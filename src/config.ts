/**
 * Configuration, normalized once at mount.
 *
 * The knobs answer the two questions an operator asks about a diagnostic that
 * writes files: *where does it write* (`report`, `reportDir`) and *how much does
 * it say* (`log`, `includePending`, `maxEntries`, `errorChars`, `maxLiveReports`).
 *
 * The defaults are the quiet-useful set: report to `$DSH_HOME/logs`, print one
 * line to stderr only when there is something to say, and re-report failures that
 * appear after startup. `log: 'off'` exists for a deployment that wants the file
 * and not the terminal line; `enabled: false` exists because "is this plugin
 * responsible for the file I am seeing" should be answerable without uninstalling
 * it.
 *
 * @module @argszero/dsh-activation-doctor/config
 */

import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** How much the plugin says on stderr. */
export type LogMode = 'summary' | 'off'

/** The plugin configuration as a user writes it. */
export interface Config {
  /** `false` installs nothing at all. */
  readonly enabled?: boolean
  /** Print the summary line to stderr. Defaults to `summary` on any problem, silent otherwise. */
  readonly log?: LogMode
  /** Write the durable report file. Defaults to `true`. */
  readonly report?: boolean
  /**
   * Where reports are written. Defaults to `<home>/logs`, where `<home>` is
   * `$DSH_HOME` (when set to a non-blank value) or `~/.dsh` — the same directory
   * the harness's own startup report uses (`apps/cli/src/startup-diagnostics.ts`).
   */
  readonly reportDir?: string
  /** Include entries waiting for a service. Defaults to `true`. */
  readonly includePending?: boolean
  /**
   * Re-report failures that appear after the first settled sweep — a hot reload,
   * a profile patch re-application, a plugin mounted later. Defaults to `true`.
   */
  readonly watch?: boolean
  /** Register the `activation_status` tool. Defaults to `true`. */
  readonly tool?: boolean
  /**
   * Audit the profile composition as well as the entry tree. Defaults to `true`.
   *
   * The audit compares the profile manifest's declared bundles with the launcher's
   * `startedBundles`, and recovers the launcher's own skip reasons from
   * `@deepseek-ai/dsh-app-boot`. Switch it off for a deployment that wants the
   * entry sweep and nothing else.
   */
  readonly composition?: boolean
  /** Inclusive bound on the entries listed in one report. Defaults to `50`. */
  readonly maxEntries?: number
  /** Inclusive bound on one entry's rendered error. Defaults to `4000`. */
  readonly errorChars?: number
  /** Cap on post-startup reports per process. Defaults to `5`. */
  readonly maxLiveReports?: number
  /** Quiet period before a sweep, in milliseconds. Defaults to `50`. */
  readonly debounceMs?: number
  /** Sweeps that may pass while the loader still has pending tasks. Defaults to `400`. */
  readonly maxSettleTries?: number
}

/** The configuration with every default resolved. */
export interface Settings {
  readonly enabled: boolean
  readonly log: LogMode
  readonly report: boolean
  readonly reportDir: string
  readonly includePending: boolean
  readonly watch: boolean
  readonly tool: boolean
  readonly composition: boolean
  readonly maxEntries: number
  readonly errorChars: number
  readonly maxLiveReports: number
  readonly debounceMs: number
  readonly maxSettleTries: number
}

/** The reference defaults, also exported as the plugin's `Config`. */
export const defaultConfig: Required<Config> = {
  enabled: true,
  log: 'summary',
  report: true,
  reportDir: '',
  includePending: true,
  watch: true,
  tool: true,
  composition: true,
  maxEntries: 50,
  errorChars: 4000,
  maxLiveReports: 5,
  debounceMs: 50,
  maxSettleTries: 400,
}

/** Read a boolean, falling back for anything that is not one. */
function boolean(value: boolean | undefined, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Read a positive integer, falling back when the value is absent or unusable. */
function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

/**
 * Expand a leading `~` against the account's home directory.
 *
 * The harness's own path helper normalizes a configured root this way
 * (`packages/util/home-paths`); a plugin that accepts a directory from a config
 * file has to do the same, or a `~/logs` override writes a directory literally
 * named `~` beside the process.
 * @param path - a configured path.
 * @returns the expanded path.
 */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve the harness home directory the way the shipped helper does, minus the
 * configured-path tier.
 *
 * Precedence is `$DSH_HOME` (ignoring a blank value, so a blank override never
 * resolves to the current directory) and then `~/.dsh`. The helper in
 * `packages/util/home-paths` additionally honours an explicit configured path
 * supplied by the launcher; a plugin mounted from a patch has no access to that
 * value, so an operator who configures a non-default home should set `reportDir`
 * explicitly. That boundary is stated in the README rather than papered over.
 * @param env - environment mapping; defaults to `process.env`.
 * @returns the absolute harness home directory.
 */
export function resolveHome(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return expandHome(fromEnv.trim())
  return join(homedir(), '.dsh')
}

/**
 * Resolve a user configuration into the settings the plugin runs with.
 *
 * Every value is read defensively: a configuration file is authored by hand, and
 * a diagnostic that throws on a typo is a diagnostic that loses the failure it
 * was mounted to report.
 * @param config - the configuration as mounted, possibly empty.
 * @returns every setting, with defaults applied.
 */
export function normalizeConfig(config: Config): Settings {
  const configuredDir = typeof config.reportDir === 'string' && config.reportDir.trim() !== ''
    ? expandHome(config.reportDir.trim())
    : ''
  return {
    enabled: boolean(config.enabled, defaultConfig.enabled),
    log: config.log === 'off' ? 'off' : 'summary',
    report: boolean(config.report, defaultConfig.report),
    reportDir: configuredDir === '' ? join(resolveHome(), 'logs') : configuredDir,
    includePending: boolean(config.includePending, defaultConfig.includePending),
    watch: boolean(config.watch, defaultConfig.watch),
    tool: boolean(config.tool, defaultConfig.tool),
    composition: boolean(config.composition, defaultConfig.composition),
    maxEntries: positiveInteger(config.maxEntries, defaultConfig.maxEntries),
    errorChars: positiveInteger(config.errorChars, defaultConfig.errorChars),
    maxLiveReports: positiveInteger(config.maxLiveReports, defaultConfig.maxLiveReports),
    debounceMs: positiveInteger(config.debounceMs, defaultConfig.debounceMs),
    maxSettleTries: positiveInteger(config.maxSettleTries, defaultConfig.maxSettleTries),
  }
}

/** Whether a configured report directory is usable as an absolute path. */
export function isUsableReportDir(dir: string): boolean {
  return dir.trim() !== '' && isAbsolute(dir)
}
