/**
 * dsh-mail tests: settings on every host shape.
 *
 *   register  fake DSH 0.1.5 ctx with ctx.settings.register
 *   forms     fake DSH 0.2.1 ctx with SettingsForms (update/describe, no
 *             register), loader entries and a settings.yaml.imported holding
 *             a v0.1 section with secrets. Needs a schemastery with
 *             .volatile(): run with DSH_GLOBAL_PREFIX=<dsh 0.2.x prefix>,
 *             otherwise this half is reported as skipped.
 *   no inject a strict ctx where reading ctx.settings throws (DSH 0.2 when
 *             'settings' is not injected): apply() must not throw
 *
 * Secrets must never reach the 0.1.5 section writes or the 0.2 profile row.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { test, section } from './harness.mjs'
import { bootPlugin, request, mutate } from './helpers.mjs'

const mod = await import('../lib/index.js')
const { loadHostSchemastery, isRef } = await import('../lib/dual-settings.js')
const z = loadHostSchemastery(import.meta.url)
const volatileOk = !!(z && typeof z.prototype.volatile === 'function')
const WRITE = Symbol.for('cosmokit.volatile.write')
const CANARY = ['lm-canary-77881', 'tz-canary-55443', 'acct-pw-canary-99']

const merge = (a, b) => (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b))
  ? Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(k => [k, k in b ? merge(a[k], b[k]) : a[k]])) : b

section('settings: Config declares the live v0.1 section')
await test('Config exists, declares every top-level key of the v0.1 block and of v2, no secret field', async () => {
  assert.ok(mod.Config, 'Config built with the host schemastery')
  assert.equal(mod.default.Config, mod.Config, 'Config is on the default export too (the 0.2 Loader reads it there)')
  assert.ok(mod.default.inject.includes('settings'))
  const dict = mod.Config.dict
  for (const k of ['enabled', 'defaultProvider', 'defaultFrom', 'defaultReplyTo', 'trustedHosts', 'requireHarnessCookie', 'maxRecipients', 'maxBodyChars', 'maxCsvRows', 'minDelayMs', 'maxDelayMs', 'tickSeconds', 'mailboxBaseUrl', 'providers', 'accounts', 'agents', 'cache', 'mass', 'audit', 'oauth', 'schemaVersion']) assert.ok(dict[k], 'declares ' + k)
  assert.ok(!dict.mailboxAgentToken, 'no secret top-level field')
  const { plain } = await import('../lib/dual-settings.js')
  const prov = JSON.stringify(plain(mod.Config({})).providers)
  for (const f of ['lettermintApiKey', 'agentmailApiKey', 'resendApiKey', 'smtpPass', 'tzmailPass']) assert.ok(!prov.includes(f), 'no secret provider field ' + f)
  if (volatileOk) for (const [k, v] of Object.entries(dict)) assert.equal(v.meta.volatile, true, k + ' is live')
  // the maintainer's real section shape validates
  const v = mod.Config({ trustedHosts: ['llm.example.org'], mailboxBaseUrl: 'https://mail.example.org', providers: { tzmail: { tzmailBaseURL: 'https://mail.example.org' } } })
  assert.ok(v)
})

section('settings: DSH 0.1.5 (ctx.settings.register)')
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mail-reg-'))
  let stored = { trustedHosts: ['llm.example.org'], accounts: [] }
  const writes = []
  const registered = []
  const fake = {
    register(ns, schema, opts) {
      registered.push([ns, opts.applies])
      return { get: () => schema(merge(opts.base, stored)), update: async p => { writes.push(structuredClone(p)); stored = merge(stored, p) } }
    },
  }
  const p = await bootPlugin({ dir, withDshSettings: fake, noSettingsFile: true, strict: true })
  await test('register mode: namespace dsh-mail, live; account secrets go to the 0600 file, never into the section', async () => {
    assert.deepEqual(registered, [['dsh-mail', 'live']])
    const acc = (await request(p.port, 'GET', '/accounts')).json
    assert.equal(acc.settingsStore.mode, 'register')
    const r = await mutate(p.port, '/accounts/save', { account: { id: 'work', type: 'imap-smtp', address: 'me@example.org', receive: { host: 'imap.example.org' }, send: { host: 'smtp.example.org' }, secrets: { password: CANARY[2] } } })
    assert.equal(r.status, 200, r.text)
    assert.ok(writes.length >= 1)
    for (const w of writes) assert.ok(!JSON.stringify(w).includes(CANARY[2]), 'secret written to the settings section')
    const file = join(dir, 'data', 'secrets.json')
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.ok(readFileSync(file, 'utf8').includes(CANARY[2]))
    assert.ok(p.resolved().all.find(a => a.id === 'work').secrets.password === CANARY[2], 'secret resolved (value not printed)')
    const again = (await request(p.port, 'GET', '/accounts')).json.accounts.find(a => a.id === 'work')
    assert.equal(again.secrets.password, '__set__')
  })
  await p.close()
  rmSync(dir, { recursive: true, force: true })
}

section('settings: ctx without the settings service (strict, not injected)')
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mail-noinj-'))
  let p
  await test('apply() does not throw when reading ctx.settings throws; config mode with the file store', async () => {
    p = await bootPlugin({ dir, strict: true, settings: { trustedHosts: ['x.example.org'] } })
    const st = (await request(p.port, 'GET', '/state')).json
    assert.equal(st.ok, true)
    const acc = (await request(p.port, 'GET', '/accounts')).json
    assert.equal(acc.settingsStore.mode, 'config')
    assert.equal((await mutate(p.port, '/settings', { settings: { agents: { confirmMode: 'reply-only' } } })).status, 200)
    assert.equal((await request(p.port, 'GET', '/state')).json.confirmMode.mode, 'reply-only')
  })
  if (p) await p.close()
  rmSync(dir, { recursive: true, force: true })
}

section('settings: DSH 0.2.1 forms (SettingsForms, profile row, legacy import)')
if (!volatileOk) {
  console.log('  SKIP forms mode: no schemastery with volatile() (run with DSH_GLOBAL_PREFIX=<dsh 0.2.x prefix>)')
} else {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mail-forms-'))
  const home = join(dir, 'home'); mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'settings.yaml.imported'), [
    'dsh-mail:',
    '  trustedHosts:',
    '    - llm.example.org',
    '  mailboxBaseUrl: https://mail.example.org',
    '  mailboxAgentToken: ' + CANARY[1],
    '  providers:',
    '    tzmail:',
    '      tzmailBaseURL: https://mail.example.org',
    '    lettermint:',
    '      lettermintApiKey: ' + CANARY[0],
    '',
  ].join('\n'), { mode: 0o600 })
  let user = {}
  const writes = []
  const config = mod.Config(structuredClone(user))
  const fiber = {}
  const forms = {
    describe: () => [{ ns: 'dsh-mail', user: structuredClone(user) }],
    async update(id, patch) {
      assert.equal(id, 'dsh-mail')
      for (const k of Object.keys(patch)) if (!(mod.Config.dict[k] && mod.Config.dict[k].meta.volatile)) throw new Error('Config field "' + k + '" is not volatile')
      writes.push(structuredClone(patch))
      user = merge(user, patch)
      const next = mod.Config(structuredClone(user))
      for (const [k, v] of Object.entries(config)) if (isRef(v)) v[WRITE](next[k].get())
    },
    configure: () => () => {},
  }
  const extra = { fiber, loader: { entries: () => [{ options: { id: 'dsh-mail', name: 'dsh-mail' }, fiber }], await: async () => {} }, profileContext: { home } }
  const p = await bootPlugin({ dir, withDshSettings: forms, extra, strict: true, noSettingsFile: true, config })
  await new Promise(r => setTimeout(r, 200))
  await test('one-time import of the v0.1 section into the row, secrets moved to the 0600 file, never into the row', async () => {
    assert.equal(writes.length, 1, 'one import write')
    const w = JSON.stringify(writes[0])
    for (const c of CANARY) assert.ok(!w.includes(c), 'row contains a secret')
    assert.deepEqual(writes[0].trustedHosts, ['llm.example.org'])
    assert.equal(writes[0].mailboxBaseUrl, 'https://mail.example.org')
    const sec = readFileSync(join(dir, 'data', 'secrets.json'), 'utf8')
    assert.ok(sec.includes(CANARY[0]) && sec.includes(CANARY[1]))
    const acc = (await request(p.port, 'GET', '/accounts')).json
    assert.equal(acc.settingsStore.mode, 'forms'); assert.equal(acc.settingsStore.legacyImport, 'imported')
  })
  await test('effective settings resolve the legacy accounts with the moved secrets (same as on 0.1.5)', async () => {
    const r = p.resolved()
    assert.deepEqual(r.all.map(a => a.id), ['tzmail', 'lettermint'])
    assert.ok(r.all.find(a => a.id === 'lettermint').legacyCreds.lettermintApiKey === CANARY[0], 'secret resolved (value not printed)')
    assert.ok(r.all.find(a => a.id === 'tzmail').secrets.apiKey === CANARY[1], 'secret resolved (value not printed)')
    const st = (await request(p.port, 'GET', '/state', { headers: { host: 'llm.example.org' } }))
    assert.equal(st.status, 200, 'trustedHosts from the imported row are live')
    for (const c of CANARY) assert.ok(!st.text.includes(c))
    assert.equal(st.json.confirmMode.mode, 'reply-only')
  })
  await test('saves go through SettingsForms.update with live fields only, secrets to the file', async () => {
    const r = await mutate(p.port, '/accounts/save', { account: { id: 'work', type: 'imap-smtp', address: 'me@example.org', receive: { host: 'imap.example.org' }, send: { host: 'smtp.example.org' }, secrets: { password: CANARY[2] } } })
    assert.equal(r.status, 200, r.text)
    const last = writes[writes.length - 1]
    assert.ok(last.accounts && !JSON.stringify(last).includes(CANARY[2]))
    assert.equal(p.resolved().explicit[0].id, 'work')
    assert.ok(p.resolved().explicit[0].secrets.password === CANARY[2], 'secret resolved (value not printed)')
    assert.equal((await mutate(p.port, '/settings', { settings: { agents: { confirmMode: 'all' } } })).status, 200)
    assert.equal(p.effective().agents.confirmMode, 'all')
  })
  await p.close()
  rmSync(dir, { recursive: true, force: true })
}
