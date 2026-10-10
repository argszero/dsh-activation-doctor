/**
 * What the doctor has to be true about.
 *
 * Every arm runs against a real loader with real fixture modules, and the two
 * arms that matter most are paired with a control: the failure is measured once
 * with the doctor mounted and once with it absent, so "the report names the
 * failure" is not confounded with "the failure happened at all".
 *
 * The incident itself is reproduced in the first two arms: two plugins claiming
 * the same tool name, the second one's registration throwing out of its body, and
 * the whole plugin — both of its tools — going down with that fiber. That is the
 * mechanism behind the report this plugin answers, and the report is only
 * interesting if it names the entry, the package and the original error.
 *
 * @module test/activation-doctor.spec
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { collideEntry, waitFor, world } from './harness.mjs'

/** Every report file in the harness home, oldest first. */
function reports(home) {
  const dir = join(home, 'logs')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => name.startsWith('activation-')).sort()
    .map(name => ({ name, path: join(dir, name), text: readFileSync(join(dir, name), 'utf8') }))
}

/** The text of a tool result's first block. */
function resultText(result) {
  const block = result.content?.[0]
  return block?.type === 'text' ? block.text : ''
}

/** Run one registered tool through the real registry. */
function callTool(ctx, name, args = {}) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: `call-${Math.random().toString(36).slice(2)}`,
    name,
    arguments: args,
  })
}

const worlds = []
after(async () => { while (worlds.length > 0) await worlds.pop()() })

/** Build a world, disposing the previous one first, and arrange for cleanup. */
async function makeWorld(spec) {
  // One world at a time. `process.stderr` is process-global and each world
  // installs its own capture, so a doctor still mounted from an earlier world
  // writes into whichever capture is newest — and the arm that asserts "nothing
  // is printed" would then read another world's line. Disposing the previous
  // world before building the next is what makes that assertion about this world.
  while (worlds.length > 0) await worlds.pop()()
  const built = await world(spec)
  worlds.push(built.dispose)
  return built
}

describe('the failure being reported is real', () => {
  it('takes the whole plugin down, with nothing to report it — the control arm', async () => {
    const w = await makeWorld({
      doctor: false,
      entries: [collideEntry('collide-a', 'a'), collideEntry('collide-b', 'b')],
    })
    const b = w.ctx.loader.resolve('collide-b')
    // The incident: the fiber threw, and every registration it made is gone.
    assert.equal(b.fiber.state, 3, 'the second claimant is failed')
    await assert.rejects(async () => { await b.fiber.await() }, /already registered/)
    assert.notEqual(w.ctx.tools.get('shared_tool'), undefined, 'the first claimant keeps the name')
    assert.equal(w.ctx.tools.get('second_tool_of_collide_b'), undefined, 'the second claimant contributes nothing')
    // And without the doctor, the process says nothing and files nothing.
    assert.equal(w.stderr.text(), '', 'no stderr line without the doctor')
    assert.equal(existsSync(join(w.home, 'logs')), false, 'no report directory without the doctor')
  })

  it('reports the colliding plugin, naming the entry and the original error', async () => {
    const w = await makeWorld({
      entries: [collideEntry('collide-a', 'a'), collideEntry('collide-b', 'b')],
    })
    assert.ok(await waitFor(() => w.stderr.text().includes('activation-doctor:')), 'a summary line is printed')
    const line = w.stderr.text()
    assert.match(line, /1 entry did not activate/)
    assert.match(line, /collide-b \(\.\/fixtures\/collide-b\.mjs\)/)
    assert.match(line, /already registered/)
    assert.doesNotMatch(line, /collide-a \(/, 'the plugin that worked is not reported')
  })
})

describe('the durable report', () => {
  it('is written private, with the original stack and the credential warning', async () => {
    const w = await makeWorld({
      entries: [collideEntry('collide-a', 'a'), collideEntry('collide-b', 'b')],
    })
    assert.ok(await waitFor(() => reports(w.home).length === 1), 'exactly one report is written')
    const [report] = reports(w.home)
    const dir = statSync(join(w.home, 'logs'))
    const file = statSync(report.path)
    assert.equal(dir.mode & 0o777, 0o700, 'the log directory is private')
    assert.equal(file.mode & 0o777, 0o600, 'the report is private')
    assert.match(report.text, /^WARNING: Raw diagnostics may contain configuration or credential values/)
    assert.match(report.text, /phase: startup/)
    assert.match(report.text, /settled: yes/)
    assert.match(report.text, /entries did not activate: 1 of 3/)
    assert.match(report.text, /collide-b \(\.\/fixtures\/collide-b\.mjs\)/)
    assert.match(report.text, /already registered/)
    assert.match(report.text, /collide-b\.mjs:\d+/, 'the stack names the fixture that threw')
    assert.match(report.text, /still installed and still enabled/)
    // The terminal line and the file are the same finding, so the line points at it.
    assert.ok(w.stderr.text().includes(report.path), 'the summary names the report path')
  })

  it('reports an entry whose module could not be imported at all', async () => {
    const w = await makeWorld({ entries: [{ id: 'gone', name: './fixtures/does-not-exist.mjs' }] })
    assert.ok(await waitFor(() => w.stderr.text().includes('gone (')))
    assert.match(w.stderr.text(), /failed to import/)
    assert.match(reports(w.home)[0].text, /failed to import/)
  })

  it('reports an entry waiting for a service, and separates it from a failure', async () => {
    const w = await makeWorld({ entries: [{ id: 'waiting', name: './fixtures/waiting.mjs' }] })
    assert.ok(await waitFor(() => w.stderr.text().includes('waiting (')))
    assert.match(w.stderr.text(), /pending \(waiting for service: neverProvidedService\)/)
    assert.doesNotMatch(w.stderr.text(), /fail/i)
  })

  it('leaves a deliberately disabled entry out of the report', async () => {
    const w = await makeWorld({
      entries: [{ id: 'switched-off', name: './fixtures/good.mjs', disabled: true }],
    })
    await new Promise(resolve => { setTimeout(resolve, 300) })
    assert.equal(w.stderr.text(), '', 'a disabled entry is a decision, not a finding')
    assert.deepEqual(reports(w.home), [])
  })

  it('waits for a slow import instead of misreading it as an import failure', async () => {
    // The fixture is created *concurrently* with the doctor's sweep seeing it, the
    // shape a profile's `Promise.all` produces: an entry whose module is still
    // importing has no fiber yet, and only the settle-first rule keeps that from
    // being read as `failed to import`.
    const w = await makeWorld({ entries: [{ id: 'healthy', name: './fixtures/good.mjs' }] })
    await w.mountTogether([{ id: 'slow', name: './fixtures/slow-fail.mjs' }])
    assert.ok(await waitFor(() => w.stderr.text().includes('slow (')))
    assert.match(w.stderr.text(), /slow boom: activation failed after a slow import/)
    assert.doesNotMatch(w.stderr.text(), /failed to import/)
  })
})

describe('failures that appear after startup', () => {
  it('are reported when a plugin fails later, without re-reporting the first one', async () => {
    const w = await makeWorld({
      entries: [collideEntry('collide-a', 'a'), collideEntry('collide-b', 'b')],
    })
    assert.ok(await waitFor(() => reports(w.home).length === 1))
    w.stderr.clear()
    await w.mount({ id: 'late-collide', name: './fixtures/collide-b.mjs' })
    assert.ok(await waitFor(() => w.stderr.text().includes('late-collide')), 'the late failure is reported')
    assert.match(w.stderr.text(), /late-collide \(\.\/fixtures\/collide-b\.mjs\)/)
    assert.ok(await waitFor(() => reports(w.home).some(report => report.text.includes('phase: live'))), 'a live report is filed')
    const liveReport = reports(w.home).find(report => report.text.includes('phase: live'))
    assert.match(liveReport.text, /new entries did not activate: 1 of \d+ entries in the tree/)
    assert.match(liveReport.text, /index:\n\s+late-collide \(/)
  })

  it('stops writing reports at the configured limit, and says so', async () => {
    // The first claimant is mounted up front, so both later entries really do
    // collide: alone, `collide-b` registers `shared_tool` successfully and there
    // would be nothing to report and nothing to limit.
    const w = await makeWorld({
      entries: [{ id: 'healthy', name: './fixtures/good.mjs' }, collideEntry('collide-a', 'a')],
      config: { maxLiveReports: 1 },
    })
    await new Promise(resolve => { setTimeout(resolve, 200) })
    w.stderr.clear()
    await w.mount({ id: 'late-one', name: './fixtures/collide-b.mjs' })
    assert.ok(await waitFor(() => w.stderr.text().includes('late-one')))
    w.stderr.clear()
    await w.mount({ id: 'late-two', name: './fixtures/collide-b.mjs' })
    assert.ok(await waitFor(() => w.stderr.text().includes('report limit')), 'the limit is announced')
    assert.match(w.stderr.text(), /late-two/)
    assert.equal(reports(w.home).length, 1, 'only the first live report is written')
  })
})

describe('the on-demand query', () => {
  it('is registered in the real tool registry and names the failures', async () => {
    const w = await makeWorld({ entries: [collideEntry('collide-a', 'a'), collideEntry('collide-b', 'b')] })
    assert.notEqual(w.ctx.tools.get('activation_status'), undefined, 'the tool is registered')
    const text = resultText(await callTool(w.ctx, 'activation_status'))
    assert.match(text, /activation-doctor: 3 loader entries inspected/)
    assert.match(text, /collide-b \(\.\/fixtures\/collide-b\.mjs\)/)
    assert.match(text, /activation-doctor: 1 entry did not activate/)
  })

  it('answers that everything is active when nothing failed', async () => {
    const w = await makeWorld({ entries: [{ id: 'healthy', name: './fixtures/good.mjs' }] })
    assert.notEqual(w.ctx.tools.get('activation_status'), undefined)
    const text = resultText(await callTool(w.ctx, 'activation_status'))
    assert.match(text, /2 loader entries inspected/)
    assert.match(text, /Every entry is active \(or switched off deliberately\)\./)
  })
})

describe('configuration', () => {
  it('writes the report but says nothing on the terminal when logging is off', async () => {
    const w = await makeWorld({
      entries: [collideEntry('collide-a', 'a'), collideEntry('collide-b', 'b')],
      config: { log: 'off' },
    })
    assert.ok(await waitFor(() => reports(w.home).length === 1), 'the report is still written')
    assert.equal(w.stderr.text(), '', 'nothing is printed')
  })

  it('files nothing when reporting is off, and still prints the line', async () => {
    const w = await makeWorld({
      entries: [collideEntry('collide-a', 'a'), collideEntry('collide-b', 'b')],
      config: { report: false },
    })
    assert.ok(await waitFor(() => w.stderr.text().includes('collide-b')))
    assert.equal(existsSync(join(w.home, 'logs')), false, 'no report is written')
  })

  it('leaves pending entries out when they are turned off', async () => {
    const w = await makeWorld({
      entries: [{ id: 'waiting', name: './fixtures/waiting.mjs' }],
      config: { includePending: false },
    })
    await new Promise(resolve => { setTimeout(resolve, 300) })
    assert.equal(w.stderr.text(), '', 'a pending entry is not reported')
  })

  it('installs nothing at all when it is disabled', async () => {
    const w = await makeWorld({
      entries: [collideEntry('collide-a', 'a'), collideEntry('collide-b', 'b')],
      config: { enabled: false },
    })
    await new Promise(resolve => { setTimeout(resolve, 300) })
    assert.equal(w.stderr.text(), '')
    assert.equal(w.ctx.tools.get('activation_status'), undefined, 'no tool is registered either')
    assert.equal(existsSync(join(w.home, 'logs')), false)
  })

  it('resolves the default report directory under the harness home', async () => {
    const w = await makeWorld({
      entries: [collideEntry('collide-a', 'a'), collideEntry('collide-b', 'b')],
      config: { reportDir: '' },
    })
    assert.ok(await waitFor(() => reports(w.home).length === 1), 'the default is $DSH_HOME/logs')
  })

  it('answers on demand only when the query tool is turned on', async () => {
    const w = await makeWorld({
      entries: [collideEntry('collide-a', 'a'), collideEntry('collide-b', 'b')],
      config: { tool: false },
    })
    assert.ok(await waitFor(() => reports(w.home).length === 1), 'the report is still written')
    assert.equal(w.ctx.tools.get('activation_status'), undefined, 'no tool is registered')
  })
})

describe('honesty about what it cannot do', () => {
  it('does not repair the plugin it reports on', async () => {
    const w = await makeWorld({ entries: [collideEntry('collide-a', 'a'), collideEntry('collide-b', 'b')] })
    assert.ok(await waitFor(() => reports(w.home).length === 1))
    const b = w.ctx.loader.resolve('collide-b')
    assert.equal(b.fiber.state, 3, 'the failed plugin is still failed after being reported')
    assert.equal(b.disabled, false, 'the doctor does not switch the entry off')
    assert.equal(w.ctx.tools.get('second_tool_of_collide_b'), undefined, 'nothing it contributed is resurrected')
    assert.equal(w.ctx.tools.get('shared_tool').name, 'shared_tool', 'the surviving registration is untouched')
  })

  it('still reports when the report cannot be filed, rather than losing both halves', async () => {
    // A path that exists as a *file* cannot be a report directory. It lives in
    // its own temporary root rather than in a world's home, because building the
    // world would dispose that home out from under the path.
    const root = mkdtempSync(join(tmpdir(), 'activation-doctor-blocked-'))
    const blocked = join(root, 'not-a-directory')
    writeFileSync(blocked, 'x')
    try {
      const direct = await makeWorld({
        entries: [collideEntry('collide-a', 'a'), collideEntry('collide-b', 'b')],
        config: { reportDir: blocked, debounceMs: 10 },
      })
      assert.ok(await waitFor(() => direct.stderr.text().includes('could not write the report')), 'the failure is stated')
      assert.ok(direct.stderr.text().includes('collide-b'), 'the finding is still printed in full')
      // "In full" is the distinction: the file's whole text — warning first, then
      // the stack — reaches the terminal, not just the one-line summary.
      assert.match(direct.stderr.text(), /WARNING: Raw diagnostics may contain/)
      assert.match(direct.stderr.text(), /collide-b\.mjs:\d+/)
      // And nothing threw out of the plugin: the process and its entries are intact.
      assert.equal(direct.ctx.loader.resolve('collide-a').fiber.state, 2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports anyway when the loader is still busy at its first check', async () => {
    const w = await makeWorld({
      entries: [collideEntry('collide-a', 'a'), collideEntry('collide-b', 'b')],
      config: { maxSettleTries: 1, debounceMs: 1 },
    })
    assert.ok(await waitFor(() => reports(w.home).length === 1, 6000))
    assert.match(reports(w.home)[0].text, /collide-b/)
  })
})

describe('the package itself', () => {
  it('declares itself as a mountable dsh bundle and ships the patch', async () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    assert.match(patch, /id: activation-doctor/)
    assert.match(patch, /name: '@argszero\/dsh-activation-doctor'/)
    assert.match(patch, /inject:/)
    assert.ok(manifest.files.includes('cordis.patch.yml'), 'the patch is published')
    assert.equal(manifest.peerDependencies['@deepseek-ai/cordis'] !== undefined, true)
    // The peer range has to admit both lines in the field, or a consumer on one
    // of them installs a plugin that refuses to load.
    const { satisfies } = await import('semver')
    const cordis = manifest.peerDependencies['@deepseek-ai/cordis']
    assert.ok(satisfies('4.0.4', cordis), 'the rc line is admitted')
    assert.ok(satisfies('4.0.5-alpha.1', cordis), 'the alpha line is admitted')
    const tools = manifest.peerDependencies['@deepseek-ai/dsh-tools']
    for (const version of ['0.1.7-rc.2', '0.2.0-rc.2', '0.2.1-alpha.2']) {
      assert.ok(satisfies(version, tools), `${version} is admitted`)
    }
  })

  it('creates its report directory mode 0700 even when it did not exist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'activation-doctor-fresh-'))
    try {
      const w = await makeWorld({
        entries: [collideEntry('collide-a', 'a'), collideEntry('collide-b', 'b')],
        config: { reportDir: join(root, 'fresh-logs') },
      })
      assert.ok(await waitFor(() => existsSync(join(root, 'fresh-logs'))), 'the directory is created on demand')
      assert.equal(statSync(join(root, 'fresh-logs')).mode & 0o777, 0o700)
      assert.match(w.stderr.text(), /activation-doctor: 1 entry did not activate/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('expands a home reference in a configured path, and derives the home itself', async () => {
    // Exercised through the exported helpers rather than a world, because the
    // failure mode is a directory literally named `~` written beside the process
    // — which a world-based arm would have to create to observe.
    const { expandHome, resolveHome } = await import('../lib/index.js')
    assert.equal(expandHome('~'), homedir())
    assert.equal(expandHome('~/logs'), join(homedir(), 'logs'))
    assert.equal(expandHome('./relative'), './relative', 'an ordinary path is left alone')
    assert.equal(resolveHome({ DSH_HOME: join(homedir(), 'somewhere') }), join(homedir(), 'somewhere'))
    assert.equal(resolveHome({ DSH_HOME: '   ' }), join(homedir(), '.dsh'), 'a blank override is not the current directory')
    assert.equal(resolveHome({}), join(homedir(), '.dsh'))
  })
})
