/**
 * dsh-mail / outbound.js: guard rails for outgoing mail.
 *
 *   Audit        append-only audit.jsonl (0600): who, which account, what,
 *                how many recipients, a hash of the subject. No bodies.
 *   Suppression  suppress.txt (0600): one address (or @domain) per line,
 *                honoured by mass sends, fed by hard bounces and the tab.
 *   OutboundState state.json (0600): per-account rate windows (per minute,
 *                per day; 0 = unlimited) and the recipient domains each
 *                account already wrote to (for agents.firstContactConfirm).
 *   runMassSend  CSV mass send: List-Unsubscribe (+ One-Click) headers,
 *                Precedence: bulk, suppression, delay with jitter, rate
 *                limits, a circuit breaker on consecutive failures, dry run.
 */

'use strict'

import { appendFileSync, readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'

import { personalise } from './staging.js'

function ensureDir(p) { mkdirSync(dirname(p), { recursive: true, mode: 0o700 }) }
function writeJson0600(path, obj) {
  ensureDir(path)
  const tmp = path + '.tmp-' + process.pid
  writeFileSync(tmp, JSON.stringify(obj) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
  try { chmodSync(path, 0o600) } catch {}
}
export function subjectHash(s) { return createHash('sha256').update(String(s || '')).digest('hex').slice(0, 16) }
export function domainOf(addr) {
  const m = /<([^>]+)>\s*$/.exec(String(addr || ''))
  const a = (m ? m[1] : String(addr || '')).trim().toLowerCase()
  const at = a.lastIndexOf('@')
  return at > 0 ? a.slice(at + 1) : ''
}
export function bareAddr(addr) {
  const m = /<([^>]+)>\s*$/.exec(String(addr || ''))
  return (m ? m[1] : String(addr || '')).trim().toLowerCase()
}

// ── audit ───────────────────────────────────────────────────────────────────

export class Audit {
  constructor(path, enabled = () => true) { this.path = path; this.enabled = enabled }
  write(e) {
    if (!this.enabled()) return
    const row = { ts: new Date().toISOString(), actor: e.actor || 'unknown', account: e.account || '', action: e.action }
    if (e.recipients != null) row.recipients = e.recipients
    if (e.subject != null) row.subjectHash = subjectHash(e.subject)
    if (e.ok != null) row.ok = !!e.ok
    if (e.via) row.via = e.via
    if (e.count != null) row.count = e.count
    if (e.note) row.note = String(e.note).slice(0, 200)
    try {
      ensureDir(this.path)
      appendFileSync(this.path, JSON.stringify(row) + '\n', { mode: 0o600 })
    } catch {}
  }
  tail(limit = 100) {
    let text = ''
    try { text = readFileSync(this.path, 'utf8') } catch { return [] }
    const lines = text.trim().split('\n').filter(Boolean)
    return lines.slice(-Math.min(1000, Math.max(1, limit))).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  }
}

// ── suppression ─────────────────────────────────────────────────────────────

export class Suppression {
  constructor(path) { this.path = path; this.cache = null; this.mtime = 0 }
  load() {
    let m = -1
    try { m = statSync(this.path).mtimeMs } catch {}
    if (this.cache && m === this.mtime) return this.cache
    const set = new Set()
    try {
      for (const line of readFileSync(this.path, 'utf8').split('\n')) {
        const v = line.replace(/#.*$/, '').trim().toLowerCase()
        if (v) set.add(v)
      }
    } catch {}
    this.cache = set; this.mtime = m
    return set
  }
  has(addr) {
    const a = bareAddr(addr)
    const s = this.load()
    return s.has(a) || s.has('@' + domainOf(a))
  }
  list() { return [...this.load()].sort() }
  add(addr, reason = '') {
    const a = String(addr || '').trim().toLowerCase()
    if (!/^(@[^\s@]+|[^\s@]+@[^\s@]+)$/.test(a) || this.load().has(a)) return false
    ensureDir(this.path)
    appendFileSync(this.path, a + (reason ? '  # ' + String(reason).replace(/[\r\n#]/g, ' ').slice(0, 120) : '') + '\n', { mode: 0o600 })
    try { chmodSync(this.path, 0o600) } catch {}
    this.cache = null
    return true
  }
  remove(addr) {
    const a = String(addr || '').trim().toLowerCase()
    let text = ''
    try { text = readFileSync(this.path, 'utf8') } catch { return false }
    const kept = text.split('\n').filter(l => l.replace(/#.*$/, '').trim().toLowerCase() !== a)
    writeFileSync(this.path, kept.join('\n'), { mode: 0o600 })
    this.cache = null
    return true
  }
}

/** True for a permanent recipient failure (hard bounce at SMTP time). */
export function isHardBounce(err) {
  const code = Number(err && err.responseCode)
  const m = String((err && (err.response || err.message)) || '')
  return (code >= 550 && code <= 553) || /\b5\.1\.[0-9]\b|user unknown|no such user|mailbox unavailable|does not exist/i.test(m)
}

// ── rate windows + known domains ────────────────────────────────────────────

export class RateLimitError extends Error {
  constructor(message, retryAfterSec, scope) { super(message); this.code = 'rate_limit'; this.retryAfterSec = retryAfterSec; this.scope = scope }
}

export class OutboundState {
  constructor(path) { this.path = path; this.data = null; this.dirty = false; this.timer = null }
  load() {
    if (this.data) return this.data
    try { this.data = JSON.parse(readFileSync(this.path, 'utf8')) } catch { this.data = {} }
    if (!this.data.rate) this.data.rate = {}
    if (!this.data.known) this.data.known = {}
    return this.data
  }
  flushSoon() {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = null; this.flush() }, 500)
    if (this.timer.unref) this.timer.unref()
  }
  flush() { if (!this.dirty) return; this.dirty = false; try { writeJson0600(this.path, this.load()) } catch {} }

  windows(id, now) {
    const d = this.load()
    const r = d.rate[id] || (d.rate[id] = { m: 0, mc: 0, d: 0, dc: 0 })
    const m = Math.floor(now / 60000)
    const day = Math.floor(now / 86400000)
    if (r.m !== m) { r.m = m; r.mc = 0 }
    if (r.d !== day) { r.d = day; r.dc = 0 }
    return r
  }

  /** Throws RateLimitError when `n` more messages would exceed a limit. */
  check(acc, n = 1, now = Date.now()) {
    const L = acc.limits || {}
    const r = this.windows(acc.id, now)
    if (L.perDay > 0 && r.dc + n > L.perDay) throw new RateLimitError('rate limit: ' + acc.id + ' allows ' + L.perDay + ' messages per day', Math.ceil((86400000 - (now % 86400000)) / 1000), 'day')
    if (L.perMinute > 0 && r.mc + n > L.perMinute) throw new RateLimitError('rate limit: ' + acc.id + ' allows ' + L.perMinute + ' messages per minute', Math.max(1, Math.ceil((60000 - (now % 60000)) / 1000)), 'minute')
  }
  consume(acc, n = 1, now = Date.now()) {
    const r = this.windows(acc.id, now)
    r.mc += n; r.dc += n
    this.flushSoon()
  }
  remaining(acc, now = Date.now()) {
    const L = acc.limits || {}
    const r = this.windows(acc.id, now)
    return { perMinute: L.perMinute > 0 ? Math.max(0, L.perMinute - r.mc) : null, perDay: L.perDay > 0 ? Math.max(0, L.perDay - r.dc) : null }
  }

  knowsDomain(id, domain) { const k = this.load().known[id]; return !!(k && k.includes(domain)) }
  rememberDomains(id, domains) {
    const d = this.load()
    const set = new Set(d.known[id] || [])
    let added = false
    for (const x of domains) if (x && !set.has(x)) { set.add(x); added = true }
    if (added) { d.known[id] = [...set].slice(-5000); this.flushSoon() }
  }
}

// ── mass send ───────────────────────────────────────────────────────────────

/** Parse and validate an unsubscribe value: "mailto:...", "https://...", or both comma-separated. */
export function parseUnsubscribe(v) {
  const parts = String(v || '').split(',').map(s => s.trim().replace(/^<|>$/g, '')).filter(Boolean)
  const out = { mailto: '', https: '' }
  for (const p of parts) {
    if (/[\r\n<>\s]/.test(p)) throw new Error('unsubscribe must be a mailto: or https: URL without spaces')
    if (/^mailto:[^@\s]+@[^@\s]+/i.test(p)) out.mailto = p
    else if (/^https:\/\/[^\s]+$/i.test(p)) out.https = p
    else throw new Error('unsubscribe must be a mailto: or https: URL')
  }
  if (!out.mailto && !out.https) return null
  return out
}

export function unsubscribeHeaders(unsub, row) {
  if (!unsub) return {}
  const enc = s => personalise(s, Object.fromEntries(Object.entries(row || {}).map(([k, v]) => [k, encodeURIComponent(String(v))])))
  const list = [unsub.mailto && '<' + enc(unsub.mailto) + '>', unsub.https && '<' + enc(unsub.https) + '>'].filter(Boolean).join(', ')
  const h = { 'List-Unsubscribe': list }
  if (unsub.https) h['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click'
  return h
}

const emailOf = row => row.email || row.Email || row[Object.keys(row).find(k => k.toLowerCase().includes('email'))]

/**
 * Run a CSV mass send.
 * @param job { rows, subjectTemplate, textTemplate, from, replyTo, delayMs, unsubscribe, dryRun }
 * @param d   { service, state, suppression, settings, canSetHeaders, sleep, actor, log }
 */
export async function runMassSend(acc, job, d) {
  const s = d.settings
  const rows = job.rows || []
  const threshold = Number(s.mass && s.mass.unsubscribeAbove)
  const unsub = job.unsubscribe ? parseUnsubscribe(job.unsubscribe) : null
  if (rows.length > threshold && !unsub) throw new Error('mass sends to more than ' + threshold + ' recipients need an unsubscribe address (unsubscribe: "mailto:..." and/or "https://...")')
  if (unsub && !d.canSetHeaders) throw new Error('account ' + acc.id + ' cannot set List-Unsubscribe headers; use an SMTP, Lettermint, Resend or SendGrid account for mass sends with unsubscribe')
  const targets = rows.map(r => ({ row: r, to: emailOf(r) }))
  const suppressed = targets.filter(t => t.to && d.suppression.has(t.to)).length
  const delay = Math.min(s.maxDelayMs, Math.max(s.minDelayMs, job.delayMs == null ? 1000 : Number(job.delayMs) || 0))
  const render = t => ({
    to: [t.to], subject: personalise(job.subjectTemplate, t.row), text: personalise(job.textTemplate, t.row), from: job.from || '',
    replyTo: job.replyTo || s.defaultReplyTo || '', headers: { Precedence: 'bulk', ...unsubscribeHeaders(unsub, t.row) },
  })
  if (job.dryRun) {
    const sendable = targets.filter(t => t.to && !d.suppression.has(t.to))
    return {
      dryRun: true, total: rows.length, sendable: sendable.length, suppressed, missingAddress: targets.filter(t => !t.to).length,
      preview: sendable.slice(0, 3).map(render).map(m => ({ to: m.to[0], subject: m.subject, text: m.text.slice(0, 2000), headers: m.headers })),
      limits: { ...d.state.remaining(acc), delayMs: delay, estimatedMinutes: Math.ceil((sendable.length * delay) / 60000) },
    }
  }
  const sleep = d.sleep || (ms => new Promise(r => setTimeout(r, ms)))
  const breaker = Math.max(1, Number(s.mass && s.mass.breakerFailures) || 5)
  const jitter = Math.max(0, Math.min(50, Number(s.mass && s.mass.jitterPct) || 0)) / 100
  let sent = 0, failed = 0, skipped = 0, streak = 0, stopped = '', firstError = ''
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]
    if (!t.to) { failed++; continue }
    if (d.suppression.has(t.to)) { skipped++; continue }
    const msg = render(t)
    let attempt = 0
    for (;;) {
      try {
        await d.service.send(acc, msg, { actor: d.actor || 'agent', kind: 'mass' })
        sent++; streak = 0
        break
      } catch (e) {
        if (e && e.code === 'rate_limit' && e.scope === 'minute' && attempt === 0) { attempt++; await sleep(Math.min(65, e.retryAfterSec || 60) * 1000); continue }
        if (e && e.code === 'rate_limit') { stopped = e.message; break }
        failed++; streak++
        if (!firstError) firstError = String(e && e.message).slice(0, 300)
        if (isHardBounce(e)) d.suppression.add(t.to, 'hard bounce')
        if (streak >= breaker) stopped = 'circuit breaker: ' + streak + ' consecutive failures'
        break
      }
    }
    if (stopped) break
    if (delay && i < targets.length - 1) await sleep(Math.round(delay * (1 + (Math.random() * 2 - 1) * jitter)))
  }
  return { total: rows.length, sent, failed, suppressed: skipped, stopped, firstError }
}
