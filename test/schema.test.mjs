/**
 * Output schemas must describe what the tools really return. DSH validates every tool result against the
 * declared schema (additionalProperties: false) AFTER the tool ran, so an undeclared key turns a delivered mail
 * into a reported failure and invites a duplicate send (issue #1: mail_reply "sent", mail_forward "account").
 *
 * test/helpers.mjs validates EVERY result of EVERY tool call made by the whole suite (success, draft and error
 * paths) with test/schema-check.mjs; this file adds the contract checks and a sweep of all tools.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test, section } from './harness.mjs'
import { bootPlugin } from './helpers.mjs'
import { schemaProblems } from './schema-check.mjs'
import { E, toolFail } from '../lib/errors.js'

const SCHEMA = { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, text: { type: 'string' }, n: { type: 'integer' } } }

section('output schemas')
await test('the checker rejects undeclared keys, wrong types and missing required keys', () => {
  assert.deepEqual(schemaProblems(SCHEMA, { ok: true, text: 'x', n: 2 }), [])
  assert.match(schemaProblems(SCHEMA, { ok: true, sent: true })[0], /value\.sent is not a declared property/)
  assert.match(schemaProblems(SCHEMA, { ok: 'yes' })[0], /should be boolean/)
  assert.match(schemaProblems(SCHEMA, { text: 'x' })[0], /ok is required/)
  assert.match(schemaProblems(SCHEMA, { ok: true, n: 1.5 })[0], /should be integer/)
})

const accounts = [{ id: 'box', type: 'imap-smtp', address: 'me@example.com', receive: { protocol: 'imap', host: '127.0.0.1', port: 1, security: 'none' }, send: { protocol: 'smtp', host: '127.0.0.1', port: 1, security: 'none' } }]
const dir = mkdtempSync(join(tmpdir(), 'dsh-mail-schema-'))
const p = await bootPlugin({ dir, settings: { accounts } })

await test('every tool declares a strict object schema with ok required', () => {
  assert.ok(p.tools.size >= 23, 'tools: ' + p.tools.size)
  for (const [name, t] of p.tools) {
    const s = t.output && t.output.schema
    assert.ok(s, name + ' has no output schema')
    assert.equal(s.type, 'object', name); assert.equal(s.additionalProperties, false, name)
    assert.equal(s.properties.ok && s.properties.ok.required, true, name + ' must require ok')
  }
})

await test('every tool declares every field a failed result or a rate limit can add', () => {
  const failures = [
    E.tool('MAIL_AGENT_DENIED', { message: 'no' }),
    toolFail(Object.assign(new Error('slow down'), { code: 'rate_limit', retryAfterSec: 30 }), 'MAIL_SEND_FAILED'),
    toolFail(Object.assign(new Error('token'), { code: 'needs_reauth' }), 'MAIL_SEND_FAILED'),
    toolFail(new Error('connect ECONNREFUSED'), 'MAIL_MAILBOX_UNREACHABLE'),
  ]
  assert.ok(failures[1].retryAfterSec === 30 && failures[2].oauthCode)
  for (const [name, t] of p.tools) {
    for (const f of failures) {
      // a failed result is the error body, plus the tool's own fields (text, messages, count...), which the tool schema declares
      const body = { ...f }
      const bad = schemaProblems(t.output.schema, body, name).filter(x => !/is required but missing/.test(x))
      assert.deepEqual(bad, [], name + ': ' + bad.join('; '))
    }
  }
})

await test('mail_reply and mail_forward: the sent, drafted and account fields are declared (issue #1)', () => {
  const reply = p.tools.get('mail_reply').output.schema, fwd = p.tools.get('mail_forward').output.schema
  assert.deepEqual(schemaProblems(reply, { ok: true, sent: true, text: 'SENT' }), [])
  assert.deepEqual(schemaProblems(reply, { ok: true, drafted: true, text: 'DRAFT' }), [])
  assert.deepEqual(schemaProblems(fwd, { ok: true, drafted: true, draftId: 'dr-1', account: 'box', provider: 'box', text: 'DRAFT' }), [])
  assert.deepEqual(schemaProblems(fwd, { ok: true, sent: true, messageId: 'm', from: 'a', to: 'b', subject: 's', provider: 'box', text: 'SENT' }), [])
})

await p.close()
