/**
 * dsh-mail: host half.
 *
 * Mail for agents and humans in the DeepSeek Harness:
 *   - accounts (IMAP + SMTP, POP3 + SMTP, Tzekos Mail, Lettermint, Resend,
 *     AgentMail, v0.1 provider settings through a legacy shim)
 *   - a local cache (node:sqlite) synced by polling
 *   - the Mail sidebar tab (lib/client.js) and a DSH Settings section
 *   - the mail_* agent tools (lib/tools.js)
 *
 * Settings live in the dsh-mail namespace of ~/.dsh/settings.yaml. Credential
 * files are read, never written. Every route sits behind lib/security.js:
 * reads need a loopback peer and a trusted Host; mutations also need the
 * capability token and the harness browser cookie.
 */

'use strict'

import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'

import { Queue, personalise } from './staging.js'
import { loadOrCreateSecret, mintToken, checkReadRequest, checkMutateRequest } from './security.js'
import {
  resolveAccounts, normalizeAccount, validateAccount, redactAccount, mergeSecrets, secretValues, scrub as scrubWith,
  effectiveConfirmMode, defaultAccountId, accountSummary, isLegacyInstall, TYPES, SECRET_KEYS,
} from './accounts.js'
import { MailCache } from './cache.js'
import { ImapPool } from './imap.js'
import { MailService, receiveKind, parseId } from './service.js'
import { Drafts } from './drafts.js'
import { SettingsStore } from './settings-store.js'
import { registerTools } from './tools.js'
import { addrList, loadAttachments } from './smtp.js'

export const name = 'dsh-mail'
export const inject = ['tools', 'webServer', 'settings']

export const PLUGIN_ID = 'dsh-mail'
const API_PREFIX = '/' + PLUGIN_ID + '/api'
const DISABLE_ENV = 'DSH_MAIL_DISABLE'
const VERSION = '0.2.0'
const SETTINGS_NS = PLUGIN_ID

export const DEFAULTS = {
  enabled: true,
  // v0.1 defaulted to 'lettermint'. v2 leaves it empty: the account flagged
  // agent.default wins, installs on the legacy shim still fall back to
  // lettermint (see accounts.js defaultAccountId).
  defaultProvider: '',
  defaultFrom: '',
  defaultReplyTo: '',
  trustedHosts: [],
  requireHarnessCookie: true,
  maxRecipients: 500,
  maxBodyChars: 100000,
  maxCsvRows: 1000,
  minDelayMs: 500,
  maxDelayMs: 60000,
  tickSeconds: 30,
  mailboxBaseUrl: '',
  mailboxAgentToken: '',
  agents: { enabled: true, maxBodyChars: 8000, logBodies: false },
  cache: { enabled: true, retentionDays: 90, storeBodies: true, syncDays: 90, initialMax: 1000, pollSeconds: 300 },
  accounts: [],
  providers: {
    lettermint: { lettermintApiKey: '', lettermintBaseURL: 'https://api.lettermint.co/v1' },
    agentmail: { agentmailApiKey: '', agentmailInbox: '', agentmailBaseURL: 'https://api.agentmail.to/v0' },
    resend: { resendApiKey: '', resendBaseURL: 'https://api.resend.com' },
    ovh: { smtpHost: 'ssl0.ovh.net', smtpPort: 465, smtpSecure: true, smtpUser: '', smtpPass: '', smtpFrom: '' },
    smtp: { smtpHost: '', smtpPort: 587, smtpSecure: false, smtpUser: '', smtpPass: '', smtpFrom: '', smtpLabel: 'smtp' },
    local: { smtpHost: '', smtpPort: 587, smtpSecure: false, smtpUser: '', smtpPass: '', smtpFrom: '', smtpLabel: 'local' },
    tzmail: { tzmailBaseURL: '', tzmailUser: '', tzmailPass: '', tzmailAccounts: '' },
  },
}

// ── config resolution ───────────────────────────────────────────────────────

function isObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v) }

export function resolveConfig(config = {}) {
  const c = isObj(config) ? config : {}
  return {
    ...DEFAULTS,
    ...c,
    trustedHosts: Array.isArray(c.trustedHosts) ? c.trustedHosts : DEFAULTS.trustedHosts,
    requireHarnessCookie: c.requireHarnessCookie !== false,
    agents: { ...DEFAULTS.agents, ...(isObj(c.agents) ? c.agents : {}) },
    cache: { ...DEFAULTS.cache, ...(isObj(c.cache) ? c.cache : {}) },
    accounts: Array.isArray(c.accounts) ? c.accounts : [],
    providers: { ...DEFAULTS.providers, ...(isObj(c.providers) ? c.providers : {}) },
  }
}

function dshHome() { return process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh') }

export function resolveDefineTool(env = process.env) {
  const bases = []
  if (env.DSH_MAIL_TOOLS_MAIN) bases.push(env.DSH_MAIL_TOOLS_MAIN)
  bases.push(import.meta.url)
  bases.push(join(homedir(), '.dsh', 'profiles', 'web', 'probe.js'))
  if (process.argv && process.argv[1]) bases.push(process.argv[1])
  for (const base of bases) {
    try {
      const mod = createRequire(base)('@deepseek-ai/dsh-tools')
      const fn = mod && (mod.defineTool || (mod.default && mod.default.defineTool))
      if (typeof fn === 'function') return fn
    } catch {}
  }
  return null
}

export function loadSchemastery() {
  const req = createRequire(import.meta.url)
  const candidates = []
  if (process.env.DSH_SCHEMASTERY_ENTRY) candidates.push(process.env.DSH_SCHEMASTERY_ENTRY)
  for (const prefix of [process.env.DSH_GLOBAL_PREFIX, join(homedir(), '.local'), resolve(process.execPath, '..', '..')].filter(Boolean)) {
    candidates.push(join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.cjs'))
  }
  for (const c of candidates) {
    try { if (req('node:fs').existsSync(c)) return createRequire(c)(c) } catch {}
  }
  try { return req('@deepseek-ai/schemastery') } catch {}
  return null
}

/**
 * The schema shown by the generic DSH Settings form. `accounts` and the
 * legacy `providers` block are hidden there: the custom "Mail" settings
 * section edits accounts with secret redaction.
 */
export function settingsSchema(z) {
  if (!z) return null
  const D = DEFAULTS
  const secret = s => (typeof s.role === 'function' ? s.role('secret') : s)
  const hidden = s => (typeof s.hidden === 'function' ? s.hidden() : s)
  const P = D.providers
  return z.object({
    enabled: z.boolean().default(D.enabled).description('Master switch for the Mail tab, routes and tools.'),
    defaultProvider: z.string().default(D.defaultProvider).description('Account id used when a tool omits account/provider. Empty: the account marked as agent default.'),
    defaultFrom: z.string().default(D.defaultFrom).description('Fallback From address.'),
    defaultReplyTo: z.string().default(D.defaultReplyTo),
    trustedHosts: z.array(z.string()).default(D.trustedHosts).description('Host names (besides loopback) the API accepts, e.g. the public name of this DSH.'),
    requireHarnessCookie: z.boolean().default(D.requireHarnessCookie),
    maxRecipients: z.number().min(1).default(D.maxRecipients),
    maxBodyChars: z.number().min(100).default(D.maxBodyChars),
    maxCsvRows: z.number().min(1).default(D.maxCsvRows),
    minDelayMs: z.number().min(0).default(D.minDelayMs),
    maxDelayMs: z.number().min(100).default(D.maxDelayMs),
    tickSeconds: z.number().min(5).default(D.tickSeconds),
    mailboxBaseUrl: z.string().default('').description('Legacy: Tzekos Mail base URL (used when no accounts are configured).'),
    mailboxAgentToken: hidden(secret(z.string().default(''))),
    schemaVersion: hidden(z.number()),
    agents: z.object({
      enabled: z.boolean().default(D.agents.enabled).description('Register and allow the mail_* agent tools.'),
      confirmMode: z.union([z.const('all'), z.const('reply-only')]).description('all: every agent send is drafted first and needs confirm:true. reply-only: only mail_reply drafts (v0.1 behaviour). Empty: all, except installs that still run on legacy provider settings.'),
      maxBodyChars: z.number().min(200).default(D.agents.maxBodyChars).description('Per message cap for bodies returned to agents.'),
      logBodies: z.boolean().default(D.agents.logBodies),
      allowedAccounts: z.array(z.string()).description('Optional override: only these account ids are visible to agents.'),
    }).default({}),
    cache: z.object({
      enabled: z.boolean().default(D.cache.enabled),
      retentionDays: z.number().default(D.cache.retentionDays).description('Keep cached message text for N days. 0 = headers only, -1 = keep.'),
      storeBodies: z.boolean().default(D.cache.storeBodies),
      syncDays: z.number().min(1).default(D.cache.syncDays).description('Initial sync window per folder (days).'),
      initialMax: z.number().min(10).default(D.cache.initialMax).description('Initial sync: newest N messages per folder at most.'),
      pollSeconds: z.number().min(30).default(D.cache.pollSeconds).description('Background poll interval for the Inbox of every IMAP/POP3 account.'),
    }).default({}),
    accounts: hidden(z.array(z.any()).default([])),
    providers: hidden(z.object({
      lettermint: z.object({ lettermintApiKey: secret(z.string().default('')), lettermintBaseURL: z.string().default(P.lettermint.lettermintBaseURL) }).default({}),
      agentmail: z.object({ agentmailApiKey: secret(z.string().default('')), agentmailInbox: z.string().default(''), agentmailBaseURL: z.string().default(P.agentmail.agentmailBaseURL) }).default({}),
      resend: z.object({ resendApiKey: secret(z.string().default('')), resendBaseURL: z.string().default(P.resend.resendBaseURL) }).default({}),
      ovh: z.object({ smtpHost: z.string().default(P.ovh.smtpHost), smtpPort: z.number().default(P.ovh.smtpPort), smtpSecure: z.boolean().default(P.ovh.smtpSecure), smtpUser: z.string().default(''), smtpPass: secret(z.string().default('')), smtpFrom: z.string().default('') }).default({}),
      smtp: z.object({ smtpHost: z.string().default(''), smtpPort: z.number().default(P.smtp.smtpPort), smtpSecure: z.boolean().default(P.smtp.smtpSecure), smtpUser: z.string().default(''), smtpPass: secret(z.string().default('')), smtpFrom: z.string().default(''), smtpLabel: z.string().default('smtp') }).default({}),
      local: z.object({ smtpHost: z.string().default(''), smtpPort: z.number().default(P.local.smtpPort), smtpSecure: z.boolean().default(P.local.smtpSecure), smtpUser: z.string().default(''), smtpPass: secret(z.string().default('')), smtpFrom: z.string().default(''), smtpLabel: z.string().default('local') }).default({}),
      tzmail: z.object({ tzmailBaseURL: z.string().default(''), tzmailUser: z.string().default(''), tzmailPass: secret(z.string().default('')), tzmailAccounts: z.string().default('') }).default({}),
    }).default({})),
  })
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

function readJsonBody(req, max = 256 * 1024) {
  return new Promise((fulfil, reject) => {
    let size = 0; const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > max) { reject(new Error('request body too large')); req.destroy(); return }
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
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(payload))
}

/** Settings view for read routes: every secret redacted, accounts excluded (see /accounts). */
export function safeSettings(eff) {
  const out = { ...eff, providers: {}, accounts: undefined }
  if (out.mailboxAgentToken) out.mailboxAgentToken = '__set__'
  for (const [id, p] of Object.entries(eff.providers || {})) {
    const masked = { ...p }
    for (const key of Object.keys(masked)) if (/key|pass|password|secret|token/i.test(key) && typeof masked[key] === 'string' && masked[key]) masked[key] = '__set__'
    out.providers[id] = masked
  }
  delete out.accounts
  return out
}

export function sanitizeSettingsPatch(body) {
  const patch = {}
  if (!isObj(body)) return patch
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
  if (typeof body.defaultProvider === 'string') patch.defaultProvider = body.defaultProvider.slice(0, 32)
  if (typeof body.defaultFrom === 'string' && !/[\r\n]/.test(body.defaultFrom)) patch.defaultFrom = body.defaultFrom.slice(0, 400)
  if (typeof body.defaultReplyTo === 'string' && !/[\r\n]/.test(body.defaultReplyTo)) patch.defaultReplyTo = body.defaultReplyTo.slice(0, 400)
  const n = (k, lo, hi) => { if (Number.isFinite(body[k])) patch[k] = Math.min(hi, Math.max(lo, body[k])) }
  n('maxRecipients', 1, 10000); n('maxBodyChars', 100, 500000); n('maxCsvRows', 1, 10000); n('minDelayMs', 0, 60000); n('maxDelayMs', 100, 300000); n('tickSeconds', 5, 3600)
  if (isObj(body.agents)) {
    const a = {}
    if (typeof body.agents.enabled === 'boolean') a.enabled = body.agents.enabled
    if (body.agents.confirmMode === 'all' || body.agents.confirmMode === 'reply-only') a.confirmMode = body.agents.confirmMode
    if (Number.isFinite(body.agents.maxBodyChars)) a.maxBodyChars = Math.min(100000, Math.max(200, body.agents.maxBodyChars))
    if (Object.keys(a).length) patch.agents = a
  }
  if (isObj(body.cache)) {
    const c = {}
    if (typeof body.cache.enabled === 'boolean') c.enabled = body.cache.enabled
    if (typeof body.cache.storeBodies === 'boolean') c.storeBodies = body.cache.storeBodies
    if (Number.isFinite(body.cache.retentionDays)) c.retentionDays = Math.min(3650, Math.max(-1, Math.round(body.cache.retentionDays)))
    if (Number.isFinite(body.cache.pollSeconds)) c.pollSeconds = Math.min(86400, Math.max(30, body.cache.pollSeconds))
    if (Object.keys(c).length) patch.cache = c
  }
  return patch
}

/** The stored form of an account (what goes into settings.yaml). */
export function storableAccount(acc) {
  const o = structuredClone(acc)
  delete o.legacy; delete o.legacyProvider; delete o.legacyCreds; delete o.tokenFromFile
  if (!o.passwordFile) delete o.passwordFile
  if (!o.passwordEnv) delete o.passwordEnv
  if (!Object.keys(o.secrets || {}).length) delete o.secrets
  return o
}

/**
 * Upsert one account from the editor into the explicit account list.
 * Secrets: "__set__" keeps the stored value, "" clears, anything else replaces.
 */
export function upsertAccount(storedList, incoming, originalId) {
  const list = (Array.isArray(storedList) ? storedList : []).map((a, i) => normalizeAccount(a, i))
  const origId = originalId || incoming.id
  const idx = list.findIndex(a => a.id === origId)
  const prev = idx >= 0 ? list[idx] : null
  if (prev && incoming.id !== prev.id) throw new Error('account ids are immutable')
  const secrets = mergeSecrets(incoming.secrets, prev ? prev.secrets : {})
  const acc = normalizeAccount({ ...incoming, secrets }, idx >= 0 ? idx : list.length)
  const others = list.filter((_, i) => i !== idx)
  const errs = validateAccount(acc, others)
  if (errs.length) throw new Error(errs.join('; '))
  if (acc.agent.default) for (const o of others) o.agent.default = false
  if (acc.isDefaultSender) for (const o of others) o.isDefaultSender = false
  const next = idx >= 0 ? list.map((a, i) => (i === idx ? acc : a)) : [...list, acc]
  return { list: next.map(storableAccount), account: acc }
}

// ── the plugin ──────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  if (process.env[DISABLE_ENV] === '1') {
    console.log('dsh-mail: ' + DISABLE_ENV + '=1, armed off')
    return
  }

  const dataDir = process.env.DSH_MAIL_DATA_DIR ? resolve(process.env.DSH_MAIL_DATA_DIR) : join(dshHome(), 'mail')
  const queue = new Queue(join(dataDir, 'queue'))
  const drafts = new Drafts(join(dataDir, 'drafts'))
  const secretPath = join(dataDir, 'capability.secret')
  const log = m => console.log('dsh-mail: ' + m)
  const warn = m => console.error('dsh-mail: ' + m)

  const z = loadSchemastery()
  const store = new SettingsStore({ ctx, config, ns: SETTINGS_NS, schema: settingsSchema(z), defaults: DEFAULTS, dataDir, dshHome: dshHome(), log, warn })
  const sd = store.describe()
  log('settings: ' + sd.mode + (sd.file ? ' (' + sd.file + (sd.legacySource ? ', legacy values from ' + sd.legacySource : '') + ')' : ''))
  const scope = store

  const effective = () => resolveConfig(store.get())
  const resolved = () => resolveAccounts(effective())
  const scrub = m => scrubWith(m, secretValues(resolved().all))

  let cache = null
  const getCache = () => { if (!cache) cache = new MailCache(join(dataDir, 'cache.db'), { log }); return cache }
  const pool = new ImapPool()

  // SSE clients
  const sse = new Set()
  const emit = ev => { const line = 'event: ' + (ev.type || 'message') + '\ndata: ' + JSON.stringify(ev) + '\n\n'; for (const res of sse) { try { res.write(line) } catch {} } }

  const service = new MailService({
    get cache() { return getCache() },
    pool, settings: effective, accounts: resolved, log, warn, scrub, onChange: emit,
  })
  Object.defineProperty(service, 'cache', { get: getCache })

  let secret = null
  loadOrCreateSecret(secretPath).then(s => { secret = s }).catch(e => warn('secret: ' + e.message))

  // ── agent tools ──
  const defineTool = process.env.DSH_MAIL_TEST_IDENTITY_TOOLS === '1' ? (def => def) : resolveDefineTool()
  if (effective().agents.enabled === false) log('agents.enabled is false: mail tools not registered')
  else if (defineTool && ctx.tools && typeof ctx.tools.register === 'function') {
    try { registerTools(defineTool, ctx, { effective, resolved, service, queue, drafts, dataDir, scrub }) }
    catch (e) { warn('tool registration failed: ' + e.message) }
  } else warn('defineTool or ctx.tools unavailable: agent tools not registered (the tab still works)')

  // ── timers: queue + background sync + retention ──
  async function processQueue() {
    const due = await queue.due()
    if (!due.length) return
    log('processing ' + due.length + ' queued email(s)')
    for (const entry of due) await sendQueueEntry(entry).catch(e => warn('queue send failed for ' + entry.id + ': ' + scrub(e.message)))
  }

  async function sendQueueEntry(entry) {
    const settings = effective()
    const acc = resolved().all.find(a => a.id === entry.provider)
    if (!acc) { await queue.setStatus(entry.id, 'failed', { lastError: 'provider ' + entry.provider + ' is not configured', attempts: (entry.attempts || 0) + 1 }); return { ok: false, error: 'provider not configured' } }
    try {
      if (entry.csvData && Array.isArray(entry.csvData.rows) && entry.csvData.rows.length) {
        let sent = 0, failed = 0
        await queue.setStatus(entry.id, 'sending', {})
        for (const row of entry.csvData.rows) {
          const to = row.email || row.Email || row[Object.keys(row).find(k => k.toLowerCase().includes('email'))]
          if (!to) { failed++; continue }
          try {
            await service.send(acc, { from: entry.msg.from || '', to: [to], subject: personalise(entry.msg.subject, row), text: personalise(entry.msg.text, row), replyTo: entry.msg.replyTo || settings.defaultReplyTo })
            sent++
            if (entry.delayMs) await new Promise(r => setTimeout(r, Math.min(settings.maxDelayMs, Math.max(settings.minDelayMs, entry.delayMs))))
          } catch (e) { failed++; warn('mass send row failed: ' + scrub(e.message)) }
        }
        await queue.setStatus(entry.id, 'sent', { sentCount: sent, failedCount: failed, sentMessageId: 'mass-send' })
        return { ok: true, messageId: 'mass-send', sent, failed }
      }
      const r = await service.send(acc, { ...entry.msg, to: addrList(entry.msg.to) })
      await queue.setStatus(entry.id, 'sent', { sentMessageId: r.messageId })
      return { ok: true, messageId: r.messageId }
    } catch (e) {
      await queue.setStatus(entry.id, 'failed', { lastError: scrub(String(e.message)).slice(0, 500), attempts: (entry.attempts || 0) + 1 })
      return { ok: false, error: scrub(e.message) }
    }
  }

  let lastPoll = 0
  let lastPrune = 0
  async function backgroundSync() {
    const s = effective()
    if (!s.enabled || s.cache.enabled === false) return
    const now = Date.now()
    if (now - lastPoll >= Math.max(30, Number(s.cache.pollSeconds) || 300) * 1000) {
      lastPoll = now
      for (const acc of resolved().all) {
        const k = receiveKind(acc)
        if (!acc.enabled || (k !== 'imap' && k !== 'pop3')) continue
        await service.sync(acc, 'INBOX').catch(() => {})
      }
    }
    if (now - lastPrune > 3600 * 1000) { lastPrune = now; try { if (cache) cache.prune(s.cache.retentionDays) } catch {} }
  }

  const tick = setInterval(() => { void processQueue().catch(() => {}); void backgroundSync().catch(() => {}) }, Math.max(5, effective().tickSeconds || 30) * 1000)
  if (tick.unref) tick.unref()
  const heartbeat = setInterval(() => { for (const res of sse) { try { res.write(': ping\n\n') } catch {} } }, 25000)
  if (heartbeat.unref) heartbeat.unref()

  // ── routes ──
  const handler = async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://dsh-mail.local')
      const path = url.pathname.replace(/\/+$/, '') || '/'
      const sub = path.startsWith(API_PREFIX) ? path.slice(API_PREFIX.length) : path
      const settings = effective()
      const readGate = () => {
        const g = checkReadRequest(req, { trustedHosts: settings.trustedHosts })
        if (!g.ok) sendJson(res, g.status, { error: g.reason })
        return g.ok
      }
      const mutateGate = () => {
        const g = checkMutateRequest(req, { trustedHosts: settings.trustedHosts, secret, requireHarnessCookie: settings.requireHarnessCookie })
        if (!g.ok) sendJson(res, g.status, { error: g.reason, layer: g.layer })
        return g.ok
      }
      const q = k => url.searchParams.get(k) || ''

      if (req.method === 'GET' && sub === '/session') {
        if (!readGate()) return
        if (!secret) { sendJson(res, 503, { error: 'secret not ready' }); return }
        sendJson(res, 200, { token: mintToken(secret) })
        return
      }

      if (req.method === 'GET' && sub === '/state') {
        if (!readGate()) return
        const r = resolved()
        const queueList = await queue.list()
        const draftList = await drafts.list()
        const accounts = r.all.map(a => {
          const sum = accountSummary(a)
          const st = service.status.get(a.id)
          const k = receiveKind(a)
          let unread = null
          if ((k === 'imap' || k === 'pop3') && cache) { const f = cache.folder(a.id, 'INBOX'); unread = f ? f.unseen : null }
          return { ...sum, receive: k, status: st || null, unread }
        })
        sendJson(res, 200, {
          ok: true, version: VERSION,
          settings: safeSettings(settings),
          confirmMode: effectiveConfirmMode(settings, r),
          defaultAccount: defaultAccountId(settings, r),
          legacyInstall: isLegacyInstall(r),
          cacheKind: cache ? cache.kind : null,
          accounts,
          providers: Object.fromEntries(r.all.map(a => [a.id, { enabled: a.enabled, name: a.label }])),
          queue: queueList.slice(0, 100),
          drafts: draftList.slice(0, 50).map(d => ({ id: d.id, account: d.account, to: d.to, cc: d.cc, subject: d.subject, text: String(d.text || '').slice(0, 2000), by: d.by, attachments: d.attachments, updatedAt: d.updatedAt })),
          queueCounts: {
            pending: queueList.filter(x => x.status === 'queued' || x.status === 'scheduled').length + draftList.length,
            sent: queueList.filter(x => x.status === 'sent').length,
            failed: queueList.filter(x => x.status === 'failed').length,
            cancelled: queueList.filter(x => x.status === 'cancelled').length,
          },
        })
        return
      }

      if (req.method === 'GET' && sub === '/accounts') {
        if (!readGate()) return
        const r = resolved()
        sendJson(res, 200, {
          ok: true,
          accounts: r.explicit.map(a => ({ ...redactAccount(a), capabilities: accountSummary(a).capabilities })),
          legacy: r.legacy.map(a => ({ ...redactAccount(a), capabilities: accountSummary(a).capabilities })),
          types: Object.entries(TYPES).map(([id, t]) => ({ id, label: t.label, receive: t.receive, send: t.send, unsupported: t.unsupported || '' })),
          confirmMode: effectiveConfirmMode(settings, r),
          settingsStore: store.describe(),
          settings: { defaultProvider: settings.defaultProvider, agents: { enabled: settings.agents.enabled, confirmMode: settings.agents.confirmMode || '' }, cache: settings.cache },
          secretKeys: SECRET_KEYS,
        })
        return
      }

      if (req.method === 'GET' && sub === '/folders') {
        if (!readGate()) return
        try {
          const acc = service.account(q('account'))
          sendJson(res, 200, { ok: true, account: acc.id, folders: await service.folders(acc) })
        } catch (e) { sendJson(res, 400, { ok: false, error: scrub(e.message) }) }
        return
      }

      if (req.method === 'GET' && sub === '/messages') {
        if (!readGate()) return
        try {
          const out = await service.list({ account: q('account') || 'all', folder: q('folder'), q: q('q'), filter: q('filter'), limit: Math.min(200, Number(q('limit')) || 50), offset: Math.max(0, Number(q('offset')) || 0), sync: q('sync') !== '0' })
          sendJson(res, 200, { ok: true, ...out })
        } catch (e) { sendJson(res, 400, { ok: false, error: scrub(e.message) }) }
        return
      }

      if (req.method === 'GET' && sub === '/thread') {
        if (!readGate()) return
        try { sendJson(res, 200, { ok: true, ...(await service.thread(q('account'), q('thread'), q('folder'))) }) }
        catch (e) { sendJson(res, 400, { ok: false, error: scrub(e.message) }) }
        return
      }

      if (req.method === 'GET' && sub === '/message') {
        if (!readGate()) return
        try { sendJson(res, 200, { ok: true, message: await service.message(q('id'), { images: q('images') === '1' }) }) }
        catch (e) { sendJson(res, 400, { ok: false, error: scrub(e.message) }) }
        return
      }

      if (req.method === 'GET' && sub === '/attachment') {
        if (!readGate()) return
        try {
          const a = await service.attachment(q('id'), q('part'))
          const inline = q('inline') === '1' && /^image\/(png|jpeg|gif|webp)$/i.test(a.contentType)
          res.writeHead(200, {
            'content-type': inline ? a.contentType : 'application/octet-stream',
            'content-length': a.content.length,
            'content-disposition': (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(a.filename),
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; sandbox",
            'cache-control': 'no-store',
          })
          res.end(a.content)
        } catch (e) { sendJson(res, 400, { ok: false, error: scrub(e.message) }) }
        return
      }

      if (req.method === 'GET' && sub === '/events') {
        if (!readGate()) return
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
        res.write('event: hello\ndata: {"ok":true}\n\n')
        sse.add(res)
        req.on('close', () => sse.delete(res))
        return
      }

      // ── mutations ──
      if (req.method !== 'POST') { sendJson(res, req.method === 'GET' ? 404 : 405, { error: req.method === 'GET' ? 'not found' : 'method not allowed' }); return }
      if (!mutateGate()) return
      const body = await readJsonBody(req)

      if (sub === '/send') {
        try {
          const r = resolved()
          const id = body.account || body.provider || defaultAccountId(settings, r)
          const acc = r.all.find(a => a.id === id)
          if (!acc) { sendJson(res, 400, { error: 'provider ' + id + ' is not configured' }); return }
          const attachments = Array.isArray(body.attachments) && body.attachments.length ? await loadAttachments(body.attachments) : undefined
          const sig = acc.signature && body.text ? '\n\n' + acc.signature : ''
          const out = await service.send(acc, { from: body.from || '', to: addrList(body.to), cc: addrList(body.cc), bcc: addrList(body.bcc), subject: body.subject || '', text: (body.text || '') + sig, html: body.html || '', replyTo: body.replyTo || '', inReplyTo: body.inReplyTo || '', references: body.references || '', threadId: body.threadId || undefined, attachments })
          sendJson(res, 200, { ok: true, messageId: out.messageId, from: out.from, provider: acc.id })
        } catch (e) { sendJson(res, 400, { error: scrub(e.message) }) }
        return
      }

      if (sub === '/queue/send' || sub === '/queue/approve') {
        try {
          const entry = await queue.read(body.id)
          if (!entry) { sendJson(res, 404, { error: 'not found' }); return }
          if (entry.status === 'sent') { sendJson(res, 400, { error: 'already sent' }); return }
          if (sub === '/queue/approve' && entry.requestedSendAt && entry.requestedSendAt * 1000 > Date.now()) {
            await queue.setStatus(entry.id, 'scheduled', { sendAt: entry.requestedSendAt, note: 'approved' })
            sendJson(res, 200, { ok: true, scheduled: true }); return
          }
          const r = await sendQueueEntry(entry)
          sendJson(res, r.ok ? 200 : 400, r.ok ? { ok: true, messageId: r.messageId } : { error: r.error })
        } catch (e) { sendJson(res, 400, { error: scrub(e.message) }) }
        return
      }

      if (sub === '/queue/cancel') {
        try { await queue.cancel(body.id, { by: 'ui' }); sendJson(res, 200, { ok: true }) } catch (e) { sendJson(res, 400, { error: e.message }) }
        return
      }
      if (sub === '/queue/delete') {
        try { await queue.delete(body.id); sendJson(res, 200, { ok: true }) } catch (e) { sendJson(res, 400, { error: e.message }) }
        return
      }

      if (sub === '/drafts/send') {
        try {
          const dr = await drafts.read(body.id)
          if (!dr) { sendJson(res, 404, { error: 'no draft' }); return }
          const acc = service.account(dr.account)
          const attachments = dr.attachments && dr.attachments.length ? await loadAttachments(dr.attachments) : undefined
          const out = await service.send(acc, { ...dr, to: addrList(dr.to), cc: addrList(dr.cc), bcc: addrList(dr.bcc), attachments, text: dr.text + (acc.signature ? '\n\n' + acc.signature : '') })
          await drafts.remove(dr.id)
          sendJson(res, 200, { ok: true, messageId: out.messageId })
        } catch (e) { sendJson(res, 400, { error: scrub(e.message) }) }
        return
      }
      if (sub === '/drafts/delete') {
        try { await drafts.remove(body.id); sendJson(res, 200, { ok: true }) } catch (e) { sendJson(res, 400, { error: e.message }) }
        return
      }

      if (sub === '/messages/mark') {
        try { sendJson(res, 200, { ok: true, ...(await service.mark(body.ids, body.op)) }) } catch (e) { sendJson(res, 400, { ok: false, error: scrub(e.message) }) }
        return
      }
      if (sub === '/messages/move') {
        try { sendJson(res, 200, { ok: true, ...(await service.move(body.ids, body.to)) }) } catch (e) { sendJson(res, 400, { ok: false, error: scrub(e.message) }) }
        return
      }
      if (sub === '/sync') {
        try {
          const accs = body.account ? [service.account(body.account)] : resolved().all.filter(a => a.enabled)
          const out = {}
          for (const a of accs) { try { out[a.id] = await service.sync(a, body.folder || 'INBOX', { force: true }) } catch (e) { out[a.id] = { error: scrub(e.message) } } }
          sendJson(res, 200, { ok: true, results: out })
        } catch (e) { sendJson(res, 400, { ok: false, error: scrub(e.message) }) }
        return
      }

      if (sub === '/accounts/save') {
        if (!scope.canWrite()) { sendJson(res, 503, { ok: false, error: 'settings service unavailable' }); return }
        try {
          const { list, account } = upsertAccount(settings.accounts, isObj(body.account) ? body.account : {}, body.originalId)
          await scope.update({ accounts: list })
          pool.close(account.id).catch(() => {})
          sendJson(res, 200, { ok: true, account: redactAccount(account) })
        } catch (e) { sendJson(res, 400, { ok: false, error: scrub(e.message) }) }
        return
      }
      if (sub === '/accounts/remove') {
        if (!scope.canWrite()) { sendJson(res, 503, { ok: false, error: 'settings service unavailable' }); return }
        try {
          const id = String(body.id || '')
          const list = settings.accounts.filter(a => a && a.id !== id)
          if (list.length === settings.accounts.length) { sendJson(res, 404, { ok: false, error: 'no explicit account ' + id + ' (legacy accounts come from the providers settings)' }); return }
          await scope.update({ accounts: list })
          await pool.close(id).catch(() => {})
          try { getCache().wipeAccount(id) } catch {}
          for (const e of await queue.list()) if (e.provider === id && (e.status === 'queued' || e.status === 'scheduled')) await queue.cancel(e.id, { by: 'account removed' }).catch(() => {})
          for (const dr of await drafts.list()) if (dr.account === id) await drafts.remove(dr.id).catch(() => {})
          sendJson(res, 200, { ok: true })
        } catch (e) { sendJson(res, 400, { ok: false, error: scrub(e.message) }) }
        return
      }
      if (sub === '/accounts/test') {
        try {
          let acc
          if (isObj(body.account)) {
            const prev = settings.accounts.map((a, i) => normalizeAccount(a, i)).find(a => a.id === (body.originalId || body.account.id))
            const legacyPrev = resolved().all.find(a => a.id === body.account.id)
            acc = normalizeAccount({ ...body.account, secrets: mergeSecrets(body.account.secrets, (prev || legacyPrev || {}).secrets) })
            if (!prev && legacyPrev && legacyPrev.legacy) acc = legacyPrev
          } else acc = service.account(String(body.id || ''))
          const t = await service.test(acc)
          sendJson(res, 200, { ok: true, result: { ...t, steps: t.steps.map(s => ({ ...s, detail: scrub(s.detail) })) } })
        } catch (e) { sendJson(res, 400, { ok: false, error: scrub(e.message) }) }
        return
      }
      if (sub === '/settings') {
        if (!scope.canWrite()) { sendJson(res, 503, { ok: false, error: 'settings service unavailable' }); return }
        await scope.update(sanitizeSettingsPatch(body.settings || body))
        sendJson(res, 200, { ok: true, settings: safeSettings(effective()) })
        return
      }
      if (sub === '/cache/wipe') {
        try { if (body.account) getCache().wipeAccount(String(body.account)); else for (const a of resolved().all) getCache().wipeAccount(a.id); service.lastSync.clear(); sendJson(res, 200, { ok: true }) }
        catch (e) { sendJson(res, 400, { ok: false, error: e.message }) }
        return
      }

      sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      try { if (res.headersSent) { res.end(); return } sendJson(res, 400, { error: scrub(String(error.message || error)) }) } catch {}
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler }), 'dsh-mail: api route')

  void (async () => {
    await queue.init().catch(() => {})
    log('armed: route ' + API_PREFIX + ', data ' + dataDir)
  })().catch(e => warn('init crashed: ' + e.message))

  ctx.effect(() => () => {
    clearInterval(tick)
    clearInterval(heartbeat)
    for (const res of sse) { try { res.end() } catch {} }
    sse.clear()
    pool.close().catch(() => {})
    if (cache) cache.close()
  }, 'dsh-mail: cleanup')

  return { handler, service, effective, resolved }
}

export default { name: 'dsh-mail', apply, inject: ['tools', 'webServer', 'settings'], resolveConfig, resolveDefineTool, PLUGIN_ID }
