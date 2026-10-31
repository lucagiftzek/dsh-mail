/**
 * dsh-mail / drafts.js: local drafts (agent drafts awaiting a human or a
 * `confirm:true`). One JSON file per draft in ~/.dsh/dsh-mail/drafts (0700/0600).
 */

'use strict'

import fsP from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const ID_RE = /^d-[a-z0-9]{10}$/
const MAX = 500

function clip(s, n) { return typeof s === 'string' ? s.slice(0, n) : '' }

export class Drafts {
  constructor(dir) { this.dir = dir }
  async init() { await fsP.mkdir(this.dir, { recursive: true, mode: 0o700 }); try { await fsP.chmod(this.dir, 0o700) } catch {} }
  path(id) { if (!ID_RE.test(String(id || ''))) throw new Error('invalid draft id'); return join(this.dir, id + '.json') }

  async list() {
    let names = []
    try { names = await fsP.readdir(this.dir) } catch { return [] }
    const out = []
    for (const n of names.filter(n => n.endsWith('.json')).slice(0, MAX)) {
      const d = await this.read(n.slice(0, -5))
      if (d) out.push(d)
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async read(id) { try { return JSON.parse(await fsP.readFile(this.path(id), 'utf8')) } catch { return null } }

  async save(d) {
    await this.init()
    const now = Date.now()
    const id = d.id && ID_RE.test(d.id) ? d.id : 'd-' + randomBytes(8).toString('hex').slice(0, 10)
    const prev = d.id ? await this.read(d.id) : null
    if (!prev && (await this.list()).length >= MAX) throw new Error('too many drafts; delete some first')
    const draft = {
      id, account: clip(d.account, 32), by: clip(d.by || (prev && prev.by) || 'agent', 40), kind: clip(d.kind || (prev && prev.kind) || 'send', 20),
      from: clip(d.from, 400), to: clip(d.to, 4000), cc: clip(d.cc, 4000), bcc: clip(d.bcc, 4000),
      subject: clip(d.subject, 1000), text: clip(d.text, 200000), html: clip(d.html, 400000), replyTo: clip(d.replyTo, 400),
      inReplyTo: clip(d.inReplyTo, 1000), references: clip(d.references, 4000),
      attachments: Array.isArray(d.attachments) ? d.attachments.filter(p => typeof p === 'string').slice(0, 20) : [],
      forwardOf: clip(d.forwardOf || (prev && prev.forwardOf) || '', 600),
      forwardAttachments: d.forwardAttachments === true || (d.forwardAttachments === undefined && !!(prev && prev.forwardAttachments)),
      createdAt: prev ? prev.createdAt : now, updatedAt: now,
    }
    await fsP.writeFile(this.path(id), JSON.stringify(draft, null, 2) + '\n', { mode: 0o600 })
    return draft
  }

  async remove(id) { await fsP.rm(this.path(id), { force: true }); return true }
}
