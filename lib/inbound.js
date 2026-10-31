/**
 * dsh-mail / inbound.js: Twilio SendGrid Inbound Parse webhook.
 *
 *   POST /dsh-mail/api/inbound/sendgrid/<accountId>?s=<path secret>
 *
 * Public by nature (SendGrid posts from the internet through the DSH edge),
 * so: OFF unless the account sets inbound.enabled, the per-account path
 * secret is compared in constant time, the Host must be trusted, the body
 * is capped at 25 MB, and the message only goes into the local cache (and
 * a 0600 .eml file for the reading view). It never triggers agent actions.
 * Configure SendGrid with "POST the raw, full MIME message" for best results;
 * the parsed form fields are accepted too.
 * https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/setting-up-the-inbound-parse-webhook
 */

'use strict'

import { createHash, timingSafeEqual } from 'node:crypto'
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

import { isLoopbackPeer, isLoopbackHostname } from './security.js'
import { E } from './errors.js'

const require = createRequire(import.meta.url)
const { simpleParser } = require('mailparser')
export const MAX_INBOUND_BYTES = 25 * 1024 * 1024

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []
    req.on('data', c => { size += c.length; if (size > max) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return } chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** Minimal multipart/form-data parser: { name: { value: Buffer, filename, type } } (first value wins). */
export function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || '')
  if (!m) throw new Error('not multipart')
  const boundary = Buffer.from('--' + (m[1] || m[2]))
  const out = {}
  let pos = buf.indexOf(boundary)
  while (pos >= 0) {
    pos += boundary.length
    if (buf.slice(pos, pos + 2).toString() === '--') break
    if (buf.slice(pos, pos + 2).toString() === '\r\n') pos += 2
    const headEnd = buf.indexOf('\r\n\r\n', pos)
    if (headEnd < 0) break
    const head = buf.slice(pos, headEnd).toString('utf8')
    const next = buf.indexOf(boundary, headEnd + 4)
    if (next < 0) break
    let body = buf.slice(headEnd + 4, next)
    if (body.slice(-2).toString() === '\r\n') body = body.slice(0, -2)
    const name = /name="([^"]*)"/i.exec(head)
    const filename = /filename="([^"]*)"/i.exec(head)
    const type = /content-type:\s*([^\r\n]+)/i.exec(head)
    if (name && !(name[1] in out)) out[name[1]] = { value: body, filename: filename ? filename[1] : '', type: type ? type[1].trim() : '' }
    pos = next
  }
  return out
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''))
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}

function trustedHost(req, trustedHosts) {
  const host = String(req.headers.host || '')
  let u
  try { u = new URL('http://' + host) } catch { return false }
  if (isLoopbackHostname(u.hostname)) return true
  return (trustedHosts || []).some(h => { try { const t = new URL('http://' + h); return t.port ? t.host === u.host : t.hostname === u.hostname } catch { return false } })
}

/** Build an RFC 822 message from SendGrid's parsed fields when raw mode is off. */
function rebuild(f) {
  const v = k => (f[k] ? f[k].value.toString('utf8') : '')
  const headers = v('headers').replace(/\r?\n$/, '')
  const lines = headers ? [headers] : ['From: ' + v('from'), 'To: ' + v('to'), 'Subject: ' + v('subject')]
  const html = v('html')
  const text = v('text')
  if (html) return Buffer.from(lines.join('\r\n').replace(/^content-type:.*$/gim, '').replace(/\r\n\r\n/g, '\r\n') + '\r\nContent-Type: text/html; charset=utf-8\r\n\r\n' + html)
  return Buffer.from(lines.join('\r\n').replace(/^content-type:.*$/gim, '').replace(/\r\n\r\n/g, '\r\n') + '\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' + text)
}

export async function handleSendgridInbound(req, res, d) {
  const send = (status, text) => { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end(text) }
  try {
    if (!isLoopbackPeer(req.socket && req.socket.remoteAddress)) return send(403, 'forbidden')
    if (!trustedHost(req, d.settings.trustedHosts)) return send(403, 'forbidden')
    const id = d.sub.slice('/inbound/sendgrid/'.length)
    const acc = d.resolved().explicit.find(a => a.id === id)
    // Same answer for unknown, disabled and wrong secret: nothing to probe.
    if (!acc || acc.type !== 'sendgrid' || !acc.inbound.enabled) return send(404, 'not found')
    const want = (d.secretsStore.account(acc.id) || {}).webhookSecret || acc.secrets.webhookSecret
    if (!want || !safeEqual(d.url.searchParams.get('s'), want)) return send(404, 'not found')
    const len = Number(req.headers['content-length'] || 0)
    if (len > MAX_INBOUND_BYTES) return send(413, 'too large')
    const body = await readBody(req, MAX_INBOUND_BYTES)
    const fields = parseMultipart(body, req.headers['content-type'])
    const raw = fields.email ? fields.email.value : rebuild(fields)
    const p = await simpleParser(raw, { skipImageLinks: true })
    const uid = createHash('sha256').update(p.messageId || raw).digest('hex').slice(0, 20)
    const dir = join(d.dataDir, 'inbound', acc.id)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, uid + '.eml')
    writeFileSync(file, raw, { mode: 0o600 })
    try { chmodSync(file, 0o600) } catch {}
    const from = (p.from && p.from.value && p.from.value[0]) || {}
    d.cache.putMessage({
      account: acc.id, folder: 'INBOX', uid, msgid: p.messageId || null, inReplyTo: p.inReplyTo || null,
      refs: Array.isArray(p.references) ? p.references.join(' ') : (p.references || null),
      fromName: from.name || '', fromAddr: from.address || '',
      to: ((p.to && p.to.value) || []).map(a => ({ name: a.name || '', address: (a.address || '').toLowerCase() })), cc: [],
      subject: p.subject || '', date: p.date ? p.date.getTime() : Date.now(), flags: [], size: raw.length,
      hasAtt: (p.attachments || []).length > 0, snippet: String(p.text || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    })
    d.cache.putFolder({ account: acc.id, path: 'INBOX', name: 'Inbox', role: 'inbox', delimiter: '/', unseen: d.cache.unseen(acc.id, 'INBOX'), total: null, synced_at: Date.now() })
    d.audit({ actor: 'webhook', action: 'inbound', account: acc.id, subject: p.subject })
    d.emit({ type: 'sync', account: acc.id, folder: 'INBOX', added: 1 })
    send(200, 'ok')
  } catch (e) {
    send(e && e.status === 413 ? 413 : 400, 'rejected')
    if (d.warn) d.warn(E.logLine('MAIL_INBOUND_REJECTED', 'sendgrid: ' + (e && e.message)))
  }
}
