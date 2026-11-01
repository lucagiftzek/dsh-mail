# Preset probe

Run: 2026-10-31 04:54 UTC, timeout 6000 ms. TCP + TLS handshake (implicit TLS) or greeting (STARTTLS ports); docs = HTTP status of the documentation URL.

| Preset | Verified | IMAP | POP3 | SMTP | Docs |
|---|---|---|---|---|---|
| posteo | yes | ok | ok | ok | 200 |
| mailbox-org | yes | ok | ok | ok | 200 |
| infomaniak | yes | ok | ok | ok | 200 |
| migadu | yes | ok | ok | ok | 200 |
| runbox | yes | ok | ok | ok | 200 |
| soverin | yes | ok | n/a | ok | 200 |
| startmail | yes | ok | n/a | ok | 403 |
| mailfence | no | timeout | timeout | timeout | error |
| mailo | yes | ok | n/a | ok | 200 |
| mail-de | yes | ok | n/a | ok | 200 |
| gmx | yes | ok | ok | ok | 200 |
| web-de | yes | ok | ok | ok | 200 |
| eclipso | yes | ok | n/a | ok | 200 |
| hostpoint | yes | ok | n/a | ok | 200 |
| inbox-eu | yes | ok | n/a | ok | 200 |
| kolab-now | yes | ok | n/a | ok | 200 |
| ovh | yes | ok | ok | ok | 200 |
| ionos | yes | ok | ok | ok | 200 |
| custom-host | skipped (custom host) | | | | |
| proton-bridge | skipped (local bridge) | | | | |
| tuta | skipped (unsupported) | | | | |
| gmail | yes | ok | ok | ok | 200 |
| outlook | yes | ok | ok | ok | 200 |
| icloud | yes | ok | n/a | ok | 200 |
| yahoo | yes | ok | ok | ok | 200 |
| fastmail | yes | ok | ok | ok | 200 |
| zoho-eu | yes | ok | ok | ok | 200 |

Notes: Mailfence did not answer on any port from the probing host (as in the spec research), so it stays unverified. StartMail's documentation site answers 403 to non-browser clients; the page exists. Run `npm run probe-presets -- --write --docs --md docs/presets-probe.md` before a release.
