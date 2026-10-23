import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import { SessionOwnershipRegistry } from '../../../src/runtimes/agent/session-ownership.ts';
import type {
  SessionManager,
  SessionProcessTreeTerminationLease,
} from '../../../src/runtimes/agent/session.ts';

const { alive, births } = vi.hoisted(() => ({
  alive: new Map<number, boolean | Error>(),
  births: new Map<number, string | null>(),
}));

vi.mock('../../../src/runtimes/agent/runtime-predicates.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/runtimes/agent/runtime-predicates.ts')>(),
  isProcessAlive: (pid: number) => {
    const observed = alive.get(pid);
    if (observed instanceof Error) throw observed;
    return observed ?? false;
  },
}));

vi.mock('../../../src/lib/process-identity.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/lib/process-identity.ts')>(),
  probeProcessBirthToken: (pid: number) => births.get(pid) ?? null,
}));

interface ResetRuntime {
  resetOwnedPerChatSession(key: string, chatJid: string, session: SessionManager): Promise<void>;
}

function makeLease(pid: number): SessionProcessTreeTerminationLease {
  return {
    target: { pid, exitCode: null, signalCode: null, kill: () => false },
    rootAuthority: { pid, parentPid: process.pid, birthToken: `birth:${pid}` },
    generationMarker: `generation:${pid}`,
  };
}

function resetFixture(options: {
  oldPid?: number | null;
  oldLease?: SessionProcessTreeTerminationLease | null;
  failReplacement?: boolean;
} = {}) {
  const oldPid = options.oldPid === undefined ? 42 : options.oldPid;
  let currentPid = oldPid;
  let currentLease = options.oldLease === undefined
    ? oldPid === null ? null : makeLease(oldPid)
    : options.oldLease;
  let replacements = 0;
  const session = {
    getStatus: () => ({ pid: currentPid, providerTerminated: currentPid === null }),
    getProcessTreeTerminationLease: () => currentLease,
    shutdown: async () => {
      currentPid = null;
      currentLease = null;
    },
    spawnSession: async () => {
      replacements += 1;
      currentPid = 84;
      currentLease = makeLease(84);
      if (options.failReplacement) throw new Error('replacement initialization failed');
    },
  } as unknown as SessionManager;
  const ownership = new SessionOwnershipRegistry();
  ownership.claim('chat', 'manager');
  ownership.transition('chat', 'manager', 'active');
  const runtime = Object.create(AgentRuntime.prototype) as ResetRuntime;
  Object.assign(runtime, {
    chatSessions: new Map([['chat', session]]),
    chatQueues: new Map(),
    operationTrackers: new Map(),
    sessionManagerIds: new WeakMap([[session, 'manager']]),
    sessionOwnership: ownership,
    rejectedTerminalTeardowns: new WeakMap(),
    heldCloseFailedNotices: new WeakSet(),
    getQueueForChat: () => null,
    cleanupPerChatGenerationState: () => {},
    createOutboundQueue: () => ({}),
    createOperationTracker: () => null,
  });
  return {
    ownership,
    replacements: () => replacements,
    reset: () => runtime.resetOwnedPerChatSession('chat', 'chat@s.whatsapp.net', session),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  alive.clear();
  births.clear();
});

afterEach(() => vi.useRealTimers());

describe('reset exit proof retains the captured process identity', () => {
  it.each([
    { name: 'the captured process is absent', live: false, birth: null },
    { name: 'the PID belongs to a later incarnation', live: true, birth: 'birth:replacement' },
  ])('starts the next generation when $name', async ({ live, birth }) => {
    alive.set(42, live);
    births.set(42, birth);
    const fixture = resetFixture();
    const result = fixture.reset().then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(6_100);

    expect(await result).toBeNull();
    expect(fixture.ownership.get('chat')).toMatchObject({ generation: 2, state: 'active' });
    expect(fixture.replacements()).toBe(1);
  });

  it.each([
    { name: 'the captured identity survives', birth: 'birth:42', lease: makeLease(42) },
    { name: 'birth observation is unavailable', birth: null, lease: makeLease(42) },
    { name: 'the captured lease is absent', birth: 'birth:42', lease: null },
    { name: 'the lease belongs to a different PID', birth: 'birth:42', lease: makeLease(99) },
  ])('keeps the generation closed when $name', async ({ birth, lease }) => {
    alive.set(42, true);
    births.set(42, birth);
    const fixture = resetFixture({ oldLease: lease });
    const result = fixture.reset().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(6_100);

    expect(await result).toBeInstanceOf(Error);
    expect(fixture.ownership.get('chat')).toMatchObject({ generation: 2, state: 'closing' });
    expect(fixture.replacements()).toBe(0);
  });

  it('accepts the terminal captured child handle even when the PID has been reused', async () => {
    alive.set(42, true);
    const lease = makeLease(42);
    Object.assign(lease.target, { exitCode: 0 });
    const fixture = resetFixture({ oldLease: lease });
    const result = fixture.reset().then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(6_100);

    expect(await result).toBeNull();
    expect(fixture.ownership.get('chat')).toMatchObject({ state: 'active' });
    expect(fixture.replacements()).toBe(1);
  });

  it.each([
    { exitCode: 0, signalCode: null },
    { exitCode: null, signalCode: 'SIGTERM' },
  ])('retains terminal handle proof when the reused PID probe would throw EPERM: %j', async (terminal) => {
    alive.set(42, Object.assign(new Error('kill EPERM'), { code: 'EPERM' }));
    const lease = makeLease(42);
    Object.assign(lease.target, terminal);
    const fixture = resetFixture({ oldLease: lease, failReplacement: true });

    await expect(fixture.reset()).rejects.toThrow('replacement initialization failed');

    expect(fixture.ownership.get('chat')).toMatchObject({ generation: 2, state: 'recoverable_dead' });
    expect(fixture.replacements()).toBe(1);
  });

  it.each([
    { name: 'survives', birth: 'birth:84', state: 'closing' },
    { name: 'is unverified', birth: null, state: 'closing' },
    { name: 'has been replaced by another process', birth: 'birth:later', state: 'recoverable_dead' },
  ])('classifies failed replacement cleanup when its captured identity $name', async ({ birth, state }) => {
    alive.set(84, true);
    births.set(84, birth);
    const fixture = resetFixture({ failReplacement: true });
    await expect(fixture.reset()).rejects.toThrow('replacement initialization failed');

    expect(fixture.ownership.get('chat')).toMatchObject({ generation: 2, state });
    expect(fixture.replacements()).toBe(1);
  });
});
