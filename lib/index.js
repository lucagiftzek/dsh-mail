/**
 * dsh-mail — host half.
 *
 * Agent email tools for the DeepSeek Harness:
 *   mail_send        send one email via a configured provider
 *   mail_mass_send   personalised mass send from CSV data, with inter-email delay
 *   mail_send_later  schedule an email for future sending (adds to the queue)
 *   mail_read        read/fetch recent inbox messages (provider-dependent)
 *   mail_fetch       fetch a single message by ID (provider-dependent)
 *   mail_domains     list available sending domains / inboxes per provider
 *   mail_queue       queue an email for manual send via the sidebar UI
 *   mail_list_queue  list pending/sent/failed queue entries
 *   mail_cancel      cancel a queued/scheduled email
 *
 * Settings live in the dsh-mail namespace of ~/.dsh/settings.yaml.
 * Credentials are auto-populated from estate credential files on first boot,
 * but NEVER hard-coded in the repo. The plugin reads them at resolve time.
 *
 * CONTROL MODEL: agents can send email directly (mail_send / mail_mass_send),
 * but the sidebar tab shows a queue for review, and scheduled/manual entries
 * are only sent from the sidebar or the timer. This is deliberate: an agent
 * sending a mass email to hundreds of recipients needs the same accountability
 * the HPC plugin gives to job submissions, but a single transactional email
 * is a normal agent action.
 */

'use strict'

import fsP from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

import { buildProvider, resolveCred } from './providers.js'
import { Queue, parseCSV, personalise } from './staging.js'
import { loadOrCreateSecret, mintToken, checkReadRequest, checkMutateRequest } from './security.js'

export const name = 'dsh-mail'
export const inject = ['tools', 'webServer', 'settings']

export const PLUGIN_ID = 'dsh-mail'
const API_PREFIX = '/' + PLUGIN_ID + '/api'
const DISABLE_ENV = 'DSH_MAIL_DISABLE'
const VERSION = '0.1.0'
const SETTINGS_NS = PLUGIN_ID

const DEFAULTS = {
  enabled: true,
  defaultProvider: 'lettermint',
  defaultFrom: '',
  defaultReplyTo: '',
  trustedHosts: ['llm.tzekos.eu'],
  requireHarnessCookie: true,
  maxRecipients: 500,
  maxBodyChars: 100000,
  maxCsvRows: 1000,
  minDelayMs: 500,
  maxDelayMs: 60000,
  tickSeconds: 30,
  providers: {
    lettermint: { lettermintApiKey: '', lettermintBaseURL: 'https://api.lettermint.co/v1' },
    agentmail: { agentmailApiKey: '', agentmailInbox: '', agentmailBaseURL: 'https://api.agentmail.to/v0' },
    resend: { resendApiKey: '', resendBaseURL: 'https://api.resend.com' },
    ovh: { smtpHost: 'ssl0.ovh.net', smtpPort: 465, smtpSecure: true, smtpUser: '', smtpPass: '', smtpFrom: '' },
    smtp: { smtpHost: '', smtpPort: 587, smtpSecure: false, smtpUser: '', smtpPass: '', smtpFrom: '', smtpLabel: 'smtp' },
    local: { smtpHost: '', smtpPort: 587, smtpSecure: false, smtpUser: '', smtpPass: '', smtpFrom: '', smtpLabel: 'local' },
  },
}

// ── Credential auto-population from estate files ─────────────────────────
// These are READ-ONLY — the plugin reads them to populate settings defaults
// but never writes back to the estate credential files.

function loadEstateCreds() {
  const creds = {}
  const home = homedir()
  // AgentMail: ~/.config/agentmail/credentials
  try {
    const raw = readFileSync(join(home, '.config', 'agentmail', 'credentials'), 'utf8')
    creds.agentmailApiKey = matchEnv(raw, 'AGENTMAIL_API_KEY')
    creds.agentmailInbox = matchEnv(raw, 'AGENTMAIL_TEST_INBOX') || matchEnv(raw, 'AGENTMAIL_INBOX')
  } catch {}
  // Lettermint: ~/.config/lettermint/credentials (may be on Main via ssh, but local check first)
  try {
    const raw = readFileSync(join(home, '.config', 'lettermint', 'credentials'), 'utf8')
    creds.lettermintApiKey = matchEnv(raw, 'LETTERMINT_API_KEY')
  } catch {}
  return creds
}

function matchEnv(text, key) {
  const m = new RegExp('^' + key + '=(.+)$', 'm').exec(String(text || ''))
  return m ? m[1].trim() : null
}

// ── Config resolution ────────────────────────────────────────────────────

export function resolveConfig(config = {}) {
  const c = config && typeof config === 'object' ? config : {}
  return {
    ...DEFAULTS,
    ...c,
    trustedHosts: Array.isArray(c.trustedHosts) ? c.trustedHosts : DEFAULTS.trustedHosts,
    requireHarnessCookie: c.requireHarnessCookie !== false,
    providers: { ...DEFAULTS.providers, ...(c.providers || {}) },
  }
}

function dshHome() { return process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh') }

// ── Tool definition resolution (defensive, like dsh-hpc) ──────────────────

export function resolveDefineTool(env = process.env) {
  const bases = []
  if (env.DSH_MAIL_TOOLS_MAIN) bases.push(env.DSH_MAIL_TOOLS_MAIN)
  bases.push(import.meta.url)
  bases.push(join(homedir(), '.dsh', 'profiles', 'web', 'probe.js'))
  if (process.argv && process.argv[1]) bases.push(process.argv[1])
  for (const base of bases) {
    try {
      const req = createRequire(base)
      const mod = req('@deepseek-ai/dsh-tools')
      const fn = mod && (mod.defineTool || (mod.default && mod.default.defineTool))
      if (typeof fn === 'function') return fn
    } catch {}
  }
  return null
}

// ── Helper: get provider instance from resolved settings ──────────────────

function getProvider(settings, providerId) {
  const providerCreds = (settings.providers || {})[providerId]
  if (!providerCreds) throw new Error('unknown provider: ' + providerId)
  // Merge estate creds (read-only, never written) with settings
  const estateCreds = loadEstateCreds()
  const merged = { ...providerCreds }
  for (const [k, v] of Object.entries(estateCreds)) {
    if (!merged[k] && v) merged[k] = v
  }
  return buildProvider(providerId, merged)
}

function getEnabledProviders(settings) {
  const out = {}
  for (const id of Object.keys(settings.providers || {})) {
    try {
      const p = getProvider(settings, id)
      if (p && p.enabled()) out[id] = p
    } catch {}
  }
  return out
}

// ── Settings schema (schemastery) ─────────────────────────────────────────

function loadSchemastery() {
  const req = createRequire(import.meta.url)
  const candidates = []
  if (process.env.DSH_SCHEMASTERY_ENTRY) candidates.push(process.env.DSH_SCHEMASTERY_ENTRY)
  for (const prefix of [process.env.DSH_GLOBAL_PREFIX, join(homedir(), '.local')].filter(Boolean)) {
    candidates.push(join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.cjs'))
  }
  for (const c of candidates) {
    try { if (req('node:fs').existsSync(c)) return createRequire(c)(c) } catch {}
  }
  try { return req('@deepseek-ai/schemastery') } catch {}
  return null
}

function settingsSchema(z) {
  if (!z) return null
  return z.object({
    enabled: z.boolean().default(DEFAULTS.enabled),
    defaultProvider: z.string().default(DEFAULTS.defaultProvider),
    defaultFrom: z.string().default(DEFAULTS.defaultFrom),
    defaultReplyTo: z.string().default(DEFAULTS.defaultReplyTo),
    maxRecipients: z.number().min(1).default(DEFAULTS.maxRecipients),
    maxBodyChars: z.number().min(100).default(DEFAULTS.maxBodyChars),
    maxCsvRows: z.number().min(1).default(DEFAULTS.maxCsvRows),
    minDelayMs: z.number().min(0).default(DEFAULTS.minDelayMs),
    maxDelayMs: z.number().min(100).default(DEFAULTS.maxDelayMs),
    tickSeconds: z.number().min(5).default(DEFAULTS.tickSeconds),
    providers: z.object({
      lettermint: z.object({
        lettermintApiKey: z.string().default(''),
        lettermintBaseURL: z.string().default(DEFAULTS.providers.lettermint.lettermintBaseURL),
      }).default({}),
      agentmail: z.object({
        agentmailApiKey: z.string().default(''),
        agentmailInbox: z.string().default(''),
        agentmailBaseURL: z.string().default(DEFAULTS.providers.agentmail.agentmailBaseURL),
      }).default({}),
      resend: z.object({
        resendApiKey: z.string().default(''),
        resendBaseURL: z.string().default(DEFAULTS.providers.resend.resendBaseURL),
      }).default({}),
      ovh: z.object({
        smtpHost: z.string().default(DEFAULTS.providers.ovh.smtpHost),
        smtpPort: z.number().default(DEFAULTS.providers.ovh.smtpPort),
        smtpSecure: z.boolean().default(DEFAULTS.providers.ovh.smtpSecure),
        smtpUser: z.string().default(''),
        smtpPass: z.string().default(''),
        smtpFrom: z.string().default(''),
      }).default({}),
      smtp: z.object({
        smtpHost: z.string().default(''),
        smtpPort: z.number().default(DEFAULTS.providers.smtp.smtpPort),
        smtpSecure: z.boolean().default(DEFAULTS.providers.smtp.smtpSecure),
        smtpUser: z.string().default(''),
        smtpPass: z.string().default(''),
        smtpFrom: z.string().default(''),
        smtpLabel: z.string().default('smtp'),
      }).default({}),
      local: z.object({
        smtpHost: z.string().default(''),
        smtpPort: z.number().default(DEFAULTS.providers.local.smtpPort),
        smtpSecure: z.boolean().default(DEFAULTS.providers.local.smtpSecure),
        smtpUser: z.string().default(''),
        smtpPass: z.string().default(''),
        smtpFrom: z.string().default(''),
        smtpLabel: z.string().default('local'),
      }).default({}),
    }).default({}),
  })
}

// ── HTTP helpers ──────────────────────────────────────────────────────────

function readJsonBody(req) {
  return new Promise((fulfil, reject) => {
    let size = 0; const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > 256 * 1024) { reject(new Error('request body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { fulfil(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch (e) { reject(new Error('invalid JSON body: ' + e.message)) }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

// ── The plugin ────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  if (process.env[DISABLE_ENV] === '1') {
    console.log('dsh-mail: ' + DISABLE_ENV + '=1 — armed off')
    return
  }

  const cfg = resolveConfig(config)
  const pluginDir = join(dshHome(), PLUGIN_ID.replace('dsh-', ''))
  const queueDir = join(pluginDir, 'queue')
  const secretPath = join(pluginDir, 'capability.secret')
  const queue = new Queue(queueDir)
  const log = m => console.log('dsh-mail: ' + m)
  const warn = m => console.error('dsh-mail: ' + m)

  // ── Settings ──
  const z = loadSchemastery()
  let settingsScope = null
  const schema = settingsSchema(z)
  if (schema && ctx.settings && typeof ctx.settings.register === 'function') {
    try {
      settingsScope = ctx.settings.register(SETTINGS_NS, schema, { base: structuredCloneSafe(DEFAULTS), applies: 'live' })
      log('settings registered at ns ' + SETTINGS_NS)
    } catch (e) { warn('settings register failed: ' + e.message) }
  }

  function structuredCloneSafe(o) { return JSON.parse(JSON.stringify(o)) }

  const effective = () => {
    let raw
    if (settingsScope && typeof settingsScope.get === 'function') {
      try { raw = settingsScope.get() } catch { raw = null }
    } else { raw = { ...DEFAULTS, ...config } }
    return resolveConfig(raw)
  }

  // ── Capability secret ──
  const secretP = loadOrCreateSecret(secretPath).catch(() => null)
  let secret = null
  secretP.then(s => { secret = s })

  // ── Agent tools ──
  const defineTool = resolveDefineTool()
  if (defineTool && ctx.tools && typeof ctx.tools.register === 'function') {
    try { registerTools(defineTool, ctx, effective, queue, cfg) }
    catch (e) { warn('tool registration failed: ' + e.message) }
  } else {
    warn('defineTool or ctx.tools unavailable — agent tools not registered (sidebar still works)')
  }

  // ── Timer: process scheduled queue entries ──
  let tickTimer = null
  const armTimer = () => {
    if (tickTimer) return
    tickTimer = setInterval(() => { void processQueue().catch(() => {}) }, cfg.tickSeconds * 1000)
    if (typeof tickTimer.unref === 'function') tickTimer.unref()
  }

  async function processQueue() {
    const settings = effective()
    const due = await queue.due()
    if (!due.length) return
    log('processing ' + due.length + ' queued email(s)')
    for (const entry of due) {
      try {
        const provider = getProvider(settings, entry.provider)
        if (!provider || !provider.enabled()) {
          await queue.setStatus(entry.id, 'failed', { lastError: 'provider ' + entry.provider + ' is not configured', attempts: (entry.attempts || 0) + 1 })
          continue
        }
        // Mass send (CSV)
        if (entry.csvData && Array.isArray(entry.csvData.rows) && entry.csvData.rows.length) {
          let sent = 0, failed = 0
          for (const row of entry.csvData.rows) {
            const to = row.email || row.Email || row[Object.keys(row).find(k => k.toLowerCase().includes('email'))]
            if (!to) { failed++; continue }
            const text = personalise(entry.msg.text, row)
            const subject = personalise(entry.msg.subject, row)
            const from = entry.msg.from || settings.defaultFrom || provider.name()
            try {
              await provider.send({}, { from, to, subject, text, replyTo: entry.msg.replyTo || settings.defaultReplyTo })
              sent++
              if (entry.delayMs) await sleep(Math.min(settings.maxDelayMs, Math.max(settings.minDelayMs, entry.delayMs)))
            } catch (e) { failed++; warn('mass send to ' + to + ' failed: ' + e.message) }
          }
          await queue.setStatus(entry.id, 'sent', { sentCount: sent, failedCount: failed, sentMessageId: 'mass-send' })
        } else {
          // Single email
          const from = entry.msg.from || settings.defaultFrom || ''
          const result = await provider.send({}, { ...entry.msg, from })
          await queue.setStatus(entry.id, 'sent', { sentMessageId: result.messageId })
        }
      } catch (e) {
        await queue.setStatus(entry.id, 'failed', { lastError: String(e.message).slice(0, 500), attempts: (entry.attempts || 0) + 1 })
        warn('queue send failed for ' + entry.id + ': ' + e.message)
      }
    }
  }

  // ── HTTP routes ──
  const handler = async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://dsh-mail.local')
      const path = url.pathname.replace(/\/+$/, '') || '/'
      const sub = path.startsWith(API_PREFIX) ? path.slice(API_PREFIX.length) : path

      if (req.method === 'GET' && sub === '/session') {
        if (!secret) { sendJson(res, 503, { error: 'secret not ready' }); return }
        sendJson(res, 200, { token: mintToken(secret) })
        return
      }

      const settings = effective()

      if (req.method === 'GET' && sub === '/state') {
        const gate = checkReadRequest(req, { trustedHosts: settings.trustedHosts })
        if (!gate.ok) { sendJson(res, gate.status, { error: gate.reason }); return }
        const providers = {}
        for (const id of Object.keys(settings.providers || {})) {
          try {
            const p = getProvider(settings, id)
            providers[id] = { enabled: p && p.enabled(), name: p ? p.name() : id }
          } catch { providers[id] = { enabled: false, name: id } }
        }
        const queueList = await queue.list()
        sendJson(res, 200, {
          ok: true,
          version: VERSION,
          settings: safeSettings(settings),
          providers,
          queue: queueList.slice(0, 100),
          queueCounts: {
            pending: queueList.filter(q => q.status === 'queued' || q.status === 'scheduled').length,
            sent: queueList.filter(q => q.status === 'sent').length,
            failed: queueList.filter(q => q.status === 'failed').length,
            cancelled: queueList.filter(q => q.status === 'cancelled').length,
          },
        })
        return
      }

      if (req.method === 'POST' && sub === '/send') {
        const gate = checkMutateRequest(req, { trustedHosts: settings.trustedHosts, secret, requireHarnessCookie: settings.requireHarnessCookie })
        if (!gate.ok) { sendJson(res, gate.status, { error: gate.reason, layer: gate.layer }); return }
        const body = await readJsonBody(req)
        const providerId = body.provider || settings.defaultProvider
        try {
          const provider = getProvider(settings, providerId)
          if (!provider || !provider.enabled()) { sendJson(res, 400, { error: 'provider ' + providerId + ' is not configured' }); return }
          const from = body.from || settings.defaultFrom || ''
          const result = await provider.send({}, { ...body, from })
          sendJson(res, 200, { ok: true, messageId: result.messageId, from: result.from, provider: providerId })
        } catch (e) { sendJson(res, 400, { error: e.message }) }
        return
      }

      if (req.method === 'POST' && sub === '/queue/send') {
        const gate = checkMutateRequest(req, { trustedHosts: settings.trustedHosts, secret, requireHarnessCookie: settings.requireHarnessCookie })
        if (!gate.ok) { sendJson(res, gate.status, { error: gate.reason, layer: gate.layer }); return }
        const body = await readJsonBody(req)
        try {
          const entry = await queue.read(body.id)
          if (!entry) { sendJson(res, 404, { error: 'not found' }); return }
          if (entry.status === 'sent') { sendJson(res, 400, { error: 'already sent' }); return }
          const provider = getProvider(settings, entry.provider)
          if (!provider || !provider.enabled()) { sendJson(res, 400, { error: 'provider not configured' }); return }
          const from = entry.msg.from || settings.defaultFrom || ''
          const result = await provider.send({}, { ...entry.msg, from })
          await queue.setStatus(body.id, 'sent', { sentMessageId: result.messageId })
          sendJson(res, 200, { ok: true, messageId: result.messageId })
        } catch (e) { sendJson(res, 400, { error: e.message }) }
        return
      }

      if (req.method === 'POST' && sub === '/queue/cancel') {
        const gate = checkMutateRequest(req, { trustedHosts: settings.trustedHosts, secret, requireHarnessCookie: settings.requireHarnessCookie })
        if (!gate.ok) { sendJson(res, gate.status, { error: gate.reason, layer: gate.layer }); return }
        const body = await readJsonBody(req)
        try {
          await queue.cancel(body.id, { by: 'ui' })
          sendJson(res, 200, { ok: true })
        } catch (e) { sendJson(res, 400, { error: e.message }) }
        return
      }

      if (req.method === 'POST' && sub === '/queue/delete') {
        const gate = checkMutateRequest(req, { trustedHosts: settings.trustedHosts, secret, requireHarnessCookie: settings.requireHarnessCookie })
        if (!gate.ok) { sendJson(res, gate.status, { error: gate.reason, layer: gate.layer }); return }
        const body = await readJsonBody(req)
        try {
          await queue.delete(body.id)
          sendJson(res, 200, { ok: true })
        } catch (e) { sendJson(res, 400, { error: e.message }) }
        return
      }

      if (req.method === 'PUT' && sub === '/settings') {
        const csrf = req.headers['x-requested-with'] === PLUGIN_ID && String(req.headers['content-type'] || '').split(';')[0].trim() === 'application/json'
        if (!csrf) { sendJson(res, 403, { error: 'csrf-guard' }); return }
        const body = await readJsonBody(req)
        if (settingsScope && typeof settingsScope.update === 'function') {
          await settingsScope.update(sanitizeSettingsPatch(body))
          sendJson(res, 200, { ok: true, settings: safeSettings(effective()) })
        } else {
          sendJson(res, 200, { ok: false, error: 'settings service unavailable' })
        }
        return
      }

      sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      try { if (res.headersSent) { res.end(); return }; sendJson(res, 400, { error: String(error.message || error) }) } catch {}
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler }), 'dsh-mail: api route')

  void (async () => {
    await queue.init().catch(() => {})
    armTimer()
    log('armed — route ' + API_PREFIX + ' · queue ' + queueDir)
  })().catch(e => { warn('init crashed: ' + e.message); try { armTimer() } catch {} })

  ctx.effect(() => () => {
    if (tickTimer) clearInterval(tickTimer)
  }, 'dsh-mail: cleanup')
}

// ── Agent tool registration ───────────────────────────────────────────────

function registerTools(defineTool, ctx, effective, queue, cfg) {
  const TEXT = s => [{ type: 'text', text: s }]

  ctx.tools.register(defineTool({
    name: 'mail_send',
    description: 'Send one email via a configured provider. Returns the provider message ID. ' +
      'Use mail_send_later to schedule, mail_mass_send for bulk, mail_read to check replies.',
    parameters: {
      provider: { type: 'string', description: 'Provider ID: lettermint, agentmail, resend, ovh, smtp, local. Defaults to the configured default.' },
      from: { type: 'string', description: 'Sender email address. Defaults to the configured defaultFrom.' },
      to: { type: 'string', description: 'Recipient email address (single or comma-separated).' },
      subject: { type: 'string', description: 'Email subject.' },
      text: { type: 'string', description: 'Plain-text email body.' },
      html: { type: 'string', description: 'Optional HTML body.' },
      replyTo: { type: 'string', description: 'Optional reply-to address.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          messageId: { type: 'string' },
          from: { type: 'string' },
          provider: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_a, v) => TEXT(v.ok ? 'Sent via ' + v.provider + ': message ID ' + v.messageId : 'Send failed: ' + (v.error || 'unknown')),
    },
    async execute(args) {
      const settings = effective()
      const providerId = args.provider || settings.defaultProvider
      try {
        const provider = getProvider(settings, providerId)
        if (!provider || !provider.enabled()) return { ok: false, error: 'provider ' + providerId + ' is not configured' }
        const from = args.from || settings.defaultFrom || ''
        const to = args.to ? args.to.split(',').map(t => t.trim()).filter(Boolean) : []
        const result = await provider.send({}, { from, to, subject: args.subject, text: args.text, html: args.html, replyTo: args.replyTo })
        return { ok: true, messageId: result.messageId, from: result.from, provider: providerId }
      } catch (e) { return { ok: false, error: String(e.message) } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mail_mass_send',
    description: 'Send personalised mass emails from CSV data. Each row is one email with template substitution. ' +
      'Supports a delay between sends to respect rate limits. Example CSV: name,email\nMaria,maria@example.com\nFotis,fotis@example.com. ' +
      'Template uses {name}, {email}, {any_column} placeholders.',
    parameters: {
      provider: { type: 'string', description: 'Provider ID. Defaults to the configured default.' },
      from: { type: 'string', description: 'Sender email address.' },
      subjectTemplate: { type: 'string', description: 'Subject with {placeholders} for CSV columns, e.g. "Hi, {name}!"' },
      textTemplate: { type: 'string', description: 'Body text with {placeholders}, e.g. "Hi {name}, ..."' },
      csv: { type: 'string', description: 'CSV text with header row. Columns must include at least "email" (or "Email"). Other columns are available as {column_name} placeholders.' },
      delayMs: { type: 'integer', description: 'Delay in milliseconds between sends. Clamped to [minDelayMs, maxDelayMs]. Default: 1000.' },
      replyTo: { type: 'string', description: 'Optional reply-to address.' },
      queueOnly: { type: 'boolean', description: 'If true, queue for manual send via sidebar instead of sending immediately. Default: false.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          sent: { type: 'integer' },
          failed: { type: 'integer' },
          total: { type: 'integer' },
          queueId: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_a, v) => TEXT(v.ok
        ? (v.queueId ? 'Queued ' + v.total + ' emails (id ' + v.queueId + ')' : 'Sent ' + v.sent + '/' + v.total + (v.failed ? ', ' + v.failed + ' failed' : ''))
        : 'Mass send failed: ' + (v.error || 'unknown')),
    },
    async execute(args) {
      const settings = effective()
      const providerId = args.provider || settings.defaultProvider
      try {
        const rows = parseCSV(args.csv, settings.maxCsvRows)
        if (!rows.length) return { ok: false, error: 'CSV has no data rows' }
        if (rows.length > settings.maxRecipients) return { ok: false, error: 'too many recipients: ' + rows.length + ' > maxRecipients ' + settings.maxRecipients }

        if (args.queueOnly) {
          const entry = await queue.create({
            name: 'mass-send-' + Date.now(),
            provider: providerId,
            msg: { from: args.from || settings.defaultFrom, to: '', subject: args.subjectTemplate, text: args.textTemplate, replyTo: args.replyTo },
            csvData: { rows, columns: Object.keys(rows[0]) },
            delayMs: Math.min(settings.maxDelayMs, Math.max(settings.minDelayMs, args.delayMs || 1000)),
            requestedBy: 'agent',
          })
          return { ok: true, total: rows.length, queueId: entry.id, sent: 0, failed: 0 }
        }

        // Send immediately
        const provider = getProvider(settings, providerId)
        if (!provider || !provider.enabled()) return { ok: false, error: 'provider ' + providerId + ' is not configured' }
        const delayMs = Math.min(settings.maxDelayMs, Math.max(settings.minDelayMs, args.delayMs || 1000))
        let sent = 0, failed = 0
        for (const row of rows) {
          const to = row.email || row.Email || row[Object.keys(row).find(k => k.toLowerCase().includes('email'))]
          if (!to) { failed++; continue }
          const text = personalise(args.textTemplate, row)
          const subject = personalise(args.subjectTemplate, row)
          const from = args.from || settings.defaultFrom || ''
          try {
            await provider.send({}, { from, to, subject, text, replyTo: args.replyTo || settings.defaultReplyTo })
            sent++
            if (delayMs) await sleep(delayMs)
          } catch (e) { failed++ }
        }
        return { ok: true, sent, failed, total: rows.length }
      } catch (e) { return { ok: false, error: String(e.message) } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mail_send_later',
    description: 'Schedule an email for future sending. Adds it to the queue with a sendAt timestamp. ' +
      'The timer processes it automatically when the time arrives. Alternatively, set queue=true for manual send via the sidebar.',
    parameters: {
      provider: { type: 'string', description: 'Provider ID. Defaults to the configured default.' },
      from: { type: 'string', description: 'Sender email address.' },
      to: { type: 'string', description: 'Recipient email address.' },
      subject: { type: 'string', description: 'Email subject.' },
      text: { type: 'string', description: 'Plain-text email body.' },
      html: { type: 'string', description: 'Optional HTML body.' },
      replyTo: { type: 'string', description: 'Optional reply-to address.' },
      sendAt: { type: 'string', description: 'ISO 8601 datetime to send at, e.g. "2026-09-25T09:00:00Z". Ignored if queue is true.' },
      queue: { type: 'boolean', description: 'If true, queue for manual send (no scheduled time). Default: false.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          queueId: { type: 'string' },
          status: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_a, v) => TEXT(v.ok ? 'Email ' + v.status + ' (id ' + v.queueId + ')' : 'Failed: ' + (v.error || 'unknown')),
    },
    async execute(args) {
      const settings = effective()
      const providerId = args.provider || settings.defaultProvider
      try {
        const provider = getProvider(settings, providerId)
        if (!provider || !provider.enabled()) return { ok: false, error: 'provider ' + providerId + ' is not configured' }
        let sendAt = null
        if (args.queue) {
          // manual queue only
        } else if (args.sendAt) {
          const ts = Date.parse(args.sendAt)
          if (!Number.isFinite(ts)) return { ok: false, error: 'invalid sendAt: must be ISO 8601' }
          sendAt = Math.round(ts / 1000)
        }
        const entry = await queue.create({
          name: 'email-' + Date.now(),
          provider: providerId,
          msg: { from: args.from || settings.defaultFrom, to: args.to, subject: args.subject, text: args.text, html: args.html, replyTo: args.replyTo },
          sendAt,
          requestedBy: 'agent',
        })
        return { ok: true, queueId: entry.id, status: entry.status }
      } catch (e) { return { ok: false, error: String(e.message) } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mail_read',
    description: 'Read recent inbox messages from a provider that supports inbox reading (AgentMail, SMTP/IMAP). ' +
      'Returns a list of messages with subject, from, to, text preview, and message ID. ' +
      'Optionally filter by domain or address.',
    parameters: {
      provider: { type: 'string', description: 'Provider ID (agentmail or smtp/ovh/local with IMAP). Defaults to the configured default.' },
      limit: { type: 'integer', description: 'Max messages to return. Default 20, max 100.' },
      domain: { type: 'string', description: 'Optional: filter by domain (e.g. "example.com").' },
      address: { type: 'string', description: 'Optional: filter by from/to address.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          messages: { type: 'json', required: true },
          count: { type: 'integer', required: true },
          provider: { type: 'string', required: true },
          error: { type: 'string' },
        },
      },
      render: (_a, v) => TEXT(v.ok
        ? (v.count + ' message(s) from ' + v.provider + (v.messages.length ? '\n' + v.messages.map(m => '  [' + (m.inbound ? 'IN' : 'OUT') + '] ' + m.from + ' → ' + m.subject).join('\n') : ''))
        : 'Read failed: ' + (v.error || 'unknown')),
    },
    async execute(args) {
      const settings = effective()
      const providerId = args.provider || settings.defaultProvider
      try {
        const provider = getProvider(settings, providerId)
        if (!provider || !provider.enabled()) return { ok: false, error: 'provider ' + providerId + ' is not configured', messages: [], count: 0, provider: providerId }
        if (typeof provider.recent !== 'function') return { ok: false, error: 'provider ' + providerId + ' does not support inbox reading', messages: [], count: 0, provider: providerId }
        const limit = Math.min(100, Math.max(1, args.limit || 20))
        let messages = await provider.recent({}, limit)
        // Optional filters
        if (args.domain) {
          const d = args.domain.toLowerCase()
          messages = messages.filter(m => (m.from || '').toLowerCase().includes(d) || (m.to || '').toLowerCase().includes(d))
        }
        if (args.address) {
          const a = args.address.toLowerCase()
          messages = messages.filter(m => (m.from || '').toLowerCase().includes(a) || (m.to || '').toLowerCase().includes(a))
        }
        return { ok: true, messages, count: messages.length, provider: providerId }
      } catch (e) { return { ok: false, error: String(e.message), messages: [], count: 0, provider: providerId } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mail_fetch',
    description: 'Fetch a single message by message ID (full body). Provider-dependent: AgentMail supports this.',
    parameters: {
      provider: { type: 'string', description: 'Provider ID.' },
      messageId: { type: 'string', description: 'The message ID to fetch.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a, v) => TEXT(v.ok
        ? ('From: ' + (v.message.from || '?') + '\nSubject: ' + (v.message.subject || '?') + '\n\n' + ((v.message.text || '').slice(0, 500)))
        : 'Fetch failed: ' + (v.error || 'unknown')),
    },
    async execute(args) {
      const settings = effective()
      const providerId = args.provider || settings.defaultProvider
      try {
        const provider = getProvider(settings, providerId)
        if (!provider || !provider.enabled()) return { ok: false, error: 'provider not configured' }
        if (typeof provider.fetch !== 'function') return { ok: false, error: 'provider does not support message fetch' }
        const message = await provider.fetch({}, args.messageId)
        return { ok: true, message }
      } catch (e) { return { ok: false, error: String(e.message) } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mail_domains',
    description: 'List available sending domains or inboxes per provider. Useful for knowing which From addresses are available.',
    parameters: {
      provider: { type: 'string', description: 'Provider ID. If omitted, lists domains for all configured providers.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          domains: { type: 'json', required: true },
          error: { type: 'string' },
        },
      },
      render: (_a, v) => TEXT(v.ok
        ? (v.domains.map(d => d.provider + ': ' + d.domains.map(dd => dd.domain || dd.name).join(', ')).join('\n') || 'No domains found')
        : 'Failed: ' + (v.error || 'unknown')),
    },
    async execute(args) {
      const settings = effective()
      const ids = args.provider ? [args.provider] : Object.keys(settings.providers || {})
      const out = []
      for (const id of ids) {
        try {
          const p = getProvider(settings, id)
          if (p && p.enabled() && typeof p.domains === 'function') {
            const domains = await p.domains({})
            out.push({ provider: id, domains })
          }
        } catch {}
      }
      return { ok: true, domains: out }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mail_list_queue',
    description: 'List the email queue: pending, sent, failed, and cancelled entries. Useful for tracking scheduled and mass-send status.',
    parameters: {
      status: { type: 'string', description: 'Optional filter: queued, scheduled, sent, failed, cancelled.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          entries: { type: 'json', required: true },
          count: { type: 'integer', required: true },
        },
      },
      render: (_a, v) => TEXT(v.ok
        ? (v.count + ' queue entries\n' + v.entries.map(e => '  [' + e.status + '] ' + e.name + ' via ' + e.provider + (e.sentMessageId ? ' → ' + e.sentMessageId : '')).join('\n'))
        : 'Failed'),
    },
    async execute(args) {
      try {
        const entries = await queue.list()
        const filtered = args.status ? entries.filter(e => e.status === args.status) : entries
        return { ok: true, entries: filtered, count: filtered.length }
      } catch (e) { return { ok: false, entries: [], count: 0 } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mail_cancel',
    description: 'Cancel a queued or scheduled email. Cannot cancel an email that was already sent.',
    parameters: {
      id: { type: 'string', description: 'The queue entry ID to cancel.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
        },
      },
      render: (_a, v) => TEXT(v.ok ? 'Cancelled' : 'Failed: ' + (v.error || 'unknown')),
    },
    async execute(args) {
      try {
        await queue.cancel(args.id, { by: 'agent' })
        return { ok: true }
      } catch (e) { return { ok: false, error: String(e.message) } }
    },
  }))
}

// ── Settings sanitization ─────────────────────────────────────────────────

function sanitizeSettingsPatch(body) {
  const patch = {}
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return patch
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
  if (typeof body.defaultProvider === 'string') patch.defaultProvider = body.defaultProvider
  if (typeof body.defaultFrom === 'string') patch.defaultFrom = body.defaultFrom
  if (typeof body.defaultReplyTo === 'string') patch.defaultReplyTo = body.defaultReplyTo
  if (Number.isFinite(body.maxRecipients)) patch.maxRecipients = Math.min(10000, Math.max(1, body.maxRecipients))
  if (Number.isFinite(body.maxBodyChars)) patch.maxBodyChars = Math.min(500000, Math.max(100, body.maxBodyChars))
  if (Number.isFinite(body.maxCsvRows)) patch.maxCsvRows = Math.min(10000, Math.max(1, body.maxCsvRows))
  if (Number.isFinite(body.minDelayMs)) patch.minDelayMs = Math.min(60000, Math.max(0, body.minDelayMs))
  if (Number.isFinite(body.maxDelayMs)) patch.maxDelayMs = Math.min(300000, Math.max(100, body.maxDelayMs))
  if (Number.isFinite(body.tickSeconds)) patch.tickSeconds = Math.min(3600, Math.max(5, body.tickSeconds))
  if (body.providers && typeof body.providers === 'object' && !Array.isArray(body.providers)) {
    patch.providers = body.providers
  }
  return patch
}

function safeSettings(eff) {
  const out = { ...eff, providers: {} }
  for (const [id, p] of Object.entries(eff.providers || {})) {
    const masked = { ...p }
    for (const key of Object.keys(masked)) {
      if (/key|pass|password|secret/i.test(key) && typeof masked[key] === 'string' && masked[key]) {
        masked[key] = '***'
      }
    }
    out.providers[id] = masked
  }
  return out
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// Default export wrapping the full namespace. This ensures cordis-plugin-loader's
// unwrapExports always resolves to an object with { name, inject, apply }.
export default { name: 'dsh-mail', apply, inject: ['tools', 'webServer', 'settings'], resolveConfig, resolveDefineTool, PLUGIN_ID }
