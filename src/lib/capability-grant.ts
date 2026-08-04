import { createChildLogger } from '../logger.ts';
import { MS_PER_HOUR } from './time-units.ts';

/**
 * Temporary capability grant manager.
 *
 * Grants a group of capabilities for a bounded time-to-live, records the exact
 * diff applied to the underlying policy, and reverts precisely on manual disarm
 * or automatic expiry.
 *
 * The manager is policy-agnostic. It speaks to a PolicyAdapter with three
 * methods: read the current allow/deny sets, apply a delta, and persist a
 * grant record. The adapter translates to the host system's policy store.
 *
 * Design constraints (fail-closed throughout):
 *
 * - Diff-driven revert: each grant records {addedToAllow, removedFromDeny}.
 *   Disarm only touches exactly what the grant changed — never re-derives
 *   state. This survives concurrent unrelated policy edits.
 *
 * - Singleton slot: by default, only one active grant at a time. Arming while
 *   armed is allowed but the previous grant's diff is reverted first.
 *
 * - Startup reconciliation: persisted grants survive process restarts. On
 *   startup, call reconcile() — expired grants are reverted *before* the
 *   manager accepts new commands. This is the critical invariant: a crash
 *   must not leave a privileged window open until the next poll.
 *
 * - Fail-closed duration parsing: invalid/zero/overflow durations are rejected
 *   with no state mutation.
 *
 * - Idempotent disarm: calling disarm() when not armed is a no-op.
 *
 * - Scope-first authorization: when the caller's scope set is known, authorize
 *   purely on scope (e.g. requires 'admin'); only fall back to an owner flag
 *   for unscoped callers. This prevents lower-privileged scopes from
 *   escalating.
 *
 * - Coarse polling + unref: expiry is checked on a configurable interval
 *   (default 15s). The timer is unref'd so it doesn't keep the process alive.
 */

export interface PolicySnapshot {
  /** Current set of allowed capabilities. */
  allow: ReadonlySet<string>;
  /** Current set of explicitly-denied capabilities. */
  deny: ReadonlySet<string>;
}

export interface PolicyDelta {
  /** Entries to add to the allow set. */
  addAllow: readonly string[];
  /** Entries to remove from the allow set. */
  removeAllow: readonly string[];
  /** Entries to add to the deny set. */
  addDeny: readonly string[];
  /** Entries to remove from the deny set. */
  removeDeny: readonly string[];
}

/**
 * Adapter the manager uses to read and mutate the underlying policy.
 * All methods must be implemented atomically by the host — the manager
 * relies on read-then-mutate not racing with itself.
 */
export interface PolicyAdapter {
  /** Read the current policy snapshot. */
  read(): Promise<PolicySnapshot>;
  /** Apply a delta to the policy. Must be atomic. */
  apply(delta: PolicyDelta): Promise<void>;
}

export type GrantGroup = string;

export interface GrantGroupDefinition {
  /** The capabilities unlocked by this group. */
  capabilities: readonly string[];
}

export interface GrantRecord {
  /** Monotonic version of the record schema. */
  version: 2;
  /** ISO timestamp (ms since epoch) when the grant was armed. */
  armedAtMs: number;
  /** ISO timestamp (ms) when the grant expires, or null for manual-only. */
  expiresAtMs: number | null;
  /** The group that was armed. */
  group: GrantGroup;
  /** Full set of capabilities the group resolves to. */
  capabilities: readonly string[];
  /** Capabilities added to the allow set by this grant. */
  addedToAllow: readonly string[];
  /** Capabilities removed from the deny set by this grant. */
  removedFromDeny: readonly string[];
}

export interface GrantStatus {
  armed: boolean;
  group?: GrantGroup;
  capabilities?: readonly string[];
  armedAtMs?: number;
  expiresAtMs?: number | null;
  /** Milliseconds until expiry, or null if manual-only / not armed. */
  remainingMs?: number | null;
}

export type DisarmReason = 'manual' | 'expired' | 'superseded' | 'reconcile' | 'unauthorized';

export interface DisarmResult {
  changed: boolean;
  removed: readonly string[];
  restored: readonly string[];
  reason: DisarmReason;
}

export interface GrantStore {
  read(): Promise<GrantRecord | null>;
  write(record: GrantRecord | null): Promise<void>;
}

export interface GrantManagerOptions {
  /** Map of group name → capabilities. */
  groups: Record<GrantGroup, GrantGroupDefinition>;
  /** Policy adapter for reading/mutating the allow/deny sets. */
  policy: PolicyAdapter;
  /** Persistent store for the active grant record. */
  store: GrantStore;
  /** Expiry poll interval in milliseconds. Default: 15_000. */
  pollIntervalMs?: number;
  /** Called after a disarm completes (manual, expired, or superseded). */
  onDisarm?: (result: DisarmResult) => void | Promise<void>;
  /** Called when an expiry disarm or lifecycle observer fails. */
  onError?: (
    error: unknown,
    operation: 'expiry-disarm' | 'disarm-observer',
  ) => void | Promise<void>;
  /** Injectable clock (default: Date.now). */
  now?: () => number;
  /** Injectable timers (default: global). */
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export interface CapabilityGrantManager {
  /** Grant a group for an optional duration. Returns the record, or null on auth/validation failure. */
  arm: (
    group: GrantGroup,
    durationMs: number | null,
    auth: GrantAuthorization,
  ) => Promise<{ ok: true; record: GrantRecord } | { ok: false; error: string }>;
  /** Revert the active grant. Idempotent. */
  disarm: (auth: GrantAuthorization) => Promise<DisarmResult>;
  /** Read-only status (no auth required). */
  status: () => Promise<GrantStatus>;
  /** Reconcile persisted state on startup: revert expired grants before accepting commands. */
  reconcile: () => Promise<DisarmResult | null>;
  /** Stop the expiry poll timer. Does NOT disarm. */
  stop: () => void;
}

export interface GrantAuthorization {
  /**
   * Caller's scope set, if known. When present, authorization is decided
   * purely on whether this set contains the required scope.
   */
  scopes?: readonly string[];
  /**
   * Owner flag for unscoped callers. Only consulted when `scopes` is undefined.
   */
  isOwner?: boolean;
}

// ─── Constants ─────────────────────────────────────────────────────────────

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const MAX_DATE_MS = 8.64e15;

// ─── Duration parsing ──────────────────────────────────────────────────────

/**
 * Parse a human duration string like "30s", "5m", "2h", "1d" into milliseconds.
 * Returns null for invalid, zero, or overflow inputs.
 */
export function parseDurationMs(input: string): number | null {
  const match = /^(\d+)(s|m|h|d)$/.exec(input.trim());
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  const unit = match[2];
  const multiplier =
    unit === 's' ? 1_000 :
    unit === 'm' ? 60_000 :
    unit === 'h' ? MS_PER_HOUR :
    86_400_000; // d
  const ms = n * multiplier;
  if (!Number.isSafeInteger(ms)) return null;
  return ms;
}

/**
 * Format a millisecond duration for human display.
 * Inverse of parseDurationMs (approximate — units collapse).
 */
export function formatDurationMs(ms: number): string {
  if (ms <= 0) return '0s';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < MS_PER_HOUR) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / MS_PER_HOUR)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

// ─── Authorization ─────────────────────────────────────────────────────────

/**
 * Decide whether a caller is authorized to mutate grants.
 * Scope-first: when scopes are known, decide purely on scope membership.
 * Only fall back to the owner flag for unscoped callers.
 */
export function isAuthorizedToMutateGrants(
  auth: GrantAuthorization,
  requiredScope: string,
): boolean {
  if (Array.isArray(auth.scopes)) {
    return auth.scopes.includes(requiredScope);
  }
  return auth.isOwner === true;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function uniqSorted(arr: readonly string[]): string[] {
  return [...new Set(arr)].sort();
}

function resolveExpiresAtMs(durationMs: number | null, nowMs: number): number | null {
  if (durationMs === null) return null;
  const expires = nowMs + durationMs;
  if (!Number.isSafeInteger(expires) || expires > MAX_DATE_MS) return null;
  return expires;
}

function isExpired(record: GrantRecord, nowMs: number): boolean {
  if (record.expiresAtMs === null) return false;
  return nowMs >= record.expiresAtMs;
}

// ─── Manager ───────────────────────────────────────────────────────────────

export function createCapabilityGrantManager(
  options: GrantManagerOptions,
): CapabilityGrantManager {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const onDisarm = options.onDisarm ?? (() => {});
  const onError = options.onError ?? (() => {});
  const now = options.now ?? (() => Date.now());
  const _setTimeout = options.setTimeout ?? setTimeout;
  const _clearTimeout = options.clearTimeout ?? clearTimeout;

  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  const log = createChildLogger('capability-grant');

  const reportError = (
    error: unknown,
    operation: 'expiry-disarm' | 'disarm-observer',
  ): void => {
    try {
      void Promise.resolve(onError(error, operation)).catch((err) => { log.warn({ err, operation }, 'capability-grant: error observer rejected'); });
    } catch {
      // intentional: observability must never break expiry retries or completed state changes.
    }
  };

  const notifyDisarm = (result: DisarmResult): void => {
    try {
      void Promise.resolve(onDisarm(result)).catch((error: unknown) => {
        reportError(error, 'disarm-observer');
      });
    } catch (error) {
      reportError(error, 'disarm-observer');
    }
  };

  // Serialize every mutating command (arm/disarm/reconcile) and the expiry tick
  // through one chain, so the manager's own read→mutate→write of the policy+store
  // cannot interleave with a concurrent command (TOCTOU). Internal reverts use the
  // private disarmInternal (never the public disarm), so there is no re-entrancy.
  let commandChain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = commandChain.then(fn, fn);
    commandChain = run.then(() => undefined, () => undefined);
    return run;
  };

  const resolveGroup = (group: GrantGroup): readonly string[] | null => {
    const def = options.groups[group];
    if (!def) return null;
    return uniqSorted(def.capabilities);
  };

  /**
   * Internal disarm: reverts the diff recorded in the active grant.
   * Idempotent — returns {changed:false} if not armed.
   */
  const disarmInternal = async (reason: DisarmReason): Promise<DisarmResult> => {
    const record = await options.store.read();
    if (!record) return { changed: false, removed: [], restored: [], reason };

    const snapshot = await options.policy.read();
    const allow = new Set(snapshot.allow);
    const deny = new Set(snapshot.deny);

    const removed: string[] = [];
    const restored: string[] = [];

    // Revert: remove what we added to allow, restore what we removed from deny
    for (const cap of record.addedToAllow) {
      if (allow.delete(cap)) removed.push(cap);
    }
    for (const cap of record.removedFromDeny) {
      if (!deny.has(cap)) {
        deny.add(cap);
        restored.push(cap);
      }
    }

    if (removed.length > 0 || restored.length > 0) {
      await options.policy.apply({
        addAllow: [],
        removeAllow: removed,
        addDeny: restored,
        removeDeny: [],
      });
    }

    await options.store.write(null);
    const result: DisarmResult = {
      changed: removed.length > 0 || restored.length > 0,
      removed: uniqSorted(removed),
      restored: uniqSorted(restored),
      reason,
    };
    notifyDisarm(result);
    return result;
  };

  const tick = async () => serialize(async () => {
    const record = await options.store.read();
    if (!record || record.expiresAtMs === null) return;
    if (!isExpired(record, now())) return;
    await disarmInternal('expired');
  });

  const startPolling = () => {
    if (pollTimer !== null) return;
    const fire = () => {
      pollTimer = null;
      void tick()
        .catch((error: unknown) => reportError(error, 'expiry-disarm'))
        .finally(() => {
          // Re-arm only if not stopped during tick
          if (pollTimer === null && running) {
            const handle = _setTimeout(fire, pollIntervalMs);
            pollTimer = handle;
            // unref the timer handle if supported
            if (handle && typeof handle === 'object' && 'unref' in handle) {
              (handle as { unref?: () => void }).unref?.();
            }
          }
        });
    };
    const handle = _setTimeout(fire, pollIntervalMs);
    pollTimer = handle;
    if (handle && typeof handle === 'object' && 'unref' in handle) {
      (handle as { unref?: () => void }).unref?.();
    }
  };

  const arm: CapabilityGrantManager['arm'] = async (group, durationMs, auth) => {
    if (!isAuthorizedToMutateGrants(auth, 'admin')) {
      return { ok: false, error: 'requires admin scope or owner' };
    }
    const capabilities = resolveGroup(group);
    if (!capabilities) {
      return { ok: false, error: `unknown group: ${group}` };
    }

    // Fail-closed duration validation: a non-positive or non-finite duration must
    // be rejected outright. Otherwise arm() resolves expiresAtMs to now-or-past and
    // opens a privileged window that only the next poll (up to pollIntervalMs later)
    // would close. parseDurationMs guards the string path; arm() takes a raw number
    // and must guard it independently.
    if (durationMs !== null && (!Number.isSafeInteger(durationMs) || durationMs <= 0)) {
      return { ok: false, error: 'duration must be a positive integer (ms)' };
    }

    const nowMs = now();
    const expiresAtMs = resolveExpiresAtMs(durationMs, nowMs);
    if (durationMs !== null && expiresAtMs === null) {
      return { ok: false, error: 'duration overflow' };
    }

    // Revert any active grant first (singleton slot, superseded)
    const existing = await options.store.read();
    if (existing) {
      await disarmInternal('superseded');
    }

    const snapshot = await options.policy.read();
    const allow = new Set(snapshot.allow);
    const deny = new Set(snapshot.deny);

    const addedToAllow: string[] = [];
    const removedFromDeny: string[] = [];

    for (const cap of capabilities) {
      if (!allow.has(cap)) {
        allow.add(cap);
        addedToAllow.push(cap);
      }
      if (deny.has(cap)) {
        deny.delete(cap);
        removedFromDeny.push(cap);
      }
    }

    const record: GrantRecord = {
      version: 2,
      armedAtMs: nowMs,
      expiresAtMs,
      group,
      capabilities,
      addedToAllow: uniqSorted(addedToAllow),
      removedFromDeny: uniqSorted(removedFromDeny),
    };

    // Persist the exact rollback intent before opening the capability window.
    // If the atomic policy write fails, clear that intent because no elevation
    // was committed. A crash after the record write is conservative: startup
    // reconciliation sees the record and reverts any policy delta that landed.
    await options.store.write(record);
    try {
      if (addedToAllow.length > 0 || removedFromDeny.length > 0) {
        await options.policy.apply({
          addAllow: addedToAllow,
          removeAllow: [],
          addDeny: [],
          removeDeny: removedFromDeny,
        });
      }
    } catch (error) {
      await options.store.write(null);
      throw error;
    }
    // Defence-in-depth: guarantee the expiry poller is live for a timed grant even
    // when reconcile() was never called on this manager. Without this, a wiring path
    // that arms before reconcile() would leave the privileged window open until the
    // process restarts. Manual-only grants (no expiry) need no poller.
    if (record.expiresAtMs !== null) {
      running = true;
      startPolling();
    }
    return { ok: true, record };
  };

  const disarm: CapabilityGrantManager['disarm'] = async (auth) => {
    if (!isAuthorizedToMutateGrants(auth, 'admin')) {
      // Fail-closed AND distinguishable: an unauthorized disarm must not read as a
      // legitimate no-op (reason:'manual'), so the wire can surface "not authorized"
      // rather than silently reporting a successful no-op.
      return { changed: false, removed: [], restored: [], reason: 'unauthorized' };
    }
    return disarmInternal('manual');
  };

  const status: CapabilityGrantManager['status'] = async () => {
    const record = await options.store.read();
    if (!record) return { armed: false };
    const nowMs = now();
    const remainingMs =
      record.expiresAtMs === null ? null : Math.max(0, record.expiresAtMs - nowMs);
    return {
      armed: true,
      group: record.group,
      capabilities: record.capabilities,
      armedAtMs: record.armedAtMs,
      expiresAtMs: record.expiresAtMs,
      remainingMs,
    };
  };

  const reconcile: CapabilityGrantManager['reconcile'] = async () => {
    running = true;
    const record = await options.store.read();
    if (!record) {
      startPolling();
      return null;
    }
    if (isExpired(record, now())) {
      const result = await disarmInternal('reconcile');
      startPolling();
      return result;
    }
    startPolling();
    return null;
  };

  const stop: CapabilityGrantManager['stop'] = () => {
    if (pollTimer !== null) {
      _clearTimeout(pollTimer);
      pollTimer = null;
    }
    running = false;
  };

  return {
    // Mutating commands run through the serialize chain (TOCTOU guard); status is
    // read-only and stop is synchronous, so neither needs to queue.
    arm: (group, durationMs, auth) => serialize(() => arm(group, durationMs, auth)),
    disarm: (auth) => serialize(() => disarm(auth)),
    status,
    reconcile: () => serialize(() => reconcile()),
    stop,
  };
}
