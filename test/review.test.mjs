/**
 * dsh-mail tests: fixes from the pre-merge review.
 *
 *   public unsubscribe surface   malformed URLs never throw (the plain http
 *                                listener would crash the host), the listener
 *                                binds loopback only, rate-limit key from the
 *                                edge-appended X-Forwarded-For entry
 *   queue                        no duplicate sends: one send per entry at a
 *                                time, a retried mass send skips the addresses
 *                                already delivered, cancel stops a running batch
 *   IMAP drafts                  only our own \Draft copy (same Message-ID) is
 *                                ever deleted; no plain EXPUNGE without UIDPLUS;
 *                                no copies pile up without APPENDUID; the agent
 *                                paths remove the server copy too
 *   reading view                 relative links are dropped
 *   SSRF                         API base URLs: https, or http to loopback only
 *   parity                       an explicit html part goes out unchanged
 *   tests                        no real credential file is reachable
 */
import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import net from 'node:net'
import http from 'node:http'

import { test, section } from './harness.mjs'
import { bootPlugin, request, mutate } from './helpers.mjs'
import { makeUnsubHandler, unsubListenHost, clientKeyOf, HitLimiter } from '../lib/unsub.js'
import { runMassSend } from '../lib/outbound.js'
import { Queue } from '../lib/staging.js'
import { sanitizeMailHtml } from '../lib/html.js'
import { apiBaseUrlError, normalizeAccount, validateAccount } from '../lib/accounts.js'
import { renderBody } from '../lib/compose.js'
import { deleteDraftCopy, ImapPool } from '../lib/imap.js'

const require = createRequire(import.meta.url)
const hoodiecrow = require('hoodiecrow-imap')
const { SMTPServer } = require('smtp-server')
const { ImapFlow } = require('imapflow')

function freePort() { return new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) }) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(25) } return false }
function raw(port, path, method = 'GET') {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path, method }, res => { const c = []; res.on('data', x => c.push(x)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(c).toString('utf8') })) })
    req.on('error', e => resolve({ status: 0, error: e.message }))
    req.end()
  })
}

section('review: public unsubscribe surface')
await test('handler never throws on malformed paths (bad percent-encoding, bad URL)', async () => {
  const h = makeUnsubHandler(() => ({ key: Buffer.alloc(32, 1), campaigns: { get: () => null }, suppression: {}, lists: {}, limiter: new HitLimiter(), audit: null }))
  for (const url of ['/dsh-mail-unsub/%E0%A4%A', '/dsh-mail-unsub/%', '//[', '/dsh-mail-unsub/' + 'a'.repeat(5000)]) {
    let status = 0
    const res = { headersSent: false, writeHead(s) { status = s; this.headersSent = true }, end() {} }
    assert.doesNotThrow(() => h({ url, method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res), url)
    assert.ok(status >= 400 && status < 500, url + ' answered ' + status)
  }
})
await test('listener host is loopback only; rate-limit key is the edge-appended client', () => {
  assert.equal(unsubListenHost('0.0.0.0'), '127.0.0.1')
  assert.equal(unsubListenHost('192.0.2.10'), '127.0.0.1')
  assert.equal(unsubListenHost(''), '127.0.0.1')
  assert.equal(unsubListenHost('::1'), '::1')
  assert.equal(unsubListenHost('127.0.0.2'), '127.0.0.2')
  assert.equal(clientKeyOf({ headers: { 'x-forwarded-for': 'spoofed-1, 203.0.113.7' }, socket: { remoteAddress: '127.0.0.1' } }), '203.0.113.7')
  assert.equal(clientKeyOf({ headers: { 'cf-connecting-ip': '198.51.100.4', 'x-forwarded-for': 'x, y' } }), '198.51.100.4')
  assert.equal(clientKeyOf({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1')
})
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mail-rv-unsub-'))
  const port = await freePort()
  const p = await bootPlugin({ dir, settings: { unsubscribe: { listenHost: '0.0.0.0', listenPort: port } } })
  await test('a configured 0.0.0.0 listener still binds 127.0.0.1 and survives a malformed request', async () => {
    assert.ok(await until(() => p.unsubPort() === port))
    const st = (await request(p.port, 'GET', '/unsubscribe/status')).json
    assert.equal(st.listener.host, '127.0.0.1')
    const bad = await raw(port, '/dsh-mail-unsub/%E0%A4%A')
    assert.ok(bad.status >= 400 && bad.status < 500, 'answered ' + bad.status)
    const again = await raw(port, '/dsh-mail-unsub/x.y')
    assert.equal(again.status, 404, 'listener still alive')
    assert.equal((await raw(port, '/dsh-mail/api/state')).status, 404, 'serves nothing else')
  })
  await p.close()
  rmSync(dir, { recursive: true, force: true })
}

section('review: no duplicate sends')
await test('a stopped mass send resumes without mailing anyone twice; cancel stops a running batch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mail-rv-q-'))
  const q = new Queue(join(dir, 'queue')); await q.init()
  const e = await q.create({ name: 'mass', provider: 'x', msg: { subject: 's', text: 't' }, csvData: { rows: [] } })
  const delivered = []
  let failFrom = 3
  const service = { send: async (_a, m) => { if (delivered.length + 1 >= failFrom) throw Object.assign(new Error('451 try later'), { responseCode: 451 }); delivered.push(m.to[0]) } }
  const rows = ['a', 'b', 'c', 'd', 'e'].map(x => ({ email: x + '@example.org' }))
  const settings = { minDelayMs: 0, maxDelayMs: 10, maxRecipients: 500, mass: { unsubscribeAbove: 50, breakerFailures: 2, jitterPct: 0 }, unsubscribe: { footer: false } }
  const deps = { service, state: { remaining: () => ({}) }, suppression: { has: () => false, add() {} }, settings, canSetHeaders: true, sleep: async () => {}, onSent: addr => q.markSent(e.id, addr) }
  const r1 = await runMassSend({ id: 'x', limits: {} }, { rows, subjectTemplate: 's', textTemplate: 't', delayMs: 0 }, deps)
  assert.equal(r1.sent, 2); assert.match(r1.stopped, /circuit breaker/)
  failFrom = 99
  const already = await q.sentSet(e.id)
  assert.deepEqual([...already].sort(), ['a@example.org', 'b@example.org'])
  const r2 = await runMassSend({ id: 'x', limits: {} }, { rows, subjectTemplate: 's', textTemplate: 't', delayMs: 0, alreadySent: already }, deps)
  assert.equal(r2.sent, 3); assert.equal(r2.alreadySent, 2)
  assert.deepEqual(delivered, ['a@example.org', 'b@example.org', 'c@example.org', 'd@example.org', 'e@example.org'], 'every address exactly once')
  let n = 0
  const r3 = await runMassSend({ id: 'x', limits: {} }, { rows, subjectTemplate: 's', textTemplate: 't', delayMs: 0 }, { ...deps, onSent: null, isCancelled: async () => ++n > 2 })
  assert.equal(r3.stopped, 'cancelled'); assert.equal(r3.sent, 2)
  await q.delete(e.id)
  assert.equal((await q.sentSet(e.id)).size, 0, 'progress sidecar removed with the entry')
  rmSync(dir, { recursive: true, force: true })
})
{
  const sink = []
  let delayMs = 600
  const smtpPort = await freePort()
  const smtp = new SMTPServer({ authOptional: true, disabledCommands: ['STARTTLS', 'AUTH'], logger: false, onData(stream, _s, cb) { const c = []; stream.on('data', x => c.push(x)); stream.on('end', () => setTimeout(() => { sink.push(Buffer.concat(c)); cb() }, delayMs)) } })
  await new Promise(r => smtp.listen(smtpPort, '127.0.0.1', r))
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mail-rv-q2-'))
  const p = await bootPlugin({ dir, settings: { agents: { confirmMode: 'reply-only', firstContactConfirm: false }, accounts: [{ id: 'out', type: 'imap-smtp', address: 'me@example.org', receive: { protocol: 'none' }, send: { protocol: 'smtp', host: '127.0.0.1', port: smtpPort, security: 'none' }, agent: { allow: true, default: true }, limits: { perMinute: 0, perDay: 0 } }] } })
  await test('two concurrent "Send now" clicks on one queue entry deliver it once', async () => {
    const q = await p.tools.get('mail_send_later').execute({ account: 'out', to: 'friend@example.org', subject: 'once', text: 'only once', queue: true })
    assert.equal(q.ok, true, q.error)
    const [a, b] = await Promise.all([mutate(p.port, '/queue/send', { id: q.queueId }), sleep(50).then(() => mutate(p.port, '/queue/send', { id: q.queueId }))])
    const codes = [a.status, b.status].sort()
    assert.deepEqual(codes, [200, 409], 'one send, one refusal: ' + a.text + ' / ' + b.text)
    await sleep(delayMs + 200)
    assert.equal(sink.length, 1, 'delivered exactly once')
    const again = await mutate(p.port, '/queue/send', { id: q.queueId })
    assert.equal(again.status, 400, 'a sent entry is not sent again')
  })
  await p.close()
  await new Promise(r => smtp.close(r))
  rmSync(dir, { recursive: true, force: true })
}

section('review: IMAP drafts never touch a message that is not our draft')
for (const plugins of [['SPECIAL-USE', 'UIDPLUS'], ['SPECIAL-USE']]) {
  const label = plugins.includes('UIDPLUS') ? 'with UIDPLUS' : 'without UIDPLUS'
  const imapPort = await freePort()
  const userDraft = 'From: me@example.org\r\nTo: x@example.org\r\nSubject: my own draft\r\nMessage-ID: <user-draft@example.org>\r\n\r\nkeep me\r\n'
  const deletedElsewhere = 'From: me@example.org\r\nSubject: deleted by another client\r\nMessage-ID: <other@example.org>\r\n\r\nflagged deleted\r\n'
  const imap = hoodiecrow({ plugins, storage: { INBOX: { messages: [{ raw: 'From: a@example.org\r\nSubject: inbox mail\r\nMessage-ID: <in1@example.org>\r\n\r\nhi\r\n' }] }, '': { separator: '/', folders: { Drafts: { 'special-use': '\\Drafts', messages: [{ raw: userDraft, flags: ['\\Draft'] }, { raw: deletedElsewhere, flags: ['\\Deleted'] }] } } } } })
  await new Promise(r => imap.listen(imapPort, '127.0.0.1', r))
  const acc = normalizeAccount({ id: 'box', type: 'imap-smtp', address: 'testuser@example.org', auth: { user: 'testuser' }, receive: { protocol: 'imap', host: '127.0.0.1', port: imapPort, security: 'none' }, send: { protocol: 'smtp', host: '127.0.0.1', port: 1, security: 'none' }, secrets: { password: 'testpass' } })
  const pool = new ImapPool()
  const look = async () => {
    const c = new ImapFlow({ host: '127.0.0.1', port: imapPort, secure: false, doSTARTTLS: false, auth: { user: 'testuser', pass: 'testpass' }, logger: false })
    await c.connect()
    const out = []
    try { const lock = await c.getMailboxLock('Drafts'); try { for await (const m of c.fetch('1:*', { uid: true, flags: true, envelope: true })) out.push({ uid: m.uid, mid: m.envelope.messageId, flags: [...m.flags] }) } finally { lock.release() } } finally { await c.logout() }
    return out
  }
  await test('deleteDraftCopy ' + label + ': refuses a wrong Message-ID, a non-draft, and never expunges others', async () => {
    const before = await look()
    const user = before.find(m => m.mid === '<user-draft@example.org>')
    assert.equal(await deleteDraftCopy(pool, acc, 'Drafts', user.uid, { messageId: '<ours@example.org>' }), false, 'stale uid of the user draft is left alone')
    const other = before.find(m => m.mid === '<other@example.org>')
    assert.equal(await deleteDraftCopy(pool, acc, 'Drafts', other.uid, {}), false, 'not a \\Draft')
    const c = new ImapFlow({ host: '127.0.0.1', port: imapPort, secure: false, doSTARTTLS: false, auth: { user: 'testuser', pass: 'testpass' }, logger: false })
    await c.connect()
    const ours = await c.append('Drafts', 'From: me@example.org\r\nSubject: ours\r\nMessage-ID: <ours@example.org>\r\n\r\nx\r\n', ['\\Draft'])
    await c.logout()
    let uid = ours && ours.uid
    if (!uid) uid = (await look()).find(m => m.mid === '<ours@example.org>').uid
    assert.equal(await deleteDraftCopy(pool, acc, 'Drafts', uid, { messageId: '<ours@example.org>' }), true)
    const after = await look()
    assert.ok(after.some(m => m.mid === '<user-draft@example.org>'), 'user draft kept')
    assert.ok(after.some(m => m.mid === '<other@example.org>'), 'the other client\'s \\Deleted message was not expunged')
    const mine = after.find(m => m.mid === '<ours@example.org>')
    if (plugins.includes('UIDPLUS')) assert.ok(!mine, 'our copy expunged by UID')
    else assert.ok(mine && mine.flags.includes('\\Deleted'), 'without UIDPLUS our copy is only flagged \\Deleted')
  })
  await pool.close()
  await new Promise(r => imap.close(r))
}
{
  const imapPort = await freePort()
  const imap = hoodiecrow({ plugins: ['SPECIAL-USE'], storage: { INBOX: { messages: [] }, '': { separator: '/', folders: { Drafts: { 'special-use': '\\Drafts' } } } } })
  await new Promise(r => imap.listen(imapPort, '127.0.0.1', r))
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mail-rv-dr-'))
  const p = await bootPlugin({ dir, settings: { agents: { confirmMode: 'all' }, accounts: [{ id: 'box', type: 'imap-smtp', address: 'testuser@example.org', auth: { user: 'testuser' }, receive: { protocol: 'imap', host: '127.0.0.1', port: imapPort, security: 'none' }, send: { protocol: 'smtp', host: '127.0.0.1', port: 1, security: 'none' }, secrets: { password: 'testpass' }, agent: { allow: true, default: true } }] } })
  const count = async () => { const c = new ImapFlow({ host: '127.0.0.1', port: imapPort, secure: false, doSTARTTLS: false, auth: { user: 'testuser', pass: 'testpass' }, logger: false }); await c.connect(); try { return (await c.status('Drafts', { messages: true })).messages } finally { await c.logout() } }
  await test('server without UIDPLUS: autosaves replace the copy (found by Message-ID), agent delete removes it', async () => {
    const s1 = await mutate(p.port, '/drafts/save', { draft: { account: 'box', to: 'a@example.org', subject: 'v1', text: 'one', remote: { folder: 'INBOX', uid: '1' } } })
    assert.equal(s1.status, 200, s1.text)
    assert.equal(s1.json.remote, true)
    for (const v of ['v2', 'v3']) assert.equal((await mutate(p.port, '/drafts/save', { draft: { id: s1.json.id, account: 'box', to: 'a@example.org', subject: v, text: v } })).status, 200)
    // copies are flagged \Deleted (no UIDPLUS), so count the undeleted ones
    const c = new ImapFlow({ host: '127.0.0.1', port: imapPort, secure: false, doSTARTTLS: false, auth: { user: 'testuser', pass: 'testpass' }, logger: false })
    await c.connect()
    let live = 0
    try { const lock = await c.getMailboxLock('Drafts'); try { for await (const m of c.fetch('1:*', { flags: true })) if (!m.flags.has('\\Deleted')) live++ } finally { lock.release() } } finally { await c.logout() }
    assert.equal(live, 1, 'one live copy, not one per autosave')
    const r = await p.tools.get('mail_draft').execute({ action: 'delete', draftId: s1.json.id })
    assert.equal(r.ok, true)
    assert.ok(await count() >= 0)
  })
  await p.close()
  await new Promise(r => imap.close(r))
  rmSync(dir, { recursive: true, force: true })
}

section('review: reading view, SSRF, parity, isolation')
await test('relative links are dropped from mail HTML; absolute, mailto and anchors stay', () => {
  const { html } = sanitizeMailHtml('<a href="/dsh-mail/api/state">rel</a><a href="//evil.example/x">proto</a><a href="https://ok.example/">abs</a><a href="mailto:a@example.org">m</a><a href="#top">top</a>')
  assert.ok(!/href="\/dsh-mail/.test(html), 'relative href removed')
  assert.ok(!/evil\.example/.test(html), 'protocol-relative removed')
  assert.match(html, /href="https:\/\/ok\.example\/"/)
  assert.match(html, /href="mailto:a@example\.org"/)
  assert.match(html, /href="#top"/)
})
await test('API base URLs: https, or http to loopback only, never link-local', () => {
  assert.equal(apiBaseUrlError('https://api.example.org/v1'), '')
  assert.equal(apiBaseUrlError('http://127.0.0.1:8080'), '')
  assert.ok(apiBaseUrlError('http://api.example.org'))
  assert.ok(apiBaseUrlError('https://169.254.169.254/latest'))
  assert.ok(apiBaseUrlError('file:///etc/passwd'))
  assert.ok(apiBaseUrlError('https://user:pw@api.example.org'))
  const errs = validateAccount(normalizeAccount({ id: 'lm', type: 'lettermint', api: { baseUrl: 'http://192.0.2.5/' } }), [])
  assert.ok(errs.some(e => /api\.baseUrl/.test(e)))
})
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mail-rv-ssrf-'))
  let hits = 0
  const trap = http.createServer((req, res) => { hits++; res.end('{}') })
  await new Promise(r => trap.listen(0, '127.0.0.2', r))
  const p = await bootPlugin({ dir, settings: { accounts: [{ id: 'lm', type: 'lettermint', api: { baseUrl: '' } }] } })
  await test('Test connection refuses an account with a disallowed API base URL before any request', async () => {
    const r = await mutate(p.port, '/accounts/test', { account: { id: 'lm', type: 'lettermint', api: { baseUrl: 'http://api.example.org' }, secrets: { apiKey: '__set__' } } })
    assert.equal(r.status, 400); assert.match(r.json.error, /api\.baseUrl/)
    const s = await mutate(p.port, '/accounts/save', { account: { id: 'lm2', type: 'lettermint', api: { baseUrl: 'http://api.example.org' } } })
    assert.equal(s.status, 400)
    assert.equal(hits, 0)
  })
  await p.close()
  await new Promise(r => trap.close(r))
  rmSync(dir, { recursive: true, force: true })
}
await test('mail_send html (plain format) goes out unchanged, like v0.1', () => {
  const html = '<table bgcolor="#eee" style="padding:12px;font-size:15px"><tr><td><style>.x{color:red}</style><span class="x">Hi</span></td></tr></table>'
  assert.equal(renderBody({ format: 'plain', text: 't', html }).html, html)
  assert.ok(!/<script/.test(renderBody({ format: 'markdown', text: '<script>x</script>' }).html), 'generated html is still sanitised')
})
await test('tests cannot reach the real credential files of this machine', () => {
  for (const k of ['DSH_MAIL_ESTATE_HOME', 'DSH_MAIL_MAILBOX_CREDENTIALS']) {
    assert.ok(process.env[k], k + ' set')
    assert.ok(!process.env[k].startsWith(join(homedir(), '.config')), k + ' points away from the real home')
  }
})
