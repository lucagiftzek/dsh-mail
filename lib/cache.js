/**
 * dsh-mail / cache.js: the local mail cache.
 *
 * SQLite through the built-in node:sqlite (DatabaseSync) at
 * ~/.dsh/dsh-mail/cache.db (mode 0600). Tables: folders, messages, threads,
 * meta. When node:sqlite is unavailable the same API runs on an in-memory
 * store (nothing persists across restarts; a warning is logged).
 *
 * Bodies are cached as plain text only (HTML and attachments are fetched on
 * open). Threading: References / In-Reply-To first, then a normalised subject
 * fallback for "Re:" / "Fwd:" messages of the same account within 60 days.
 */

'use strict'

import { createHash } from 'node:crypto'
import { mkdirSync, chmodSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { createRequire } from 'node:module'

const SUBJECT_WINDOW_MS = 60 * 86400 * 1000

export function normSubject(s) {
  let t = String(s || '').trim()
  for (let i = 0; i < 5; i++) {
    const n = t.replace(/^\s*((re|fw|fwd|aw|wg|sv|vs|antw|r|rif|tr)(\[\d+\])?\s*:\s*)/i, '').replace(/^\[[^\]]{1,40}\]\s*/, '')
    if (n === t) break
    t = n
  }
  return t.toLowerCase().replace(/\s+/g, ' ').trim()
}

function hasReplyPrefix(s) { return /^\s*(re|fw|fwd|aw|wg|sv|vs|antw|r|rif|tr)(\[\d+\])?\s*:/i.test(String(s || '')) }

export function parseRefs(v) {
  return String(v || '').match(/<[^<>\s]+>/g) || []
}

function sha(s) { return createHash('sha1').update(String(s)).digest('hex').slice(0, 16) }

const MSG_COLS = ['account', 'folder', 'uid', 'msgid', 'in_reply_to', 'refs', 'thread', 'from_name', 'from_addr', 'to_json', 'cc_json', 'subject', 'subject_norm', 'date', 'flags', 'seen', 'flagged', 'snippet', 'has_att', 'body_text', 'size', 'synced_at']

function rowOut(r) {
  if (!r) return null
  return {
    ...r,
    uid: String(r.uid),
    to: safeJson(r.to_json, []),
    cc: safeJson(r.cc_json, []),
    flags: safeJson(r.flags, []),
    seen: !!r.seen, flagged: !!r.flagged, has_att: !!r.has_att,
    date: Number(r.date) || 0,
  }
}
function safeJson(s, d) { try { return s ? JSON.parse(s) : d } catch { return d } }

// ── backends ────────────────────────────────────────────────────────────────

class SqliteBackend {
  constructor(path) {
    const req = createRequire(import.meta.url)
    const { DatabaseSync } = req('node:sqlite')
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const fresh = !existsSync(path)
      this.db = new DatabaseSync(path)
      if (fresh) { try { chmodSync(path, 0o600) } catch {} }
    } else this.db = new DatabaseSync(':memory:')
    this.kind = 'sqlite'
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS folders (account TEXT, path TEXT, name TEXT, role TEXT, delimiter TEXT,
        uidvalidity TEXT, uidnext INTEGER, highestmodseq TEXT, unseen INTEGER, total INTEGER, synced_at INTEGER,
        PRIMARY KEY (account, path));
      CREATE TABLE IF NOT EXISTS messages (account TEXT, folder TEXT, uid TEXT, msgid TEXT, in_reply_to TEXT, refs TEXT,
        thread TEXT, from_name TEXT, from_addr TEXT, to_json TEXT, cc_json TEXT, subject TEXT, subject_norm TEXT,
        date INTEGER, flags TEXT, seen INTEGER, flagged INTEGER, snippet TEXT, has_att INTEGER, body_text TEXT,
        size INTEGER, synced_at INTEGER, PRIMARY KEY (account, folder, uid));
      CREATE INDEX IF NOT EXISTS messages_folder_date ON messages (account, folder, date);
      CREATE INDEX IF NOT EXISTS messages_msgid ON messages (account, msgid);
      CREATE INDEX IF NOT EXISTS messages_thread ON messages (account, thread);
      CREATE TABLE IF NOT EXISTS threads (account TEXT, thread TEXT, subject_norm TEXT, last_date INTEGER, count INTEGER,
        PRIMARY KEY (account, thread));
      CREATE INDEX IF NOT EXISTS threads_subject ON threads (account, subject_norm);
    `)
    this.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schemaVersion', '1')").run()
    const ph = MSG_COLS.map(() => '?').join(',')
    this.st = {
      put: this.db.prepare('INSERT OR REPLACE INTO messages (' + MSG_COLS.join(',') + ') VALUES (' + ph + ')'),
      get: this.db.prepare('SELECT * FROM messages WHERE account=? AND folder=? AND uid=?'),
      del: this.db.prepare('DELETE FROM messages WHERE account=? AND folder=? AND uid=?'),
      byFolder: this.db.prepare('SELECT * FROM messages WHERE account=? AND folder=? ORDER BY date DESC LIMIT ?'),
      byAccount: this.db.prepare('SELECT * FROM messages WHERE account=? ORDER BY date DESC LIMIT ?'),
      byThread: this.db.prepare('SELECT * FROM messages WHERE account=? AND thread=? ORDER BY date ASC'),
      byMsgid: this.db.prepare('SELECT thread FROM messages WHERE account=? AND msgid=? LIMIT 1'),
      threadBySubject: this.db.prepare('SELECT thread, last_date FROM threads WHERE account=? AND subject_norm=? ORDER BY last_date DESC LIMIT 1'),
      threadUp: this.db.prepare('INSERT INTO threads (account, thread, subject_norm, last_date, count) VALUES (?,?,?,?,1) ON CONFLICT(account, thread) DO UPDATE SET last_date=max(last_date, excluded.last_date), count=count+1'),
      uids: this.db.prepare('SELECT uid FROM messages WHERE account=? AND folder=?'),
      folderPut: this.db.prepare('INSERT OR REPLACE INTO folders (account, path, name, role, delimiter, uidvalidity, uidnext, highestmodseq, unseen, total, synced_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
      folders: this.db.prepare('SELECT * FROM folders WHERE account=? ORDER BY path'),
      folder: this.db.prepare('SELECT * FROM folders WHERE account=? AND path=?'),
      delFolderMsgs: this.db.prepare('DELETE FROM messages WHERE account=? AND folder=?'),
      delAccountMsgs: this.db.prepare('DELETE FROM messages WHERE account=?'),
      delAccountFolders: this.db.prepare('DELETE FROM folders WHERE account=?'),
      delAccountThreads: this.db.prepare('DELETE FROM threads WHERE account=?'),
      setFlags: this.db.prepare('UPDATE messages SET flags=?, seen=?, flagged=? WHERE account=? AND folder=? AND uid=?'),
      setBody: this.db.prepare('UPDATE messages SET body_text=? WHERE account=? AND folder=? AND uid=?'),
      prune: this.db.prepare('UPDATE messages SET body_text=NULL WHERE body_text IS NOT NULL AND date < ?'),
      pruneAll: this.db.prepare('UPDATE messages SET body_text=NULL WHERE body_text IS NOT NULL'),
      unseen: this.db.prepare('SELECT count(*) AS n FROM messages WHERE account=? AND folder=? AND seen=0'),
    }
  }
  putMessage(r) { this.st.put.run(...MSG_COLS.map(c => r[c] === undefined ? null : r[c])) }
  getMessage(a, f, u) { return this.st.get.get(a, f, String(u)) }
  deleteMessage(a, f, u) { this.st.del.run(a, f, String(u)) }
  messagesByFolder(a, f, limit) { return this.st.byFolder.all(a, f, limit) }
  messagesByAccount(a, limit) { return this.st.byAccount.all(a, limit) }
  messagesByThread(a, t) { return this.st.byThread.all(a, t) }
  threadOfMsgid(a, id) { const r = this.st.byMsgid.get(a, id); return r ? r.thread : null }
  threadBySubject(a, s) { return this.st.threadBySubject.get(a, s) || null }
  touchThread(a, t, s, d) { this.st.threadUp.run(a, t, s, d) }
  uids(a, f) { return this.st.uids.all(a, f).map(r => String(r.uid)) }
  putFolder(f) { this.st.folderPut.run(f.account, f.path, f.name, f.role, f.delimiter, f.uidvalidity == null ? null : String(f.uidvalidity), f.uidnext ?? null, f.highestmodseq == null ? null : String(f.highestmodseq), f.unseen ?? null, f.total ?? null, f.synced_at ?? null) }
  folders(a) { return this.st.folders.all(a) }
  folder(a, p) { return this.st.folder.get(a, p) || null }
  deleteFolderMessages(a, f) { this.st.delFolderMsgs.run(a, f) }
  deleteAccount(a) { this.st.delAccountMsgs.run(a); this.st.delAccountFolders.run(a); this.st.delAccountThreads.run(a) }
  setFlags(a, f, u, flags, seen, flagged) { this.st.setFlags.run(JSON.stringify(flags), seen ? 1 : 0, flagged ? 1 : 0, a, f, String(u)) }
  setBody(a, f, u, text) { this.st.setBody.run(text, a, f, String(u)) }
  pruneBodies(before) { return before === null ? this.st.pruneAll.run().changes : this.st.prune.run(before).changes }
  unseen(a, f) { return this.st.unseen.get(a, f).n }
  close() { try { this.db.close() } catch {} }
}

class MemoryBackend {
  constructor() { this.kind = 'memory'; this.m = new Map(); this.f = new Map(); this.t = new Map() }
  k(a, f, u) { return a + '\u0000' + f + '\u0000' + u }
  putMessage(r) { this.m.set(this.k(r.account, r.folder, r.uid), { ...r }) }
  getMessage(a, f, u) { return this.m.get(this.k(a, f, String(u))) || null }
  deleteMessage(a, f, u) { this.m.delete(this.k(a, f, String(u))) }
  _all(a) { return [...this.m.values()].filter(r => r.account === a) }
  messagesByFolder(a, f, limit) { return this._all(a).filter(r => r.folder === f).sort((x, y) => y.date - x.date).slice(0, limit) }
  messagesByAccount(a, limit) { return this._all(a).sort((x, y) => y.date - x.date).slice(0, limit) }
  messagesByThread(a, t) { return this._all(a).filter(r => r.thread === t).sort((x, y) => x.date - y.date) }
  threadOfMsgid(a, id) { const r = this._all(a).find(r => r.msgid === id); return r ? r.thread : null }
  threadBySubject(a, s) { const c = [...this.t.values()].filter(t => t.account === a && t.subject_norm === s).sort((x, y) => y.last_date - x.last_date)[0]; return c || null }
  touchThread(a, t, s, d) { const k = a + '\u0000' + t; const c = this.t.get(k); if (c) { c.last_date = Math.max(c.last_date, d); c.count++ } else this.t.set(k, { account: a, thread: t, subject_norm: s, last_date: d, count: 1 }) }
  uids(a, f) { return this._all(a).filter(r => r.folder === f).map(r => String(r.uid)) }
  putFolder(f) { this.f.set(f.account + '\u0000' + f.path, { ...f }) }
  folders(a) { return [...this.f.values()].filter(f => f.account === a).sort((x, y) => x.path.localeCompare(y.path)) }
  folder(a, p) { return this.f.get(a + '\u0000' + p) || null }
  deleteFolderMessages(a, f) { for (const r of this._all(a)) if (r.folder === f) this.deleteMessage(a, f, r.uid) }
  deleteAccount(a) { for (const r of this._all(a)) this.deleteMessage(a, r.folder, r.uid); for (const [k, f] of this.f) if (f.account === a) this.f.delete(k); for (const [k, t] of this.t) if (t.account === a) this.t.delete(k) }
  setFlags(a, f, u, flags, seen, flagged) { const r = this.getMessage(a, f, u); if (r) { r.flags = JSON.stringify(flags); r.seen = seen ? 1 : 0; r.flagged = flagged ? 1 : 0 } }
  setBody(a, f, u, text) { const r = this.getMessage(a, f, u); if (r) r.body_text = text }
  pruneBodies(before) { let n = 0; for (const r of this.m.values()) if (r.body_text != null && (before === null || r.date < before)) { r.body_text = null; n++ } return n }
  unseen(a, f) { return this._all(a).filter(r => r.folder === f && !r.seen).length }
  close() {}
}

// ── the cache API ───────────────────────────────────────────────────────────

export class MailCache {
  constructor(path, { log = () => {} } = {}) {
    try { this.b = new SqliteBackend(path) }
    catch (e) { log('node:sqlite unavailable (' + e.message + '); using an in-memory cache'); this.b = new MemoryBackend() }
  }

  get kind() { return this.b.kind }

  /** Store message headers. `m` uses JS names; thread is computed here. */
  putMessage(m) {
    const account = m.account
    const existing = this.b.getMessage(account, m.folder, m.uid)
    const msgid = m.msgid || null
    let thread = existing ? existing.thread : null
    const refs = [...parseRefs(m.refs), ...parseRefs(m.inReplyTo)]
    const subjectNorm = normSubject(m.subject)
    if (!thread && msgid) thread = this.b.threadOfMsgid(account, msgid)
    if (!thread) for (const r of refs.reverse()) { thread = this.b.threadOfMsgid(account, r); if (thread) break }
    if (!thread && subjectNorm && (hasReplyPrefix(m.subject) || refs.length)) {
      const t = this.b.threadBySubject(account, subjectNorm)
      if (t && Math.abs((m.date || 0) - Number(t.last_date)) < SUBJECT_WINDOW_MS) thread = t.thread
    }
    if (!thread) thread = 't' + sha(account + '|' + (refs[0] || msgid || m.folder + ':' + m.uid))
    const flags = Array.isArray(m.flags) ? m.flags : []
    const row = {
      account, folder: m.folder, uid: String(m.uid), msgid, in_reply_to: m.inReplyTo || null, refs: m.refs || null, thread,
      from_name: m.fromName || '', from_addr: (m.fromAddr || '').toLowerCase(), to_json: JSON.stringify(m.to || []), cc_json: JSON.stringify(m.cc || []),
      subject: m.subject || '', subject_norm: subjectNorm, date: Number(m.date) || 0,
      flags: JSON.stringify(flags), seen: flags.includes('\\Seen') ? 1 : 0, flagged: flags.includes('\\Flagged') ? 1 : 0,
      snippet: String(m.snippet || '').slice(0, 300), has_att: m.hasAtt ? 1 : 0,
      body_text: existing && existing.body_text != null ? existing.body_text : (m.bodyText ?? null),
      size: Number(m.size) || 0, synced_at: Date.now(),
    }
    this.b.putMessage(row)
    if (!existing) this.b.touchThread(account, thread, subjectNorm, row.date)
    return thread
  }

  getMessage(account, folder, uid) { return rowOut(this.b.getMessage(account, folder, uid)) }
  deleteMessage(account, folder, uid) { this.b.deleteMessage(account, folder, uid) }
  uids(account, folder) { return this.b.uids(account, folder) }
  maxUid(account, folder) { return this.b.uids(account, folder).map(Number).filter(Number.isFinite).reduce((a, b) => Math.max(a, b), 0) }
  setFlags(account, folder, uid, flags) { this.b.setFlags(account, folder, uid, flags, flags.includes('\\Seen'), flags.includes('\\Flagged')) }
  setBody(account, folder, uid, text) { this.b.setBody(account, folder, uid, text) }
  threadMessages(account, thread) { return this.b.messagesByThread(account, thread).map(rowOut) }
  putFolder(f) { this.b.putFolder(f) }
  folders(account) { return this.b.folders(account) }
  folder(account, path) { return this.b.folder(account, path) }
  dropFolder(account, folder) { this.b.deleteFolderMessages(account, folder) }
  wipeAccount(account) { this.b.deleteAccount(account) }
  unseen(account, folder) { return this.b.unseen(account, folder) }

  /** Retention: days > 0 prunes bodies older than N days, 0 prunes all bodies, -1 keeps. */
  prune(retentionDays, now = Date.now()) {
    const d = Number(retentionDays)
    if (!Number.isFinite(d) || d < 0) return 0
    return this.b.pruneBodies(d === 0 ? null : now - d * 86400 * 1000)
  }

  /** Raw messages of one folder (newest first). */
  messages(account, folder, limit = 5000) { return this.b.messagesByFolder(account, folder, limit).map(rowOut) }
  accountMessages(account, limit = 20000) { return this.b.messagesByAccount(account, limit).map(rowOut) }

  /**
   * Thread list rows for one or more (account, folder) sources, newest first.
   * filter: { unread, flagged, attachments, q (parsed query object) }
   */
  threads(sources, { filter = {}, limit = 50, offset = 0 } = {}) {
    const groups = new Map()
    for (const { account, folder } of sources) {
      const rows = folder === '*' ? this.accountMessages(account) : this.messages(account, folder)
      for (const r of rows) {
        if (!matches(r, filter)) continue
        const k = account + '\u0000' + r.thread
        const g = groups.get(k)
        if (!g) groups.set(k, { account, thread: r.thread, latest: r, count: 1, unread: r.seen ? 0 : 1, flagged: r.flagged, has_att: r.has_att, folder: r.folder })
        else {
          g.count++
          if (!r.seen) g.unread++
          g.flagged = g.flagged || r.flagged
          g.has_att = g.has_att || r.has_att
          if (r.date > g.latest.date) g.latest = r
        }
      }
    }
    const all = [...groups.values()].sort((a, b) => b.latest.date - a.latest.date)
    return { total: all.length, rows: all.slice(offset, offset + limit) }
  }

  close() { this.b.close() }
}

/** Parse "from:x to:y subject:z is:unread is:flagged has:attachment after:2026-01-01 before:... words" */
export function parseQuery(q) {
  const out = { text: [] }
  const re = /(\w+):("[^"]*"|\S+)|("[^"]*"|\S+)/g
  let m
  while ((m = re.exec(String(q || '')))) {
    if (m[1]) {
      const k = m[1].toLowerCase()
      const v = m[2].replace(/^"|"$/g, '')
      if (k === 'is' && v === 'unread') out.unread = true
      else if (k === 'is' && v === 'read') out.read = true
      else if (k === 'is' && (v === 'flagged' || v === 'starred')) out.flagged = true
      else if (k === 'has' && v.startsWith('attach')) out.attachments = true
      else if (k === 'from' || k === 'to' || k === 'subject') out[k] = v.toLowerCase()
      else if (k === 'after' || k === 'since') { const t = Date.parse(v); if (Number.isFinite(t)) out.after = t }
      else if (k === 'before') { const t = Date.parse(v); if (Number.isFinite(t)) out.before = t }
      else out.text.push((k + ':' + v).toLowerCase())
    } else out.text.push(m[3].replace(/^"|"$/g, '').toLowerCase())
  }
  return out
}

export function matches(r, f) {
  if (!f) return true
  if (f.unread && r.seen) return false
  if (f.read && !r.seen) return false
  if (f.flagged && !r.flagged) return false
  if (f.attachments && !r.has_att) return false
  const q = f.q
  if (!q) return true
  if (q.unread && r.seen) return false
  if (q.read && !r.seen) return false
  if (q.flagged && !r.flagged) return false
  if (q.attachments && !r.has_att) return false
  if (q.after && r.date < q.after) return false
  if (q.before && r.date >= q.before) return false
  if (q.from && !((r.from_addr + ' ' + r.from_name).toLowerCase().includes(q.from))) return false
  if (q.to && !JSON.stringify([r.to, r.cc]).toLowerCase().includes(q.to)) return false
  if (q.subject && !String(r.subject).toLowerCase().includes(q.subject)) return false
  if (q.text && q.text.length) {
    const hay = (r.subject + ' ' + r.from_name + ' ' + r.from_addr + ' ' + r.snippet + ' ' + (r.body_text || '') + ' ' + JSON.stringify(r.to)).toLowerCase()
    for (const w of q.text) if (!hay.includes(w)) return false
  }
  return true
}
