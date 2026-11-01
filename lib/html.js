/**
 * dsh-mail / html.js: make an HTML mail body safe to show.
 *
 * The body is sanitised on the server (sanitize-html allow-list: no scripts,
 * forms, iframes, objects or event handlers, only http(s)/mailto/cid/data
 * URLs) and wrapped in a document with a strict CSP. The tab shows it in a
 * sandboxed iframe without allow-scripts.
 *
 * The browser never contacts a host named in the mail:
 *   - remote images and CSS url() loads are blocked by default (src moved to
 *     data-blocked-src, url() replaced with none, @import removed) and the
 *     count is reported so the tab can offer "Load images";
 *   - "Load images" rewrites them to the signed same-origin image proxy
 *     (lib/remote.js), and the CSP allows images only from data:, cid: and
 *     the DSH origin itself; without a proxy rewriter they stay blocked;
 *   - http(s) links point at the signed same-origin link page, which shows the
 *     real destination and opens it with rel=noopener noreferrer.
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

const CSS_URL = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi

/**
 * Rewrite url(...) in CSS text: remote (http, https, protocol relative) loads
 * become the proxy URL when `img` is given, else `none`; @import is removed.
 * Returns { css, remote } with the count of remote loads seen.
 */
export function rewriteCss(css, img) {
  let remote = 0
  let out = String(css || '').replace(/@import[^;]*;?/gi, () => { remote++; return '' })
  out = out.replace(CSS_URL, (all, _q, raw) => {
    const u = String(raw).trim()
    if (/^data:image\//i.test(u)) return all
    let abs = null
    if (/^https?:\/\//i.test(u)) abs = u
    else if (/^\/\//.test(u)) abs = 'https:' + u
    if (!abs) { if (/^(cid:|#)/i.test(u)) return all; return 'none' }
    remote++
    if (!img) return 'none'
    return 'url("' + img(abs).replace(/"/g, '%22') + '")'
  })
  return { css: out, remote }
}

/**
 * @param {string} html raw HTML body
 * @param {object} o  { images: boolean (load remote images through the proxy),
 *                      cid: Map<cid, dataUri>,
 *                      proxy: { img(url) -> same-origin path, link(url) -> same-origin path } }
 * @returns {{ html: string, blocked: number }}
 */
export function sanitizeMailHtml(html, { images = false, cid = new Map(), proxy = null } = {}) {
  let blocked = 0
  const imgRewrite = images && proxy && typeof proxy.img === 'function' ? proxy.img : null
  const linkRewrite = proxy && typeof proxy.link === 'function' ? proxy.link : null
  const css = text => { const r = rewriteCss(text, imgRewrite); blocked += r.remote; return r.css }
  const clean = sanitizeHtml(String(html || ''), {
    allowedTags: TAGS,
    allowVulnerableTags: true, // <style> is kept for layout; its url() and @import are rewritten and the CSP blocks every other remote load
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
    allowProtocolRelative: false, // protocol-relative image URLs are turned into https below; such links are dropped
    disallowedTagsMode: 'discard',
    nonTextTags: ['script', 'textarea', 'option', 'noscript', 'title', 'head', 'iframe', 'object', 'embed', 'form', 'svg', 'math'],
    transformTags: {
      // Only absolute http(s)/mailto links and in-page anchors: a relative href would
      // resolve against the DSH origin (srcdoc frames use the parent's base URL).
      a: (tagName, attribs) => {
        const out = { ...attribs, target: '_blank', rel: 'noreferrer noopener' }
        let href = String(attribs.href || '').trim()
        if (/^https?:\/\//i.test(href)) out.href = linkRewrite ? linkRewrite(href) : href
        else if (/^mailto:/i.test(href)) out.href = href
        else if (/^#/.test(href)) { out.href = href; delete out.target }
        else delete out.href
        return { tagName, attribs: out }
      },
      img: (tagName, attribs) => {
        let src = String(attribs.src || '').trim()
        if (/^\/\//.test(src)) src = 'https:' + src
        const out = { ...attribs }
        if (/^cid:/i.test(src)) {
          const key = src.slice(4).replace(/^<|>$/g, '')
          if (cid.has(key)) out.src = cid.get(key)
          else delete out.src
        } else if (/^data:image\//i.test(src)) {
          // keep inline data images
        } else if (/^https?:/i.test(src)) {
          blocked++
          if (imgRewrite) out.src = imgRewrite(src)
          else { delete out.src; out['data-blocked-src'] = src }
        } else delete out.src
        return { tagName, attribs: out }
      },
      // Runs after the tag-specific transform above (sanitize-html applies both).
      '*': (tagName, attribs) => {
        if (!attribs.style) return { tagName, attribs }
        return { tagName, attribs: { ...attribs, style: css(attribs.style) } }
      },
    },
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src && !frame.attribs['data-blocked-src'],
  })
  // <style> text is emitted raw by sanitize-html (textFilter never sees it): rewrite its url() and @import here.
  const out = clean.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, a, b, c) => a + css(b) + c)
  return { html: out, blocked }
}

/** Wrap a sanitised body into the srcdoc document shown by the tab. */
export function mailDocument(html, { images = false, dark = false } = {}) {
  // With images the only extra source is the DSH origin itself (the signed image proxy); never a remote host.
  const imgSrc = images ? "data: cid: 'self'" : 'data: cid:'
  const csp = "default-src 'none'; img-src " + imgSrc + "; style-src 'unsafe-inline'; font-src data:; media-src 'none'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="' + csp + '">' +
    '<meta http-equiv="x-dns-prefetch-control" content="off">' +
    '<meta name="referrer" content="no-referrer"><base target="_blank">' +
    '<style>html,body{margin:0;padding:0}body{padding:4px 2px;font:14px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;word-wrap:break-word;overflow-wrap:anywhere' +
    (dark ? ';color:#e6e6e6;background:transparent' : '') + '}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}blockquote{margin:0 0 0 8px;padding-left:8px;border-left:2px solid #8884}</style>' +
    '</head><body>' + html + '</body></html>'
}

/** Plain text to safe HTML (for text-only messages shown in the same frame); links go through `link` when given. */
export function textToHtml(text, { link = null } = {}) {
  const esc = String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const attr = s => s.replace(/"/g, '&quot;')
  const linked = esc.replace(/\bhttps?:\/\/[^\s<>"']+/g, u => {
    const raw = u.replace(/&amp;/g, '&')
    const href = typeof link === 'function' ? link(raw) : raw
    return '<a href="' + attr(href.replace(/&/g, '&amp;')) + '" target="_blank" rel="noopener noreferrer">' + u + '</a>'
  })
  return '<pre style="white-space:pre-wrap;font:inherit;margin:0">' + linked + '</pre>'
}
