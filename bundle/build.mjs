#!/usr/bin/env node
/**
 * Build the bundle lib/ from the POC's TypeScript sources (plugin/*.ts).
 *
 * All @deepseek-ai/* imports in the plugin sources are `import type`, so the
 * emitted ESM has zero runtime deps outside Node builtins — the bundle needs
 * no @deepseek-ai install. Type errors from unresolved workspace types are
 * expected and tolerated (noEmitOnError=false) as long as emission succeeds.
 *
 * Usage:
 *   node bundle/build.mjs                 # uses DSH_CHECKOUT or the default checkout
 *   DSH_CHECKOUT=/path/to/deepseek-harness node bundle/build.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginDir = join(root, 'plugin')
const outDir = join(root, 'bundle', 'lib')
const dsh = process.env.DSH_CHECKOUT ?? '/Users/tonysprite/projects/github.com/deepseek-harness'
const tsc = join(dsh, 'node_modules', '.bin', 'tsc')

const sources = ['system-one-guard.ts', 'system-one-shortlist.ts', 'approval-logger.ts']
  .map((f) => join(pluginDir, f))

mkdirSync(outDir, { recursive: true })
let failed = false
for (const f of sources) {
  const out = join(outDir, `${f.split('/').pop().replace(/\.ts$/, '.js')}`)
  // Only re-emit when the source is newer than the output.
  let stale = true
  try {
    stale = statSync(f).mtimeMs > statSync(out).mtimeMs
  } catch { /* missing output -> rebuild */ }
  if (!stale) { console.log(`up to date: ${out}`); continue }
  rmSync(out, { force: true })
  const r = spawnSync(tsc, [
    '--ignoreConfig',
    f,
    '--outFile', out,
    '--module', 'esnext',
    '--moduleResolution', 'bundler',
    '--target', 'es2022',
    '--skipLibCheck',
    '--noEmitOnError', 'false',
    '--declaration', 'false',
    '--sourceMap', 'false',
  ], { stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`build failed for ${f}`)
    failed = true
  } else if (statSync(out).size === 0) {
    console.error(`no output for ${f}`)
    failed = true
  }
}
if (failed) process.exit(1)
