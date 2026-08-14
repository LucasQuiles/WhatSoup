/**
 * Round-22 AE1 adapter: the operator drop-file trigger + the live session
 * activation closure. The trigger's fail-closed properties are the point:
 * consume-before-act, TTL, schema validation, symlink refusal, per-cycle
 * bound — and the activation closure's post-condition is the SAME dispatch
 * predicate the supervisor uses, never the session flag alone.
 */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildLiveActivateSession,
  drainNowRequestDirForDbPath,
  serviceDrainNowRequests,
  writeDrainNowRequest,
  type ActivatableSession,
  type DrainNowRequest,
  type SessionActivationPorts,
} from '../../../src/runtimes/agent/capability-obligation-drain-now-service.ts';

let dir: string;
const NOW = 1_800_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ws-drain-now-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function validRequest(obligationId: number, over: Partial<DrainNowRequest> = {}): DrainNowRequest {
  return {
    obligationId,
    requestedAtUnixSec: NOW - 10,
    requestedBy: 'operator-test',
    nonce: 'nonce-0123456789',
    ...over,
  };
}

function dropRequest(obligationId: number, over: Partial<DrainNowRequest> = {}): string {
  const path = join(dir, `${obligationId}.json`);
  writeFileSync(path, JSON.stringify(validRequest(obligationId, over)));
  return path;
}

function collectingDrain(): { calls: number[]; drain: (id: number) => Promise<{ activated: true }> } {
  const calls: number[] = [];
  return {
    calls,
    drain: async (id: number) => {
      calls.push(id);
      return { activated: true as const };
    },
  };
}

describe('drainNowRequestDirForDbPath', () => {
  it('derives a sibling capability-drain-now dir from the db path', () => {
    expect(drainNowRequestDirForDbPath('/var/lib/ws/bot.db')).toBe('/var/lib/ws/capability-drain-now');
  });
  it('an in-memory db has no drop dir (servicing inert)', () => {
    expect(drainNowRequestDirForDbPath(':memory:')).toBeNull();
  });
});

describe('serviceDrainNowRequests', () => {
  it('services a valid request: consumes (renames) it, drains, and records the outcome', async () => {
    dropRequest(41);
    const { calls, drain } = collectingDrain();
    const outcomes = await serviceDrainNowRequests({ requestDir: dir, drain, nowUnixSec: () => NOW });
    expect(outcomes).toEqual([{ kind: 'drained', obligationId: 41, file: '41.json' }]);
    expect(calls).toEqual([41]);
    const names = readdirSync(dir).sort();
    expect(names).toEqual([`41.json.consumed-${NOW}`, `41.json.consumed-${NOW}.result.json`]);
    const result = JSON.parse(readFileSync(join(dir, `41.json.consumed-${NOW}.result.json`), 'utf8')) as Record<string, unknown>;
    expect(result).toMatchObject({ kind: 'drained', obligationId: 41, at: NOW });
  });

  it('FALSIFIER (consume-before-act): the request file is already renamed when the drain runs', async () => {
    dropRequest(42);
    let requestFileDuringDrain: string[] | null = null;
    const outcomes = await serviceDrainNowRequests({
      requestDir: dir,
      nowUnixSec: () => NOW,
      drain: async () => {
        requestFileDuringDrain = readdirSync(dir).filter((n) => n === '42.json');
        return { activated: true as const };
      },
    });
    expect(outcomes).toHaveLength(1);
    expect(requestFileDuringDrain).toEqual([]); // consumed BEFORE the drain — a crash mid-drain can never re-service it
  });

  it('a refused drain records the runtime reason', async () => {
    dropRequest(43);
    const outcomes = await serviceDrainNowRequests({
      requestDir: dir,
      nowUnixSec: () => NOW,
      drain: async () => ({ activated: false as const, reason: 'group_approval_required' }),
    });
    expect(outcomes).toEqual([
      { kind: 'refused', obligationId: 43, file: '43.json', reason: 'group_approval_required' },
    ]);
  });

  it('an EXPIRED request is consumed and refused, never drained', async () => {
    dropRequest(44, { requestedAtUnixSec: NOW - 901 });
    const { calls, drain } = collectingDrain();
    const outcomes = await serviceDrainNowRequests({ requestDir: dir, drain, nowUnixSec: () => NOW });
    expect(outcomes).toEqual([
      { kind: 'refused', obligationId: 44, file: '44.json', reason: 'request_expired' },
    ]);
    expect(calls).toEqual([]);
    expect(readdirSync(dir).some((n) => n === '44.json')).toBe(false); // consumed
  });

  it('a FUTURE-DATED request (beyond skew) is consumed and refused', async () => {
    dropRequest(45, { requestedAtUnixSec: NOW + 301 });
    const { calls, drain } = collectingDrain();
    const outcomes = await serviceDrainNowRequests({ requestDir: dir, drain, nowUnixSec: () => NOW });
    expect(outcomes).toEqual([
      { kind: 'refused', obligationId: 45, file: '45.json', reason: 'request_future_dated' },
    ]);
    expect(calls).toEqual([]);
  });

  it('unparseable JSON and schema violations are consumed as invalid, never drained', async () => {
    writeFileSync(join(dir, '46.json'), '{not json');
    writeFileSync(join(dir, '47.json'), JSON.stringify({ obligationId: 47 })); // missing fields
    writeFileSync(join(dir, '48.json'), JSON.stringify({ ...validRequest(48), extra: 'field' })); // strict schema
    const { calls, drain } = collectingDrain();
    const outcomes = await serviceDrainNowRequests({ requestDir: dir, drain, nowUnixSec: () => NOW });
    expect(outcomes.map((o) => o.kind)).toEqual(['invalid', 'invalid', 'invalid']);
    expect(calls).toEqual([]);
  });

  it('a filename/payload id MISMATCH is consumed as invalid', async () => {
    writeFileSync(join(dir, '49.json'), JSON.stringify(validRequest(50)));
    const { calls, drain } = collectingDrain();
    const outcomes = await serviceDrainNowRequests({ requestDir: dir, drain, nowUnixSec: () => NOW });
    expect(outcomes).toEqual([{ kind: 'invalid', file: '49.json', reason: 'filename_id_mismatch' }]);
    expect(calls).toEqual([]);
  });

  it('a SYMLINK request is consumed as invalid without being read through', async () => {
    const target = join(dir, 'target-payload');
    writeFileSync(target, JSON.stringify(validRequest(51)));
    symlinkSync(target, join(dir, '51.json'));
    const { calls, drain } = collectingDrain();
    const outcomes = await serviceDrainNowRequests({ requestDir: dir, drain, nowUnixSec: () => NOW });
    expect(outcomes).toEqual([{ kind: 'invalid', file: '51.json', reason: 'not_a_regular_file' }]);
    expect(calls).toEqual([]);
  });

  it('non-request filenames are ignored entirely (no consume, no outcome)', async () => {
    writeFileSync(join(dir, 'notes.txt'), 'hi');
    writeFileSync(join(dir, '99999999999.json'), JSON.stringify(validRequest(53))); // 11 digits > filename bound
    const { calls, drain } = collectingDrain();
    const outcomes = await serviceDrainNowRequests({ requestDir: dir, drain, nowUnixSec: () => NOW });
    expect(outcomes).toEqual([]);
    expect(calls).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(['99999999999.json', 'notes.txt']); // untouched
  });

  it('services at most maxRequestsPerCycle, lowest obligation id first', async () => {
    dropRequest(7);
    dropRequest(3);
    dropRequest(9);
    dropRequest(5);
    const { calls, drain } = collectingDrain();
    const outcomes = await serviceDrainNowRequests({ requestDir: dir, drain, nowUnixSec: () => NOW, maxRequestsPerCycle: 2 });
    expect(outcomes.map((o) => (o.kind === 'drained' ? o.obligationId : -1))).toEqual([3, 5]);
    expect(calls).toEqual([3, 5]);
    expect(readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)).sort()).toEqual(['7.json', '9.json']);
  });

  it('r22 review hardening: a GROUP/OTHER-writable drop-dir is refused wholesale, nothing serviced', async () => {
    dropRequest(70);
    chmodSync(dir, 0o777);
    const { calls, drain } = collectingDrain();
    const outcomes = await serviceDrainNowRequests({ requestDir: dir, drain, nowUnixSec: () => NOW });
    expect(outcomes).toEqual([{ kind: 'invalid', file: '.', reason: 'untrusted_request_dir' }]);
    expect(calls).toEqual([]);
    expect(readdirSync(dir)).toContain('70.json'); // not even consumed — the dir is not trusted
    chmodSync(dir, 0o700);
    const after = await serviceDrainNowRequests({ requestDir: dir, drain, nowUnixSec: () => NOW });
    expect(after).toEqual([{ kind: 'drained', obligationId: 70, file: '70.json' }]); // trusted again → serviced
  });

  it('a missing drop-dir yields no outcomes and never throws', async () => {
    const { calls, drain } = collectingDrain();
    const outcomes = await serviceDrainNowRequests({ requestDir: join(dir, 'does-not-exist'), drain, nowUnixSec: () => NOW });
    expect(outcomes).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('a THROWING drain is recorded as a refusal, not propagated', async () => {
    dropRequest(54);
    const outcomes = await serviceDrainNowRequests({
      requestDir: dir,
      nowUnixSec: () => NOW,
      drain: async () => { throw new Error('boom'); },
    });
    expect(outcomes).toEqual([
      { kind: 'refused', obligationId: 54, file: '54.json', reason: 'drain_threw:Error' },
    ]);
  });

  it('uses the system clock when no nowUnixSec is injected (fresh request drains)', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    dropRequest(56, { requestedAtUnixSec: nowSec }); // well inside TTL and skew under the real clock
    const { calls, drain } = collectingDrain();
    const outcomes = await serviceDrainNowRequests({ requestDir: dir, drain });
    expect(outcomes).toEqual([{ kind: 'drained', obligationId: 56, file: '56.json' }]);
    expect(calls).toEqual([56]);
  });

  it('a drain that rejects with a NON-Error is recorded as drain_threw:unknown', async () => {
    dropRequest(55);
    const outcomes = await serviceDrainNowRequests({
      requestDir: dir,
      nowUnixSec: () => NOW,
      drain: () => Promise.reject('string-bomb'),
    });
    expect(outcomes).toEqual([
      { kind: 'refused', obligationId: 55, file: '55.json', reason: 'drain_threw:unknown' },
    ]);
  });

  it('fails closed when the platform has no geteuid (dir ownership unverifiable)', async () => {
    dropRequest(72);
    const { calls, drain } = collectingDrain();
    const original = process.geteuid;
    delete (process as { geteuid?: () => number }).geteuid;
    try {
      const outcomes = await serviceDrainNowRequests({ requestDir: dir, drain, nowUnixSec: () => NOW });
      expect(outcomes).toEqual([{ kind: 'invalid', file: '.', reason: 'untrusted_request_dir' }]);
      expect(calls).toEqual([]);
      expect(readdirSync(dir)).toContain('72.json'); // not even consumed — ownership unprovable
    } finally {
      (process as { geteuid?: () => number }).geteuid = original;
    }
  });

  it('prunes at most 20 stale artifacts per cycle; the next cycle finishes the job', async () => {
    const past = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    for (let i = 1; i <= 25; i += 1) {
      const p = join(dir, `${i}.json.consumed-100`);
      writeFileSync(p, '{}');
      utimesSync(p, past, past);
    }
    const { drain } = collectingDrain();
    const outcomes = await serviceDrainNowRequests({ requestDir: dir, drain, nowUnixSec: () => NOW });
    expect(outcomes).toEqual([]);
    // CONSUMED_PRUNE_PER_CYCLE = 20: exactly 5 of the 25 stale artifacts survive.
    expect(readdirSync(dir).filter((n) => n.includes('.consumed-'))).toHaveLength(5);
    await serviceDrainNowRequests({ requestDir: dir, drain, nowUnixSec: () => NOW });
    expect(readdirSync(dir).filter((n) => n.includes('.consumed-'))).toHaveLength(0);
  });

  it('prunes consumed/result artifacts AND orphaned .tmp-* files older than the retention window', async () => {
    const old = join(dir, '1.json.consumed-100');
    const oldResult = join(dir, '1.json.consumed-100.result.json');
    const orphanTmp = join(dir, '.tmp-nonce-abc-1'); // r22 review L5: a crashed writer's leak
    writeFileSync(old, '{}');
    writeFileSync(oldResult, '{}');
    writeFileSync(orphanTmp, '{}');
    const past = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    utimesSync(old, past, past);
    utimesSync(oldResult, past, past);
    utimesSync(orphanTmp, past, past);
    const fresh = join(dir, '2.json.consumed-200');
    const freshTmp = join(dir, '.tmp-nonce-def-2'); // recent — a request being written right now
    writeFileSync(fresh, '{}');
    writeFileSync(freshTmp, '{}');
    const { drain } = collectingDrain();
    await serviceDrainNowRequests({ requestDir: dir, drain, nowUnixSec: () => NOW });
    const names = readdirSync(dir);
    expect(names).not.toContain('1.json.consumed-100');
    expect(names).not.toContain('1.json.consumed-100.result.json');
    expect(names).not.toContain('.tmp-nonce-abc-1'); // stale orphan pruned
    expect(names).toContain('2.json.consumed-200');
    expect(names).toContain('.tmp-nonce-def-2'); // fresh tmp left alone (in-flight write)
  });
});

describe('writeDrainNowRequest', () => {
  it('writes atomically and round-trips through the service', async () => {
    const sub = join(dir, 'nested');
    const path = writeDrainNowRequest(sub, validRequest(60));
    expect(path).toBe(join(sub, '60.json'));
    const { calls, drain } = collectingDrain();
    const outcomes = await serviceDrainNowRequests({ requestDir: sub, drain, nowUnixSec: () => NOW });
    expect(outcomes).toEqual([{ kind: 'drained', obligationId: 60, file: '60.json' }]);
    expect(calls).toEqual([60]);
  });

  it('refuses to overwrite a pending request for the same obligation', () => {
    writeDrainNowRequest(dir, validRequest(61));
    expect(() => writeDrainNowRequest(dir, validRequest(61, { nonce: 'nonce-different-1' }))).toThrow(
      /already exists/,
    );
  });

  it('rejects an invalid request payload before touching the filesystem', () => {
    const sub = join(dir, 'never-created');
    expect(() =>
      writeDrainNowRequest(sub, { ...validRequest(62), requestedBy: '' } as DrainNowRequest),
    ).toThrow();
    expect(readdirSync(dir)).not.toContain('never-created'); // dir never created
  });

  it('propagates a non-ENOENT stat failure instead of treating it as no-pending-request', () => {
    // An unsearchable drop-dir must fail the write, never be read as "nothing
    // pending" (which would proceed to write into a dir of unknowable state).
    const sub = join(dir, 'unsearchable');
    mkdirSync(sub, { mode: 0o700 });
    chmodSync(sub, 0o000);
    try {
      expect(() => writeDrainNowRequest(sub, validRequest(63))).toThrow(/EACCES|EPERM/);
    } finally {
      chmodSync(sub, 0o700);
    }
  });
});

describe('buildLiveActivateSession', () => {
  interface StubSession extends ActivatableSession {
    spawned: number;
  }

  function makeSession(activeAfterSpawn: boolean, initiallyActive = false): StubSession {
    let active = initiallyActive;
    const session: StubSession = {
      spawned: 0,
      getStatus: () => ({ active }),
      spawnSession: async () => {
        session.spawned += 1;
        active = activeAfterSpawn;
      },
    };
    return session;
  }

  function makePorts(over: Partial<SessionActivationPorts> & { session?: StubSession } = {}): {
    ports: SessionActivationPorts;
    session: StubSession;
    log: string[];
  } {
    const session = over.session ?? makeSession(true);
    const log: string[] = [];
    // resolveActiveTarget mirrors the runtime: non-null only when the session is active.
    const base: SessionActivationPorts = {
      resolveMapKey: (jid) => `key:${jid}`,
      resolveActiveTarget: (jid) => {
        log.push(`resolve:${jid}`);
        return session.getStatus().active ? { session } : null;
      },
      getSession: (mapKey) => {
        log.push(`get:${mapKey}`);
        return session;
      },
      captureOwnedGeneration: (mapKey) => {
        log.push(`capture:${mapKey}`);
        return { managerId: 'm1', generation: 1 };
      },
      activateSpawnedSession: async (mapKey) => {
        log.push(`activate:${mapKey}`);
        return mapKey;
      },
    };
    const { session: _ignored, ...portOverrides } = over;
    return { ports: { ...base, ...portOverrides }, session, log };
  }

  it('activates an inactive session via capture → spawn → activate and re-checks the dispatch predicate', async () => {
    const { ports, session, log } = makePorts();
    const activate = buildLiveActivateSession(ports);
    const active = await activate('dm@lid');
    expect(active).toBe(true);
    expect(session.spawned).toBe(1);
    expect(log).toEqual([
      'resolve:dm@lid', 'get:key:dm@lid', 'capture:key:dm@lid', 'activate:key:dm@lid', 'resolve:dm@lid',
    ]);
  });

  it('an already-active target short-circuits without spawning', async () => {
    const { ports, session } = makePorts({ session: makeSession(true, true) });
    const activate = buildLiveActivateSession(ports);
    const active = await activate('dm@lid');
    expect(active).toBe(true);
    expect(session.spawned).toBe(0);
  });

  it('an active-but-undispatchable session is NOT re-spawned; the predicate verdict is reported', async () => {
    // #2169 cold path: the session flag reads active while the dispatch
    // predicate still refuses (e.g. ownership superseded). Spawning again would
    // double-spawn a live session — the closure must skip capture/spawn/activate
    // entirely and report the predicate's refusal.
    const session = makeSession(false, true); // already active
    const { ports, log } = makePorts({ session, resolveActiveTarget: () => null });
    const activate = buildLiveActivateSession(ports);
    const active = await activate('dm@lid');
    expect(active).toBe(false);
    expect(session.spawned).toBe(0);
    expect(log).toEqual(['get:key:dm@lid']); // no capture, no activate
  });

  it('FALSIFIER: reports false when the spawn does NOT produce a dispatchable target', async () => {
    // The session flag flips but the dispatch predicate still refuses (e.g.
    // ownership superseded) — the closure must report the PREDICATE, not the flag.
    const session = makeSession(true);
    const { ports } = makePorts({
      session,
      resolveActiveTarget: () => null, // dispatch predicate never satisfied
    });
    const activate = buildLiveActivateSession(ports);
    const active = await activate('dm@lid');
    expect(active).toBe(false);
    expect(session.spawned).toBe(1); // it did try — and refused to report success on the flag alone
  });

  it('fails closed (false) when capture throws', async () => {
    const { ports, session } = makePorts({
      captureOwnedGeneration: () => { throw new Error('unowned'); },
    });
    const activate = buildLiveActivateSession(ports);
    const active = await activate('dm@lid');
    expect(active).toBe(false);
    expect(session.spawned).toBe(0);
  });

  it('fails closed (false) when the session is absent', async () => {
    const { ports } = makePorts({ getSession: () => undefined });
    const activate = buildLiveActivateSession(ports);
    const active = await activate('dm@lid');
    expect(active).toBe(false);
  });
});
