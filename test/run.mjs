#!/usr/bin/env node
/**
 * dsh-mail tests. Run: node test/run.mjs   (npm test)
 *
 * Unit tests (staging, providers, security, accounts, cache, html, pop3
 * unstuffing, settings store, client bundle), the migration test for the v0.1
 * settings block, the route security tests and the end-to-end test against a
 * local in-memory IMAP + SMTP server (hoodiecrow-imap) and a local POP3 fake.
 */
import { strict as assert } from 'node:assert'
import { rmSync, readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { stats, test, section } from './harness.mjs'
import { parseCSV, personalise, slugify, Queue } from '../lib/staging.js'
import { buildProvider } from '../lib/providers.js'
import { loadOrCreateSecret, mintToken, verifyToken } from '../lib/security.js'
import { sanitizeMailHtml, mailDocument } from '../lib/html.js'
import { MailCache, parseQuery, normSubject } from '../lib/cache.js'
import { unstuff } from '../lib/pop3.js'
import { parseId, makeId, safeName } from '../lib/service.js'
import { assertNoInjection, validateRecipients } from '../lib/smtp.js'
import { createSettingsStore, readLegacyYamlBlock, mergeLayers } from '../lib/settings-store.js'
import { SecretStore } from '../lib/secrets.js'

const TMP = mkdtempSync(join(tmpdir(), 'dsh-mail-test-'))

section('staging.js')
await test('parseCSV basic', () => {
  const rows = parseCSV('name,email\nAlice,alice@test.com\nBob,bob@test.com', 100)
  assert.equal(rows.length, 2); assert.equal(rows[0].name, 'Alice'); assert.equal(rows[0].email, 'alice@test.com')
})
await test('parseCSV empty and max rows', () => {
  assert.equal(parseCSV('', 100).length, 0)
  assert.equal(parseCSV('name,email', 100).length, 0)
  assert.equal(parseCSV('email\n' + Array.from({ length: 10 }, (_, i) => 'u' + i + '@t.com').join('\n'), 5).length, 5)
})
await test('personalise', () => {
  assert.equal(personalise('Hi {name}!', { name: 'World' }), 'Hi World!')
  assert.equal(personalise('No match {missing}', { name: 'X' }), 'No match {missing}')
})
await test('slugify', () => { assert.ok(slugify('Hello World!').startsWith('hello-world-')); assert.ok(slugify('a@b.com').startsWith('a-b-com-')) })

const qdir = join(TMP, 'queue')
await test('Queue create, read, setStatus, cancel', async () => {
  const q = new Queue(qdir); await q.init()
  const e = await q.create({ name: 'test', provider: 'lettermint', msg: { to: 'x@y.com', subject: 's', text: 't' } })
  assert.equal(e.status, 'queued'); assert.equal((await q.read(e.id)).msg.to, 'x@y.com')
  await q.setStatus(e.id, 'sent', { sentMessageId: 'msg-123' })
  assert.equal((await q.read(e.id)).sentMessageId, 'msg-123')
  const c = await q.create({ name: 'test3', provider: 'smtp', msg: { to: 'c@d.com', subject: 's', text: 't' } })
  await q.cancel(c.id, { by: 'test' }); assert.equal((await q.read(c.id)).status, 'cancelled')
})
await test('Queue due: scheduled past entries only; queued entries wait for a human', async () => {
  const q = new Queue(qdir)
  const past = await q.create({ name: 'past', provider: 'smtp', msg: { to: 'e@f.com', subject: 's', text: 't' }, sendAt: Math.floor(Date.now() / 1000) - 60 })
  const future = await q.create({ name: 'future', provider: 'smtp', msg: { to: 'g@h.com', subject: 's', text: 't' }, sendAt: Math.floor(Date.now() / 1000) + 3600 })
  const manual = await q.create({ name: 'manual', provider: 'smtp', msg: { to: 'i@j.com', subject: 's', text: 't' } })
  const due = await q.due()
  assert.ok(due.some(d => d.id === past.id)); assert.ok(!due.some(d => d.id === future.id)); assert.ok(!due.some(d => d.id === manual.id))
})

section('providers.js (v0.1 transport layer, unchanged)')
await test('provider enable rules', () => {
  assert.equal(buildProvider('lettermint', { lettermintApiKey: '' }).enabled(), false)
  assert.equal(buildProvider('lettermint', { lettermintApiKey: 'k' }).enabled(), true)
  assert.equal(buildProvider('agentmail', { agentmailApiKey: 'k', agentmailInbox: 'i' }).enabled(), true)
  assert.equal(buildProvider('resend', { resendApiKey: 're_x' }).enabled(), true)
  assert.equal(buildProvider('smtp', { smtpHost: 'h', smtpUser: 'u', smtpPass: 'p' }).enabled(), true)
  assert.equal(buildProvider('smtp', { smtpHost: '', smtpUser: 'u', smtpPass: 'p' }).enabled(), false)
  assert.equal(buildProvider('nonexistent', {}), null)
})

section('security.js')
await test('secret creation, token mint and verify', async () => {
  const secret = await loadOrCreateSecret(join(TMP, 'secret'))
  assert.ok(secret.length > 20)
  assert.equal(verifyToken(secret, mintToken(secret)).ok, true)
  assert.equal(verifyToken(secret, 'invalid-token').ok, false)
  assert.equal(verifyToken(secret, mintToken(secret, { nowMs: Date.now() - 3600e3 })).ok, false)
})

section('html.js (XSS)')
await test('crafted HTML renders inert: script, handlers, iframe, javascript: links, forms, svg', () => {
  const evil = '<p onclick="alert(1)">hi</p><script>alert(2)</script><img src="x" onerror="alert(3)"><iframe src="https://evil.example"></iframe>' +
    '<a href="javascript:alert(4)">x</a><form action="https://evil.example"><input name=a></form><svg onload="alert(5)"><script>alert(6)</script></svg>' +
    '<object data="x"></object><embed src="x"><a href="https://ok.example/">ok</a><style>body{background:url(https://track.example/p.gif)}</style><meta http-equiv="refresh" content="0;url=https://evil.example">'
  const { html, blocked } = sanitizeMailHtml(evil)
  for (const bad of ['<script', 'onclick', 'onerror', '<iframe', 'javascript:', '<form', '<svg', '<object', '<embed', 'onload', 'alert(', '<meta']) assert.ok(!html.toLowerCase().includes(bad), 'still contains ' + bad)
  assert.ok(html.includes('href="https://ok.example/"') && html.includes('rel="noreferrer noopener"'))
  assert.equal(blocked, 0)
  const doc = mailDocument(html)
  assert.ok(doc.includes("default-src 'none'") && doc.includes('img-src data: cid:'))
  assert.ok(!doc.includes('track.example'), 'remote url() in CSS is stripped when images are blocked')
})
await test('remote images blocked by default, allowed on request, cid mapped', () => {
  const src = '<img src="https://img.example/a.png"><img src="cid:logo@x">'
  const a = sanitizeMailHtml(src, { cid: new Map([['logo@x', 'data:image/png;base64,AAAA']]) })
  assert.equal(a.blocked, 1); assert.ok(!/\ssrc="https:\/\/img\.example/.test(a.html)); assert.ok(a.html.includes('data:image/png;base64,AAAA'))
  const b = sanitizeMailHtml(src, { images: true })
  assert.ok(b.html.includes('src="https://img.example/a.png"'))
})

section('cache.js')
await test('threading by References / In-Reply-To and subject fallback; flags; prune', () => {
  const c = new MailCache(':memory:')
  const t0 = Date.now() - 3 * 86400e3
  const t1 = c.putMessage({ account: 'a', folder: 'INBOX', uid: 1, msgid: '<m1@x>', subject: 'Plan', date: t0, flags: [] })
  const t2 = c.putMessage({ account: 'a', folder: 'INBOX', uid: 2, msgid: '<m2@x>', inReplyTo: '<m1@x>', refs: '<m1@x>', subject: 'Re: Plan', date: t0 + 1000, flags: ['\\Seen'], bodyText: 'body' })
  const t3 = c.putMessage({ account: 'a', folder: 'Sent', uid: 1, msgid: '<m3@x>', subject: 'RE: plan', date: t0 + 2000, flags: ['\\Seen'] })
  const t4 = c.putMessage({ account: 'a', folder: 'INBOX', uid: 3, msgid: '<m4@x>', subject: 'Other', date: t0 + 3000, flags: [] })
  assert.equal(t1, t2); assert.equal(t1, t3); assert.notEqual(t1, t4)
  const list = c.threads([{ account: 'a', folder: 'INBOX' }])
  assert.equal(list.total, 2)
  assert.equal(c.threads([{ account: 'a', folder: 'INBOX' }], { filter: { unread: true } }).total, 2)
  c.setFlags('a', 'INBOX', 1, ['\\Seen', '\\Flagged'])
  assert.equal(c.threads([{ account: 'a', folder: 'INBOX' }], { filter: { flagged: true } }).total, 1)
  assert.equal(c.prune(1), 1)
  assert.equal(c.getMessage('a', 'INBOX', 2).body_text, null)
  assert.equal(c.kind, 'sqlite')
})
await test('query parser', () => {
  const q = parseQuery('from:bob subject:"big plan" is:unread has:attachment after:2026-01-01 hello')
  assert.equal(q.from, 'bob'); assert.equal(q.subject, 'big plan'); assert.ok(q.unread && q.attachments && q.after); assert.deepEqual(q.text, ['hello'])
  assert.equal(normSubject('Re: Fwd: [list] Hello  World'), 'hello world')
})

section('service / smtp helpers')
await test('composite ids, safe names, header injection, recipients', () => {
  assert.deepEqual(parseId(makeId('work', 'INBOX/Sub:x', '42')), { account: 'work', folder: 'INBOX/Sub:x', uid: '42' })
  assert.equal(parseId('nonsense'), null)
  assert.ok(!safeName('../../etc/passwd').includes('/') && !safeName('../x').startsWith('.'))
  assert.throws(() => assertNoInjection({ subject: 'hi\r\nBcc: x@y.z' }))
  assert.throws(() => validateRecipients(['not an address']))
  validateRecipients(['A <a@b.co>', 'c@d.org'])
})
await test('pop3 dot-unstuffing', () => {
  assert.equal(unstuff(Buffer.from('a\r\n..b\r\nc')).toString(), 'a\r\n.b\r\nc\r\n')
})

section('settings-store.js (config mode: no settings service)')
await test('file mode layers: defaults < settings.yaml.imported block < cordis config < settings.json; update writes 0600 JSON', async () => {
  const home = join(TMP, 'dshhome'); mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'settings.yaml.imported'), 'other: 1\ndsh-mail:\n  trustedHosts:\n    - llm.example.org\n  mailboxBaseUrl: https://mail.example.org\n  providers:\n    tzmail:\n      tzmailBaseURL: https://mail.example.org\n')
  assert.equal(readLegacyYamlBlock(home, 'dsh-mail').file, 'settings.yaml.imported')
  const dataDir = join(TMP, 'data-store')
  const st = createSettingsStore({}, { maxRecipients: 42 }, { ns: 'dsh-mail', schema: null, defaults: { maxRecipients: 500, trustedHosts: [], agents: { enabled: true } }, dataDir, dshHome: home, secrets: new SecretStore(join(dataDir, 'secrets.json')), log: () => {}, warn: () => {} })
  assert.equal(st.mode, 'config')
  let v = st.get()
  assert.deepEqual(v.trustedHosts, ['llm.example.org']); assert.equal(v.maxRecipients, 42); assert.equal(v.mailboxBaseUrl, 'https://mail.example.org')
  await st.update({ agents: { confirmMode: 'reply-only' }, accounts: [{ id: 'x' }] })
  v = st.get()
  assert.equal(v.agents.confirmMode, 'reply-only'); assert.equal(v.agents.enabled, true); assert.equal(v.accounts.length, 1)
  const mode = (await import('node:fs')).statSync(join(dataDir, 'settings.json')).mode & 0o777
  assert.equal(mode, 0o600)
  assert.deepEqual(mergeLayers({ a: [1, 2], b: { c: 1 } }, { a: [3], b: { d: 2 } }), { a: [3], b: { c: 1, d: 2 } })
})

section('client.js')
await test('bundle exports apply() + inject through the ModuleLoader factory', () => {
  let exported
  const window = { __ModuleLoader__: { load: ({ id, factory }) => { assert.equal(id, 'dsh-mail'); exported = factory(name => (name === 'react' ? {} : { jsx() {}, jsxs() {}, Fragment: 'F' })) } } }
  runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), { window, console })
  assert.equal(typeof exported?.apply, 'function')
  assert.equal(JSON.stringify(exported.inject), '["betterSidebar","slots"]')
})

await import('./accounts.test.mjs')
await import('./routes.test.mjs')
await import('./e2e.test.mjs')
await import('./oauth.test.mjs')
await import('./dual.test.mjs')
await import('./phase3.test.mjs')

rmSync(TMP, { recursive: true, force: true })
console.log('\n' + stats.passed + ' passed, ' + stats.failed + ' failed' + (stats.failed ? ': ' + stats.failures.join('; ') : ''))
process.exit(stats.failed > 0 ? 1 : 0)
