/**
 * The stage before the entries: did the profile compose the bundles it names?
 *
 * The entry sweep answers "which plugin did not activate". This module answers
 * the same question one stage earlier, and it is a strictly larger loss when the
 * answer is bad: a bundle the launcher skipped contributes **no entries at all**,
 * so the sweep cannot see it, no fiber exists to `await`, and no
 * `internal/status` event is ever emitted for it. The process starts, every
 * remaining entry activates, and the harness carries on with a smaller
 * composition than its own configuration declares — which is the defect reported
 * in discussion #9451 (boot and `--dump-config` exit 0 for a profile that names a
 * bundle that is not installed; only `--dump-config-schema` exits 1).
 *
 * ## Where the facts come from, and which one is authoritative
 *
 * Two public surfaces, and the difference between them is the whole design:
 *
 * - **`ctx.profileContext.startedBundles`** is the authority for *what this
 *   process was composed from*. It is the launcher's own list — the layer
 *   `packageName`s the running application was actually built out of
 *   (`apps/cli/src/profile-boot.ts` sets it from `Profile.layers`) — so nothing
 *   this module computes can overrule it, and a name in the profile manifest that
 *   is absent from it genuinely did not contribute.
 * - **`<profile>/package.json` → `dsh.profile.bundles`** is the *declaration*.
 *   It is a documented file format rather than an API, so it is read directly,
 *   defensively, and absence is reported as absence rather than as an empty list.
 *
 * One stage before that pair sits the arm in `installed.ts`: a package installed
 * and never selected is in neither list, so the two agree and this module is
 * structurally unable to see it. Both arms are answered from the same parse of the
 * manifest and reported together, because the operator's question — "which of the
 * plugins I installed is not running" — spans all three stages.
 *
 * The **reason** for a skip is not on either surface, and that is deliberate on
 * the harness's side: `loadProfileDirectory` collects `skippedBundles` and the
 * launcher prints them once to stderr (`reportSkippedBundles`), so the only
 * durable copy is the text the operator already scrolled past. This module
 * recovers it from the package that owns it — `@deepseek-ai/dsh-app-boot` — via a
 * dynamic import, and treats that read as **advisory**: it can only supply an
 * explanation, never change the finding. When it is unreachable the audit is
 * still complete and the report says the reason is unavailable, naming why.
 *
 * ## Why the import is dynamic, and why it is safe to attempt
 *
 * The doctor declares no dependency on app-boot. A profile that mounts this
 * plugin is a Node application: app-boot, cordis and the loader are all present
 * and resolvable, because the loader is what composed the tree. A host that is
 * not a `dsh` profile has no `profileContext` at all, so the section is skipped
 * before the import is reached. The import is therefore attempted exactly where
 * it can succeed, and every way it can fail — the package is absent, one of its
 * own peers is absent, the export was renamed, the returned profile has no
 * `skippedBundles` list — lands in the same safe place: findings without reasons.
 *
 * One boundary is worth naming rather than hiding: `loadProfileDirectory`
 * normalizes retired bundles out of the profile manifest, i.e. it can *write*
 * `<profile>/package.json` (its `dropRetiredBundles` step). The read here is
 * guarded to the one case where the manifest is already inconsistent with the
 * running process, and the launcher has itself already run that normalization
 * during this same boot — but the reader is not pure, and a diagnostic that says
 * so is worth more than one that quietly is not.
 *
 * @module @argszero/dsh-activation-doctor/composition
 */

import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { auditInstalledSelection } from './installed.ts'
import type { InstalledAudit } from './installed.ts'

/** The package that owns profile parsing. Read only when a reason is needed. */
export const APP_BOOT = '@deepseek-ai/dsh-app-boot'

/**
 * The launcher's profile facts, as this module reads them.
 *
 * Structural on purpose: `Context.profileContext` is declared by app-boot's own
 * module augmentation, and this plugin does not depend on app-boot. Validating
 * the shape at runtime is also what keeps a renamed or re-typed field from being
 * read as a healthy composition.
 */
export interface ProfileFacts {
  /** The profile name, falling back to the directory's own name. */
  readonly name: string
  /** The profile directory. */
  readonly dir: string
  /** The package-manager anchor, or `''` when the launcher supplied none. */
  readonly installAnchor: string
  /** The bundle packages this process was started from. */
  readonly startedBundles: readonly string[]
}

/** One bundle the profile names and this process did not compose. */
export interface StoppedBundle {
  /** The package name exactly as `dsh.profile.bundles` spells it. */
  readonly packageName: string
  /** The launcher's own skip text, when it could be recovered. */
  readonly reason: string | undefined
}

/** The composition answer: what was declared, what started, and why they differ. */
export interface CompositionAudit {
  /** The profile this process was launched from. */
  readonly profile: string
  /** Its directory. */
  readonly dir: string
  /** `dsh.profile.bundles` as the manifest states it; `undefined` when unreadable. */
  readonly declared: readonly string[] | undefined
  /** Why the manifest could not be read, when it could not. */
  readonly declaredError: string | undefined
  /** This process's own startup bundles. */
  readonly started: readonly string[]
  /** Declared names that contributed no layer. Empty when the declaration is unknown. */
  readonly missing: readonly StoppedBundle[]
  /** Where the reasons came from. */
  readonly reasons: 'dsh-app-boot' | 'unavailable'
  /** Why no reason came back, when none did. */
  readonly reasonsError: string | undefined
  /**
   * The stage before this one: dependencies that declare `dsh.bundle` and never
   * entered the bundle list.
   *
   * `undefined` when it could not be answered — the profile manifest was unreadable,
   * so neither list exists — and also when the operator switched the arm off. The
   * two are distinguishable by {@link declaredError}: a read failure is already
   * reported there, and an audit that claims nothing is not an audit that claims
   * health.
   */
  readonly installed: InstalledAudit | undefined
}

/** The reader that supplies the launcher's own skip reasons. */
export type ReasonReader = (dir: string, installAnchor: string) => Promise<readonly StoppedBundle[]>

/** Render any thrown value as one line, without a stack. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error === '' ? '(empty string thrown)' : error
  if (error === undefined) return '(undefined thrown)'
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

/**
 * Read the launcher's profile facts off a context.
 *
 * Every field is validated: `ctx.get` is a service lookup that can throw, and the
 * value on the other side is supplied by the launcher rather than by this plugin,
 * so a shape that is not the one this module reads is reported as "no profile
 * context" instead of being coerced into a composition claim. A context with no
 * `profileContext` is the normal case for a plain cordis application, and it is
 * not an error.
 * @param ctx - the plugin context.
 * @returns the facts, or `undefined` when this process is not a dsh profile.
 */
export function profileFactsOf(ctx: { get(name: string): unknown }): ProfileFacts | undefined {
  let candidate: unknown
  try {
    candidate = ctx.get('profileContext')
  } catch {
    return undefined
  }
  if (candidate === null || typeof candidate !== 'object') return undefined
  const probe = candidate as {
    name?: unknown
    dir?: unknown
    installAnchor?: unknown
    startedBundles?: unknown
  }
  if (typeof probe.dir !== 'string' || probe.dir === '') return undefined
  if (!Array.isArray(probe.startedBundles)) return undefined
  const startedBundles = probe.startedBundles.filter((name): name is string => typeof name === 'string')
  if (startedBundles.length !== probe.startedBundles.length) return undefined
  return {
    name: typeof probe.name === 'string' && probe.name !== '' ? probe.name : basename(probe.dir),
    dir: probe.dir,
    installAnchor: typeof probe.installAnchor === 'string' ? probe.installAnchor : '',
    startedBundles,
  }
}

/**
 * The two lists a profile manifest declares about plugins.
 *
 * One parse feeds both stages: `bundles` is the selection this process composed
 * its tree from, `dependencies` is what the package manager installed. Their
 * difference is the finding the two arms report — declared-and-not-started here,
 * installed-and-not-selected in `installed.ts`. The two fields do not even share a
 * *shape*: `bundles` is an array of names and `dependencies` is an npm map of names
 * to ranges, which is why each is read by its own reader.
 */
export interface DeclaredProfile {
  /** Ordered bundle layer list; `undefined` when the key is absent. */
  readonly bundles: readonly string[] | undefined
  /** Direct dependency names, read from the map's keys; `undefined` when the key is absent. */
  readonly dependencies: readonly string[] | undefined
}

/** Read one list of package names off a manifest object. */
function nameList(value: unknown, field: string): { readonly names: readonly string[] } | { readonly error: string } {
  if (value === undefined) return { names: [] }
  if (!Array.isArray(value)) return { error: `${field} is not a list` }
  if (value.some(name => typeof name !== 'string')) return { error: `${field} carries a non-string entry` }
  return { names: value as readonly string[] }
}

/**
 * Read the dependency names off a manifest object.
 *
 * `dependencies` is an npm **map** — `{"@acme/plugin": "^0.5.4"}` — and not the
 * array `dsh.profile.bundles` is, which is why it has its own reader rather than
 * sharing {@link nameList}. Reading it as a list looks harmless and is not: the
 * parse fails, and the failure is the *whole profile's* — every shipped profile
 * carries a `dependencies` map, so a composition audit that rejected one would
 * report `declaredError` and lose the bundle declaration too, which is the arm that
 * was already shipped and working. The defect survives any fixture whose manifest
 * happens to omit the key, so the arm that caught it is the one built from a real
 * profile manifest. `plugin-manager` reads the same field the same way
 * (`Object.keys(manifest.dependencies ?? {})`).
 *
 * A list of names is accepted as well: the claim this feeds is about names either
 * way, and refusing a spelling that states the same thing would be pedantry rather
 * than a finding. Anything else is reported rather than read as "no dependencies".
 * @param value - the parsed `dependencies` field.
 * @returns the names in manifest order, or the reason there are none.
 */
function dependencyNames(value: unknown): { readonly names: readonly string[] } | { readonly error: string } {
  if (value === undefined) return { names: [] }
  if (Array.isArray(value)) {
    if (value.some(name => typeof name !== 'string')) return { error: 'dependencies carries a non-string entry' }
    return { names: value as readonly string[] }
  }
  if (value === null || typeof value !== 'object') return { error: 'dependencies is neither a map of names nor a list' }
  return { names: Object.keys(value) }
}

/**
 * Read the declared bundle list and dependency names from the profile manifest.
 *
 * A missing key is an empty declaration — a profile is allowed to name no bundles
 * and to have no dependencies — while an unreadable or malformed manifest is
 * reported as an error, because "declared nothing" and "could not be read" lead to
 * opposite conclusions and must not render the same. The two fields are read by
 * their own readers because they do not share a shape: `dsh.profile.bundles` is an
 * array, `dependencies` an npm map.
 * @param dir - the profile directory.
 * @returns the declaration, or the reason there is none.
 */
export async function readDeclaredProfile(dir: string): Promise<{ readonly profile: DeclaredProfile } | { readonly error: string }> {
  let raw: string
  try {
    raw = await readFile(join(dir, 'package.json'), 'utf8')
  } catch (error: unknown) {
    return { error: `the profile manifest could not be read: ${describe(error)}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error: unknown) {
    return { error: `the profile manifest is not valid JSON: ${describe(error)}` }
  }
  if (parsed === null || typeof parsed !== 'object') return { error: 'the profile manifest is not an object' }
  const document = parsed as { dsh?: { profile?: { bundles?: unknown } }, dependencies?: unknown }
  const bundles = nameList(document.dsh?.profile?.bundles, 'dsh.profile.bundles')
  if ('error' in bundles) return bundles
  const dependencies = dependencyNames(document.dependencies)
  if ('error' in dependencies) return dependencies
  const carriesBundles = document.dsh?.profile?.bundles !== undefined
  const carriesDependencies = document.dependencies !== undefined
  return {
    profile: {
      bundles: carriesBundles ? bundles.names : undefined,
      dependencies: carriesDependencies ? dependencies.names : undefined,
    },
  }
}

/**
 * Read the declared bundle list from the profile manifest.
 *
 * A missing `dsh.profile.bundles` is an empty declaration — a profile is allowed
 * to name no bundles — while an unreadable or malformed manifest is reported as
 * an error, because "declared nothing" and "could not be read" lead to opposite
 * conclusions and must not render the same.
 * @param dir - the profile directory.
 * @returns the declaration, or the reason there is none.
 */
export async function readDeclaredBundles(
  dir: string,
): Promise<{ readonly bundles: readonly string[] } | { readonly error: string }> {
  const read = await readDeclaredProfile(dir)
  if ('error' in read) return read
  return { bundles: read.profile.bundles ?? [] }
}

/**
 * The default reason reader: the launcher's own profile loader, imported late.
 *
 * Read as a package rather than as an internal path, because the two-anchor
 * runtime resolution is what makes the installation's copy reachable from inside
 * a profile. Every failure — absence, a missing peer, a renamed export, a profile
 * without the list — is thrown for the caller to record, never swallowed here:
 * the caller is the one that knows the finding stands without a reason.
 * @param dir - the profile directory.
 * @param installAnchor - the package-manager anchor the launcher supplied.
 * @returns the skipped bundles, with the launcher's own reason for each.
 */
export async function readSkippedBundles(dir: string, installAnchor: string): Promise<readonly StoppedBundle[]> {
  // A computed specifier on purpose: this package is not a dependency of the
  // doctor, so the import must neither be resolved at build time nor declared as
  // one. It is attempted at runtime, in the one situation where it can succeed.
  const specifier = APP_BOOT
  const module = (await import(specifier)) as { loadProfileDirectory?: unknown }
  const load = module.loadProfileDirectory
  if (typeof load !== 'function') {
    throw new TypeError(`${APP_BOOT} does not export loadProfileDirectory`)
  }
  const profile = (load as (bin: string, dir: string, anchor: string, options: { userLayer: boolean }) => unknown)(
    'dsh', dir, installAnchor, { userLayer: false },
  )
  const skipped = (profile as { skippedBundles?: unknown } | null | undefined)?.skippedBundles
  if (!Array.isArray(skipped)) throw new TypeError('the loaded profile carries no skippedBundles list')
  return skipped.map((row: unknown) => {
    const entry = (row ?? {}) as { packageName?: unknown, reason?: unknown }
    return {
      packageName: typeof entry.packageName === 'string' ? entry.packageName : '(unnamed bundle)',
      reason: typeof entry.reason === 'string' ? entry.reason : undefined,
    }
  })
}

/**
 * Audit the profile composition of this process.
 *
 * The declaration is diffed against `startedBundles`, and the launcher's reader
 * is consulted **only when the diff is non-empty**: in the healthy case nothing
 * is imported and nothing is written, which is the case that runs on every start.
 *
 * The installed-selection arm runs from the same parse and is gated by
 * `options.installed`: it resolves and reads one manifest per dependency the
 * profile did not select, which is work a deployment that wants only the entry
 * sweep should not pay for. It is skipped too when the manifest could not be read
 * — there is no list to compare against, and that failure is already on
 * `declaredError` rather than a claim of health here.
 * @param ctx - the plugin context.
 * @param readReasons - the reason reader; the seam a test drives, defaulting to
 *   {@link readSkippedBundles}.
 * @param options - the arms to run.
 * @returns the audit, or `undefined` when this process is not a dsh profile.
 */
export async function auditComposition(
  ctx: { get(name: string): unknown },
  readReasons: ReasonReader = readSkippedBundles,
  options: { readonly installed?: boolean } = {},
): Promise<CompositionAudit | undefined> {
  const facts = profileFactsOf(ctx)
  if (facts === undefined) return undefined

  const read = await readDeclaredProfile(facts.dir)
  const declared = 'profile' in read ? (read.profile.bundles ?? []) : undefined
  const declaredError = 'error' in read ? read.error : undefined

  const started = new Set(facts.startedBundles)
  const missingNames = declared === undefined ? [] : declared.filter(name => !started.has(name))

  let reasons: CompositionAudit['reasons'] = 'unavailable'
  let reasonsError: string | undefined
  let byName = new Map<string, string | undefined>()
  if (missingNames.length > 0) {
    if (facts.installAnchor === '') {
      reasonsError = 'the launcher supplied no install anchor, so its profile loader cannot be addressed'
    } else {
      try {
        const rows = await readReasons(facts.dir, facts.installAnchor)
        reasons = 'dsh-app-boot'
        byName = new Map(rows.map(row => [row.packageName, row.reason]))
      } catch (error: unknown) {
        reasonsError = describe(error)
      }
    }
  }

  // Only when both lists are known: with an unreadable manifest there is nothing
  // to compare, and reporting "no unselected packages" from an empty pair of lists
  // would be a claim this audit is not entitled to make.
  let installed: InstalledAudit | undefined
  if ('profile' in read && (options.installed ?? true)) {
    installed = await auditInstalledSelection({
      dir: facts.dir,
      installAnchor: facts.installAnchor,
      dependencies: read.profile.dependencies ?? [],
      bundles: read.profile.bundles ?? [],
    })
  }

  return {
    profile: facts.name,
    dir: facts.dir,
    declared,
    declaredError,
    started: facts.startedBundles,
    missing: missingNames.map(packageName => ({ packageName, reason: byName.get(packageName) })),
    reasons,
    reasonsError,
    installed,
  }
}

/**
 * The stopped bundles of an audit, in declaration order.
 *
 * The one accessor every consumer shares, so the summary line, the report and the
 * on-demand query can never disagree about what counts as a finding.
 * @param audit - a composition audit, when one was made.
 * @returns the stopped bundles.
 */
export function stoppedBundles(audit: CompositionAudit | undefined): readonly StoppedBundle[] {
  return audit?.missing ?? []
}
