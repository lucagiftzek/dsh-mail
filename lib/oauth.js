/**
 * dsh-mail / oauth.js: OAuth2 for Google and Microsoft mail accounts.
 *
 * Bring-your-own client: every account carries its own client id (and
 * secret, redacted like every other secret). Flow: authorization code +
 * PKCE (S256). The `state` parameter is signed (HMAC with the plugin
 * capability secret), carries the account id, a nonce, a hash of the PKCE
 * verifier, the hash of the browser's harness cookie and an expiry of ten
 * minutes, and is single use (the nonce is consumed on completion).
 * Microsoft also supports the device code flow for hosts without a public
 * HTTPS name. Tokens are handled by lib/tokens.js and never leave the host.
 */

'use strict'

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { isLoopbackHost } from './accounts.js'

export const STATE_TTL_MS = 10 * 60 * 1000
export const CALLBACK_PATH = '/dsh-mail/api/oauth/callback'

export class OAuthError extends Error {
  constructor(message, code) { super(message); this.code = code || 'oauth_error' }
}

const MS_IMAP_SCOPES = ['offline_access', 'https://outlook.office.com/IMAP.AccessAsUser.All', 'https://outlook.office.com/SMTP.Send']
const MS_GRAPH_SCOPES = ['offline_access', 'https://graph.microsoft.com/Mail.Send']

export function b64url(buf) { return Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '') }
export function sha256(s) { return createHash('sha256').update(s).digest() }

/** Provider endpoints and scopes for an account, honouring per-account overrides (sovereign clouds, tests). */
export function providerConfig(acc) {
  const o = acc.oauth || {}
  if (acc.type === 'google') {
    return {
      provider: 'google',
      authorizeUrl: o.authorizeUrl || 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: o.tokenUrl || 'https://oauth2.googleapis.com/token',
      revokeUrl: o.revokeUrl || 'https://oauth2.googleapis.com/revoke',
      deviceUrl: '',
      scopes: { mail: ['https://mail.google.com/'] },
      authorizeScopes: ['https://mail.google.com/'],
      extra: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    }
  }
  if (acc.type === 'microsoft') {
    const tenant = /^[A-Za-z0-9.-]{1,80}$/.test(o.tenant || '') ? o.tenant : 'common'
    const base = 'https://login.microsoftonline.com/' + tenant + '/oauth2/v2.0'
    const graph = o.sendMode !== 'smtp'
    return {
      provider: 'microsoft',
      authorizeUrl: o.authorizeUrl || base + '/authorize',
      tokenUrl: o.tokenUrl || base + '/token',
      revokeUrl: '',
      deviceUrl: o.deviceUrl || base + '/devicecode',
      graphUrl: o.graphUrl || 'https://graph.microsoft.com/v1.0',
      scopes: { mail: MS_IMAP_SCOPES, graph: MS_GRAPH_SCOPES },
      // Consent covers both resources; each token request asks for one of them.
      authorizeScopes: graph ? [...new Set([...MS_IMAP_SCOPES, ...MS_GRAPH_SCOPES])] : MS_IMAP_SCOPES,
      extra: { prompt: 'select_account' },
    }
  }
  throw new OAuthError('OAuth2 is available for Google and Microsoft accounts only')
}

/** Endpoint overrides must be https (or http to a loopback host). */
export function validateEndpoints(o) {
  const errs = []
  for (const k of ['authorizeUrl', 'tokenUrl', 'revokeUrl', 'deviceUrl', 'graphUrl']) {
    const v = o && o[k]
    if (!v) continue
    let u
    try { u = new URL(v) } catch { errs.push('oauth.' + k + ' is not a URL'); continue }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(u.hostname))) errs.push('oauth.' + k + ' must use https')
  }
  return errs
}

export function newPkce() {
  const verifier = b64url(randomBytes(32))
  return { verifier, challenge: b64url(sha256(verifier)), method: 'S256' }
}

/** SHA-256 of the harness cookie value the browser presented (binds the flow to that browser). */
export function cookieFingerprint(cookieHeader, cookieName) {
  if (!cookieName || typeof cookieHeader !== 'string') return ''
  for (const seg of cookieHeader.split(';')) {
    const at = seg.indexOf('=')
    if (at > 0 && seg.slice(0, at).trim() === cookieName) return b64url(sha256(seg.slice(at + 1).trim())).slice(0, 22)
  }
  return ''
}

/**
 * Pending authorization flows (in memory: a restart simply asks for a new
 * Connect). Each nonce can complete once.
 */
export class FlowStore {
  constructor(secret) { this.secret = secret; this.pending = new Map() }

  sign(payload) {
    const body = b64url(Buffer.from(JSON.stringify(payload)))
    return body + '.' + b64url(createHmac('sha256', this.secret()).update('dsh-mail-oauth-state.' + body).digest())
  }

  /** Start a flow; returns { state, pkce }. */
  begin({ accountId, cookieFp, redirectUri, now = Date.now() }) {
    this.gc(now)
    const nonce = b64url(randomBytes(16))
    const pkce = newPkce()
    const exp = now + STATE_TTL_MS
    const state = this.sign({ v: 1, a: accountId, n: nonce, p: b64url(sha256(pkce.verifier)).slice(0, 22), c: cookieFp, e: exp })
    this.pending.set(nonce, { accountId, verifier: pkce.verifier, redirectUri, exp, cookieFp })
    if (this.pending.size > 200) this.pending.delete(this.pending.keys().next().value)
    return { state, pkce }
  }

  /** Verify and consume a state. Throws OAuthError on tamper, expiry, replay or browser mismatch. */
  consume(state, { cookieFp, now = Date.now() }) {
    const s = String(state || '')
    const dot = s.lastIndexOf('.')
    if (dot <= 0 || s.length > 2000) throw new OAuthError('invalid state', 'bad_state')
    const body = s.slice(0, dot)
    const want = b64url(createHmac('sha256', this.secret()).update('dsh-mail-oauth-state.' + body).digest())
    const a = Buffer.from(s.slice(dot + 1)); const b = Buffer.from(want)
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new OAuthError('state signature mismatch', 'bad_state')
    let p
    try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch { throw new OAuthError('invalid state', 'bad_state') }
    if (!p || p.v !== 1 || typeof p.e !== 'number') throw new OAuthError('invalid state', 'bad_state')
    if (p.e < now) { this.pending.delete(p.n); throw new OAuthError('the sign-in took longer than 10 minutes; press Connect again', 'expired_state') }
    const flow = this.pending.get(p.n)
    if (!flow) throw new OAuthError('this sign-in was already used or is unknown; press Connect again', 'replayed_state')
    this.pending.delete(p.n)
    if (flow.accountId !== p.a) throw new OAuthError('state does not match the account', 'bad_state')
    if (b64url(sha256(flow.verifier)).slice(0, 22) !== p.p) throw new OAuthError('PKCE verifier mismatch', 'bad_state')
    if (!p.c || p.c !== cookieFp) throw new OAuthError('the sign-in was started in another browser session', 'bad_state')
    return { accountId: p.a, verifier: flow.verifier, redirectUri: flow.redirectUri }
  }

  gc(now = Date.now()) { for (const [k, v] of this.pending) if (v.exp < now) this.pending.delete(k) }
}

export function authorizeUrl(acc, { state, pkce, redirectUri, clientId }) {
  const pc = providerConfig(acc)
  const u = new URL(pc.authorizeUrl)
  const q = {
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: pc.authorizeScopes.join(' '),
    state, code_challenge: pkce.challenge, code_challenge_method: 'S256', ...pc.extra,
  }
  if (acc.address) q.login_hint = acc.address
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v)
  return u.toString()
}

async function postForm(url, form, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(form).toString(), signal: ctrl.signal })
    const text = await r.text()
    let j = {}
    try { j = JSON.parse(text) } catch { j = {} }
    return { status: r.status, ok: r.ok, json: j }
  } catch (e) {
    throw new OAuthError(e && e.name === 'AbortError' ? 'token endpoint timed out' : 'token endpoint unreachable: ' + (e && e.message), 'network')
  } finally { clearTimeout(t) }
}

function tokenError(provider, j, status, phase = 'refresh') {
  const code = String(j.error || 'http_' + status)
  let hint = ''
  if (code === 'invalid_grant' && phase === 'exchange') hint = ' The authorization code was refused (expired, already used, a different redirect URI or a PKCE mismatch); press Connect again.'
  else if (code === 'invalid_grant') {
    hint = provider === 'google'
      ? ' The refresh token was revoked or expired. If this happens every 7 days, set the OAuth consent screen publishing status to "In production" in the Google Cloud console, then Reconnect.'
      : ' The refresh token was revoked or expired (password change, admin policy or 90 days unused). Reconnect.'
  } else if (code === 'invalid_client' || code === 'unauthorized_client') hint = ' Check the client id and secret of this account.'
  else if (/AADSTS65001|consent_required/.test(String(j.error_description || ''))) hint = ' An administrator of the tenant must grant consent to this app.'
  // error_description is provider text without tokens; trim it anyway.
  return new OAuthError(provider + ': ' + code + (j.error_description ? ' (' + String(j.error_description).split('\n')[0].slice(0, 200) + ')' : '') + '.' + hint, code)
}

function clientForm(acc) {
  const f = { client_id: (acc.oauth && acc.oauth.clientId) || '' }
  if (acc.secrets && acc.secrets.oauthClientSecret) f.client_secret = acc.secrets.oauthClientSecret
  return f
}

/** Exchange an authorization code. Returns the raw token set (never to be logged). */
export async function exchangeCode(acc, { code, verifier, redirectUri, fetchImpl }) {
  const pc = providerConfig(acc)
  const form = { ...clientForm(acc), grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }
  if (pc.provider === 'microsoft') form.scope = pc.scopes.mail.join(' ')
  const r = await postForm(pc.tokenUrl, form, { fetchImpl })
  if (!r.ok || !r.json.access_token) throw tokenError(pc.provider, r.json, r.status, 'exchange')
  return normaliseTokens(r.json)
}

/** Refresh for one purpose ('mail' or, Microsoft only, 'graph'). */
export async function refreshToken(acc, refresh, purpose = 'mail', { fetchImpl } = {}) {
  const pc = providerConfig(acc)
  const form = { ...clientForm(acc), grant_type: 'refresh_token', refresh_token: refresh }
  if (pc.provider === 'microsoft') form.scope = (pc.scopes[purpose] || pc.scopes.mail).join(' ')
  const r = await postForm(pc.tokenUrl, form, { fetchImpl })
  if (!r.ok || !r.json.access_token) throw tokenError(pc.provider, r.json, r.status)
  return normaliseTokens(r.json)
}

export async function revokeToken(acc, token, { fetchImpl } = {}) {
  const pc = providerConfig(acc)
  if (!pc.revokeUrl || !token) return { revoked: false, reason: pc.provider === 'microsoft' ? 'Microsoft has no token revocation endpoint; the local tokens were deleted. Remove the app under My Apps to revoke access.' : 'nothing to revoke' }
  const r = await postForm(pc.revokeUrl, { token }, { fetchImpl })
  return { revoked: r.ok || r.status === 400, status: r.status }
}

/** Device code flow (Microsoft). Returns { deviceCode, userCode, verificationUri, interval, expiresAt, message }. */
export async function startDeviceCode(acc, { fetchImpl } = {}) {
  const pc = providerConfig(acc)
  if (!pc.deviceUrl) throw new OAuthError('the device code flow is only offered for Microsoft accounts')
  const r = await postForm(pc.deviceUrl, { client_id: (acc.oauth && acc.oauth.clientId) || '', scope: pc.authorizeScopes.join(' ') }, { fetchImpl })
  if (!r.ok || !r.json.device_code) throw tokenError(pc.provider, r.json, r.status)
  return {
    deviceCode: r.json.device_code, userCode: r.json.user_code, verificationUri: r.json.verification_uri || r.json.verification_url,
    interval: Math.max(1, Number(r.json.interval) || 5), expiresAt: Date.now() + (Number(r.json.expires_in) || 900) * 1000, message: r.json.message || '',
  }
}

/** One device-code poll. Returns tokens, or { pending: true, slowDown } while the user has not finished. */
export async function pollDeviceCode(acc, deviceCode, { fetchImpl } = {}) {
  const pc = providerConfig(acc)
  const r = await postForm(pc.tokenUrl, { client_id: (acc.oauth && acc.oauth.clientId) || '', grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode }, { fetchImpl })
  if (r.ok && r.json.access_token) return normaliseTokens(r.json)
  if (r.json.error === 'authorization_pending') return { pending: true }
  if (r.json.error === 'slow_down') return { pending: true, slowDown: true }
  throw tokenError(pc.provider, r.json, r.status)
}

export function normaliseTokens(j) {
  return {
    accessToken: String(j.access_token),
    refreshToken: j.refresh_token ? String(j.refresh_token) : '',
    expiresAt: Date.now() + Math.max(60, Number(j.expires_in) || 3600) * 1000,
    scope: String(j.scope || ''),
  }
}

/** The SASL XOAUTH2 initial response (what imapflow and nodemailer send for us). */
export function xoauth2String(user, accessToken) {
  return Buffer.from('user=' + user + '\x01auth=Bearer ' + accessToken + '\x01\x01').toString('base64')
}

/** The exact redirect URI for this DSH host: settings override, else the request's own origin. */
export function redirectUriFor(req, settings) {
  const fixed = settings && settings.oauth && settings.oauth.redirectBaseUrl
  if (fixed) return String(fixed).replace(/\/+$/, '') + CALLBACK_PATH
  const host = String((req.headers && req.headers.host) || '')
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  const fwd = String((req.headers && req.headers['x-forwarded-proto']) || '').split(',')[0].trim()
  const proto = fwd === 'http' || fwd === 'https' ? fwd : (isLoopbackHost(hostname) ? 'http' : 'https')
  return proto + '://' + host + CALLBACK_PATH
}
