/** dsh-mail tests: boot the plugin with a fake cordis ctx and talk to its routes over real HTTP. */
import http from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export async function bootPlugin({ dir, settings = {}, withDshSettings = null }) {
  process.env.DSH_MAIL_DATA_DIR = join(dir, 'data')
  process.env.DSH_HOME = join(dir, 'home')
  process.env.DSH_MAIL_TEST_IDENTITY_TOOLS = '1'
  process.env.DSH_MAIL_MAILBOX_CREDENTIALS = join(dir, 'no-mailbox-credentials')
  process.env.DSH_MAIL_ESTATE_HOME = join(dir, 'no-estate-home')
  mkdirSync(process.env.DSH_MAIL_DATA_DIR, { recursive: true })
  mkdirSync(process.env.DSH_HOME, { recursive: true })
  writeFileSync(join(process.env.DSH_MAIL_DATA_DIR, 'settings.json'), JSON.stringify(settings))
  const { apply } = await import('../lib/index.js')
  const tools = new Map()
  let route = null
  const disposers = []
  const ctx = {
    tools: { register: t => tools.set(t.name, t) },
    webServer: { register: r => { route = r; return () => {} } },
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
  }
  if (withDshSettings) ctx.settings = withDshSettings
  const api = apply(ctx, {})
  const server = http.createServer((req, res) => route.handler(req, res))
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

export function request(port, method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    const req = http.request({ host: '127.0.0.1', port, method, path: '/dsh-mail/api' + path, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers } }, res => {
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
