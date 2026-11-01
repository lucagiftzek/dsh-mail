/**
 * dsh-mail / accounts.js: the account model.
 *
 * v2 keeps every mailbox and every sending service as one "account" in the
 * `accounts` array of the dsh-mail settings namespace. Installs that predate
 * v2 have no `accounts` key: their provider-keyed settings (providers.*,
 * mailboxBaseUrl, the estate credential files) are turned into VIRTUAL
 * accounts in memory by legacyAccounts() below. Nothing is ever written back
 * to settings.yaml by this module.
 *
 * Secrets: password, apiKey, oauthClientSecret, webhookSecret. Every read
 * route returns them through redactAccount() as "__set__" (present) or ""
 * (empty); on save, mergeSecrets() treats "__set__" as "keep what is stored".
 */

'use strict'

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { readMailboxCredentials } from './mailbox.js'

export const SET_MARKER = '__set__'
export const SECRET_KEYS = ['password', 'apiKey', 'oauthClientSecret', 'webhookSecret']
export const ID_RE = /^[a-z0-9-]{2,32}$/
export const LEGACY_PROVIDER_IDS = ['lettermint', 'agentmail', 'resend', 'ovh', 'smtp', 'local', 'tzmail']

/** Account types that phase 1 can operate. */
export const TYPES = {
  'imap-smtp': { label: 'IMAP + SMTP', receive: 'imap', send: 'smtp' },
  'pop3-smtp': { label: 'POP3 + SMTP', receive: 'pop3', send: 'smtp' },
  google: { label: 'Google (Gmail, Workspace)', receive: 'imap', send: 'smtp' },
  local: { label: 'Self-hosted (IMAP/POP + SMTP)', receive: 'imap', send: 'smtp' },
  tzekos: { label: 'Tzekos Mail (webmail agent API)', receive: 'api', send: 'api' },
  lettermint: { label: 'Lettermint (send only)', receive: 'none', send: 'api' },
  resend: { label: 'Resend (send only)', receive: 'none', send: 'api' },
  agentmail: { label: 'AgentMail', receive: 'api', send: 'api' },
  sendgrid: { label: 'Twilio SendGrid (send; optional inbound parse)', receive: 'none', send: 'api' },
  microsoft: { label: 'Microsoft 365 / Outlook.com (OAuth2)', receive: 'imap', send: 'smtp' },
}

/** Server defaults filled in when a Google or Microsoft account leaves the hosts empty. */
const HOST_DEFAULTS = {
  google: { receive: { host: 'imap.gmail.com', port: 993, security: 'tls' }, send: { host: 'smtp.gmail.com', port: 465, security: 'tls' } },
  microsoft: { receive: { host: 'outlook.office365.com', port: 993, security: 'tls' }, send: { host: 'smtp.office365.com', port: 587, security: 'starttls' } },
}

const COLORS = ['#4d6bfe', '#2e9e5b', '#c98a14', '#cf3b3b', '#8b5cf6', '#0e9aa7', '#d9480f', '#5c7cfa']

function isObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v) }
function str(v, max = 2000) { return typeof v === 'string' ? v.slice(0, max) : '' }
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d }
function bool(v, d) { return typeof v === 'boolean' ? v : d }

export function matchEnv(text, key) {
  const m = new RegExp('^' + key + '=(.+)$', 'm').exec(String(text || ''))
  return m ? m[1].trim() : null
}

/** Estate credential files (read-only): AgentMail and Lettermint keys. */
export function loadEstateCreds(home = process.env.DSH_MAIL_ESTATE_HOME || homedir()) {
  const creds = {}
  try {
    const raw = readFileSync(join(home, '.config', 'agentmail', 'credentials'), 'utf8')
    creds.agentmailApiKey = matchEnv(raw, 'AGENTMAIL_API_KEY')
    creds.agentmailInbox = matchEnv(raw, 'AGENTMAIL_TEST_INBOX') || matchEnv(raw, 'AGENTMAIL_INBOX')
  } catch {}
  try {
    const raw = readFileSync(join(home, '.config', 'lettermint', 'credentials'), 'utf8')
    creds.lettermintApiKey = matchEnv(raw, 'LETTERMINT_API_KEY')
  } catch {}
  return creds
}

function defaultPorts(protocol, security) {
  if (protocol === 'imap') return security === 'tls' ? 993 : 143
  if (protocol === 'pop3') return security === 'tls' ? 995 : 110
  if (protocol === 'smtp') return security === 'tls' ? 465 : 587
  return 0
}

function normEndpoint(e, fallbackProtocol) {
  const o = isObj(e) ? e : {}
  const protocol = ['imap', 'pop3', 'smtp', 'api', 'inbound', 'none'].includes(o.protocol) ? o.protocol : fallbackProtocol
  const security = ['tls', 'starttls', 'none'].includes(o.security) ? o.security : 'tls'
  const out = { protocol, host: str(o.host, 253).trim(), port: num(o.port, defaultPorts(protocol, security)), security }
  if (protocol === 'pop3') out.leaveOnServer = o.leaveOnServer !== false
  if (o.user) out.user = str(o.user, 320)
  return out
}

/** Normalise one account object from settings (or from the editor). */
export function normalizeAccount(raw, index = 0) {
  const a = isObj(raw) ? raw : {}
  const type = TYPES[a.type] ? a.type : 'imap-smtp'
  const t = TYPES[type]
  const agent = isObj(a.agent) ? a.agent : {}
  const limits = isObj(a.limits) ? a.limits : {}
  const secrets = isObj(a.secrets) ? a.secrets : {}
  const out = {
    id: str(a.id, 32),
    label: str(a.label, 80) || str(a.id, 32),
    type,
    enabled: a.enabled !== false,
    address: str(a.address, 320).trim(),
    displayName: str(a.displayName, 120),
    receive: normEndpoint(a.receive, t.receive),
    send: normEndpoint(a.send, t.send),
    auth: { method: ['password', 'app-password', 'oauth2', 'api-key', 'bearer'].includes(a.auth && a.auth.method) ? a.auth.method : (t.send === 'api' ? 'api-key' : 'password'), user: str(a.auth && a.auth.user, 320) },
    secrets: {},
    passwordFile: str(a.passwordFile, 1000),
    passwordEnv: str(a.passwordEnv, 120),
    allowSelfSigned: a.allowSelfSigned === true,
    defaultFrom: str(a.defaultFrom, 400),
    replyTo: str(a.replyTo, 400),
    signature: str(a.signature, 4000),
    agent: {
      allow: agent.allow === true,
      canRead: agent.canRead !== false,
      canSend: agent.canSend !== false,
      canMass: agent.canMass === true,
      canManageFolders: agent.canManageFolders === true,
      default: agent.default === true,
    },
    isDefaultSender: a.isDefaultSender === true,
    // 0 = unlimited (used by the legacy accounts, which had no limits in v0.1)
    limits: { perMinute: Math.max(0, num(limits.perMinute, 20)), perDay: Math.max(0, num(limits.perDay, 300)), maxRecipients: num(limits.maxRecipients, 500) },
    // API key from a KEY=value credentials file (read at use, never copied)
    apiKeyFile: str(a.apiKeyFile, 1000),
    apiKeyVar: /^[A-Z0-9_]{1,64}$/.test(a.apiKeyVar || '') ? a.apiKeyVar : '',
    inbound: { enabled: !!(isObj(a.inbound) && a.inbound.enabled === true) },
    // Unsubscribe replies: an explicit mailbox, else local+unsubscribe@domain for accounts that read their mail
    unsubscribe: { mailto: str(isObj(a.unsubscribe) ? a.unsubscribe.mailto : '', 320).trim(), plusTag: !(isObj(a.unsubscribe) && a.unsubscribe.plusTag === false) },
    push: a.push === true,
    folders: isObj(a.folders) ? Object.fromEntries(Object.entries(a.folders).filter(([k, v]) => ['sent', 'drafts', 'trash', 'archive', 'junk'].includes(k) && typeof v === 'string' && v).map(([k, v]) => [k, v.slice(0, 200)])) : {},
    api: isObj(a.api) ? { baseUrl: str(a.api.baseUrl, 500), inbox: str(a.api.inbox, 200) } : { baseUrl: '', inbox: '' },
    oauth: normOauth(a.oauth),
    color: /^#[0-9a-f]{6}$/i.test(a.color || '') ? a.color : COLORS[index % COLORS.length],
  }
  for (const k of SECRET_KEYS) if (typeof secrets[k] === 'string' && secrets[k]) out.secrets[k] = secrets[k]
  const hd = HOST_DEFAULTS[type]
  if (hd) for (const side of ['receive', 'send']) if (!out[side].host) out[side] = { ...out[side], ...hd[side] }
  if (type === 'microsoft') out.auth.method = 'oauth2'
  if (type === 'sendgrid') out.receive = { protocol: out.inbound.enabled ? 'inbound' : 'none', host: '', port: 0, security: 'tls' }
  if (!out.secrets.apiKey && out.apiKeyFile) {
    try { const v = matchEnv(readFileSync(out.apiKeyFile.replace(/^~(?=\/)/, homedir()), 'utf8'), out.apiKeyVar || 'API_KEY'); if (v) { out.secrets.apiKey = v; out.apiKeyFromFile = true } } catch {}
  }
  if (type === 'google' && !['oauth2', 'app-password', 'password'].includes(out.auth.method)) out.auth.method = 'app-password'
  return out
}

function normOauth(o) {
  const x = isObj(o) ? o : {}
  const out = { clientId: str(x.clientId, 300).trim(), tenant: str(x.tenant, 80).trim(), sendMode: ['auto', 'smtp', 'graph'].includes(x.sendMode) ? x.sendMode : 'auto' }
  for (const k of ['authorizeUrl', 'tokenUrl', 'revokeUrl', 'deviceUrl', 'graphUrl']) if (typeof x[k] === 'string' && x[k]) out[k] = x[k].slice(0, 500)
  return out
}

/** True when the account authenticates with OAuth2 (XOAUTH2 for IMAP and SMTP). */
export function usesOAuth(acc) { return !!acc && (acc.type === 'google' || acc.type === 'microsoft') && acc.auth.method === 'oauth2' }

export function validateAccount(acc, others = []) {
  const errs = []
  if (!ID_RE.test(acc.id)) errs.push('id must match [a-z0-9-]{2,32}')
  if (others.some(o => o.id === acc.id)) errs.push('id ' + acc.id + ' already exists')
  const t = TYPES[acc.type]
  if (t && t.unsupported) errs.push(t.unsupported)
  if (acc.type === 'microsoft' && acc.auth.method !== 'oauth2') errs.push('Microsoft accepts only OAuth2 for IMAP and SMTP (basic authentication is retired)')
  if (usesOAuth(acc)) {
    if (!acc.oauth.clientId) errs.push('OAuth2 needs the client id of your own OAuth app')
    if (acc.type === 'microsoft' && acc.oauth.tenant && !/^[A-Za-z0-9.-]{1,80}$/.test(acc.oauth.tenant)) errs.push('tenant must be common, organizations, consumers, a domain or a tenant id')
    for (const k of ['authorizeUrl', 'tokenUrl', 'revokeUrl', 'deviceUrl', 'graphUrl']) {
      const v = acc.oauth[k]
      if (!v) continue
      let u = null
      try { u = new URL(v) } catch {}
      if (!u || (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(u.hostname)))) errs.push('oauth.' + k + ' must be an https URL')
    }
  }
  for (const side of ['receive', 'send']) {
    const e = acc[side]
    if (['imap', 'pop3', 'smtp'].includes(e.protocol)) {
      if (!e.host) errs.push(side + ': host is required')
      if (!(e.port > 0 && e.port < 65536)) errs.push(side + ': port is invalid')
      if (e.security === 'none' && !isLoopbackHost(e.host)) errs.push(side + ': plaintext is only allowed to a loopback host')
    }
  }
  if (acc.address && /[\r\n]/.test(acc.address)) errs.push('address must be one line')
  if (acc.api && acc.api.baseUrl) { const e = apiBaseUrlError(acc.api.baseUrl); if (e) errs.push('api.baseUrl ' + e) }
  return errs
}

/**
 * HTTP API base URLs (Lettermint, Resend, AgentMail, SendGrid, Tzekos Mail)
 * receive the account's API key, so they are constrained: https, or plain
 * http to a loopback host only, and never a link-local address (cloud
 * metadata endpoints). IMAP, POP3 and SMTP hosts stay free: self-hosted mail
 * on the LAN is a normal setup. Returns '' when the URL is acceptable.
 */
export function apiBaseUrlError(v) {
  let u
  try { u = new URL(String(v)) } catch { return 'must be an absolute URL' }
  if (u.username || u.password) return 'must not carry credentials'
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (u.protocol === 'http:' && !isLoopbackHost(host)) return 'must use https (plain http only to a loopback host)'
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'must use https'
  if (/^169\.254\./.test(host) || /^fe[89ab][0-9a-f]:/i.test(host) || host === 'metadata.google.internal' || host === '0.0.0.0' || host === '::') return 'must not point at a link-local or unspecified address'
  return ''
}

export function isLoopbackHost(h) {
  const s = String(h || '').toLowerCase()
  return s === 'localhost' || s === '::1' || s === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(s)
}

/** Capabilities derived from the endpoints (read only, shown in the UI and tools). */
export function capabilities(acc) {
  const r = acc.receive.protocol
  const s = acc.send.protocol
  const caps = []
  if (['imap', 'pop3', 'api', 'inbound'].includes(r)) caps.push('read')
  if (r === 'inbound') caps.push('inbound')
  if (['smtp', 'api'].includes(s)) caps.push('send')
  if (r === 'imap') caps.push('folders', 'search')
  if (r === 'api' && acc.type === 'tzekos') caps.push('folders', 'search', 'threads')
  return caps
}

// ── secrets ─────────────────────────────────────────────────────────────────

/** Redact one account for any read response. */
export function redactAccount(acc) {
  const out = structuredClone(acc)
  const s = {}
  for (const k of SECRET_KEYS) s[k] = acc.secrets && acc.secrets[k] ? SET_MARKER : ''
  out.secrets = s
  delete out.legacyCreds
  delete out.tokenFromFile
  if (acc.apiKeyFromFile) out.secrets.apiKey = ''
  delete out.apiKeyFromFile
  return out
}

/** Apply the "__set__ means keep" rule to an incoming account against the stored one. */
export function mergeSecrets(incoming, stored) {
  const out = {}
  const inc = isObj(incoming) ? incoming : {}
  for (const k of SECRET_KEYS) {
    const v = inc[k]
    if (v === SET_MARKER) { if (stored && stored[k]) out[k] = stored[k] }
    else if (typeof v === 'string' && v) out[k] = v
  }
  return out
}

/** The password for an account: inline secret, then passwordFile, then passwordEnv. */
export function resolvePassword(acc, env = process.env) {
  if (acc.secrets && acc.secrets.password) return acc.secrets.password
  if (acc.passwordFile) {
    try { const v = readFileSync(acc.passwordFile.replace(/^~(?=\/)/, homedir()), 'utf8').trim(); if (v) return v } catch {}
  }
  if (acc.passwordEnv && typeof env[acc.passwordEnv] === 'string' && env[acc.passwordEnv]) return env[acc.passwordEnv]
  return ''
}

/** Every secret value of every account, for scrubbing error messages. */
export function secretValues(accounts) {
  const out = []
  for (const a of accounts || []) {
    for (const k of SECRET_KEYS) if (a.secrets && a.secrets[k] && a.secrets[k].length >= 4) out.push(a.secrets[k])
    const p = resolvePassword(a)
    if (p && p.length >= 4) out.push(p)
    if (a.legacyCreds) for (const [k, v] of Object.entries(a.legacyCreds)) if (/key|pass|secret|token/i.test(k) && typeof v === 'string' && v.length >= 4) out.push(v)
    if (a.tokenFromFile && a.tokenFromFile.length >= 4) out.push(a.tokenFromFile)
  }
  return out
}

export function scrub(message, secrets) {
  let m = String(message == null ? '' : message)
  for (const s of secrets || []) if (s) m = m.split(s).join('***')
  m = m.replace(/(authorization:\s*bearer\s+)\S+/gi, '$1***').replace(/(AUTH\s+(PLAIN|LOGIN|XOAUTH2)\s+)\S+/gi, '$1***')
  return m
}

// ── the legacy shim ─────────────────────────────────────────────────────────

/**
 * Turn v0.1 provider-keyed settings into virtual accounts. Ids equal the old
 * provider ids so `provider: "lettermint"` in old chats keeps resolving.
 * Every virtual account keeps `legacyProvider` + `legacyCreds` so it sends and
 * reads through exactly the same code path as v0.1 (lib/providers.js).
 */
export function legacyAccounts(settings, { estate = loadEstateCreds(), mailboxCreds = readMailboxCredentials(), env = process.env } = {}) {
  const s = isObj(settings) ? settings : {}
  const p = isObj(s.providers) ? s.providers : {}
  const out = []
  const base = (id, type, extra) => {
    const acc = normalizeAccount({ id, label: id, type, agent: { allow: true, canRead: true, canSend: true, canMass: true }, limits: { perMinute: 0, perDay: 0, maxRecipients: 500 }, ...extra }, out.length)
    acc.legacy = true
    if (!acc.defaultFrom && s.defaultFrom) acc.defaultFrom = s.defaultFrom
    if (!acc.replyTo && s.defaultReplyTo) acc.replyTo = s.defaultReplyTo
    out.push(acc)
    return acc
  }
  const pick = (envKeys, setVal, fileVal) => {
    for (const k of envKeys) if (typeof env[k] === 'string' && env[k].trim()) return env[k].trim()
    if (typeof setVal === 'string' && setVal.trim()) return setVal.trim()
    if (typeof fileVal === 'string' && fileVal.trim()) return fileVal.trim()
    return ''
  }

  // tzmail: the webmail agent API (token) and/or the per-user cookie login.
  const tz = isObj(p.tzmail) ? p.tzmail : {}
  const tzBase = String(s.mailboxBaseUrl || tz.tzmailBaseURL || mailboxCreds.MAIL_AGENT_BASE_URL || '').replace(/\/+$/, '')
  const tzToken = String(s.mailboxAgentToken || '') || String(mailboxCreds.MAIL_AGENT_TOKEN || '')
  const tzCookie = !!(tz.tzmailBaseURL && tz.tzmailUser && tz.tzmailPass && tz.tzmailAccounts)
  if ((tzBase && tzToken) || tzCookie) {
    const acc = base('tzmail', 'tzekos', { label: 'Tzekos Mail', api: { baseUrl: tzBase }, auth: { method: 'bearer' } })
    if (s.mailboxAgentToken) acc.secrets.apiKey = String(s.mailboxAgentToken)
    else if (mailboxCreds.MAIL_AGENT_TOKEN) acc.tokenFromFile = String(mailboxCreds.MAIL_AGENT_TOKEN)
    if (tzCookie) acc.legacyProvider = 'tzmail'
    acc.legacyCreds = { ...tz }
  }

  const lm = isObj(p.lettermint) ? p.lettermint : {}
  const lmKey = pick([], lm.lettermintApiKey, estate.lettermintApiKey)
  if (lmKey) {
    const acc = base('lettermint', 'lettermint', { label: 'Lettermint' })
    acc.legacyProvider = 'lettermint'
    acc.legacyCreds = { ...lm, lettermintApiKey: lmKey }
  }

  const am = isObj(p.agentmail) ? p.agentmail : {}
  const amKey = pick([], am.agentmailApiKey, estate.agentmailApiKey)
  const amInbox = pick([], am.agentmailInbox, estate.agentmailInbox)
  if (amKey && amInbox) {
    const acc = base('agentmail', 'agentmail', { label: 'AgentMail', api: { inbox: amInbox } })
    acc.legacyProvider = 'agentmail'
    acc.legacyCreds = { ...am, agentmailApiKey: amKey, agentmailInbox: amInbox }
  }

  const rs = isObj(p.resend) ? p.resend : {}
  if (rs.resendApiKey) {
    const acc = base('resend', 'resend', { label: 'Resend' })
    acc.legacyProvider = 'resend'
    acc.legacyCreds = { ...rs }
  }

  for (const id of ['ovh', 'smtp', 'local']) {
    const c = isObj(p[id]) ? p[id] : {}
    if (!(c.smtpHost && c.smtpUser && c.smtpPass)) continue
    const port = Number(c.smtpPort) || 587
    const secure = c.smtpSecure !== undefined ? !!c.smtpSecure : port === 465
    const acc = base(id, id === 'local' ? 'local' : 'imap-smtp', {
      label: id === 'ovh' ? 'OVH' : id,
      address: c.smtpFrom || c.smtpUser,
      send: { protocol: 'smtp', host: c.smtpHost, port, security: secure ? 'tls' : 'starttls' },
      receive: c.imapHost ? { protocol: 'imap', host: c.imapHost, port: c.imapPort || 993, security: c.imapSecure === false ? 'starttls' : 'tls' } : { protocol: 'none' },
    })
    acc.legacyProvider = id
    acc.legacyCreds = { ...c }
    acc.auth.user = c.imapUser || c.smtpUser
    acc.secrets.password = c.imapPass || c.smtpPass
  }
  return out
}

/**
 * The account list the plugin works with: explicit accounts first, then the
 * legacy virtual ones whose id is not taken by an explicit account.
 */
export function resolveAccounts(settings, opts = {}) {
  const s = isObj(settings) ? settings : {}
  const stored = opts.accountSecrets || {}
  const explicit = (Array.isArray(s.accounts) ? s.accounts : [])
    .map((a, i) => normalizeAccount(isObj(a) ? { ...a, secrets: { ...(isObj(a.secrets) ? a.secrets : {}), ...(stored[a.id] || {}) } } : a, i))
    .filter(a => ID_RE.test(a.id))
  const seen = new Set(explicit.map(a => a.id))
  const legacy = legacyAccounts(s, opts).filter(a => !seen.has(a.id))
  return { explicit, legacy, all: [...explicit, ...legacy] }
}

/** True when the install runs on the legacy shim only (no explicit accounts, legacy config present). */
export function isLegacyInstall(resolved) {
  return resolved.explicit.length === 0 && resolved.legacy.length > 0
}

/** agents.confirmMode: explicit value wins, else legacy installs keep v0.1 behaviour. */
export function effectiveConfirmMode(settings, resolved) {
  const m = settings && settings.agents && settings.agents.confirmMode
  if (m === 'all' || m === 'reply-only') return { mode: m, source: 'settings' }
  if (isLegacyInstall(resolved)) return { mode: 'reply-only', source: 'legacy-detected' }
  return { mode: 'all', source: 'default' }
}

/** agents.firstContactConfirm: explicit value wins, else off for legacy installs (v0.1 had no such check), on otherwise. */
export function effectiveFirstContact(settings, resolved) {
  const v = settings && settings.agents && settings.agents.firstContactConfirm
  if (v === true || v === false) return { on: v, source: 'settings' }
  if (isLegacyInstall(resolved)) return { on: false, source: 'legacy-detected' }
  return { on: true, source: 'default' }
}

/** The account used when a tool omits account/provider. */
export function defaultAccountId(settings, resolved) {
  const flagged = resolved.all.find(a => a.agent.default)
  if (flagged) return flagged.id
  const dp = settings && typeof settings.defaultProvider === 'string' ? settings.defaultProvider : ''
  if (dp) return dp
  // v0.1's implicit default was lettermint; keep it for installs on the shim.
  if (isLegacyInstall(resolved)) return 'lettermint'
  const first = resolved.all.find(a => a.enabled && capabilities(a).includes('send'))
  return first ? first.id : ''
}

/** Find an account by id (also accepts the old provider ids). */
export function findAccount(resolved, id) {
  return resolved.all.find(a => a.id === id) || null
}

/** Tool-level permission check. Returns null when allowed or an error string. */
export function agentDenied(acc, need, settings) {
  if (!acc) return 'unknown account'
  const allowList = settings && settings.agents && Array.isArray(settings.agents.allowedAccounts) ? settings.agents.allowedAccounts : null
  if (!acc.enabled) return 'account ' + acc.id + ' is disabled'
  const allowed = allowList && allowList.length ? allowList.includes(acc.id) : acc.agent.allow
  if (!allowed) return 'account ' + acc.id + ' not permitted for agents'
  if (need === 'read' && !acc.agent.canRead) return 'account ' + acc.id + ' not permitted for agents (read)'
  if (need === 'send' && !acc.agent.canSend) return 'account ' + acc.id + ' not permitted for agents (send)'
  if (need === 'mass' && !acc.agent.canMass) return 'account ' + acc.id + ' not permitted for agents (mass send)'
  return null
}

/** Summary row for tools and the tab (never secrets). */
export function accountSummary(acc) {
  return {
    id: acc.id, label: acc.label, type: acc.type, address: acc.address || (acc.api && acc.api.inbox ? acc.api.inbox : ''), auth: acc.auth.method,
    enabled: acc.enabled, legacy: !!acc.legacy, color: acc.color,
    capabilities: capabilities(acc),
    agent: { ...acc.agent },
    limits: { ...acc.limits },
  }
}
