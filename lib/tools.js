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
import { agentDenied, accountSummary, capabilities, defaultAccountId, effectiveConfirmMode, effectiveFirstContact } from './accounts.js'
import { runMassSend, parseUnsubscribe, domainOf } from './outbound.js'
import { renderBody } from './compose.js'
import { LANGS, normList, bare } from './unsub.js'
import { parseId, receiveKind, providerFor, makeId, safeName } from './service.js'
import { parseCSV, personalise } from './staging.js'
import { loadAttachments, addrList } from './smtp.js'
import { normSubject } from './cache.js'
import { E, toolFail, classify } from './errors.js'

const TEXT = s => [{ type: 'text', text: s }]
// Structured error fields (lib/errors.js) added to every failed result; output schemas are strict.
const ERR_PROPS = { code: { type: 'string' }, message: { type: 'string' }, hint: { type: 'string' }, docs: { type: 'string' }, oauthCode: { type: 'string' } }
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
    retryAfterSec: { type: 'integer' },
    ...ERR_PROPS,
  },
}
const genericOut = { schema: GENERIC, render: (_a, v) => TEXT(v.text || v.error || (v.ok ? 'ok' : 'failed')) }
// mail_doctor: the doctor report (lib/doctor.js), declared field by field because output schemas are strict.
const DOCTOR_OUT = {
  type: 'object', additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    plugin: { type: 'string' },
    version: { type: 'string' },
    status: { type: 'string' },
    host: { type: 'json' },
    checks: { type: 'json' },
    docs: { type: 'string' },
    generatedAt: { type: 'string' },
    text: { type: 'string' },
    error: { type: 'string' },
    ...ERR_PROPS,
  },
}
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
  /** Failed tool result: the old text stays in `error`, the code, hint and docs are added. */
  const fail = (code, message, extra) => E.tool(code, { message, ...extra })
  const failFrom = (e, fallback, extra) => toolFail(e, fallback, scrub, extra)

  /** A pick()/mailbox() refusal: the old text in `error`, the tool result (with code) in `fail`. */
  const refuse = (code, message) => ({ error: message, fail: fail(code, message) })

  /** Resolve the account a tool works on; returns { acc } or { error, fail }. */
  function pick(args, need, { preferRead = false } = {}) {
    if (toolsOff()) return refuse('MAIL_TOOLS_DISABLED', 'agent mail tools are disabled (agents.enabled: false)')
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
    if (!r.all.length) return refuse('MAIL_NO_ACCOUNTS', 'no accounts configured')
    if (!id) return refuse('MAIL_NO_ACCOUNTS', 'no accounts configured')
    const acc = r.all.find(a => a.id === id)
    if (!acc) return refuse('MAIL_ACCOUNT_NOT_FOUND', 'provider ' + id + ' is not configured')
    const denied = agentDenied(acc, need, s)
    if (denied) return refuse(classify(new Error(denied)).code, denied)
    return { acc }
  }

  function confirmMode() { return effectiveConfirmMode(settings(), d.resolved()).mode }

  function renderDraft(dr) {
    return 'DRAFT (not sent) ' + dr.id + ' via ' + dr.account + '\nFrom: ' + (dr.from || '(account default)') + '\nTo: ' + dr.to +
      (dr.cc ? '\nCc: ' + dr.cc : '') + (dr.bcc ? '\nBcc: ' + dr.bcc : '') + '\nSubject: ' + dr.subject +
      (dr.attachments && dr.attachments.length ? '\nAttachments: ' + dr.attachments.join(', ') : '') + '\n\n' + clipText(dr.text, 4000)
  }

  async function deliver(acc, msg) {
    const files = msg.attachments && msg.attachments.length ? await loadAttachments(msg.attachments) : []
    const fwd = msg.forwardOf && msg.forwardAttachments ? await d.service.forwardAttachments(msg.forwardOf) : []
    const attachments = files.length || fwd.length ? [...files, ...fwd] : undefined
    const sig = acc.signature && msg.text && !msg.noSignature ? '\n\n' + acc.signature : ''
    return d.service.send(acc, { ...msg, text: (msg.text || '') + sig, attachments }, { actor: 'agent' })
  }

  /** Recipient domains this account never wrote to or heard from (agents.firstContactConfirm). */
  function newDomains(acc, msg) {
    if (!effectiveFirstContact(settings(), d.resolved()).on) return []
    const all = [...addrList(msg.to), ...addrList(msg.cc), ...addrList(msg.bcc)].map(domainOf).filter(Boolean)
    return [...new Set(all)].filter(x => !d.service.knownDomain(acc, x))
  }

  /** Shared draft-first gate for mail_send and mail_forward. Returns a tool result to return, or null to send. */
  async function gate(acc, msg, args, extra = {}) {
    const fresh = args.confirm === true ? [] : newDomains(acc, msg)
    if (confirmMode() === 'all' && args.confirm !== true) {
      const dr = await d.drafts.save({ ...msg, ...extra, account: acc.id, by: 'agent' })
      return { ok: true, drafted: true, draftId: dr.id, account: acc.id, provider: acc.id, text: renderDraft(dr) + '\n\nNothing was sent. Show this to the user; deliver with mail_send({ draftId: "' + dr.id + '", confirm: true }).' }
    }
    if (fresh.length) {
      const dr = await d.drafts.save({ ...msg, ...extra, account: acc.id, by: 'agent' })
      return { ok: true, drafted: true, draftId: dr.id, account: acc.id, provider: acc.id, text: renderDraft(dr) + '\n\nFirst message from ' + acc.id + ' to ' + fresh.join(', ') + ': nothing was sent. Confirm with the user, then mail_send({ draftId: "' + dr.id + '", confirm: true }).' }
    }
    return null
  }

  const rateFail = e => failFrom(e, 'MAIL_SEND_FAILED')

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
      format: { type: 'string', description: 'plain (default) or markdown: with markdown the text is rendered to a sanitised HTML part too.' },
      draftId: { type: 'string', description: 'Deliver (with confirm:true) or show a draft created earlier.' },
      confirm: { type: 'boolean', description: 'true delivers. Without it the draft is returned when confirmation is required.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true }, messageId: { type: 'string' }, from: { type: 'string' }, provider: { type: 'string' },
          account: { type: 'string' }, drafted: { type: 'boolean' }, draftId: { type: 'string' }, text: { type: 'string' }, error: { type: 'string' }, data: { type: 'json' }, retryAfterSec: { type: 'integer' }, ...ERR_PROPS,
        },
      },
      render: (_a, v) => TEXT(v.drafted ? v.text : v.ok ? 'Sent via ' + v.provider + ': message ID ' + v.messageId : 'Send failed: ' + (v.error || 'unknown')),
    },
    async execute(args) {
      try {
        let src = args
        if (args.draftId) {
          const dr = await d.drafts.read(args.draftId)
          if (!dr) return fail('MAIL_OBJECT_NOT_FOUND', 'no draft ' + args.draftId)
          src = { ...dr, account: dr.account, attachments: dr.attachments }
          if (args.confirm !== true) return { ok: true, drafted: true, draftId: dr.id, text: renderDraft(dr) + '\n\nRe-run mail_send with { draftId: "' + dr.id + '", confirm: true } to deliver it.' }
        }
        const { acc, fail: refusal } = pick(src, 'send')
        if (refusal) return refusal
        const body = renderBody({ format: src.format === 'markdown' ? 'markdown' : 'plain', text: src.text || '', html: src.html || '' })
        const msg = {
          from: src.from || '', to: src.to || '', cc: src.cc || '', bcc: src.bcc || '', subject: src.subject || '', text: body.text,
          html: body.html, replyTo: src.replyTo || '', inReplyTo: src.inReplyTo || '', references: src.references || '',
          attachments: Array.isArray(src.attachments) ? src.attachments : [],
        }
        if (!args.draftId) { const held = await gate(acc, msg, args); if (held) return held }
        const to = addrList(msg.to)
        const r = await deliver(acc, { ...msg, to, cc: addrList(msg.cc), bcc: addrList(msg.bcc), forwardOf: src.forwardOf || '', forwardAttachments: !!src.forwardAttachments })
        if (args.draftId) {
          // Also drop our copy in the IMAP Drafts folder, so nobody sends it a second time from there.
          const dr = await d.drafts.read(args.draftId).catch(() => null)
          if (dr && dr.remote) await d.service.deleteDraftRemote(acc, dr).catch(() => {})
          await d.drafts.remove(args.draftId).catch(() => {})
        }
        return { ok: true, messageId: String(r.messageId || ''), from: String(r.from || ''), provider: acc.id, account: acc.id }
      } catch (e) { return rateFail(e) }
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
      unsubscribe: { type: 'string', description: 'Optional custom unsubscribe target ("mailto:..." and/or "https://...", {email} placeholders allowed). By default the built-in unsubscribe adds a per-recipient mailto and one-click link, a footer, and processes the replies. Above 50 recipients an unsubscribe is required.' },
      list: { type: 'string', description: 'Mailing list name (e.g. "newsletter"): unsubscribes apply to this list; default: this campaign only.' },
      language: { type: 'string', description: 'Footer and unsubscribe page language: en, it or el.' },
      footer: { type: 'boolean', description: 'Append the unsubscribe footer (default true).' },
      dryRun: { type: 'boolean', description: 'Only preview: the first 3 rendered messages, suppressed addresses and the rate-limit budget. Sends nothing.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true }, sent: { type: 'integer' }, failed: { type: 'integer' }, total: { type: 'integer' }, suppressed: { type: 'integer' },
          stopped: { type: 'string' }, queueId: { type: 'string' }, error: { type: 'string' }, preview: { type: 'json' }, text: { type: 'string' }, campaignId: { type: 'string' }, list: { type: 'string' }, retryAfterSec: { type: 'integer' }, ...ERR_PROPS,
        },
      },
      render: (_a, v) => TEXT(v.preview ? v.text
        : v.ok ? (v.queueId ? 'Queued ' + v.total + ' emails (id ' + v.queueId + ') for review in the Mail tab' : 'Sent ' + v.sent + '/' + v.total + (v.failed ? ', ' + v.failed + ' failed' : '') + (v.suppressed ? ', ' + v.suppressed + ' suppressed' : '') + (v.stopped ? '. Stopped: ' + v.stopped : ''))
          : 'Mass send failed: ' + (v.error || 'unknown')),
    },
    async execute(args) {
      const s = settings()
      try {
        const { acc, fail: refusal } = pick(args, 'send')
        if (refusal) return refusal
        const rows = parseCSV(args.csv, s.maxCsvRows)
        if (!rows.length) return fail('MAIL_INVALID_INPUT', 'CSV has no data rows')
        if (rows.length > s.maxRecipients) return fail('MAIL_TOO_MANY_RECIPIENTS', 'too many recipients: ' + rows.length + ' > maxRecipients ' + s.maxRecipients)
        const delayMs = Math.min(s.maxDelayMs, Math.max(s.minDelayMs, args.delayMs == null ? 1000 : Number(args.delayMs) || 0))
        if (args.unsubscribe) parseUnsubscribe(args.unsubscribe) // validate early
        const language = LANGS.includes(args.language) ? args.language : ''
        const job = { rows, subjectTemplate: args.subjectTemplate, textTemplate: args.textTemplate, from: args.from || '', replyTo: args.replyTo, delayMs, unsubscribe: args.unsubscribe || '', list: args.list ? normList(args.list) : '', language, footer: args.footer !== false }
        const deps = { service: d.service, state: d.outbound, suppression: d.suppression, settings: s, canSetHeaders: d.service.canSetHeaders(acc), actor: 'agent', unsub: d.unsub ? d.unsub() : null }
        if (args.dryRun) {
          const r = await runMassSend(acc, { ...job, dryRun: true }, deps)
          const text = 'DRY RUN (nothing sent): ' + r.sendable + ' of ' + r.total + ' would be sent, ' + r.suppressed + ' suppressed, ' + r.missingAddress + ' without address. ' +
            'Budget: ' + (r.limits.perMinute == null ? 'no per-minute limit' : r.limits.perMinute + ' left this minute') + ', ' + (r.limits.perDay == null ? 'no daily limit' : r.limits.perDay + ' left today') + ', about ' + r.limits.estimatedMinutes + ' min.\n\n' +
            r.preview.map(m => 'To: ' + m.to + '\nSubject: ' + m.subject + '\n' + Object.entries(m.headers).map(([k, v]) => k + ': ' + v).join('\n') + '\n\n' + m.text.slice(0, 600)).join('\n\n---\n\n')
          return { ok: true, total: r.total, suppressed: r.suppressed, preview: r, text }
        }
        // Validate unsubscribe requirements before staging, so a queued batch can actually run.
        await runMassSend(acc, { ...job, dryRun: true }, deps)
        const canMassNow = !agentDenied(acc, 'mass', s)
        const stage = args.queueOnly || !canMassNow || (confirmMode() === 'all' && args.confirm !== true)
        if (stage) {
          const entry = await d.queue.create({
            name: 'mass-send-' + Date.now(), provider: acc.id,
            msg: { from: args.from || acc.defaultFrom || s.defaultFrom, to: '', subject: args.subjectTemplate, text: args.textTemplate, replyTo: args.replyTo },
            csvData: { rows, columns: Object.keys(rows[0]) }, delayMs, unsubscribe: args.unsubscribe || '', list: job.list, language, requestedBy: 'agent',
          })
          return { ok: true, total: rows.length, queueId: entry.id, sent: 0, failed: 0 }
        }
        const r = await runMassSend(acc, job, deps)
        d.audit({ actor: 'agent', action: 'mass_send', account: acc.id, recipients: r.total, subject: args.subjectTemplate, ok: !r.stopped, count: r.sent, note: r.stopped })
        return { ok: true, sent: r.sent, failed: r.failed, total: r.total, suppressed: r.suppressed, stopped: r.stopped || undefined, campaignId: r.campaignId || undefined, list: r.list || undefined }
      } catch (e) { return failFrom(e, 'MAIL_SEND_FAILED') }
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
        properties: { ok: { type: 'boolean', required: true }, queueId: { type: 'string' }, status: { type: 'string' }, error: { type: 'string' }, ...ERR_PROPS },
      },
      render: (_a, v) => TEXT(v.ok ? 'Email ' + v.status + ' (id ' + v.queueId + ')' : 'Failed: ' + (v.error || 'unknown')),
    },
    async execute(args) {
      const s = settings()
      try {
        const { acc, fail: refusal } = pick(args, 'send')
        if (refusal) return refusal
        let sendAt = null
        if (!args.queue && args.sendAt) {
          const ts = Date.parse(args.sendAt)
          if (!Number.isFinite(ts)) return fail('MAIL_INVALID_INPUT', 'invalid sendAt: must be ISO 8601')
          sendAt = Math.round(ts / 1000)
        }
        const hold = confirmMode() === 'all' && args.confirm !== true
        const entry = await d.queue.create({
          name: 'email-' + Date.now(), provider: acc.id,
          msg: { from: args.from || acc.defaultFrom || s.defaultFrom, to: args.to, subject: args.subject, text: args.text, html: args.html, replyTo: args.replyTo },
          sendAt: hold ? null : sendAt, requestedSendAt: hold ? sendAt : null, requestedBy: 'agent',
        })
        return { ok: true, queueId: entry.id, status: hold ? 'queued for approval' : entry.status }
      } catch (e) { return failFrom(e, 'MAIL_INTERNAL') }
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
        properties: { ok: { type: 'boolean', required: true }, messages: { type: 'json', required: true }, count: { type: 'integer', required: true }, provider: { type: 'string', required: true }, error: { type: 'string' }, ...ERR_PROPS },
      },
      render: (_a, v) => TEXT(v.ok
        ? (v.count + ' message(s) from ' + v.provider + (v.messages.length ? '\n' + v.messages.map(m => '  [' + (m.inbound ? 'IN' : 'OUT') + (m.unread ? ' NEW' : '') + '] ' + m.from + ' > ' + m.subject + '  id ' + m.messageId).join('\n') : ''))
        : 'Read failed: ' + (v.error || 'unknown')),
    },
    async execute(args) {
      const { acc, fail: refusal } = pick(args, 'read', { preferRead: true })
      const pid = acc ? acc.id : (args.account || args.provider || '')
      if (refusal) return { ...refusal, messages: [], count: 0, provider: pid }
      try {
        const limit = Math.min(100, Math.max(1, args.limit || 20))
        const kind = receiveKind(acc)
        let messages = []
        if (kind === 'imap' || kind === 'pop3' || kind === 'inbound') {
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
          if (!p || !p.enabled()) return { ...fail('MAIL_ACCOUNT_NOT_FOUND', 'provider ' + acc.id + ' is not configured'), messages: [], count: 0, provider: acc.id }
          messages = await p.recent({}, limit)
        } else return { ...fail('MAIL_CAPABILITY_UNSUPPORTED', 'provider ' + acc.id + ' does not support inbox reading'), messages: [], count: 0, provider: acc.id }
        if (args.domain) { const x = args.domain.toLowerCase(); messages = messages.filter(m => (m.from || '').toLowerCase().includes(x) || (m.to || '').toLowerCase().includes(x)) }
        if (args.address) { const x = args.address.toLowerCase(); messages = messages.filter(m => (m.from || '').toLowerCase().includes(x) || (m.to || '').toLowerCase().includes(x)) }
        messages = messages.slice(0, limit)
        return { ok: true, messages, count: messages.length, provider: acc.id }
      } catch (e) { return { ...failFrom(e, 'MAIL_MAILBOX_UNREACHABLE'), messages: [], count: 0, provider: acc.id } }
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
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, error: { type: 'string' }, ...ERR_PROPS, message: { type: 'json' } } }, // message: the fetched message on success, the error text on failure
      render: (_a, v) => TEXT(v.ok
        ? ('From: ' + (v.message.from || '?') + '\nSubject: ' + (v.message.subject || '?') + '\n\n' + (v.message.text || ''))
        : 'Fetch failed: ' + (v.error || 'unknown')),
    },
    async execute(args) {
      try {
        const ref = parseId(args.messageId)
        const r = d.resolved()
        const viaId = ref && r.all.some(a => a.id === ref.account) ? ref.account : ''
        const { acc, fail: refusal } = pick({ account: args.account || args.provider || viaId }, 'read', { preferRead: true })
        if (refusal) return refusal
        const kind = receiveKind(acc)
        if ((kind === 'imap' || kind === 'pop3' || kind === 'inbound') && ref) {
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
        if (!p || !p.enabled()) return fail('MAIL_ACCOUNT_NOT_FOUND', 'provider not configured')
        if (typeof p.fetch !== 'function') return fail('MAIL_CAPABILITY_UNSUPPORTED', 'provider does not support message fetch')
        const m = await p.fetch({}, ref ? ref.uid : args.messageId)
        return { ok: true, message: { ...m, text: clipText(m.text, maxBody()) } }
      } catch (e) { return failFrom(e, 'MAIL_MAILBOX_UNREACHABLE') }
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
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, domains: { type: 'json', required: true }, error: { type: 'string' }, ...ERR_PROPS } },
      render: (_a, v) => TEXT(v.ok ? (v.domains.map(x => x.provider + ': ' + x.domains.map(dd => dd.domain || dd.name).join(', ')).join('\n') || 'No domains found') : 'Failed: ' + (v.error || 'unknown')),
    },
    async execute(args) {
      if (toolsOff()) return { ...fail('MAIL_TOOLS_DISABLED', 'agent mail tools are disabled'), domains: [] }
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
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, entries: { type: 'json', required: true }, count: { type: 'integer', required: true }, error: { type: 'string' }, ...ERR_PROPS } },
      render: (_a, v) => TEXT(v.ok ? (v.count + ' queue entries\n' + v.entries.map(e => '  [' + e.status + '] ' + e.name + ' via ' + e.provider + (e.sentMessageId ? ' > ' + e.sentMessageId : '')).join('\n')) : 'Failed'),
    },
    async execute(args) {
      try {
        const entries = await d.queue.list()
        const filtered = args.status ? entries.filter(e => e.status === args.status) : entries
        return { ok: true, entries: filtered, count: filtered.length }
      } catch (e) { return { ...failFrom(e, 'MAIL_INTERNAL'), entries: [], count: 0 } }
    },
  })

  reg({
    name: 'mail_cancel',
    description: 'Cancel a queued or scheduled email. Cannot cancel an email that was already sent.',
    parameters: { id: { type: 'string', description: 'The queue entry ID to cancel.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, error: { type: 'string' }, ...ERR_PROPS } },
      render: (_a, v) => TEXT(v.ok ? 'Cancelled' : 'Failed: ' + (v.error || 'unknown')),
    },
    async execute(args) {
      try { await d.queue.cancel(args.id, { by: 'agent' }); return { ok: true } } catch (e) { return failFrom(e, 'MAIL_INTERNAL') }
    },
  })

  // ── mailbox conversation tools (Tzekos Mail semantics; IMAP via the cache) ──
  const MB_SCHEMA = {
    type: 'object', additionalProperties: false,
    properties: { ok: { type: 'boolean', required: true }, text: { type: 'string', required: true }, count: { type: 'integer' }, drafted: { type: 'boolean' }, error: { type: 'string' }, ...ERR_PROPS },
  }
  const mbOut = { schema: MB_SCHEMA, render: (_a, v) => TEXT(v.text || v.error || 'no result') }

  /** Which mailbox a conversation tool talks to: { acc, kind: 'tzekos'|'cache' } or { error }. */
  function mailbox(args, need = 'read') {
    if (toolsOff()) return refuse('MAIL_TOOLS_DISABLED', 'agent mail tools are disabled (agents.enabled: false)')
    const s = settings()
    const r = d.resolved()
    let id = args.account || ''
    if (!id && args.threadId && String(args.threadId).includes('/')) {
      const pre = String(args.threadId).split('/')[0]
      if (r.all.some(a => a.id === pre)) id = pre
    }
    let acc = id ? r.all.find(a => a.id === id) : (r.all.find(a => a.id === 'tzmail' && receiveKind(a) === 'tzekos') || r.all.find(a => receiveKind(a) === 'tzekos' && !agentDenied(a, need, s)))
    if (!acc && !id) acc = r.all.find(a => ['imap', 'pop3'].includes(receiveKind(a)) && !agentDenied(a, need, s))
    if (!acc) return id ? refuse('MAIL_ACCOUNT_NOT_FOUND', 'unknown account ' + id) : refuse('MAIL_NO_ACCOUNTS', 'mailbox not configured: add a Tzekos Mail or IMAP account, or write MAIL_AGENT_BASE_URL and MAIL_AGENT_TOKEN to the mailbox credentials file')
    const denied = agentDenied(acc, need, s)
    if (denied) return refuse(classify(new Error(denied)).code, denied)
    const kind = receiveKind(acc)
    if (kind === 'tzekos') return { acc, kind: 'tzekos', cfg: tzCfgOf(acc) }
    if (kind === 'imap' || kind === 'pop3' || kind === 'inbound') return { acc, kind: 'cache' }
    return refuse('MAIL_CAPABILITY_UNSUPPORTED', 'account ' + acc.id + ' has no conversations')
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
      if (mb.error) return { ...mb.fail, text: 'Could not read the inbox: ' + mb.error }
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
      } catch (e) { return { ...failFrom(e, 'MAIL_MAILBOX_UNREACHABLE'), text: 'Mailbox unreachable: ' + scrub(e) } }
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
      if (mb.error) return { ...mb.fail, text: 'Could not open the conversation: ' + mb.error }
      const cap = Math.min(maxBody(), Math.max(200, args.maxBodyChars || 4000))
      try {
        if (mb.kind === 'tzekos') {
          const res = await agentCall(mb.cfg, 'thread', { id: args.threadId })
          return { ok: true, text: formatThread(res, { maxBody: cap }) }
        }
        const t = d.service.cache.threadMessages(mb.acc.id, threadKey(mb.acc, args.threadId))
        if (!t.length) return { ...fail('MAIL_OBJECT_NOT_FOUND', 'not found'), text: 'Conversation not found.' }
        const messages = []
        for (const m of t) {
          let body = m.body_text
          if (body == null) { try { body = (await d.service.message(makeId(mb.acc.id, m.folder, m.uid))).text } catch { body = m.snippet } }
          const out = /sent/i.test(m.folder)
          messages.push({ direction: out ? 'out' : 'in', from_addr: m.from_addr, to_addrs: m.to.map(a => a.address), text_body: body, received_at: iso(m.date) })
        }
        const detail = { thread: { id: mb.acc.id + '/' + t[0].thread, subject: t[t.length - 1].subject, participants: [...new Set(t.map(m => m.from_addr))] }, messages }
        return { ok: true, text: formatThread(detail, { maxBody: cap }) }
      } catch (e) { return { ...failFrom(e, 'MAIL_MAILBOX_UNREACHABLE'), text: 'Mailbox unreachable: ' + scrub(e) } }
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
      if (mb.error) return { ...mb.fail, text: 'Reply failed: ' + mb.error }
      try {
        if (mb.kind === 'tzekos') {
          const res = await agentCall(mb.cfg, 'reply', { threadId: args.threadId, text: args.text, to: args.to || undefined, confirm: args.confirm === true })
          if (res.draft) return { ok: true, drafted: true, text: 'Draft (not sent) to ' + res.to + ', subject "' + res.subject + '":\n\n' + res.text + '\n\nRe-run with confirm:true to deliver it.' }
          return { ok: true, text: 'Sent. It is part of the same conversation (thread ' + (res.threadId || args.threadId) + ').' }
        }
        const acc = mb.acc
        const t = d.service.cache.threadMessages(acc.id, threadKey(acc, args.threadId))
        if (!t.length) return { ...fail('MAIL_OBJECT_NOT_FOUND', 'thread not found'), text: 'Reply failed: thread not found' }
        const own = String(acc.address || '').toLowerCase()
        const lastIn = [...t].reverse().find(m => m.from_addr && m.from_addr !== own) || t[t.length - 1]
        const to = args.to || lastIn.from_addr
        const subject = /^\s*re:/i.test(lastIn.subject) ? lastIn.subject : 'Re: ' + (lastIn.subject || normSubject(lastIn.subject))
        const refs = [lastIn.refs, lastIn.msgid].filter(Boolean).join(' ')
        if (args.confirm !== true) return { ok: true, drafted: true, text: 'Draft (not sent) to ' + to + ', subject "' + subject + '":\n\n' + (args.text || '') + '\n\nRe-run with confirm:true to deliver it.' }
        if (agentDenied(acc, 'send', settings())) { const den = agentDenied(acc, 'send', settings()); return { ...fail(classify(new Error(den)).code, den), text: 'Reply failed: not permitted' } }
        await deliver(acc, { to: [to], subject, text: args.text || '', inReplyTo: lastIn.msgid || '', references: refs })
        return { ok: true, text: 'Sent. It is part of the same conversation (thread ' + acc.id + '/' + lastIn.thread + ').' }
      } catch (e) { return { ...failFrom(e, 'MAIL_SEND_FAILED'), text: 'Reply failed: ' + scrub(e) } }
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
      if (ids.length === 0) return { ...fail('MAIL_INVALID_INPUT', 'no thread id'), text: 'Give a threadId or ids.' }
      const mb = mailbox({ ...args, threadId: ids[0] })
      if (mb.error) return { ...mb.fail, text: 'Triage failed: ' + mb.error }
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
        if (!msgIds.length) return { ...fail('MAIL_OBJECT_NOT_FOUND', 'not found'), text: 'Triage failed: conversation not found' }
        const op = { read: 'read', unread: 'unread', star: 'flag', unstar: 'unflag' }[action]
        if (op) await d.service.mark(msgIds.map(x => x.id), op)
        else {
          const to = { archive: 'archive', trash: 'trash', restore: 'inbox', inbox: 'inbox' }[action]
          if (!to) return { ...fail('MAIL_INVALID_INPUT', 'unknown action'), text: 'Unknown action ' + action }
          const sentPath = (await d.service.folders(acc)).filter(f => f.role === 'sent').map(f => f.path)
          await d.service.move(msgIds.filter(x => !sentPath.includes(x.folder)).map(x => x.id), to)
        }
        return { ok: true, text: action + ': ' + ids.length + ' conversation(s).' }
      } catch (e) { return { ...failFrom(e, 'MAIL_MAILBOX_UNREACHABLE'), text: 'Triage failed: ' + scrub(e) } }
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
      if (mb.error) return { ...mb.fail, text: 'Lookup failed: ' + mb.error }
      if (mb.kind !== 'tzekos') return { ...fail('MAIL_CAPABILITY_UNSUPPORTED', 'contacts need a Tzekos Mail account'), text: 'Contacts are only available for Tzekos Mail accounts.' }
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
      } catch (e) { return { ...failFrom(e, 'MAIL_MAILBOX_UNREACHABLE'), text: 'Mailbox unreachable: ' + scrub(e) } }
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
      if (mb.error) return { ...mb.fail, text: 'Reminder failed: ' + mb.error }
      if (mb.kind !== 'tzekos') return { ...fail('MAIL_CAPABILITY_UNSUPPORTED', 'reminders need a Tzekos Mail account'), text: 'Reminders are only available for Tzekos Mail accounts.' }
      try {
        const res = await agentCall(mb.cfg, 'remind', { threadId: args.threadId, preset: args.preset || (args.at ? undefined : 'tomorrow'), at: args.at || undefined, note: args.note || undefined, snooze: args.snooze === true })
        const when = res.reminder && res.reminder.remind_at ? new Date(res.reminder.remind_at).toLocaleString() : 'the requested time'
        return { ok: true, text: (args.snooze ? 'Snoozed until ' : 'Reminder set for ') + when + '.' }
      } catch (e) { return { ...failFrom(e, 'MAIL_MAILBOX_UNREACHABLE'), text: 'Mailbox unreachable: ' + scrub(e) } }
    },
  })

  // ── new in v2 ─────────────────────────────────────────────────────────────
  reg({
    name: 'mail_accounts',
    description: 'List the mail accounts this agent may use: id, label, address, type, capabilities (read, send, folders, search), agent permissions and limits. Never shows secrets. Also reports agents.confirmMode and the default account.',
    parameters: {},
    output: genericOut,
    async execute() {
      if (toolsOff()) return fail('MAIL_TOOLS_DISABLED', 'agent mail tools are disabled')
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
    name: 'mail_doctor',
    description: 'Read-only self-check of the mail plugin: settings mode, accounts (id and type only), secrets present (booleans), OAuth reconnect flags, last sync status, cache, file permissions, unsubscribe and IDLE configuration, queue counts. Offline, never connects to a mail server, never shows a secret. Every row that is not ok carries a MAIL_* code, a hint and a docs anchor. Use it first when a mail tool or the Mail tab misbehaves.',
    parameters: {},
    output: {
      schema: DOCTOR_OUT,
      render: (_a, v) => TEXT(v.text || v.error || (v.ok ? 'ok' : 'failed')),
    },
    async execute() {
      try {
        const r = await d.doctor()
        const lines = r.checks.map(c => c.status.toUpperCase().padEnd(4) + ' ' + c.id + (c.code ? ' [' + c.code + ']' : '') + (c.detail ? ': ' + c.detail : ''))
        return { ok: true, plugin: r.plugin, version: r.version, status: r.status, host: r.host, checks: r.checks, docs: r.docs, generatedAt: r.generatedAt, text: 'dsh-mail doctor: ' + r.status + '\n' + lines.join('\n') }
      } catch (e) { return failFrom(e, 'MAIL_INTERNAL') }
    },
  })

  reg({
    name: 'mail_folders',
    description: 'List the folders of an account with unread and total counts (Inbox, Drafts, Sent, Archive, Junk, Trash and custom folders). create and rename need the account permission canManageFolders.',
    parameters: {
      account: ACCOUNT_ARG,
      action: { type: 'string', description: 'list (default) | create | rename' },
      name: { type: 'string', description: 'create: new folder name; rename: new name.' },
      parent: { type: 'string', description: 'create: optional parent folder path.' },
      from: { type: 'string', description: 'rename: the folder path to rename (custom folders only).' },
    },
    output: genericOut,
    async execute(args) {
      const { acc, fail: refusal } = pick(args, 'read', { preferRead: true })
      if (refusal) return refusal
      try {
        if (args.action === 'create' || args.action === 'rename') {
          if (!acc.agent.canManageFolders) return fail('MAIL_AGENT_DENIED', 'account ' + acc.id + ' does not allow agents to manage folders (canManageFolders)')
          const r = args.action === 'create' ? await d.service.createFolder(acc, args.name, args.parent || '') : await d.service.renameFolder(acc, args.from, args.name)
          d.audit({ actor: 'agent', action: 'folder_' + args.action, account: acc.id })
          return { ok: true, text: (args.action === 'create' ? 'Created ' : 'Renamed to ') + r.path, data: r }
        }
        const fl = await d.service.folders(acc)
        return { ok: true, count: fl.length, data: { account: acc.id, folders: fl }, text: acc.id + ' folders:\n' + fl.map(f => '- ' + f.path + (f.role ? ' (' + f.role + ')' : '') + (f.unseen ? ', ' + f.unseen + ' unread' : '') + (f.total != null ? ', ' + f.total + ' total' : '')).join('\n') }
      } catch (e) { return failFrom(e, 'MAIL_MAILBOX_UNREACHABLE') }
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
      if (toolsOff()) return fail('MAIL_TOOLS_DISABLED', 'agent mail tools are disabled')
      const s = settings()
      try {
        if (args.account) { const { fail: refusal } = pick(args, 'read'); if (refusal) return refusal }
        const r = await d.service.search({ account: args.account || '', folder: args.folder || '', query: args.query || '', limit: args.limit || 20 })
        const rows = r.rows.filter(x => { const a = d.resolved().all.find(y => y.id === x.account); return a && !agentDenied(a, 'read', s) })
        return {
          ok: true, count: rows.length, data: { results: rows, errors: r.errors },
          text: rows.length ? rows.map(x => (x.unread ? '[NEW] ' : '') + iso(x.date).slice(0, 16).replace('T', ' ') + '  ' + x.from + '  "' + x.subject + '"  id ' + x.id + '  thread ' + x.account + '/' + x.thread + (x.snippet ? '\n    ' + x.snippet.slice(0, 140) : '')).join('\n') : 'No results.' + (r.errors.length ? ' Errors: ' + r.errors.map(e => e.account + ': ' + e.error).join('; ') : ''),
        }
      } catch (e) { return failFrom(e, 'MAIL_MAILBOX_UNREACHABLE') }
    },
  })

  function permittedIds(ids, need) {
    const s = settings()
    const r = d.resolved()
    for (const id of ids) {
      const ref = parseId(id)
      if (!ref) return { code: 'MAIL_INVALID_INPUT', text: 'invalid message id: ' + String(id).slice(0, 80) }
      const acc = r.all.find(a => a.id === ref.account)
      const den = agentDenied(acc, need, s)
      if (den) return { code: classify(new Error(den)).code, text: den }
    }
    return null
  }
  const denial = den => fail(den.code, den.text)
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
      if (toolsOff()) return fail('MAIL_TOOLS_DISABLED', 'agent mail tools are disabled')
      const ids = idsOf(args)
      if (!ids.length) return fail('MAIL_INVALID_INPUT', 'ids required')
      const den = permittedIds(ids, 'read')
      if (den) return denial(den)
      try { const r = await d.service.mark(ids, String(args.action || args.op || 'read')); return { ok: true, count: r.updated, text: (args.action || 'read') + ': ' + r.updated + ' message(s).' } }
      catch (e) { return failFrom(e, 'MAIL_MAILBOX_UNREACHABLE') }
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
      if (toolsOff()) return fail('MAIL_TOOLS_DISABLED', 'agent mail tools are disabled')
      const ids = idsOf(args)
      if (!ids.length) return fail('MAIL_INVALID_INPUT', 'ids required')
      const den = permittedIds(ids, 'read')
      if (den) return denial(den)
      try { const r = await d.service.move(ids, args.to); return { ok: true, count: r.moved, text: 'Moved ' + r.moved + ' message(s) to ' + args.to + '.' } }
      catch (e) { return failFrom(e, 'MAIL_MAILBOX_UNREACHABLE') }
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
      if (toolsOff()) return fail('MAIL_TOOLS_DISABLED', 'agent mail tools are disabled')
      const action = String(args.action || 'list')
      try {
        if (action === 'list') {
          const all = await d.drafts.list()
          return { ok: true, count: all.length, data: { drafts: all.map(x => ({ id: x.id, account: x.account, to: x.to, subject: x.subject, by: x.by, updatedAt: x.updatedAt })) }, text: all.length ? all.map(x => x.id + '  ' + x.account + '  to ' + x.to + '  "' + x.subject + '"').join('\n') : 'No drafts.' }
        }
        if (action === 'get') { const dr = await d.drafts.read(args.draftId); return dr ? { ok: true, draftId: dr.id, text: renderDraft(dr) } : fail('MAIL_OBJECT_NOT_FOUND', 'no draft ' + args.draftId) }
        if (action === 'delete') {
          const dr = await d.drafts.read(args.draftId)
          if (dr && dr.remote) { try { await d.service.deleteDraftRemote(d.service.account(dr.account), dr) } catch {} }
          await d.drafts.remove(args.draftId)
          return { ok: true, text: 'Deleted ' + args.draftId }
        }
        if (action === 'create' || action === 'update') {
          const prev = action === 'update' ? await d.drafts.read(args.draftId) : null
          if (action === 'update' && !prev) return fail('MAIL_OBJECT_NOT_FOUND', 'no draft ' + args.draftId)
          const { acc, fail: refusal } = pick({ account: args.account || (prev && prev.account) }, 'send')
          if (refusal) return refusal
          const merged = { ...(prev || {}) }
          for (const k of ['to', 'cc', 'bcc', 'subject', 'text', 'html', 'inReplyTo']) if (typeof args[k] === 'string') merged[k] = args[k]
          if (Array.isArray(args.attachments)) merged.attachments = args.attachments
          let dr = await d.drafts.save({ ...merged, id: prev ? prev.id : undefined, account: acc.id, by: 'agent' })
          try { const remote = await d.service.syncDraftRemote(acc, dr); if (remote) dr = await d.drafts.save({ ...dr, remote }) } catch {}
          return { ok: true, drafted: true, draftId: dr.id, text: renderDraft(dr) }
        }
        return fail('MAIL_INVALID_INPUT', 'action must be create, update, list, get or delete')
      } catch (e) { return failFrom(e, 'MAIL_INTERNAL') }
    },
  })

  reg({
    name: 'mail_forward',
    description: 'Forward a message (id from mail_read / mail_search) with an optional note. Draft first, then confirm:true, like mail_send. Original attachments are included only with attachments:true.',
    parameters: {
      id: { type: 'string', description: 'Message id (account:folder:uid).' },
      to: { type: 'string', description: 'Recipients (comma-separated).' },
      cc: { type: 'string', description: 'Optional Cc.' },
      note: { type: 'string', description: 'Text written above the forwarded message.' },
      attachments: { type: 'boolean', description: 'Also forward the original attachments. Default false.' },
      account: { type: 'string', description: 'Account to send from. Default: the account of the message.' },
      confirm: { type: 'boolean', description: 'true delivers (subject to agents.confirmMode and firstContactConfirm).' },
    },
    output: genericOut,
    async execute(args) {
      if (toolsOff()) return fail('MAIL_TOOLS_DISABLED', 'agent mail tools are disabled')
      const ref = parseId(args.id)
      if (!ref) return fail('MAIL_INVALID_INPUT', 'id must be a message id (account:folder:uid)')
      const den = permittedIds([args.id], 'read')
      if (den) return denial(den)
      const { acc, fail: refusal } = pick({ account: args.account || ref.account }, 'send')
      if (refusal) return refusal
      if (!args.to) return fail('MAIL_INVALID_INPUT', 'to is required')
      try {
        const m = await d.service.message(args.id)
        const subj = /^\s*fwd?:/i.test(m.subject || '') ? m.subject : 'Fwd: ' + (m.subject || '')
        const who = a => (a ? (a.name ? a.name + ' <' + a.address + '>' : a.address) : '')
        const text = (args.note ? args.note + '\n\n' : '') + '---------- Forwarded message ----------\nFrom: ' + who(m.from) + '\nDate: ' + (m.date ? new Date(m.date).toUTCString() : '') +
          '\nSubject: ' + (m.subject || '') + '\nTo: ' + (m.to || []).map(who).join(', ') + '\n\n' + String(m.text || '').slice(0, 200000)
        const msg = { to: args.to, cc: args.cc || '', subject: subj, text, forwardOf: args.id, forwardAttachments: args.attachments === true }
        const held = await gate(acc, msg, args)
        if (held) return held
        const r = await deliver(acc, { ...msg, to: addrList(msg.to), cc: addrList(msg.cc) })
        return { ok: true, text: 'Forwarded via ' + acc.id + ': message ID ' + (r.messageId || '') }
      } catch (e) { return rateFail(e) }
    },
  })

  reg({
    name: 'mail_suppression',
    description: 'The unsubscribe and suppression lists: list (optional q, list), check an address, campaigns, or add / remove an address (global or for one list). add and remove only show what would change unless confirm:true.',
    parameters: {
      action: { type: 'string', description: 'list | check | campaigns | add | remove' },
      address: { type: 'string', description: 'Address (or @domain for global add).' },
      list: { type: 'string', description: 'Optional list name; omit for the global list.' },
      q: { type: 'string', description: 'list: filter text.' },
      confirm: { type: 'boolean', description: 'add / remove: true applies the change.' },
    },
    output: genericOut,
    async execute(args) {
      if (toolsOff()) return fail('MAIL_TOOLS_DISABLED', 'agent mail tools are disabled')
      const action = String(args.action || 'list')
      const listId = args.list ? normList(args.list) : ''
      try {
        if (action === 'list') {
          const qq = String(args.q || '').toLowerCase()
          const global = d.suppression.entries().filter(e => !qq || e.address.includes(qq))
          const lists = d.lists.all()
          const rows = listId ? Object.keys(lists[listId] || {}).filter(a => !qq || a.includes(qq)).map(a => ({ address: a, scope: 'list:' + listId })) : [...global.map(e => ({ address: e.address, scope: 'all', reason: e.reason })), ...Object.entries(lists).flatMap(([l, m]) => Object.keys(m).filter(a => !qq || a.includes(qq)).map(a => ({ address: a, scope: 'list:' + l })))]
          return { ok: true, count: rows.length, data: { rows: rows.slice(0, 500) }, text: rows.length ? rows.slice(0, 200).map(r => r.address + '  ' + r.scope + (r.reason ? '  (' + r.reason + ')' : '')).join('\n') : 'The suppression lists are empty.' }
        }
        if (action === 'campaigns') {
          const c = d.campaigns.summaries().slice(0, 50)
          return { ok: true, count: c.length, data: { campaigns: c }, text: c.length ? c.map(x => x.id + '  list ' + x.list + '  ' + x.sent + ' sent, ' + x.unsubscribed + ' unsubscribed  ' + new Date(x.createdAt).toISOString().slice(0, 16)).join('\n') : 'No campaigns yet.' }
        }
        const addr = bare(args.address)
        if (!addr) return fail('MAIL_INVALID_INPUT', 'address required')
        if (action === 'check') {
          const g = d.suppression.has(addr)
          const ls = Object.entries(d.lists.all()).filter(([, m]) => m[addr]).map(([l]) => l)
          return { ok: true, data: { global: g, lists: ls }, text: addr + (g ? ' is suppressed for all mail' : ' is not globally suppressed') + (ls.length ? '; unsubscribed from: ' + ls.join(', ') : '') + '.' }
        }
        if (action === 'add' || action === 'remove') {
          const what = (action === 'add' ? 'Add ' : 'Remove ') + addr + (listId ? ' (list ' + listId + ')' : ' (all mail)')
          if (args.confirm !== true) return { ok: true, drafted: true, text: what + ': not applied. Confirm with the user, then call again with confirm:true.' }
          const done = action === 'add' ? (listId ? d.lists.add(listId, addr, 'added by agent') : d.suppression.add(addr, 'added by agent')) : (listId ? d.lists.remove(listId, addr) : d.suppression.remove(addr))
          d.audit({ actor: 'agent', action: 'suppress_' + action, note: listId ? 'list' : 'all' })
          return { ok: true, text: what + (done ? ': done.' : ': no change.') }
        }
        return fail('MAIL_INVALID_INPUT', 'action must be list, check, campaigns, add or remove')
      } catch (e) { return failFrom(e, 'MAIL_INTERNAL') }
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
      if (toolsOff()) return fail('MAIL_TOOLS_DISABLED', 'agent mail tools are disabled')
      const den = permittedIds([args.messageId], 'read')
      if (den) return denial(den)
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
      } catch (e) { return failFrom(e, 'MAIL_MAILBOX_UNREACHABLE') }
    },
  })
}
