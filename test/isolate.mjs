/**
 * dsh-mail tests: imported FIRST by run.mjs. Points every path the plugin
 * reads on its own (estate credential files, the mailbox credentials file,
 * the DSH home, the data dir) at an empty temp directory, so no test can
 * ever read a real credential file of the machine it runs on. A test that
 * needs credentials passes canary values explicitly. The opt-in live check
 * (DSH_MAIL_LIVE_CHECK=1) reads the real settings on purpose and prints ids only.
 */
import { mkdtempSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

if (process.env.DSH_MAIL_LIVE_CHECK !== '1') {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mail-isolate-'))
  process.env.DSH_MAIL_ESTATE_HOME = join(root, 'no-estate-home')
  process.env.DSH_MAIL_MAILBOX_CREDENTIALS = join(root, 'no-mailbox-credentials')
  process.env.DSH_HOME = join(root, 'home')
  process.env.DSH_MAIL_DATA_DIR = join(root, 'data')
  mkdirSync(process.env.DSH_HOME, { recursive: true })
}
