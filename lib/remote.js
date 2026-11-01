/**
 * dsh-mail / remote.js: everything a mail body points at is fetched by the
 * server, never by the browser.
 *
 *   - Remote images (and CSS background images) are rewritten to a signed,
 *     same-origin proxy URL. The proxy fetches them from the DSH host with no
 *     cookies, no Referer and a generic User-Agent, follows at most three
 *     redirects, and only ever connects to PUBLIC addresses (the DNS answer
 *     is checked and pinned for the connection, so a rebinding host or a
 *     redirect to a private range is refused). Only real raster images pass
 *     (magic bytes are checked; SVG, HTML and scripts never do), with a size
 *     and a time cap.
 *   - Links go through a signed interstitial page on the DSH origin that
 *     shows the real destination and opens it with rel=noopener noreferrer.
 *   - http:// image URLs are upgraded to https://. Plain http is used only
 *     when the setting render.allowHttpImages is on (default off): there is
 *     no silent plaintext fallback.
 *
 * Signatures are HMACs with the per-install capability secret, so the routes
 * fetch or show only URLs that this server itself put into a rendered mail.
 */

'use strict'

import dns from 'node:dns'
import net from 'node:net'
import os from 'node:os'
import http from 'node:http'
import https from 'node:https'
import { createHmac, timingSafeEqual } from 'node:crypto'

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_REDIRECTS = 3
export const FETCH_TIMEOUT_MS = 10000
export const ALLOWED_PORTS = new Set([80, 443, 8080, 8443])
const MAX_URL = 4096
const USER_AGENT = 'Mozilla/5.0 (compatible; dsh-mail image proxy)'

// ── addresses ───────────────────────────────────────────────────────────────

const BLOCK = new net.BlockList()
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) BLOCK.addSubnet(a, p, 'ipv4')
for (const [a, p] of [
  // ::ffff:0:0/96 (IPv4-mapped) is NOT added here: a BlockList checks IPv4 addresses against it too. Mapped forms are refused below.
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001::', 32],
  ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) BLOCK.addSubnet(a, p, 'ipv6')

/** Addresses of this host's own interfaces (a public IP of the DSH host is not a target either). */
function ownAddresses() {
  const out = new Set()
  try { for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) out.add(String(i.address).toLowerCase()) } catch {}
  return out
}

/** True only for a globally routable unicast address that is not this host. */
export function isPublicAddress(ip, { own = ownAddresses() } = {}) {
  const s = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  const fam = net.isIP(s)
  if (!fam) return false
  if (own.has(s)) return false
  if (fam === 4) return !BLOCK.check(s, 'ipv4')
  // IPv4-mapped forms are judged as IPv4 (and the whole ::ffff:0:0/96 is blocked anyway).
  if (/^::ffff:/.test(s) || /^0:0:0:0:0:ffff:/.test(s)) return false
  if (BLOCK.check(s, 'ipv6')) return false
  // Global unicast is 2000::/3 only.
  const first = parseInt(s.split(':')[0] || '0', 16)
  return first >= 0x2000 && first <= 0x3fff
}

/** A dns lookup for http(s).request that refuses any non-public answer (checked and pinned per connection). */
export function guardedLookup(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {} }
  const own = ownAddresses()
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err)
    const list = (addrs || []).filter(a => a && a.address)
    if (!list.length) return cb(Object.assign(new Error('no address for ' + hostname), { code: 'ENOTFOUND' }))
    const bad = list.find(a => !isPublicAddress(a.address, { own }))
    if (bad) return cb(Object.assign(new Error('refused: ' + hostname + ' resolves to a private or reserved address'), { code: 'EBLOCKED' }))
    if (options && options.all) return cb(null, list.map(a => ({ address: a.address, family: a.family })))
    return cb(null, list[0].address, list[0].family)
  })
}

// ── URL checks ──────────────────────────────────────────────────────────────

export class RemoteError extends Error {
  constructor(message, status = 502) { super(message); this.status = status }
}

/** Parse and check a remote URL: http(s), no credentials, an allowed port, a host that is a name or a public IP. */
export function checkRemoteUrl(raw, { ports = ALLOWED_PORTS } = {}) {
  const s = String(raw || '')
  if (!s || s.length > MAX_URL) throw new RemoteError('invalid url', 400)
  let u
  try { u = new URL(s) } catch { throw new RemoteError('invalid url', 400) }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new RemoteError('only http(s) urls', 400)
  if (u.username || u.password) throw new RemoteError('urls with credentials are refused', 400)
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80)
  if (!(ports instanceof Set ? ports : new Set(ports)).has(port)) throw new RemoteError('port ' + port + ' is not allowed', 400)
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (!host) throw new RemoteError('invalid url', 400)
  if (net.isIP(host) && !isPublicAddress(host)) throw new RemoteError('refused: private or reserved address', 403)
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home\.arpa)$/i.test(host)) throw new RemoteError('refused: local host name', 403)
  return u
}

/** http:// becomes https:// (the default port moves along; an explicit :8080 becomes :8443). */
export function upgradeToHttps(u) {
  if (u.protocol !== 'http:') return u
  const v = new URL(u.href)
  v.protocol = 'https:'
  if (u.port === '8080') v.port = '8443'
  else if (u.port === '80') v.port = ''
  return v
}

// ── signing ─────────────────────────────────────────────────────────────────

function b64url(buf) { return Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '') }

export function signUrl(secret, kind, url) {
  return b64url(createHmac('sha256', String(secret)).update('dsh-mail-' + kind + '\0' + url).digest()).slice(0, 32)
}

export function verifyUrl(secret, kind, url, sig) {
  if (!secret || typeof sig !== 'string' || sig.length !== 32) return false
  const a = Buffer.from(sig)
  const b = Buffer.from(signUrl(secret, kind, url))
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * The rewriters the sanitizer uses. `img(url)` and `link(url)` return a
 * same-origin path under the plugin API prefix.
 */
export function makeRewriter(secret, apiPrefix) {
  return {
    img: url => apiPrefix + '/img?' + new URLSearchParams({ u: url, s: signUrl(secret, 'img', url) }).toString(),
    link: url => apiPrefix + '/link?' + new URLSearchParams({ u: url, s: signUrl(secret, 'link', url) }).toString(),
  }
}

// ── image sniffing ──────────────────────────────────────────────────────────

/** Content type from the magic bytes; null for anything that is not a plain raster image. */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null
  const b = buf
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.toString('latin1', 0, 4) === 'GIF8') return 'image/gif'
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  if (b.toString('latin1', 4, 8) === 'ftyp' && /^avi[fs]$/.test(b.toString('latin1', 8, 12))) return 'image/avif'
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp'
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'image/x-icon'
  return null
}

// ── fetching ────────────────────────────────────────────────────────────────

function requestOnce(u, { timeoutMs, maxBytes, lookup }) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || undefined,
      path: u.pathname + u.search, method: 'GET', agent: false, lookup,
      headers: { 'user-agent': USER_AGENT, accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,image/*;q=0.8', 'accept-encoding': 'identity' },
      // Certificate verification stays on (Node default); servername follows the host name.
    })
    const timer = setTimeout(() => req.destroy(new RemoteError('timeout', 504)), timeoutMs)
    req.on('error', e => { clearTimeout(timer); reject(e instanceof RemoteError ? e : new RemoteError(e.code === 'EBLOCKED' ? e.message : 'fetch failed: ' + (e.code || e.message), e.code === 'EBLOCKED' ? 403 : 502)) })
    req.on('response', res => {
      const status = res.statusCode || 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume(); clearTimeout(timer)
        resolve({ redirect: String(res.headers.location) })
        return
      }
      if (status !== 200 && status !== 203) { res.resume(); clearTimeout(timer); reject(new RemoteError('remote answered ' + status, 502)); return }
      const enc = String(res.headers['content-encoding'] || 'identity').toLowerCase()
      if (enc !== 'identity') { res.destroy(); clearTimeout(timer); reject(new RemoteError('encoded response refused', 502)); return }
      const len = Number(res.headers['content-length'] || 0)
      if (len > maxBytes) { res.destroy(); clearTimeout(timer); reject(new RemoteError('image larger than ' + maxBytes + ' bytes', 413)); return }
      const chunks = []; let size = 0
      res.on('data', c => { size += c.length; if (size > maxBytes) { res.destroy(); clearTimeout(timer); reject(new RemoteError('image larger than ' + maxBytes + ' bytes', 413)); return } chunks.push(c) })
      res.on('end', () => { clearTimeout(timer); resolve({ body: Buffer.concat(chunks) }) })
      res.on('error', e => { clearTimeout(timer); reject(new RemoteError('fetch failed: ' + (e.code || e.message))) })
    })
    req.end()
  })
}

/**
 * Fetch one remote image server-side. Returns { contentType, body, url, upgraded, plain }.
 * Options: allowHttp (plain http after a failed https upgrade; default false),
 * timeoutMs, maxBytes, maxRedirects; lookup and ports only for tests.
 */
export async function fetchRemoteImage(raw, o = {}) {
  const opts = { timeoutMs: o.timeoutMs || FETCH_TIMEOUT_MS, maxBytes: o.maxBytes || MAX_IMAGE_BYTES, lookup: o.lookup || guardedLookup }
  const maxRedirects = o.maxRedirects ?? MAX_REDIRECTS
  const ports = o.ports || ALLOWED_PORTS // tests only; the route always uses the default ports
  let u = checkRemoteUrl(raw, { ports })
  let plain = false, upgraded = false
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let r
    if (u.protocol === 'http:') {
      const secure = upgradeToHttps(u)
      try { r = await requestOnce(secure, opts); u = secure; upgraded = true }
      catch (e) {
        if (e && e.status === 403) throw e
        if (!o.allowHttp) throw new RemoteError('https upgrade failed and plain http is off (render.allowHttpImages)', 502)
        r = await requestOnce(u, opts); plain = true
      }
    } else r = await requestOnce(u, opts)
    if (r.redirect) {
      if (hop === maxRedirects) throw new RemoteError('too many redirects', 502)
      let next
      try { next = new URL(r.redirect, u) } catch { throw new RemoteError('bad redirect', 502) }
      if (u.protocol === 'https:' && next.protocol === 'http:' && !o.allowHttp) next = upgradeToHttps(next)
      u = checkRemoteUrl(next.href, { ports })
      continue
    }
    const type = sniffImage(r.body)
    if (!type) throw new RemoteError('not an image', 415)
    return { contentType: type, body: r.body, url: u.href, upgraded, plain }
  }
  throw new RemoteError('too many redirects', 502)
}

/** A tiny LRU for proxied images (by URL), so re-rendering a mail does not refetch. */
export class ImageCache {
  constructor({ maxEntries = 64, maxBytes = 16 * 1024 * 1024, ttlMs = 10 * 60 * 1000 } = {}) {
    this.map = new Map(); this.bytes = 0; this.o = { maxEntries, maxBytes, ttlMs }
  }
  get(k) {
    const v = this.map.get(k)
    if (!v) return null
    if (v.exp < Date.now()) { this.delete(k); return null }
    this.map.delete(k); this.map.set(k, v)
    return v.value
  }
  set(k, value) {
    this.delete(k)
    const size = value.body.length
    if (size > this.o.maxBytes) return
    this.map.set(k, { value, exp: Date.now() + this.o.ttlMs, size }); this.bytes += size
    while (this.map.size > this.o.maxEntries || this.bytes > this.o.maxBytes) this.delete(this.map.keys().next().value)
  }
  delete(k) { const v = this.map.get(k); if (v) { this.bytes -= v.size; this.map.delete(k) } }
}

/** At most `n` fetches in flight. */
export function limiter(n = 6) {
  let active = 0; const waiting = []
  const next = () => { if (active < n && waiting.length) { active++; waiting.shift()() } }
  return fn => new Promise((resolve, reject) => {
    waiting.push(() => Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next() }))
    next()
  })
}

// ── link interstitial ───────────────────────────────────────────────────────

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') }

/** The page shown by GET /link: the real destination, and a link that opens it without opener or referrer. */
export function linkPage(url) {
  let u = null
  try { u = new URL(url) } catch {}
  const ok = !!u && (u.protocol === 'https:' || u.protocol === 'http:')
  const host = ok ? u.hostname : ''
  const plain = ok && u.protocol === 'http:'
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="referrer" content="no-referrer"><title>Leaving Mail</title>' +
    '<style>body{font:15px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:640px;margin:12vh auto;padding:0 20px;color:#222;background:#fafafa}' +
    '@media (prefers-color-scheme:dark){body{color:#e6e6e6;background:#1b1b1b}.u{background:#2a2a2a!important}}' +
    'h1{font-size:18px;margin:0 0 12px}.h{font-size:22px;font-weight:700;word-break:break-all}.u{font:13px/1.4 ui-monospace,Menlo,monospace;word-break:break-all;background:#eee;padding:8px;margin:12px 0}' +
    'a.b{display:inline-block;padding:8px 16px;background:#4d6bfe;color:#fff;text-decoration:none;margin-right:8px}.w{color:#c98a14}</style></head><body>' +
    (ok
      ? '<h1>This link from an email leads to</h1><div class="h">' + esc(host) + '</div><div class="u">' + esc(u.href) + '</div>' +
        (plain ? '<p class="w">Warning: this address uses plain http, the connection is not encrypted.</p>' : '') +
        '<p>Opening it connects your browser to that site directly. Check the address before you continue.</p>' +
        '<p><a class="b" href="' + esc(u.href) + '" rel="noopener noreferrer">Open link</a></p>'
      : '<h1>This link cannot be opened</h1>') +
    '</body></html>'
}

export const LINK_PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
  'cross-origin-opener-policy': 'same-origin',
}

// ── outbound API transport guard ────────────────────────────────────────────

function loopbackName(h) {
  const s = String(h || '').toLowerCase().replace(/^\[|\]$/g, '')
  return s === 'localhost' || s === '::1' || /^127\.\d+\.\d+\.\d+$/.test(s)
}

/**
 * Every HTTP API call of the plugin (Lettermint, Resend, AgentMail, SendGrid,
 * Tzekos Mail, OAuth token endpoints, Microsoft Graph) goes through this check:
 * https, or plain http to a loopback relay only (for example an SSH-tunnelled
 * relay on 127.0.0.1, which SSH encrypts). Throws otherwise.
 */
export function assertSecureApiUrl(url, what = 'api') {
  let u
  try { u = new URL(String(url)) } catch { throw new Error(what + ': invalid URL') }
  if (u.protocol === 'https:') return u
  if (u.protocol === 'http:' && loopbackName(u.hostname)) return u
  throw new Error(what + ': refused plain ' + u.protocol.replace(':', '') + ' to ' + u.hostname + ' (https required; plain http only to a loopback relay)')
}
