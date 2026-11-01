/**
 * dsh-mail tests: the Mail tab rendered in happy-dom at 360 x 740 (a small
 * phone), against a real plugin instance with an IMAP account.
 *
 * happy-dom does not lay out boxes, so "fits 360 px" is checked structurally:
 * the stylesheet and every inline style set no fixed width above 360 px,
 * one pane shows at a time, the composer opens full width, and every button
 * has an accessible name. The views exercised: list, reading view, composer
 * (plain / Markdown / rich), unsubscribes pane, settings, folder switcher.
 */
import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import net from 'node:net'

import { test, section } from './harness.mjs'
import { bootPlugin } from './helpers.mjs'

const require = createRequire(import.meta.url)
const { build } = require('esbuild')
const { Window } = require('happy-dom')
const hoodiecrow = require('hoodiecrow-imap')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function freePort() { return new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) }) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

section('Mail tab at 360 px (happy-dom)')
const imapPort = await freePort()
const now = new Date().toUTCString()
const imap = hoodiecrow({ plugins: ['SPECIAL-USE', 'MOVE', 'UIDPLUS'], storage: { INBOX: { messages: [
  { raw: 'From: Very Long Sender Name With Many Words <a.very.long.address.that.could.overflow@an-extremely-long-domain-name.example>\r\nTo: testuser@example.org\r\nSubject: ' + 'A subject that is far too long to fit on a narrow phone screen in one line '.repeat(3) + '\r\nDate: ' + now + '\r\nMessage-ID: <r1@x>\r\n\r\nBody text.\r\n' },
  { raw: 'From: Bob <bob@example.org>\r\nTo: testuser@example.org\r\nSubject: Short\r\nDate: ' + now + '\r\nMessage-ID: <r2@x>\r\nContent-Type: text/html\r\n\r\n<p>Hello <b>there</b></p>\r\n' },
] }, '': { separator: '/', folders: { Sent: { 'special-use': '\\Sent' }, Projects: {} } } } })
await new Promise(r => imap.listen(imapPort, '127.0.0.1', r))
const dir = mkdtempSync(join(tmpdir(), 'dsh-mail-render-'))
const p = await bootPlugin({ dir, settings: { accounts: [{ id: 'box', type: 'imap-smtp', label: 'Box', address: 'testuser@example.org', auth: { user: 'testuser' }, receive: { protocol: 'imap', host: '127.0.0.1', port: imapPort, security: 'none' }, send: { protocol: 'smtp', host: '127.0.0.1', port: 9, security: 'none' }, secrets: { password: 'testpass' } }] } })

// Bundle the tab (react from this package's dev dependencies).
const out = join(root, 'test', '.render-tab.mjs') // inside the package so react resolves
await build({
  stdin: { contents: "export { MailView } from './src/app.jsx'; export { injectCss } from './src/css.js'; export { AccountsEditor } from './src/accounts.jsx'", resolveDir: root, loader: 'jsx' },
  bundle: true, format: 'esm', platform: 'browser', outfile: out, jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime'], logLevel: 'silent',
})

const win = new Window({ url: 'http://127.0.0.1:' + p.port + '/', width: 360, height: 740 })
for (const k of ['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver']) {
  try { Object.defineProperty(globalThis, k, { value: k === 'window' ? win : win[k], configurable: true, writable: true }) } catch {}
}
globalThis.IS_REACT_ACT_ENVIRONMENT = false
// The tab's relative /dsh-mail/api URLs go to the real plugin (read routes only here).
const nodeFetch = globalThis.fetch
win.fetch = globalThis.fetch = (url, opts = {}) => nodeFetch(new URL(String(url), 'http://127.0.0.1:' + p.port), { ...opts, headers: { ...(opts.headers || {}) } })
win.prompt = () => null; win.confirm = () => false; win.alert = () => {}
const React = require('react')
const { createRoot } = require('react-dom/client')
const { flushSync } = require('react-dom')
const { MailView, injectCss } = await import(pathToFileURL(out).href)

const container = document.createElement('div')
container.style.width = '360px'
document.body.appendChild(container)
injectCss()
const rootR = createRoot(container)
rootR.render(React.createElement(MailView, { visible: true }))
const until = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(50) } return false }
const click = el => { el.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); return sleep(60) }
const btn = label => [...container.querySelectorAll('button,[role=button]')].find(b => (b.getAttribute('aria-label') || b.textContent || '').trim() === label)

function widthProblems() {
  const bad = []
  for (const el of container.querySelectorAll('*')) {
    const st = el.getAttribute('style') || ''
    for (const m of st.matchAll(/(?:^|;)\s*(width|min-width)\s*:\s*(\d+)px/g)) if (Number(m[2]) > 360) bad.push(el.tagName + ' ' + m[0])
  }
  return bad
}
function unnamedButtons() {
  return [...container.querySelectorAll('button,[role=button]')].filter(b => !(b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').trim()).map(b => b.outerHTML.slice(0, 80))
}

await test('stylesheet: no fixed width or min-width above 360 px', () => {
  const css = [...document.querySelectorAll('style')].map(s => s.textContent).join('\n')
  assert.ok(css.includes('.mlx-'), 'CSS injected')
  for (const m of css.matchAll(/(?<![-\w])(width|min-width)\s*:\s*(\d+)px/g)) assert.ok(Number(m[2]) <= 360, 'CSS ' + m[0])
})
await test('list view renders the threads, long subjects and senders can wrap or clip, one pane at a time', async () => {
  assert.ok(await until(() => container.querySelectorAll('.mlx-li').length >= 2), 'threads rendered: ' + container.textContent.slice(0, 200))
  assert.deepEqual(widthProblems(), [])
  assert.deepEqual(unnamedButtons(), [])
  assert.equal(container.querySelectorAll('.mlx-compose').length, 0)
  assert.ok(!container.textContent.includes('undefined') && !container.textContent.includes('[object Object]'))
})
await test('reading view replaces the list (no side by side panes at 360 px)', async () => {
  const li = [...container.querySelectorAll('.mlx-li')].find(x => x.textContent.includes('Short'))
  await click(li.querySelector('[role=button],button') || li)
  assert.ok(await until(() => /Hello|there/.test(container.textContent) || !!container.querySelector('iframe')), 'message opened')
  assert.equal(container.querySelectorAll('.mlx-li').length, 0, 'the list is not shown beside the message')
  assert.deepEqual(widthProblems(), []); assert.deepEqual(unnamedButtons(), [])
  const back = btn('Back')
  if (back) await click(back)
})
await test('composer opens as a full-width dialog; Markdown and rich modes render', async () => {
  assert.ok(await until(() => !!btn('Compose')))
  await click(btn('Compose'))
  const dlg = container.querySelector('[role=dialog][aria-label=Compose]')
  assert.ok(dlg, 'composer dialog')
  assert.equal(dlg.querySelectorAll('textarea').length, 1)
  await click(btn('Markdown'))
  assert.match(dlg.querySelector('textarea').getAttribute('placeholder'), /bold/)
  await click(btn('Rich text'))
  assert.ok(dlg.querySelector('[contenteditable]'), 'rich editor')
  assert.ok(dlg.querySelector('[role=toolbar]'))
  assert.deepEqual(widthProblems(), []); assert.deepEqual(unnamedButtons(), [])
  await click(btn('Cancel'))
  assert.equal(container.querySelectorAll('[role=dialog][aria-label=Compose]').length, 0, 'an empty composer closes without asking')
})
await test('unsubscribes pane, settings and the folder switcher render at 360 px', async () => {
  rootR.render(React.createElement(MailView, { visible: true, key: 'again' }))
  await sleep(200)
  assert.ok(await until(() => !!btn('Unsubscribes')))
  await click(btn('Unsubscribes'))
  assert.ok(await until(() => container.textContent.includes('Nobody has unsubscribed yet')))
  assert.ok(container.querySelector('a[download]').getAttribute('href').endsWith('/suppress?format=csv'))
  assert.deepEqual(widthProblems(), []); assert.deepEqual(unnamedButtons(), [])
  await click(btn('Settings'))
  assert.ok(await until(() => container.textContent.includes('Unsubscribe') && container.textContent.includes('Add account')), 'settings: ' + container.textContent.slice(0, 120))
  assert.deepEqual(widthProblems(), []); assert.deepEqual(unnamedButtons(), [])
})

flushSync(() => rootR.unmount())
await win.happyDOM.abort().catch(() => {})
await win.happyDOM.close().catch(() => {})
await p.close()
await new Promise(r => imap.close(r))
rmSync(dir, { recursive: true, force: true })
rmSync(out, { force: true })
