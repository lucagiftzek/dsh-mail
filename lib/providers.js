/**
 * dsh-mail — provider transport layer.
 *
 * Every provider implements the same interface:
 *   name()      -> string
 *   enabled()   -> boolean
 *   send(ctx, msg)   -> { messageId, from }
 *   recent(ctx, limit) -> [InboundMessage]   (optional — not all providers support read)
 *   fetch(ctx, messageId) -> InboundMessage  (optional)
 *   domains(ctx) -> [{ name, domain }]       (optional)
 *
 * Credentials are NEVER stored in this file. They come from:
 *   1. ~/.dsh/settings.yaml  (dsh-mail namespace, set via Settings UI or MD file)
 *   2. Environment variables  (DSH_MAIL_<PROVIDER>_<KEY>, wins over settings)
 *   3. Estate credential files (read-only, never written by this plugin)
 *
 * The plugin resolves credentials at call time, never caches them in memory
 * longer than one request, and never logs values.
 */

'use strict'

import { createRequire } from 'node:module'
const req = createRequire(import.meta.url)

// ── Helpers ──────────────────────────────────────────────────────────────

function envCred(envKey) {
  const v = process.env[envKey]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** Resolve a credential: env wins, then settings, then estate file field. */
function resolveCred(envKeys, settingsVal, fileVal) {
  for (const k of envKeys) {
    const v = envCred(k)
    if (v) return v
  }
  if (typeof settingsVal === 'string' && settingsVal.trim()) return settingsVal.trim()
  if (typeof fileVal === 'string' && fileVal.trim()) return fileVal.trim()
  return null
}

/** Simple fetch with timeout. Uses global fetch (Node >= 22). */
async function httpFetch(url, opts = {}, timeoutMs = 30000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal })
    return r
  } finally {
    clearTimeout(timer)
  }
}

async function readBody(r, maxBytes = 4 * 1024 * 1024) {
  const buf = await r.arrayBuffer()
  const bytes = new Uint8Array(buf.slice(0, maxBytes))
  return new TextDecoder().decode(bytes)
}

// ── Lettermint ────────────────────────────────────────────────────────────
// API base: https://api.lettermint.co/v1
// Auth: x-lettermint-token header
// Send: POST /send  body: { from, to: [..], subject, text, reply_to: [..], headers: {} }
// Verified live in the Erioun-apply codebase on this estate.

function lettermintProvider(creds) {
  const apiKey = creds.lettermintApiKey
  const baseURL = creds.lettermintBaseURL || 'https://api.lettermint.co/v1'
  return {
    name: () => 'lettermint',
    enabled: () => !!apiKey,
    async send(ctx, msg) {
      const payload = {
        from: msg.from,
        to: Array.isArray(msg.to) ? msg.to : [msg.to],
        subject: msg.subject,
        text: msg.text,
      }
      if (msg.html) payload.html = msg.html
      if (msg.replyTo) payload.reply_to = Array.isArray(msg.replyTo) ? msg.replyTo : [msg.replyTo]
      if (msg.inReplyTo) payload.headers = { 'In-Reply-To': msg.inReplyTo, References: msg.inReplyTo }
      const r = await httpFetch(baseURL + '/send', {
        method: 'POST',
        headers: {
          'x-lettermint-token': apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(payload),
      })
      const body = await readBody(r)
      if (!r.ok) throw new Error('lettermint: send failed (' + r.status + '): ' + body.slice(0, 400))
      const parsed = JSON.parse(body)
      return { messageId: parsed.message_id || parsed.id || '', from: msg.from }
    },
  }
}

// ── AgentMail ─────────────────────────────────────────────────────────────
// API base: https://api.agentmail.to/v0
// Auth: Bearer token
// Send:  POST /inboxes/{inbox}/messages/send  body: { to: [..], subject, text, reply_to: [..] }
// List:  GET  /inboxes/{inbox}/messages?limit=N
// Fetch: GET  /inboxes/{inbox}/messages/{messageId}
// Domains: GET /inboxes (lists available inboxes — restricted keys may 403)
// Verified live in the Erioun-apply codebase on this estate.

function agentmailProvider(creds) {
  const apiKey = creds.agentmailApiKey
  const inbox = creds.agentmailInbox
  const baseURL = creds.agentmailBaseURL || 'https://api.agentmail.to/v0'
  return {
    name: () => 'agentmail',
    enabled: () => !!(apiKey && inbox),
    async send(ctx, msg) {
      const payload = {
        to: Array.isArray(msg.to) ? msg.to : [msg.to],
        subject: msg.subject,
        text: msg.text,
      }
      if (msg.replyTo) payload.reply_to = Array.isArray(msg.replyTo) ? msg.replyTo : [msg.replyTo]
      const r = await httpFetch(baseURL + '/inboxes/' + encodeURIComponent(inbox) + '/messages/send', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(payload),
      })
      const body = await readBody(r)
      if (!r.ok) throw new Error('agentmail: send failed (' + r.status + '): ' + body.slice(0, 400))
      const parsed = JSON.parse(body)
      return { messageId: parsed.message_id || '', from: inbox + '@agentmail.to', threadId: parsed.thread_id || '' }
    },
    async recent(ctx, limit) {
      const n = Math.min(100, Math.max(1, limit || 50))
      const r = await httpFetch(baseURL + '/inboxes/' + encodeURIComponent(inbox) + '/messages?limit=' + n, {
        headers: { authorization: 'Bearer ' + apiKey, accept: 'application/json' },
      })
      if (!r.ok) throw new Error('agentmail: list failed (' + r.status + ')')
      const body = await readBody(r)
      const parsed = JSON.parse(body)
      return (parsed.messages || []).map(m => ({
        messageId: m.message_id,
        threadId: m.thread_id,
        from: m.from,
        to: (m.to || [])[0] || '',
        subject: m.subject,
        text: m.text || m.preview || '',
        inbound: !(m.labels || []).some(l => l.toLowerCase() === 'sent'),
        timestamp: m.timestamp,
      }))
    },
    async fetch(ctx, messageId) {
      const r = await httpFetch(baseURL + '/inboxes/' + encodeURIComponent(inbox) + '/messages/' + encodeURIComponent(messageId), {
        headers: { authorization: 'Bearer ' + apiKey, accept: 'application/json' },
      })
      if (!r.ok) throw new Error('agentmail: fetch failed (' + r.status + ')')
      const body = await readBody(r)
      const m = JSON.parse(body)
      return {
        messageId: m.message_id,
        threadId: m.thread_id,
        from: m.from,
        to: (m.to || [])[0] || '',
        subject: m.subject,
        text: m.text || m.preview || '',
        inbound: !(m.labels || []).some(l => l.toLowerCase() === 'sent'),
        timestamp: m.timestamp,
      }
    },
    async domains(ctx) {
      try {
        const r = await httpFetch(baseURL + '/inboxes', {
          headers: { authorization: 'Bearer ' + apiKey, accept: 'application/json' },
        })
        if (!r.ok) return []
        const body = await readBody(r)
        const parsed = JSON.parse(body)
        return (parsed.inboxes || parsed || []).map(i => ({ name: i.name || i.inbox || '', domain: i.domain || (i.inbox || '') + '@agentmail.to' }))
      } catch { return [] }
    },
  }
}

// ── Resend ────────────────────────────────────────────────────────────────
// API base: https://api.resend.com
// Auth: Bearer token
// Send:  POST /emails  body: { from, to: [..], subject, text, html, reply_to, cc, bcc, attachments }
// Verified against public Resend API documentation.

function resendProvider(creds) {
  const apiKey = creds.resendApiKey
  const baseURL = creds.resendBaseURL || 'https://api.resend.com'
  return {
    name: () => 'resend',
    enabled: () => !!apiKey,
    async send(ctx, msg) {
      const payload = {
        from: msg.from,
        to: Array.isArray(msg.to) ? msg.to : [msg.to],
        subject: msg.subject,
        text: msg.text,
      }
      if (msg.html) payload.html = msg.html
      if (msg.replyTo) payload.reply_to = msg.replyTo
      if (msg.cc) payload.cc = Array.isArray(msg.cc) ? msg.cc : [msg.cc]
      if (msg.bcc) payload.bcc = Array.isArray(msg.bcc) ? msg.bcc : [msg.bcc]
      if (msg.attachments) payload.attachments = msg.attachments
      const r = await httpFetch(baseURL + '/emails', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(payload),
      })
      const body = await readBody(r)
      if (!r.ok) throw new Error('resend: send failed (' + r.status + '): ' + body.slice(0, 400))
      const parsed = JSON.parse(body)
      return { messageId: parsed.id || '', from: msg.from }
    },
    async domains(ctx) {
      try {
        const r = await httpFetch(baseURL + '/domains', {
          headers: { authorization: 'Bearer ' + apiKey, accept: 'application/json' },
        })
        if (!r.ok) return []
        const body = await readBody(r)
        const parsed = JSON.parse(body)
        return (parsed.data || parsed || []).map(d => ({ name: d.name || '', domain: d.name || '' }))
      } catch { return [] }
    },
  }
}

// ── SMTP (OVH / Manual / Local self-host) ─────────────────────────────────
// Uses nodemailer if available (resolved defensively from the profile node_modules).
// OVH defaults: smtp host ssl0.ovh.net port 465 (SSL) or 587 (STARTTLS)
// IMAP read: uses imapflow if available (resolved defensively).

function smtpProvider(creds) {
  const host = creds.smtpHost
  const port = creds.smtpPort || 587
  const user = creds.smtpUser
  const pass = creds.smtpPass
  const from = creds.smtpFrom || user
  const secure = creds.smtpSecure !== undefined ? creds.smtpSecure : port === 465
  const providerName = creds.smtpLabel || 'smtp'

  return {
    name: () => providerName,
    enabled: () => !!(host && user && pass),
    async send(ctx, msg) {
      let transporter = null
      try {
        const nodemailer = req('nodemailer')
        transporter = nodemailer.createTransport({
          host,
          port: Number(port),
          secure: !!secure,
          auth: { user, pass },
        })
      } catch (e) {
        // Try resolving from profile node_modules
        try {
          const profileReq = createRequire(require('node:path').join(process.env.HOME || '/home/lucagiftzek', '.dsh', 'profiles', 'web', 'package.json'))
          const nodemailer = profileReq('nodemailer')
          transporter = nodemailer.createTransport({
            host, port: Number(port), secure: !!secure, auth: { user, pass },
          })
        } catch (e2) {
          throw new Error('smtp: nodemailer is not installed. Install it in the web profile: cd ~/.dsh/profiles/web && pnpm add nodemailer')
        }
      }
      const info = await transporter.sendMail({
        from: msg.from || from,
        to: Array.isArray(msg.to) ? msg.to.join(', ') : msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        replyTo: msg.replyTo,
        cc: msg.cc,
        bcc: msg.bcc,
        attachments: msg.attachments,
      })
      return { messageId: info.messageId || '', from: msg.from || from }
    },
    async recent(ctx, limit) {
      if (!creds.imapHost && !creds.smtpHost) return []
      let imapClient = null
      try {
        const ImapFlow = req('imapflow')
        imapClient = new ImapFlow.ImapFlow || ImapFlow
      } catch {
        try {
          const profileReq = createRequire(require('node:path').join(process.env.HOME || '/home/lucagiftzek', '.dsh', 'profiles', 'web', 'package.json'))
          const ImapFlow = profileReq('imapflow')
          imapClient = ImapFlow.ImapFlow || ImapFlow
        } catch { return [] }
      }
      if (!imapClient) return []
      const client = new imapClient({
        host: creds.imapHost || host,
        port: creds.imapPort || 993,
        secure: creds.imapSecure !== false,
        auth: { user: creds.imapUser || user, pass: creds.imapPass || pass },
      })
      try {
        await client.connect()
        const lock = await client.getMailboxLock('INBOX')
        try {
          const messages = []
          for await (const msg of client.fetch({ count: Math.min(100, limit || 50) }, { envelope: true, source: true })) {
            const env = msg.envelope || {}
            messages.push({
              messageId: env.messageId || '',
              from: (env.from && env.from[0] && (env.from[0].address || '')) || '',
              to: (env.to && env.to[0] && (env.to[0].address || '')) || '',
              subject: env.subject || '',
              text: '', // source would need parsing; full body fetch is expensive
              inbound: true,
              timestamp: env.date ? env.date.toISOString() : '',
            })
          }
          return messages
        } finally { lock.release() }
      } finally { await client.logout().catch(() => {}) }
    },
    async domains(ctx) {
      // For SMTP, the "domain" is the from address domain
      if (from && from.includes('@')) return [{ name: providerName, domain: from.split('@')[1] }]
      if (user && user.includes('@')) return [{ name: providerName, domain: user.split('@')[1] }]
      return [{ name: providerName, domain: host || 'unknown' }]
    },
  }
}

// ── Provider factory ─────────────────────────────────────────────────────

export function buildProvider(providerId, creds) {
  switch (providerId) {
    case 'lettermint': return lettermintProvider(creds)
    case 'agentmail':  return agentmailProvider(creds)
    case 'resend':     return resendProvider(creds)
    case 'ovh':        return smtpProvider({ ...creds, smtpLabel: 'ovh' })
    case 'smtp':       return smtpProvider({ ...creds, smtpLabel: creds.smtpLabel || 'smtp' })
    case 'local':      return smtpProvider({ ...creds, smtpLabel: 'local' })
    default: return null
  }
}

/** List all configured provider IDs (enabled ones first). */
export function configuredProviders(providers) {
  const out = []
  for (const [id, p] of Object.entries(providers)) {
    if (p && typeof p.enabled === 'function' && p.enabled()) out.push(id)
  }
  return out
}

export { resolveCred, envCred }
