# dsh-mail Architecture

## Overview

dsh-mail is a DSH plugin that gives agents the ability to send and read email
through multiple provider backends. It follows the same architecture pattern
as dsh-hpc: a host half (Node ESM) that defines tools and API routes, and a
browser half (React JSX) that renders a sidebar tab.

## Host half (lib/)

### index.js

The main entry point. `apply(ctx)` receives the DSH context and:

1. **Registers settings** via schemastery schema at namespace `dsh-mail`
2. **Defines agent tools** via `ctx.tools.register(defineTool({...}))` — 8 tools
3. **Registers HTTP routes** at `/dsh-mail/api/*` via `ctx.webServer.register`
4. **Runs a tick timer** every `tickSeconds` to process scheduled queue entries
5. **Resolves credentials** at call-time from settings + estate files

### providers.js

Multi-provider transport layer. `buildProvider(id, creds)` returns a provider
object with a common interface:

- `enabled()` — whether the provider has the required credentials
- `name()` — human-readable provider name
- `send(ctx, msg)` — send an email, returns `{ messageId, from }`
- `recent(ctx, limit)` — read recent inbox messages (optional)
- `fetch(ctx, id)` — fetch a single message (optional)
- `domains(ctx)` — list sending domains/inboxes (optional)

Providers: lettermint, agentmail, resend, ovh, smtp, local.

### staging.js

Queue management. The `Queue` class stores entries as JSON files in
`~/.dsh/dsh-mail/queue/`. Each entry has a status: `queued`, `scheduled`,
`sent`, `failed`, `cancelled`.

Also provides:
- `parseCSV(text, maxRows)` — parse CSV with header row
- `personalise(template, row)` — `{column_name}` placeholder substitution
- `slugify(str)` — filesystem-safe slug

### security.js

4-layer route security, adapted from dsh-hpc:

1. **Loopback** — requests must come from 127.0.0.1
2. **Trust fence** — Host header must be in `trustedHosts`
3. **Capability token** — `x-dsh-mail-token` header must match a signed token
4. **Harness cookie** — `requireHarnessCookie` validates the session cookie

`checkReadRequest` checks layers 1-2; `checkMutateRequest` checks all 4.

## Browser half (src/)

### client.jsx

React component rendered in the sidebar. Four sections:
- **Overview** — provider status cards, queue summary
- **Queue** — list of queue entries with Send-now / Cancel actions
- **Send** — compose and send a test email
- **Settings** — configure provider credentials and limits

Styled with `--dsh-alias-*` design tokens to match the harness theme.

Built with esbuild (`scripts/build.mjs`) into `lib/client.js`, wrapped in a
`window.__ModuleLoader__.load()` factory.

## Data flow

```
Agent calls mail_send
  → index.js execute()
  → getProvider(settings, providerId)
  → provider.send(ctx, msg)
  → HTTP API to provider (Lettermint/AgentMail/Resend/SMTP)
  → return { ok, messageId }

Agent calls mail_mass_send
  → parseCSV → for each row: personalise → provider.send → sleep(delayMs)
  → or queue.create() if queueOnly=true

Timer tick (every 30s)
  → queue.due() → for each due entry: provider.send → queue.setStatus('sent')
```

## Security model

- Agents can send single emails immediately (mail_send)
- Mass sends and scheduled emails go through the queue
- The sidebar tab provides human review (Send-now / Cancel)
- All API routes require the trust fence + capability token
- Credentials are never sent to the browser in plaintext (masked in /state)
- Credential sources (read-only, merged at call time, settings win only when
  non-empty): `~/.config/lettermint/credentials` → `lettermintApiKey`,
  `~/.config/agentmail/credentials` → `agentmailApiKey` / `agentmailInbox`.
  On this estate the populated Lettermint key originates from
  `~/.config/erioun-prod/credentials` on Main (Erioun prod) and was copied
  into the local lettermint credentials file; see README "Settings".
