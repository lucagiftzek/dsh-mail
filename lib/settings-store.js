/**
 * dsh-mail / settings-store.js: the ONE place that reads and writes settings.
 *
 * Built on lib/dual-settings.js (vendored, shared by the estate plugins):
 *   register  DSH 0.1.x: ctx.settings.register, the dsh-mail section of
 *             settings.yaml, live
 *   forms     DSH 0.1.7+/0.2.x: the exported live `Config`, values in the
 *             profile cordis.patch.yml row, written with
 *             ctx.settings.update(entryId, patch); the old dsh-mail section is
 *             imported once from settings.yaml(.imported), with its secrets
 *             moved into the 0600 secrets file first
 *   config    no settings service (not injected, headless, tests): layers
 *             DEFAULTS < settings.yaml(.imported) block < apply() config
 *             < <data dir>/settings.json (0600), writable through the routes
 *
 * Secrets never go through this module's writes: lib/secrets.js holds them.
 * In forms mode, while the one-time import has not succeeded, the legacy
 * section is layered over the row so the install keeps its old values.
 */

'use strict'

import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'

import { createDualSettings, plain } from './dual-settings.js'

const require = createRequire(import.meta.url)

function isObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v) }

export function mergeLayers(under, over) {
  if (!isObj(under) || !isObj(over)) return over === undefined ? under : over
  const out = { ...under }
  for (const [k, v] of Object.entries(over)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
    out[k] = k in out ? mergeLayers(out[k], v) : v
  }
  return out
}

/** DSH 0.2.x passes live Config fields as references read with .get(). */
export function unwrapConfig(v) { return plain(v) }

/** Read the `ns` block of the first existing settings YAML file under dshHome (sync). */
export function readLegacyYamlBlock(dshHome, ns, files = ['settings.yaml', 'settings.yaml.imported']) {
  for (const f of files) {
    const p = join(dshHome, f)
    if (!existsSync(p)) continue
    try {
      const YAML = require('yaml')
      const doc = YAML.parse(readFileSync(p, 'utf8'))
      if (isObj(doc) && isObj(doc[ns])) return { block: doc[ns], file: f }
      return { block: null, file: f }
    } catch { return { block: null, file: f, error: 'unreadable' } }
  }
  return { block: null, file: null }
}

/** The config-mode store: a 0600 JSON layer over defaults, the legacy YAML block and the row config. */
export class FileLayer {
  constructor({ path, defaults, config, schema, legacyBlock, warn }) { Object.assign(this, { path, defaults, config, schema, legacyBlock, warn }) }
  readFile() { try { const j = JSON.parse(readFileSync(this.path, 'utf8')); return isObj(j) ? j : {} } catch { return {} } }
  base() {
    let v = structuredClone(this.defaults)
    if (isObj(this.legacyBlock)) v = mergeLayers(v, this.legacyBlock)
    if (isObj(this.config)) v = mergeLayers(v, plain(this.config))
    return v
  }
  get() {
    const v = mergeLayers(this.base(), this.readFile())
    if (this.schema) { try { return plain(this.schema(v)) } catch (e) { if (this.warn) this.warn('settings invalid (' + e.message + '); using unvalidated values') } }
    return v
  }
  async update(patch) {
    const next = mergeLayers(this.readFile(), patch)
    if (this.schema) this.schema(mergeLayers(this.base(), next))
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const tmp = this.path + '.tmp-' + process.pid
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.path)
    try { chmodSync(this.path, 0o600) } catch {}
  }
}

const IMPORT_OK = new Set(['imported', 'already-configured', 'no-legacy-section', 'not-needed'])

/**
 * @param ctx      plugin ctx (reading ctx.settings may throw on 0.2 without inject: handled by the helper)
 * @param config   apply() config
 * @param o        { ns, schema, defaults, dataDir, dshHome, secrets (SecretStore), log, warn, metaUrl }
 */
export function createSettingsStore(ctx, config, o) {
  const legacyBlock = () => {
    const found = readLegacyYamlBlock(o.dshHome, o.ns, ['settings.yaml.imported', 'settings.yaml'])
    return found.block ? { block: o.secrets ? o.secrets.extractLegacy(found.block).section : found.block, file: found.file } : { block: null, file: found.file }
  }
  const dual = createDualSettings(ctx, config, {
    ns: o.ns, packageName: o.ns, schema: o.schema || null, base: o.defaults, autoForm: false, log: o.log, warn: o.warn, metaUrl: o.metaUrl,
    legacy: { transform: (patch) => (o.secrets ? o.secrets.extractLegacy(patch).section : patch) },
  })
  let file = null
  let fileLegacy = null
  if (dual.mode === 'config') {
    fileLegacy = legacyBlock()
    file = new FileLayer({ path: join(o.dataDir, 'settings.json'), defaults: o.defaults, config, schema: o.schema || null, legacyBlock: fileLegacy.block, warn: o.warn })
  }
  let overlay = null
  return {
    get mode() { return dual.mode },
    ready: dual.ready,
    get() {
      if (dual.mode === 'config') return file.get()
      const v = plain(dual.get())
      if (dual.mode === 'forms' && !IMPORT_OK.has(dual.importOutcome)) {
        if (!overlay) overlay = legacyBlock()
        if (overlay.block) return mergeLayers(v, overlay.block)
      }
      return v
    },
    canWrite() { return dual.mode === 'config' ? true : dual.writable() },
    async update(patch) {
      if (dual.mode === 'config') return file.update(patch)
      overlay = null
      return dual.update(patch)
    },
    describe() {
      const d = dual.describeStore()
      return { ...d, file: file ? file.path : null, legacySource: dual.mode === 'config' ? (fileLegacy && fileLegacy.file) : null }
    },
  }
}
