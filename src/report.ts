/**
 * Rendering and the durable file.
 *
 * The report exists because the harness already composes this text and then
 * writes it to a sink the user cannot reach. `auditStartupEntries` throws only for
 * a required entry id (`packages/boot/app-boot/src/index.ts`), so a third-party
 * plugin's failure takes the `warn` branch and goes to `process.stderr`; the
 * persistent file under `$DSH_HOME/logs` is written from exactly one place, the
 * `StartupError` handler in `apps/cli/src/bin.ts`, and is therefore never created
 * for a third-party-only failure. In the desktop build the line survives one hop
 * further: the host's stderr is drained into a bounded in-memory buffer
 * (`apps/desktop/src/host-process.ts`) that is attached to an error message only
 * on *exit*. While the application is running normally, that text exists nowhere
 * an operator can look. This module is the missing sink.
 *
 * The file follows the shipped diagnostic's conventions rather than inventing
 * new ones: a uniquely named `activation-<timestamp>-<uuid>.log` under
 * `<home>/logs`, a `0700` directory and a `0600` file created with `wx` so an
 * existing path is an error rather than an overwrite, and a first line warning
 * that raw plugin errors may contain configuration or credential values.
 *
 * @module @argszero/dsh-activation-doctor/report
 */

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { formatError, isProblem } from './audit.ts'
import type { EntryAudit } from './audit.ts'
import { APP_BOOT, stoppedBundles } from './composition.ts'
import type { CompositionAudit, StoppedBundle } from './composition.ts'
import { unselectedPackages } from './installed.ts'
import type { InstalledAudit, UnselectedPackage } from './installed.ts'

/** The warning the shipped diagnostic puts at the top of its report. */
export const CREDENTIAL_WARNING = 'WARNING: Raw diagnostics may contain configuration or credential values from plugin errors. Review before sharing.'

/** What one report needs to know about where it came from. */
export interface ReportContext {
  /** The profile the process was launched with, when it is known. */
  readonly profile?: string | undefined
  /** The application version, when it is known. */
  readonly version?: string | undefined
  /** The phase that produced the report. */
  readonly phase: 'startup' | 'live' | 'on-demand'
  /**
   * Whether the loader had finished its pending work when the sweep ran.
   * `false` is reported rather than hidden: a tree that never settles is itself a
   * finding, and treating a slow import as an import failure is exactly the kind
   * of wrong answer this plugin exists to prevent.
   */
  readonly settled: boolean
  /** How many entries the sweep inspected, when it is more than the rows given. */
  readonly totalEntries?: number | undefined
  /**
   * The profile composition audit, when this process is a dsh profile.
   *
   * Absent is a fact rather than a gap: a plain cordis application has no profile
   * to audit, and the report says so by not making a claim about one.
   */
  readonly composition?: CompositionAudit | undefined
}

/** Rendering bounds shared by every projection of one sweep. */
export interface RenderOptions {
  /** Inclusive bound on the entries listed. */
  readonly maxEntries: number
  /** Inclusive bound on one entry's rendered error. */
  readonly errorChars: number
  /** Whether entries waiting for a service are listed. */
  readonly includePending: boolean
  /** How much of an error the one-line projection carries. */
  readonly summaryChars: number
}

/** The problems in a sweep, in tree order, after the configured filters. */
export function problems(rows: readonly EntryAudit[], includePending: boolean): readonly EntryAudit[] {
  return rows.filter(row => isProblem(row.outcome) && (includePending || row.outcome.kind !== 'pending'))
}

/** One entry, one line, for the file's index. */
function headline(row: EntryAudit, errorChars: number): string {
  const { outcome } = row
  if (outcome.kind === 'failed') {
    const phase = outcome.phase === undefined ? '' : `${outcome.phase}: `
    const first = formatError(outcome.error, errorChars).split('\n')[0] ?? ''
    return `${phase}${first}`
  }
  if (outcome.kind === 'import-failed') return 'failed to import: the module could not be loaded, so no fiber exists'
  if (outcome.kind === 'pending') {
    const services = outcome.missing.length === 0 ? 'unknown' : outcome.missing.join(', ')
    return `pending (waiting for ${outcome.missing.length === 1 ? 'service' : 'services'}: ${services})`
  }
  if (outcome.kind === 'disabled') return 'disabled'
  if (outcome.kind === 'active') return 'active'
  return `state ${String(outcome.state)}`
}

/** The first line of one entry's error, collapsed, for the terminal. */
function firstLine(row: EntryAudit, limit: number): string {
  const text = headline(row, limit).replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * One stopped bundle, collapsed to a line.
 *
 * A bundle with no reason is stated as such rather than omitted: the finding is
 * that it did not start, and a reader who is shown the name with no explanation
 * learns exactly as much as the doctor knows.
 * @param bundle - a declared bundle that contributed no layer.
 * @param limit - the inclusive bound on the rendered text.
 * @returns the terminal text for this bundle.
 */
function stoppedLine(bundle: StoppedBundle, limit: number): string {
  const text = (bundle.reason ?? 'the launcher reported no reason for this one').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * One unselected package, collapsed to a line.
 *
 * The whole finding is "installed, never selected", so the line states what the
 * package is and what it claims: the declaration is the reason this was reported
 * at all, and its absence would leave the operator to guess why this package and
 * not the twenty ordinary dependencies beside it.
 * @param entry - an installed dependency the profile never selected.
 * @param limit - the inclusive bound on the rendered text.
 * @returns the terminal text for this package.
 */
function unselectedLine(entry: UnselectedPackage, limit: number): string {
  const installed = entry.version === undefined ? 'installed' : `installed ${entry.version}`
  const claims = entry.patchError !== undefined
    ? `declares a malformed dsh.bundle.patch: ${entry.patchError}`
    : `declares dsh.bundle.patch ${entry.patches.join(', ')}`
  const text = `${installed} — ${claims} — absent from dsh.profile.bundles (resolved from the ${entry.from})`
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * The coverage caveat of one installed-selection audit, or `undefined` when it
 * inspected everything.
 *
 * Reported rather than dropped: a dependency whose manifest could not be read is
 * one this audit cannot classify, and an audit that stays quiet about its own gaps
 * reads as coverage it does not have.
 * @param audit - the installed-selection audit, when one was made.
 * @returns one line, or `undefined`.
 */
function inspectedGap(audit: InstalledAudit | undefined): string | undefined {
  if (audit === undefined) return undefined
  const parts: string[] = []
  if (audit.uninspected.length > 0) {
    parts.push(`${String(audit.uninspected.length)} of ${String(audit.dependencies.length)} dependencies could not be inspected`)
  }
  if (audit.truncated > 0) parts.push(`${String(audit.truncated)} left uninspected by the audit's bound`)
  return parts.length === 0 ? undefined : parts.join('; ')
}

/** The header line summarising one composition audit, or `undefined` without one. */
function compositionFact(audit: CompositionAudit | undefined): string | undefined {
  if (audit === undefined) return undefined
  if (audit.declared === undefined) return `profileBundles: the declaration could not be read — ${String(audit.declaredError)}`
  const stopped = stoppedBundles(audit)
  const unselected = unselectedPackages(audit)
  const head = `profileBundles: ${String(audit.declared.length)} declared, ${String(audit.started.length)} started`
  const parts = [head]
  if (stopped.length > 0) parts.push(`${String(stopped.length)} did not start`)
  if (unselected.length > 0) parts.push(`${String(unselected.length)} installed but never selected`)
  const gap = inspectedGap(audit.installed)
  if (gap !== undefined) parts.push(gap)
  return parts.join(', ')
}

/**
 * The installed-but-not-selected section of the durable report, or an empty list
 * without a finding.
 *
 * The `uninspected` list is rendered whenever this audit ran, including the
 * healthy case, because it is coverage rather than a finding: an operator reading
 * "no package is unselected" has to be able to see how many dependencies were
 * actually inspected before that sentence means anything.
 * @param audit - the composition audit, when one was made.
 * @param errorChars - the inclusive bound on one rendered reason.
 * @returns the section's lines.
 */
function installedSection(audit: CompositionAudit | undefined, errorChars: number): readonly string[] {
  const installed = audit?.installed
  if (installed === undefined) return []
  const unselected = unselectedPackages(audit)
  const parts: string[] = []
  if (unselected.length > 0) {
    parts.push('', '─'.repeat(72), 'installed but never selected', '─'.repeat(72))
    parts.push('These packages are installed in the profile and declare a dsh.bundle, so the harness\'s own')
    parts.push('reconcile step would have added each of them to dsh.profile.bundles. It did not run, or it did')
    parts.push('not finish, so the package is installed and never selected: no layer, no entries, nothing in')
    parts.push('this process and nothing for the entry sweep above to report. `dsh plugin add` is one way to')
    parts.push('reach this state — it reconciles only after the package manager returns.')
    for (const entry of unselected) {
      parts.push('', entry.packageName + (entry.version === undefined ? '' : `@${entry.version}`))
      if (entry.patchError !== undefined) parts.push(`  ${formatError(entry.patchError, errorChars)}`)
      else parts.push(`  dsh.bundle.patch: ${entry.patches.join(', ')}`)
      parts.push(`  resolved from the ${entry.from}; absent from dsh.profile.bundles`)
    }
    parts.push('')
    parts.push('To select it without reinstalling, add the name above to dsh.profile.bundles in the profile')
    parts.push('manifest, or re-run the install that was interrupted so reconcile runs.')
  }
  const gap = inspectedGap(installed)
  if (gap !== undefined) {
    parts.push('', `coverage: ${gap}`)
    for (const entry of installed.uninspected) {
      parts.push(`  ${entry.packageName}: ${formatError(entry.reason, errorChars)}`)
    }
  }
  return parts
}

/**
 * The composition section of the durable report, or an empty list without a finding.
 */
function compositionSection(audit: CompositionAudit | undefined, errorChars: number): readonly string[] {
  const stopped = stoppedBundles(audit)
  if (audit === undefined || stopped.length === 0) return []
  const parts: string[] = []
  parts.push('', '─'.repeat(72), 'profile composition', '─'.repeat(72))
  parts.push('The profile named these bundles and this process did not start from them. A bundle is')
  parts.push('composed before any entry exists, so a skipped one contributes no entries at all — the')
  parts.push('entry sweep above cannot see it, whatever it would have provided is missing from this')
  parts.push('process, and the launcher printed its reason once to stderr and carried on.')
  for (const bundle of stopped) {
    parts.push('', bundle.packageName)
    if (bundle.reason !== undefined) parts.push(`  ${formatError(bundle.reason, errorChars)}`)
    else parts.push('  no reason: the launcher\'s profile loader did not report this bundle')
  }
  parts.push('')
  parts.push(audit.reasons === 'dsh-app-boot'
    ? `reasons: recovered from ${APP_BOOT} (the launcher's own profile loader)`
    : `reasons: unavailable — ${String(audit.reasonsError)}`)
  return parts
}

/**
 * The terminal projection: what did not activate, and where the full report is.
 *
 * Kept to one line per entry plus one header, because the desktop shell truncates
 * stderr to the last 64 KiB and because a startup diagnostic that floods the
 * terminal is one an operator learns to skip. The stack lives in the file.
 * @param rows - the audited entries.
 * @param options - rendering bounds.
 * @param reportPath - the durable report, when one was written.
 * @param omitted - entries dropped by `maxEntries`.
 * @param composition - the profile composition audit, when this process is a dsh profile.
 * @returns the text to write to stderr, or `''` when there is nothing to say.
 */
export function renderSummary(
  rows: readonly EntryAudit[],
  options: RenderOptions,
  reportPath?: string | undefined,
  omitted = 0,
  composition?: CompositionAudit | undefined,
): string {
  const found = problems(rows, options.includePending)
  const stopped = stoppedBundles(composition)
  const unselected = unselectedPackages(composition)
  // Any of the three being short is a finding on its own. A profile whose bundles
  // are all present can still have a plugin that failed; an entry tree that is
  // entirely healthy can still have been composed from fewer bundles than the
  // profile names; and a composition that matches its own manifest exactly can
  // still have been built from a manifest that never learned what was installed.
  if (found.length === 0 && stopped.length === 0 && unselected.length === 0) return ''
  const shown = found.slice(0, options.maxEntries)
  const counts: string[] = []
  if (stopped.length > 0) {
    counts.push(`${String(stopped.length)} profile ${stopped.length === 1 ? 'bundle' : 'bundles'} did not start`)
  }
  if (unselected.length > 0) {
    counts.push(`${String(unselected.length)} ${unselected.length === 1 ? 'package' : 'packages'} installed but never selected`)
  }
  if (found.length > 0) counts.push(`${String(found.length)} ${found.length === 1 ? 'entry' : 'entries'} did not activate`)
  const suffix = reportPath === undefined ? '' : ` (report: ${reportPath})`
  const lines = [`dsh: activation-doctor: ${counts.join('; ')}${suffix}`]
  for (const bundle of stopped) {
    lines.push(`  profile bundle ${bundle.packageName}: ${stoppedLine(bundle, options.summaryChars)}`)
  }
  for (const entry of unselected) {
    lines.push(`  unselected ${entry.packageName}: ${unselectedLine(entry, options.summaryChars)}`)
  }
  for (const row of shown) lines.push(`  ${row.id} (${row.name}): ${firstLine(row, options.summaryChars)}`)
  const hidden = found.length - shown.length + omitted
  if (hidden > 0) lines.push(`  … and ${String(hidden)} more (see the report)`)
  return `${lines.join('\n')}\n`
}

/**
 * The durable projection: every problem, with its original error and stack.
 *
 * The index comes first so the file is readable without scrolling past stacks,
 * and each entry is then repeated in full. Both projections come from the same
 * sweep, so the file can never disagree with the line the operator saw.
 * @param rows - the audited entries.
 * @param context - where the report came from.
 * @param options - rendering bounds.
 * @param now - the report's timestamp.
 * @returns the report text.
 */
export function renderReport(
  rows: readonly EntryAudit[],
  context: ReportContext,
  options: RenderOptions,
  now: Date,
): string {
  const found = problems(rows, options.includePending)
  const shown = found.slice(0, options.maxEntries)
  const total = context.totalEntries ?? rows.length
  const parts: string[] = []
  parts.push(CREDENTIAL_WARNING, '')
  parts.push(`timestamp: ${now.toISOString()}`)
  parts.push(`phase: ${context.phase}`)
  parts.push(`settled: ${context.settled ? 'yes' : 'no — the loader still had pending work when this ran'}`)
  if (context.version !== undefined) parts.push(`dshVersion: ${context.version}`)
  if (context.profile !== undefined) parts.push(`profile: ${context.profile}`)
  const compositionFactLine = compositionFact(context.composition)
  if (compositionFactLine !== undefined) parts.push(compositionFactLine)
  parts.push(`nodeVersion: ${process.version}`)
  parts.push(`platform: ${process.platform} ${process.arch}`)
  parts.push(`execPath: ${process.execPath}`)
  parts.push('')
  parts.push(context.phase === 'live'
    ? `new entries did not activate: ${String(found.length)} of ${String(total)} entries in the tree`
    : `entries did not activate: ${String(found.length)} of ${String(total)}`)
  for (const line of compositionSection(context.composition, options.errorChars)) parts.push(line)
  for (const line of installedSection(context.composition, options.errorChars)) parts.push(line)
  parts.push('')
  parts.push('index:')
  for (const row of shown) parts.push(`  ${row.id} (${row.name}): ${headline(row, options.summaryChars)}`)
  const hiddenIndex = found.length - shown.length
  if (hiddenIndex > 0) parts.push(`  … and ${String(hiddenIndex)} more`)
  for (const row of shown) {
    parts.push('', '─'.repeat(72), `${row.id} (${row.name})`, '─'.repeat(72))
    if (row.outcome.kind === 'failed') {
      if (row.outcome.phase !== undefined) parts.push(`phase: ${row.outcome.phase}`)
      parts.push(formatError(row.outcome.error, options.errorChars))
    } else {
      parts.push(headline(row, options.errorChars))
    }
  }
  if (found.length > 0) {
    parts.push('', 'Every plugin above is still installed and still enabled: the harness does not roll back a')
    parts.push('registration, it unloads the fiber that threw. Whatever the plugin contributed is gone for this')
    parts.push('process. To see the collision that caused it, search the stack for the registration call.')
  }
  return `${parts.join('\n')}\n`
}

/**
 * Write one report and return its path.
 *
 * The directory is created with `0700` and the file with `0600` and the `wx` flag,
 * so a report is private and a name collision is a failure rather than a
 * truncation of an earlier report. A failed write is not thrown: the caller prints
 * the full report to stderr instead, which is what the shipped diagnostic does in
 * the same situation.
 * @param dir - the report directory.
 * @param text - the report text.
 * @param now - the timestamp used in the file name.
 * @returns the written path.
 * @throws when the directory or the file cannot be created.
 */
export async function writeReport(dir: string, text: string, now: Date): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `activation-${now.toISOString().replaceAll(':', '-')}-${randomUUID()}.log`)
  await writeFile(path, text, { flag: 'wx', mode: 0o600 })
  return path
}
