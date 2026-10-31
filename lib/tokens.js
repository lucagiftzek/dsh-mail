/**
 * dsh-mail / tokens.js: OAuth tokens at rest and on demand.
 *
 * Storage: <data dir>/tokens.enc, JSON encrypted with AES-256-GCM. The key is
 * derived with HKDF-SHA256 from the plugin capability secret (a 0600 file in
 * the same 0700 directory), so neither file alone reveals a token. Tokens
 * never appear in settings, routes or logs.
 *
 * Access tokens are refreshed on demand 120 s before expiry, single-flight
 * per account and purpose ('mail', or Microsoft 'graph'). invalid_grant marks
 * the account needsReauth (the tab shows a Reconnect banner).
 */

'use strict'

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'

import { refreshToken, OAuthError } from './oauth.js'

export const REFRESH_SKEW_MS = 120 * 1000

export function deriveKey(secret) {
  return Buffer.from(hkdfSync('sha256', Buffer.from(String(secret)), Buffer.from('dsh-mail'), Buffer.from('dsh-mail tokens v1'), 32))
}

export class TokenStore {
  /** @param path tokens.enc path; @param keyFn () => 32 byte key (or null while not ready) */
  constructor(path, keyFn) { this.path = path; this.keyFn = keyFn; this.cache = null }

  load() {
    if (this.cache) return this.cache
    const key = this.keyFn()
    if (!key) throw new Error('token key not ready')
    let raw
    try { raw = readFileSync(this.path, 'utf8') } catch { this.cache = { accounts: {} }; return this.cache }
    const f = JSON.parse(raw)
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(f.iv, 'base64'))
    d.setAuthTag(Buffer.from(f.tag, 'base64'))
    const plain = Buffer.concat([d.update(Buffer.from(f.data, 'base64')), d.final()]).toString('utf8')
    this.cache = JSON.parse(plain)
    if (!this.cache.accounts) this.cache.accounts = {}
    return this.cache
  }

  save() {
    const key = this.keyFn()
    if (!key) throw new Error('token key not ready')
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', key, iv)
    const data = Buffer.concat([c.update(JSON.stringify(this.cache || { accounts: {} }), 'utf8'), c.final()])
    const out = JSON.stringify({ v: 1, alg: 'aes-256-gcm', kdf: 'hkdf-sha256', iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }) + '\n'
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const tmp = this.path + '.tmp-' + process.pid
    writeFileSync(tmp, out, { mode: 0o600 })
    renameSync(tmp, this.path)
    try { chmodSync(this.path, 0o600) } catch {}
  }

  get(id) { return this.load().accounts[id] || null }
  set(id, entry) { this.load().accounts[id] = entry; this.save() }
  remove(id) { const a = this.load().accounts; if (a[id]) { delete a[id]; this.save() } }
}

export class TokenManager {
  /** @param o { store, fetchImpl, onChange } */
  constructor(o) { this.o = o; this.inflight = new Map() }
  get store() { return this.o.store }

  /** Save the result of a code exchange or device flow; clears needsReauth. */
  connect(acc, tokens) {
    const prev = this.store.get(acc.id) || {}
    this.store.set(acc.id, {
      provider: acc.type, user: acc.address || prev.user || '', clientId: (acc.oauth && acc.oauth.clientId) || '',
      refreshToken: tokens.refreshToken || prev.refreshToken || '',
      access: { mail: { token: tokens.accessToken, expiresAt: tokens.expiresAt } },
      scope: tokens.scope || '', connectedAt: Date.now(), needsReauth: false, reauthReason: '',
    })
    if (this.o.onChange) this.o.onChange({ type: 'oauth', account: acc.id })
  }

  status(id) {
    let e = null
    try { e = this.store.get(id) } catch { return { connected: false, needsReauth: false, error: 'token store unreadable' } }
    if (!e) return { connected: false, needsReauth: false }
    return { connected: !!e.refreshToken && !e.needsReauth, needsReauth: !!e.needsReauth, reason: e.reauthReason || '', user: e.user || '', connectedAt: e.connectedAt || 0 }
  }

  /** A valid access token for the purpose, refreshing when needed (single-flight). */
  async accessToken(acc, purpose = 'mail') {
    const e = this.store.get(acc.id)
    if (!e || !e.refreshToken) throw new OAuthError('account ' + acc.id + ' is not connected: open its settings and press Connect', 'not_connected')
    if (e.needsReauth) throw new OAuthError('account ' + acc.id + ' needs to be reconnected: ' + (e.reauthReason || 'sign in again'), 'needs_reauth')
    if ((acc.oauth && acc.oauth.clientId) && e.clientId && e.clientId !== acc.oauth.clientId) throw new OAuthError('the OAuth client of ' + acc.id + ' changed: press Connect again', 'needs_reauth')
    const cur = e.access && e.access[purpose]
    if (cur && cur.token && cur.expiresAt - REFRESH_SKEW_MS > Date.now()) return cur.token
    const key = acc.id + '\u0000' + purpose
    if (this.inflight.has(key)) return this.inflight.get(key)
    const p = (async () => {
      try {
        const t = await refreshToken(acc, e.refreshToken, purpose, { fetchImpl: this.o.fetchImpl })
        const now = this.store.get(acc.id) || e
        now.access = { ...(now.access || {}), [purpose]: { token: t.accessToken, expiresAt: t.expiresAt } }
        if (t.refreshToken) now.refreshToken = t.refreshToken
        this.store.set(acc.id, now)
        return t.accessToken
      } catch (err) {
        if (err && err.code === 'invalid_grant') {
          const now = this.store.get(acc.id) || e
          now.needsReauth = true
          now.reauthReason = String(err.message).slice(0, 400)
          now.access = {}
          this.store.set(acc.id, now)
          if (this.o.onChange) this.o.onChange({ type: 'oauth', account: acc.id, needsReauth: true })
        }
        throw err
      } finally { this.inflight.delete(key) }
    })()
    this.inflight.set(key, p)
    return p
  }

  refreshTokenOf(id) { const e = this.store.get(id); return e ? e.refreshToken : '' }
  forget(id) { this.store.remove(id) }
  /** Token values, for scrubbing error text. */
  values() {
    try {
      const out = []
      for (const e of Object.values(this.store.load().accounts)) {
        if (e.refreshToken) out.push(e.refreshToken)
        for (const a of Object.values(e.access || {})) if (a && a.token) out.push(a.token)
      }
      return out
    } catch { return [] }
  }
}
