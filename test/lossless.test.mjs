/**
 * Regression for DSH 0.2.1: every agent tool result, success or error, must be lossless JSON.
 * test/helpers.mjs wraps every registered tool with the core rule (test/lossless-check.mjs), so the e2e,
 * phase3, phase4 and review tests already guard the success paths. This file sweeps ALL tools through
 * the error paths (no accounts, tools disabled, denied account, unreachable server, bad arguments)
 * and asserts every tool was exercised by the suite.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test, section } from './harness.mjs'
import { bootPlugin, losslessSeen } from './helpers.mjs'

const BOGUS = [
  {}, { account: 'nope' }, { provider: 'nope' }, { threadId: 'x', text: 'hi' }, { messageId: 'nope:INBOX:1' }, { messageId: 'garbage' }, { ids: ['nope:INBOX:1'], action: 'read', to: 'archive' },
  { to: 'a@example.com', subject: 's', text: 't' }, { to: 'not-an-address', subject: 's', text: 't', confirm: true }, { draftId: 'nope', confirm: true },
  { csv: 'email\na@example.com', subjectTemplate: 's', textTemplate: 't', dryRun: true }, { csv: '', subjectTemplate: '', textTemplate: '' },
  { id: 'nope', action: 'cancel' }, { action: 'list' }, { action: 'create', subject: 's', text: 't' }, { action: 'get', draftId: 'nope' },
  { query: 'from:x is:unread' }, { q: 'x' }, { address: 'a@example.com', action: 'check' }, { sendAt: 'not a date', to: 'a@example.com', subject: 's', text: 't' },
  { preset: 'tomorrow', threadId: 'x' }, { action: 'list', messageId: 'nope:INBOX:1' }, { folder: 'INBOX', limit: 3, unread: true },
]

const variants = [
  ['no accounts', {}],
  ['agent denied', { accounts: [{ id: 'box', type: 'imap-smtp', address: 'me@example.com', receive: { protocol: 'imap', host: '127.0.0.1', port: 1, security: 'none' }, send: { protocol: 'smtp', host: '127.0.0.1', port: 1, security: 'none' }, agent: { allow: false } }] }],
  ['unreachable server', { accounts: [{ id: 'box', type: 'imap-smtp', address: 'me@example.com', receive: { protocol: 'imap', host: '127.0.0.1', port: 1, security: 'none' }, send: { protocol: 'smtp', host: '127.0.0.1', port: 1, security: 'none' } }] }],
]

section('lossless: every tool, error paths')
for (const [label, settings] of variants) {
  await test('all tool results are lossless JSON: ' + label, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-mail-lossless-'))
    const p = await bootPlugin({ dir, settings })
    try {
      assert.ok(p.tools.size >= 20, 'tools registered: ' + p.tools.size)
      for (const [name, t] of p.tools) {
        for (const args of BOGUS) {
          for (const a of [args, { ...args, account: 'box' }]) {
            try { await t.execute(a) } catch (e) { if (/not lossless JSON/.test(String(e && e.message))) throw e /* a plain throw is a tool error the core reports itself */ }
          }
        }
      }
    } finally { await p.close() }
  })
}

await test('every registered tool result was checked at least once by the suite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mail-lossless-'))
  const p = await bootPlugin({ dir, settings: {} })
  try { for (const name of p.tools.keys()) assert.ok(losslessSeen.has(name), name + ' was never executed under the lossless check') } finally { await p.close() }
})
