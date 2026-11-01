/**
 * dsh-mail / secrets.js: every secret the plugin holds, in ONE 0600 file
 * (<data dir>/secrets.json, directory 0700), never in settings.yaml or the
 * DSH 0.2 profile row.
 *
 *   accounts.<id>  { password, apiKey, oauthClientSecret, webhookSecret }
 *   legacy         v0.1 secrets moved out of an imported settings section:
 *                  { mailboxAgentToken, providers: { <id>: { <key>: value } } }
 *
 * OAuth tokens live separately and encrypted (lib/tokens.js). Read routes
 * only ever see the "__set__" marker.
 */

'use strict'

import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

import { SECRET_KEYS } from './accounts.js'

/** v0.1 provider fields that hold secrets. */
export const LEGACY_SECRET_FIELDS = {
  lettermint: ['lettermintApiKey'], agentmail: ['agentmailApiKey'], resend: ['resendApiKey'],
  ovh: ['smtpPass', 'imapPass'], smtp: ['smtpPass', 'imapPass'], local: ['smtpPass', 'imapPass'], tzmail: ['tzmailPass'],
}

function isObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v) }

export class SecretStore {
  constructor(path) { this.path = path; this.cache = null; this.mtime = 0 }

  load() {
    let m = 0
    try { m = statSync(this.path).mtimeMs } catch { m = -1 }
    if (this.cache && m === this.mtime) return this.cache
    let data = {}
    try { data = JSON.parse(readFileSync(this.path, 'utf8')) } catch { data = {} }
    if (!isObj(data.accounts)) data.accounts = {}
    if (!isObj(data.legacy)) data.legacy = {}
    this.cache = data
    this.mtime = m
    return data
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const tmp = this.path + '.tmp-' + process.pid
    writeFileSync(tmp, JSON.stringify(this.cache, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.path)
    try { chmodSync(this.path, 0o600) } catch {}
    try { this.mtime = statSync(this.path).mtimeMs } catch {}
  }

  /** id -> secrets map for every explicit account. */
  accounts() { return this.load().accounts }
  account(id) { return this.load().accounts[id] || {} }

  setAccount(id, secrets) {
    const d = this.load()
    const clean = {}
    for (const k of SECRET_KEYS) if (typeof secrets[k] === 'string' && secrets[k]) clean[k] = secrets[k]
    if (Object.keys(clean).length) d.accounts[id] = clean
    else delete d.accounts[id]
    this.save()
  }

  removeAccount(id) { const d = this.load(); if (d.accounts[id]) { delete d.accounts[id]; this.save() } }

  legacy() { return this.load().legacy }

  /**
   * Move v0.1 secrets out of a settings section (used by the DSH 0.2 legacy
   * import). Returns the section without them; the values land in this file.
   */
  extractLegacy(section) {
    const out = structuredClone(isObj(section) ? section : {})
    const d = this.load()
    let moved = 0
    if (typeof out.mailboxAgentToken === 'string') {
      if (out.mailboxAgentToken) { d.legacy.mailboxAgentToken = out.mailboxAgentToken; moved++ }
      delete out.mailboxAgentToken
    }
    if (isObj(out.providers)) {
      for (const [pid, fields] of Object.entries(LEGACY_SECRET_FIELDS)) {
        const p = out.providers[pid]
        if (!isObj(p)) continue
        for (const f of fields) {
          if (typeof p[f] !== 'string') continue
          if (p[f]) { d.legacy.providers = d.legacy.providers || {}; d.legacy.providers[pid] = { ...(d.legacy.providers[pid] || {}), [f]: p[f] }; moved++ }
          delete p[f]
        }
      }
    }
    if (Array.isArray(out.accounts)) {
      for (const a of out.accounts) {
        if (!isObj(a) || !isObj(a.secrets)) continue
        if (typeof a.id === 'string' && a.id) { d.accounts[a.id] = { ...(d.accounts[a.id] || {}), ...Object.fromEntries(Object.entries(a.secrets).filter(([k, v]) => SECRET_KEYS.includes(k) && typeof v === 'string' && v && v !== '__set__')) }; moved++ }
        delete a.secrets
      }
    }
    if (moved) this.save()
    return { section: out, moved }
  }

  /** Overlay legacy secrets where the settings value is empty (they were moved here). */
  withLegacy(settings) {
    const s = structuredClone(settings)
    const L = this.legacy()
    if (!s.mailboxAgentToken && L.mailboxAgentToken) s.mailboxAgentToken = L.mailboxAgentToken
    if (isObj(L.providers)) {
      s.providers = isObj(s.providers) ? s.providers : {}
      for (const [pid, vals] of Object.entries(L.providers)) {
        const cur = isObj(s.providers[pid]) ? { ...s.providers[pid] } : {}
        for (const [k, v] of Object.entries(vals || {})) if (!cur[k] && v) cur[k] = v
        s.providers[pid] = cur
      }
    }
    return s
  }

  /** Drop moved v0.1 secrets once their accounts were converted. */
  clearLegacy(ids) {
    const d = this.load()
    let changed = false
    for (const id of ids) {
      if (d.legacy.providers && d.legacy.providers[id]) { delete d.legacy.providers[id]; changed = true }
      if (id === 'tzmail' && d.legacy.mailboxAgentToken) { delete d.legacy.mailboxAgentToken; changed = true }
    }
    if (changed) this.save()
  }

  /** Every secret value, for scrubbing. */
  values() {
    const out = []
    const d = this.load()
    for (const a of Object.values(d.accounts)) for (const v of Object.values(a || {})) if (typeof v === 'string' && v.length >= 4) out.push(v)
    if (d.legacy.mailboxAgentToken) out.push(d.legacy.mailboxAgentToken)
    for (const p of Object.values(d.legacy.providers || {})) for (const v of Object.values(p || {})) if (typeof v === 'string' && v.length >= 4) out.push(v)
    return out
  }
}
