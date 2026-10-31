/**
 * dsh-mail / idle.js: IMAP IDLE push for new mail, with polling as the fallback.
 *
 * Accounts with `push: true` (at most `push.maxAccounts`, default 5) get one
 * extra, long-lived connection that selects INBOX and IDLEs (imapflow keeps
 * the IDLE alive). An EXISTS notification syncs INBOX at once and tells the
 * tab (SSE). A dropped connection reconnects with a backoff from 5 s to
 * 5 min; a server without IDLE, or 3 failures in a row, leaves the account
 * on polling (the background poll keeps running for every account anyway).
 */

'use strict'

import { createRequire } from 'node:module'

import { imapOptions } from './imap.js'
import { usesOAuth } from './accounts.js'
import { E } from './errors.js'

const require = createRequire(import.meta.url)
const { ImapFlow } = require('imapflow')

export class IdleManager {
  /**
   * @param o { accounts: () => Account[], max: () => number, tokenFor(acc), onExists(acc), log, warn, minBackoffMs, maxBackoffMs }
   */
  constructor(o) {
    this.o = { minBackoffMs: 5000, maxBackoffMs: 300000, ...o }
    this.conns = new Map() // id -> { client, timer, failures, key, mode }
    this.stopped = false
  }

  status() { return Object.fromEntries([...this.conns].map(([id, c]) => [id, { mode: c.mode, failures: c.failures }])) }

  /** Bring the set of IDLE connections in line with the accounts (call periodically). */
  reconcile() {
    if (this.stopped) return
    const want = this.o.accounts().filter(a => a.enabled && a.push && a.receive.protocol === 'imap').slice(0, Math.max(0, this.o.max()))
    const ids = new Set(want.map(a => a.id))
    for (const [id] of this.conns) if (!ids.has(id)) this.stop(id)
    for (const a of want) {
      const key = JSON.stringify([a.receive, a.auth, a.allowSelfSigned])
      const cur = this.conns.get(a.id)
      if (cur && cur.key === key) continue
      if (cur) this.stop(a.id)
      this.conns.set(a.id, { client: null, timer: null, failures: 0, key, mode: 'connecting' })
      void this.connect(a)
    }
  }

  async connect(acc) {
    const slot = this.conns.get(acc.id)
    if (!slot || this.stopped) return
    try {
      const token = usesOAuth(acc) && this.o.tokenFor ? await this.o.tokenFor(acc) : null
      const c = new ImapFlow({ ...imapOptions(acc, token), disableAutoIdle: false, maxIdleTime: 25 * 60 * 1000 })
      c.on('error', () => {})
      slot.client = c
      await c.connect()
      if (!c.capabilities || !c.capabilities.has('IDLE')) {
        slot.mode = 'polling (no IDLE)'
        if (this.o.warn) this.o.warn(E.logLine('MAIL_IDLE_UNAVAILABLE', 'the server of ' + acc.id + ' has no IDLE; polling'))
        await c.logout().catch(() => {})
        slot.client = null
        return
      }
      await c.mailboxOpen('INBOX')
      slot.mode = 'idle'
      slot.failures = 0
      c.on('exists', () => { try { this.o.onExists(acc) } catch {} })
      c.on('close', () => { if (this.conns.get(acc.id) === slot && !this.stopped) this.retry(acc, slot, 'closed') })
      await c.idle().catch(() => {})
    } catch (e) {
      if (this.conns.get(acc.id) === slot) this.retry(acc, slot, e && e.message)
    }
  }

  retry(acc, slot, reason) {
    slot.failures++
    if (slot.client) { try { slot.client.close() } catch {} ; slot.client = null }
    if (slot.failures >= 3) { slot.mode = 'polling (IDLE failed: ' + String(reason || '').slice(0, 80) + ')'; if (this.o.warn) this.o.warn(E.logLine('MAIL_IDLE_UNAVAILABLE', 'IDLE for ' + acc.id + ' gave up after 3 failures; polling')) ; return }
    slot.mode = 'reconnecting'
    const delay = Math.min(this.o.maxBackoffMs, this.o.minBackoffMs * 2 ** (slot.failures - 1))
    slot.timer = setTimeout(() => { void this.connect(acc) }, delay)
    if (slot.timer.unref) slot.timer.unref()
  }

  stop(id) {
    const s = this.conns.get(id)
    if (!s) return
    clearTimeout(s.timer)
    this.conns.delete(id)
    if (s.client) s.client.logout().catch(() => { try { s.client.close() } catch {} })
  }

  stopAll() { this.stopped = true; for (const id of [...this.conns.keys()]) this.stop(id) }
}
