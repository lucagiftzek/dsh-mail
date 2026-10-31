/**
 * dsh-mail tests: end to end against local throwaway servers.
 *
 *   IMAP + SMTP  hoodiecrow-imap (in-memory IMAP server; its SMTP sink appends
 *                every received message to INBOX), loopback only, plaintext
 *   POP3         a small in-test POP3 server with STLS (hoodiecrow's test cert)
 *
 * Covers: LIST with SPECIAL-USE, initial sync of 200 messages, threading by
 * References, sanitised HTML, attachment download, mark read, move to Trash,
 * draft-first mail_send ("all") vs immediate ("reply-only"), send with an
 * attachment and receive it, copy to Sent, search, UIDVALIDITY reset, POP3
 * STAT/UIDL/RETR/TOP incl. STLS and dot-stuffing.
 */
import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import net from 'node:net'
import tls from 'node:tls'

import { test, section } from './harness.mjs'
import { bootPlugin, request, mutate } from './helpers.mjs'
import { Pop3Client } from '../lib/pop3.js'

const require = createRequire(import.meta.url)
const hoodiecrow = require('hoodiecrow-imap')
const { startSMTPServer } = require('hoodiecrow-imap/lib/hoodiecrowSMTPServer.js')
const { ImapFlow } = require('imapflow')

function freePort() { return new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) }) }

function msg(i, extra = {}) {
  const date = new Date(Date.now() - (300 - i) * 3600e3).toUTCString()
  const headers = ['From: Sender ' + i + ' <sender' + i + '@example.org>', 'To: testuser@example.org', 'Subject: ' + (extra.subject || 'Message ' + i), 'Date: ' + date, 'Message-ID: <m' + i + '@example.org>']
  if (extra.inReplyTo) headers.push('In-Reply-To: ' + extra.inReplyTo, 'References: ' + extra.inReplyTo)
  if (extra.raw) return headers.join('\r\n') + '\r\n' + extra.raw
  headers.push('Content-Type: text/plain; charset=utf-8')
  return headers.join('\r\n') + '\r\n\r\nBody of message ' + i + '\r\n'
}

function storage(n, uidvalidity = 7) {
  const messages = []
  for (let i = 1; i <= n; i++) {
    if (i === 3) messages.push({ raw: msg(i, { subject: 'Re: Message 2', inReplyTo: '<m2@example.org>' }), flags: [] })
    else if (i === 4) messages.push({ raw: msg(i, { subject: 'HTML mail', raw: 'Content-Type: text/html; charset=utf-8\r\n\r\n<p onclick="alert(1)">Hello <b>there</b></p><script>alert(2)</script><img src="https://tracker.example/p.gif">\r\n' }), flags: [] })
    else if (i === 5) messages.push({ raw: msg(i, { subject: 'With attachment', raw: 'MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b1"\r\n\r\n--b1\r\nContent-Type: text/plain\r\n\r\nSee attached.\r\n--b1\r\nContent-Type: text/plain; name="notes.txt"\r\nContent-Disposition: attachment; filename="notes.txt"\r\n\r\nattachment-payload-123\r\n--b1--\r\n' }), flags: [] })
    else messages.push({ raw: msg(i), flags: i % 2 ? ['\\Seen'] : [] })
  }
  return {
    INBOX: { uidvalidity, messages },
    '': { separator: '/', folders: { Sent: { 'special-use': '\\Sent' }, Trash: { 'special-use': '\\Trash' }, Archive: { 'special-use': '\\Archive' }, Junk: { 'special-use': '\\Junk' }, Projects: {} } },
  }
}

async function startImap(port, n, uidvalidity) {
  const server = hoodiecrow({ plugins: ['SPECIAL-USE', 'MOVE', 'UIDPLUS', 'ID', 'UNSELECT', 'ENABLE'], storage: storage(n, uidvalidity) })
  await new Promise(r => server.listen(port, '127.0.0.1', r))
  return server
}

async function status(port, path) {
  const c = new ImapFlow({ host: '127.0.0.1', port, secure: false, doSTARTTLS: false, auth: { user: 'testuser', pass: 'testpass' }, logger: false })
  await c.connect()
  try { return await c.status(path, { messages: true, unseen: true }) } finally { await c.logout() }
}

section('e2e: IMAP + SMTP (hoodiecrow-imap)')
const dir = mkdtempSync(join(tmpdir(), 'dsh-mail-e2e-'))
const imapPort = await freePort()
const smtpPort = await freePort()
let imap = await startImap(imapPort, 200, 7)
const origLog = console.log
console.log = (...a) => { if (!String(a[0]).includes('Incoming SMTP server')) origLog(...a) }
const smtp = await new Promise(r => { const s = startSMTPServer(smtpPort, imap, () => r(s)) })
console.log = origLog

const account = {
  id: 'hc', label: 'Test IMAP', type: 'imap-smtp', address: 'testuser@example.org', auth: { user: 'testuser' },
  receive: { protocol: 'imap', host: '127.0.0.1', port: imapPort, security: 'none' },
  send: { protocol: 'smtp', host: '127.0.0.1', port: smtpPort, security: 'starttls' }, allowSelfSigned: true,
  secrets: { password: 'testpass' }, signature: '-- \nTest', agent: { allow: true, canMass: true, default: true },
}
const p = await bootPlugin({ dir, settings: { accounts: [account], agents: { confirmMode: 'all' } } })

await test('LIST with SPECIAL-USE maps roles', async () => {
  const r = (await request(p.port, 'GET', '/folders?account=hc')).json
  const roles = Object.fromEntries(r.folders.map(f => [f.path, f.role]))
  assert.equal(roles.INBOX, 'inbox'); assert.equal(roles.Sent, 'sent'); assert.equal(roles.Trash, 'trash'); assert.equal(roles.Archive, 'archive'); assert.equal(roles.Junk, 'junk'); assert.equal(roles.Projects, '')
  assert.equal(r.folders[0].path, 'INBOX')
})
let rows
await test('initial sync fetches 200 messages and threads them by References', async () => {
  const r = (await request(p.port, 'GET', '/messages?account=hc&folder=INBOX&limit=200')).json
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors))
  assert.equal(p.service.cache.messages('hc', 'INBOX').length, 200)
  assert.equal(r.total, 199)
  rows = r.rows
  const t = rows.find(x => x.subject === 'Re: Message 2')
  assert.equal(t.count, 2)
  const th = (await request(p.port, 'GET', '/thread?account=hc&thread=' + t.thread)).json
  assert.deepEqual(th.messages.map(m => m.subject), ['Message 2', 'Re: Message 2'])
  assert.ok(rows.find(x => x.subject === 'With attachment').hasAtt)
  assert.ok(rows.find(x => x.subject === 'Message 7').snippet.includes('Body of message 7'))
})
await test('reading view: HTML is sanitised, remote image blocked, attachment downloads safely', async () => {
  const html = rows.find(x => x.subject === 'HTML mail')
  const m = (await request(p.port, 'GET', '/message?id=' + encodeURIComponent(html.id))).json.message
  assert.ok(!m.srcdoc.includes('<script') && !m.srcdoc.includes('onclick') && m.srcdoc.includes('<b>there</b>'))
  assert.equal(m.blocked, 1)
  const att = rows.find(x => x.subject === 'With attachment')
  const am = (await request(p.port, 'GET', '/message?id=' + encodeURIComponent(att.id))).json.message
  assert.equal(am.attachments.length, 1); assert.equal(am.attachments[0].filename, 'notes.txt')
  const dl = await request(p.port, 'GET', '/attachment?id=' + encodeURIComponent(att.id) + '&part=0')
  assert.equal(dl.status, 200); assert.match(dl.headers['content-disposition'], /^attachment;/); assert.equal(dl.headers['x-content-type-options'], 'nosniff')
  assert.equal(dl.text.trim(), 'attachment-payload-123')
})
await test('mark read and move to Trash reach the server', async () => {
  const unread = rows.find(x => x.unread && x.count === 1)
  const before = await status(imapPort, 'INBOX')
  let r = await mutate(p.port, '/messages/mark', { ids: [unread.id], op: 'read' })
  assert.equal(r.json.updated, 1)
  assert.equal((await status(imapPort, 'INBOX')).unseen, before.unseen - 1)
  r = await mutate(p.port, '/messages/move', { ids: [unread.id], to: 'trash' })
  assert.equal(r.json.moved, 1)
  assert.equal((await status(imapPort, 'Trash')).messages, 1)
  assert.equal((await status(imapPort, 'INBOX')).messages, before.messages - 1)
})
const attachPath = join(dir, 'report.txt')
writeFileSync(attachPath, 'attached-file-content-xyz')
await test('confirmMode all: mail_send without confirm only drafts; draftId + confirm delivers with the attachment', async () => {
  const send = p.tools.get('mail_send')
  const before = (await status(imapPort, 'INBOX')).messages
  const d = await send.execute({ to: 'testuser@example.org', subject: 'Drafted first', text: 'hello', attachments: [attachPath] })
  assert.equal(d.ok, true); assert.equal(d.drafted, true); assert.match(d.draftId, /^d-/)
  await new Promise(r => setTimeout(r, 300))
  assert.equal((await status(imapPort, 'INBOX')).messages, before, 'nothing may be sent without confirm')
  const st = (await request(p.port, 'GET', '/state')).json
  assert.ok(st.drafts.some(x => x.id === d.draftId))
  const s = await send.execute({ draftId: d.draftId, confirm: true })
  assert.equal(s.ok, true, s.error)
  for (let i = 0; i < 40 && (await status(imapPort, 'INBOX')).messages === before; i++) await new Promise(r => setTimeout(r, 50))
  assert.equal((await status(imapPort, 'INBOX')).messages, before + 1)
  assert.equal((await status(imapPort, 'Sent')).messages, 1, 'a copy is appended to Sent')
  await mutate(p.port, '/sync', { account: 'hc' })
  const got = p.service.cache.messages('hc', 'INBOX').find(m => m.subject === 'Drafted first')
  const full = await p.service.message('hc:INBOX:' + got.uid)
  assert.equal(full.attachments[0].filename, 'report.txt')
  assert.ok(full.text.includes('hello') && full.text.includes('Test'), 'signature appended')
  const a = await p.service.attachment('hc:INBOX:' + got.uid, 0)
  assert.equal(a.content.toString(), 'attached-file-content-xyz')
})
await test('confirmMode reply-only: mail_send delivers at once (v0.1 behaviour)', async () => {
  await mutate(p.port, '/settings', { settings: { agents: { confirmMode: 'reply-only' } } })
  assert.equal((await request(p.port, 'GET', '/state')).json.confirmMode.mode, 'reply-only')
  const before = (await status(imapPort, 'INBOX')).messages
  const s = await p.tools.get('mail_send').execute({ provider: 'hc', to: 'testuser@example.org', subject: 'Immediate', text: 'now' })
  assert.equal(s.ok, true); assert.ok(!s.drafted); assert.equal(s.provider, 'hc')
  for (let i = 0; i < 40 && (await status(imapPort, 'INBOX')).messages === before; i++) await new Promise(r => setTimeout(r, 50))
  assert.equal((await status(imapPort, 'INBOX')).messages, before + 1)
})
await test('tools: mail_accounts, mail_folders, mail_search, mail_read, mail_fetch, mail_mark, mail_move, mail_inbox, mail_thread', async () => {
  const T = n => p.tools.get(n)
  const acc = await T('mail_accounts').execute({})
  assert.ok(acc.ok && acc.data.accounts[0].id === 'hc' && acc.data.accounts[0].capabilities.includes('folders'))
  assert.ok((await T('mail_folders').execute({ account: 'hc' })).text.includes('Trash (trash)'))
  const se = await T('mail_search').execute({ account: 'hc', query: 'subject:"Message 1"' })
  assert.ok(se.ok && se.count > 0, se.error)
  const rd = await T('mail_read').execute({ account: 'hc', limit: 5 })
  assert.equal(rd.ok, true); assert.equal(rd.count, 5); assert.match(rd.messages[0].messageId, /^hc:INBOX:\d+$/)
  const f = await T('mail_fetch').execute({ messageId: rd.messages[0].messageId })
  assert.ok(f.ok && typeof f.message.text === 'string')
  const id = se.data.results[0].id
  assert.ok((await T('mail_mark').execute({ ids: [id], action: 'flag' })).ok)
  assert.ok(p.service.cache.getMessage('hc', 'INBOX', id.split(':').pop()).flagged)
  assert.ok((await T('mail_move').execute({ ids: [id], to: 'archive' })).ok)
  assert.equal((await status(imapPort, 'Archive')).messages, 1)
  const ib = await T('mail_inbox').execute({ account: 'hc', limit: 3 })
  assert.ok(ib.ok && ib.text.includes('id hc/'))
  const tid = /id (hc\/\S+)/.exec(ib.text)[1]
  assert.ok((await T('mail_thread').execute({ threadId: tid })).ok)
  const rep = await T('mail_reply').execute({ threadId: tid, text: 'Thanks' })
  assert.ok(rep.ok && rep.drafted)
})
await test('UIDVALIDITY reset drops the cached folder', async () => {
  await new Promise(r => imap.close(r))
  imap = await startImap(imapPort, 3, 99)
  await p.service.pool.close()
  await mutate(p.port, '/sync', { account: 'hc', folder: 'INBOX' })
  assert.equal(p.service.cache.messages('hc', 'INBOX').length, 3)
  assert.equal(p.service.cache.folder('hc', 'INBOX').uidvalidity, '99')
})
await p.close()
await new Promise(r => smtp.close(r))
await new Promise(r => imap.close(r))

section('e2e: POP3 with STLS')
const creds = imap.getCredentials()
const popMsgs = [
  { uid: 'u-1', raw: msg(1) },
  { uid: 'u-2', raw: msg(2, { raw: 'Content-Type: text/plain\r\n\r\nfirst line\r\n.a line that starts with a dot\r\nend\r\n' }) },
]
const popPort = await freePort()
const popSockets = new Set()
const popServer = net.createServer(sock => {
  popSockets.add(sock); sock.on('close', () => popSockets.delete(sock))
  let s = sock
  let buf = ''
  const out = l => s.write(l + '\r\n')
  const multi = (head, body) => { out(head); s.write(body.split('\r\n').map(l => (l.startsWith('.') ? '.' + l : l)).join('\r\n').replace(/\r\n$/, '') + '\r\n.\r\n') }
  const onData = d => {
    buf += d.toString('latin1')
    let i
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2)
      const [cmd, a, b] = line.split(' ')
      const m = popMsgs[Number(a) - 1]
      switch (cmd.toUpperCase()) {
        case 'CAPA': multi('+OK', 'STLS\r\nUIDL\r\nTOP\r\nUSER\r\n'); break
        case 'STLS': out('+OK begin TLS'); s.removeListener('data', onData); s = new tls.TLSSocket(sock, { isServer: true, key: creds.key, cert: creds.cert }); s.on('data', onData); s.on('error', () => {}); break
        case 'USER': out('+OK'); break
        case 'PASS': out(a === 'poppass' && s instanceof tls.TLSSocket ? '+OK' : '-ERR auth'); break
        case 'STAT': out('+OK ' + popMsgs.length + ' ' + popMsgs.reduce((n, x) => n + x.raw.length, 0)); break
        case 'UIDL': multi('+OK', popMsgs.map((x, j) => (j + 1) + ' ' + x.uid).join('\r\n') + '\r\n'); break
        case 'LIST': multi('+OK', popMsgs.map((x, j) => (j + 1) + ' ' + x.raw.length).join('\r\n') + '\r\n'); break
        case 'RETR': if (m) multi('+OK', m.raw); else out('-ERR no such message'); break
        case 'TOP': if (m) { const [h, body] = m.raw.split('\r\n\r\n'); multi('+OK', h + '\r\n\r\n' + body.split('\r\n').slice(0, Number(b)).join('\r\n')) } else out('-ERR no such message'); break
        case 'QUIT': out('+OK bye'); s.end(); break
        default: out('-ERR unknown')
      }
    }
  }
  s.on('data', onData)
  s.on('error', () => {})
  out('+OK POP3 test server ready')
})
await new Promise(r => popServer.listen(popPort, '127.0.0.1', r))

await test('Pop3Client: STLS, STAT, UIDL, TOP, RETR with dot-unstuffing; plaintext login refused by the server', async () => {
  const c = new Pop3Client({ host: '127.0.0.1', port: popPort, security: 'starttls', user: 'popuser', pass: 'poppass', allowSelfSigned: true })
  await c.connect()
  assert.deepEqual(await c.stat(), { count: 2, size: popMsgs.reduce((n, x) => n + x.raw.length, 0) })
  assert.deepEqual((await c.uidl()).map(x => x.uid), ['u-1', 'u-2'])
  assert.ok((await c.top(2, 0)).toString().includes('Subject: Message 2'))
  const raw = (await c.retr(2)).toString()
  assert.ok(raw.includes('\r\n.a line that starts with a dot\r\n'))
  await assert.rejects(c.retr(9), /no such message/)
  await c.quit()
  const plain = new Pop3Client({ host: '127.0.0.1', port: popPort, security: 'none', user: 'popuser', pass: 'poppass' })
  await assert.rejects(plain.connect(), /auth/)
})
await test('POP3 account: sync into the cache, open a message, local read state', async () => {
  const d2 = mkdtempSync(join(tmpdir(), 'dsh-mail-pop-'))
  const pp = await bootPlugin({ dir: d2, settings: { accounts: [{ id: 'pop', type: 'pop3-smtp', address: 'popuser@example.org', auth: { user: 'popuser' }, receive: { protocol: 'pop3', host: '127.0.0.1', port: popPort, security: 'starttls' }, send: { protocol: 'smtp', host: '127.0.0.1', port: 1, security: 'none' }, allowSelfSigned: true, secrets: { password: 'poppass' }, agent: { allow: true } }] } })
  const r = (await request(pp.port, 'GET', '/messages?account=pop')).json
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors)); assert.equal(r.rows.length, 2)
  const f = (await request(pp.port, 'GET', '/folders?account=pop')).json.folders
  assert.deepEqual(f.map(x => x.path), ['INBOX'])
  const m = (await request(pp.port, 'GET', '/message?id=' + encodeURIComponent('pop:INBOX:u-2'))).json.message
  assert.ok(m.text.includes('.a line that starts with a dot'))
  await mutate(pp.port, '/messages/mark', { ids: ['pop:INBOX:u-2'], op: 'read' })
  assert.equal(pp.service.cache.getMessage('pop', 'INBOX', 'u-2').seen, true)
  const mv = await mutate(pp.port, '/messages/move', { ids: ['pop:INBOX:u-2'], to: 'trash' })
  assert.match(mv.json.error, /no server folders/)
  await pp.close()
  rmSync(d2, { recursive: true, force: true })
})
for (const so of popSockets) so.destroy()
await new Promise(r => popServer.close(r))
rmSync(dir, { recursive: true, force: true })
