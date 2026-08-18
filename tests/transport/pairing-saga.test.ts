import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

    const record = readPairingOperationRecord(stateRoot, 'pairing-op-0001');
    expect(record?.operation.state).toBe('receipt_persisted');
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
    const record = readPairingOperationRecord(stateRoot, 'pairing-op-0001');
    expect(record?.operation.state).toBe('activated');
    expect(record?.operation.resultGenerationId).toBe(outcome.generationId);
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
    expect(readPairingOperationRecord(stateRoot, 'pairing-op-0001')?.operation.state).toBe('failed');
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
    expect(readPairingOperationRecord(stateRoot, 'pairing-op-0001')?.operation.state).toBe('failed');
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
    expect(readPairingOperationRecord(stateRoot, 'pairing-op-0001')?.operation.state).toBe('failed');
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
