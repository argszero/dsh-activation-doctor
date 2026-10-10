/**
 * The sweep: read the loader's settled tree and say what did not activate.
 *
 * This is the whole plugin's substance, and it is deliberately a *read*. Nothing
 * here starts, stops, retries or repairs a plugin; the one thing it does to a
 * fiber is `await()` it — which is how the harness's own startup audit recovers a
 * failure reason, and also how a healthy fiber is confirmed healthy.
 *
 * ## Why the classification is behavioural rather than a comparison
 *
 * Cordis declares fiber states as a `const enum` (`FiberState`), and a `const
 * enum` is erased at emit time: the published `@deepseek-ai/cordis` exports
 * `Context`, `Fiber`, `EventsService` and the rest, but **no `FiberState`
 * object** — `import { FiberState } from '@deepseek-ai/cordis'` evaluates to
 * `undefined`, so `fiber.state === FiberState.FAILED` is `false` for a failure
 * and `undefined === undefined` for a `PENDING` fiber. The harness's own audit
 * sidesteps this by aliasing numeric literals beside the type
 * (`const FIBER_FAILED = 3 as FiberState.FAILED`, `packages/boot/app-boot/src/index.ts`),
 * which is correct for first-party code compiled alongside the enum but is not a
 * contract a third-party plugin should copy blindly.
 *
 * So this module settles first and asks afterwards: `await fiber.await()` rejects
 * exactly when the fiber failed, and the original error comes back with it. The
 * numeric state is read only *after* a successful settle, to separate "running"
 * from "waiting for a service"; a state that is neither is reported as `unknown`
 * with its raw value rather than guessed into a category.
 *
 * @module @argszero/dsh-activation-doctor/audit
 */

/**
 * The subset of a Cordis fiber this module reads.
 *
 * Structural on purpose. `@deepseek-ai/cordis` publishes `Fiber` as a class, but
 * a plugin that only reads state does not need to depend on the fiber's or the
 * loader's exact declaration surface, and narrowing that dependency is what keeps
 * this plugin working across the harness's release lines. Every member here is
 * public API on the shipped type.
 */
export interface FiberLike {
  /** Lifecycle state as a number; see the module note on the erased `const enum`. */
  readonly state: number
  /** Required service name → intercept config, as resolved for this fiber. */
  readonly inject: Record<string, unknown>
  /** The fiber's context, used to ask which injected services actually resolved. */
  readonly ctx: { get(name: string): unknown }
  /** Settle the fiber's in-flight work and rethrow its activation error, if any. */
  await(): Promise<unknown>
}

/**
 * The subset of a loader entry this module reads.
 *
 * `disabled` is a getter on the shipped entry and it can *throw*: the value is an
 * expression evaluated against the entry's own context, so a broken patch
 * expression surfaces here rather than at load time. The harness treats that as
 * an entry failure, and so does this module.
 */
export interface EntryLike {
  /** Entry options; `id` and `name` are the two the report names. */
  readonly options: { id: string, name: string }
  /** Whether the entry is switched off in its profile or patch layer. */
  readonly disabled: boolean
  /** The entry's root fiber; absent when the module never imported. */
  readonly fiber?: FiberLike | undefined
}

/** The subset of the loader service this module reads. */
export interface LoaderLike {
  /** Iterate this tree's entries and any nested subtrees. */
  entries(): Iterable<EntryLike>
  /** Pending import and lifecycle tasks, when the loader exposes them. */
  getTasks?(): readonly unknown[]
}

/**
 * The numeric states this module names.
 *
 * These are the values of the erased enum, used only to tell settled healthy
 * states apart *after* `await()` has confirmed there is no failure. `PENDING` is
 * a fiber whose dependencies do not all resolve yet; `ACTIVE` is a running fiber.
 */
export const FIBER_PENDING = 0
export const FIBER_ACTIVE = 2

/** What the sweep concluded about one entry. */
export type Outcome =
  /** The entry is switched off: a legitimate state, not a problem. */
  | { readonly kind: 'disabled' }
  /** The module could not be imported, so no fiber exists. */
  | { readonly kind: 'import-failed' }
  /** The fiber threw; `error` is the original rejection reason. */
  | { readonly kind: 'failed', readonly phase?: string, readonly error: unknown }
  /** The fiber is running. */
  | { readonly kind: 'active', readonly state: number }
  /** The fiber is waiting for services it declares. */
  | { readonly kind: 'pending', readonly missing: readonly string[], readonly state: number }
  /** A settled state this module does not have a name for. */
  | { readonly kind: 'unknown', readonly state: number }

/** One entry and what happened to it. */
export interface EntryAudit {
  /** The loader entry id, which is what a profile or patch row names. */
  readonly id: string
  /** The module specifier the entry imports. */
  readonly name: string
  /** The classification. */
  readonly outcome: Outcome
}

/**
 * Whether an outcome is something an operator needs to be told about.
 *
 * A disabled entry is excluded because it is a decision the operator made; an
 * active fiber is excluded because it is the healthy case. Everything else —
 * including `pending` — is reported, because a plugin that silently never starts
 * is the entire complaint this plugin exists to answer.
 * @param outcome - a classification.
 * @returns whether the outcome belongs in a report.
 */
export function isProblem(outcome: Outcome): boolean {
  return outcome.kind !== 'disabled' && outcome.kind !== 'active'
}

/**
 * The services a pending fiber is still waiting for.
 *
 * A missing service is one whose name is injected but resolves to `undefined`;
 * `ctx.get` is the resolver the harness's own audit calls for the same purpose.
 * @param fiber - the pending fiber.
 * @returns the injected service names that do not resolve.
 */
function missingServices(fiber: FiberLike): readonly string[] {
  const missing: string[] = []
  for (const service of Object.keys(fiber.inject ?? {})) {
    let resolved: unknown
    try {
      resolved = fiber.ctx.get(service)
    } catch {
      resolved = undefined
    }
    if (resolved === undefined) missing.push(service)
  }
  return missing
}

/**
 * Classify one entry.
 *
 * Order matters. `disabled` is read first because it can throw and because a
 * disabled entry is a legitimate state rather than a failure. A missing fiber
 * means the import itself failed — the one failure that leaves nothing to await.
 * Everything else is settled through `await()`, so a rejection is proof of
 * failure and its absence means the fiber is healthy, waiting, or in a state this
 * module does not name.
 * @param entry - the loader entry.
 * @returns the entry's outcome.
 */
export async function classifyEntry(entry: EntryLike): Promise<Outcome> {
  try {
    if (entry.disabled) return { kind: 'disabled' }
  } catch (error: unknown) {
    return { kind: 'failed', phase: 'disabled expression failed', error }
  }
  const fiber = entry.fiber
  if (fiber === undefined) return { kind: 'import-failed' }
  try {
    await fiber.await()
  } catch (error: unknown) {
    return { kind: 'failed', error }
  }
  if (fiber.state === FIBER_ACTIVE) return { kind: 'active', state: fiber.state }
  if (fiber.state === FIBER_PENDING) return { kind: 'pending', missing: missingServices(fiber), state: fiber.state }
  return { kind: 'unknown', state: fiber.state }
}

/**
 * Sweep a settled loader tree.
 *
 * The tree is read exactly as the loader presents it, including nested subtrees,
 * because a nested entry fails the same way a top-level one does and is reported
 * the same way. Entries are classified sequentially: the sweep runs once per
 * quiet period, and awaiting each fiber in turn keeps the loader's own task list
 * from being perturbed by a burst of concurrent settles.
 * @param loader - the loader service.
 * @returns one audit row per entry, in tree order.
 */
export async function auditEntries(loader: LoaderLike): Promise<readonly EntryAudit[]> {
  const rows: EntryAudit[] = []
  for (const entry of loader.entries()) {
    const id = typeof entry.options?.id === 'string' ? entry.options.id : '(no id)'
    const name = typeof entry.options?.name === 'string' ? entry.options.name : '(no name)'
    rows.push({ id, name, outcome: await classifyEntry(entry) })
  }
  return rows
}

/**
 * Pending work the loader still owns.
 *
 * The sweep waits for this to reach zero: an entry that has not finished
 * importing has no fiber yet and would be misread as an import failure. A loader
 * that does not expose the count reads as settled, which is the safe direction —
 * this only ever delays a report, never invents one.
 * @param loader - the loader service.
 * @returns the number of pending tasks.
 */
export function pendingTasks(loader: LoaderLike): number {
  try {
    return loader.getTasks?.().length ?? 0
  } catch {
    return 0
  }
}

/**
 * Render one error the way the harness's own diagnostics do.
 *
 * The stack is preferred over the message because the duplicate-registration case
 * is only actionable when the operator can see *which* plugin threw and from
 * where. Non-`Error` rejections (`throw undefined`, `throw 'string'`) are
 * rendered rather than dropped, so an empty report never stands in for a
 * failure that happened.
 * @param error - the rejection reason.
 * @param maxChars - inclusive bound on the rendered text.
 * @returns the rendered error.
 */
export function formatError(error: unknown, maxChars = 4000): string {
  let text: string
  if (error instanceof Error) {
    text = error.stack ?? `${error.name}: ${error.message}`
  } else if (typeof error === 'string') {
    text = error === '' ? '(empty string rejection)' : error
  } else if (error === undefined) {
    text = '(undefined rejection)'
  } else {
    try {
      text = `non-Error rejection: ${JSON.stringify(error) ?? String(error)}`
    } catch {
      text = `non-Error rejection: ${String(error)}`
    }
  }
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (truncated)` : text
}

/**
 * A stable identity for one finding, used to report each failure once.
 *
 * The key includes the rendered error so that a plugin that fails, is fixed and
 * fails again is reported again, while a fiber that merely re-settles into the
 * same failure is not.
 * @param row - one audit row.
 * @returns the deduplication key.
 */
export function findingKey(row: EntryAudit): string {
  const { outcome } = row
  if (outcome.kind === 'failed') return `${row.id}\u0000failed\u0000${String(formatError(outcome.error, 200))}`
  if (outcome.kind === 'pending') return `${row.id}\u0000pending\u0000${outcome.missing.join(',')}`
  return `${row.id}\u0000${outcome.kind}`
}
