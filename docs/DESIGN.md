# dsh-mail design notes (v0.2, phase 1 of v2)

## Halves

- **Host half** (`lib/`, Node ESM): settings, the account model, mail access,
  the cache, HTTP routes under `/dsh-mail/api`, timers and the agent tools.
- **Browser half** (`src/*.jsx`, bundled by `scripts/build.mjs` into
  `lib/client.js`): the Mail sidebar tab (dsh-better-sidebar) and the "Mail"
  section of DSH Settings (`settings.section` slot). The build verifies the
  bundle through a stub ModuleLoader (exports `apply` + `inject`, no
  `@deepseek-ai/*` values, size budget 120 KB) before replacing the live file.

## Settings

`lib/settings-store.js` is the only module that reads or writes settings.
With `ctx.settings.register` (DSH 0.1.x) it registers the schemastery schema
at `dsh-mail` (live). Without it (DSH 0.2.x) it layers DEFAULTS, the old
`dsh-mail` block of `settings.yaml` or `settings.yaml.imported`, the cordis
row config (volatile references unwrapped) and `<data dir>/settings.json`
(0600). Writes go through the gated `POST /settings` and `/accounts/*` routes
in both modes.

## Accounts

`lib/accounts.js` normalises `accounts[]`, validates them, derives
capabilities, redacts secrets (`__set__`) and merges them back on save. The
legacy shim turns v0.1 provider settings into virtual accounts (ids = old
provider ids, `legacyProvider` + `legacyCreds` keep the v0.1 transport).
`effectiveConfirmMode` returns the explicit `agents.confirmMode`, else
`reply-only` for installs that only have virtual accounts, else `all`.

## Mail access

`lib/service.js` dispatches by `receiveKind`: `imap` (imapflow with a pooled,
serialised connection per account), `pop3` (`lib/pop3.js`), `tzekos`
(webmail agent API), `provider` (AgentMail or the v0.1 tzmail cookie login).
Message ids are `account:folder:uid`. Sending: SMTP accounts compose once
(MailComposer), deliver, and append the same bytes to Sent (except Gmail);
API accounts use `lib/providers.js`; Tzekos Mail uses the agent API.

## Cache

`lib/cache.js` uses `node:sqlite` (`~/.dsh/mail/cache.db`, 0600) with tables
`folders`, `messages`, `threads`, `meta`; an in-memory backend with the same
API is used when `node:sqlite` is missing. Folder sync: UIDVALIDITY check
(drop on change), initial `SEARCH SINCE` window capped to the newest N, then
`maxUid+1:*`; flags and expunges are refreshed for the cached UID range.
Snippets come from the first 6 KB of each message. Threads: References and
In-Reply-To, then normalised subject for replies within 60 days. Bodies are
cached as text only, on open; the retention job prunes them hourly.

## Routes

Reads (`GET /session`, `/state`, `/accounts`, `/folders`, `/messages`,
`/thread`, `/message`, `/attachment`, `/events`) pass `checkReadRequest`;
every `POST` passes `checkMutateRequest` (token, same-origin, cookie). The
v0.1 `PUT /settings` (CSRF header only) is gone. Errors are scrubbed of every
known secret value.

## Review queue

`lib/staging.js` keeps queue entries as JSON files. The timer sends only
`scheduled` entries whose time has come; `queued` entries wait for the tab.
Agent drafts live in `lib/drafts.js` and show up in the same pane.

## OAuth2 (phase 2)

`lib/oauth.js` builds the authorization URL (code + PKCE S256), signs the
`state` (HMAC with the capability secret: account, nonce, verifier hash,
cookie fingerprint, 10 min expiry) and keeps the verifier in an in-memory
`FlowStore` keyed by the nonce, consumed once. `GET /oauth/callback` is the
only route reachable after a cross-site redirect: it checks the loopback peer
and the Host, then serves a static page (nonce CSP, no referrer) that posts
code + state to `POST /oauth/complete`, which passes the full mutate gate and
compares the harness cookie fingerprint with the one signed into the state.
`lib/tokens.js` stores tokens AES-256-GCM encrypted (HKDF-SHA256 key from the
capability secret) and refreshes per account and purpose (`mail`, Microsoft
`graph`) single-flight, 120 s before expiry; `invalid_grant` sets
`needsReauth`. IMAP and SMTP use XOAUTH2 through imapflow and nodemailer;
Microsoft accounts fall back to Graph `sendMail` with the MIME message when
SMTP AUTH is refused (send mode `auto`) or always (`graph`). The device code
flow polls in the background and is visible through `GET /oauth/status`.

## Unsubscribe, push, search and compose (phase 4)

`lib/unsub.js` signs per-recipient tokens (HKDF key from the capability
secret, info "dsh-mail unsubscribe v1"; payload account, list, campaign,
128-bit recipient hash). Campaign records (`campaigns/c-*.json`, 0600) hold the
hash to address map and never leave the host. The public page handler is
pure apart from the suppression writes, so the DSH route and the optional
listener share it; the client key for the rate limiter is the first
X-Forwarded-For hop (the edge) or the peer. Unsubscribe replies are found in
the rows that a sync adds (`onNewMessages`), deduplicated through a persisted
seen set. `lib/idle.js` keeps one IDLE connection per push account outside
the pool; an EXISTS triggers a forced sync. Sync now issues NOOP and always
asks `maxUid+1:*`, because a pooled connection that keeps INBOX selected has
a stale UIDNEXT (found by the IDLE test; it also affected the background
poll). The cache keeps an FTS5 table in step with every write. Undo send holds
the send closure in memory (`lib/outbox.js`).
