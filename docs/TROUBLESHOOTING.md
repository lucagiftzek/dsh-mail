# Troubleshooting dsh-mail

Checked on: DSH 0.1.5-rc.1 and 0.2.1-rc.5, plugin 0.2.0.

<a id="start-here"></a>
**Start here.** Ask your agent to load the `mail-doctor` skill, or run the doctor yourself:

```bash
curl -s <dsh-url>/dsh-mail/api/doctor | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(r.status,r.host);for(const c of r.checks)console.log(c.status,c.id,c.code||"",c.detail||"")})'
```

The doctor is offline and read-only: it never connects to a mail server and never prints a secret. Agents can call the tool `mail_doctor` instead. Every error the plugin returns carries a `code`; look it up in [ERRORS.md](ERRORS.md). If your DSH web UI is protected by a login in front of it, run the `curl` from the DSH host itself (the plugin only accepts loopback peers and trusted Host headers) or call `fetch('/dsh-mail/api/doctor')` from the browser console of a logged-in DSH tab.

## Quick index

| # | Symptom (what you see) | Most likely cause | Jump |
|---|---|---|---|
| 1 | "Test connection" fails, login refused, authentication errors | Normal password instead of an app password, wrong host, port or TLS mode | [1](#t-login-failed) |
| 2 | "Reconnect" banner, Google or Microsoft account stopped working | Refresh token expired or revoked, OAuth client or redirect URI mismatch | [2](#t-oauth-reconnect) |
| 3 | Settings do not save, reset after a restart, 503 on save | DSH 0.2.x settings model, Config not on the default export, read-only v1 | [3](#t-settings-not-saved) |
| 4 | Agents say "not permitted", "no accounts configured" or cannot see an account | Allow agents is off, a permission box is off, tools disabled | [4](#t-agent-denied) |
| 5 | New mail does not show up (or only after minutes) | Polling interval, no IDLE on the server, UIDVALIDITY reset, sync failing | [5](#t-no-new-mail) |
| 6 | A send is refused or only drafted | Draft first mode, first contact, rate limit, over 50 recipients, suppression | [6](#t-send-refused) |
| 7 | Duplicate drafts, missing drafts, drafts that do not delete | Server without UIDPLUS or APPENDUID | [7](#t-drafts-duplicate) |
| 8 | Unsubscribe links do not work | No public base URL, proxy login gate, listener not exposed | [8](#t-unsub-links) |
| 9 | SendGrid inbound mail never arrives | Opt-in off, wrong path secret, not raw MIME, gate in front | [9](#t-sendgrid-inbound) |
| 10 | An API base URL is rejected | https only, or http to loopback; no link-local, no credentials | [10](#t-api-base-url) |
| 11 | HTTP 403 from the plugin routes, "reload the tab" | Security gate: Host, token or session cookie | [11](#t-route-403) |
| 12 | Undo send did not catch the message, message vanished | dsh web restarted inside the undo window | [12](#t-undo-lost) |
| 13 | A mail renders without images or looks plain | HTML is sanitised, remote images are blocked | [13](#t-html-rendering) |
| 14 | The Mail tab is missing | Plugin not loaded, server half not restarted, optional sidebar missing | [14](#t-tab-missing) |
| 15 | Doctor warns about permissions or the cache | Data directory or a secrets file readable by group or others (expected 0700 and 0600), cache.db unreadable | [15](#t-data-files) |
| C1 to C9 | Install problems common to DSH plugins | see the end of this page | [Common install problems](#common-install-problems-on-dsh) |

## 0. Collect facts (read-only, always safe)

The report is `{ plugin, version, status, host, checks, docs, generatedAt }`. `status` is the worst check (`ok`, `warn` or `fail`); `host` has `dsh`, `dshLine`, `settingsMode` (`register` = 0.1.5, `forms` = 0.2.x, `config` = neither), `node` and `platform`. Each check is `{ id, label, status, detail, code, hint, docs, human }`: `status` is `ok`, `warn`, `fail`, `info` or `skip`; `code`, `hint` and `docs` (an anchor in [ERRORS.md](ERRORS.md)) are present on every row that is not ok; `human: true` marks a fix only you can do. Account rows show the id and the type only, never the address, the host or a secret.

| Check id | What it looks at | Codes |
|---|---|---|
| `plugin` | version, capability secret ready | `MAIL_NOT_READY` |
| `settings` | settings mode and writable | `MAIL_SETTINGS_UNAVAILABLE` |
| `config` | `Config` on the default export (needed for the DSH 0.2.x form) | `MAIL_SETTINGS_UNAVAILABLE` |
| `accounts` | number of accounts and how many are enabled | `MAIL_NO_ACCOUNTS` |
| `account:<id>` | type, enabled, secret present (true or false), `needsReauth` (Google and Microsoft), last sync status and age, SendGrid inbound and webhook secret (booleans) | `MAIL_SECRET_MISSING`, `MAIL_OAUTH_REAUTH`, `MAIL_ACCOUNT_AUTH_FAILED`, `MAIL_CONNECT_FAILED`, `MAIL_MAILBOX_UNREACHABLE`, `MAIL_ACCOUNT_DISABLED` |
| `agents` | `agents.enabled` and the confirm mode | `MAIL_TOOLS_DISABLED` |
| `data-dir` | mode of the data directory (expected 700) | `MAIL_DATA_PERMISSIONS` |
| `secrets-files` | modes of `secrets.json`, `capability.secret`, `tokens.enc`, `settings.json` (expected 600) | `MAIL_DATA_PERMISSIONS` |
| `cache` | the cache database opens (read-only look, nothing is created) | `MAIL_CACHE_UNAVAILABLE` |
| `unsubscribe` | `publicBaseUrl` set (boolean), mailto set, the loopback listener | `MAIL_UNSUBSCRIBE_NOT_PUBLIC` |
| `idle` | accounts with push, how many hold IDLE or fell back to polling | `MAIL_IDLE_UNAVAILABLE` |
| `queue` | queue entries by status and the number of drafts | `MAIL_SEND_FAILED` (info, when entries failed) |

Placeholders: `<dsh-url>` is where your DSH web UI answers (for example `http://127.0.0.1:3080`), `DSH_HOME` defaults to `~/.dsh`, the profile is `web`. The plugin data directory is `${DSH_HOME:-$HOME/.dsh}/mail` unless the environment variable `DSH_MAIL_DATA_DIR` points elsewhere.

```bash
dsh --version
# the doctor (see Start here); the first lines are the host facts: DSH version, settings mode (register = 0.1.5, forms = 0.2.x, config = neither)
curl -s <dsh-url>/dsh-mail/api/doctor
# the accounts the plugin sees (secrets are shown only as __set__ or empty)
curl -s <dsh-url>/dsh-mail/api/accounts | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);for(const a of r.accounts.concat(r.legacy))console.log(a.id,a.type,a.enabled,a.auth.method,JSON.stringify(a.oauthStatus||""))})'
# file modes only, never the contents
D="${DSH_MAIL_DATA_DIR:-${DSH_HOME:-$HOME/.dsh}/mail}"; ls -la "$D" | head -30
# recent plugin log lines carry the stable code first
journalctl -u <your-dsh-unit> --since "1 hour ago" | grep -E 'dsh-mail: MAIL_' | tail -40
```

The log lines go to the terminal that runs `dsh web` or to your service manager. Settings: on DSH 0.1.5 they live in the `dsh-mail:` section of `${DSH_HOME:-$HOME/.dsh}/settings.yaml`; on DSH 0.2.x in the `- id: dsh-mail` row of `${DSH_HOME:-$HOME/.dsh}/profiles/web/cordis.patch.yml`. Passwords, API keys and OAuth client secrets are never in either file: they are in the plugin's own `secrets.json` (mode 0600) and `tokens.enc`. Do not paste a settings row anywhere without checking it.

<a id="t-login-failed"></a>
## 1. "Test connection" fails, the server refuses the login

**Likely causes** (most likely first)
1. The provider needs an **app password** (2-step verification on: Gmail, iCloud, Yahoo, Fastmail, many others) and the normal password was used.
2. Wrong user name (the full address is the norm; some servers want only the local part) or IMAP/SMTP access is switched off in the provider's mail settings.
3. Wrong host, port or TLS mode: 993 and 465 are implicit TLS, 143 and 587 are STARTTLS; port 25 is usually blocked. A preset that does not match the account (a preset fills hosts for one provider only).
4. Providers without IMAP/SMTP (Tuta) or that need a local bridge (Proton Mail Bridge on the same host or LAN, with the bridge password and a self-signed certificate).
5. The account has no secret stored (it was created elsewhere, or `secrets.json` was moved).

**Diagnose** (read-only)
```bash
# which step fails (IMAP login, SMTP verify, API call): press Test connection in Settings, Mail (the secret is never shown)
# can this host reach the server and complete TLS? (replace host and port)
openssl s_client -connect <imap-host>:993 -brief </dev/null 2>&1 | head -5
nc -vz <smtp-host> 587
# doctor row for the account (secret present: true or false, last sync status)
curl -s <dsh-url>/dsh-mail/api/doctor | grep -o '"id":"account:[^}]*}'
```
Healthy: the TLS handshake prints a protocol and a verified chain, and Test connection shows every step ok. `Connection refused`, `timed out` or `ENOTFOUND` is cause 3 (code `MAIL_CONNECT_FAILED`); an `AUTHENTICATIONFAILED` or `535` answer is cause 1, 2 or 5 (code `MAIL_ACCOUNT_AUTH_FAILED`); `secret present: false` is cause 5.

**Fix**
- Cause 1 **[HUMAN]**: create an app password in the provider's account security page and type it into the account (Settings, Mail, Save). The preset text for the provider names the exact page.
- Cause 2: use the full address as user; switch IMAP on at the provider **[HUMAN]**.
- Cause 3: pick the preset of the provider again (it fills host, port and TLS), or correct the fields to match the provider's documentation. A self-signed server certificate needs "Accept a self-signed certificate" on that account only (your own server or a local bridge).
- Cause 4: use another provider, or start the bridge and use its generated password.
- Cause 5 **[HUMAN]**: retype the secret and Save. Do not copy secret files between machines unless you also keep the same permissions (0600).
- Repeated failed logins can lock the mailbox: stop retrying after two attempts.

**Verify:** Test connection shows every step ok; `curl -s <dsh-url>/dsh-mail/api/folders?account=<id>` lists folders.

**Related codes:** `MAIL_ACCOUNT_AUTH_FAILED`, `MAIL_CONNECT_FAILED`, `MAIL_SECRET_MISSING`, `MAIL_ACCOUNT_INVALID`.

<a id="t-oauth-reconnect"></a>
## 2. Google or Microsoft account asks to Reconnect, or OAuth cannot start

**Likely causes**
1. The refresh token expired or was revoked: the Google consent screen is in **testing** mode (tokens last 7 days), the user changed the password or removed the app, an admin policy, or 90 days of no use. The tab shows a Reconnect banner and the doctor row says `needsReauth`.
2. No OAuth client of your own: there is no shared app. Each install creates its own client at the provider (Google Cloud console, or an Entra app registration for Microsoft), pastes the client id (and the secret for Google) into the account, Saves, then presses Connect.
3. The redirect URI registered at the provider does not match the public URL you open DSH on (scheme, host, port and path must match exactly). Behind a reverse proxy the request may carry the internal address.
4. The provider returned no refresh token (the app was authorised before; Google only returns it on first consent).
5. Microsoft 365: an administrator must grant consent, or SMTP AUTH is disabled for the mailbox (the plugin then sends through Microsoft Graph when "Send via" is auto).

**Diagnose** (read-only)
```bash
curl -s <dsh-url>/dsh-mail/api/oauth/redirect-uri          # the exact URI to register at the provider
curl -s '<dsh-url>/dsh-mail/api/oauth/status?account=<id>'  # connected, needsReauth, reason (no tokens)
curl -s <dsh-url>/dsh-mail/api/doctor | grep -o '"id":"account:[^}]*}'
```
Healthy: `connected: true, needsReauth: false`. A `reason` that mentions "In production" or 7 days is cause 1 with a testing consent screen. If the printed redirect URI is not your public DSH address, set the plugin setting `oauth.redirectBaseUrl` (https://your-public-host) and register that exact URI (cause 3).

**Fix** (all steps happen in a browser **[HUMAN]**)
- Cause 1: Settings, Mail, open the account, press **Connect** (Reconnect). For Google, set the OAuth consent screen publishing status to "In production" in the Google Cloud console so the token stops expiring every 7 days.
- Cause 2: create the client, copy the client id and secret, Save, then Connect.
- Cause 3: register the URI printed above at the provider and use the same address in the browser.
- Cause 4: remove the app in the provider's account permissions page, then Connect again.
- Cause 5: ask the tenant administrator for consent; leave "Send via" on auto.

**Verify:** `oauth/status` shows `connected: true`; Test connection shows "OAuth2 access token valid" and the IMAP step ok.

**Related codes:** `MAIL_OAUTH_REAUTH`, `MAIL_OAUTH_FLOW_FAILED`, `MAIL_OAUTH_NOT_CONFIGURED`.

<a id="t-settings-not-saved"></a>
## 3. Settings or accounts do not save, reset after a restart, or answer 503

**Likely causes by DSH line** (see also C3)
1. **DSH 0.2.x, old plugin build:** the loader reads `Config` from the **default export**; a build that exports it only by name gets no settings form and no writable row. The doctor `config` check fails.
2. **DSH 0.2.x, read-only host:** a profile row override or a command-line overlay that sets the same key wins and the form write is refused; a `settings.yaml` that reappears is imported again at every boot and overwrites the row.
3. **DSH 0.1.5:** the settings are a registered namespace in `settings.yaml`; a YAML error in a hand edit makes the whole file unreadable.
4. **A v1 (0.1.x) plugin build on DSH 0.2.x** is read-only there: saves answer 503 `settings service unavailable`.
5. No settings service (headless run or tests): the plugin keeps a 0600 `settings.json` in its data directory instead; edits must go through the plugin routes.

**Diagnose** (read-only)
```bash
curl -s <dsh-url>/dsh-mail/api/doctor | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(r.host);for(const c of r.checks.filter(c=>c.id==="settings"||c.id==="config"))console.log(c)})'
D="${DSH_HOME:-$HOME/.dsh}"; ls -la "$D/settings.yaml" "$D/settings.yaml.imported" 2>/dev/null
grep -n -A6 -- '- id: dsh-mail' "$D/profiles/web/cordis.patch.yml" 2>/dev/null | grep -v -i -E 'secret|password|token|key'
```
Healthy: `host.settingsMode` is `register` on 0.1.5 or `forms` on 0.2.x, the `settings` check is ok and `config` is ok. `config` as the mode on a normal install, or a failing `config` check, is cause 1 or 4 (code `MAIL_SETTINGS_UNAVAILABLE`).

**Fix**
- Cause 1 and 4: use plugin version 0.2.0 or newer; restart `dsh web` because the server half loads only at start **[HUMAN if your chat runs inside dsh web]**.
- Cause 2: stop any script that rewrites `settings.yaml`; edit the key in the profile row; back up first (`cp file file.bak-$(date +%Y%m%d)`).
- Cause 3: fix the YAML syntax; keep a backup.
- Cause 5: use Settings, Mail (or the routes); do not edit `settings.json` while dsh web runs.
- **Convert legacy settings** (Settings, Mail) rewrites settings only after a confirmation and writes `.bak-YYYYMMDD-mailv2-convert` backups first.

**Verify:** change a harmless value (the undo-send seconds), reload the tab and see it kept; `curl -s <dsh-url>/dsh-mail/api/state` shows it under `settings`.

**Related codes:** `MAIL_SETTINGS_UNAVAILABLE`, `MAIL_CONFIRM_REQUIRED`.

<a id="t-agent-denied"></a>
## 4. Agents say "not permitted for agents" or "no accounts configured"

**Likely causes**
1. **Allow agents** is off on the account (new accounts start off), or a finer box is off (Can read, Can send, Can mass send, Can manage folders).
2. `agents.allowedAccounts` lists other ids only.
3. `agents.enabled` is false (every tool refuses).
4. The account is disabled, or the id is wrong (an old v0.1 provider id such as `lettermint` only resolves while the legacy settings exist).
5. The account type cannot do the action (for example reading on an API-only sender).

**Diagnose** (read-only): call the tool `mail_accounts` (it lists accounts the agent may use, their capabilities and the confirm mode), or run the `/accounts` curl of section 0 and compare `agent.allow`, `agent.canRead`, `agent.canSend`. The `agents` doctor check reports `agents.enabled` and the confirm mode.

**Fix [HUMAN]:** Settings, Mail, open the account, tick Allow agents and the needed boxes, Save; or set `agents.enabled` to true. Do not enable mass sending on an account you do not intend agents to bulk mail from.

**Verify:** `mail_accounts` lists the account with the capability you need.

**Related codes:** `MAIL_AGENT_DENIED`, `MAIL_TOOLS_DISABLED`, `MAIL_NO_ACCOUNTS`, `MAIL_ACCOUNT_NOT_FOUND`, `MAIL_ACCOUNT_DISABLED`, `MAIL_CAPABILITY_UNSUPPORTED`.

<a id="t-no-new-mail"></a>
## 5. New mail does not appear (or only after several minutes)

**Likely causes**
1. **Polling, not push:** without "Instant (IMAP IDLE)" the plugin polls the Inbox every `cache.pollSeconds` (default 300 seconds, minimum 30). Opening a folder syncs it at once.
2. **The server has no IDLE** or IDLE failed three times in a row: the account stays on polling (log line `MAIL_IDLE_UNAVAILABLE`, doctor check `idle`). At most `push.maxAccounts` (default 5) accounts hold an IDLE connection.
3. **UIDVALIDITY changed** on the server (a folder was rebuilt or migrated): the plugin drops that folder from its cache and fetches it again; the folder is empty for a moment and counts reset.
4. **Sync is failing** (login or connection error): the cache shows old mail and the doctor row of the account carries the last error (`MAIL_ACCOUNT_AUTH_FAILED`, `MAIL_CONNECT_FAILED`).
5. **POP3 account:** mail leaves the server after the provider's own rules; read state is kept locally.
6. The cache is disabled (`cache.enabled` false) or the retention is 0 (headers only).

**Diagnose** (read-only)
```bash
curl -s <dsh-url>/dsh-mail/api/doctor | grep -o '"id":"\(idle\|cache\|account:[^"]*\)"[^}]*}'
curl -s <dsh-url>/dsh-mail/api/unsubscribe/status          # idle: per account mode (idle, polling (no IDLE), reconnecting)
```
Healthy: `idle` mode `idle` for push accounts, the account row shows `last sync ok`.

**Fix**
- Cause 1: tick Instant (IMAP IDLE) on IMAP accounts, or lower `cache.pollSeconds`.
- Cause 2: nothing is lost; polling covers it. Keep `push.maxAccounts` at or above the number of push accounts.
- Cause 3: wait for the refetch; if mail is missing after a minute press Sync in the tab (or POST `/sync` with the account).
- Cause 4: follow entry 1.
- Cause 6: set `cache.enabled` true.

**Verify:** send yourself a message and watch it arrive; `curl -s '<dsh-url>/dsh-mail/api/messages?account=<id>&limit=3'` lists it.

**Related codes:** `MAIL_IDLE_UNAVAILABLE`, `MAIL_MAILBOX_UNREACHABLE`, `MAIL_ACCOUNT_AUTH_FAILED`, `MAIL_CONNECT_FAILED`.

<a id="t-send-refused"></a>
## 6. A send is refused, rate limited or only drafted

**Likely causes**
1. **Draft first:** with `agents.confirmMode: all` (the default for new installs) `mail_send` without `confirm: true` returns a draft and a `draftId`; `mail_send({ draftId, confirm: true })` delivers. `reply-only` sends a new `mail_send` at once and drafts only `mail_reply`. Read the first words of the result: `SENT (...)` or `DRAFT ONLY, NOTHING WAS SENT`. Scheduled and mass sends wait for approval in the Queue pane. This is by design, not an error.
2. **First contact:** `agents.firstContactConfirm` (default on): the first message to a recipient domain the account never wrote to or heard from becomes a draft, even in `reply-only` mode.
3. **Rate limit:** per account `limits.perMinute` and `limits.perDay`; the result has `code MAIL_RATE_LIMITED` and `retryAfterSec`. Mass sends wait for the next minute and stop at the daily cap.
4. **Mass send above 50 recipients** (`mass.unsubscribeAbove`) needs an unsubscribe address, on every account: `unsubscribe.mailto` or `unsubscribe.publicBaseUrl`, or a custom `unsubscribe` argument. Accounts that cannot set headers (hosted webmail, AgentMail) refuse such batches. `MAIL_UNSUBSCRIBE_REQUIRED`.
5. **Circuit breaker:** 5 consecutive failures stop a batch (`mass.breakerFailures`); retrying resumes and skips addresses already delivered.
6. **Suppression:** addresses on the global list (`suppress.txt`, `@domain` entries too) or on the unsubscribe list are skipped; hard bounces (5.1.x) are added automatically.
7. **Too many recipients** (`limits.maxRecipients`, `maxRecipients`), a bad address, attachments over 20 MB (`MAIL_TOO_MANY_RECIPIENTS`, `MAIL_INVALID_INPUT`, `MAIL_SIZE_LIMIT`).
8. The provider rejected the message (unverified sender, quota) (`MAIL_SEND_FAILED`).

**Diagnose** (read-only)
```bash
curl -s <dsh-url>/dsh-mail/api/state | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(r.confirmMode,r.queueCounts)})'
curl -s '<dsh-url>/dsh-mail/api/audit?limit=20'     # time, actor, account, action, ok (no bodies)
curl -s <dsh-url>/dsh-mail/api/suppress | head -c 600
```
For a batch use `mail_mass_send` with `dryRun: true`: it prints the first three messages, the suppressed count and the remaining budget, and sends nothing.

**Fix**
- Cause 1 and 2: show the draft to the human; deliver only with `confirm: true` after they agreed. Changing the mode is a human decision (Settings, Mail).
- Cause 3: wait `retryAfterSec` or raise the limits **[HUMAN]**.
- Cause 4 **[HUMAN]**: configure the unsubscribe mailbox or public base URL (entry 8), or pass `unsubscribe: "mailto:..."`.
- Cause 5: read the first error (`MAIL_SEND_FAILED` text), fix it, then Send now on the queue entry.
- Cause 6: remove an address from the list only with the owner's consent (`mail_suppression remove ... confirm: true`).
- Cause 7 and 8: correct the input; fix the sender at the provider **[HUMAN]**.

**Verify:** the audit log shows the send with `ok: true`; `mail_list_queue` shows the entry as sent.

**Related codes:** `MAIL_RATE_LIMITED`, `MAIL_UNSUBSCRIBE_REQUIRED`, `MAIL_TOO_MANY_RECIPIENTS`, `MAIL_QUEUE_CONFLICT`, `MAIL_STORE_FULL`, `MAIL_SEND_FAILED`, `MAIL_INVALID_INPUT`, `MAIL_SIZE_LIMIT`.

<a id="t-drafts-duplicate"></a>
## 7. Duplicate or missing drafts, drafts that do not disappear

**Likely causes**
1. The IMAP server has no **UIDPLUS** (so no APPENDUID answer): the plugin cannot learn the UID of the copy it saved and finds it by its own Message-ID instead; if that lookup fails, one extra copy can stay until the next autosave replaces it.
2. After a **UIDVALIDITY** change the stored UID points nowhere; only a message that still carries `\Draft` and the plugin's own Message-ID is ever removed, so an older copy can remain.
3. Without UIDPLUS a delete only flags the message deleted (no folder-wide EXPUNGE, to protect other clients' mail), so another client may still show it until it expunges.
4. The draft was sent or deleted elsewhere: `no draft <id>` (`MAIL_OBJECT_NOT_FOUND`).

**Diagnose** (read-only): `mail_draft` with `action: list` shows the plugin's own drafts; compare with the Drafts folder in your regular mail client. `curl -s '<dsh-url>/dsh-mail/api/folders?account=<id>'` shows the folder roles; the doctor does not test server capabilities because it is offline.

**Fix:** delete the stray copy from the other client (or flag and expunge the Drafts folder there) **[HUMAN]**; delete plugin drafts with `mail_draft delete`. Nothing is lost by the flag-only delete.

**Verify:** after one more autosave, `mail_draft list` and the Drafts folder agree.

**Related codes:** `MAIL_OBJECT_NOT_FOUND`, `MAIL_STORE_FULL`.

<a id="t-unsub-links"></a>
## 8. One-click unsubscribe links do not work

The plugin offers two unsubscribe routes: a **mailto** (the account's unsubscribe mailbox, `unsubscribe.mailto`, or `<address>+unsubscribe@<domain>` for accounts that read their mail) and an **https one-click link** (RFC 8058) that needs a public address.

**Likely causes**
1. `unsubscribe.publicBaseUrl` is empty: only the mailto is offered (doctor check `unsubscribe`, code `MAIL_UNSUBSCRIBE_NOT_PUBLIC`, informational).
2. The public edge route is missing: the plugin does not create it. The path `/dsh-mail-unsub/*` must reach DSH (or the plugin's small listener) **without the login gate**, while everything else stays behind it.
3. The reverse proxy exposes more than the unsubscribe path, or the login gate redirects the path (answer 302 or 401 instead of the confirm page).
4. The optional loopback listener (`unsubscribe.listenPort`) is off, on another port than the proxy targets, or `unsubscribe.listenHost` was set to a non-loopback address (it falls back to 127.0.0.1 and logs a warning). Port changes apply after a restart.
5. The mailto replies are not processed because no account reads the unsubscribe mailbox (the mailbox must be read by one of the accounts).

**Diagnose** (read-only)
```bash
curl -s <dsh-url>/dsh-mail/api/unsubscribe/status      # publicBaseUrl, listener host and port, mailto addresses, idle
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://<your-public-host>/dsh-mail-unsub/probe
ss -ltn | grep ':<listen-port> '                        # the listener is on loopback only
```
Healthy: the public probe answers a plain 200 or 404 page of the plugin (not a login redirect); the listener shows `127.0.0.1`.

**Fix [HUMAN]**
- Set `unsubscribe.publicBaseUrl` to the https base (for example `https://unsub.example.com`) and `unsubscribe.listenPort` to a free port, restart dsh web.
- Route only the path through your edge, for example with Caddy:
  ```
  unsub.example.com {
    @unsub path /dsh-mail-unsub/*
    handle @unsub { reverse_proxy 127.0.0.1:<listen-port> }
    handle { respond 404 }
  }
  ```
  Behind a tunnel, use an ingress rule for that hostname and path to the same port. Keep the login on everything else.
- Make sure one of your accounts reads the unsubscribe mailbox.

**Verify:** send a test mass mail to yourself with `mail_mass_send` (dry run first); the headers contain `List-Unsubscribe` and `List-Unsubscribe-Post`; opening the link shows the confirm page; the Unsubscribes pane lists the entry after confirming.

**Related codes:** `MAIL_UNSUBSCRIBE_NOT_PUBLIC`, `MAIL_UNSUBSCRIBE_REQUIRED`.

<a id="t-sendgrid-inbound"></a>
## 9. SendGrid inbound mail never arrives

Inbound Parse is opt-in per account and posts to `/dsh-mail/api/inbound/sendgrid/<account>?s=<path secret>`.

**Likely causes**
1. Inbound is off on the account ("Receive mail through SendGrid Inbound Parse"), or the account was not saved after ticking it.
2. The path secret is wrong or was regenerated (the URL is shown once). Unknown account, inbound off and wrong secret all answer 404 on purpose, so nothing can be probed.
3. A login gate or proxy in front of DSH covers the path (302 or 401), or the proxy does not forward it (see C9).
4. SendGrid is not set to "POST the raw, full MIME message" (parsed fields are accepted but lose headers), or the body is over 25 MB.
5. The Host header does not match a trusted host (`trustedHosts`).

**Diagnose** (read-only): the doctor row of the account shows inbound enabled and the webhook secret present (booleans). Look for `MAIL_INBOUND_REJECTED` in the log. From outside: `curl -s -o /dev/null -w '%{http_code}\n' -X POST 'https://<your-public-host>/dsh-mail/api/inbound/sendgrid/<account>?s=wrong'`: `404` means the route is reached (good); `302` means a login gate (cause 3).

**Fix [HUMAN]:** tick the option and Save, press **Generate the webhook URL**, set it as the Inbound Parse destination in SendGrid with the raw option, expose that path without login (C9), and add your public host name to `trustedHosts`.

**Verify:** send a message to the parse domain; it appears in the account's Inbox in the tab (it only enters the local cache and never triggers agent actions).

**Related codes:** `MAIL_INBOUND_REJECTED`, `MAIL_ACCOUNT_INVALID`.

<a id="t-api-base-url"></a>
## 10. An API base URL is rejected

API accounts (Lettermint, Resend, AgentMail, SendGrid, the hosted webmail type) send the account's API key to the base URL, so it is restricted: **https**, or plain http to a **loopback** host only; no credentials inside the URL; never a link-local or unspecified address (cloud metadata endpoints). IMAP, POP3 and SMTP hosts are not restricted: self-hosted mail on a LAN is normal.

**Diagnose:** the save fails with `api.baseUrl must use https (plain http only to a loopback host)`, `... must not carry credentials` or `... must not point at a link-local or unspecified address` (code `MAIL_ACCOUNT_INVALID`).

**Fix:** use the https address of the service (for SendGrid with EU data residency the vendor's EU endpoint); if the service is on the same machine use `http://127.0.0.1:<port>`; for a service on another machine put it behind https. Remove user and password from the URL; use the API key field instead.

**Verify:** Save succeeds and Test connection shows the API step ok.

**Related codes:** `MAIL_ACCOUNT_INVALID`.

<a id="t-route-403"></a>
## 11. HTTP 403, 405 or 415 from the plugin routes ("reload the tab")

The routes have layers: a loopback peer and a trusted Host on every route; change routes (POST) also need `sec-fetch-site: same-origin`, an Origin, `content-type: application/json`, the capability token (`x-dsh-mail-token`, 15 minutes) and the DSH browser-session cookie.

**Likely causes:** a script or `curl` call without those headers (codes `MAIL_TOKEN_INVALID`, `MAIL_SESSION_COOKIE_MISSING`, `MAIL_REQUEST_FORBIDDEN`); a tab that stayed open for hours or a plugin restart (new secret): reload the tab; DSH opened through a public host name that is not in `trustedHosts`; a reverse proxy that rewrites Host or drops Origin.

**Diagnose:** the error body names the layer: `curl -s <dsh-url>/dsh-mail/api/state` should answer 200 from the DSH host; a 403 with `cross-site or untrusted Host` means the Host header, `non-loopback peer` means the call came from another machine or a proxy on another host.

**Fix:** use the web UI for changes. Add your public DSH host name to the plugin setting `trustedHosts` **[HUMAN]**. Do not set `requireHarnessCookie: false` unless you understand that any local process could then change mail settings and send.

**Verify:** reload the tab; the Mail tab loads and a harmless change (mark a message read) works.

**Related codes:** `MAIL_REQUEST_FORBIDDEN`, `MAIL_TOKEN_INVALID`, `MAIL_SESSION_COOKIE_MISSING`, `MAIL_METHOD_NOT_ALLOWED`, `MAIL_NOT_READY`.

<a id="t-undo-lost"></a>
## 12. Undo send missed, or a sent message vanished

Messages sent from the tab wait `compose.undoSendSec` seconds (default 6, 0 = off) in **memory**, then go out. A restart of `dsh web` inside that window **drops the held message**: it is not sent and not saved. Undo after the window answers `already sent or unknown` (code `MAIL_OUTBOX_GONE`).

**Diagnose** (read-only): look in the Sent folder and the audit log (`GET /audit`): no `send` entry for that time means it was never sent. A restart shows in the dsh web log.

**Fix:** compose and send again. Avoid restarting dsh web right after sending; set `compose.undoSendSec` to 0 if you never want the hold.

**Related codes:** `MAIL_OUTBOX_GONE`.

<a id="t-html-rendering"></a>
## 13. A mail looks plain, has no images or broken layout

HTML mail is **sanitised** with an allow-list (no scripts, forms, relative links or unsafe styles) and shown in a sandboxed frame without scripts; remote images are blocked for privacy until you press Load images, so tracking pixels do nothing by default. Messages with only a text part show as text. This is intended and not an error.

**What you can do:** use Load images for one message; open the original attachment (`.eml` for inbound webhook mail) in a mail client when exact layout matters. An explicit `html` part passed by an agent to `mail_send` goes out exactly as given; Markdown and the rich editor produce sanitised HTML plus a text part.

**Related codes:** none.

<a id="t-tab-missing"></a>
## 14. The Mail tab is missing

**Likely causes**
1. The plugin is not loaded: not in the profile bundles, or `dsh web` was not restarted (C1, C2).
2. `DSH_MAIL_DISABLE=1` is set in the dsh web environment (the server half logs `armed off`), or the row is `disabled: true`.
3. `agents.enabled` is false: only the tools are off, the tab stays.
4. The optional sidebar host (`dsh-better-sidebar`) is not installed: the plugin boots without it (it is injected optionally) but there is no side card to hold the tab; install a sidebar host version that matches your DSH (C4).

**Diagnose:** `curl -s -o /dev/null -w '%{http_code}\n' <dsh-url>/dsh-mail/api/doctor` (404 means cause 1 or 2); the dsh web log shows `dsh-mail: armed: route /dsh-mail/api` when loaded.

**Fix:** see C1 and C2; remove the disable switch **[HUMAN]** and restart.

**Related codes:** none (use C1 to C4).

<a id="t-data-files"></a>
## 15. The doctor warns about file permissions, the cache or startup

**Likely causes:** the data directory is not mode 0700, or `secrets.json`, `capability.secret`, `tokens.enc` or `settings.json` is not 0600 (copied or restored from a backup, another user created it); `cache.db` is corrupt, locked or the directory is read-only; Node is older than 22.5 so `node:sqlite` is missing (an in-memory cache is used and lost at restart).

**Diagnose** (read-only)
```bash
D="${DSH_MAIL_DATA_DIR:-${DSH_HOME:-$HOME/.dsh}/mail}"
stat -c '%a %n' "$D" "$D"/secrets.json "$D"/capability.secret "$D"/tokens.enc "$D"/settings.json "$D"/cache.db 2>/dev/null   # on macOS: stat -f '%Lp %N'
node --version
```
Healthy: `700` for the directory, `600` for the files, Node 22.5 or newer.

**Fix [HUMAN]** (it changes permissions; check nobody else needs the files): `chmod 700 "$D"` and `chmod 600 "$D"/secrets.json "$D"/capability.secret "$D"/tokens.enc "$D"/settings.json`. A damaged cache is rebuildable: move it aside (`mv "$D"/cache.db "$D"/cache.db.stale-$(date +%Y%m%d)`), restart or press Sync. Never delete `secrets.json` or `tokens.enc`: they hold the only copy of your passwords and OAuth tokens.

**Verify:** the doctor checks `data-dir`, `secrets-files` and `cache` are ok.

**Related codes:** `MAIL_DATA_PERMISSIONS`, `MAIL_CACHE_UNAVAILABLE`, `MAIL_NOT_READY`.

<!-- dsh-common-install:v1 -->
## Common install problems on DSH

Placeholders: `<dsh-url>` is where your DSH web UI answers (for example
`http://127.0.0.1:3080`), `DSH_HOME` defaults to `~/.dsh`, the profile is `web`.

<a id="c1-not-loaded"></a>
### C1. The plugin does not appear at all (no tab, no settings, no tools)

**Causes:** (1) the package is installed but not in the profile's bundle list;
(2) it is in the list but `dsh web` was not restarted; (3) DSH refused it as
incompatible (engines or peer range); (4) its server entry threw at start;
(5) the entry is defined twice (`duplicate loader entry id`: a hand-written `insert` row in
the profile patch plus the package's own patch); (6) an old build without `dsh.bundle` in its
`package.json` (`declares no dsh.bundle`).

**Diagnose**
```bash
D="${DSH_HOME:-$HOME/.dsh}/profiles/web"
node -e 'const p=require(process.argv[1]);console.log((p.dsh?.profile?.bundles||[]).join("\n"))' "$D/package.json" | grep -n 'dsh-mail' || echo "NOT IN BUNDLES"
ls -la "$D/node_modules/dsh-mail" 2>/dev/null || echo "NOT INSTALLED"
dsh --profile web --dump-config 2>/dev/null | grep -n -i 'dsh-mail' | head    # composed tree, does not boot
# DSH log: the terminal running `dsh web`, or your service manager, e.g.
journalctl -u <your-dsh-unit> --since "1 hour ago" | grep -i -E 'dsh-mail|dsh-mail|incompatible|skipped|exemption|duplicate loader entry|declares no dsh.bundle' | tail -40
```

**Fix:** install with `dsh plugin --profile web add @lucagiftzek/dsh-mail` (it adds the package to
`dsh.profile.bundles` when the package declares `dsh.bundle`; override values with a plain
`- id: dsh-mail` row, never a second `insert` row), then restart
`dsh web` **[HUMAN if your chat runs inside dsh web]**. If the log says the bundle
was skipped as incompatible, update the plugin; DSH 0.2.x also offers an exact-version
exemption (`dsh plugin allow-version`, see the log message), which must be granted
again after every DSH version change.

**Verify:** the tab or settings page appears; `curl -s -o /dev/null -w '%{http_code}\n' <dsh-url>/dsh-mail/api/doctor` prints `200`.

<a id="c2-route-404"></a>
### C2. Every plugin route answers 404

**Causes:** the plugin's server half is not loaded (C1), or it was updated and the
running `dsh web` still has the old server code (the client half hot-reloads, the
server half loads only at start). A 404 on ONE path while others answer means a
wrong path, not a load problem.

**Diagnose**
```bash
for p in api/doctor api/health api/does-not-exist; do echo "$p $(curl -s -o /dev/null -w '%{http_code}' <dsh-url>/dsh-mail/$p)"; done
```
All 404 = route prefix not registered. `200` on doctor/health and `404` on the last = healthy.

**Fix:** restart `dsh web` **[HUMAN]**. If you open DSH through a browser login or a
reverse proxy, check the proxy forwards `/dsh-mail/` to DSH. After a restart the
web UI may ask you to open the launch URL again (the one `dsh web` prints, with its
one-time token); that is expected and unrelated to plugin routes.

<a id="c3-settings-not-saved"></a>
### C3. Settings do not save, or reset after a restart

**Causes by DSH line:**
- **0.1.5:** the plugin registers a settings namespace; values live in
  `$DSH_HOME/settings.yaml` under the plugin's section. A hand edit with a YAML error
  makes the whole file unreadable.
- **0.2.x:** settings are forms over the plugin's exported `Config`; values live in
  `$DSH_HOME/profiles/web/cordis.patch.yml` under the row `- id: dsh-mail` `config:`.
  (a) Only fields marked live (`volatile`) are editable in forms; others are edited in
  the row and remount the plugin. (b) The loader reads `Config` from the DEFAULT export
  when the module has one: a plugin that exports `default { name, apply }` without
  `Config` gets no form. (c) A plugin that touches `ctx.settings` without declaring
  `inject: ['settings']` throws on 0.2.x. (d) A home patch or command-line overlay that
  sets the same key wins, and the form write is refused. (e) On first boot 0.2.x renames
  `settings.yaml` to `settings.yaml.imported` and imports only sections whose name equals
  an entry id with all keys declared live; a `settings.yaml` that reappears (a script
  rewriting it) is imported AGAIN at every boot and overwrites profile rows.

**Diagnose**
```bash
dsh --version
curl -s <dsh-url>/dsh-mail/api/doctor | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(r.host);for(const c of r.checks)console.log(c.status,c.id,c.detail||"")})'
D="${DSH_HOME:-$HOME/.dsh}"; ls -la "$D/settings.yaml" "$D/settings.yaml.imported" 2>/dev/null
grep -n -A12 -- '- id: dsh-mail' "$D/profiles/web/cordis.patch.yml"   # 0.2.x row (may contain secrets: do not paste it anywhere)
```

**Fix:** use a plugin version that supports your DSH line (the doctor's `host.settingsMode`
must not be `config` on a normal install). On 0.2.x stop any script that rewrites
`settings.yaml`, and edit non-live fields in the row. Back up the file before any hand
edit (`cp file file.bak-$(date +%Y%m%d)`).

<a id="c4-gui-blank"></a>
### C4. After a DSH update the web UI does not render ("Failed to load plugins", blank page)

**Causes:** on 0.2.x an unmet REQUIRED client inject stops the whole GUI, not just one
plugin. Typical: a plugin requires `dsh-better-sidebar` (or another client service) and
that package was refused as too old for the new DSH. Older plugin builds that require
their sidebar host are affected; current ones inject it optionally.

**Diagnose:** browser devtools console (the first red error names the plugin), and the
DSH log for `skipped` / `incompatible` bundles (C1 command).

**Fix:** update `dsh-better-sidebar` (0.28 or newer for DSH 0.2.1) and the plugin;
or disable the failing bundle by row and restart **[HUMAN]**:
```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: dsh-mail
  disabled: true
```

<a id="c5-model-404"></a>
### C5. After a DSH update every model turn fails (HTTP 404) for one provider

**Cause:** an environment variable such as `DEEPSEEK_BASE_URL` changed meaning between
DSH lines (0.1.5: plain API host; 0.2.x: the Anthropic-messages base, for example
`https://api.deepseek.com/anthropic`). Not a plugin bug, but it looks like one.

**Fix:** set the base URL the new line expects (env or the provider row), restart **[HUMAN]**.

<a id="c6-oom-install"></a>
### C6. The machine runs out of memory during an install

**Cause:** a profile-level `pnpm install` (or `npm i -g` of the harness) can grow to many
GB on a large profile; with swap full, the kernel or earlyoom kills unrelated services.

**Fix:** check `free -m` first, then install inside a memory-capped scope:
```bash
systemd-run --user --scope -p MemoryMax=3G dsh plugin --profile web add @lucagiftzek/dsh-mail
# pnpm only: add --child-concurrency 1 to reduce peak memory
```
A runaway then kills only itself. Check afterwards that your other services are up.

<a id="c7-stale-client"></a>
### C7. UI shows new options but they do nothing, or "restart dsh web" banners

**Cause:** the client half (browser bundle) hot-reloaded, the server half did not. Mixed
versions are tolerated by design, but new server features stay off until a restart.
**Fix:** restart `dsh web` when convenient **[HUMAN]**; reload the browser tab.

<a id="c9-webhooks-blocked"></a>
### C9. Provider webhooks never arrive, or arrive and are rejected (401/403/302)

**Causes (webhook paths: `/dsh-mail/api/inbound/sendgrid/<account>` and the public unsubscribe path `/dsh-mail-unsub/*`):** (1) a login gate (SSO, basic auth, a "sign in" redirect) in front of DSH also
covers the webhook path; (2) the reverse proxy does not forward the path, or rewrites
scheme/host/port so the request signature no longer matches (providers sign the exact
public URL they called); (3) a firewall or the home router blocks the provider.

**Diagnose**
```bash
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -X POST 'https://<your-public-host>/dsh-mail/api/inbound/sendgrid/<account>?s=wrong'
```
`302` to a login page = login gate (cause 1). A plain `404` on the inbound path = the route is reached and a request without the right secret is correctly refused (good); `403` = the Host is not trusted (add it to `trustedHosts`). Then compare
the URL configured at the provider with the public address of DSH.

**Fix:** expose ONLY the webhook path without the login gate (rate-limited), keep every
other DSH path behind it **[HUMAN]**. For one-click unsubscribe, set `unsubscribe.publicBaseUrl` (https) and expose only `/dsh-mail-unsub/*`; add your public host name to `trustedHosts` for the inbound webhook, and make the proxy pass `X-Forwarded-Proto` and `X-Forwarded-Host`.

<!-- /dsh-common-install -->
