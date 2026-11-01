# Error codes: dsh-mail

Every HTTP error body and every failed tool result has this shape:

```json
{ "ok": false, "error": "account work not permitted for agents", "code": "MAIL_AGENT_DENIED",
  "message": "account work not permitted for agents", "hint": "Human: in the account editor tick Allow agents ...",
  "docs": "docs/ERRORS.md#mail_agent_denied" }
```

`error` keeps the short text that earlier versions returned (clients and agents may parse it); `code`, `message`, `hint` and `docs` are additive. A few results carry extra fields: `retryAfterSec` (rate limit), `layer` (security gate layer L1 to L4) and `oauthCode` (the provider or flow code that older versions returned as `code` on the OAuth routes). Success results are unchanged. Log lines start with the code (`grep MAIL_SEND_FAILED`). Codes never change meaning; new ones are added. Statuses of the routes are unchanged from earlier versions: where a table row shows a status that differs from the one a route answers, the route status wins (the catalog value is a default).

Troubleshooting entries are in [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

| Code | HTTP | Where it appears | Meaning | Agent action |
|---|---|---|---|---|
| MAIL_INTERNAL | 500 | log, any route, any tool | An unexpected exception that no rule recognised. | Read the log line that starts with MAIL_INTERNAL (it carries the scrubbed exception text), note the request or tool call that caused it, repeat once to see if it is stable, then report it as a bug ([details](#mail_internal)) |
| MAIL_INVALID_INPUT | 400 | tools (all), routes (400) | A required argument is missing or malformed (ids, action, CSV, dates, folder names, addresses, unsubscribe value). | Read `message`, correct that argument against the tool description, retry ([details](#mail_invalid_input)) |
| MAIL_OBJECT_NOT_FOUND | 404 | tools mail_send, mail_draft, mail_cancel, mail_thread, mail_reply, mail_triage; routes /queue/*, /drafts/*, /accounts/remove | The draft, queue entry, thread, message or folder id does not exist (any more). | List first (mail_draft list, mail_list_queue, mail_search) and use an id from the result ([details](#mail_object_not_found)) |
| MAIL_ROUTE_NOT_FOUND | 404 | route (any unknown GET path under the plugin prefix) | The path is not one of the plugin routes. | Compare the path with the route list in README; a 404 on every plugin route is a load problem instead (see C2) ([details](#mail_route_not_found)) |
| MAIL_METHOD_NOT_ALLOWED | 405 | route (non-GET on a read path, non-POST on a change path) | The HTTP method is not allowed for this route. | Use GET for reads and POST with a JSON body for changes ([details](#mail_method_not_allowed)) |
| MAIL_SIZE_LIMIT | 413 | tools mail_fetch, mail_attachments, mail_send; routes /send, any POST body | An attachment total (20 MB), a message or attachment read (25 MB), a request body (256 KB) or a queue entry is too large. | Shorten or split the content, send big files by link, or save the attachment with mail_attachments instead of fetching it inline ([details](#mail_size_limit)) |
| MAIL_NOT_READY | 503 | route /session and every change route, log, doctor check plugin | The plugin has not finished creating its capability secret. | Retry in a few seconds ([details](#mail_not_ready)) |
| MAIL_CONFIRM_REQUIRED | 400 | route POST /accounts/convert | The one-time conversion of legacy settings only runs with "confirm": true. | Do not set it yourself: ask the human, then repeat with confirm true ([details](#mail_confirm_required)) |
| MAIL_SETTINGS_UNAVAILABLE | 503 | routes POST /settings, /accounts/save, /accounts/remove, /accounts/convert; doctor checks settings, config | Settings cannot be written: no settings service, no loader row for this plugin, or (DSH 0.2.x) the loader does not see the plugin Config. | Run the doctor and read checks settings and config, then follow the TROUBLESHOOTING entry ([details](#mail_settings_unavailable)) |
| MAIL_REQUEST_FORBIDDEN | 403 | every route (read and change gates) | The route security gate refused the request: non-loopback peer, untrusted Host, cross-site fetch, wrong method or content type, or an Origin that does not match. | Call from the DSH host (loopback) through the web UI, or add the public host name to the plugin setting trustedHosts; change calls must come from the browser tab ([details](#mail_request_forbidden)) |
| MAIL_TOKEN_INVALID | 403 | every change route (POST) | The capability token (x-dsh-mail-token) is missing, malformed, expired (15 minutes) or signed with another secret. | Reload the Mail tab, or fetch a token with GET session and send it as x-dsh-mail-token, then retry ([details](#mail_token_invalid)) |
| MAIL_SESSION_COOKIE_MISSING | 403 | every change route (POST) | The DSH browser-session cookie is not on the request. | Make the change from the logged-in browser tab ([details](#mail_session_cookie_missing)) |
| MAIL_NO_ACCOUNTS | 400 | tools (all with an account), doctor check accounts | No mail account is configured, or none is usable for the requested action. | Call mail_accounts ([details](#mail_no_accounts)) |
| MAIL_ACCOUNT_NOT_FOUND | 404 | tools (account argument), route /send, /accounts/test | The account or provider id does not exist. | Call mail_accounts and use an id from it ([details](#mail_account_not_found)) |
| MAIL_ACCOUNT_DISABLED | 409 | tools (account argument), send paths, doctor check account:<id> (info) | The account exists but is switched off. | Choose another account, or ask the human to enable it ([details](#mail_account_disabled)) |
| MAIL_AGENT_DENIED | 403 | tools (all), mail_folders create and rename | The account is not permitted for agents or for this action (read, send, mass send, manage folders). | Do not try other accounts to get around it ([details](#mail_agent_denied)) |
| MAIL_TOOLS_DISABLED | 403 | tools (all), doctor check agents | agents.enabled is false: the mail tools refuse to work. | Ask the human to set agents.enabled to true; it applies without a restart for tools already registered ([details](#mail_tools_disabled)) |
| MAIL_CAPABILITY_UNSUPPORTED | 400 | tools mail_read, mail_fetch, mail_inbox, mail_contacts, mail_remind, mail_folders | The account type cannot do this (for example folders on a send-only API account, contacts on a non-webmail account). | mail_accounts shows the capabilities per account (read, send, folders, search); pick an account that has it ([details](#mail_capability_unsupported)) |
| MAIL_ACCOUNT_INVALID | 400 | routes POST /accounts/save, /accounts/test | The account form failed validation. | Read `message`: it lists every failing field ([details](#mail_account_invalid)) |
| MAIL_SECRET_MISSING | 400 | doctor check account:<id> | The account has no password, app password or API key stored or resolvable. | Do not look for the value ([details](#mail_secret_missing)) |
| MAIL_ACCOUNT_AUTH_FAILED | 401 | tools mail_read, mail_send, mail_inbox and others, routes /accounts/test, /sync, /folders, log, doctor check account:<id> (last sync) | The IMAP, POP3, SMTP or API server refused the credentials. | Run Test connection (route /accounts/test) and read which step failed (IMAP login, SMTP verify) ([details](#mail_account_auth_failed)) |
| MAIL_CONNECT_FAILED | 502 | tools and routes that reach a mail server, log, doctor check account:<id> (last sync) | The server could not be reached or the TLS handshake failed. | Run Test connection and compare host, port and security with the provider preset; from the DSH host run the openssl or nc check in the TROUBLESHOOTING entry ([details](#mail_connect_failed)) |
| MAIL_MAILBOX_UNREACHABLE | 502 | tools mail_inbox, mail_thread, mail_read, mail_fetch, mail_search, mail_mark, mail_move, mail_folders, routes /folders, /messages, /thread, /message, /sync, log (background sync), doctor check account:<id> | Reading or syncing a mailbox failed for a reason that is not a login or connection error. | Read `message`, then Test connection for the account; the doctor row shows the last sync status ([details](#mail_mailbox_unreachable)) |
| MAIL_IDLE_UNAVAILABLE | n/a | log, doctor check idle | Instant new mail (IMAP IDLE) is not active for an account. | Nothing breaks: new mail arrives at the poll interval (cache.pollSeconds, default 300 s) ([details](#mail_idle_unavailable)) |
| MAIL_OAUTH_REAUTH | 401 | tools and routes that use an OAuth account, doctor check account:<id>, UI banner "Reconnect" | The account has no valid OAuth connection: never connected, refresh token revoked or expired, or the OAuth client was changed. | Check the doctor row (needsReauth) ([details](#mail_oauth_reauth)) |
| MAIL_OAUTH_FLOW_FAILED | 400 | routes POST /oauth/start, /oauth/complete, /oauth/device/start | The sign-in flow did not complete. | Press Connect again in the same browser ([details](#mail_oauth_flow_failed)) |
| MAIL_OAUTH_NOT_CONFIGURED | 400 | routes POST /oauth/start, /oauth/device/start, /oauth/complete | OAuth cannot start: the account is unsaved, does not use OAuth, has no client id, or the provider rejected the client. | Read GET /oauth/redirect-uri for the exact URI, register it at the provider, paste the client id, Save, then Connect ([details](#mail_oauth_not_configured)) |
| MAIL_SEND_FAILED | 502 | tools mail_send, mail_mass_send, mail_send_later, mail_reply, mail_forward, routes /send, /queue/send, /drafts/send, log, doctor check queue (info, failed entries) | The message could not be delivered by the server or provider. | Read `message`, check the audit log (GET /audit) and the account limits, run Test connection ([details](#mail_send_failed)) |
| MAIL_RATE_LIMITED | 429 | tools mail_send, mail_forward, mail_mass_send, routes /send, log | The per-account limit (limits.perMinute or limits.perDay) was reached. | Wait `retryAfterSec` seconds (it is in the result) and retry once ([details](#mail_rate_limited)) |
| MAIL_TOO_MANY_RECIPIENTS | 400 | tools mail_send, mail_mass_send, route /send | The recipient count is over the per-account limit (limits.maxRecipients) or the plugin setting maxRecipients. | Split the batch, or ask the human to raise the limit ([details](#mail_too_many_recipients)) |
| MAIL_UNSUBSCRIBE_REQUIRED | 400 | tools mail_mass_send, queue send of a mass entry | A mass send above mass.unsubscribeAbove (default 50) recipients has no unsubscribe address, or the account cannot set headers. | Pass unsubscribe: "mailto:..." and/or "https://...", or ask the human to configure unsubscribe.mailto or unsubscribe.publicBaseUrl; or pick an SMTP, Lettermint, Resend or SendGrid account ([details](#mail_unsubscribe_required)) |
| MAIL_UNSUBSCRIBE_NOT_PUBLIC | n/a | doctor check unsubscribe | One-click unsubscribe links are not published: unsubscribe.publicBaseUrl is empty, or the optional listener is misconfigured (non-loopback listenHost, or listenPort set but nothing listens). | Information only ([details](#mail_unsubscribe_not_public)) |
| MAIL_STORE_FULL | 409 | tools mail_send_later, mail_draft, mail_mass_send (staging), routes /queue, /drafts/save | The queue or the draft store holds its maximum. | List the queue and drafts, cancel or delete stale entries (ask the human first for entries it did not create), retry ([details](#mail_store_full)) |
| MAIL_QUEUE_CONFLICT | 409 | tools mail_cancel, routes /queue/send, /queue/approve, /queue/cancel, /queue/delete | The queue entry is in a state that does not allow the action. | List the queue and read the status; act only on queued, scheduled or failed entries ([details](#mail_queue_conflict)) |
| MAIL_OUTBOX_GONE | 404 | route POST /outbox/cancel | Undo send came too late or the held message is unknown. | Check the Sent folder and the Drafts: if the message is in neither, it was dropped by a restart and must be composed again ([details](#mail_outbox_gone)) |
| MAIL_INBOUND_REJECTED | 400 | log (route POST /inbound/sendgrid/<account>) | An inbound webhook body could not be parsed or was too large. | Read the log line, then check the SendGrid destination settings ([details](#mail_inbound_rejected)) |
| MAIL_DATA_PERMISSIONS | 500 | doctor checks data-dir, secrets-files | The data directory is not mode 0700 or a secrets file is not mode 0600. | Do not print the files ([details](#mail_data_permissions)) |
| MAIL_CACHE_UNAVAILABLE | 500 | doctor check cache | The local mail cache (cache.db) cannot be opened, or SQLite is unavailable and an in-memory cache is used. | The cache is rebuildable ([details](#mail_cache_unavailable)) |

### MAIL_INTERNAL
- **Meaning:** An unexpected exception that no rule recognised.
- **Where:** log, any route, any tool.
- **Likely causes:** A bug, or a situation the plugin does not classify yet.
- **Agent action:** Read the log line that starts with MAIL_INTERNAL (it carries the scrubbed exception text), note the request or tool call that caused it, repeat once to see if it is stable, then report it as a bug.
- **Needs the human:** No
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-no-new-mail)

### MAIL_INVALID_INPUT
- **Meaning:** A required argument is missing or malformed (ids, action, CSV, dates, folder names, addresses, unsubscribe value).
- **Where:** tools (all), routes (400).
- **Likely causes:** Wrong argument name or shape, an id from another account, an unsupported action word.
- **Agent action:** Read `message`, correct that argument against the tool description, retry. Never retry unchanged.
- **Needs the human:** No
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-send-refused)

### MAIL_OBJECT_NOT_FOUND
- **Meaning:** The draft, queue entry, thread, message or folder id does not exist (any more).
- **Where:** tools mail_send, mail_draft, mail_cancel, mail_thread, mail_reply, mail_triage; routes /queue/*, /drafts/*, /accounts/remove.
- **Likely causes:** The draft was sent or deleted, the id belongs to another account, the cache was wiped, or the id was typed from memory.
- **Agent action:** List first (mail_draft list, mail_list_queue, mail_search) and use an id from the result.
- **Needs the human:** No
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-drafts-duplicate)

### MAIL_ROUTE_NOT_FOUND
- **Meaning:** The path is not one of the plugin routes.
- **Where:** route (any unknown GET path under the plugin prefix). Legacy `error` text: `not found`.
- **Likely causes:** A typo, an old client calling a removed route, or a reverse proxy rewriting the path.
- **Agent action:** Compare the path with the route list in README; a 404 on every plugin route is a load problem instead (see C2).
- **Needs the human:** No
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#c2-route-404)

### MAIL_METHOD_NOT_ALLOWED
- **Meaning:** The HTTP method is not allowed for this route.
- **Where:** route (non-GET on a read path, non-POST on a change path). Legacy `error` text: `method not allowed`.
- **Likely causes:** A script used PUT or DELETE, or POST on a read route.
- **Agent action:** Use GET for reads and POST with a JSON body for changes.
- **Needs the human:** No
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-route-403)

### MAIL_SIZE_LIMIT
- **Meaning:** An attachment total (20 MB), a message or attachment read (25 MB), a request body (256 KB) or a queue entry is too large.
- **Where:** tools mail_fetch, mail_attachments, mail_send; routes /send, any POST body.
- **Likely causes:** A big attachment, a huge pasted body, a CSV that is too large.
- **Agent action:** Shorten or split the content, send big files by link, or save the attachment with mail_attachments instead of fetching it inline.
- **Needs the human:** No
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-send-refused)

### MAIL_NOT_READY
- **Meaning:** The plugin has not finished creating its capability secret.
- **Where:** route /session and every change route, log, doctor check plugin.
- **Likely causes:** The call came in the first seconds after start, or the data directory is not writable so the secret file cannot be created.
- **Agent action:** Retry in a few seconds. If it persists run the doctor (check data-dir) and read the log line.
- **Needs the human:** Only if the data directory permissions must be fixed
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-data-files)

### MAIL_CONFIRM_REQUIRED
- **Meaning:** The one-time conversion of legacy settings only runs with "confirm": true.
- **Where:** route POST /accounts/convert. Legacy `error` text: `confirm: true required`.
- **Likely causes:** The request omitted the confirmation.
- **Agent action:** Do not set it yourself: ask the human, then repeat with confirm true.
- **Needs the human:** Yes: converting rewrites settings (a backup is written first)
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-settings-not-saved)

### MAIL_SETTINGS_UNAVAILABLE
- **Meaning:** Settings cannot be written: no settings service, no loader row for this plugin, or (DSH 0.2.x) the loader does not see the plugin Config.
- **Where:** routes POST /settings, /accounts/save, /accounts/remove, /accounts/convert; doctor checks settings, config. Legacy `error` text: `settings service unavailable`.
- **Likely causes:** DSH 0.2.x with an old plugin build whose Config is not on the default export, a profile row missing, or a host without a settings service.
- **Agent action:** Run the doctor and read checks settings and config, then follow the TROUBLESHOOTING entry.
- **Needs the human:** Yes if a restart or a profile row edit is needed
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-settings-not-saved)

### MAIL_REQUEST_FORBIDDEN
- **Meaning:** The route security gate refused the request: non-loopback peer, untrusted Host, cross-site fetch, wrong method or content type, or an Origin that does not match.
- **Where:** every route (read and change gates).
- **Likely causes:** A script or proxy calling from another machine, a public hostname not listed in trustedHosts, a missing Origin or sec-fetch-site header.
- **Agent action:** Call from the DSH host (loopback) through the web UI, or add the public host name to the plugin setting trustedHosts; change calls must come from the browser tab.
- **Needs the human:** Yes for trustedHosts or proxy changes
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-route-403)

### MAIL_TOKEN_INVALID
- **Meaning:** The capability token (x-dsh-mail-token) is missing, malformed, expired (15 minutes) or signed with another secret.
- **Where:** every change route (POST).
- **Likely causes:** The tab stayed open for hours, the plugin restarted (a new secret), or a script has no token.
- **Agent action:** Reload the Mail tab, or fetch a token with GET session and send it as x-dsh-mail-token, then retry.
- **Needs the human:** No
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-route-403)

### MAIL_SESSION_COOKIE_MISSING
- **Meaning:** The DSH browser-session cookie is not on the request.
- **Where:** every change route (POST).
- **Likely causes:** A script, curl, or a browser profile that is not logged in to DSH.
- **Agent action:** Make the change from the logged-in browser tab. Do not disable requireHarnessCookie on your own.
- **Needs the human:** Yes
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-route-403)

### MAIL_NO_ACCOUNTS
- **Meaning:** No mail account is configured, or none is usable for the requested action.
- **Where:** tools (all with an account), doctor check accounts.
- **Likely causes:** A fresh install, every account removed, or settings not readable on this DSH line.
- **Agent action:** Call mail_accounts. If the list is empty ask the human to add an account in Settings, Mail.
- **Needs the human:** Yes
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-agent-denied)

### MAIL_ACCOUNT_NOT_FOUND
- **Meaning:** The account or provider id does not exist.
- **Where:** tools (account argument), route /send, /accounts/test.
- **Likely causes:** A typo, an account that was removed, or an old v0.1 provider id whose legacy settings were converted away.
- **Agent action:** Call mail_accounts and use an id from it.
- **Needs the human:** No
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-agent-denied)

### MAIL_ACCOUNT_DISABLED
- **Meaning:** The account exists but is switched off.
- **Where:** tools (account argument), send paths, doctor check account:<id> (info).
- **Likely causes:** Enabled is off in the account editor.
- **Agent action:** Choose another account, or ask the human to enable it.
- **Needs the human:** Yes to enable
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-agent-denied)

### MAIL_AGENT_DENIED
- **Meaning:** The account is not permitted for agents or for this action (read, send, mass send, manage folders).
- **Where:** tools (all), mail_folders create and rename.
- **Likely causes:** New accounts start with Allow agents off; canRead, canSend, canMass and canManageFolders narrow it; agents.allowedAccounts restricts globally.
- **Agent action:** Do not try other accounts to get around it. Tell the human which permission is missing.
- **Needs the human:** Yes: account editor, Allow agents and the specific box
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-agent-denied)

### MAIL_TOOLS_DISABLED
- **Meaning:** agents.enabled is false: the mail tools refuse to work.
- **Where:** tools (all), doctor check agents.
- **Likely causes:** The plugin setting agents.enabled was switched off.
- **Agent action:** Ask the human to set agents.enabled to true; it applies without a restart for tools already registered.
- **Needs the human:** Yes
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-agent-denied)

### MAIL_CAPABILITY_UNSUPPORTED
- **Meaning:** The account type cannot do this (for example folders on a send-only API account, contacts on a non-webmail account).
- **Where:** tools mail_read, mail_fetch, mail_inbox, mail_contacts, mail_remind, mail_folders.
- **Likely causes:** An API-only account (Lettermint, Resend, SendGrid without inbound) used for reading, a POP3 account used for server folders.
- **Agent action:** mail_accounts shows the capabilities per account (read, send, folders, search); pick an account that has it.
- **Needs the human:** No
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-agent-denied)

### MAIL_ACCOUNT_INVALID
- **Meaning:** The account form failed validation.
- **Where:** routes POST /accounts/save, /accounts/test.
- **Likely causes:** An id outside [a-z0-9-]{2,32}, a duplicate id, a missing host or port, plaintext to a non-loopback host, OAuth without a client id, an OAuth URL or API base URL that is not https (or http to loopback), a link-local or credential-carrying API base URL.
- **Agent action:** Read `message`: it lists every failing field. Fix the field (see the API base URL entry for the URL rule) and save again.
- **Needs the human:** No
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-api-base-url)

### MAIL_SECRET_MISSING
- **Meaning:** The account has no password, app password or API key stored or resolvable.
- **Where:** doctor check account:<id>.
- **Likely causes:** Secrets live in secrets.json (never in settings); the file was moved, the account was created on another machine, or passwordFile/passwordEnv points at nothing.
- **Agent action:** Do not look for the value. Ask the human to type it again in the account editor and Save, or fix the file or variable the account points at.
- **Needs the human:** Yes
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-login-failed)

### MAIL_ACCOUNT_AUTH_FAILED
- **Meaning:** The IMAP, POP3, SMTP or API server refused the credentials.
- **Where:** tools mail_read, mail_send, mail_inbox and others, routes /accounts/test, /sync, /folders, log, doctor check account:<id> (last sync).
- **Likely causes:** A normal password where an app password is required (2-step verification), a revoked app password, a wrong user name (full address vs local part), IMAP access not enabled at the provider, a wrong host so another server answered.
- **Agent action:** Run Test connection (route /accounts/test) and read which step failed (IMAP login, SMTP verify). Do not retry in a loop: repeated failures can lock the mailbox.
- **Needs the human:** Yes: new app password, provider switch
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-login-failed)

### MAIL_CONNECT_FAILED
- **Meaning:** The server could not be reached or the TLS handshake failed.
- **Where:** tools and routes that reach a mail server, log, doctor check account:<id> (last sync).
- **Likely causes:** Wrong host, port or TLS mode (implicit TLS on 993/465 vs STARTTLS on 143/587), firewall or DNS on the DSH host, a self-signed certificate (Proton Mail Bridge, a self-hosted server), a provider that is down.
- **Agent action:** Run Test connection and compare host, port and security with the provider preset; from the DSH host run the openssl or nc check in the TROUBLESHOOTING entry.
- **Needs the human:** Yes for allowSelfSigned or firewall changes
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-login-failed)

### MAIL_MAILBOX_UNREACHABLE
- **Meaning:** Reading or syncing a mailbox failed for a reason that is not a login or connection error.
- **Where:** tools mail_inbox, mail_thread, mail_read, mail_fetch, mail_search, mail_mark, mail_move, mail_folders, routes /folders, /messages, /thread, /message, /sync, log (background sync), doctor check account:<id>.
- **Likely causes:** A server-side error, an API error from the hosted mailbox account type, a bad base URL or token for that type, a folder that vanished.
- **Agent action:** Read `message`, then Test connection for the account; the doctor row shows the last sync status. Cached mail stays readable while the server is down.
- **Needs the human:** No
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-no-new-mail)

### MAIL_IDLE_UNAVAILABLE
- **Meaning:** Instant new mail (IMAP IDLE) is not active for an account.
- **Where:** log, doctor check idle.
- **Likely causes:** The server has no IDLE capability, IDLE failed three times in a row (the plugin gives up and polls), or more accounts have push on than push.maxAccounts allows.
- **Agent action:** Nothing breaks: new mail arrives at the poll interval (cache.pollSeconds, default 300 s). Only look further if the account should support IDLE.
- **Needs the human:** No
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-no-new-mail)

### MAIL_OAUTH_REAUTH
- **Meaning:** The account has no valid OAuth connection: never connected, refresh token revoked or expired, or the OAuth client was changed.
- **Where:** tools and routes that use an OAuth account, doctor check account:<id>, UI banner "Reconnect".
- **Likely causes:** The consent screen is in testing mode (refresh tokens expire after 7 days), the user changed the password or removed the app, an admin policy, 90 days unused, or the client id in the account differs from the one that was connected.
- **Agent action:** Check the doctor row (needsReauth). Do not retry: tell the human to open the account and press Connect.
- **Needs the human:** Yes: the consent happens in the human browser
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-oauth-reconnect)

### MAIL_OAUTH_FLOW_FAILED
- **Meaning:** The sign-in flow did not complete.
- **Where:** routes POST /oauth/start, /oauth/complete, /oauth/device/start.
- **Likely causes:** The state expired (10 minutes), was already used, or the sign-in ran in another browser session; the provider answered an error; no authorization code or no refresh token came back.
- **Agent action:** Press Connect again in the same browser. If no refresh token came back, remove the app in the provider account permissions first.
- **Needs the human:** Yes
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-oauth-reconnect)

### MAIL_OAUTH_NOT_CONFIGURED
- **Meaning:** OAuth cannot start: the account is unsaved, does not use OAuth, has no client id, or the provider rejected the client.
- **Where:** routes POST /oauth/start, /oauth/device/start, /oauth/complete.
- **Likely causes:** There is no shared app: each install needs its own client id (and secret for Google). A redirect URI that does not match, or a client of the wrong type.
- **Agent action:** Read GET /oauth/redirect-uri for the exact URI, register it at the provider, paste the client id, Save, then Connect.
- **Needs the human:** Yes: provider console
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-oauth-reconnect)

### MAIL_SEND_FAILED
- **Meaning:** The message could not be delivered by the server or provider.
- **Where:** tools mail_send, mail_mass_send, mail_send_later, mail_reply, mail_forward, routes /send, /queue/send, /drafts/send, log, doctor check queue (info, failed entries).
- **Likely causes:** A rejected recipient or sender, a provider quota, an unverified sender domain, a message the server refuses, a mass send stopped by the circuit breaker (5 consecutive failures).
- **Agent action:** Read `message`, check the audit log (GET /audit) and the account limits, run Test connection. Do not resend in a loop.
- **Needs the human:** Yes for provider-side fixes (verified sender, quota)
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-send-refused)

### MAIL_RATE_LIMITED
- **Meaning:** The per-account limit (limits.perMinute or limits.perDay) was reached.
- **Where:** tools mail_send, mail_forward, mail_mass_send, routes /send, log.
- **Likely causes:** A burst of messages, or a mass send running against the daily cap.
- **Agent action:** Wait `retryAfterSec` seconds (it is in the result) and retry once.
- **Needs the human:** Only to raise the limit
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-send-refused)

### MAIL_TOO_MANY_RECIPIENTS
- **Meaning:** The recipient count is over the per-account limit (limits.maxRecipients) or the plugin setting maxRecipients.
- **Where:** tools mail_send, mail_mass_send, route /send.
- **Likely causes:** A large CC list, or a CSV bigger than the cap.
- **Agent action:** Split the batch, or ask the human to raise the limit.
- **Needs the human:** Only to raise the limit
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-send-refused)

### MAIL_UNSUBSCRIBE_REQUIRED
- **Meaning:** A mass send above mass.unsubscribeAbove (default 50) recipients has no unsubscribe address, or the account cannot set headers.
- **Where:** tools mail_mass_send, queue send of a mass entry.
- **Likely causes:** No unsubscribe mailbox and no public base URL configured, no custom unsubscribe passed, or an account type that cannot set List-Unsubscribe (hosted mailbox, AgentMail).
- **Agent action:** Pass unsubscribe: "mailto:..." and/or "https://...", or ask the human to configure unsubscribe.mailto or unsubscribe.publicBaseUrl; or pick an SMTP, Lettermint, Resend or SendGrid account.
- **Needs the human:** Yes for settings
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-send-refused)

### MAIL_UNSUBSCRIBE_NOT_PUBLIC
- **Meaning:** One-click unsubscribe links are not published: unsubscribe.publicBaseUrl is empty.
- **Where:** doctor check unsubscribe.
- **Likely causes:** The feature is optional. Without a public base URL only the mailto unsubscribe is offered.
- **Agent action:** Information only. If one-click links are wanted, follow the unsubscribe entry.
- **Needs the human:** Yes: public edge route
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-unsub-links)

### MAIL_STORE_FULL
- **Meaning:** The queue or the draft store holds its maximum.
- **Where:** tools mail_send_later, mail_draft, mail_mass_send (staging), routes /queue, /drafts/save.
- **Likely causes:** Many pending queue entries or drafts that nobody reviewed.
- **Agent action:** List the queue and drafts, cancel or delete stale entries (ask the human first for entries it did not create), retry.
- **Needs the human:** Yes before deleting anything the agent did not create
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-drafts-duplicate)

### MAIL_QUEUE_CONFLICT
- **Meaning:** The queue entry is in a state that does not allow the action.
- **Where:** tools mail_cancel, routes /queue/send, /queue/approve, /queue/cancel, /queue/delete.
- **Likely causes:** It is being sent right now, was already sent, was cancelled, or is no longer scheduled; a queued entry waits for Send now or Approve and is never sent by the timer.
- **Agent action:** List the queue and read the status; act only on queued, scheduled or failed entries.
- **Needs the human:** No
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-send-refused)

### MAIL_OUTBOX_GONE
- **Meaning:** Undo send came too late or the held message is unknown.
- **Where:** route POST /outbox/cancel. Legacy `error` text: `already sent or unknown`.
- **Likely causes:** The undo window (compose.undoSendSec, default 6 s) passed, or dsh web restarted inside the window (the held message is dropped and never sent).
- **Agent action:** Check the Sent folder and the Drafts: if the message is in neither, it was dropped by a restart and must be composed again.
- **Needs the human:** No
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-undo-lost)

### MAIL_INBOUND_REJECTED
- **Meaning:** An inbound webhook body could not be parsed or was too large.
- **Where:** log (route POST /inbound/sendgrid/<account>).
- **Likely causes:** Inbound Parse not set to "POST the raw, full MIME message", a body over 25 MB, a truncated request through a proxy.
- **Agent action:** Read the log line, then check the SendGrid destination settings. Unknown account, inbound off and wrong secret all answer 404 on purpose.
- **Needs the human:** Yes: SendGrid console
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-sendgrid-inbound)

### MAIL_DATA_PERMISSIONS
- **Meaning:** The data directory is not mode 0700 or a secrets file is not mode 0600.
- **Where:** doctor checks data-dir, secrets-files.
- **Likely causes:** The directory was created by another process or copied with different permissions, a backup restore, a shared user.
- **Agent action:** Do not print the files. Ask the human (or run with their consent) chmod 700 on the data directory and chmod 600 on secrets.json, capability.secret, tokens.enc, settings.json.
- **Needs the human:** Yes: it changes file permissions
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-data-files)

### MAIL_CACHE_UNAVAILABLE
- **Meaning:** The local mail cache (cache.db) cannot be opened, or SQLite is unavailable and an in-memory cache is used.
- **Where:** doctor check cache.
- **Likely causes:** A corrupt or locked cache.db, a read-only data directory, or Node older than 22.5 (no node:sqlite).
- **Agent action:** The cache is rebuildable. With the human consent move cache.db aside and press Sync; check `node --version`.
- **Needs the human:** Yes before moving files
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-data-files)
