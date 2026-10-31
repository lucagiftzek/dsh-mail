---
name: mail-doctor
description: Diagnose and fix dsh-mail problems step by step (accounts and login, OAuth reconnect, settings, new mail, sending guard rails, unsubscribe links, SendGrid inbound). Load it when a mail_* tool or a /dsh-mail route fails, an error carries a MAIL_* code, or the user reports that login fails, mail does not arrive, a send is refused or the Mail tab is missing.
---

# dsh-mail doctor

## Rules
- Read-only checks first. Never print secrets: do not cat `secrets.json`, `tokens.enc`, `capability.secret` or a settings row; read modes with `stat`, never contents.
- Never restart `dsh web` yourself: the chat you are in may run inside it. Ask the human.
- Never send a test mail, mass send, delete a queue entry or draft you did not create, or change account permissions on your own. Steps marked [HUMAN] need the human (provider console, app passwords, consent screens, router or proxy, restart, money).
- Do not retry a failing login in a loop: repeated failures can lock the mailbox. Two tries at most.
- Stop and report after a fix; verify with the step given.

## 0. Facts (read-only)
1. Plugin dir: `node -p "require('path').dirname(require.resolve('dsh-mail/package.json', {paths:[(process.env.DSH_HOME||require('os').homedir()+'/.dsh')+'/profiles/web']}))"` (docs are in its `docs/` folder: `TROUBLESHOOTING.md`, `ERRORS.md`).
2. Doctor: tool `mail_doctor`, or `curl -s <dsh-url>/dsh-mail/api/doctor` (offline, no secrets in the output).
3. Accounts and permissions: tool `mail_accounts`.
4. Log lines start with the code: `journalctl -u <your-dsh-unit> | grep 'dsh-mail: MAIL_'` (or the terminal running `dsh web`).

## 1. Decision tree
- Doctor route answers 404, or no `mail_*` tools exist -> plugin not loaded: TROUBLESHOOTING "Common install problems", C1 and C2.
- Doctor check `settings` or `config` not ok, or `MAIL_SETTINGS_UNAVAILABLE` -> TROUBLESHOOTING entry 3 (Config on the default export, read-only v1, DSH 0.2.x rows).
- Doctor check `accounts` warns, or `MAIL_NO_ACCOUNTS` -> [HUMAN] add an account in Settings, Mail; then entry 4 (Allow agents).
- `MAIL_AGENT_DENIED`, `MAIL_TOOLS_DISABLED`, `MAIL_ACCOUNT_DISABLED`, `MAIL_CAPABILITY_UNSUPPORTED` -> entry 4: `mail_accounts` shows capabilities and permissions; tell the human which box is missing. Do not switch to another account to get around it.
- `MAIL_ACCOUNT_AUTH_FAILED`, `MAIL_CONNECT_FAILED`, `MAIL_SECRET_MISSING` -> entry 1: ask the human to press Test connection and read the failing step; app password, host, port, TLS mode. [HUMAN] for any secret.
- `MAIL_OAUTH_REAUTH`, doctor row `needsReauth`, a Reconnect banner -> entry 2. [HUMAN] presses Connect (the consent happens in the browser). Check the redirect URI with `GET /dsh-mail/api/oauth/redirect-uri` and the consent screen status (testing mode expires tokens after 7 days).
- `MAIL_OAUTH_FLOW_FAILED`, `MAIL_OAUTH_NOT_CONFIGURED` -> entry 2: own OAuth client, exact redirect URI, same browser session.
- New mail missing or late, `MAIL_IDLE_UNAVAILABLE`, `MAIL_MAILBOX_UNREACHABLE` -> entry 5: polling interval, IDLE, last sync status in the doctor row.
- Send refused or drafted: `MAIL_RATE_LIMITED` (wait `retryAfterSec`), `MAIL_UNSUBSCRIBE_REQUIRED`, `MAIL_TOO_MANY_RECIPIENTS`, `MAIL_QUEUE_CONFLICT`, `MAIL_STORE_FULL`, `MAIL_SEND_FAILED`, a result with `drafted: true` -> entry 6. A draft is not an error: show it to the human; deliver only with `confirm: true` after they agreed.
- Duplicate or missing drafts, `MAIL_OBJECT_NOT_FOUND` for a draft -> entry 7.
- Unsubscribe links, `MAIL_UNSUBSCRIBE_NOT_PUBLIC` -> entry 8 (public base URL, edge route without the login gate, loopback listener).
- SendGrid inbound silent, `MAIL_INBOUND_REJECTED` -> entry 9 and C9.
- `MAIL_ACCOUNT_INVALID` with api.baseUrl in the message -> entry 10 (https or loopback http only).
- HTTP 403 from a route, `MAIL_TOKEN_INVALID`, `MAIL_SESSION_COOKIE_MISSING`, `MAIL_REQUEST_FORBIDDEN` -> entry 11: reload the tab, trusted hosts.
- `MAIL_OUTBOX_GONE` -> entry 12 (restart inside the undo window).
- `MAIL_DATA_PERMISSIONS`, `MAIL_CACHE_UNAVAILABLE`, `MAIL_NOT_READY` -> entry 15.
- `MAIL_INTERNAL` -> collect the log line (it is scrubbed) and the steps; report a bug.
- Mail tab missing -> entry 14, C1 and C4.

## 2. Fixes you may apply
- Read-only calls: `mail_accounts`, `mail_folders` list, `mail_list_queue`, `mail_search`, `mail_doctor`, `GET` routes.
- `mail_mass_send` with `dryRun: true` to explain a guard rail (it sends nothing).
- Cancelling or deleting only drafts and queue entries you created in this task.
- Everything else (settings, permissions, secrets, provider consoles, proxy, restart) is [HUMAN].

## 3. Steps that need the human
Ask one question at a time, with the exact place to click: Settings, Mail, the account, the box or button. For provider consoles say what to create (app password, OAuth client, verified sender) and where to paste it. Never ask the human to paste a secret into the chat.

## 4. Report back
Tell the human: the failing check or code, the cause you found, what you changed (usually nothing), and what they must do next. Include the verify step that proves the fix (Test connection ok, doctor status ok, a message arrived).
