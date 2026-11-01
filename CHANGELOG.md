# Changelog

## 0.2.1 (2026-11-02)

- **Fix: white text on a white button in dark mode.** On a stock DSH theme in dark mode the host primary colour is near white, but the compose button, primary buttons, the queue badge, brand pills and the All inboxes avatar had hard-coded white text. They now use the host's paired foreground token (`--dsw-alias-label-primary-foreground`, white as the fallback), so they read in light and dark and with custom themes.

## 0.2.0 (2026-11-01)

A full mail client for DSH, rebuilt around accounts.

- **Accounts:** IMAP, POP3 and SMTP accounts next to the API senders, a local cache and a reading tab in the sidebar; Google and Microsoft accounts through OAuth2 (bring your own OAuth client); provider presets with an EU-first list; SendGrid as a sender.
- **Reading and search:** IMAP IDLE push, full-text search (SQLite FTS5), Drafts kept in sync with the server's Drafts folder, folder create and rename.
- **Writing:** Markdown and rich compose with autosave, a 6 second undo for sends.
- **Bulk mail guard rails:** per-recipient signed unsubscribe links (mailto and RFC 8058 one-click), a footer in English, Italian or Greek, automatic processing of unsubscribe mail, per-list and global suppression, campaigns, the `mail_suppression` tool.
- **Agent safety:** the send tools describe what every mail mode does, and every send result starts with SENT, DRAFT ONLY or SCHEDULED, so an agent cannot report a sent mail as a draft. `mail_accounts` states what a send call does in the current mode.
- **Server-side and encrypted:** remote images, CSS and fonts in mail are never fetched by the browser (blocked by default; "Load images" goes through a signed same-origin proxy with an SSRF guard), links open through a link page, provider APIs must be https, and IMAP, POP3 and SMTP require TLS.
- **Settings** work on DSH 0.1.5 and 0.2.x from one code base.
- **Troubleshooting:** stable `MAIL_*` error codes on routes and tools, `GET /dsh-mail/api/doctor` and the `mail_doctor` tool (offline, read-only), the `mail-doctor` skill, docs/TROUBLESHOOTING.md and docs/ERRORS.md.
- **Fix:** on DSH 0.2.1 several tools failed with "value is not lossless JSON"; results are sanitized at the tool boundary.

## 0.1.0

First release: send through API providers (Lettermint, AgentMail, Resend, OVH, SMTP), scheduled and mass sends from CSV, agent tools.
