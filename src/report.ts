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

/** The header line summarising one composition audit, or `undefined` without one. */
function compositionFact(audit: CompositionAudit | undefined): string | undefined {
  if (audit === undefined) return undefined
  if (audit.declared === undefined) return `profileBundles: the declaration could not be read — ${String(audit.declaredError)}`
  const stopped = stoppedBundles(audit)
  const head = `profileBundles: ${String(audit.declared.length)} declared, ${String(audit.started.length)} started`
  return stopped.length === 0 ? head : `${head}, ${String(stopped.length)} did not start`
}

/** The composition section of the durable report, or an empty list without a finding. */
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
  // Either stage being short is a finding on its own. A profile whose bundles
  // are all present can still have a plugin that failed, and — the case this
  // half was added for — an entry tree that is entirely healthy can still have
  // been composed from fewer bundles than the profile names.
  if (found.length === 0 && stopped.length === 0) return ''
  const shown = found.slice(0, options.maxEntries)
  const counts: string[] = []
  if (stopped.length > 0) {
    counts.push(`${String(stopped.length)} profile ${stopped.length === 1 ? 'bundle' : 'bundles'} did not start`)
  }
  if (found.length > 0) counts.push(`${String(found.length)} ${found.length === 1 ? 'entry' : 'entries'} did not activate`)
  const suffix = reportPath === undefined ? '' : ` (report: ${reportPath})`
  const lines = [`dsh: activation-doctor: ${counts.join('; ')}${suffix}`]
  for (const bundle of stopped) {
    lines.push(`  profile bundle ${bundle.packageName}: ${stoppedLine(bundle, options.summaryChars)}`)
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
