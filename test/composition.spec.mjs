/**
 * The stage before the entries: did the profile compose the bundles it names?
 *
 * The entry sweep cannot answer this. A bundle the launcher skipped contributes
 * **no entries at all** — no fiber, no `internal/status` event, nothing to await —
 * so the process starts with a smaller composition than its own configuration
 * declares and every remaining entry activates perfectly. That is discussion
 * #9451's defect, and the arms below are built so that the healthy-entry-tree /
 * stopped-bundle arm is the one that fails if this half is removed: the entry
 * count is asserted alongside the finding, so "it reported something" cannot pass
 * for "it reported the composition".
 *
 * The two halves are measured against their real owners. The launcher's facts come
 * from `ctx.profileContext`, provided as a service exactly as app-boot provides it;
 * the declaration comes from a real `<profile>/package.json` on disk; and the skip
 * reason comes from the real `@deepseek-ai/dsh-app-boot` — which this package
 * deliberately does not depend on, so the reachable branch here is its absence,
 * and the arm pins that absence to a message rather than to a skip.
 *
 * @module test/composition.spec
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { collideEntry, waitFor, world } from './harness.mjs'

/** The module under test, through the package's own public surface. */
const {
  APP_BOOT,
  auditComposition,
  profileFactsOf,
  readDeclaredBundles,
  readSkippedBundles,
  renderReport,
  renderSummary,
  stoppedBundles,
} = await import('../lib/index.js')

/** Directories this file created, removed at the end of the run. */
const scratch = []
after(() => { while (scratch.length > 0) rmSync(scratch.pop(), { recursive: true, force: true }) })

/** A real profile directory. `manifest` is written verbatim, or omitted entirely. */
function profileDir(manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'activation-doctor-profile-'))
  scratch.push(dir)
  if (manifest !== undefined) {
    writeFileSync(join(dir, 'package.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
  }
  return dir
}

/** A context stub whose only job is `get`. */
function ctxWith(value) {
  return { get: name => (name === 'profileContext' ? value : undefined) }
}

/** The launcher's facts, as app-boot supplies them. */
function facts(overrides = {}) {
  return {
    name: 'staging',
    dir: profileDir({ name: 'staging', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }),
    installAnchor: '/anchor',
    startedBundles: ['@deepseek-ai/dsh-base'],
    ...overrides,
  }
}

/** A reason reader that records its calls, so "never consulted" is measurable. */
function recordingReader(rows = []) {
  const calls = []
  const reader = async (dir, anchor) => { calls.push({ dir, anchor }); return rows }
  return { reader, calls }
}

describe('reading the launcher\'s facts', () => {
  it('takes the name, the directory, the anchor and the started bundles', () => {
    const given = facts()
    assert.deepEqual(profileFactsOf(ctxWith(given)), {
      name: 'staging',
      dir: given.dir,
      installAnchor: '/anchor',
      startedBundles: ['@deepseek-ai/dsh-base'],
    })
  })

  it('falls back to the directory\'s own name when the launcher named no profile', () => {
    const given = facts({ name: '' })
    assert.equal(profileFactsOf(ctxWith(given)).name, given.dir.split('/').pop())
  })

  it('answers "not a profile" for a plain cordis application', () => {
    assert.equal(profileFactsOf(ctxWith(undefined)), undefined, 'no service')
    assert.equal(profileFactsOf({ get: () => undefined }), undefined)
  })

  it('answers "not a profile" rather than throwing when the lookup itself throws', () => {
    assert.equal(profileFactsOf({ get: () => { throw new Error('service lookup rejected') } }), undefined)
  })

  it('refuses a shape it cannot read, instead of claiming a composition from it', () => {
    // Each of these is a field the module reads. Coercing any of them would turn
    // "this is not the launcher I know" into a composition claim about a process
    // this plugin has no facts about.
    const unreadable = [
      facts({ dir: undefined }),
      facts({ dir: '' }),
      facts({ startedBundles: undefined }),
      facts({ startedBundles: '@deepseek-ai/dsh-base' }),
      facts({ startedBundles: ['@deepseek-ai/dsh-base', 7] }),
      null,
      'a string',
    ]
    for (const value of unreadable) {
      assert.equal(profileFactsOf(ctxWith(value)), undefined, `${JSON.stringify(value)} is not readable`)
    }
  })
})

describe('reading the profile manifest', () => {
  it('reads the declared bundles, and treats a missing key as an empty declaration', async () => {
    const dir = profileDir({ name: 'staging', dsh: { profile: { bundles: ['a', 'b'] } } })
    assert.deepEqual(await readDeclaredBundles(dir), { bundles: ['a', 'b'] })
    // "Names nothing" and "could not be read" lead to opposite conclusions, so the
    // first is a list and only the second is an error.
    assert.deepEqual(await readDeclaredBundles(profileDir({ name: 'bare' })), { bundles: [] })
  })

  it('reports a manifest it could not read, rather than an empty declaration', async () => {
    const cases = [
      [profileDir(undefined), /could not be read/],
      [profileDir('{ not json'), /not valid JSON/],
      [profileDir('"a string"'), /not an object/],
      [profileDir({ dsh: { profile: { bundles: 'a' } } }), /not a list/],
      [profileDir({ dsh: { profile: { bundles: ['a', 7] } } }), /non-string entry/],
    ]
    for (const [dir, pattern] of cases) {
      const read = await readDeclaredBundles(dir)
      assert.equal('bundles' in read, false, `${dir} must not read as an empty declaration`)
      assert.match(read.error, pattern)
    }
  })
})

describe('auditing the composition', () => {
  it('is silent — and imports nothing — when the declaration and the process agree', async () => {
    const given = facts({
      dir: profileDir({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }),
    })
    const { reader, calls } = recordingReader()
    const audit = await auditComposition(ctxWith(given), reader)
    assert.deepEqual(audit.missing, [])
    assert.equal(audit.reasons, 'unavailable')
    // The reader is the dynamic import of the launcher. The healthy case runs on
    // every start, so it must not reach for it at all.
    assert.deepEqual(calls, [], 'the launcher is not consulted when there is nothing to explain')
  })

  it('names the bundle the profile declared and the process did not start from', async () => {
    const given = facts({
      dir: profileDir({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'the-missing-one'] } } }),
    })
    const { reader, calls } = recordingReader([{ packageName: 'the-missing-one', reason: 'cannot resolve it' }])
    const audit = await auditComposition(ctxWith(given), reader)
    assert.deepEqual(audit.declared, ['@deepseek-ai/dsh-base', 'the-missing-one'])
    assert.deepEqual(audit.started, ['@deepseek-ai/dsh-base'])
    assert.deepEqual(audit.missing, [{ packageName: 'the-missing-one', reason: 'cannot resolve it' }])
    assert.equal(audit.reasons, 'dsh-app-boot')
    assert.equal(calls.length, 1, 'the launcher is consulted once, for the diff')
    assert.equal(calls[0].dir, given.dir)
    assert.equal(calls[0].anchor, given.installAnchor)
  })

  it('keeps the finding when the launcher cannot be reached, and says why', async () => {
    const given = facts({
      dir: profileDir({ dsh: { profile: { bundles: ['the-missing-one'] } } }),
    })
    const audit = await auditComposition(ctxWith(given), async () => { throw new Error('the launcher is not reachable') })
    // The reason is advisory: it can explain a finding, never remove one.
    assert.deepEqual(audit.missing, [{ packageName: 'the-missing-one', reason: undefined }])
    assert.equal(audit.reasons, 'unavailable')
    assert.equal(audit.reasonsError, 'the launcher is not reachable')
  })

  it('does not invent a reason for a bundle the launcher\'s list does not mention', async () => {
    const given = facts({ dir: profileDir({ dsh: { profile: { bundles: ['the-missing-one'] } } }) })
    const { reader } = recordingReader([{ packageName: 'some-other-bundle', reason: 'not this one' }])
    const audit = await auditComposition(ctxWith(given), reader)
    assert.deepEqual(audit.missing, [{ packageName: 'the-missing-one', reason: undefined }])
    assert.equal(audit.reasons, 'dsh-app-boot', 'the reader answered — it just had nothing for this bundle')
  })

  it('refuses to address a loader it was given no anchor for', async () => {
    const given = facts({ installAnchor: '', dir: profileDir({ dsh: { profile: { bundles: ['the-missing-one'] } } }) })
    const { reader, calls } = recordingReader([{ packageName: 'the-missing-one', reason: 'never asked for' }])
    const audit = await auditComposition(ctxWith(given), reader)
    assert.deepEqual(calls, [], 'a reader with no anchor to resolve from cannot be called')
    assert.deepEqual(audit.missing, [{ packageName: 'the-missing-one', reason: undefined }])
    assert.match(audit.reasonsError, /install anchor/)
  })

  it('still reports the findings when the manifest itself could not be read', async () => {
    const audit = await auditComposition(ctxWith(facts({ dir: profileDir(undefined) })), async () => [])
    assert.equal(audit.declared, undefined)
    assert.match(audit.declaredError, /could not be read/)
    // And it says "unknown", not "nothing is wrong": with no declaration there is
    // no diff to compute, which is not the same claim as an empty one.
    assert.deepEqual(audit.missing, [])
  })

  it('is undefined for a host that is not a dsh profile', async () => {
    assert.equal(await auditComposition(ctxWith(undefined)), undefined)
  })

  it('reports the stopped bundles through the one shared accessor', async () => {
    assert.deepEqual(stoppedBundles(undefined), [])
    assert.deepEqual(stoppedBundles({ missing: [{ packageName: 'x', reason: undefined }] }), [{ packageName: 'x', reason: undefined }])
  })
})

describe('recovering the launcher\'s own reason', () => {
  it('reports that the launcher is unreachable rather than inventing a reason', async () => {
    // This package declares no dependency on the launcher — that is what keeps it
    // mountable anywhere — so in this tree the reachable branch is its absence.
    // The arm pins the absence to a message naming the package: a future revision
    // that started depending on it would fail here loudly rather than pass because
    // a guard swallowed a negative.
    await assert.rejects(
      () => readSkippedBundles(profileDir(undefined), '/anchor'),
      error => {
        assert.match(String(error.message), new RegExp(APP_BOOT.replace(/[/@.]/g, '\\$&')))
        return true
      },
    )
  })
})

describe('the two projections of one audit', () => {
  /** Rendering bounds, spelled out so a bound in an assertion is the one used. */
  const options = { maxEntries: 50, errorChars: 4000, includePending: true, summaryChars: 200 }

  /** An audit of one stopped bundle, with everything else defaulted. */
  function audit(overrides = {}) {
    return {
      profile: 'staging',
      dir: '/profiles/staging',
      declared: ['@deepseek-ai/dsh-base', '@acme/gone'],
      declaredError: undefined,
      started: ['@deepseek-ai/dsh-base'],
      missing: [{ packageName: '@acme/gone', reason: undefined }],
      reasons: 'unavailable',
      reasonsError: 'the launcher is not reachable',
      ...overrides,
    }
  }

  it('states a bundle with no reason rather than dropping it', () => {
    // The finding is the name; a reader shown the name with no explanation learns
    // exactly as much as the doctor knows, and learns that the doctor knows no more.
    const line = renderSummary([], options, undefined, 0, audit())
    assert.match(line, /activation-doctor: 1 profile bundle did not start/)
    assert.match(line, /profile bundle @acme\/gone: the launcher reported no reason for this one/)
  })

  it('collapses the launcher\'s own reason to one bounded line', () => {
    const long = `${'x'.repeat(500)}\n  and a second line`
    const line = renderSummary([], { ...options, summaryChars: 40 }, undefined, 0, audit({
      missing: [{ packageName: '@acme/gone', reason: long }],
      reasons: 'dsh-app-boot',
    }))
    const rendered = /profile bundle @acme\/gone: (.*)$/m.exec(line)[1]
    assert.equal(rendered.length, 41, 'bounded to the configured width, not the reason\'s')
    assert.match(rendered, /^x+…$/, 'one line, no interior newline')
  })

  it('says nothing at all when both halves are healthy', () => {
    assert.equal(renderSummary([], options, undefined, 0, audit({ declared: [], started: [], missing: [] })), '')
    assert.equal(renderSummary([], options, undefined, 0, undefined), '', 'no profile context, nothing to say')
  })

  it('counts what the declaration stated against what started, in the file', () => {
    const report = renderReport([], { phase: 'startup', settled: true, composition: audit() }, options, new Date(0))
    assert.match(report, /^profileBundles: 2 declared, 1 started, 1 did not start$/m)
    assert.match(report, /profile composition/)
    assert.match(report, /@acme\/gone/)
  })

  it('names where the reasons came from, on either path', () => {
    const recovered = renderReport([], {
      phase: 'startup', settled: true, composition: audit({ reasons: 'dsh-app-boot', reasonsError: undefined }),
    }, options, new Date(0))
    assert.match(recovered, new RegExp(`reasons: recovered from ${APP_BOOT.replace(/[/@.]/g, '\\$&')}`))
    const unavailable = renderReport([], { phase: 'startup', settled: true, composition: audit() }, options, new Date(0))
    assert.match(unavailable, /reasons: unavailable — the launcher is not reachable/)
  })

  it('says the declaration could not be read instead of counting nothing', () => {
    // The distinction the whole manifest reader exists for: "the profile names no
    // bundles" and "this process could not read what the profile names" are
    // different facts about the process, and only one of them is reassuring.
    const report = renderReport([], {
      phase: 'startup',
      settled: true,
      composition: audit({ declared: undefined, declaredError: 'the profile manifest could not be read: ENOENT', missing: [] }),
    }, options, new Date(0))
    assert.match(report, /^profileBundles: the declaration could not be read — the profile manifest could not be read: ENOENT$/m)
    assert.doesNotMatch(report, /0 declared/)
    assert.doesNotMatch(report, /profile composition/, 'with no diff there is no finding to write a section for')
  })

  it('makes no claim about a profile it was not given', () => {
    const report = renderReport([], { phase: 'startup', settled: true }, options, new Date(0))
    assert.doesNotMatch(report, /profileBundles:/)
    assert.doesNotMatch(report, /profile composition/)
  })
})

describe('the composition in a running process', () => {
  /** The report files the doctor filed in a world's home, oldest first. */
  function reports(home) {
    const dir = join(home, 'logs')
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter(name => name.startsWith('activation-')).sort()
      .map(name => readFileSync(join(dir, name), 'utf8'))
  }

  /** A profile whose manifest names one bundle more than this process started from. */
  function partialProfile() {
    const dir = mkdtempSync(join(tmpdir(), 'activation-doctor-live-profile-'))
    scratch.push(dir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'staging',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@acme/dsh-missing-plugin'] } },
    }))
    return {
      dir,
      context: {
        name: 'staging',
        dir,
        installAnchor: '/anchor',
        startedBundles: ['@deepseek-ai/dsh-base'],
      },
    }
  }

  it('reports a stopped bundle even though every entry activated', async () => {
    const profile = partialProfile()
    const w = await world({
      entries: [{ id: 'healthy', name: './fixtures/good.mjs' }],
      profileContext: profile.context,
    })
    try {
      assert.ok(await waitFor(() => reports(w.home).length === 1), 'a report is filed')
      const [report] = reports(w.home)
      // The two halves together are the proof: the entry sweep found nothing, and
      // the process is still short one bundle.
      assert.match(report, /entries did not activate: 0 of \d+/)
      assert.match(report, /profileBundles: 2 declared, 1 started, 1 did not start/)
      assert.match(report, /profile composition/)
      assert.match(report, /@acme\/dsh-missing-plugin/)
      // The report states where the reasons came from either way: recovered from
      // the launcher, or unavailable *with a reason why* — never a blank. Asserted
      // as the invariant rather than as one branch, so the arm measures the plugin
      // on a tree that carries app-boot and on one that does not; which branch
      // *this* tree takes is pinned by the arm that reads the launcher, and both
      // spellings are pinned exactly by the renderer arm above.
      assert.match(report, /^reasons: (recovered from @deepseek-ai\/dsh-app-boot|unavailable — \S.*)$/m)
      // With no entry finding there is no entry paragraph to write.
      assert.doesNotMatch(report, /still installed and still enabled/)
    } finally {
      await w.dispose()
    }
  })

  it('says the same thing on the terminal, in one line per stopped bundle', async () => {
    const profile = partialProfile()
    const w = await world({
      entries: [{ id: 'healthy', name: './fixtures/good.mjs' }],
      profileContext: profile.context,
    })
    try {
      assert.ok(await waitFor(() => w.stderr.text().includes('did not start')), 'a summary line is printed')
      const line = w.stderr.text()
      assert.match(line, /activation-doctor: 1 profile bundle did not start/)
      // The bundle is named with its reason on the same line. Which reason text
      // appears depends on whether this tree can reach the launcher — the
      // renderer arm above pins both spellings, so this one pins the position.
      assert.match(line, /^ {2}profile bundle @acme\/dsh-missing-plugin: \S.*$/m)
      assert.doesNotMatch(line, /did not activate/, 'no entry finding is claimed')
    } finally {
      await w.dispose()
    }
  })

  it('answers the on-demand query from the same facts', async () => {
    const profile = partialProfile()
    const w = await world({
      entries: [{ id: 'healthy', name: './fixtures/good.mjs' }],
      profileContext: profile.context,
    })
    try {
      assert.ok(await waitFor(() => w.stderr.text().includes('did not start')))
      const result = await w.ctx.tools.execute({
        signal: new AbortController().signal,
        callId: 'call-composition',
        name: 'activation_status',
        arguments: {},
      })
      const text = result.content?.[0]?.type === 'text' ? result.content[0].text : ''
      assert.match(text, /Every entry is active \(or switched off deliberately\)\./)
      assert.match(text, /1 profile bundle did not start/)
      assert.match(text, /@acme\/dsh-missing-plugin/)
    } finally {
      await w.dispose()
    }
  })

  it('leaves a live report about live failures, without repeating the launch fact', async () => {
    const profile = partialProfile()
    const w = await world({
      entries: [{ id: 'healthy', name: './fixtures/good.mjs' }, collideEntry('collide-a', 'a')],
      profileContext: profile.context,
    })
    try {
      assert.ok(await waitFor(() => reports(w.home).length === 1))
      await w.mount({ id: 'late-collide', name: './fixtures/collide-b.mjs' })
      assert.ok(await waitFor(() => reports(w.home).some(text => text.includes('phase: live'))), 'a live report is filed')
      const live = reports(w.home).find(text => text.includes('phase: live'))
      assert.match(live, /late-collide/, 'the live failure is named')
      // The composition is a launch fact: it is written once, where it belongs,
      // rather than re-stated as if it were new on every later sweep.
      assert.doesNotMatch(live, /profile composition/)
    } finally {
      await w.dispose()
    }
  })

  it('says there was nothing to audit on a host that is not a profile', async () => {
    const w = await world({ entries: [collideEntry('collide-a', 'a'), collideEntry('collide-b', 'b')] })
    try {
      assert.ok(await waitFor(() => reports(w.home).length === 1))
      const [report] = reports(w.home)
      assert.doesNotMatch(report, /profileBundles:/, 'no claim is made about a profile that does not exist')
      assert.doesNotMatch(report, /profile composition/)
      const result = await w.ctx.tools.execute({
        signal: new AbortController().signal,
        callId: 'call-no-profile',
        name: 'activation_status',
        arguments: {},
      })
      const text = result.content?.[0]?.type === 'text' ? result.content[0].text : ''
      // Absent has to be legible: "nothing was composed badly" and "there was
      // nothing to compose" are different answers.
      assert.match(text, /no profile composition to audit/)
    } finally {
      await w.dispose()
    }
  })

  it('can be switched off, leaving the entry sweep alone', async () => {
    const profile = partialProfile()
    const w = await world({
      entries: [collideEntry('collide-a', 'a'), collideEntry('collide-b', 'b')],
      profileContext: profile.context,
      config: { composition: false },
    })
    try {
      // Both halves of the finding, waited for: the file is written before the
      // line, so a synchronous read of stderr here could pass a negative by
      // arriving early rather than by the switch working.
      assert.ok(await waitFor(() => reports(w.home).length === 1 && w.stderr.text().includes('activation-doctor:')))
      const [report] = reports(w.home)
      assert.match(report, /collide-b/, 'the entry sweep is untouched')
      assert.doesNotMatch(report, /profileBundles:/)
      assert.doesNotMatch(w.stderr.text(), /did not start/)
      const result = await w.ctx.tools.execute({
        signal: new AbortController().signal,
        callId: 'call-off',
        name: 'activation_status',
        arguments: {},
      })
      const text = result.content?.[0]?.type === 'text' ? result.content[0].text : ''
      assert.match(text, /collide-b/, 'the query still answers about the entries')
      assert.doesNotMatch(text, /profile bundle did not start/, 'the query is silent about the composition too')
    } finally {
      await w.dispose()
    }
  })
})
