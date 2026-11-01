/**
 * dsh-mail / smtp.js: SMTP sending for account objects (nodemailer).
 *
 * The message is composed once (MailComposer), delivered over SMTP and, for
 * IMAP accounts, the same bytes can be appended to the Sent folder.
 * Header injection: every header value is rejected when it carries CR or LF.
 */

'use strict'

import { createRequire } from 'node:module'
import fsP from 'node:fs/promises'
import { basename } from 'node:path'

import { resolvePassword, isLoopbackHost } from './accounts.js'

const require = createRequire(import.meta.url)
const nodemailer = require('nodemailer')
const MailComposer = require('nodemailer/lib/mail-composer')

export const MAX_ATTACH_TOTAL = 20 * 1024 * 1024

export function transportOptions(acc, accessToken) {
  const e = acc.send
  if (e.security === 'none' && !isLoopbackHost(e.host)) throw new Error('smtp: plaintext is only allowed to a loopback host')
  const user = (acc.auth && acc.auth.user) || e.user || acc.address
  const pass = accessToken ? '' : resolvePassword(acc)
  const o = {
    host: e.host,
    port: Number(e.port),
    secure: e.security === 'tls',
    requireTLS: e.security === 'starttls',
    ignoreTLS: e.security === 'none',
    tls: { rejectUnauthorized: !acc.allowSelfSigned, servername: e.host },
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 60000,
  }
  if (accessToken) o.auth = { type: 'OAuth2', user, accessToken } // SASL XOAUTH2
  else if (user && pass) o.auth = { user, pass }
  return o
}

const ADDR_HDRS = ['from', 'to', 'cc', 'bcc', 'replyTo', 'subject', 'inReplyTo', 'references']

export function assertNoInjection(msg) {
  for (const k of ADDR_HDRS) {
    const v = msg[k]
    const vals = Array.isArray(v) ? v : [v]
    for (const x of vals) if (typeof x === 'string' && /[\r\n]/.test(x)) throw new Error('header ' + k + ' must not contain line breaks')
  }
  for (const [k, v] of Object.entries(msg.headers || {})) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(k) || /[\r\n]/.test(String(v))) throw new Error('invalid custom header ' + String(k).slice(0, 40))
  }
}

const SIMPLE_ADDR = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/
export function addrList(v) {
  return (Array.isArray(v) ? v : String(v || '').split(',')).map(s => String(s).trim()).filter(Boolean)
}
export function validateRecipients(list) {
  for (const r of list) {
    const m = /<([^<>]+)>\s*$/.exec(r)
    const a = (m ? m[1] : r).trim()
    if (!SIMPLE_ADDR.test(a)) throw new Error('invalid recipient: ' + r.slice(0, 120))
  }
}

/** Load attachments given as file paths (workspace files), capped. */
export async function loadAttachments(paths) {
  const out = []
  let total = 0
  for (const p of paths || []) {
    if (typeof p !== 'string' || !p) continue
    const st = await fsP.stat(p)
    if (!st.isFile()) throw new Error('attachment is not a file: ' + basename(p))
    total += st.size
    if (total > MAX_ATTACH_TOTAL) throw new Error('attachments exceed 20 MB in total')
    out.push({ filename: basename(p), content: await fsP.readFile(p) })
  }
  return out
}

/** Compose the RFC 5322 message bytes. */
export async function compose(acc, msg) {
  assertNoInjection(msg)
  const from = msg.from || acc.defaultFrom || (acc.displayName ? '"' + acc.displayName.replace(/"/g, '') + '" <' + acc.address + '>' : acc.address)
  if (!from) throw new Error('no From address: set the account address or pass from')
  const text = msg.text || ''
  const mail = new MailComposer({
    from,
    to: msg.to, cc: msg.cc, bcc: msg.bcc,
    replyTo: msg.replyTo || acc.replyTo || undefined,
    subject: msg.subject || '',
    text,
    html: msg.html || undefined,
    inReplyTo: msg.inReplyTo || undefined,
    references: msg.references || undefined,
    attachments: msg.attachments || undefined,
    headers: { ...(msg.headers || {}), 'X-Mailer': 'dsh-mail' },
  }).compile()
  mail.keepBcc = false
  const raw = await mail.build()
  return { raw, envelope: mail.getEnvelope(), messageId: mail.messageId(), from }
}

/** Send through SMTP. Returns { messageId, from, raw }. */
export async function smtpSend(acc, msg, { transport, accessToken, built: prebuilt } = {}) {
  const built = prebuilt || await compose(acc, msg)
  const tr = transport || nodemailer.createTransport(transportOptions(acc, accessToken))
  try {
    const info = await tr.sendMail({ envelope: built.envelope, raw: built.raw })
    return { messageId: info.messageId || built.messageId, from: built.from, raw: built.raw, accepted: info.accepted || [] }
  } finally { if (!transport) tr.close() }
}

export async function smtpVerify(acc, accessToken) {
  const tr = nodemailer.createTransport(transportOptions(acc, accessToken))
  try { await tr.verify(); return true } finally { tr.close() }
}

/** True when an SMTP error means the tenant or mailbox has SMTP AUTH disabled (Microsoft). */
export function isSmtpAuthDisabled(err) {
  const m = String((err && (err.response || err.message)) || '')
  return /5\.7\.139|SmtpClientAuthentication is disabled|SMTP AUTH is disabled|5\.7\.3 Authentication unsuccessful|^535|\b535\b/i.test(m) || (err && (err.responseCode === 535 || err.code === 'EAUTH'))
}
