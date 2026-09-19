#!/usr/bin/env node
/**
 * dsh-mail — browser-half build.
 *
 * Bundles src/client.jsx → lib/client.js wrapped in a ModuleLoader factory,
 * exactly like dsh-hpc does. The wrapper is what lets the harness inject
 * react/react-jsx-runtime without the plugin shipping them.
 *
 * Run: node scripts/build.mjs        (or: pnpm run build)
 */
import { build } from 'esbuild'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const outfile = join(root, 'lib', 'client.js')

if (!existsSync(join(root, 'lib'))) mkdirSync(join(root, 'lib'), { recursive: true })

const banner = [
  "window.__ModuleLoader__.load({",
  "  id: 'dsh-mail',",
  "  factory: function (require) {",
  "    var module = { exports: {} };",
  "    var exports = module.exports;",
].join('\n')

const footer = [
  "    return module.exports;",
  "  }",
  "});",
].join('\n')

async function main() {
  await build({
    entryPoints: [join(root, 'src', 'client.jsx')],
    bundle: true,
    outfile,
    format: 'iife',
    platform: 'browser',
    target: ['chrome110', 'firefox110', 'safari16'],
    jsx: 'automatic',
    banner: { js: banner },
    footer: { js: footer },
    external: ['react', 'react/jsx-runtime'],
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'info',
  })

  // Touch the output so the harness HMR picks it up.
  console.log('dsh-mail: bundle written to lib/client.js')
}

main().catch((err) => {
  console.error('dsh-mail build failed:', err)
  process.exit(1)
})
