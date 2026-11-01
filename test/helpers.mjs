/** dsh-mail tests: boot the plugin with a fake cordis ctx and talk to its routes over real HTTP. */
import http from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertLossless } from './lossless-check.mjs'

/** Names of the tools whose execute() ran under the lossless check (coverage assertion in test/lossless.test.mjs). */
export const losslessSeen = new Set()
/** Every tool result is checked against DSH 0.2.1's lossless-JSON rule, so every existing tool test also guards it. */
function checked(t) {
  const execute = t.execute
  if (typeof execute !== 'function') return t
  return { ...t, execute: async function (...a) { const out = await execute.apply(this, a); await assertLossless(out, 'tool ' + t.name + ' result'); losslessSeen.add(t.name); return out } }
}

export async function bootPlugin({ dir, settings = {}, withDshSettings = null, extra = {}, strict = false, noSettingsFile = false, estateHome = null, mailboxCreds = null, config = {} }) {
  process.env.DSH_MAIL_DATA_DIR = join(dir, 'data')
  process.env.DSH_HOME = join(dir, 'home')
  process.env.DSH_MAIL_TEST_IDENTITY_TOOLS = '1'
  process.env.DSH_MAIL_MAILBOX_CREDENTIALS = mailboxCreds || join(dir, 'no-mailbox-credentials')
  process.env.DSH_MAIL_ESTATE_HOME = estateHome || join(dir, 'no-estate-home')
  mkdirSync(process.env.DSH_MAIL_DATA_DIR, { recursive: true })
  mkdirSync(process.env.DSH_HOME, { recursive: true })
  if (!noSettingsFile) writeFileSync(join(process.env.DSH_MAIL_DATA_DIR, 'settings.json'), JSON.stringify(settings))
  const { apply } = await import('../lib/index.js')
  const tools = new Map()
  const routes = []
  const disposers = []
  const base = {
    tools: { register: t => tools.set(t.name, checked(t)) },
    webServer: { register: r => { routes.push(r); return () => {} } },
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
    ...extra,
  }
  if (withDshSettings) base.settings = withDshSettings
  // strict: like cordis on DSH 0.2, reading a service that is not injected throws
  const ctx = strict ? new Proxy(base, { get(t, k) { if (typeof k === 'symbol' || k in t) return t[k]; throw new TypeError('cannot get property "' + String(k) + '" without inject') } }) : base
  const api = apply(ctx, config)
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname
    const r = routes.filter(x => path === x.path || path.startsWith(x.path + '/')).sort((a, b) => b.path.length - a.path.length)[0]
    if (!r) { res.writeHead(404); res.end(); return }
    r.handler(req, res)
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  // wait for the capability secret
  for (let i = 0; i < 50; i++) { const r = await request(port, 'GET', '/session'); if (r.status === 200) break; await new Promise(r => setTimeout(r, 20)) }
  return {
    ...api, tools, port,
    async close() { for (const d of disposers) { try { d() } catch {} } await new Promise(r => server.close(r)) },
  }
}

export function cookieFor(host) {
  const d = createHash('sha256').update(host).digest('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
  return 'dsh-auth-' + d + '=1'
}

export function request(port, method, path, { body, headers = {}, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    const req = http.request({ host: '127.0.0.1', port, method, path: raw ? path : '/dsh-mail/api' + path, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers } }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks)
        let json = null
        try { json = JSON.parse(raw.toString('utf8')) } catch {}
        resolve({ status: res.statusCode, headers: res.headers, raw, text: raw.toString('utf8'), json })
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

/** A mutating request with every layer satisfied (token, same-origin, cookie). */
export async function mutate(port, path, body, { omit = [] } = {}) {
  const tok = (await request(port, 'GET', '/session')).json.token
  const host = '127.0.0.1:' + port
  const headers = { origin: 'http://' + host, 'sec-fetch-site': 'same-origin', 'x-dsh-mail-token': tok, cookie: cookieFor(host) }
  for (const k of omit) delete headers[k]
  return request(port, 'POST', path, { body, headers })
}
