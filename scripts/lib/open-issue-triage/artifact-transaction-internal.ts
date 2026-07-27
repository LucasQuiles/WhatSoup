import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  acquireProcessLock,
  isProcessLockError,
  readProcessLockPayload,
  releaseProcessLock,
  type AcquireProcessLockOptions,
  type ProcessLockHandle,
} from "../../../src/lib/process-lock.ts";
import { isRecord } from "../../../src/lib/type-guards.ts";

export { isRecord };

export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const DEV_INO_PATTERN = /^\d+:\d+$/;
export const MAX_OPERATIONS = 256;
export const MAX_RELATIVE_PATH_BYTES = 1_024;
export const MAX_TEXT_BYTES = 16 * 1024 * 1024;
export const MAX_TOTAL_TEXT_BYTES = 64 * 1024 * 1024;

// Node has no descriptor-relative link/unlink API, so path mutation is safe only
// while every writer using these transaction artifacts follows this protocol.
export const ARTIFACT_TRANSACTION_CONCURRENCY_BOUNDARY =
  "cooperative-path-writers-only" as const;

export type ArtifactTransactionErrorCode =
  | "invalid-input"
  | "unsafe-path"
  | "lock-unavailable"
  | "lock-identity-changed"
  | "journal-malformed"
  | "journal-state-conflict"
  | "pending-journal-mismatch"
  | "concurrent-drift"
  | "candidate-invalid"
  | "durability-failed"
  | "mutation-outcome-unknown"
  | "post-write-verification-failed"
  | "journal-removal-failed";

export interface ArtifactTransactionRecoveryPacket {
  transactionId: string;
  journalPath: string;
  paths: string[];
}

export class ArtifactTransactionError extends Error {
  readonly code: ArtifactTransactionErrorCode;
  readonly recoveryPacket?: ArtifactTransactionRecoveryPacket;

  constructor(
    code: ArtifactTransactionErrorCode,
    message: string,
    options: {
      cause?: unknown;
      recoveryPacket?: ArtifactTransactionRecoveryPacket;
    } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ArtifactTransactionError";
    this.code = code;
    this.recoveryPacket = options.recoveryPacket;
  }
}

export interface ArtifactTransactionOperation {
  path: string;
  expectedBeforeSha256: string | null;
  desiredText: string | null;
}

export type ArtifactTransactionHookPhase =
  | "journal-durable"
  | "candidate-durable"
  | "prepared-journal-durable"
  | "before-operation-cas"
  | "after-final-cas"
  | "after-exclusive-create-link"
  | "after-operation-mutation"
  | "after-operation-verified"
  | "finalizing-journal-durable"
  | "committed-journal-durable"
  | "before-journal-remove";

export interface ArtifactTransactionHookEvent {
  phase: ArtifactTransactionHookPhase;
  operationIndex: number | null;
  path: string | null;
}

export interface ArtifactTransactionProcessLockOptions {
  pid?: number;
  token?: string;
  now?: Date;
  bootId?: string;
  isProcessAlive?: (pid: number) => boolean;
}

export interface ArtifactTransactionInput {
  root: string;
  lockPath: string;
  journalPath: string;
  authorizationDigest: string;
  operations: readonly ArtifactTransactionOperation[];
  interruptionHook?: (event: ArtifactTransactionHookEvent) => void;
  processLockOptions?: ArtifactTransactionProcessLockOptions;
}

export interface RecoverArtifactTransactionInput {
  root: string;
  lockPath: string;
  journalPath: string;
  authorizationDigest: string;
  expectedOperationPaths: readonly string[];
  interruptionHook?: (event: ArtifactTransactionHookEvent) => void;
  processLockOptions?: ArtifactTransactionProcessLockOptions;
}

export interface ArtifactTransactionReceipt {
  schemaVersion: 1;
  transactionId: string;
  recovered: boolean;
  operationCount: number;
  replacementCount: number;
  createCount: number;
  deleteCount: number;
}

export interface Identity {
  devIno: string;
  realpath: string;
}

export interface AncestorIdentity extends Identity {
  path: string;
}

export interface NormalizedOperation {
  path: string;
  expectedBeforeSha256: string | null;
  desiredText: string | null;
  desiredSha256: string | null;
}

export interface JournalOperation {
  afterSha256: string | null;
  backupDevIno: string | null;
  backupPath: string | null;
  beforeSha256: string | null;
  candidateDevIno: string | null;
  candidatePath: string | null;
  path: string;
}

export interface TransactionJournal {
  authorizationDigest: string;
  operations: JournalOperation[];
  phase: "applying" | "prepared" | "finalizing" | "committed";
  receipt: Omit<ArtifactTransactionReceipt, "recovered"> | null;
  root: Identity;
  schemaVersion: 1;
  transactionId: string;
}

export interface ResolvedOperation extends NormalizedOperation {
  absolute: string;
  ancestors: AncestorIdentity[];
  backupAbsolute: string | null;
  backupPath: string | null;
  candidateAbsolute: string | null;
  candidatePath: string | null;
  parent: string;
}

export interface LockState {
  devIno: string;
  handle: ProcessLockHandle;
  parent: string;
  realpath: string;
}

export interface JournalState {
  identity: Identity;
  journal: TransactionJournal;
}

export type TargetState =
  "before" | "after" | "owned-after-link" | "owned-before-link";

export function fail(
  code: ArtifactTransactionErrorCode,
  message: string,
  cause?: unknown,
  recoveryPacket?: ArtifactTransactionRecoveryPacket,
): ArtifactTransactionError {
  return new ArtifactTransactionError(code, message, {
    cause,
    recoveryPacket,
  });
}

export function sha256Bytes(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function compareUtf8(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareUtf8(left, right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value))}\n`;
}

export function identity(stat: Stats): string {
  return `${stat.dev}:${stat.ino}`;
}

export function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

export function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const observed = Object.keys(value).sort(compareUtf8);
  const sortedExpected = [...expected].sort(compareUtf8);
  return (
    observed.length === sortedExpected.length &&
    observed.every((key, index) => key === sortedExpected[index])
  );
}

export function safeRelativePath(value: unknown, label: string): string[] {
  if (
    typeof value !== "string" ||
    value === "" ||
    Buffer.byteLength(value, "utf8") > MAX_RELATIVE_PATH_BYTES ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw fail(
      "unsafe-path",
      `${label} must be a bounded repository-relative POSIX path`,
    );
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw fail("unsafe-path", `${label} contains an unsafe path segment`);
  }
  return parts;
}

export function normalizeOperations(
  operations: readonly ArtifactTransactionOperation[],
): NormalizedOperation[] {
  if (
    !Array.isArray(operations) ||
    operations.length === 0 ||
    operations.length > MAX_OPERATIONS
  ) {
    throw fail(
      "invalid-input",
      `operations must contain between 1 and ${MAX_OPERATIONS} entries`,
    );
  }
  let totalTextBytes = 0;
  const normalized = operations
    .map((operation, index) => {
      if (
        !isRecord(operation) ||
        !exactKeys(operation, ["desiredText", "expectedBeforeSha256", "path"])
      ) {
        throw fail(
          "invalid-input",
          `operations[${index}] has unknown or missing fields`,
        );
      }
      safeRelativePath(operation.path, `operations[${index}].path`);
      if (
        operation.expectedBeforeSha256 !== null &&
        (typeof operation.expectedBeforeSha256 !== "string" ||
          !SHA256_PATTERN.test(operation.expectedBeforeSha256))
      ) {
        throw fail(
          "invalid-input",
          `operations[${index}].expectedBeforeSha256 is invalid`,
        );
      }
      if (
        operation.desiredText !== null &&
        typeof operation.desiredText !== "string"
      ) {
        throw fail(
          "invalid-input",
          `operations[${index}].desiredText must be text or null`,
        );
      }
      if (
        operation.expectedBeforeSha256 === null &&
        operation.desiredText === null
      ) {
        throw fail(
          "invalid-input",
          `operations[${index}] cannot delete an expected-absent path`,
        );
      }
      const path = operation.path as string;
      if (basename(path).startsWith(".artifact-transaction-")) {
        throw fail(
          "unsafe-path",
          `operations[${index}].path uses the reserved transaction namespace`,
        );
      }
      const expectedBeforeSha256 = operation.expectedBeforeSha256 as
        string | null;
      const desiredText = operation.desiredText as string | null;
      const textBytes =
        desiredText === null ? 0 : Buffer.byteLength(desiredText, "utf8");
      if (textBytes > MAX_TEXT_BYTES) {
        throw fail(
          "invalid-input",
          `operations[${index}].desiredText exceeds the per-file limit`,
        );
      }
      totalTextBytes += textBytes;
      const desiredSha256 =
        desiredText === null ? null : sha256Bytes(desiredText);
      if (desiredSha256 !== null && desiredSha256 === expectedBeforeSha256) {
        throw fail(
          "invalid-input",
          `operations[${index}] does not change file content`,
        );
      }
      return {
        path,
        expectedBeforeSha256,
        desiredText,
        desiredSha256,
      };
    })
    .sort((left, right) => compareUtf8(left.path, right.path));

  if (totalTextBytes > MAX_TOTAL_TEXT_BYTES) {
    throw fail("invalid-input", "desired text exceeds the transaction limit");
  }
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1]!.path === normalized[index]!.path) {
      throw fail(
        "invalid-input",
        `duplicate operation path: ${normalized[index]!.path}`,
      );
    }
  }
  return normalized;
}

export function resolveRoot(rootInput: string): {
  path: string;
  identity: Identity;
} {
  if (
    typeof rootInput !== "string" ||
    !isAbsolute(rootInput) ||
    resolve(rootInput) !== rootInput
  ) {
    throw fail(
      "unsafe-path",
      "root must be an explicit normalized absolute path",
    );
  }
  let stat: Stats;
  let real: string;
  try {
    stat = lstatSync(rootInput);
    real = realpathSync(rootInput);
  } catch (error) {
    throw fail("unsafe-path", "root is unavailable", error);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== rootInput) {
    throw fail("unsafe-path", "root must be a real directory, not a symlink");
  }
  return { path: real, identity: { devIno: identity(stat), realpath: real } };
}

export function validateControlPaths(
  root: string,
  lockPath: string,
  journalPath: string,
): string {
  const journalStagePath = `${journalPath}.candidate`;
  if (
    typeof lockPath !== "string" ||
    typeof journalPath !== "string" ||
    !isAbsolute(lockPath) ||
    !isAbsolute(journalPath) ||
    resolve(lockPath) !== lockPath ||
    resolve(journalPath) !== journalPath ||
    lockPath === journalPath ||
    lockPath === journalStagePath ||
    journalPath === `${lockPath}.candidate` ||
    lockPath.startsWith(`${journalPath}.`) ||
    journalPath.startsWith(`${lockPath}.`) ||
    isInside(root, lockPath) ||
    isInside(root, journalPath) ||
    isInside(root, journalStagePath) ||
    dirname(lockPath) !== dirname(journalPath)
  ) {
    throw fail(
      "unsafe-path",
      "transaction control paths must be disjoint normalized absolute paths outside the repository",
    );
  }
  const parent = dirname(lockPath);
  let stat: Stats;
  let real: string;
  try {
    stat = lstatSync(parent);
    real = realpathSync(parent);
  } catch (error) {
    throw fail("unsafe-path", "lock and journal parent is unavailable", error);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== parent) {
    throw fail(
      "unsafe-path",
      "lock and journal parent must be a real resolved directory",
    );
  }
  return parent;
}

export function assertSingleLinkRegularFile(
  path: string,
  label: string,
): Identity {
  let stat: Stats;
  let real: string;
  try {
    stat = lstatSync(path);
    real = realpathSync(path);
  } catch (error) {
    throw fail("unsafe-path", `${label} is unavailable`, error);
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    real !== path
  ) {
    throw fail(
      "unsafe-path",
      `${label} must be a real single-link regular file`,
    );
  }
  return { devIno: identity(stat), realpath: real };
}

export function optionalFileIdentity(
  path: string,
  label: string,
): Identity | null {
  try {
    return assertSingleLinkRegularFile(path, label);
  } catch (error) {
    if (
      error instanceof ArtifactTransactionError &&
      (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
    ) {
      return null;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function writeAll(descriptor: number, text: string): void {
  const bytes = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error("short transaction artifact write");
    offset += written;
  }
}

export function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function acquireCoordinatorLock(
  lockPath: string,
  parent: string,
  options: ArtifactTransactionProcessLockOptions = {},
): LockState {
  const previousIdentity = optionalFileIdentity(
    lockPath,
    "existing transaction lock",
  );
  let handle: ProcessLockHandle;
  try {
    const acquireOptions: AcquireProcessLockOptions = {
      ...options,
      reclaimDeadSameBoot: true,
      beforeReclaimUnlink:
        previousIdentity === null
          ? undefined
          : () => {
              const current = assertSingleLinkRegularFile(
                lockPath,
                "stale transaction lock",
              );
              if (
                current.devIno !== previousIdentity.devIno ||
                current.realpath !== previousIdentity.realpath
              ) {
                throw fail(
                  "lock-identity-changed",
                  "stale transaction lock changed during recovery",
                );
              }
            },
    };
    handle = acquireProcessLock(lockPath, acquireOptions);
  } catch (error) {
    if (error instanceof ArtifactTransactionError) throw error;
    if (isProcessLockError(error)) {
      throw fail(
        "lock-unavailable",
        `transaction lock is ${error.reason}`,
        error,
      );
    }
    throw fail(
      "lock-unavailable",
      "transaction lock acquisition failed",
      error,
    );
  }

  try {
    const current = assertSingleLinkRegularFile(
      lockPath,
      "acquired transaction lock",
    );
    const payload = readProcessLockPayload(lockPath);
    if (payload?.pid !== handle.pid || payload.token !== handle.token) {
      throw fail(
        "lock-identity-changed",
        "transaction lock ownership changed during acquisition",
      );
    }
    try {
      fsyncDirectory(parent);
    } catch (error) {
      throw fail(
        "durability-failed",
        "transaction lock publication durability is unknown",
        error,
      );
    }
    return {
      devIno: current.devIno,
      handle,
      parent,
      realpath: current.realpath,
    };
  } catch (error) {
    releaseProcessLock(handle);
    throw error;
  }
}

export function revalidateCoordinatorLock(lock: LockState): void {
  let current: Identity;
  try {
    current = assertSingleLinkRegularFile(
      lock.handle.path,
      "held transaction lock",
    );
  } catch (error) {
    throw fail(
      "lock-identity-changed",
      "transaction lock disappeared or changed shape",
      error,
    );
  }
  const payload = readProcessLockPayload(lock.handle.path);
  if (
    current.devIno !== lock.devIno ||
    current.realpath !== lock.realpath ||
    payload?.pid !== lock.handle.pid ||
    payload.token !== lock.handle.token
  ) {
    throw fail(
      "lock-identity-changed",
      "transaction lock identity or ownership changed",
    );
  }
}

export function releaseCoordinatorLock(lock: LockState): void {
  revalidateCoordinatorLock(lock);
  const released = releaseProcessLock(lock.handle, {
    beforeReleaseUnlink: () => revalidateCoordinatorLock(lock),
  });
  if (!released) {
    throw fail(
      "lock-identity-changed",
      "transaction lock ownership changed before release",
    );
  }
  try {
    fsyncDirectory(lock.parent);
  } catch (error) {
    throw fail(
      "durability-failed",
      "transaction lock release durability is unknown",
      error,
    );
  }
}

export function captureAncestors(
  root: string,
  parts: readonly string[],
): {
  ancestors: AncestorIdentity[];
  parent: string;
} {
  const ancestors: AncestorIdentity[] = [];
  let cursor = root;
  const capture = (path: string): void => {
    let stat: Stats;
    let real: string;
    try {
      stat = lstatSync(path);
      real = realpathSync(path);
    } catch (error) {
      throw fail("unsafe-path", "an operation ancestor is unavailable", error);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || !isInside(root, real)) {
      throw fail(
        "unsafe-path",
        "an operation ancestor is not a repository-confined real directory",
      );
    }
    ancestors.push({
      path,
      devIno: identity(stat),
      realpath: real,
    });
  };
  capture(root);
  for (const part of parts) {
    cursor = join(cursor, part);
    capture(cursor);
  }
  return { ancestors, parent: cursor };
}

export function revalidateAncestors(
  root: string,
  ancestors: readonly AncestorIdentity[],
): void {
  for (const expected of ancestors) {
    let stat: Stats;
    let real: string;
    try {
      stat = lstatSync(expected.path);
      real = realpathSync(expected.path);
    } catch (error) {
      throw fail("unsafe-path", "an operation ancestor disappeared", error);
    }
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      identity(stat) !== expected.devIno ||
      real !== expected.realpath ||
      !isInside(root, real)
    ) {
      throw fail("unsafe-path", "an operation ancestor changed identity");
    }
  }
}

export function readSafeFile(
  root: string,
  absolute: string,
  label: string,
): {
  hash: string;
  identity: Identity;
  mode: number;
} {
  let descriptor: number;
  try {
    descriptor = openSync(
      absolute,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    throw error;
  }
  try {
    const opened = fstatSync(descriptor);
    let pathStat: Stats;
    let real: string;
    try {
      pathStat = lstatSync(absolute);
      real = realpathSync(absolute);
    } catch (error) {
      throw fail("unsafe-path", `${label} changed while opened`, error);
    }
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      !pathStat.isFile() ||
      pathStat.isSymbolicLink() ||
      pathStat.nlink !== 1 ||
      identity(opened) !== identity(pathStat) ||
      !isInside(root, real)
    ) {
      throw fail(
        "unsafe-path",
        `${label} must be a repository-confined single-link regular file`,
      );
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (identity(after) !== identity(opened) || after.size !== bytes.length) {
      throw fail("concurrent-drift", `${label} changed while hashing`);
    }
    return {
      hash: sha256Bytes(bytes),
      identity: { devIno: identity(opened), realpath: real },
      mode: opened.mode & 0o777,
    };
  } finally {
    closeSync(descriptor);
  }
}

export function readTarget(
  root: string,
  operation: ResolvedOperation,
): ReturnType<typeof readSafeFile> | null {
  revalidateAncestors(root, operation.ancestors);
  try {
    return readSafeFile(root, operation.absolute, `target ${operation.path}`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") {
      throw fail("unsafe-path", `target ${operation.path} is a symlink`, error);
    }
    throw error;
  }
}

export function isOwnedLink(
  root: string,
  firstPath: string,
  secondPath: string,
  expectedSha256: string,
  label: string,
): boolean {
  let first: Stats;
  let second: Stats;
  let firstReal: string;
  let secondReal: string;
  try {
    first = lstatSync(firstPath);
    second = lstatSync(secondPath);
    firstReal = realpathSync(firstPath);
    secondReal = realpathSync(secondPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw fail("unsafe-path", `${label} is unavailable`, error);
  }
  if (
    !first.isFile() ||
    first.isSymbolicLink() ||
    first.nlink !== 2 ||
    !second.isFile() ||
    second.isSymbolicLink() ||
    second.nlink !== 2 ||
    identity(first) !== identity(second) ||
    !isInside(root, firstReal) ||
    !isInside(root, secondReal)
  ) {
    return false;
  }
  let descriptor: number;
  try {
    descriptor = openSync(
      firstPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    throw fail("candidate-invalid", `${label} cannot be opened`, error);
  }
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 2 ||
      identity(opened) !== identity(first) ||
      sha256Bytes(readFileSync(descriptor)) !== expectedSha256
    ) {
      return false;
    }
  } finally {
    closeSync(descriptor);
  }
  return true;
}

export function isOwnedAfterLink(
  root: string,
  operation: ResolvedOperation,
): boolean {
  return (
    operation.desiredSha256 !== null &&
    operation.candidateAbsolute !== null &&
    isOwnedLink(
      root,
      operation.absolute,
      operation.candidateAbsolute,
      operation.desiredSha256,
      `owned final link for ${operation.path}`,
    )
  );
}

export function isOwnedBeforeLink(
  root: string,
  operation: ResolvedOperation,
): boolean {
  return (
    operation.expectedBeforeSha256 !== null &&
    operation.backupAbsolute !== null &&
    isOwnedLink(
      root,
      operation.absolute,
      operation.backupAbsolute,
      operation.expectedBeforeSha256,
      `owned backup link for ${operation.path}`,
    )
  );
}

export function targetState(
  root: string,
  operation: ResolvedOperation,
): TargetState {
  if (isOwnedAfterLink(root, operation)) return "owned-after-link";
  if (isOwnedBeforeLink(root, operation)) return "owned-before-link";
  const observed = readTarget(root, operation);
  if (operation.expectedBeforeSha256 === null) {
    if (observed === null) return "before";
    if (observed.hash === operation.desiredSha256) return "after";
  } else if (operation.desiredSha256 === null) {
    if (observed === null) return "after";
    if (observed.hash === operation.expectedBeforeSha256) return "before";
  } else if (observed !== null) {
    if (observed.hash === operation.expectedBeforeSha256) return "before";
    if (observed.hash === operation.desiredSha256) return "after";
  }
  throw fail(
    "concurrent-drift",
    `target ${operation.path} matches neither transaction state`,
  );
}

export function deriveTransactionId(
  rootIdentity: Identity,
  operations: readonly {
    path: string;
    expectedBeforeSha256: string | null;
    desiredSha256: string | null;
  }[],
  authorizationDigest: string,
): string {
  return sha256Bytes(
    canonicalJson({
      authorizationDigest,
      operations: operations.map((operation) => ({
        afterSha256: operation.desiredSha256,
        beforeSha256: operation.expectedBeforeSha256,
        path: operation.path,
      })),
      root: rootIdentity,
      schemaVersion: 1,
    }),
  );
}

export function buildJournal(
  rootIdentity: Identity,
  operations: readonly NormalizedOperation[],
  authorizationDigest: string,
): TransactionJournal {
  const transactionId = deriveTransactionId(
    rootIdentity,
    operations,
    authorizationDigest,
  );
  return {
    authorizationDigest,
    operations: operations.map((operation, index) => {
      const parts = operation.path.split("/");
      const candidatePath =
        operation.desiredText === null
          ? null
          : [
              ...parts.slice(0, -1),
              `.artifact-transaction-${transactionId.slice(0, 24)}-${index}.candidate`,
            ].join("/");
      const backupPath =
        operation.expectedBeforeSha256 === null
          ? null
          : [
              ...parts.slice(0, -1),
              `.artifact-transaction-${transactionId.slice(0, 24)}-${index}.backup`,
            ].join("/");
      return {
        afterSha256: operation.desiredSha256,
        backupDevIno: null,
        backupPath,
        beforeSha256: operation.expectedBeforeSha256,
        candidateDevIno: null,
        candidatePath,
        path: operation.path,
      };
    }),
    phase: "applying",
    receipt: null,
    root: rootIdentity,
    schemaVersion: 1,
    transactionId,
  };
}

export function parseJournal(value: unknown): TransactionJournal {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "authorizationDigest",
      "operations",
      "phase",
      "receipt",
      "root",
      "schemaVersion",
      "transactionId",
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.authorizationDigest !== "string" ||
    !SHA256_PATTERN.test(value.authorizationDigest) ||
    !["applying", "prepared", "finalizing", "committed"].includes(
      value.phase as string,
    ) ||
    !(
      value.receipt === null ||
      (isRecord(value.receipt) &&
        exactKeys(value.receipt, [
          "createCount",
          "deleteCount",
          "operationCount",
          "replacementCount",
          "schemaVersion",
          "transactionId",
        ]) &&
        value.receipt.schemaVersion === 1 &&
        typeof value.receipt.transactionId === "string" &&
        SHA256_PATTERN.test(value.receipt.transactionId) &&
        typeof value.receipt.operationCount === "number" &&
        typeof value.receipt.replacementCount === "number" &&
        typeof value.receipt.createCount === "number" &&
        typeof value.receipt.deleteCount === "number")
    ) ||
    typeof value.transactionId !== "string" ||
    !SHA256_PATTERN.test(value.transactionId) ||
    !isRecord(value.root) ||
    !exactKeys(value.root, ["devIno", "realpath"]) ||
    typeof value.root.devIno !== "string" ||
    typeof value.root.realpath !== "string" ||
    !Array.isArray(value.operations) ||
    value.operations.length === 0 ||
    value.operations.length > MAX_OPERATIONS
  ) {
    throw fail(
      "journal-malformed",
      "transaction journal envelope is malformed",
    );
  }
  const operations: JournalOperation[] = value.operations.map(
    (operation, index) => {
      if (
        !isRecord(operation) ||
        !exactKeys(operation, [
          "afterSha256",
          "backupDevIno",
          "backupPath",
          "beforeSha256",
          "candidateDevIno",
          "candidatePath",
          "path",
        ]) ||
        typeof operation.path !== "string" ||
        !(
          operation.beforeSha256 === null ||
          (typeof operation.beforeSha256 === "string" &&
            SHA256_PATTERN.test(operation.beforeSha256))
        ) ||
        !(
          operation.backupDevIno === null ||
          (typeof operation.backupDevIno === "string" &&
            DEV_INO_PATTERN.test(operation.backupDevIno))
        ) ||
        !(
          operation.candidateDevIno === null ||
          (typeof operation.candidateDevIno === "string" &&
            DEV_INO_PATTERN.test(operation.candidateDevIno))
        ) ||
        !(
          operation.afterSha256 === null ||
          (typeof operation.afterSha256 === "string" &&
            SHA256_PATTERN.test(operation.afterSha256))
        ) ||
        !(
          operation.backupPath === null ||
          typeof operation.backupPath === "string"
        ) ||
        !(
          operation.candidatePath === null ||
          typeof operation.candidatePath === "string"
        )
      ) {
        throw fail(
          "journal-malformed",
          `transaction journal operation ${index} is malformed`,
        );
      }
      safeRelativePath(operation.path, `journal.operations[${index}].path`);
      if (operation.candidatePath !== null) {
        safeRelativePath(
          operation.candidatePath,
          `journal.operations[${index}].candidatePath`,
        );
      }
      if (operation.backupPath !== null) {
        safeRelativePath(
          operation.backupPath,
          `journal.operations[${index}].backupPath`,
        );
      }
      return {
        afterSha256: operation.afterSha256 as string | null,
        backupDevIno: operation.backupDevIno as string | null,
        backupPath: operation.backupPath as string | null,
        beforeSha256: operation.beforeSha256 as string | null,
        candidateDevIno: operation.candidateDevIno as string | null,
        candidatePath: operation.candidatePath as string | null,
        path: operation.path,
      };
    },
  );
  return {
    authorizationDigest: value.authorizationDigest,
    operations,
    phase: value.phase as TransactionJournal["phase"],
    receipt: value.receipt as TransactionJournal["receipt"],
    root: {
      devIno: value.root.devIno,
      realpath: value.root.realpath,
    },
    schemaVersion: 1,
    transactionId: value.transactionId,
  };
}

export function readJournalFile(path: string): JournalState {
  const before = assertSingleLinkRegularFile(path, "transaction journal");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw fail(
      "journal-malformed",
      "transaction journal is not valid JSON",
      error,
    );
  }
  const after = assertSingleLinkRegularFile(path, "transaction journal");
  if (before.devIno !== after.devIno || before.realpath !== after.realpath) {
    throw fail(
      "journal-malformed",
      "transaction journal changed while reading",
    );
  }
  return { identity: after, journal: parseJournal(value) };
}

export function sameJournal(
  left: TransactionJournal,
  right: TransactionJournal,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function transactionIdentity(journal: TransactionJournal): unknown {
  return {
    authorizationDigest: journal.authorizationDigest,
    operations: journal.operations.map((operation) => ({
      afterSha256: operation.afterSha256,
      backupPath: operation.backupPath,
      beforeSha256: operation.beforeSha256,
      candidatePath: operation.candidatePath,
      path: operation.path,
    })),
    root: journal.root,
    schemaVersion: journal.schemaVersion,
    transactionId: journal.transactionId,
  };
}

export function sameTransaction(
  left: TransactionJournal,
  right: TransactionJournal,
): boolean {
  return (
    canonicalJson(transactionIdentity(left)) ===
    canonicalJson(transactionIdentity(right))
  );
}

export function createExclusiveSyncedFile(
  path: string,
  text: string,
  mode: number,
): Identity {
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      mode,
    );
  } catch (error) {
    throw error;
  }
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1) {
      throw fail(
        "unsafe-path",
        "exclusive transaction artifact has an unsafe identity",
      );
    }
    writeAll(descriptor, text);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return assertSingleLinkRegularFile(path, "exclusive transaction artifact");
}

export function loadOrCreateJournal(
  journalPath: string,
  parent: string,
  expected: TransactionJournal,
  assertLock: () => void,
): { recovered: boolean; state: JournalState } {
  const stagePath = `${journalPath}.candidate`;
  const journalIdentity = optionalFileIdentity(
    journalPath,
    "transaction journal",
  );
  const stageIdentity = optionalFileIdentity(
    stagePath,
    "transaction journal candidate",
  );
  if (journalIdentity !== null && stageIdentity !== null) {
    const current = readJournalFile(journalPath);
    const staged = readJournalFile(stagePath);
    validatePhaseJournal(current.journal);
    validatePhaseJournal(staged.journal);
    const phaseRank = {
      applying: 0,
      prepared: 1,
      finalizing: 2,
      committed: 3,
    } as const;
    if (
      !sameTransaction(current.journal, expected) ||
      !sameTransaction(staged.journal, expected) ||
      phaseRank[staged.journal.phase] !== phaseRank[current.journal.phase] + 1
    ) {
      throw fail(
        "journal-state-conflict",
        "journal and journal candidate do not form one recoverable transition",
      );
    }
    assertLock();
    try {
      renameSync(stagePath, journalPath);
      fsyncDirectory(parent);
    } catch (error) {
      throw fail(
        "durability-failed",
        "journal transition durability is unknown",
        error,
      );
    }
    return { recovered: true, state: readJournalFile(journalPath) };
  }
  if (journalIdentity !== null) {
    const state = readJournalFile(journalPath);
    if (!sameTransaction(state.journal, expected)) {
      throw fail(
        "pending-journal-mismatch",
        "pending journal belongs to another transaction",
      );
    }
    return { recovered: true, state };
  }
  if (stageIdentity !== null) {
    const staged = readJournalFile(stagePath);
    validatePhaseJournal(staged.journal);
    if (!sameTransaction(staged.journal, expected)) {
      throw fail(
        "pending-journal-mismatch",
        "pending journal candidate belongs to another transaction",
      );
    }
    assertLock();
    try {
      renameSync(stagePath, journalPath);
      fsyncDirectory(parent);
    } catch (error) {
      throw fail(
        "durability-failed",
        "journal creation durability is unknown",
        error,
      );
    }
    return { recovered: true, state: readJournalFile(journalPath) };
  }

  assertLock();
  try {
    createExclusiveSyncedFile(stagePath, canonicalJson(expected), 0o600);
  } catch (error) {
    throw fail("durability-failed", "journal candidate creation failed", error);
  }
  const staged = readJournalFile(stagePath);
  if (!sameJournal(staged.journal, expected)) {
    throw fail(
      "journal-malformed",
      "durable journal candidate failed verification",
    );
  }
  assertLock();
  try {
    renameSync(stagePath, journalPath);
    fsyncDirectory(parent);
  } catch (error) {
    throw fail(
      "durability-failed",
      "journal publication durability is unknown",
      error,
    );
  }
  const state = readJournalFile(journalPath);
  if (!sameJournal(state.journal, expected)) {
    throw fail("journal-malformed", "durable journal failed verification");
  }
  return { recovered: false, state };
}

export function transitionJournal(
  journalPath: string,
  parent: string,
  current: JournalState,
  next: TransactionJournal,
  assertLock: () => void,
): JournalState {
  const stagePath = `${journalPath}.candidate`;
  validatePhaseJournal(current.journal);
  validatePhaseJournal(next);
  if (!sameTransaction(current.journal, next)) {
    throw fail(
      "pending-journal-mismatch",
      "journal transition changes transaction identity",
    );
  }
  if (
    optionalFileIdentity(stagePath, "transaction journal candidate") !== null
  ) {
    throw fail(
      "journal-state-conflict",
      "journal transition candidate already exists",
    );
  }
  try {
    createExclusiveSyncedFile(stagePath, canonicalJson(next), 0o600);
  } catch (error) {
    throw fail(
      "durability-failed",
      "journal transition candidate creation failed",
      error,
    );
  }
  const staged = readJournalFile(stagePath);
  if (!sameJournal(staged.journal, next)) {
    throw fail(
      "journal-malformed",
      "journal transition candidate failed verification",
    );
  }
  const immediate = readJournalFile(journalPath);
  if (
    immediate.identity.devIno !== current.identity.devIno ||
    immediate.identity.realpath !== current.identity.realpath ||
    !sameJournal(immediate.journal, current.journal)
  ) {
    throw fail(
      "journal-state-conflict",
      "journal changed before phase transition",
    );
  }
  assertLock();
  const final = readJournalFile(journalPath);
  if (
    final.identity.devIno !== current.identity.devIno ||
    final.identity.realpath !== current.identity.realpath ||
    !sameJournal(final.journal, current.journal)
  ) {
    throw fail(
      "journal-state-conflict",
      "journal changed immediately before phase transition",
    );
  }
  try {
    renameSync(stagePath, journalPath);
    fsyncDirectory(parent);
  } catch (error) {
    throw fail(
      "durability-failed",
      "journal phase transition durability is unknown",
      error,
    );
  }
  const state = readJournalFile(journalPath);
  if (!sameJournal(state.journal, next)) {
    throw fail(
      "journal-malformed",
      "journal phase transition failed verification",
    );
  }
  return state;
}

export function resolveOperations(
  root: string,
  normalized: readonly NormalizedOperation[],
  journal: TransactionJournal,
): ResolvedOperation[] {
  const targetPaths = new Set(normalized.map((operation) => operation.path));
  return normalized.map((operation, index) => {
    const parts = safeRelativePath(operation.path, `operations[${index}].path`);
    const { ancestors, parent } = captureAncestors(root, parts.slice(0, -1));
    const journalOperation = journal.operations[index]!;
    const transactionPrefix = journal.transactionId.slice(0, 24);
    const expectedCandidatePath =
      operation.desiredSha256 === null
        ? null
        : [
            ...parts.slice(0, -1),
            `.artifact-transaction-${transactionPrefix}-${index}.candidate`,
          ].join("/");
    const expectedBackupPath =
      operation.expectedBeforeSha256 === null
        ? null
        : [
            ...parts.slice(0, -1),
            `.artifact-transaction-${transactionPrefix}-${index}.backup`,
          ].join("/");
    if (
      journalOperation.path !== operation.path ||
      journalOperation.beforeSha256 !== operation.expectedBeforeSha256 ||
      journalOperation.afterSha256 !== operation.desiredSha256 ||
      journalOperation.candidatePath !== expectedCandidatePath ||
      journalOperation.backupPath !== expectedBackupPath
    ) {
      throw fail(
        "pending-journal-mismatch",
        "journal operation does not match caller input",
      );
    }
    const candidatePath = journalOperation.candidatePath;
    const backupPath = journalOperation.backupPath;
    if (
      (candidatePath !== null && targetPaths.has(candidatePath)) ||
      (backupPath !== null && targetPaths.has(backupPath)) ||
      (candidatePath !== null && candidatePath === backupPath)
    ) {
      throw fail(
        "invalid-input",
        "a transaction candidate collides with a target path",
      );
    }
    return {
      ...operation,
      absolute: join(parent, basename(operation.path)),
      ancestors,
      backupAbsolute: backupPath === null ? null : join(root, backupPath),
      backupPath,
      candidateAbsolute:
        candidatePath === null ? null : join(root, candidatePath),
      candidatePath,
      parent,
    };
  });
}

export function receiptBody(
  journal: TransactionJournal,
): Omit<ArtifactTransactionReceipt, "recovered"> {
  const complete = receipt(journal, false);
  const { recovered: _recovered, ...body } = complete;
  return body;
}

export function receipt(
  journal: TransactionJournal,
  recovered: boolean,
): ArtifactTransactionReceipt {
  let replacementCount = 0;
  let createCount = 0;
  let deleteCount = 0;
  for (const operation of journal.operations) {
    if (operation.beforeSha256 === null) createCount += 1;
    else if (operation.afterSha256 === null) deleteCount += 1;
    else replacementCount += 1;
  }
  return {
    schemaVersion: 1,
    transactionId: journal.transactionId,
    recovered,
    operationCount: journal.operations.length,
    replacementCount,
    createCount,
    deleteCount,
  };
}

export function validatePhaseJournal(journal: TransactionJournal): void {
  const derivedTransactionId = deriveTransactionId(
    journal.root,
    journal.operations.map((operation) => ({
      path: operation.path,
      expectedBeforeSha256: operation.beforeSha256,
      desiredSha256: operation.afterSha256,
    })),
    journal.authorizationDigest,
  );
  if (journal.transactionId !== derivedTransactionId) {
    throw fail(
      "journal-malformed",
      "journal transaction ID does not match its authorization and operations",
    );
  }
  const expectedReceipt = receiptBody(journal);
  if (journal.phase === "committed") {
    if (
      journal.receipt === null ||
      canonicalJson(journal.receipt) !== canonicalJson(expectedReceipt)
    ) {
      throw fail("journal-malformed", "committed journal receipt is invalid");
    }
  } else if (journal.receipt !== null) {
    throw fail("journal-malformed", "uncommitted journal contains a receipt");
  }
  for (const operation of journal.operations) {
    const hasOwnershipIdentity =
      operation.candidateDevIno !== null || operation.backupDevIno !== null;
    if (journal.phase === "applying" && hasOwnershipIdentity) {
      throw fail(
        "journal-malformed",
        "applying journal contains final ownership",
      );
    }
    if (
      journal.phase !== "applying" &&
      ((operation.afterSha256 !== null) !==
        (operation.candidateDevIno !== null) ||
        (operation.beforeSha256 !== null) !== (operation.backupDevIno !== null))
    ) {
      throw fail(
        "journal-malformed",
        "finalizing journal lacks ownership identity",
      );
    }
  }
}

export function recoveryPacket(
  journal: TransactionJournal,
  journalPath: string,
): ArtifactTransactionRecoveryPacket {
  return {
    transactionId: journal.transactionId,
    journalPath,
    paths: journal.operations.map((operation) => operation.path),
  };
}

export function withRecoveryPacket(
  error: unknown,
  journal: TransactionJournal,
  journalPath: string,
): unknown {
  if (!(error instanceof ArtifactTransactionError)) {
    return new ArtifactTransactionError(
      "mutation-outcome-unknown",
      "transaction outcome is unknown after durable journal publication",
      {
        cause: error,
        recoveryPacket: recoveryPacket(journal, journalPath),
      },
    );
  }
  if (error.recoveryPacket !== undefined) return error;
  return new ArtifactTransactionError(error.code, error.message, {
    cause: error.cause,
    recoveryPacket: recoveryPacket(journal, journalPath),
  });
}
