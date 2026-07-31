import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { createChildLogger } from '../logger.ts';
import {
  appendPrivateJsonLineSync,
  forceEnsurePrivateDirectorySync,
  fsyncDirectory,
  readPrivateFileSync,
  writeAtomicPrivateFileSync,
} from '../lib/private-fs.ts';
import { acquireProcessLock, releaseProcessLock } from '../lib/process-lock.ts';

const log = createChildLogger('silence-manager');

const CONFIG_DIR = join(homedir(), '.config', 'whatsoup');
const SILENCES_FILE = join(CONFIG_DIR, 'fleet-silences.json');
const SILENCES_LOCK_FILE = join(CONFIG_DIR, 'fleet-silences.lock');
const SILENCE_REGISTRY_GENERATION_FILE = join(CONFIG_DIR, 'fleet-silence-registry-state.json');
const SILENCE_QUARANTINE_DIR = join(CONFIG_DIR, 'fleet-silence-quarantine');
const SILENCE_REPAIR_RECEIPT_FILE = join(CONFIG_DIR, 'fleet-silence-repair-receipts.jsonl');
const MAX_SILENCE_RULES = 1_024;
const MAX_SILENCE_FIELD_BYTES = 16 * 1_024;
const EMPTY_SILENCE_REGISTRY_RAW = '[]\n';
const ISO_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

/** An in-memory read basis is deliberately short-lived; an old mute must not persist forever. */
export const SILENCE_LAST_KNOWN_GOOD_MAX_AGE_MS = 5 * 60_000;

export interface SilenceRule {
  instance: string;
  until: string;        // ISO8601
  reason: string;
  silencedBy: string;
  createdAt: string;    // ISO8601
}

export const SILENCE_STORE_REASON_CLASSES = [
  'invalid_json',
  'invalid_document',
  'missing_after_observed',
  'permission_denied',
  'read_failed',
] as const;

export type SilenceStoreReasonClass = (typeof SILENCE_STORE_REASON_CLASSES)[number];
export type SilenceStoreFailureAvailability = 'unavailable' | 'invalid';
export type SilenceStoreReadBasis = 'current' | 'last_known_good' | 'none';

export type SilenceStoreReadResult =
  | {
      availability: 'observed';
      readBasis: 'current';
      rules: SilenceRule[];
      observedAt: string;
      revision: string;
    }
  | {
      availability: 'uninitialized';
      readBasis: 'current';
      rules: SilenceRule[];
      observedAt: string;
    }
  | {
      availability: SilenceStoreFailureAvailability;
      readBasis: 'last_known_good';
      rules: SilenceRule[];
      observedAt: string;
      reasonClass: SilenceStoreReasonClass;
      lastKnownGoodAt: string;
      lastKnownGoodAgeMs: number;
      revision: string;
    }
  | {
      availability: SilenceStoreFailureAvailability;
      readBasis: 'none';
      rules: null;
      observedAt: string;
      reasonClass: SilenceStoreReasonClass;
    };

export type SilenceRegistryResetInspection =
  | {
      state: 'ready';
      revision: string;
      reasonClass: Extract<SilenceStoreReasonClass, 'invalid_json' | 'invalid_document'>;
    }
  | {
      state: 'blocked';
      availability: SilenceStoreReadResult['availability'];
      readBasis: SilenceStoreReadBasis;
      reasonClass?: SilenceStoreReasonClass;
    };

export interface SilenceRegistryResetResult {
  state: 'verified';
  repairId: string;
  priorRevision: string;
  nextRevision: string;
  reasonClass: Extract<SilenceStoreReasonClass, 'invalid_json' | 'invalid_document'>;
}

interface SilenceStoreSnapshot {
  rules: SilenceRule[];
  observedAt: string;
  revision: string;
}

/** A current validated read is required before an ordinary registry mutation. */
export class SilenceStoreUnavailableError extends Error {
  readonly availability: SilenceStoreFailureAvailability;
  readonly readBasis: Exclude<SilenceStoreReadBasis, 'current'>;
  readonly reasonClass: SilenceStoreReasonClass;

  constructor(result: Extract<SilenceStoreReadResult, { availability: SilenceStoreFailureAvailability }>) {
    super('silence registry unavailable');
    this.name = 'SilenceStoreUnavailableError';
    this.availability = result.availability;
    this.readBasis = result.readBasis;
    this.reasonClass = result.reasonClass;
  }
}

/** An attempted new rule failed the same strict schema used for persisted data. */
export class SilenceRuleValidationError extends Error {
  constructor() {
    super('invalid silence rule');
    this.name = 'SilenceRuleValidationError';
  }
}

/** The local reset command may act only on the exact current invalid generation. */
export class SilenceRegistryResetPreconditionError extends Error {
  constructor() {
    super('silence registry reset precondition failed');
    this.name = 'SilenceRegistryResetPreconditionError';
  }
}

const boundedText = z.string()
  .refine((value) => value.trim().length > 0)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_SILENCE_FIELD_BYTES);

/**
 * The public silence registry historically accepts explicit ISO offsets, so it
 * cannot use the UTC-only round-trip helper. Validate calendar components
 * first: Date.parse normalizes impossible dates such as February 30th.
 */
function isStrictSilenceTimestamp(value: string): boolean {
  const match = ISO_TIMESTAMP_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1
    && month <= 12
    && day >= 1
    && day <= daysInMonth[month - 1]!
    && hour <= 23
    && minute <= 59
    && second <= 59
    && offsetHour <= 23
    && offsetMinute <= 59
    && Number.isFinite(Date.parse(value));
}

const isoTimestamp = boundedText.refine(isStrictSilenceTimestamp);

const silenceRuleSchema = z.object({
  instance: boundedText,
  until: isoTimestamp,
  reason: boundedText,
  silencedBy: boundedText,
  createdAt: isoTimestamp,
}).strict().refine(
  (rule) => Date.parse(rule.createdAt) <= Date.parse(rule.until),
  { message: 'silence expiry must not precede creation' },
);

const silenceRulesSchema = z.array(silenceRuleSchema).max(MAX_SILENCE_RULES).superRefine((rules, ctx) => {
  const instances = new Set<string>();
  for (const [index, rule] of rules.entries()) {
    if (instances.has(rule.instance)) {
      ctx.addIssue({
        code: 'custom',
        path: [index, 'instance'],
        message: 'silence rules must have unique instances',
      });
    }
    instances.add(rule.instance);
  }
});

const silenceRegistryGenerationSchema = z.discriminatedUnion('state', [
  z.object({
    schemaVersion: z.literal(1),
    state: z.literal('observed'),
    revision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    observedAt: isoTimestamp,
  }).strict(),
  z.object({
    schemaVersion: z.literal(1),
    state: z.literal('uninitialized'),
    observedAt: isoTimestamp,
  }).strict(),
]);

type PersistedObservedGenerationState = 'observed' | 'uninitialized' | 'absent' | 'unavailable';
type PersistedLifecycleMarkerState = Extract<PersistedObservedGenerationState, 'observed' | 'uninitialized'>;

let lastReportedFailure: `${SilenceStoreFailureAvailability}:${SilenceStoreReasonClass}` | null = null;
let lastKnownGood: SilenceStoreSnapshot | null = null;
let hasObservedRegistry = false;
let persistedLifecycleMarkerState: PersistedLifecycleMarkerState | null = null;
let lifecycleMarkerFailureReported = false;

function noteLifecycleMarkerFailure(): void {
  if (lifecycleMarkerFailureReported) return;
  lifecycleMarkerFailureReported = true;
  log.warn({}, 'silence registry lifecycle marker unavailable');
}

function persistObservedGeneration(revision: string, observedAt: string, force = false): void {
  if (persistedLifecycleMarkerState === 'observed' && !force) return;
  writeAtomicPrivateFileSync(
    SILENCE_REGISTRY_GENERATION_FILE,
    `${JSON.stringify({ schemaVersion: 1, state: 'observed', revision, observedAt })}\n`,
    'fleet silence registry lifecycle marker',
    'required',
  );
  persistedLifecycleMarkerState = 'observed';
  lifecycleMarkerFailureReported = false;
}

/** A missing store is current only after its first-run lifecycle state is durable. */
function persistUninitializedGeneration(observedAt: string): void {
  if (persistedLifecycleMarkerState !== null) return;
  writeAtomicPrivateFileSync(
    SILENCE_REGISTRY_GENERATION_FILE,
    `${JSON.stringify({ schemaVersion: 1, state: 'uninitialized', observedAt })}\n`,
    'fleet silence registry lifecycle marker',
    'required',
  );
  persistedLifecycleMarkerState = 'uninitialized';
  lifecycleMarkerFailureReported = false;
}

function persistedObservedGenerationState(): PersistedObservedGenerationState {
  if (persistedLifecycleMarkerState !== null) return persistedLifecycleMarkerState;
  let raw: string | null;
  try {
    raw = readPrivateFileSync(SILENCE_REGISTRY_GENERATION_FILE, {
      label: 'fleet silence registry lifecycle marker',
      maxBytes: 1024,
    });
  } catch {
    noteLifecycleMarkerFailure();
    return 'unavailable';
  }
  if (raw === null) return 'absent';

  try {
    const parsed = silenceRegistryGenerationSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      noteLifecycleMarkerFailure();
      return 'unavailable';
    }
    persistedLifecycleMarkerState = parsed.data.state;
  } catch {
    noteLifecycleMarkerFailure();
    return 'unavailable';
  }
  lifecycleMarkerFailureReported = false;
  return persistedLifecycleMarkerState;
}

function revisionFor(raw: string): string {
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

function snapshotRules(rules: SilenceRule[]): SilenceRule[] {
  return rules.map((rule) => ({ ...rule }));
}

function rememberObservedRules(rules: SilenceRule[], raw: string, observedAt: string): SilenceStoreReadResult {
  const revision = revisionFor(raw);
  // A valid registry cannot become a mutation-capable current read until the
  // restart-discrimination marker is durable as well.
  persistObservedGeneration(revision, observedAt);
  const snapshot: SilenceStoreSnapshot = {
    rules: snapshotRules(rules),
    observedAt,
    revision,
  };
  lastKnownGood = snapshot;
  hasObservedRegistry = true;
  lastReportedFailure = null;
  return {
    availability: 'observed',
    readBasis: 'current',
    rules: snapshotRules(snapshot.rules),
    observedAt: snapshot.observedAt,
    revision: snapshot.revision,
  };
}

function reportCurrentUninitialized(observedAt: string): SilenceStoreReadResult {
  lastReportedFailure = null;
  return { availability: 'uninitialized', readBasis: 'current', rules: [], observedAt };
}

function reportFailure(
  availability: SilenceStoreFailureAvailability,
  reasonClass: SilenceStoreReasonClass,
  observedAt: string,
): SilenceStoreReadResult {
  const failureKey = `${availability}:${reasonClass}` as const;
  if (lastReportedFailure !== failureKey) {
    log.warn({ availability, reasonClass }, 'silence registry unavailable');
    lastReportedFailure = failureKey;
  }

  const snapshot = lastKnownGood;
  const snapshotAgeMs = snapshot === null ? null : Date.parse(observedAt) - Date.parse(snapshot.observedAt);
  if (
    snapshot !== null
    && snapshotAgeMs !== null
    && snapshotAgeMs >= 0
    && snapshotAgeMs <= SILENCE_LAST_KNOWN_GOOD_MAX_AGE_MS
  ) {
    return {
      availability,
      readBasis: 'last_known_good',
      rules: snapshotRules(snapshot.rules),
      observedAt,
      reasonClass,
      lastKnownGoodAt: snapshot.observedAt,
      lastKnownGoodAgeMs: snapshotAgeMs,
      revision: snapshot.revision,
    };
  }

  return { availability, readBasis: 'none', rules: null, observedAt, reasonClass };
}

function reasonClassForReadError(err: unknown): SilenceStoreReasonClass {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  return code === 'EACCES' || code === 'EPERM' ? 'permission_denied' : 'read_failed';
}

type ParsedSilenceRules =
  | { state: 'observed'; rules: SilenceRule[] }
  | { state: 'invalid'; reasonClass: Extract<SilenceStoreReasonClass, 'invalid_json' | 'invalid_document'> };

function parseSilenceRules(raw: string): ParsedSilenceRules {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'invalid', reasonClass: 'invalid_json' };
  }

  const validated = silenceRulesSchema.safeParse(parsed);
  if (!validated.success) return { state: 'invalid', reasonClass: 'invalid_document' };
  return { state: 'observed', rules: validated.data };
}

function ensureSilenceRegistryDirectory(): void {
  forceEnsurePrivateDirectorySync(CONFIG_DIR, 'fleet silence registry directory');
}

interface SilenceRegistryFileIdentity {
  dev: number;
  ino: number;
}

interface PinnedSilenceRegistryFile {
  raw: string;
  identity: SilenceRegistryFileIdentity;
}

function silenceRegistryFileError(code = 'EINVAL'): NodeJS.ErrnoException {
  const err = new Error('invalid silence registry file') as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function identityFor(stat: Stats): SilenceRegistryFileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameSilenceRegistryIdentity(
  left: SilenceRegistryFileIdentity,
  right: SilenceRegistryFileIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertRegularSilenceRegistryFile(stat: Stats, requireSingleLink: boolean): void {
  if (stat.isSymbolicLink() || !stat.isFile() || (requireSingleLink && stat.nlink !== 1)) {
    throw silenceRegistryFileError();
  }
}

/**
 * Read a registry file through a no-follow descriptor and bind the bytes to
 * the lstat identity observed before opening. Repair uses the same primitive
 * for source, quarantine, and published output so no path is followed later.
 */
function readPinnedSilenceRegistryFile(
  filePath: string,
  options: { expectedIdentity?: SilenceRegistryFileIdentity; requireSingleLink?: boolean } = {},
): PinnedSilenceRegistryFile {
  const requireSingleLink = options.requireSingleLink ?? false;
  const before = lstatSync(filePath);
  assertRegularSilenceRegistryFile(before, requireSingleLink);
  if (options.expectedIdentity && !sameSilenceRegistryIdentity(identityFor(before), options.expectedIdentity)) {
    throw silenceRegistryFileError('ESTALE');
  }

  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const opened = fstatSync(descriptor);
    assertRegularSilenceRegistryFile(opened, requireSingleLink);
    if (!sameSilenceRegistryIdentity(identityFor(before), identityFor(opened))) {
      throw silenceRegistryFileError('ESTALE');
    }
    if (options.expectedIdentity && !sameSilenceRegistryIdentity(identityFor(opened), options.expectedIdentity)) {
      throw silenceRegistryFileError('ESTALE');
    }
    const raw = readFileSync(descriptor, 'utf-8');
    const after = fstatSync(descriptor);
    if (!sameSilenceRegistryIdentity(identityFor(opened), identityFor(after))) {
      throw silenceRegistryFileError('ESTALE');
    }
    return { raw, identity: identityFor(after) };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

/** Read only a regular, no-follow registry entry. */
function readSilenceRegistryFile(): string {
  return readPinnedSilenceRegistryFile(SILENCES_FILE).raw;
}

function pathMatchesSilenceRegistryGeneration(
  filePath: string,
  expectedIdentity: SilenceRegistryFileIdentity,
  expectedRaw: string,
): boolean {
  try {
    const current = readPinnedSilenceRegistryFile(filePath, { expectedIdentity });
    return current.raw === expectedRaw;
  } catch {
    return false;
  }
}

function withSilenceRegistryLock<T>(fn: () => T): T {
  ensureSilenceRegistryDirectory();
  const lock = acquireProcessLock(SILENCES_LOCK_FILE, { reclaimDeadSameBoot: true });
  try {
    return fn();
  } finally {
    releaseProcessLock(lock);
  }
}

/** The single typed read observation used by evaluation, API, UI, and mutation gates. */
export function getSilenceStoreObservation(): SilenceStoreReadResult {
  const observedAt = new Date().toISOString();
  let raw: string;
  try {
    raw = readSilenceRegistryFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      const persistedState = hasObservedRegistry ? 'observed' : persistedObservedGenerationState();
      if (persistedState === 'observed') {
        return reportFailure('unavailable', 'missing_after_observed', observedAt);
      }
      if (persistedState === 'unavailable') {
        return reportFailure('unavailable', 'read_failed', observedAt);
      }
      if (persistedState === 'absent') {
        try {
          persistUninitializedGeneration(observedAt);
        } catch (markerErr) {
          noteLifecycleMarkerFailure();
          return reportFailure('unavailable', reasonClassForReadError(markerErr), observedAt);
        }
      }
      return reportCurrentUninitialized(observedAt);
    }
    return reportFailure('unavailable', reasonClassForReadError(err), observedAt);
  }

  const parsed = parseSilenceRules(raw);
  if (parsed.state === 'invalid') return reportFailure('invalid', parsed.reasonClass, observedAt);
  try {
    return rememberObservedRules(parsed.rules, raw, observedAt);
  } catch (err) {
    noteLifecycleMarkerFailure();
    return reportFailure('unavailable', reasonClassForReadError(err), observedAt);
  }
}

function requireMutableRules(): SilenceRule[] {
  const loaded = getSilenceStoreObservation();
  if (loaded.readBasis !== 'current') throw new SilenceStoreUnavailableError(loaded);
  return loaded.rules;
}

function saveRules(rules: SilenceRule[]): void {
  ensureSilenceRegistryDirectory();
  const tmpFile = join(CONFIG_DIR, `.fleet-silences.${process.pid}.${randomUUID()}.tmp`);
  const raw = JSON.stringify(rules, null, 2) + '\n';
  const observedAt = new Date().toISOString();
  try {
    // Persist a conservative observed marker before publication. If publication
    // later fails, a restart treats absence as unavailable rather than silently
    // reclassifying a potentially interrupted mutation as first run.
    persistObservedGeneration(revisionFor(raw), observedAt);
    writeFileSync(tmpFile, raw, { mode: 0o600 });
    chmodSync(tmpFile, 0o600);
    renameSync(tmpFile, SILENCES_FILE);
    rememberObservedRules(rules, raw, observedAt);
  } catch (err) {
    try {
      unlinkSync(tmpFile);
    } catch {
      // intentional: best-effort temp cleanup must not mask the persistence failure being rethrown
    }
    throw err;
  }
}

/**
 * Inspect whether the current local artifact is eligible for the explicit
 * quarantine-and-reset workflow. This probe never updates LKG or lifecycle
 * state, so the CLI can accurately promise a read-only dry run.
 */
export function inspectSilenceRegistryReset(): SilenceRegistryResetInspection {
  let raw: string;
  try {
    raw = readSilenceRegistryFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      const persistedState = hasObservedRegistry ? 'observed' : persistedObservedGenerationState();
      if (persistedState === 'observed') {
        return {
          state: 'blocked',
          availability: 'unavailable',
          readBasis: 'none',
          reasonClass: 'missing_after_observed',
        };
      }
      if (persistedState === 'absent' || persistedState === 'uninitialized') {
        return { state: 'blocked', availability: 'uninitialized', readBasis: 'current' };
      }
    }
    return {
      state: 'blocked',
      availability: 'unavailable',
      readBasis: 'none',
      reasonClass: reasonClassForReadError(err),
    };
  }
  const parsed = parseSilenceRules(raw);
  if (parsed.state !== 'invalid') {
    return { state: 'blocked', availability: 'observed', readBasis: 'current' };
  }
  return { state: 'ready', revision: revisionFor(raw), reasonClass: parsed.reasonClass };
}

function appendResetReceipt(value: Record<string, unknown>): void {
  appendPrivateJsonLineSync(SILENCE_REPAIR_RECEIPT_FILE, {
    schemaVersion: 1,
    action: 'silence_registry_quarantine_and_reset',
    at: new Date().toISOString(),
    ...value,
  });
}

interface PreparedSilenceRegistryReplacement {
  path: string;
  identity: SilenceRegistryFileIdentity;
}

function writePreparedEmptySilenceRegistryReplacement(): PreparedSilenceRegistryReplacement {
  const path = join(
    CONFIG_DIR,
    `.${basename(SILENCES_FILE)}.reset.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | null = null;
  let created = false;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    created = true;
    const opened = fstatSync(descriptor);
    assertRegularSilenceRegistryFile(opened, true);
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, EMPTY_SILENCE_REGISTRY_RAW, 'utf-8');
    fsyncSync(descriptor);
    const completed = fstatSync(descriptor);
    assertRegularSilenceRegistryFile(completed, true);
    if (!sameSilenceRegistryIdentity(identityFor(opened), identityFor(completed))) {
      throw silenceRegistryFileError('ESTALE');
    }
    closeSync(descriptor);
    descriptor = null;
    return { path, identity: identityFor(completed) };
  } catch (err) {
    if (descriptor !== null) closeSync(descriptor);
    if (created) {
      try { unlinkSync(path); } catch {
        // intentional: preserve the primary reset failure when temporary cleanup also fails.
      }
    }
    throw err;
  }
}

/**
 * Restore only by linking the preserved original into an absent path. A
 * different current file is left intact; the private quarantine is the manual
 * recovery evidence rather than a target for an overwrite.
 */
function restoreQuarantinedRegistryOriginal(
  quarantineFile: string,
  original: PinnedSilenceRegistryFile,
  sourceDetached: boolean,
  publishedIdentity: SilenceRegistryFileIdentity | null,
): boolean {
  try {
    if (!sourceDetached) {
      const current = readPinnedSilenceRegistryFile(SILENCES_FILE, {
        expectedIdentity: original.identity,
      });
      return current.raw === original.raw;
    }
    try {
      const current = readPinnedSilenceRegistryFile(SILENCES_FILE, {
        expectedIdentity: publishedIdentity ?? undefined,
      });
      if (
        publishedIdentity === null
        || current.raw !== EMPTY_SILENCE_REGISTRY_RAW
      ) {
        return false;
      }
      unlinkSync(SILENCES_FILE);
      fsyncDirectory(CONFIG_DIR);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    linkSync(quarantineFile, SILENCES_FILE);
    const restored = readPinnedSilenceRegistryFile(SILENCES_FILE, {
      expectedIdentity: original.identity,
    });
    fsyncDirectory(CONFIG_DIR);
    return restored.raw === original.raw;
  } catch {
    return false;
  }
}

/**
 * Quarantine one exact invalid registry generation, replace it with an empty
 * private document, and prove the fresh read before declaring the reset valid.
 * This is deliberately a local operator primitive; normal API mutations use
 * `addSilence` and `removeSilence` and can never reach this path.
 */
export function resetInvalidSilenceRegistry(expectedRevision: string): SilenceRegistryResetResult {
  return withSilenceRegistryLock(() => {
    const inspection = inspectSilenceRegistryReset();
    if (inspection.state !== 'ready' || inspection.revision !== expectedRevision) {
      throw new SilenceRegistryResetPreconditionError();
    }

    let original: PinnedSilenceRegistryFile;
    try {
      original = readPinnedSilenceRegistryFile(SILENCES_FILE, { requireSingleLink: true });
    } catch (err) {
      throw new SilenceRegistryResetPreconditionError();
    }
    const parsed = parseSilenceRules(original.raw);
    if (
      parsed.state !== 'invalid'
      || parsed.reasonClass !== inspection.reasonClass
      || revisionFor(original.raw) !== expectedRevision
    ) {
      throw new SilenceRegistryResetPreconditionError();
    }

    forceEnsurePrivateDirectorySync(SILENCE_QUARANTINE_DIR, 'fleet silence quarantine directory');
    const repairId = randomUUID();
    const quarantineFile = join(SILENCE_QUARANTINE_DIR, `${repairId}.json`);
    let quarantined = false;
    let sourceDetached = false;
    let publishedIdentity: SilenceRegistryFileIdentity | null = null;
    let replacement: PreparedSilenceRegistryReplacement | null = null;
    try {
      // Link first: the verified original is durable in quarantine before the
      // live namespace is detached, and no source path is ever followed later.
      linkSync(SILENCES_FILE, quarantineFile);
      const quarantinedCopy = readPinnedSilenceRegistryFile(quarantineFile, {
        expectedIdentity: original.identity,
      });
      if (quarantinedCopy.raw !== original.raw) {
        throw new Error('silence registry quarantine verification failed');
      }
      chmodSync(quarantineFile, 0o600);
      fsyncDirectory(SILENCE_QUARANTINE_DIR);
      quarantined = true;
      appendResetReceipt({
        phase: 'quarantined',
        repairId,
        priorRevision: expectedRevision,
        reasonClass: inspection.reasonClass,
      });

      if (!pathMatchesSilenceRegistryGeneration(SILENCES_FILE, original.identity, original.raw)) {
        throw new Error('silence registry source changed before reset publication');
      }
      unlinkSync(SILENCES_FILE);
      sourceDetached = true;
      fsyncDirectory(CONFIG_DIR);
      const detachedSource = readPinnedSilenceRegistryFile(quarantineFile, {
        expectedIdentity: original.identity,
      });
      if (detachedSource.raw !== original.raw) {
        throw new Error('silence registry source changed while reset publication was starting');
      }

      replacement = writePreparedEmptySilenceRegistryReplacement();
      const sourceBeforePublication = readPinnedSilenceRegistryFile(quarantineFile, {
        expectedIdentity: original.identity,
      });
      if (sourceBeforePublication.raw !== original.raw) {
        throw new Error('silence registry source changed before reset publication');
      }
      linkSync(replacement.path, SILENCES_FILE);
      publishedIdentity = replacement.identity;
      const published = readPinnedSilenceRegistryFile(SILENCES_FILE, {
        expectedIdentity: publishedIdentity,
      });
      if (published.raw !== EMPTY_SILENCE_REGISTRY_RAW || parseSilenceRules(published.raw).state !== 'observed') {
        throw new Error('silence registry reset verification failed');
      }
      unlinkSync(replacement.path);
      replacement = null;
      fsyncDirectory(CONFIG_DIR);

      const observedAt = new Date().toISOString();
      const nextRevision = revisionFor(published.raw);
      persistObservedGeneration(nextRevision, observedAt, true);
      appendResetReceipt({
        phase: 'verified',
        repairId,
        priorRevision: expectedRevision,
        nextRevision,
        reasonClass: inspection.reasonClass,
      });
      // Do not make the temporary empty document LKG until every durable
      // repair receipt has succeeded; aborted repairs retain the prior LKG.
      rememberObservedRules([], published.raw, observedAt);
      return {
        state: 'verified',
        repairId,
        priorRevision: expectedRevision,
        nextRevision,
        reasonClass: inspection.reasonClass,
      };
    } catch (err) {
      if (replacement !== null) {
        try { unlinkSync(replacement.path); } catch {
          // intentional: preserve the primary reset failure when temporary cleanup also fails.
        }
      }
      const originalRestored = quarantined
        ? restoreQuarantinedRegistryOriginal(
          quarantineFile,
          original,
          sourceDetached,
          publishedIdentity,
        )
        : false;
      try {
        appendResetReceipt({
          phase: 'aborted',
          repairId,
          priorRevision: expectedRevision,
          reasonClass: inspection.reasonClass,
          originalRestored,
        });
      } catch {
        // intentional: preserve the primary reset failure while the quarantine remains recovery evidence.
      }
      throw err;
    }
  });
}

/** `null` means the registry could not provide a current silence verdict. */
export function isInstanceSilenced(name: string): boolean | null {
  const loaded = getSilenceStoreObservation();
  if (loaded.rules === null) return null;
  const now = new Date();
  return loaded.rules.some(
    (rule) => rule.instance === name && new Date(rule.until) > now,
  );
}

export function listActiveSilences(): SilenceStoreReadResult {
  const loaded = getSilenceStoreObservation();
  if (loaded.rules === null) return loaded;
  const now = new Date();
  return {
    ...loaded,
    rules: loaded.rules.filter((rule) => new Date(rule.until) > now),
  };
}

export function addSilence(
  instance: string,
  durationMinutes: number,
  reason: string,
  silencedBy: string,
): SilenceRule {
  return withSilenceRegistryLock(() => {
    const rules = requireMutableRules().filter((rule) => rule.instance !== instance);
    const now = new Date();
    const until = new Date(now.getTime() + durationMinutes * 60 * 1000);
    const rule: SilenceRule = {
      instance,
      until: until.toISOString(),
      reason,
      silencedBy,
      createdAt: now.toISOString(),
    };
    const nextRules = [...rules, rule];
    if (!silenceRulesSchema.safeParse(nextRules).success) {
      throw new SilenceRuleValidationError();
    }
    saveRules(nextRules);
    return rule;
  });
}

export function removeSilence(instance: string): boolean {
  return withSilenceRegistryLock(() => {
    const rules = requireMutableRules();
    const filtered = rules.filter((rule) => rule.instance !== instance);
    if (filtered.length === rules.length) return false;
    saveRules(filtered);
    return true;
  });
}
