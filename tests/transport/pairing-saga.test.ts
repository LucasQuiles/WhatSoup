import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import {
  executePairingSaga,
  pairingPreflight,
  readPairingOperationRecord,
  type PairingSagaEffects,
} from '../../src/transport/pairing-saga.ts';
import {
  appendLatchTransition,
  decideConnectActivation,
  readTerminalLatchJournal,
  type LatchTransitionV1,
  type TerminalLatchV1,
} from '../../src/transport/terminal-latch.ts';
import {
  computeCredentialTreeDigest,
  observeActiveTree,
  resolveAuthGenerationEvidenceV2,
} from '../../src/transport/auth-generation-v2.ts';
import { acquireCoordinationLease, releaseCoordinationLease, type LeaseProbes } from '../../src/transport/coordination-lease.ts';
import { parseAccountScopeId, type CoordinationLeaseV1 } from '../../src/transport/auth-custody-contracts.ts';

const SCOPE = parseAccountScopeId('scope:line-a-wa')!;
const T0 = Date.parse('2026-08-18T18:00:00.000Z');

let root: string;
let stateRoot: string;
let authDir: string;

function probes(): LeaseProbes {
  return {
    hostId: 'host-a',
    bootId: 'boot-current',
    pid: process.pid,
    birthToken: () => 'birth-self',
    pidAlive: pid => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
      }
    },
    nowMs: () => T0,
  };
}

interface EffectLog {
  calls: string[];
}

function makeEffects(overrides: Partial<PairingSagaEffects> = {}): { effects: PairingSagaEffects; log: EffectLog } {
  const log: EffectLog = { calls: [] };
  const effects: PairingSagaEffects = {
    nowMs: () => T0,
    stopService: async () => {
      log.calls.push('stopService');
      return true;
    },
    startService: async () => {
      log.calls.push('startService');
      return true;
    },
    acquireLease: operationId => {
      log.calls.push(`acquireLease:${operationId}`);
      return acquireCoordinationLease({
        stateRoot,
        scopeId: SCOPE,
        operationId,
        mode: 'pairing',
        ttlMs: 60_000,
        probes: probes(),
      });
    },
    releaseLease: lease => {
      log.calls.push('releaseLease');
      releaseCoordinationLease({ stateRoot, scopeId: SCOPE, lease });
    },
    runPairingHelper: async input => {
      log.calls.push('runPairingHelper');
      // Default: a successful pairing writes fresh credentials into the
      // FINAL directory it was handed.
      mkdirSync(join(input.authDir, 'keys'), { recursive: true });
      writeFileSync(join(input.authDir, 'creds.json'), '{"me":{"id":"fresh"}}');
      writeFileSync(join(input.authDir, 'keys', 'pre-key-1.json'), '{"k":1}');
      return { ok: true };
    },
    ...overrides,
  };
  return { effects, log };
}

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: 'pairing-op-0001',
    host: 'host-a',
    instance: 'line-a',
    scopeId: 'scope:line-a-wa',
    expectedCurrentGenerationId: null,
    expectedLatchRevision: 0,
    method: 'pairing_code' as const,
    authorizationId: 'auth-g4-0001',
    actorOperationId: null,
    startService: false,
    ...overrides,
  };
}

function mustRecord(key: string) {
  const record = readPairingOperationRecord(stateRoot, key);
  if (record === null || record === 'journal_unreadable') {
    throw new Error(`no readable operation record for ${key}`);
  }
  return record;
}

function writeRevokedTree(): string {
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(authDir, 'creds.json'), '{"me":{"id":"revoked"}}');
  const digest = computeCredentialTreeDigest(authDir);
  if (!digest.ok) throw new Error('fixture digest failed');
  return digest.digest;
}

function latchCreated(digest: string): LatchTransitionV1 {
  const latch: TerminalLatchV1 = {
    v: 1,
    scopeId: SCOPE,
    latchedGenerationId: null,
    latchedCredentialTreeDigest: digest,
    reason: 'serverside_logout_irreversible',
    evidenceDigest: 'f'.repeat(64),
    latchedAt: '2026-08-18T12:00:00.000Z',
  };
  return {
    v: 1,
    scopeId: SCOPE,
    kind: 'latch_created',
    revision: 1,
    expectedPriorRevision: 0,
    at: '2026-08-18T12:00:00.000Z',
    operationId: 'latch-op-1',
    ownerAuthorizationId: null,
    latch,
    supersededByGenerationId: null,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pairing-saga-test-'));
  stateRoot = join(root, 'state');
  authDir = join(root, 'auth');
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
});

afterEach(() => {
  for (const entry of existsSync(root) ? readdirSync(root) : []) {
    try {
      chmodSync(join(root, entry), 0o700);
    } catch {
      // fixture dirs may already be writable
    }
  }
  rmSync(root, { recursive: true, force: true });
});

describe('executePairingSaga - happy path over a latched revoked tree', () => {
  it('quarantines, pairs into the final dir, persists a bound receipt, supersedes the latch, releases the lease', async () => {
    const revokedDigest = writeRevokedTree();
    expect(appendLatchTransition(stateRoot, latchCreated(revokedDigest)).ok).toBe(true);

    const { effects, log } = makeEffects();
    const outcome = await executePairingSaga(
      baseRequest({ expectedLatchRevision: 1 }),
      { stateRoot, authDir },
      effects,
    );
    if (!outcome.ok) throw new Error(`saga failed: ${outcome.errorClass}`);

    // The revoked tree is preserved under a quarantine name, never deleted.
    const quarantined = readdirSync(root).filter(name => name.startsWith('auth.revoked.'));
    expect(quarantined).toHaveLength(1);
    const quarantineDigest = computeCredentialTreeDigest(join(root, quarantined[0]!));
    if (!quarantineDigest.ok) throw new Error('quarantine digest failed');
    expect(quarantineDigest.digest).toBe(revokedDigest);

    // The fresh generation lives in the FINAL auth dir with a bound V2 receipt.
    const evidence = resolveAuthGenerationEvidenceV2(stateRoot);
    if (evidence.status !== 'recorded_v2') throw new Error(`no v2 receipt: ${evidence.status}`);
    expect(evidence.receipt.generationId).toBe(outcome.generationId);
    const active = observeActiveTree(authDir);
    if (active.status !== 'digest') throw new Error('active tree unreadable');
    expect(evidence.receipt.credentialTreeDigest).toBe(active.digest);

    // The latch is superseded by exactly that generation, and the connect
    // gate would now allow activation.
    const latchState = readTerminalLatchJournal(stateRoot);
    expect(latchState).toEqual(
      expect.objectContaining({ status: 'superseded', supersededByGenerationId: outcome.generationId }),
    );
    expect(decideConnectActivation(latchState, active, evidence)).toEqual({
      allow: true,
      basis: 'bound_superseding_generation',
    });

    // Service was stopped before the lease was acquired; lease released after.
    expect(log.calls[0]).toBe('stopService');
    expect(log.calls[1]).toBe(`acquireLease:${baseRequest().idempotencyKey}`);
    expect(log.calls).toContain('releaseLease');
    // startService was NOT requested (install-without-activate default).
    expect(log.calls).not.toContain('startService');

    expect(mustRecord('pairing-op-0001').operation.state).toBe('receipt_persisted');
  });

  it('activates (and only then) when startService is requested and succeeds', async () => {
    const revokedDigest = writeRevokedTree();
    expect(appendLatchTransition(stateRoot, latchCreated(revokedDigest)).ok).toBe(true);
    const { effects, log } = makeEffects();
    const outcome = await executePairingSaga(
      baseRequest({ startService: true, expectedLatchRevision: 1 }),
      { stateRoot, authDir },
      effects,
    );
    if (!outcome.ok) throw new Error(`saga failed: ${outcome.errorClass}`);
    expect(log.calls).toContain('startService');
    const record = mustRecord('pairing-op-0001');
    expect(record.operation.state).toBe('activated');
    expect(record.operation.resultGenerationId).toBe(outcome.generationId);
  });

  it('handles an already-quarantined (absent) active tree', async () => {
    // P8.1 quarantined the tree operationally before the saga ran.
    const revokedDigest = 'd'.repeat(64);
    expect(appendLatchTransition(stateRoot, latchCreated(revokedDigest)).ok).toBe(true);
    const { effects } = makeEffects();
    const outcome = await executePairingSaga(
      baseRequest({ expectedLatchRevision: 1 }),
      { stateRoot, authDir },
      effects,
    );
    if (!outcome.ok) throw new Error(`saga failed: ${outcome.errorClass}`);
    expect(readdirSync(root).filter(name => name.startsWith('auth.revoked.'))).toHaveLength(0);
    expect(readTerminalLatchJournal(stateRoot).status).toBe('superseded');
  });
});

describe('executePairingSaga - refusals and faults', () => {
  it('refuses a stale latch revision without touching anything', async () => {
    const revokedDigest = writeRevokedTree();
    expect(appendLatchTransition(stateRoot, latchCreated(revokedDigest)).ok).toBe(true);
    const { effects, log } = makeEffects();
    const outcome = await executePairingSaga(
      baseRequest({ expectedLatchRevision: 0 }),
      { stateRoot, authDir },
      effects,
    );
    expect(outcome).toEqual({ ok: false, errorClass: 'verification_failed', refusal: 'stale_latch_revision' });
    expect(log.calls).toHaveLength(0);
    expect(existsSync(join(authDir, 'creds.json'))).toBe(true);
    expect(readPairingOperationRecord(stateRoot, 'pairing-op-0001')).toBeNull();
  });

  it('refuses a stale expected generation', async () => {
    const { effects, log } = makeEffects();
    const outcome = await executePairingSaga(
      baseRequest({ expectedCurrentGenerationId: 'gen-that-does-not-exist' }),
      { stateRoot, authDir },
      effects,
    );
    expect(outcome).toEqual({
      ok: false,
      errorClass: 'verification_failed',
      refusal: 'stale_expected_generation',
    });
    expect(log.calls).toHaveLength(0);
  });

  it('fails closed when the service cannot be stopped', async () => {
    writeRevokedTree();
    const { effects } = makeEffects({
      stopService: async () => false,
    });
    const outcome = await executePairingSaga(baseRequest(), { stateRoot, authDir }, effects);
    expect(outcome).toEqual({ ok: false, errorClass: 'verification_failed', refusal: 'service_stop_unverified' });
    expect(existsSync(join(authDir, 'creds.json'))).toBe(true);
    expect(mustRecord('pairing-op-0001').operation.state).toBe('failed');
  });

  it('fails with lease_unavailable when a live owner holds the scope', async () => {
    writeRevokedTree();
    const held = acquireCoordinationLease({
      stateRoot,
      scopeId: SCOPE,
      operationId: 'someone-else',
      mode: 'runtime_start',
      ttlMs: 60_000,
      probes: probes(),
    });
    expect(held.ok).toBe(true);
    const { effects } = makeEffects();
    const outcome = await executePairingSaga(baseRequest(), { stateRoot, authDir }, effects);
    expect(outcome).toEqual({ ok: false, errorClass: 'lease_unavailable', refusal: 'held_by_live_owner' });
    // The active tree was NOT quarantined - the saga never got custody.
    expect(existsSync(join(authDir, 'creds.json'))).toBe(true);
  });

  it('a failed pairing helper quarantines the incomplete tree and leaves the service stopped', async () => {
    writeRevokedTree();
    const { effects, log } = makeEffects({
      runPairingHelper: async input => {
        // Helper wrote a partial tree then died.
        mkdirSync(input.authDir, { recursive: true });
        writeFileSync(join(input.authDir, 'creds.json'), '{"partial":true}');
        return { ok: false, errorClass: 'pairing_timeout' };
      },
    });
    const outcome = await executePairingSaga(baseRequest(), { stateRoot, authDir }, effects);
    expect(outcome).toEqual({ ok: false, errorClass: 'pairing_timeout', refusal: 'pairing_helper_failed' });
    // Incomplete tree moved aside; final dir does not present as active.
    expect(existsSync(join(authDir, 'creds.json'))).toBe(false);
    expect(readdirSync(root).filter(name => name.startsWith('auth.failed.'))).toHaveLength(1);
    // No receipt exists, so nothing can activate on this tree.
    expect(resolveAuthGenerationEvidenceV2(stateRoot).status).toBe('unavailable');
    expect(log.calls).not.toContain('startService');
    expect(log.calls).toContain('releaseLease');
    expect(mustRecord('pairing-op-0001').operation.state).toBe('failed');
  });

  it('a receipt-persistence failure is a pairing failure: incomplete tree quarantined, no activation', async () => {
    writeRevokedTree();
    const { effects, log } = makeEffects({
      runPairingHelper: async input => {
        mkdirSync(input.authDir, { recursive: true });
        writeFileSync(join(input.authDir, 'creds.json'), '{"me":{"id":"fresh"}}');
        // Make the tree unreadable so the post-pairing digest fails.
        chmodSync(input.authDir, 0o000);
        return { ok: true };
      },
    });
    const outcome = await executePairingSaga(baseRequest(), { stateRoot, authDir }, effects);
    expect(outcome).toEqual({
      ok: false,
      errorClass: 'receipt_write_failed',
      refusal: 'generation_receipt_unpersisted',
    });
    expect(log.calls).not.toContain('startService');
    expect(mustRecord('pairing-op-0001').operation.state).toBe('failed');
  });

  it('replaying a terminal operation with identical parameters returns the recorded outcome without re-running', async () => {
    const revokedDigest = writeRevokedTree();
    expect(appendLatchTransition(stateRoot, latchCreated(revokedDigest)).ok).toBe(true);
    const { effects } = makeEffects();
    const request = baseRequest({ expectedLatchRevision: 1 });
    const first = await executePairingSaga(request, { stateRoot, authDir }, effects);
    if (!first.ok) throw new Error('first run failed');

    const { effects: secondEffects, log: secondLog } = makeEffects();
    const second = await executePairingSaga(request, { stateRoot, authDir }, secondEffects);
    expect(second).toEqual({ ok: true, generationId: first.generationId, replayed: true });
    expect(secondLog.calls).toHaveLength(0);
  });

  it('rejects parameter drift under the same idempotency key', async () => {
    const revokedDigest = writeRevokedTree();
    expect(appendLatchTransition(stateRoot, latchCreated(revokedDigest)).ok).toBe(true);
    const { effects } = makeEffects();
    const first = await executePairingSaga(
      baseRequest({ expectedLatchRevision: 1 }),
      { stateRoot, authDir },
      effects,
    );
    expect(first.ok).toBe(true);
    const { effects: driftEffects, log: driftLog } = makeEffects();
    const drifted = await executePairingSaga(
      baseRequest({ expectedLatchRevision: 1, method: 'qr' }),
      { stateRoot, authDir },
      driftEffects,
    );
    expect(drifted).toEqual({ ok: false, errorClass: 'verification_failed', refusal: 'parameter_drift' });
    expect(driftLog.calls).toHaveLength(0);
  });

  it('a crash-interrupted operation refuses resumption and demands a new authorized operation', async () => {
    writeRevokedTree();
    const { effects } = makeEffects({
      runPairingHelper: async () => {
        throw new Error('simulated crash mid-pairing');
      },
    });
    await expect(
      executePairingSaga(baseRequest(), { stateRoot, authDir }, effects),
    ).rejects.toThrow('simulated crash mid-pairing');

    const { effects: retryEffects, log: retryLog } = makeEffects();
    const retry = await executePairingSaga(baseRequest(), { stateRoot, authDir }, retryEffects);
    expect(retry).toEqual({ ok: false, errorClass: 'crash_recovered', refusal: 'operation_interrupted' });
    expect(retryLog.calls).toHaveLength(0);
  });
});

describe('pairingPreflight', () => {
  it('is side-effect-free and reports latch, tree, generation, lease, and operation state', async () => {
    const revokedDigest = writeRevokedTree();
    expect(appendLatchTransition(stateRoot, latchCreated(revokedDigest)).ok).toBe(true);
    const before = readdirSync(root).sort();
    const plan = pairingPreflight({ stateRoot, authDir });
    expect(readdirSync(root).sort()).toEqual(before);
    expect(plan).toEqual(
      expect.objectContaining({
        latch: expect.objectContaining({ status: 'active', revision: 1 }),
        activeTree: expect.objectContaining({ status: 'digest', digest: revokedDigest }),
        generationEvidence: expect.objectContaining({ status: 'unavailable' }),
        lease: { status: 'vacant' },
      }),
    );
  });
});

describe('executePairingSaga — refusal and custody edge branches', () => {
  it('refuses an invalid scope id before touching anything', async () => {
    const { effects, log } = makeEffects();
    const outcome = await executePairingSaga(baseRequest({ scopeId: 'not-a-scope' }) as never, { stateRoot, authDir }, effects);
    expect(outcome).toEqual({ ok: false, errorClass: 'authorization_invalid', refusal: 'scope_invalid' });
    expect(log.calls).toEqual([]);
  });

  it('refuses an empty authorization id before touching anything', async () => {
    const { effects, log } = makeEffects();
    const outcome = await executePairingSaga(baseRequest({ authorizationId: '' }) as never, { stateRoot, authDir }, effects);
    expect(outcome).toEqual({ ok: false, errorClass: 'authorization_invalid', refusal: 'authorization_required' });
    expect(log.calls).toEqual([]);
  });

  it('refuses when the latch journal is corrupt', async () => {
    writeFileSync(join(stateRoot, 'terminal-latch.journal.ndjson'), 'garbage{{{\n', { mode: 0o600 });
    const { effects, log } = makeEffects();
    const outcome = await executePairingSaga(baseRequest() as never, { stateRoot, authDir }, effects);
    expect(outcome).toEqual({ ok: false, errorClass: 'verification_failed', refusal: 'latch_state_corrupt' });
    expect(log.calls).toEqual([]);
  });

  it('replays a recorded failure as operation_already_failed without re-running', async () => {
    const revokedDigest = writeRevokedTree();
    expect(appendLatchTransition(stateRoot, latchCreated(revokedDigest)).ok).toBe(true);
    const failing = makeEffects({ runPairingHelper: async () => ({ ok: false, errorClass: 'pairing_timeout' }) });
    const first = await executePairingSaga(baseRequest({ expectedLatchRevision: 1 }) as never, { stateRoot, authDir }, failing.effects);
    expect(first.ok).toBe(false);

    const replay = makeEffects();
    const second = await executePairingSaga(baseRequest({ expectedLatchRevision: 1 }) as never, { stateRoot, authDir }, replay.effects);
    expect(second).toEqual({ ok: false, errorClass: 'pairing_timeout', refusal: 'operation_already_failed' });
    expect(replay.log.calls).toEqual([]);
  });

  it('fails closed when the operation journal exists but cannot be read (idempotency must not silently vanish)', async () => {
    const revokedDigest = writeRevokedTree();
    expect(appendLatchTransition(stateRoot, latchCreated(revokedDigest)).ok).toBe(true);
    const journalPath = join(stateRoot, 'pairing-operations.ndjson');
    writeFileSync(journalPath, 'placeholder\n', { mode: 0o600 });
    chmodSync(journalPath, 0o000);
    const { effects, log } = makeEffects();
    const outcome = await executePairingSaga(baseRequest({ expectedLatchRevision: 1 }) as never, { stateRoot, authDir }, effects);
    chmodSync(journalPath, 0o600);
    expect(outcome).toEqual({ ok: false, errorClass: 'verification_failed', refusal: 'operation_journal_unreadable' });
    expect(log.calls).toEqual([]);
  });

  it('refuses an unreadable active tree without quarantining it', async () => {
    const revokedDigest = writeRevokedTree();
    expect(appendLatchTransition(stateRoot, latchCreated(revokedDigest)).ok).toBe(true);
    chmodSync(authDir, 0o000);
    const { effects } = makeEffects();
    const outcome = await executePairingSaga(baseRequest({ expectedLatchRevision: 1 }) as never, { stateRoot, authDir }, effects);
    chmodSync(authDir, 0o700);
    expect(outcome).toEqual({ ok: false, errorClass: 'quarantine_failed', refusal: 'active_tree_unreadable' });
    expect(existsSync(join(authDir, 'creds.json'))).toBe(true);
  });

  it('a supersede transition whose operation id was already used refuses supersession but keeps the fresh tree', async () => {
    const revokedDigest = writeRevokedTree();
    const created = latchCreated(revokedDigest);
    const collided = { ...created, operationId: 'pairing-op-0031.supersede' };
    expect(appendLatchTransition(stateRoot, collided).ok).toBe(true);
    const { effects } = makeEffects();
    const outcome = await executePairingSaga(
      baseRequest({ idempotencyKey: 'pairing-op-0031', expectedLatchRevision: 1 }) as never,
      { stateRoot, authDir },
      effects,
    );
    expect(outcome).toEqual({ ok: false, errorClass: 'verification_failed', refusal: 'latch_supersession_refused' });
    expect(existsSync(join(authDir, 'creds.json'))).toBe(true);
    expect(readTerminalLatchJournal(stateRoot).status).toBe('active');
  });

  it('a service start failure after receipt persistence refuses activation but keeps the paired generation', async () => {
    const revokedDigest = writeRevokedTree();
    expect(appendLatchTransition(stateRoot, latchCreated(revokedDigest)).ok).toBe(true);
    const { effects } = makeEffects({ startService: async () => false });
    const outcome = await executePairingSaga(
      baseRequest({ expectedLatchRevision: 1, startService: true }) as never,
      { stateRoot, authDir },
      effects,
    );
    expect(outcome).toEqual({ ok: false, errorClass: 'verification_failed', refusal: 'service_start_unverified' });
    expect(resolveAuthGenerationEvidenceV2(stateRoot).status).toBe('recorded_v2');
    expect(readTerminalLatchJournal(stateRoot).status).toBe('superseded');
  });

  it('an incomplete pairing that wrote nothing leaves no failed-quarantine sibling', async () => {
    const revokedDigest = writeRevokedTree();
    expect(appendLatchTransition(stateRoot, latchCreated(revokedDigest)).ok).toBe(true);
    const { effects } = makeEffects({ runPairingHelper: async () => ({ ok: false, errorClass: 'unknown' }) });
    const outcome = await executePairingSaga(baseRequest({ expectedLatchRevision: 1 }) as never, { stateRoot, authDir }, effects);
    expect(outcome.ok).toBe(false);
    expect(readdirSync(root).filter(name => name.includes('.failed.'))).toEqual([]);
  });

  it('journal reads skip torn, non-object, foreign-version, and foreign-key rows', async () => {
    const revokedDigest = writeRevokedTree();
    expect(appendLatchTransition(stateRoot, latchCreated(revokedDigest)).ok).toBe(true);
    const { effects } = makeEffects();
    const outcome = await executePairingSaga(baseRequest({ expectedLatchRevision: 1 }) as never, { stateRoot, authDir }, effects);
    expect(outcome.ok).toBe(true);

    const journalPath = join(stateRoot, 'pairing-operations.ndjson');
    const rows = readFileSync(journalPath, 'utf-8').trimEnd().split('\n');
    const lastRow = JSON.parse(rows[rows.length - 1]!) as { operation: { idempotencyKey: string } };
    const foreign = { ...lastRow, operation: { ...lastRow.operation, idempotencyKey: 'pairing-op-other' } };
    writeFileSync(
      journalPath,
      ['torn{{{', '"just-a-string"', JSON.stringify({ v: 99, paramsDigest: 'x' }), JSON.stringify(foreign), ...rows].join('\n') + '\n',
      { mode: 0o600 },
    );
    const record = readPairingOperationRecord(stateRoot, 'pairing-op-0001');
    expect(record).not.toBeNull();
    expect(record).not.toBe('journal_unreadable');
    if (record === null || record === 'journal_unreadable') throw new Error('unreachable');
    expect(record.operation.idempotencyKey).toBe('pairing-op-0001');
    expect(record.operation.state).toBe('receipt_persisted');
  });
});

describe('pairingPreflight — fail-closed reporting branches', () => {
  it('reports a corrupt lease file as corrupt, never vacant', () => {
    writeFileSync(join(stateRoot, 'coordination-lease.line-a-wa.json'), 'not json', { mode: 0o600 });
    const plan = pairingPreflight({ stateRoot, authDir });
    expect(plan.lease).toEqual({ status: 'corrupt' });
  });

  it('reports a held lease with its mode', () => {
    const acquired = acquireCoordinationLease({
      stateRoot,
      scopeId: SCOPE,
      operationId: 'op-preflight-held',
      mode: 'pairing',
      ttlMs: 60_000,
      probes: probes(),
    });
    expect(acquired.ok).toBe(true);
    const plan = pairingPreflight({ stateRoot, authDir });
    expect(plan.lease).toEqual({ status: 'held', mode: 'pairing' });
  });

  it('reports the journal tail operation while skipping torn rows, and null for an unreadable journal', async () => {
    const revokedDigest = writeRevokedTree();
    expect(appendLatchTransition(stateRoot, latchCreated(revokedDigest)).ok).toBe(true);
    const { effects } = makeEffects();
    const outcome = await executePairingSaga(baseRequest({ expectedLatchRevision: 1 }) as never, { stateRoot, authDir }, effects);
    expect(outcome.ok).toBe(true);

    const journalPath = join(stateRoot, 'pairing-operations.ndjson');
    appendFileSync(journalPath, 'torn{{{\n');
    let plan = pairingPreflight({ stateRoot, authDir });
    expect(plan.lastOperation).toEqual({ idempotencyKey: 'pairing-op-0001', state: 'receipt_persisted' });

    chmodSync(journalPath, 0o000);
    plan = pairingPreflight({ stateRoot, authDir });
    chmodSync(journalPath, 0o600);
    expect(plan.lastOperation).toBeNull();
  });
});
