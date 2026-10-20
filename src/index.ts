/**
 * A third-party plugin that fails to activate disappears without a trace, and
 * this plugin is the trace.
 *
 * The reported incident (#9308) is the clean form of it: a plugin registered a
 * tool whose name was already taken, `NamedEntries.insert` threw before any
 * insertion, the error left the plugin body, and the fiber unloaded — taking with
 * it every tool and every prompt section that plugin had contributed. The
 * marketplace row still said *installed and enabled*, because the row describes
 * the profile, not the activation; no UI showed anything, and the operator's
 * search for a log found zero hits.
 *
 * Zero hits is the expected result, and the reason is structural rather than a
 * bug in logging. Three facts, each of them read from the shipped source:
 *
 * 1. **The failure *is* logged, into a sink nobody can read.** `Fiber._reload()`
 *    catches the plugin body's throw, calls `this.ctx.logger.error(reason)`,
 *    records the error, and unloads the fiber (`vendor/cordis/src/fiber.ts`).
 *    Neither shipped profile mounts a logger sink.
 * 2. **Startup only *fails* for core entry ids.** `auditStartupEntries` marks an
 *    entry required only when its id is in the built-in set or it is the bootstrap
 *    include (`packages/boot/app-boot/src/index.ts`); a third-party id can never be
 *    in that set, so a third-party failure takes the `warn` branch and one line
 *    goes to `process.stderr` while the rest of the application starts normally.
 * 3. **The persistent report is written only on that fatal path.**
 *    `reportStartupFailure` has exactly one caller — the `StartupError` handler in
 *    `apps/cli/src/bin.ts` — so `$DSH_HOME/logs/startup-*.log` is never created for
 *    a third-party-only failure. In the desktop build the stderr line is drained
 *    into a 64 KiB in-memory buffer (`apps/desktop/src/host-process.ts`) that is
 *    attached to an error message only on exit.
 *
 * So the missing piece is not a fix to the loader, the registry or the audit
 * policy — it is a **sink**. The state a report needs is already public: the loader
 * exposes its entries (`ctx.loader.entries()`), every entry carries its fiber, and
 * `fiber.await()` rethrows the original activation error with its stack. This
 * plugin reads that state after the tree settles, writes a private report where
 * the operator will find it, prints one line, and keeps watching so a failure that
 * appears later — a hot reload, a profile patch re-application, a plugin mounted
 * after startup — is reported too. `activation_status` answers the same question
 * inside a session, on demand.
 *
 * ## The third stage: installed and never selected
 *
 * The sweep answers "which plugin did not activate" and the composition arm
 * answers "which named bundle did not start". Neither can see a package that was
 * installed and never entered the bundle list at all, because such a package
 * appears in no list the running process holds — the profile manifest agrees with
 * itself and the package is simply absent. `installed.ts` reads the profile's
 * `dependencies`, resolves each one the way the loader resolves a bundle, and
 * reports the ones whose own manifest declares `dsh.bundle`: those are exactly the
 * packages the harness's `reconcile` step would have selected, and a failed or
 * interrupted `dsh plugin add` is how they come to be missing (discussion #9261).
 * It is a file read, so it needs no runtime service and is answered before the
 * first entry exists.
 *
 * ## Why the sweep waits for the tree to settle
 *
 * An entry that has not finished importing has no fiber yet, and the sweep would
 * read that as an import failure. The sweep therefore asks the loader for its
 * pending tasks and waits for zero before it reports. Two mechanical notes came
 * out of measuring this against a real loader rather than assuming it:
 *
 * - **A plugin must not await the loader from inside its own setup.** `getTasks()`
 *   includes the entry's fiber *inertia*, which during that plugin's own setup is
 *   the promise of that very setup — `await loader.await()` there waits on itself.
 *   The sweep is therefore scheduled (a short debounce after the tree goes quiet),
 *   never awaited inline.
 * - **The loader's `await: true` intercept is not a substitute.** It is evaluated
 *   when a dependent's dependency set is refreshed, and reaching it early — before
 *   the entries that will fail even exist — is the normal case for a plugin mounted
 *   from a patch, so it cannot be relied on to mean "after the tree settled".
 *
 * ## What this is not
 *
 * A detector, not a repairer. It does not restart the failed plugin, does not
 * change registration semantics, does not touch the marketplace row, and cannot
 * move the desktop's stderr. A plugin whose tool name collides with another
 * plugin's still fails; the difference is that the operator can now find out which
 * two plugins, which name, and from where. The README states the boundary; the
 * `cordis.patch.yml` in this package states the seam and why it is a read.
 *
 * @module @argszero/dsh-activation-doctor
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { auditEntries, findingKey, formatError, isProblem, pendingTasks } from './audit.ts'
import type { EntryAudit, LoaderLike } from './audit.ts'
import { auditComposition, stoppedBundles } from './composition.ts'
import type { CompositionAudit } from './composition.ts'
import { unselectedPackages } from './installed.ts'
import { censusDenials, deniedRows } from './denial.ts'
import type { DenialCensus } from './denial.ts'
import { defaultConfig, normalizeConfig } from './config.ts'
import type { Config, Settings } from './config.ts'
import { problems, renderReport, renderSummary, writeReport } from './report.ts'
import type { RenderOptions } from './report.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'activation-doctor'

/**
 * The service this plugin reads.
 *
 * `loader` is required — without the entry tree there is nothing to sweep, and a
 * doctor that activates without it would be reporting an empty world as healthy.
 */
export const inject = ['loader']

export type { Config, Settings, LogMode } from './config.ts'
export { defaultConfig, normalizeConfig, resolveHome, expandHome } from './config.ts'
export type { CompositionAudit, ProfileFacts, ReasonReader, StoppedBundle } from './composition.ts'
export { APP_BOOT, auditComposition, profileFactsOf, readDeclaredBundles, readDeclaredProfile, readSkippedBundles, stoppedBundles } from './composition.ts'
export type { DeclaredProfile } from './composition.ts'
export type { AnchorKind, DependencyManifest, InstalledAudit, PackageReader, UninspectedDependency, UnselectedPackage } from './installed.ts'
export { MAX_INSPECTED, auditInstalledSelection, inspectManifest, packageDirFor, searchPathsFor, unselectedPackages } from './installed.ts'
export type { EntryAudit, EntryLike, FiberLike, LoaderLike, Outcome } from './audit.ts'
export { auditEntries, classifyEntry, findingKey, formatError, isProblem, pendingTasks } from './audit.ts'
export type {
  CensusOptions, CompatibilityIssue, CompatibilityRule, DenialCensus, DenialCheck, DenialVerdict, RuleReader,
  RuleSource, RuleState, VerdictContext,
} from './denial.ts'
export {
  NO_NAME_REASON, UNRESOLVED_REASON, censusDenials, deniedRows, isBareSpecifier, resolveManifest, verdictOf,
} from './denial.ts'
export type { ReportContext, RenderOptions } from './report.ts'
export { CREDENTIAL_WARNING, problems, renderReport, renderSummary, writeReport } from './report.ts'

/** The tool name the on-demand query registers under. */
export const STATUS_TOOL_NAME = 'activation_status'

/** State that lives for as long as the plugin is mounted. */
interface DoctorState {
  /** Finding keys already reported, so a settled fiber is not re-reported. */
  readonly reported: Set<string>
  /** Post-startup reports written so far. */
  liveReports: number
  /** The most recent report path, if a report was ever written. */
  lastReportPath: string | undefined
  /** Whether the startup sweep has run. */
  started: boolean
  /** The composition audit, cached for the on-demand query. */
  composition: CompositionAudit | undefined
  /** Whether the composition audit has been attempted; it is a once-per-process fact. */
  compositionAudited: boolean
  /** The denial census, cached for the on-demand query. */
  census: DenialCensus | undefined
  /** Whether the census has been attempted; the preflight runs before the tree mounts. */
  censusAudited: boolean
}

/** Read the loader service through the reflection layer, structurally. */
function loaderOf(ctx: Context): LoaderLike | undefined {
  let candidate: unknown
  try {
    candidate = ctx.get('loader')
  } catch {
    candidate = undefined
  }
  return isLoaderLike(candidate) ? candidate : undefined
}

/** Whether a value looks like the loader service this plugin reads. */
function isLoaderLike(value: unknown): value is LoaderLike {
  return typeof value === 'object' && value !== null && typeof (value as LoaderLike).entries === 'function'
}

/** Wait for a real delay; the sweep runs on its own timer, never inline. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Render the plugin's version when the host exposes one.
 *
 * Read defensively: the version is decoration in a report, and a doctor that
 * throws while describing a failure is worse than one that omits a line.
 * @param ctx - the plugin context.
 * @returns the version, or `undefined`.
 */
function versionOf(ctx: Context): string | undefined {
  try {
    const version = ctx.get('appInfo')?.version ?? ctx.get('version')
    return typeof version === 'string' && version !== '' ? version : undefined
  } catch {
    return undefined
  }
}

/** The profile name from the environment the launcher sets, when present. */
function profileOf(): string | undefined {
  for (const key of ['DSH_PROFILE', 'DSH_ACTIVE_PROFILE']) {
    const value = process.env[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** Rendering bounds derived from the settings. */
function renderOptions(settings: Settings): RenderOptions {
  return {
    maxEntries: settings.maxEntries,
    errorChars: settings.errorChars,
    includePending: settings.includePending,
    summaryChars: 400,
  }
}

/**
 * The on-demand query.
 *
 * It exists because the report is otherwise only visible at startup, and "which
 * of my plugins is actually running" is a question an operator asks *after* the
 * process is up, usually while looking at a session in which a tool they expect is
 * missing. The answer is produced by the same sweep as the startup report, so the
 * two can never disagree.
 * @param sweep - the plugin's settle-then-audit routine.
 * @param options - rendering bounds.
 * @returns the tool definition.
 */
function statusTool(
  sweep: () => Promise<{
    rows: readonly EntryAudit[]
    settled: boolean
    reportPath: string | undefined
    composition: CompositionAudit | undefined
    denial: DenialCensus | undefined
  }>,
  options: RenderOptions,
): ToolDefinition {
  return defineTool({
    name: STATUS_TOOL_NAME,
    description: 'Report which plugins did not activate in this process, and why. '
      + 'A plugin that fails while registering — most often because a tool or prompt-section name it registers '
      + 'is already taken — is unloaded whole: every tool and prompt section it contributed is gone, while the '
      + 'marketplace still shows it installed. It also reports a package that is installed and was never '
      + 'selected as a profile bundle, which is the state a failed or interrupted install leaves behind. '
      + 'It also separates the entries that are switched off because you switched them off from the ones the '
      + 'launcher refused while composing the profile: a refusal is written as the same `disabled` flag, and '
      + 'its reason goes to stderr once and nowhere else. '
      + 'Use this to find out whether a plugin you expect is missing, which one it is, and why.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      const { rows, settled, reportPath, composition, denial } = await sweep()
      const found = problems(rows, options.includePending)
      const stopped = stoppedBundles(composition)
      const unselected = unselectedPackages(composition)
      const refused = deniedRows(denial)
      const header = `activation-doctor: ${String(rows.length)} loader ${rows.length === 1 ? 'entry' : 'entries'} inspected`
        + `${settled ? '' : ' (the loader still had pending work when this ran)'}`
        + `${reportPath === undefined ? '' : `; last report: ${reportPath}`}`
        // Said rather than omitted: a caller asking this question about a host
        // with no profile has to be able to tell "nothing was composed badly"
        // from "there was nothing to compose".
        + `${composition === undefined ? '; no profile composition to audit (this process was not launched from a dsh profile)' : ''}`
        + (denial === undefined
          ? ''
          : `; ${String(denial.inspected)} ${denial.inspected === 1 ? 'entry' : 'entries'} switched off, `
            + `${String(refused.length)} of them refused by the launcher's preflight`
            + `${denial.unchecked.length === 0 ? '' : `, ${String(denial.unchecked.length)} not recomputable`}`)
      // "Or switched off deliberately" is a claim about work this arm did, and it
      // is only earned when every switched-off row was actually cleared. With the
      // census switched off — or with a row it could not read — some of these
      // entries are switched off for a reason this report cannot account for, and
      // an unearned all-clear is the failure mode this plugin exists to remove.
      const accounted = !rows.some(row => row.outcome.kind === 'disabled')
        || (denial !== undefined && refused.length === 0 && denial.unchecked.length === 0)
      const allClear = accounted
        ? 'Every entry is active (or switched off deliberately).'
        : 'Every entry is active. At least one entry is switched off, and this report cannot say whether you did it.'
      if (found.length === 0 && stopped.length === 0 && unselected.length === 0 && refused.length === 0) {
        // The second sentence is added only when that arm actually ran: a host
        // with no profile, or one whose manifest could not be read, has not
        // earned the claim either.
        const selected = composition?.installed === undefined ? '' : ' Every installed bundle was selected.'
        return `${header}\n${allClear}${selected}`
      }
      const summary = renderSummary(rows, options, reportPath, 0, composition, denial)
      const healthy = found.length === 0 && refused.length === 0 ? `${allClear}\n` : ''
      return `${header}\n\n${healthy}${summary}`
    },
  })
}

/**
 * Mount the doctor.
 *
 * `config` is whatever a loader entry passed, or `undefined` when it passed
 * nothing, so the defaults live here. They cannot live in an exported `Config`:
 * cordis reads `Config['~standard'].validate` off a plugin's `Config`
 * (measured: `vendor/cordis/src/fiber.ts`, `resolveConfig`), and a plain defaults
 * object has no such property, so naming one there throws
 * `Cannot read properties of undefined (reading 'validate')` out of
 * `Fiber._reload` — before this function is called, taking the doctor down
 * exactly when somebody needs it to report on the plugin that just did the same.
 *
 * There is deliberately **no `Config` export** at all. A
 * `@deepseek-ai/schemastery` schema would be the other way to satisfy that check,
 * at the price of one more peer range to keep admitted across the release lines;
 * every knob here is read defensively by {@link normalizeConfig} instead, so the
 * defaults are the same with or without a schema, and the mount cannot be broken
 * by a dependency the doctor does not need.
 * @param ctx - the plugin context.
 * @param config - the plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const settings = normalizeConfig(config)
  if (!settings.enabled) return
  const options = renderOptions(settings)

  ctx.effect(() => {
    const state: DoctorState = {
      reported: new Set<string>(),
      liveReports: 0,
      lastReportPath: undefined,
      started: false,
      composition: undefined,
      compositionAudited: false,
      census: undefined,
      censusAudited: false,
    }
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined

    /**
     * Sweep, waiting for the loader to go quiet first.
     *
     * `settled: false` is reported rather than hidden: a tree that never settles is
     * itself a finding, and pretending otherwise would turn a slow import into an
     * import failure.
     */
    const settledSweep = async (maxTries: number): Promise<{ rows: readonly EntryAudit[], settled: boolean }> => {
      for (let attempt = 0; attempt <= maxTries; attempt += 1) {
        const loader = loaderOf(ctx)
        if (loader === undefined) return { rows: [], settled: false }
        if (pendingTasks(loader) === 0) return { rows: await auditEntries(loader), settled: true }
        await delay(settings.debounceMs)
        if (disposed) return { rows: [], settled: false }
      }
      const loader = loaderOf(ctx)
      return { rows: loader === undefined ? [] : await auditEntries(loader), settled: false }
    }

    /**
     * Audit the profile composition, once per process.
     *
     * Once, because the answer is a launch fact: `startedBundles` is what this
     * process was *composed from* and cannot change while it runs. The cache is
     * kept for the on-demand query, and the return value is deliberately
     * `undefined` after the first call so that a later sweep does not re-report a
     * finding that has not changed — the same reason the entry sweep keeps
     * `state.reported`.
     */
    const auditOnce = async (): Promise<CompositionAudit | undefined> => {
      if (!settings.composition || state.compositionAudited) return undefined
      state.compositionAudited = true
      try {
        state.composition = await auditComposition(ctx, undefined, { installed: settings.installed })
      } catch {
        // The audit is itself wrapped defensively, so this is belt and braces: a
        // diagnostic that throws is worse than a diagnostic that is silent.
        state.composition = undefined
      }
      return state.composition
    }

    /**
     * Census the switched-off entries, once per process.
     *
     * Once, for the same reason the composition is audited once: what was switched
     * off is decided when the profile is composed, before the tree mounts, and the
     * preflight keeps no copy of what the declaration said beforehand. Re-reading
     * the tree later would attribute a *later* denial to this boot's preflight,
     * which is a claim this arm is not entitled to make.
     */
    const censusOnce = async (): Promise<DenialCensus | undefined> => {
      if (!settings.denial || state.censusAudited) return undefined
      state.censusAudited = true
      try {
        const loader = loaderOf(ctx)
        if (loader === undefined) return undefined
        state.census = await censusDenials(ctx, loader.entries())
      } catch {
        // Belt and braces, like the composition: a diagnostic that throws is worse
        // than a diagnostic that is silent.
        state.census = undefined
      }
      return state.census
    }

    /** Write the report and the terminal line for one sweep's fresh findings. */
    const emit = async (
      phase: 'startup' | 'live',
      total: number,
      settled: boolean,
      fresh: readonly EntryAudit[],
      composition: CompositionAudit | undefined,
      census: DenialCensus | undefined,
    ): Promise<void> => {
      const now = new Date()
      let reportPath = state.lastReportPath
      if (settings.report) {
        const text = renderReport(fresh, {
          phase,
          settled,
          totalEntries: total,
          version: versionOf(ctx),
          profile: profileOf() ?? composition?.profile,
          composition,
          denial: census,
        }, options, now)
        try {
          reportPath = await writeReport(settings.reportDir, text, now)
          state.lastReportPath = reportPath
          if (phase === 'live') state.liveReports += 1
        } catch (error: unknown) {
          // The file is the durable half. When it cannot be written the terminal
          // carries the same text, rather than the operator losing both halves.
          process.stderr.write(`dsh: activation-doctor: could not write the report to ${settings.reportDir}: ${String(error)}\n`)
          process.stderr.write(`${text}\n`)
        }
      }
      if (settings.log === 'off') return
      const summary = renderSummary(fresh, options, reportPath, 0, composition, census)
      if (summary !== '') process.stderr.write(summary)
    }

    /** One sweep, from the scheduler or from the tool. */
    const run = async (phase: 'startup' | 'live'): Promise<void> => {
      if (disposed) return
      const { rows, settled } = await settledSweep(settings.maxSettleTries)
      if (disposed) return
      // The composition is audited on the startup sweep. It does not depend on
      // the loader having settled — the profile was composed before any entry
      // existed — but it is reported with the same sweep so the file and the
      // line carry one picture of the process.
      const composition = await auditOnce()
      if (disposed) return
      const census = await censusOnce()
      if (disposed) return
      const stopped = stoppedBundles(composition)
      const unselected = unselectedPackages(composition)
      const refused = deniedRows(census)
      const found = problems(rows, settings.includePending)
      if (settled) {
        // A finding that has healed is forgotten, so a genuine re-failure is
        // reported again instead of being suppressed as a duplicate.
        const live = new Set(found.map(findingKey))
        for (const key of [...state.reported]) if (!live.has(key)) state.reported.delete(key)
      }
      const fresh = found.filter(row => !state.reported.has(findingKey(row)))
      // A healthy entry tree is not a healthy composition: the case this half
      // exists for is a profile that started with fewer bundles than it names
      // and every remaining entry activating perfectly. Nor is a composition that
      // matches its manifest a healthy installation: the third case is a package
      // installed and never selected, where the manifest agrees with itself and
      // the package is simply absent. Nor is an entry tree with nothing failed a
      // tree in which every switch-off was the operator's: a row the launcher's
      // preflight refused is `disabled` too, and it is reported by no other arm.
      if (fresh.length === 0 && stopped.length === 0 && unselected.length === 0 && refused.length === 0) return
      for (const row of fresh) state.reported.add(findingKey(row))
      if (phase === 'live' && state.liveReports >= settings.maxLiveReports) {
        if (settings.log !== 'off') {
          process.stderr.write(`dsh: activation-doctor: ${String(fresh.length)} further ${fresh.length === 1 ? 'entry' : 'entries'} did not activate; `
            + `report limit (${String(settings.maxLiveReports)}) reached: ${fresh.map(row => row.id).join(', ')}\n`)
        }
        return
      }
      await emit(phase, rows.length, settled, fresh, composition, census)
    }

    /** Debounce a sweep; the tree going quiet is what ends the wait. */
    const schedule = (phase: 'startup' | 'live'): void => {
      if (disposed) return
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        if (!state.started) {
          state.started = true
          void run('startup')
          return
        }
        void run('live')
      }, settings.debounceMs)
    }

    // The first sweep is scheduled rather than run inline: this plugin's own
    // activation happens while the tree is still loading, and a sweep now would
    // read not-yet-imported entries as import failures.
    schedule('startup')

    if (settings.watch) {
      // `internal/status` fires for every fiber in the process, including fibers
      // owned by other contexts — the loader's own entries among them — so this is
      // where a failure that appears after startup is noticed.
      ctx.on('internal/status', () => { schedule('live') })
    }

    // Registered through `ctx.inject` so a deployment whose tool registry never
    // appears still gets the file and the line.
    if (settings.tool) {
      ctx.inject(['tools'], toolCtx => {
        const tools = toolCtx.get('tools') as { register(definition: ToolDefinition): () => void } | undefined
        if (tools === undefined) return
        const dispose = tools.register(statusTool(async () => {
          const { rows, settled } = await settledSweep(Math.min(settings.maxSettleTries, 20))
          // The audit is a launch fact, so the query answers from the cache the
          // startup sweep filled rather than reading the profile again; asking a
          // second time could describe a composition this process never ran with.
          const composition = state.compositionAudited
            ? state.composition
            : await auditComposition(ctx, undefined, { installed: settings.installed })
          // Cached when the startup sweep ran, because a denial is a composition
          // fact; recomputed otherwise, which is the case for a host whose first
          // sweep is still pending when somebody asks.
          const liveLoader = state.censusAudited ? undefined : loaderOf(ctx)
          const census = !settings.denial
            ? undefined
            : state.censusAudited
              ? state.census
              : liveLoader === undefined ? undefined : await censusDenials(ctx, liveLoader.entries())
          return {
            rows,
            settled,
            reportPath: state.lastReportPath,
            composition: settings.composition ? composition : undefined,
            denial: census,
          }
        }, options))
        return () => { dispose() }
      })
    }

    return () => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, 'activation-doctor: report the plugins that did not activate')
}

export default { name, inject, apply }
