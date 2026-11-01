/**
 * dsh-mail / graph.js: Microsoft Graph sendMail, the fallback for tenants
 * that disabled SMTP AUTH. The message is sent as MIME (base64 body,
 * Content-Type text/plain), so headers, threading and attachments are the
 * same bytes SMTP would have carried. Graph stores it in Sent Items itself.
 * https://learn.microsoft.com/graph/api/user-sendmail (MIME format)
 */

'use strict'

import { assertSecureApiUrl } from './remote.js'

export async function graphSendMime(graphUrl, accessToken, raw, { fetchImpl = fetch, timeoutMs = 60000 } = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    assertSecureApiUrl(String(graphUrl).replace(/\/+$/, '') + '/me/sendMail', 'graph')
    const r = await fetchImpl(String(graphUrl).replace(/\/+$/, '') + '/me/sendMail', {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: 'Bearer ' + accessToken, 'content-type': 'text/plain' },
      body: Buffer.from(raw).toString('base64'),
      signal: ctrl.signal,
    })
    if (r.status === 202 || r.ok) return { ok: true }
    let detail = ''
    try { const j = await r.json(); detail = (j.error && (j.error.code + ': ' + j.error.message)) || '' } catch {}
    throw new Error('graph sendMail failed (' + r.status + ')' + (detail ? ': ' + detail.slice(0, 300) : ''))
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('graph sendMail timed out')
    throw e
  } finally { clearTimeout(t) }
}
