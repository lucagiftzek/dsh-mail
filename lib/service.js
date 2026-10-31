/**
 * dsh-mail / service.js: one interface over every account type.
 *
 *   IMAP accounts      live folders + local cache (lib/imap.js, lib/cache.js)
 *   POP3 accounts      local cache only, Inbox only (lib/pop3.js)
 *   tzekos             the webmail agent API (lib/mailbox.js)
 *   legacy/API types   lib/providers.js (Lettermint, Resend, AgentMail, v0.1 SMTP and tzmail)
 *
 * Message ids are composite: "<account>:<folder>:<uid>" (the folder may hold
 * ":"; the account is before the first colon and the uid after the last).
 * Permission checks for agents live in the tools, not here.
 */

'use strict'

import { createRequire } from 'node:module'

import { buildProvider } from './providers.js'
import { agentCall } from './mailbox.js'
import { capabilities, resolvePassword } from './accounts.js'
import { listFolders, syncFolder, fetchFull, setFlags, moveMessages, appendMessage, serverSearch, fetchHeaders, folderForRole, imapTest, ROLE_ORDER, MAX_MESSAGE_BYTES } from './imap.js'
import { smtpSend, smtpVerify, addrList, validateRecipients } from './smtp.js'
import { Pop3Client } from './pop3.js'
import { parseQuery, matches } from './cache.js'
import { sanitizeMailHtml, mailDocument, textToHtml } from './html.js'

const require = createRequire(import.meta.url)
const { simpleParser } = require('mailparser')

const FRESH_MS = 60 * 1000

export function makeId(account, folder, uid) { return account + ':' + folder + ':' + uid }
export function parseId(id) {
  const s = String(id || '')
  const a = s.indexOf(':')
  const b = s.lastIndexOf(':')
  if (a <= 0 || b <= a) return null
  return { account: s.slice(0, a), folder: s.slice(a + 1, b), uid: s.slice(b + 1) }
}

export function receiveKind(acc) {
  if (acc.type === 'tzekos') return (acc.secrets.apiKey || acc.tokenFromFile) ? 'tzekos' : (acc.legacyProvider ? 'provider' : 'none')
  if (acc.legacyProvider && acc.receive.protocol !== 'imap') return ['agentmail', 'tzmail'].includes(acc.legacyProvider) ? 'provider' : 'none'
  if (acc.type === 'agentmail') return 'provider'
  if (acc.receive.protocol === 'imap') return 'imap'
  if (acc.receive.protocol === 'pop3') return 'pop3'
  return 'none'
}

/** v0.1 provider credentials for an account (legacy or API type). */
export function providerFor(acc) {
  if (acc.legacyProvider) return buildProvider(acc.legacyProvider, acc.legacyCreds || {})
  const k = acc.secrets.apiKey || ''
  if (acc.type === 'lettermint') return buildProvider('lettermint', { lettermintApiKey: k, lettermintBaseURL: acc.api.baseUrl || undefined })
  if (acc.type === 'resend') return buildProvider('resend', { resendApiKey: k, resendBaseURL: acc.api.baseUrl || undefined })
  if (acc.type === 'agentmail') return buildProvider('agentmail', { agentmailApiKey: k, agentmailInbox: acc.api.inbox, agentmailBaseURL: acc.api.baseUrl || undefined })
  return null
}

function tzCfg(acc) {
  const token = acc.secrets.apiKey || acc.tokenFromFile || ''
  const baseUrl = String(acc.api.baseUrl || '').replace(/\/+$/, '')
  return { baseUrl, token, configured: !!(token && baseUrl) }
}

const TZ_FOLDERS = [
  { path: 'inbox', name: 'Inbox', role: 'inbox' },
  { path: 'archive', name: 'Archive', role: 'archive' },
  { path: 'trash', name: 'Trash', role: 'trash' },
  { path: 'all', name: 'All mail', role: 'all' },
]

function fmtAddr(a) { return a && a.address ? (a.name ? a.name + ' <' + a.address + '>' : a.address) : '' }
function splitAddr(s) {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(String(s || ''))
  return m ? { name: m[1].trim(), address: m[2].trim().toLowerCase() } : { name: '', address: String(s || '').trim().toLowerCase() }
}

export class MailService {
  /**
   * @param {object} o { cache, pool, settings: () => effective settings, accounts: () => resolved accounts, log, warn, onChange }
   */
  constructor(o) {
    this.o = o
    this.cache = o.cache
    this.pool = o.pool
    this.lastSync = new Map()
    this.inflight = new Map()
    this.status = new Map() // account -> { ok, error, at }
  }

  settings() { return this.o.settings() }
  accounts() { return this.o.accounts() }
  account(id) {
    const a = this.accounts().all.find(x => x.id === id)
    if (!a) throw new Error('unknown account: ' + id)
    return a
  }
  cacheOpts() { const c = this.settings().cache || {}; return { days: Number(c.syncDays) || 90, max: Number(c.initialMax) || 1000 } }
  storeBodies() { const c = this.settings().cache || {}; return c.storeBodies !== false && Number(c.retentionDays) !== 0 }
  setStatus(id, ok, error) { this.status.set(id, { ok, error: error ? String(error).slice(0, 300) : '', at: Date.now() }) }

  // ── folders ───────────────────────────────────────────────────────────────

  async folders(acc) {
    const kind = receiveKind(acc)
    if (kind === 'imap') {
      try {
        const live = await listFolders(this.pool, acc)
        for (const f of live) {
          const prev = this.cache.folder(acc.id, f.path)
          this.cache.putFolder({ ...(prev || {}), account: acc.id, path: f.path, name: f.name, role: f.role, delimiter: f.delimiter, unseen: f.unseen, total: f.total })
        }
        this.setStatus(acc.id, true)
        return sortFolders(live)
      } catch (e) {
        this.setStatus(acc.id, false, e.message)
        const cached = this.cache.folders(acc.id).map(f => ({ path: f.path, name: f.name, role: f.role, unseen: f.unseen, total: f.total, offline: true }))
        if (cached.length) return sortFolders(cached)
        throw e
      }
    }
    if (kind === 'pop3') return [{ path: 'INBOX', name: 'Inbox', role: 'inbox', unseen: this.cache.unseen(acc.id, 'INBOX'), total: null }]
    if (kind === 'tzekos') return TZ_FOLDERS.map(f => ({ ...f, unseen: null, total: null }))
    if (kind === 'provider') return [{ path: 'INBOX', name: 'Inbox', role: 'inbox', unseen: null, total: null }]
    return []
  }

  inboxPath(acc) {
    const k = receiveKind(acc)
    return k === 'tzekos' ? 'inbox' : 'INBOX'
  }

  // ── sync ──────────────────────────────────────────────────────────────────

  async sync(acc, folder, { force = false } = {}) {
    const kind = receiveKind(acc)
    if (kind !== 'imap' && kind !== 'pop3') return null
    const path = folder || 'INBOX'
    const key = acc.id + '\u0000' + path
    if (!force && Date.now() - (this.lastSync.get(key) || 0) < FRESH_MS) return null
    if (this.inflight.has(key)) return this.inflight.get(key)
    const p = (async () => {
      try {
        const r = kind === 'imap' ? await syncFolder(this.pool, acc, this.cache, path, this.cacheOpts()) : await this.syncPop(acc)
        this.lastSync.set(key, Date.now())
        this.setStatus(acc.id, true)
        if (r && r.added && this.o.onChange) this.o.onChange({ type: 'sync', account: acc.id, folder: path, added: r.added })
        return r
      } catch (e) { this.setStatus(acc.id, false, e.message); throw e }
      finally { this.inflight.delete(key) }
    })()
    this.inflight.set(key, p)
    return p
  }

  popOptions(acc) {
    const e = acc.receive
    return { host: e.host, port: Number(e.port), security: e.security, user: (acc.auth && acc.auth.user) || e.user || acc.address, pass: resolvePassword(acc), allowSelfSigned: acc.allowSelfSigned }
  }

  async syncPop(acc) {
    const c = new Pop3Client(this.popOptions(acc))
    await c.connect()
    try {
      const list = await c.uidl()
      const known = new Set(this.cache.uids(acc.id, 'INBOX'))
      const onServer = new Set(list.map(x => x.uid))
      let removed = 0
      for (const u of known) if (!onServer.has(u)) { this.cache.deleteMessage(acc.id, 'INBOX', u); removed++ }
      const fresh = list.filter(x => !known.has(x.uid)).slice(-this.cacheOpts().max)
      const rows = []
      for (const x of fresh) {
        const head = await c.top(x.num, 40)
        const p = await simpleParser(head, { skipImageLinks: true })
        const from = (p.from && p.from.value && p.from.value[0]) || {}
        rows.push({
          account: acc.id, folder: 'INBOX', uid: x.uid, msgid: p.messageId || null, inReplyTo: p.inReplyTo || null,
          refs: Array.isArray(p.references) ? p.references.join(' ') : (p.references || null),
          fromName: from.name || '', fromAddr: from.address || '',
          to: ((p.to && p.to.value) || []).map(a => ({ name: a.name || '', address: (a.address || '').toLowerCase() })),
          cc: ((p.cc && p.cc.value) || []).map(a => ({ name: a.name || '', address: (a.address || '').toLowerCase() })),
          subject: p.subject || '', date: p.date ? p.date.getTime() : 0, flags: [], size: 0,
          hasAtt: /multipart\/mixed/i.test(String(p.headers.get('content-type') && p.headers.get('content-type').value)),
          snippet: String(p.text || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        })
      }
      rows.sort((a, b) => a.date - b.date)
      for (const r of rows) this.cache.putMessage(r)
      this.cache.putFolder({ account: acc.id, path: 'INBOX', name: 'Inbox', role: 'inbox', delimiter: '/', unseen: this.cache.unseen(acc.id, 'INBOX'), total: list.length, synced_at: Date.now() })
      return { added: rows.length, removed, total: list.length }
    } finally { await c.quit() }
  }

  // ── listing ───────────────────────────────────────────────────────────────

  rowFromCache(g, acc) {
    const r = g.latest
    return {
      account: g.account, thread: g.thread, id: makeId(g.account, r.folder, r.uid), folder: r.folder,
      from: { name: r.from_name, address: r.from_addr }, subject: r.subject, snippet: r.snippet, date: r.date,
      unread: g.unread, count: g.count, flagged: !!g.flagged, hasAtt: !!g.has_att, color: acc ? acc.color : '',
    }
  }

  /**
   * Thread list. account "all" (or empty) = the unified inbox.
   * @returns {{ rows, total, errors }}
   */
  async list({ account = 'all', folder = '', q = '', filter = '', limit = 50, offset = 0, sync = true } = {}) {
    const res = this.accounts()
    const errors = []
    const qobj = q ? parseQuery(q) : null
    const f = { q: qobj, unread: filter === 'unread', flagged: filter === 'flagged', attachments: filter === 'attachments' }
    const targets = account && account !== 'all'
      ? [{ acc: this.account(account), folder: folder || null }]
      : res.all.filter(a => a.enabled && receiveKind(a) !== 'none').map(a => ({ acc: a, folder: null }))
    const cacheSources = []
    let apiRows = []
    for (const t of targets) {
      const kind = receiveKind(t.acc)
      const path = t.folder || this.inboxPath(t.acc)
      try {
        if (kind === 'imap' || kind === 'pop3') {
          if (sync) await this.sync(t.acc, path).catch(e => errors.push({ account: t.acc.id, error: this.scrub(e.message) }))
          cacheSources.push({ account: t.acc.id, folder: path })
        } else if (kind === 'tzekos') {
          const r = await agentCall(tzCfg(t.acc), 'threads', { view: path, q: q || undefined, limit: Math.min(50, limit + offset) })
          apiRows = apiRows.concat((r.threads || []).map(th => ({
            account: t.acc.id, thread: th.id, id: makeId(t.acc.id, path, th.id), folder: path,
            from: splitAddr(th.last_from || ''), subject: th.subject || '', snippet: th.preview || '',
            date: Date.parse(th.last_message_at || '') || 0, unread: th.unread_count || 0, count: th.message_count || 1,
            flagged: !!th.starred, hasAtt: false, color: t.acc.color,
          })).filter(row => matches({ seen: !row.unread, flagged: row.flagged, has_att: false, subject: row.subject, from_name: row.from.name, from_addr: row.from.address, snippet: row.snippet, to: [], date: row.date }, { ...f, q: null })))
        } else if (kind === 'provider') {
          const p = providerFor(t.acc)
          if (p && p.enabled() && typeof p.recent === 'function') {
            const msgs = await p.recent({}, Math.min(100, limit + offset))
            apiRows = apiRows.concat(msgs.map(m => ({
              account: t.acc.id, thread: m.messageId, id: makeId(t.acc.id, 'INBOX', m.messageId), folder: 'INBOX',
              from: splitAddr(m.from), subject: m.subject || '', snippet: String(m.text || '').slice(0, 200),
              date: Date.parse(m.timestamp || '') || 0, unread: m.unread || 0, count: m.messages || 1, flagged: false, hasAtt: false, color: t.acc.color,
            })).filter(row => !qobj || matches({ seen: true, subject: row.subject, from_name: row.from.name, from_addr: row.from.address, snippet: row.snippet, to: [], date: row.date }, { q: qobj })))
          }
        }
      } catch (e) {
        this.setStatus(t.acc.id, false, e.message)
        errors.push({ account: t.acc.id, error: this.scrub(e.message) })
      }
    }
    const byId = new Map(res.all.map(a => [a.id, a]))
    const cached = this.cache.threads(cacheSources, { filter: f, limit: limit + offset + 1000, offset: 0 })
    let rows = cached.rows.map(g => this.rowFromCache(g, byId.get(g.account))).concat(apiRows)
    rows.sort((a, b) => b.date - a.date)
    const total = cached.total + apiRows.length
    rows = rows.slice(offset, offset + limit)
    return { rows, total, errors, updatedAt: Date.now() }
  }

  /** Messages of one thread (headers; bodies come from message()). */
  async thread(accountId, thread, folder) {
    const acc = this.account(accountId)
    const kind = receiveKind(acc)
    if (kind === 'imap' || kind === 'pop3') {
      const msgs = this.cache.threadMessages(acc.id, thread)
      return {
        account: acc.id, thread, subject: msgs.length ? msgs[msgs.length - 1].subject : '',
        messages: msgs.map(m => ({
          id: makeId(acc.id, m.folder, m.uid), folder: m.folder, from: { name: m.from_name, address: m.from_addr }, to: m.to, cc: m.cc,
          subject: m.subject, date: m.date, snippet: m.snippet, seen: m.seen, flagged: m.flagged, hasAtt: m.has_att,
        })),
      }
    }
    if (kind === 'tzekos') {
      const r = await agentCall(tzCfg(acc), 'thread', { id: thread })
      return {
        account: acc.id, thread, subject: (r.thread && r.thread.subject) || '',
        reminder: r.reminder || null,
        messages: (r.messages || []).map(m => ({
          id: makeId(acc.id, folder || 'inbox', thread) + '#' + m.id, folder: folder || 'inbox', from: splitAddr(m.from_addr), to: (m.to_addrs || []).map(splitAddr), cc: (m.cc_addrs || []).map(splitAddr),
          subject: m.subject || '', date: Date.parse(m.received_at || m.created_at || '') || 0, snippet: m.snippet || '', seen: !!m.read, flagged: !!m.starred, hasAtt: false,
          direction: m.direction, text: String(m.text_body || m.snippet || ''),
          srcdoc: mailDocument(textToHtml(m.text_body || m.snippet || '')), blocked: 0, attachments: [],
        })),
      }
    }
    if (kind === 'provider') {
      const p = providerFor(acc)
      const m = await p.fetch({}, thread)
      return {
        account: acc.id, thread, subject: m.subject || '',
        messages: [{ id: makeId(acc.id, 'INBOX', m.messageId || thread), folder: 'INBOX', from: splitAddr(m.from), to: [splitAddr(m.to)], cc: [], subject: m.subject || '', date: Date.parse(m.timestamp || '') || 0, snippet: '', seen: true, flagged: false, hasAtt: false, text: m.text || '', srcdoc: mailDocument(textToHtml(m.text || '')), blocked: 0, attachments: [] }],
      }
    }
    throw new Error('account ' + acc.id + ' cannot read mail')
  }

  async rawMessage(acc, folder, uid) {
    const kind = receiveKind(acc)
    if (kind === 'imap') return fetchFull(this.pool, acc, folder, uid)
    if (kind === 'pop3') {
      const c = new Pop3Client(this.popOptions(acc))
      await c.connect()
      try {
        const hit = (await c.uidl()).find(x => x.uid === String(uid))
        if (!hit) throw new Error('message is no longer on the POP3 server')
        const size = ((await c.list()).find(x => x.num === hit.num) || {}).size || 0
        if (size > MAX_MESSAGE_BYTES) throw new Error('message is larger than 25 MB')
        const parsed = await simpleParser(await c.retr(hit.num), { skipImageLinks: true })
        const row = this.cache.getMessage(acc.id, folder, uid)
        return { parsed, flags: row ? row.flags : [], size }
      } finally { await c.quit() }
    }
    throw new Error('account ' + acc.id + ' has no raw message access')
  }

  /** One full message for the reading view (sanitised HTML in a CSP document). */
  async message(id, { images = false } = {}) {
    const ref = parseId(id)
    if (!ref) throw new Error('invalid message id')
    const acc = this.account(ref.account)
    const kind = receiveKind(acc)
    if (kind === 'tzekos' || kind === 'provider') {
      const t = await this.thread(acc.id, ref.uid.split('#')[0], ref.folder)
      const m = t.messages.find(x => x.id === id) || t.messages[t.messages.length - 1]
      return { ...m, account: acc.id }
    }
    const { parsed, flags } = await this.rawMessage(acc, ref.folder, ref.uid)
    const atts = (parsed.attachments || [])
    const cid = new Map()
    atts.forEach(a => { if (a.contentId && /^image\//i.test(a.contentType) && a.size < 2 * 1024 * 1024) cid.set(String(a.contentId).replace(/^<|>$/g, ''), 'data:' + a.contentType + ';base64,' + a.content.toString('base64')) })
    let body, blocked = 0
    if (parsed.html) { const s = sanitizeMailHtml(parsed.html, { images, cid }); body = s.html; blocked = s.blocked }
    else body = textToHtml(parsed.text || '')
    const text = parsed.text || ''
    if (this.storeBodies()) { try { this.cache.setBody(acc.id, ref.folder, ref.uid, text.slice(0, 200000)) } catch {} }
    const from = (parsed.from && parsed.from.value && parsed.from.value[0]) || {}
    return {
      id, account: acc.id, folder: ref.folder, uid: ref.uid,
      from: { name: from.name || '', address: (from.address || '').toLowerCase() },
      to: ((parsed.to && parsed.to.value) || []).map(a => ({ name: a.name || '', address: a.address || '' })),
      cc: ((parsed.cc && parsed.cc.value) || []).map(a => ({ name: a.name || '', address: a.address || '' })),
      subject: parsed.subject || '', date: parsed.date ? parsed.date.getTime() : 0,
      messageId: parsed.messageId || '', inReplyTo: parsed.inReplyTo || '', references: Array.isArray(parsed.references) ? parsed.references.join(' ') : (parsed.references || ''),
      text, srcdoc: mailDocument(body, { images }), blocked, flags,
      seen: flags.includes('\\Seen'), flagged: flags.includes('\\Flagged'),
      attachments: atts.map((a, i) => ({ part: i, filename: safeName(a.filename || 'attachment-' + (i + 1)), contentType: a.contentType || 'application/octet-stream', size: a.size || 0, inline: a.contentDisposition === 'inline' && !!a.contentId })),
    }
  }

  async attachment(id, part) {
    const ref = parseId(id)
    if (!ref) throw new Error('invalid message id')
    if (!/^\d{1,4}$/.test(String(part))) throw new Error('invalid part id')
    const acc = this.account(ref.account)
    const { parsed } = await this.rawMessage(acc, ref.folder, ref.uid)
    const a = (parsed.attachments || [])[Number(part)]
    if (!a) throw new Error('attachment not found')
    if (a.size > MAX_MESSAGE_BYTES) throw new Error('attachment is larger than 25 MB')
    return { filename: safeName(a.filename || 'attachment-' + (Number(part) + 1)), contentType: a.contentType || 'application/octet-stream', content: a.content }
  }

  // ── actions ───────────────────────────────────────────────────────────────

  groupIds(ids) {
    const groups = new Map()
    for (const id of ids || []) {
      const r = parseId(id)
      if (!r) throw new Error('invalid message id: ' + String(id).slice(0, 80))
      const k = r.account + '\u0000' + r.folder
      if (!groups.has(k)) groups.set(k, { account: r.account, folder: r.folder, uids: [] })
      groups.get(k).uids.push(r.uid.split('#')[0])
    }
    return [...groups.values()]
  }

  /** op: read | unread | flag | unflag */
  async mark(ids, op) {
    const OPS = { read: [['\\Seen'], []], unread: [[], ['\\Seen']], flag: [['\\Flagged'], []], unflag: [[], ['\\Flagged']] }
    if (!OPS[op]) throw new Error('op must be read, unread, flag or unflag')
    let updated = 0
    for (const g of this.groupIds(ids)) {
      const acc = this.account(g.account)
      const kind = receiveKind(acc)
      if (kind === 'imap') {
        const flags = await setFlags(this.pool, acc, g.folder, g.uids, { add: OPS[op][0], remove: OPS[op][1] })
        for (const [uid, f] of Object.entries(flags)) this.cache.setFlags(acc.id, g.folder, uid, f)
        updated += g.uids.length
      } else if (kind === 'pop3') {
        for (const uid of g.uids) {
          const row = this.cache.getMessage(acc.id, g.folder, uid)
          if (!row) continue
          const set = new Set(row.flags)
          OPS[op][0].forEach(x => set.add(x)); OPS[op][1].forEach(x => set.delete(x))
          this.cache.setFlags(acc.id, g.folder, uid, [...set]); updated++
        }
      } else if (kind === 'tzekos') {
        const r = op === 'read' || op === 'unread'
          ? await agentCall(tzCfg(acc), 'mark', { ids: g.uids, read: op === 'read' })
          : await agentCall(tzCfg(acc), 'move', { ids: g.uids, move: op === 'flag' ? 'star' : 'unstar' })
        updated += r.updated != null ? r.updated : g.uids.length
      } else throw new Error('account ' + acc.id + ' does not support marking')
    }
    if (this.o.onChange) this.o.onChange({ type: 'changed' })
    return { updated }
  }

  /** to: inbox | archive | trash | spam | junk | <folder path>. Never deletes permanently. */
  async move(ids, to) {
    const target = String(to || '').trim()
    if (!target) throw new Error('target folder required')
    let moved = 0
    for (const g of this.groupIds(ids)) {
      const acc = this.account(g.account)
      const kind = receiveKind(acc)
      if (kind === 'imap') {
        const role = target === 'spam' ? 'junk' : target
        let folders = this.cache.folders(acc.id).map(f => ({ path: f.path, name: f.name || f.path, role: f.role || '' }))
        if (!folders.length || !folderForRole(folders, role, acc)) folders = await this.folders(acc)
        const dest = folderForRole(folders, role, acc)
        if (!dest) throw new Error('no ' + target + ' folder on account ' + acc.id)
        if (dest === g.folder) continue
        await moveMessages(this.pool, acc, g.folder, g.uids, dest)
        for (const uid of g.uids) this.cache.deleteMessage(acc.id, g.folder, uid)
        this.lastSync.delete(acc.id + '\u0000' + dest)
        moved += g.uids.length
      } else if (kind === 'tzekos') {
        const map = { inbox: 'inbox', archive: 'archive', trash: 'trash', spam: 'trash', junk: 'trash', restore: 'restore' }
        if (!map[target]) throw new Error('Tzekos Mail moves to inbox, archive or trash')
        const r = await agentCall(tzCfg(acc), 'move', { ids: g.uids, move: map[target] })
        moved += r.updated != null ? r.updated : g.uids.length
      } else throw new Error('account ' + acc.id + ' has no server folders (POP3 or send-only)')
    }
    if (this.o.onChange) this.o.onChange({ type: 'changed' })
    return { moved }
  }

  /** Message-level search: cache first, then IMAP SEARCH in one folder to reach older mail. */
  async search({ account = '', folder = '', query = '', limit = 20 } = {}) {
    const lim = Math.min(50, Math.max(1, Number(limit) || 20))
    const q = parseQuery(query)
    const res = this.accounts()
    const accs = account ? [this.account(account)] : res.all.filter(a => a.enabled && receiveKind(a) !== 'none')
    const out = []
    const errors = []
    for (const acc of accs) {
      const kind = receiveKind(acc)
      try {
        if (kind === 'imap' || kind === 'pop3') {
          const path = folder || 'INBOX'
          await this.sync(acc, path).catch(() => {})
          const rows = (folder ? this.cache.messages(acc.id, path) : this.cache.accountMessages(acc.id)).filter(r => matches(r, { q }))
          for (const r of rows) out.push(this.searchRow(acc.id, r))
          if (kind === 'imap' && rows.length < lim) {
            const crit = {}
            if (q.from) crit.from = q.from
            if (q.to) crit.to = q.to
            if (q.subject) crit.subject = q.subject
            if (q.unread) crit.seen = false
            if (q.flagged) crit.flagged = true
            if (q.after) crit.since = new Date(q.after)
            if (q.before) crit.before = new Date(q.before)
            if (q.text.length) crit.text = q.text.join(' ')
            if (Object.keys(crit).length) {
              const uids = (await serverSearch(this.pool, acc, path, crit)).sort((a, b) => b - a).slice(0, lim)
              const missing = uids.filter(u => !this.cache.getMessage(acc.id, path, u))
              for (const r of await fetchHeaders(this.pool, acc, path, missing)) this.cache.putMessage(r)
              for (const u of missing) { const r = this.cache.getMessage(acc.id, path, u); if (r && matches(r, { q: { ...q, text: [] } })) out.push(this.searchRow(acc.id, r)) }
            }
          }
        } else if (kind === 'tzekos') {
          const r = await agentCall(tzCfg(acc), 'threads', { view: folder || 'all', q: [q.from, q.to, q.subject, ...q.text].filter(Boolean).join(' ') || undefined, limit: lim })
          for (const t of r.threads || []) out.push({ id: makeId(acc.id, folder || 'all', t.id), account: acc.id, thread: t.id, from: t.last_from || '', subject: t.subject || '', date: Date.parse(t.last_message_at || '') || 0, snippet: t.preview || '', unread: (t.unread_count || 0) > 0 })
        } else if (kind === 'provider') {
          const p = providerFor(acc)
          const msgs = await p.recent({}, 100)
          for (const m of msgs) {
            const row = { seen: true, flagged: false, has_att: false, subject: m.subject || '', from_name: '', from_addr: String(m.from || '').toLowerCase(), snippet: String(m.text || ''), to: [m.to], date: Date.parse(m.timestamp || '') || 0 }
            if (matches(row, { q })) out.push({ id: makeId(acc.id, 'INBOX', m.messageId), account: acc.id, thread: m.messageId, from: m.from || '', subject: m.subject || '', date: row.date, snippet: String(m.text || '').slice(0, 200), unread: false })
          }
        }
      } catch (e) { errors.push({ account: acc.id, error: this.scrub(e.message) }) }
    }
    const seen = new Set()
    const rows = out.filter(r => (seen.has(r.id) ? false : seen.add(r.id))).sort((a, b) => b.date - a.date).slice(0, lim)
    return { rows, errors }
  }

  searchRow(account, r) {
    return { id: makeId(account, r.folder, r.uid), account, folder: r.folder, thread: r.thread, from: fmtAddr({ name: r.from_name, address: r.from_addr }), subject: r.subject, date: r.date, snippet: r.snippet, unread: !r.seen, flagged: r.flagged, hasAtt: r.has_att }
  }

  // ── sending ───────────────────────────────────────────────────────────────

  /**
   * Send one message through the account. msg: { from, to, cc, bcc, subject, text, html, replyTo, inReplyTo, references, attachments (loaded), threadId }
   */
  async send(acc, msg) {
    if (!acc.enabled) throw new Error('account ' + acc.id + ' is disabled')
    const to = addrList(msg.to)
    const all = [...to, ...addrList(msg.cc), ...addrList(msg.bcc)]
    if (!all.length && !msg.threadId) throw new Error('no recipient')
    if (all.length) validateRecipients(all)
    const max = Math.min(Number(acc.limits.maxRecipients) || 500, Number(this.settings().maxRecipients) || 500)
    if (all.length > max) throw new Error('too many recipients: ' + all.length + ' > ' + max)
    if (acc.type === 'tzekos' && !acc.legacyProvider) {
      const cfg = tzCfg(acc)
      const r = await agentCall(cfg, 'send', { to: to.join(', '), subject: msg.subject || '', text: msg.text || '', threadId: msg.threadId || undefined, confirm: true })
      return { messageId: (r.message && (r.message.message_id || r.message.id)) || r.messageId || '', from: msg.from || acc.address || '' }
    }
    const p = acc.send.protocol === 'smtp' && !acc.legacyProvider ? null : providerFor(acc)
    if (p) {
      if (!p.enabled()) throw new Error('provider ' + acc.id + ' is not configured')
      const from = msg.from || acc.defaultFrom || this.settings().defaultFrom || ''
      return p.send({}, { ...msg, from, to: to.length ? to : msg.to, replyTo: msg.replyTo || acc.replyTo || undefined })
    }
    if (acc.send.protocol !== 'smtp') throw new Error('account ' + acc.id + ' cannot send')
    const r = await smtpSend(acc, { ...msg, to, cc: addrList(msg.cc), bcc: addrList(msg.bcc) })
    // Keep a copy in Sent for IMAP accounts (Gmail stores it by itself).
    if (receiveKind(acc) === 'imap' && !/(^|\.)gmail\.com$|googlemail\.com$/i.test(acc.send.host)) {
      try {
        const folders = this.cache.folders(acc.id).length ? this.cache.folders(acc.id) : await this.folders(acc)
        const sent = folderForRole(folders.map(f => ({ path: f.path, name: f.name || f.path, role: f.role || '' })), 'sent', acc)
        if (sent) await appendMessage(this.pool, acc, sent, r.raw, ['\\Seen'])
      } catch (e) { if (this.o.warn) this.o.warn('append to Sent failed for ' + acc.id + ': ' + this.scrub(e.message)) }
    }
    return { messageId: r.messageId, from: r.from }
  }

  // ── test connection ───────────────────────────────────────────────────────

  async test(acc) {
    const steps = []
    const step = async (name, fn) => {
      try { const d = await fn(); steps.push({ step: name, ok: true, detail: d || 'ok' }) }
      catch (e) { steps.push({ step: name, ok: false, detail: this.scrub(e && e.message ? e.message : String(e), acc) }) }
    }
    const kind = receiveKind(acc)
    if (kind === 'imap') await step('IMAP login + LIST', async () => { const r = await imapTest(acc); return r.folders + ' folders' })
    if (kind === 'pop3') await step('POP3 login + STAT', async () => { const c = new Pop3Client(this.popOptions(acc)); await c.connect(); try { const s = await c.stat(); return s.count + ' messages' } finally { await c.quit() } })
    if (kind === 'tzekos') await step('Webmail agent API', async () => { const r = await agentCall(tzCfg(acc), 'accounts', {}); return (r.accounts || []).length + ' mailbox(es)' })
    if (kind === 'provider' && acc.type === 'agentmail') await step('AgentMail inbox', async () => { const r = await providerFor(acc).recent({}, 1); return 'reachable (' + r.length + ')' })
    if (acc.send.protocol === 'smtp' && !acc.legacyProvider) await step('SMTP verify', async () => { await smtpVerify(acc); return 'ok' })
    else if (acc.send.protocol === 'smtp' && acc.legacyProvider) await step('SMTP configuration', async () => { const p = providerFor(acc); if (!p || !p.enabled()) throw new Error('incomplete'); return 'configured' })
    if (['lettermint', 'resend'].includes(acc.type)) await step('API key present', async () => { const p = providerFor(acc); if (!p || !p.enabled()) throw new Error('no API key'); return 'configured (send is verified on first use)' })
    return { ok: steps.length > 0 && steps.every(s => s.ok), steps, capabilities: capabilities(acc) }
  }

  scrub(message, extraAcc) {
    const s = this.o.scrub ? this.o.scrub(message) : String(message)
    if (!extraAcc) return s
    let m = s
    for (const v of Object.values(extraAcc.secrets || {})) if (v && v.length >= 4) m = m.split(v).join('***')
    return m
  }
}

function sortFolders(list) {
  const rank = f => { const i = ROLE_ORDER.indexOf(f.role); return i < 0 ? 100 : i }
  return [...list].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path))
}

export function safeName(n) {
  const s = String(n || '').replace(/[\\/\u0000-\u001f\u007f]+/g, '_').replace(/^\.+/, '_').trim()
  return (s || 'attachment').slice(0, 180)
}
