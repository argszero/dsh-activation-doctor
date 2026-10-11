/**
 * The integration harness: a REAL cordis context, the REAL loader plugin, the REAL
 * tool registry, and REAL plugin modules on disk.
 *
 * Nothing about the seam is simulated. The doctor is mounted either as a plain
 * cordis plugin or as a loader **entry** — the same way a profile mounts it —
 * and the entries it reports on are real modules the real loader imports and
 * really fails, including the incident's own mechanism: two plugins registering
 * the same tool name, with the second one's registration throwing out of its body
 * and taking its fiber down. A control arm mounts everything except the doctor,
 * so "the report names the failure" can be measured against the same failure
 * happening with nothing to name it.
 *
 * `process.stderr` is captured, not mocked away: the plugin deliberately writes
 * the line to the real sink, because the harness's own logger has no sink in
 * either shipped profile, and a test that injected a private sink would be
 * testing a different program.
 *
 * @module test/harness
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as doctor from '../lib/index.js'

/** The loader's base URL: fixture specifiers resolve beside this file. */
export const BASE_URL = import.meta.url

/** Capture `process.stderr` writes for the duration of one harness. */
function captureStderr() {
  const original = process.stderr.write
  const chunks = []
  process.stderr.write = chunk => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk))
    return true
  }
  return {
    /** Everything written so far. */
    text: () => chunks.join(''),
    /** Forget what has been written, keeping the capture installed. */
    clear: () => { chunks.length = 0 },
    /** Put the real sink back. */
    restore: () => { process.stderr.write = original },
  }
}

/**
 * Build a world.
 *
 * @param spec - `doctor: false` mounts everything except the doctor (the control
 *   arm); `doctor: 'entry'` mounts it the way a profile does, as a loader entry;
 *   `config` is the doctor's configuration; `entries` are the fixture entries to
 *   create after the doctor; `home` overrides the harness home directory;
 *   `profileContext` is the launcher's own service, provided exactly as a real
 *   `dsh` profile provides it — absent means this process is a plain cordis
 *   application, which is the other half of what the composition section has to
 *   get right.
 * @returns the context, the loader, the stderr capture, the home directory and a
 *   `dispose` that restores the process sink and removes the home directory.
 */
export async function world(spec = {}) {
  const home = spec.home ?? mkdtempSync(join(tmpdir(), 'activation-doctor-'))
  const stderr = captureStderr()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home

  const ctx = new Context()
  // The launcher's service, provided the way app-boot provides it — as a plain
  // service on the root context, before any fiber exists. A world that omits it
  // reproduces a plain cordis application, where `ctx.get` answers `undefined`.
  if (spec.profileContext !== undefined) ctx.provide('profileContext', spec.profileContext)
  await ctx.plugin(Loader, { baseUrl: BASE_URL })
  // `SystemPrompt` first: the real `ToolRuntime` constructor wires its schema
  // catalog into `ctx.systemPrompt`, so mounting it alone would leave a failed
  // fiber and no registry at all — measured, not assumed.
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (ctx.get('tools') === undefined) throw new Error('harness: the tool registry did not come up')

  const config = { debounceMs: 10, reportDir: join(home, 'logs'), ...(spec.config ?? {}) }
  // Entries first, the doctor last: a profile appends the doctor's row to the
  // composition, so it is the last entry created and it observes a tree that is
  // already being mounted. Creating it first would hide any ordering assumption.
  for (const entry of spec.entries ?? []) {
    await ctx.loader.create(entry)
  }
  await ctx.loader.await()
  if (spec.doctor === 'direct') {
    await ctx.plugin(doctor, config)
  } else if (spec.doctor !== false) {
    await ctx.loader.create({ id: 'activation-doctor', name: './fixtures/doctor.mjs', config })
  }
  await ctx.loader.await()

  return {
    ctx,
    home,
    config,
    stderr,
    /** Create one more entry after startup, as a hot reload or a late mount does. */
    async mount(entry) {
      await ctx.loader.create(entry)
      await ctx.loader.await()
    },
    /**
     * Create several entries at once, the way a profile's own tree does.
     *
     * `EntryTree.update` creates a configuration file's new rows through
     * `Promise.all`, so a plugin can be mid-import while another plugin's `apply`
     * is already running — which is the case the doctor's settle-first rule
     * exists for. Awaiting each `create` in turn would never produce it.
     */
    async mountTogether(entries) {
      await Promise.all(entries.map(entry => ctx.loader.create(entry)))
      await ctx.loader.await()
    },
    /** Wait for the loader to have no pending work at all. */
    async settle() {
      await ctx.loader.await()
    },
    /**
     * End the world: tear the context down, then restore the process sink.
     *
     * Disposing the root fiber is what stops the doctor — its effect disposer
     * clears the timer and its `internal/status` subscription, so a world that is
     * over cannot write into the next world's capture. The sink is restored
     * *after* the teardown, so anything the plugin says while unloading is still
     * captured rather than printed over the test output.
     */
    async dispose() {
      try {
        await ctx.fiber.dispose()
      } catch {
        // A world is over; a teardown that throws must not mask the assertion
        // that made the test fail.
      }
      stderr.restore()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      rmSync(home, { recursive: true, force: true })
    },
  }
}

/**
 * Wait for a predicate, polling until it holds or the deadline passes.
 *
 * The doctor reports on a timer, so every assertion about its output has to wait
 * for the report rather than read it synchronously — and a fixed sleep would be
 * both slower and flakier than this.
 * @param predicate - the condition to wait for.
 * @param timeoutMs - how long to wait.
 * @returns whether the predicate held.
 */
export async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise(resolve => { setTimeout(resolve, 10) })
  }
  return await predicate()
}

/** The fixture entry that registers a tool under a name another entry also uses. */
export function collideEntry(id, suffix) {
  return { id, name: `./fixtures/collide-${suffix}.mjs` }
}
