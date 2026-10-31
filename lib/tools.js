/**
 * dsh-mail / tools.js: the agent tools.
 *
 * Every v0.1 tool keeps its name, its arguments and its result shape; new
 * arguments are optional. `account` is accepted everywhere and `provider` is
 * its alias (old provider ids are the ids of the legacy virtual accounts).
 *
 * Sends follow agents.confirmMode:
 *   all         draft first: without confirm:true the tool returns the draft
 *               and a draftId; mail_send({ draftId, confirm:true }) delivers.
 *   reply-only  v0.1 behaviour: mail_send sends at once, only mail_reply drafts.
 */

'use strict'

import fsP from 'node:fs/promises'
import { join } from 'node:path'

import { agentCall, formatThread, formatThreads } from './mailbox.js'
import { agentDenied, accountSummary, capabilities, defaultAccountId, effectiveConfirmMode } from './accounts.js'
import { parseId, receiveKind, providerFor, makeId, safeName } from './service.js'
import { parseCSV, personalise } from './staging.js'
import { loadAttachments, addrList } from './smtp.js'
import { normSubject } from './cache.js'

const TEXT = s => [{ type: 'text', text: s }]
const GENERIC = {
  type: 'object', additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    text: { type: 'string' },
    count: { type: 'integer' },
    drafted: { type: 'boolean' },
    draftId: { type: 'string' },
    error: { type: 'string' },
    data: { type: 'json' },
  },
}
const genericOut = { schema: GENERIC, render: (_a, v) => TEXT(v.text || v.error || (v.ok ? 'ok' : 'failed')) }
const ACCOUNT_ARG = { type: 'string', description: 'Account id (see mail_accounts). Omit for the default account.' }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function iso(ms) { return ms ? new Date(ms).toISOString() : '' }
function clipText(s, n) { const t = String(s || ''); return t.length > n ? t.slice(0, n) + '\n[... truncated at ' + n + ' characters]' : t }

/**
 * @param defineTool  the harness defineTool
 * @param ctx         cordis context with ctx.tools
 * @param d           { effective, resolved, service, queue, drafts, dataDir, scrub }
 */
export function registerTools(defineTool, ctx, d) {
  const reg = def => ctx.tools.register(defineTool(def))
  const settings = () => d.effective()
  const maxBody = () => Math.max(200, Number((settings().agents || {}).maxBodyChars) || 8000)
  const toolsOff = () => (settings().agents || {}).enabled === false
  const scrub = m => d.scrub(String(m && m.message ? m.message : m))

  /** Resolve the account a tool works on; returns { acc } or { error }. */
  function pick(args, need, { preferRead = false } = {}) {
    if (toolsOff()) return { error: 'agent mail tools are disabled (agents.enabled: false)' }
    const s = settings()
    const r = d.resolved()
    let id = args.account || args.provider || ''
    if (!id) {
      id = defaultAccountId(s, r)
      if (preferRead) {
        const def = r.all.find(a => a.id === id)
        if (!def || !capabilities(def).includes('read')) {
          const alt = r.all.find(a => a.enabled && capabilities(a).includes('read') && !agentDenied(a, 'read', s))
          if (alt) id = alt.id
        }
      }
    }
    if (!r.all.length) return { error: 'no accounts configured' }
    if (!id) return { error: 'no accounts configured' }
    const acc = r.all.find(a => a.id === id)
    if (!acc) return { error: 'provider ' + id + ' is not configured' }
    const denied = agentDenied(acc, need, s)
    if (denied) return { error: denied }
    return { acc }
  }

  function confirmMode() { return effectiveConfirmMode(settings(), d.resolved()).mode }

  function renderDraft(dr) {
    return 'DRAFT (not sent) ' + dr.id + ' via ' + dr.account + '\nFrom: ' + (dr.from || '(account default)') + '\nTo: ' + dr.to +
      (dr.cc ? '\nCc: ' + dr.cc : '') + (dr.bcc ? '\nBcc: ' + dr.bcc : '') + '\nSubject: ' + dr.subject +
      (dr.attachments && dr.attachments.length ? '\nAttachments: ' + dr.attachments.join(', ') : '') + '\n\n' + clipText(dr.text, 4000)
  }

  async function deliver(acc, msg) {
    const attachments = msg.attachments && msg.attachments.length ? await loadAttachments(msg.attachments) : undefined
    const sig = acc.signature && msg.text && !msg.noSignature ? '\n\n' + acc.signature : ''
    return d.service.send(acc, { ...msg, text: (msg.text || '') + sig, attachments })
  }

  // ── mail_send ─────────────────────────────────────────────────────────────
  reg({
    name: 'mail_send',
    description: 'Send one email through an account. Draft first, then confirm:true: when agents.confirmMode is "all", a call without confirm:true only returns the draft and a draftId; ' +
      'call mail_send({ draftId, confirm:true }) to deliver it. Use mail_send_later to schedule, mail_mass_send for bulk, mail_read to check replies.',
    parameters: {
      provider: { type: 'string', description: 'Account id (alias of account; old provider ids lettermint, agentmail, resend, ovh, smtp, local, tzmail still work). Defaults to the configured default.' },
      account: ACCOUNT_ARG,
      from: { type: 'string', description: 'Sender email address. Defaults to the account default From.' },
      to: { type: 'string', description: 'Recipient email address (single or comma-separated).' },
      cc: { type: 'string', description: 'Optional Cc (comma-separated).' },
      bcc: { type: 'string', description: 'Optional Bcc (comma-separated).' },
      subject: { type: 'string', description: 'Email subject.' },
      text: { type: 'string', description: 'Plain-text email body.' },
      html: { type: 'string', description: 'Optional HTML body.' },
      replyTo: { type: 'string', description: 'Optional reply-to address.' },
      attachments: { type: 'json', description: 'Optional array of file paths to attach (20 MB total).' },
      draftId: { type: 'string', description: 'Deliver (with confirm:true) or show a draft created earlier.' },
      confirm: { type: 'boolean', description: 'true delivers. Without it the draft is returned when confirmation is required.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true }, messageId: { type: 'string' }, from: { type: 'string' }, provider: { type: 'string' },
          account: { type: 'string' }, drafted: { type: 'boolean' }, draftId: { type: 'string' }, text: { type: 'string' }, error: { type: 'string' }, data: { type: 'json' },
        },
      },
      render: (_a, v) => TEXT(v.drafted ? v.text : v.ok ? 'Sent via ' + v.provider + ': message ID ' + v.messageId : 'Send failed: ' + (v.error || 'unknown')),
    },
    async execute(args) {
      try {
        let src = args
        if (args.draftId) {
          const dr = await d.drafts.read(args.draftId)
          if (!dr) return { ok: false, error: 'no draft ' + args.draftId }
          src = { ...dr, account: dr.account, attachments: dr.attachments }
          if (args.confirm !== true) return { ok: true, drafted: true, draftId: dr.id, text: renderDraft(dr) + '\n\nRe-run mail_send with { draftId: "' + dr.id + '", confirm: true } to deliver it.' }
        }
        const { acc, error } = pick(src, 'send')
        if (error) return { ok: false, error }
        const msg = {
          from: src.from || '', to: src.to || '', cc: src.cc || '', bcc: src.bcc || '', subject: src.subject || '', text: src.text || '',
          html: src.html || '', replyTo: src.replyTo || '', inReplyTo: src.inReplyTo || '', references: src.references || '',
          attachments: Array.isArray(src.attachments) ? src.attachments : [],
        }
        if (!args.draftId && confirmMode() === 'all' && args.confirm !== true) {
          const dr = await d.drafts.save({ ...msg, account: acc.id, by: 'agent' })
          return { ok: true, drafted: true, draftId: dr.id, account: acc.id, provider: acc.id, text: renderDraft(dr) + '\n\nNothing was sent. Show this to the user; deliver with mail_send({ draftId: "' + dr.id + '", confirm: true }).' }
        }
        const to = addrList(msg.to)
        const r = await deliver(acc, { ...msg, to, cc: addrList(msg.cc), bcc: addrList(msg.bcc) })
        if (args.draftId) await d.drafts.remove(args.draftId).catch(() => {})
        return { ok: true, messageId: String(r.messageId || ''), from: String(r.from || ''), provider: acc.id, account: acc.id }
      } catch (e) { return { ok: false, error: scrub(e) } }
    },
  })

  // ── mail_mass_send ────────────────────────────────────────────────────────
  reg({
    name: 'mail_mass_send',
    description: 'Send personalised mass emails from CSV data. Each row is one email with template substitution. ' +
      'Supports a delay between sends to respect rate limits. Example CSV: name,email\nMaria,maria@example.com\nFotis,fotis@example.com. ' +
      'Template uses {name}, {email}, {any_column} placeholders. When agents.confirmMode is "all" the batch is staged in the review queue unless confirm:true and the account allows agent mass sends.',
    parameters: {
      provider: { type: 'string', description: 'Account id (alias of account). Defaults to the configured default.' },
      account: ACCOUNT_ARG,
      from: { type: 'string', description: 'Sender email address.' },
      subjectTemplate: { type: 'string', description: 'Subject with {placeholders} for CSV columns, e.g. "Hi, {name}!"' },
      textTemplate: { type: 'string', description: 'Body text with {placeholders}, e.g. "Hi {name}, ..."' },
      csv: { type: 'string', description: 'CSV text with header row. Columns must include at least "email" (or "Email"). Other columns are available as {column_name} placeholders.' },
      delayMs: { type: 'integer', description: 'Delay in milliseconds between sends. Clamped to [minDelayMs, maxDelayMs]. Default: 1000.' },
      replyTo: { type: 'string', description: 'Optional reply-to address.' },
      queueOnly: { type: 'boolean', description: 'If true, queue for manual send via sidebar instead of sending immediately. Default: false.' },
      confirm: { type: 'boolean', description: 'With confirmMode "all": true sends now (needs agent mass-send permission on the account).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, sent: { type: 'integer' }, failed: { type: 'integer' }, total: { type: 'integer' }, queueId: { type: 'string' }, error: { type: 'string' } },
      },
      render: (_a, v) => TEXT(v.ok
        ? (v.queueId ? 'Queued ' + v.total + ' emails (id ' + v.queueId + ') for review in the Mail tab' : 'Sent ' + v.sent + '/' + v.total + (v.failed ? ', ' + v.failed + ' failed' : ''))
        : 'Mass send failed: ' + (v.error || 'unknown')),
    },
    async execute(args) {
      const s = settings()
      try {
        const { acc, error } = pick(args, 'send')
        if (error) return { ok: false, error }
        const rows = parseCSV(args.csv, s.maxCsvRows)
        if (!rows.length) return { ok: false, error: 'CSV has no data rows' }
        if (rows.length > s.maxRecipients) return { ok: false, error: 'too many recipients: ' + rows.length + ' > maxRecipients ' + s.maxRecipients }
        const delayMs = Math.min(s.maxDelayMs, Math.max(s.minDelayMs, args.delayMs || 1000))
        const canMassNow = !agentDenied(acc, 'mass', s)
        const stage = args.queueOnly || !canMassNow || (confirmMode() === 'all' && args.confirm !== true)
        if (stage) {
          const entry = await d.queue.create({
            name: 'mass-send-' + Date.now(), provider: acc.id,
            msg: { from: args.from || acc.defaultFrom || s.defaultFrom, to: '', subject: args.subjectTemplate, text: args.textTemplate, replyTo: args.replyTo },
            csvData: { rows, columns: Object.keys(rows[0]) }, delayMs, requestedBy: 'agent',
          })
          return { ok: true, total: rows.length, queueId: entry.id, sent: 0, failed: 0 }
        }
        let sent = 0, failed = 0
        for (const row of rows) {
          const to = row.email || row.Email || row[Object.keys(row).find(k => k.toLowerCase().includes('email'))]
          if (!to) { failed++; continue }
          try {
            await d.service.send(acc, { from: args.from || '', to: [to], subject: personalise(args.subjectTemplate, row), text: personalise(args.textTemplate, row), replyTo: args.replyTo || s.defaultReplyTo })
            sent++
            if (delayMs) await sleep(delayMs)
          } catch { failed++ }
        }
        return { ok: true, sent, failed, total: rows.length }
      } catch (e) { return { ok: false, error: scrub(e) } }
    },
  })

  // ── mail_send_later ───────────────────────────────────────────────────────
  reg({
    name: 'mail_send_later',
    description: 'Schedule an email for future sending. Adds it to the queue with a sendAt timestamp. ' +
      'The timer processes it automatically when the time arrives. Alternatively, set queue=true for manual send via the sidebar. ' +
      'When agents.confirmMode is "all", entries without confirm:true wait for approval in the Mail tab queue.',
    parameters: {
      provider: { type: 'string', description: 'Account id (alias of account). Defaults to the configured default.' },
      account: ACCOUNT_ARG,
      from: { type: 'string', description: 'Sender email address.' },
      to: { type: 'string', description: 'Recipient email address.' },
      subject: { type: 'string', description: 'Email subject.' },
      text: { type: 'string', description: 'Plain-text email body.' },
      html: { type: 'string', description: 'Optional HTML body.' },
      replyTo: { type: 'string', description: 'Optional reply-to address.' },
      sendAt: { type: 'string', description: 'ISO 8601 datetime to send at, e.g. "2026-09-25T09:00:00Z". Ignored if queue is true.' },
      queue: { type: 'boolean', description: 'If true, queue for manual send (no scheduled time). Default: false.' },
      confirm: { type: 'boolean', description: 'With confirmMode "all": true schedules without waiting for approval.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, queueId: { type: 'string' }, status: { type: 'string' }, error: { type: 'string' } },
      },
      render: (_a, v) => TEXT(v.ok ? 'Email ' + v.status + ' (id ' + v.queueId + ')' : 'Failed: ' + (v.error || 'unknown')),
    },
    async execute(args) {
      const s = settings()
      try {
        const { acc, error } = pick(args, 'send')
        if (error) return { ok: false, error }
        let sendAt = null
        if (!args.queue && args.sendAt) {
          const ts = Date.parse(args.sendAt)
          if (!Number.isFinite(ts)) return { ok: false, error: 'invalid sendAt: must be ISO 8601' }
          sendAt = Math.round(ts / 1000)
        }
        const hold = confirmMode() === 'all' && args.confirm !== true
        const entry = await d.queue.create({
          name: 'email-' + Date.now(), provider: acc.id,
          msg: { from: args.from || acc.defaultFrom || s.defaultFrom, to: args.to, subject: args.subject, text: args.text, html: args.html, replyTo: args.replyTo },
          sendAt: hold ? null : sendAt, requestedSendAt: hold ? sendAt : null, requestedBy: 'agent',
        })
        return { ok: true, queueId: entry.id, status: hold ? 'queued for approval' : entry.status }
      } catch (e) { return { ok: false, error: scrub(e) } }
    },
  })

  // ── mail_read ─────────────────────────────────────────────────────────────
  reg({
    name: 'mail_read',
    description: 'Read recent inbox messages from any account that can receive (IMAP, POP3, Tzekos Mail, AgentMail). ' +
      'Returns a list of messages with subject, from, to, text preview, and message ID (pass it to mail_fetch). Optionally filter by domain, address, folder, unread, since.',
    parameters: {
      provider: { type: 'string', description: 'Account id (alias of account). Defaults to the default account, or the first one that can read.' },
      account: ACCOUNT_ARG,
      limit: { type: 'integer', description: 'Max messages to return. Default 20, max 100.' },
      domain: { type: 'string', description: 'Optional: filter by domain (e.g. "example.com").' },
      address: { type: 'string', description: 'Optional: filter by from/to address.' },
      folder: { type: 'string', description: 'Optional folder path or role (IMAP). Default Inbox.' },
      unread: { type: 'boolean', description: 'Optional: only unread messages.' },
      since: { type: 'string', description: 'Optional ISO date: only messages after it.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, messages: { type: 'json', required: true }, count: { type: 'integer', required: true }, provider: { type: 'string', required: true }, error: { type: 'string' } },
      },
      render: (_a, v) => TEXT(v.ok
        ? (v.count + ' message(s) from ' + v.provider + (v.messages.length ? '\n' + v.messages.map(m => '  [' + (m.inbound ? 'IN' : 'OUT') + (m.unread ? ' NEW' : '') + '] ' + m.from + ' > ' + m.subject + '  id ' + m.messageId).join('\n') : ''))
        : 'Read failed: ' + (v.error || 'unknown')),
    },
    async execute(args) {
      const { acc, error } = pick(args, 'read', { preferRead: true })
      const pid = acc ? acc.id : (args.account || args.provider || '')
      if (error) return { ok: false, error, messages: [], count: 0, provider: pid }
      try {
        const limit = Math.min(100, Math.max(1, args.limit || 20))
        const kind = receiveKind(acc)
        let messages = []
        if (kind === 'imap' || kind === 'pop3') {
          let folder = args.folder || 'INBOX'
          if (kind === 'imap' && args.folder && !/[/.]/.test(args.folder) && args.folder !== 'INBOX') {
            const fl = await d.service.folders(acc)
            const hit = fl.find(f => f.role === args.folder.toLowerCase() || f.path === args.folder || f.name.toLowerCase() === args.folder.toLowerCase())
            if (hit) folder = hit.path
          }
          await d.service.sync(acc, folder).catch(() => {})
          const since = args.since ? Date.parse(args.since) : 0
          messages = d.service.cache.messages(acc.id, folder, 2000)
            .filter(m => (!args.unread || !m.seen) && (!since || m.date >= since))
            .map(m => ({ messageId: makeId(acc.id, m.folder, m.uid), threadId: acc.id + '/' + m.thread, from: m.from_name ? m.from_name + ' <' + m.from_addr + '>' : m.from_addr, to: (m.to[0] && m.to[0].address) || '', subject: m.subject, text: m.snippet, inbound: m.folder === folder && !/sent/i.test(folder), unread: !m.seen, timestamp: iso(m.date) }))
        } else if (kind === 'tzekos') {
          const r = await agentCall(tzCfgOf(acc), 'threads', { view: args.folder || 'all', limit: Math.min(50, limit) })
          messages = (r.threads || []).map(t => ({ messageId: t.id, threadId: t.id, from: t.last_from || '', to: t.account_address || '', subject: t.subject || '', text: t.preview || '', inbound: true, unread: t.unread_count || 0, messages: t.message_count || 0, timestamp: t.last_message_at }))
          if (args.unread) messages = messages.filter(m => m.unread)
        } else if (kind === 'provider') {
          const p = providerFor(acc)
          if (!p || !p.enabled()) return { ok: false, error: 'provider ' + acc.id + ' is not configured', messages: [], count: 0, provider: acc.id }
          messages = await p.recent({}, limit)
        } else return { ok: false, error: 'provider ' + acc.id + ' does not support inbox reading', messages: [], count: 0, provider: acc.id }
        if (args.domain) { const x = args.domain.toLowerCase(); messages = messages.filter(m => (m.from || '').toLowerCase().includes(x) || (m.to || '').toLowerCase().includes(x)) }
        if (args.address) { const x = args.address.toLowerCase(); messages = messages.filter(m => (m.from || '').toLowerCase().includes(x) || (m.to || '').toLowerCase().includes(x)) }
        messages = messages.slice(0, limit)
        return { ok: true, messages, count: messages.length, provider: acc.id }
      } catch (e) { return { ok: false, error: scrub(e), messages: [], count: 0, provider: acc.id } }
    },
  })

  function tzCfgOf(acc) {
    return { baseUrl: String(acc.api.baseUrl || '').replace(/\/+$/, ''), token: acc.secrets.apiKey || acc.tokenFromFile || '' }
  }

  // ── mail_fetch ────────────────────────────────────────────────────────────
  reg({
    name: 'mail_fetch',
    description: 'Fetch a single message by message ID (full text body, HTML converted to text). Accepts the composite id "account:folder:uid" from mail_read / mail_search, an API message id, or a Tzekos Mail thread id.',
    parameters: {
      provider: { type: 'string', description: 'Account id (alias of account). Not needed for composite ids.' },
      account: ACCOUNT_ARG,
      messageId: { type: 'string', description: 'The message ID to fetch.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, message: { type: 'json' }, error: { type: 'string' } } },
      render: (_a, v) => TEXT(v.ok
        ? ('From: ' + (v.message.from || '?') + '\nSubject: ' + (v.message.subject || '?') + '\n\n' + (v.message.text || ''))
        : 'Fetch failed: ' + (v.error || 'unknown')),
    },
    async execute(args) {
      try {
        const ref = parseId(args.messageId)
        const r = d.resolved()
        const viaId = ref && r.all.some(a => a.id === ref.account) ? ref.account : ''
        const { acc, error } = pick({ account: args.account || args.provider || viaId }, 'read', { preferRead: true })
        if (error) return { ok: false, error }
        const kind = receiveKind(acc)
        if ((kind === 'imap' || kind === 'pop3') && ref) {
          const m = await d.service.message(args.messageId)
          return { ok: true, message: {
            messageId: m.id, threadId: acc.id + '/' + ((d.service.cache.getMessage(acc.id, m.folder, m.uid) || {}).thread || ''),
            from: m.from.name ? m.from.name + ' <' + m.from.address + '>' : m.from.address, to: m.to.map(a => a.address).join(', '), cc: m.cc.map(a => a.address).join(', '),
            subject: m.subject, text: clipText(m.text, maxBody()), inbound: true, timestamp: iso(m.date),
            attachments: m.attachments.map(a => ({ part: a.part, filename: a.filename, contentType: a.contentType, size: a.size })),
          } }
        }
        if (kind === 'tzekos') {
          const id = ref ? ref.uid.split('#')[0] : args.messageId
          const res = await agentCall(tzCfgOf(acc), 'thread', { id })
          const msgs = res.messages || []
          const last = msgs[msgs.length - 1] || {}
          const text = msgs.map(m => '--- ' + (m.direction || '') + ' ' + (m.from_addr || '') + ' -> ' + (m.to_addrs || []).join(', ') + ' @ ' + (m.received_at || m.created_at || '') + '\n' + (m.text_body || m.snippet || '')).join('\n\n')
          return { ok: true, message: { messageId: id, threadId: id, from: last.from_addr || '', to: (last.to_addrs || [])[0] || '', subject: (res.thread && res.thread.subject) || last.subject || '', text: clipText(text, maxBody()), inbound: last.direction !== 'out', timestamp: last.received_at || last.created_at, messageCount: msgs.length } }
        }
        const p = providerFor(acc)
        if (!p || !p.enabled()) return { ok: false, error: 'provider not configured' }
        if (typeof p.fetch !== 'function') return { ok: false, error: 'provider does not support message fetch' }
        const m = await p.fetch({}, ref ? ref.uid : args.messageId)
        return { ok: true, message: { ...m, text: clipText(m.text, maxBody()) } }
      } catch (e) { return { ok: false, error: scrub(e) } }
    },
  })

  // ── mail_domains ──────────────────────────────────────────────────────────
  reg({
    name: 'mail_domains',
    description: 'List sender identities (domains, inboxes, addresses) per account. Useful for knowing which From addresses are available.',
    parameters: {
      provider: { type: 'string', description: 'Account id. If omitted, lists every account that can send.' },
      account: ACCOUNT_ARG,
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, domains: { type: 'json', required: true }, error: { type: 'string' } } },
      render: (_a, v) => TEXT(v.ok ? (v.domains.map(x => x.provider + ': ' + x.domains.map(dd => dd.domain || dd.name).join(', ')).join('\n') || 'No domains found') : 'Failed: ' + (v.error || 'unknown')),
    },
    async execute(args) {
      if (toolsOff()) return { ok: false, domains: [], error: 'agent mail tools are disabled' }
      const s = settings()
      const id = args.account || args.provider
      const accs = d.resolved().all.filter(a => (!id || a.id === id) && a.enabled && capabilities(a).includes('send') && !agentDenied(a, 'send', s))
      const out = []
      for (const acc of accs) {
        try {
          const p = acc.send.protocol === 'api' || acc.legacyProvider ? providerFor(acc) : null
          if (p && p.enabled() && typeof p.domains === 'function') out.push({ provider: acc.id, domains: await p.domains({}) })
          else if (acc.address) out.push({ provider: acc.id, domains: [{ name: acc.address, domain: acc.address.split('@')[1] || acc.address }] })
        } catch {}
      }
      return { ok: true, domains: out }
    },
  })

  // ── queue tools (unchanged) ───────────────────────────────────────────────
  reg({
    name: 'mail_list_queue',
    description: 'List the email queue: pending, sent, failed, and cancelled entries. Useful for tracking scheduled and mass-send status.',
    parameters: { status: { type: 'string', description: 'Optional filter: queued, scheduled, sent, failed, cancelled.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, entries: { type: 'json', required: true }, count: { type: 'integer', required: true } } },
      render: (_a, v) => TEXT(v.ok ? (v.count + ' queue entries\n' + v.entries.map(e => '  [' + e.status + '] ' + e.name + ' via ' + e.provider + (e.sentMessageId ? ' > ' + e.sentMessageId : '')).join('\n')) : 'Failed'),
    },
    async execute(args) {
      try {
        const entries = await d.queue.list()
        const filtered = args.status ? entries.filter(e => e.status === args.status) : entries
        return { ok: true, entries: filtered, count: filtered.length }
      } catch { return { ok: false, entries: [], count: 0 } }
    },
  })

  reg({
    name: 'mail_cancel',
    description: 'Cancel a queued or scheduled email. Cannot cancel an email that was already sent.',
    parameters: { id: { type: 'string', description: 'The queue entry ID to cancel.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, error: { type: 'string' } } },
      render: (_a, v) => TEXT(v.ok ? 'Cancelled' : 'Failed: ' + (v.error || 'unknown')),
    },
    async execute(args) {
      try { await d.queue.cancel(args.id, { by: 'agent' }); return { ok: true } } catch (e) { return { ok: false, error: String(e.message) } }
    },
  })

  // ── mailbox conversation tools (Tzekos Mail semantics; IMAP via the cache) ──
  const MB_SCHEMA = {
    type: 'object', additionalProperties: false,
    properties: { ok: { type: 'boolean', required: true }, text: { type: 'string', required: true }, count: { type: 'integer' }, drafted: { type: 'boolean' }, error: { type: 'string' } },
  }
  const mbOut = { schema: MB_SCHEMA, render: (_a, v) => TEXT(v.text || v.error || 'no result') }

  /** Which mailbox a conversation tool talks to: { acc, kind: 'tzekos'|'cache' } or { error }. */
  function mailbox(args, need = 'read') {
    if (toolsOff()) return { error: 'agent mail tools are disabled (agents.enabled: false)' }
    const s = settings()
    const r = d.resolved()
    let id = args.account || ''
    if (!id && args.threadId && String(args.threadId).includes('/')) {
      const pre = String(args.threadId).split('/')[0]
      if (r.all.some(a => a.id === pre)) id = pre
    }
    let acc = id ? r.all.find(a => a.id === id) : (r.all.find(a => a.id === 'tzmail' && receiveKind(a) === 'tzekos') || r.all.find(a => receiveKind(a) === 'tzekos' && !agentDenied(a, need, s)))
    if (!acc && !id) acc = r.all.find(a => ['imap', 'pop3'].includes(receiveKind(a)) && !agentDenied(a, need, s))
    if (!acc) return { error: id ? 'unknown account ' + id : 'mailbox not configured: add a Tzekos Mail or IMAP account, or write MAIL_AGENT_BASE_URL and MAIL_AGENT_TOKEN to the mailbox credentials file' }
    const denied = agentDenied(acc, need, s)
    if (denied) return { error: denied }
    const kind = receiveKind(acc)
    if (kind === 'tzekos') return { acc, kind: 'tzekos', cfg: tzCfgOf(acc) }
    if (kind === 'imap' || kind === 'pop3') return { acc, kind: 'cache' }
    return { error: 'account ' + acc.id + ' has no conversations' }
  }

  function threadKey(acc, tid) {
    const s = String(tid || '')
    return s.startsWith(acc.id + '/') ? s.slice(acc.id.length + 1) : s
  }

  async function viewFolder(acc, view) {
    if (receiveKind(acc) === 'pop3') return 'INBOX'
    const fl = await d.service.folders(acc)
    const role = { inbox: 'inbox', archive: 'archive', trash: 'trash', all: 'all', sent: 'sent' }[view || 'inbox'] || 'inbox'
    const hit = fl.find(f => f.role === role) || (role === 'all' ? fl.find(f => f.role === 'archive') : null)
    return hit ? hit.path : 'INBOX'
  }

  reg({
    name: 'mail_inbox',
    description: 'List conversations in a mailbox (unread count, latest sender, subject, preview). ' +
      'Call this first: it is the only way to learn the thread ids the other mailbox tools take. Defaults to the Tzekos Mail account; pass account for an IMAP account.',
    parameters: {
      view: { type: 'string', description: 'inbox | archive | trash | all. Default inbox.' },
      q: { type: 'string', description: 'Optional search text over subjects and bodies.' },
      limit: { type: 'integer', description: 'How many conversations (default 15, max 50).' },
      account: ACCOUNT_ARG,
    },
    output: mbOut,
    async execute(args) {
      const mb = mailbox(args)
      if (mb.error) return { ok: false, error: mb.error, text: 'Could not read the inbox: ' + mb.error }
      try {
        const limit = Math.min(50, Math.max(1, args.limit || 15))
        if (mb.kind === 'tzekos') {
          const res = await agentCall(mb.cfg, 'threads', { view: args.view || 'inbox', q: args.q || undefined, limit })
          const threads = res.threads || []
          return { ok: true, count: threads.length, text: formatThreads(threads, res.view || args.view || 'inbox') }
        }
        const folder = await viewFolder(mb.acc, args.view)
        const r = await d.service.list({ account: mb.acc.id, folder, q: args.q || '', limit })
        const threads = r.rows.map(t => ({ id: mb.acc.id + '/' + t.thread, unread_count: t.unread, last_from: t.from.address, subject: t.subject, message_count: t.count, last_message_at: iso(t.date) }))
        return { ok: true, count: threads.length, text: formatThreads(threads, args.view || 'inbox') }
      } catch (e) { return { ok: false, error: scrub(e), text: 'Mailbox unreachable: ' + scrub(e) } }
    },
  })

  reg({
    name: 'mail_thread',
    description: 'Read one conversation: every message body in order, plus any pending reminder.',
    parameters: {
      threadId: { type: 'string', description: 'Conversation id from mail_inbox.' },
      maxBodyChars: { type: 'integer', description: 'Per-message body cap. Default 4000.' },
      account: ACCOUNT_ARG,
    },
    output: mbOut,
    async execute(args) {
      const mb = mailbox(args)
      if (mb.error) return { ok: false, error: mb.error, text: 'Could not open the conversation: ' + mb.error }
      const cap = Math.min(maxBody(), Math.max(200, args.maxBodyChars || 4000))
      try {
        if (mb.kind === 'tzekos') {
          const res = await agentCall(mb.cfg, 'thread', { id: args.threadId })
          return { ok: true, text: formatThread(res, { maxBody: cap }) }
        }
        const t = d.service.cache.threadMessages(mb.acc.id, threadKey(mb.acc, args.threadId))
        if (!t.length) return { ok: false, error: 'not found', text: 'Conversation not found.' }
        const messages = []
        for (const m of t) {
          let body = m.body_text
          if (body == null) { try { body = (await d.service.message(makeId(mb.acc.id, m.folder, m.uid))).text } catch { body = m.snippet } }
          const out = /sent/i.test(m.folder)
          messages.push({ direction: out ? 'out' : 'in', from_addr: m.from_addr, to_addrs: m.to.map(a => a.address), text_body: body, received_at: iso(m.date) })
        }
        const detail = { thread: { id: mb.acc.id + '/' + t[0].thread, subject: t[t.length - 1].subject, participants: [...new Set(t.map(m => m.from_addr))] }, messages }
        return { ok: true, text: formatThread(detail, { maxBody: cap }) }
      } catch (e) { return { ok: false, error: scrub(e), text: 'Mailbox unreachable: ' + scrub(e) } }
    },
  })

  reg({
    name: 'mail_reply',
    description: 'Answer a conversation IN PLACE: same thread, same References chain, recipient taken from the thread. ' +
      'Without confirm:true it returns the draft only, which is the safe way to show a human what would be sent.',
    parameters: {
      threadId: { type: 'string', description: 'Conversation id to answer.' },
      text: { type: 'string', description: 'Reply body (plain text).' },
      confirm: { type: 'boolean', description: 'true actually sends. Omit to get the draft back.' },
      to: { type: 'string', description: 'Optional recipient override (defaults to the last inbound sender).' },
      account: ACCOUNT_ARG,
    },
    output: mbOut,
    async execute(args) {
      const mb = mailbox(args, args.confirm === true ? 'send' : 'read')
      if (mb.error) return { ok: false, error: mb.error, text: 'Reply failed: ' + mb.error }
      try {
        if (mb.kind === 'tzekos') {
          const res = await agentCall(mb.cfg, 'reply', { threadId: args.threadId, text: args.text, to: args.to || undefined, confirm: args.confirm === true })
          if (res.draft) return { ok: true, drafted: true, text: 'Draft (not sent) to ' + res.to + ', subject "' + res.subject + '":\n\n' + res.text + '\n\nRe-run with confirm:true to deliver it.' }
          return { ok: true, text: 'Sent. It is part of the same conversation (thread ' + (res.threadId || args.threadId) + ').' }
        }
        const acc = mb.acc
        const t = d.service.cache.threadMessages(acc.id, threadKey(acc, args.threadId))
        if (!t.length) return { ok: false, error: 'thread not found', text: 'Reply failed: thread not found' }
        const own = String(acc.address || '').toLowerCase()
        const lastIn = [...t].reverse().find(m => m.from_addr && m.from_addr !== own) || t[t.length - 1]
        const to = args.to || lastIn.from_addr
        const subject = /^\s*re:/i.test(lastIn.subject) ? lastIn.subject : 'Re: ' + (lastIn.subject || normSubject(lastIn.subject))
        const refs = [lastIn.refs, lastIn.msgid].filter(Boolean).join(' ')
        if (args.confirm !== true) return { ok: true, drafted: true, text: 'Draft (not sent) to ' + to + ', subject "' + subject + '":\n\n' + (args.text || '') + '\n\nRe-run with confirm:true to deliver it.' }
        if (agentDenied(acc, 'send', settings())) return { ok: false, error: agentDenied(acc, 'send', settings()), text: 'Reply failed: not permitted' }
        await deliver(acc, { to: [to], subject, text: args.text || '', inReplyTo: lastIn.msgid || '', references: refs })
        return { ok: true, text: 'Sent. It is part of the same conversation (thread ' + acc.id + '/' + lastIn.thread + ').' }
      } catch (e) { return { ok: false, error: scrub(e), text: 'Reply failed: ' + scrub(e) } }
    },
  })

  reg({
    name: 'mail_triage',
    description: 'File conversations: archive, trash, restore, inbox, read, unread, star, unstar. One id or a list.',
    parameters: {
      threadId: { type: 'string', description: 'One conversation id.' },
      ids: { type: 'json', description: 'Optional array of conversation ids.' },
      action: { type: 'string', description: 'archive | trash | restore | inbox | read | unread | star | unstar' },
      account: ACCOUNT_ARG,
    },
    output: mbOut,
    async execute(args) {
      const ids = Array.isArray(args.ids) && args.ids.length > 0 ? args.ids : [args.threadId].filter(Boolean)
      if (ids.length === 0) return { ok: false, error: 'no thread id', text: 'Give a threadId or ids.' }
      const mb = mailbox({ ...args, threadId: ids[0] })
      if (mb.error) return { ok: false, error: mb.error, text: 'Triage failed: ' + mb.error }
      const action = String(args.action || 'archive')
      try {
        if (mb.kind === 'tzekos') {
          const res = action === 'read' || action === 'unread'
            ? await agentCall(mb.cfg, 'mark', { ids, read: action === 'read' })
            : await agentCall(mb.cfg, 'move', { ids, move: action })
          return { ok: true, text: action + ': ' + (res.updated != null ? res.updated : ids.length) + ' conversation(s).' }
        }
        const acc = mb.acc
        let msgIds = []
        for (const id of ids) for (const m of d.service.cache.threadMessages(acc.id, threadKey(acc, id))) msgIds.push({ id: makeId(acc.id, m.folder, m.uid), folder: m.folder })
        if (!msgIds.length) return { ok: false, error: 'not found', text: 'Triage failed: conversation not found' }
        const op = { read: 'read', unread: 'unread', star: 'flag', unstar: 'unflag' }[action]
        if (op) await d.service.mark(msgIds.map(x => x.id), op)
        else {
          const to = { archive: 'archive', trash: 'trash', restore: 'inbox', inbox: 'inbox' }[action]
          if (!to) return { ok: false, error: 'unknown action', text: 'Unknown action ' + action }
          const sentPath = (await d.service.folders(acc)).filter(f => f.role === 'sent').map(f => f.path)
          await d.service.move(msgIds.filter(x => !sentPath.includes(x.folder)).map(x => x.id), to)
        }
        return { ok: true, text: action + ': ' + ids.length + ' conversation(s).' }
      } catch (e) { return { ok: false, error: scrub(e), text: 'Triage failed: ' + scrub(e) } }
    },
  })

  reg({
    name: 'mail_contacts',
    description: 'Look up the address book (email AND phone numbers), or save a contact so the composer and the SMS alerts know them. Tzekos Mail accounts only.',
    parameters: {
      q: { type: 'string', description: 'Search name, address or number.' },
      save: { type: 'json', description: 'Optional contact to save: { name, email, phone, notify_sms, star, company, notes }' },
      account: ACCOUNT_ARG,
    },
    output: mbOut,
    async execute(args) {
      const mb = mailbox(args)
      if (mb.error) return { ok: false, error: mb.error, text: 'Lookup failed: ' + mb.error }
      if (mb.kind !== 'tzekos') return { ok: false, error: 'contacts need a Tzekos Mail account', text: 'Contacts are only available for Tzekos Mail accounts.' }
      try {
        if (args.save && typeof args.save === 'object') {
          const res = await agentCall(mb.cfg, 'contact_save', args.save)
          const c = res.contact || {}
          return { ok: true, text: 'Saved contact ' + (c.name || c.email || c.phone) + '.' }
        }
        const res = await agentCall(mb.cfg, 'contacts', { q: args.q || undefined, limit: 50 })
        const list = res.contacts || []
        if (list.length === 0) return { ok: true, text: 'No matching contacts.' }
        return { ok: true, text: list.map(c => [c.name || '(no name)', c.email || '', c.phone || '', c.star ? 'VIP' : '', c.notify_sms ? 'SMS alerts' : ''].filter(Boolean).join(' · ')).join('\n') }
      } catch (e) { return { ok: false, error: scrub(e), text: 'Mailbox unreachable: ' + scrub(e) } }
    },
  })

  reg({
    name: 'mail_remind',
    description: 'Set a reminder on a conversation (a push notification at that time), or snooze it out of the inbox until then. Tzekos Mail accounts only.',
    parameters: {
      threadId: { type: 'string', description: 'Conversation id.' },
      preset: { type: 'string', description: '1h | tonight | tomorrow | weekend | nextweek' },
      at: { type: 'string', description: 'Or an ISO timestamp.' },
      note: { type: 'string', description: 'Optional note shown with the reminder.' },
      snooze: { type: 'boolean', description: 'true hides the conversation from the inbox until then.' },
      account: ACCOUNT_ARG,
    },
    output: mbOut,
    async execute(args) {
      const mb = mailbox(args)
      if (mb.error) return { ok: false, error: mb.error, text: 'Reminder failed: ' + mb.error }
      if (mb.kind !== 'tzekos') return { ok: false, error: 'reminders need a Tzekos Mail account', text: 'Reminders are only available for Tzekos Mail accounts.' }
      try {
        const res = await agentCall(mb.cfg, 'remind', { threadId: args.threadId, preset: args.preset || (args.at ? undefined : 'tomorrow'), at: args.at || undefined, note: args.note || undefined, snooze: args.snooze === true })
        const when = res.reminder && res.reminder.remind_at ? new Date(res.reminder.remind_at).toLocaleString() : 'the requested time'
        return { ok: true, text: (args.snooze ? 'Snoozed until ' : 'Reminder set for ') + when + '.' }
      } catch (e) { return { ok: false, error: scrub(e), text: 'Mailbox unreachable: ' + scrub(e) } }
    },
  })

  // ── new in v2 ─────────────────────────────────────────────────────────────
  reg({
    name: 'mail_accounts',
    description: 'List the mail accounts this agent may use: id, label, address, type, capabilities (read, send, folders, search), agent permissions and limits. Never shows secrets. Also reports agents.confirmMode and the default account.',
    parameters: {},
    output: genericOut,
    async execute() {
      if (toolsOff()) return { ok: false, error: 'agent mail tools are disabled' }
      const s = settings()
      const r = d.resolved()
      const list = r.all.filter(a => !agentDenied(a, 'any', s)).map(accountSummary)
      const mode = effectiveConfirmMode(s, r)
      const def = defaultAccountId(s, r)
      if (!list.length) return { ok: true, count: 0, text: 'no accounts configured (or none permitted for agents)', data: { accounts: [], confirmMode: mode.mode, default: def } }
      return {
        ok: true, count: list.length, data: { accounts: list, confirmMode: mode.mode, default: def },
        text: 'confirmMode: ' + mode.mode + (mode.mode === 'all' ? ' (sends are drafted first; confirm:true delivers)' : ' (mail_send delivers at once)') + '\ndefault account: ' + (def || '(none)') + '\n' +
          list.map(a => '- ' + a.id + (a.id === def ? ' (default)' : '') + ': ' + a.label + (a.address ? ' <' + a.address + '>' : '') + ' [' + a.type + '] can ' + a.capabilities.join(', ') +
            (a.agent.canSend ? '' : ' (agent send off)') + (a.legacy ? ' (from legacy settings)' : '')).join('\n'),
      }
    },
  })

  reg({
    name: 'mail_folders',
    description: 'List the folders of an account with unread and total counts (Inbox, Drafts, Sent, Archive, Junk, Trash and custom folders).',
    parameters: { account: ACCOUNT_ARG },
    output: genericOut,
    async execute(args) {
      const { acc, error } = pick(args, 'read', { preferRead: true })
      if (error) return { ok: false, error }
      try {
        const fl = await d.service.folders(acc)
        return { ok: true, count: fl.length, data: { account: acc.id, folders: fl }, text: acc.id + ' folders:\n' + fl.map(f => '- ' + f.path + (f.role ? ' (' + f.role + ')' : '') + (f.unseen ? ', ' + f.unseen + ' unread' : '') + (f.total != null ? ', ' + f.total + ' total' : '')).join('\n') }
      } catch (e) { return { ok: false, error: scrub(e) } }
    },
  })

  reg({
    name: 'mail_search',
    description: 'Search mail. query accepts free text plus from:, to:, subject:, is:unread, is:flagged, has:attachment, after:YYYY-MM-DD, before:YYYY-MM-DD. ' +
      'Searches the local cache and, for IMAP, the server folder. Returns message ids (for mail_fetch, mail_mark, mail_move), sender, subject, date, snippet and thread id.',
    parameters: {
      query: { type: 'string', description: 'Search query.' },
      account: ACCOUNT_ARG,
      folder: { type: 'string', description: 'Optional folder path (default Inbox for the server search; the cache search covers all cached folders when omitted).' },
      limit: { type: 'integer', description: 'Max results (default 20, max 50).' },
    },
    output: genericOut,
    async execute(args) {
      if (toolsOff()) return { ok: false, error: 'agent mail tools are disabled' }
      const s = settings()
      try {
        if (args.account) { const { error } = pick(args, 'read'); if (error) return { ok: false, error } }
        const r = await d.service.search({ account: args.account || '', folder: args.folder || '', query: args.query || '', limit: args.limit || 20 })
        const rows = r.rows.filter(x => { const a = d.resolved().all.find(y => y.id === x.account); return a && !agentDenied(a, 'read', s) })
        return {
          ok: true, count: rows.length, data: { results: rows, errors: r.errors },
          text: rows.length ? rows.map(x => (x.unread ? '[NEW] ' : '') + iso(x.date).slice(0, 16).replace('T', ' ') + '  ' + x.from + '  "' + x.subject + '"  id ' + x.id + '  thread ' + x.account + '/' + x.thread + (x.snippet ? '\n    ' + x.snippet.slice(0, 140) : '')).join('\n') : 'No results.' + (r.errors.length ? ' Errors: ' + r.errors.map(e => e.account + ': ' + e.error).join('; ') : ''),
        }
      } catch (e) { return { ok: false, error: scrub(e) } }
    },
  })

  function permittedIds(ids, need) {
    const s = settings()
    const r = d.resolved()
    for (const id of ids) {
      const ref = parseId(id)
      if (!ref) return 'invalid message id: ' + String(id).slice(0, 80)
      const acc = r.all.find(a => a.id === ref.account)
      const den = agentDenied(acc, need, s)
      if (den) return den
    }
    return null
  }
  const idsOf = args => (Array.isArray(args.ids) ? args.ids : typeof args.ids === 'string' ? args.ids.split(',') : []).concat(args.id ? [args.id] : []).map(x => String(x).trim()).filter(Boolean)

  reg({
    name: 'mail_mark',
    description: 'Mark messages read, unread, flagged or unflagged. ids are message ids from mail_read / mail_search (account:folder:uid).',
    parameters: {
      ids: { type: 'json', description: 'Array of message ids.' },
      action: { type: 'string', description: 'read | unread | flag | unflag' },
      account: ACCOUNT_ARG,
    },
    output: genericOut,
    async execute(args) {
      if (toolsOff()) return { ok: false, error: 'agent mail tools are disabled' }
      const ids = idsOf(args)
      if (!ids.length) return { ok: false, error: 'ids required' }
      const den = permittedIds(ids, 'read')
      if (den) return { ok: false, error: den }
      try { const r = await d.service.mark(ids, String(args.action || args.op || 'read')); return { ok: true, count: r.updated, text: (args.action || 'read') + ': ' + r.updated + ' message(s).' } }
      catch (e) { return { ok: false, error: scrub(e) } }
    },
  })

  reg({
    name: 'mail_move',
    description: 'Move messages to a folder: inbox, archive, trash, spam, or a folder path. Never deletes permanently. ids are message ids from mail_read / mail_search.',
    parameters: {
      ids: { type: 'json', description: 'Array of message ids.' },
      to: { type: 'string', description: 'inbox | archive | trash | spam | <folder path>' },
      account: ACCOUNT_ARG,
    },
    output: genericOut,
    async execute(args) {
      if (toolsOff()) return { ok: false, error: 'agent mail tools are disabled' }
      const ids = idsOf(args)
      if (!ids.length) return { ok: false, error: 'ids required' }
      const den = permittedIds(ids, 'read')
      if (den) return { ok: false, error: den }
      try { const r = await d.service.move(ids, args.to); return { ok: true, count: r.moved, text: 'Moved ' + r.moved + ' message(s) to ' + args.to + '.' } }
      catch (e) { return { ok: false, error: scrub(e) } }
    },
  })

  reg({
    name: 'mail_draft',
    description: 'Create, update, list, show or delete drafts. Never sends: deliver a draft with mail_send({ draftId, confirm:true }). Drafts are visible and sendable by the human in the Mail tab queue.',
    parameters: {
      action: { type: 'string', description: 'create | update | list | get | delete' },
      draftId: { type: 'string', description: 'Draft id for update, get and delete.' },
      account: ACCOUNT_ARG,
      to: { type: 'string', description: 'Recipients (comma-separated).' },
      cc: { type: 'string', description: 'Cc.' },
      bcc: { type: 'string', description: 'Bcc.' },
      subject: { type: 'string', description: 'Subject.' },
      text: { type: 'string', description: 'Plain-text body.' },
      html: { type: 'string', description: 'Optional HTML body.' },
      inReplyTo: { type: 'string', description: 'Optional Message-ID this draft answers.' },
      attachments: { type: 'json', description: 'Optional array of file paths.' },
    },
    output: genericOut,
    async execute(args) {
      if (toolsOff()) return { ok: false, error: 'agent mail tools are disabled' }
      const action = String(args.action || 'list')
      try {
        if (action === 'list') {
          const all = await d.drafts.list()
          return { ok: true, count: all.length, data: { drafts: all.map(x => ({ id: x.id, account: x.account, to: x.to, subject: x.subject, by: x.by, updatedAt: x.updatedAt })) }, text: all.length ? all.map(x => x.id + '  ' + x.account + '  to ' + x.to + '  "' + x.subject + '"').join('\n') : 'No drafts.' }
        }
        if (action === 'get') { const dr = await d.drafts.read(args.draftId); return dr ? { ok: true, draftId: dr.id, text: renderDraft(dr) } : { ok: false, error: 'no draft ' + args.draftId } }
        if (action === 'delete') { await d.drafts.remove(args.draftId); return { ok: true, text: 'Deleted ' + args.draftId } }
        if (action === 'create' || action === 'update') {
          const prev = action === 'update' ? await d.drafts.read(args.draftId) : null
          if (action === 'update' && !prev) return { ok: false, error: 'no draft ' + args.draftId }
          const { acc, error } = pick({ account: args.account || (prev && prev.account) }, 'send')
          if (error) return { ok: false, error }
          const merged = { ...(prev || {}) }
          for (const k of ['to', 'cc', 'bcc', 'subject', 'text', 'html', 'inReplyTo']) if (typeof args[k] === 'string') merged[k] = args[k]
          if (Array.isArray(args.attachments)) merged.attachments = args.attachments
          const dr = await d.drafts.save({ ...merged, id: prev ? prev.id : undefined, account: acc.id, by: 'agent' })
          return { ok: true, drafted: true, draftId: dr.id, text: renderDraft(dr) }
        }
        return { ok: false, error: 'action must be create, update, list, get or delete' }
      } catch (e) { return { ok: false, error: scrub(e) } }
    },
  })

  reg({
    name: 'mail_attachments',
    description: 'List the attachments of a message, or save one to disk (default directory: the plugin downloads folder per account). Returns file paths, never file contents.',
    parameters: {
      action: { type: 'string', description: 'list | save' },
      messageId: { type: 'string', description: 'Message id (account:folder:uid).' },
      part: { type: 'integer', description: 'Attachment index from list (for save).' },
      destDir: { type: 'string', description: 'Optional destination directory for save.' },
    },
    output: genericOut,
    async execute(args) {
      if (toolsOff()) return { ok: false, error: 'agent mail tools are disabled' }
      const den = permittedIds([args.messageId], 'read')
      if (den) return { ok: false, error: den }
      try {
        if ((args.action || 'list') === 'list') {
          const m = await d.service.message(args.messageId)
          return { ok: true, count: m.attachments.length, data: { attachments: m.attachments }, text: m.attachments.length ? m.attachments.map(a => a.part + ': ' + a.filename + ' (' + a.contentType + ', ' + a.size + ' bytes)').join('\n') : 'No attachments.' }
        }
        const a = await d.service.attachment(args.messageId, args.part)
        const ref = parseId(args.messageId)
        const dir = args.destDir || join(d.dataDir, 'downloads', ref.account)
        await fsP.mkdir(dir, { recursive: true, mode: 0o700 })
        let path = join(dir, safeName(a.filename))
        for (let i = 1; i < 100; i++) { try { await fsP.access(path); path = join(dir, i + '-' + safeName(a.filename)) } catch { break } }
        await fsP.writeFile(path, a.content, { mode: 0o600 })
        return { ok: true, text: 'Saved ' + path + ' (' + a.content.length + ' bytes)', data: { path, size: a.content.length } }
      } catch (e) { return { ok: false, error: scrub(e) } }
    },
  })
}
