/**
 * dsh-mail tests: phase 3. Presets, Twilio SendGrid (send + Inbound Parse),
 * mass-send hardening (List-Unsubscribe, suppression, rate limits, jitter,
 * circuit breaker, dry run), firstContactConfirm, the audit log, mail_forward
 * and the explicit "Convert legacy settings to accounts".
 */
import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'

import { test, section } from './harness.mjs'
import { bootPlugin, request, mutate } from './helpers.mjs'
import { runMassSend, parseUnsubscribe, unsubscribeHeaders, Suppression, OutboundState, RateLimitError, isHardBounce } from '../lib/outbound.js'
import { probeEndpoint } from '../scripts/probe-presets.mjs'
import { parseMultipart } from '../lib/inbound.js'

const require = createRequire(import.meta.url)
const presets = require('../lib/presets.json')
const hoodiecrow = require('hoodiecrow-imap')
const { SMTPServer } = require('smtp-server')
const { simpleParser } = require('mailparser')

function freePort() { return new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) }) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

section('presets')
await test('presets.json: complete rows, sane ports and TLS, EU first, Tuta unsupported, Proton via Bridge', () => {
  const ids = new Set()
  let seenGlobal = false
  for (const p of presets) {
    assert.ok(p.id && !ids.has(p.id), 'unique id ' + p.id); ids.add(p.id)
    for (const k of ['label', 'region', 'type', 'auth', 'notes', 'docs']) assert.ok(typeof p[k] === 'string' && p[k], p.id + ' has ' + k)
    assert.match(p.docs, /^https:\/\//, p.id + ' docs is https')
    assert.equal(typeof p.verified, 'boolean', p.id + ' verified flag')
    if (p.region === 'global') seenGlobal = true
    else assert.ok(!seenGlobal, 'EU providers are listed before the global ones (' + p.id + ')')
    if (p.unsupported || p.customHost) continue
    const eps = [p.receive.imap, p.receive.pop3, p.send].filter(Boolean)
    assert.ok(p.receive.imap && p.send.host, p.id + ' has IMAP and SMTP')
    for (const e of eps) {
      assert.ok(e.host && Number.isInteger(e.port), p.id + ' endpoint')
      assert.ok(['tls', 'starttls'].includes(e.security), p.id + ' never plaintext')
      if (!p.bridge) {
        if ([993, 995, 465].includes(e.port)) assert.equal(e.security, 'tls', p.id + ' ' + e.port + ' is implicit TLS')
        if ([587, 143, 110].includes(e.port)) assert.equal(e.security, 'starttls', p.id + ' ' + e.port + ' is STARTTLS')
      }
    }
  }
  const tuta = presets.find(p => p.id === 'tuta'); assert.match(tuta.unsupported, /no IMAP/)
  const proton = presets.find(p => p.id === 'proton-bridge'); assert.equal(proton.receive.imap.host, '127.0.0.1'); assert.equal(proton.allowSelfSigned, true)
  assert.equal(presets.find(p => p.id === 'mailfence').verified, false, 'Mailfence is not reachable: unverified')
})
await test('probe: TLS handshake ok on a TLS server, closed port reported', async () => {
  const creds = hoodiecrow({}).getCredentials()
  const port = await freePort()
  const srv = tls.createServer({ key: creds.key, cert: creds.cert }, s => s.end())
  await new Promise(r => srv.listen(port, '127.0.0.1', r))
  const r = await probeEndpoint({ host: '127.0.0.1', port, security: 'tls' }, 3000)
  assert.equal(r.ok, false, 'self-signed is not "verified"'); assert.match(r.detail, /TLS|self|certificate/i)
  srv.close()
  const closed = await probeEndpoint({ host: '127.0.0.1', port: await freePort(), security: 'tls' }, 2000)
  assert.equal(closed.ok, false)
  const plainPort = await freePort()
  const smtp = net.createServer(s => s.write('220 hello\r\n'))
  await new Promise(r => smtp.listen(plainPort, '127.0.0.1', r))
  assert.equal((await probeEndpoint({ host: '127.0.0.1', port: plainPort, security: 'starttls' }, 2000)).ok, true)
  smtp.close()
})

section('outbound units')
await test('unsubscribe parsing and headers (mailto + https One-Click, placeholders encoded)', () => {
  const u = parseUnsubscribe('mailto:unsub@example.org?subject=unsubscribe, https://example.org/u?e={email}')
  const h = unsubscribeHeaders(u, { email: 'a+b@example.org' })
  assert.equal(h['List-Unsubscribe'], '<mailto:unsub@example.org?subject=unsubscribe>, <https://example.org/u?e=a%2Bb%40example.org>')
  assert.equal(h['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click')
  assert.equal(unsubscribeHeaders(parseUnsubscribe('mailto:u@example.org'), {})['List-Unsubscribe-Post'], undefined)
  assert.throws(() => parseUnsubscribe('ftp://x'))
  assert.throws(() => parseUnsubscribe('https://x\r\nBcc: y'))
})
const dirU = mkdtempSync(join(tmpdir(), 'dsh-mail-p3u-'))
const baseSettings = { maxDelayMs: 60000, minDelayMs: 0, defaultReplyTo: '', mass: { unsubscribeAbove: 50, breakerFailures: 5, jitterPct: 20 } }
const rows = n => Array.from({ length: n }, (_, i) => ({ name: 'N' + i, email: 'u' + i + '@example.org' }))
const acc = { id: 'x', limits: { perMinute: 0, perDay: 0 } }
await test('mass send: >50 needs unsubscribe; header-less accounts refused; dry run previews 3', async () => {
  const st = new OutboundState(join(dirU, 's1.json')); const sup = new Suppression(join(dirU, 'sup1.txt'))
  const d = { service: { send: async () => ({}) }, state: st, suppression: sup, settings: baseSettings, canSetHeaders: true }
  await assert.rejects(runMassSend(acc, { rows: rows(51), subjectTemplate: 's', textTemplate: 't' }, d), /unsubscribe/)
  await assert.rejects(runMassSend(acc, { rows: rows(3), subjectTemplate: 's', textTemplate: 't', unsubscribe: 'mailto:u@example.org' }, { ...d, canSetHeaders: false }), /cannot set List-Unsubscribe/)
  sup.add('u1@example.org')
  const dry = await runMassSend(acc, { rows: rows(60), subjectTemplate: 'Hi {name}', textTemplate: 'x', unsubscribe: 'https://example.org/u', dryRun: true, delayMs: 1000 }, d)
  assert.equal(dry.preview.length, 3); assert.equal(dry.suppressed, 1); assert.equal(dry.sendable, 59); assert.equal(dry.preview[0].subject, 'Hi N0')
  assert.equal(dry.preview[0].headers.Precedence, 'bulk')
})
await test('mass send: circuit breaker after 5 consecutive failures; hard bounces suppressed', async () => {
  const sup = new Suppression(join(dirU, 'sup2.txt'))
  let calls = 0
  const svc = { send: async () => { calls++; const e = new Error('550 5.1.1 user unknown'); e.responseCode = 550; throw e } }
  const r = await runMassSend(acc, { rows: rows(20), subjectTemplate: 's', textTemplate: 't', delayMs: 0 }, { service: svc, state: new OutboundState(join(dirU, 's2.json')), suppression: sup, settings: baseSettings, canSetHeaders: true })
  assert.equal(calls, 5); assert.match(r.stopped, /circuit breaker/); assert.equal(sup.list().length, 5)
  assert.ok(isHardBounce({ responseCode: 550 }))
})
await test('mass send: per-minute limit waits and retries, daily limit stops; jitter within +-20%', async () => {
  const waits = []
  let n = 0
  const svc = { send: async () => { n++; if (n === 2) throw new RateLimitError('rate limit: per minute', 30, 'minute'); if (n === 5) throw new RateLimitError('rate limit: per day', 999, 'day') } }
  const r = await runMassSend(acc, { rows: rows(8), subjectTemplate: 's', textTemplate: 't', delayMs: 1000 }, { service: svc, state: new OutboundState(join(dirU, 's3.json')), suppression: new Suppression(join(dirU, 'sup3.txt')), settings: baseSettings, canSetHeaders: true, sleep: async ms => { waits.push(ms) } })
  assert.equal(r.sent, 3); assert.match(r.stopped, /per day/)
  assert.ok(waits.includes(30000), 'waited for the minute window')
  for (const w of waits.filter(x => x !== 30000)) assert.ok(w >= 800 && w <= 1200, 'jitter ' + w)
})
await test('rate windows: check/consume per minute and per day, 0 = unlimited', () => {
  const st = new OutboundState(join(dirU, 's4.json'))
  const a = { id: 'r', limits: { perMinute: 2, perDay: 3 } }
  const t0 = Date.UTC(2026, 9, 31, 10, 0, 5)
  st.check(a, 1, t0); st.consume(a, 1, t0); st.check(a, 1, t0); st.consume(a, 1, t0)
  assert.throws(() => st.check(a, 1, t0), e => e.code === 'rate_limit' && e.scope === 'minute' && e.retryAfterSec === 55)
  st.check(a, 1, t0 + 60000); st.consume(a, 1, t0 + 60000)
  assert.throws(() => st.check(a, 1, t0 + 120000), e => e.scope === 'day')
  st.check({ id: 'u', limits: { perMinute: 0, perDay: 0 } }, 1000, t0)
})
await test('inbound multipart parser', () => {
  const b = '----x'
  const body = Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="to"\r\n\r\nme@example.org\r\n--' + b + '\r\nContent-Disposition: form-data; name="email"\r\n\r\nFrom: a@example.org\r\nSubject: Hi\r\n\r\nbody\r\n--' + b + '--\r\n')
  const f = parseMultipart(body, 'multipart/form-data; boundary=' + b)
  assert.equal(f.to.value.toString(), 'me@example.org'); assert.match(f.email.value.toString(), /Subject: Hi/)
})

// ── integration: SMTP sink, IMAP, SendGrid mock ─────────────────────────────
const sink = []
const smtpPort = await freePort()
const smtp = new SMTPServer({ authOptional: true, allowInsecureAuth: true, disabledCommands: ['STARTTLS'], logger: false, onAuth(a, s, cb) { cb(null, { user: a.username }) }, onData(stream, s, cb) { const c = []; stream.on('data', x => c.push(x)); stream.on('end', () => { sink.push(Buffer.concat(c)); cb() }) } })
await new Promise(r => smtp.listen(smtpPort, '127.0.0.1', r))
const imapPort = await freePort()
const ATT = 'MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b1"\r\n\r\n--b1\r\nContent-Type: text/plain\r\n\r\nOriginal body.\r\n--b1\r\nContent-Type: text/plain; name="a.txt"\r\nContent-Disposition: attachment; filename="a.txt"\r\n\r\nforwarded-attachment-xyz\r\n--b1--\r\n'
const imap = hoodiecrow({ plugins: ['SPECIAL-USE', 'MOVE', 'UIDPLUS'], storage: { INBOX: { messages: [{ raw: 'From: Ann <ann@partner.example>\r\nTo: me@example.org\r\nSubject: Report\r\nMessage-ID: <r1@partner.example>\r\nDate: ' + new Date().toUTCString() + '\r\n' + ATT }] }, '': { separator: '/', folders: { Sent: { 'special-use': '\\Sent' } } } } })
await new Promise(r => imap.listen(imapPort, '127.0.0.1', r))
const sg = { mails: [] }
const sgPort = await freePort()
const sgServer = http.createServer((req, res) => {
  let data = ''; req.on('data', c => { data += c }); req.on('end', () => {
    if (req.url === '/v3/mail/send' && req.headers.authorization === 'Bearer SG.canary-key') { sg.mails.push(JSON.parse(data)); res.writeHead(202, { 'x-message-id': 'sg-msg-1' }); return res.end() }
    res.writeHead(401); res.end('{"errors":[{"message":"unauthorized"}]}')
  })
})
await new Promise(r => sgServer.listen(sgPort, '127.0.0.1', r))

const dir = mkdtempSync(join(tmpdir(), 'dsh-mail-p3-'))
const settings = {
  minDelayMs: 0, trustedHosts: ['mail-dsh.example.org'], agents: { confirmMode: 'reply-only' },
  accounts: [
    { id: 'box', type: 'imap-smtp', address: 'me@example.org', receive: { protocol: 'imap', host: '127.0.0.1', port: imapPort, security: 'none' }, send: { protocol: 'smtp', host: '127.0.0.1', port: smtpPort, security: 'none' }, auth: { user: 'testuser' }, secrets: { password: 'testpass' }, agent: { allow: true, canMass: true, default: true }, limits: { perMinute: 0, perDay: 0 } },
    { id: 'slow', type: 'imap-smtp', address: 'me@example.org', receive: { protocol: 'none' }, send: { protocol: 'smtp', host: '127.0.0.1', port: smtpPort, security: 'none' }, agent: { allow: true }, limits: { perMinute: 2, perDay: 100 } },
    { id: 'sg', type: 'sendgrid', address: 'news@example.org', defaultFrom: 'News <news@example.org>', api: { baseUrl: 'http://127.0.0.1:' + sgPort }, secrets: { apiKey: 'SG.canary-key' }, agent: { allow: true, canMass: true }, inbound: { enabled: true } },
  ],
}
section('phase 3: integration')
const p = await bootPlugin({ dir, settings })
const T = n => p.tools.get(n)

await test('SendGrid v3 send: personalizations, from, content, attachments, custom headers', async () => {
  const f = join(dir, 'note.txt'); writeFileSync(f, 'sg-attachment')
  const r = await T('mail_send').execute({ account: 'sg', to: 'Reader <reader@example.org>', cc: 'cc@example.org', subject: 'Hello', text: 'Plain', html: '<p>Rich</p>', attachments: [f], confirm: true })
  assert.equal(r.ok, true, r.error); assert.equal(r.messageId, 'sg-msg-1')
  const m = sg.mails[0]
  assert.deepEqual(m.personalizations[0].to, [{ email: 'reader@example.org', name: 'Reader' }]); assert.deepEqual(m.personalizations[0].cc, [{ email: 'cc@example.org' }])
  assert.deepEqual(m.from, { email: 'news@example.org', name: 'News' })
  assert.deepEqual(m.content.map(c => c.type), ['text/plain', 'text/html'])
  assert.equal(Buffer.from(m.attachments[0].content, 'base64').toString(), 'sg-attachment')
})
await test('SendGrid Inbound Parse: off without secret, path secret required, stored in the cache only', async () => {
  const fd = (raw) => { const b = '----dshmail'; return { body: '--' + b + '\r\nContent-Disposition: form-data; name="email"\r\n\r\n' + raw + '\r\n--' + b + '--\r\n', ct: 'multipart/form-data; boundary=' + b } }
  const post = (path, f, host = 'mail-dsh.example.org') => new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: p.port, method: 'POST', path: '/dsh-mail/api' + path, headers: { host, 'content-type': f.ct, 'content-length': Buffer.byteLength(f.body) } }, x => { let t = ''; x.on('data', c => { t += c }); x.on('end', () => res({ status: x.statusCode, text: t })) })
    r.on('error', rej); r.end(f.body)
  })
  const raw = 'From: Client <client@cust.example>\r\nTo: news@example.org\r\nSubject: Inbound hello\r\nMessage-ID: <in1@cust.example>\r\n\r\nHi there\r\n'
  assert.equal((await post('/inbound/sendgrid/sg?s=nope', fd(raw))).status, 404, 'no secret configured yet')
  const g = await mutate(p.port, '/accounts/webhook-secret', { account: 'sg' })
  assert.match(g.json.path, /^\/dsh-mail\/api\/inbound\/sendgrid\/sg\?s=/)
  const path = g.json.path.replace('/dsh-mail/api', '')
  assert.equal((await post(path.replace(/s=.*/, 's=wrong'), fd(raw))).status, 404)
  assert.equal((await post(path, fd(raw), 'evil.example')).status, 403)
  assert.equal((await post(path, fd(raw))).status, 200)
  const list = (await request(p.port, 'GET', '/messages?account=sg')).json
  assert.equal(list.rows[0].subject, 'Inbound hello')
  const m = (await request(p.port, 'GET', '/message?id=' + encodeURIComponent(list.rows[0].id))).json.message
  assert.match(m.text, /Hi there/)
  assert.equal(statSync(join(dir, 'data', 'inbound', 'sg')).mode & 0o777, 0o700)
  assert.ok(!(await request(p.port, 'GET', '/accounts')).text.includes(path.split('s=')[1]), 'the webhook secret is not readable afterwards')
})
await test('mass send of 120 rows: unsubscribe headers, suppression honoured, all delivered to the sink', async () => {
  sink.length = 0
  await mutate(p.port, '/suppress', { add: 'u7@example.org' })
  await mutate(p.port, '/suppress', { add: '@blocked.example' })
  const csv = 'name,email\n' + rows(118).map(r => r.name + ',' + r.email).join('\n') + '\nX,x@blocked.example\nY,y@blocked.example'
  // 'slow' cannot receive mail and no public unsubscribe URL is configured: no built-in unsubscribe, so refused
  const refused = await T('mail_mass_send').execute({ account: 'slow', subjectTemplate: 'Hi {name}', textTemplate: 'Hello {name}', csv, delayMs: 0 })
  assert.equal(refused.ok, false); assert.match(refused.error, /unsubscribe/)
  const r = await T('mail_mass_send').execute({ account: 'box', subjectTemplate: 'Hi {name}', textTemplate: 'Hello {name}', csv, delayMs: 0, unsubscribe: 'mailto:unsub@example.org, https://example.org/u?e={email}' })
  assert.equal(r.ok, true, r.error); assert.equal(r.total, 120); assert.equal(r.sent, 117); assert.equal(r.suppressed, 3)
  for (let i = 0; i < 50 && sink.length < 117; i++) await sleep(20)
  assert.equal(sink.length, 117)
  const head = sink[0].toString('utf8').split('\r\n\r\n')[0].replace(/\r\n[ \t]+/g, ' ')
  assert.match(head, /^List-Unsubscribe: <mailto:unsub@example\.org>, <https:\/\/example\.org\/u\?e=u0%40example\.org>$/m)
  assert.match(head, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m)
  assert.match(head, /^Precedence: bulk$/m)
})
await test('per-account rate limit: third send in a minute returns rate limit with retryAfterSec', async () => {
  const a = await T('mail_send').execute({ account: 'slow', to: 'p@example.org', subject: '1', text: 'x', confirm: true })
  const b = await T('mail_send').execute({ account: 'slow', to: 'p@example.org', subject: '2', text: 'x', confirm: true })
  const c = await T('mail_send').execute({ account: 'slow', to: 'p@example.org', subject: '3', text: 'x', confirm: true })
  assert.ok(a.ok && b.ok, a.error || b.error)
  assert.equal(c.ok, false); assert.match(c.error, /rate limit/); assert.ok(c.retryAfterSec > 0)
})
await test('firstContactConfirm: a new recipient domain needs confirm:true, even in reply-only mode', async () => {
  sink.length = 0
  const r = await T('mail_send').execute({ account: 'box', to: 'boss@newcorp.example', subject: 'Hello', text: 'x' })
  assert.equal(r.drafted, true); assert.match(r.text, /First message from box to newcorp\.example/)
  assert.equal(sink.length, 0)
  const known = await T('mail_send').execute({ account: 'box', to: 'colleague@example.org', subject: 'Hi', text: 'x' })
  assert.ok(known.ok && !known.drafted, 'own domain is known')
  const ok = await T('mail_send').execute({ draftId: r.draftId, confirm: true })
  assert.equal(ok.ok, true, ok.error)
  const again = await T('mail_send').execute({ account: 'box', to: 'other@newcorp.example', subject: 'Again', text: 'x' })
  assert.ok(again.ok && !again.drafted, 'domain is known after the confirmed send')
})
await test('mail_forward: draft first in "all", forwards body and (opt-in) attachments', async () => {
  const list = (await request(p.port, 'GET', '/messages?account=box')).json
  const id = list.rows.find(x => x.subject === 'Report').id
  await mutate(p.port, '/settings', { settings: { agents: { confirmMode: 'all' } } })
  const d = await T('mail_forward').execute({ id, to: 'team@example.org', note: 'FYI', attachments: true })
  assert.equal(d.drafted, true)
  sink.length = 0
  const s = await T('mail_send').execute({ draftId: d.draftId, confirm: true })
  assert.equal(s.ok, true, s.error)
  for (let i = 0; i < 50 && !sink.length; i++) await sleep(20)
  const m = await simpleParser(sink[0])
  assert.equal(m.subject, 'Fwd: Report'); assert.match(m.text, /FYI[\s\S]*Forwarded message[\s\S]*Original body/)
  assert.equal(m.attachments[0].content.toString(), 'forwarded-attachment-xyz')
  await mutate(p.port, '/settings', { settings: { agents: { confirmMode: 'reply-only' } } })
})
await test('audit log: 0600 jsonl with actor, account, count and subject hash; no subjects or bodies', async () => {
  const f = join(dir, 'data', 'audit.jsonl')
  assert.equal(statSync(f).mode & 0o777, 0o600)
  const text = readFileSync(f, 'utf8')
  assert.ok(!text.includes('Hello {name}') && !text.includes('Fwd: Report') && !text.includes('FYI'))
  const a = (await request(p.port, 'GET', '/audit?limit=500')).json.entries
  assert.ok(a.some(e => e.action === 'mass_send' && e.actor === 'agent' && e.count === 117))
  assert.ok(a.some(e => e.action === 'inbound' && e.account === 'sg'))
  assert.ok(a.some(e => e.action === 'send' && e.ok === false && e.account === 'slow') === false, 'rate-limited sends never reached the transport')
  assert.ok(a.every(e => !e.subject && (e.subjectHash === undefined || /^[a-f0-9]{16}$/.test(e.subjectHash))))
  assert.equal((await request(p.port, 'GET', '/audit', { headers: { host: 'evil.example' } })).status, 403)
})
await p.close()
await new Promise(r => smtp.close(r)); await new Promise(r => imap.close(r)); await new Promise(r => sgServer.close(r))
rmSync(dir, { recursive: true, force: true })

section('phase 3: convert legacy settings to accounts')
{
  const d2 = mkdtempSync(join(tmpdir(), 'dsh-mail-conv-'))
  const estate = join(d2, 'estate'); mkdirSync(join(estate, '.config', 'lettermint'), { recursive: true })
  writeFileSync(join(estate, '.config', 'lettermint', 'credentials'), 'LETTERMINT_API_KEY=lm-file-canary\n')
  const legacy = {
    trustedHosts: ['llm.example.org'], mailboxBaseUrl: 'http://127.0.0.1:9', mailboxAgentToken: 'tz-conv-canary',
    providers: { tzmail: { tzmailBaseURL: 'http://127.0.0.1:9' }, resend: { resendApiKey: 're-conv-canary' }, smtp: { smtpHost: 'smtp.example.org', smtpUser: 'u@example.org', smtpPass: 'smtp-conv-canary' } },
  }
  const c = await bootPlugin({ dir: d2, settings: legacy, estateHome: estate })
  await test('before: virtual legacy accounts, reply-only and default lettermint detected', async () => {
    assert.deepEqual(c.resolved().legacy.map(a => a.id).sort(), ['lettermint', 'resend', 'smtp', 'tzmail'])
    const st = (await request(c.port, 'GET', '/state')).json
    assert.equal(st.legacyInstall, true); assert.equal(st.confirmMode.mode, 'reply-only'); assert.equal(st.defaultAccount, 'lettermint')
  })
  await test('convert needs confirm:true and is never automatic', async () => {
    const r = await mutate(c.port, '/accounts/convert', {})
    assert.equal(r.status, 400)
    assert.equal(c.resolved().explicit.length, 0)
  })
  await test('convert: same ids, behaviour pinned, secrets moved to the 0600 file, file keys referenced, backup written', async () => {
    const r = await mutate(c.port, '/accounts/convert', { confirm: true })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.converted.sort(), ['lettermint', 'resend', 'smtp', 'tzmail'])
    assert.deepEqual(r.json.pins, { defaultProvider: 'lettermint', 'agents.confirmMode': 'reply-only', 'agents.firstContactConfirm': false })
    const res = c.resolved()
    assert.equal(res.legacy.length, 0)
    assert.deepEqual(res.explicit.map(a => a.id).sort(), ['lettermint', 'resend', 'smtp', 'tzmail'])
    // compare as booleans: a failing assertion must never print a secret value
    assert.ok(res.explicit.find(a => a.id === 'lettermint').secrets.apiKey === 'lm-file-canary', 'lettermint key read from the referenced file')
    assert.ok(res.explicit.find(a => a.id === 'resend').secrets.apiKey === 're-conv-canary', 'resend key moved')
    assert.ok(res.explicit.find(a => a.id === 'tzmail').secrets.apiKey === 'tz-conv-canary', 'tzmail token moved')
    assert.ok(res.explicit.find(a => a.id === 'smtp').secrets.password === 'smtp-conv-canary', 'smtp password moved')
    const settingsFile = readFileSync(join(d2, 'data', 'settings.json'), 'utf8')
    for (const s of ['re-conv-canary', 'tz-conv-canary', 'smtp-conv-canary', 'lm-file-canary']) assert.ok(!settingsFile.includes(s), 'settings keep ' + s)
    const sec = readFileSync(join(d2, 'data', 'secrets.json'), 'utf8')
    assert.ok(!sec.includes('lm-file-canary'), 'credential-file keys are referenced, not copied')
    assert.ok(JSON.parse(settingsFile).accounts.find(a => a.id === 'lettermint').apiKeyFile.includes('lettermint/credentials'))
    const st = (await request(c.port, 'GET', '/state')).json
    assert.equal(st.legacyInstall, false); assert.equal(st.confirmMode.mode, 'reply-only'); assert.equal(st.defaultAccount, 'lettermint')
    assert.equal(c.effective().agents.firstContactConfirm, false)
    assert.ok(existsSync(join(d2, 'data', 'backups')))
    const tools = await c.tools.get('mail_accounts').execute({})
    assert.ok(tools.text.includes('lettermint (default)'))
  })
  await c.close()
  rmSync(d2, { recursive: true, force: true })
}
rmSync(dirU, { recursive: true, force: true })
