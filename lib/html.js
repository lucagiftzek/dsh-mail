/**
 * dsh-mail / html.js: make an HTML mail body safe to show.
 *
 * The body is sanitised on the server (sanitize-html allow-list: no scripts,
 * forms, iframes, objects or event handlers, only http(s)/mailto/cid/data
 * URLs) and wrapped in a document with a strict CSP. The tab shows it in a
 * sandboxed iframe without allow-scripts. Remote images are blocked unless
 * the reader asks for them: their src is moved to data-blocked-src and the
 * count is reported so the tab can offer "Load images".
 */

'use strict'

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sanitizeHtml = require('sanitize-html')

const TAGS = ['a', 'abbr', 'address', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col', 'colgroup',
  'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins',
  'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'tt', 'u', 'ul', 'wbr', 'style']

const COMMON_ATTRS = ['style', 'class', 'align', 'valign', 'width', 'height', 'bgcolor', 'color', 'dir', 'lang', 'title', 'border', 'cellpadding', 'cellspacing']

/**
 * @param {string} html raw HTML body
 * @param {object} o  { images: boolean (allow remote), cid: Map<cid, dataUri> }
 * @returns {{ html: string, blocked: number }}
 */
export function sanitizeMailHtml(html, { images = false, cid = new Map() } = {}) {
  let blocked = 0
  const clean = sanitizeHtml(String(html || ''), {
    allowedTags: TAGS,
    allowVulnerableTags: true, // <style> is kept for layout; the CSP blocks every remote load
    allowedAttributes: {
      '*': COMMON_ATTRS,
      a: ['href', 'name', 'target', 'rel', ...COMMON_ATTRS],
      img: ['src', 'alt', 'width', 'height', 'data-blocked-src', ...COMMON_ATTRS],
      td: ['colspan', 'rowspan', ...COMMON_ATTRS],
      th: ['colspan', 'rowspan', 'scope', ...COMMON_ATTRS],
      font: ['face', 'size', 'color'],
      col: ['span', ...COMMON_ATTRS],
      ol: ['start', 'type', ...COMMON_ATTRS],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'cid', 'data'],
    allowedSchemesByTag: { img: ['http', 'https', 'cid', 'data'], a: ['http', 'https', 'mailto'] },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    nonTextTags: ['script', 'textarea', 'option', 'noscript', 'title', 'head', 'iframe', 'object', 'embed', 'form', 'svg', 'math'],
    transformTags: {
      // Only absolute http(s)/mailto links and in-page anchors: a relative href would
      // resolve against the DSH origin (srcdoc frames use the parent's base URL).
      a: (tagName, attribs) => {
        const out = { ...attribs, target: '_blank', rel: 'noreferrer noopener' }
        const href = String(attribs.href || '').trim()
        if (href && !/^(https?:\/\/|mailto:|#)/i.test(href)) delete out.href
        if (/^#/.test(href)) delete out.target
        return { tagName, attribs: out }
      },
      img: (tagName, attribs) => {
        const src = String(attribs.src || '')
        const out = { ...attribs }
        if (/^cid:/i.test(src)) {
          const key = src.slice(4).replace(/^<|>$/g, '')
          if (cid.has(key)) out.src = cid.get(key)
          else delete out.src
        } else if (/^data:image\//i.test(src)) {
          // keep inline data images
        } else if (/^https?:/i.test(src)) {
          if (!images) { blocked++; delete out.src; out['data-blocked-src'] = src }
        } else delete out.src
        return { tagName, attribs: out }
      },
    },
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src && !frame.attribs['data-blocked-src'],
  })
  return { html: clean, blocked }
}

/** CSS that strips url() loads from inline style unless images are allowed. */
function stripRemoteCss(html, images) {
  if (images) return html
  return html.replace(/url\(\s*(['"]?)\s*(https?:)?\/\/[^)]*\)/gi, 'none')
}

/** Wrap a sanitised body into the srcdoc document shown by the tab. */
export function mailDocument(html, { images = false, dark = false } = {}) {
  const imgSrc = images ? 'data: cid: https: http:' : 'data: cid:'
  const csp = "default-src 'none'; img-src " + imgSrc + "; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="' + csp + '">' +
    '<meta name="referrer" content="no-referrer"><base target="_blank">' +
    '<style>html,body{margin:0;padding:0}body{padding:4px 2px;font:14px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;word-wrap:break-word;overflow-wrap:anywhere' +
    (dark ? ';color:#e6e6e6;background:transparent' : '') + '}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}blockquote{margin:0 0 0 8px;padding-left:8px;border-left:2px solid #8884}</style>' +
    '</head><body>' + stripRemoteCss(html, images) + '</body></html>'
}

/** Plain text to safe HTML (for text-only messages shown in the same frame). */
export function textToHtml(text) {
  const esc = String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const linked = esc.replace(/\bhttps?:\/\/[^\s<>"']+/g, u => '<a href="' + u + '" target="_blank" rel="noreferrer noopener">' + u + '</a>')
  return '<pre style="white-space:pre-wrap;font:inherit;margin:0">' + linked + '</pre>'
}
