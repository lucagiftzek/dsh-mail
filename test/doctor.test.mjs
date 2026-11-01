/**
 * dsh-mail tests: the doctor (lib/doctor.js), GET /dsh-mail/api/doctor, the
 * mail_doctor tool and the registration of the packaged skill. Planted canary
 * secrets must never appear in any report.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, chmodSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import net from 'node:net'

import { test, section } from './harness.mjs'
import { bootPlugin, request } from './helpers.mjs'
import { E } from '../lib/errors.js'

const CANARY = ['doctor-canary-pw-4417', 'doctor-canary-key-8802', 'doctor-canary-hook-3359', 'doctor-canary-sync-6641']
const dir = mkdtempSync(join(tmpdir(), 'dsh-mail-doctor-'))
const settings = {
  trustedHosts: ['llm.example.org'],
  accounts: [
    { id: 'work', type: 'imap-smtp', address: 'me@example.com', receive: { protocol: 'imap', host: '127.0.0.1', port: 1, security: 'none' }, send: { protocol: 'smtp', host: '127.0.0.1', port: 1, security: 'none' }, secrets: { password: CANARY[0] }, push: true },
    { id: 'nopw', type: 'imap-smtp', address: 'nopw@example.com', receive: { protocol: 'imap', host: '127.0.0.1', port: 1, security: 'none' }, send: { protocol: 'smtp', host: '127.0.0.1', port: 1, security: 'none' } },
    { id: 'tx', type: 'resend', secrets: { apiKey: CANARY[1] } },
    { id: 'gm', type: 'google', address: 'gm@example.com', auth: { method: 'oauth2' } },
    { id: 'off', type: 'resend', enabled: false, secrets: { apiKey: CANARY[1] } },
    { id: 'sg', type: 'sendgrid', secrets: { apiKey: CANARY[1], webhookSecret: CANARY[2] }, inbound: { enabled: true } },
  ],
  unsubscribe: { publicBaseUrl: 'https://private-host.example/x', mailto: 'u@example.com' },
}

section('doctor: route')
const skillProviders = []
const asked = []
const p = await bootPlugin({ dir, settings, extra: { inject: (deps, cb) => { asked.push(deps); cb({ skills: { registerProvider: f => skillProviders.push(f()) } }) } } })
const noSecret = (label, text) => {
  for (const c of CANARY) assert.ok(!text.includes(c), label + ' leaks a secret')
  assert.ok(!/@example\.com|private-host\.example/.test(text), label + ' leaks an address or host')
}
chmodSync(join(process.env.DSH_MAIL_DATA_DIR, 'settings.json'), 0o600) // the fixture writes it with the default umask; the plugin itself writes 0600
p.service.status.set('work', { ok: false, error: 'AUTHENTICATIONFAILED password=' + CANARY[3] + ' for me@example.com', at: Date.now() - 125000 })

await test('GET /doctor answers 200 with the doctorReport shape and no secret, address or host', async () => {
  const r = await request(p.port, 'GET', '/doctor')
  assert.equal(r.status, 200)
  assert.equal(r.headers['cache-control'], 'no-store')
  noSecret('/doctor', r.text)
  const j = r.json
  assert.equal(j.plugin, 'dsh-mail')
  assert.equal(j.version, '0.2.1')
  assert.ok(['ok', 'warn', 'fail'].includes(j.status))
  assert.equal(j.docs, 'docs/TROUBLESHOOTING.md')
  assert.ok(j.host && j.host.node && j.host.settingsMode && j.host.platform)
  assert.ok(Date.parse(j.generatedAt) > 0)
  const ids = j.checks.map(c => c.id)
  for (const id of ['plugin', 'settings', 'config', 'accounts', 'agents', 'data-dir', 'secrets-files', 'cache', 'unsubscribe', 'idle', 'queue']) assert.ok(ids.includes(id), 'check ' + id)
  for (const a of settings.accounts) assert.ok(ids.includes('account:' + a.id), 'account row ' + a.id)
  for (const c of j.checks) {
    assert.ok(c.id && c.label && ['ok', 'warn', 'fail', 'skip', 'info'].includes(c.status))
    if (c.status === 'warn' || c.status === 'fail') {
      assert.ok(E.has(c.code), c.id + ' carries a catalog code')
      assert.ok(c.hint && c.docs && c.docs.startsWith('docs/ERRORS.md#mail_'), c.id + ' carries hint and docs')
    }
    assert.ok(!/[\u2013\u2014]/.test(JSON.stringify(c)), c.id + ' has no dash')
  }
})
await test('account rows: secret present booleans, reauth, last sync with age, disabled, inbound', async () => {
  const j = (await request(p.port, 'GET', '/doctor')).json
  const row = id => j.checks.find(c => c.id === 'account:' + id)
  assert.equal(row('work').status, 'warn'); assert.equal(row('work').code, 'MAIL_ACCOUNT_AUTH_FAILED')
  assert.match(row('work').detail, /type imap-smtp, enabled, secret present: true, last sync failed 2m ago/)
  assert.equal(row('nopw').code, 'MAIL_SECRET_MISSING'); assert.match(row('nopw').detail, /secret present: false/); assert.ok(row('nopw').human)
  assert.equal(row('tx').status, 'ok'); assert.match(row('tx').detail, /secret present: true/)
  assert.equal(row('gm').code, 'MAIL_OAUTH_REAUTH'); assert.match(row('gm').detail, /needsReauth: false/)
  assert.equal(row('off').status, 'info'); assert.equal(row('off').code, 'MAIL_ACCOUNT_DISABLED')
  assert.equal(row('sg').status, 'ok'); assert.match(row('sg').detail, /inbound enabled: true, webhook secret present: true/)
  assert.equal(j.checks.find(c => c.id === 'accounts').detail, 'count 6, enabled 5')
  assert.equal(j.status, 'warn')
})
await test('unsubscribe, agents, queue and idle rows', async () => {
  const j = (await request(p.port, 'GET', '/doctor')).json
  const row = id => j.checks.find(c => c.id === id)
  assert.equal(row('unsubscribe').status, 'ok'); assert.match(row('unsubscribe').detail, /publicBaseUrl set: true, mailto set: true, listener: off/)
  assert.match(row('agents').detail, /agents\.enabled true, confirm mode (all|reply-only)/)
  assert.match(row('queue').detail, /queued 0, scheduled 0, sending 0, sent 0, failed 0, cancelled 0, drafts 0/)
  assert.ok(['ok', 'warn'].includes(row('idle').status)) // work has push; the fake host refuses, so the state depends on timing
  assert.match(row('idle').detail, /push accounts 1/)
  assert.equal(row('cache').status, 'ok')
})
await test('loose permissions on the data directory and a secrets file are reported with MAIL_DATA_PERMISSIONS', async () => {
  const data = process.env.DSH_MAIL_DATA_DIR
  const sec = join(data, 'secrets.json')
  writeFileSync(sec, '{"accounts":{}}', { mode: 0o644 }); chmodSync(sec, 0o644)
  chmodSync(data, 0o755)
  try {
    const j = (await request(p.port, 'GET', '/doctor')).json
    const d = j.checks.find(c => c.id === 'data-dir'); const f = j.checks.find(c => c.id === 'secrets-files')
    assert.equal(d.status, 'warn'); assert.equal(d.code, 'MAIL_DATA_PERMISSIONS'); assert.match(d.detail, /mode 755/)
    assert.equal(f.status, 'warn'); assert.equal(f.code, 'MAIL_DATA_PERMISSIONS'); assert.match(f.detail, /loose: secrets\.json/)
  } finally { chmodSync(data, 0o700); chmodSync(sec, 0o600) }
  const j2 = (await request(p.port, 'GET', '/doctor')).json
  assert.equal(j2.checks.find(c => c.id === 'data-dir').status, 'ok')
  assert.equal(j2.checks.find(c => c.id === 'secrets-files').status, 'ok')
})
await test('read gate: foreign Host, cross-site and POST are refused with a MAIL_* code', async () => {
  const a = await request(p.port, 'GET', '/doctor', { headers: { host: 'evil.example' } })
  assert.equal(a.status, 403); assert.equal(a.json.ok, false); assert.equal(a.json.code, 'MAIL_REQUEST_FORBIDDEN'); assert.ok(a.json.docs)
  const b = await request(p.port, 'GET', '/doctor', { headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(b.status, 403); assert.equal(b.json.code, 'MAIL_REQUEST_FORBIDDEN')
  assert.equal((await request(p.port, 'GET', '/doctor', { headers: { host: 'llm.example.org' } })).status, 200)
  const c = await request(p.port, 'POST', '/doctor', { body: {} })
  assert.ok(c.status === 403 || c.status === 405, 'POST is not the doctor')
  assert.equal(c.json.ok, false)
})

section('doctor: tool')
await test('mail_doctor returns the declared fields, no secret, and makes no network call', async () => {
  const tool = p.tools.get('mail_doctor')
  assert.ok(tool, 'mail_doctor is registered')
  assert.deepEqual(tool.parameters, {})
  const seen = []
  const realConnect = net.Socket.prototype.connect
  const realFetch = globalThis.fetch
  net.Socket.prototype.connect = function (...a) { seen.push('connect'); return realConnect.apply(this, a) }
  globalThis.fetch = (...a) => { seen.push('fetch'); return realFetch(...a) }
  let r
  try { r = await tool.execute({}) } finally { net.Socket.prototype.connect = realConnect; globalThis.fetch = realFetch }
  assert.deepEqual(seen, [], 'the doctor is offline')
  assert.equal(r.ok, true)
  noSecret('mail_doctor', JSON.stringify(r))
  assert.equal(r.plugin, 'dsh-mail'); assert.equal(r.status, 'warn'); assert.ok(Array.isArray(r.checks) && r.checks.length > 10)
  assert.match(r.text, /^dsh-mail doctor: warn\n/); assert.match(r.text, /WARN account:nopw \[MAIL_SECRET_MISSING\]/)
  assert.ok(!/[\u2013\u2014]/.test(r.text))
})

section('doctor: skill registration')
await test('apply() registers the packaged mail-doctor skill through ctx.inject(["skills"])', async () => {
  assert.ok(asked.some(d => d.length === 1 && d[0] === 'skills'))
  const prov = skillProviders.find(x => x.name === 'plugin-dsh-mail')
  assert.ok(prov, 'provider plugin-dsh-mail')
  const [cand] = await prov.list()
  assert.equal(cand.name, 'mail-doctor'); assert.equal(cand.source, 'bundled')
  const def = await prov.get(cand, {})
  assert.match(def.content, /^# dsh-mail doctor/)
  assert.ok(existsSync(new URL('../skills/mail-doctor/SKILL.md', import.meta.url)))
})
await test('a host without ctx.inject or without the skills service does not break apply()', async () => {
  const d2 = mkdtempSync(join(tmpdir(), 'dsh-mail-doctor2-'))
  const q = await bootPlugin({ dir: d2, settings: {}, extra: { inject: (_d, cb) => cb({}) } })
  assert.equal((await request(q.port, 'GET', '/doctor')).status, 200)
  await q.close()
  const d3 = mkdtempSync(join(tmpdir(), 'dsh-mail-doctor3-'))
  const s = await bootPlugin({ dir: d3, settings: {}, strict: true, withDshSettings: null })
  assert.equal((await request(s.port, 'GET', '/doctor')).json.checks.find(c => c.id === 'accounts').code, 'MAIL_NO_ACCOUNTS')
  await s.close()
})
await test('package.json ships skills and docs; the skill is valid and dash free', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(pkg.files.includes('skills') && pkg.files.includes('docs'))
  const t = readFileSync(new URL('../skills/mail-doctor/SKILL.md', import.meta.url), 'utf8')
  assert.match(t, /^---\nname: mail-doctor\ndescription: [^\n]+\n---\n/)
  assert.ok(!/[\u2013\u2014]/.test(t))
  for (const m of t.matchAll(/`(MAIL_[A-Z_]+)`/g)) assert.ok(E.has(m[1]), 'skill mentions unknown code ' + m[1])
})

await p.close()
