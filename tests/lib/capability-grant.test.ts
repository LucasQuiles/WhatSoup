import { describe, expect, it, vi } from 'vitest';

import {
  createCapabilityGrantManager,
  formatDurationMs,
  isAuthorizedToMutateGrants,
  parseDurationMs,
  type GrantAuthorization,
  type PolicyAdapter,
  type PolicySnapshot,
  type GrantStore,
  type GrantRecord,
} from '../../src/lib/capability-grant.ts';

// ─── Test fixtures ─────────────────────────────────────────────────────────

class FakePolicy implements PolicyAdapter {
  allow = new Set<string>();
  deny = new Set<string>();
  applyCount = 0;
  appliedDeltas: Array<{ addAllow: string[]; removeAllow: string[]; addDeny: string[]; removeDeny: string[] }> = [];

  async read(): Promise<PolicySnapshot> {
    return { allow: new Set(this.allow), deny: new Set(this.deny) };
  }
  async apply(delta: { addAllow: readonly string[]; removeAllow: readonly string[]; addDeny: readonly string[]; removeDeny: readonly string[] }): Promise<void> {
    this.applyCount++;
    this.appliedDeltas.push({
      addAllow: [...delta.addAllow],
      removeAllow: [...delta.removeAllow],
      addDeny: [...delta.addDeny],
      removeDeny: [...delta.removeDeny],
    });
    for (const c of delta.addAllow) this.allow.add(c);
    for (const c of delta.removeAllow) this.allow.delete(c);
    for (const c of delta.addDeny) this.deny.add(c);
    for (const c of delta.removeDeny) this.deny.delete(c);
  }
}

class FakeStore implements GrantStore {
  record: GrantRecord | null = null;
  writes = 0;
  async read(): Promise<GrantRecord | null> { return this.record; }
  async write(record: GrantRecord | null): Promise<void> {
    this.record = record;
    this.writes++;
  }
}

const ownerAuth: GrantAuthorization = { isOwner: true };
const adminAuth: GrantAuthorization = { scopes: ['admin'] };
const nonAdminAuth: GrantAuthorization = { scopes: ['user'] };
const unauthScoped: GrantAuthorization = { scopes: ['user'] };
const unauthUnscoped: GrantAuthorization = { isOwner: false };

function makeManager(opts: Partial<Parameters<typeof createCapabilityGrantManager>[0]> = {}) {
  const policy = opts.policy ?? new FakePolicy();
  const store = opts.store ?? new FakeStore();
  const manager = createCapabilityGrantManager({
    groups: {
      camera: { capabilities: ['camera.snap', 'camera.clip'] },
      writes: { capabilities: ['contacts.add', 'sms.send'] },
      all: { capabilities: ['camera.snap', 'camera.clip', 'contacts.add', 'sms.send'] },
    },
    policy,
    store,
    pollIntervalMs: 100,
    ...opts,
  });
  return { manager, policy: policy as FakePolicy, store: store as FakeStore };
}

// ─── parseDurationMs ───────────────────────────────────────────────────────

describe('parseDurationMs', () => {
  it('parses seconds', () => {
    expect(parseDurationMs('30s')).toBe(30_000);
  });
  it('parses minutes', () => {
    expect(parseDurationMs('5m')).toBe(300_000);
  });
  it('parses hours', () => {
    expect(parseDurationMs('2h')).toBe(7_200_000);
  });
  it('parses days', () => {
    expect(parseDurationMs('1d')).toBe(86_400_000);
  });
  it('returns null for invalid format', () => {
    expect(parseDurationMs('abc')).toBeNull();
    expect(parseDurationMs('30')).toBeNull();
    expect(parseDurationMs('30x')).toBeNull();
    expect(parseDurationMs('')).toBeNull();
  });
  it('returns null for zero', () => {
    expect(parseDurationMs('0s')).toBeNull();
    expect(parseDurationMs('0m')).toBeNull();
  });
  it('returns null for overflow beyond safe integer', () => {
    expect(parseDurationMs('9007199254740993d')).toBeNull();
  });
  it('trims whitespace', () => {
    expect(parseDurationMs('  30s  ')).toBe(30_000);
  });
});

// ─── formatDurationMs ──────────────────────────────────────────────────────

describe('formatDurationMs', () => {
  it('formats seconds', () => {
    expect(formatDurationMs(30_000)).toBe('30s');
  });
  it('formats minutes', () => {
    expect(formatDurationMs(300_000)).toBe('5m');
  });
  it('formats hours', () => {
    expect(formatDurationMs(7_200_000)).toBe('2h');
  });
  it('formats days', () => {
    expect(formatDurationMs(86_400_000)).toBe('1d');
  });
  it('handles zero', () => {
    expect(formatDurationMs(0)).toBe('0s');
  });
});

// ─── isAuthorizedToMutateGrants ────────────────────────────────────────────

describe('isAuthorizedToMutateGrants', () => {
  it('returns true when scopes include required scope', () => {
    expect(isAuthorizedToMutateGrants({ scopes: ['admin'] }, 'admin')).toBe(true);
    expect(isAuthorizedToMutateGrants({ scopes: ['user', 'admin'] }, 'admin')).toBe(true);
  });
  it('returns false when scopes do not include required scope', () => {
    expect(isAuthorizedToMutateGrants({ scopes: ['user'] }, 'admin')).toBe(false);
    expect(isAuthorizedToMutateGrants({ scopes: [] }, 'admin')).toBe(false);
  });
  it('falls back to isOwner when scopes is undefined', () => {
    expect(isAuthorizedToMutateGrants({ isOwner: true }, 'admin')).toBe(true);
    expect(isAuthorizedToMutateGrants({ isOwner: false }, 'admin')).toBe(false);
    expect(isAuthorizedToMutateGrants({}, 'admin')).toBe(false);
  });
  it('ignores isOwner when scopes is present (scope-first)', () => {
    // Even if owner, a non-admin scope is rejected
    expect(isAuthorizedToMutateGrants({ scopes: ['user'], isOwner: true }, 'admin')).toBe(false);
  });
});

// ─── createCapabilityGrantManager — arm ───────────────────────────────────

describe('createCapabilityGrantManager — arm', () => {
  it('rejects unauthorized callers', async () => {
    const { manager } = makeManager();
    const result = await manager.arm('camera', 60_000, nonAdminAuth);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('admin');
  });

  it('rejects unknown group', async () => {
    const { manager } = makeManager();
    const result = await manager.arm('nonexistent', 60_000, ownerAuth);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unknown group');
  });

  it('rejects duration overflow', async () => {
    const { manager } = makeManager();
    const result = await manager.arm('camera', 9e15, ownerAuth);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('overflow');
  });

  it('rejects zero duration fail-closed (no privileged window, no state mutation)', async () => {
    const { manager, policy, store } = makeManager();
    const result = await manager.arm('camera', 0, ownerAuth);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('duration');
    // A rejected arm must not touch the policy or persist a record.
    expect(store.record).toBeNull();
    expect(store.writes).toBe(0);
    expect(policy.applyCount).toBe(0);
  });

  it('rejects negative and non-finite durations fail-closed', async () => {
    const { manager, policy } = makeManager();
    for (const bad of [-1000, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      const result = await manager.arm('camera', bad, ownerAuth);
      expect(result.ok).toBe(false);
    }
    expect(policy.applyCount).toBe(0);
  });

  it('adds capabilities to allow and removes from deny', async () => {
    const { manager, policy } = makeManager();
    // Pre-populate deny
    policy.deny.add('camera.snap');
    policy.deny.add('camera.clip');

    const result = await manager.arm('camera', 60_000, ownerAuth);
    expect(result.ok).toBe(true);
    expect(policy.allow.has('camera.snap')).toBe(true);
    expect(policy.allow.has('camera.clip')).toBe(true);
    expect(policy.deny.has('camera.snap')).toBe(false);
    expect(policy.deny.has('camera.clip')).toBe(false);
  });

  it('records the diff accurately', async () => {
    const { manager, policy, store } = makeManager();
    policy.deny.add('camera.snap');

    const result = await manager.arm('camera', 60_000, ownerAuth);
    if (!result.ok) throw new Error('expected ok');
    expect(result.record.addedToAllow).toEqual(['camera.clip', 'camera.snap']);
    expect(result.record.removedFromDeny).toEqual(['camera.snap']);
    expect(store.record).not.toBeNull();
  });

  it('supports manual-only grants (durationMs = null)', async () => {
    const { manager, store } = makeManager();
    const result = await manager.arm('camera', null, ownerAuth);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.record.expiresAtMs).toBeNull();
    expect(store.record?.expiresAtMs).toBeNull();
    expect(result.record.group).toBe('camera');
  });

  it('supersedes an existing grant (reverts diff first)', async () => {
    const { manager, policy } = makeManager();
    await manager.arm('camera', 60_000, ownerAuth);
    expect(policy.allow.has('camera.snap')).toBe(true);
    // Arm a different group
    await manager.arm('writes', 60_000, ownerAuth);
    // camera capabilities should have been reverted
    expect(policy.allow.has('camera.snap')).toBe(false);
    expect(policy.allow.has('sms.send')).toBe(true);
  });

  it('does not add capabilities already allowed', async () => {
    const { manager, policy, store } = makeManager();
    policy.allow.add('camera.snap');
    const result = await manager.arm('camera', 60_000, ownerAuth);
    if (!result.ok) throw new Error('expected ok');
    expect(result.record.addedToAllow).toEqual(['camera.clip']);
  });
});

// ─── disarm ────────────────────────────────────────────────────────────────

describe('createCapabilityGrantManager — disarm', () => {
  it('reverts the exact diff recorded in the grant', async () => {
    const { manager, policy } = makeManager();
    policy.deny.add('camera.snap');
    await manager.arm('camera', 60_000, ownerAuth);
    expect(policy.allow.has('camera.snap')).toBe(true);
    expect(policy.deny.has('camera.snap')).toBe(false);

    const result = await manager.disarm(ownerAuth);
    expect(result.changed).toBe(true);
    expect(policy.allow.has('camera.snap')).toBe(false);
    expect(policy.allow.has('camera.clip')).toBe(false);
    expect(policy.deny.has('camera.snap')).toBe(true);
  });

  it('is idempotent when not armed', async () => {
    const { manager } = makeManager();
    const result = await manager.disarm(ownerAuth);
    expect(result.changed).toBe(false);
    expect(result.removed).toEqual([]);
    expect(result.restored).toEqual([]);
  });

  it('rejects unauthorized callers', async () => {
    const { manager } = makeManager();
    await manager.arm('camera', 60_000, ownerAuth);
    const result = await manager.disarm(nonAdminAuth);
    expect(result.changed).toBe(false);
  });

  it('reports an unauthorized disarm distinguishably (not a silent manual no-op)', async () => {
    const { manager, policy } = makeManager();
    await manager.arm('camera', 60_000, ownerAuth);
    const result = await manager.disarm(nonAdminAuth);
    // Fails closed (grant stays armed) AND is distinguishable from a legit no-op.
    expect(result.reason).toBe('unauthorized');
    expect(policy.allow.has('camera.snap')).toBe(true);
  });

  it('a legitimate no-op disarm still reports reason "manual"', async () => {
    const { manager } = makeManager();
    const result = await manager.disarm(ownerAuth); // authorized, nothing armed
    expect(result.changed).toBe(false);
    expect(result.reason).toBe('manual');
  });

  it('clears the store record after disarm', async () => {
    const { manager, store } = makeManager();
    await manager.arm('camera', 60_000, ownerAuth);
    expect(store.record).not.toBeNull();
    await manager.disarm(ownerAuth);
    expect(store.record).toBeNull();
    expect(store.writes).toBeGreaterThanOrEqual(2); // arm + disarm-clear
  });

  it('fires onDisarm callback', async () => {
    const onDisarm = vi.fn();
    const { manager } = makeManager({ onDisarm });
    await manager.arm('camera', 60_000, ownerAuth);
    await manager.disarm(ownerAuth);
    expect(onDisarm).toHaveBeenCalledTimes(1);
    expect(onDisarm).toHaveBeenCalledWith(expect.objectContaining({ reason: 'manual' }));
  });
});

// ─── status ────────────────────────────────────────────────────────────────

describe('createCapabilityGrantManager — status', () => {
  it('returns disarmed when not armed', async () => {
    const { manager } = makeManager();
    const s = await manager.status();
    expect(s.armed).toBe(false);
  });

  it('returns armed with group and capabilities', async () => {
    const { manager } = makeManager();
    await manager.arm('camera', 60_000, ownerAuth);
    const s = await manager.status();
    expect(s.armed).toBe(true);
    expect(s.group).toBe('camera');
    expect(s.capabilities).toEqual(expect.arrayContaining(['camera.snap', 'camera.clip']));
  });

  it('returns remainingMs for TTL grants', async () => {
    let fakeNow = 1000;
    const { manager } = makeManager({ now: () => fakeNow });
    await manager.arm('camera', 60_000, ownerAuth);
    fakeNow = 30_000;
    const s = await manager.status();
    expect(s.remainingMs).toBe(31_000); // 61000 - 30000
  });

  it('returns null remainingMs for manual-only grants', async () => {
    const { manager } = makeManager();
    await manager.arm('camera', null, ownerAuth);
    const s = await manager.status();
    expect(s.remainingMs).toBeNull();
    expect(s.expiresAtMs).toBeNull();
    expect(s.armed).toBe(true);
    expect(s.group).toBe('camera');
  });
});

// ─── expiry poll ───────────────────────────────────────────────────────────

describe('createCapabilityGrantManager — expiry', () => {
  it('auto-disarms on expiry via poll', async () => {
    vi.useFakeTimers();
    let fakeNow = 1000;
    const onDisarm = vi.fn();
    const { manager, policy } = makeManager({
      now: () => fakeNow,
      pollIntervalMs: 50,
      onDisarm,
    });

    await manager.arm('camera', 200, ownerAuth); // expires at 1200
    expect(policy.allow.has('camera.snap')).toBe(true);

    await manager.reconcile();
    // Advance past expiry + poll
    fakeNow = 2000;
    await vi.advanceTimersByTimeAsync(100);

    expect(policy.allow.has('camera.snap')).toBe(false);
    expect(onDisarm).toHaveBeenCalledWith(expect.objectContaining({ reason: 'expired' }));
    manager.stop();
    vi.useRealTimers();
  });

  it('does not disarm before expiry', async () => {
    vi.useFakeTimers();
    let fakeNow = 1000;
    const { manager, policy } = makeManager({
      now: () => fakeNow,
      pollIntervalMs: 50,
    });

    await manager.arm('camera', 60_000, ownerAuth);
    await manager.reconcile();
    fakeNow = 10_000; // 9s in, expires at 61000
    await vi.advanceTimersByTimeAsync(100);
    expect(policy.allow.has('camera.snap')).toBe(true);
    manager.stop();
    vi.useRealTimers();
  });

  it('does not auto-disarm manual-only grants', async () => {
    vi.useFakeTimers();
    let fakeNow = 1000;
    const { manager, policy } = makeManager({
      now: () => fakeNow,
      pollIntervalMs: 50,
    });

    await manager.arm('camera', null, ownerAuth);
    await manager.reconcile();
    fakeNow = 1_000_000;
    await vi.advanceTimersByTimeAsync(200);
    expect(policy.allow.has('camera.snap')).toBe(true);
    manager.stop();
    vi.useRealTimers();
  });

  it('auto-disarms a timed grant even when reconcile() was never called (arm starts the poller)', async () => {
    vi.useFakeTimers();
    let fakeNow = 1000;
    const onDisarm = vi.fn();
    const { manager, policy } = makeManager({
      now: () => fakeNow,
      pollIntervalMs: 50,
      onDisarm,
    });

    // Arm a timed grant but deliberately do NOT call reconcile(). A wiring path
    // that arms without a prior reconcile() must still get expiry — otherwise the
    // privileged window never closes (fail-open).
    await manager.arm('camera', 200, ownerAuth); // expires at 1200
    expect(policy.allow.has('camera.snap')).toBe(true);

    fakeNow = 2000;
    await vi.advanceTimersByTimeAsync(100);

    expect(policy.allow.has('camera.snap')).toBe(false);
    expect(onDisarm).toHaveBeenCalledWith(expect.objectContaining({ reason: 'expired' }));
    manager.stop();
    vi.useRealTimers();
  });
});

// ─── reconcile ─────────────────────────────────────────────────────────────

describe('createCapabilityGrantManager — reconcile', () => {
  it('reverts expired grants on startup', async () => {
    const policy = new FakePolicy();
    const store = new FakeStore();
    // Simulate a crashed process: grant persisted, now expired
    store.record = {
      version: 2,
      armedAtMs: 1000,
      expiresAtMs: 2000,
      group: 'camera',
      capabilities: ['camera.clip', 'camera.snap'],
      addedToAllow: ['camera.clip', 'camera.snap'],
      removedFromDeny: [],
    };
    // Policy was left in the armed state
    policy.allow.add('camera.clip');
    policy.allow.add('camera.snap');

    const now = () => 10_000; // well past expiry
    const manager = createCapabilityGrantManager({
      groups: { camera: { capabilities: ['camera.snap', 'camera.clip'] } },
      policy,
      store,
      now,
    });

    const result = await manager.reconcile();
    expect(result).not.toBeNull();
    expect(result?.changed).toBe(true);
    expect(policy.allow.has('camera.snap')).toBe(false);
    expect(store.record).toBeNull();
    manager.stop();
  });

  it('preserves active (non-expired) grants on startup', async () => {
    const policy = new FakePolicy();
    const store = new FakeStore();
    store.record = {
      version: 2,
      armedAtMs: 1000,
      expiresAtMs: 1_000_000,
      group: 'camera',
      capabilities: ['camera.clip', 'camera.snap'],
      addedToAllow: ['camera.clip', 'camera.snap'],
      removedFromDeny: [],
    };
    policy.allow.add('camera.clip');
    policy.allow.add('camera.snap');

    const now = () => 5000; // before expiry
    const manager = createCapabilityGrantManager({
      groups: { camera: { capabilities: ['camera.snap', 'camera.clip'] } },
      policy,
      store,
      now,
    });

    const result = await manager.reconcile();
    expect(result).toBeNull();
    expect(policy.allow.has('camera.snap')).toBe(true);
    manager.stop();
  });

  it('is a no-op when no grant is persisted', async () => {
    const { manager } = makeManager();
    const result = await manager.reconcile();
    expect(result).toBeNull();
    manager.stop();
  });
});

// ─── stop ──────────────────────────────────────────────────────────────────

describe('createCapabilityGrantManager — stop', () => {
  it('stops the poll timer', async () => {
    vi.useFakeTimers();
    const { manager, policy } = makeManager({ pollIntervalMs: 50 });
    await manager.arm('camera', 100, ownerAuth);
    await manager.reconcile();
    manager.stop();
    // Even after advancing time past expiry, no disarm happens
    await vi.advanceTimersByTimeAsync(500);
    expect(policy.allow.has('camera.snap')).toBe(true);
    vi.useRealTimers();
  });
});
