/**
 * dsh-mail / pop3.js: a small POP3 client (RFC 1939 + RFC 2595 STLS).
 *
 * Written instead of depending on an unmaintained npm package. Supports
 * implicit TLS (995), STLS upgrade (110) and plaintext only to loopback.
 * Commands: CAPA, STLS, USER/PASS, STAT, UIDL, LIST, RETR, TOP, DELE, NOOP, QUIT.
 * Multi-line responses are dot-unstuffed and returned as Buffers.
 */

'use strict'

import net from 'node:net'
import tls from 'node:tls'

const CRLF = Buffer.from('\r\n')
const TERM = Buffer.from('\r\n.\r\n')

export class Pop3Error extends Error {}

export class Pop3Client {
  /**
   * @param {object} o host, port, security ('tls'|'starttls'|'none'), user, pass,
   *   allowSelfSigned, timeoutMs, maxBytes (per multi-line response)
   */
  constructor(o) {
    this.o = { timeoutMs: 30000, maxBytes: 30 * 1024 * 1024, ...o }
    this.sock = null
    this.buf = Buffer.alloc(0)
    this.waiter = null
    this.closed = false
  }

  _attach(sock) {
    this.sock = sock
    sock.setTimeout(this.o.timeoutMs, () => this._fail(new Pop3Error('pop3: timeout')))
    sock.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this._pump() })
    sock.on('error', e => this._fail(new Pop3Error('pop3: ' + e.message)))
    sock.on('close', () => { this.closed = true; this._fail(new Pop3Error('pop3: connection closed')) })
  }

  _fail(err) {
    const w = this.waiter
    this.waiter = null
    if (w) w.reject(err)
  }

  _pump() {
    const w = this.waiter
    if (!w) return
    if (this.buf.length > this.o.maxBytes) { this._fail(new Pop3Error('pop3: response too large')); try { this.sock.destroy() } catch {} ; return }
    const eol = this.buf.indexOf(CRLF)
    if (eol < 0) return
    const first = this.buf.subarray(0, eol).toString('utf8')
    if (!first.startsWith('+OK')) {
      this.buf = this.buf.subarray(eol + 2)
      this.waiter = null
      w.reject(new Pop3Error('pop3: ' + first.replace(/^-ERR\s*/, '').slice(0, 300)))
      return
    }
    if (!w.multi) {
      this.buf = this.buf.subarray(eol + 2)
      this.waiter = null
      w.resolve({ line: first, data: null })
      return
    }
    // Multi-line: the body ends with CRLF.CRLF; an empty body is "+OK...\r\n.\r\n".
    const rest = this.buf.subarray(eol + 2)
    let end
    if (rest.length >= 3 && rest.subarray(0, 3).equals(Buffer.from('.\r\n'))) end = -1
    else { end = rest.indexOf(TERM); if (end < 0) return }
    const body = end === -1 ? Buffer.alloc(0) : rest.subarray(0, end)
    this.buf = end === -1 ? rest.subarray(3) : rest.subarray(end + TERM.length)
    this.waiter = null
    w.resolve({ line: first, data: unstuff(body) })
  }

  _wait(multi) {
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject, multi }
      this._pump()
    })
  }

  async _cmd(line, multi = false) {
    if (!this.sock || this.closed) throw new Pop3Error('pop3: not connected')
    if (/[\r\n]/.test(line)) throw new Pop3Error('pop3: invalid command')
    const p = this._wait(multi)
    this.sock.write(line + '\r\n')
    return p
  }

  async connect() {
    const { host, port, security, allowSelfSigned } = this.o
    // Transport rule: TLS or STLS; plaintext (USER/PASS in clear) only to a loopback host.
    const loop = /^(localhost|::1|\[::1\]|127\.\d+\.\d+\.\d+)$/i.test(String(host || ''))
    if (security !== 'tls' && security !== 'starttls' && !loop) throw new Pop3Error('pop3: plaintext is only allowed to a loopback host')
    const tlsOpts = { host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: !allowSelfSigned }
    const sock = await new Promise((resolve, reject) => {
      const s = security === 'tls' ? tls.connect(tlsOpts) : net.connect({ host, port })
      const onErr = e => reject(new Pop3Error('pop3: ' + e.message))
      s.once('error', onErr)
      s.once(security === 'tls' ? 'secureConnect' : 'connect', () => { s.off('error', onErr); resolve(s) })
    })
    this._attach(sock)
    this.greeting = (await this._wait(false)).line
    if (security === 'starttls') await this._stls()
    if (this.o.user) {
      await this._cmd('USER ' + this.o.user)
      await this._cmd('PASS ' + this.o.pass)
    }
    return this
  }

  async _stls() {
    await this._cmd('STLS')
    const plain = this.sock
    plain.removeAllListeners('data'); plain.removeAllListeners('error'); plain.removeAllListeners('close')
    plain.setTimeout(0)
    const { host, allowSelfSigned } = this.o
    const secure = await new Promise((resolve, reject) => {
      const s = tls.connect({ socket: plain, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: !allowSelfSigned })
      s.once('error', e => reject(new Pop3Error('pop3: STLS ' + e.message)))
      s.once('secureConnect', () => resolve(s))
    })
    this.buf = Buffer.alloc(0)
    this._attach(secure)
  }

  async capa() {
    try { const r = await this._cmd('CAPA', true); return r.data.toString('utf8').split('\r\n').filter(Boolean) } catch { return [] }
  }

  async stat() {
    const r = await this._cmd('STAT')
    const m = /^\+OK\s+(\d+)\s+(\d+)/.exec(r.line)
    return { count: m ? Number(m[1]) : 0, size: m ? Number(m[2]) : 0 }
  }

  async uidl() {
    const r = await this._cmd('UIDL', true)
    return r.data.toString('utf8').split('\r\n').filter(Boolean).map(l => { const [n, u] = l.split(/\s+/); return { num: Number(n), uid: u } })
  }

  async list() {
    const r = await this._cmd('LIST', true)
    return r.data.toString('utf8').split('\r\n').filter(Boolean).map(l => { const [n, s] = l.split(/\s+/); return { num: Number(n), size: Number(s) } })
  }

  async retr(num) { return (await this._cmd('RETR ' + Number(num), true)).data }
  async top(num, lines = 0) { return (await this._cmd('TOP ' + Number(num) + ' ' + Number(lines), true)).data }
  async dele(num) { await this._cmd('DELE ' + Number(num)) }
  async noop() { await this._cmd('NOOP') }

  async quit() {
    try { await this._cmd('QUIT') } catch {}
    try { this.sock.end() } catch {}
  }
}

/** Remove POP3 byte-stuffing: a line starting with ".." becomes "." */
export function unstuff(buf) {
  const s = buf.toString('latin1')
  const out = s.split('\r\n').map(l => (l.startsWith('..') ? l.slice(1) : l)).join('\r\n')
  return Buffer.from(out + (out.length ? '\r\n' : ''), 'latin1')
}

export async function pop3Connect(o) {
  const c = new Pop3Client(o)
  await c.connect()
  return c
}
