/**
 * The stage before the composition: did the profile ever *select* what it installed?
 *
 * The two arms beside this one read lists the running process holds — the loader's
 * entries, and the bundles the launcher composed its tree from. A package that was
 * installed and never entered `dsh.profile.bundles` is in neither, so both arms can
 * report a perfectly healthy world while the package the operator installed is
 * simply not there. That is discussion #9261's state: the package manager finished,
 * the CLI never returned, and the reconcile step that appends the package to the
 * bundle list therefore never ran.
 *
 * Two things about the arms below are load-bearing.
 *
 * **The qualifier is the design.** Most dependencies are not bundles, so a check
 * that reported every dependency missing from the bundle list would be a storm of
 * false findings. The bundle claim is read from the package's own manifest, the way
 * the harness's `bundleManifest` reads it — `dsh.bundle.patch` defined — and the arm
 * that proves it is not noise installs a dependency declaring no `dsh.bundle` in the
 * *same* tree as a real finding, so "it reported something" cannot pass for "it
 * reported the right package".
 *
 * **Resolution is measured against real directories.** The rule being mirrored is
 * an ordering (`resolveBundleDir` searches the installation anchor before the
 * profile), so the fixtures are real profile directories with real
 * `node_modules/<name>/package.json` files, and the reader seam is driven only where
 * a *read* has to fail or be counted — never to fake a resolution.
 *
 * The first arm of `the findings in a real profile` is also the arm that caught the
 * defect this round fixed, and it caught it because its manifest is a real one:
 * `dependencies` in a `package.json` is an npm **map**, and the first cut of this
 * arm read it with the list reader `dsh.profile.bundles` uses. Every fixture in the
 * suite whose manifest simply omitted the key passed; a manifest carrying one failed
 * the *whole profile parse*, which would have taken the already-shipped composition
 * arm down with it. The manifest in that arm is written the way npm writes one —
 * `{"@acme/hot-installer": "^0.5.4"}` — and a unit arm beside it pins the map
 * reading directly, so the mistake cannot come back unnoticed.
 *
 * @module test/installed.spec
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { waitFor, world } from './harness.mjs'

/** The module under test, through the package's own public surface. */
const {
  MAX_INSPECTED,
  auditComposition,
  auditInstalledSelection,
  inspectManifest,
  packageDirFor,
  readDeclaredProfile,
  renderReport,
  renderSummary,
  searchPathsFor,
  unselectedPackages,
} = await import('../lib/index.js')

/** Directories this file created, removed at the end of the run. */
const scratch = []
after(() => { while (scratch.length > 0) rmSync(scratch.pop(), { recursive: true, force: true }) })

/** A fresh directory. */
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

/** Write one package under `<root>/node_modules/<name>/package.json`, as npm leaves it. */
function install(root, name, manifest) {
  const dir = join(root, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
  return dir
}

/**
 * A real profile directory: the manifest npm would find, plus what was installed.
 *
 * `dependencies` is written as the **map** npm writes, which is the shape that makes
 * this fixture a profile rather than a stub.
 */
function profile({ dependencies = {}, bundles = [], installed = {} } = {}) {
  const dir = tempDir('activation-doctor-installed-')
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${dir.split('/').pop()}`,
    private: true,
    dependencies,
    dsh: { profile: { bundles } },
  }, undefined, 2)}\n`)
  for (const [name, manifest] of Object.entries(installed)) install(dir, name, manifest)
  return dir
}

/** A context stub whose only job is `get`. */
function ctxWith(value) {
  return { get: name => (name === 'profileContext' ? value : undefined) }
}

/**
 * A reader that records which package directories it was asked for.
 *
 * It reads the package's own `package.json` the way the shipped default reader does
 * — this is the audit's traversal under test, and a reader that answered from a map
 * instead of from disk would have made the resolution arms above it the only real
 * evidence. `throws` maps a directory to the error that read should raise, which is
 * the one thing a real file cannot be asked to do.
 */
function recordingReader({ throws = {} } = {}) {
  const asked = []
  const reader = async packageDir => {
    asked.push(packageDir)
    if (packageDir in throws) throw new Error(throws[packageDir])
    return JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  }
  return { reader, asked }
}

describe('reading a package\'s own bundle claim', () => {
  it('is a bundle only when dsh.bundle.patch is defined — the harness\'s own test', () => {
    // `bundleManifest` reads `manifest.dsh?.bundle?.patch === undefined` as "not a
    // bundle", so a package carrying an empty `bundle` object is an ordinary
    // dependency. Reporting it would be the false finding this arm must never make.
    for (const manifest of [{}, { dsh: {} }, { dsh: { bundle: {} } }, { dsh: { bundle: { icon: './i.png' } } }]) {
      const claim = inspectManifest(manifest)
      assert.equal(claim.patches, undefined, `${JSON.stringify(manifest)} declares no patch`)
      assert.equal(claim.patchError, undefined)
    }
  })

  it('reads one patch file, or an ordered list of them', () => {
    assert.deepEqual(inspectManifest({ dsh: { bundle: { patch: './cordis.patch.yml' } } }).patches, ['./cordis.patch.yml'])
    assert.deepEqual(
      inspectManifest({ dsh: { bundle: { patch: ['a.yml', 'b.yml'] } } }).patches,
      ['a.yml', 'b.yml'],
    )
  })

  it('reports a malformed declaration instead of dropping it', () => {
    // app-boot throws on this while loading the bundle ("must be a file path or a
    // list of file paths"), so the package *is* claiming to be a bundle and the
    // profile loses it. Silence here would hide a real one.
    for (const patch of [7, {}, [1], ['a', 2]]) {
      const claim = inspectManifest({ dsh: { bundle: { patch } } })
      assert.equal(claim.patches, undefined)
      assert.match(claim.patchError, /must be a file path or a list of file paths/)
    }
  })

  it('reads a version when there is one, and refuses to invent the rest', () => {
    assert.equal(inspectManifest({ version: '1.2.3' }).version, '1.2.3')
    for (const manifest of [undefined, null, 'a string', 7, { version: '' }, { version: 7 }]) {
      const claim = inspectManifest(manifest)
      assert.equal(claim.version, undefined)
      assert.equal(claim.patches, undefined, 'a value that is not a manifest is not a bundle')
    }
  })
})

describe('resolving an installed package', () => {
  it('finds a dependency in the profile\'s own node_modules', () => {
    const dir = profile({ dependencies: { '@acme/plugin': '^1.0.0' }, installed: { '@acme/plugin': { version: '1.0.0' } } })
    // No installation anchor: the launcher supplied none, which is the case the
    // profile branch has to answer on its own.
    const found = packageDirFor('@acme/plugin', dir, '')
    assert.equal(found?.from, 'profile')
    assert.equal(found?.dir, join(dir, 'node_modules', '@acme/plugin'))
  })

  it('searches the installation anchor first, the way the loader resolves a bundle', () => {
    // The order is `resolveBundleDir`'s contract: an in-box bundle always comes
    // from the running installation, never from a profile-local copy — so when
    // both anchors hold the package, the installation is the one that answers.
    const installation = tempDir('activation-doctor-install-')
    install(installation, 'both/plugin', { version: '9.9.9' })
    const dir = profile({ installed: { 'both/plugin': { version: '1.0.0' } } })
    const found = packageDirFor('both/plugin', dir, join(installation, 'package.json'))
    assert.equal(found?.from, 'installation')
    assert.equal(found?.dir, join(installation, 'node_modules', 'both/plugin'))
  })

  it('answers "not resolvable" rather than throwing when there is no anchor', () => {
    const dir = profile({})
    assert.equal(packageDirFor('@acme/nothing', dir, ''), undefined)
    assert.deepEqual(searchPathsFor('', 'x'), [])
    assert.deepEqual(searchPathsFor('relative/package.json', 'x'), [], 'a relative anchor cannot be resolved from')
  })
})

describe('reading the two declarations of a real manifest', () => {
  it('reads dependencies as the map npm writes, in manifest order', async () => {
    // The shape that matters: an object of names to ranges. `dsh.profile.bundles`
    // is an array and `dependencies` is not, and a reader that assumed otherwise
    // would fail here on the manifest every real profile has.
    const dir = profile({
      dependencies: { '@acme/b-plugin': '^0.5.4', '@acme/a-plugin': '~1.2.3' },
      bundles: ['@deepseek-ai/dsh-base'],
    })
    const read = await readDeclaredProfile(dir)
    assert.deepEqual(read, { profile: { bundles: ['@deepseek-ai/dsh-base'], dependencies: ['@acme/b-plugin', '@acme/a-plugin'] } })
  })

  it('still treats an absent key as an empty declaration, and a bad one as unreadable', async () => {
    // Absent is empty (`dependencies` is optional), a list of names is accepted
    // because it states the same thing, and anything else is reported rather than
    // read as "this profile has no dependencies".
    assert.deepEqual(
      await readDeclaredProfile(profile({ bundles: [] })),
      { profile: { bundles: [], dependencies: [] } },
    )
    assert.deepEqual(
      await readDeclaredProfile(profile({ dependencies: undefined, bundles: [] })),
      { profile: { bundles: [], dependencies: [] } },
    )
    const listed = tempDir('activation-doctor-listed-')
    writeFileSync(join(listed, 'package.json'), JSON.stringify({ dependencies: ['@acme/x]'.slice(0, -1)] }))
    assert.deepEqual(await readDeclaredProfile(listed), { profile: { bundles: undefined, dependencies: ['@acme/x'] } })
    for (const dependencies of ['a string', 7, null, ['a', 2]]) {
      const dir = tempDir('activation-doctor-baddeps-')
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies }))
      const read = await readDeclaredProfile(dir)
      assert.equal('error' in read, true, `${JSON.stringify(dependencies)} must not read as an empty dependency list`)
      assert.match(read.error, /dependencies/)
    }
  })
})

describe('auditing the installed-but-not-selected gap', () => {
  /** A profile with one bundle-declaring dependency installed beside one plain dependency. */
  function twoPackages() {
    return profile({
      dependencies: { '@acme/hot': '^0.5.4', 'left-pad': '^1.3.0' },
      bundles: [],
      installed: {
        '@acme/hot': { version: '0.5.4', dsh: { bundle: { patch: './cordis.patch.yml' } } },
        'left-pad': { version: '1.3.0' },
      },
    })
  }

  it('reports the package that declares a bundle and was never selected', async () => {
    const dir = twoPackages()
    const { reader, asked } = recordingReader()
    const audit = await auditInstalledSelection(
      { dir, installAnchor: '', dependencies: ['@acme/hot'], bundles: [] },
      reader,
    )
    assert.deepEqual(asked, [join(dir, 'node_modules', '@acme/hot')], 'the installed copy is the one read')
    assert.deepEqual(audit.unselected, [{
      packageName: '@acme/hot',
      version: '0.5.4',
      patches: ['./cordis.patch.yml'],
      patchError: undefined,
      from: 'profile',
    }])
    assert.deepEqual(audit.uninspected, [])
    assert.equal(audit.truncated, 0)
  })

  it('stays silent for a dependency that declares no bundle — the shape of most dependencies', async () => {
    const dir = twoPackages()
    const { reader, asked } = recordingReader()
    const audit = await auditInstalledSelection(
      { dir, installAnchor: '', dependencies: ['left-pad'], bundles: [] },
      reader,
    )
    assert.deepEqual(audit.unselected, [], 'an ordinary dependency is not a finding')
    // And it says so by having looked: the silence is a classification, not a miss.
    assert.deepEqual(asked, [join(dir, 'node_modules', 'left-pad')])
  })

  it('does not even resolve a dependency the profile already selected', async () => {
    const dir = twoPackages()
    const { reader, asked } = recordingReader()
    const audit = await auditInstalledSelection(
      { dir, installAnchor: '', dependencies: ['@acme/hot'], bundles: ['@acme/hot'] },
      reader,
    )
    assert.deepEqual(audit.unselected, [])
    // Selected is a non-finding by definition, and skipping it keeps a healthy
    // profile's cost at one Set lookup per dependency rather than a file read.
    assert.deepEqual(asked, [], 'a selected package is not read at all')
  })

  it('separates a coverage gap from a finding', async () => {
    const dir = twoPackages()
    const { reader } = recordingReader({
      throws: { [join(dir, 'node_modules', '@acme/hot')]: 'EACCES: permission denied, open \'package.json\'' },
    })
    const audit = await auditInstalledSelection(
      { dir, installAnchor: '', dependencies: ['@acme/hot'], bundles: [] },
      reader,
    )
    // An unreadable manifest is a gap in this audit, not a defect in the profile:
    // turning it into a finding would make an incomplete audit look like a broken
    // installation, and swallowing it would read as coverage this audit lacks.
    assert.deepEqual(audit.unselected, [])
    assert.equal(audit.uninspected.length, 1)
    assert.match(audit.uninspected[0].reason, /could not be read: EACCES/)
  })

  it('says which dependencies it could not resolve, rather than calling them plain', async () => {
    const dir = twoPackages()
    const audit = await auditInstalledSelection(
      { dir, installAnchor: '', dependencies: ['@acme/not-installed'], bundles: [] },
      async () => { throw new Error('must not be called') },
    )
    assert.deepEqual(audit.unselected, [])
    assert.equal(audit.uninspected.length, 1)
    assert.match(audit.uninspected[0].reason, /not resolvable/)
  })

  it('bounds its own work and reports what it left out', async () => {
    const dependencies = Array.from({ length: MAX_INSPECTED + 3 }, (_, index) => `pkg-${String(index)}`)
    const audit = await auditInstalledSelection(
      { dir: profile({}), installAnchor: '', dependencies, bundles: [] },
      async () => { throw new Error('unreachable in this tree') },
    )
    assert.equal(audit.truncated, 3)
    assert.equal(audit.uninspected.length, MAX_INSPECTED, 'the bound is on inspection, not on reporting')
  })
})

describe('the shared accessor', () => {
  it('answers an empty list for a host that audited nothing', () => {
    assert.deepEqual(unselectedPackages(undefined), [])
    assert.deepEqual(unselectedPackages({}), [])
  })

  it('answers the audit\'s own list for a host that audited something', () => {
    const entry = { packageName: '@acme/hot', version: '0.5.4', patches: ['a.yml'], patchError: undefined, from: 'profile' }
    assert.deepEqual(unselectedPackages({ installed: { unselected: [entry] } }), [entry])
  })
})

describe('the findings in a real profile', () => {
  it('names the installed package the manifest never selected, and not its ordinary neighbour', async () => {
    // The two dependencies differ in exactly one property — whether their own
    // manifest declares a bundle — and both must be inspected (neither is
    // selected). An arm that reported either the wrong one, or both, fails here.
    //
    // This is also the arm that caught the read of `dependencies` as a list: the
    // manifest below is written the way npm writes one, and the first cut of this
    // arm failed the whole parse on it — which would have taken `declared` and the
    // shipped composition arm with it. The assertions on `declared` are therefore
    // not decoration.
    const dir = profile({
      dependencies: { '@acme/hot-installer': '^0.5.4', 'left-pad': '^1.3.0' },
      bundles: ['@deepseek-ai/dsh-base'],
      installed: {
        '@acme/hot-installer': { version: '0.5.4', dsh: { bundle: { patch: './cordis.patch.yml' } } },
        'left-pad': { version: '1.3.0' },
      },
    })
    const audit = await auditComposition(
      ctxWith({ name: 'desktop', dir, installAnchor: '', startedBundles: ['@deepseek-ai/dsh-base'] }),
      async () => [],
    )
    assert.equal(audit.declaredError, undefined)
    assert.deepEqual(audit.declared, ['@deepseek-ai/dsh-base'])
    assert.deepEqual(audit.installed.dependencies, ['@acme/hot-installer', 'left-pad'])
    assert.deepEqual(audit.installed.unselected.map(entry => entry.packageName), ['@acme/hot-installer'])
    assert.equal(audit.installed.unselected[0].version, '0.5.4')
    assert.deepEqual(audit.installed.uninspected, [], 'both dependencies were inspected')
    // The composition stage stays silent: the manifest agrees with the process, and
    // that agreement is precisely what this stage exists to see through.
    assert.deepEqual(audit.missing, [])
  })

  it('is skipped when the manifest cannot be read — there is nothing to compare', async () => {
    const dir = tempDir('activation-doctor-broken-')
    writeFileSync(join(dir, 'package.json'), '{ not json')
    const audit = await auditComposition(
      ctxWith({ name: 'desktop', dir, installAnchor: '', startedBundles: [] }),
      async () => [],
    )
    assert.match(audit.declaredError, /not valid JSON/)
    assert.equal(audit.installed, undefined, 'an unreadable manifest is not an empty dependency list')
  })

  it('leaves the two lists out of an audit for a host that is not a profile', async () => {
    assert.equal(await auditComposition(ctxWith(undefined), async () => []), undefined)
  })
})

describe('the two projections of one audit', () => {
  /** Rendering bounds, spelled out so a bound in an assertion is the one used. */
  const options = { maxEntries: 50, errorChars: 4000, includePending: true, summaryChars: 400 }

  /** An audit carrying one unselected package, with everything else defaulted. */
  function audit(overrides = {}) {
    return {
      profile: 'desktop',
      dir: '/profiles/desktop',
      declared: ['@deepseek-ai/dsh-base'],
      declaredError: undefined,
      started: ['@deepseek-ai/dsh-base'],
      missing: [],
      reasons: 'unavailable',
      reasonsError: undefined,
      installed: {
        dependencies: ['@acme/hot-installer'],
        bundles: ['@deepseek-ai/dsh-base'],
        unselected: [{
          packageName: '@acme/hot-installer',
          version: '0.5.4',
          patches: ['./cordis.patch.yml'],
          patchError: undefined,
          from: 'profile',
        }],
        uninspected: [],
        truncated: 0,
      },
      ...overrides,
    }
  }

  it('announces it on the terminal line even when every entry activated', () => {
    const summary = renderSummary([], options, '/tmp/report.log', 0, audit())
    assert.match(summary, /activation-doctor: 1 package installed but never selected/)
    assert.match(summary, /^ {2}unselected @acme\/hot-installer: installed 0\.5\.4 — declares dsh\.bundle\.patch \.\/cordis\.patch\.yml — absent from dsh\.profile\.bundles \(resolved from the profile\)$/m)
    assert.match(summary, /report: \/tmp\/report\.log/)
    assert.doesNotMatch(summary, /did not activate/, 'no entry finding is claimed')
  })

  it('writes the section, with the install path to follow, into the durable report', () => {
    const text = renderReport([], { phase: 'startup', settled: true, composition: audit() }, options, new Date(0))
    assert.match(text, /profileBundles: 1 declared, 1 started, 1 installed but never selected/)
    assert.match(text, /^installed but never selected$/m)
    assert.match(text, /^@acme\/hot-installer@0\.5\.4$/m)
    assert.match(text, /^ {2}dsh\.bundle\.patch: \.\/cordis\.patch\.yml$/m)
    assert.match(text, /^ {2}resolved from the profile; absent from dsh\.profile\.bundles$/m)
    assert.match(text, /^To select it without reinstalling, add the name above to dsh\.profile\.bundles in the profile$/m)
    // Without an unselected package the section is not written at all, even though
    // the composition ran: the header line is the summary of a finding, not of an arm.
    const clean = renderReport([], {
      phase: 'startup',
      settled: true,
      composition: audit({ installed: { dependencies: ['left-pad'], bundles: [], unselected: [], uninspected: [], truncated: 0 } }),
    }, options, new Date(0))
    assert.doesNotMatch(clean, /installed but never selected/)
    assert.match(clean, /^profileBundles: 1 declared, 1 started$/m)
  })

  it('states its own coverage whenever it audited, and stays quiet when it did not', () => {
    const gap = audit({
      installed: {
        dependencies: ['a', 'b'],
        bundles: [],
        unselected: [],
        uninspected: [{ packageName: 'b', reason: 'its package.json could not be read: EACCES' }],
        truncated: 0,
      },
    })
    const text = renderReport([], { phase: 'startup', settled: true, composition: gap }, options, new Date(0))
    assert.match(text, /^coverage: 1 of 2 dependencies could not be inspected$/m)
    assert.match(text, /^ {2}b: its package\.json could not be read: EACCES$/m)
    // Without the audit there is no coverage claim to make: a host that is not a
    // dsh profile says nothing rather than saying "nothing was missed".
    const none = renderReport([], { phase: 'startup', settled: true }, options, new Date(0))
    assert.doesNotMatch(none, /coverage:/)
    assert.doesNotMatch(none, /profileBundles:/)
    assert.equal(renderSummary([], options, undefined, 0, undefined), '')
  })

  it('renders a truncated audit as the gap it is, on both projections', () => {
    const truncated = audit({
      installed: {
        dependencies: ['a'],
        bundles: [],
        unselected: [],
        uninspected: [],
        truncated: 4,
      },
    })
    const text = renderReport([], { phase: 'startup', settled: true, composition: truncated }, options, new Date(0))
    assert.match(text, /^profileBundles: 1 declared, 1 started, 4 left uninspected by the audit's bound$/m)
    assert.match(text, /^coverage: 4 left uninspected by the audit's bound$/m)
  })

  it('renders a malformed declaration as the reason the package was reported', () => {
    const broken = audit({
      installed: {
        dependencies: ['@acme/hot-installer'],
        bundles: [],
        unselected: [{
          packageName: '@acme/hot-installer',
          version: undefined,
          patches: [],
          patchError: 'dsh.bundle.patch must be a file path or a list of file paths',
          from: 'installation',
        }],
        uninspected: [],
        truncated: 0,
      },
    })
    const summary = renderSummary([], options, undefined, 0, broken)
    assert.match(summary, /declares a malformed dsh\.bundle\.patch/)
    assert.match(summary, /resolved from the installation/)
    assert.match(summary, /installed —/, 'a package with no version says so rather than inventing one')
  })
})

describe('against a mounted doctor', () => {
  /** The reports the doctor filed, oldest first. */
  function reports(home) {
    const dir = join(home, 'logs')
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter(name => name.startsWith('activation-')).sort()
      .map(name => readFileSync(join(dir, name), 'utf8'))
  }

  it('prints the finding and files it, with the entry tree entirely healthy', async () => {
    // The end-to-end arm: a real cordis world, the real service the launcher
    // provides, a real profile directory on disk — and no failing entry at all, so
    // this finding is the only thing the doctor has to say. That is the case the
    // composition and entry arms are both blind to.
    const dir = profile({
      dependencies: { '@acme/hot-installer': '^0.5.4' },
      bundles: ['@deepseek-ai/dsh-base'],
      installed: {
        '@acme/hot-installer': { version: '0.5.4', dsh: { bundle: { patch: './cordis.patch.yml' } } },
      },
    })
    const w = await world({
      entries: [{ id: 'healthy', name: './fixtures/good.mjs' }],
      profileContext: { name: 'desktop', dir, installAnchor: '', startedBundles: ['@deepseek-ai/dsh-base'] },
      config: { debounceMs: 10 },
    })
    try {
      assert.ok(await waitFor(() => reports(w.home).length === 1), `no report was filed: ${w.stderr.text()}`)
      const [report] = reports(w.home)
      // Both halves are the proof: the entry sweep found nothing, and a package the
      // profile installed is still not selected.
      assert.match(report, /entries did not activate: 0 of \d+/)
      assert.match(report, /profileBundles: 1 declared, 1 started, 1 installed but never selected/)
      assert.match(report, /installed but never selected/)
      assert.match(report, /@acme\/hot-installer@0\.5\.4/)
      assert.match(w.stderr.text(), /1 package installed but never selected/)
      assert.match(w.stderr.text(), /^ {2}unselected @acme\/hot-installer: /m)
    } finally {
      await w.dispose()
    }
  })

  it('says nothing at all when every installed bundle was selected', async () => {
    const dir = profile({
      dependencies: { '@acme/selected': '^1.0.0', 'left-pad': '^1.3.0' },
      bundles: ['@acme/selected'],
      installed: {
        '@acme/selected': { version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } },
        'left-pad': { version: '1.3.0' },
      },
    })
    const w = await world({
      entries: [{ id: 'healthy', name: './fixtures/good.mjs' }],
      profileContext: { name: 'desktop', dir, installAnchor: '', startedBundles: ['@acme/selected'] },
      config: { debounceMs: 10 },
    })
    try {
      // Wait for the sweep to have run — a report is filed only when something is
      // wrong, so its absence is not evidence that the sweep ran — and only then
      // require silence. The entry tree is healthy and nothing was missed.
      await waitFor(() => Promise.resolve(false), 300)
      assert.equal(w.stderr.text(), '', 'a healthy profile produces no output')
      assert.deepEqual(reports(w.home), [])
    } finally {
      await w.dispose()
    }
  })

  it('can be switched off, and then claims nothing about selection', async () => {
    const dir = profile({
      dependencies: { '@acme/hot-installer': '^0.5.4' },
      bundles: [],
      installed: {
        '@acme/hot-installer': { version: '0.5.4', dsh: { bundle: { patch: './cordis.patch.yml' } } },
      },
    })
    const w = await world({
      entries: [{ id: 'healthy', name: './fixtures/good.mjs' }],
      profileContext: { name: 'desktop', dir, installAnchor: '', startedBundles: [] },
      config: { debounceMs: 10, installed: false },
    })
    try {
      await waitFor(() => Promise.resolve(false), 300)
      assert.equal(w.stderr.text(), '', 'with the arm off there is nothing to report')
      assert.deepEqual(reports(w.home), [])
      // And the omission is the arm's absence rather than a clean bill of health:
      // the same facts with the arm on do produce the finding.
      const on = await auditComposition(
        ctxWith({ name: 'desktop', dir, installAnchor: '', startedBundles: [] }),
        async () => [],
      )
      assert.deepEqual(on.installed.unselected.map(entry => entry.packageName), ['@acme/hot-installer'])
      const off = await auditComposition(
        ctxWith({ name: 'desktop', dir, installAnchor: '', startedBundles: [] }),
        async () => [],
        { installed: false },
      )
      assert.equal(off.installed, undefined, 'switched off says nothing rather than saying "nothing found"')
      // The composition half is untouched either way.
      assert.deepEqual(off.started, [])
    } finally {
      await w.dispose()
    }
  })
})
