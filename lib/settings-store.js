/**
 * dsh-mail / settings-store.js: the ONE place that reads and writes settings.
 *
 * Two hosts are supported:
 *   1. DSH with ctx.settings.register (0.1.x): the dsh-mail namespace of
 *      ~/.dsh/settings.yaml, registered with the schemastery schema, live.
 *   2. DSH without ctx.settings (0.2.x): layers, lowest first:
 *        DEFAULTS
 *        < the dsh-mail block of ~/.dsh/settings.yaml or settings.yaml.imported
 *          (read only; 0.2.x renames settings.yaml on first boot and does not
 *          import plugin sections, so Luca's values are picked up from there)
 *        < the `config` the cordis row passes to apply(ctx, config)
 *        < <dataDir>/settings.json (0600): what the Mail settings editor saves
 *
 * Merge rule in both modes: plain objects merge recursively, arrays and
 * scalars replace. update(patch) never touches settings.yaml in file mode.
 *
 * Not used on purpose (yet): the 0.2.x native path (a schemastery `Config`
 * export with .volatile() fields stored in the profile cordis.patch.yml and
 * written with ctx.settings.update(entryId, patch)). It keeps secrets in the
 * profile patch file and cannot be verified on 0.1.x; the 0600 file store
 * works on both. Revisit when the estate runs 0.2.x.
 */

'use strict'

import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'

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

/** DSH 0.2.x passes volatile Config fields as live references read with .get(). */
export function unwrapConfig(v, depth = 0) {
  if (depth > 8 || v == null) return v
  if (typeof v === 'object' && !Array.isArray(v) && typeof v.get === 'function') return unwrapConfig(v.get(), depth + 1)
  if (Array.isArray(v)) return v.map(x => unwrapConfig(x, depth + 1))
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unwrapConfig(x, depth + 1)]))
  return v
}

/** Read the `ns` block of the first existing settings YAML file under dshHome. */
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

export class SettingsStore {
  /**
   * @param o { ctx, config, ns, schema, defaults, dataDir, dshHome, log, warn }
   */
  constructor(o) {
    this.o = o
    this.scope = null
    this.mode = 'file'
    const { ctx, ns, schema, defaults } = o
    if (schema && ctx && ctx.settings && typeof ctx.settings.register === 'function') {
      try {
        this.scope = ctx.settings.register(ns, schema, { base: structuredClone(defaults), applies: 'live' })
        this.mode = 'dsh-settings'
      } catch (e) { if (o.warn) o.warn('settings register failed, using the file store: ' + e.message) }
    }
    this.filePath = join(o.dataDir, 'settings.json')
    this.legacy = this.mode === 'file' ? readLegacyYamlBlock(o.dshHome, ns) : { block: null, file: null }
  }

  readFile() {
    try { const j = JSON.parse(readFileSync(this.filePath, 'utf8')); return isObj(j) ? j : {} } catch { return {} }
  }

  /** The effective raw settings (before plugin-level normalisation). */
  get() {
    if (this.scope && typeof this.scope.get === 'function') {
      try { return this.scope.get() } catch {}
    }
    let v = structuredClone(this.o.defaults)
    if (isObj(this.legacy.block)) v = mergeLayers(v, this.legacy.block)
    if (isObj(this.o.config)) v = mergeLayers(v, unwrapConfig(this.o.config))
    v = mergeLayers(v, this.readFile())
    if (this.o.schema) { try { return this.o.schema(v) } catch (e) { if (this.o.warn) this.o.warn('settings invalid (' + e.message + '); using unvalidated values') } }
    return v
  }

  canWrite() { return this.mode === 'file' || !!(this.scope && typeof this.scope.update === 'function') }

  /** Merge a patch (arrays replace). Throws when the result is invalid. */
  async update(patch) {
    if (this.mode === 'dsh-settings') {
      if (!this.scope || typeof this.scope.update !== 'function') throw new Error('settings service unavailable')
      return this.scope.update(patch)
    }
    const next = mergeLayers(this.readFile(), patch)
    if (this.o.schema) {
      let v = structuredClone(this.o.defaults)
      if (isObj(this.legacy.block)) v = mergeLayers(v, this.legacy.block)
      if (isObj(this.o.config)) v = mergeLayers(v, unwrapConfig(this.o.config))
      this.o.schema(mergeLayers(v, next))
    }
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const tmp = this.filePath + '.tmp-' + process.pid
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.filePath)
    try { chmodSync(this.filePath, 0o600) } catch {}
  }

  describe() {
    return { mode: this.mode, file: this.mode === 'file' ? this.filePath : null, legacySource: this.legacy.file }
  }
}
