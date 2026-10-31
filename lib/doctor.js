/**
 * dsh-mail / doctor.js: the read-only self-check behind GET /dsh-mail/api/doctor
 * and the agent tool mail_doctor (standard: docs/PLUGIN-DOCS-STANDARD.md).
 *
 * Offline and fast: it never opens a connection to a mail server or any other
 * host, never writes, and never puts a secret into the report. Account rows
 * carry the id and the type only (no address, no host); secrets, tokens and
 * URLs are reduced to booleans. Every row that is not ok carries the matching
 * MAIL_* code, its hint and its docs anchor (docs/ERRORS.md).
 */

'use strict'

import { statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

import { doctorReport, check, hostInfo } from './plugin-errors.js'
import { E, classify } from './errors.js'
import { usesOAuth, resolvePassword, TYPES } from './accounts.js'
import { receiveKind } from './service.js'
import { unsubListenHost } from './unsub.js'

const MAX_ACCOUNT_ROWS = 50
const SECRET_FILES = ['secrets.json', 'capability.secret', 'tokens.enc', 'settings.json']

/** code, hint and docs anchor of a catalog entry, to spread into a row. */
function why(code, extra = {}) {
  const c = E.codes[code]
  return { code, hint: extra.hint || c.hint, docs: c.docs, ...(extra.human ? { human: true } : {}) }
}

const modeOf = st => (st.mode & 0o777).toString(8).padStart(3, '0')
const loose = st => (st.mode & 0o077) !== 0

function age(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return s + 's'
  if (s < 5400) return Math.round(s / 60) + 'm'
  if (s < 129600) return Math.round(s / 3600) + 'h'
  return Math.round(s / 86400) + 'd'
}

/** Is the secret an account needs stored? Booleans only, the value is never kept. */
function secretPresent(acc, tokens) {
  if (usesOAuth(acc)) { const t = tokens.status(acc.id); return !!(t && t.connected) }
  const t = TYPES[acc.type] || {}
  if (t.send === 'api' || t.receive === 'api' || acc.auth.method === 'api-key' || acc.auth.method === 'bearer') return !!(acc.secrets && acc.secrets.apiKey)
  return !!resolvePassword(acc)
}

/** Read-only look at cache.db: header and a trivial query, without creating it. */
function probeCacheFile(path) {
  let st
  try { st = statSync(path) } catch { return { status: 'ok', detail: 'cache.db not created yet (it is created on first use)' } }
  try {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
    const db = new DatabaseSync(path, { readOnly: true })
    try { db.prepare('SELECT count(*) AS n FROM sqlite_master').get() } finally { db.close() }
    return { status: 'ok', detail: 'cache.db opens, ' + st.size + ' bytes, mode ' + modeOf(st) }
  } catch (e) {
    if (/node:sqlite|Cannot find module|ERR_UNKNOWN_BUILTIN/i.test(String(e && e.message))) return { status: 'warn', ...why('MAIL_CACHE_UNAVAILABLE'), detail: 'node:sqlite is missing (Node 22.5 or newer is needed); an in-memory cache is used' }
    // A WAL database that no process has open can refuse a read-only open: fall back to the file header.
    try {
      const fd = openSync(path, 'r')
      try {
        const b = Buffer.alloc(16)
        readSync(fd, b, 0, 16, 0)
        if (b.toString('latin1') === 'SQLite format 3\0') return { status: 'ok', detail: 'cache.db header is valid (a read-only open was refused, normal for an idle WAL database)' }
      } finally { closeSync(fd) }
    } catch { /* fall through */ }
    return { status: 'warn', ...why('MAIL_CACHE_UNAVAILABLE'), detail: 'cache.db cannot be opened' }
  }
}

/**
 * @param ctx  the cordis context (only used for the settings mode)
 * @param d    { version, dataDir, effective, resolved, store, tokens, service, idle, queue, drafts,
 *               getCache, secretReady, configVisible, unsubListening }
 */
export async function buildDoctor(ctx, d) {
  const host = await hostInfo(ctx)
  const checks = []
  const now = Date.now()
  const settings = d.effective()
  const all = d.resolved().all

  checks.push(await check('plugin', 'Plugin running', () => d.secretReady()
    ? { status: 'ok', detail: 'version ' + d.version + ', capability secret ready' }
    : { status: 'warn', ...why('MAIL_NOT_READY'), detail: 'version ' + d.version + ', capability secret not ready yet' }))

  checks.push(await check('settings', 'Settings readable and writable', () => {
    const sd = d.store.describe()
    const writable = !!d.store.canWrite()
    if (!writable) return { status: 'fail', ...why('MAIL_SETTINGS_UNAVAILABLE', { human: true }), detail: 'mode ' + sd.mode + ', not writable' }
    if (host.settingsMode === 'config' && host.dshLine !== 'unknown') return { status: 'warn', ...why('MAIL_SETTINGS_UNAVAILABLE', { human: true }), detail: 'the host exposes no settings service; values come from the plugin settings.json fallback' }
    return { status: 'ok', detail: 'mode ' + sd.mode + ', host settings ' + host.settingsMode + ', writable' }
  }))

  checks.push(await check('config', 'Config visible to the loader', () => {
    if (d.configVisible) return { status: 'ok', detail: 'Config is on the default export' }
    if (host.settingsMode === 'forms') return { status: 'fail', ...why('MAIL_SETTINGS_UNAVAILABLE', { human: true }), detail: 'no Config on the default export; the settings form cannot be built on this host' }
    return { status: 'skip', detail: 'no Config (the settings schema library was not found); only needed on DSH 0.2.x forms' }
  }))

  checks.push(await check('accounts', 'Accounts configured', () => {
    const enabled = all.filter(a => a.enabled).length
    if (!all.length) return { status: 'warn', ...why('MAIL_NO_ACCOUNTS', { human: true }), detail: 'count 0' }
    return { status: 'ok', detail: 'count ' + all.length + ', enabled ' + enabled }
  }))

  for (const acc of all.slice(0, MAX_ACCOUNT_ROWS)) {
    checks.push(await check('account:' + acc.id, 'Account ' + acc.id, () => {
      const parts = ['type ' + acc.type, acc.enabled ? 'enabled' : 'disabled']
      const oauth = usesOAuth(acc)
      const present = secretPresent(acc, d.tokens)
      parts.push('secret present: ' + present)
      let needsReauth = false
      if (oauth) { const t = d.tokens.status(acc.id) || {}; needsReauth = !!t.needsReauth; parts.push('needsReauth: ' + needsReauth) }
      const kind = receiveKind(acc)
      const st = d.service.status.get(acc.id)
      if (kind === 'imap' || kind === 'pop3') parts.push(st ? 'last sync ' + (st.ok ? 'ok' : 'failed') + ' ' + age(now - st.at) + ' ago' : 'last sync: none yet')
      if (acc.type === 'sendgrid') {
        const hook = !!(acc.secrets && acc.secrets.webhookSecret)
        parts.push('inbound enabled: ' + !!(acc.inbound && acc.inbound.enabled) + ', webhook secret present: ' + hook)
        if (acc.inbound && acc.inbound.enabled && !hook) return { status: 'warn', ...why('MAIL_SECRET_MISSING', { human: true }), detail: parts.join(', ') }
      }
      if (!acc.enabled) return { status: 'info', ...why('MAIL_ACCOUNT_DISABLED'), detail: parts.join(', ') }
      if (oauth && needsReauth) return { status: 'warn', ...why('MAIL_OAUTH_REAUTH', { human: true }), detail: parts.join(', ') }
      if (!present) {
        if (oauth) return { status: 'warn', ...why('MAIL_OAUTH_REAUTH', { human: true }), detail: parts.join(', ') + ', not connected' }
        return { status: 'warn', ...why('MAIL_SECRET_MISSING', { human: true }), detail: parts.join(', ') }
      }
      if (st && st.ok === false) {
        const code = classify(new Error(st.error || ''), 'MAIL_MAILBOX_UNREACHABLE').code
        return { status: 'warn', ...why(E.has(code) ? code : 'MAIL_MAILBOX_UNREACHABLE'), detail: parts.join(', ') + ', last error code ' + code }
      }
      return { status: 'ok', detail: parts.join(', ') }
    }))
  }
  if (all.length > MAX_ACCOUNT_ROWS) checks.push({ id: 'accounts-truncated', label: 'More accounts than rows', status: 'info', detail: 'showing ' + MAX_ACCOUNT_ROWS + ' of ' + all.length })

  checks.push(await check('agents', 'Agent tools', () => {
    const a = settings.agents || {}
    const mode = d.effectiveConfirmMode()
    if (a.enabled === false) return { status: 'warn', ...why('MAIL_TOOLS_DISABLED', { human: true }), detail: 'agents.enabled false, confirm mode ' + mode }
    return { status: 'ok', detail: 'agents.enabled true, confirm mode ' + mode }
  }))

  checks.push(await check('data-dir', 'Data directory mode', () => {
    if (process.platform === 'win32') return { status: 'skip', detail: 'file modes are not checked on Windows' }
    let st
    try { st = statSync(d.dataDir) } catch { return { status: 'info', detail: 'not created yet' } }
    if (loose(st)) return { status: 'warn', ...why('MAIL_DATA_PERMISSIONS', { human: true }), detail: 'mode ' + modeOf(st) + ', expected 700' }
    return { status: 'ok', detail: 'mode ' + modeOf(st) }
  }))

  checks.push(await check('secrets-files', 'Secrets files mode', () => {
    if (process.platform === 'win32') return { status: 'skip', detail: 'file modes are not checked on Windows' }
    const seen = []
    const bad = []
    for (const f of SECRET_FILES) {
      let st
      try { st = statSync(join(d.dataDir, f)) } catch { continue }
      seen.push(f + ' ' + modeOf(st))
      if (loose(st)) bad.push(f)
    }
    if (bad.length) return { status: 'warn', ...why('MAIL_DATA_PERMISSIONS', { human: true }), detail: 'loose: ' + bad.join(', ') + ' (expected 600); ' + seen.join(', ') }
    return { status: 'ok', detail: seen.length ? seen.join(', ') : 'no secrets file yet' }
  }))

  checks.push(await check('cache', 'Local cache', () => {
    if (settings.cache && settings.cache.enabled === false) return { status: 'skip', detail: 'cache.enabled is false' }
    const open = d.getCache()
    if (open) {
      if (open.kind !== 'sqlite') return { status: 'warn', ...why('MAIL_CACHE_UNAVAILABLE'), detail: 'in-memory cache (lost at restart); node:sqlite was not usable' }
      return { status: 'ok', detail: 'sqlite, open, fts ' + !!open.fts }
    }
    return probeCacheFile(join(d.dataDir, 'cache.db'))
  }))

  checks.push(await check('unsubscribe', 'Unsubscribe links', () => {
    const u = settings.unsubscribe || {}
    const pub = typeof u.publicBaseUrl === 'string' && u.publicBaseUrl.trim() !== ''
    const port = Number(u.listenPort) || 0
    const wanted = String(u.listenHost || '127.0.0.1').trim().toLowerCase()
    const bound = unsubListenHost(u.listenHost)
    const parts = ['publicBaseUrl set: ' + pub, 'mailto set: ' + !!u.mailto, 'listener: ' + (port > 0 ? (d.unsubListening() ? 'on' : 'configured, not listening') + ', loopback ' + (wanted === bound) : 'off')]
    if (port > 0 && wanted !== bound) return { status: 'warn', ...why('MAIL_UNSUBSCRIBE_NOT_PUBLIC', { hint: 'unsubscribe.listenHost is not a loopback address; the listener falls back to 127.0.0.1. Put an edge proxy in front, see docs/TROUBLESHOOTING.md entry 8.' }), detail: parts.join(', ') }
    if (port > 0 && !d.unsubListening()) return { status: 'warn', ...why('MAIL_UNSUBSCRIBE_NOT_PUBLIC', { hint: 'unsubscribe.listenPort is set but nothing listens (port in use?). Check the log, see docs/TROUBLESHOOTING.md entry 8.' }), detail: parts.join(', ') }
    if (!pub) return { status: 'info', ...why('MAIL_UNSUBSCRIBE_NOT_PUBLIC'), detail: parts.join(', ') + ' (only the mailto unsubscribe is offered)' }
    return { status: 'ok', detail: parts.join(', ') }
  }))

  checks.push(await check('idle', 'IMAP IDLE (instant new mail)', () => {
    const want = all.filter(a => a.enabled && a.push && a.receive && a.receive.protocol === 'imap')
    if (!want.length) return { status: 'skip', detail: 'no account has push enabled (polling every ' + (Number(settings.cache && settings.cache.pollSeconds) || 300) + ' s)' }
    const st = d.idle.status()
    const modes = Object.values(st).map(s => String(s.mode))
    const polling = modes.filter(m => m.startsWith('polling')).length
    const detail = 'push accounts ' + want.length + ', max ' + (Number(settings.push && settings.push.maxAccounts) || 0) + ', idle ' + modes.filter(m => m === 'idle').length + ', polling ' + polling + ', connecting or reconnecting ' + (modes.length - polling - modes.filter(m => m === 'idle').length)
    if (polling) return { status: 'warn', ...why('MAIL_IDLE_UNAVAILABLE'), detail }
    return { status: 'ok', detail }
  }))

  checks.push(await check('queue', 'Send queue and drafts', async () => {
    const q = await d.queue.list()
    const n = s => q.filter(e => e.status === s).length
    const dr = await d.drafts.list()
    const detail = 'queued ' + n('queued') + ', scheduled ' + n('scheduled') + ', sending ' + n('sending') + ', sent ' + n('sent') + ', failed ' + n('failed') + ', cancelled ' + n('cancelled') + ', drafts ' + dr.length
    if (n('failed') > 0) return { status: 'info', ...why('MAIL_SEND_FAILED'), detail }
    return { status: 'ok', detail }
  }))

  return doctorReport({ plugin: 'dsh-mail', version: d.version, host, checks })
}
