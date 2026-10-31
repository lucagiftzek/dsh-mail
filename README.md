# dsh-mail

Mail for agents and humans in the DeepSeek Harness (DSH). Connect any IMAP or
POP3 mailbox, Gmail with an app password, a Tzekos Mail webmail, or a sending
service (Lettermint, Resend, AgentMail). Read your mail in the sidebar Mail
tab, and let agents read, search, file and send mail through the `mail_*`
tools, with sends drafted first by default.

Everything runs on your DSH host: mail is fetched straight from your own
servers into a local cache, nothing is sent anywhere else, and there is no
telemetry.

## What is in version 0.2 (phase 1 of v2)

- **Accounts** in DSH Settings: a "Mail" settings section (and the gear in the
  tab) to add, edit, test and remove accounts. Several accounts at once.
- **Account types**: generic IMAP + SMTP, POP3 + SMTP, Google (app password),
  self-hosted (IMAP or POP3), Tzekos Mail (webmail agent API, optional),
  Lettermint and Resend (send only), AgentMail.
- **Local cache** (built-in `node:sqlite`): folders, messages, threads and
  flags; initial sync of the last 90 days (newest 1000 per folder), then
  incremental by UID; background polling of every Inbox; retention setting.
- **Mail tab**: account switcher with "All inboxes", folder list with unread
  counts, thread list (unread dot, avatar, sender, time, subject, snippet,
  flag / attachment / count badges), search with `from:` `subject:`
  `is:unread` `has:attachment` `after:` `before:`, filter chips, quick actions
  (archive, delete, read / unread, flag), multi-select, reading view with
  sanitised HTML in a sandboxed frame, "Load images" on request, attachment
  downloads, a simple composer with reply and forward, and the review queue
  with agent drafts. Keyboard: j / k, Enter, e, #, r, c, /.
- **Agent tools**: every v0.1 tool keeps its name and arguments; new tools
  `mail_accounts`, `mail_folders`, `mail_search`, `mail_mark`, `mail_move`,
  `mail_draft`, `mail_attachments`.

Coming next: Google and Microsoft OAuth2 (phase 2), the EU provider presets
and SendGrid (phase 3), IMAP IDLE push, full-text search, rich compose and
undo send (phase 4).

## Accounts

Open **Settings, Mail** (or the gear in the Mail tab), pick a type and fill in
the form. **Test connection** logs in (IMAP LIST, POP3 STAT, SMTP verify or an
API call) and reports each step; it never shows a secret.

| Type | Incoming | Outgoing | Credentials |
|---|---|---|---|
| IMAP + SMTP | IMAP (TLS 993 or STARTTLS 143) | SMTP (TLS 465 or STARTTLS 587) | password or app password |
| POP3 + SMTP | POP3 (TLS 995 or STLS 110) | SMTP | password; read state is kept locally, mail stays on the server |
| Google | imap.gmail.com | smtp.gmail.com | app password (2-Step Verification required) |
| Self-hosted | IMAP or POP3 | SMTP | password; plaintext allowed only to a loopback host |
| Tzekos Mail | webmail `/api/agent` | same API | service token (never a user password) |
| Lettermint, Resend | none | API | API key |
| AgentMail | API inbox | API | API key + inbox id |

Settings shape (`dsh-mail` namespace):

```yaml
dsh-mail:
  accounts:
    - id: work                 # [a-z0-9-]{2,32}, used as the tool argument `account`
      label: Work mail
      type: imap-smtp
      address: me@example.com
      receive: { protocol: imap, host: imap.example.com, port: 993, security: tls }
      send:    { protocol: smtp, host: smtp.example.com, port: 465, security: tls }
      secrets: { password: "..." }        # or passwordFile: /path, or passwordEnv: NAME
      agent: { allow: true, canRead: true, canSend: true, canMass: false, default: true }
      limits: { maxRecipients: 500 }
  agents:
    confirmMode: all            # all | reply-only
  cache:
    retentionDays: 90           # 0 = headers only, -1 = keep
```

**Secrets** are returned to the browser only as `__set__` (stored) or empty.
Saving `__set__` keeps the stored value; typing a new value replaces it. Prefer
`passwordFile` or `passwordEnv` so no password sits in a settings file.

**Agents** see an account only when `agent.allow` is on (new accounts start
off). `canRead`, `canSend` and `canMass` narrow it further, and
`agents.allowedAccounts` can restrict the list globally.

**Draft first.** With `agents.confirmMode: all` (the default for new installs)
`mail_send` without `confirm: true` only creates a draft, shows it, and returns
a `draftId`; `mail_send({ draftId, confirm: true })` delivers it, or you send it
from the Queue pane of the tab. Mass and scheduled sends wait for approval in
the queue. `reply-only` keeps the v0.1 behaviour (only `mail_reply` drafts).

### Upgrading from v0.1

Nothing has to change. When no explicit account uses their ids, the v0.1
provider settings (`providers.*`, `mailboxBaseUrl`, `mailboxAgentToken`, the
Lettermint and AgentMail credential files, the mailbox credentials file)
become **virtual accounts** whose ids are the old provider ids (`lettermint`,
`agentmail`, `resend`, `ovh`, `smtp`, `local`, `tzmail`), so
`provider: "lettermint"` in old chats keeps working and they send through
exactly the v0.1 code path. An install that has only these virtual accounts
keeps `reply-only` and the old default provider (`lettermint`) unless you set
`agents.confirmMode` and `defaultProvider` yourself. Pinning them explicitly
before upgrading is recommended:

```yaml
dsh-mail:
  defaultProvider: lettermint
  agents: { confirmMode: reply-only }
  schemaVersion: 1
```

Behaviour change: queue entries in state `queued` (manual queue) are no longer
sent by the timer; they wait for **Send now** or **Approve** in the tab, as the
v0.1 documentation already described.

### DSH 0.2

On DSH versions without `ctx.settings.register`, settings are read from the
plugin row config and from a plugin-owned file `<data dir>/settings.json`
(mode 0600) that the settings editor writes through the plugin API; a v0.1
`dsh-mail` block left in `settings.yaml` or `settings.yaml.imported` is still
honoured as the lowest layer.

## Agent tools

| Tool | What it does |
|---|---|
| `mail_send` | send one message (`account`/`provider`, `to`, `cc`, `bcc`, `subject`, `text`, `html`, `replyTo`, `attachments`, `draftId`, `confirm`) |
| `mail_mass_send` | CSV-personalised bulk send with a delay; staged for review under draft-first |
| `mail_send_later` | schedule a send (`sendAt`) or queue it for manual send |
| `mail_read` | recent messages of any account that can read (`folder`, `unread`, `since`, `domain`, `address`) |
| `mail_fetch` | one message as text, by composite id `account:folder:uid`, API id or thread id |
| `mail_domains` | sender identities per account |
| `mail_list_queue`, `mail_cancel` | the review queue |
| `mail_inbox`, `mail_thread`, `mail_reply`, `mail_triage` | conversations (Tzekos Mail, or IMAP / POP3 via the cache with `account`) |
| `mail_contacts`, `mail_remind` | Tzekos Mail address book and reminders |
| `mail_accounts` | accounts visible to agents, capabilities, confirm mode, default account |
| `mail_folders` | folders with unread and total counts |
| `mail_search` | search the cache and the IMAP server |
| `mail_mark` | read, unread, flag, unflag |
| `mail_move` | inbox, archive, trash, spam or a folder path (never deletes permanently) |
| `mail_draft` | create, update, list, get, delete drafts (never sends) |
| `mail_attachments` | list attachments or save one to disk (returns the path) |

Tool output carries at most `agents.maxBodyChars` (default 8000) characters of
a body; HTML is converted to text.

## Security

- Every route sits behind four layers: loopback peer, trusted Host (plus
  `trustedHosts`), a short-lived capability token for mutations, and the DSH
  browser-session cookie.
- No read response ever contains a secret; provider errors are scrubbed.
- HTML mail is sanitised on the host (no scripts, forms, frames or event
  handlers, remote images blocked until you ask) and shown in a sandboxed
  frame without script permission under a strict Content Security Policy.
- Attachments download as attachments with `nosniff`; 25 MB cap.
- TLS certificates are verified unless an account opts in to
  `allowSelfSigned`; plaintext only to a loopback host.
- Cache, drafts, queue and settings files are created with mode 0600 in a
  0700 directory (`~/.dsh/mail`).

## Install

```bash
cd /path/to/dsh-mail
npm install          # runtime dependencies + esbuild for the bundle
npm run build        # verified build of src/*.jsx into lib/client.js
npm test             # unit, route security and end-to-end tests
```

Add the plugin to the web profile (`"dsh-mail": "link:/path/to/dsh-mail"` in
`~/.dsh/profiles/web/package.json` dependencies and `dsh-mail` in the bundle
list), then restart dsh-web. Ask the people using that DSH first: chats run
inside it. The browser half hot-reloads; the host half loads on restart.

**Kill switches:** `DSH_MAIL_DISABLE=1` in the dsh-web environment, or
`- id: dsh-mail` with `disabled: true` in `~/.dsh/profiles/web/cordis.patch.yml`.
`agents.enabled: false` hides all tools; `enabled: false` on an account turns
it off.

## Dependencies

Runtime: `imapflow` (MIT), `nodemailer` (MIT-0), `mailparser` (MIT),
`sanitize-html` (MIT), `yaml` (ISC). Tests and build: `esbuild` (MIT),
`hoodiecrow-imap` (MIT, in-memory IMAP + SMTP test server), `smtp-server`
(MIT-0). The POP3 client is a small built-in module (`lib/pop3.js`).

## Layout

```
lib/index.js           host entry: settings, routes, timers
lib/settings-store.js  settings access for DSH 0.1 and 0.2
lib/accounts.js        account model, legacy shim, secrets, permissions
lib/service.js         one interface over every account type
lib/imap.js            IMAP (imapflow) and folder sync
lib/pop3.js            POP3 client
lib/smtp.js            SMTP (nodemailer), header and recipient checks
lib/cache.js           node:sqlite cache and threading
lib/html.js            HTML sanitising for the reading view
lib/tools.js           agent tools
lib/drafts.js          local drafts
lib/staging.js         review queue, CSV
lib/providers.js       API providers (Lettermint, Resend, AgentMail, v0.1 transports)
lib/mailbox.js         Tzekos Mail agent API client
lib/security.js        route security
src/*.jsx              browser half (Mail tab, accounts editor)
```

See [docs/DESIGN.md](docs/DESIGN.md) for the design notes.

---

Built by Luca Tzekos, who also makes [**Job Opportunities API**](https://jobopportunitiesapi.org): employer-direct job data with per-field provenance you can verify yourself, free to read and available as an API. If this plugin is useful to you, a star on this repo or a look at [jobopportunitiesapi.org](https://jobopportunitiesapi.org) is the best thanks.
