import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import {
  canonicalizeBoundaryRun,
  hasDirectStatus,
  hasExactKeys,
  isBoundedText,
  isOid,
  isOperationalId,
  isRecord,
  isTimestamp,
  sha256Bytes,
} from '../verification/boundary-run/shared.ts';
import { parseBoundaryJsonBytes } from '../verification/boundary-run/schema.ts';
import { assertBoundedEvidenceGraph } from './preconditions.ts';

export type AttemptLifecycle = 'created' | 'running' | 'finalizing' | 'terminal' | 'cancelled' | 'timed-out' | 'corrupt';
export type TerminalLifecycle = Exclude<AttemptLifecycle, 'created' | 'running' | 'finalizing'>;

export type ProcessStartIdentityV1 =
  | { source: 'linux-proc-stat'; bootId: string; startTicks: string }
  | { source: 'darwin-proc-bsdinfo'; bootId: string; startSec: number; startUsec: number };

export interface ProcessIdentityV1 {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  start: ProcessStartIdentityV1;
}

export interface SupervisorProcessLeaseV1 {
  schemaVersion: 1;
  attemptId: string;
  leaseId: string;
  issuedAt: string;
  validUntil: string;
  challengeDigest: string;
  supervisorToolDigest: string;
  identityProbeDigest: string;
  closeObserverDigest: string;
  supervisor: ProcessIdentityV1;
  anchor: ProcessIdentityV1;
  target: ProcessIdentityV1;
  commandDigest: string;
  cwdDigest: string;
  environmentDigest: string;
}

export interface SupervisorLeaseExpectationsV1 {
  attemptId: string;
  callerPid: number;
  supervisorPid: number;
  challengeDigest: string;
  supervisorToolDigest: string;
  identityProbeDigest: string;
  closeObserverDigest: string;
  commandDigest: string;
  cwdDigest: string;
  environmentDigest: string;
}

export interface SupervisorTerminalV1 {
  schemaVersion: 1;
  attemptId: string;
  leaseDigest: string;
  terminalAt: string;
  targetStatus: { rawExit: number | null; rawSignal: string | null; timedOut: boolean };
  anchorStatus: { rawExit: number | null; rawSignal: string | null };
  finalGroup: {
    status: 'empty';
    observedAt: string;
    leaseDigest: string;
    identityProbeDigest: string;
    lastMatchedSnapshot: { supervisor: ProcessIdentityV1; anchor: ProcessIdentityV1; target: ProcessIdentityV1 };
    members: [];
  };
}

export interface SupervisorCloseV1 {
  schemaVersion: 1;
  attemptId: string;
  leaseDigest: string;
  supervisorPid: number;
  rawExit: number | null;
  rawSignal: string | null;
  observerDigest: string;
  closedAt: string;
}

export interface TerminalAttemptV1 {
  schemaVersion: 1;
  id: string;
  lifecycle: TerminalLifecycle;
  createdAt: string;
  terminalAt: string;
  rawExit: number | null;
  rawSignal: string | null;
  timedOut: boolean;
  terminationProof: {
    schemaVersion: 1;
    leaseDigest: string;
    supervisorTerminalDigest: string;
    supervisorCloseDigest: string;
    supervisorDigest: string;
    observedAt: string;
    status: 'reaped';
  };
  evidenceBinding: {
    controlId: string;
    candidateOid: string;
    manifestDigest: string;
    policyDigest: string;
    toolDigest: string;
    platformDigest: string;
    preconditionDigest: string;
    producerDigest: string;
    scannerPolicyReceiptDigest: string;
    resultEvidenceDigest: string;
  };
  historySequence: number;
  historyEntryDigest: string;
}

interface ValidationClock { now?: number }
interface LeaseReadOptions extends ValidationClock { expectedLease?: SupervisorLeaseExpectationsV1 }
interface FinalizedClose { supervisorCloseDigest: string; historyEntryDigest: string }
interface TerminalAttemptAdmissionOptions extends ValidationClock {
  leaseDigest: string;
  supervisorTerminalDigest: string;
  supervisorCloseDigest: string;
  expectedLease: SupervisorLeaseExpectationsV1;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const TERMINALS = new Set<AttemptLifecycle>(['terminal', 'cancelled', 'timed-out', 'corrupt']);
const MAX_EVIDENCE_BYTES = 16_384;
const MAX_VALIDITY_MS = 24 * 60 * 60_000;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const ATTEMPT_KEYS = ['createdAt', 'evidenceBinding', 'historyEntryDigest', 'historySequence', 'id', 'lifecycle', 'rawExit', 'rawSignal', 'schemaVersion', 'terminalAt', 'terminationProof', 'timedOut'] as const;
const TERMINATION_KEYS = ['leaseDigest', 'observedAt', 'schemaVersion', 'status', 'supervisorCloseDigest', 'supervisorDigest', 'supervisorTerminalDigest'] as const;
const EVIDENCE_BINDING_KEYS = ['candidateOid', 'controlId', 'manifestDigest', 'platformDigest', 'policyDigest', 'preconditionDigest', 'producerDigest', 'resultEvidenceDigest', 'scannerPolicyReceiptDigest', 'toolDigest'] as const;
const LEASE_KEYS = ['anchor', 'attemptId', 'challengeDigest', 'closeObserverDigest', 'commandDigest', 'cwdDigest', 'environmentDigest', 'identityProbeDigest', 'issuedAt', 'leaseId', 'schemaVersion', 'supervisor', 'supervisorToolDigest', 'target', 'validUntil'] as const;
const EXPECTATION_KEYS = ['attemptId', 'callerPid', 'challengeDigest', 'closeObserverDigest', 'commandDigest', 'cwdDigest', 'environmentDigest', 'identityProbeDigest', 'supervisorPid', 'supervisorToolDigest'] as const;
const SNAPSHOT_KEYS = ['anchor', 'supervisor', 'target'] as const;
const IDENTITY_KEYS = ['pgid', 'pid', 'ppid', 'sid', 'start'] as const;
const LINUX_START_KEYS = ['bootId', 'source', 'startTicks'] as const;
const DARWIN_START_KEYS = ['bootId', 'source', 'startSec', 'startUsec'] as const;
const TERMINAL_KEYS = ['anchorStatus', 'attemptId', 'finalGroup', 'leaseDigest', 'schemaVersion', 'targetStatus', 'terminalAt'] as const;
const TARGET_STATUS_KEYS = ['rawExit', 'rawSignal', 'timedOut'] as const;
const ANCHOR_STATUS_KEYS = ['rawExit', 'rawSignal'] as const;
const FINAL_GROUP_KEYS = ['identityProbeDigest', 'lastMatchedSnapshot', 'leaseDigest', 'members', 'observedAt', 'status'] as const;
const CLOSE_KEYS = ['attemptId', 'closedAt', 'leaseDigest', 'observerDigest', 'rawExit', 'rawSignal', 'schemaVersion', 'supervisorPid'] as const;
const HISTORY_KEYS = ['at', 'attemptId', 'lifecycle', 'predecessorDigest', 'schemaVersion', 'sequence'] as const;

function digestCore(value: unknown): string {
  return `sha256:${sha256Bytes(canonicalizeBoundaryRun(value))}`;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function isPositivePid(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function requireExactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, keys)) throw new Error(`${label} keys are invalid`);
  return value;
}

function validateTimestampWindow(createdAt: string, validUntil: string, now: number): void {
  const created = Date.parse(createdAt);
  const valid = Date.parse(validUntil);
  if (created > now + MAX_FUTURE_SKEW_MS || valid < created || valid < now || valid - created > MAX_VALIDITY_MS) throw new Error('supervisor lease freshness is invalid');
}

function validateStartIdentity(value: unknown): ProcessStartIdentityV1 {
  if (!isRecord(value)) throw new Error('process start identity is invalid');
  if (value.source === 'linux-proc-stat') {
    const start = requireExactRecord(value, LINUX_START_KEYS, 'Linux process start identity');
    if (!isBoundedText(start.bootId, 256) || typeof start.startTicks !== 'string' || !POSITIVE_DECIMAL.test(start.startTicks) || start.startTicks.length > 32) throw new Error('Linux process start identity is invalid');
    return start as unknown as ProcessStartIdentityV1;
  }
  if (value.source === 'darwin-proc-bsdinfo') {
    const start = requireExactRecord(value, DARWIN_START_KEYS, 'Darwin process start identity');
    if (!isBoundedText(start.bootId, 256) || !Number.isSafeInteger(start.startSec) || Number(start.startSec) <= 0 || !Number.isSafeInteger(start.startUsec) || Number(start.startUsec) < 0 || Number(start.startUsec) > 999_999) throw new Error('Darwin process start identity is invalid');
    return start as unknown as ProcessStartIdentityV1;
  }
  throw new Error('process start identity source is invalid');
}

function validateProcessIdentity(value: unknown, label: string): ProcessIdentityV1 {
  const identity = requireExactRecord(value, IDENTITY_KEYS, label);
  if (![identity.pid, identity.ppid, identity.pgid, identity.sid].every(isPositivePid)) throw new Error(`${label} numeric identity is invalid`);
  return { ...identity, start: validateStartIdentity(identity.start) } as unknown as ProcessIdentityV1;
}

function validateLeaseShape(value: unknown): SupervisorProcessLeaseV1 {
  assertBoundedEvidenceGraph(value, { maxDepth: 5, maxItems: 32, maxNodes: 64, maxStringBytes: 2_048 });
  const lease = requireExactRecord(value, LEASE_KEYS, 'supervisor lease');
  if (lease.schemaVersion !== 1 || !isOperationalId(lease.attemptId) || !isOperationalId(lease.leaseId) || !isTimestamp(lease.issuedAt) || !isTimestamp(lease.validUntil)) throw new Error('supervisor lease identity is invalid');
  for (const key of ['challengeDigest', 'supervisorToolDigest', 'identityProbeDigest', 'closeObserverDigest', 'commandDigest', 'cwdDigest', 'environmentDigest']) if (!isDigest(lease[key])) throw new Error(`supervisor lease ${key} binding is invalid`);
  const supervisor = validateProcessIdentity(lease.supervisor, 'supervisor identity');
  const anchor = validateProcessIdentity(lease.anchor, 'anchor identity');
  const target = validateProcessIdentity(lease.target, 'target identity');
  if (anchor.ppid !== supervisor.pid || anchor.pid !== anchor.pgid || anchor.pid !== anchor.sid || anchor.sid === supervisor.sid || anchor.pgid === supervisor.pgid) throw new Error('supervisor anchor process topology or session is invalid');
  if (target.ppid !== anchor.pid || target.pgid !== anchor.pid || target.sid !== anchor.pid || new Set([supervisor.pid, anchor.pid, target.pid]).size !== 3) throw new Error('supervisor target process topology is invalid');
  const bootIds = [supervisor.start.bootId, anchor.start.bootId, target.start.bootId];
  if (new Set(bootIds).size !== 1) throw new Error('supervisor process boot identity mismatch');
  if (new Set([supervisor.start.source, anchor.start.source, target.start.source]).size !== 1) throw new Error('supervisor process start identity source mismatch');
  return { ...lease, supervisor, anchor, target } as unknown as SupervisorProcessLeaseV1;
}

function validateExpectations(value: SupervisorLeaseExpectationsV1): void {
  assertBoundedEvidenceGraph(value, { maxDepth: 2, maxItems: 16, maxNodes: 4, maxStringBytes: 2_048 });
  if (!isRecord(value) || !hasExactKeys(value, EXPECTATION_KEYS) || !isOperationalId(value.attemptId) || !isPositivePid(value.callerPid) || !isPositivePid(value.supervisorPid)) throw new Error('trusted supervisor lease expectation keys or identity are invalid');
  for (const key of ['challengeDigest', 'supervisorToolDigest', 'identityProbeDigest', 'closeObserverDigest', 'commandDigest', 'cwdDigest', 'environmentDigest'] as const) if (!isDigest(value[key])) throw new Error('trusted supervisor lease expectation binding is invalid');
}

export function validateSupervisorProcessLease(value: unknown, expected: SupervisorLeaseExpectationsV1, options: ValidationClock = {}): SupervisorProcessLeaseV1 {
  validateExpectations(expected);
  const lease = validateLeaseShape(value);
  validateTimestampWindow(lease.issuedAt, lease.validUntil, options.now ?? Date.now());
  if (lease.attemptId !== expected.attemptId || lease.supervisor.pid !== expected.supervisorPid || lease.supervisor.ppid !== expected.callerPid) throw new Error('supervisor lease parent or process identity does not match trusted expectations');
  for (const key of ['challengeDigest', 'supervisorToolDigest', 'identityProbeDigest', 'closeObserverDigest', 'commandDigest', 'cwdDigest', 'environmentDigest'] as const) if (lease[key] !== expected[key]) throw new Error(`supervisor lease ${key} does not match trusted binding`);
  return lease;
}

export function supervisorProcessLeaseDigest(value: SupervisorProcessLeaseV1): string {
  return digestCore(validateLeaseShape(value));
}

export type SupervisorLeaseRevalidation = 'match' | 'missing' | 'drift';

export function revalidateSupervisorLease(leaseValue: SupervisorProcessLeaseV1, snapshotValue: unknown): SupervisorLeaseRevalidation {
  if (snapshotValue === null || snapshotValue === undefined) return 'missing';
  try {
    const lease = validateLeaseShape(leaseValue);
    assertBoundedEvidenceGraph(snapshotValue, { maxDepth: 4, maxItems: 16, maxNodes: 24, maxStringBytes: 2_048 });
    const snapshot = requireExactRecord(snapshotValue, SNAPSHOT_KEYS, 'supervisor identity snapshot');
    const normalized = {
      supervisor: validateProcessIdentity(snapshot.supervisor, 'snapshot supervisor identity'),
      anchor: validateProcessIdentity(snapshot.anchor, 'snapshot anchor identity'),
      target: validateProcessIdentity(snapshot.target, 'snapshot target identity'),
    };
    const expected = { supervisor: lease.supervisor, anchor: lease.anchor, target: lease.target };
    return canonicalizeBoundaryRun(normalized) === canonicalizeBoundaryRun(expected) ? 'match' : 'drift';
  } catch {
    return 'drift';
  }
}

function validateTerminalShape(value: unknown, lease: SupervisorProcessLeaseV1): SupervisorTerminalV1 {
  assertBoundedEvidenceGraph(value, { maxDepth: 4, maxItems: 24, maxNodes: 32, maxStringBytes: 2_048 });
  const terminal = requireExactRecord(value, TERMINAL_KEYS, 'supervisor terminal receipt');
  const targetStatus = requireExactRecord(terminal.targetStatus, TARGET_STATUS_KEYS, 'target direct status');
  const anchorStatus = requireExactRecord(terminal.anchorStatus, ANCHOR_STATUS_KEYS, 'anchor direct status');
  const finalGroup = requireExactRecord(terminal.finalGroup, FINAL_GROUP_KEYS, 'final process group proof');
  if (terminal.schemaVersion !== 1 || terminal.attemptId !== lease.attemptId || terminal.leaseDigest !== supervisorProcessLeaseDigest(lease) || !isTimestamp(terminal.terminalAt)) throw new Error('supervisor terminal lease binding is invalid');
  if (!hasDirectStatus(targetStatus.rawExit, targetStatus.rawSignal) || typeof targetStatus.timedOut !== 'boolean' || !hasDirectStatus(anchorStatus.rawExit, anchorStatus.rawSignal)) throw new Error('supervisor terminal direct status is invalid');
  const lastMatchedSnapshot = requireExactRecord(finalGroup.lastMatchedSnapshot, SNAPSHOT_KEYS, 'final matched identity snapshot');
  if (finalGroup.status !== 'empty' || !isTimestamp(finalGroup.observedAt) || finalGroup.leaseDigest !== supervisorProcessLeaseDigest(lease) || finalGroup.identityProbeDigest !== lease.identityProbeDigest || !Array.isArray(finalGroup.members) || finalGroup.members.length !== 0 || revalidateSupervisorLease(lease, lastMatchedSnapshot) !== 'match' || Date.parse(finalGroup.observedAt) < Date.parse(lease.issuedAt) || Date.parse(finalGroup.observedAt) > Date.parse(terminal.terminalAt) || Date.parse(terminal.terminalAt) < Date.parse(lease.issuedAt)) throw new Error('supervisor terminal group-empty revalidation or chronology is invalid');
  return { ...terminal, targetStatus, anchorStatus, finalGroup } as unknown as SupervisorTerminalV1;
}

export function validateSupervisorTerminal(value: unknown, leaseValue: SupervisorProcessLeaseV1, options: ValidationClock = {}): SupervisorTerminalV1 {
  const lease = validateLeaseShape(leaseValue);
  const terminal = validateTerminalShape(value, lease);
  const now = options.now ?? Date.now();
  if (Date.parse(terminal.terminalAt) > now + MAX_FUTURE_SKEW_MS || now - Date.parse(terminal.terminalAt) > MAX_VALIDITY_MS) throw new Error('supervisor terminal receipt is stale or future-dated');
  return terminal;
}

export function supervisorTerminalDigest(value: SupervisorTerminalV1, lease: SupervisorProcessLeaseV1): string {
  return digestCore(validateTerminalShape(value, validateLeaseShape(lease)));
}

function validateCloseShape(value: unknown, lease: SupervisorProcessLeaseV1, terminal: SupervisorTerminalV1): SupervisorCloseV1 {
  assertBoundedEvidenceGraph(value, { maxDepth: 2, maxItems: 16, maxNodes: 8, maxStringBytes: 2_048 });
  const close = requireExactRecord(value, CLOSE_KEYS, 'supervisor direct close');
  if (close.schemaVersion !== 1 || close.attemptId !== lease.attemptId || close.leaseDigest !== supervisorProcessLeaseDigest(lease) || close.supervisorPid !== lease.supervisor.pid || close.observerDigest !== lease.closeObserverDigest || !isTimestamp(close.closedAt)) throw new Error('supervisor direct close lease binding is invalid');
  if (!hasDirectStatus(close.rawExit, close.rawSignal, 0)) throw new Error('supervisor direct close must prove exit zero without a signal');
  if (Date.parse(close.closedAt) < Date.parse(terminal.terminalAt)) throw new Error('supervisor direct close chronology is invalid');
  return close as unknown as SupervisorCloseV1;
}

export function validateSupervisorClose(value: unknown, leaseValue: SupervisorProcessLeaseV1, terminalValue: SupervisorTerminalV1, options: ValidationClock = {}): SupervisorCloseV1 {
  const lease = validateLeaseShape(leaseValue);
  const terminal = validateTerminalShape(terminalValue, lease);
  const close = validateCloseShape(value, lease, terminal);
  if (Date.parse(close.closedAt) > (options.now ?? Date.now()) + MAX_FUTURE_SKEW_MS) throw new Error('supervisor direct close is future-dated');
  return close;
}

export function supervisorCloseDigest(value: SupervisorCloseV1, lease: SupervisorProcessLeaseV1, terminal: SupervisorTerminalV1): string {
  return digestCore(validateCloseShape(value, validateLeaseShape(lease), validateTerminalShape(terminal, validateLeaseShape(lease))));
}

export function terminalAttemptDigest(value: Record<string, unknown>): string {
  return digestCore(validateTerminalAttemptShape(value));
}

function validateTerminalAttemptShape(value: unknown): TerminalAttemptV1 {
  assertBoundedEvidenceGraph(value, { maxDepth: 5, maxItems: 32, maxNodes: 64, maxStringBytes: 2_048 });
  const attempt = requireExactRecord(value, ATTEMPT_KEYS, 'terminal attempt');
  if (attempt.schemaVersion !== 1 || !isOperationalId(attempt.id) || typeof attempt.lifecycle !== 'string' || !TERMINALS.has(attempt.lifecycle as AttemptLifecycle)) throw new Error('invalid terminal attempt identity or lifecycle');
  if (!isTimestamp(attempt.createdAt) || !isTimestamp(attempt.terminalAt) || Date.parse(attempt.terminalAt) < Date.parse(attempt.createdAt)) throw new Error('invalid terminal attempt timestamps');
  if (!hasDirectStatus(attempt.rawExit, attempt.rawSignal) || typeof attempt.timedOut !== 'boolean' || attempt.timedOut !== (attempt.lifecycle === 'timed-out')) throw new Error('invalid terminal attempt direct status');
  const proof = requireExactRecord(attempt.terminationProof, TERMINATION_KEYS, 'supervisor termination proof');
  if (proof.schemaVersion !== 1 || proof.status !== 'reaped' || !isTimestamp(proof.observedAt) || [proof.leaseDigest, proof.supervisorTerminalDigest, proof.supervisorCloseDigest, proof.supervisorDigest].some((item) => !isDigest(item)) || proof.observedAt !== attempt.terminalAt) throw new Error('supervisor termination proof is invalid');
  const binding = requireExactRecord(attempt.evidenceBinding, EVIDENCE_BINDING_KEYS, 'attempt evidence binding');
  if (!isOperationalId(binding.controlId) || !isOid(binding.candidateOid) || [binding.manifestDigest, binding.policyDigest, binding.toolDigest, binding.platformDigest, binding.preconditionDigest, binding.producerDigest, binding.scannerPolicyReceiptDigest, binding.resultEvidenceDigest].some((item) => !isDigest(item))) throw new Error('attempt evidence binding is invalid');
  if (binding.toolDigest !== proof.supervisorDigest) throw new Error('attempt supervisor and tool binding mismatch');
  if (!Number.isSafeInteger(attempt.historySequence) || Number(attempt.historySequence) !== 4 || !isDigest(attempt.historyEntryDigest)) throw new Error('invalid append-only attempt history');
  return { ...attempt, terminationProof: proof, evidenceBinding: binding } as unknown as TerminalAttemptV1;
}

export function validateTerminalAttempt(value: unknown, options: ValidationClock = {}): TerminalAttemptV1 {
  const attempt = validateTerminalAttemptShape(value);
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now)) throw new Error('terminal attempt validation clock must be finite');
  if (Date.parse(attempt.createdAt) > now + MAX_FUTURE_SKEW_MS || Date.parse(attempt.terminalAt) > now + MAX_FUTURE_SKEW_MS || now - Date.parse(attempt.createdAt) > MAX_VALIDITY_MS) throw new Error('terminal attempt is stale or future-dated');
  return attempt;
}

export function transitionAttempt(from: AttemptLifecycle, to: AttemptLifecycle): AttemptLifecycle {
  const allowed: Record<AttemptLifecycle, AttemptLifecycle[]> = {
    created: ['running'], running: ['finalizing'], finalizing: ['terminal', 'cancelled', 'timed-out', 'corrupt'],
    terminal: [], cancelled: [], 'timed-out': [], corrupt: [],
  };
  if (!allowed[from].includes(to)) throw new Error(`invalid attempt transition: ${from} -> ${to}`);
  return to;
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, constants.O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function readBoundedNoFollow(filePath: string, maxBytes: number, failure: string): Buffer {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error(failure);
    const bytes = readFileSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    return bytes;
  } catch {
    if (descriptor !== null) closeSync(descriptor);
    throw new Error(failure);
  }
}

export class FileAttemptEvidenceStore {
  readonly #trustedRoot: string;
  readonly #rootDevice: number;
  readonly #rootInode: number;

  constructor(trustedRoot: string) {
    this.#trustedRoot = realpathSync(trustedRoot);
    const stat = lstatSync(this.#trustedRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('attempt store root is not a confined directory');
    this.#rootDevice = stat.dev;
    this.#rootInode = stat.ino;
  }

  terminalPath(attemptId: string): string {
    this.#assertAttemptId(attemptId);
    this.#assertRootIdentity();
    return path.join(this.#trustedRoot, `${attemptId}.terminal.json`);
  }

  beginAttempt(attemptId: string, createdAt: string): string {
    this.#assertAttemptId(attemptId);
    if (!isTimestamp(createdAt)) throw new Error('attempt creation timestamp is invalid');
    const entry = { schemaVersion: 1, attemptId, sequence: 1, lifecycle: 'created', at: createdAt, predecessorDigest: null };
    const digest = this.#historyDigest(entry);
    this.#writeCanonical(this.#historyName(attemptId, 1), entry, 'attempt id reuse is forbidden');
    return digest;
  }

  writeSupervisorLease(value: SupervisorProcessLeaseV1, expected: SupervisorLeaseExpectationsV1, options: ValidationClock = {}): string {
    const lease = validateSupervisorProcessLease(value, expected, options);
    const created = this.#readHistory(lease.attemptId, 1);
    if (created.lifecycle !== 'created' || created.predecessorDigest !== null || Date.parse(lease.issuedAt) < Date.parse(created.at as string)) throw new Error('attempt created history is unavailable or non-monotonic');
    const digest = supervisorProcessLeaseDigest(lease);
    this.#writeCanonical(this.#leaseName(lease.attemptId), lease, 'supervisor lease exists; attempt reuse is forbidden');
    const running = { schemaVersion: 1, attemptId: lease.attemptId, sequence: 2, lifecycle: 'running', at: lease.issuedAt, predecessorDigest: this.#historyDigest(created) };
    this.#writeCanonical(this.#historyName(lease.attemptId, 2), running, 'attempt running history exists; attempt reuse is forbidden');
    return digest;
  }

  writeSupervisorTerminal(value: SupervisorTerminalV1, expectedLeaseDigest: string, options: LeaseReadOptions = {}): string {
    const lease = this.readSupervisorLease(value.attemptId, expectedLeaseDigest, options);
    const terminal = validateSupervisorTerminal(value, lease, options);
    const running = this.#readHistory(lease.attemptId, 2);
    if (running.lifecycle !== 'running' || Date.parse(terminal.terminalAt) < Date.parse(running.at as string)) throw new Error('attempt running history is unavailable or non-monotonic');
    const digest = supervisorTerminalDigest(terminal, lease);
    this.#writeCanonical(this.#supervisorTerminalName(lease.attemptId), terminal, 'supervisor terminal receipt exists; attempt reuse is forbidden');
    const finalizing = { schemaVersion: 1, attemptId: lease.attemptId, sequence: 3, lifecycle: 'finalizing', at: terminal.terminalAt, predecessorDigest: this.#historyDigest(running) };
    this.#writeCanonical(this.#historyName(lease.attemptId, 3), finalizing, 'attempt finalizing history exists; attempt reuse is forbidden');
    return digest;
  }

  writeSupervisorClose(value: SupervisorCloseV1, expectedLeaseDigest: string, expectedTerminalDigest: string, lifecycle: TerminalLifecycle, options: LeaseReadOptions = {}): FinalizedClose {
    if (!TERMINALS.has(lifecycle)) throw new Error('terminal lifecycle is invalid');
    const lease = this.readSupervisorLease(value.attemptId, expectedLeaseDigest, options);
    const terminal = this.readSupervisorTerminal(value.attemptId, expectedTerminalDigest, lease, options);
    const close = validateSupervisorClose(value, lease, terminal, options);
    if (terminal.targetStatus.timedOut !== (lifecycle === 'timed-out')) throw new Error('terminal lifecycle does not match supervisor timeout evidence');
    const finalizing = this.#readHistory(lease.attemptId, 3);
    if (finalizing.lifecycle !== 'finalizing' || Date.parse(close.closedAt) < Date.parse(finalizing.at as string)) throw new Error('attempt finalizing history is unavailable or non-monotonic');
    const closeDigest = supervisorCloseDigest(close, lease, terminal);
    this.#writeCanonical(this.#supervisorCloseName(lease.attemptId), close, 'supervisor close receipt exists; attempt reuse is forbidden');
    const completed = { schemaVersion: 1, attemptId: lease.attemptId, sequence: 4, lifecycle, at: close.closedAt, predecessorDigest: this.#historyDigest(finalizing) };
    const historyEntryDigest = this.#historyDigest(completed);
    this.#writeCanonical(this.#historyName(lease.attemptId, 4), completed, 'terminal attempt history exists; attempt reuse is forbidden');
    return { supervisorCloseDigest: closeDigest, historyEntryDigest };
  }

  readSupervisorLease(attemptId: string, expectedDigest: string, options: LeaseReadOptions = {}): SupervisorProcessLeaseV1 {
    if (!isDigest(expectedDigest) || options.expectedLease === undefined) throw new Error('trusted supervisor lease digest and expectations are required');
    const value = this.#readCanonical(this.#leaseName(attemptId), 'supervisor lease is unavailable or malformed');
    const lease = validateSupervisorProcessLease(value, options.expectedLease, options);
    if (supervisorProcessLeaseDigest(lease) !== expectedDigest) throw new Error('supervisor lease bytes or digest mismatch');
    return lease;
  }

  readSupervisorTerminal(attemptId: string, expectedDigest: string, lease: SupervisorProcessLeaseV1, options: ValidationClock = {}): SupervisorTerminalV1 {
    if (!isDigest(expectedDigest)) throw new Error('supervisor terminal digest is invalid');
    const value = this.#readCanonical(this.#supervisorTerminalName(attemptId), 'supervisor terminal receipt is unavailable or malformed');
    const terminal = validateSupervisorTerminal(value, lease, options);
    if (supervisorTerminalDigest(terminal, lease) !== expectedDigest) throw new Error('supervisor terminal receipt bytes or digest mismatch');
    return terminal;
  }

  readSupervisorClose(attemptId: string, expectedDigest: string, lease: SupervisorProcessLeaseV1, terminal: SupervisorTerminalV1, options: ValidationClock = {}): SupervisorCloseV1 {
    if (!isDigest(expectedDigest)) throw new Error('supervisor close digest is invalid');
    const value = this.#readCanonical(this.#supervisorCloseName(attemptId), 'supervisor close receipt is unavailable or malformed');
    const close = validateSupervisorClose(value, lease, terminal, options);
    if (supervisorCloseDigest(close, lease, terminal) !== expectedDigest) throw new Error('supervisor close receipt bytes or digest mismatch');
    return close;
  }

  readTerminalAttempt(attemptId: string, expectedDigest: string, expectedAttempt: TerminalAttemptV1, options: LeaseReadOptions = {}): TerminalAttemptV1 {
    if (!isDigest(expectedDigest)) throw new Error('terminal attempt digest is invalid');
    const attempt = validateTerminalAttempt(this.#readCanonical(path.basename(this.terminalPath(attemptId)), 'terminal attempt receipt is unavailable or malformed'), options);
    if (attempt.id !== attemptId || terminalAttemptDigest(attempt as unknown as Record<string, unknown>) !== expectedDigest || canonicalizeBoundaryRun(attempt) !== canonicalizeBoundaryRun(expectedAttempt)) throw new Error('terminal attempt receipt bytes or binding mismatch');
    const lease = this.readSupervisorLease(attemptId, attempt.terminationProof.leaseDigest, options);
    const terminal = this.readSupervisorTerminal(attemptId, attempt.terminationProof.supervisorTerminalDigest, lease, options);
    const close = this.readSupervisorClose(attemptId, attempt.terminationProof.supervisorCloseDigest, lease, terminal, options);
    this.#assertAttemptEvidence(attempt, lease, terminal, close);
    this.#assertHistory(attempt, lease, terminal, close);
    this.#assertRootIdentity();
    return attempt;
  }

  claim(attemptId: string, attemptDigest: string): boolean {
    this.#assertAttemptId(attemptId);
    if (!isDigest(attemptDigest)) throw new Error('attempt replay claim identity is invalid');
    try {
      this.#writeBytes(`.ci-control-consumed-${attemptId}.lock`, `${attemptDigest}\n`);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  }

  assertAdmissionChain(attempt: TerminalAttemptV1, options: LeaseReadOptions): void {
    const lease = this.readSupervisorLease(attempt.id, attempt.terminationProof.leaseDigest, options);
    const terminal = this.readSupervisorTerminal(attempt.id, attempt.terminationProof.supervisorTerminalDigest, lease, options);
    const close = this.readSupervisorClose(attempt.id, attempt.terminationProof.supervisorCloseDigest, lease, terminal, options);
    this.#assertAttemptEvidence(attempt, lease, terminal, close);
    this.#assertHistory(attempt, lease, terminal, close);
  }

  writeAdmittedAttempt(value: unknown, options?: TerminalAttemptAdmissionOptions): string {
    if (options === undefined) throw new Error('trusted terminal attempt admission options are required');
    const attempt = validateTerminalAttempt(value, options);
    if (attempt.terminationProof.leaseDigest !== options.leaseDigest || attempt.terminationProof.supervisorTerminalDigest !== options.supervisorTerminalDigest || attempt.terminationProof.supervisorCloseDigest !== options.supervisorCloseDigest) throw new Error('terminal receipt supervisor evidence digest mismatch');
    this.assertAdmissionChain(attempt, { now: options.now, expectedLease: options.expectedLease });
    this.#writeCanonical(path.basename(this.terminalPath(attempt.id)), attempt, 'terminal receipt exists; attempt reuse is forbidden');
    const digest = terminalAttemptDigest(attempt as unknown as Record<string, unknown>);
    this.readTerminalAttempt(attempt.id, digest, attempt, { now: options.now, expectedLease: options.expectedLease });
    return digest;
  }

  #assertAttemptEvidence(attempt: TerminalAttemptV1, lease: SupervisorProcessLeaseV1, terminal: SupervisorTerminalV1, close: SupervisorCloseV1): void {
    if (attempt.terminationProof.supervisorDigest !== lease.supervisorToolDigest || attempt.rawExit !== terminal.targetStatus.rawExit || attempt.rawSignal !== terminal.targetStatus.rawSignal || attempt.timedOut !== terminal.targetStatus.timedOut || attempt.terminalAt !== close.closedAt || attempt.terminationProof.observedAt !== close.closedAt) throw new Error('terminal attempt does not match supervisor-issued evidence');
  }

  #assertHistory(attempt: TerminalAttemptV1, lease: SupervisorProcessLeaseV1, terminal: SupervisorTerminalV1, close: SupervisorCloseV1): void {
    const created = this.#readHistory(attempt.id, 1);
    const running = this.#readHistory(attempt.id, 2);
    const finalizing = this.#readHistory(attempt.id, 3);
    const completed = this.#readHistory(attempt.id, 4);
    if (created.lifecycle !== 'created' || created.at !== attempt.createdAt || created.predecessorDigest !== null || running.lifecycle !== 'running' || running.at !== lease.issuedAt || running.predecessorDigest !== this.#historyDigest(created) || finalizing.lifecycle !== 'finalizing' || finalizing.at !== terminal.terminalAt || finalizing.predecessorDigest !== this.#historyDigest(running) || completed.lifecycle !== attempt.lifecycle || completed.at !== close.closedAt || completed.predecessorDigest !== this.#historyDigest(finalizing) || attempt.historySequence !== 4 || attempt.historyEntryDigest !== this.#historyDigest(completed)) throw new Error('attempt lifecycle history binding mismatch');
  }

  #assertAttemptId(attemptId: string): void {
    if (!isOperationalId(attemptId)) throw new Error('attempt identity is invalid');
  }

  #leaseName(attemptId: string): string { this.#assertAttemptId(attemptId); return `${attemptId}.lease.json`; }
  #supervisorTerminalName(attemptId: string): string { this.#assertAttemptId(attemptId); return `${attemptId}.supervisor-terminal.json`; }
  #supervisorCloseName(attemptId: string): string { this.#assertAttemptId(attemptId); return `${attemptId}.supervisor-close.json`; }
  #historyName(attemptId: string, sequence: number): string { this.#assertAttemptId(attemptId); return `${attemptId}.history.${String(sequence).padStart(4, '0')}.json`; }
  #historyDigest(entry: Record<string, unknown>): string { return digestCore(entry); }

  #readHistory(attemptId: string, sequence: number): Record<string, unknown> {
    const value = this.#readCanonical(this.#historyName(attemptId, sequence), 'attempt lifecycle history is unavailable or malformed');
    if (!isRecord(value) || !hasExactKeys(value, HISTORY_KEYS) || value.schemaVersion !== 1 || value.attemptId !== attemptId || value.sequence !== sequence || !isTimestamp(value.at) || !(value.predecessorDigest === null || isDigest(value.predecessorDigest))) throw new Error('attempt lifecycle history is malformed');
    return value;
  }

  #readCanonical(name: string, failure: string): unknown {
    this.#assertRootIdentity();
    const bytes = readBoundedNoFollow(path.join(this.#trustedRoot, name), MAX_EVIDENCE_BYTES, failure);
    const decoded = parseBoundaryJsonBytes(bytes);
    if (!decoded.result.ok || decoded.value === null || !bytes.equals(Buffer.from(canonicalizeBoundaryRun(decoded.value), 'utf8'))) throw new Error(failure);
    this.#assertRootIdentity();
    return decoded.value;
  }

  #writeCanonical(name: string, value: unknown, existsFailure: string): void {
    this.#writeBytes(name, canonicalizeBoundaryRun(value), existsFailure);
  }

  #writeBytes(name: string, bytes: string, existsFailure?: string): void {
    this.#assertRootIdentity();
    const target = path.join(this.#trustedRoot, name);
    const temporary = path.join(this.#trustedRoot, `.${name}.${process.pid}.${randomUUID()}.tmp`);
    let descriptor: number | null = null;
    try {
      descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, bytes, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      linkSync(temporary, target);
      unlinkSync(temporary);
      fsyncDirectory(this.#trustedRoot);
      this.#assertRootIdentity();
    } catch (error) {
      if (descriptor !== null) closeSync(descriptor);
      try { unlinkSync(temporary); } catch {}
      if ((error as NodeJS.ErrnoException).code === 'EEXIST' && existsFailure !== undefined) throw new Error(existsFailure);
      throw error;
    }
  }

  #assertRootIdentity(): void {
    const stat = lstatSync(this.#trustedRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== this.#rootDevice || stat.ino !== this.#rootInode) throw new Error('attempt store root identity changed');
  }
}

export function writeTerminalAttempt(filePath: string, value: TerminalAttemptV1, options: {
  store: FileAttemptEvidenceStore;
  leaseDigest: string;
  supervisorTerminalDigest: string;
  supervisorCloseDigest: string;
  expectedLease: SupervisorLeaseExpectationsV1;
  now?: number;
}): string {
  const attempt = validateTerminalAttempt(value, options);
  if (path.resolve(filePath) !== options.store.terminalPath(attempt.id)) throw new Error('terminal receipt path does not match its attempt store');
  return options.store.writeAdmittedAttempt(attempt, options);
}
