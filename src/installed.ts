/**
 * The stage before the composition: did the profile ever *select* what it installed?
 *
 * The module beside this one answers "the profile named these bundles and this
 * process did not start from them". It reads two lists — `dsh.profile.bundles`
 * and the launcher's `startedBundles` — and its blind spot is structural: a
 * package that never entered `dsh.profile.bundles` is in **neither** list, so the
 * two agree, the composition looks healthy, and the package that was installed is
 * simply absent from the process. That is the state discussion #9261 reports:
 * `pnpm` completes, `dependencies` and `pnpm-lock.yaml` are written, the CLI never
 * returns, and the reconcile step that appends the package to
 * `dsh.profile.bundles` therefore never runs. The package is installed and never
 * selected, and nothing in the running application can say so, because the only
 * artifact of the loss is a list that the package is missing from.
 *
 * ## The invariant, taken from the harness rather than invented here
 *
 * `reconcile()` (`packages/boot/plugin-manager/src/operations.ts`) is the code
 * that appends: for every dependency the run just added it reads that package's
 * own manifest and, when the manifest declares `dsh.bundle`, pushes the name into
 * the bundle list. It skips the ones that declare no `dsh.bundle`, with the
 * warning *"declares no dsh.bundle — installed as a plain dependency, not a
 * profile layer"*. So the invariant this module checks is the harness's own:
 *
 *   a declared dependency whose manifest carries `dsh.bundle` must appear in
 *   `dsh.profile.bundles`
 *
 * and the qualifier is what keeps the check from being noise. **Most dependencies
 * are not bundles** — a profile's `dependencies` and its `dsh.profile.bundles`
 * are different lists on purpose, the shipped profiles start with an empty
 * dependency set and a bundle list resolved from the installation — so a check
 * built on "a dependency that is not in the bundle list" would report every
 * ordinary dependency and be switched off within a day. The bundle claim has to
 * come from the package itself, which is exactly where the harness reads it.
 *
 * `bundleManifest` is likewise the authority for what counts as a declaration, and
 * this module mirrors its test rather than approximating it: it is a bundle when
 * `dsh.bundle.patch` is defined (`manifest.dsh?.bundle?.patch === undefined` →
 * not a bundle, so `dsh: { bundle: {} }` is not one), and a `patch` that is
 * neither a string nor a list of strings is reported as a malformed declaration
 * rather than silently dropped.
 *
 * ## Resolution, mirrored from the loader
 *
 * A dependency is found the way `resolveBundleDir` finds a bundle: **the
 * installation anchor first, then the profile directory**, each through Node's own
 * resolution from that file. The order is the harness's contract — an in-box
 * bundle always comes from the same installation as the running `dsh`, never from
 * a profile-local copy — and mirroring it matters here because the two anchors
 * answer different questions: a package resolvable only from the installation is
 * an in-box dependency, one resolvable from the profile is the package `pnpm`
 * just wrote. Only `node:module` and `node:fs` are used; the resolution is a file
 * read, never an import, so this module loads no third-party code to describe one.
 *
 * ## What is *not* checked, and why that is deliberate
 *
 * The reverse direction — a name in `dsh.profile.bundles` that is not a dependency
 * — is not a finding. `@deepseek-ai/dsh-base` and every other shipped bundle are
 * runtime dependencies of the *installation*, not of the profile, so the reverse
 * gap is the normal shape of a healthy profile. A bundle that is selected but
 * cannot be loaded is the other module's arm: the launcher reports it in
 * `skippedBundles`, which is the authority for "declared and not started".
 *
 * @module @argszero/dsh-activation-doctor/installed
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'

/**
 * How many dependencies one audit inspects.
 *
 * A bound rather than a promise: an unbounded audit would read one manifest per
 * dependency at every start, and a profile is free to declare a large tree. The
 * remainder is reported as a count, so a truncated audit says so instead of
 * presenting partial coverage as complete.
 */
export const MAX_INSPECTED = 200

/** Where a resolved package was found. */
export type AnchorKind = 'installation' | 'profile'

/** A dependency this audit could not inspect, and why. */
export interface UninspectedDependency {
  /** The dependency name exactly as the profile manifest spells it. */
  readonly packageName: string
  /** Why it could not be inspected. */
  readonly reason: string
}

/** A dependency the profile installed and never selected as a bundle. */
export interface UnselectedPackage {
  /** The dependency name exactly as the profile manifest spells it. */
  readonly packageName: string
  /** The installed version, when the package declares one. */
  readonly version: string | undefined
  /** The declared `dsh.bundle.patch` files, as written. Empty for a malformed declaration. */
  readonly patches: readonly string[]
  /** Set when `dsh.bundle.patch` is present but is neither a path nor a list of paths. */
  readonly patchError: string | undefined
  /** Which anchor resolved it. */
  readonly from: AnchorKind
}

/** The selection answer: what was installed, what was selected, and the gap. */
export interface InstalledAudit {
  /** The profile's declared dependency names, in manifest order. */
  readonly dependencies: readonly string[]
  /** The bundles the profile selected. */
  readonly bundles: readonly string[]
  /** Dependencies that declare `dsh.bundle` and are absent from the bundle list. */
  readonly unselected: readonly UnselectedPackage[]
  /**
   * Dependencies that could not be inspected, so this audit cannot say whether
   * they declare `dsh.bundle`.
   *
   * Reported alongside the finding rather than folded into it: an unreadable
   * manifest is a gap in this audit's coverage, not a defect in the profile, and
   * turning it into a finding would make an incomplete audit look like a broken
   * installation. A run that inspects everything reports an empty list.
   */
  readonly uninspected: readonly UninspectedDependency[]
  /** Dependencies left uninspected by {@link MAX_INSPECTED}. */
  readonly truncated: number
}

/** What one package's own manifest says about being a bundle. */
export interface DependencyManifest {
  /** The package's version, when it declares one. */
  readonly version: string | undefined
  /** The declared patch files; `undefined` when the package declares no `dsh.bundle.patch`. */
  readonly patches: readonly string[] | undefined
  /** Set when the declaration exists but is malformed. */
  readonly patchError: string | undefined
}

/** Read one package's parsed `package.json`. */
export type PackageReader = (packageDir: string) => Promise<unknown>

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

/** The default reader: the package's own `package.json`, parsed. */
async function readPackageJson(packageDir: string): Promise<unknown> {
  return JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as unknown
}

/**
 * The Node search paths a specifier resolves through, from one anchor file.
 *
 * Split out and total: `createRequire` throws on an anchor that is not an absolute
 * path, and a launcher that supplied no anchor must produce "this cannot be
 * resolved" rather than an exception out of a diagnostic. A builtin specifier has
 * no search paths (`null`), which is likewise no answer rather than an error.
 * @param anchor - absolute path of a file inside the anchoring package.
 * @param packageName - the specifier to resolve.
 * @returns the search paths, or an empty list when there are none.
 */
export function searchPathsFor(anchor: string, packageName: string): readonly string[] {
  if (anchor === '' || !isAbsolute(anchor)) return []
  try {
    return createRequire(anchor).resolve.paths(packageName) ?? []
  } catch {
    return []
  }
}

/**
 * Resolve an installed package the way the loader resolves a bundle.
 *
 * The installation anchor is searched **first** and the profile directory second,
 * which is `resolveBundleDir`'s order rather than a preference of this module.
 * @param packageName - the dependency name.
 * @param dir - the profile directory.
 * @param installAnchor - absolute path of the dsh installation's `package.json`, or `''`.
 * @returns the package directory and which anchor found it, or `undefined`.
 */
export function packageDirFor(
  packageName: string,
  dir: string,
  installAnchor: string,
): { readonly dir: string, readonly from: AnchorKind } | undefined {
  const anchors: readonly (readonly [string, AnchorKind])[] = [
    [installAnchor, 'installation'],
    [join(dir, 'package.json'), 'profile'],
  ]
  for (const [anchor, from] of anchors) {
    for (const searchPath of searchPathsFor(anchor, packageName)) {
      const candidate = join(searchPath, packageName)
      try {
        if (existsSync(join(candidate, 'package.json'))) return { dir: candidate, from }
      } catch {
        // An unreadable search path is not an answer; the next one may be.
      }
    }
  }
  return undefined
}

/**
 * Read a package's own bundle claim, the way `bundleManifest` reads it.
 *
 * `dsh.bundle.patch` absent is "not a bundle" — the harness's own test, so a
 * package carrying `dsh: { bundle: {} }` is an ordinary dependency and reporting
 * it would be a false finding. Present but malformed is the opposite case: app-boot
 * throws on such a declaration while loading it, so the package *is* claiming to be
 * a bundle and the profile silently loses it. It is reported, with the reason.
 * @param manifest - the parsed `package.json`.
 * @returns the bundle claim.
 */
export function inspectManifest(manifest: unknown): DependencyManifest {
  const version = manifest !== null && typeof manifest === 'object'
    ? (manifest as { version?: unknown }).version
    : undefined
  const named = typeof version === 'string' && version !== '' ? version : undefined
  const bundle = manifest !== null && typeof manifest === 'object'
    ? (manifest as { dsh?: { bundle?: { patch?: unknown } } }).dsh?.bundle
    : undefined
  if (bundle === null || typeof bundle !== 'object') return { version: named, patches: undefined, patchError: undefined }
  const patch = (bundle as { patch?: unknown }).patch
  if (patch === undefined) return { version: named, patches: undefined, patchError: undefined }
  if (typeof patch === 'string') return { version: named, patches: [patch], patchError: undefined }
  if (Array.isArray(patch) && patch.every(file => typeof file === 'string')) {
    return { version: named, patches: patch as readonly string[], patchError: undefined }
  }
  return {
    version: named,
    patches: undefined,
    patchError: 'dsh.bundle.patch must be a file path or a list of file paths',
  }
}

/**
 * Audit the installed-but-not-selected gap for a profile.
 *
 * Only dependencies **absent from the bundle list** are resolved and read: a
 * selected package is a non-finding by definition, and skipping it keeps a healthy
 * profile's cost at one `Set` lookup per dependency instead of a manifest read.
 * @param input - the profile's directory, anchor, and the two lists it declares.
 * @param readPackage - the manifest reader; the seam a test drives.
 * @returns the audit.
 */
export async function auditInstalledSelection(
  input: {
    readonly dir: string
    readonly installAnchor: string
    readonly dependencies: readonly string[]
    readonly bundles: readonly string[]
  },
  readPackage: PackageReader = readPackageJson,
): Promise<InstalledAudit> {
  const selected = new Set(input.bundles)
  const unselected: UnselectedPackage[] = []
  const uninspected: UninspectedDependency[] = []
  let inspected = 0
  let truncated = 0
  for (const packageName of input.dependencies) {
    if (selected.has(packageName)) continue
    if (inspected >= MAX_INSPECTED) {
      truncated += 1
      continue
    }
    inspected += 1
    const found = packageDirFor(packageName, input.dir, input.installAnchor)
    if (found === undefined) {
      uninspected.push({
        packageName,
        reason: 'not resolvable from the dsh installation or the profile, so it may not be installed',
      })
      continue
    }
    let manifest: unknown
    try {
      manifest = await readPackage(found.dir)
    } catch (error: unknown) {
      uninspected.push({ packageName, reason: `its package.json could not be read: ${describe(error)}` })
      continue
    }
    const claim = inspectManifest(manifest)
    if (claim.patches === undefined && claim.patchError === undefined) continue
    unselected.push({
      packageName,
      version: claim.version,
      patches: claim.patches ?? [],
      patchError: claim.patchError,
      from: found.from,
    })
  }
  return {
    dependencies: input.dependencies,
    bundles: input.bundles,
    unselected,
    uninspected,
    truncated,
  }
}

/**
 * The unselected packages of a composition audit, in dependency order.
 *
 * The one accessor every consumer shares, so the summary line, the durable report
 * and the on-demand query can never disagree about what counts as a finding.
 * @param audit - a composition audit, when one was made.
 * @returns the unselected packages, or an empty list.
 */
export function unselectedPackages(
  audit: { readonly installed?: InstalledAudit | undefined } | undefined,
): readonly UnselectedPackage[] {
  return audit?.installed?.unselected ?? []
}
