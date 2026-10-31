/**
 * dsh-mail / errors.js: the stable error catalog (prefix MAIL).
 *
 * Standard: docs/PLUGIN-DOCS-STANDARD.md of the DSH plugin set; the codes are
 * documented one by one in docs/ERRORS.md (a test keeps both in sync). Codes
 * are an API: add, never rename.
 *
 * Every HTTP error body and every failed agent tool result has the shape
 *   { ok:false, error, code, message, hint, docs }
 * `error` keeps the text older clients and agents read: most sites pass the
 * original text as `message`, so it is unchanged. Success results are not
 * touched.
 */

'use strict'

import { defineErrors } from './plugin-errors.js'

/** Generic redaction for text that reaches bodies and logs (callers also pass their own secret-aware scrubber first). */
export function genericScrub(s) {
  return String(s == null ? '' : s)
    .replace(/(\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1***@')
    .replace(/(authorization:\s*(?:bearer|basic)\s+)\S+/gi, '$1***')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, '$1 ***')
    .replace(/(AUTH\s+(?:PLAIN|LOGIN|XOAUTH2)\s+)\S+/gi, '$1***')
    .replace(/\b((?:password|passwd|secret|token|api[_-]?key|apikey)=)[^\s&]+/gi, '$1***')
}

export const E = defineErrors('MAIL', {
  // ── generic ──
  MAIL_INTERNAL: { status: 500, message: 'Unexpected error', hint: 'Find the log line that starts with MAIL_INTERNAL in the dsh web output and report it as a bug with the steps that led to it.' },
  MAIL_INVALID_INPUT: { status: 400, message: 'A tool argument or request field is missing or invalid', hint: 'Read the message: it names the field. Compare it with the tool description (or the route description in docs/TROUBLESHOOTING.md) and retry with a valid value.' },
  MAIL_OBJECT_NOT_FOUND: { status: 404, message: 'The draft, queue entry, message, thread or folder was not found', hint: 'List first (mail_draft list, mail_list_queue, mail_search, mail_folders) and use an id from the result; ids from an older session or another account do not resolve.' },
  MAIL_ROUTE_NOT_FOUND: { status: 404, legacy: 'not found', message: 'No such route', hint: 'Check the path against the routes listed in docs/TROUBLESHOOTING.md; an unknown path under the plugin prefix answers 404 while other plugin routes work.' },
  MAIL_METHOD_NOT_ALLOWED: { status: 405, legacy: 'method not allowed', message: 'Method not allowed', hint: 'Reads are GET, changes are POST with a JSON body.' },
  MAIL_SIZE_LIMIT: { status: 413, message: 'A size limit was exceeded', hint: 'Attachments are limited to 20 MB in total, a message to read or save to 25 MB, a request body to 256 KB (inbound webhook: 25 MB); shorten or split the content.' },
  MAIL_NOT_READY: { status: 503, message: 'The plugin is still starting', hint: 'The capability secret is created at start. Retry in a few seconds; if it persists check the data directory permissions (doctor check data-dir).' },
  MAIL_CONFIRM_REQUIRED: { status: 400, legacy: 'confirm: true required', message: 'This change needs confirm: true', hint: 'Repeat the request with "confirm": true after the human agreed.' },
  MAIL_SETTINGS_UNAVAILABLE: { status: 503, legacy: 'settings service unavailable', message: 'Settings cannot be saved on this install', hint: 'The host has no writable settings service for this plugin, or the DSH 0.2.x loader cannot see the plugin Config (it must be on the default export). See docs/TROUBLESHOOTING.md "Settings do not save" and run the doctor (checks settings and config).' },

  // ── route security gates ──
  MAIL_REQUEST_FORBIDDEN: { status: 403, message: 'The request was refused by the route security gate', hint: 'Open DSH through loopback or a host listed in the plugin setting trustedHosts. Cross-site requests, non-loopback peers and wrong methods or content types are refused.' },
  MAIL_TOKEN_INVALID: { status: 403, message: 'The capability token is missing, expired or wrong', hint: 'Reload the Mail tab: it mints a fresh token with GET /dsh-mail/api/session. Scripts must send it in the x-dsh-mail-token header.' },
  MAIL_SESSION_COOKIE_MISSING: { status: 403, message: 'No DSH browser-session cookie on a change request', hint: 'Make changes from the browser that is logged in to DSH. Only if you understand the risk, requireHarnessCookie: false lifts this layer.' },

  // ── accounts and permissions ──
  MAIL_NO_ACCOUNTS: { status: 400, message: 'No mail account is configured', hint: 'Add an account in Settings, Mail (or the gear in the Mail tab), enable Allow agents on it, then retry.' },
  MAIL_ACCOUNT_NOT_FOUND: { status: 404, message: 'The account is not configured', hint: 'Call mail_accounts for the valid ids. Old v0.1 provider ids only resolve while their legacy settings exist.' },
  MAIL_ACCOUNT_DISABLED: { status: 409, message: 'The account is disabled', hint: 'Enable the account in Settings, Mail.', },
  MAIL_AGENT_DENIED: { status: 403, message: 'The account does not allow this agent action', hint: 'Human: in the account editor tick Allow agents and the needed Can read / Can send / Can mass send boxes, or list the id in agents.allowedAccounts.' },
  MAIL_TOOLS_DISABLED: { status: 403, message: 'The mail agent tools are switched off', hint: 'Human: set agents.enabled to true in the plugin settings.' },
  MAIL_CAPABILITY_UNSUPPORTED: { status: 400, message: 'This account type cannot do that', hint: 'mail_accounts lists the capabilities of every account (read, send, folders, search). Use an account that has the capability.' },
  MAIL_ACCOUNT_INVALID: { status: 400, message: 'The account settings are invalid', hint: 'Fix the field named in the message: id format, host and port, plaintext only to loopback, OAuth client id, or the API base URL (https, or http to loopback only).' },
  MAIL_SECRET_MISSING: { status: 400, message: 'A required secret is not stored for the account', hint: 'Open the account in Settings, Mail and type the password, app password or API key again (Save), or point passwordFile / passwordEnv / apiKeyFile at a file you manage.' },

  // ── login and connection ──
  MAIL_ACCOUNT_AUTH_FAILED: { status: 401, message: 'The mail server refused the login', hint: 'Use an app password where the provider requires it (2-step verification), check the user name and the IMAP/SMTP host, port and TLS mode, then press Test connection in the account editor.' },
  MAIL_CONNECT_FAILED: { status: 502, message: 'The mail server could not be reached', hint: 'Check host, port and TLS mode (993/465 are TLS, 143/587 are STARTTLS), firewall and DNS from the DSH host; a self-signed certificate needs allowSelfSigned on that account.' },
  MAIL_MAILBOX_UNREACHABLE: { status: 502, message: 'The mailbox could not be read or synced', hint: 'Press Test connection for the account in Settings, Mail and read the failing step (the doctor row of the account shows the last sync status); for the hosted mailbox account type also check its base URL and service token.' },
  MAIL_IDLE_UNAVAILABLE: { status: 200, message: 'Instant new mail (IMAP IDLE) is not active for an account', hint: 'The account stays on polling (cache.pollSeconds). The server may not support IDLE, or the connection failed three times in a row; this is not data loss.' },

  // ── OAuth ──
  MAIL_OAUTH_REAUTH: { status: 401, message: 'The account must be connected again', hint: 'Human: Settings, Mail, open the account, press Connect (Reconnect) and finish the consent. A consent screen left in testing mode expires refresh tokens after 7 days.' },
  MAIL_OAUTH_FLOW_FAILED: { status: 400, message: 'The sign-in flow did not complete', hint: 'Press Connect again in the same browser session. If the provider returned no refresh token, remove the app from the account permissions at the provider and Connect again.' },
  MAIL_OAUTH_NOT_CONFIGURED: { status: 400, message: 'OAuth is not set up for this account', hint: 'Create your own OAuth client at the provider, paste its client id (and secret) into the account, Save, then Connect. The redirect URI must match your public DSH URL exactly (GET /dsh-mail/api/oauth/redirect-uri).' },

  // ── sending and guard rails ──
  MAIL_SEND_FAILED: { status: 502, message: 'The message could not be sent', hint: 'Read the message (it carries the server or provider answer), run Test connection for the account, and check the account limits and the audit log.' },
  MAIL_RATE_LIMITED: { status: 429, message: 'The per-account send limit was reached', hint: 'Wait retryAfterSec seconds, or raise limits.perMinute / limits.perDay for the account (0 = no limit).' },
  MAIL_TOO_MANY_RECIPIENTS: { status: 400, message: 'Too many recipients', hint: 'Split the send, or raise the account limit limits.maxRecipients and the plugin setting maxRecipients.' },
  MAIL_UNSUBSCRIBE_REQUIRED: { status: 400, message: 'A mass send to this many recipients needs an unsubscribe address', hint: 'Configure unsubscribe.mailto or unsubscribe.publicBaseUrl in the plugin settings, or pass unsubscribe: "mailto:..." and/or "https://..." to the tool. Accounts that cannot set headers (hosted mailbox, AgentMail) cannot do mass sends above the threshold.' },
  MAIL_UNSUBSCRIBE_NOT_PUBLIC: { status: 200, message: 'One-click unsubscribe links are not published', hint: 'Set unsubscribe.publicBaseUrl (https) and expose only /dsh-mail-unsub/* without login; without it only the mailto unsubscribe is offered.' },
  MAIL_STORE_FULL: { status: 409, message: 'The queue or the draft store is full', hint: 'Cancel or delete old queue entries or drafts, then retry.' },
  MAIL_QUEUE_CONFLICT: { status: 409, message: 'The queue entry is in a state that does not allow this', hint: 'List the queue and check the status: an entry that is sending, sent or cancelled cannot be sent or cancelled again.' },
  MAIL_OUTBOX_GONE: { status: 404, legacy: 'already sent or unknown', message: 'The held message was already sent or is unknown', hint: 'Undo only works inside the undo window (compose.undoSendSec) and a dsh web restart in that window drops the held message; check the Sent folder.' },

  // ── inbound webhook and storage (log and doctor) ──
  MAIL_INBOUND_REJECTED: { status: 400, message: 'An inbound webhook request was rejected', hint: 'Check the SendGrid Inbound Parse destination: raw full MIME, the per-account path secret, the 25 MB cap. Unknown account, disabled inbound and wrong secret deliberately look the same (404).' },
  MAIL_DATA_PERMISSIONS: { status: 500, message: 'The data directory or a secrets file has loose permissions', hint: 'Run chmod 700 on the plugin data directory and chmod 600 on secrets.json, capability.secret, tokens.enc and settings.json.' },
  MAIL_CACHE_UNAVAILABLE: { status: 500, message: 'The local mail cache could not be opened', hint: 'The cache is rebuildable: move cache.db aside and press Sync. Without node:sqlite (Node 22.5 or newer) an in-memory cache is used and lost at restart.' },
}, { scrub: genericScrub })

/** Ordered message rules for errors thrown deep inside the plugin: [regex, code]. First match wins. */
const RULES = [
  [/not permitted for agents/i, 'MAIL_AGENT_DENIED'],
  [/\bis disabled\b/i, 'MAIL_ACCOUNT_DISABLED'],
  [/too many recipients/i, 'MAIL_TOO_MANY_RECIPIENTS'],
  [/need an unsubscribe|cannot set List-Unsubscribe/i, 'MAIL_UNSUBSCRIBE_REQUIRED'],
  [/queue already holds|too many drafts/i, 'MAIL_STORE_FULL'],
  [/being sent right now|already sent|was sent|not scheduled any more|cannot cancel/i, 'MAIL_QUEUE_CONFLICT'],
  [/authenticationfailed|authentication failed|auth(?:entication)? (?:rejected|unsuccessful)|invalid credentials|login failed|username and password not accepted|bad credentials|\b53[45]\b.*(?:auth|credential|password)|-ERR.*(?:auth|login|password|credential)/i, 'MAIL_ACCOUNT_AUTH_FAILED'],
  [/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH|timed out|self[- ]signed|certificate|wrong version number|socket hang up|greeting|unreachable|not connected/i, 'MAIL_CONNECT_FAILED'],
  [/larger than 25 MB|exceeds? \d+ ?(?:MB|bytes)|body too large|too large/i, 'MAIL_SIZE_LIMIT'],
  [/is not configured|unknown account|no accounts configured/i, 'MAIL_ACCOUNT_NOT_FOUND'],
  [/cannot read mail|cannot send$|cannot send\b|has no server folders|has no raw|no conversations|does not support|need a |needs a|only offered|available for Google|moves to inbox|special folders|no server folders/i, 'MAIL_CAPABILITY_UNSUPPORTED'],
  [/not found|no longer on|^no (?:queue entry|draft|folder|thread)|no such/i, 'MAIL_OBJECT_NOT_FOUND'],
  [/^invalid |op must be|required|must not contain|must be a mailto|already exists|no recipient|no From address|cannot be deleted|immutable/i, 'MAIL_INVALID_INPUT'],
]

/**
 * Decide the catalog code for something that was thrown. Returns
 * { code, extra } where extra carries structured fields (retryAfterSec,
 * oauthCode). `fallback` is the code for the context when nothing matches.
 */
export function classify(err, fallback = 'MAIL_INTERNAL') {
  const text = String(err && err.message ? err.message : err == null ? '' : err)
  if (err && typeof err.code === 'string' && E.has(err.code)) return { code: err.code, extra: {} }
  if (err && err.code === 'rate_limit') return { code: 'MAIL_RATE_LIMITED', extra: { retryAfterSec: err.retryAfterSec } }
  if (err && typeof err.code === 'string' && /^[a-z][a-z0-9_]*$/.test(err.code)) {
    const oc = err.code
    const extra = { oauthCode: oc }
    if (oc === 'invalid_grant' && /authorization code was refused/i.test(text)) return { code: 'MAIL_OAUTH_FLOW_FAILED', extra }
    if (oc === 'not_connected' || oc === 'needs_reauth' || oc === 'invalid_grant') return { code: 'MAIL_OAUTH_REAUTH', extra }
    if (oc === 'bad_state' || oc === 'expired_state' || oc === 'replayed_state') return { code: 'MAIL_OAUTH_FLOW_FAILED', extra }
    if (oc === 'network') return { code: 'MAIL_CONNECT_FAILED', extra }
    if (oc === 'invalid_client' || oc === 'unauthorized_client' || oc === 'redirect_uri_mismatch' || oc === 'invalid_request') return { code: 'MAIL_OAUTH_NOT_CONFIGURED', extra }
    if (oc === 'oauth_error') {
      if (/save the account first|does not use OAuth2|set the client id|only offered for Microsoft|Google and Microsoft accounts only/i.test(text)) return { code: 'MAIL_OAUTH_NOT_CONFIGURED', extra }
      return { code: 'MAIL_OAUTH_FLOW_FAILED', extra }
    }
    if (/^(?:access_denied|consent_required|interaction_required|http_\d+)$/.test(oc)) return { code: 'MAIL_OAUTH_FLOW_FAILED', extra }
  }
  if (err && err.authenticationFailed) return { code: 'MAIL_ACCOUNT_AUTH_FAILED', extra: {} }
  for (const [re, code] of RULES) if (re.test(text)) return { code, extra: {} }
  if (err && typeof err.code === 'string' && /^(ECONN|ENOTFOUND|EAI_|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE)/.test(err.code)) return { code: 'MAIL_CONNECT_FAILED', extra: {} }
  return { code: fallback, extra: {} }
}

/** Agent tool failure from a thrown error. `scrub` is the plugin's secret-aware scrubber; the original text stays the `error` field. */
export function toolFail(err, fallback, scrub, extra = {}) {
  const c = classify(err, fallback)
  const raw = String(err && err.message ? err.message : err == null ? '' : err)
  return E.tool(c.code, { message: scrub ? scrub(raw) : raw, ...c.extra, ...extra })
}

/** Gate reason (lib/security.js) to a code. The gate reason text stays the `error`. */
export function gateCode(g) {
  if (g.layer === 'L3') return /no per-install secret/.test(g.reason) ? 'MAIL_NOT_READY' : 'MAIL_TOKEN_INVALID'
  if (g.layer === 'L4') return 'MAIL_SESSION_COOKIE_MISSING'
  if (g.status === 405) return 'MAIL_METHOD_NOT_ALLOWED'
  return 'MAIL_REQUEST_FORBIDDEN'
}
