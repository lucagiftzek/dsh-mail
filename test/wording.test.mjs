/**
 * dsh-mail tests: wording of the send tools. A weaker model must never be able to believe that a call only drafts
 * when it really sent (a real case: reply-only mode, mail_send without confirm:true delivered, the agent said "draft").
 * Per mode (all, reply-only, automatic) and per tool: the description and the first words of every result.
 */
import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import net from 'node:net'

import { test, section } from './harness.mjs'
import { bootPlugin, mutate } from './helpers.mjs'
import { SENT_PREFIX, DRAFT_PREFIX } from '../lib/tools.js'

const require = createRequire(import.meta.url)
const hoodiecrow = require('hoodiecrow-imap')
const { SMTPServer } = require('smtp-server')

const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const sleep = ms => new Promise(r => setTimeout(r, ms))

section('wording: send tools say what really happened')
const sink = []
const smtpPort = await freePort()
const smtp = new SMTPServer({ authOptional: true, allowInsecureAuth: true, disabledCommands: ['STARTTLS'], logger: false, onAuth(a, s, cb) { cb(null, { user: a.username }) }, onData(stream, s, cb) { const c = []; stream.on('data', x => c.push(x)); stream.on('end', () => { sink.push(Buffer.concat(c)); cb() }) } })
await new Promise(r => smtp.listen(smtpPort, '127.0.0.1', r))
const imapPort = await freePort()
const imap = hoodiecrow({ plugins: ['SPECIAL-USE', 'MOVE', 'UIDPLUS'], storage: { INBOX: { messages: [{ raw: 'From: Ann <ann@partner.example>\r\nTo: me@example.org\r\nSubject: Report\r\nMessage-ID: <w1@partner.example>\r\nDate: ' + new Date().toUTCString() + '\r\n\r\nOriginal body.\r\n' }] }, '': { separator: '/', folders: { Sent: { 'special-use': '\\Sent' } } } } })
await new Promise(r => imap.listen(imapPort, '127.0.0.1', r))

const dir = mkdtempSync(join(tmpdir(), 'dsh-mail-wording-'))
const box = { id: 'box', type: 'imap-smtp', address: 'me@example.org', receive: { protocol: 'imap', host: '127.0.0.1', port: imapPort, security: 'none' }, send: { protocol: 'smtp', host: '127.0.0.1', port: smtpPort, security: 'none' }, auth: { user: 'testuser' }, secrets: { password: 'testpass' }, agent: { allow: true, canMass: true, default: true }, limits: { perMinute: 0, perDay: 0 } }
const p = await bootPlugin({ dir, settings: { minDelayMs: 0, trustedHosts: ['mail-dsh.example.org'], agents: { confirmMode: 'reply-only' }, accounts: [box] } })
const T = n => p.tools.get(n)
await mutate(p.port, '/sync', { account: 'box' })
const setMode = m => mutate(p.port, '/settings', { settings: { agents: { confirmMode: m } } })
const dashes = /[\u2013\u2014]/
const csv = 'name,email\nAnn,ann@example.org\nBob,bob@example.org'
const mass = { account: 'box', subjectTemplate: 'Hi {name}', textTemplate: 'Hello {name}', csv, delayMs: 0, unsubscribe: 'mailto:unsub@example.org' }
const threadId = async () => /id (box\/\S+)/.exec((await T('mail_inbox').execute({ account: 'box', limit: 3 })).text)[1]
const msgId = async () => (await T('mail_read').execute({ account: 'box', limit: 1 })).messages[0].messageId

await test('descriptions never claim draft-first unconditionally and state every mode', () => {
  for (const n of ['mail_send', 'mail_forward', 'mail_reply', 'mail_mass_send', 'mail_send_later', 'mail_accounts']) {
    const dsc = T(n).description
    assert.ok(!/draft first/i.test(dsc), n + ' must not say "draft first"')
    assert.ok(!dashes.test(dsc), n + ' has no dash characters')
  }
  for (const n of ['mail_send', 'mail_forward']) {
    const dsc = T(n).description
    assert.match(dsc, /mode "all" = it only saves a DRAFT and sends nothing/); assert.match(dsc, /mode "reply-only" = a NEW message is SENT IMMEDIATELY/)
    assert.match(dsc, /automatic/); assert.ok(dsc.includes(SENT_PREFIX) && dsc.includes(DRAFT_PREFIX))
  }
  assert.match(T('mail_send').description, /^Send one email through an account\. A call may SEND IMMEDIATELY or only save a draft, depending on the mail mode, and the result says which\./)
  assert.match(T('mail_mass_send').description, /mode "all"[^]*STAGES the batch[^]*mode "reply-only"[^]*SENDS NOW/)
  assert.match(T('mail_send_later').description, /SCHEDULED for <time>, not sent yet/)
  assert.match(T('mail_reply').description, /In every mail mode a call without confirm:true only returns a draft/)
})

section('wording: reply-only (sent but reported as a draft)')
await test('reply-only: mail_send for a NEW email without confirm SENDS, result starts with SENT', async () => {
  await setMode('reply-only'); sink.length = 0
  const r = await T('mail_send').execute({ account: 'box', to: 'colleague@example.org', subject: 'New mail', text: 'hello' })
  assert.equal(r.ok, true, r.error); assert.equal(r.sent, true); assert.ok(!r.drafted)
  assert.ok(r.text.startsWith(SENT_PREFIX), r.text)
  assert.match(r.text, /From: /); assert.match(r.text, /To: colleague@example\.org/); assert.match(r.text, /Subject: New mail/); assert.match(r.text, /Provider message id: /)
  for (let i = 0; i < 50 && !sink.length; i++) await sleep(20)
  assert.equal(sink.length, 1, 'it really was delivered')
})
await test('reply-only: mail_accounts says plainly that a send call sends at once', async () => {
  const a = await T('mail_accounts').execute({})
  assert.match(a.text, /^Mail mode: reply-only \(set by the user\)\. In this install, mail_send and mail_forward WITHOUT confirm:true SEND IMMEDIATELY/)
  assert.equal(a.data.confirmMode, 'reply-only'); assert.equal(a.data.sendWithoutConfirm, 'send')
})
await test('reply-only: mail_forward without confirm SENDS (SENT prefix), mail_reply without confirm DRAFTS', async () => {
  sink.length = 0
  const f = await T('mail_forward').execute({ id: await msgId(), to: 'team@example.org', note: 'FYI' })
  assert.equal(f.sent, true); assert.ok(f.text.startsWith(SENT_PREFIX), f.text); assert.match(f.text, /Subject: Fwd: Report/)
  const rp = await T('mail_reply').execute({ threadId: await threadId(), text: 'Thanks' })
  assert.equal(rp.drafted, true); assert.ok(rp.text.startsWith(DRAFT_PREFIX), rp.text)
})
await test('reply-only: mail_reply with confirm SENDS, mass send SENDS, send_later with a time is SCHEDULED', async () => {
  const rp = await T('mail_reply').execute({ threadId: await threadId(), text: 'Thanks', confirm: true })
  assert.equal(rp.sent, true); assert.ok(rp.text.startsWith(SENT_PREFIX), rp.text)
  const m = await T('mail_mass_send').execute(mass)
  assert.equal(m.ok, true, m.error); assert.equal(m.sent, 2); assert.ok(m.text.startsWith(SENT_PREFIX), m.text)
  const when = new Date(Math.floor((Date.now() + 3600e3) / 1000) * 1000).toISOString()
  const l = await T('mail_send_later').execute({ account: 'box', to: 'x@example.org', subject: 'Later', text: 'x', sendAt: when })
  assert.equal(l.scheduled, true); assert.ok(l.text.startsWith('SCHEDULED for ' + when + ', not sent yet'), l.text)
})
await test('reply-only: a first message to a NEW domain is drafted, and says so', async () => {
  const r = await T('mail_send').execute({ account: 'box', to: 'boss@newcorp.example', subject: 'Hello', text: 'x' })
  assert.equal(r.drafted, true); assert.ok(r.text.startsWith(DRAFT_PREFIX), r.text); assert.match(r.text, /new recipient domain/)
})

section('wording: all')
await test('all: mail_send, mail_forward and mass send without confirm only DRAFT, results start with DRAFT ONLY', async () => {
  await setMode('all'); sink.length = 0
  const s = await T('mail_send').execute({ account: 'box', to: 'colleague@example.org', subject: 'Held', text: 'x' })
  assert.equal(s.drafted, true); assert.ok(!s.sent); assert.ok(s.text.startsWith(DRAFT_PREFIX), s.text)
  const f = await T('mail_forward').execute({ id: await msgId(), to: 'team@example.org' })
  assert.equal(f.drafted, true); assert.ok(f.text.startsWith(DRAFT_PREFIX), f.text)
  const m = await T('mail_mass_send').execute(mass)
  assert.equal(m.drafted, true); assert.equal(m.sent, 0); assert.ok(m.text.startsWith(DRAFT_PREFIX), m.text)
  const l = await T('mail_send_later').execute({ account: 'box', to: 'x@example.org', subject: 'Later', text: 'x', sendAt: new Date(Date.now() + 3600e3).toISOString() })
  assert.equal(l.drafted, true); assert.ok(l.text.startsWith(DRAFT_PREFIX), l.text)
  const rp = await T('mail_reply').execute({ threadId: await threadId(), text: 'Thanks' })
  assert.ok(rp.text.startsWith(DRAFT_PREFIX))
  await sleep(150); assert.equal(sink.length, 0, 'nothing was delivered')
})
await test('all: confirm:true sends and the draft id route also ends with SENT', async () => {
  const s = await T('mail_send').execute({ account: 'box', to: 'colleague@example.org', subject: 'Now', text: 'x', confirm: true })
  assert.equal(s.sent, true); assert.ok(s.text.startsWith(SENT_PREFIX), s.text)
  const d = await T('mail_send').execute({ account: 'box', to: 'colleague@example.org', subject: 'Via draft', text: 'x' })
  const again = await T('mail_send').execute({ draftId: d.draftId })
  assert.ok(again.text.startsWith(DRAFT_PREFIX), again.text)
  const ok = await T('mail_send').execute({ draftId: d.draftId, confirm: true })
  assert.ok(ok.text.startsWith(SENT_PREFIX), ok.text); assert.match(ok.text, /Subject: Via draft/)
})
await test('all: mail_accounts says plainly that a send call only drafts', async () => {
  const a = await T('mail_accounts').execute({})
  assert.match(a.text, /^Mail mode: all \(set by the user\)\. In this install, mail_send and mail_forward WITHOUT confirm:true only save a DRAFT and send NOTHING/)
  assert.equal(a.data.sendWithoutConfirm, 'draft')
})
await p.close()
await new Promise(r => smtp.close(r)); await new Promise(r => imap.close(r))
rmSync(dir, { recursive: true, force: true })

section('wording: automatic (no mode set)')
{
  const d2 = mkdtempSync(join(tmpdir(), 'dsh-mail-wording2-'))
  const a2 = await bootPlugin({ dir: d2, settings: { minDelayMs: 0, accounts: [box] } })
  await test('automatic on a new install resolves to "all" and mail_accounts says so', async () => {
    const a = await a2.tools.get('mail_accounts').execute({})
    assert.match(a.text, /^Mail mode: all \(automatic: the default for a new install\)\. In this install, mail_send and mail_forward WITHOUT confirm:true only save a DRAFT/)
  })
  await a2.close(); rmSync(d2, { recursive: true, force: true })
  const d3 = mkdtempSync(join(tmpdir(), 'dsh-mail-wording3-'))
  const a3 = await bootPlugin({ dir: d3, settings: { minDelayMs: 0, trustedHosts: ['llm.example.org'], providers: { smtp: { smtpHost: 'smtp.example.org', smtpUser: 'u@example.org', smtpPass: 'canary-pass' } } } })
  await test('automatic on a legacy v0.1 install resolves to "reply-only" and mail_accounts says sends are immediate', async () => {
    const a = await a3.tools.get('mail_accounts').execute({})
    assert.match(a.text, /^Mail mode: reply-only \(automatic: this install came from v0\.1\)\. In this install, mail_send and mail_forward WITHOUT confirm:true SEND IMMEDIATELY/)
    assert.ok(!a.text.includes('canary-pass'))
  })
  await a3.close(); rmSync(d3, { recursive: true, force: true })
}
