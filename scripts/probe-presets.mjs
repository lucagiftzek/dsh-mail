#!/usr/bin/env node
/**
 * dsh-mail: probe the server presets (lib/presets.json).
 *
 * For every preset endpoint: TCP connect, then a TLS handshake (implicit TLS
 * ports) or a greeting read (STARTTLS ports), each with a short timeout.
 * A preset counts as verified when its IMAP and SMTP endpoints both answer.
 * With --docs the documentation URLs are fetched too (HTTP status only).
 *
 *   npm run probe-presets                 report only
 *   npm run probe-presets -- --write      also set "verified" in presets.json
 *   npm run probe-presets -- --docs --md docs/presets-probe.md
 *
 * Nothing is sent but a TCP / TLS handshake and, with --docs, one GET per
 * documentation page. Loopback (Proton Bridge) and custom-host rows are skipped.
 */
import net from 'node:net'
import tls from 'node:tls'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const file = join(root, 'lib', 'presets.json')
const args = process.argv.slice(2)
const has = f => args.includes(f)
const opt = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : '' }
const TIMEOUT = Number(opt('--timeout')) || 6000

export function probeEndpoint({ host, port, security }, timeoutMs = TIMEOUT) {
  return new Promise(done => {
    const t0 = Date.now()
    let finished = false
    const finish = (ok, detail) => { if (finished) return; finished = true; try { sock.destroy() } catch {} ; done({ ok, detail, ms: Date.now() - t0 }) }
    const sock = security === 'tls'
      ? tls.connect({ host, port, servername: host, timeout: timeoutMs }, () => finish(sock.authorized, sock.authorized ? 'TLS ok' : 'TLS: ' + sock.authorizationError))
      : net.connect({ host, port, timeout: timeoutMs }, () => { sock.once('data', d => finish(/^(\* OK|\+OK|220)/.test(d.toString('latin1')), 'greeting ' + d.toString('latin1').slice(0, 3).trim())) })
    sock.setTimeout(timeoutMs, () => finish(false, 'timeout'))
    sock.on('error', e => finish(false, e.code || e.message))
  })
}

async function probeDocs(url) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT * 2)
  try { const r = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'user-agent': 'dsh-mail-preset-probe' } }); return r.status } catch (e) { return e.name === 'AbortError' ? 'timeout' : 'error' } finally { clearTimeout(t) }
}

async function main() {
  const presets = JSON.parse(readFileSync(file, 'utf8'))
  const rows = []
  for (const p of presets) {
    if (p.unsupported || p.customHost || p.bridge) { rows.push({ id: p.id, skipped: p.unsupported ? 'unsupported' : p.customHost ? 'custom host' : 'local bridge' }); continue }
    const eps = []
    if (p.receive.imap) eps.push(['imap', p.receive.imap])
    if (p.receive.pop3) eps.push(['pop3', p.receive.pop3])
    if (p.send && p.send.host) eps.push(['smtp', p.send])
    const res = {}
    await Promise.all(eps.map(async ([k, e]) => { res[k] = await probeEndpoint(e) }))
    const verified = !!(res.imap && res.imap.ok && res.smtp && res.smtp.ok)
    const row = { id: p.id, verified, ...res }
    if (has('--docs')) row.docs = await probeDocs(p.docs)
    if (has('--write')) p.verified = verified
    rows.push(row)
    process.stdout.write(p.id.padEnd(14) + (verified ? ' verified ' : ' NOT verified ') + Object.entries(res).map(([k, v]) => k + ':' + (v.ok ? 'ok' : v.detail)).join(' ') + (row.docs !== undefined ? ' docs:' + row.docs : '') + '\n')
  }
  if (has('--write')) writeFileSync(file, JSON.stringify(presets, null, 2) + '\n')
  const md = opt('--md')
  if (md) {
    const lines = ['# Preset probe', '', 'Run: ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC, timeout ' + TIMEOUT + ' ms. TCP + TLS handshake (implicit TLS) or greeting (STARTTLS ports); docs = HTTP status of the documentation URL.', '',
      '| Preset | Verified | IMAP | POP3 | SMTP | Docs |', '|---|---|---|---|---|---|']
    for (const r of rows) {
      if (r.skipped) { lines.push('| ' + r.id + ' | skipped (' + r.skipped + ') | | | | |'); continue }
      const c = x => (x ? (x.ok ? 'ok' : x.detail) : 'n/a')
      lines.push('| ' + r.id + ' | ' + (r.verified ? 'yes' : 'no') + ' | ' + c(r.imap) + ' | ' + c(r.pop3) + ' | ' + c(r.smtp) + ' | ' + (r.docs !== undefined ? r.docs : '') + ' |')
    }
    writeFileSync(resolve(root, md), lines.join('\n') + '\n')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e); process.exit(1) })
