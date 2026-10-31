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
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'

import { Queue, personalise } from './staging.js'
import { loadOrCreateSecret, mintToken, checkReadRequest, checkMutateRequest } from './security.js'
import {
  resolveAccounts, normalizeAccount, validateAccount, redactAccount, mergeSecrets, secretValues, scrub as scrubWith, usesOAuth,
  effectiveConfirmMode, effectiveFirstContact, defaultAccountId, accountSummary, isLegacyInstall, TYPES, SECRET_KEYS,
} from './accounts.js'
import { MailCache } from './cache.js'
import { ImapPool } from './imap.js'
import { MailService, receiveKind, parseId } from './service.js'
import { Drafts } from './drafts.js'
import { createSettingsStore } from './settings-store.js'
import { loadHostSchemastery, liveObject } from './dual-settings.js'
import { E, classify, gateCode } from './errors.js'
import { SecretStore } from './secrets.js'
import { Audit, Suppression, OutboundState, runMassSend } from './outbound.js'
import { convertLegacy } from './convert.js'
import { handleSendgridInbound } from './inbound.js'
import { unsubKey, Campaigns, ListSuppression, HitLimiter, makeUnsubHandler, processUnsubMails, unsubAddresses, unsubListenHost, UNSUB_PATH, LANGS, bare } from './unsub.js'
import { renderBody, withSignature } from './compose.js'
import { Outbox } from './outbox.js'
import { IdleManager } from './idle.js'
import http from 'node:http'
import { registerTools } from './tools.js'
import { FlowStore } from './oauth.js'
import { TokenStore, TokenManager, deriveKey } from './tokens.js'
import { makeOAuthRoutes } from './oauth-routes.js'
import { addrList, loadAttachments } from './smtp.js'

export const name = 'dsh-mail'
export const inject = ['tools', 'webServer', 'settings']

export const PLUGIN_ID = 'dsh-mail'
export const PRESETS = JSON.parse(readFileSync(new URL('./presets.json', import.meta.url), 'utf8'))
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
  agents: { enabled: true, maxBodyChars: 8000, logBodies: false },
  cache: { enabled: true, retentionDays: 90, storeBodies: true, syncDays: 90, initialMax: 1000, pollSeconds: 300 },
  mass: { unsubscribeAbove: 50, breakerFailures: 5, jitterPct: 20 },
  audit: { enabled: true },
  oauth: { redirectBaseUrl: '' },
  unsubscribe: { publicBaseUrl: '', listenHost: '127.0.0.1', listenPort: 0, mailto: '', language: 'en', footer: true, texts: { en: '', it: '', el: '' } },
  compose: { undoSendSec: 6 },
  push: { maxAccounts: 5 },
  accounts: [],
  providers: {
    lettermint: { lettermintBaseURL: 'https://api.lettermint.co/v1' },
    agentmail: { agentmailInbox: '', agentmailBaseURL: 'https://api.agentmail.to/v0' },
    resend: { resendBaseURL: 'https://api.resend.com' },
    ovh: { smtpHost: 'ssl0.ovh.net', smtpPort: 465, smtpSecure: true, smtpUser: '', smtpFrom: '' },
    smtp: { smtpHost: '', smtpPort: 587, smtpSecure: false, smtpUser: '', smtpFrom: '', smtpLabel: 'smtp' },
    local: { smtpHost: '', smtpPort: 587, smtpSecure: false, smtpUser: '', smtpFrom: '', smtpLabel: 'local' },
    tzmail: { tzmailBaseURL: '', tzmailUser: '', tzmailAccounts: '' },
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
    oauth: { ...DEFAULTS.oauth, ...(isObj(c.oauth) ? c.oauth : {}) },
    unsubscribe: { ...DEFAULTS.unsubscribe, ...(isObj(c.unsubscribe) ? c.unsubscribe : {}), texts: { ...DEFAULTS.unsubscribe.texts, ...(isObj(c.unsubscribe) && isObj(c.unsubscribe.texts) ? c.unsubscribe.texts : {}) } },
    compose: { ...DEFAULTS.compose, ...(isObj(c.compose) ? c.compose : {}) },
    push: { ...DEFAULTS.push, ...(isObj(c.push) ? c.push : {}) },
    mass: { ...DEFAULTS.mass, ...(isObj(c.mass) ? c.mass : {}) },
    audit: { ...DEFAULTS.audit, ...(isObj(c.audit) ? c.audit : {}) },
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

/** The RUNNING harness's schemastery (on 0.2.x only its copy wraps live fields the way the Loader expects). */
export function loadSchemastery() { return loadHostSchemastery(import.meta.url) }

/**
 * The plugin Config. Every top-level key of a v0.1 `dsh-mail:` section is
 * declared (DSH 0.2 rejects a whole section with one undeclared key) and every
 * top-level field is live, so the 0.2 core can carry the section into the
 * profile row and forms can edit it. No secret is declared: passwords, API
 * keys, OAuth client secrets and tokens live in the 0600 files of the plugin
 * (lib/secrets.js, lib/tokens.js). `accounts` and the legacy `providers`
 * block are hidden from the generic form; the "Mail" settings section edits
 * them with redaction.
 */
export function settingsSchema(z) {
  if (!z) return null
  const D = DEFAULTS
  const hidden = s => (typeof s.hidden === 'function' ? s.hidden() : s)
  const P = D.providers
  return liveObject(z, {
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
    mailboxBaseUrl: z.string().default('').description('Legacy: Tzekos Mail base URL (used when no Tzekos Mail account is configured).'),
    schemaVersion: hidden(z.number()),
    agents: z.object({
      enabled: z.boolean().default(D.agents.enabled).description('Register and allow the mail_* agent tools.'),
      confirmMode: z.union([z.const('all'), z.const('reply-only')]).description('all: every agent send is drafted first and needs confirm:true. reply-only: only mail_reply drafts (v0.1 behaviour). Empty: all, except installs that still run on legacy provider settings.'),
      firstContactConfirm: z.boolean().description('Agents need confirm:true for the first message to a new recipient domain, even in reply-only mode. Empty: on, except installs that still run on legacy provider settings.'),
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
    mass: z.object({
      unsubscribeAbove: z.number().min(0).default(D.mass.unsubscribeAbove).description('Mass sends with more recipients need an unsubscribe address (List-Unsubscribe).'),
      breakerFailures: z.number().min(1).default(D.mass.breakerFailures).description('Stop a mass send after this many consecutive failures.'),
      jitterPct: z.number().min(0).max(50).default(D.mass.jitterPct).description('Random +- percentage on the delay between mass-send messages.'),
    }).default({}),
    audit: z.object({
      enabled: z.boolean().default(D.audit.enabled).description('Append sends and mailbox changes to the local audit log (no bodies).'),
    }).default({}),
    unsubscribe: z.object({
      publicBaseUrl: z.string().default('').description('Public https base for one-click unsubscribe links (the edge must route /dsh-mail-unsub/* to the unsubscribe listener without login). Empty: mailto only.'),
      listenHost: z.string().default(D.unsubscribe.listenHost).description('Loopback address of the small unsubscribe listener (127.0.0.1 or ::1; anything else falls back to 127.0.0.1). An edge proxy is the public side.'),
      listenPort: z.number().default(0).description('Port of the unsubscribe listener; 0 = off. Changes apply after a restart.'),
      mailto: z.string().default('').description('Mailbox for unsubscribe replies when an account has none (it must be read by one of the accounts).'),
      language: z.union([z.const('en'), z.const('it'), z.const('el')]).default('en').description('Default language of the unsubscribe footer and page.'),
      footer: z.boolean().default(true).description('Append a visible unsubscribe footer to mass mails.'),
      texts: z.object({ en: z.string().default(''), it: z.string().default(''), el: z.string().default('') }).default({}).description('Optional custom footer per language; placeholders {sender} {url} {mailto}.'),
    }).default({}),
    compose: z.object({
      undoSendSec: z.number().min(0).max(30).default(D.compose.undoSendSec).description('Hold messages sent from the tab this many seconds so they can be undone.'),
    }).default({}),
    push: z.object({
      maxAccounts: z.number().min(0).max(20).default(D.push.maxAccounts).description('At most this many accounts keep an IMAP IDLE connection for instant new mail.'),
    }).default({}),
    oauth: z.object({
      redirectBaseUrl: z.string().default('').description('Optional: public base URL of this DSH (https://host) for the OAuth redirect URI. Empty: taken from the request.'),
    }).default({}),
    accounts: hidden(z.array(z.any()).default([])),
    providers: hidden(z.object({
      lettermint: z.object({ lettermintBaseURL: z.string().default(P.lettermint.lettermintBaseURL) }).default({}),
      agentmail: z.object({ agentmailInbox: z.string().default(''), agentmailBaseURL: z.string().default(P.agentmail.agentmailBaseURL) }).default({}),
      resend: z.object({ resendBaseURL: z.string().default(P.resend.resendBaseURL) }).default({}),
      ovh: z.object({ smtpHost: z.string().default(P.ovh.smtpHost), smtpPort: z.number().default(P.ovh.smtpPort), smtpSecure: z.boolean().default(P.ovh.smtpSecure), smtpUser: z.string().default(''), smtpFrom: z.string().default('') }).default({}),
      smtp: z.object({ smtpHost: z.string().default(''), smtpPort: z.number().default(P.smtp.smtpPort), smtpSecure: z.boolean().default(P.smtp.smtpSecure), smtpUser: z.string().default(''), smtpFrom: z.string().default(''), smtpLabel: z.string().default('smtp') }).default({}),
      local: z.object({ smtpHost: z.string().default(''), smtpPort: z.number().default(P.local.smtpPort), smtpSecure: z.boolean().default(P.local.smtpSecure), smtpUser: z.string().default(''), smtpFrom: z.string().default(''), smtpLabel: z.string().default('local') }).default({}),
      tzmail: z.object({ tzmailBaseURL: z.string().default(''), tzmailUser: z.string().default(''), tzmailAccounts: z.string().default('') }).default({}),
    }).default({})),
  })
}

/** The plugin Config, built with the running harness's schemastery (undefined when it cannot be found). */
export const Config = settingsSchema(loadSchemastery()) || undefined

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
  if (isObj(body.unsubscribe)) {
    const u = {}
    const b = body.unsubscribe
    if (typeof b.publicBaseUrl === 'string' && (b.publicBaseUrl === '' || /^https:\/\/[^\s/]+(\/[^\s]*)?$/i.test(b.publicBaseUrl))) u.publicBaseUrl = b.publicBaseUrl.replace(/\/+$/, '')
    if (typeof b.mailto === 'string' && (b.mailto === '' || /^[^\s@<>]+@[^\s@<>]+$/.test(b.mailto))) u.mailto = b.mailto
    if (LANGS.includes(b.language)) u.language = b.language
    if (typeof b.footer === 'boolean') u.footer = b.footer
    if (isObj(b.texts)) { u.texts = {}; for (const l of LANGS) if (typeof b.texts[l] === 'string' && !/[<>]/.test(b.texts[l])) u.texts[l] = b.texts[l].slice(0, 600) }
    if (Number.isInteger(b.listenPort) && b.listenPort >= 0 && b.listenPort < 65536) u.listenPort = b.listenPort
    if (Object.keys(u).length) patch.unsubscribe = u
  }
  if (isObj(body.compose) && Number.isFinite(body.compose.undoSendSec)) patch.compose = { undoSendSec: Math.min(30, Math.max(0, Math.round(body.compose.undoSendSec))) }
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
  delete o.legacy; delete o.legacyProvider; delete o.legacyCreds; delete o.tokenFromFile; delete o.apiKeyFromFile
  if (!o.passwordFile) delete o.passwordFile
  if (!o.passwordEnv) delete o.passwordEnv
  if (!Object.keys(o.secrets || {}).length) delete o.secrets
  return o
}

/**
 * Upsert one account from the editor into the explicit account list.
 * Secrets: "__set__" keeps the stored value, "" clears, anything else replaces.
 */
export function upsertAccount(storedList, incoming, originalId, accountSecrets = {}) {
  const list = (Array.isArray(storedList) ? storedList : []).map((a, i) => normalizeAccount({ ...a, secrets: { ...((a && a.secrets) || {}), ...(accountSecrets[a && a.id] || {}) } }, i))
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
  // Secrets never go into settings: the caller writes `secrets` to the 0600 secrets file.
  const outSecrets = { ...acc.secrets }
  if (acc.apiKeyFromFile) delete outSecrets.apiKey // stays in its credentials file
  return { list: next.map(a => { const o = storableAccount(a); delete o.secrets; return o }), account: acc, secrets: outSecrets }
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

  const secretsStore = new SecretStore(join(dataDir, 'secrets.json'))
  const store = createSettingsStore(ctx, config, { ns: SETTINGS_NS, schema: Config || null, defaults: DEFAULTS, dataDir, dshHome: dshHome(), secrets: secretsStore, log, warn, metaUrl: import.meta.url })
  const sd = store.describe()
  log('settings: ' + sd.mode + (sd.file ? ' (' + sd.file + (sd.legacySource ? ', legacy values from ' + sd.legacySource : '') + ')' : ''))
  const scope = store

  const effective = () => resolveConfig(secretsStore.withLegacy(store.get()))
  const resolved = () => resolveAccounts(effective(), { accountSecrets: secretsStore.accounts() })
  let secret = null
  let tokenKey = null
  const tokens = new TokenManager({ store: new TokenStore(join(dataDir, 'tokens.enc'), () => tokenKey), onChange: ev => emit(ev) })
  const flows = new FlowStore(() => secret || 'not-ready')
  const scrub = m => scrubWith(m, [...secretValues(resolved().all), ...tokens.values(), ...secretsStore.values()])

  let cache = null
  const getCache = () => { if (!cache) cache = new MailCache(join(dataDir, 'cache.db'), { log }); return cache }
  const pool = new ImapPool({ tokenFor: acc => service.tokenFor(acc) })

  // SSE clients
  const sse = new Set()
  const emit = ev => { const line = 'event: ' + (ev.type || 'message') + '\ndata: ' + JSON.stringify(ev) + '\n\n'; for (const res of sse) { try { res.write(line) } catch {} } }

  const auditLog = new Audit(join(dataDir, 'audit.jsonl'), () => effective().audit.enabled !== false)
  const audit = e => auditLog.write(e)
  const suppression = new Suppression(join(dataDir, 'suppress.txt'))
  const outbound = new OutboundState(join(dataDir, 'state.json'))
  const campaigns = new Campaigns(join(dataDir, 'campaigns'))
  const listSuppression = new ListSuppression(join(dataDir, 'suppress-lists.json'))
  const unsubLimiter = new HitLimiter({ perKey: 20, global: 600 })
  let unsubKeyBuf = null
  const unsubDeps = () => ({ key: unsubKeyBuf, campaigns, suppression, lists: listSuppression, limiter: unsubLimiter, audit })
  const unsubForMass = () => ({ key: unsubKeyBuf, campaigns, lists: listSuppression })
  const outbox = new Outbox()
  const service = new MailService({
    get cache() { return getCache() },
    pool, settings: effective, accounts: resolved, log, warn, scrub, onChange: ev => emit(ev), tokens, outbound, audit, suppression, dataDir,
    // New mail: unsubscribe replies feed the suppression lists.
    onNewMessages: (acc, folder, rows) => {
      if (!unsubKeyBuf) return
      const n = processUnsubMails(rows, { key: unsubKeyBuf, addresses: unsubAddresses(resolved().all, effective()), campaigns, lists: listSuppression, suppression, seen: outbound.seenSet('unsub'), audit })
      if (n) emit({ type: 'suppress', account: acc.id, added: n })
    },
  })
  Object.defineProperty(service, 'cache', { get: getCache })
  const oauthRoutes = makeOAuthRoutes({ service, tokens, flows, resolved, effective, pool, scrub, warn, log })

  loadOrCreateSecret(secretPath).then(s => { secret = s; tokenKey = deriveKey(s); unsubKeyBuf = unsubKey(s) }).catch(e => warn(E.logLine('MAIL_NOT_READY', 'capability secret: ' + e.message)))

  // ── agent tools ──
  const defineTool = process.env.DSH_MAIL_TEST_IDENTITY_TOOLS === '1' ? (def => def) : resolveDefineTool()
  if (effective().agents.enabled === false) log('agents.enabled is false: mail tools not registered')
  else if (defineTool && ctx.tools && typeof ctx.tools.register === 'function') {
    try { registerTools(defineTool, ctx, { effective, resolved, service, queue, drafts, dataDir, scrub, outbound, suppression, audit, unsub: unsubForMass, lists: listSuppression, campaigns }) }
    catch (e) { warn(E.logLine('MAIL_INTERNAL', 'tool registration failed: ' + e.message)) }
  } else warn('defineTool or ctx.tools unavailable: agent tools not registered (the tab still works)')

  // ── timers: queue + background sync + retention ──
  // One timer pass at a time (setInterval does not wait for a slow SMTP
  // server), and one send per queue entry at a time (timer and Send now).
  let queueBusy = false
  const queueInflight = new Set()
  async function processQueue() {
    if (queueBusy) return
    queueBusy = true
    try {
      const due = await queue.due()
      if (!due.length) return
      log('processing ' + due.length + ' queued email(s)')
      for (const entry of due) await sendQueueEntry(entry).catch(e => warn(E.logLine(classify(e, 'MAIL_SEND_FAILED').code, 'queue entry ' + entry.id + ': ' + scrub(e.message))))
    } finally { queueBusy = false }
  }

  async function sendQueueEntry(entry, actor = 'timer') {
    if (queueInflight.has(entry.id)) return { ok: false, error: 'this entry is being sent right now', code: 'MAIL_QUEUE_CONFLICT' }
    queueInflight.add(entry.id)
    try { return await sendQueueEntryOnce(entry, actor) } finally { queueInflight.delete(entry.id) }
  }

  async function sendQueueEntryOnce(entry0, actor) {
    // Re-read: the status may have changed since the caller listed the entry.
    const entry = (await queue.read(entry0.id)) || entry0
    if (entry.status === 'sent') return { ok: false, error: 'already sent', code: 'MAIL_QUEUE_CONFLICT' }
    if (actor === 'timer' && entry.status !== 'scheduled') return { ok: false, error: 'not scheduled any more', code: 'MAIL_QUEUE_CONFLICT' }
    const settings = effective()
    const acc = resolved().all.find(a => a.id === entry.provider)
    if (!acc) { await queue.setStatus(entry.id, 'failed', { lastError: 'provider ' + entry.provider + ' is not configured', attempts: (entry.attempts || 0) + 1 }); return { ok: false, error: 'provider not configured', code: 'MAIL_ACCOUNT_NOT_FOUND' } }
    try {
      if (entry.csvData && Array.isArray(entry.csvData.rows) && entry.csvData.rows.length) {
        const already = await queue.sentSet(entry.id)
        await queue.setStatus(entry.id, 'sending', already.size ? { note: 'resumed: ' + already.size + ' already sent' } : {})
        const r = await runMassSend(acc, {
          rows: entry.csvData.rows, subjectTemplate: entry.msg.subject, textTemplate: entry.msg.text, from: entry.msg.from || '',
          replyTo: entry.msg.replyTo, delayMs: entry.delayMs, unsubscribe: entry.unsubscribe || '',
          list: entry.list || '', language: entry.language || '', alreadySent: already,
        }, { service, state: outbound, suppression, settings, canSetHeaders: service.canSetHeaders(acc), actor, unsub: unsubForMass(), onSent: addr => queue.markSent(entry.id, addr), isCancelled: async () => ((await queue.read(entry.id)) || {}).status === 'cancelled' })
        audit({ actor, action: 'mass_send', account: acc.id, recipients: r.total, subject: entry.msg.subject, ok: !r.stopped, count: r.sent, note: r.stopped })
        const sentTotal = already.size + r.sent
        await queue.setStatus(entry.id, r.stopped === 'cancelled' ? 'cancelled' : r.stopped ? 'failed' : 'sent', { sentCount: sentTotal, failedCount: r.failed, suppressedCount: r.suppressed, sentMessageId: 'mass-send', lastError: r.stopped || null })
        return { ok: !r.stopped, messageId: 'mass-send', sent: r.sent, failed: r.failed, alreadySent: r.alreadySent, error: r.stopped || undefined }
      }
      // Mark the single send first: a crash or a slow server can no longer lead to a second send.
      await queue.setStatus(entry.id, 'sending', {})
      const r = await service.send(acc, { ...entry.msg, to: addrList(entry.msg.to) }, { actor })
      await queue.setStatus(entry.id, 'sent', { sentMessageId: r.messageId })
      return { ok: true, messageId: r.messageId }
    } catch (e) {
      await queue.setStatus(entry.id, 'failed', { lastError: scrub(String(e.message)).slice(0, 500), attempts: (entry.attempts || 0) + 1 })
      return { ok: false, error: scrub(e.message), code: classify(e, 'MAIL_SEND_FAILED').code }
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
    // Every error body is { ok:false, error, code, message, hint, docs } (lib/errors.js); `error` keeps the old text and status.
    const fail = (code, message, extra = {}) => { try { res.setHeader('x-content-type-options', 'nosniff') } catch {} return E.send(res, code, { message, ...extra }) }
    const failFrom = (err, fallback, status = 400) => { const c = classify(err, fallback); return fail(c.code, scrub(String(err && err.message ? err.message : err)), { status, ...c.extra }) }
    try {
      const url = new URL(req.url || '/', 'http://dsh-mail.local')
      const path = url.pathname.replace(/\/+$/, '') || '/'
      const sub = path.startsWith(API_PREFIX) ? path.slice(API_PREFIX.length) : path
      const settings = effective()
      const readGate = () => {
        const g = checkReadRequest(req, { trustedHosts: settings.trustedHosts })
        if (!g.ok) fail(gateCode(g), g.reason, { status: g.status })
        return g.ok
      }
      const mutateGate = () => {
        const g = checkMutateRequest(req, { trustedHosts: settings.trustedHosts, secret, requireHarnessCookie: settings.requireHarnessCookie })
        if (!g.ok) fail(gateCode(g), g.reason, { status: g.status, layer: g.layer })
        return g.ok
      }
      const q = k => url.searchParams.get(k) || ''

      if (req.method === 'GET' && sub === '/session') {
        if (!readGate()) return
        if (!secret) { fail('MAIL_NOT_READY', 'secret not ready', { status: 503 }); return }
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
          return { ...sum, receive: k, status: st || null, unread, oauth: usesOAuth(a) ? tokens.status(a.id) : null }
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
          accounts: r.explicit.map(a => ({ ...redactAccount(a), capabilities: accountSummary(a).capabilities, oauthStatus: usesOAuth(a) ? oauthRoutes.statusOf(a.id) : null })),
          legacy: r.legacy.map(a => ({ ...redactAccount(a), capabilities: accountSummary(a).capabilities })),
          types: Object.entries(TYPES).map(([id, t]) => ({ id, label: t.label, receive: t.receive, send: t.send, unsupported: t.unsupported || '' })),
          confirmMode: effectiveConfirmMode(settings, r),
          settingsStore: store.describe(),
          settings: { defaultProvider: settings.defaultProvider, agents: { enabled: settings.agents.enabled, confirmMode: settings.agents.confirmMode || '' }, cache: settings.cache, unsubscribe: settings.unsubscribe, compose: settings.compose },
          secretKeys: SECRET_KEYS,
        })
        return
      }

      if (req.method === 'GET' && sub === '/folders') {
        if (!readGate()) return
        try {
          const acc = service.account(q('account'))
          sendJson(res, 200, { ok: true, account: acc.id, folders: await service.folders(acc) })
        } catch (e) { failFrom(e, 'MAIL_MAILBOX_UNREACHABLE') }
        return
      }

      if (req.method === 'GET' && sub === '/messages') {
        if (!readGate()) return
        try {
          const out = await service.list({ account: q('account') || 'all', folder: q('folder'), q: q('q'), filter: q('filter'), limit: Math.min(200, Number(q('limit')) || 50), offset: Math.max(0, Number(q('offset')) || 0), sync: q('sync') !== '0' })
          sendJson(res, 200, { ok: true, ...out })
        } catch (e) { failFrom(e, 'MAIL_MAILBOX_UNREACHABLE') }
        return
      }

      if (req.method === 'GET' && sub === '/thread') {
        if (!readGate()) return
        try { sendJson(res, 200, { ok: true, ...(await service.thread(q('account'), q('thread'), q('folder'))) }) }
        catch (e) { failFrom(e, 'MAIL_MAILBOX_UNREACHABLE') }
        return
      }

      if (req.method === 'GET' && sub === '/message') {
        if (!readGate()) return
        try { sendJson(res, 200, { ok: true, message: await service.message(q('id'), { images: q('images') === '1' }) }) }
        catch (e) { failFrom(e, 'MAIL_MAILBOX_UNREACHABLE') }
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
        } catch (e) { failFrom(e, 'MAIL_MAILBOX_UNREACHABLE') }
        return
      }

      if (req.method === 'GET' && sub === '/audit') {
        if (!readGate()) return
        sendJson(res, 200, { ok: true, entries: auditLog.tail(Math.min(1000, Number(q('limit')) || 100)) })
        return
      }
      if (req.method === 'GET' && sub === '/suppress') {
        if (!readGate()) return
        const global = suppression.entries()
        const lists = listSuppression.all()
        if (q('format') === 'csv') {
          const cell = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'
          const lines = ['address,scope,reason,added']
          for (const e of global) lines.push([e.address, 'all', e.reason, ''].map(cell).join(','))
          for (const [l, m] of Object.entries(lists)) for (const [a, v] of Object.entries(m)) lines.push([a, 'list:' + l, v.reason, new Date(v.at).toISOString()].map(cell).join(','))
          res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="dsh-mail-suppression.csv"', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
          res.end(lines.join('\r\n') + '\r\n')
          return
        }
        sendJson(res, 200, { ok: true, addresses: global.map(e => e.address), global, lists })
        return
      }
      if (req.method === 'GET' && sub === '/campaigns') {
        if (!readGate()) return
        sendJson(res, 200, { ok: true, campaigns: campaigns.summaries().slice(0, 200) })
        return
      }
      if (req.method === 'GET' && sub === '/unsubscribe/status') {
        if (!readGate()) return
        const u = settings.unsubscribe
        sendJson(res, 200, { ok: true, publicBaseUrl: u.publicBaseUrl, listener: unsubServer ? { host: unsubListenHost(u.listenHost), port: u.listenPort } : null, mailto: [...unsubAddresses(resolved().all, settings)], idle: idle.status(), outbox: outbox.pending() })
        return
      }
      if (req.method === 'GET' && sub === '/presets') {
        if (!readGate()) return
        sendJson(res, 200, { ok: true, presets: PRESETS })
        return
      }

      // Public by nature (Twilio SendGrid posts here): path secret, opt-in per account, cache only.
      if (req.method === 'POST' && sub.startsWith('/inbound/sendgrid/')) {
        await handleSendgridInbound(req, res, { sub, url, settings, resolved, secretsStore, cache: getCache(), dataDir, emit, audit, warn })
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

      if (req.method === 'GET' && sub.startsWith('/oauth/') && await oauthRoutes.get(sub, req, res, { readGate, url })) return

      // ── mutations ──
      if (req.method !== 'POST') { if (req.method === 'GET') fail('MAIL_ROUTE_NOT_FOUND', 'not found', { status: 404 }); else fail('MAIL_METHOD_NOT_ALLOWED', 'method not allowed', { status: 405 }); return }
      if (!mutateGate()) return
      const body = await readJsonBody(req)

      if (sub.startsWith('/oauth/') && await oauthRoutes.post(sub, req, res, body)) return

      if (sub === '/send') {
        try {
          const r = resolved()
          const id = body.account || body.provider || defaultAccountId(settings, r)
          const acc = r.all.find(a => a.id === id)
          if (!acc) { fail('MAIL_ACCOUNT_NOT_FOUND', 'provider ' + id + ' is not configured', { status: 400 }); return }
          const attachments = Array.isArray(body.attachments) && body.attachments.length ? await loadAttachments(body.attachments) : undefined
          const rendered = withSignature(renderBody({ format: body.format, text: body.text || '', html: body.html || '' }), acc.signature)
          const msg = { from: body.from || '', to: addrList(body.to), cc: addrList(body.cc), bcc: addrList(body.bcc), subject: body.subject || '', text: rendered.text, html: rendered.html, replyTo: body.replyTo || '', inReplyTo: body.inReplyTo || '', references: body.references || '', threadId: body.threadId || undefined, attachments }
          const run = async () => {
            const out = await service.send(acc, msg, { actor: 'human' })
            if (body.draftId) { const dr = await drafts.read(body.draftId); if (dr) { await service.deleteDraftRemote(acc, dr).catch(() => {}); await drafts.remove(dr.id) } }
            return out
          }
          const hold = body.undo === true ? Math.max(0, Number(settings.compose.undoSendSec) || 0) : 0
          if (hold > 0) {
            // Undo send: held in memory, the tab can cancel within the window.
            const h = outbox.hold(run, hold * 1000, (err) => emit({ type: 'outbox', id: h.id, ok: !err, error: err ? scrub(err.message) : '' }))
            sendJson(res, 200, { ok: true, held: true, outboxId: h.id, sendAt: h.sendAt, provider: acc.id })
            return
          }
          const out = await run()
          sendJson(res, 200, { ok: true, messageId: out.messageId, from: out.from, provider: acc.id })
        } catch (e) { failFrom(e, 'MAIL_SEND_FAILED') }
        return
      }
      if (sub === '/outbox/cancel') {
        const ok = outbox.cancel(String(body.id || ''))
        if (ok) audit({ actor: 'human', action: 'undo_send' })
        if (ok) sendJson(res, 200, { ok: true }); else fail('MAIL_OUTBOX_GONE', 'already sent or unknown', { status: 404 })
        return
      }
      if (sub === '/drafts/save') {
        try {
          const d0 = isObj(body.draft) ? { ...body.draft } : {}
          delete d0.remote // where our IMAP copy lives is decided here, never by the request
          const acc = service.account(String(d0.account || ''))
          const prev = d0.id ? await drafts.read(d0.id) : null
          let dr = await drafts.save({ ...(prev || {}), ...d0, by: 'human' })
          try { const remote = await service.syncDraftRemote(acc, dr); if (remote) dr = await drafts.save({ ...dr, remote }) } catch (e) { warn(E.logLine(classify(e, 'MAIL_MAILBOX_UNREACHABLE').code, 'draft sync for ' + acc.id + ': ' + scrub(e.message))) }
          sendJson(res, 200, { ok: true, id: dr.id, savedAt: dr.updatedAt, remote: !!dr.remote })
        } catch (e) { failFrom(e, 'MAIL_INTERNAL') }
        return
      }
      if (sub === '/folders/create' || sub === '/folders/rename') {
        try {
          const acc = service.account(String(body.account || ''))
          const r = sub === '/folders/create' ? await service.createFolder(acc, body.name, body.parent || '') : await service.renameFolder(acc, String(body.from || ''), String(body.to || ''))
          audit({ actor: 'human', action: sub === '/folders/create' ? 'folder_create' : 'folder_rename', account: acc.id })
          sendJson(res, 200, { ok: true, ...r })
        } catch (e) { failFrom(e, 'MAIL_MAILBOX_UNREACHABLE') }
        return
      }

      if (sub === '/queue/send' || sub === '/queue/approve') {
        try {
          const entry = await queue.read(body.id)
          if (!entry) { fail('MAIL_OBJECT_NOT_FOUND', 'not found', { status: 404 }); return }
          if (entry.status === 'sent') { fail('MAIL_QUEUE_CONFLICT', 'already sent', { status: 400 }); return }
          if (queueInflight.has(entry.id)) { fail('MAIL_QUEUE_CONFLICT', 'this entry is being sent right now', { status: 409 }); return }
          if (sub === '/queue/approve' && entry.requestedSendAt && entry.requestedSendAt * 1000 > Date.now()) {
            await queue.setStatus(entry.id, 'scheduled', { sendAt: entry.requestedSendAt, note: 'approved' })
            sendJson(res, 200, { ok: true, scheduled: true }); return
          }
          const r = await sendQueueEntry(entry, 'human')
          if (r.ok) sendJson(res, 200, { ok: true, messageId: r.messageId }); else fail(r.code || 'MAIL_SEND_FAILED', r.error, { status: 400 })
        } catch (e) { failFrom(e, 'MAIL_SEND_FAILED') }
        return
      }

      if (sub === '/queue/cancel') {
        try { await queue.cancel(body.id, { by: 'ui' }); sendJson(res, 200, { ok: true }) } catch (e) { failFrom(e, 'MAIL_INTERNAL') }
        return
      }
      if (sub === '/queue/delete') {
        try { await queue.delete(body.id); sendJson(res, 200, { ok: true }) } catch (e) { failFrom(e, 'MAIL_INTERNAL') }
        return
      }

      if (sub === '/drafts/send') {
        try {
          const dr = await drafts.read(body.id)
          if (!dr) { fail('MAIL_OBJECT_NOT_FOUND', 'no draft', { status: 404 }); return }
          const acc = service.account(dr.account)
          const attachments = dr.attachments && dr.attachments.length ? await loadAttachments(dr.attachments) : undefined
          const fwd = dr.forwardOf && dr.forwardAttachments ? await service.forwardAttachments(dr.forwardOf) : []
          const out = await service.send(acc, { ...dr, to: addrList(dr.to), cc: addrList(dr.cc), bcc: addrList(dr.bcc), attachments: [...(attachments || []), ...fwd], text: dr.text + (acc.signature ? '\n\n' + acc.signature : '') }, { actor: 'human' })
          await service.deleteDraftRemote(acc, dr).catch(() => {})
          await drafts.remove(dr.id)
          sendJson(res, 200, { ok: true, messageId: out.messageId })
        } catch (e) { failFrom(e, 'MAIL_SEND_FAILED') }
        return
      }
      if (sub === '/drafts/delete') {
        try {
          const dr = await drafts.read(body.id)
          if (dr && dr.remote) { try { await service.deleteDraftRemote(service.account(dr.account), dr) } catch {} }
          await drafts.remove(body.id); sendJson(res, 200, { ok: true })
        } catch (e) { failFrom(e, 'MAIL_INTERNAL') }
        return
      }

      if (sub === '/messages/mark') {
        try { sendJson(res, 200, { ok: true, ...(await service.mark(body.ids, body.op)) }) } catch (e) { failFrom(e, 'MAIL_MAILBOX_UNREACHABLE') }
        return
      }
      if (sub === '/messages/move') {
        try { sendJson(res, 200, { ok: true, ...(await service.move(body.ids, body.to)) }) } catch (e) { failFrom(e, 'MAIL_MAILBOX_UNREACHABLE') }
        return
      }
      if (sub === '/sync') {
        try {
          const accs = body.account ? [service.account(body.account)] : resolved().all.filter(a => a.enabled)
          const out = {}
          for (const a of accs) { try { out[a.id] = await service.sync(a, body.folder || 'INBOX', { force: true }) } catch (e) { out[a.id] = { error: scrub(e.message) } } }
          sendJson(res, 200, { ok: true, results: out })
        } catch (e) { failFrom(e, 'MAIL_MAILBOX_UNREACHABLE') }
        return
      }

      if (sub === '/accounts/save') {
        if (!scope.canWrite()) { fail('MAIL_SETTINGS_UNAVAILABLE', 'settings service unavailable', { status: 503 }); return }
        try {
          const { list, account, secrets: accSecrets } = upsertAccount(settings.accounts, isObj(body.account) ? body.account : {}, body.originalId, secretsStore.accounts())
          secretsStore.setAccount(account.id, accSecrets)
          await scope.update({ accounts: list })
          audit({ actor: 'human', action: 'account_save', account: account.id })
          pool.close(account.id).catch(() => {})
          sendJson(res, 200, { ok: true, account: redactAccount(account) })
        } catch (e) { failFrom(e, 'MAIL_ACCOUNT_INVALID') }
        return
      }
      if (sub === '/accounts/remove') {
        if (!scope.canWrite()) { fail('MAIL_SETTINGS_UNAVAILABLE', 'settings service unavailable', { status: 503 }); return }
        try {
          const id = String(body.id || '')
          const list = settings.accounts.filter(a => a && a.id !== id)
          if (list.length === settings.accounts.length) { fail('MAIL_OBJECT_NOT_FOUND', 'no explicit account ' + id + ' (legacy accounts come from the providers settings)', { status: 404 }); return }
          await scope.update({ accounts: list })
          await pool.close(id).catch(() => {})
          try { getCache().wipeAccount(id) } catch {}
          try { oauthRoutes.forget(id) } catch {}
          try { secretsStore.removeAccount(id) } catch {}
          audit({ actor: 'human', action: 'account_remove', account: id })
          for (const e of await queue.list()) if (e.provider === id && (e.status === 'queued' || e.status === 'scheduled')) await queue.cancel(e.id, { by: 'account removed' }).catch(() => {})
          for (const dr of await drafts.list()) if (dr.account === id) await drafts.remove(dr.id).catch(() => {})
          sendJson(res, 200, { ok: true })
        } catch (e) { failFrom(e, 'MAIL_INTERNAL') }
        return
      }
      if (sub === '/accounts/test') {
        try {
          let acc
          if (isObj(body.account)) {
            const prev = resolved().explicit.find(a => a.id === (body.originalId || body.account.id))
            const legacyPrev = resolved().all.find(a => a.id === body.account.id)
            acc = normalizeAccount({ ...body.account, secrets: mergeSecrets(body.account.secrets, (prev || legacyPrev || {}).secrets) })
            if (!prev && legacyPrev && legacyPrev.legacy) acc = legacyPrev
            else {
              // The same rules as saving (stored secrets must not be tested against an arbitrary endpoint).
              const errs = validateAccount(acc, []).filter(e => !/^id /.test(e))
              if (errs.length) { fail('MAIL_ACCOUNT_INVALID', errs.join('; '), { status: 400 }); return }
            }
          } else acc = service.account(String(body.id || ''))
          const t = await service.test(acc)
          sendJson(res, 200, { ok: true, result: { ...t, steps: t.steps.map(s => ({ ...s, detail: scrub(s.detail) })) } })
        } catch (e) { failFrom(e, 'MAIL_INTERNAL') }
        return
      }
      if (sub === '/suppress') {
        try {
          const list = typeof body.list === 'string' && body.list ? body.list : ''
          if (body.add) { list ? listSuppression.add(list, String(body.add), 'added in the Mail tab') : suppression.add(String(body.add), 'added in the Mail tab'); audit({ actor: 'human', action: 'suppress_add', note: list ? 'list' : 'all' }) }
          if (body.remove) { list ? listSuppression.remove(list, String(body.remove)) : suppression.remove(String(body.remove)); audit({ actor: 'human', action: 'suppress_remove', note: list ? 'list' : 'all' }) }
          sendJson(res, 200, { ok: true, addresses: suppression.list(), global: suppression.entries(), lists: listSuppression.all() })
        } catch (e) { failFrom(e, 'MAIL_INVALID_INPUT') }
        return
      }
      if (sub === '/accounts/convert') {
        if (!scope.canWrite()) { fail('MAIL_SETTINGS_UNAVAILABLE', 'settings service unavailable', { status: 503 }); return }
        if (body.confirm !== true) { fail('MAIL_CONFIRM_REQUIRED', 'confirm: true required', { status: 400 }); return }
        try {
          const r = await convertLegacy({ settings, raw: store.get(), resolved: resolved(), store: scope, secretsStore, dataDir, dshHome: dshHome(), firstContact: effectiveFirstContact(settings, resolved()) })
          audit({ actor: 'human', action: 'convert_legacy', count: r.converted.length })
          sendJson(res, 200, { ok: true, ...r })
        } catch (e) { failFrom(e, 'MAIL_INVALID_INPUT') }
        return
      }
      if (sub === '/accounts/webhook-secret') {
        try {
          const acc = resolved().explicit.find(a => a.id === String(body.account || ''))
          if (!acc || acc.type !== 'sendgrid') throw new Error('a saved SendGrid account is required')
          const s = randomBytes(24).toString('base64url')
          secretsStore.setAccount(acc.id, { ...secretsStore.account(acc.id), webhookSecret: s })
          audit({ actor: 'human', action: 'webhook_secret', account: acc.id })
          // Shown once: the full URL to paste into SendGrid Inbound Parse.
          sendJson(res, 200, { ok: true, path: API_PREFIX + '/inbound/sendgrid/' + acc.id + '?s=' + s })
        } catch (e) { failFrom(e, 'MAIL_INVALID_INPUT') }
        return
      }
      if (sub === '/settings') {
        if (!scope.canWrite()) { fail('MAIL_SETTINGS_UNAVAILABLE', 'settings service unavailable', { status: 503 }); return }
        await scope.update(sanitizeSettingsPatch(body.settings || body))
        sendJson(res, 200, { ok: true, settings: safeSettings(effective()) })
        return
      }
      if (sub === '/cache/wipe') {
        try { if (body.account) getCache().wipeAccount(String(body.account)); else for (const a of resolved().all) getCache().wipeAccount(a.id); service.lastSync.clear(); sendJson(res, 200, { ok: true }) }
        catch (e) { failFrom(e, 'MAIL_INTERNAL') }
        return
      }

      fail('MAIL_ROUTE_NOT_FOUND', 'not found', { status: 404 })
    } catch (error) {
      try { if (res.headersSent) { res.end(); return } failFrom(error, 'MAIL_INTERNAL') } catch {}
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler }), 'dsh-mail: api route')

  // Unsubscribe page: on the DSH server (where /dsh-mail-unsub/ is reachable without
  // login) and, when unsubscribe.listenPort is set, on a tiny listener that serves
  // nothing else, for an edge route that exempts only /dsh-mail-unsub/* from login.
  const unsubHandler = makeUnsubHandler(unsubDeps)
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: UNSUB_PATH.replace(/\/$/, ''), handler: unsubHandler }), 'dsh-mail: unsubscribe route')
  let unsubServer = null
  const u0 = effective().unsubscribe
  const unsubHost = unsubListenHost(u0.listenHost)
  if (Number(u0.listenPort) > 0) {
    if (unsubHost !== String(u0.listenHost || '127.0.0.1').trim().toLowerCase()) warn('unsubscribe.listenHost ' + String(u0.listenHost).slice(0, 60) + ' is not a loopback address; binding ' + unsubHost + ' (put an edge proxy in front)')
    unsubServer = http.createServer(unsubHandler)
    unsubServer.on('clientError', (_e, sock) => { try { sock.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n') } catch {} })
    unsubServer.on('error', e => { warn(E.logLine('MAIL_INTERNAL', 'unsubscribe listener: ' + e.message)); unsubServer = null })
    unsubServer.listen(Number(u0.listenPort), unsubHost, () => log('unsubscribe listener on ' + unsubHost + ':' + u0.listenPort))
  }

  // IMAP IDLE push (accounts with push: true), polling stays the fallback.
  const idle = new IdleManager({
    accounts: () => resolved().all, max: () => Number(effective().push.maxAccounts) || 0,
    tokenFor: acc => service.tokenFor(acc), log, warn,
    onExists: acc => { void service.sync(acc, 'INBOX', { force: true }).then(() => emit({ type: 'sync', account: acc.id, folder: 'INBOX', push: true })).catch(() => {}) },
  })
  const idleTimer = setInterval(() => { try { idle.reconcile() } catch {} }, 30000)
  if (idleTimer.unref) idleTimer.unref()
  setTimeout(() => { try { idle.reconcile() } catch {} }, 1000).unref?.()

  void (async () => {
    await queue.init().catch(() => {})
    log('armed: route ' + API_PREFIX + ', data ' + dataDir)
  })().catch(e => warn(E.logLine('MAIL_INTERNAL', 'init crashed: ' + e.message)))

  ctx.effect(() => () => {
    clearInterval(tick)
    clearInterval(heartbeat)
    clearInterval(idleTimer)
    idle.stopAll()
    outbox.clear()
    if (unsubServer) { try { unsubServer.close() } catch {} }
    for (const res of sse) { try { res.end() } catch {} }
    sse.clear()
    pool.close().catch(() => {})
    if (cache) cache.close()
  }, 'dsh-mail: cleanup')

  return { handler, service, effective, resolved, tokens, flows, campaigns, listSuppression, suppression, idle, outbox, unsubHandler, getUnsubKey: () => unsubKeyBuf, unsubPort: () => (unsubServer && unsubServer.address() ? unsubServer.address().port : 0) }
}

// The DSH 0.2 Loader reads `Config` from the DEFAULT export when there is one.
export default { name: 'dsh-mail', apply, inject: ['tools', 'webServer', 'settings'], Config, resolveConfig, resolveDefineTool, PLUGIN_ID }
