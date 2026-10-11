/**
 * Defect injection: mutate the source, rebuild, run the suite, and require that
 * the mutation is caught. An arm whose mutation leaves the suite green is SILENT
 * — it proves nothing about the suite, and it is reported as a failure of the
 * harness rather than hidden.
 *
 * The suite imports `lib/*.js`, not `src/*.ts`, so every arm **emits** first; a
 * mutation that is never written to `lib/` is a mutation the suite cannot see. A
 * mutation that does not compile is reported separately as TYPEFAIL, because it
 * never reached the suite either.
 *
 * Every arm is a defect this plugin could plausibly have shipped: one distinction
 * it exists to make, removed one line at a time. The distinctions were chosen
 * from the plugin's own promises — the classification, the settle-first rule, the
 * four configuration knobs, the private file mode and the deduplication — so a
 * SILENT arm is a claim the package makes to its users that nothing checks.
 *
 * ```sh
 * node scripts/inject-defects.mjs                    # every arm
 * node scripts/inject-defects.mjs --filter=classify  # arms whose name matches
 * ```
 *
 * @module scripts/inject-defects
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TSC = resolve(ROOT, 'node_modules/typescript/bin/tsc')

/** Each arm names the one distinction it removes, and the file it lives in. */
const MUTATIONS = [
  {
    // The whole reason the classification is behavioural: a fiber whose body
    // threw rejects on await, and reporting the success instead is the silence
    // this plugin exists to break.
    name: 'classify: a fiber that threw is read as healthy',
    file: 'src/audit.ts',
    edits: [["  } catch (error: unknown) {\n    return { kind: 'failed', error }\n  }", "  } catch {\n    return { kind: 'active', state: FIBER_ACTIVE }\n  }"]],
  },
  {
    // A `disabled: true` entry is a decision the operator made. Reporting it as a
    // failure turns the report into noise, and a noisy report gets ignored.
    name: 'classify: a disabled entry is not recognised as disabled',
    file: 'src/audit.ts',
    edits: [["    if (entry.disabled) return { kind: 'disabled' }", '    if (false) return { kind: \'disabled\' }']],
  },
  {
    name: 'classify: a disabled entry is a problem anyway',
    file: 'src/audit.ts',
    edits: [["  return outcome.kind !== 'disabled' && outcome.kind !== 'active'", '  return true']],
  },
  {
    // The failure that leaves nothing to await. Reading it as healthy loses the
    // one case the settle-first rule cannot help with.
    name: 'classify: a module that never imported is not an import failure',
    file: 'src/audit.ts',
    edits: [["  if (fiber === undefined) return { kind: 'import-failed' }", "  if (fiber === undefined) return { kind: 'active', state: FIBER_ACTIVE }"]],
  },
  {
    name: 'classify: an active fiber is not recognised as active',
    file: 'src/audit.ts',
    // The constant is moved rather than the branch removed: `if (false)` would
    // make the branch unreachable and TypeScript would narrow the fall-through to
    // a type error, so the arm would never reach the suite. Moving the value keeps
    // the shape and still removes the distinction.
    edits: [['export const FIBER_ACTIVE = 2', 'export const FIBER_ACTIVE = 99']],
  },
  {
    // A plugin waiting for a service has not failed, and the report has to say
    // which service rather than lumping it in with a throw.
    name: 'classify: a waiting fiber is not recognised as waiting',
    file: 'src/audit.ts',
    edits: [['export const FIBER_PENDING = 0', 'export const FIBER_PENDING = 99']],
  },
  {
    // The name is the actionable half of "waiting": an operator can look up what
    // provides it, and a pending row that says `unknown` cannot be acted on.
    name: 'classify: the service a waiting fiber misses is not named',
    file: 'src/audit.ts',
    edits: [['    if (resolved === undefined) missing.push(service)', '    if (false) missing.push(service)']],
  },
  {
    // A config file is written by hand; a diagnostic that throws on a typo is a
    // diagnostic that loses the failure it was mounted to report.
    name: 'config: `enabled: false` installs the plugin anyway',
    file: 'src/config.ts',
    edits: [['    enabled: boolean(config.enabled, defaultConfig.enabled),', '    enabled: true,']],
  },
  {
    name: 'config: `log: off` still prints',
    file: 'src/config.ts',
    edits: [["    log: config.log === 'off' ? 'off' : 'summary',", "    log: 'summary',"]],
  },
  {
    name: 'config: `report: false` writes the file anyway',
    file: 'src/config.ts',
    edits: [['    report: boolean(config.report, defaultConfig.report),', '    report: true,']],
  },
  {
    name: 'config: `includePending: false` is ignored',
    file: 'src/config.ts',
    edits: [['    includePending: boolean(config.includePending, defaultConfig.includePending),', '    includePending: true,']],
  },
  {
    // The default directory is derived, not left empty: an empty `reportDir`
    // would write the report to the process's working directory.
    name: 'config: the default report directory is not derived from the home',
    file: 'src/config.ts',
    edits: [["    reportDir: configuredDir === '' ? join(resolveHome(), 'logs') : configuredDir,", '    reportDir: configuredDir,']],
  },
  {
    // `$DSH_HOME` is where the harness's own diagnostics live; a report filed
    // anywhere else is a report nobody finds.
    name: 'config: `$DSH_HOME` is not honoured',
    file: 'src/config.ts',
    edits: [["  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return expandHome(fromEnv.trim())", "  if (false) return expandHome('')"]],
  },
  {
    // A `~` in a configured path is a home reference, not a directory literally
    // named `~` beside the process.
    name: 'config: a leading `~` is not expanded',
    file: 'src/config.ts',
    edits: [["  if (path === '~') return homedir()", "  if (path === '~') return path"]],
  },
  {
    // The pending entries are dropped when the operator asked for them to be
    // dropped — one filter, two callers, so it is the filter that is mutated.
    name: 'report: the pending filter is ignored',
    file: 'src/report.ts',
    edits: [["  return rows.filter(row => isProblem(row.outcome) && (includePending || row.outcome.kind !== 'pending'))", '  return rows.filter(row => isProblem(row.outcome))']],
  },
  {
    // Raw plugin errors can carry configuration or credential values; a report
    // an operator shares without reading that line is a leak.
    name: 'report: the credential warning is dropped',
    file: 'src/report.ts',
    edits: [["  parts.push(CREDENTIAL_WARNING, '')", "  parts.push('')"]],
  },
  {
    // The incident's single most useful output is the stack, because it names the
    // module that threw. The one-line projection must not replace the file's.
    name: 'report: the full entry section loses the stack',
    file: 'src/report.ts',
    edits: [['      parts.push(formatError(row.outcome.error, options.errorChars))', "      parts.push(headline(row, options.errorChars))"]],
  },
  {
    // The directory and the file are private because they hold raw errors.
    name: 'report: the report directory is world-readable',
    file: 'src/report.ts',
    edits: [['  await mkdir(dir, { recursive: true, mode: 0o700 })', '  await mkdir(dir, { recursive: true, mode: 0o755 })']],
  },
  {
    name: 'report: the report file is world-readable',
    file: 'src/report.ts',
    edits: [["  await writeFile(path, text, { flag: 'wx', mode: 0o600 })", "  await writeFile(path, text, { flag: 'w', mode: 0o644 })"]],
  },
  {
    // Settling first is what keeps a slow import from being read as an import
    // failure — the one wrong answer that would make the report untrustworthy.
    name: 'sweep: the loader is not awaited before the audit',
    file: 'src/index.ts',
    edits: [["        if (pendingTasks(loader) === 0) return { rows: await auditEntries(loader), settled: true }", '        return { rows: await auditEntries(loader), settled: true }']],
  },
  {
    // A finding already reported is not a new finding. Without this, every status
    // change in the process refiles the same report.
    name: 'sweep: a finding that was already reported is reported again',
    file: 'src/index.ts',
    edits: [['      const fresh = found.filter(row => !state.reported.has(findingKey(row)))', '      const fresh = found']],
  },
  {
    // The limit exists so a process whose plugins keep failing cannot fill the
    // disk with reports.
    name: 'sweep: the post-startup report limit is not enforced',
    file: 'src/index.ts',
    edits: [['      if (phase === \'live\' && state.liveReports >= settings.maxLiveReports) {', '      if (false) {']],
  },
  {
    // The two halves are one finding: when the file cannot be written the
    // terminal carries the same text, rather than the operator losing both.
    name: 'sweep: a report that cannot be filed loses its content',
    file: 'src/index.ts',
    edits: [["          process.stderr.write(`${text}\\n`)", '']],
  },
  {
    // `tool: false` is documented as "the file and the line, no tool".
    name: 'sweep: the query tool is registered even when it is turned off',
    file: 'src/index.ts',
    edits: [['    if (settings.tool) {', '    {']],
  },
  {
    // `enabled: false` is documented as "installs nothing at all".
    name: 'sweep: `enabled: false` still installs the sweep',
    file: 'src/index.ts',
    edits: [['  if (!settings.enabled) return', '  if (false) return']],
  },
  {
    // The whole point of the composition half: a bundle the profile names and the
    // process did not start from contributes no entries, so the entry sweep cannot
    // see it and nothing else will. Dropping the diff is the plugin shipping the
    // blind spot it was added to close.
    name: 'composition: a declared bundle the process did not start from is not looked for',
    file: 'src/composition.ts',
    edits: [['  const missingNames = declared === undefined ? [] : declared.filter(name => !started.has(name))', '  const missingNames: string[] = []']],
  },
  {
    // One accessor feeds the summary, the report and the query, so mutating it is
    // mutating "what counts as a finding" for all three at once.
    name: 'composition: the stopped-bundle accessor always answers "nothing"',
    file: 'src/composition.ts',
    edits: [['  return audit?.missing ?? []', '  return []']],
  },
  {
    // The launcher is a dynamic import. The healthy case is every start, so it is
    // the one that must not reach for it.
    name: 'composition: the launcher\'s reader is consulted even when nothing is missing',
    file: 'src/composition.ts',
    edits: [['  if (missingNames.length > 0) {', '  if (missingNames.length >= 0) {']],
  },
  {
    // "Declared nothing" and "could not be read" lead to opposite conclusions about
    // the process, so a malformed declaration must not render as an empty one.
    name: 'composition: a malformed declaration reads as an empty one',
    file: 'src/composition.ts',
    edits: [["  if (!Array.isArray(bundles)) return { error: 'dsh.profile.bundles is not a list' }", '  if (!Array.isArray(bundles)) return { bundles: [] }']],
  },
  {
    // A launcher fact the module cannot read is reported as "not a profile", never
    // coerced into a composition claim about a process it has no facts about.
    name: 'composition: a profile with no directory is accepted',
    file: 'src/composition.ts',
    edits: [["  if (typeof probe.dir !== 'string' || probe.dir === '') return undefined", "  if (typeof probe.dir !== 'string') return undefined"]],
  },
  {
    name: 'composition: a non-string bundle in the launcher\'s list is filtered away instead of refused',
    file: 'src/composition.ts',
    edits: [['  if (startedBundles.length !== probe.startedBundles.length) return undefined', '  if (false) return undefined']],
  },
  {
    // The reader is addressed through the launcher's own install anchor; without
    // one there is nothing to resolve it from, and calling anyway is guessing.
    name: 'composition: the launcher is addressed without an install anchor',
    file: 'src/composition.ts',
    edits: [["    if (facts.installAnchor === '') {", '    if (false) {']],
  },
  {
    // The file is what an operator reads later. A composition finding that lives
    // only in the terminal line is a finding the report does not carry.
    name: 'report: the composition section is never written',
    file: 'src/report.ts',
    edits: [['  if (audit === undefined || stopped.length === 0) return []', '  if (audit === undefined || stopped.length >= 0) return []']],
  },
  {
    // A healthy entry tree is not a healthy composition — the case the second half
    // of that condition exists for.
    name: 'report: an empty entry list suppresses the terminal line',
    file: 'src/report.ts',
    edits: [["  if (found.length === 0 && stopped.length === 0) return ''", "  if (found.length === 0) return ''"]],
  },
  {
    // "The launcher gave no reason" is information, and a bundle rendered with an
    // empty explanation reads as a truncated line rather than as a finding.
    name: 'report: a stopped bundle with no reason is rendered blank',
    file: 'src/report.ts',
    edits: [["  const text = (bundle.reason ?? 'the launcher reported no reason for this one').replace(/\\s+/g, ' ').trim()", "  const text = (bundle.reason ?? '').replace(/\\s+/g, ' ').trim()"]],
  },
  {
    // "The profile names no bundles" and "this process could not read what it
    // names" are opposite facts about the process.
    name: 'report: an unreadable declaration is rendered as an empty one',
    file: 'src/report.ts',
    edits: [['  if (audit.declared === undefined) return `profileBundles: the declaration could not be read — ${String(audit.declaredError)}`', '  if (audit.declared === undefined) return `profileBundles: 0 declared, ${String(audit.started.length)} started`']],
  },
  {
    // "The reasons are unavailable" without saying *why* is a shrug; the error is
    // the difference between "your launcher moved" and "the name is misspelled".
    name: 'report: unavailable reasons are stated without the error',
    file: 'src/report.ts',
    edits: [["    : `reasons: unavailable — ${String(audit.reasonsError)}`)", "    : 'reasons: unavailable — unknown')"]],
  },
  {
    name: 'report: the composition header states the counts without the shortfall',
    file: 'src/report.ts',
    edits: [['  return stopped.length === 0 ? head : `${head}, ${String(stopped.length)} did not start`', '  return head']],
  },
  {
    name: 'sweep: the composition is never audited',
    file: 'src/index.ts',
    edits: [['      if (!settings.composition || state.compositionAudited) return undefined', '      if (settings.composition) return undefined']],
  },
  {
    name: 'sweep: a healthy entry tree suppresses the composition finding',
    file: 'src/index.ts',
    edits: [['      if (fresh.length === 0 && stopped.length === 0) return', '      if (fresh.length === 0) return']],
  },
  {
    name: 'sweep: the on-demand query reports the composition even when it is switched off',
    file: 'src/index.ts',
    edits: [['composition: settings.composition ? composition : undefined }', 'composition }']],
  },
]

const argv = process.argv.slice(2)
const filter = argv.find(argument => argument.startsWith('--filter='))?.slice('--filter='.length)

/**
 * Run one command, capturing whether it succeeded.
 *
 * The timeout is not decoration: an arm that removes a wait can leave the suite
 * polling until its own deadline, and a mutant that never terminates is a mutant
 * the suite cannot report on. It is killed here and counted as caught, which is
 * what it is — the suite never reaches its assertions because the code under test
 * never returns.
 * @param command - the executable.
 * @param args - its arguments.
 * @returns whether it succeeded, and the text it produced.
 */
function run(command, args) {
  try {
    execFileSync(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 })
    return { ok: true, output: '' }
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

/** Emit the compiled artifact the suite actually imports. */
function build() {
  return run(process.execPath, [TSC])
}

/** Run every spec in the suite. */
function test() {
  return run(process.execPath, ['--test', 'test/*.spec.mjs'])
}

const results = []
for (const mutation of MUTATIONS) {
  if (filter !== undefined && !mutation.name.includes(filter)) continue
  const path = resolve(ROOT, mutation.file)
  const original = readFileSync(path, 'utf8')
  let mutated = original
  let applied = true
  for (const [from, to] of mutation.edits) {
    if (!mutated.includes(from)) {
      applied = false
      break
    }
    mutated = mutated.replace(from, to)
  }
  if (!applied) {
    results.push({ name: mutation.name, outcome: 'NO-OP', detail: 'the source no longer contains the text this arm mutates' })
    continue
  }
  try {
    writeFileSync(path, mutated)
    const built = build()
    if (!built.ok) {
      results.push({ name: mutation.name, outcome: 'TYPEFAIL', detail: 'the mutation does not compile, so the suite never ran' })
      continue
    }
    const tested = test()
    results.push(tested.ok
      ? { name: mutation.name, outcome: 'SILENT', detail: 'the suite stayed green — this arm proves nothing' }
      : { name: mutation.name, outcome: 'CAUGHT', detail: '' })
  } finally {
    writeFileSync(path, original)
  }
}

// Put `lib/` back. The last arm left its mutation COMPILED there — the source is
// restored in the `finally` above, but the build output is not, and a checkout
// that runs this script and then publishes would ship the last mutant. Rebuilt
// once here so the tree is consistent whether a human runs this or CI does.
const restored = build()
if (!restored.ok) {
  process.stdout.write('\nWARNING: the rebuild after restoring the sources failed — lib/ may hold a mutant\n')
}

const caught = results.filter(result => result.outcome === 'CAUGHT').length
const declared = new Set(MUTATIONS.filter(mutation => mutation.equivalent !== undefined).map(mutation => mutation.name))
const equivalents = results.filter(result => result.outcome === 'SILENT' && declared.has(result.name))
const silent = results.filter(result => result.outcome === 'SILENT' && !declared.has(result.name))
const other = results.filter(result => result.outcome !== 'CAUGHT' && result.outcome !== 'SILENT')

for (const result of results) {
  const label = result.outcome === 'SILENT' && declared.has(result.name) ? 'EQUIVALENT' : result.outcome
  process.stdout.write(`${label.padEnd(10)} ${result.name}${result.detail === '' ? '' : `\n           ${result.detail}`}\n`)
}
process.stdout.write(`\n${caught}/${results.length} caught`)
process.stdout.write(silent.length === 0
  ? ` — no arm is silent (${equivalents.length} declared equivalent — see the arms)\n`
  : `, ${silent.length} SILENT\n`)
if (other.length > 0) {
  process.stdout.write(`${other.length} arm(s) could not be evaluated: ${other.map(result => `${result.outcome} ${result.name}`).join(', ')}\n`)
}
process.exitCode = silent.length === 0 && other.length === 0 ? 0 : 1
