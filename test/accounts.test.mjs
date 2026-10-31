/**
 * dsh-mail tests: account model, "__set__" secret round trip and the legacy
 * shim (a v0.1 settings block must yield the same behaviour with zero edits).
 *
 * Opt-in live check: DSH_MAIL_LIVE_CHECK=1 also resolves the dsh-mail block of
 * the real ~/.dsh/settings.yaml (or settings.yaml.imported) and prints only the
 * resulting account ids, types and the confirm mode, never values.
 */
import { strict as assert } from 'node:assert'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { test, section } from './harness.mjs'
import {
  resolveAccounts, legacyAccounts, effectiveConfirmMode, defaultAccountId, findAccount, redactAccount,
  mergeSecrets, agentDenied, normalizeAccount, validateAccount, secretValues, scrub, LEGACY_PROVIDER_IDS,
} from '../lib/accounts.js'
import { DEFAULTS, resolveConfig, settingsSchema, loadSchemastery, upsertAccount, safeSettings } from '../lib/index.js'
import { readLegacyYamlBlock } from '../lib/settings-store.js'

// The v0.1 block exactly as it is shaped on the maintainer's install (host names replaced).
const V01_BLOCK = {
  trustedHosts: ['llm.example.org'],
  mailboxBaseUrl: 'https://mail.example.org',
  providers: { tzmail: { tzmailBaseURL: 'https://mail.example.org' } },
}
const ESTATE = { lettermintApiKey: 'lm-canary-key-123', agentmailApiKey: 'am-canary-key-456', agentmailInbox: 'inbox-x' }
const MAILBOX = { MAIL_AGENT_BASE_URL: 'https://mail.example.org', MAIL_AGENT_TOKEN: 'tz-canary-token-789' }
const z = loadSchemastery()
const schema = settingsSchema(z)
const load = (block) => resolveConfig(schema ? schema(structuredClone({ ...DEFAULTS, ...block, providers: { ...DEFAULTS.providers, ...(block.providers || {}) } })) : { ...DEFAULTS, ...block })

section('accounts.js: legacy shim (migration of the v0.1 block, zero edits)')
await test('schemastery is found and the v0.1 block validates against the v2 schema', () => {
  assert.ok(z, 'schemastery not found')
  const v = load(V01_BLOCK)
  assert.deepEqual(v.trustedHosts, ['llm.example.org'])
  assert.equal(v.agents.confirmMode, undefined)
})
await test('v0.1 block + credential files yield tzmail, lettermint, agentmail virtual accounts', () => {
  const s = load(V01_BLOCK)
  const r = resolveAccounts(s, { estate: ESTATE, mailboxCreds: MAILBOX, env: {} })
  assert.deepEqual(r.all.map(a => a.id), ['tzmail', 'lettermint', 'agentmail'])
  assert.equal(r.explicit.length, 0)
  const tz = findAccount(r, 'tzmail')
  assert.equal(tz.type, 'tzekos'); assert.equal(tz.api.baseUrl, 'https://mail.example.org'); assert.equal(tz.tokenFromFile, MAILBOX.MAIL_AGENT_TOKEN)
  assert.ok(tz.agent.allow && tz.agent.canRead && tz.agent.canSend)
  assert.equal(findAccount(r, 'lettermint').legacyProvider, 'lettermint')
  assert.equal(findAccount(r, 'agentmail').api.inbox, 'inbox-x')
})
await test('without pins: legacy install keeps v0.1 behaviour (reply-only, default lettermint)', () => {
  const s = load(V01_BLOCK)
  const r = resolveAccounts(s, { estate: ESTATE, mailboxCreds: MAILBOX, env: {} })
  assert.deepEqual(effectiveConfirmMode(s, r), { mode: 'reply-only', source: 'legacy-detected' })
  assert.equal(defaultAccountId(s, r), 'lettermint')
})
await test('with the documented pins the result is identical and explicit', () => {
  const s = load({ ...V01_BLOCK, defaultProvider: 'lettermint', agents: { confirmMode: 'reply-only' }, schemaVersion: 1 })
  const r = resolveAccounts(s, { estate: ESTATE, mailboxCreds: MAILBOX, env: {} })
  assert.deepEqual(effectiveConfirmMode(s, r), { mode: 'reply-only', source: 'settings' })
  assert.equal(defaultAccountId(s, r), 'lettermint')
  assert.deepEqual(r.all.map(a => a.id), ['tzmail', 'lettermint', 'agentmail'])
})
await test('every v0.1 provider id resolves when its credentials exist', () => {
  const s = load({
    ...V01_BLOCK,
    providers: {
      ...V01_BLOCK.providers,
      resend: { resendApiKey: 're_canary' },
      ovh: { smtpUser: 'u@example.org', smtpPass: 'ovh-canary-pass' },
      smtp: { smtpHost: 'smtp.example.org', smtpUser: 'u', smtpPass: 'smtp-canary-pass', imapHost: 'imap.example.org' },
      local: { smtpHost: '127.0.0.1', smtpUser: 'u', smtpPass: 'local-canary-pass' },
    },
  })
  const r = resolveAccounts(s, { estate: ESTATE, mailboxCreds: MAILBOX, env: {} })
  for (const id of LEGACY_PROVIDER_IDS) assert.ok(findAccount(r, id), 'provider id ' + id + ' does not resolve')
  assert.equal(findAccount(r, 'ovh').send.host, 'ssl0.ovh.net')
  assert.equal(findAccount(r, 'smtp').receive.protocol, 'imap')
  assert.equal(findAccount(r, 'smtp').secrets.password, 'smtp-canary-pass')
})
await test('fresh install (no block, no credential files): zero accounts, confirmMode all', () => {
  const s = load({})
  const r = resolveAccounts(s, { estate: {}, mailboxCreds: {}, env: {} })
  assert.equal(r.all.length, 0)
  assert.equal(effectiveConfirmMode(s, r).mode, 'all')
  assert.equal(defaultAccountId(s, r), '')
})
await test('explicit accounts win over legacy ones with the same id; legacy ones stay otherwise', () => {
  const s = load({ ...V01_BLOCK, accounts: [{ id: 'work', type: 'imap-smtp', address: 'me@example.org', receive: { host: 'imap.example.org' }, send: { host: 'smtp.example.org' }, agent: { allow: true, default: true } }, { id: 'lettermint', type: 'lettermint', secrets: { apiKey: 'x' } }] })
  const r = resolveAccounts(s, { estate: ESTATE, mailboxCreds: MAILBOX, env: {} })
  assert.deepEqual(r.all.map(a => a.id), ['work', 'lettermint', 'tzmail', 'agentmail'])
  assert.equal(findAccount(r, 'lettermint').legacy, undefined)
  assert.equal(defaultAccountId(s, r), 'work')
  assert.equal(effectiveConfirmMode(s, r).mode, 'all')
})

section('accounts.js: secrets')
await test('__set__ round trip: keep on "__set__", clear on "", replace on a new value', () => {
  const stored = [{ id: 'work', type: 'imap-smtp', receive: { host: 'imap.example.org' }, send: { host: 'smtp.example.org' }, secrets: { password: 'old-secret-pw', apiKey: 'old-api-key' } }]
  const redacted = redactAccount(normalizeAccount(stored[0]))
  assert.equal(redacted.secrets.password, '__set__'); assert.equal(redacted.secrets.apiKey, '__set__'); assert.equal(redacted.secrets.webhookSecret, '')
  assert.ok(!JSON.stringify(redacted).includes('old-secret-pw'))
  const keep = upsertAccount(stored, { ...redacted, label: 'Work' })
  assert.equal(keep.list[0].secrets.password, 'old-secret-pw'); assert.equal(keep.list[0].label, 'Work')
  const clear = upsertAccount(stored, { ...redacted, secrets: { ...redacted.secrets, apiKey: '' } })
  assert.equal(clear.list[0].secrets.apiKey, undefined); assert.equal(clear.list[0].secrets.password, 'old-secret-pw')
  const repl = upsertAccount(stored, { ...redacted, secrets: { ...redacted.secrets, password: 'new-pw-1' } })
  assert.equal(repl.list[0].secrets.password, 'new-pw-1')
  assert.deepEqual(mergeSecrets({ password: '__set__' }, {}), {})
})
await test('validation: ids, plaintext only to loopback, microsoft refused, immutable ids', () => {
  assert.ok(validateAccount(normalizeAccount({ id: 'A B' })).length)
  assert.ok(validateAccount(normalizeAccount({ id: 'x1', receive: { host: 'imap.example.org', security: 'none' }, send: { host: 'smtp.example.org' } })).some(e => e.includes('loopback')))
  assert.equal(validateAccount(normalizeAccount({ id: 'x1', receive: { host: '127.0.0.1', security: 'none' }, send: { host: '127.0.0.1', security: 'none' } })).length, 0)
  assert.ok(validateAccount(normalizeAccount({ id: 'ms', type: 'microsoft', receive: { host: 'outlook.office365.com' }, send: { host: 'smtp.office365.com' } })).some(e => e.includes('OAuth2')))
  assert.throws(() => upsertAccount([{ id: 'a1', receive: { host: 'h' }, send: { host: 'h' } }], { id: 'a2', receive: { host: 'h' }, send: { host: 'h' } }, 'a1'), /immutable/)
})
await test('agent permissions and scrubbing', () => {
  const a = normalizeAccount({ id: 'p1', agent: { allow: false } })
  assert.match(agentDenied(a, 'read', {}), /not permitted for agents/)
  const b = normalizeAccount({ id: 'p2', agent: { allow: true, canSend: false } })
  assert.equal(agentDenied(b, 'read', {}), null); assert.match(agentDenied(b, 'send', {}), /not permitted/)
  assert.match(agentDenied(b, 'read', { agents: { allowedAccounts: ['other'] } }), /not permitted/)
  const c = normalizeAccount({ id: 'p3', secrets: { password: 'hunter2-canary' } })
  assert.equal(scrub('login failed for hunter2-canary', secretValues([c])), 'login failed for ***')
  const safe = JSON.stringify(safeSettings(load({ ...V01_BLOCK, mailboxAgentToken: 'tok-canary', providers: { resend: { resendApiKey: 're-canary' } } })))
  assert.ok(!safe.includes('tok-canary') && !safe.includes('re-canary'))
})

if (process.env.DSH_MAIL_LIVE_CHECK === '1') {
  section('live check (opt-in): the real dsh-mail block of this machine')
  await test('real settings resolve (ids, types and confirm mode only)', () => {
    const { block, file } = readLegacyYamlBlock(join(homedir(), '.dsh'), 'dsh-mail')
    const s = load(block || {})
    const r = resolveAccounts(s)
    const mode = effectiveConfirmMode(s, r)
    console.log('       source ' + file + ': ' + r.all.map(a => a.id + '(' + a.type + ')').join(', ') + ' | confirmMode ' + mode.mode + ' (' + mode.source + ') | default ' + defaultAccountId(s, r))
    assert.ok(r.all.length >= 0)
  })
}
