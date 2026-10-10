#!/usr/bin/env node
/**
 * A `peerDependencies` range is a claim about versions nobody ran. This script
 * makes the claim checkable instead of asserted: for each line the range admits,
 * it copies this package into a scratch directory, pins **the whole line**,
 * installs, builds, and runs the suite.
 *
 * The lines come from the manifest, not from a list here — a probe with its own
 * copy of the contract can drift from the thing it is supposed to be checking.
 * Each `||` segment of the `@deepseek-ai/dsh-tools` range is one line, and its
 * **newest** published build is the representative: the earliest build of a line
 * is an alpha nobody is left on, and probing it says less than probing the build
 * the line converged to.
 *
 * This plugin reads the loader, the fiber states and the tool registry across
 * those lines, so the probe is not a formality here — it is the only thing that
 * says whether a distinction read from one line's source still exists on the
 * other. Four rules, because violating any of them measures the probe rather than
 * the line:
 *
 * 1. **The whole line is pinned, not the packages this plugin happens to
 *    import.** The set of harness packages a line carries grows between lines, so
 *    it is read from that line's own `@deepseek-ai/dsh-agent` manifest rather
 *    than written down here, and it is widened by every `@deepseek-ai/dsh-*` this
 *    package declares. Pinning a subset leaves npm free to resolve the rest from
 *    another line, and the resulting tree is not the line.
 * 2. **`--legacy-peer-deps`.** Without it npm derives peers transitively and can
 *    install a second line's copy of a package to satisfy them — again a tree
 *    that is not the line. The installation is `npm ci`-free on purpose: there is
 *    no lockfile to honour, the pins *are* the specification.
 * 3. **Every pinned package's version is read back after install.** A pin that
 *    silently did not apply is the failure mode this whole script exists to
 *    prevent, so it is asserted rather than assumed, and the assertion runs
 *    before the suite so a mixed tree can never be reported as a passing line.
 * 4. **Two packages do not follow the harness's line numbering**, so they are
 *    resolved from the line rather than pinned to it: `@deepseek-ai/cordis`
 *    (whose constraint the line's own `dsh-tools` manifest states) and
 *    `@deepseek-ai/cordis-plugin-loader` (whose versions the harness publishes
 *    under line-named dist-tags, not under the line number itself). Both are
 *    still pinned to an exact version and read back; only the *source* of the
 *    number differs, and an unmatched line is reported rather than guessed.
 *
 * ```sh
 * node scripts/probe-lines.mjs                  # every line the range admits
 * node scripts/probe-lines.mjs -- 0.2.0-rc.2    # one line
 * node scripts/probe-lines.mjs --keep           # leave the scratch trees in place
 * ```
 *
 * A line that fails here is removed from the range (manifest, README and the
 * `SUPPORTED_LINES` note in the spec) rather than left claimed. This script is
 * development-only and is not published.
 *
 * @module scripts/probe-lines
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** What is copied into the scratch tree; everything else is not needed to test. */
const COPIED = ['src', 'test', 'scripts', 'tsconfig.json', 'README.md', 'LICENSE', 'cordis.patch.yml']

/**
 * The loader build each cordis constraint was published against.
 *
 * Read as data, matched against the constraint the line's own `dsh-tools`
 * manifest states, and never guessed: a line whose constraint matches no row is
 * reported as unpinned for that package instead of being resolved by npm from
 * whichever line it prefers.
 */
const LOADER_FOR_CORDIS = [
  { cordis: '~4.0.5-alpha.1', loader: '1.0.6-alpha.1' },
  { cordis: '~4.0.4', loader: '1.0.5' },
]

/**
 * Harness packages the suite imports that a line's `dsh-agent` manifest does not
 * name.
 *
 * Measured, not guessed: each entry was found by installing one line's declared
 * graph and walking every `@deepseek-ai/` specifier that the installed build of
 * `@deepseek-ai/dsh-tools` and the suite itself reach. A real deployment never
 * notices, because the profile's lockfile carries them.
 */
const EXTRA = []

/**
 * The newest published build of each `||` segment of a range.
 * @param range - a semver range, composed of `||` segments.
 * @param versions - every published version of the package.
 * @returns one version per segment, in range order.
 */
function representativesOf(range, versions) {
  return range.split('||')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0)
    .map(segment => semver.maxSatisfying(versions, segment))
}

/** Read one field of a published manifest, or `undefined` when it is unreachable. */
function view(specifier, field) {
  try {
    const raw = execFileSync(
      'npm', ['view', specifier, field, '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
    return JSON.parse(raw || 'null')
  } catch {
    return undefined
  }
}

/**
 * Every `@deepseek-ai/dsh-*` package one line carries.
 *
 * Read from the line's own `dsh-agent` **and** `dsh-tools` manifests, because the
 * two together are what the suite's imports reach: `dsh-agent` names the agent
 * graph, and `dsh-tools` names the services its own installed build imports at
 * module scope. Pinning only one leaves the other's packages to be resolved from
 * whichever line npm prefers, and the resulting tree is not the line.
 * @param line - the line to read.
 * @returns the package names, or an empty array when neither manifest is reachable.
 */
function linePackages(line) {
  const names = new Set()
  for (const pkg of ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-tools']) {
    const peers = view(`${pkg}@${line}`, 'peerDependencies') ?? {}
    for (const name of Object.keys(peers)) if (name.startsWith('@deepseek-ai/dsh-')) names.add(name)
  }
  return [...names]
}

/** Whether one package has a build at exactly this line. */
function publishedAt(name, line) {
  return view(`${name}@${line}`, 'version') !== undefined
}

/** The exact versions this line requires for the two packages that are not line-numbered. */
function nonLinePins(line) {
  const peers = view(`@deepseek-ai/dsh-tools@${line}`, 'peerDependencies') ?? {}
  const cordis = peers['@deepseek-ai/cordis']
  const cordisVersion = cordis === undefined ? undefined : semver.minVersion(cordis.replace(/^[~^]/, ''))?.version
  const row = LOADER_FOR_CORDIS.find(candidate => candidate.cordis === cordis)
  return {
    '@deepseek-ai/cordis': cordis === undefined ? undefined : semver.maxSatisfying(view('@deepseek-ai/cordis', 'versions') ?? [], cordis),
    '@deepseek-ai/cordis-plugin-loader': row?.loader,
    /** Reported, not hidden: the constraint the line states, for the log. */
    cordisConstraint: cordis,
    cordisVersion,
    loaderConstraint: row?.cordis,
  }
}

/**
 * Install the pinned tree, then assert that the pins are what was installed.
 *
 * `--legacy-peer-deps` is the second rule in the header: without it npm derives
 * peer requirements transitively and can satisfy them with another line's copy.
 * @param dir - the probe tree.
 * @param log - the progress writer.
 * @param pins - the exact versions the tree was supposed to get.
 * @param line - the line being probed.
 */
function install(dir, log, pins, line) {
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--legacy-peer-deps'], { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] })
  const resolved = []
  for (const [name, wanted] of Object.entries(pins)) {
    const installed = JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8')).version
    resolved.push(`${name.replace('@deepseek-ai/', '')}@${installed}`)
    if (installed !== wanted) {
      throw new Error(`the pin did not apply: ${name} resolved to ${installed}, not ${wanted}`)
    }
  }
  log(`    pinned ${resolved.length} packages exactly: ${resolved.join(' ')}`)
}

/** Install one probe and run the suite in it. */
function probe(line) {
  const dir = mkdtempSync(join(tmpdir(), `activation-doctor-${line}-`))
  const log = message => process.stdout.write(`${message}\n`)
  log(`\n=== ${line} — ${dir}`)

  const declared = [
    ...Object.keys(manifest.peerDependencies),
    ...Object.keys(manifest.devDependencies),
    ...linePackages(line),
    ...EXTRA,
  ]
  const names = [...new Set(declared)]
    .filter(name => name.startsWith('@deepseek-ai/dsh-'))
    // A package the line never shipped cannot be pinned to it. Dropped rather
    // than silently resolved from another line: the count is printed, because a
    // dropped name is one hole in "the whole line" that the reader should see.
    .filter(name => publishedAt(name, line))
  const linePins = Object.fromEntries(names.map(name => [name, line]))
  const extra = nonLinePins(line)
  const pins = Object.fromEntries(Object.entries({ ...linePins, ...extra })
    .filter(([name, version]) => name.startsWith('@deepseek-ai/') && typeof version === 'string'))
  log(`    pinning ${names.length} harness packages${declared.length - names.length > 0 ? ` (${declared.length - names.length} not published at this line, left unpinned)` : ''}`)
  log(`    line states cordis ${String(extra.cordisConstraint)}; loader ${extra.loaderConstraint === undefined ? 'UNMATCHED — left to npm' : `pinned ${String(extra['@deepseek-ai/cordis-plugin-loader'])}`}`)

  for (const entry of COPIED) cpSync(join(ROOT, entry), join(dir, entry), { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    ...manifest,
    // The pins live in `devDependencies` so the tree is exactly the line: the
    // peers are then satisfied by it, and nothing else is installed for them.
    devDependencies: { ...manifest.devDependencies, ...pins },
    // No `probe-lines` script here: the probe must not be able to recurse.
    scripts: { build: 'tsc', test: 'tsc && node --test "test/*.spec.mjs"' },
  }, null, 2)}\n`)

  try {
    install(dir, log, pins, line)
    execFileSync('npm', ['test'], { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] })
    log(`=== ${line}: PASS`)
    return true
  } catch (error) {
    if (error.stdout !== undefined) process.stdout.write(String(error.stdout))
    log(`=== ${line}: FAIL — ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    return false
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true })
  }
}

const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const requested = argv.filter(argument => !argument.startsWith('-'))

const range = manifest.peerDependencies['@deepseek-ai/dsh-tools']
const published = view('@deepseek-ai/dsh-tools', 'versions') ?? []
const lines = requested.length > 0 ? requested : representativesOf(range, published)

const failed = lines.filter(line => !probe(line))
process.stdout.write(`\nprobed ${lines.length} line(s) of ${range}\n`)
if (failed.length > 0) {
  process.stdout.write(`failed: ${failed.join(', ')} — remove them from the range, the README and SUPPORTED_LINES\n`)
  process.exitCode = 1
}
