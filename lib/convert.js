/**
 * dsh-mail / convert.js: "Convert legacy settings to accounts".
 *
 * Only ever runs from an explicit, confirmed button (POST /accounts/convert
 * with confirm:true). It turns the virtual legacy accounts (v0.1 provider
 * settings, credential files) into editable accounts with the SAME ids, so
 * old chats keep resolving, and pins today's behaviour so nothing changes
 * for agents: defaultProvider, agents.confirmMode and
 * agents.firstContactConfirm keep their current effective values.
 *
 * Secrets: values that sat in the settings move into the 0600 secrets file
 * and are blanked in the settings; keys that came from credential files stay
 * there (the account references the file: apiKeyFile + apiKeyVar).
 * A backup of settings.yaml (when present) and of the current dsh-mail
 * settings is written before anything changes.
 */

'use strict'

import { copyFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Where the estate credential files live (the same base lib/accounts.js reads them from). */
const estateFile = rel => (process.env.DSH_MAIL_ESTATE_HOME ? join(process.env.DSH_MAIL_ESTATE_HOME, rel) : '~/' + rel)

import { CREDENTIAL_PATH } from './mailbox.js'
import { defaultAccountId, effectiveConfirmMode } from './accounts.js'
import { LEGACY_SECRET_FIELDS } from './secrets.js'

function stamp(d = new Date()) { return d.toISOString().slice(0, 10).replace(/-/g, '') }

/** Secret-looking values masked: the JSON backup is a record of the settings, the secrets stay in their files. */
function masked(v, key = '') {
  if (Array.isArray(v)) return v.map(x => masked(x))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'secrets' ? '__redacted__' : masked(x, k)]))
  return typeof v === 'string' && v && /key|pass|secret|token/i.test(key) ? '__set__' : v
}

function backup(dshHome, dataDir, settings) {
  const out = []
  // Every file the settings service may write: settings.yaml on DSH 0.1, the
  // profile rows (cordis.patch.yml) on DSH 0.2, plus the imported section.
  const files = [join(dshHome, 'settings.yaml'), join(dshHome, 'settings.yaml.imported')]
  try { for (const p of readdirSync(join(dshHome, 'profiles'))) files.push(join(dshHome, 'profiles', p, 'cordis.patch.yml')) } catch {}
  for (const f of files) {
    if (!existsSync(f)) continue
    let dest = f + '.bak-' + stamp() + '-mailv2-convert'
    if (existsSync(dest)) dest += '-' + Date.now()
    copyFileSync(f, dest)
    out.push(dest)
  }
  mkdirSync(join(dataDir, 'backups'), { recursive: true, mode: 0o700 })
  const json = join(dataDir, 'backups', 'settings-' + Date.now() + '.json')
  writeFileSync(json, JSON.stringify(masked(settings), null, 2) + '\n', { mode: 0o600 })
  out.push(json)
  return out
}

/** Build the explicit account for one legacy account; returns { account, secrets } or { skip }. */
export function convertOne(acc, settings) {
  const p = (settings.providers || {})[acc.id] || {}
  const base = {
    id: acc.id, label: acc.label, enabled: true, defaultFrom: acc.defaultFrom || '', replyTo: acc.replyTo || '',
    agent: { allow: true, canRead: true, canSend: true, canMass: true, default: false },
    limits: { perMinute: 0, perDay: 0, maxRecipients: 500 },
  }
  const secrets = {}
  if (acc.id === 'tzmail') {
    if (acc.legacyProvider === 'tzmail') return { skip: 'uses the per-user webmail login (tzmailUser/tzmailPass); kept as a legacy account' }
    const a = { ...base, type: 'tzekos', api: { baseUrl: acc.api.baseUrl }, auth: { method: 'bearer' } }
    if (settings.mailboxAgentToken) secrets.apiKey = settings.mailboxAgentToken
    else { a.apiKeyFile = CREDENTIAL_PATH(); a.apiKeyVar = 'MAIL_AGENT_TOKEN' }
    return { account: a, secrets }
  }
  if (acc.id === 'lettermint') {
    const a = { ...base, type: 'lettermint', api: { baseUrl: p.lettermintBaseURL && p.lettermintBaseURL !== 'https://api.lettermint.co/v1' ? p.lettermintBaseURL : '' } }
    if (p.lettermintApiKey) secrets.apiKey = p.lettermintApiKey
    else { a.apiKeyFile = estateFile('.config/lettermint/credentials'); a.apiKeyVar = 'LETTERMINT_API_KEY' }
    return { account: a, secrets }
  }
  if (acc.id === 'agentmail') {
    const a = { ...base, type: 'agentmail', api: { inbox: acc.api.inbox, baseUrl: p.agentmailBaseURL && p.agentmailBaseURL !== 'https://api.agentmail.to/v0' ? p.agentmailBaseURL : '' } }
    if (p.agentmailApiKey) secrets.apiKey = p.agentmailApiKey
    else { a.apiKeyFile = estateFile('.config/agentmail/credentials'); a.apiKeyVar = 'AGENTMAIL_API_KEY' }
    return { account: a, secrets }
  }
  if (acc.id === 'resend') {
    if (!p.resendApiKey) return { skip: 'no API key in the settings' }
    secrets.apiKey = p.resendApiKey
    return { account: { ...base, type: 'resend', api: { baseUrl: p.resendBaseURL && p.resendBaseURL !== 'https://api.resend.com' ? p.resendBaseURL : '' } }, secrets }
  }
  if (['ovh', 'smtp', 'local'].includes(acc.id)) {
    if (acc.secrets.password) secrets.password = acc.secrets.password
    return {
      account: { ...base, type: acc.id === 'local' ? 'local' : 'imap-smtp', address: acc.address, auth: { method: 'password', user: acc.auth.user }, receive: acc.receive, send: acc.send },
      secrets,
    }
  }
  return { skip: 'unknown legacy provider' }
}

/**
 * @param d { settings (effective, with legacy secrets overlaid), resolved, store, secretsStore, dataDir, dshHome, firstContact }
 */
export async function convertLegacy(d) {
  const { settings, resolved, store, secretsStore } = d
  if (!resolved.legacy.length) throw new Error('nothing to convert: no legacy provider settings are in use')
  const backups = backup(d.dshHome, d.dataDir, settings)
  const def = defaultAccountId(settings, resolved)
  const mode = effectiveConfirmMode(settings, resolved).mode
  const converted = []
  const skipped = []
  const newAccounts = []
  for (const acc of resolved.legacy) {
    const r = convertOne(acc, settings)
    if (r.skip) { skipped.push({ id: acc.id, reason: r.skip }); continue }
    if (acc.id === def) r.account.agent.default = true
    newAccounts.push(r.account)
    if (Object.keys(r.secrets).length) secretsStore.setAccount(acc.id, { ...secretsStore.account(acc.id), ...r.secrets })
    converted.push(acc.id)
  }
  const existing = (settings.accounts || []).map(a => { const o = { ...a }; delete o.secrets; return o })
  const patch = { accounts: [...existing, ...newAccounts], schemaVersion: 2, agents: {} }
  const pins = {}
  if (!settings.defaultProvider && def) { patch.defaultProvider = def; pins.defaultProvider = def }
  if (!(settings.agents && settings.agents.confirmMode)) { patch.agents.confirmMode = mode; pins['agents.confirmMode'] = mode }
  if (!(settings.agents && typeof settings.agents.firstContactConfirm === 'boolean')) { patch.agents.firstContactConfirm = !!(d.firstContact && d.firstContact.on); pins['agents.firstContactConfirm'] = patch.agents.firstContactConfirm }
  if (!Object.keys(patch.agents).length) delete patch.agents
  // Blank the migrated secrets in the settings (they now live in the 0600 file).
  const blanks = {}
  const raw = d.raw || {}
  for (const id of converted) {
    const fields = LEGACY_SECRET_FIELDS[id] || []
    const cur = (raw.providers || {})[id] || {}
    for (const f of fields) if (cur[f]) { blanks[id] = { ...(blanks[id] || {}), [f]: '' } }
  }
  if (Object.keys(blanks).length) patch.providers = blanks
  if (converted.includes('tzmail') && raw.mailboxAgentToken) patch.mailboxAgentToken = ''
  await store.update(patch)
  secretsStore.clearLegacy(converted)
  return { converted, skipped, backups: backups.map(b => b.replace(/^.*\/(?=[^/]+$)/, '')), pins }
}
