/**
 * Pins the pairing-completion gate (src/transport/pairing-completion.ts).
 *
 * The pairing CLI used to exit as soon as `saveCreds()` resolved, while Baileys
 * was still running its post-'open' `process.nextTick` block (own LID<->PN
 * mapping, own device-list, own-session migration). These tests drive the gate
 * against an in-memory key store whose writes span real macrotask turns, as disk
 * writes do, and assert on observed state:
 *   - the gate resolves only after a write scheduled via process.nextTick landed;
 *   - every unmet condition becomes a typed rejection that names it;
 *   - a store that refuses wrapping degrades without throwing and the gate then
 *     depends on the own-LID state check.
 *
 * Not covered here: whether WhatsApp accepts the next connection. That requires
 * a live-line reconnect qualification.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  awaitPairingCompletion,
  createPairingWriteTracker,
  PairingCompletionError,
  type PairingCompletionTimers,
  type PairingWriteTracker,
} from '../../src/transport/pairing-completion.ts';
import { deferred } from '../helpers/deferred.ts';

// Own identity fixtures. Device 7 on both: transferDevice keeps the PN device.
const PN_ID = '15550000003:7@s.whatsapp.net';
const PN_USER = '15550000003';
const LID_ID = '11111110000402:7@lid';
const LID_USER = '11111110000402';
const PN_SESSION = `${PN_USER}.7`;
const LID_SESSION = `${LID_USER}_1.7`;

type KeyData = Record<string, Record<string, unknown>>;

const macrotask = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

/**
 * In-memory stand-in for useMultiFileAuthState's key store. Each operation
 * spans two macrotask turns, like file I/O, so a gate that only drained
 * microtasks would resolve while a write is still in flight.
 */
function memoryKeyStore(initial: KeyData = {}) {
  const data = new Map<string, unknown>();
  for (const [type, entries] of Object.entries(initial)) {
    for (const [id, value] of Object.entries(entries)) data.set(`${type}/${id}`, value);
  }
  const store = {
    async get(type: string, ids: string[]): Promise<Record<string, unknown>> {
      await macrotask();
      await macrotask();
      const out: Record<string, unknown> = {};
      for (const id of ids) out[id] = data.get(`${type}/${id}`) ?? null;
      return out;
    },
    async set(update: KeyData): Promise<void> {
      await macrotask();
      await macrotask();
      for (const [type, entries] of Object.entries(update)) {
        for (const [id, value] of Object.entries(entries)) {
          if (value === null) data.delete(`${type}/${id}`);
          else data.set(`${type}/${id}`, value);
        }
      }
    },
  };
  return { store, data };
}

/** Deadline under test control; the macrotask yield stays real. */
function controlledDeadline() {
  let armed: (() => void) | null = null;
  const timers: PairingCompletionTimers = {
    setTimeout: (fn) => {
      armed = fn;
      return 'deadline';
    },
    clearTimeout: () => {
      armed = null;
    },
    yieldMacrotask: macrotask,
  };
  return {
    timers,
    isArmed: (): boolean => armed !== null,
    fire: (): void => {
      const fn = armed;
      armed = null;
      fn?.();
    },
  };
}

function lidCreds() {
  return { me: { id: PN_ID, lid: LID_ID } };
}

/** The writes Baileys' CB:success nextTick block performs on a fresh pairing. */
function ownLidWrites(): KeyData[] {
  return [
    { 'lid-mapping': { [PN_USER]: LID_USER, [`${LID_USER}_reverse`]: PN_USER } },
    { 'device-list': { [PN_USER]: ['7'] } },
  ];
}

async function settleTurns(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await macrotask();
}

function track(store: object, tracker: PairingWriteTracker = createPairingWriteTracker()) {
  tracker.wrapKeyStore(store);
  return tracker;
}

async function expectCompletionError(
  gate: Promise<unknown>,
): Promise<PairingCompletionError> {
  const err = await gate.then(
    () => { throw new Error('the gate resolved, but a rejection was expected'); },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PairingCompletionError);
  return err as PairingCompletionError;
}

describe('awaitPairingCompletion', () => {
  it('without a LID, completes after one quiescent macrotask turn and disarms the deadline', async () => {
    const { store } = memoryKeyStore();
    const tracker = track(store);
    const deadline = controlledDeadline();

    const report = await awaitPairingCompletion({ tracker, getCreds: () => ({}), timers: deadline.timers });

    expect(report.ownLidState).toBe('not-applicable');
    expect(report.keyStoreTracking).toBe('full');
    expect(report.macrotaskTurns).toBeGreaterThanOrEqual(1);
    expect(deadline.isArmed()).toBe(false);
  });

  it('does not resolve until a key-store set scheduled via process.nextTick has landed', async () => {
    const { store, data } = memoryKeyStore();
    const tracker = track(store);
    const deadline = controlledDeadline();
    let landed = false;
    let landedWhenResolved: boolean | undefined;

    const gate = awaitPairingCompletion({ tracker, getCreds: () => ({}), timers: deadline.timers })
      .then((report) => {
        landedWhenResolved = landed;
        return report;
      });
    // Same shape as socket.js CB:success: the write starts on a later tick and
    // nobody awaits it.
    process.nextTick(() => {
      void store.set({ 'device-list': { [PN_USER]: ['7'] } }).then(() => { landed = true; });
    });

    await gate;
    expect(landedWhenResolved).toBe(true);
    expect(data.get(`device-list/${PN_USER}`)).toEqual(['7']);
  });

  it('re-checks quiescence after each settle when writes are chained', async () => {
    const { store } = memoryKeyStore();
    const tracker = track(store);
    const deadline = controlledDeadline();
    const order: string[] = [];

    const gate = awaitPairingCompletion({ tracker, getCreds: () => ({}), timers: deadline.timers })
      .then(() => { order.push('gate'); });
    process.nextTick(() => {
      void (async () => {
        // Each write starts in the microtask continuation of the previous one.
        for (const write of ownLidWrites()) await store.set(write);
        order.push('writes');
      })();
    });

    await gate;
    expect(order).toEqual(['writes', 'gate']);
  });

  it('waits for an unsettled credential save and resolves once it settles', async () => {
    const { store } = memoryKeyStore();
    const tracker = track(store);
    const deadline = controlledDeadline();
    const save = deferred<void>();
    const trackedSave = tracker.trackCredsSave(() => save.promise);
    let resolved = false;

    void trackedSave();
    const gate = awaitPairingCompletion({ tracker, getCreds: () => ({}), timers: deadline.timers })
      .then(() => { resolved = true; });
    await settleTurns(5);
    expect(resolved).toBe(false);

    save.resolve();
    await gate;
    expect(resolved).toBe(true);
  });

  it('rejects with creds-save-failed when a pending credential save rejects', async () => {
    const { store } = memoryKeyStore();
    const tracker = track(store);
    const deadline = controlledDeadline();
    const save = deferred<void>();
    const trackedSave = tracker.trackCredsSave(() => save.promise);

    // The caller still receives the original rejection and handles it itself.
    const callerSaw = trackedSave().then(() => 'resolved', (e: unknown) => e);
    const gate = awaitPairingCompletion({ tracker, getCreds: () => ({}), timers: deadline.timers });
    await settleTurns(2);
    save.reject(new Error('ENOSPC: no space left on device'));

    const err = await expectCompletionError(gate);
    expect(err.condition).toBe('creds-save-failed');
    expect(err.message).toMatch(/^pairing did not reach a durable state: creds-save-failed/);
    expect(err.message).toContain('ENOSPC');
    expect(await callerSaw).toBeInstanceOf(Error);
    expect(deadline.isArmed()).toBe(false);
  });

  it('rejects with creds-save-pending when a credential save never settles before the deadline', async () => {
    const { store } = memoryKeyStore();
    const tracker = track(store);
    const deadline = controlledDeadline();
    void tracker.trackCredsSave(() => new Promise<void>(() => {}))();

    const gate = awaitPairingCompletion({ tracker, getCreds: () => ({}), timers: deadline.timers });
    await settleTurns(3);
    deadline.fire();

    const err = await expectCompletionError(gate);
    expect(err.condition).toBe('creds-save-pending');
  });

  it('rejects naming key-store quiescence when a key write never resolves', async () => {
    const tracker = createPairingWriteTracker();
    const store = {
      get: async () => ({}),
      set: (): Promise<void> => new Promise<void>(() => {}),
    };
    tracker.wrapKeyStore(store);
    const deadline = controlledDeadline();

    void store.set();
    const gate = awaitPairingCompletion({ tracker, getCreds: () => ({}), timers: deadline.timers });
    let settled = false;
    void gate.then(() => { settled = true; }, () => { settled = true; });
    await settleTurns(5);
    expect(settled).toBe(false);

    deadline.fire();
    const err = await expectCompletionError(gate);
    expect(err.condition).toBe('key-store-quiescence');
    expect(err.detail).toContain('1 key-store operation(s) in flight');
    expect(err.message).toMatch(/^pairing did not reach a durable state: key-store-quiescence/);
  });

  it('rejects with key-store-write-failed when a tracked write rejects', async () => {
    const tracker = createPairingWriteTracker();
    const store = {
      get: async () => ({}),
      set: async (): Promise<void> => { throw new Error('EACCES: permission denied'); },
    };
    tracker.wrapKeyStore(store);
    const deadline = controlledDeadline();

    const writeSaw = store.set().then(() => 'resolved', (e: unknown) => e);
    const err = await expectCompletionError(
      awaitPairingCompletion({ tracker, getCreds: () => ({}), timers: deadline.timers }),
    );
    expect(err.condition).toBe('key-store-write-failed');
    expect(err.detail).toContain('set');
    // The wrapper does not swallow the failure from Baileys either.
    expect(await writeSaw).toBeInstanceOf(Error);
  });

  it('does not treat a rejected read as a failed write', async () => {
    const tracker = createPairingWriteTracker();
    const store = {
      get: async (): Promise<Record<string, unknown>> => { throw new Error('EIO'); },
      set: async (): Promise<void> => {},
    };
    tracker.wrapKeyStore(store);
    const deadline = controlledDeadline();

    await store.get().catch(() => 'read failed');
    const report = await awaitPairingCompletion({ tracker, getCreds: () => ({}), timers: deadline.timers });
    expect(report.ownLidState).toBe('not-applicable');
  });

  describe('own LID state check (creds.me.lid set)', () => {
    it('verifies the own LID-PN mapping and own device-list written after open', async () => {
      const { store } = memoryKeyStore();
      const tracker = track(store);
      const deadline = controlledDeadline();

      const gate = awaitPairingCompletion({ tracker, getCreds: lidCreds, timers: deadline.timers });
      process.nextTick(() => {
        void (async () => {
          for (const write of ownLidWrites()) await store.set(write);
        })();
      });

      const report = await gate;
      expect(report.ownLidState).toBe('verified');
    });

    it('rejects naming the state check when the own entries are missing after quiescence', async () => {
      const { store } = memoryKeyStore();
      const tracker = track(store);
      const deadline = controlledDeadline();

      const gate = awaitPairingCompletion({ tracker, getCreds: lidCreds, timers: deadline.timers });
      let settled = false;
      void gate.then(() => { settled = true; }, () => { settled = true; });
      await settleTurns(20);
      // Quiescent and incomplete: the gate keeps waiting rather than passing.
      expect(settled).toBe(false);

      deadline.fire();
      const err = await expectCompletionError(gate);
      expect(err.condition).toBe('own-lid-state');
      expect(err.detail).toContain('own device-list entry');
      expect(err.detail).toContain('own LID-PN mapping');
      // Identities stay out of the operator-facing message.
      expect(err.message).not.toContain(PN_USER);
      expect(err.message).not.toContain(LID_USER);
    });

    it('keeps waiting through a quiet gap and resolves when the remaining write lands', async () => {
      const { store } = memoryKeyStore();
      const tracker = track(store);
      const deadline = controlledDeadline();
      const [mapping, deviceList] = ownLidWrites();
      const release = deferred<void>();

      const gate = awaitPairingCompletion({ tracker, getCreds: lidCreds, timers: deadline.timers });
      void (async () => {
        await store.set(mapping!);
        // A gap with nothing in flight: quiescence is observed, the state is not.
        await release.promise;
        await store.set(deviceList!);
      })();
      await settleTurns(15);

      release.resolve();
      const report = await gate;
      expect(report.ownLidState).toBe('verified');
    });

    it('requires the own LID session when an own PN session exists to migrate', async () => {
      const { store } = memoryKeyStore({
        ...Object.assign({}, ...ownLidWrites()),
        session: { [PN_SESSION]: new Uint8Array([1]) },
      });
      const tracker = track(store);
      const deadline = controlledDeadline();

      const gate = awaitPairingCompletion({ tracker, getCreds: lidCreds, timers: deadline.timers });
      await settleTurns(20);
      deadline.fire();

      const err = await expectCompletionError(gate);
      expect(err.condition).toBe('own-lid-state');
      expect(err.detail).toContain('own LID session');
    });

    it('accepts a migrated own session (LID present, PN removed)', async () => {
      const { store } = memoryKeyStore(Object.assign({}, ...ownLidWrites()));
      const tracker = track(store);
      const deadline = controlledDeadline();
      void store.set({ session: { [PN_SESSION]: new Uint8Array([1]) } });

      const gate = awaitPairingCompletion({ tracker, getCreds: lidCreds, timers: deadline.timers });
      process.nextTick(() => {
        // migrateSession's single bulk write (libsignal.js:286-294).
        void store.set({ session: { [LID_SESSION]: new Uint8Array([1]), [PN_SESSION]: null } });
      });

      const report = await gate;
      expect(report.ownLidState).toBe('verified');
    });
  });

  describe('wrapper refusal', () => {
    it('degrades without throwing on a frozen store and then relies on the state check', async () => {
      const { store } = memoryKeyStore(Object.assign({}, ...ownLidWrites()));
      const frozen = Object.freeze({ get: store.get, set: store.set });
      const onSeamRefused = vi.fn();
      const tracker = createPairingWriteTracker({ onSeamRefused });

      expect(() => tracker.wrapKeyStore(frozen)).not.toThrow();
      expect(onSeamRefused.mock.calls.map(([seam]) => seam)).toEqual(['get', 'set']);
      expect(tracker.keyStoreTracking()).toBe('none');

      const deadline = controlledDeadline();
      const report = await awaitPairingCompletion({ tracker, getCreds: lidCreds, timers: deadline.timers });
      expect(report.keyStoreTracking).toBe('none');
      expect(report.ownLidState).toBe('verified');
    });

    it('still rejects on a frozen store when the own LID state is missing', async () => {
      const { store } = memoryKeyStore();
      const frozen = Object.freeze({ get: store.get, set: store.set });
      const tracker = createPairingWriteTracker({ onSeamRefused: vi.fn() });
      tracker.wrapKeyStore(frozen);
      const deadline = controlledDeadline();

      const gate = awaitPairingCompletion({ tracker, getCreds: lidCreds, timers: deadline.timers });
      await settleTurns(20);
      deadline.fire();

      const err = await expectCompletionError(gate);
      expect(err.condition).toBe('own-lid-state');
    });
  });

  it('tracks a key-store transaction for its whole duration', async () => {
    const tracker = createPairingWriteTracker();
    const work = deferred<void>();
    const store = {
      get: async () => ({}),
      set: async (): Promise<void> => {},
      transaction: (exec: () => Promise<void>): Promise<void> => exec(),
    };
    tracker.wrapKeyStore(store);
    const deadline = controlledDeadline();
    let resolved = false;

    void store.transaction(() => work.promise);
    const gate = awaitPairingCompletion({ tracker, getCreds: () => ({}), timers: deadline.timers })
      .then(() => { resolved = true; });
    await settleTurns(5);
    expect(resolved).toBe(false);
    expect(tracker.snapshot().keyStoreOpsInFlight).toBe(1);

    work.resolve();
    await gate;
    expect(resolved).toBe(true);
  });
});
