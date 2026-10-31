/**
 * dsh-mail / compose.js: outgoing bodies.
 *
 *   plain     text only
 *   markdown  text is Markdown: HTML = sanitize(marked(text)), text part = the Markdown
 *   rich      HTML from the composer's rich editor: sanitized, text part = html-to-text
 *
 * Every send that has HTML goes out as multipart/alternative (text + HTML).
 * The outgoing allow-list is small: formatting, links, lists, quotes, code,
 * tables, images by https/cid/data. No scripts, styles from outside, forms.
 */

'use strict'

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sanitizeHtml = require('sanitize-html')
const { convert } = require('html-to-text')
const { marked } = require('marked')

const OUT_TAGS = ['a', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'br', 'p', 'div', 'span', 'blockquote', 'ul', 'ol', 'li', 'code', 'pre', 'h1', 'h2', 'h3', 'h4', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img', 'sub', 'sup']

export function sanitizeOutgoing(html) {
  return sanitizeHtml(String(html || ''), {
    allowedTags: OUT_TAGS,
    allowedAttributes: { a: ['href', 'title'], img: ['src', 'alt', 'width', 'height'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'], '*': ['style'] },
    allowedStyles: { '*': { color: [/^#[0-9a-f]{3,6}$/i, /^rgb\(/], 'text-align': [/^(left|right|center)$/], 'font-weight': [/^\w+$/], 'font-style': [/^\w+$/], 'text-decoration': [/^[\w ]+$/] } },
    allowedSchemes: ['https', 'http', 'mailto', 'cid'],
    allowedSchemesByTag: { img: ['https', 'cid', 'data'] },
    transformTags: { a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, rel: 'noopener noreferrer' } }) },
  })
}

export function htmlToText(html) {
  return convert(String(html || ''), { wordwrap: 78, selectors: [{ selector: 'a', options: { hideLinkHrefIfSameAsText: true } }, { selector: 'img', format: 'skip' }] })
}

export function markdownToHtml(md) {
  return sanitizeOutgoing(marked.parse(String(md || ''), { gfm: true, breaks: true, async: false }))
}

/** Build { text, html } from a compose request: { format: 'plain'|'markdown'|'rich', text, html }. */
export function renderBody({ format = 'plain', text = '', html = '' } = {}) {
  if (format === 'markdown') return { text: String(text || ''), html: markdownToHtml(text) }
  if (format === 'rich') {
    const clean = sanitizeOutgoing(html)
    return { text: htmlToText(clean), html: clean }
  }
  return { text: String(text || ''), html: html ? sanitizeOutgoing(html) : '' }
}

/** Append a plain signature to both parts. */
export function withSignature(body, signature) {
  if (!signature) return body
  const esc = String(signature).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
  return { text: (body.text || '') + '\n\n' + signature, html: body.html ? body.html + '<p>' + esc + '</p>' : '' }
}
