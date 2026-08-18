// src/transport/pairing-saga.ts
//
// T5 of the q-canary re-pair enablement lane: the evidence-preserving,
// fresh-generation pairing saga. One idempotent operation takes an instance
// from "stopped over revoked material" to "fresh receipted generation with
// the terminal latch superseded" — or fails closed at a named step with the
// service left stopped, the latch active, and every tree preserved.
//
// Division of labor: filesystem custody (quarantine renames, digests,
// receipts, operation journal, latch transitions) is REAL code in this
// module; only the genuinely external effects (service stop/start, lease
// acquisition, the pairing helper subprocess) are injected. Saga tests
// therefore assert actual filesystem state after every injected fault.
//
// Rollback doctrine (plan T5): never copy a revoked or failed tree over
// active auth. Recovery from any failure is "remain stopped and latched,
// preserve artifacts, retry with a NEW authorized operation" — which is why
// a crash-interrupted operation refuses resumption instead of resuming.

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appendPrivateJsonLineSync, fsyncDirectory, readPrivateFileSync } from '../lib/private-fs.ts';
import {
  parseAccountScopeId,
  parseCoordinationLease,
  parsePairingOperation,
  type AccountScopeIdV1,
  type CoordinationLeaseV1,
  type PairingErrorClass,
  type PairingMethod,
  type PairingOperationState,
  type PairingOperationV1,
} from './auth-custody-contracts.ts';
import {
  appendLatchTransition,
  readTerminalLatchJournal,
  type LatchJournalState,
} from './terminal-latch.ts';
import {
  computeCredentialTreeDigest,
  observeActiveTree,
  persistAuthGenerationReceiptV2,
  resolveAuthGenerationEvidenceV2,
  type AuthGenerationEvidenceV2,
} from './auth-generation-v2.ts';
import type { AcquireLeaseResult } from './coordination-lease.ts';

const OPERATIONS_JOURNAL_FILENAME = 'pairing-operations.ndjson';
const MAX_OPERATIONS_JOURNAL_BYTES = 512 * 1024;

export interface PairingSagaRequest {
  idempotencyKey: string;
  host: string;
  instance: string;
  scopeId: unknown;
  expectedCurrentGenerationId: string | null;
  expectedLatchRevision: number;
  method: PairingMethod;
  authorizationId: string;
  actorOperationId: string | null;
  startService: boolean;
}

export interface PairingSagaPaths {
  stateRoot: string;
  authDir: string;
}

export interface PairingSagaEffects {
  nowMs(): number;
  /** Stop the instance service and verify it stopped. false = unverified. */
  stopService(): Promise<boolean>;
  /** Start the instance service and verify it started. false = unverified. */
  startService(): Promise<boolean>;
  acquireLease(operationId: string): AcquireLeaseResult;
  releaseLease(lease: CoordinationLeaseV1): void;
  runPairingHelper(input: {
    authDir: string;
    lease: CoordinationLeaseV1;
  }): Promise<{ ok: true } | { ok: false; errorClass: PairingErrorClass }>;
}

export type PairingSagaOutcome =
  | { ok: true; generationId: string; replayed?: true }
  | { ok: false; errorClass: PairingErrorClass; refusal: string };

interface OperationRow {
  v: 1;
  paramsDigest: string;
  generationId: string | null;
  custody: {
    priorTreeDigest: string;
    priorFileCount: number;
    quarantinePath: string;
  } | null;
  operation: PairingOperationV1;
}

export interface PairingOperationRecord {
  paramsDigest: string;
  generationId: string | null;
  custody: OperationRow['custody'];
  operation: PairingOperationV1;
}

function operationsJournalPath(stateRoot: string): string {
  return join(stateRoot, OPERATIONS_JOURNAL_FILENAME);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function paramsDigestOf(request: PairingSagaRequest): string {
  return createHash('sha256').update(stableStringify(request)).digest('hex');
}

/** Last journal row for one idempotency key, or null. Corrupt rows are skipped
 * (the journal is append-only evidence; a torn tail must not wedge reads). */
export function readPairingOperationRecord(
  stateRoot: string,
  idempotencyKey: string,
): PairingOperationRecord | null {
  if (!existsSync(operationsJournalPath(stateRoot))) return null;
  let raw: string | null;
  try {
    raw = readPrivateFileSync(operationsJournalPath(stateRoot), {
      maxBytes: MAX_OPERATIONS_JOURNAL_BYTES,
      label: 'pairing operations journal',
    });
  } catch {
    // intentional: an unreadable journal reads as no record - the saga then
    // re-validates every precondition from primary state before acting.
    return null;
  }
  if (raw === null) return null;
  let latest: PairingOperationRecord | null = null;
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    let parsedLine: unknown;
    try {
      parsedLine = JSON.parse(line);
    } catch {
      // intentional: a torn journal tail row is skipped; the journal is
      // append-only evidence and a partial line must not wedge reads.
      continue;
    }
    if (typeof parsedLine !== 'object' || parsedLine === null) continue;
    const row = parsedLine as Partial<OperationRow>;
    if (row.v !== 1 || typeof row.paramsDigest !== 'string') continue;
    const operation = parsePairingOperation(row.operation);
    if (operation === null) continue;
    if (operation.idempotencyKey !== idempotencyKey) continue;
    latest = {
      paramsDigest: row.paramsDigest,
      generationId: typeof row.generationId === 'string' ? row.generationId : null,
      custody: (row.custody ?? null) as OperationRow['custody'],
      operation,
    };
  }
  return latest;
}

const TERMINAL_STATES: readonly PairingOperationState[] = ['activated', 'failed', 'aborted'];
/** receipt_persisted is the resting SUCCESS for install-without-activate. */
const COMPLETED_STATES: readonly PairingOperationState[] = ['activated', 'receipt_persisted'];

export async function executePairingSaga(
  request: PairingSagaRequest,
  paths: PairingSagaPaths,
  effects: PairingSagaEffects,
): Promise<PairingSagaOutcome> {
  const scopeId = parseAccountScopeId(request.scopeId);
  if (scopeId === null) {
    return { ok: false, errorClass: 'authorization_invalid', refusal: 'scope_invalid' };
  }
  if (request.authorizationId.length === 0) {
    return { ok: false, errorClass: 'authorization_invalid', refusal: 'authorization_required' };
  }
  const paramsDigest = paramsDigestOf(request);

  // Idempotency and crash posture come from the durable operation journal.
  const existing = readPairingOperationRecord(paths.stateRoot, request.idempotencyKey);
  if (existing !== null) {
    if (existing.paramsDigest !== paramsDigest) {
      return { ok: false, errorClass: 'verification_failed', refusal: 'parameter_drift' };
    }
    if (COMPLETED_STATES.includes(existing.operation.state) && existing.generationId !== null) {
      return { ok: true, generationId: existing.generationId, replayed: true };
    }
    if (existing.operation.state === 'failed') {
      return {
        ok: false,
        errorClass: existing.operation.errorClass ?? 'unknown',
        refusal: 'operation_already_failed',
      };
    }
    // Any persisted non-terminal state means a coordinator died mid-saga.
    // Resuming would act on state the dead run only partially established.
    return { ok: false, errorClass: 'crash_recovered', refusal: 'operation_interrupted' };
  }

  // Precondition CAS against the latch journal and generation evidence.
  const latchState = readTerminalLatchJournal(paths.stateRoot);
  if (latchState.status === 'corrupt') {
    return { ok: false, errorClass: 'verification_failed', refusal: 'latch_state_corrupt' };
  }
  if (latchState.revision !== request.expectedLatchRevision) {
    return { ok: false, errorClass: 'verification_failed', refusal: 'stale_latch_revision' };
  }
  const evidence = resolveAuthGenerationEvidenceV2(paths.stateRoot);
  const currentGenerationId = evidence.status === 'recorded_v2' ? evidence.receipt.generationId : null;
  if (request.expectedCurrentGenerationId !== currentGenerationId) {
    return { ok: false, errorClass: 'verification_failed', refusal: 'stale_expected_generation' };
  }

  const startedAtMs = effects.nowMs();
  const requestedAt = new Date(startedAtMs).toISOString();
  let custody: OperationRow['custody'] = null;
  let generationId: string | null = null;

  const journal = (
    state: PairingOperationState,
    extra: { errorClass?: PairingErrorClass | null; fencingToken?: number } = {},
  ): void => {
    const operation: PairingOperationV1 | null = parsePairingOperation({
      v: 1,
      idempotencyKey: request.idempotencyKey,
      host: request.host,
      instance: request.instance,
      scopeId,
      expectedCurrentGenerationId: request.expectedCurrentGenerationId,
      method: request.method,
      authorizationId: request.authorizationId,
      state,
      fencingToken: extra.fencingToken ?? 1,
      requestedAt,
      updatedAt: new Date(effects.nowMs()).toISOString(),
      errorClass: state === 'failed' ? (extra.errorClass ?? 'unknown') : null,
      resultGenerationId: state === 'activated' ? generationId : null,
    });
    if (operation === null) {
      throw new Error(`pairing saga built an operation row its own contract refuses (state=${state})`);
    }
    const row: OperationRow = { v: 1, paramsDigest, generationId, custody, operation };
    appendPrivateJsonLineSync(operationsJournalPath(paths.stateRoot), row);
  };

  journal('requested');

  const stopped = await effects.stopService();
  if (!stopped) {
    journal('failed', { errorClass: 'verification_failed' });
    return { ok: false, errorClass: 'verification_failed', refusal: 'service_stop_unverified' };
  }
  journal('service_stopped');

  const leaseResult = effects.acquireLease(request.idempotencyKey);
  if (!leaseResult.ok) {
    journal('failed', { errorClass: 'lease_unavailable' });
    return { ok: false, errorClass: 'lease_unavailable', refusal: leaseResult.refusal };
  }
  const lease = leaseResult.lease;
  journal('lease_acquired', { fencingToken: lease.fencingToken });

  try {
    // Quarantine the existing active tree (if any) under a unique
    // revoked-generation name. Hash BEFORE moving; rename, never delete;
    // read-only afterwards as defense in depth.
    if (existsSync(paths.authDir)) {
      const priorDigest = computeCredentialTreeDigest(paths.authDir);
      if (!priorDigest.ok) {
        journal('failed', { errorClass: 'quarantine_failed', fencingToken: lease.fencingToken });
        return { ok: false, errorClass: 'quarantine_failed', refusal: 'active_tree_unreadable' };
      }
      const quarantinePath = `${paths.authDir}.revoked.${timestampTag(effects.nowMs())}`;
      renameSync(paths.authDir, quarantinePath);
      fsyncDirectory(dirname(paths.authDir));
      try {
        chmodSync(quarantinePath, 0o500);
      } catch {
        // intentional: read-only is defense in depth, not an immutability
        // claim - the custody digest above is the integrity anchor.
      }
      custody = {
        priorTreeDigest: priorDigest.digest,
        priorFileCount: priorDigest.fileCount,
        quarantinePath,
      };
    }
    journal('quarantined', { fencingToken: lease.fencingToken });

    // Pair directly into the FINAL active directory — a later rename would
    // change the identity the generation receipt vouches for.
    mkdirSync(paths.authDir, { recursive: true, mode: 0o700 });
    journal('pairing', { fencingToken: lease.fencingToken });
    const helper = await effects.runPairingHelper({ authDir: paths.authDir, lease });
    if (!helper.ok) {
      quarantineIncomplete(paths, effects.nowMs());
      journal('failed', { errorClass: helper.errorClass, fencingToken: lease.fencingToken });
      return { ok: false, errorClass: helper.errorClass, refusal: 'pairing_helper_failed' };
    }

    const persisted = persistAuthGenerationReceiptV2({
      scopeId,
      operationId: request.idempotencyKey,
      authDir: paths.authDir,
      stateRoot: paths.stateRoot,
      createdAtMs: effects.nowMs(),
      persistedAtMs: effects.nowMs(),
      effectiveClient: null,
      actorOperationId: request.actorOperationId,
    });
    if (!persisted.ok) {
      quarantineIncomplete(paths, effects.nowMs());
      journal('failed', { errorClass: 'receipt_write_failed', fencingToken: lease.fencingToken });
      return { ok: false, errorClass: 'receipt_write_failed', refusal: 'generation_receipt_unpersisted' };
    }
    generationId = persisted.receipt.generationId;

    // Supersede the latch for exactly this generation. The fresh tree is
    // NEVER quarantined on a supersession refusal — the credentials are
    // valid; the operator resolves the journal conflict and retries the
    // transition, not the pairing.
    const latchNow = readTerminalLatchJournal(paths.stateRoot);
    if (latchNow.status === 'active') {
      const superseded = appendLatchTransition(paths.stateRoot, {
        v: 1,
        scopeId,
        kind: 'generation_superseded',
        revision: latchNow.revision + 1,
        expectedPriorRevision: latchNow.revision,
        at: new Date(effects.nowMs()).toISOString(),
        operationId: `${request.idempotencyKey}.supersede`,
        ownerAuthorizationId: null,
        latch: null,
        supersededByGenerationId: generationId,
      });
      if (!superseded.ok) {
        journal('failed', { errorClass: 'verification_failed', fencingToken: lease.fencingToken });
        return { ok: false, errorClass: 'verification_failed', refusal: 'latch_supersession_refused' };
      }
    }
    journal('receipt_persisted', { fencingToken: lease.fencingToken });

    if (request.startService) {
      const started = await effects.startService();
      if (!started) {
        journal('failed', { errorClass: 'verification_failed', fencingToken: lease.fencingToken });
        return { ok: false, errorClass: 'verification_failed', refusal: 'service_start_unverified' };
      }
      journal('activated', { fencingToken: lease.fencingToken });
    }

    return { ok: true, generationId };
  } finally {
    effects.releaseLease(lease);
  }
}

function timestampTag(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/[:.]/g, '-');
}

function quarantineIncomplete(paths: PairingSagaPaths, nowMs: number): void {
  if (!existsSync(paths.authDir)) return;
  try {
    if (readdirSync(paths.authDir).length === 0) return;
  } catch {
    // intentional: an unreadable incomplete tree is still moved aside so
    // nothing can present it as active auth.
  }
  const failedPath = `${paths.authDir}.failed.${timestampTag(nowMs)}`;
  renameSync(paths.authDir, failedPath);
  fsyncDirectory(dirname(paths.authDir));
}

export interface PairingPreflightPlan {
  latch:
    | { status: 'missing' | 'active' | 'superseded' | 'released'; revision: number }
    | { status: 'corrupt' };
  activeTree: ReturnType<typeof observeActiveTree>;
  generationEvidence: AuthGenerationEvidenceV2;
  lease: { status: 'vacant' } | { status: 'held'; mode: string } | { status: 'corrupt' };
  lastOperation: { idempotencyKey: string; state: PairingOperationState } | null;
}

/** Side-effect-free preflight: the typed plan an operator reviews before apply. */
export function pairingPreflight(paths: PairingSagaPaths): PairingPreflightPlan {
  const latchState: LatchJournalState = readTerminalLatchJournal(paths.stateRoot);
  const latch: PairingPreflightPlan['latch'] = latchState.status === 'corrupt'
    ? { status: 'corrupt' }
    : { status: latchState.status, revision: latchState.revision };

  let lease: PairingPreflightPlan['lease'] = { status: 'vacant' };
  try {
    const leaseFiles = existsSync(paths.stateRoot)
      ? readdirSync(paths.stateRoot).filter(
          name => name.startsWith('coordination-lease.') && name.endsWith('.json') && !name.endsWith('.last-token.json'),
        )
      : [];
    for (const name of leaseFiles) {
      let parsed: CoordinationLeaseV1 | null = null;
      try {
        const raw = readPrivateFileSync(join(paths.stateRoot, name), {
          maxBytes: 64 * 1024,
          label: 'coordination lease',
        });
        parsed = raw === null ? null : parseCoordinationLease(JSON.parse(raw));
      } catch {
        // intentional: an unreadable lease file surfaces as 'corrupt' in the
        // preflight plan below rather than as an exception.
        parsed = null;
      }
      lease = parsed === null ? { status: 'corrupt' } : { status: 'held', mode: parsed.mode };
      break;
    }
  } catch {
    // intentional: a lease directory that cannot be scanned reads as
    // 'corrupt' in the plan - fail closed, never vacant.
    lease = { status: 'corrupt' };
  }

  const tail = readLastOperationTail(paths.stateRoot);
  return {
    latch,
    activeTree: observeActiveTree(paths.authDir),
    generationEvidence: resolveAuthGenerationEvidenceV2(paths.stateRoot),
    lease,
    lastOperation: tail,
  };
}

function readLastOperationTail(
  stateRoot: string,
): { idempotencyKey: string; state: PairingOperationState } | null {
  if (!existsSync(operationsJournalPath(stateRoot))) return null;
  let raw: string | null;
  try {
    raw = readPrivateFileSync(operationsJournalPath(stateRoot), {
      maxBytes: MAX_OPERATIONS_JOURNAL_BYTES,
      label: 'pairing operations journal',
    });
  } catch {
    // intentional: an unreadable journal yields no tail row for the
    // side-effect-free preflight plan.
    return null;
  }
  if (raw === null) return null;
  let tail: { idempotencyKey: string; state: PairingOperationState } | null = null;
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    try {
      const row = JSON.parse(line) as Partial<OperationRow>;
      const operation = parsePairingOperation(row.operation);
      if (operation !== null) {
        tail = { idempotencyKey: operation.idempotencyKey, state: operation.state };
      }
    } catch {
      // intentional: unreadable rows are skipped while scanning for the tail;
      // the operation journal is append-only evidence.
      continue;
    }
  }
  return tail;
}
