# dsh-mail

Agent email tools for the DeepSeek Harness. Send, mass-send (CSV-personalised),
schedule, read inbox, list domains, and queue emails for manual review — all
from the sidebar Mail tab, with 6 provider backends.

## Providers

| ID | Backend | Auth | Inbox read |
|----|---------|------|------------|
| lettermint | Lettermint API | x-lettermint-token | no |
| agentmail | AgentMail API | Bearer | yes |
| resend | Resend API | Bearer | no |
| ovh | OVH SMTP | user/pass | via IMAP (planned) |
| smtp | Manual SMTP | user/pass | via IMAP (planned) |
| local | Self-host SMTP | user/pass | via IMAP (planned) |

## Agent tools

- **mail_send** — send one email
- **mail_mass_send** — CSV-personalised bulk send with inter-email delay
- **mail_send_later** — schedule an email for future sending
- **mail_read** — read recent inbox messages (AgentMail)
- **mail_fetch** — fetch a single message by ID
- **mail_domains** — list available sending domains/inboxes
- **mail_list_queue** — list queue entries
- **mail_cancel** — cancel a queued/scheduled email

## Sidebar tab

The Mail tab (order 91) shows:
- Overview: provider status, queue counts
- Queue: pending, sent, failed, cancelled entries with Send-now / Cancel
- Send: compose and send a test email
- Settings: configure all provider credentials and limits

## Installation

```bash
cd /opt/stacks/llm/plugins/dsh-mail
pnpm install   # dev deps (esbuild)
pnpm build     # bundle src/client.jsx → lib/client.js
```

Then add the plugin to the web profile:

```bash
# In ~/.dsh/profiles/web/package.json, add to dependencies:
"   \"dsh-mail\": \"file:/opt/stacks/llm/plugins/dsh-mail\","

# And to the bundles array:
"   \"dsh-mail\","

pnpm install --dir ~/.dsh/profiles/web
```

Restart dsh-web to mount the plugin (ask the user first — this session runs
inside dsh-web).

## Settings

Settings live in `~/.dsh/settings.yaml` under the `dsh-mail` namespace.
Credentials are auto-populated from estate files on first use:
- Lettermint: `~/.config/lettermint/credentials` (`LETTERMINT_API_KEY`)
- AgentMail: `~/.config/agentmail/credentials` (`AGENTMAIL_API_KEY`, `AGENTMAIL_TEST_INBOX`)

Credentials are **never** hard-coded in the repo. They are read at call time
and merged with settings (settings win only when non-empty).

> Credential provenance on this estate (2026-09-19): the populated
> `LETTERMINT_API_KEY` lives in `~/.config/erioun-prod/credentials` on Main
> (the Erioun prod service's key — same `x-lettermint-token` auth the plugin
> uses). It was filled into the empty `LETTERMINT_API_KEY=` line of the local
> `~/.config/lettermint/credentials` on BlackServer so dsh-mail's estate
> discovery picks it up. Verified live: POST /v1/send with an empty payload
> returns 422 (auth accepted, validation rejects), never 401. No key value is
> stored in this repo, in settings.yaml, or in any artifact.

## Kill switch

Set `DSH_MAIL_DISABLE=1` in the environment or `disabled: true` in cordis
to disable the plugin.

## Architecture

```
lib/index.js      host half — tools, settings, routes, timer
lib/providers.js  multi-provider transport layer
lib/staging.js    queue management, CSV parsing, template personalisation
lib/security.js   4-layer route security (loopback, trust fence, capability, cookie)
src/client.jsx    browser half — sidebar tab UI
scripts/build.mjs esbuild bundler
```

See [docs/DESIGN.md](docs/DESIGN.md) for the full architecture.
