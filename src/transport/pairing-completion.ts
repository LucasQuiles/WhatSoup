/**
 * Pairing-completion gate for the pairing CLI (`src/transport/auth.ts`).
 *
 * WHY. `connection: 'open'` does not mark the end of Baileys' pairing writes,
 * and `saveCreds()` covers only `creds.json`. In Baileys 7.0.0-rc13 (the pinned
 * version; the CB:success handler, lid-mapping.js and libsignal.js are
 * byte-identical to rc12) `lib/Socket/socket.js` CB:success (:743-786) emits
 * 'open' at :762 and then, awaited by no listener, runs `void
 * sendUnifiedSession()` (:763) and a `process.nextTick(async …)` block
 * (:764-785) when the success node carries a LID. That block:
 *
 *   1. stores the own LID<->PN mapping (`lidMapping.storeLIDPNMappings`, :770),
 *      which writes key type `lid-mapping` ids `<pnUser>` -> lidUser and
 *      `<lidUser>_reverse` -> pnUser (`lib/Signal/lid-mapping.js`:69-76), and
 *      only when the pair is `@lid` / `@s.whatsapp.net` (:21);
 *   2. writes key type `device-list`, id `<pnUser>`, value
 *      `[device?.toString() || '0']` (socket.js:772-778);
 *   3. calls `signalRepository.migrateSession(myPN, myLID)` (:779). That copies
 *      an EXISTING open PN session to its LID address and deletes the PN copy
 *      (`lib/Signal/libsignal.js`:204-305; write at :286-294). It creates
 *      nothing when no PN session for the own device is stored (:229-247), which
 *      is the normal state of a fresh pairing — so an own LID session is NOT an
 *      unconditional postcondition. Session ids are libsignal addresses
 *      `<signalUser>.<device>`, where signalUser is `<user>` for
 *      `@s.whatsapp.net` and `<user>_<domainType>` otherwise (`_1` for `@lid`;
 *      libsignal.js:311-322, WABinary/jid-utils.js:7-13).
 *
 * The CLI used to exit straight after `saveCreds()` resolved, so it could kill
 * the process while those reads and writes were in flight.
 *
 * WHAT THIS MODULE DOES. It tracks every async operation on the raw Signal key
 * store and every credential save, and `awaitPairingCompletion` resolves only
 * when, observed together:
 *   (a) every tracked credential save has settled, and none rejected;
 *   (b) the key store is quiescent — zero tracked operations in flight across a
 *       full macrotask turn (setImmediate), re-checked after each settle, and no
 *       tracked write rejected;
 *   (c) key-store tracking is complete: `set` and every other seam the store
 *       exposes were wrapped. Quiescence in (b) is only as good as what is
 *       wrapped, and the own-LID markers in (d) cannot show that an unrelated
 *       write settled, so a refused or missing seam is a failure, never a
 *       degraded success;
 *   (d) when `creds.me.lid` and `creds.me.id` are set (exactly Baileys' gate at
 *       socket.js:764, because the creds.update at :761 overwrites `me.lid` with
 *       the success node's attribute), the store holds the writes listed above.
 * The deadline turns an unmet condition into a typed rejection that names it.
 * There is no wall-clock "probably done" path.
 *
 * It does not prove the server accepts the next connection. Only a live-line
 * reconnect qualification proves that.
 */
import { isLidUser, isPnUser, jidDecode } from '@whiskeysockets/baileys';
import { systemClock, type Clock } from '../lib/clock.ts';
import { errorMessage } from '../lib/error-message.ts';

export const DEFAULT_PAIRING_COMPLETION_DEADLINE_MS = 30_000;

export type PairingCompletionCondition =
  | 'creds-save-failed'
  | 'creds-save-pending'
  | 'key-store-write-failed'
  | 'key-store-quiescence'
  | 'key-store-tracking-incomplete'
  | 'own-lid-state';

export class PairingCompletionError extends Error {
  readonly condition: PairingCompletionCondition;
  readonly detail: string;

  constructor(condition: PairingCompletionCondition, detail: string, options?: { cause?: unknown }) {
    super(`pairing did not reach a durable state: ${condition} (${detail})`, options);
    this.name = 'PairingCompletionError';
    this.condition = condition;
    this.detail = detail;
  }
}

export type KeyStoreSeam = 'get' | 'set' | 'clear' | 'transaction';
const KEY_STORE_SEAMS: readonly KeyStoreSeam[] = ['get', 'set', 'clear', 'transaction'];
// A failed read leaves the store unchanged; a failed write may leave it partial.
const WRITE_SEAMS: ReadonlySet<KeyStoreSeam> = new Set<KeyStoreSeam>(['set', 'clear']);

export type KeyStoreRead = (type: string, ids: string[]) => Promise<Record<string, unknown>>;

export interface PairingWriteSnapshot {
  credsSavesPending: number;
  credsSaveFailure: { error: unknown } | null;
  keyStoreOpsInFlight: number;
  keyStoreWriteFailure: { seam: KeyStoreSeam; error: unknown } | null;
  /** Increments on every operation start and settle; equality means no activity. */
  epoch: number;
}

/**
 * 'full': `set` and every other present seam are wrapped. 'partial': `set` is
 * wrapped but another seam was refused. 'none': `set` is not wrapped, so no write
 * is observable. Only 'full' can reach a successful completion.
 */
export type KeyStoreTracking = 'full' | 'partial' | 'none';

export interface PairingWriteTracker {
  /**
   * Wrap the raw key store IN PLACE and return it. Pass the result to
   * `makeCacheableSignalKeyStore` so every cache miss and write-through is seen.
   */
  wrapKeyStore<T extends object>(keys: T): T;
  /** Route a credential saver through the tracker; the returned saver behaves identically. */
  trackCredsSave(save: () => Promise<void>): () => Promise<void>;
  /** The store's own `get`, called without tracking so verification reads do not count as activity. */
  readUntracked(): KeyStoreRead | null;
  keyStoreTracking(): KeyStoreTracking;
  snapshot(): PairingWriteSnapshot;
  /** Resolves at the next operation start or settle. */
  nextActivity(): Promise<void>;
}

export interface PairingWriteTrackerOptions {
  /** A seam that cannot be wrapped. Wrapping never throws; the completion gate then fails. */
  onSeamRefused?: (seam: KeyStoreSeam, err: unknown) => void;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export function createPairingWriteTracker(options: PairingWriteTrackerOptions = {}): PairingWriteTracker {
  let credsSavesPending = 0;
  let credsSaveFailure: PairingWriteSnapshot['credsSaveFailure'] = null;
  let keyStoreOpsInFlight = 0;
  let keyStoreWriteFailure: PairingWriteSnapshot['keyStoreWriteFailure'] = null;
  let epoch = 0;
  let setWrapped = false;
  let refusedSeams = 0;
  let rawGet: KeyStoreRead | null = null;
  const waiters = new Set<() => void>();

  const notify = (): void => {
    epoch += 1;
    const pending = [...waiters];
    waiters.clear();
    for (const wake of pending) wake();
  };

  const settleKeyOp = (seam: KeyStoreSeam, failed: boolean, error?: unknown): void => {
    keyStoreOpsInFlight -= 1;
    if (failed && WRITE_SEAMS.has(seam) && keyStoreWriteFailure === null) {
      keyStoreWriteFailure = { seam, error };
    }
    notify();
  };

  const wrapSeam = (fn: (...args: unknown[]) => unknown, seam: KeyStoreSeam) =>
    function (this: unknown, ...args: unknown[]): unknown {
      keyStoreOpsInFlight += 1;
      notify();
      let result: unknown;
      try {
        result = fn.apply(this, args);
      } catch (err) {
        settleKeyOp(seam, true, err);
        throw err;
      }
      if (isThenable(result)) {
        return Promise.resolve(result).then(
          (value) => {
            settleKeyOp(seam, false);
            return value;
          },
          (err: unknown) => {
            settleKeyOp(seam, true, err);
            throw err;
          },
        );
      }
      settleKeyOp(seam, false);
      return result;
    };

  return {
    wrapKeyStore<T extends object>(keys: T): T {
      // Same in-place wrap and degrade-on-refusal contract as
      // ConnectionManager.invalidatingKeyStore (src/transport/connection.ts). It is
      // mirrored rather than shared so this pairing-only fix leaves the daemon's
      // source and its runtime pin untouched. A refused seam must not fail the
      // pairing connect itself; it makes the completion gate fail instead, since
      // writes through that seam would be invisible to the quiescence check.
      const store = keys as Record<string, unknown>;
      const originalGet = store['get'];
      if (typeof originalGet === 'function') {
        rawGet = (type, ids) =>
          Promise.resolve((originalGet as (t: string, i: string[]) => unknown).call(store, type, ids))
            .then((value) => (value ?? {}) as Record<string, unknown>);
      }
      for (const seam of KEY_STORE_SEAMS) {
        const original = store[seam];
        if (typeof original !== 'function') continue;
        try {
          store[seam] = wrapSeam(original as (...args: unknown[]) => unknown, seam);
          if (seam === 'set') setWrapped = true;
        } catch (err) {
          refusedSeams += 1;
          options.onSeamRefused?.(seam, err);
        }
      }
      return keys;
    },

    trackCredsSave(save: () => Promise<void>): () => Promise<void> {
      return () => {
        credsSavesPending += 1;
        notify();
        let pending: Promise<void>;
        try {
          pending = Promise.resolve(save());
        } catch (err) {
          pending = Promise.reject(err);
        }
        // The derived promise handles the rejection for tracking only; the caller
        // still receives the original promise and owns its own error handling.
        void pending.then(
          () => {
            credsSavesPending -= 1;
            notify();
          },
          (err: unknown) => {
            credsSavesPending -= 1;
            if (credsSaveFailure === null) credsSaveFailure = { error: err };
            notify();
          },
        );
        return pending;
      };
    },

    readUntracked: () => rawGet,

    keyStoreTracking(): KeyStoreTracking {
      if (!setWrapped) return 'none';
      return refusedSeams === 0 ? 'full' : 'partial';
    },

    snapshot: () => ({
      credsSavesPending,
      credsSaveFailure,
      keyStoreOpsInFlight,
      keyStoreWriteFailure,
      epoch,
    }),

    nextActivity: () => new Promise<void>((resolve) => { waiters.add(resolve); }),
  };
}

// ---------------------------------------------------------------------------
// Own-LID state expectation (see the module header for every Baileys citation)
// ---------------------------------------------------------------------------

interface OwnLidExpectation {
  pnUser: string;
  device: string;
  lidUser: string;
  /** storeLIDPNMappings validation (lid-mapping.js:21) and migrateSession's gate (libsignal.js:206-210). */
  pairIsStandard: boolean;
  pnSessionId: string;
  lidSessionId: string;
}

type OwnLidPlan =
  | { kind: 'not-applicable' }
  | { kind: 'undecodable' }
  | { kind: 'expected'; expectation: OwnLidExpectation };

function readMe(creds: unknown): { id?: unknown; lid?: unknown } | undefined {
  if (creds === null || typeof creds !== 'object') return undefined;
  const me = (creds as { me?: unknown }).me;
  if (me === null || typeof me !== 'object') return undefined;
  return me as { id?: unknown; lid?: unknown };
}

/** libsignal.js:311-322 jidToSignalProtocolAddress(...).toString(). */
function signalAddress(user: string, domainType: number, device: number): string {
  return `${domainType !== 0 ? `${user}_${domainType}` : user}.${device}`;
}

function planOwnLidState(creds: unknown): OwnLidPlan {
  const me = readMe(creds);
  const id = me?.id;
  const lid = me?.lid;
  if (typeof id !== 'string' || id.length === 0 || typeof lid !== 'string' || lid.length === 0) {
    return { kind: 'not-applicable' };
  }
  const pn = jidDecode(id);
  const lidDecoded = jidDecode(lid);
  if (!pn?.user || !lidDecoded?.user) return { kind: 'undecodable' };
  const device = pn.device?.toString() || '0';
  const deviceNumber = pn.device || 0;
  return {
    kind: 'expected',
    expectation: {
      pnUser: pn.user,
      device,
      lidUser: lidDecoded.user,
      pairIsStandard: isLidUser(lid) === true && isPnUser(id) === true,
      pnSessionId: signalAddress(pn.user, pn.domainType ?? 0, deviceNumber),
      // transferDevice(pnJid, lid) keeps the PN device on the LID user (jid-utils.js:90-95).
      lidSessionId: signalAddress(lidDecoded.user, lidDecoded.domainType ?? 1, deviceNumber),
    },
  };
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

async function verifyOwnLidState(
  expectation: OwnLidExpectation,
  read: KeyStoreRead,
): Promise<string[]> {
  const missing: string[] = [];
  const deviceList = (await read('device-list', [expectation.pnUser]))[expectation.pnUser];
  if (!Array.isArray(deviceList) || !deviceList.includes(expectation.device)) {
    missing.push('own device-list entry');
  }
  if (!expectation.pairIsStandard) return missing;

  const reverseId = `${expectation.lidUser}_reverse`;
  const mapping = await read('lid-mapping', [expectation.pnUser, reverseId]);
  if (mapping[expectation.pnUser] !== expectation.lidUser || mapping[reverseId] !== expectation.pnUser) {
    missing.push('own LID-PN mapping');
  }
  const sessions = await read('session', [expectation.pnSessionId, expectation.lidSessionId]);
  // migrateSession only moves a session that exists; an absent PN session means
  // there was nothing to migrate, not that the migration was lost.
  if (isPresent(sessions[expectation.pnSessionId]) && !isPresent(sessions[expectation.lidSessionId])) {
    missing.push('own LID session (own PN session not migrated)');
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Completion gate
// ---------------------------------------------------------------------------

export interface PairingCompletionTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Resolve after one full macrotask turn, after every queued nextTick and microtask. */
  yieldMacrotask(): Promise<void>;
}

export const defaultPairingCompletionTimers: PairingCompletionTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
  yieldMacrotask: () => new Promise<void>((resolve) => { setImmediate(resolve); }),
};

export interface PairingCompletionOptions {
  tracker: PairingWriteTracker;
  /** Read at each check: Baileys mutates the creds object in place. */
  getCreds: () => unknown;
  deadlineMs?: number;
  timers?: PairingCompletionTimers;
  clock?: Clock;
}

export interface PairingCompletionReport {
  elapsedMs: number;
  macrotaskTurns: number;
  keyStoreTracking: KeyStoreTracking;
  ownLidState: 'verified' | 'not-applicable';
}

export async function awaitPairingCompletion(options: PairingCompletionOptions): Promise<PairingCompletionReport> {
  const { tracker, getCreds } = options;
  const deadlineMs = options.deadlineMs ?? DEFAULT_PAIRING_COMPLETION_DEADLINE_MS;
  const timers = options.timers ?? defaultPairingCompletionTimers;
  const clock = options.clock ?? systemClock;
  const startedAt = clock.now();

  // What the gate is waiting on right now; the deadline reports exactly this.
  let condition: PairingCompletionCondition = 'creds-save-pending';
  let detail = 'not yet observed';
  let expired = false;
  let wakeOnExpiry!: () => void;
  const expiry = new Promise<void>((resolve) => { wakeOnExpiry = resolve; });
  const handle = timers.setTimeout(() => {
    expired = true;
    wakeOnExpiry();
  }, deadlineMs);

  const waitOrExpire = async (pending: Promise<unknown>): Promise<void> => {
    await Promise.race([pending, expiry]);
    if (expired) {
      throw new PairingCompletionError(condition, `${detail}; deadline ${deadlineMs} ms elapsed`);
    }
  };

  let macrotaskTurns = 0;
  try {
    for (;;) {
      const before = tracker.snapshot();
      if (before.credsSaveFailure !== null) {
        throw new PairingCompletionError('creds-save-failed', errorMessage(before.credsSaveFailure.error), {
          cause: before.credsSaveFailure.error,
        });
      }
      if (before.keyStoreWriteFailure !== null) {
        throw new PairingCompletionError(
          'key-store-write-failed',
          `${before.keyStoreWriteFailure.seam}: ${errorMessage(before.keyStoreWriteFailure.error)}`,
          { cause: before.keyStoreWriteFailure.error },
        );
      }
      if (before.credsSavesPending > 0) {
        condition = 'creds-save-pending';
        detail = `${before.credsSavesPending} credential save(s) unsettled`;
        await waitOrExpire(tracker.nextActivity());
        continue;
      }
      if (before.keyStoreOpsInFlight > 0) {
        condition = 'key-store-quiescence';
        detail = `${before.keyStoreOpsInFlight} key-store operation(s) in flight`;
        await waitOrExpire(tracker.nextActivity());
        continue;
      }

      // Zero in flight now; it only counts if nothing starts before the next
      // macrotask. Baileys chains its post-open writes through nextTick and
      // microtasks, all of which run before setImmediate.
      condition = 'key-store-quiescence';
      detail = 'no idle macrotask turn observed';
      await waitOrExpire(timers.yieldMacrotask());
      macrotaskTurns += 1;
      if (tracker.snapshot().epoch !== before.epoch) continue;

      // Everything observable has settled. With incomplete tracking that is not
      // proof that every write settled, and no later state read can supply it.
      const tracking = tracker.keyStoreTracking();
      if (tracking !== 'full') {
        throw new PairingCompletionError(
          'key-store-tracking-incomplete',
          `key-store write tracking is ${tracking}; quiescence cannot be proven`,
        );
      }

      const plan = planOwnLidState(getCreds());
      if (plan.kind === 'not-applicable') {
        return {
          elapsedMs: clock.now() - startedAt,
          macrotaskTurns,
          keyStoreTracking: tracker.keyStoreTracking(),
          ownLidState: 'not-applicable',
        };
      }

      condition = 'own-lid-state';
      const read = tracker.readUntracked();
      let missing: string[];
      if (plan.kind === 'undecodable') {
        missing = ['own PN/LID identity not decodable'];
      } else if (read === null) {
        missing = ['key store has no readable get'];
      } else {
        detail = 'own LID state read did not complete';
        const reading = verifyOwnLidState(plan.expectation, read).then(
          (result) => result,
          (err: unknown) => [`key-store read failed: ${errorMessage(err)}`],
        );
        await waitOrExpire(reading);
        missing = await reading;
      }
      if (missing.length > 0) {
        // Not final: a write may still be scheduled behind a gap. Wait for the
        // next store activity, or let the deadline report this state.
        detail = `missing ${missing.join(', ')}`;
        await waitOrExpire(tracker.nextActivity());
        continue;
      }
      // The verification reads are untracked, so any activity seen here came from
      // someone else; re-establish quiescence before accepting the result.
      if (tracker.snapshot().epoch !== before.epoch) continue;
      return {
        elapsedMs: clock.now() - startedAt,
        macrotaskTurns,
        keyStoreTracking: tracker.keyStoreTracking(),
        ownLidState: 'verified',
      };
    }
  } finally {
    timers.clearTimeout(handle);
  }
}
