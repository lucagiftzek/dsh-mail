/**
 * dsh-mail / unsub.js: the unsubscribe feature.
 *
 * Every mass-sent message carries a per-recipient token:
 *   <payload>.<signature>   payload = base64url(JSON { v, a, l, c, r })
 *     a  account id         l  list id (a campaign group, e.g. "newsletter")
 *     c  campaign id        r  recipient hash (SHA-256 of the lowercased address, 128 bits)
 *   signature = HMAC-SHA256 with a key derived (HKDF) from the plugin's 0600
 *   capability secret. The token holds no address: the campaign record kept
 *   on this host (0600) maps the hash back to the address.
 *
 * The token is used in three places:
 *   List-Unsubscribe: <mailto:ADDR?subject=unsubscribe%20TOKEN>, <https://BASE/dsh-mail-unsub/TOKEN>
 *   List-Unsubscribe-Post: List-Unsubscribe=One-Click   (RFC 8058, only with the https URL)
 *   a visible footer (en / it / el) with the https link or the mailto
 *
 * Unsubscribes land in the suppression lists: global (suppress.txt) or per
 * list (suppress-lists.json). The public page is served by handleUnsubRequest
 * (rate limited, HMAC verified): GET shows a confirm page, POST one-click
 * answers 200.
 */

'use strict'

import { createHash, createHmac, hkdfSync, timingSafeEqual, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'

export const UNSUB_PATH = '/dsh-mail-unsub/'
const LIST_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

function b64url(buf) { return Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '') }
function isObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v) }
function writeJson0600(path, obj) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = path + '.tmp-' + process.pid
  writeFileSync(tmp, JSON.stringify(obj) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
  try { chmodSync(path, 0o600) } catch {}
}
export function bare(addr) {
  const m = /<([^>]+)>\s*$/.exec(String(addr || ''))
  return (m ? m[1] : String(addr || '')).trim().toLowerCase()
}

export function unsubKey(secret) {
  return Buffer.from(hkdfSync('sha256', Buffer.from(String(secret)), Buffer.from('dsh-mail'), Buffer.from('dsh-mail unsubscribe v1'), 32))
}
export function recipientHash(addr) { return b64url(createHash('sha256').update(bare(addr)).digest()).slice(0, 22) }
export function normList(s) {
  const v = String(s || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 64)
  return LIST_RE.test(v) ? v : ''
}

export function makeToken(key, { a, l, c, r }) {
  const body = b64url(Buffer.from(JSON.stringify({ v: 1, a, l, c, r })))
  return body + '.' + b64url(createHmac('sha256', key).update(body).digest()).slice(0, 32)
}

export function verifyToken(key, token) {
  const t = String(token || '')
  if (t.length > 600) return null
  const dot = t.lastIndexOf('.')
  if (dot <= 0) return null
  const body = t.slice(0, dot)
  const want = b64url(createHmac('sha256', key).update(body).digest()).slice(0, 32)
  const a = Buffer.from(t.slice(dot + 1)); const b = Buffer.from(want)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    return p && p.v === 1 && typeof p.r === 'string' ? p : null
  } catch { return null }
}

/** The mailto address that receives unsubscribe replies for an account ('' when none). */
export function unsubMailto(acc, settings) {
  const u = (acc && acc.unsubscribe) || {}
  if (u.mailto) return bare(u.mailto)
  const global = settings && settings.unsubscribe && settings.unsubscribe.mailto
  if (global) return bare(global)
  // local+unsubscribe@domain, only for accounts that can read their own mail (the sync loop processes it)
  const canRead = acc && ['imap', 'pop3'].includes(acc.receive && acc.receive.protocol)
  if (u.plusTag !== false && canRead && /^[^@\s+]+@[^@\s]+$/.test(acc.address || '')) {
    const [local, domain] = acc.address.toLowerCase().split('@')
    return local + '+unsubscribe@' + domain
  }
  return ''
}

export function unsubUrl(settings, token) {
  const base = settings && settings.unsubscribe && settings.unsubscribe.publicBaseUrl
  if (!base || !/^https:\/\//i.test(base)) return ''
  return String(base).replace(/\/+$/, '') + UNSUB_PATH + token
}

// ── footer and page texts (English, Italian, Greek) ─────────────────────────

export const TEXTS = {
  en: {
    footerUrl: 'You received this email from {sender}. To stop receiving these emails, unsubscribe here: {url}',
    footerMail: 'You received this email from {sender}. To stop receiving these emails, write to {mailto} with the subject "unsubscribe".',
    title: 'Unsubscribe', ask: 'Unsubscribe {who} from these emails?', list: 'Unsubscribe from this list', all: 'Unsubscribe from all emails from this sender',
    done: 'Done. {who} will not receive these emails any more.', bad: 'This unsubscribe link is not valid.', busy: 'Too many requests. Please try again in a minute.',
  },
  it: {
    footerUrl: 'Hai ricevuto questa email da {sender}. Per non ricevere più queste email, annulla l\'iscrizione qui: {url}',
    footerMail: 'Hai ricevuto questa email da {sender}. Per non ricevere più queste email, scrivi a {mailto} con oggetto "unsubscribe".',
    title: 'Annulla iscrizione', ask: 'Annullare l\'iscrizione di {who} a queste email?', list: 'Annulla l\'iscrizione a questa lista', all: 'Non ricevere più email da questo mittente',
    done: 'Fatto. {who} non riceverà più queste email.', bad: 'Questo link di disiscrizione non è valido.', busy: 'Troppe richieste. Riprova tra un minuto.',
  },
  el: {
    footerUrl: 'Λάβατε αυτό το email από {sender}. Για να μη λαμβάνετε πλέον αυτά τα email, απεγγραφείτε εδώ: {url}',
    footerMail: 'Λάβατε αυτό το email από {sender}. Για να μη λαμβάνετε πλέον αυτά τα email, γράψτε στο {mailto} με θέμα "unsubscribe".',
    title: 'Απεγγραφή', ask: 'Απεγγραφή του {who} από αυτά τα email;', list: 'Απεγγραφή από αυτή τη λίστα', all: 'Απεγγραφή από όλα τα email αυτού του αποστολέα',
    done: 'Έγινε. Το {who} δεν θα λαμβάνει πλέον αυτά τα email.', bad: 'Αυτός ο σύνδεσμος απεγγραφής δεν είναι έγκυρος.', busy: 'Πάρα πολλά αιτήματα. Δοκιμάστε ξανά σε ένα λεπτό.',
  },
}
export const LANGS = Object.keys(TEXTS)
export function lang(l) { return LANGS.includes(l) ? l : 'en' }
function fill(t, v) { return String(t).replace(/\{(\w+)\}/g, (m, k) => (v[k] != null ? v[k] : m)) }

/** The visible footer for one recipient. Custom texts (settings.unsubscribe.texts.<lang>) may use {sender} {url} {mailto}. */
export function footerText({ language, sender, url, mailto, custom }) {
  const L = TEXTS[lang(language)]
  const c = custom && custom[lang(language)]
  if (c) return fill(c, { sender, url: url || mailto, mailto })
  return url ? fill(L.footerUrl, { sender, url }) : mailto ? fill(L.footerMail, { sender, mailto }) : ''
}

// ── campaigns (local record: hash -> address, never published) ─────────────

export class Campaigns {
  constructor(dir) { this.dir = dir }
  path(id) { if (!/^c-[a-z0-9]{12}$/.test(String(id || ''))) throw new Error('invalid campaign id'); return join(this.dir, id + '.json') }
  create({ account, list, subject, language }) {
    const id = 'c-' + randomBytes(9).toString('hex').slice(0, 12)
    const rec = { id, account, list: normList(list) || id, subjectHash: createHash('sha256').update(String(subject || '')).digest('hex').slice(0, 16), language: lang(language), createdAt: Date.now(), recipients: {}, sent: 0, unsubscribed: 0 }
    writeJson0600(this.path(id), rec)
    return rec
  }
  get(id) { try { return JSON.parse(readFileSync(this.path(id), 'utf8')) } catch { return null } }
  save(rec) { writeJson0600(this.path(rec.id), rec) }
  addRecipients(rec, addrs) { for (const a of addrs) rec.recipients[recipientHash(a)] = bare(a); this.save(rec) }
  lookup(id, hash) { const r = this.get(id); return r && r.recipients[hash] ? r.recipients[hash] : '' }
  summaries() {
    let names = []
    try { names = readdirSync(this.dir).filter(n => /^c-[a-z0-9]{12}\.json$/.test(n)) } catch { return [] }
    return names.map(n => this.get(n.slice(0, -5))).filter(Boolean)
      .map(r => ({ id: r.id, account: r.account, list: r.list, createdAt: r.createdAt, recipients: Object.keys(r.recipients).length, sent: r.sent, unsubscribed: r.unsubscribed, language: r.language }))
      .sort((a, b) => b.createdAt - a.createdAt)
  }
}

// ── per-list suppression ────────────────────────────────────────────────────

export class ListSuppression {
  constructor(path) { this.path = path; this.cache = null; this.mtime = 0 }
  load() {
    let m = -1
    try { m = statSync(this.path).mtimeMs } catch {}
    if (this.cache && m === this.mtime) return this.cache
    let d = {}
    try { d = JSON.parse(readFileSync(this.path, 'utf8')) } catch {}
    if (!isObj(d.lists)) d.lists = {}
    this.cache = d; this.mtime = m
    return d
  }
  save() { writeJson0600(this.path, this.cache); try { this.mtime = statSync(this.path).mtimeMs } catch {} }
  has(list, addr) { const l = this.load().lists[list]; return !!(l && l[bare(addr)]) }
  add(list, addr, reason = '') {
    const id = normList(list); const a = bare(addr)
    if (!id || !/^[^\s@]+@[^\s@]+$/.test(a)) return false
    const d = this.load()
    d.lists[id] = d.lists[id] || {}
    if (d.lists[id][a]) return false
    d.lists[id][a] = { at: Date.now(), reason: String(reason).slice(0, 120) }
    this.save()
    return true
  }
  remove(list, addr) { const d = this.load(); const l = d.lists[normList(list)]; if (l && l[bare(addr)]) { delete l[bare(addr)]; this.save(); return true } return false }
  all() { return this.load().lists }
}

// ── the public request handler ──────────────────────────────────────────────

export class HitLimiter {
  constructor({ perKey = 20, global = 600, windowMs = 60000 } = {}) { Object.assign(this, { perKey, global, windowMs }); this.hits = new Map(); this.total = []; }
  allow(key, now = Date.now()) {
    this.total = this.total.filter(t => now - t < this.windowMs)
    if (this.total.length >= this.global) return false
    const arr = (this.hits.get(key) || []).filter(t => now - t < this.windowMs)
    if (arr.length >= this.perKey) { this.hits.set(key, arr); return false }
    arr.push(now); this.hits.set(key, arr); this.total.push(now)
    if (this.hits.size > 5000) this.hits.clear()
    return true
  }
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') }
export function maskAddr(a) {
  const [l, d] = String(a || '').split('@')
  if (!d) return 'this address'
  return (l.length <= 2 ? l[0] + '*' : l[0] + '***' + l[l.length - 1]) + '@' + d
}

function page(L, body, status = 200) {
  return {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    },
    body: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>' + esc(L.title) + '</title>' +
      '<style>body{font:16px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#f6f6f6;color:#222}' +
      'main{max-width:440px;margin:16px;padding:24px;border-radius:12px;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.08)}button{font:inherit;display:block;width:100%;margin:10px 0 0;padding:10px;border-radius:8px;border:1px solid #888;background:#fff;cursor:pointer}' +
      'button.p{background:#222;color:#fff;border-color:#222}@media (prefers-color-scheme:dark){body{background:#1b1b1b;color:#ddd}main{background:#262626}button{background:#333;color:#eee}}</style></head><body><main>' + body + '</main></body></html>',
  }
}

/**
 * Decide the response for /dsh-mail-unsub/<token>. Pure apart from the
 * suppression writes, so the DSH route and the public listener share it.
 * @param d { key, campaigns, suppression (global), lists (ListSuppression), limiter, audit }
 */
export function unsubResponse({ method, token, body, clientKey, acceptLanguage }, d) {
  const pref = /^(it|el)\b/i.exec(String(acceptLanguage || ''))
  let L = TEXTS[pref ? pref[1].toLowerCase() : 'en']
  if (!d.limiter.allow(clientKey || 'unknown')) return { ...page(L, '<p>' + esc(L.busy) + '</p>', 429), headers: { ...page(L, '').headers, 'retry-after': '60' } }
  const p = d.key ? verifyToken(d.key, token) : null
  if (!p) return page(L, '<p>' + esc(L.bad) + '</p>', 404)
  const rec = p.c ? d.campaigns.get(p.c) : null
  if (rec && rec.language && TEXTS[rec.language] && !pref) L = TEXTS[rec.language]
  const addr = rec ? rec.recipients[p.r] : ''
  if (!addr) return page(L, '<p>' + esc(L.bad) + '</p>', 404)
  const who = maskAddr(addr)
  if (method === 'GET' || method === 'HEAD') {
    return page(L, '<h1 style="font-size:20px;margin:0 0 8px">' + esc(L.title) + '</h1><p>' + esc(fill(L.ask, { who })) + '</p>' +
      '<form method="post"><input type="hidden" name="scope" value="list"><button class="p" type="submit">' + esc(L.list) + '</button></form>' +
      '<form method="post"><input type="hidden" name="scope" value="all"><button type="submit">' + esc(L.all) + '</button></form>')
  }
  if (method !== 'POST') return { status: 405, headers: { 'content-type': 'text/plain', allow: 'GET, POST' }, body: 'method not allowed' }
  const form = new URLSearchParams(String(body || ''))
  // RFC 8058 one-click: "List-Unsubscribe=One-Click" unsubscribes from the list the header belongs to.
  const scope = form.get('scope') === 'all' ? 'all' : 'list'
  const added = scope === 'all' ? d.suppression.add(addr, 'unsubscribed (all, link)') : d.lists.add(p.l || rec.list, addr, 'unsubscribed (' + (form.get('List-Unsubscribe') === 'One-Click' ? 'one-click' : 'link') + ')')
  if (added) { rec.unsubscribed = (rec.unsubscribed || 0) + 1; d.campaigns.save(rec) }
  if (d.audit) d.audit({ actor: 'recipient', action: 'unsubscribe', account: p.a, note: scope + (form.get('List-Unsubscribe') === 'One-Click' ? ' one-click' : '') })
  return page(L, '<p>' + esc(fill(L.done, { who })) + '</p>')
}

/** Node request handler for GET/POST /dsh-mail-unsub/<token> (DSH route and public listener). */
/**
 * The client key for rate limiting. The listener sits behind ONE trusted edge
 * (Caddy, cloudflared): its own address is the peer, so the client is
 * CF-Connecting-IP when present, else the LAST X-Forwarded-For entry (the one
 * the edge appended; earlier entries are whatever the client sent).
 */
export function clientKeyOf(req) {
  const h = (req && req.headers) || {}
  const cf = String(h['cf-connecting-ip'] || '').trim()
  if (cf && cf.length <= 64) return cf
  const parts = String(h['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean)
  const last = parts.length ? parts[parts.length - 1] : ''
  if (last && last.length <= 64) return last
  return (req && req.socket && req.socket.remoteAddress) || 'unknown'
}

/** Node request handler for GET/POST /dsh-mail-unsub/<token> (DSH route and public listener). Never throws. */
export function makeUnsubHandler(getDeps) {
  return (req, res) => {
    const plainText = (status, text) => { try { if (!res.headersSent) res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(text) } catch {} }
    // This handler faces the internet: every failure answers, none escapes (an
    // exception thrown here would be uncaught in the plain http listener).
    try {
      const send = r => { res.writeHead(r.status, r.headers); res.end(req.method === 'HEAD' ? '' : r.body) }
      let url
      try { url = new URL(req.url || '/', 'http://unsub.local') } catch { plainText(400, 'bad request'); return }
      if (!url.pathname.startsWith(UNSUB_PATH)) { plainText(404, 'not found'); return }
      let token = ''
      try { token = decodeURIComponent(url.pathname.slice(UNSUB_PATH.length)).replace(/\/+$/, '') } catch { token = '' }
      const clientKey = clientKeyOf(req)
      const finish = body => {
        try { send(unsubResponse({ method: req.method, token, body, clientKey, acceptLanguage: req.headers['accept-language'] }, getDeps())) }
        catch { plainText(500, 'error') }
      }
      if (req.method !== 'POST') { finish(''); return }
      let size = 0; const chunks = []
      req.on('error', () => plainText(400, 'bad request'))
      req.on('data', c => { size += c.length; if (size > 4096) { plainText(413, 'too large'); req.destroy(); return } chunks.push(c) })
      req.on('end', () => { if (size <= 4096) finish(Buffer.concat(chunks).toString('utf8')) })
    } catch { plainText(500, 'error') }
  }
}

/** The unsubscribe listener only ever binds a loopback address (the edge proxy is the public side). */
export function unsubListenHost(h) {
  const s = String(h || '').trim().toLowerCase()
  return s === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s) ? s : '127.0.0.1'
}

/** Find a valid token in a subject or body ("unsubscribe <token>"). */
export function tokenIn(text, key) {
  const re = /([A-Za-z0-9_-]{20,})\.([A-Za-z0-9_-]{32})/g
  let m
  while ((m = re.exec(String(text || '')))) { const p = verifyToken(key, m[0]); if (p) return p }
  return null
}

/** Every address that receives unsubscribe replies (all accounts + the global mailbox). */
export function unsubAddresses(accounts, settings) {
  const out = new Set()
  for (const a of accounts || []) { const m = unsubMailto(a, settings); if (m) out.add(m) }
  if (settings && settings.unsubscribe && settings.unsubscribe.mailto) out.add(bare(settings.unsubscribe.mailto))
  return out
}

/**
 * Process newly synced messages: a mail to an unsubscribe address, or with
 * subject "unsubscribe <token>", suppresses the token's recipient for its
 * list, or (no valid token) the sender for all mail. Each message counts once.
 * @param d { key, addresses (Set), campaigns, lists, suppression, seen: { has(id), add(id) }, audit }
 * @returns number of new suppressions
 */
export function processUnsubMails(rows, d) {
  let n = 0
  for (const r of rows || []) {
    const id = r.account + ':' + (r.msgid || r.folder + ':' + r.uid)
    if (d.seen.has(id)) continue
    const rcpts = [...(r.to || []), ...(r.cc || [])].map(x => bare(x && x.address !== undefined ? x.address : x))
    const toUnsub = rcpts.some(a => d.addresses.has(a))
    const subj = String(r.subject || '')
    const p = d.key ? tokenIn(subj, d.key) : null
    if (!toUnsub && !(p && /\bunsubscribe\b/i.test(subj))) continue
    d.seen.add(id)
    let target = '', list = '', rec = null
    if (p) {
      rec = p.c ? d.campaigns.get(p.c) : null
      const a = rec ? rec.recipients[p.r] : ''
      if (a) { target = a; list = p.l || rec.list }
      else if (recipientHash(r.fromAddr) === p.r) { target = bare(r.fromAddr); list = p.l || '' }
    }
    if (!target && toUnsub) target = bare(r.fromAddr)
    if (!target || !/^[^\s@]+@[^\s@]+$/.test(target)) continue
    const added = list ? d.lists.add(list, target, 'unsubscribed (mail)') : d.suppression.add(target, 'unsubscribed (mail)')
    if (added) {
      n++
      if (rec) { rec.unsubscribed = (rec.unsubscribed || 0) + 1; d.campaigns.save(rec) }
      if (d.audit) d.audit({ actor: 'recipient', action: 'unsubscribe', account: r.account, note: (list ? 'list' : 'all') + ' by mail' })
    }
  }
  return n
}
