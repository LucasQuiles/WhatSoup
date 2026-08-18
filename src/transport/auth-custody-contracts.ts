// src/transport/auth-custody-contracts.ts
//
// T1 of the q-canary re-pair enablement lane: closed, bounded, versioned wire
// contracts frozen BEFORE any runtime producer or consumer exists. Every parser
// here is exact-key and fail-closed: unknown keys, missing keys, wrong types,
// out-of-bounds values, and cross-version payloads all return null. A caller
// that receives null must refuse — never repair, never default.
//
// The scope identity rule deserves its one sentence: an AccountScopeIdV1 is an
// OPAQUE CONFIGURED identifier. It must never be inferred from a directory
// path, phone number, JID, or operator label — the charset and shape rules
// below make those inferences structurally unrepresentable rather than merely
// discouraged.

const SCOPE_PREFIX = 'scope:';
const SCOPE_TAIL_RE = /^[a-z0-9-]{4,59}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const ADVISORY_HASH_RE = /^[0-9a-f]{8,64}$/;
const MAX_TOKEN_LENGTH = 128;
const MAX_CLIENT_SUBTREE_BYTES = 8 * 1024;
const MAX_CLIENT_SUBTREE_DEPTH = 3;
const MAX_CLIENT_LEAF_STRING = 512;

export type AccountScopeIdV1 = string & { readonly __accountScopeIdV1: unique symbol };

export function parseAccountScopeId(value: unknown): AccountScopeIdV1 | null {
  if (typeof value !== 'string') return null;
  if (!value.startsWith(SCOPE_PREFIX)) return null;
  const tail = value.slice(SCOPE_PREFIX.length);
  if (!SCOPE_TAIL_RE.test(tail)) return null;
  // A digits-and-dashes-only tail can smuggle a phone number through the
  // charset; require at least one letter so the identifier stays opaque.
  if (!/[a-z]/.test(tail)) return null;
  return value as AccountScopeIdV1;
}

export const COORDINATION_LEASE_MODES = [
  'pairing',
  'runtime_start',
  'watchdog_maintenance',
  'route_orchestration',
] as const;
export type CoordinationLeaseMode = (typeof COORDINATION_LEASE_MODES)[number];

export interface CoordinationLeaseV1 {
  v: 1;
  scopeId: AccountScopeIdV1;
  operationId: string;
  hostId: string;
  bootId: string;
  processBirthToken: string;
  pid: number;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
  fencingToken: number;
  mode: CoordinationLeaseMode;
}

export interface AuthGenerationReceiptV2 {
  v: 2;
  scopeId: AccountScopeIdV1;
  generationId: string;
  operationId: string;
  credentialTreeDigest: string;
  createdAt: string;
  persistedAt: string;
  effectiveClient: Record<string, unknown> | null;
  actorOperationId: string | null;
  advisoryAuthRootHash: string | null;
}

export interface BackupCandidateManifestV2 {
  v: 2;
  snapshotId: string;
  sourceGenerationId: string;
  credentialTreeDigest: string;
  snapshotAt: string;
  inventoryDigest: string;
}

export const PAIRING_METHODS = ['pairing_code', 'qr'] as const;
export type PairingMethod = (typeof PAIRING_METHODS)[number];

export const PAIRING_OPERATION_STATES = [
  'requested',
  'lease_acquired',
  'service_stopped',
  'quarantined',
  'pairing',
  'receipt_persisted',
  'activated',
  'failed',
  'aborted',
] as const;
export type PairingOperationState = (typeof PAIRING_OPERATION_STATES)[number];

export const PAIRING_ERROR_CLASSES = [
  'lease_unavailable',
  'authorization_invalid',
  'quarantine_failed',
  'pairing_timeout',
  'pairing_rejected',
  'receipt_write_failed',
  'verification_failed',
  'aborted_by_operator',
  'crash_recovered',
  'unknown',
] as const;
export type PairingErrorClass = (typeof PAIRING_ERROR_CLASSES)[number];

export interface PairingOperationV1 {
  v: 1;
  idempotencyKey: string;
  host: string;
  instance: string;
  scopeId: AccountScopeIdV1;
  expectedCurrentGenerationId: string | null;
  method: PairingMethod;
  authorizationId: string;
  state: PairingOperationState;
  fencingToken: number;
  requestedAt: string;
  updatedAt: string;
  errorClass: PairingErrorClass | null;
  resultGenerationId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(record);
  if (present.length !== keys.length) return false;
  return keys.every(key => Object.prototype.hasOwnProperty.call(record, key));
}

function boundedToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > MAX_TOKEN_LENGTH) return null;
  return value;
}

function positiveInt(value: unknown): number | null {
  // typeof distinguishes booleans from numbers in JS, but the explicit guard
  // documents the contract: true must never satisfy an integer field.
  if (typeof value !== 'number' || typeof value === 'boolean') return null;
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

function isoInstantMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function hex64(value: unknown): string | null {
  if (typeof value !== 'string' || !HEX64_RE.test(value)) return null;
  return value;
}

/**
 * Bounded, scalar-leaf JSON subtree. This is deliberately NOT `unknown`: an
 * unbounded shadow field once cost a whole forensic row to one cyclic value.
 * Objects only, depth-capped, byte-capped, leaves restricted to scalars.
 */
function boundedClientSubtree(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (!walkBounded(value, 1)) return null;
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf-8') > MAX_CLIENT_SUBTREE_BYTES) return null;
  return value;
}

function walkBounded(record: Record<string, unknown>, depth: number): boolean {
  if (depth > MAX_CLIENT_SUBTREE_DEPTH) return false;
  for (const leaf of Object.values(record)) {
    if (leaf === null) continue;
    if (typeof leaf === 'string') {
      if (leaf.length > MAX_CLIENT_LEAF_STRING) return false;
      continue;
    }
    if (typeof leaf === 'number') {
      if (!Number.isFinite(leaf)) return false;
      continue;
    }
    if (typeof leaf === 'boolean') continue;
    if (isRecord(leaf)) {
      if (!walkBounded(leaf, depth + 1)) return false;
      continue;
    }
    return false;
  }
  return true;
}

const LEASE_KEYS = [
  'v', 'scopeId', 'operationId', 'hostId', 'bootId', 'processBirthToken',
  'pid', 'acquiredAt', 'renewedAt', 'expiresAt', 'fencingToken', 'mode',
] as const;

export function parseCoordinationLease(value: unknown): CoordinationLeaseV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, LEASE_KEYS)) return null;
  if (value.v !== 1) return null;
  const scopeId = parseAccountScopeId(value.scopeId);
  const operationId = boundedToken(value.operationId);
  const hostId = boundedToken(value.hostId);
  const bootId = boundedToken(value.bootId);
  const processBirthToken = boundedToken(value.processBirthToken);
  const pid = positiveInt(value.pid);
  const fencingToken = positiveInt(value.fencingToken);
  const acquiredAtMs = isoInstantMs(value.acquiredAt);
  const renewedAtMs = isoInstantMs(value.renewedAt);
  const expiresAtMs = isoInstantMs(value.expiresAt);
  const mode = COORDINATION_LEASE_MODES.find(m => m === value.mode) ?? null;
  if (
    scopeId === null || operationId === null || hostId === null || bootId === null ||
    processBirthToken === null || pid === null || fencingToken === null ||
    acquiredAtMs === null || renewedAtMs === null || expiresAtMs === null || mode === null
  ) {
    return null;
  }
  if (renewedAtMs < acquiredAtMs) return null;
  if (expiresAtMs <= renewedAtMs) return null;
  return {
    v: 1,
    scopeId,
    operationId,
    hostId,
    bootId,
    processBirthToken,
    pid,
    acquiredAt: value.acquiredAt as string,
    renewedAt: value.renewedAt as string,
    expiresAt: value.expiresAt as string,
    fencingToken,
    mode,
  };
}

const GENERATION_RECEIPT_KEYS = [
  'v', 'scopeId', 'generationId', 'operationId', 'credentialTreeDigest',
  'createdAt', 'persistedAt', 'effectiveClient', 'actorOperationId', 'advisoryAuthRootHash',
] as const;

export function parseAuthGenerationReceiptV2(value: unknown): AuthGenerationReceiptV2 | null {
  if (!isRecord(value) || !hasExactKeys(value, GENERATION_RECEIPT_KEYS)) return null;
  if (value.v !== 2) return null;
  const scopeId = parseAccountScopeId(value.scopeId);
  const generationId = boundedToken(value.generationId);
  const operationId = boundedToken(value.operationId);
  const credentialTreeDigest = hex64(value.credentialTreeDigest);
  const createdAtMs = isoInstantMs(value.createdAt);
  const persistedAtMs = isoInstantMs(value.persistedAt);
  if (
    scopeId === null || generationId === null || operationId === null ||
    credentialTreeDigest === null || createdAtMs === null || persistedAtMs === null
  ) {
    return null;
  }
  if (persistedAtMs < createdAtMs) return null;
  let effectiveClient: Record<string, unknown> | null = null;
  if (value.effectiveClient !== null) {
    effectiveClient = boundedClientSubtree(value.effectiveClient);
    if (effectiveClient === null) return null;
  }
  let actorOperationId: string | null = null;
  if (value.actorOperationId !== null) {
    actorOperationId = boundedToken(value.actorOperationId);
    if (actorOperationId === null) return null;
  }
  let advisoryAuthRootHash: string | null = null;
  if (value.advisoryAuthRootHash !== null) {
    if (typeof value.advisoryAuthRootHash !== 'string' || !ADVISORY_HASH_RE.test(value.advisoryAuthRootHash)) {
      return null;
    }
    advisoryAuthRootHash = value.advisoryAuthRootHash;
  }
  return {
    v: 2,
    scopeId,
    generationId,
    operationId,
    credentialTreeDigest,
    createdAt: value.createdAt as string,
    persistedAt: value.persistedAt as string,
    effectiveClient,
    actorOperationId,
    advisoryAuthRootHash,
  };
}

const MANIFEST_KEYS = [
  'v', 'snapshotId', 'sourceGenerationId', 'credentialTreeDigest', 'snapshotAt', 'inventoryDigest',
] as const;

export function parseBackupCandidateManifest(value: unknown): BackupCandidateManifestV2 | null {
  if (!isRecord(value) || !hasExactKeys(value, MANIFEST_KEYS)) return null;
  if (value.v !== 2) return null;
  const snapshotId = boundedToken(value.snapshotId);
  const sourceGenerationId = boundedToken(value.sourceGenerationId);
  const credentialTreeDigest = hex64(value.credentialTreeDigest);
  const inventoryDigest = hex64(value.inventoryDigest);
  const snapshotAtMs = isoInstantMs(value.snapshotAt);
  if (
    snapshotId === null || sourceGenerationId === null || credentialTreeDigest === null ||
    inventoryDigest === null || snapshotAtMs === null
  ) {
    return null;
  }
  return {
    v: 2,
    snapshotId,
    sourceGenerationId,
    credentialTreeDigest,
    snapshotAt: value.snapshotAt as string,
    inventoryDigest,
  };
}

const PAIRING_OPERATION_KEYS = [
  'v', 'idempotencyKey', 'host', 'instance', 'scopeId', 'expectedCurrentGenerationId',
  'method', 'authorizationId', 'state', 'fencingToken', 'requestedAt', 'updatedAt',
  'errorClass', 'resultGenerationId',
] as const;

export function parsePairingOperation(value: unknown): PairingOperationV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, PAIRING_OPERATION_KEYS)) return null;
  if (value.v !== 1) return null;
  const idempotencyKey = boundedToken(value.idempotencyKey);
  const host = boundedToken(value.host);
  const instance = boundedToken(value.instance);
  const scopeId = parseAccountScopeId(value.scopeId);
  const authorizationId = boundedToken(value.authorizationId);
  const fencingToken = positiveInt(value.fencingToken);
  const requestedAtMs = isoInstantMs(value.requestedAt);
  const updatedAtMs = isoInstantMs(value.updatedAt);
  const method = PAIRING_METHODS.find(m => m === value.method) ?? null;
  const state = PAIRING_OPERATION_STATES.find(s => s === value.state) ?? null;
  if (
    idempotencyKey === null || host === null || instance === null || scopeId === null ||
    authorizationId === null || fencingToken === null || requestedAtMs === null ||
    updatedAtMs === null || method === null || state === null
  ) {
    return null;
  }
  if (updatedAtMs < requestedAtMs) return null;
  let expectedCurrentGenerationId: string | null = null;
  if (value.expectedCurrentGenerationId !== null) {
    expectedCurrentGenerationId = boundedToken(value.expectedCurrentGenerationId);
    if (expectedCurrentGenerationId === null) return null;
  }
  let errorClass: PairingErrorClass | null = null;
  if (value.errorClass !== null) {
    errorClass = PAIRING_ERROR_CLASSES.find(c => c === value.errorClass) ?? null;
    if (errorClass === null) return null;
  }
  // errorClass carries meaning only on the failed state; anywhere else it is a
  // contradiction, and a failed operation without one is unexplained.
  if ((state === 'failed') !== (errorClass !== null)) return null;
  let resultGenerationId: string | null = null;
  if (value.resultGenerationId !== null) {
    resultGenerationId = boundedToken(value.resultGenerationId);
    if (resultGenerationId === null) return null;
  }
  // A result generation exists exactly at activation: earlier it is a claim
  // without a verified receipt, and failed/aborted operations must not carry one.
  if ((state === 'activated') !== (resultGenerationId !== null)) return null;
  return {
    v: 1,
    idempotencyKey,
    host,
    instance,
    scopeId,
    expectedCurrentGenerationId,
    method,
    authorizationId,
    state,
    fencingToken,
    requestedAt: value.requestedAt as string,
    updatedAt: value.updatedAt as string,
    errorClass,
    resultGenerationId,
  };
}

// The pairing saga's legal moves. Forward-only, quarantine before pairing,
// receipt before activation, terminal states absorbing. Failure/abort are legal
// from every non-terminal state so a crash never needs an illegal transition to
// record what happened.
const PAIRING_FORWARD_EDGES: Readonly<Record<PairingOperationState, readonly PairingOperationState[]>> = {
  // Stop BEFORE acquiring: a running runtime holds the scope lease as a live
  // owner, so acquisition can only succeed after its stop releases it. The
  // coordinator then races any concurrent restart for the lease (T4.3).
  requested: ['service_stopped'],
  service_stopped: ['lease_acquired'],
  lease_acquired: ['quarantined'],
  quarantined: ['pairing'],
  pairing: ['receipt_persisted'],
  receipt_persisted: ['activated'],
  activated: [],
  failed: [],
  aborted: [],
};

const PAIRING_TERMINAL_STATES: readonly PairingOperationState[] = ['activated', 'failed', 'aborted'];

export function isPairingStateTransitionAllowed(
  from: PairingOperationState,
  to: PairingOperationState,
): boolean {
  if (PAIRING_TERMINAL_STATES.includes(from)) return false;
  if (to === 'failed' || to === 'aborted') return true;
  return PAIRING_FORWARD_EDGES[from].includes(to);
}
