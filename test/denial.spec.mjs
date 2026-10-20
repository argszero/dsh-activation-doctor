/**
 * The fourth stage: who switched this row off?
 *
 * `prepareProfileEntries` refuses a row by setting `disabled: true` on it before
 * the Loader is handed the entry list, so on the only surface a plugin can read a
 * machine refusal and an operator's decision are the same value. The reason goes
 * to stderr once, at composition time, and nowhere else. Discussion #10203 is the
 * clean form of it: a `--patch` row with no `name` at all.
 *
 * The arms below are built so that each one fails if its own half is removed.
 * The missing-name arm needs no dependency at all — it is the one case where the
 * declaration is structurally unreadable — so it is measured without a rule, and
 * the rule arms are measured through the seam with a rule that is the launcher's
 * shape. The coverage arm is paired with the finding arm, because the failure
 * this module must not make is turning its own blind spot into a finding.
 *
 * Every unit arm runs against a real profile directory on disk, because the
 * resolution under test is the loader's lookup and a stubbed one would prove
 * nothing about it.
 *
 * @module test/denial.spec
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

/** The module under test, through the package's own public surface. */
const {
  NO_NAME_REASON,
  UNRESOLVED_REASON,
  censusDenials,
  deniedRows,
  isBareSpecifier,
  renderReport,
  renderSummary,
  verdictOf,
} = await import('../lib/index.js')

/** Directories this file created, removed at the end of the run. */
const scratch = []
after(() => { while (scratch.length > 0) rmSync(scratch.pop(), { recursive: true, force: true }) })

/** A real profile directory, optionally carrying a dependency on disk. */
function profileDir(packages = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'activation-doctor-denial-'))
  scratch.push(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'staging' }))
  for (const [name, manifest] of Object.entries(packages)) {
    const packageDir = join(dir, 'node_modules', name)
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
  }
  return dir
}

/** Every file in a directory tree, with its contents — for the "never writes" arm. */
function snapshot(dir) {
  const files = {}
  const walk = current => {
    for (const item of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, item.name)
      if (item.isDirectory()) walk(path)
      else files[path] = readFileSync(path, 'utf8')
    }
  }
  walk(dir)
  return files
}

/** A context stub whose only job is `get`, as the launcher provides services. */
function ctxWith(services = {}) {
  return { get: name => services[name] }
}

/** One switched-off loader entry. `name` is omitted entirely when `undefined`. */
function off(id, name) {
  return { options: name === undefined ? { id } : { id, name }, disabled: true }
}

/** One loader entry that is not switched off. */
function on(id, name) {
  return { options: { id, name }, disabled: false }
}

/** A rule in the launcher's shape, so the arms exercise the real decision path. */
function rule({ issues = {}, throws = undefined } = {}) {
  return {
    evaluate(manifest) {
      if (throws !== undefined) throw throws
      return issues[manifest.name]
    },
    warn(issue) { return `Plugin ${issue.name}@${issue.version} is incompatible.` },
  }
}

describe('the row no manifest could ever be read for', () => {
  it('is refused by the launcher, and the census names the missing name', async () => {
    const census = await censusDenials(ctxWith(), [off('patch-row')])
    assert.equal(census.inspected, 1)
    const [row] = deniedRows(census)
    assert.equal(row.id, 'patch-row')
    assert.equal(row.name, '(no name)')
    assert.equal(row.verdict.kind, 'denied')
    assert.equal(row.verdict.reason, NO_NAME_REASON)
    // The point of the plain sentence: it names the field, which the line the
    // launcher printed does not.
    assert.match(row.verdict.reason, /declares no `name`/u)
    // And this is the one verdict that needs nothing imported to reach.
    assert.equal(census.rule, 'not-needed')
    assert.equal(census.ruleError, undefined)
  })

  it('is reported even when a rule is available, because it never gets that far', async () => {
    let read = 0
    const census = await censusDenials(ctxWith(), [off('patch-row')], {
      readRule: async () => { read += 1; return rule() },
    })
    assert.equal(read, 0, 'a row with no name needs no compatibility rule')
    assert.equal(deniedRows(census).length, 1)
    assert.equal(census.rule, 'not-needed')
  })
})

describe('an entry the operator switched off', () => {
  it('is not a refusal when its declaration is compatible', async () => {
    const dir = profileDir({ 'acme-plugin': { name: 'acme-plugin', version: '1.0.0' } })
    const census = await censusDenials(ctxWith(), [off('acme', 'acme-plugin')], {
      dir,
      installAnchor: '',
      readRule: async () => rule(),
    })
    assert.equal(census.inspected, 1)
    assert.deepEqual(deniedRows(census), [], 'nothing was refused')
    assert.deepEqual(census.unchecked, [], 'and everything was read')
    assert.equal(census.rule, 'dsh-app-boot')
  })

  it('is not a refusal when the row is a builtin with no manifest at all', async () => {
    const census = await censusDenials(ctxWith(), [off('group', 'cordis:group')], {
      dir: profileDir(),
      readRule: async () => rule(),
    })
    assert.deepEqual(deniedRows(census), [])
    assert.deepEqual(census.unchecked, [])
    assert.equal(census.rule, 'not-needed', 'no row needed the rule')
  })
})

describe('a refusal the launcher reaches through the compatibility rule', () => {
  it("is reported with the launcher's own warning text", async () => {
    const dir = profileDir({ 'old-plugin': { name: 'old-plugin', version: '0.1.0' } })
    const census = await censusDenials(ctxWith(), [off('old', 'old-plugin')], {
      dir,
      readRule: async () => rule({ issues: { 'old-plugin': { name: 'old-plugin', version: '0.1.0', requirements: { 'engines.dsh': '^9' }, exempted: false } } }),
    })
    const [row] = deniedRows(census)
    assert.equal(row.verdict.kind, 'denied')
    assert.match(row.verdict.reason, /old-plugin@0\.1\.0 is incompatible/u)
    assert.equal(row.verdict.detail, undefined, 'the launcher said this one itself')
  })

  it('is not reported when the profile granted an exact-version exemption', async () => {
    const dir = profileDir({ 'old-plugin': { name: 'old-plugin', version: '0.1.0' } })
    const census = await censusDenials(ctxWith(), [off('old', 'old-plugin')], {
      dir,
      readRule: async () => rule({ issues: { 'old-plugin': { name: 'old-plugin', version: '0.1.0', requirements: {}, exempted: true } } }),
    })
    assert.deepEqual(deniedRows(census), [], 'a granted exemption is not a refusal')
  })

  it("reproduces the preflight's catch when the rule itself throws", async () => {
    const dir = profileDir({ 'odd-plugin': { name: 'odd-plugin', version: '1.0.0', peerDependencies: 'not a map' } })
    const census = await censusDenials(ctxWith(), [off('odd', 'odd-plugin')], {
      dir,
      readRule: async () => rule({ throws: new Error('Plugin manifest peerDependencies must be an object') }),
    })
    const [row] = deniedRows(census)
    assert.equal(row.verdict.kind, 'denied')
    // The launcher's own wording, verbatim: this is the sentence an operator may
    // have scrolled past, so the report has to be matchable against it.
    assert.equal(row.verdict.reason, 'its declared dsh requirements cannot be validated')
    assert.match(row.verdict.detail, /peerDependencies must be an object/u)
  })

  it('is refused when the manifest exists and cannot be parsed, as the preflight reads it', async () => {
    const dir = profileDir({ 'broken-plugin': '{ not json' })
    let read = 0
    const census = await censusDenials(ctxWith(), [off('broken', 'broken-plugin')], {
      dir,
      readRule: async () => { read += 1; return rule() },
    })
    const [row] = deniedRows(census)
    assert.equal(row.verdict.kind, 'denied')
    assert.match(row.verdict.detail, /broken-plugin\/package\.json/u)
    assert.equal(read, 0, 'a manifest that cannot be parsed needs no rule')
  })
})

describe('what the census cannot read is coverage, never a finding', () => {
  it('reports an unreachable rule as coverage, with the reason', async () => {
    const dir = profileDir({ 'acme-plugin': { name: 'acme-plugin', version: '1.0.0' } })
    const census = await censusDenials(ctxWith(), [off('acme', 'acme-plugin')], {
      dir,
      readRule: async () => { throw new TypeError('@deepseek-ai/dsh-app-boot is not installed') },
    })
    assert.deepEqual(deniedRows(census), [], 'no rule, no refusal to claim')
    assert.equal(census.unchecked.length, 1)
    assert.equal(census.rule, 'unavailable')
    assert.match(census.ruleError, /is not installed/u)
  })

  it('reports a specifier it cannot follow as coverage instead of clearing it', async () => {
    const census = await censusDenials(ctxWith(), [off('local', './plugins/local.mjs')], {
      dir: profileDir(),
      readRule: async () => rule(),
    })
    assert.deepEqual(deniedRows(census), [], 'a path it cannot follow is not a finding')
    assert.equal(census.unchecked.length, 1)
    assert.equal(census.unchecked[0].verdict.kind, 'unchecked')
    assert.equal(census.unchecked[0].verdict.reason, UNRESOLVED_REASON)
  })
})

describe('the census reads, and only reads', () => {
  it('leaves the profile directory byte-identical', async () => {
    const dir = profileDir({ 'acme-plugin': { name: 'acme-plugin', version: '1.0.0' } })
    const before = snapshot(dir)
    await censusDenials(ctxWith(), [off('acme', 'acme-plugin'), off('patch-row')], {
      dir,
      readRule: async () => rule({ issues: { 'acme-plugin': { name: 'acme-plugin', version: '1.0.0', requirements: {}, exempted: false } } }),
    })
    assert.deepEqual(snapshot(dir), before)
  })

  it('answers `undefined` for a tree in which nothing is switched off', async () => {
    const census = await censusDenials(ctxWith(), [on('a', 'acme-plugin')])
    assert.equal(census, undefined, 'an arm with no question to answer makes no claim')
  })

  it("skips a row whose `disabled` expression throws — that is the entry sweep's finding", async () => {
    const broken = { options: { id: 'broken', name: 'acme-plugin' }, get disabled() { throw new Error('boom') } }
    const census = await censusDenials(ctxWith(), [broken, on('a', 'acme-plugin')])
    assert.equal(census, undefined)
  })
})

describe('the census in the two projections', () => {
  /** A census with one refused row, built through the real walker. */
  async function refused() {
    return await censusDenials(ctxWith(), [off('patch-row')])
  }

  it('names the refusal on the terminal line, with the row and not just a count', async () => {
    const census = await refused()
    const text = renderSummary([], { maxEntries: 50, errorChars: 4000, includePending: true, summaryChars: 400 }, undefined, 0, undefined, census)
    assert.match(text, /1 row switched off by the launcher's preflight/u)
    assert.match(text, /patch-row \(\(no name\)\): disabled by the preflight/u)
  })

  it('explains the mechanism in the file, and says what to do about it', async () => {
    const census = await refused()
    const text = renderReport([], { phase: 'startup', settled: true, denial: census }, {
      maxEntries: 50, errorChars: 4000, includePending: true, summaryChars: 400,
    }, new Date('2026-10-21T00:00:00.000Z'))
    assert.match(text, /switchedOff: 1 entry, 1 refused by the launcher's preflight/u)
    assert.match(text, /switched off by the launcher, not by you/u)
    assert.match(text, /name\.startsWith/u, 'the row that threw is named by the property it threw on')
    assert.match(text, /`--dump-config` renders the patch layer/u)
    assert.match(text, /switching\s+them back on will not make them run/u)
  })

  it('renders coverage as coverage — with no count of refusals invented', async () => {
    const census = await censusDenials(ctxWith(), [off('local', './plugins/local.mjs')], {
      dir: profileDir(),
      readRule: async () => rule(),
    })
    const text = renderReport([], { phase: 'startup', settled: true, denial: census }, {
      maxEntries: 50, errorChars: 4000, includePending: true, summaryChars: 400,
    }, new Date('2026-10-21T00:00:00.000Z'))
    assert.match(text, /switchedOff: 1 entry, 0 refused by the launcher's preflight, 1 could not be recomputed/u)
    assert.match(text, /None of these is a finding/u)
    // And coverage alone never produces a terminal line.
    assert.equal(renderSummary([], {
      maxEntries: 50, errorChars: 4000, includePending: true, summaryChars: 400,
    }, undefined, 0, undefined, census), '')
  })
})

describe('the bare-specifier test the resolution turns on', () => {
  it('separates package names from paths and URLs', () => {
    for (const name of ['acme-plugin', '@acme/plugin', 'left-pad']) assert.equal(isBareSpecifier(name), true, name)
    for (const name of ['./f.mjs', '../f.mjs', '/abs/f.mjs', '#resource', 'file:///x', 'node:fs', 'C:\\x', '']) {
      assert.equal(isBareSpecifier(name), false, name)
    }
  })
})

describe('verdictOf on a row with no name', () => {
  it('is decided without touching the resolver', async () => {
    let asked = 0
    const verdict = await verdictOf(undefined, {
      ctx: { get: () => { asked += 1; return undefined } },
      dir: '',
      installAnchor: '',
      ruleOnce: async () => { asked += 1; return { kind: 'unavailable', error: 'never' } },
    })
    assert.equal(verdict.kind, 'denied')
    assert.equal(asked, 0)
  })
})
