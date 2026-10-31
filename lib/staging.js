/**
 * dsh-mail: the queue / staging area.
 *
 * A queued email is a message waiting to be sent. It can be:
 *   - 'queued'    : waiting for manual send via the sidebar UI
 *   - 'scheduled' : waiting for a timer to fire at sendAt
 *   - 'sent'      : successfully delivered
 *   - 'failed'    : attempted and failed (error recorded)
 *   - 'cancelled' : withdrawn before send
 *
 * The staging area lives at ~/.dsh/dsh-mail/queue (0700), separate from
 * any provider credentials or credential files.
 */

'use strict'

import fsP from 'node:fs/promises'
import { join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'

export const ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/
const MAX_QUEUED = 500
const MAX_BODY_BYTES = 256 * 1024

export const STATUS = {
  queued: 'queued',
  scheduled: 'scheduled',
  sent: 'sent',
  failed: 'failed',
  cancelled: 'cancelled',
}

export function slugify(name, fallbackPrefix = 'mail') {
  const base = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  const stem = base.length >= 3 ? base : fallbackPrefix
  return stem + '-' + randomUUID().slice(0, 8)
}

function clip(s, n = 8000) {
  const t = typeof s === 'string' ? s : ''
  return t.length > n ? t.slice(0, n) : t
}

export class Queue {
  constructor(dir) { this.dir = dir }

  async init() {
    await fsP.mkdir(this.dir, { recursive: true, mode: 0o700 })
    try { await fsP.chmod(this.dir, 0o700) } catch { /* best effort */ }
  }

  paths(id) {
    if (!ID_RE.test(String(id ?? ''))) throw new Error('invalid queue id')
    return { meta: join(this.dir, id + '.json') }
  }

  async list() {
    let names = []
    try { names = await fsP.readdir(this.dir) } catch { return [] }
    const ids = names.filter(n => n.endsWith('.json')).map(n => basename(n, '.json')).filter(n => ID_RE.test(n))
    const out = []
    for (const id of ids.slice(0, MAX_QUEUED)) {
      const p = await this.read(id)
      if (p) out.push(p)
    }
    out.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
    return out
  }

  async read(id) {
    try {
      const { meta: mp } = this.paths(id)
      const meta = JSON.parse(await fsP.readFile(mp, 'utf8'))
      meta.id = id
      return meta
    } catch { return null }
  }

  async write(id, meta) {
    const { meta: mp } = this.paths(id)
    const body = JSON.stringify(meta, null, 2) + '\n'
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) throw new Error('queue entry exceeds ' + MAX_BODY_BYTES + ' bytes')
    await fsP.writeFile(mp, body, { mode: 0o600 })
    return { ...meta, id }
  }

  async create({ name, provider, msg, recipients, csvData, delayMs, sendAt, requestedSendAt, unsubscribe, list, language, requestedBy, nowMs = Date.now() }) {
    await this.init()
    const existing = await this.list()
    const pending = existing.filter(p => p.status === STATUS.queued || p.status === STATUS.scheduled)
    if (pending.length >= MAX_QUEUED) throw new Error('the queue already holds ' + MAX_QUEUED + ' pending emails; cancel some first')
    const id = slugify(name)
    const status = sendAt ? STATUS.scheduled : STATUS.queued
    const meta = {
      id,
      name: clip(name, 120) || id,
      status,
      provider,
      msg: {
        from: clip(msg.from, 200),
        to: msg.to,
        subject: clip(msg.subject, 500),
        text: clip(msg.text, 100000),
        html: msg.html ? clip(msg.html, 100000) : undefined,
        replyTo: msg.replyTo,
      },
      recipients: recipients || null,
      csvData: csvData || null,
      delayMs: delayMs || null,
      sendAt: sendAt || null,
      requestedSendAt: requestedSendAt || null,
      unsubscribe: clip(unsubscribe, 1000) || null,
      list: clip(list, 64) || null,
      language: clip(language, 4) || null,
      requestedBy: clip(requestedBy, 120),
      created_at: Math.round(nowMs / 1000),
      updated_at: Math.round(nowMs / 1000),
      attempts: 0,
      lastError: null,
      sentMessageId: null,
      history: [{ at: Math.round(nowMs / 1000), what: 'queued', by: clip(requestedBy, 120) }],
    }
    return this.write(id, meta)
  }

  async setStatus(id, status, extra = {}, nowMs = Date.now()) {
    const cur = await this.read(id)
    if (!cur) throw new Error('no queue entry ' + id)
    const next = {
      ...cur,
      status,
      updated_at: Math.round(nowMs / 1000),
      ...extra,
      history: [...(cur.history || []), { at: Math.round(nowMs / 1000), what: status, note: clip(extra.note || extra.lastError || '', 500) }],
    }
    return this.write(id, next)
  }

  async cancel(id, { by, nowMs = Date.now() } = {}) {
    const cur = await this.read(id)
    if (!cur) throw new Error('no queue entry ' + id)
    if (cur.status === STATUS.sent) throw new Error('entry ' + id + ' was already sent; cannot cancel')
    return this.setStatus(id, STATUS.cancelled, { note: 'cancelled by ' + (by || 'user') }, nowMs)
  }

  async delete(id) {
    const cur = await this.read(id)
    if (!cur) throw new Error('no queue entry ' + id)
    if (cur.status === STATUS.sent) throw new Error('entry ' + id + ' was sent; it is part of the record and cannot be deleted')
    const { meta } = this.paths(id)
    await fsP.rm(meta, { force: true })
    return { id, deleted: true }
  }

  /**
   * Entries the timer may send: scheduled ones whose sendAt has passed.
   * 'queued' entries wait for a human (Send now / Approve in the Mail tab);
   * v0.1 also auto-sent them, which contradicted the documented review step.
   */
  async due(nowMs = Date.now()) {
    const all = await this.list()
    return all.filter(p => {
      if (p.status === STATUS.scheduled && p.sendAt) {
        const ts = typeof p.sendAt === 'number' ? p.sendAt : Date.parse(p.sendAt)
        return Number.isFinite(ts) && ts <= nowMs / 1000
      }
      return false
    })
  }
}

/** Parse a CSV string into rows of { name, email, ...customFields }. */
export function parseCSV(text, maxRows = 1000) {
  const lines = String(text ?? '').trim().split(/\r?\n/).filter(l => l.trim())
  if (lines.length < 2) return []
  const headers = parseCSVLine(lines[0])
  const rows = []
  for (const line of lines.slice(1, maxRows + 1)) {
    const cells = parseCSVLine(line)
    const row = {}
    headers.forEach((h, i) => { row[h] = cells[i] || '' })
    rows.push(row)
  }
  return rows
}

function parseCSVLine(line) {
  const result = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ }
        else inQuotes = false
      } else cur += ch
    } else {
      if (ch === '"') inQuotes = true
      else if (ch === ',') { result.push(cur.trim()); cur = '' }
      else cur += ch
    }
  }
  result.push(cur.trim())
  return result
}

/** Replace template placeholders like {name}, {email} in text using row data. */
export function personalise(template, row) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (match, key) => {
    return row && typeof row[key] === 'string' ? row[key] : match
  })
}
