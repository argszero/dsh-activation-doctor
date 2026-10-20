/**
 * The census: who switched this row off, the operator or the launcher?
 *
 * `classifyEntry` reports a `disabled` entry and its docblock says why — "a
 * disabled entry is excluded because it is a decision the operator made". That
 * sentence is false for one class of row, and it is the class an operator cannot
 * see any other way.
 *
 * `prepareProfileEntries` (`packages/boot/app-boot/src/compatibility-preflight.ts`)
 * denies a row by setting `row.disabled = true` on a clone of the profile's entry
 * list before the loader is ever handed it. Three facts about that denial decide
 * this module's whole shape:
 *
 * 1. **On the only surface a plugin can read, it is indistinguishable from a
 *    decision.** The denial *is* `disabled: true` — there is no second flag, no
 *    annotation, and no record of what the declaration said beforehand. The flag
 *    is the decision and the refusal alike.
 * 2. **Its reason goes to stderr and nowhere else** — one `process.stderr.write`
 *    per denied row, at composition time, before any plugin owns a logger. The
 *    desktop shell drains that into a 64 KiB buffer that is attached to an error
 *    message only on *exit*, so while the application runs the reason exists
 *    nowhere an operator can look.
 * 3. **The preflight's own `catch` makes the second one worse.** Any throw from
 *    reading the row's manifest is rewritten as *"its declared dsh requirements
 *    cannot be validated: <detail>"*, which reads like a version-range question
 *    and is nothing of the kind. The case that reported it (discussion #10203) is
 *    a `--patch` row with **no `name` field at all**: `manifestOf` opens with
 *    `name.startsWith('cordis:')`, so `undefined` throws
 *    `Cannot read properties of undefined (reading 'startsWith')`, the catch
 *    turns that into the sentence above, and `deny()` switches the row off. The
 *    patch file looks correct, `--dump-config` renders the patch layer without
 *    ever calling the preflight (`apps/cli/src/dump-config.ts`), and the plugin is
 *    simply not there. That declaration/loader split is structural rather than a
 *    bug in the dump.
 *
 * ## What this census can and cannot decide
 *
 * `preflight` skips a row that is **already** disabled (`row.disabled === true &&
 * !row.group` → `continue`), so it never denies one. Everything it switched off
 * was enabled before it ran. The census therefore says exactly one thing, and
 * says only that: **what the launcher's rule makes of this row's own
 * declaration.** For a row with no `name` the answer is structural, needs no
 * dependency and cannot be argued with — that row cannot be mounted, enabled or
 * not. For every other row the answer is the launcher's verdict, recomputed on
 * the manifest the row names, through the launcher's own
 * `evaluatePluginCompatibility` and with the profile's own exemptions: a
 * *recompute*, reported as "the preflight refuses this row", never as "the
 * preflight denied this row", because the two differ for exactly one row — the
 * one the operator disabled *and* that is incompatible — and there the sentence
 * that helps is the one saying re-enabling it will not work either.
 *
 * ## Why the recompute is a port rather than a call
 *
 * The one entry point that runs the whole decision, `prepareProfileEntries`,
 * returns the rows with denials applied and reports the reason **only** through a
 * stderr write, which a diagnostic must not intercept: the reason is the thing
 * this module exists to recover, so hooking `process.stderr.write` to read it
 * back is a much larger sin than reproducing the lookup. `manifestOf` is not
 * exported either, so the resolution below mirrors its order — `cordis:`
 * builtin, then the `pluginPackages` service, then Node's own search paths from
 * the installation anchor and the profile — and everything it cannot reproduce
 * (a `#` resource, a path that needs the tree's own base URL) is reported as
 * **coverage**, never as "the operator did it" and never as a finding. That is
 * the same rule `installed.ts` follows: an audit that cannot answer must not
 * answer "healthy".
 *
 * The one caveat worth stating in the report: the preflight rewrites clones in
 * place and keeps no copy of the original declaration, so this is recompute-only.
 * It cannot diff the patch row against the loader's entry, and it cannot tell a
 * row that was denied from an identical row an operator switched off by hand.
 *
 * @module @argszero/dsh-activation-doctor/denial
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EntryLike } from './audit.ts'
import { APP_BOOT, profileFactsOf } from './composition.ts'
import { searchPathsFor } from './installed.ts'

/**
 * The plain sentence for a row the preflight cannot read a name off.
 *
 * Written in the doctor's own words rather than the preflight's: the line the
 * launcher printed says its *declared dsh requirements* could not be validated,
 * and that sentence names neither the row's problem nor the code that threw.
 */
export const NO_NAME_REASON = 'this row declares no `name`, so the compatibility preflight threw before it could read a manifest and switched the row off; the single line it printed says only that the row\'s declared dsh requirements cannot be validated'

/** Why a row's declaration could not be recomputed at all. */
export const UNRESOLVED_REASON = 'this row\'s manifest could not be resolved from the anchors the loader uses, so the launcher\'s opinion cannot be recomputed'

/** One unmet-requirement verdict, as the launcher returns it. */
export interface CompatibilityIssue {
  /** The plugin's own name, from its manifest. */
  readonly name: string
  /** The plugin's own version. */
  readonly version: string
  /** The requirements the running dsh version does not satisfy. */
  readonly requirements: Readonly<Record<string, string>>
  /** Whether this profile granted an exact-version exemption. */
  readonly exempted: boolean
}

/** The launcher's compatibility rule, bound to one profile's exemptions. */
export interface CompatibilityRule {
  /** The launcher's own evaluation: unmet requirements, or `undefined` when compatible. */
  evaluate(manifest: object): CompatibilityIssue | undefined
  /** The launcher's own warning text for an unmet requirement. */
  warn(issue: CompatibilityIssue): string
}

/** Read the launcher's rule for one profile; the seam a test drives. */
export type RuleReader = (dir: string) => Promise<CompatibilityRule>

/** What the census concluded about one switched-off row. */
export type DenialVerdict =
  /** The launcher's rule refuses this row's declaration, so it would not mount if enabled. */
  | { readonly kind: 'denied', readonly reason: string, readonly detail: string | undefined }
  /** Nothing in the declaration gives the preflight a reason to refuse it. */
  | { readonly kind: 'clear' }
  /** The census could not recompute the verdict, and says so instead of guessing. */
  | { readonly kind: 'unchecked', readonly reason: string }

/** One switched-off entry and the census's verdict on it. */
export interface DenialCheck {
  /** The loader entry id, which is what a profile or patch row names. */
  readonly id: string
  /** The module specifier the entry imports; `(no name)` when it declares none. */
  readonly name: string
  /** The verdict. */
  readonly verdict: DenialVerdict
}

/** Where the compatibility verdicts came from. */
export type RuleSource =
  /** The launcher's own rule, imported at runtime. */
  | 'dsh-app-boot'
  /** No row needed the rule, so it was never imported. */
  | 'not-needed'
  /** The rule could not be reached, so the verdicts that needed it are coverage gaps. */
  | 'unavailable'

/** The census: every switched-off entry, and which of them the launcher refuses. */
export interface DenialCensus {
  /** How many switched-off entries were examined. */
  readonly inspected: number
  /** Rows the launcher's rule refuses. */
  readonly denied: readonly DenialCheck[]
  /**
   * Rows whose verdict could not be recomputed.
   *
   * Coverage, not a finding: a row the census cannot resolve is one it cannot
   * classify, and turning that into a finding would report the audit's own blind
   * spot as the profile's defect.
   */
  readonly unchecked: readonly DenialCheck[]
  /** Which rule produced the verdicts. */
  readonly rule: RuleSource
  /** Why the rule could not be read, when it could not. */
  readonly ruleError: string | undefined
}

/** What one census run may assume about the process it is describing. */
export interface CensusOptions {
  /** The profile directory; defaults to the launcher's `profileContext.dir`. */
  readonly dir?: string
  /** The launcher's package-manager anchor; defaults to the profile's own. */
  readonly installAnchor?: string
  /** The rule reader; the seam a test drives. */
  readonly readRule?: RuleReader
}

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

/** Read a service without letting a throwing lookup take the census down. */
function serviceOf(ctx: { get(name: string): unknown }, name: string): unknown {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/**
 * Whether a specifier is a bare package name.
 *
 * The same distinction the launcher's resolution makes before it decides between
 * a package lookup and a path: a relative path, an absolute path, a URL and a `#`
 * resource are not package names. Only a bare name can be safely reported as
 * "no manifest, so the preflight has no opinion" — for anything else this module
 * cannot follow the lookup, and says so rather than answering `clear`.
 * @param name - a loader entry's `name`.
 * @returns whether it names a package.
 */
export function isBareSpecifier(name: string): boolean {
  // A blank specifier names nothing; it is not a package either.
  if (name.trim() === '') return false
  if (name.startsWith('.') || name.startsWith('/') || name.startsWith('#') || name.startsWith('file:')) return false
  // Any other scheme (`node:`, `data:`, ...) is a URL, not a package.
  if (/^[A-Za-z][A-Za-z\d+.-]*:/u.test(name)) return false
  // Windows absolute paths are not package names either.
  if (name.startsWith('\\\\') || /^[A-Za-z]:[\\/]/u.test(name)) return false
  return true
}

/** The default rule reader: the launcher's own evaluation, imported late. */
async function readCompatibilityRule(dir: string): Promise<CompatibilityRule> {
  // A computed specifier on purpose: this package is not a dependency of the
  // doctor, so the import must be resolved at runtime and never declared.
  const specifier = APP_BOOT
  const module = (await import(specifier)) as {
    evaluatePluginCompatibility?: unknown
    pluginCompatibilityWarning?: unknown
    readProfileCompatibility?: unknown
  }
  const evaluate = module.evaluatePluginCompatibility
  const warn = module.pluginCompatibilityWarning
  if (typeof evaluate !== 'function') throw new TypeError(`${APP_BOOT} does not export evaluatePluginCompatibility`)
  if (typeof warn !== 'function') throw new TypeError(`${APP_BOOT} does not export pluginCompatibilityWarning`)

  // The profile's own grants, read through the launcher's reader: a plugin the
  // operator explicitly allowed must not be reported as refused. The reader
  // authorizes nothing for a missing or damaged file, which is the same answer
  // this module wants for a process with no profile.
  let exemptions: Readonly<Record<string, readonly string[]>> = {}
  const read = dir === '' ? undefined : module.readProfileCompatibility
  if (typeof read === 'function') {
    try {
      const record = (read as (profileDir: string) => { exemptions?: unknown })(dir)
      const value = record?.exemptions
      if (value !== null && typeof value === 'object') exemptions = value as Record<string, readonly string[]>
    } catch {
      // A grant this module cannot read is a grant it cannot honour; the verdict
      // falls back to "no exemptions", which is the reader's own answer for a
      // damaged file.
    }
  }
  return {
    evaluate: manifest => (evaluate as (m: object, e: unknown) => CompatibilityIssue | undefined)(manifest, exemptions),
    warn: issue => (warn as (i: CompatibilityIssue) => string)(issue),
  }
}

/** What a row's declaration turned out to be. */
type ManifestRead =
  /** A parsed manifest the rule can be run against. */
  | { readonly kind: 'manifest', readonly manifest: object }
  /** The declaration resolves to no manifest, so the preflight has no opinion. */
  | { readonly kind: 'absent' }
  /** The manifest exists but cannot be read — the preflight's own `catch`. */
  | { readonly kind: 'unreadable', readonly detail: string }
  /** This module cannot reproduce the launcher's lookup for this specifier. */
  | { readonly kind: 'unresolved' }

/**
 * Read one `package.json`, the way `manifestOf`'s `readManifest` does.
 *
 * A parse failure is *unreadable* rather than absent, because that is where the
 * preflight's exception comes from: it reads the file inside the `try`, so a
 * malformed manifest refuses the row exactly as a missing name does.
 * @param path - the manifest path.
 * @returns the parse result.
 */
async function readManifestFile(path: string): Promise<ManifestRead> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error: unknown) {
    return { kind: 'unreadable', detail: `${path}: ${describe(error)}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error: unknown) {
    return { kind: 'unreadable', detail: `${path}: ${describe(error)}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'unreadable', detail: `${path}: the manifest is not a JSON object` }
  }
  return { kind: 'manifest', manifest: parsed as object }
}

/**
 * Resolve a row's manifest, mirroring `manifestOf`'s order.
 *
 * The base URL the preflight passes is the *tree's* own, which no public surface
 * the doctor reads exposes; the profile's `package.json` URL is used instead and
 * is the nearest honest stand-in, since that is the file a profile row is
 * resolved from. Where the substitution could change the answer the result is
 * `unresolved`, never `absent`: a guess about the doctor's own location must not
 * be reported as the launcher having no opinion.
 * @param name - the entry's module specifier.
 * @param ctx - the plugin context, for the launcher's package service.
 * @param dir - the profile directory, or `''` when there is no profile.
 * @param installAnchor - the launcher's package-manager anchor, or `''`.
 * @returns what the declaration resolved to.
 */
export async function resolveManifest(
  name: string,
  ctx: { get(name: string): unknown },
  dir: string,
  installAnchor: string,
): Promise<ManifestRead> {
  // The launcher's own first statement, in its own order.
  if (name.startsWith('cordis:')) return { kind: 'absent' }
  // A `#` resource is resolved by app-boot against the tree's parent URL.
  if (name.startsWith('#')) return { kind: 'unresolved' }

  const packages = serviceOf(ctx, 'pluginPackages') as { packageOf?: unknown } | undefined
  const packageOf = packages?.packageOf
  const base = dir === '' ? '' : pathToFileURL(join(dir, 'package.json')).href
  if (typeof packageOf === 'function' && base !== '') {
    let mapping: unknown
    try {
      mapping = (packageOf as (specifier: string, parentURL: string) => unknown).call(packages, name, base)
    } catch (error: unknown) {
      return { kind: 'unreadable', detail: describe(error) }
    }
    if (mapping === undefined || mapping === null) {
      // The preflight would fall through to its path branch; for a bare name that
      // branch answers `undefined` too, so "no opinion" is the faithful reading.
      return isBareSpecifier(name) ? { kind: 'absent' } : { kind: 'unresolved' }
    }
    const manifestPath = (mapping as { manifestPath?: unknown }).manifestPath
    if (typeof manifestPath !== 'string' || manifestPath === '') {
      // The preflight would hand this straight to its file reader, which throws.
      return { kind: 'unreadable', detail: 'the launcher\'s package mapping carries no manifest path' }
    }
    return readManifestFile(manifestPath)
  }

  // No package service: the launcher falls back to Node's own lookup, so this
  // does too — the installation anchor first, then the profile. That order is
  // the harness's contract, not a preference; `installed.ts` reads it the same way.
  for (const anchor of [installAnchor, dir === '' ? '' : join(dir, 'package.json')]) {
    for (const searchPath of searchPathsFor(anchor, name)) {
      const candidate = join(searchPath, name, 'package.json')
      if (existsSync(candidate)) return readManifestFile(candidate)
    }
  }
  return isBareSpecifier(name) ? { kind: 'absent' } : { kind: 'unresolved' }
}

/** The rule, read once per census and only if a row needs it. */
export type RuleState =
  | { readonly kind: 'rule', readonly rule: CompatibilityRule }
  | { readonly kind: 'unavailable', readonly error: string }

/** What one row's verdict needs. */
export interface VerdictContext {
  readonly ctx: { get(name: string): unknown }
  readonly dir: string
  readonly installAnchor: string
  readonly ruleOnce: () => Promise<RuleState>
}

/**
 * The census's verdict on one switched-off row.
 *
 * The order is the preflight's order, so a row is attributed to the same code
 * that would have refused it: no readable name first (structural, needs no
 * dependency), then an unreadable manifest, then the compatibility rule.
 * @param name - the entry's `name`, deliberately untyped: the row that has none
 *   is the finding.
 * @param at - the context the verdict is computed in.
 * @returns the verdict.
 */
export async function verdictOf(name: unknown, at: VerdictContext): Promise<DenialVerdict> {
  if (typeof name !== 'string' || name.trim() === '') {
    return { kind: 'denied', reason: NO_NAME_REASON, detail: undefined }
  }
  const read = await resolveManifest(name, at.ctx, at.dir, at.installAnchor)
  if (read.kind === 'absent') return { kind: 'clear' }
  if (read.kind === 'unresolved') return { kind: 'unchecked', reason: UNRESOLVED_REASON }
  if (read.kind === 'unreadable') {
    return {
      kind: 'denied',
      reason: 'its manifest could not be read, so the preflight refuses the row',
      detail: read.detail,
    }
  }
  const state = await at.ruleOnce()
  if (state.kind === 'unavailable') {
    return { kind: 'unchecked', reason: `the launcher's compatibility rule could not be reached: ${state.error}` }
  }
  try {
    const issue = state.rule.evaluate(read.manifest)
    if (issue === undefined || issue.exempted === true) return { kind: 'clear' }
    return { kind: 'denied', reason: state.rule.warn(issue), detail: undefined }
  } catch (error: unknown) {
    // The preflight's own `catch`, word for word: a requirement it cannot even
    // evaluate is refused rather than admitted.
    return { kind: 'denied', reason: 'its declared dsh requirements cannot be validated', detail: describe(error) }
  }
}

/**
 * Census every switched-off entry in a loader tree.
 *
 * `undefined` when nothing is switched off: there is then no denial to attribute
 * and no coverage to disclose, and an arm that reported "0 of 0" would be a claim
 * about a question nobody asked. Disabled rows only — everything else is the
 * entry sweep's business, and this module must not duplicate its verdicts.
 * @param ctx - the plugin context.
 * @param entries - the loader's entries, this tree and every subtree.
 * @param options - the profile facts to use, and the rule reader a test drives.
 * @returns the census, or `undefined` when no entry is disabled.
 */
export async function censusDenials(
  ctx: { get(name: string): unknown },
  entries: Iterable<EntryLike>,
  options: CensusOptions = {},
): Promise<DenialCensus | undefined> {
  const facts = options.dir === undefined || options.installAnchor === undefined
    ? profileFactsOf(ctx)
    : undefined
  const dir = options.dir ?? facts?.dir ?? ''
  const installAnchor = options.installAnchor ?? facts?.installAnchor ?? ''
  const readRule = options.readRule ?? readCompatibilityRule

  const rows: { readonly id: string, readonly name: unknown }[] = []
  for (const entry of entries) {
    let disabled: unknown
    try {
      disabled = entry.disabled
    } catch {
      // A throwing `disabled` expression is already reported by the entry sweep,
      // as a failed entry with its own error. It is not a denial to attribute.
      continue
    }
    if (disabled !== true) continue
    const fields = (entry.options ?? {}) as { id?: unknown, name?: unknown }
    rows.push({ id: typeof fields.id === 'string' && fields.id !== '' ? fields.id : '(no id)', name: fields.name })
  }
  if (rows.length === 0) return undefined

  let ruleState: RuleState | undefined
  const ruleOnce = async (): Promise<RuleState> => {
    if (ruleState === undefined) {
      try {
        ruleState = { kind: 'rule', rule: await readRule(dir) }
      } catch (error: unknown) {
        ruleState = { kind: 'unavailable', error: describe(error) }
      }
    }
    return ruleState
  }

  const denied: DenialCheck[] = []
  const unchecked: DenialCheck[] = []
  for (const row of rows) {
    const name = typeof row.name === 'string' && row.name !== '' ? row.name : '(no name)'
    const verdict = await verdictOf(row.name, { ctx, dir, installAnchor, ruleOnce })
    const check: DenialCheck = { id: row.id, name, verdict }
    if (verdict.kind === 'denied') denied.push(check)
    else if (verdict.kind === 'unchecked') unchecked.push(check)
  }

  const source: RuleSource = ruleState === undefined
    ? 'not-needed'
    : ruleState.kind === 'rule' ? 'dsh-app-boot' : 'unavailable'
  return {
    inspected: rows.length,
    denied,
    unchecked,
    rule: source,
    ruleError: ruleState !== undefined && ruleState.kind === 'unavailable' ? ruleState.error : undefined,
  }
}

/**
 * The rows the launcher's rule refuses, in tree order.
 *
 * The one accessor every consumer shares, so the summary line, the durable report
 * and the on-demand query can never disagree about what counts as a finding.
 * @param census - a census, when one was made.
 * @returns the refused rows.
 */
export function deniedRows(census: DenialCensus | undefined): readonly DenialCheck[] {
  return census?.denied ?? []
}
