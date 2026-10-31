/**
 * dsh-mail / oauth-routes.js: the OAuth2 routes under /dsh-mail/api/oauth.
 *
 *   GET  /oauth/redirect-uri   read gate      the exact URI to register at the provider
 *   GET  /oauth/status         read gate      connected / needsReauth / device flow state
 *   GET  /oauth/callback       callback gate  static page; finishes the flow with a POST
 *   POST /oauth/start          mutate gate    authorization URL (code + PKCE, signed state)
 *   POST /oauth/complete       mutate gate    verify state, exchange the code, store tokens
 *   POST /oauth/revoke         mutate gate    revoke at the provider (Google) and forget
 *   POST /oauth/device/start   mutate gate    Microsoft device code flow
 *
 * No response ever contains a token or the authorization code; the code is
 * never logged.
 */

'use strict'

import { randomBytes } from 'node:crypto'

import { usesOAuth } from './accounts.js'
import { authorizeUrl, cookieFingerprint, exchangeCode, redirectUriFor, revokeToken, startDeviceCode, pollDeviceCode, OAuthError } from './oauth.js'
import { harnessCookieName, checkCallbackRequest } from './security.js'

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(payload))
}

/** The page the provider redirects to. It moves code + state to a gated POST and closes. */
export function callbackPage(nonce) {
  const script = `
(function(){
  var p = new URLSearchParams(location.search);
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
  var out = document.getElementById('m');
  function done(ok, text) {
    out.textContent = text;
    document.body.className = ok ? 'ok' : 'bad';
    try { if (window.opener) window.opener.postMessage({ type: 'dsh-mail-oauth', ok: ok }, location.origin); } catch (e) {}
    if (ok) setTimeout(function(){ try { window.close(); } catch (e) {} }, 1500);
  }
  var body = { code: p.get('code') || '', state: p.get('state') || '', error: p.get('error') || '', error_description: (p.get('error_description') || '').slice(0, 300) };
  fetch('/dsh-mail/api/session', { credentials: 'same-origin' }).then(function(r){ return r.json(); }).then(function(s){
    return fetch('/dsh-mail/api/oauth/complete', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-dsh-mail-token': s.token }, body: JSON.stringify(body) });
  }).then(function(r){ return r.json(); }).then(function(j){
    done(!!j.ok, j.ok ? 'Connected ' + (j.account || '') + '. You can close this window.' : 'Not connected: ' + (j.error || 'unknown error'));
  }).catch(function(e){ done(false, 'Not connected: ' + e.message); });
})();`
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="referrer" content="no-referrer"><title>dsh-mail sign-in</title>' +
    '<style>body{font:15px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;color:#333;background:#f6f6f6}' +
    'div{max-width:420px;padding:24px;border-radius:12px;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.08)}.ok div{border-top:4px solid #2e9e5b}.bad div{border-top:4px solid #cf3b3b}' +
    '@media (prefers-color-scheme:dark){body{background:#1b1b1b;color:#ddd}div{background:#262626}}</style></head>' +
    '<body><div><b>Mail sign-in</b><p id="m">Finishing the sign-in...</p></div><script nonce="' + nonce + '">' + script + '</script></body></html>'
}

export function makeOAuthRoutes(d) {
  const { service, tokens, flows, resolved, effective, pool, scrub, warn } = d
  const devices = new Map() // account -> { userCode, verificationUri, expiresAt, message, status, error }

  const explicitOAuthAccount = id => {
    const acc = resolved().explicit.find(a => a.id === String(id || ''))
    if (!acc) throw new OAuthError('save the account first (unknown account ' + String(id || '').slice(0, 40) + ')')
    if (!usesOAuth(acc)) throw new OAuthError('account ' + acc.id + ' does not use OAuth2')
    if (!acc.oauth.clientId) throw new OAuthError('set the client id of your OAuth app first')
    return acc
  }
  const fpOf = req => cookieFingerprint(req.headers.cookie, harnessCookieName(req.headers.host))
  const statusOf = id => {
    const s = tokens.status(id)
    const dv = devices.get(id)
    return { ...s, device: dv ? { status: dv.status, userCode: dv.userCode, verificationUri: dv.verificationUri, expiresAt: dv.expiresAt, error: dv.error || '' } : null }
  }

  async function pollDevice(acc, flow) {
    let interval = flow.interval
    while (Date.now() < flow.expiresAt) {
      await new Promise(r => { const t = setTimeout(r, interval * 1000); if (t.unref) t.unref() })
      const cur = devices.get(acc.id)
      if (!cur || cur !== flow.view) return
      try {
        const r = await pollDeviceCode(acc, flow.deviceCode, { fetchImpl: d.fetchImpl })
        if (r.pending) { if (r.slowDown) interval += 5; continue }
        tokens.connect(acc, r)
        await pool.close(acc.id).catch(() => {})
        flow.view.status = 'connected'
        return
      } catch (e) { flow.view.status = 'failed'; flow.view.error = scrub(e.message); return }
    }
    flow.view.status = 'expired'
  }

  /** GET routes; returns true when handled. */
  async function get(sub, req, res, { readGate, url }) {
    if (sub === '/oauth/redirect-uri') {
      if (!readGate()) return true
      sendJson(res, 200, { ok: true, redirectUri: redirectUriFor(req, effective()) })
      return true
    }
    if (sub === '/oauth/status') {
      if (!readGate()) return true
      sendJson(res, 200, { ok: true, account: url.searchParams.get('account') || '', status: statusOf(url.searchParams.get('account') || '') })
      return true
    }
    if (sub === '/oauth/callback') {
      const g = checkCallbackRequest(req, { trustedHosts: effective().trustedHosts })
      if (!g.ok) { res.writeHead(g.status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end('dsh-mail: ' + g.reason); return true }
      const nonce = randomBytes(16).toString('base64')
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      })
      res.end(callbackPage(nonce))
      return true
    }
    return false
  }

  /** POST routes (the mutate gate has already passed); returns true when handled. */
  async function post(sub, req, res, body) {
    try {
      if (sub === '/oauth/start') {
        const acc = explicitOAuthAccount(body.account)
        const fp = fpOf(req)
        if (!fp) throw new OAuthError('no browser session cookie to bind the sign-in to')
        const redirectUri = redirectUriFor(req, effective())
        const { state, pkce } = flows.begin({ accountId: acc.id, cookieFp: fp, redirectUri })
        sendJson(res, 200, { ok: true, url: authorizeUrl(acc, { state, pkce, redirectUri, clientId: acc.oauth.clientId }), redirectUri })
        return true
      }
      if (sub === '/oauth/complete') {
        if (body.error) {
          // Still consume the state so it cannot be reused.
          try { flows.consume(body.state, { cookieFp: fpOf(req) }) } catch {}
          throw new OAuthError('the provider answered: ' + String(body.error).slice(0, 60) + (body.error_description ? ' (' + String(body.error_description).slice(0, 200) + ')' : ''))
        }
        const flow = flows.consume(body.state, { cookieFp: fpOf(req) })
        const acc = explicitOAuthAccount(flow.accountId)
        if (typeof body.code !== 'string' || !body.code || body.code.length > 4096) throw new OAuthError('no authorization code')
        const t = await exchangeCode(acc, { code: body.code, verifier: flow.verifier, redirectUri: flow.redirectUri, fetchImpl: d.fetchImpl })
        if (!t.refreshToken) throw new OAuthError('the provider returned no refresh token; remove the app from your account permissions and Connect again')
        tokens.connect(acc, t)
        await pool.close(acc.id).catch(() => {})
        sendJson(res, 200, { ok: true, account: acc.id })
        return true
      }
      if (sub === '/oauth/revoke') {
        const acc = resolved().all.find(a => a.id === String(body.account || ''))
        if (!acc) throw new OAuthError('unknown account')
        let r = { revoked: false }
        try { r = await revokeToken(acc, tokens.refreshTokenOf(acc.id), { fetchImpl: d.fetchImpl }) } catch (e) { warn('revoke failed for ' + acc.id + ': ' + scrub(e.message)) }
        tokens.forget(acc.id)
        devices.delete(acc.id)
        await pool.close(acc.id).catch(() => {})
        sendJson(res, 200, { ok: true, revoked: !!r.revoked, note: r.reason || '' })
        return true
      }
      if (sub === '/oauth/device/start') {
        const acc = explicitOAuthAccount(body.account)
        const f = await startDeviceCode(acc, { fetchImpl: d.fetchImpl })
        const view = { status: 'pending', userCode: f.userCode, verificationUri: f.verificationUri, expiresAt: f.expiresAt, message: f.message }
        devices.set(acc.id, view)
        void pollDevice(acc, { ...f, view })
        sendJson(res, 200, { ok: true, userCode: f.userCode, verificationUri: f.verificationUri, expiresAt: f.expiresAt, message: f.message })
        return true
      }
    } catch (e) {
      sendJson(res, 400, { ok: false, error: scrub(e.message), code: e.code || '' })
      return true
    }
    return false
  }

  return { get, post, statusOf, forget: id => { tokens.forget(id); devices.delete(id) } }
}
