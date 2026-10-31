/**
 * dsh-mail / mailbox.js: the webmail conversation bridge.
 *
 * The rest of this plugin sends mail through a provider (Lettermint, SMTP, …).
 * That is fine for "send a message", but it cannot READ a mailbox or answer a
 * conversation in place. The webmail app exposes /api/agent for exactly that, and
 * this module is the thin client: one JSON call per action, bearer-token auth.
 *
 * The token is a mailbox service token (MAIL_AGENT_TOKEN on the mail app), NOT a
 * user password: it never expires on its own, it cannot be used to sign in to the
 * web UI, and revoking it is one line in the app's environment. It is read from
 * the plugin settings first, then from ~/.config/dsh-mail/mailbox-credentials so the
 * usual "credentials live in a file, never in git" rule holds.
 *
 * See mail app route: src/app/api/agent/route.ts (actions: accounts, threads,
 * thread, contacts, suggest, reminder, reply, send, move, mark, remind,
 * contact_save).
 */

'use strict'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const CREDENTIAL_PATH = () => process.env.DSH_MAIL_MAILBOX_CREDENTIALS || join(homedir(), '.config', 'dsh-mail', 'mailbox-credentials')

// readMailboxCredentials parses the credential file (KEY=value lines).
export function readMailboxCredentials() {
  const out = {}
  try {
    const raw = readFileSync(CREDENTIAL_PATH(), 'utf8')
    for (const line of raw.split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
      if (m) out[m[1]] = m[2].trim()
    }
  } catch {}
  return out
}

// resolveMailbox merges settings and the credential file into one config.
export function resolveMailbox(settings = {}) {
  const creds = readMailboxCredentials()
  const baseUrl = String(settings.mailboxBaseUrl || creds.MAIL_AGENT_BASE_URL || '')
    .replace(/\/+$/, '')
  const token = String(settings.mailboxAgentToken || creds.MAIL_AGENT_TOKEN || '')
  return { baseUrl, token, configured: Boolean(token && baseUrl) }
}

export class MailboxError extends Error {}

// agentCall performs one action against the mailbox agent API.
export async function agentCall(cfg, action, payload = {}, { timeoutMs = 20000 } = {}) {
  if (!cfg.token) throw new MailboxError('mailbox not configured: set mailboxBaseUrl and mailboxAgentToken, or write MAIL_AGENT_BASE_URL and MAIL_AGENT_TOKEN to ' + CREDENTIAL_PATH())
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(cfg.baseUrl + '/api/agent', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: 'Bearer ' + cfg.token,
      },
      body: JSON.stringify({ action, ...payload }),
      signal: controller.signal,
    })
    const text = await res.text()
    let json = {}
    try { json = text ? JSON.parse(text) : {} } catch { json = { ok: false, error: text.slice(0, 300) } }
    if (!res.ok && !json.error) json.error = 'HTTP ' + res.status
    // A refusal is an ERROR, not data. Without this the tools returned
    // {ok:false} as if it were a successful result, so an agent could believe a
    // send went out when the server had rejected it (found 2026-10-26).
    if (!res.ok || json.ok === false) {
      throw new MailboxError(String(json.error || 'HTTP ' + res.status) + (json.hint ? ' (' + json.hint + ')' : ''))
    }
    return json
  } catch (e) {
    if (e && e.name === 'AbortError') throw new MailboxError('mailbox request timed out')
    throw new MailboxError(String(e && e.message ? e.message : e))
  } finally {
    clearTimeout(timer)
  }
}

// formatThreads renders a conversation list for a chat transcript: one line per
// conversation, unread first-class, no JSON noise.
export function formatThreads(threads = [], view = 'inbox') {
  if (!Array.isArray(threads) || threads.length === 0) return 'No conversations in ' + view + '.'
  return threads.map((t) => {
    const unread = t.unread_count > 0 ? '[' + t.unread_count + ' NEW] ' : ''
    const who = t.last_from || t.account_address || 'unknown'
    const count = t.message_count > 1 ? ' (' + t.message_count + ' msgs)' : ''
    const when = String(t.last_message_at || '').slice(0, 16).replace('T', ' ')
    return unread + who + ' — ' + (t.subject || '(no subject)') + count + ' · ' + when + ' · id ' + t.id
  }).join('\n')
}

// formatThread renders one conversation for reading: header, then each message
// with its direction and body (trimmed), oldest first.
export function formatThread(detail, { maxBody = 4000 } = {}) {
  if (!detail || !detail.thread) return 'Conversation not found.'
  const t = detail.thread
  const lines = ['# ' + (t.subject || '(no subject)'), 'id ' + t.id + ' · ' + (t.participants || []).join(', ')]
  if (detail.reminder) lines.push('reminder: ' + detail.reminder.remind_at + (detail.reminder.note ? ' — ' + detail.reminder.note : ''))
  for (const m of detail.messages || []) {
    const who = m.direction === 'out' ? 'YOU → ' + (m.to_addrs || []).join(', ') : (m.from_addr || 'unknown')
    const body = String(m.text_body || m.snippet || '(no text body)').slice(0, maxBody)
    lines.push('', '--- ' + who + ' · ' + String(m.received_at || m.created_at || '').slice(0, 16).replace('T', ' '), body)
  }
  return lines.join('\n')
}
