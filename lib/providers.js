/**
 * dsh-mail: provider transport layer.
 *
 * Every provider implements the same interface:
 *   name()      -> string
 *   enabled()   -> boolean
 *   send(ctx, msg)   -> { messageId, from }
 *   recent(ctx, limit) -> [InboundMessage]   (optional, not all providers support read)
 *   fetch(ctx, messageId) -> InboundMessage  (optional)
 *   domains(ctx) -> [{ name, domain }]       (optional)
 *
 * Credentials are NEVER stored in this file. They come from:
 *   1. ~/.dsh/settings.yaml  (dsh-mail namespace, set via Settings UI or MD file)
 *   2. Environment variables  (DSH_MAIL_<PROVIDER>_<KEY>, wins over settings)
 *   3. Local credential files (read-only, never written by this plugin)
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

/** Resolve a credential: env wins, then settings, then credential file field. */
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
// Verified live.

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
// Domains: GET /inboxes (lists available inboxes; restricted keys may 403)
// Verified live.

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
// Uses nodemailer (a declared dependency).
// OVH defaults: smtp host ssl0.ovh.net port 465 (SSL) or 587 (STARTTLS)
// IMAP read: imapflow (a declared dependency).

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
      // nodemailer is a declared dependency of this plugin (v0.1 resolved it from the profile by luck).
      const nodemailer = req('nodemailer')
      const transporter = nodemailer.createTransport({ host, port: Number(port), secure: !!secure, auth: { user, pass } })
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
      const imapClient = req('imapflow').ImapFlow
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

// ── tzmail (webmail API) ────────────────────────────
// Added 2026-09-25 for per-person mailboxes. Logs in AS THE MAILBOX USER, so the
// webmail's own per-user scoping (accountAllowed) decides what can be read and
// which addresses can send -- no shared key is involved, and sent mail lands
// in the user's Sent/thread exactly as if sent from the web UI.
//   Login:  POST /api/auth/login {username,password} -> cookie tzm_session
//           (users with OTP enabled cannot use this provider: step "otp")
//   Send:   POST /api/send {accountId,to,cc,subject,text,html,threadId,idempotencyKey}
//   List:   GET  /api/threads?view=inbox|all&limit=N
//   Fetch:  GET  /api/threads/{threadId}
// tzmailAccounts maps From addresses to webmail account ids:
//   "a@x.com=uuid, b@y.com=uuid"  (first entry is the default From)

const _tzSessions = new Map()   // user -> { cookie, exp }  (session token only, never the password)

function tzmailProvider(creds) {
  const base = (creds.tzmailBaseURL || '').replace(/\/+$/, '')
  const user = creds.tzmailUser
  const pass = creds.tzmailPass
  const accounts = String(creds.tzmailAccounts || '').split(',').map(s => s.trim()).filter(Boolean)
    .map(s => { const i = s.indexOf('='); return i > 0 ? { address: s.slice(0, i).trim().toLowerCase(), id: s.slice(i + 1).trim() } : null })
    .filter(Boolean)

  async function login(force) {
    const c = _tzSessions.get(user)
    if (!force && c && c.exp > Date.now()) return c.cookie
    const r = await httpFetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ username: user, password: pass }),
      redirect: 'manual',
    })
    const body = await readBody(r)
    let parsed = {}
    try { parsed = JSON.parse(body) } catch {}
    if (!r.ok || !parsed.ok) throw new Error('tzmail: login failed (' + r.status + ')')
    if (parsed.step !== 'done') throw new Error('tzmail: this mailbox user has OTP enabled; API login is not possible')
    const setc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || '']
    const m = setc.map(s => /tzm_session=([^;]+)/.exec(s || '')).find(Boolean)
    if (!m) throw new Error('tzmail: login returned no session cookie')
    const cookie = 'tzm_session=' + m[1]
    _tzSessions.set(user, { cookie, exp: Date.now() + 30 * 60 * 1000 })
    return cookie
  }

  async function api(path, opts = {}) {
    for (const force of [false, true]) {
      const cookie = await login(force)
      const r = await httpFetch(base + path, { ...opts, headers: { ...(opts.headers || {}), cookie, accept: 'application/json' }, redirect: 'manual' })
      if (r.status === 401 && !force) { _tzSessions.delete(user); continue }
      const body = await readBody(r)
      let parsed = {}
      try { parsed = JSON.parse(body) } catch {}
      if (!r.ok || parsed.ok === false) throw new Error('tzmail: ' + (opts.method || 'GET') + ' ' + path.split('?')[0] + ' failed (' + r.status + '): ' + String(parsed.error || body).slice(0, 300))
      return parsed
    }
    throw new Error('tzmail: unauthorized')
  }

  function accountFor(from) {
    if (!accounts.length) throw new Error('tzmail: no accounts configured (tzmailAccounts)')
    if (!from) return accounts[0]
    const f = String(from).toLowerCase()
    const hit = accounts.find(a => f === a.address || f.endsWith('<' + a.address + '>'))
    if (!hit) throw new Error('tzmail: ' + from + ' is not one of this user\'s mailboxes: ' + accounts.map(a => a.address).join(', '))
    return hit
  }

  const toList = v => (Array.isArray(v) ? v : String(v || '').split(',')).map(s => String(s).trim()).filter(Boolean)

  return {
    name: () => 'tzmail',
    enabled: () => !!(base && user && pass && accounts.length),
    async send(ctx, msg) {
      const acct = accountFor(msg.from)
      const payload = { accountId: acct.id, to: toList(msg.to), subject: msg.subject || '', text: msg.text || '' }
      if (msg.html) payload.html = msg.html
      if (msg.cc) payload.cc = toList(msg.cc)
      if (msg.threadId) payload.threadId = msg.threadId
      if (msg.inReplyTo) payload.inReplyTo = msg.inReplyTo
      payload.idempotencyKey = 'dsh-mail-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
      const res = await api('/api/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      return { messageId: (res.message && (res.message.message_id || res.message.id)) || '', from: acct.address, threadId: res.threadId || '' }
    },
    async recent(ctx, limit) {
      const n = Math.min(100, Math.max(1, limit || 20))
      const res = await api('/api/threads?view=all&limit=' + n)
      return (res.threads || []).map(t => ({
        messageId: t.id,              // thread id: pass it to mail_fetch
        threadId: t.id,
        from: t.last_from || (t.participants || [])[0] || '',
        to: (t.account && t.account.address) || '',
        subject: t.subject || '',
        text: t.preview || '',
        inbound: !!(t.last_from && t.account && String(t.last_from).toLowerCase().indexOf(String(t.account.address).toLowerCase()) < 0),
        unread: t.unread_count || 0,
        messages: t.message_count || 0,
        timestamp: t.last_message_at,
      }))
    },
    async fetch(ctx, threadId) {
      const res = await api('/api/threads/' + encodeURIComponent(threadId))
      const msgs = res.messages || []
      const last = msgs[msgs.length - 1] || {}
      const text = msgs.map(m => '--- ' + (m.direction || '') + ' ' + (m.from_addr || '') + ' -> ' + (m.to_addrs || []).join(', ') +
        ' @ ' + (m.received_at || m.created_at || '') + '\n' + (m.text_body || m.snippet || '')).join('\n\n')
      return {
        messageId: threadId, threadId,
        from: last.from_addr || '', to: (last.to_addrs || [])[0] || '',
        subject: (res.thread && res.thread.subject) || last.subject || '',
        text, inbound: last.direction !== 'outbound', timestamp: last.received_at || last.created_at,
        messageCount: msgs.length, lastMessageId: last.message_id || '',
      }
    },
    async domains() {
      return accounts.map(a => ({ name: a.address, domain: a.address }))
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
    case 'tzmail':     return tzmailProvider(creds)
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
