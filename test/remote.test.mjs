/**
 * dsh-mail tests: server-side first + encrypted transport (lib/remote.js and
 * the transport guards). The browser must never contact a host named in a
 * mail, the image proxy must only reach public addresses, and every provider
 * link must be TLS (plain http only to a loopback relay, plaintext mail
 * protocols only to loopback).
 */
import { strict as assert } from 'node:assert'
import http from 'node:http'
import os from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { test, section } from './harness.mjs'
import { bootPlugin, request } from './helpers.mjs'
import {
  isPublicAddress, checkRemoteUrl, upgradeToHttps, signUrl, verifyUrl, makeRewriter, sniffImage,
  fetchRemoteImage, guardedLookup, linkPage, LINK_PAGE_HEADERS, assertSecureApiUrl, limiter, ImageCache,
} from '../lib/remote.js'
import { sanitizeMailHtml, mailDocument, textToHtml, rewriteCss } from '../lib/html.js'
import { buildProvider } from '../lib/providers.js'
import { agentCall } from '../lib/mailbox.js'
import { Pop3Client } from '../lib/pop3.js'
import { graphSendMime } from '../lib/graph.js'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex')

section('remote.js: addresses and URLs (SSRF guard)')
await test('only global unicast addresses that are not this host are public', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e']) assert.ok(isPublicAddress(ip, { own: new Set() }), ip)
  for (const ip of ['127.0.0.1', '127.8.9.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.10.5', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8',
    '64:ff9b::7f00:1', '2002:7f00:1::', '2001:db8::1', 'ff02::1', 'not-an-ip', '']) assert.ok(!isPublicAddress(ip, { own: new Set() }), ip)
  assert.ok(!isPublicAddress('8.8.8.8', { own: new Set(['8.8.8.8']) }), 'an address of this host is never a target')
})
await test('checkRemoteUrl refuses private literals, local names, credentials, odd ports and schemes', () => {
  assert.equal(checkRemoteUrl('https://img.example.org/a.png').hostname, 'img.example.org')
  assert.equal(checkRemoteUrl('http://8.8.8.8:8080/x').port, '8080')
  for (const u of ['https://127.0.0.1/a', 'http://[::1]/a', 'http://10.0.0.1/', 'https://169.254.169.254/latest/meta-data', 'http://localhost/a', 'https://x.localhost/',
    'https://printer.local/', 'https://metadata.google.internal/', 'https://user:pw@img.example.org/', 'https://img.example.org:22/', 'ftp://img.example.org/',
    'file:///etc/passwd', 'javascript:alert(1)', 'https://[fd00::1]/', 'x'.repeat(5000)]) assert.throws(() => checkRemoteUrl(u), u)
})
await test('http upgrades to https (8080 to 8443)', () => {
  assert.equal(upgradeToHttps(new URL('http://a.example/x?y')).href, 'https://a.example/x?y')
  assert.equal(upgradeToHttps(new URL('http://a.example:8080/x')).href, 'https://a.example:8443/x')
})
await test('guardedLookup refuses names that resolve to loopback (DNS answer checked per connection)', async () => {
  const err = await new Promise(r => guardedLookup('localhost', {}, e => r(e)))
  assert.ok(err && err.code === 'EBLOCKED', String(err && err.message))
})
await test('signatures bind the URL and the kind', () => {
  const s = signUrl('k'.repeat(40), 'img', 'https://a.example/x')
  assert.equal(s.length, 32)
  assert.ok(verifyUrl('k'.repeat(40), 'img', 'https://a.example/x', s))
  assert.ok(!verifyUrl('k'.repeat(40), 'link', 'https://a.example/x', s), 'an image signature is not a link signature')
  assert.ok(!verifyUrl('k'.repeat(40), 'img', 'https://a.example/y', s))
  assert.ok(!verifyUrl('other-secret-other-secret-other-secret', 'img', 'https://a.example/x', s))
  assert.ok(!verifyUrl('', 'img', 'https://a.example/x', s))
  const rw = makeRewriter('k'.repeat(40), '/dsh-mail/api')
  assert.match(rw.img('https://a.example/x'), /^\/dsh-mail\/api\/img\?u=https%3A%2F%2Fa\.example%2Fx&s=[A-Za-z0-9_-]{32}$/)
})
await test('sniffImage accepts raster images only (no SVG, HTML, JSON)', () => {
  assert.equal(sniffImage(PNG), 'image/png')
  assert.equal(sniffImage(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00', 'latin1')), 'image/gif')
  assert.equal(sniffImage(Buffer.from('ffd8ffe000104a4649460001', 'hex')), 'image/jpeg')
  for (const bad of ['<svg xmlns="http://www.w3.org/2000/svg"></svg>', '<!doctype html><script>x</script>', '{"a":1}            ']) assert.equal(sniffImage(Buffer.from(bad)), null, bad)
})
await test('limiter and image cache', async () => {
  const lim = limiter(2); let active = 0, peak = 0
  await Promise.all(Array.from({ length: 6 }, () => lim(async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active-- })))
  assert.equal(peak, 2)
  const c = new ImageCache({ maxEntries: 2 })
  c.set('a', { body: Buffer.alloc(1) }); c.set('b', { body: Buffer.alloc(1) }); c.set('c', { body: Buffer.alloc(1) })
  assert.equal(c.get('a'), null); assert.ok(c.get('c'))
})

section('remote.js: server-side image fetch')
// A local origin stands in for the internet: the test lookup maps *.test names to 127.0.0.1
// (the real guard would refuse it, as tested above) and private.test to 10.0.0.1 (refused).
const seen = []
const origin = http.createServer((req, res) => {
  seen.push({ url: req.url, headers: req.headers })
  if (req.url === '/a.png') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(PNG); return }
  if (req.url === '/page.html') { res.writeHead(200, { 'content-type': 'image/png' }); res.end('<!doctype html><html><script>alert(1)</script></html>'); return }
  if (req.url === '/big.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.concat([PNG, Buffer.alloc(300 * 1024)])); return }
  if (req.url === '/to-private') { res.writeHead(302, { location: 'http://private.test:' + port + '/a.png' }); res.end(); return }
  if (req.url === '/to-good') { res.writeHead(301, { location: '/a.png' }); res.end(); return }
  if (req.url.startsWith('/loop')) { res.writeHead(302, { location: '/loop' + (Number(req.url.slice(5) || 0) + 1) }); res.end(); return }
  res.writeHead(404); res.end()
})
await new Promise(r => origin.listen(0, '127.0.0.1', r))
const port = origin.address().port
const testLookup = (hostname, options, cb) => {
  if (typeof options === 'function') { cb = options; options = {} }
  if (hostname === 'private.test') return cb(Object.assign(new Error('refused: private.test resolves to a private or reserved address'), { code: 'EBLOCKED' }))
  if (options && options.all) return cb(null, [{ address: '127.0.0.1', family: 4 }])
  return cb(null, '127.0.0.1', 4)
}
const o = extra => ({ lookup: testLookup, ports: [port], ...extra })
const base = 'http://img.test:' + port

await test('http image: https upgrade first; plain http only with allowHttp (never silently)', async () => {
  await assert.rejects(fetchRemoteImage(base + '/a.png', o()), /plain http is off/)
  const r = await fetchRemoteImage(base + '/a.png', o({ allowHttp: true }))
  assert.equal(r.contentType, 'image/png'); assert.ok(r.plain); assert.ok(r.body.equals(PNG))
})
await test('no cookie, no referrer, generic user agent reach the remote host', async () => {
  const h = seen.filter(x => x.url === '/a.png').pop().headers
  assert.equal(h.cookie, undefined); assert.equal(h.referer, undefined); assert.equal(h.authorization, undefined)
  assert.match(h['user-agent'], /dsh-mail image proxy/)
})
await test('type and size limits: HTML labelled image/png is refused, oversized is refused', async () => {
  await assert.rejects(fetchRemoteImage(base + '/page.html', o({ allowHttp: true })), e => e.status === 415)
  await assert.rejects(fetchRemoteImage(base + '/big.png', o({ allowHttp: true, maxBytes: 64 * 1024 })), e => e.status === 413)
})
await test('redirects: re-checked at every hop; private target refused; at most 3', async () => {
  const ok = await fetchRemoteImage(base + '/to-good', o({ allowHttp: true }))
  assert.equal(ok.contentType, 'image/png')
  await assert.rejects(fetchRemoteImage(base + '/to-private', o({ allowHttp: true })), e => e.status === 403)
  await assert.rejects(fetchRemoteImage(base + '/loop0', o({ allowHttp: true })), /too many redirects/)
  await assert.rejects(fetchRemoteImage('http://127.0.0.1:' + port + '/a.png', o({ allowHttp: true })), e => e.status === 403)
})
await new Promise(r => origin.close(r))

section('html.js: the browser never contacts a host named in a mail')
const RW = makeRewriter('s'.repeat(40), '/dsh-mail/api')
const MAIL = '<style>@import url(https://fonts.example/f.css);@font-face{font-family:x;src:url(https://fonts.example/x.woff2)} body{background:url("https://t.example/bg.png")}</style>' +
  '<p style="background-image:url(//cdn.example/a.png)">hi <a href="https://shop.example/a?b=1&c=2">shop</a> <a href="mailto:a@b.example">m</a></p>' +
  '<img src="http://track.example/p.gif" width="1" height="1"><img src="https://img.example/i.png"><img src="//cdn.example/p.png">'
const HOSTS = ['fonts.example', 't.example', 'cdn.example', 'shop.example', 'track.example', 'img.example']
const loadTargets = doc => [...doc.replace(/&quot;/g, '"').matchAll(/(?:\ssrc|\shref)="([^"]*)"|url\(\s*["']?([^"')]*)/g)].map(m => m[1] || m[2]).filter(Boolean)
const sameOriginOrInert = t => /^(\/dsh-mail\/api\/(img|link)\?|mailto:|data:image\/|none)/.test(t)
await test('blocked by default: no load target and no link names a remote host', () => {
  const { html, blocked } = sanitizeMailHtml(MAIL, { proxy: RW })
  assert.equal(blocked, 7)
  const doc = mailDocument(html)
  for (const t of loadTargets(doc)) assert.ok(sameOriginOrInert(t) && !t.startsWith('/dsh-mail/api/img'), 'direct target ' + t)
  for (const h of HOSTS) assert.ok(!new RegExp('\\s(src|href)="(https?:)?//' + h.replace('.', '\\.')).test(html), 'remote ' + h)
  assert.match(doc, /x-dns-prefetch-control" content="off"/)
  assert.ok(!/@import/.test(doc))
})
await test('Load images: every remote image and CSS image goes through the signed proxy, links through the link page', () => {
  const { html } = sanitizeMailHtml(MAIL, { images: true, proxy: RW })
  const doc = mailDocument(html, { images: true })
  const targets = loadTargets(doc)
  assert.ok(targets.length >= 6)
  for (const t of targets) assert.ok(sameOriginOrInert(t), 'unexpected target ' + t)
  assert.match(doc, /img-src data: cid: 'self';/)
  assert.ok(!/img-src[^;]*https?:/.test(doc))
  assert.match(html, /rel="noreferrer noopener"/)
})
await test('rewriteCss handles quotes, protocol-relative and data images', () => {
  const r = rewriteCss("a{b:url('https://x.example/a.png')} c{d:url(//y.example/b)} e{f:url(data:image/png;base64,AA)} g{h:url(/rel)}", u => '/p?u=' + encodeURIComponent(u))
  assert.equal(r.remote, 2)
  assert.ok(r.css.includes('url("/p?u=https%3A%2F%2Fx.example%2Fa.png")') && r.css.includes('url("/p?u=https%3A%2F%2Fy.example%2Fb")'))
  assert.ok(r.css.includes('url(data:image/png;base64,AA)') && r.css.includes('h:none'))
})
await test('plain-text mail: links go through the link page', () => {
  const h = textToHtml('see https://a.example/x?y=1&z=2 now', { link: RW.link })
  assert.match(h, /href="\/dsh-mail\/api\/link\?u=https%3A%2F%2Fa\.example%2Fx%3Fy%3D1%26z%3D2&amp;s=/)
  assert.match(h, /rel="noopener noreferrer"/)
})
await test('link page: escaped destination, http warning, no referrer, no scripts', () => {
  const p = linkPage('https://evil.example/"><script>alert(1)</script>')
  assert.ok(!p.includes('<script>'))
  assert.match(p, /rel="noopener noreferrer"/)
  assert.match(linkPage('http://plain.example/'), /plain http/)
  assert.match(linkPage('javascript:alert(1)'), /cannot be opened/)
  assert.equal(LINK_PAGE_HEADERS['referrer-policy'], 'no-referrer')
  assert.match(LINK_PAGE_HEADERS['content-security-policy'], /default-src 'none'/)
})

section('routes: /img and /link')
const dir = mkdtempSync(join(tmpdir(), 'dsh-mail-remote-'))
const pl = await bootPlugin({ dir, settings: {} })
await test('unsigned or forged URLs are refused; the gate refuses cross-site loads', async () => {
  assert.equal((await request(pl.port, 'GET', '/img?u=' + encodeURIComponent('https://a.example/x.png'))).status, 403)
  assert.equal((await request(pl.port, 'GET', '/img?u=' + encodeURIComponent('https://a.example/x.png') + '&s=' + 'A'.repeat(32))).status, 403)
  assert.equal((await request(pl.port, 'GET', '/link?u=' + encodeURIComponent('https://a.example/'))).status, 403)
  assert.equal((await request(pl.port, 'GET', '/img?u=x&s=y', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
})
await test('a signed URL to a private address is refused by the proxy (403), never fetched', async () => {
  const secret = (await import('node:fs')).readFileSync(join(dir, 'data', 'capability.secret'), 'utf8').trim()
  const rw = makeRewriter(secret, '')
  const r = await request(pl.port, 'GET', rw.img('http://127.0.0.1/dsh-mail/api/state'))
  assert.equal(r.status, 403)
  const l = await request(pl.port, 'GET', rw.link('https://shop.example/x'))
  assert.equal(l.status, 200); assert.equal(l.headers['referrer-policy'], 'no-referrer'); assert.match(l.text, /shop\.example/)
})
await pl.close()
rmSync(dir, { recursive: true, force: true })

section('transport: TLS everywhere, plaintext never silent')
await test('provider APIs: https only; plain http refused unless loopback (SSH-tunnelled relays keep working)', async () => {
  assert.ok(assertSecureApiUrl('https://api.lettermint.co/v1/send'))
  assert.ok(assertSecureApiUrl('http://127.0.0.1:8025/v1/send'))
  for (const u of ['http://api.lettermint.co/v1', 'http://192.168.10.5:8025/', 'ftp://x.example/']) assert.throws(() => assertSecureApiUrl(u), u)
  const lm = buildProvider('lettermint', { lettermintApiKey: 'k', lettermintBaseURL: 'http://relay.example/v1' })
  await assert.rejects(lm.send({}, { from: 'a@b.example', to: 'c@d.example', subject: 's', text: 't' }), /refused plain http/)
  for (const id of ['resend', 'sendgrid']) {
    const p = buildProvider(id, { resendApiKey: 'k', sendgridApiKey: 'k', resendBaseURL: 'http://x.example', sendgridBaseURL: 'http://x.example' })
    await assert.rejects(p.send({}, { from: 'a@b.example', to: 'c@d.example', subject: 's', text: 't' }), /refused plain http/, id)
  }
  // loopback relay (for example the SSH-tunnelled Lettermint relay on 127.0.0.1) still works
  const relay = http.createServer((req, res) => { res.writeHead(202, { 'content-type': 'application/json' }); res.end('{"message_id":"m1"}') })
  await new Promise(r => relay.listen(0, '127.0.0.1', r))
  const ok = await buildProvider('lettermint', { lettermintApiKey: 'k', lettermintBaseURL: 'http://127.0.0.1:' + relay.address().port + '/v1' }).send({}, { from: 'a@b.example', to: 'c@d.example', subject: 's', text: 't' })
  assert.equal(ok.messageId, 'm1')
  await new Promise(r => relay.close(r))
})
await test('Tzekos Mail agent API and Microsoft Graph refuse plain http to a remote host', async () => {
  await assert.rejects(agentCall({ baseUrl: 'http://mail.example', token: 't' }, 'accounts'), /refused plain http/)
  await assert.rejects(graphSendMime('http://graph.example/v1.0', 'tok', 'raw'), /refused plain http/)
})
await test('POP3: no USER/PASS on a plaintext socket to a remote host', async () => {
  const c = new Pop3Client({ host: 'pop.example', port: 110, security: 'none', user: 'u', pass: 'p' })
  await assert.rejects(c.connect(), /plaintext is only allowed to a loopback host/)
})
await test('legacy SMTP provider (smtpSecure false): STARTTLS is required, no AUTH in clear to a non-loopback host', async () => {
  const lan = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)
  if (!lan) { console.log('  SKIP no non-loopback IPv4 address on this host'); return }
  const { SMTPServer } = await import('smtp-server')
  let authSeen = false
  const srv = new SMTPServer({ disabledCommands: ['STARTTLS'], authOptional: true, onAuth(a, s, cb) { authSeen = true; cb(null, { user: 'u' }) }, onData(st, s, cb) { st.resume(); st.on('end', cb) } })
  await new Promise(r => srv.listen(0, lan.address, r))
  const p = buildProvider('smtp', { smtpHost: lan.address, smtpPort: srv.server.address().port, smtpSecure: false, smtpUser: 'u', smtpPass: 'p' })
  await assert.rejects(p.send({}, { from: 'a@b.example', to: 'c@d.example', subject: 's', text: 't' }), /STARTTLS|TLS/i)
  assert.equal(authSeen, false, 'credentials never reached a plaintext socket')
  await new Promise(r => srv.close(r))
})
