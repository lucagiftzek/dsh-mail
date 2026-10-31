/**
 * dsh-mail tests: route security. Canary secrets must never appear in any
 * read response; the gates must refuse missing token / cookie / foreign Host;
 * attachment downloads refuse bad part ids and oversized parts.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { test, section } from './harness.mjs'
import { bootPlugin, request, mutate } from './helpers.mjs'

const CANARY = ['imap-canary-pw-5521', 'api-canary-key-7733', 'tz-canary-token-9911']
const dir = mkdtempSync(join(tmpdir(), 'dsh-mail-routes-'))
const settings = {
  trustedHosts: ['llm.example.org'],
  accounts: [
    { id: 'work', type: 'imap-smtp', address: 'me@example.org', receive: { protocol: 'imap', host: '127.0.0.1', port: 1, security: 'none' }, send: { protocol: 'smtp', host: '127.0.0.1', port: 1, security: 'none' }, secrets: { password: CANARY[0] }, agent: { allow: true } },
    { id: 'tx', type: 'resend', secrets: { apiKey: CANARY[1] }, agent: { allow: false } },
    { id: 'tz', type: 'tzekos', api: { baseUrl: 'http://127.0.0.1:1' }, secrets: { apiKey: CANARY[2] } },
  ],
}

section('routes: security')
const p = await bootPlugin({ dir, settings })
const noCanary = (label, text) => { for (const c of CANARY) assert.ok(!text.includes(c), label + ' leaks a secret') }

await test('no secret in any read response (state, accounts, folders, messages, session)', async () => {
  for (const path of ['/state', '/accounts', '/folders?account=work', '/messages?account=work&sync=0', '/messages?account=all&sync=0', '/thread?account=work&thread=x', '/message?id=work:INBOX:1', '/session']) {
    const r = await request(p.port, 'GET', path)
    noCanary(path, r.text)
  }
  const acc = (await request(p.port, 'GET', '/accounts')).json
  assert.equal(acc.accounts.find(a => a.id === 'work').secrets.password, '__set__')
  assert.equal(acc.settingsStore.mode, 'file')
})
await test('error messages from failing connections are scrubbed', async () => {
  const r = await mutate(p.port, '/accounts/test', { id: 'work' })
  noCanary('/accounts/test', r.text)
  assert.equal(r.json.result.ok, false)
})
await test('read gate refuses a foreign Host and cross-site fetches', async () => {
  assert.equal((await request(p.port, 'GET', '/state', { headers: { host: 'evil.example' } })).status, 403)
  assert.equal((await request(p.port, 'GET', '/state', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
  assert.equal((await request(p.port, 'GET', '/state', { headers: { host: 'llm.example.org' } })).status, 200)
})
await test('mutate gate refuses missing token, missing cookie, missing origin, wrong method', async () => {
  assert.equal((await mutate(p.port, '/messages/mark', { ids: [], op: 'read' }, { omit: ['x-dsh-mail-token'] })).json.layer, 'L3')
  assert.equal((await mutate(p.port, '/messages/mark', { ids: [], op: 'read' }, { omit: ['cookie'] })).json.layer, 'L4')
  assert.equal((await mutate(p.port, '/messages/mark', { ids: [], op: 'read' }, { omit: ['origin'] })).status, 403)
  assert.equal((await request(p.port, 'PUT', '/settings', { body: {} })).status, 405)
  const ok = await mutate(p.port, '/messages/mark', { ids: [], op: 'read' })
  assert.equal(ok.status, 200)
})
await test('attachment route refuses path traversal and bad ids', async () => {
  for (const q of ['id=work:INBOX:1&part=../../etc/passwd', 'id=../../etc:x:1&part=0', 'id=work:INBOX:1&part=-1', 'id=nonsense&part=0']) {
    const r = await request(p.port, 'GET', '/attachment?' + q)
    assert.equal(r.status, 400, q)
    noCanary(q, r.text)
  }
})
await test('attachments over 25 MB are refused', async () => {
  const orig = p.service.rawMessage
  p.service.rawMessage = async () => ({ parsed: { attachments: [{ filename: 'big.bin', size: 26 * 1024 * 1024, content: Buffer.alloc(1) }] }, flags: [] })
  try {
    const r = await request(p.port, 'GET', '/attachment?id=work:INBOX:1&part=0')
    assert.equal(r.status, 400); assert.match(r.json.error, /25 MB/)
  } finally { p.service.rawMessage = orig }
})
await test('accounts save keeps secrets on "__set__" through the route and never echoes them', async () => {
  const acc = (await request(p.port, 'GET', '/accounts')).json.accounts.find(a => a.id === 'work')
  const r = await mutate(p.port, '/accounts/save', { account: { ...acc, label: 'Work 2' } })
  assert.equal(r.status, 200); noCanary('/accounts/save', r.text)
  const again = (await request(p.port, 'GET', '/accounts')).json.accounts.find(a => a.id === 'work')
  assert.equal(again.label, 'Work 2'); assert.equal(again.secrets.password, '__set__')
  assert.equal(p.resolved().all.find(a => a.id === 'work').secrets.password, CANARY[0])
})
await test('tools: denied account returns the documented error; no accounts gives a clear error', async () => {
  const r = await p.tools.get('mail_send').execute({ account: 'tx', to: 'a@example.org', subject: 's', text: 't', confirm: true })
  assert.equal(r.ok, false); assert.equal(r.error, 'account tx not permitted for agents')
  const acc = await p.tools.get('mail_accounts').execute({})
  assert.ok(acc.ok && !acc.text.includes('tx:'))
  for (const c of CANARY) assert.ok(!JSON.stringify(acc).includes(c))
})

await p.close()
rmSync(dir, { recursive: true, force: true })

section('routes: fresh install (no settings at all)')
const dir2 = mkdtempSync(join(tmpdir(), 'dsh-mail-fresh-'))
const f = await bootPlugin({ dir: dir2, settings: {} })
await test('zero accounts: state is empty, tools say "no accounts configured" instead of throwing', async () => {
  const st = (await request(f.port, 'GET', '/state')).json
  assert.equal(st.accounts.length, 0); assert.equal(st.confirmMode.mode, 'all')
  const r = await f.tools.get('mail_send').execute({ to: 'a@example.org', subject: 's', text: 't' })
  assert.deepEqual([r.ok, r.error], [false, 'no accounts configured'])
  const rd = await f.tools.get('mail_read').execute({})
  assert.equal(rd.ok, false)
  const ib = await f.tools.get('mail_inbox').execute({})
  assert.equal(ib.ok, false)
})
await f.close()
rmSync(dir2, { recursive: true, force: true })

section('routes: DSH 0.1.x settings service (ctx.settings.register)')
const dir3 = mkdtempSync(join(tmpdir(), 'dsh-mail-dshsettings-'))
const { mergeLayers } = await import('../lib/settings-store.js')
let section3 = { trustedHosts: ['llm.example.org'], accounts: [{ id: 'w2', type: 'imap-smtp', receive: { host: '127.0.0.1', port: 1, security: 'none' }, send: { host: '127.0.0.1', port: 1, security: 'none' }, secrets: { password: CANARY[0] } }] }
const fakeSettings = {
  register(ns, schema, { base }) {
    assert.equal(ns, 'dsh-mail')
    return { get: () => schema(mergeLayers(base, section3)), update: async patch => { schema(mergeLayers(base, mergeLayers(section3, patch))); section3 = mergeLayers(section3, patch) } }
  },
}
const g = await bootPlugin({ dir: dir3, settings: {}, withDshSettings: fakeSettings })
await test('settings come from ctx.settings and saves go through scope.update', async () => {
  const acc = (await request(g.port, 'GET', '/accounts')).json
  assert.equal(acc.settingsStore.mode, 'dsh-settings')
  assert.equal(acc.accounts[0].id, 'w2'); assert.equal(acc.accounts[0].secrets.password, '__set__')
  const r = await mutate(g.port, '/settings', { settings: { agents: { confirmMode: 'reply-only' } } })
  assert.equal(r.status, 200); assert.equal(section3.agents.confirmMode, 'reply-only')
  const bad = await mutate(g.port, '/settings', { settings: { agents: { confirmMode: 'bogus' } } })
  assert.equal(section3.agents.confirmMode, 'reply-only', 'invalid values are dropped by the patch sanitiser')
  assert.equal(bad.status, 200)
})
await g.close()
rmSync(dir3, { recursive: true, force: true })
