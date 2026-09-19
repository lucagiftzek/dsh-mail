#!/usr/bin/env node
/**
 * dsh-mail — basic smoke tests.
 * Run: node test/run.mjs
 */
import { strict as assert } from 'node:assert'
import { rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'

// Test staging.js
import { parseCSV, personalise, slugify, Queue } from '../lib/staging.js'

let passed = 0, failed = 0
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name) }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + e.message) }
}
async function atest(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name) }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + e.message) }
}

console.log('staging.js:')
test('parseCSV basic', () => {
  const rows = parseCSV('name,email\nAlice,alice@test.com\nBob,bob@test.com', 100)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].name, 'Alice')
  assert.equal(rows[0].email, 'alice@test.com')
})
test('parseCSV empty', () => {
  assert.equal(parseCSV('', 100).length, 0)
  assert.equal(parseCSV('name,email', 100).length, 0)
})
test('parseCSV max rows', () => {
  const csv = 'email\n' + Array.from({length: 10}, (_, i) => 'u' + i + '@t.com').join('\n')
  assert.equal(parseCSV(csv, 5).length, 5)
})
test('personalise', () => {
  assert.equal(personalise('Hi {name}!', { name: 'World' }), 'Hi World!')
  assert.equal(personalise('No match {missing}', { name: 'X' }), 'No match {missing}')
  assert.equal(personalise('plain text', {}), 'plain text')
})
test('slugify', () => {
  assert.ok(slugify('Hello World!').startsWith('hello-world-'))
  assert.ok(slugify('  spaces  ').startsWith('spaces-'))
  assert.ok(slugify('a@b.com').startsWith('a-b-com-'))
})

// Queue tests
const tmpQueueDir = join(tmpdir(), 'dsh-mail-test-' + Date.now())
rmSync(tmpQueueDir, { recursive: true, force: true })

console.log('\nQueue:')
await atest('Queue init + create + read', async () => {
  const q = new Queue(tmpQueueDir)
  await q.init()
  const entry = await q.create({ name: 'test', provider: 'lettermint', msg: { to: 'x@y.com', subject: 's', text: 't' } })
  assert.ok(entry.id)
  assert.equal(entry.status, 'queued')
  const read = await q.read(entry.id)
  assert.equal(read.msg.to, 'x@y.com')
})
await atest('Queue list + setStatus + cancel', async () => {
  const q = new Queue(tmpQueueDir)
  const entry = await q.create({ name: 'test2', provider: 'resend', msg: { to: 'a@b.com', subject: 's', text: 't' } })
  await q.setStatus(entry.id, 'sent', { sentMessageId: 'msg-123' })
  const read = await q.read(entry.id)
  assert.equal(read.status, 'sent')
  assert.equal(read.sentMessageId, 'msg-123')
  const list = await q.list()
  assert.ok(list.length >= 2)
})
await atest('Queue cancel', async () => {
  const q = new Queue(tmpQueueDir)
  const entry = await q.create({ name: 'test3', provider: 'smtp', msg: { to: 'c@d.com', subject: 's', text: 't' } })
  await q.cancel(entry.id, { by: 'test' })
  const read = await q.read(entry.id)
  assert.equal(read.status, 'cancelled')
})
await atest('Queue due (scheduled)', async () => {
  const q = new Queue(tmpQueueDir)
  // Create an entry scheduled in the past
  const entry = await q.create({ name: 'past', provider: 'smtp', msg: { to: 'e@f.com', subject: 's', text: 't' }, sendAt: Math.floor(Date.now()/1000) - 60 })
  const due = await q.due()
  assert.ok(due.some(d => d.id === entry.id))
  // Future entry should not be due
  const future = await q.create({ name: 'future', provider: 'smtp', msg: { to: 'g@h.com', subject: 's', text: 't' }, sendAt: Math.floor(Date.now()/1000) + 3600 })
  const due2 = await q.due()
  assert.ok(!due2.some(d => d.id === future.id))
})

// Test providers.js
import { buildProvider } from '../lib/providers.js'

console.log('\nproviders.js:')
test('lettermint provider disabled without key', () => {
  const p = buildProvider('lettermint', { lettermintApiKey: '' })
  assert.equal(p.enabled(), false)
})
test('lettermint provider enabled with key', () => {
  const p = buildProvider('lettermint', { lettermintApiKey: 'test-key', lettermintBaseURL: 'https://api.lettermint.co/v1' })
  assert.equal(p.enabled(), true)
  assert.equal(p.name(), 'lettermint')
})
test('agentmail provider enabled with key + inbox', () => {
  const p = buildProvider('agentmail', { agentmailApiKey: 'test', agentmailInbox: 'inbox1' })
  assert.equal(p.enabled(), true)
})
test('resend provider enabled with key', () => {
  const p = buildProvider('resend', { resendApiKey: 're_test' })
  assert.equal(p.enabled(), true)
})
test('smtp provider enabled with host+user+pass', () => {
  const p = buildProvider('smtp', { smtpHost: 'smtp.test.com', smtpPort: 587, smtpUser: 'u', smtpPass: 'p' })
  assert.equal(p.enabled(), true)
})
test('smtp provider disabled without host', () => {
  const p = buildProvider('smtp', { smtpHost: '', smtpUser: 'u', smtpPass: 'p' })
  assert.equal(p.enabled(), false)
})
test('unknown provider returns null', () => {
  assert.equal(buildProvider('nonexistent', {}), null)
})

// Test security.js
import { loadOrCreateSecret, mintToken, verifyToken } from '../lib/security.js'

console.log('\nsecurity.js:')
await atest('secret creation + token mint + verify', async () => {
  const tmpSecret = join(tmpdir(), 'dsh-mail-test-secret-' + Date.now())
  rmSync(tmpSecret, { recursive: true, force: true })
  const secret = await loadOrCreateSecret(tmpSecret)
  assert.ok(typeof secret === 'string' && secret.length > 20)
  const token = mintToken(secret)
  assert.ok(typeof token === 'string')
  assert.equal(verifyToken(secret, token).ok, true)
  assert.equal(verifyToken(secret, 'invalid-token').ok, false)
})

// The browser half must hand the loader { apply, inject }. An esbuild
// format:'iife' build wraps everything in (()=>{...})(), module.exports stays
// {} and the whole web UI fails: "expect function or object with an apply
// method, received object".
console.log('\nclient.js:')
test('bundle exports apply() + inject through the ModuleLoader factory', () => {
  let exported
  const window = { __ModuleLoader__: { load: ({ id, factory }) => {
    assert.equal(id, 'dsh-mail')
    exported = factory((name) => name === 'react' ? {} : { jsx() {}, jsxs() {}, Fragment: 'F' })
  } } }
  runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), { window, console })
  assert.equal(typeof exported?.apply, 'function')
  assert.equal(JSON.stringify(exported.inject), '["betterSidebar"]')
})

// Cleanup
rmSync(tmpQueueDir, { recursive: true, force: true })

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed > 0 ? 1 : 0)
