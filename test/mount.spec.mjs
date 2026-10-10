/**
 * The object a profile entry mounts, mounted — and the one line that can stop it.
 *
 * `vendor/loader` normalises a plugin module with `exports.default ?? exports` and
 * hands that object to `ctx.plugin`, which validates `Config['~standard'].validate`
 * whenever the plugin carries a `Config`. This package exports no `Config` at all,
 * which is the shape that survives both mount spellings; the arm below is what
 * keeps it that way.
 *
 * The defect it is written against is one ten sibling packages shipped in
 * `0.1.0`: `export default { name, inject, apply, Config: defaultConfig }`, where
 * `defaultConfig` is a plain defaults object rather than a schema. It has no
 * `~standard`, so `resolveConfig` threw
 * `TypeError: Cannot read properties of undefined (reading 'validate')` before a
 * line of `apply` ran — and every one of those suites stayed green, because they
 * mount the module *namespace* (`import * as plugin`), which carries no `Config`
 * key of its own. The two mounts are one object apart, and only the default
 * export is what a profile entry reaches.
 *
 * The rest of this package's suite is not blind to that: its loader-entry fixture
 * re-exports `default`, so the real loader has been mounting the default export all
 * along. What this file adds is the *invariant* rather than the mount — for a
 * diagnostic whose whole job is to report a plugin that failed to mount, a mount
 * failure of its own is the worst bug it can have, and the rule is cheaper to
 * state once than to rediscover.
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import test from 'node:test'
import plugin from '../lib/index.js'

test('a `Config` on the default export is a schema cordis can validate with', () => {
  const Config = plugin.Config
  if (Config === undefined) return
  assert.equal(
    typeof Config['~standard']?.validate,
    'function',
    'cordis calls Config["~standard"].validate at mount; a plain defaults object throws there',
  )
})

/**
 * A loader stub that satisfies `inject: ['loader']` without mounting anything.
 *
 * The sweep reads `entries()` and, optionally, `getTasks()`. An empty loader is a
 * real answer to "which entries did not activate" — none — so the arm exercises
 * the whole `apply` body rather than a partial path.
 */
function loaderStub() {
  return { entries: () => [] }
}

test('the default export mounts, and reaches the end of `apply`', async () => {
  const registered = []
  const ctx = new Context()
  ctx.provide('loader', loaderStub())
  ctx.provide('tools', {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  })
  await ctx.plugin(plugin, { report: false, log: 'off' })
  // The tool is registered from inside the effect, through `ctx.inject`, so its
  // presence is the evidence that `apply` ran past config resolution and past the
  // effect body's first statements — a mount that throws never gets here.
  assert.equal(registered.length, 1, 'the default export must mount and register its tool')
  assert.equal(registered[0].name, 'activation_status')
  await ctx.fiber.dispose()
})

test('`enabled: false` is a mount that installs nothing', async () => {
  const registered = []
  const ctx = new Context()
  ctx.provide('loader', loaderStub())
  ctx.provide('tools', {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  })
  await ctx.plugin(plugin, { enabled: false })
  assert.deepEqual(registered, [], 'a disabled doctor registers nothing')
  await ctx.fiber.dispose()
})
