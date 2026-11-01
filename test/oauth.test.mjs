/**
 * dsh-mail tests: OAuth2 (phase 2) against mocked provider endpoints.
 *
 * A local mock plays the Google / Microsoft token, revoke, device code and
 * Graph endpoints (accounts point at it through their per-account endpoint
 * overrides). IMAP runs on hoodiecrow with AUTH=XOAUTH2 + SASL-IR, SMTP on
 * smtp-server with XOAUTH2 only; the Microsoft SMTP refuses SMTP AUTH like a
 * tenant with SmtpClientAuthentication disabled, so mail must go through the
 * Graph sendMail fallback.
 */
import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'
import net from 'node:net'

import { test, section } from './harness.mjs'
import { bootPlugin, request, mutate, cookieFor } from './helpers.mjs'
import { FlowStore, xoauth2String, cookieFingerprint, exchangeCode, providerConfig, redirectUriFor, STATE_TTL_MS } from '../lib/oauth.js'
import { normalizeAccount, validateAccount } from '../lib/accounts.js'

const require = createRequire(import.meta.url)
const hoodiecrow = require('hoodiecrow-imap')
const { SMTPServer } = require('smtp-server')
const { simpleParser } = require('mailparser')

function freePort() { return new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) }) }
const b64url = b => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')

section('oauth.js: unit')
await test('state: valid once, then replay, tamper, expiry and other-browser are refused', () => {
  const fs = new FlowStore(() => 'k'.repeat(40))
  const { state } = fs.begin({ accountId: 'gm', cookieFp: 'fp1', redirectUri: 'https://h/cb' })
  assert.equal(fs.consume(state, { cookieFp: 'fp1' }).accountId, 'gm')
  assert.throws(() => fs.consume(state, { cookieFp: 'fp1' }), e => e.code === 'replayed_state')
  const b = fs.begin({ accountId: 'gm', cookieFp: 'fp1', redirectUri: 'x' })
  const [body, sig] = b.state.split('.')
  const forged = b64url(Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), a: 'other' }))) + '.' + sig
  assert.throws(() => fs.consume(forged, { cookieFp: 'fp1' }), e => e.code === 'bad_state')
  assert.throws(() => fs.consume(b.state, { cookieFp: 'fp-other' }), /another browser/)
  const c = fs.begin({ accountId: 'gm', cookieFp: 'fp1', redirectUri: 'x' })
  assert.throws(() => fs.consume(c.state, { cookieFp: 'fp1', now: Date.now() + STATE_TTL_MS + 1000 }), e => e.code === 'expired_state')
  const other = new FlowStore(() => 'z'.repeat(40))
  const d = fs.begin({ accountId: 'gm', cookieFp: 'fp1', redirectUri: 'x' })
  assert.throws(() => other.consume(d.state, { cookieFp: 'fp1' }), /signature/)
})
await test('PKCE is S256 of the verifier; XOAUTH2 SASL string; cookie fingerprint', () => {
  const fs = new FlowStore(() => 'k'.repeat(40))
  const { pkce } = fs.begin({ accountId: 'a', cookieFp: 'f', redirectUri: 'x' })
  assert.equal(pkce.method, 'S256')
  assert.equal(pkce.challenge, b64url(createHash('sha256').update(pkce.verifier).digest()))
  assert.ok(pkce.verifier.length >= 43)
  assert.equal(Buffer.from(xoauth2String('me@example.org', 'tok'), 'base64').toString(), 'user=me@example.org\x01auth=Bearer tok\x01\x01')
  assert.equal(cookieFingerprint('a=1; dsh-auth-x=secret', 'dsh-auth-x').length, 22)
  assert.equal(cookieFingerprint('a=1', 'dsh-auth-x'), '')
})
await test('provider config: Google and Microsoft scopes, tenant, redirect URI', () => {
  const g = providerConfig(normalizeAccount({ id: 'g1', type: 'google', auth: { method: 'oauth2' }, oauth: { clientId: 'c' } }))
  assert.deepEqual(g.authorizeScopes, ['https://mail.google.com/']); assert.equal(g.extra.access_type, 'offline')
  const m = providerConfig(normalizeAccount({ id: 'm1', type: 'microsoft', oauth: { clientId: 'c', tenant: 'contoso.example' } }))
  assert.ok(m.tokenUrl.includes('/contoso.example/oauth2/v2.0/token'))
  for (const s of ['offline_access', 'https://outlook.office.com/IMAP.AccessAsUser.All', 'https://outlook.office.com/SMTP.Send', 'https://graph.microsoft.com/Mail.Send']) assert.ok(m.authorizeScopes.includes(s), s)
  assert.deepEqual(m.scopes.graph, ['offline_access', 'https://graph.microsoft.com/Mail.Send'])
  assert.equal(redirectUriFor({ headers: { host: 'dsh.example.org' } }, {}), 'https://dsh.example.org/dsh-mail/api/oauth/callback')
  assert.equal(redirectUriFor({ headers: { host: '127.0.0.1:3080' } }, {}), 'http://127.0.0.1:3080/dsh-mail/api/oauth/callback')
  assert.equal(redirectUriFor({ headers: { host: 'x' } }, { oauth: { redirectBaseUrl: 'https://pub.example.org/' } }), 'https://pub.example.org/dsh-mail/api/oauth/callback')
})
await test('validation: Microsoft refuses passwords, OAuth needs a client id, endpoints must be https', () => {
  const ms = normalizeAccount({ id: 'ms', type: 'microsoft' })
  assert.equal(ms.receive.host, 'outlook.office365.com'); assert.equal(ms.send.port, 587); assert.equal(ms.auth.method, 'oauth2')
  assert.ok(validateAccount(ms).some(e => e.includes('client id')))
  const bad = normalizeAccount({ id: 'g2', type: 'google', auth: { method: 'oauth2' }, oauth: { clientId: 'c', tokenUrl: 'http://evil.example/token' } })
  assert.ok(validateAccount(bad).some(e => e.includes('https')))
  assert.equal(validateAccount(normalizeAccount({ id: 'g3', type: 'google', auth: { method: 'oauth2' }, oauth: { clientId: 'c' } })).length, 0)
})

// ── mock provider ───────────────────────────────────────────────────────────
const mock = { codes: new Map(), refreshCalls: 0, revoked: new Set(), revokeCalls: [], deviceCalls: 0, graphMail: [], exchanges: 0 }
const mockPort = await freePort()
const M = 'http://127.0.0.1:' + mockPort
const mockServer = http.createServer((req, res) => {
  let data = ''
  req.on('data', c => { data += c })
  req.on('end', () => {
    const json = (status, o, delay = 0) => setTimeout(() => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }, delay)
    const f = Object.fromEntries(new URLSearchParams(data))
    if (req.url === '/token') {
      if (f.grant_type === 'authorization_code') {
        const c = mock.codes.get(f.code)
        mock.codes.delete(f.code)
        if (!c || c.clientId !== f.client_id || c.redirectUri !== f.redirect_uri) return json(400, { error: 'invalid_grant', error_description: 'bad code' })
        if (b64url(createHash('sha256').update(f.code_verifier || '').digest()) !== c.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' })
        mock.exchanges++
        return json(200, { access_token: 'testtoken', refresh_token: 'rt-canary-' + f.client_id, expires_in: 3600, token_type: 'Bearer' })
      }
      if (f.grant_type === 'refresh_token') {
        if (mock.revoked.has(f.refresh_token)) return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })
        mock.refreshCalls++
        return json(200, { access_token: /graph/.test(f.scope || '') ? 'graph-token-xyz' : 'testtoken', expires_in: 3600 }, 150)
      }
      if (f.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
        mock.deviceCalls++
        if (mock.deviceCalls < 2) return json(400, { error: 'authorization_pending' })
        return json(200, { access_token: 'testtoken', refresh_token: 'rt-canary-device', expires_in: 3600 })
      }
    }
    if (req.url === '/revoke') { mock.revokeCalls.push(f.token); return json(200, {}) }
    if (req.url === '/devicecode') return json(200, { device_code: 'dc-1', user_code: 'ABCD-EFGH', verification_uri: 'https://microsoft.com/devicelogin', interval: 1, expires_in: 60 })
    if (req.url === '/graph/me/sendMail') {
      if (req.headers.authorization !== 'Bearer graph-token-xyz') return json(401, { error: { code: 'InvalidAuthenticationToken', message: 'bad' } })
      mock.graphMail.push(Buffer.from(data, 'base64'))
      res.writeHead(202); return res.end()
    }
    json(404, { error: 'not_found' })
  })
})
await new Promise(r => mockServer.listen(mockPort, '127.0.0.1', r))

// ── IMAP (XOAUTH2) + two SMTP servers ───────────────────────────────────────
const imapPort = await freePort()
const imap = hoodiecrow({ plugins: ['XOAUTH2', 'SASL-IR', 'SPECIAL-USE', 'MOVE', 'UIDPLUS', 'ENABLE'], storage: { INBOX: { messages: [{ raw: 'From: a@example.org\r\nTo: testuser@example.org\r\nSubject: Hello over XOAUTH2\r\nMessage-ID: <x1@example.org>\r\n\r\nbody\r\n' }] }, '': { separator: '/', folders: { Sent: { 'special-use': '\\Sent' }, Trash: { 'special-use': '\\Trash' } } } } })
await new Promise(r => imap.listen(imapPort, '127.0.0.1', r))
const creds = imap.getCredentials()
const smtpGot = []
const smtpAuth = []
const smtpPort = await freePort()
const smtpOk = new SMTPServer({ key: creds.key, cert: creds.cert, authMethods: ['XOAUTH2'], logger: false,
  onAuth(auth, _s, cb) { smtpAuth.push(auth.method); if (auth.method === 'XOAUTH2' && auth.accessToken === 'testtoken' && auth.username === 'testuser') return cb(null, { user: auth.username }); cb(new Error('bad token')) },
  onData(stream, _s, cb) { const ch = []; stream.on('data', c => ch.push(c)); stream.on('end', () => { smtpGot.push(Buffer.concat(ch)); cb() }) } })
await new Promise(r => smtpOk.listen(smtpPort, '127.0.0.1', r))
const msSmtpPort = await freePort()
const smtpMs = new SMTPServer({ key: creds.key, cert: creds.cert, authMethods: ['XOAUTH2'], logger: false,
  onAuth(_a, _s, cb) { const e = new Error('5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Tenant.'); e.responseCode = 535; cb(e) },
  onData(stream, _s, cb) { stream.resume(); stream.on('end', () => cb()) } })
await new Promise(r => smtpMs.listen(msSmtpPort, '127.0.0.1', r))

const endpoints = { authorizeUrl: M + '/authorize', tokenUrl: M + '/token', revokeUrl: M + '/revoke', deviceUrl: M + '/devicecode', graphUrl: M + '/graph' }
const gm = {
  id: 'gm', type: 'google', label: 'Gmail OAuth', address: 'testuser@example.org', auth: { method: 'oauth2', user: 'testuser' },
  receive: { protocol: 'imap', host: '127.0.0.1', port: imapPort, security: 'none' }, send: { protocol: 'smtp', host: '127.0.0.1', port: smtpPort, security: 'starttls' },
  allowSelfSigned: true, oauth: { clientId: 'cid-google', ...endpoints }, secrets: { oauthClientSecret: 'client-secret-canary-1' }, agent: { allow: true, default: true },
}
const ms = {
  id: 'ms', type: 'microsoft', label: 'Outlook OAuth', address: 'testuser@example.org', auth: { method: 'oauth2', user: 'testuser' },
  receive: { protocol: 'imap', host: '127.0.0.1', port: imapPort, security: 'none' }, send: { protocol: 'smtp', host: '127.0.0.1', port: msSmtpPort, security: 'starttls' },
  allowSelfSigned: true, oauth: { clientId: 'cid-ms', tenant: 'common', sendMode: 'auto', ...endpoints }, agent: { allow: true },
}
const dir = mkdtempSync(join(tmpdir(), 'dsh-mail-oauth-'))
section('oauth: end to end with mocked endpoints')
const p = await bootPlugin({ dir, settings: { accounts: [gm, ms], agents: { confirmMode: 'reply-only' } } })
const CANARIES = ['rt-canary', 'testtoken', 'graph-token-xyz', 'client-secret-canary-1']
const noCanary = (label, text) => { for (const c of CANARIES) assert.ok(!text.includes(c), label + ' leaks ' + c) }

let started
await test('start: authorization URL with PKCE S256, signed state, exact redirect URI', async () => {
  const r = await mutate(p.port, '/oauth/start', { account: 'gm' })
  assert.equal(r.status, 200, r.text)
  const u = new URL(r.json.url)
  assert.equal(u.origin + u.pathname, M + '/authorize')
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(u.searchParams.get('scope'), 'https://mail.google.com/')
  assert.equal(u.searchParams.get('access_type'), 'offline'); assert.equal(u.searchParams.get('prompt'), 'consent')
  assert.equal(u.searchParams.get('redirect_uri'), 'http://127.0.0.1:' + p.port + '/dsh-mail/api/oauth/callback')
  assert.equal(u.searchParams.get('login_hint'), 'testuser@example.org')
  started = u
  const ru = (await request(p.port, 'GET', '/oauth/redirect-uri')).json
  assert.equal(ru.redirectUri, u.searchParams.get('redirect_uri'))
})
await test('callback page: allowed after a cross-site redirect, strict CSP, no referrer; foreign Host refused', async () => {
  const r = await request(p.port, 'GET', '/oauth/callback?code=abc&state=xyz', { headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(r.status, 200)
  assert.match(r.headers['content-security-policy'], /script-src 'nonce-/)
  assert.equal(r.headers['referrer-policy'], 'no-referrer')
  assert.ok(!r.text.includes('abc') && !r.text.includes('xyz'), 'the page does not echo code or state')
  assert.equal((await request(p.port, 'GET', '/oauth/callback?code=a', { headers: { host: 'evil.example' } })).status, 403)
})
await test('complete: wrong PKCE verifier is refused by the provider; correct one stores encrypted tokens', async () => {
  const state = started.searchParams.get('state')
  // a code registered with a different challenge: the provider refuses the verifier
  mock.codes.set('code-wrong', { challenge: 'not-the-challenge', clientId: 'cid-google', redirectUri: started.searchParams.get('redirect_uri') })
  const bad = await mutate(p.port, '/oauth/complete', { code: 'code-wrong', state })
  assert.equal(bad.json.ok, false); assert.match(bad.json.error, /PKCE/)
  // the state was consumed by that attempt: start again
  const again = new URL((await mutate(p.port, '/oauth/start', { account: 'gm' })).json.url)
  mock.codes.set('code-1', { challenge: again.searchParams.get('code_challenge'), clientId: 'cid-google', redirectUri: again.searchParams.get('redirect_uri') })
  const ok = await mutate(p.port, '/oauth/complete', { code: 'code-1', state: again.searchParams.get('state') })
  assert.equal(ok.json.ok, true, ok.text); assert.equal(ok.json.account, 'gm')
  noCanary('/oauth/complete', ok.text)
  const replay = await mutate(p.port, '/oauth/complete', { code: 'code-1', state: again.searchParams.get('state') })
  assert.equal(replay.json.ok, false); assert.equal(replay.json.oauthCode, 'replayed_state'); assert.equal(replay.json.code, 'MAIL_OAUTH_FLOW_FAILED')
  const enc = join(dir, 'data', 'tokens.enc')
  assert.equal(statSync(enc).mode & 0o777, 0o600)
  const raw = readFileSync(enc, 'utf8')
  assert.ok(!raw.includes('rt-canary') && !raw.includes('testtoken'), 'tokens.enc is not plaintext')
  assert.equal(JSON.parse(raw).alg, 'aes-256-gcm')
})
await test('complete from another browser session (different harness cookie) is refused', async () => {
  const u = new URL((await mutate(p.port, '/oauth/start', { account: 'gm' })).json.url)
  const tok = (await request(p.port, 'GET', '/session')).json.token
  const host = '127.0.0.1:' + p.port
  const r = await request(p.port, 'POST', '/oauth/complete', { body: { code: 'x', state: u.searchParams.get('state') }, headers: { origin: 'http://' + host, 'sec-fetch-site': 'same-origin', 'x-dsh-mail-token': tok, cookie: cookieFor(host).replace('=1', '=another-session') } })
  assert.equal(r.json.ok, false); assert.match(r.json.error, /another browser/)
})
await test('no token or client secret in any read response', async () => {
  for (const path of ['/state', '/accounts', '/oauth/status?account=gm', '/oauth/redirect-uri']) noCanary(path, (await request(p.port, 'GET', path)).text)
  const st = (await request(p.port, 'GET', '/state')).json
  assert.deepEqual([st.accounts.find(a => a.id === 'gm').oauth.connected, st.accounts.find(a => a.id === 'gm').oauth.needsReauth], [true, false])
})
await test('IMAP over XOAUTH2 (hoodiecrow AUTH=XOAUTH2) and SMTP over XOAUTH2', async () => {
  const r = (await request(p.port, 'GET', '/messages?account=gm')).json
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors)); assert.equal(r.rows[0].subject, 'Hello over XOAUTH2')
  const s = await p.tools.get('mail_send').execute({ account: 'gm', to: 'friend@example.org', subject: 'Sent with XOAUTH2', text: 'hi' })
  assert.equal(s.ok, true, s.error)
  assert.ok(smtpAuth.includes('XOAUTH2'))
  assert.equal((await simpleParser(smtpGot[smtpGot.length - 1])).subject, 'Sent with XOAUTH2')
  const t = await mutate(p.port, '/accounts/test', { id: 'gm' })
  assert.equal(t.json.result.ok, true, JSON.stringify(t.json.result.steps))
})
await test('refresh 120 s before expiry, single-flight for concurrent callers', async () => {
  const e = p.tokens.store.get('gm')
  e.access.mail.expiresAt = Date.now() + 60 * 1000
  p.tokens.store.set('gm', e)
  const before = mock.refreshCalls
  const acc = p.resolved().all.find(a => a.id === 'gm')
  const toks = await Promise.all([1, 2, 3, 4, 5].map(() => p.tokens.accessToken(acc)))
  assert.equal(mock.refreshCalls - before, 1)
  assert.ok(toks.every(x => x === 'testtoken'))
  assert.ok(p.tokens.store.get('gm').access.mail.expiresAt > Date.now() + 3000 * 1000)
  const again = await p.tokens.accessToken(acc)
  assert.equal(again, 'testtoken'); assert.equal(mock.refreshCalls - before, 1, 'a fresh token is reused')
})
await test('revoked refresh token: invalid_grant flips needsReauth with the "In production" hint', async () => {
  mock.revoked.add('rt-canary-cid-google')
  const e = p.tokens.store.get('gm'); e.access = {}; p.tokens.store.set('gm', e)
  const acc = p.resolved().all.find(a => a.id === 'gm')
  await assert.rejects(p.tokens.accessToken(acc), err => err.code === 'invalid_grant' && /In production/.test(err.message))
  const st = (await request(p.port, 'GET', '/state')).json.accounts.find(a => a.id === 'gm')
  assert.equal(st.oauth.needsReauth, true); assert.equal(st.oauth.connected, false)
  await assert.rejects(p.tokens.accessToken(acc), err => err.code === 'needs_reauth')
})
await test('Microsoft device code flow connects; SMTP AUTH disabled falls back to Graph sendMail', async () => {
  const d = await mutate(p.port, '/oauth/device/start', { account: 'ms' })
  assert.equal(d.json.userCode, 'ABCD-EFGH')
  let s
  for (let i = 0; i < 40; i++) { s = (await request(p.port, 'GET', '/oauth/status?account=ms')).json.status; if (s.connected) break; await new Promise(r => setTimeout(r, 250)) }
  assert.equal(s.connected, true, JSON.stringify(s))
  const r = await p.tools.get('mail_send').execute({ account: 'ms', to: 'friend@example.org', subject: 'Through Graph', text: 'hello' })
  assert.equal(r.ok, true, r.error)
  assert.equal(mock.graphMail.length, 1)
  const parsed = await simpleParser(mock.graphMail[0])
  assert.equal(parsed.subject, 'Through Graph'); assert.equal(parsed.to.text, 'friend@example.org')
  const t = await mutate(p.port, '/accounts/test', { id: 'ms' })
  assert.equal(t.json.result.ok, true, JSON.stringify(t.json.result.steps))
  assert.ok(t.json.result.steps.some(x => /Graph/.test(x.detail)))
})
await test('revoke: Google endpoint called with the refresh token and local tokens deleted', async () => {
  mock.revoked.delete('rt-canary-cid-google')
  const u = new URL((await mutate(p.port, '/oauth/start', { account: 'gm' })).json.url)
  mock.codes.set('code-2', { challenge: u.searchParams.get('code_challenge'), clientId: 'cid-google', redirectUri: u.searchParams.get('redirect_uri') })
  assert.equal((await mutate(p.port, '/oauth/complete', { code: 'code-2', state: u.searchParams.get('state') })).json.ok, true)
  assert.equal(p.tokens.status('gm').connected, true, 'reconnect clears needsReauth')
  const r = await mutate(p.port, '/oauth/revoke', { account: 'gm' })
  assert.equal(r.json.revoked, true)
  assert.deepEqual(mock.revokeCalls, ['rt-canary-cid-google'])
  assert.equal(p.tokens.status('gm').connected, false)
  const m = await mutate(p.port, '/oauth/revoke', { account: 'ms' })
  assert.equal(m.json.revoked, false); assert.match(m.json.note, /no token revocation endpoint/)
})
await test('unit: exchangeCode surfaces provider errors without tokens', async () => {
  const acc = normalizeAccount({ id: 'g9', type: 'google', auth: { method: 'oauth2' }, oauth: { clientId: 'nobody', tokenUrl: M + '/token' } })
  await assert.rejects(exchangeCode(acc, { code: 'nope', verifier: 'v', redirectUri: 'r' }), e => e.code === 'invalid_grant')
})

await p.close()
await new Promise(r => smtpOk.close(r))
await new Promise(r => smtpMs.close(r))
await new Promise(r => imap.close(r))
await new Promise(r => mockServer.close(r))
rmSync(dir, { recursive: true, force: true })
