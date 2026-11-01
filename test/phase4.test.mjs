/**
 * dsh-mail tests: phase 4. The unsubscribe feature (signed per-recipient
 * tokens, List-Unsubscribe mailto + RFC 8058 one-click, footer, public page
 * on the DSH route and on the small listener, rate limit, mailto processing
 * in the sync loop, per-list and global suppression, campaigns, the
 * suppression routes and mail_suppression), IMAP IDLE push, FTS5 search,
 * Markdown / rich compose, undo send, IMAP Drafts APPEND sync and folder
 * create / rename.
 */
import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import net from 'node:net'
import http from 'node:http'

import { test, section } from './harness.mjs'
import { bootPlugin, request, mutate } from './helpers.mjs'
import { makeToken, verifyToken, recipientHash, unsubMailto, footerText, HitLimiter, unsubKey, maskAddr, TEXTS } from '../lib/unsub.js'
import { MailCache } from '../lib/cache.js'
import { renderBody, sanitizeOutgoing } from '../lib/compose.js'

const require = createRequire(import.meta.url)
const hoodiecrow = require('hoodiecrow-imap')
const { SMTPServer } = require('smtp-server')
const { simpleParser } = require('mailparser')
const { ImapFlow } = require('imapflow')

function freePort() { return new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) }) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, ms = 6000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(100) } return false }

section('unsubscribe: units')
const key = unsubKey('k'.repeat(43))
await test('token: signed, no address inside, tamper and wrong key rejected', () => {
  const t = makeToken(key, { a: 'box', l: 'news', c: 'c-aaaaaaaaaaaa', r: recipientHash('Ann@Example.org') })
  const p = verifyToken(key, t)
  assert.deepEqual([p.a, p.l, p.r], ['box', 'news', recipientHash('ann@example.org')])
  assert.ok(!Buffer.from(t.split('.')[0], 'base64url').toString().includes('example.org'), 'no address in the token')
  const [body, sig] = t.split('.')
  const forged = Buffer.from(JSON.stringify({ v: 1, a: 'box', l: 'other', c: 'c-aaaaaaaaaaaa', r: p.r })).toString('base64url') + '.' + sig
  assert.equal(verifyToken(key, forged), null)
  assert.equal(verifyToken(unsubKey('z'.repeat(43)), t), null)
  assert.equal(verifyToken(key, body), null)
})
await test('mailto: explicit, global, or local+unsubscribe@domain for accounts that read mail', () => {
  const acc = { address: 'me@example.org', receive: { protocol: 'imap' }, unsubscribe: { mailto: '', plusTag: true } }
  assert.equal(unsubMailto(acc, {}), 'me+unsubscribe@example.org')
  assert.equal(unsubMailto({ ...acc, receive: { protocol: 'none' } }, {}), '')
  assert.equal(unsubMailto({ ...acc, receive: { protocol: 'none' } }, { unsubscribe: { mailto: 'out@example.org' } }), 'out@example.org')
  assert.equal(unsubMailto({ ...acc, unsubscribe: { mailto: 'list-off@example.org' } }, {}), 'list-off@example.org')
})
await test('footer texts in English, Italian and Greek; custom text; masked address; rate limiter', () => {
  assert.match(footerText({ language: 'en', sender: 'Shop', url: 'https://u/x' }), /unsubscribe here: https:\/\/u\/x/)
  assert.match(footerText({ language: 'it', sender: 'Shop', url: 'https://u/x' }), /annulla l'iscrizione/)
  assert.match(footerText({ language: 'el', sender: 'Shop', mailto: 'u@x.org' }), /unsubscribe/)
  assert.match(footerText({ language: 'el', sender: 'Shop', url: 'https://u/x' }), /απεγγραφείτε/)
  assert.equal(footerText({ language: 'en', sender: 'S', url: 'https://u', custom: { en: 'Bye {url}' } }), 'Bye https://u')
  for (const l of Object.keys(TEXTS)) for (const v of Object.values(TEXTS[l])) assert.ok(!/[\u2013\u2014]/.test(v), 'no dashes in ' + l)
  assert.equal(maskAddr('anna@example.org'), 'a***a@example.org')
  const lim = new HitLimiter({ perKey: 3, global: 5 })
  assert.deepEqual([1, 2, 3, 4].map(() => lim.allow('ip1')), [true, true, true, false])
  assert.equal(lim.allow('ip2'), true); assert.equal(lim.allow('ip3'), true); assert.equal(lim.allow('ip4'), false, 'global cap')
})
await test('FTS5: word prefix search over subject, sender and body text', () => {
  const c = new MailCache(':memory:')
  assert.equal(c.fts, true)
  c.putMessage({ account: 'a', folder: 'INBOX', uid: 1, subject: 'Quarterly report', fromAddr: 'cfo@corp.example', date: 1, flags: [] })
  c.putMessage({ account: 'a', folder: 'INBOX', uid: 2, subject: 'Lunch', fromAddr: 'bob@corp.example', date: 2, flags: [] })
  c.setBody('a', 'INBOX', 2, 'the budget spreadsheet is attached')
  const hit = w => c.threads([{ account: 'a', folder: 'INBOX' }], { filter: { q: { text: [w] } } }).rows.map(r => r.latest.subject)
  assert.deepEqual(hit('quart'), ['Quarterly report'])
  assert.deepEqual(hit('budget'), ['Lunch'])
  assert.deepEqual(hit('cfo'), ['Quarterly report'])
  assert.deepEqual(hit('nothing'), [])
  c.deleteMessage('a', 'INBOX', 2)
  assert.deepEqual(hit('budget'), [])
})
await test('compose: Markdown to sanitised HTML; rich HTML sanitised with a text part', () => {
  const md = renderBody({ format: 'markdown', text: '**Bold** and [link](https://example.org)\n\n<script>alert(1)</script>' })
  assert.match(md.html, /<strong>Bold<\/strong>/); assert.match(md.html, /href="https:\/\/example\.org"/); assert.ok(!md.html.includes('<script'))
  assert.equal(md.text.startsWith('**Bold**'), true)
  const rich = renderBody({ format: 'rich', html: '<p onclick="x()">Hi <b>you</b></p><img src="https://t.example/p.gif" onerror="y()"><a href="javascript:alert(1)">x</a>' })
  assert.ok(!/onclick|onerror|javascript:/.test(rich.html)); assert.match(rich.text, /Hi you/i)
  assert.ok(!sanitizeOutgoing('<form><input></form><iframe src=x></iframe>').match(/form|iframe|input/))
})

// ── integration ─────────────────────────────────────────────────────────────
const sink = []
const smtpPort = await freePort()
const smtp = new SMTPServer({ authOptional: true, allowInsecureAuth: true, disabledCommands: ['STARTTLS'], logger: false, onAuth(a, s, cb) { cb(null, { user: a.username }) }, onData(stream, s, cb) { const c = []; stream.on('data', x => c.push(x)); stream.on('end', () => { sink.push(Buffer.concat(c)); cb() }) } })
await new Promise(r => smtp.listen(smtpPort, '127.0.0.1', r))
const imapPort = await freePort()
const imap = hoodiecrow({ plugins: ['SPECIAL-USE', 'MOVE', 'UIDPLUS', 'IDLE', 'ENABLE', 'LIST-STATUS'], storage: { INBOX: { messages: [] }, '': { separator: '/', folders: { Sent: { 'special-use': '\\Sent' }, Drafts: { 'special-use': '\\Drafts' }, Trash: { 'special-use': '\\Trash' }, Projects: {} } } } })
await new Promise(r => imap.listen(imapPort, '127.0.0.1', r))
const unsubPort = await freePort()
const dir = mkdtempSync(join(tmpdir(), 'dsh-mail-p4-'))
const settings = {
  minDelayMs: 0, agents: { confirmMode: 'reply-only', firstContactConfirm: false }, compose: { undoSendSec: 1 },
  unsubscribe: { publicBaseUrl: 'https://unsub.example.org', listenPort: unsubPort, language: 'en' },
  accounts: [{
    id: 'box', type: 'imap-smtp', address: 'testuser@example.org', displayName: 'Box Shop', auth: { user: 'testuser' },
    receive: { protocol: 'imap', host: '127.0.0.1', port: imapPort, security: 'none' }, send: { protocol: 'smtp', host: '127.0.0.1', port: smtpPort, security: 'none' },
    secrets: { password: 'testpass' }, agent: { allow: true, canMass: true, default: true }, limits: { perMinute: 0, perDay: 0 }, push: true,
  }],
}
section('phase 4: integration')
const p = await bootPlugin({ dir, settings })
const T = n => p.tools.get(n)
await until(() => !!p.getUnsubKey(), 3000)
const csv = 'name,email\n' + Array.from({ length: 60 }, (_, i) => 'N' + i + ',r' + i + '@dest.example').join('\n')
let firstToken = ''
await test('mass send with built-in unsubscribe: mailto + one-click headers, footer, campaign recorded', async () => {
  sink.length = 0
  const r = await T('mail_mass_send').execute({ account: 'box', subjectTemplate: 'News for {name}', textTemplate: 'Hello {name}', csv, delayMs: 0, list: 'Newsletter' })
  assert.equal(r.ok, true, r.error); assert.equal(r.sent, 60); assert.match(r.campaignId, /^c-/); assert.equal(r.list, 'newsletter')
  assert.ok(await until(() => sink.length >= 60))
  const raw = sink[0].toString('utf8')
  const head = raw.split('\r\n\r\n')[0].replace(/\r\n[ \t]+/g, ' ')
  const m = /^List-Unsubscribe: <mailto:testuser\+unsubscribe@example\.org\?subject=unsubscribe%20([^>]+)>, <https:\/\/unsub\.example\.org\/dsh-mail-unsub\/([^>]+)>$/m.exec(head)
  assert.ok(m, 'List-Unsubscribe with mailto and https')
  assert.equal(m[1], m[2])
  assert.match(head, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m)
  const parsed = await simpleParser(sink[0])
  assert.match(parsed.text, /You received this email from Box Shop\. To stop receiving these emails, unsubscribe here: https:\/\/unsub\.example\.org\/dsh-mail-unsub\//)
  firstToken = m[1]
  const camps = (await request(p.port, 'GET', '/campaigns')).json.campaigns
  assert.equal(camps[0].sent, 60); assert.equal(camps[0].list, 'newsletter')
  assert.ok(!JSON.stringify(camps).includes('@dest.example'), 'campaign summaries carry no addresses')
})
const getUnsub = (port, path, opts = {}) => new Promise((res, rej) => {
  const data = opts.body ? Buffer.from(opts.body) : null
  const r = http.request({ host: '127.0.0.1', port, method: opts.method || 'GET', path, headers: { ...(data ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': data.length } : {}), ...(opts.headers || {}) } }, x => { let t = ''; x.on('data', c => { t += c }); x.on('end', () => res({ status: x.statusCode, text: t, headers: x.headers })) })
  r.on('error', rej); if (data) r.write(data); r.end()
})
await test('public page on the listener: GET confirm page (masked address), POST one-click unsubscribes from the list', async () => {
  const sent0 = await simpleParser(sink.find(b => b.toString().includes('To: r0@dest.example')) || sink[0])
  const tok = /dsh-mail-unsub\/(\S+)/.exec(sent0.text)[1]
  const g = await getUnsub(unsubPort, '/dsh-mail-unsub/' + tok)
  assert.equal(g.status, 200); assert.match(g.text, /r\*@dest\.example/); assert.ok(!g.text.includes('r0@dest.example'))
  assert.match(g.headers['content-security-policy'], /default-src 'none'/)
  const po = await getUnsub(unsubPort, '/dsh-mail-unsub/' + tok, { method: 'POST', body: 'List-Unsubscribe=One-Click' })
  assert.equal(po.status, 200)
  assert.ok(p.listSuppression.has('newsletter', 'r0@dest.example'))
  assert.equal(p.suppression.has('r0@dest.example'), false, 'one-click is list-scoped')
  assert.equal((await getUnsub(unsubPort, '/dsh-mail-unsub/garbage.token')).status, 404)
  assert.equal((await getUnsub(unsubPort, '/dsh-mail/api/state')).status, 404, 'the listener serves nothing else')
})
await test('the DSH route serves the same page; "all mail" goes to the global list; rate limit answers 429', async () => {
  const tok1 = /dsh-mail-unsub\/(\S+)/.exec((await simpleParser(sink.find(b => b.toString().includes('To: r1@dest.example')))).text)[1]
  const r = await request(p.port, 'POST', '/dsh-mail-unsub/' + tok1, { raw: true, body: 'scope=all', headers: { 'content-type': 'application/x-www-form-urlencoded' } })
  assert.equal(r.status, 200)
  assert.equal(p.suppression.has('r1@dest.example'), true)
  let last = 0
  for (let i = 0; i < 25; i++) last = (await getUnsub(unsubPort, '/dsh-mail-unsub/x.y', { headers: { 'x-forwarded-for': '203.0.113.9' } })).status
  assert.equal(last, 429)
})
await test('unsubscribe replies by mail: token reply suppresses that recipient for the list, plain mail suppresses the sender', async () => {
  const tok2 = /dsh-mail-unsub\/(\S+)/.exec((await simpleParser(sink.find(b => b.toString().includes('To: r2@dest.example')))).text)[1]
  imap.appendMessage('INBOX', [], false, 'From: r2@dest.example\r\nTo: testuser+unsubscribe@example.org\r\nSubject: unsubscribe ' + tok2 + '\r\nMessage-ID: <u2@dest.example>\r\n\r\n\r\n')
  imap.appendMessage('INBOX', [], false, 'From: someone@other.example\r\nTo: testuser+unsubscribe@example.org\r\nSubject: please remove me\r\nMessage-ID: <u3@other.example>\r\n\r\n\r\n')
  await mutate(p.port, '/sync', { account: 'box' })
  assert.ok(await until(() => p.listSuppression.has('newsletter', 'r2@dest.example') && p.suppression.has('someone@other.example')))
  await mutate(p.port, '/suppress', { remove: 'someone@other.example' })
  await mutate(p.port, '/sync', { account: 'box' })
  assert.equal(p.suppression.has('someone@other.example'), false, 'a processed message never re-adds a removed address')
})
await test('next mass send to the list skips list and global unsubscribes; another list still reaches list-only ones', async () => {
  sink.length = 0
  const csv3 = 'email\nr0@dest.example\nr1@dest.example\nr2@dest.example\nr3@dest.example'
  const a = await T('mail_mass_send').execute({ account: 'box', subjectTemplate: 'Again', textTemplate: 'x', csv: csv3, delayMs: 0, list: 'newsletter' })
  assert.deepEqual([a.sent, a.suppressed], [1, 3])
  const b = await T('mail_mass_send').execute({ account: 'box', subjectTemplate: 'Other', textTemplate: 'x', csv: csv3, delayMs: 0, list: 'offers' })
  assert.deepEqual([b.sent, b.suppressed], [3, 1], 'only the global unsubscribe (r1) blocks another list')
})
await test('suppression routes: CSV export, remove with list scope; mail_suppression add/remove need confirm', async () => {
  const c = await request(p.port, 'GET', '/suppress?format=csv')
  assert.equal(c.status, 200); assert.match(c.headers['content-type'], /text\/csv/); assert.match(c.text, /"r0@dest\.example","list:newsletter"/)
  await mutate(p.port, '/suppress', { remove: 'r0@dest.example', list: 'newsletter' })
  assert.equal(p.listSuppression.has('newsletter', 'r0@dest.example'), false)
  const d = await T('mail_suppression').execute({ action: 'add', address: 'x@y.example' })
  assert.equal(d.drafted, true); assert.equal(p.suppression.has('x@y.example'), false)
  assert.ok((await T('mail_suppression').execute({ action: 'add', address: 'x@y.example', confirm: true })).ok)
  assert.equal(p.suppression.has('x@y.example'), true)
  assert.match((await T('mail_suppression').execute({ action: 'check', address: 'r2@dest.example' })).text, /newsletter/)
  assert.ok((await T('mail_suppression').execute({ action: 'campaigns' })).text.includes('newsletter'))
  await T('mail_suppression').execute({ action: 'remove', address: 'x@y.example', confirm: true })
  assert.equal(p.suppression.has('x@y.example'), false)
})
await test('IMAP IDLE: a new message reaches the cache within 5 s without a manual sync', async () => {
  assert.ok(await until(() => (p.idle.status().box || {}).mode === 'idle', 8000), 'IDLE connection up: ' + JSON.stringify(p.idle.status()))
  imap.appendMessage('INBOX', [], false, 'From: push@example.org\r\nTo: testuser@example.org\r\nSubject: Pushed in\r\nMessage-ID: <push1@example.org>\r\n\r\nhi\r\n')
  assert.ok(await until(() => p.service.cache.messages('box', 'INBOX').some(m => m.subject === 'Pushed in'), 5000), 'idle: ' + JSON.stringify(p.idle.status()))
})
await test('Markdown compose from the tab: multipart with sanitised HTML', async () => {
  sink.length = 0
  const r = await mutate(p.port, '/send', { account: 'box', to: 'friend@example.org', subject: 'MD', text: '**Hello** _there_', format: 'markdown' })
  assert.equal(r.status, 200, r.text)
  assert.ok(await until(() => sink.length === 1))
  const m = await simpleParser(sink[0])
  assert.match(m.html, /<strong>Hello<\/strong>/); assert.match(m.text, /\*\*Hello\*\*/)
})
await test('undo send: held for compose.undoSendSec, cancel drops it, otherwise it goes out', async () => {
  sink.length = 0
  const a = await mutate(p.port, '/send', { account: 'box', to: 'friend@example.org', subject: 'Undo me', text: 'x', undo: true })
  assert.equal(a.json.held, true)
  assert.equal((await mutate(p.port, '/outbox/cancel', { id: a.json.outboxId })).status, 200)
  const b = await mutate(p.port, '/send', { account: 'box', to: 'friend@example.org', subject: 'Keep me', text: 'x', undo: true })
  await sleep(1600)
  assert.equal(sink.length, 1); assert.match(sink[0].toString(), /Subject: Keep me/)
  assert.equal((await mutate(p.port, '/outbox/cancel', { id: b.json.outboxId })).status, 404, 'too late to undo')
})
async function boxStatus(path) {
  const c = new ImapFlow({ host: '127.0.0.1', port: imapPort, secure: false, doSTARTTLS: false, auth: { user: 'testuser', pass: 'testpass' }, logger: false })
  await c.connect()
  try { return await c.status(path, { messages: true }) } finally { await c.logout() }
}
await test('IMAP Drafts sync: autosave APPENDs with \\Draft, an update replaces it, delete removes it', async () => {
  await request(p.port, 'GET', '/folders?account=box')
  const s1 = await mutate(p.port, '/drafts/save', { draft: { account: 'box', to: 'a@example.org', subject: 'Draft v1', text: 'one' } })
  assert.equal(s1.json.remote, true, s1.text)
  assert.equal((await boxStatus('Drafts')).messages, 1)
  const s2 = await mutate(p.port, '/drafts/save', { draft: { id: s1.json.id, account: 'box', to: 'a@example.org', subject: 'Draft v2', text: 'two' } })
  assert.equal(s2.json.id, s1.json.id)
  assert.equal((await boxStatus('Drafts')).messages, 1, 'old copy removed')
  await mutate(p.port, '/drafts/delete', { id: s1.json.id })
  assert.equal((await boxStatus('Drafts')).messages, 0)
})
await test('folders: create and rename custom folders; special folders refused; agents need canManageFolders', async () => {
  const c = await mutate(p.port, '/folders/create', { account: 'box', name: 'Clients' })
  assert.equal(c.status, 200, c.text)
  let fl = (await request(p.port, 'GET', '/folders?account=box')).json.folders.map(f => f.path)
  assert.ok(fl.includes('Clients'))
  assert.equal((await mutate(p.port, '/folders/rename', { account: 'box', from: 'Clients', to: 'Customers' })).status, 200)
  fl = (await request(p.port, 'GET', '/folders?account=box')).json.folders.map(f => f.path)
  assert.ok(fl.includes('Customers') && !fl.includes('Clients'))
  assert.match((await mutate(p.port, '/folders/rename', { account: 'box', from: 'Sent', to: 'X' })).json.error, /special/)
  assert.match((await T('mail_folders').execute({ account: 'box', action: 'create', name: 'Agent' })).error, /canManageFolders/)
})
await p.close()
await new Promise(r => smtp.close(r))
await new Promise(r => imap.close(r))
rmSync(dir, { recursive: true, force: true })
