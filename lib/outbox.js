/**
 * dsh-mail / outbox.js: undo send. A message sent from the tab is held in
 * memory for `compose.undoSendSec` seconds (default 6) before it goes out;
 * POST /outbox/cancel during that window drops it. A restart within the
 * window drops the message too (the tab says so).
 */

'use strict'

import { randomBytes } from 'node:crypto'

export class Outbox {
  constructor() { this.held = new Map() }

  /** Hold `fn` for `ms`; returns { id, sendAt }. onResult(err, value) is called after it ran. */
  hold(fn, ms, onResult = () => {}) {
    const id = 'o-' + randomBytes(6).toString('hex')
    const sendAt = Date.now() + ms
    const timer = setTimeout(async () => {
      this.held.delete(id)
      try { onResult(null, await fn()) } catch (e) { onResult(e) }
    }, ms)
    if (timer.unref) timer.unref()
    this.held.set(id, { timer, sendAt })
    return { id, sendAt }
  }

  cancel(id) {
    const h = this.held.get(id)
    if (!h) return false
    clearTimeout(h.timer)
    this.held.delete(id)
    return true
  }

  pending() { return [...this.held].map(([id, h]) => ({ id, sendAt: h.sendAt })) }
  clear() { for (const [, h] of this.held) clearTimeout(h.timer); this.held.clear() }
}
