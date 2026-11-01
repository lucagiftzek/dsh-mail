/**
 * dsh-mail / imap.js: IMAP access (imapflow) plus the folder sync into the cache.
 *
 * One connection per account is reused for a short idle window and every
 * operation runs under a per-account mutex, so the tab and the agent tools
 * never race on one socket. Certificates are verified unless the account
 * opted in to allowSelfSigned; plaintext only to loopback.
 */

'use strict'

import { createRequire } from 'node:module'

import { resolvePassword, isLoopbackHost } from './accounts.js'

const require = createRequire(import.meta.url)
const { ImapFlow } = require('imapflow')
const { simpleParser } = require('mailparser')

export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024
const IDLE_CLOSE_MS = 90 * 1000

const ROLE_BY_USE = { '\\Inbox': 'inbox', '\\Sent': 'sent', '\\Drafts': 'drafts', '\\Trash': 'trash', '\\Junk': 'junk', '\\Archive': 'archive', '\\All': 'all', '\\Flagged': 'flagged' }
export const ROLE_ORDER = ['inbox', 'flagged', 'drafts', 'sent', 'archive', 'all', 'junk', 'trash']

export function imapOptions(acc, accessToken) {
  const e = acc.receive
  if (e.security === 'none' && !isLoopbackHost(e.host)) throw new Error('imap: plaintext is only allowed to a loopback host')
  const user = (acc.auth && acc.auth.user) || e.user || acc.address
  return {
    host: e.host,
    port: Number(e.port),
    secure: e.security === 'tls',
    doSTARTTLS: e.security === 'starttls' ? true : (e.security === 'none' ? false : undefined),
    // OAuth2 accounts log in with SASL XOAUTH2 (imapflow builds it from accessToken).
    auth: accessToken ? { user, accessToken } : { user, pass: resolvePassword(acc) },
    tls: { rejectUnauthorized: !acc.allowSelfSigned, servername: e.host },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 120000,
  }
}

export class ImapPool {
  /** @param o { tokenFor: async acc => accessToken | null } for OAuth2 accounts */
  constructor(o = {}) { this.slots = new Map(); this.tokenFor = o.tokenFor || null }

  /** Run fn(client) with the account's connection, serialised per account. */
  async run(acc, fn) {
    let slot = this.slots.get(acc.id)
    if (!slot) { slot = { chain: Promise.resolve(), client: null, timer: null, key: '' }; this.slots.set(acc.id, slot) }
    const key = JSON.stringify([acc.receive, acc.auth, acc.allowSelfSigned, acc.secrets && acc.secrets.password ? 1 : 0, acc.oauth && acc.oauth.clientId])
    const job = slot.chain.then(async () => {
      clearTimeout(slot.timer)
      if (slot.client && (!slot.client.usable || slot.key !== key)) { try { await slot.client.logout() } catch {} ; slot.client = null }
      if (!slot.client) {
        const token = this.tokenFor ? await this.tokenFor(acc) : null
        const c = new ImapFlow(imapOptions(acc, token))
        c.on('error', () => {})
        await c.connect()
        slot.client = c
        slot.key = key
      }
      try { return await fn(slot.client) }
      finally {
        slot.timer = setTimeout(() => { const c = slot.client; slot.client = null; if (c) c.logout().catch(() => {}) }, IDLE_CLOSE_MS)
        if (slot.timer.unref) slot.timer.unref()
      }
    })
    slot.chain = job.catch(() => {})
    return job
  }

  async close(id) {
    const ids = id ? [id] : [...this.slots.keys()]
    for (const k of ids) {
      const s = this.slots.get(k)
      if (!s) continue
      clearTimeout(s.timer)
      if (s.client) { try { await s.client.logout() } catch {} }
      this.slots.delete(k)
    }
  }
}

export function roleOf(box, acc) {
  const ov = acc && acc.folders ? Object.entries(acc.folders).find(([, p]) => p === box.path) : null
  if (ov) return ov[0]
  if (String(box.path).toUpperCase() === 'INBOX') return 'inbox'
  return ROLE_BY_USE[box.specialUse] || ''
}

export async function listFolders(pool, acc) {
  return pool.run(acc, async (c) => {
    const list = await c.list({ statusQuery: { unseen: true, messages: true } })
    return list.filter(b => !b.flags.has('\\Noselect') && !b.flags.has('\\NonExistent')).map(b => ({
      path: b.path, name: b.name, delimiter: b.delimiter, role: roleOf(b, acc),
      unseen: b.status ? Number(b.status.unseen || 0) : null,
      total: b.status ? Number(b.status.messages || 0) : null,
    }))
  })
}

/** Resolve a role ("trash", "archive", ...) or a literal path to a folder path. */
export function folderForRole(folders, role, acc) {
  if (acc && acc.folders && acc.folders[role]) return acc.folders[role]
  const hit = folders.find(f => f.role === role)
  if (hit) return hit.path
  if (role === 'archive') { const all = folders.find(f => f.role === 'all'); if (all) return all.path }
  if (role === 'inbox') return 'INBOX'
  const byName = folders.find(f => f.path === role || f.name.toLowerCase() === role)
  return byName ? byName.path : null
}

function addr(list) { return (list || []).map(a => ({ name: a.name || '', address: (a.address || '').toLowerCase() })) }

function hasAttachment(node) {
  if (!node) return false
  const disp = String(node.disposition || '').toLowerCase()
  if (disp === 'attachment') return true
  if (disp === 'inline' && node.type && !/^text\//i.test(node.type)) return true
  return (node.childNodes || []).some(hasAttachment)
}

async function snippetFromPartial(source) {
  if (!source) return ''
  try {
    const p = await simpleParser(source, { skipHtmlToText: false, skipImageLinks: true, skipTextLinks: true })
    const t = (p.text || '').replace(/^>.*$/gm, '').replace(/\s+/g, ' ').trim()
    return t.slice(0, 200)
  } catch { return '' }
}

async function toRow(acc, folder, m) {
  const env = m.envelope || {}
  const refsHeader = m.headers ? /^references:\s*([\s\S]*?)(?:\r?\n(?!\s)|$)/im.exec(m.headers.toString('utf8')) : null
  const from = addr(env.from)[0] || { name: '', address: '' }
  return {
    account: acc.id, folder, uid: String(m.uid),
    msgid: env.messageId || null, inReplyTo: env.inReplyTo || null, refs: refsHeader ? refsHeader[1].replace(/\s+/g, ' ').trim() : null,
    fromName: from.name, fromAddr: from.address,
    to: addr(env.to), cc: addr(env.cc),
    subject: env.subject || '',
    date: (env.date ? new Date(env.date) : m.internalDate ? new Date(m.internalDate) : new Date(0)).getTime() || 0,
    flags: m.flags ? [...m.flags] : [],
    size: m.size || 0,
    hasAtt: hasAttachment(m.bodyStructure),
    snippet: await snippetFromPartial(m.source),
  }
}

const HEADER_QUERY = { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true, size: true, headers: ['references'], source: { maxLength: 6144 } }

/**
 * Sync one folder into the cache: UIDVALIDITY check, new messages since the
 * highest cached UID (initial: last `days` days, newest `max`), flag refresh
 * and expunge detection for the cached UID range.
 */
export async function syncFolder(pool, acc, cache, path, { days = 90, max = 1000 } = {}) {
  return pool.run(acc, async (c) => {
    const lock = await c.getMailboxLock(path)
    try {
      const box = c.mailbox
      const prev = cache.folder(acc.id, path)
      const uidvalidity = String(box.uidValidity)
      if (prev && prev.uidvalidity && prev.uidvalidity !== uidvalidity) cache.dropFolder(acc.id, path)
      const known = new Set(cache.uids(acc.id, path))
      let added = 0
      let newRows = []
      const maxUid = [...known].map(Number).reduce((a, b) => Math.max(a, b), 0)
      let range = null
      if (!known.size) {
        if (box.exists > 0) {
          const since = new Date(Date.now() - days * 86400 * 1000)
          let uids = await c.search({ since }, { uid: true }) || []
          uids = uids.sort((a, b) => a - b).slice(-max)
          if (uids.length) range = uids
        }
      } else {
        // A pooled connection may keep the folder selected, so its UIDNEXT is stale:
        // NOOP picks up new EXISTS, and n:* is asked even when UIDNEXT looks unchanged
        // (a server answers n:* with the last message when nothing is newer; known UIDs are skipped).
        await c.noop().catch(() => {})
        if (box.exists > 0) range = (maxUid + 1) + ':*'
      }
      if (range) {
        const rows = []
        for await (const m of c.fetch(range, HEADER_QUERY, { uid: true })) {
          if (known.has(String(m.uid))) continue
          rows.push(await toRow(acc, path, m))
        }
        rows.sort((a, b) => a.date - b.date)
        for (const r of rows) { cache.putMessage(r); added++ }
        newRows = rows
      }
      // Flags + expunges for the cached range.
      let removed = 0
      if (known.size) {
        const nums = [...known].map(Number).filter(Number.isFinite)
        const lo = Math.min(...nums)
        const present = new Set()
        for await (const m of c.fetch(lo + ':' + Math.max(maxUid, lo), { uid: true, flags: true }, { uid: true })) {
          present.add(String(m.uid))
          if (known.has(String(m.uid))) cache.setFlags(acc.id, path, m.uid, [...(m.flags || [])])
        }
        for (const u of known) if (!present.has(u)) { cache.deleteMessage(acc.id, path, u); removed++ }
      }
      cache.putFolder({
        account: acc.id, path, name: (prev && prev.name) || path.split(box.delimiter || '/').pop(), role: (prev && prev.role) || (path.toUpperCase() === 'INBOX' ? 'inbox' : ''),
        delimiter: box.delimiter || '/', uidvalidity, uidnext: box.uidNext || null, highestmodseq: box.highestModseq ? String(box.highestModseq) : null,
        unseen: cache.unseen(acc.id, path), total: box.exists, synced_at: Date.now(),
      })
      return { added, removed, total: box.exists, rows: newRows }
    } finally { lock.release() }
  })
}

/** Fetch and parse one full message (source capped at 25 MB). */
export async function fetchFull(pool, acc, path, uid) {
  return pool.run(acc, async (c) => {
    const lock = await c.getMailboxLock(path)
    try {
      const meta = await c.fetchOne(String(uid), { uid: true, size: true, flags: true }, { uid: true })
      if (!meta) throw new Error('message not found')
      if (meta.size > MAX_MESSAGE_BYTES) throw new Error('message is larger than 25 MB')
      const m = await c.fetchOne(String(uid), { uid: true, source: true }, { uid: true })
      const parsed = await simpleParser(m.source, { skipImageLinks: true })
      return { parsed, flags: [...(meta.flags || [])], size: meta.size }
    } finally { lock.release() }
  })
}

export async function setFlags(pool, acc, path, uids, { add = [], remove = [] }) {
  return pool.run(acc, async (c) => {
    const lock = await c.getMailboxLock(path)
    try {
      if (add.length) await c.messageFlagsAdd(uids.map(String).join(','), add, { uid: true })
      if (remove.length) await c.messageFlagsRemove(uids.map(String).join(','), remove, { uid: true })
      const out = {}
      for await (const m of c.fetch(uids.map(String).join(','), { uid: true, flags: true }, { uid: true })) out[m.uid] = [...(m.flags || [])]
      return out
    } finally { lock.release() }
  })
}

export async function moveMessages(pool, acc, path, uids, dest) {
  return pool.run(acc, async (c) => {
    const lock = await c.getMailboxLock(path)
    try { return await c.messageMove(uids.map(String).join(','), dest, { uid: true }) } finally { lock.release() }
  })
}

export async function appendMessage(pool, acc, path, raw, flags = ['\\Seen']) {
  return pool.run(acc, async (c) => c.append(path, raw, flags))
}

export async function serverSearch(pool, acc, path, query) {
  return pool.run(acc, async (c) => {
    const lock = await c.getMailboxLock(path)
    try { return (await c.search(query, { uid: true })) || [] } finally { lock.release() }
  })
}

/** Fetch header rows for specific UIDs (used to fill search results outside the cache window). */
export async function fetchHeaders(pool, acc, path, uids) {
  if (!uids.length) return []
  return pool.run(acc, async (c) => {
    const lock = await c.getMailboxLock(path)
    try {
      const rows = []
      for await (const m of c.fetch(uids.map(String).join(','), HEADER_QUERY, { uid: true })) rows.push(await toRow(acc, path, m))
      return rows
    } finally { lock.release() }
  })
}

/** Test connection: login + LIST. Returns folder count. */
export async function imapTest(acc, accessToken) {
  const c = new ImapFlow({ ...imapOptions(acc, accessToken), connectionTimeout: 15000 })
  c.on('error', () => {})
  await c.connect()
  try { const l = await c.list(); return { folders: l.length, capabilities: [...(c.capabilities ? c.capabilities.keys() : [])].slice(0, 40) } }
  finally { await c.logout().catch(() => {}) }
}

/** Create a folder (path in the server's delimiter). */
export async function createFolder(pool, acc, path) {
  return pool.run(acc, async (c) => c.mailboxCreate(path))
}

export async function renameFolder(pool, acc, from, to) {
  return pool.run(acc, async (c) => c.mailboxRename(from, to))
}

/**
 * Remove OUR copy of a draft from the Drafts folder (superseded or sent).
 * Safety: only a message that still carries \Draft and, when known, the
 * Message-ID we appended is touched (a reused UID after a UIDVALIDITY change
 * or a user's own draft is left alone). With UIDPLUS the message is expunged
 * by UID; without it the message is only flagged \Deleted, because a plain
 * EXPUNGE would also remove every other \Deleted message in the folder.
 */
export async function deleteDraftCopy(pool, acc, path, uid, { messageId = '' } = {}) {
  if (!/^\d{1,10}$/.test(String(uid))) return false
  return pool.run(acc, async (c) => {
    const lock = await c.getMailboxLock(path)
    try {
      const m = await c.fetchOne(String(uid), { uid: true, flags: true, envelope: true }, { uid: true })
      if (!m) return false
      const flags = m.flags instanceof Set ? m.flags : new Set(m.flags || [])
      if (!flags.has('\\Draft')) return false
      const mid = m.envelope && m.envelope.messageId
      if (messageId && mid && mid !== messageId) return false
      if (c.capabilities && c.capabilities.has('UIDPLUS')) return !!(await c.messageDelete(String(uid), { uid: true }))
      await c.messageFlagsAdd(String(uid), ['\\Deleted'], { uid: true })
      return true
    } finally { lock.release() }
  })
}

/** The UID of the message with this Message-ID in a folder ('' when not found). */
export async function findUidByMessageId(pool, acc, path, messageId) {
  if (!messageId) return ''
  return pool.run(acc, async (c) => {
    const lock = await c.getMailboxLock(path)
    try {
      const uids = (await c.search({ header: { 'message-id': messageId } }, { uid: true })) || []
      return uids.length ? String(Math.max(...uids)) : ''
    } finally { lock.release() }
  })
}
