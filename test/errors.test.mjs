/**
 * dsh-mail tests: the error catalog (lib/errors.js), docs/ERRORS.md in sync,
 * the { ok:false, error, code, message, hint, docs } shape on routes and
 * tools, and the classification of the error texts the plugin produces.
 */
import { strict as assert } from 'node:assert'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { test, section } from './harness.mjs'
import { bootPlugin, request, mutate } from './helpers.mjs'
import { E, classify, gateCode, genericScrub } from '../lib/errors.js'
import { runMassSend } from '../lib/outbound.js'

section('errors: catalog and docs')
await test('every catalog code is documented in docs/ERRORS.md (table row and heading)', () => {
  assert.deepEqual(E.missingFromDoc(readFileSync(new URL('../docs/ERRORS.md', import.meta.url), 'utf8')), [])
  assert.ok(E.has('MAIL_INTERNAL'))
})
await test('docs/ERRORS.md and TROUBLESHOOTING.md carry no em or en dash and every Related codes entry is a catalog code', () => {
  for (const f of ['ERRORS.md', 'TROUBLESHOOTING.md']) {
    const t = readFileSync(new URL('../docs/' + f, import.meta.url), 'utf8')
    assert.ok(!/[\u2013\u2014]/.test(t), f)
    for (const m of t.matchAll(/`(MAIL_[A-Z_]+)`/g)) assert.ok(E.has(m[1]), f + ' mentions unknown code ' + m[1])
  }
})
await test('messages and hints stay free of dashes; scrubber hides credentials in URLs and bearer tokens', () => {
  for (const [c, d] of Object.entries(E.codes)) assert.ok(!/[\u2013\u2014]/.test(d.message + d.hint), c)
  assert.equal(genericScrub('GET https://user:hunter2@example.com/x'), 'GET https://***@example.com/x')
  assert.ok(!genericScrub('Authorization: Bearer abcdefghijklmnopqrstuvwxyz').includes('abcdefgh'))
  assert.equal(E.tool('MAIL_ROUTE_NOT_FOUND').error, 'not found')
  assert.equal(E.tool('MAIL_AGENT_DENIED', { message: 'account x not permitted for agents' }).error, 'account x not permitted for agents')
})

section('errors: classification of the texts the plugin produces')
await test('infrastructure and guard-rail texts map to their codes', () => {
  const c = (m, extra = {}) => classify(Object.assign(new Error(m), extra), 'MAIL_INTERNAL').code
  assert.equal(c('account work not permitted for agents (send)'), 'MAIL_AGENT_DENIED')
  assert.equal(c('account work is disabled'), 'MAIL_ACCOUNT_DISABLED')
  assert.equal(c('too many recipients: 600 > 500'), 'MAIL_TOO_MANY_RECIPIENTS')
  assert.equal(c('Invalid credentials (Failure)'), 'MAIL_ACCOUNT_AUTH_FAILED')
  assert.equal(c('x', { authenticationFailed: true }), 'MAIL_ACCOUNT_AUTH_FAILED')
  assert.equal(c('connect ECONNREFUSED 127.0.0.1:993'), 'MAIL_CONNECT_FAILED')
  assert.equal(c('self-signed certificate in certificate chain'), 'MAIL_CONNECT_FAILED')
  assert.equal(c('message is larger than 25 MB'), 'MAIL_SIZE_LIMIT')
  assert.equal(c('provider foo is not configured'), 'MAIL_ACCOUNT_NOT_FOUND')
  assert.equal(c('unknown account: foo'), 'MAIL_ACCOUNT_NOT_FOUND')
  assert.equal(c('account a has no server folders'), 'MAIL_CAPABILITY_UNSUPPORTED')
  assert.equal(c('no queue entry q1'), 'MAIL_OBJECT_NOT_FOUND')
  assert.equal(c('entry q1 was already sent; cannot cancel'), 'MAIL_QUEUE_CONFLICT')
  assert.equal(c('the queue already holds 200 pending emails; cancel some first'), 'MAIL_STORE_FULL')
  assert.equal(c('invalid recipient: x'), 'MAIL_INVALID_INPUT')
  assert.equal(c('something unexpected'), 'MAIL_INTERNAL')
  assert.equal(c('rate limit: a allows 20 messages per minute', { code: 'rate_limit', retryAfterSec: 7 }), 'MAIL_RATE_LIMITED')
  assert.equal(classify(Object.assign(new Error('x'), { code: 'rate_limit', retryAfterSec: 7 })).extra.retryAfterSec, 7)
  assert.equal(c('x', { code: 'needs_reauth' }), 'MAIL_OAUTH_REAUTH')
  assert.equal(c('x', { code: 'invalid_grant' }), 'MAIL_OAUTH_REAUTH')
  assert.equal(c('x', { code: 'replayed_state' }), 'MAIL_OAUTH_FLOW_FAILED')
  assert.equal(c('google: invalid_grant. The authorization code was refused (expired)', { code: 'invalid_grant' }), 'MAIL_OAUTH_FLOW_FAILED')
  assert.equal(c('set the client id of your OAuth app first', { code: 'oauth_error' }), 'MAIL_OAUTH_NOT_CONFIGURED')
  assert.equal(gateCode({ layer: 'L3', reason: 'capability token: expired' }), 'MAIL_TOKEN_INVALID')
  assert.equal(gateCode({ layer: 'L4', reason: 'no harness browser-session cookie' }), 'MAIL_SESSION_COOKIE_MISSING')
  assert.equal(gateCode({ status: 403, reason: 'non-loopback peer' }), 'MAIL_REQUEST_FORBIDDEN')
})
await test('the real mass-send guard rail text maps to MAIL_UNSUBSCRIBE_REQUIRED', async () => {
  const acc = { id: 'x', type: 'imap-smtp', limits: { perMinute: 0, perDay: 0, maxRecipients: 500 } }
  const rows = Array.from({ length: 60 }, (_, i) => ({ email: 'u' + i + '@example.com' }))
  const d = { settings: { mass: { unsubscribeAbove: 50 }, maxDelayMs: 100, minDelayMs: 0 }, canSetHeaders: true, unsub: null, service: {}, suppression: { has: () => false } }
  await assert.rejects(runMassSend(acc, { rows, subjectTemplate: 's', textTemplate: 't' }, d), e => classify(e).code === 'MAIL_UNSUBSCRIBE_REQUIRED')
  await assert.rejects(runMassSend(acc, { rows, subjectTemplate: 's', textTemplate: 't' }, { ...d, canSetHeaders: false }), e => classify(e).code === 'MAIL_UNSUBSCRIBE_REQUIRED')
})

section('errors: shape on routes and tools')
const dir = mkdtempSync(join(tmpdir(), 'dsh-mail-errors-'))
const p = await bootPlugin({ dir, settings: { accounts: [{ id: 'box', type: 'imap-smtp', address: 'me@example.com', receive: { protocol: 'imap', host: '127.0.0.1', port: 1, security: 'none' }, send: { protocol: 'smtp', host: '127.0.0.1', port: 1, security: 'none' }, agent: { allow: false } }] } })
const shape = b => { assert.equal(b.ok, false); for (const k of ['error', 'code', 'message', 'hint', 'docs']) assert.equal(typeof b[k], 'string', k); assert.ok(b.code.startsWith('MAIL_')); assert.ok(E.has(b.code)); assert.ok(b.docs.endsWith('#' + b.code.toLowerCase())) }
await test('routes: unknown path, wrong method, gate layers and validation keep status and old text, add code and docs', async () => {
  let r = await request(p.port, 'GET', '/nope')
  assert.equal(r.status, 404); assert.equal(r.json.error, 'not found'); assert.equal(r.json.code, 'MAIL_ROUTE_NOT_FOUND'); shape(r.json)
  assert.equal(r.headers['cache-control'], 'no-store')
  r = await request(p.port, 'DELETE', '/state')
  assert.equal(r.status, 405); assert.equal(r.json.error, 'method not allowed'); assert.equal(r.json.code, 'MAIL_METHOD_NOT_ALLOWED')
  r = await request(p.port, 'POST', '/send', { body: {}, headers: { host: '127.0.0.1:' + p.port } })
  assert.equal(r.status, 403); shape(r.json); assert.equal(r.json.layer, 'L2')
  r = await mutate(p.port, '/send', { account: 'ghost', to: 'a@example.com' })
  assert.equal(r.status, 400); assert.equal(r.json.error, 'provider ghost is not configured'); assert.equal(r.json.code, 'MAIL_ACCOUNT_NOT_FOUND'); shape(r.json)
  r = await mutate(p.port, '/accounts/convert', {})
  assert.equal(r.status, 400); assert.equal(r.json.error, 'confirm: true required'); assert.equal(r.json.code, 'MAIL_CONFIRM_REQUIRED')
  r = await mutate(p.port, '/queue/cancel', { id: 'q-missing' })
  assert.equal(r.status, 400); shape(r.json)
  r = await mutate(p.port, '/drafts/send', { id: 'dr-missing' })
  assert.ok(r.status === 404 || r.status === 400); shape(r.json)
  r = await mutate(p.port, '/outbox/cancel', { id: 'nope' })
  assert.equal(r.status, 404); assert.equal(r.json.error, 'already sent or unknown'); assert.equal(r.json.code, 'MAIL_OUTBOX_GONE')
})
await test('routes: a token problem is MAIL_TOKEN_INVALID (403) and keeps the layer', async () => {
  const host = '127.0.0.1:' + p.port
  const r = await request(p.port, 'POST', '/send', { body: {}, headers: { origin: 'http://' + host, 'sec-fetch-site': 'same-origin', 'x-dsh-mail-token': 'bad' } })
  assert.equal(r.status, 403); assert.equal(r.json.code, 'MAIL_TOKEN_INVALID'); assert.equal(r.json.layer, 'L3'); assert.match(r.json.error, /capability token/)
})
await test('tools: failed results carry code, hint and docs next to the old error text; success is unchanged', async () => {
  const T = n => p.tools.get(n)
  let r = await T('mail_send').execute({ account: 'box', to: 'a@example.com', subject: 's', text: 't' })
  assert.equal(r.ok, false); assert.equal(r.error, 'account box not permitted for agents'); assert.equal(r.code, 'MAIL_AGENT_DENIED'); shape(r)
  r = await T('mail_send').execute({ account: 'ghost', to: 'a@example.com' })
  assert.equal(r.error, 'provider ghost is not configured'); assert.equal(r.code, 'MAIL_ACCOUNT_NOT_FOUND')
  r = await T('mail_cancel').execute({ id: 'q-missing' })
  assert.equal(r.ok, false); shape(r)
  r = await T('mail_draft').execute({ action: 'get', draftId: 'dr-nothing' })
  assert.equal(r.code, 'MAIL_OBJECT_NOT_FOUND'); assert.equal(r.error, 'no draft dr-nothing')
  r = await T('mail_draft').execute({ action: 'bogus' })
  assert.equal(r.code, 'MAIL_INVALID_INPUT'); assert.equal(r.error, 'action must be create, update, list, get or delete')
  r = await T('mail_read').execute({ account: 'box' })
  assert.equal(r.ok, false); assert.equal(r.code, 'MAIL_AGENT_DENIED'); assert.deepEqual(r.messages, []); assert.equal(r.count, 0)
  r = await T('mail_inbox').execute({ account: 'box' })
  assert.equal(r.ok, false); assert.equal(r.code, 'MAIL_AGENT_DENIED'); assert.match(r.text, /Could not read the inbox/)
  r = await T('mail_list_queue').execute({})
  assert.equal(r.ok, true); assert.ok(!('code' in r))
})
await test('tools: every output schema declares the structured error fields (strict schemas would reject them otherwise)', () => {
  assert.ok(p.tools.size >= 15)
  for (const [name, t] of p.tools) {
    const props = t.output && t.output.schema && t.output.schema.properties
    assert.ok(props, name)
    for (const k of ['code', 'hint', 'docs', 'message']) assert.ok(k in props, name + ' lacks ' + k)
    if (name !== 'mail_fetch') assert.equal(props.message.type, 'string', name)
  }
})
await p.close()
rmSync(dir, { recursive: true, force: true })
