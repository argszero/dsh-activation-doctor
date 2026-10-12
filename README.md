# @argszero/dsh-activation-doctor

Writes the activation report the harness already composes and never files.

When a plugin fails to activate — most often because a tool or prompt-section
name it registers is already taken — the fiber that threw is unloaded **whole**:
every tool and every prompt section that plugin contributed disappears, while the
marketplace still shows it installed and enabled. This plugin sweeps the loader's
entries after the tree settles, awaits each fiber to recover the original error
and stack, and files a private report where an operator will find it.

It is a **detector, not a repairer**. It does not revive the failed plugin, does
not change registration semantics, does not touch the marketplace row, and cannot
move the desktop shell's stderr. A plugin whose tool name collides still fails;
the difference is that you can now find out which two plugins, which name, and
from where.

## The problem

The reported incident
([#9308](https://github.com/deepseek-ai/deepseek-harness/discussions/9308)) is the
clean form of it. A third-party plugin registered a tool whose name was already
taken. `NamedEntries.insert` threw before any insertion, the error left the
plugin body, and the fiber unloaded — taking with it every tool and every prompt
section that plugin had contributed. The operator's search for a log found **zero
hits**.

Zero hits is the expected result, and the reason is structural rather than a bug
in logging. Three facts, each read from the shipped source:

1. **The failure *is* logged, into a sink nobody can read.** `Fiber._reload()`
   catches the plugin body's throw, calls `this.ctx.logger.error(reason)`, records
   the error, and unloads the fiber (`vendor/cordis/src/fiber.ts`). Neither
   shipped profile mounts a logger sink.
2. **Startup only *fails* for core entry ids.** `auditStartupEntries` marks an
   entry required only when its id is in the built-in set or it is the bootstrap
   include (`packages/boot/app-boot/src/index.ts`). A third-party id can never be
   in that set, so a third-party failure takes the `warn` branch: one line goes to
   `process.stderr`, and the rest of the application starts normally.
3. **The durable report is written only on that fatal path.**
   `reportStartupFailure` has exactly one caller — the `StartupError` handler in
   `apps/cli/src/bin.ts` — so `$DSH_HOME/logs/startup-*.log` is never created for a
   third-party-only failure. In the desktop build the stderr line is drained into a
   64 KiB in-memory buffer (`apps/desktop/src/host-process.ts`) that is attached to
   an error message only on **exit**.

So the missing piece is not a fix to the loader, the registry or the audit policy
— it is a **sink**. The state a report needs is already public: the loader exposes
its entries (`ctx.loader.entries()`), every entry carries its fiber, and
`fiber.await()` rethrows the original activation error with its stack.

## The stage before the entries

An entry that failed is still an entry. It has an id, a name and a fiber, which is
why it can be reported at all. The strictly larger loss is the one shape the entry
sweep cannot see: a **bundle the profile names and the process did not start from**.

A bundle is composed *before* any entry exists. When the launcher skips one —
the bundle is not installed, a peer is missing, the name is misspelled — it
contributes **no entries at all**: no fiber, no `internal/status` event, nothing to
await. The process starts, every remaining entry activates perfectly, and the
application runs with a smaller composition than its own configuration declares.
That is
[#9451](https://github.com/deepseek-ai/deepseek-harness/discussions/9451): for such
a profile, `dsh` and `--dump-config` both exit `0`, and the launcher prints the
skip reason once to stderr and carries on.

The doctor reports this too. It diffs the profile manifest's declared bundles
against the launcher's own `ctx.profileContext.startedBundles`, and for each name
that did not contribute it recovers the launcher's skip reason from
`@deepseek-ai/dsh-app-boot`'s `loadProfileDirectory(...).skippedBundles` — read as
a package at runtime, so **this plugin still declares no dependency on it**. Where
the launcher is unreachable the finding stands and the report says the reason is
unavailable, naming why.

| `profileBundles` header line | meaning |
|------------------------------|---------|
| `2 declared, 2 started` | every declared bundle contributed |
| `2 declared, 1 started, 1 did not start` | one name in the manifest contributed nothing |
| `the declaration could not be read — …` | the manifest was missing or malformed. **Not** the same as "names no bundles" |

A third-party entry failure takes the `warn` branch of `auditStartupEntries`, so
nothing can turn a partial composition into an exit status from outside the
launcher — the report is where an operator can see it.

## The stage before the composition

There is one more way to lose a plugin, and both stages above are blind to it: the
package is **installed and never selected**. It is not in
`ctx.profileContext.startedBundles` (it contributed no layer) and it is not in
`dsh.profile.bundles` either (nothing ever added it there), so the two agree, the
composition looks healthy, and the plugin is simply absent from the process. The
entry sweep has nothing to report because there is no entry, and the composition
diff has nothing to report because both of its sides are consistent.

That is [#9261](https://github.com/deepseek-ai/deepseek-harness/discussions/9261):
`dsh plugin add` installs through the package manager and reconciles afterwards, so
a run the CLI never finishes leaves the package in `dependencies` and in
`pnpm-lock.yaml` with `dsh.profile.bundles` untouched. `pnpm install` run by hand, a
profile edited by a script, an interrupted or killed install — all reach the same
state, and nothing in the running application can report it, because the only
artifact of the loss is a list the package is missing from.

The doctor reads those two lists off the same manifest parse and reports the
difference:

| `profileBundles` header line | meaning |
|------------------------------|---------|
| `1 declared, 1 started, 1 installed but never selected` | a dependency declares `dsh.bundle` and is not in the bundle list |
| `coverage: 2 of 11 dependencies could not be inspected` | how much of the dependency set this arm actually read |

The qualifier is what keeps this from being noise. **Most dependencies are not
bundles** — a profile's `dependencies` and its `dsh.profile.bundles` are different
lists on purpose — so the bundle claim is read from each package's own manifest, the
way the harness's own `bundleManifest` reads it: a dependency is a bundle when its
`dsh.bundle.patch` is defined. A dependency declaring none is inspected and passed
over; a dependency whose `dsh.bundle.patch` exists but is neither a file path nor a
list of them is reported too, because app-boot throws while loading that declaration
and the profile loses the package either way.

Each dependency is resolved from disk the way the loader resolves a bundle — the
**installation anchor first, then the profile** — so an in-box package is never
mistaken for the profile-local copy, and only `package.json` files are read: no
third-party module is imported to describe one. Dependencies this arm cannot resolve,
or whose manifest it cannot read, are listed as **coverage**, never as findings: an
incomplete audit must not read as a broken installation.

Two things are deliberately not checked. The reverse direction — a name in
`dsh.profile.bundles` that is not a dependency — is the normal shape of a healthy
profile, since every shipped bundle comes from the installation rather than the
profile. And a bundle that *is* selected but cannot be loaded is the arm above: the
launcher reports it in `skippedBundles`.

## Install

**In the application (the Desktop shell, and the Web UI).** Desktop's profile is
the application's own and cannot be managed from a terminal: `dsh --profile
desktop` and `dsh plugin --profile desktop …` are both refused before they run
(`apps/cli/src/args.ts`, `rejectElectronProfile` — the `plugin` subcommand skips
the refusal only for Desktop's own installed carrier). Install it where that
profile *is* managed: open the sidebar's **Plugins** page, choose **Add plugin**,
and give the package name.

```
@argszero/dsh-activation-doctor
```

The Host reads the spec, installs it, and offers **Enable now**; the same page
switches the plugin off later without uninstalling it (which is what keeps the
report file readable after the incident).

**In a profile the launcher manages (web, tui, any custom profile).**

```sh
dsh plugin --profile <name> add @argszero/dsh-activation-doctor
```

That command forwards to pnpm inside the profile directory, so `npm install
@argszero/dsh-activation-doctor` run there is equivalent — a profile is an
ordinary package with its own `package.json`.

Then mount it, or apply the bundled patch, which mounts it and changes nothing
else:

```yaml
- insert:
    - id: activation-doctor
      name: '@argszero/dsh-activation-doctor'
      inject:
        - loader
```

## What it does

- **Sweeps after the tree settles.** An entry that has not finished importing has
  no fiber yet, and reading that as an import failure is exactly the wrong answer
  this plugin exists to prevent. The sweep waits for the loader's pending task
  count to reach zero, then classifies every entry — including nested subtrees.
- **Classifies four ways, behaviourally.** `await fiber.await()` is the primary
  question, because cordis declares fiber states as a `const enum` and a `const
  enum` is **erased at emit time**: `import { FiberState } from
  '@deepseek-ai/cordis'` evaluates to `undefined`, so `fiber.state ===
  FiberState.FAILED` is `false` for a failure. The numeric state is read only
  *after* a successful settle, to separate `active` from `pending`, and a state it
  does not recognise is reported as `unknown` with its raw value rather than
  guessed into a category:

  | outcome | meaning |
  |---------|---------|
  | `disabled` | switched off in the profile or patch. A decision, not a finding |
  | `import-failed` | the module could not be imported, so no fiber exists |
  | `failed` | the fiber threw; the original error and stack are reported |
  | `active` | running |
  | `pending` | waiting for a service; the missing service names are reported |
  | `unknown` | a settled state with no name, reported with its numeric value |

- **Files a private report.** `<home>/logs/activation-<timestamp>-<uuid>.log`,
  directory mode `0700`, file mode `0600`, created with `wx` so an existing path
  is an error rather than an overwrite. `<home>` is `$DSH_HOME` when it is set to
  a non-blank value, and `~/.dsh` otherwise — the same directory the harness's own
  startup report uses. The first line warns that raw diagnostics may contain
  configuration or credential values.

  **Before pasting a report into a public thread, read its header.** It records
  `timestamp`, `phase`, `settled`, `dshVersion`, `profile`, `nodeVersion`,
  `platform` and `execPath` — the last three name the machine and the exact Node
  binary, which is more about you than about the bug. The entries below the header
  quote a failing plugin's own error text verbatim, and that text is whatever the
  plugin chose to say, so it may carry a path or a value from your configuration.
- **Prints one line** per finding, plus the report path, to stderr — the same
  channel the harness already uses for third-party activation failures.
- **Keeps watching.** A failure that appears later — a hot reload, a profile patch
  re-application, a plugin mounted after startup — is reported too. `internal/status`
  fires for every fiber in the process, including fibers owned by other contexts,
  which is what makes a post-startup failure observable at all.
- **Answers `activation_status` on demand.** "Which of my plugins is actually
  running" is a question you ask *after* the process is up, usually while looking
  at a session in which a tool you expect is missing. The answer comes from the
  same sweep as the report, so the two can never disagree.
- **Audits the profile composition as well.** A bundle the launcher skipped
  contributes no entries, so the sweep above cannot see it. See
  [the stage before the entries](#the-stage-before-the-entries).
- **Reports installed packages the profile never selected.** The one loss both
  stages above agree on, because a package that never entered
  `dsh.profile.bundles` is missing from each list they read. See
  [the stage before the composition](#the-stage-before-the-composition).

## Configuration

| key | default | meaning |
|-----|---------|---------|
| `enabled` | `true` | `false` installs nothing at all |
| `log` | `'summary'` | `'off'` writes the file and says nothing on the terminal |
| `report` | `true` | write the durable file |
| `reportDir` | `$DSH_HOME/logs` | where reports are written; a leading `~` is expanded |
| `includePending` | `true` | list entries waiting for a service |
| `composition` | `true` | audit the profile's declared bundles against what this process started from |
| `installed` | `true` | report installed dependencies that declare a bundle and were never selected |
| `watch` | `true` | re-report failures that appear after the first sweep |
| `tool` | `true` | register the `activation_status` tool |
| `maxEntries` | `50` | inclusive bound on the entries listed |
| `errorChars` | `4000` | inclusive bound on one entry's rendered error |
| `maxLiveReports` | `5` | cap on post-startup reports per process |
| `debounceMs` | `50` | quiet period before a sweep |
| `maxSettleTries` | `400` | sweeps that may pass while the loader still has pending tasks |

Every value is read defensively: a configuration file is authored by hand, and a
diagnostic that throws on a typo is a diagnostic that loses the failure it was
mounted to report.

There is deliberately **no `Config` schema export**. Cordis validates a plugin's
config through `runtime.Config['~standard'].validate(config)` whenever the runtime
carries a `Config` at all, and a plain defaults object has no `~standard` —
exporting one throws `Cannot read properties of undefined (reading 'validate')`
out of `Fiber._reload`, taking the plugin down before it can report on anybody.
A schema would satisfy that check at the price of a `@deepseek-ai/schemastery`
peer; the knobs above are normalized in code instead, so the defaults are the same
with or without a schema, and one fewer dependency is one fewer range to keep
admitted across the release lines.

## What it is not

- **It does not repair anything.** The failed plugin stays failed, its entry stays
  enabled, and nothing it contributed comes back.
- **It cannot move the desktop shell's stderr.** The 64 KiB ring buffer is in
  `apps/desktop/src/host-process.ts`; a plugin can write more to stderr, not
  redirect what is already there. The report file is the answer to that.
- **It is not a policy change.** Registration semantics, the marketplace row and
  the startup-audit required-id set are all untouched.
- **It does not re-import a module to explain an `import-failed` entry.** The
  obvious way to recover that reason is to import the entry's specifier again and
  catch the throw — but that re-executes third-party module code inside the
  doctor's own context, for a plugin the harness has already decided not to load,
  and it would contradict the promise above that the doctor never touches the
  plugin that failed. A resolve-only probe (`import.meta.resolve`,
  `createRequire(...).resolve`) executes nothing, but it has to resolve from the
  entry's own base URL, and no public surface the doctor reads exposes it — so the
  probe would answer about the doctor's location instead and be wrong for exactly
  the relative specifiers it was meant to explain. The entry is reported by id and
  name, and the harness's own import error is not replaced by a guess.
- **`reportDir` has no access to a launcher-configured home.** The harness's own
  `resolveDshHome` honours an explicit configured path supplied by the launcher; a
  plugin mounted from a patch cannot see that value. If you configure a non-default
  home, set `reportDir` explicitly.

## Supported lines

The peer ranges admit the harness lines this package was measured against:

- `@deepseek-ai/dsh-tools` `0.1.7-rc.2`, `0.2.0-rc.2`, `0.2.1-alpha.2`
- `@deepseek-ai/cordis` `4.0.4` and `4.0.5-alpha.1`

`node scripts/probe-lines.mjs` copies this package into a scratch tree per line,
pins the whole line, installs, builds and runs the suite — the range is a claim
nobody ran until that passes.

## Development

```sh
npm install
npm test                       # tsc, then node --test on the real loader
npm run test:inject            # mutate each distinction; every arm must be caught
npm run test:probe-lines       # install and test each supported line
```

`npm test` mounts a real cordis context, the real loader, the real
`SystemPrompt`, the real `ToolRuntime` and real fixture modules on disk. The
incident is reproduced rather than simulated: two fixtures register the same tool
name, the second one's registration throws out of its body, and the whole plugin
goes down with that fiber. A control arm mounts everything **except** the doctor,
so "the report names the failure" is never confounded with "the failure happened
at all".

## License

MIT
