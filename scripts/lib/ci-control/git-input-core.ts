import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { TextDecoder, types as utilTypes } from "node:util";

import { cleanGitEnv } from "../../../src/lib/git-env.ts";

const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength",
)!.get!;
const TYPED_ARRAY_BYTE_OFFSET = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteOffset",
)!.get!;
const TYPED_ARRAY_BUFFER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "buffer",
)!.get!;

export const MAX_CHANGE_SET_BYTES = 16 * 1024 * 1024;
export const MAX_CHANGE_FACT_COUNT = 50_000;
export const MAX_EXACT_COMMIT_COUNT = 4_096;
export const MAX_EXACT_COMMIT_PARENT_EDGE_COUNT = 8_192;
export const MAX_EXACT_COMMIT_RANGE_BYTES = 1 * 1_024 * 1_024;
export const MAX_EXACT_SINGLE_COMMIT_METADATA_BYTES = 1 * 1_024 * 1_024;
export const MAX_EXACT_AGGREGATE_COMMIT_METADATA_BYTES = 16 * 1_024 * 1_024;
export const MAX_EXACT_BLOB_COUNT = 50_000;
export const MAX_EXACT_SINGLE_BLOB_BYTES = 4 * 1_024 * 1_024;
export const MAX_EXACT_AGGREGATE_BLOB_BYTES = 16 * 1_024 * 1_024;
export const MAX_EXACT_ADDED_LINE_CHANGE_COUNT = 4_096;
export const MAX_EXACT_ADDED_LINE_COUNT = 100_000;
export const MAX_EXACT_ADDED_LINE_SOURCE_LINE_COUNT = 200_000;
export const MAX_EXACT_ADDED_LINE_PATCH_BYTES = 4 * 1_024 * 1_024;
export const MAX_EXACT_ADDED_LINE_PATCH_ROW_COUNT = 400_000;
export const MAX_EXACT_ADDED_LINE_PATCH_TOTAL_BYTES = 16 * 1_024 * 1_024;
export const MAX_EXACT_ADDED_LINE_BYTES = 16 * 1_024 * 1_024;
export const MAX_EXACT_ADDED_LINE_BUDGET_V1: Readonly<ExactAddedLineBudgetV1> =
  Object.freeze({
    changeCount: MAX_EXACT_ADDED_LINE_CHANGE_COUNT,
    sourceBlobBytes: MAX_EXACT_AGGREGATE_BLOB_BYTES,
    sourceLineCount: MAX_EXACT_ADDED_LINE_SOURCE_LINE_COUNT,
    patchBytes: MAX_EXACT_ADDED_LINE_PATCH_TOTAL_BYTES,
    addedLineCount: MAX_EXACT_ADDED_LINE_COUNT,
    addedTextBytes: MAX_EXACT_ADDED_LINE_BYTES,
  });
export const MAX_EXACT_TREE_ENTRY_PATH_COUNT = 64;
export const MAX_EXACT_TREE_ENTRY_PATH_BYTES = 1_024;
export const MAX_EXACT_TREE_ENTRY_PATH_SEGMENT_COUNT = 1_023;
export const MAX_EXACT_SINGLE_TREE_BYTES = 4 * 1_024 * 1_024;
export const MAX_EXACT_AGGREGATE_TREE_BYTES = 16 * 1_024 * 1_024;
export const MAX_EXACT_TREE_ENTRY_COUNT = 50_000;
const MAX_EXACT_TREE_GIT_COMMAND_COUNT = 4_000;

export type ChangeStatusV1 =
  "added" | "modified" | "deleted" | "renamed" | "copied";
export type ChangeModeV1 = "000000" | "100644" | "100755" | "120000" | "160000";
export type ChangeObjectTypeV1 =
  "absent" | "blob" | "executable" | "symlink" | "gitlink";
export type ExactTreeModeV1 = Exclude<ChangeModeV1, "000000"> | "040000";
export type ExactTreeObjectTypeV1 = Exclude<ChangeObjectTypeV1, "absent"> | "tree";

/**
 * Exact endpoint state with state-compatible Git presentation grouping.
 *
 * Paths, modes, object identities, and the expanded added/deleted/modified
 * endpoint multiset are verified from exact commit/tree objects. For
 * `renamed` and `copied` facts, `status`, `oldPath`, and `similarity` remain
 * advisory diffcore grouping: Git objects do not encode lineage or similarity.
 * Blocker-grade added-line consumers must therefore scan every line of a
 * changed rename/copy destination; only equal-object moves/copies prove zero
 * byte additions.
 */
export interface ChangeFactV1 {
  status: ChangeStatusV1;
  path: string;
  oldPath: string | null;
  oldMode: ChangeModeV1;
  newMode: ChangeModeV1;
  oldOid: string;
  newOid: string;
  oldType: ChangeObjectTypeV1;
  newType: ChangeObjectTypeV1;
  similarity: number | null;
}

export interface ExactCommitRangeInputV1 {
  baseOid: string;
  remoteOid: string | null;
  localOid: string;
}

export interface ExactCommitV1 {
  oid: string;
  parentOids: string[];
  firstParentOid: string;
}

export interface ExactCommitRangeV1 {
  baseOid: string;
  remoteOid: string | null;
  rangeStartOid: string;
  localOid: string;
  commits: ExactCommitV1[];
}

export interface ExactCommitMetadataV1 {
  oid: string;
  treeOid: string;
  parentOids: string[];
  authorName: string;
  authorEmail: string;
  subject: string;
  message: string;
  byteLength: number;
  contentSha256: `sha256:${string}`;
}

export interface ExactBlobV1 {
  oid: string;
  byteLength: number;
  contentSha256: `sha256:${string}`;
  bytes: Uint8Array;
}

export interface ExactTreeLookupInputV1 {
  candidateOid: string;
  paths: readonly string[];
}

export interface ExactTreeEntryV1 {
  path: string;
  presence: "present" | "absent";
  mode: ExactTreeModeV1 | null;
  objectType: ExactTreeObjectTypeV1 | null;
  objectOid: string | null;
}

export interface ExactTreeEntrySetV1 {
  candidateOid: string;
  treeOid: string;
  entries: ExactTreeEntryV1[];
}

export interface ExactTreePathSetV1 {
  candidateOid: string;
  treeOid: string;
  listingDigest: `sha256:${string}`;
  paths: string[];
}

export interface ExactAddedLineInputV1 {
  baseOid: string;
  candidateOid: string;
}

export interface ExactAddedLineBudgetV1 {
  changeCount: number;
  sourceBlobBytes: number;
  sourceLineCount: number;
  patchBytes: number;
  addedLineCount: number;
  addedTextBytes: number;
}

export interface ExactAddedLineBudgetAccountingV1 {
  limit: ExactAddedLineBudgetV1;
  consumed: ExactAddedLineBudgetV1;
  remaining: ExactAddedLineBudgetV1;
}

export interface ExactBudgetedAddedLineInputV1 extends ExactAddedLineInputV1 {
  budget: ExactAddedLineBudgetV1;
}

export interface ExactAddedLineV1 {
  path: string;
  newBlobOid: string;
  newLineNumber: number;
  text: string;
}

export interface ExactChangeWithAddedLinesV1 extends ChangeFactV1 {
  addedLines: ExactAddedLineV1[];
}

export interface ExactAddedLineSetV1 {
  baseOid: string;
  candidateOid: string;
  changes: ExactChangeWithAddedLinesV1[];
}

export interface ExactBudgetedAddedLineSetV1 extends ExactAddedLineSetV1 {
  accounting: ExactAddedLineBudgetAccountingV1;
}

export type ExactGitInputErrorCode =
  | "ci.input.history-graft-present"
  | "ci.input.git-control-unavailable"
  | "ci.input.revision-unavailable"
  | "ci.input.commit-range-unavailable"
  | "ci.input.commit-range-malformed"
  | "ci.input.commit-range-budget"
  | "ci.input.commit-metadata-malformed"
  | "ci.input.commit-metadata-unavailable"
  | "ci.input.commit-metadata-timeout"
  | "ci.input.commit-metadata-budget"
  | "ci.input.commit-metadata-invalid-utf8"
  | "ci.input.commit-metadata-identity-mismatch"
  | "ci.input.tree-entry-malformed"
  | "ci.input.tree-entry-unavailable"
  | "ci.input.tree-entry-timeout"
  | "ci.input.tree-entry-budget"
  | "ci.input.tree-entry-identity-mismatch"
  | "ci.input.blob-set-malformed"
  | "ci.input.blob-set-budget"
  | "ci.input.blob-unavailable"
  | "ci.input.blob-type-unsupported"
  | "ci.input.blob-identity-mismatch"
  | "ci.input.git-execution-timeout"
  | "ci.input.added-lines.input-malformed"
  | "ci.input.added-lines.unavailable"
  | "ci.input.added-lines.timeout"
  | "ci.input.added-lines.budget"
  | "ci.input.added-lines.binary"
  | "ci.input.added-lines.invalid-utf8"
  | "ci.input.added-lines.gitlink"
  | "ci.input.added-lines.patch-malformed"
  | "ci.input.added-lines.identity-mismatch"
  | "ci.classification.merge-base-unavailable"
  | "ci.classification.change-set-malformed"
  | "ci.classification.change-set-identity-mismatch"
  | "ci.classification.change-set-budget"
  | "ci.classification.execution-timeout";

export class ExactGitInputError extends Error {
  readonly code: ExactGitInputErrorCode;

  constructor(
    code: ExactGitInputErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ExactGitInputError";
    this.code = code;
  }
}

export const FULL_OID = /^[0-9a-f]{40}$/;
export const ZERO_OID = "0".repeat(40);
export const HEADER =
  /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([AMD]|[RC](\d{1,3}))$/;
export const UTF8 = new TextDecoder("utf-8", { fatal: true });
export const GIT_TIMEOUT_MS = 30_000;
export const MODE_TYPES: Readonly<Record<ChangeModeV1, ChangeObjectTypeV1>> = {
  "000000": "absent",
  "100644": "blob",
  "100755": "executable",
  "120000": "symlink",
  "160000": "gitlink",
};

function gitControlUnavailable(): ExactGitInputError {
  return new ExactGitInputError(
    "ci.input.git-control-unavailable",
    "ci.input.git-control-unavailable",
  );
}

export function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...cleanGitEnv(),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_KEY_0: "advice.graftFileDeprecated",
    GIT_CONFIG_VALUE_0: "false",
    GIT_GRAFT_FILE: "/dev/null",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function boundedControlPath(path: string): string | null {
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  if (metadata === undefined) return null;
  if (!metadata.isFile() || metadata.size > 4_096) {
    throw gitControlUnavailable();
  }
  const value = readFileSync(path, "utf8");
  if (!value.endsWith("\n")) {
    throw gitControlUnavailable();
  }
  const line = value.endsWith("\r\n") ? value.slice(0, -2) : value.slice(0, -1);
  if (line.includes("\n") || line.includes("\r")) {
    throw gitControlUnavailable();
  }
  return line;
}

function gitCommonDirFromFilesystem(cwd: string): string | null {
  let cursor = resolve(cwd);
  for (;;) {
    const dotGit = join(cursor, ".git");
    const metadata = lstatSync(dotGit, { throwIfNoEntry: false });
    if (metadata?.isDirectory()) return dotGit;
    if (metadata?.isFile()) {
      const pointer = boundedControlPath(dotGit);
      if (pointer === null || !pointer.startsWith("gitdir: ")) {
        throw gitControlUnavailable();
      }
      const rawGitDir = pointer.slice("gitdir: ".length);
      if (rawGitDir.length === 0) {
        throw gitControlUnavailable();
      }
      const gitDir = isAbsolute(rawGitDir) ? rawGitDir : resolve(cursor, rawGitDir);
      const common = boundedControlPath(join(gitDir, "commondir"));
      return common === null
        ? gitDir
        : isAbsolute(common)
        ? common
        : resolve(gitDir, common);
    }
    if (metadata !== undefined) {
      throw gitControlUnavailable();
    }
    const bareHead = lstatSync(join(cursor, "HEAD"), { throwIfNoEntry: false });
    const bareObjects = lstatSync(join(cursor, "objects"), { throwIfNoEntry: false });
    if (bareHead?.isFile() && bareObjects?.isDirectory()) return cursor;
    if (bareHead !== undefined || bareObjects !== undefined) {
      throw gitControlUnavailable();
    }
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

/** Reject legacy graft metadata before any Git command can interpret rewritten ancestry. */
export function assertNoLegacyGrafts(cwd: string): void {
  try {
    const commonDir = gitCommonDirFromFilesystem(cwd);
    if (commonDir === null) return;
    if (lstatSync(join(commonDir, "info", "grafts"), { throwIfNoEntry: false }) === undefined) {
      return;
    }
    throw new ExactGitInputError(
      "ci.input.history-graft-present",
      "ci.input.history-graft-present",
    );
  } catch (error) {
    if (error instanceof ExactGitInputError) throw error;
    throw gitControlUnavailable();
  }
}

export function gitBytes(
  cwd: string,
  args: readonly string[],
  code: ExactGitInputErrorCode,
  maxBuffer: number,
): Buffer {
  assertNoLegacyGrafts(cwd);
  try {
    return execFileSync("git", ["--no-replace-objects", ...args], {
      cwd,
      env: gitEnvironment(),
      maxBuffer,
      timeout: GIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException & { signal?: string };
    const failureCode =
      candidate.code === "ETIMEDOUT"
        ? "ci.classification.execution-timeout"
        : candidate.code === "ENOBUFS"
        ? "ci.classification.change-set-budget"
        : code;
    throw new ExactGitInputError(failureCode, failureCode);
  }
}

export function exactInputGitBytes(
  cwd: string,
  args: readonly string[],
  failureCode: ExactGitInputErrorCode,
  budgetCode: ExactGitInputErrorCode,
  maxBuffer: number,
  timeoutCode: ExactGitInputErrorCode = "ci.input.git-execution-timeout",
): Buffer {
  assertNoLegacyGrafts(cwd);
  try {
    return execFileSync("git", ["--no-replace-objects", ...args], {
      cwd,
      env: gitEnvironment(),
      maxBuffer,
      timeout: GIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException & { signal?: string };
    const code = candidate.code === "ETIMEDOUT"
      ? timeoutCode
      : candidate.code === "ENOBUFS"
      ? budgetCode
      : failureCode;
    throw new ExactGitInputError(code, code);
  }
}

export function requireSha1ObjectFormat(
  cwd: string,
  malformedCode: ExactGitInputErrorCode,
  unavailableCode: ExactGitInputErrorCode,
  budgetCode: ExactGitInputErrorCode,
  timeoutCode: ExactGitInputErrorCode = "ci.input.git-execution-timeout",
): void {
  const format = canonicalAsciiLine(exactInputGitBytes(
    cwd,
    ["rev-parse", "--show-object-format"],
    unavailableCode,
    budgetCode,
    64,
    timeoutCode,
  ), malformedCode);
  if (format !== "sha1") {
    throw new ExactGitInputError(malformedCode, malformedCode);
  }
}

export function canonicalAsciiLine(
  bytes: Buffer,
  malformedCode: ExactGitInputErrorCode,
): string {
  if (bytes.byteLength < 2 || bytes[bytes.byteLength - 1] !== 0x0a) {
    throw new ExactGitInputError(malformedCode, malformedCode);
  }
  const body = bytes.subarray(0, bytes.byteLength - 1);
  if (body.some((byte) => byte < 0x21 || byte > 0x7e)) {
    throw new ExactGitInputError(malformedCode, malformedCode);
  }
  return body.toString("ascii");
}

export function requireFullOid(
  value: unknown,
  code: Extract<
    ExactGitInputErrorCode,
    "ci.input.commit-range-malformed" | "ci.input.blob-set-malformed"
  >,
): string {
  if (typeof value !== "string" || !FULL_OID.test(value)) {
    throw new ExactGitInputError(code, code);
  }
  return value;
}

function requireExactCommit(cwd: string, oid: string): void {
  const type = canonicalAsciiLine(exactInputGitBytes(
    cwd,
    ["cat-file", "-t", "--", oid],
    "ci.input.commit-range-unavailable",
    "ci.input.commit-range-budget",
    64,
  ), "ci.input.commit-range-malformed");
  if (type !== "commit") {
    throw new ExactGitInputError(
      "ci.input.commit-range-malformed",
      "ci.input.commit-range-malformed",
    );
  }
}

function requireAncestor(cwd: string, ancestorOid: string, localOid: string): void {
  const mergeBase = canonicalAsciiLine(exactInputGitBytes(
    cwd,
    ["merge-base", "--all", ancestorOid, localOid],
    "ci.input.commit-range-unavailable",
    "ci.input.commit-range-budget",
    1_024,
  ), "ci.input.commit-range-malformed");
  if (!FULL_OID.test(mergeBase)) {
    throw new ExactGitInputError(
      "ci.input.commit-range-malformed",
      "ci.input.commit-range-malformed",
    );
  }
  if (mergeBase !== ancestorOid) {
    throw new ExactGitInputError(
      "ci.input.commit-range-unavailable",
      "ci.input.commit-range-unavailable",
    );
  }
}

export function parseBoundedInteger(
  bytes: Buffer,
  malformedCode: ExactGitInputErrorCode,
): number {
  const value = canonicalAsciiLine(bytes, malformedCode);
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new ExactGitInputError(malformedCode, malformedCode);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ExactGitInputError(malformedCode, malformedCode);
  }
  return parsed;
}

function validateExactCommitRangeInput(value: unknown): ExactCommitRangeInputV1 {
  try {
    if (
      typeof value !== "object"
      || value === null
      || Array.isArray(value)
      || utilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype
    ) {
      throw new Error();
    }
    const keys = Reflect.ownKeys(value).sort((left, right) =>
      String(left).localeCompare(String(right)));
    if (
      keys.length !== 3
      || keys[0] !== "baseOid"
      || keys[1] !== "localOid"
      || keys[2] !== "remoteOid"
    ) {
      throw new Error();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const base = descriptors.baseOid;
    const remote = descriptors.remoteOid;
    const local = descriptors.localOid;
    if (
      base === undefined || !("value" in base) || !base.enumerable
      || remote === undefined || !("value" in remote) || !remote.enumerable
      || local === undefined || !("value" in local) || !local.enumerable
    ) {
      throw new Error();
    }
    const baseOid = requireFullOid(base.value, "ci.input.commit-range-malformed");
    const remoteOid = remote.value === null
      ? null
      : requireFullOid(remote.value, "ci.input.commit-range-malformed");
    const localOid = requireFullOid(local.value, "ci.input.commit-range-malformed");
    return { baseOid, remoteOid, localOid };
  } catch {
    throw new ExactGitInputError(
      "ci.input.commit-range-malformed",
      "ci.input.commit-range-malformed",
    );
  }
}

function parseCommitRows(bytes: Buffer, expectedCount: number): Map<string, ExactCommitV1> {
  if (bytes.byteLength > MAX_EXACT_COMMIT_RANGE_BYTES) {
    throw new ExactGitInputError(
      "ci.input.commit-range-budget",
      "ci.input.commit-range-budget",
    );
  }
  let parentEdgeCount = 0;
  for (const byte of bytes) {
    if (byte !== 0x20) continue;
    parentEdgeCount += 1;
    if (parentEdgeCount > MAX_EXACT_COMMIT_PARENT_EDGE_COUNT) {
      throw new ExactGitInputError(
        "ci.input.commit-range-budget",
        "ci.input.commit-range-budget",
      );
    }
  }
  if (bytes.some((byte) => byte > 0x7f)) {
    throw new ExactGitInputError(
      "ci.input.commit-range-malformed",
      "ci.input.commit-range-malformed",
    );
  }
  if (expectedCount === 0) {
    if (bytes.byteLength !== 0) {
      throw new ExactGitInputError(
        "ci.input.commit-range-malformed",
        "ci.input.commit-range-malformed",
      );
    }
    return new Map();
  }
  if (bytes.byteLength === 0 || bytes[bytes.byteLength - 1] !== 0x0a) {
    throw new ExactGitInputError(
      "ci.input.commit-range-malformed",
      "ci.input.commit-range-malformed",
    );
  }
  const rows = bytes.subarray(0, bytes.byteLength - 1).toString("ascii").split("\n");
  if (rows.length !== expectedCount || rows.some((row) => row.length === 0)) {
    throw new ExactGitInputError(
      "ci.input.commit-range-malformed",
      "ci.input.commit-range-malformed",
    );
  }

  const commits = new Map<string, ExactCommitV1>();
  for (const row of rows) {
    const fields = row.split(" ");
    if (fields.some((field) => !FULL_OID.test(field))) {
      throw new ExactGitInputError(
        "ci.input.commit-range-malformed",
        "ci.input.commit-range-malformed",
      );
    }
    const [oid, ...parentOids] = fields;
    if (
      !oid
      || parentOids.length === 0
      || new Set(parentOids).size !== parentOids.length
      || commits.has(oid)
    ) {
      throw new ExactGitInputError(
        "ci.input.commit-range-malformed",
        "ci.input.commit-range-malformed",
      );
    }
    commits.set(oid, { oid, parentOids, firstParentOid: parentOids[0]! });
  }
  return commits;
}

function canonicalCommitOrder(commits: Map<string, ExactCommitV1>): ExactCommitV1[] {
  const pendingParents = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const commit of commits.values()) {
    let count = 0;
    for (const parentOid of commit.parentOids) {
      if (!commits.has(parentOid)) continue;
      count += 1;
      const childOids = children.get(parentOid) ?? [];
      childOids.push(commit.oid);
      children.set(parentOid, childOids);
    }
    pendingParents.set(commit.oid, count);
  }

  const ready = [...commits.keys()]
    .filter((oid) => pendingParents.get(oid) === 0)
    .sort();
  const ordered: ExactCommitV1[] = [];
  while (ready.length > 0) {
    const oid = ready.shift()!;
    ordered.push(commits.get(oid)!);
    for (const childOid of children.get(oid) ?? []) {
      const remaining = pendingParents.get(childOid)! - 1;
      pendingParents.set(childOid, remaining);
      if (remaining === 0) {
        ready.push(childOid);
        ready.sort();
      }
    }
  }
  if (ordered.length !== commits.size) {
    throw new ExactGitInputError(
      "ci.input.commit-range-malformed",
      "ci.input.commit-range-malformed",
    );
  }
  return ordered;
}

export function readExactCommitRange(
  cwd: string,
  input: ExactCommitRangeInputV1,
): ExactCommitRangeV1 {
  const validated = validateExactCommitRangeInput(input);
  const { baseOid, remoteOid, localOid } = validated;
  requireSha1ObjectFormat(
    cwd,
    "ci.input.commit-range-malformed",
    "ci.input.commit-range-unavailable",
    "ci.input.commit-range-budget",
  );
  const rangeStartOid = remoteOid ?? baseOid;

  for (const oid of new Set([baseOid, rangeStartOid, localOid])) {
    requireExactCommit(cwd, oid);
  }
  requireAncestor(cwd, baseOid, localOid);
  requireAncestor(cwd, rangeStartOid, localOid);

  const revisionRange = `${rangeStartOid}..${localOid}`;
  const count = parseBoundedInteger(
    exactInputGitBytes(
      cwd,
      ["rev-list", "--count", revisionRange, "--"],
      "ci.input.commit-range-unavailable",
      "ci.input.commit-range-budget",
      64,
    ),
    "ci.input.commit-range-malformed",
  );
  if (count > MAX_EXACT_COMMIT_COUNT) {
    throw new ExactGitInputError(
      "ci.input.commit-range-budget",
      "ci.input.commit-range-budget",
    );
  }
  const rows = exactInputGitBytes(
    cwd,
    ["rev-list", "--parents", revisionRange, "--"],
    "ci.input.commit-range-unavailable",
    "ci.input.commit-range-budget",
    MAX_EXACT_COMMIT_RANGE_BYTES + 1,
  );
  const commits = canonicalCommitOrder(parseCommitRows(rows, count));
  if (
    (count === 0 && localOid !== rangeStartOid)
    || (count > 0 && commits.at(-1)?.oid !== localOid)
  ) {
    throw new ExactGitInputError(
      "ci.input.commit-range-malformed",
      "ci.input.commit-range-malformed",
    );
  }
  return { baseOid, remoteOid, rangeStartOid, localOid, commits };
}

interface CommitMetadataPreflight {
  oid: string;
  byteLength: number;
}

type CommitMetadataErrorCode = Extract<
  ExactGitInputErrorCode,
  `ci.input.commit-metadata-${string}`
>;

function commitMetadataError(code: CommitMetadataErrorCode): ExactGitInputError {
  return new ExactGitInputError(code, code);
}

interface EvidenceGitErrorCodes {
  unavailable: ExactGitInputErrorCode;
  timeout: ExactGitInputErrorCode;
  budget: ExactGitInputErrorCode;
}

const COMMIT_METADATA_GIT_CODES: EvidenceGitErrorCodes = {
  unavailable: "ci.input.commit-metadata-unavailable",
  timeout: "ci.input.commit-metadata-timeout",
  budget: "ci.input.commit-metadata-budget",
};

function boundedEvidenceGitBytes(
  cwd: string,
  args: readonly string[],
  maxBuffer: number,
  codes: EvidenceGitErrorCodes,
  timeout: number = GIT_TIMEOUT_MS,
): Buffer {
  assertNoLegacyGrafts(cwd);
  try {
    return execFileSync("git", ["--no-replace-objects", ...args], {
      cwd,
      env: gitEnvironment(),
      maxBuffer,
      timeout,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException;
    if (candidate.code === "ETIMEDOUT") {
      throw new ExactGitInputError(codes.timeout, codes.timeout);
    }
    if (candidate.code === "ENOBUFS") {
      throw new ExactGitInputError(codes.budget, codes.budget);
    }
    throw new ExactGitInputError(codes.unavailable, codes.unavailable);
  }
}

function boundedEvidenceGitInputBytes(
  cwd: string,
  args: readonly string[],
  input: Buffer,
  maxBuffer: number,
  codes: EvidenceGitErrorCodes,
  timeout: number = GIT_TIMEOUT_MS,
): Buffer {
  assertNoLegacyGrafts(cwd);
  try {
    return execFileSync("git", ["--no-replace-objects", ...args], {
      cwd,
      env: gitEnvironment(),
      input,
      maxBuffer,
      timeout,
      killSignal: "SIGKILL",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException;
    if (candidate.code === "ETIMEDOUT") {
      throw new ExactGitInputError(codes.timeout, codes.timeout);
    }
    if (candidate.code === "ENOBUFS") {
      throw new ExactGitInputError(codes.budget, codes.budget);
    }
    throw new ExactGitInputError(codes.unavailable, codes.unavailable);
  }
}

function metadataAsciiLine(bytes: Buffer): string {
  try {
    return canonicalAsciiLine(bytes, "ci.input.commit-metadata-malformed");
  } catch {
    throw commitMetadataError("ci.input.commit-metadata-malformed");
  }
}

function validateCommitMetadataOids(value: unknown): string[] {
  try {
    if (
      !Array.isArray(value)
      || utilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Array.prototype
    ) {
      throw commitMetadataError("ci.input.commit-metadata-malformed");
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined
      || !("value" in lengthDescriptor)
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
    ) {
      throw commitMetadataError("ci.input.commit-metadata-malformed");
    }
    const length = lengthDescriptor.value as number;
    if (length > MAX_EXACT_COMMIT_COUNT) {
      throw commitMetadataError("ci.input.commit-metadata-budget");
    }
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== length + 1
      || !ownKeys.includes("length")
      || ownKeys.some((key) => typeof key !== "string")
    ) {
      throw commitMetadataError("ci.input.commit-metadata-malformed");
    }
    const oids: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined
        || !("value" in descriptor)
        || descriptor.enumerable !== true
        || typeof descriptor.value !== "string"
        || !FULL_OID.test(descriptor.value)
      ) {
        throw commitMetadataError("ci.input.commit-metadata-malformed");
      }
      if (index > 0 && oids[index - 1]! >= descriptor.value) {
        throw commitMetadataError("ci.input.commit-metadata-malformed");
      }
      oids.push(descriptor.value);
    }
    return oids;
  } catch (error) {
    if (error instanceof ExactGitInputError) throw error;
    throw commitMetadataError("ci.input.commit-metadata-malformed");
  }
}

function requireCommitMetadataSha1(cwd: string): void {
  requireSha1ObjectFormat(
    cwd,
    "ci.input.commit-metadata-malformed",
    COMMIT_METADATA_GIT_CODES.unavailable,
    COMMIT_METADATA_GIT_CODES.budget,
    COMMIT_METADATA_GIT_CODES.timeout,
  );
}

function preflightCommitMetadata(
  cwd: string,
  oids: readonly string[],
): CommitMetadataPreflight[] {
  for (const oid of oids) {
    const type = metadataAsciiLine(boundedEvidenceGitBytes(
      cwd,
      ["cat-file", "-t", "--", oid],
      64,
      COMMIT_METADATA_GIT_CODES,
    ));
    if (type !== "commit") {
      throw commitMetadataError("ci.input.commit-metadata-malformed");
    }
  }

  const preflight: CommitMetadataPreflight[] = [];
  let aggregateBytes = 0;
  for (const oid of oids) {
    let byteLength: number;
    try {
      byteLength = parseBoundedInteger(
        boundedEvidenceGitBytes(
          cwd,
          ["cat-file", "-s", "--", oid],
          64,
          COMMIT_METADATA_GIT_CODES,
        ),
        "ci.input.commit-metadata-malformed",
      );
    } catch (error) {
      if (error instanceof ExactGitInputError && error.code === "ci.input.commit-metadata-malformed") {
        throw error;
      }
      if (error instanceof ExactGitInputError) throw error;
      throw commitMetadataError("ci.input.commit-metadata-malformed");
    }
    if (byteLength > MAX_EXACT_SINGLE_COMMIT_METADATA_BYTES) {
      throw commitMetadataError("ci.input.commit-metadata-budget");
    }
    aggregateBytes += byteLength;
    if (aggregateBytes > MAX_EXACT_AGGREGATE_COMMIT_METADATA_BYTES) {
      throw commitMetadataError("ci.input.commit-metadata-budget");
    }
    preflight.push({ oid, byteLength });
  }
  return preflight;
}

function parseCommitIdentity(value: string): { name: string; email: string } {
  const match = /^([^<>\u0000-\u001f\u007f]{1,1024}) <([^<>\s]{1,320})> [0-9]+ [+-][0-9]{4}$/u.exec(value);
  if (
    match === null
    || Buffer.byteLength(match[1]!, "utf8") > 1_024
    || Buffer.byteLength(match[2]!, "utf8") > 320
  ) {
    throw commitMetadataError("ci.input.commit-metadata-malformed");
  }
  return { name: match[1]!, email: match[2]! };
}

function parseCommitMetadataBody(
  oid: string,
  bytes: Buffer,
): ExactCommitMetadataV1 {
  if (bytes.includes(0)) {
    throw commitMetadataError("ci.input.commit-metadata-malformed");
  }
  let decoded: string;
  try {
    decoded = UTF8.decode(bytes);
  } catch {
    throw commitMetadataError("ci.input.commit-metadata-invalid-utf8");
  }
  const separator = decoded.indexOf("\n\n");
  if (separator < 0) {
    throw commitMetadataError("ci.input.commit-metadata-malformed");
  }
  const headerText = decoded.slice(0, separator);
  if (headerText.includes("\r")) {
    throw commitMetadataError("ci.input.commit-metadata-malformed");
  }
  const headers = headerText.split("\n");
  const tree = /^tree ([0-9a-f]{40})$/.exec(headers[0] ?? "");
  if (tree === null) {
    throw commitMetadataError("ci.input.commit-metadata-malformed");
  }
  let index = 1;
  const parentOids: string[] = [];
  while (index < headers.length) {
    const parent = /^parent ([0-9a-f]{40})$/.exec(headers[index]!);
    if (parent === null) break;
    if (parentOids.includes(parent[1]!)) {
      throw commitMetadataError("ci.input.commit-metadata-malformed");
    }
    parentOids.push(parent[1]!);
    index += 1;
  }
  const authorHeader = headers[index++];
  const committerHeader = headers[index++];
  if (!authorHeader?.startsWith("author ") || !committerHeader?.startsWith("committer ")) {
    throw commitMetadataError("ci.input.commit-metadata-malformed");
  }
  const author = parseCommitIdentity(authorHeader.slice("author ".length));
  parseCommitIdentity(committerHeader.slice("committer ".length));

  let optionalHeaderSeen = false;
  for (; index < headers.length; index += 1) {
    const header = headers[index]!;
    if (header.startsWith(" ")) {
      if (!optionalHeaderSeen) {
        throw commitMetadataError("ci.input.commit-metadata-malformed");
      }
      continue;
    }
    const optional = /^([a-z][a-z0-9-]*) (.+)$/u.exec(header);
    if (
      optional === null
      || new Set(["tree", "parent", "author", "committer", "encoding"]).has(optional[1]!)
    ) {
      throw commitMetadataError("ci.input.commit-metadata-malformed");
    }
    optionalHeaderSeen = true;
  }

  const message = decoded.slice(separator + 2);
  const firstLineEnd = message.indexOf("\n");
  const rawSubject = firstLineEnd < 0 ? message : message.slice(0, firstLineEnd);
  const subject = rawSubject.endsWith("\r") ? rawSubject.slice(0, -1) : rawSubject;
  return {
    oid,
    treeOid: tree[1]!,
    parentOids,
    authorName: author.name,
    authorEmail: author.email,
    subject,
    message,
    byteLength: bytes.byteLength,
    contentSha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

export function readExactCommitMetadata(
  cwd: string,
  commitOids: readonly string[],
): ExactCommitMetadataV1[] {
  const oids = validateCommitMetadataOids(commitOids);
  requireCommitMetadataSha1(cwd);
  const preflight = preflightCommitMetadata(cwd, oids);
  const bodies = new Map<string, Buffer>();
  const metadata: ExactCommitMetadataV1[] = [];
  for (const item of preflight) {
    const bytes = boundedEvidenceGitBytes(
      cwd,
      ["cat-file", "commit", "--", item.oid],
      item.byteLength + 1,
      COMMIT_METADATA_GIT_CODES,
    );
    const identity = createHash("sha1")
      .update(`commit ${item.byteLength}\0`)
      .update(bytes)
      .digest("hex");
    if (bytes.byteLength !== item.byteLength || identity !== item.oid) {
      throw commitMetadataError("ci.input.commit-metadata-identity-mismatch");
    }
    bodies.set(item.oid, bytes);
    metadata.push(parseCommitMetadataBody(item.oid, bytes));
  }
  for (const item of preflight) {
    const reread = boundedEvidenceGitBytes(
      cwd,
      ["cat-file", "commit", "--", item.oid],
      item.byteLength + 1,
      COMMIT_METADATA_GIT_CODES,
    );
    if (!reread.equals(bodies.get(item.oid)!)) {
      throw commitMetadataError("ci.input.commit-metadata-identity-mismatch");
    }
  }
  return metadata;
}

interface ParsedRawTreeEntry {
  mode: ExactTreeModeV1;
  objectType: ExactTreeObjectTypeV1;
  objectOid: string;
}

interface LoadedTree {
  oid: string;
  byteLength: number;
  bytes: Buffer;
  entries: ReadonlyMap<string, ParsedRawTreeEntry> | null;
}

const TREE_GIT_CODES: EvidenceGitErrorCodes = {
  unavailable: "ci.input.tree-entry-unavailable",
  timeout: "ci.input.tree-entry-timeout",
  budget: "ci.input.tree-entry-budget",
};

const RAW_TREE_MODE_TYPES: Readonly<Record<
  string,
  { mode: ExactTreeModeV1; objectType: ExactTreeObjectTypeV1 }
>> = {
  "40000": { mode: "040000", objectType: "tree" },
  "100644": { mode: "100644", objectType: "blob" },
  "100755": { mode: "100755", objectType: "executable" },
  "120000": { mode: "120000", objectType: "symlink" },
  "160000": { mode: "160000", objectType: "gitlink" },
};

const LS_TREE_MODE_TYPES: Readonly<Record<string, string>> = {
  "040000": "tree",
  "100644": "blob",
  "100755": "blob",
  "120000": "blob",
  "160000": "commit",
};

function parseRawTreeMode(
  bytes: Buffer,
  start: number,
  end: number,
): { rawMode: string; mapping: { mode: ExactTreeModeV1; objectType: ExactTreeObjectTypeV1 } } {
  const modeBytes = bytes.subarray(start, end);
  if (
    modeBytes.byteLength === 0
    || modeBytes.some((byte) => byte < 0x30 || byte > 0x39)
  ) {
    throw treeEntryError("ci.input.tree-entry-malformed");
  }
  const rawMode = modeBytes.toString("ascii");
  const mapping = RAW_TREE_MODE_TYPES[rawMode];
  if (mapping === undefined) {
    throw treeEntryError("ci.input.tree-entry-malformed");
  }
  return { rawMode, mapping };
}

function treeEntryError(
  code: Extract<ExactGitInputErrorCode, `ci.input.tree-entry-${string}`>,
): ExactGitInputError {
  return new ExactGitInputError(code, code);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function validateExactTreeLookupInput(value: unknown): ExactTreeLookupInputV1 {
  try {
    if (
      typeof value !== "object"
      || value === null
      || Array.isArray(value)
      || utilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype
    ) {
      throw treeEntryError("ci.input.tree-entry-malformed");
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== 2
      || keys.some((key) => typeof key !== "string")
      || !keys.includes("candidateOid")
      || !keys.includes("paths")
    ) {
      throw treeEntryError("ci.input.tree-entry-malformed");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const candidate = descriptors.candidateOid;
    const pathsDescriptor = descriptors.paths;
    if (
      candidate === undefined || !("value" in candidate) || !candidate.enumerable
      || typeof candidate.value !== "string" || !FULL_OID.test(candidate.value)
      || pathsDescriptor === undefined || !("value" in pathsDescriptor)
      || !pathsDescriptor.enumerable
    ) {
      throw treeEntryError("ci.input.tree-entry-malformed");
    }
    const rawPaths: unknown = pathsDescriptor.value;
    if (
      !Array.isArray(rawPaths)
      || utilTypes.isProxy(rawPaths)
      || Object.getPrototypeOf(rawPaths) !== Array.prototype
    ) {
      throw treeEntryError("ci.input.tree-entry-malformed");
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(rawPaths, "length");
    if (
      lengthDescriptor === undefined
      || !("value" in lengthDescriptor)
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
    ) {
      throw treeEntryError("ci.input.tree-entry-malformed");
    }
    const length = lengthDescriptor.value as number;
    if (length > MAX_EXACT_TREE_ENTRY_PATH_COUNT) {
      throw treeEntryError("ci.input.tree-entry-budget");
    }
    const pathKeys = Reflect.ownKeys(rawPaths);
    if (
      pathKeys.length !== length + 1
      || !pathKeys.includes("length")
      || pathKeys.some((key) => typeof key !== "string")
    ) {
      throw treeEntryError("ci.input.tree-entry-malformed");
    }

    const paths: string[] = [];
    let totalSegments = 0;
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(rawPaths, String(index));
      if (
        descriptor === undefined
        || !("value" in descriptor)
        || !descriptor.enumerable
        || typeof descriptor.value !== "string"
      ) {
        throw treeEntryError("ci.input.tree-entry-malformed");
      }
      const path = descriptor.value;
      const bytes = Buffer.from(path, "utf8");
      if (
        path.length === 0
        || bytes.toString("utf8") !== path
        || path.startsWith("/")
        || path.endsWith("/")
        || path.includes("\\")
        || /[\u0000-\u001f\u007f]/u.test(path)
        || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
      ) {
        throw treeEntryError("ci.input.tree-entry-malformed");
      }
      if (bytes.byteLength > MAX_EXACT_TREE_ENTRY_PATH_BYTES) {
        throw treeEntryError("ci.input.tree-entry-budget");
      }
      totalSegments += path.split("/").length;
      if (totalSegments > MAX_EXACT_TREE_ENTRY_PATH_SEGMENT_COUNT) {
        throw treeEntryError("ci.input.tree-entry-budget");
      }
      if (index > 0 && compareUtf8(paths[index - 1]!, path) >= 0) {
        throw treeEntryError("ci.input.tree-entry-malformed");
      }
      paths.push(path);
    }
    return { candidateOid: candidate.value, paths };
  } catch (error) {
    if (
      error instanceof ExactGitInputError
      && error.code === "ci.input.tree-entry-budget"
    ) {
      throw error;
    }
    throw treeEntryError("ci.input.tree-entry-malformed");
  }
}

function mapTreeCommitError(error: unknown): never {
  if (error instanceof ExactGitInputError) {
    const codeByCommitCode: Partial<Record<ExactGitInputErrorCode, ExactGitInputErrorCode>> = {
      "ci.input.commit-metadata-unavailable": "ci.input.tree-entry-unavailable",
      "ci.input.commit-metadata-timeout": "ci.input.tree-entry-timeout",
      "ci.input.commit-metadata-budget": "ci.input.tree-entry-budget",
      "ci.input.commit-metadata-identity-mismatch": "ci.input.tree-entry-identity-mismatch",
      "ci.input.commit-metadata-malformed": "ci.input.tree-entry-malformed",
      "ci.input.commit-metadata-invalid-utf8": "ci.input.tree-entry-malformed",
    };
    const mapped = codeByCommitCode[error.code];
    if (mapped !== undefined) {
      throw new ExactGitInputError(mapped, mapped);
    }
  }
  throw treeEntryError("ci.input.tree-entry-unavailable");
}

function treeAsciiLine(bytes: Buffer): string {
  try {
    return canonicalAsciiLine(bytes, "ci.input.tree-entry-malformed");
  } catch {
    throw treeEntryError("ci.input.tree-entry-malformed");
  }
}

function compareRawTreeEntryNames(
  left: Buffer,
  leftIsTree: boolean,
  right: Buffer,
  rightIsTree: boolean,
): number {
  const commonLength = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < commonLength; index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  if (left.byteLength === right.byteLength) return 0;
  const leftNext = left.byteLength === commonLength
    ? (leftIsTree ? 0x2f : 0x00)
    : left[commonLength]!;
  const rightNext = right.byteLength === commonLength
    ? (rightIsTree ? 0x2f : 0x00)
    : right[commonLength]!;
  return leftNext - rightNext;
}

function rawTreeEntryCount(bytes: Buffer, remainingCount: number): number {
  let cursor = 0;
  let count = 0;
  let previousName: Buffer | null = null;
  let previousIsTree = false;
  while (cursor < bytes.byteLength) {
    const modeEnd = bytes.indexOf(0x20, cursor);
    if (modeEnd <= cursor) throw treeEntryError("ci.input.tree-entry-malformed");
    const nameEnd = bytes.indexOf(0x00, modeEnd + 1);
    if (nameEnd <= modeEnd + 1 || nameEnd + 21 > bytes.byteLength) {
      throw treeEntryError("ci.input.tree-entry-malformed");
    }
    const { mapping } = parseRawTreeMode(bytes, cursor, modeEnd);
    const name = bytes.subarray(modeEnd + 1, nameEnd);
    if (name.includes(0x2f)) throw treeEntryError("ci.input.tree-entry-malformed");
    if (
      previousName !== null
      && compareRawTreeEntryNames(
        previousName,
        previousIsTree,
        name,
        mapping.objectType === "tree",
      ) >= 0
    ) {
      throw treeEntryError("ci.input.tree-entry-malformed");
    }
    const objectOid = bytes.subarray(nameEnd + 1, nameEnd + 21);
    if (objectOid.every((byte) => byte === 0)) {
      throw treeEntryError("ci.input.tree-entry-malformed");
    }
    previousName = name;
    previousIsTree = mapping.objectType === "tree";
    count += 1;
    if (count > remainingCount) {
      throw treeEntryError("ci.input.tree-entry-budget");
    }
    cursor = nameEnd + 21;
  }
  return count;
}

function parseRawTreeEntries(bytes: Buffer): ReadonlyMap<string, ParsedRawTreeEntry> {
  const entries = new Map<string, ParsedRawTreeEntry>();
  let cursor = 0;
  while (cursor < bytes.byteLength) {
    const modeEnd = bytes.indexOf(0x20, cursor);
    const nameEnd = bytes.indexOf(0x00, modeEnd + 1);
    const { mapping } = parseRawTreeMode(bytes, cursor, modeEnd);
    const nameKey = bytes.subarray(modeEnd + 1, nameEnd).toString("hex");
    if (entries.has(nameKey)) throw treeEntryError("ci.input.tree-entry-malformed");
    entries.set(nameKey, {
      mode: mapping.mode,
      objectType: mapping.objectType,
      objectOid: bytes.subarray(nameEnd + 1, nameEnd + 21).toString("hex"),
    });
    cursor = nameEnd + 21;
  }
  return entries;
}

interface ExactTreeReader {
  loadTree: (oid: string, materializeEntries: boolean) => LoadedTree;
  requireBlobType: (oid: string) => void;
  requireBlobTypes: (oids: readonly string[]) => void;
  rereadBlobTypes: (oids: readonly string[]) => void;
  rereadTrees: () => void;
}

export interface ExactPrimitiveChangeEvidenceV1 {
  changes: ChangeFactV1[];
  lookupBaseEntry: (path: string) => {
    mode: Exclude<ChangeModeV1, "000000">;
    objectType: ChangeObjectTypeV1;
    objectOid: string;
  } | null;
  validateObjectTypes: () => void;
  revalidate: () => void;
}

function createExactTreeReader(cwd: string): ExactTreeReader {
  const trees = new Map<string, LoadedTree>();
  const actualTypes = new Map<string, string>();
  let aggregateTreeBytes = 0;
  let aggregateEntryCount = 0;
  let gitCommandCount = 0;
  const deadline = performance.now() + GIT_TIMEOUT_MS;

  const remainingTimeout = (): number => {
    gitCommandCount += 1;
    if (gitCommandCount > MAX_EXACT_TREE_GIT_COMMAND_COUNT) {
      throw treeEntryError("ci.input.tree-entry-budget");
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw treeEntryError("ci.input.tree-entry-timeout");
    }
    return Math.max(1, Math.floor(remaining));
  };

  const treeGitBytes = (
    args: readonly string[],
    maxBuffer: number,
  ): Buffer => boundedEvidenceGitBytes(
    cwd,
    args,
    maxBuffer,
    TREE_GIT_CODES,
    remainingTimeout(),
  );

  const treeGitInputBytes = (
    args: readonly string[],
    input: Buffer,
    maxBuffer: number,
  ): Buffer => boundedEvidenceGitInputBytes(
    cwd,
    args,
    input,
    maxBuffer,
    TREE_GIT_CODES,
    remainingTimeout(),
  );

  const loadTree = (oid: string, materializeEntries: boolean): LoadedTree => {
    const cached = trees.get(oid);
    if (cached !== undefined) {
      if (materializeEntries && cached.entries === null) {
        cached.entries = parseRawTreeEntries(cached.bytes);
      }
      return cached;
    }
    const type = treeAsciiLine(treeGitBytes(
      ["cat-file", "-t", "--", oid],
      64,
    ));
    if (type !== "tree") throw treeEntryError("ci.input.tree-entry-identity-mismatch");
    let byteLength: number;
    try {
      byteLength = parseBoundedInteger(
        treeGitBytes(
          ["cat-file", "-s", "--", oid],
          64,
        ),
        "ci.input.tree-entry-malformed",
      );
    } catch (error) {
      if (error instanceof ExactGitInputError) throw error;
      throw treeEntryError("ci.input.tree-entry-malformed");
    }
    if (
      byteLength > MAX_EXACT_SINGLE_TREE_BYTES
      || byteLength > MAX_EXACT_AGGREGATE_TREE_BYTES - aggregateTreeBytes
    ) {
      throw treeEntryError("ci.input.tree-entry-budget");
    }
    const bytes = treeGitBytes(
      ["cat-file", "tree", "--", oid],
      Math.max(1_024, byteLength + 1),
    );
    const identity = createHash("sha1")
      .update(`tree ${byteLength}\0`)
      .update(bytes)
      .digest("hex");
    if (bytes.byteLength !== byteLength || identity !== oid) {
      throw treeEntryError("ci.input.tree-entry-identity-mismatch");
    }
    const entryCount = rawTreeEntryCount(
      bytes,
      MAX_EXACT_TREE_ENTRY_COUNT - aggregateEntryCount,
    );
    aggregateTreeBytes += byteLength;
    aggregateEntryCount += entryCount;
    const loaded: LoadedTree = {
      oid,
      byteLength,
      bytes,
      entries: materializeEntries ? parseRawTreeEntries(bytes) : null,
    };
    trees.set(oid, loaded);
    actualTypes.set(oid, "tree");
    return loaded;
  };

  const requireBlobType = (oid: string): void => {
    const cached = actualTypes.get(oid);
    const actual = cached ?? treeAsciiLine(treeGitBytes(
      ["cat-file", "-t", "--", oid],
      64,
    ));
    actualTypes.set(oid, actual);
    if (actual !== "blob") {
      throw treeEntryError("ci.input.tree-entry-identity-mismatch");
    }
  };

  const readObjectTypes = (oids: readonly string[]): ReadonlyMap<string, string> => {
    const exactOids = [...new Set(oids)].sort();
    if (exactOids.length === 0) return new Map();
    const input = Buffer.from(`${exactOids.join("\n")}\n`, "ascii");
    const output = treeGitInputBytes(
      ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
      input,
      Math.max(1_024, exactOids.length * 64 + 1),
    );
    if (
      output.byteLength === 0
      || output[output.byteLength - 1] !== 0x0a
      || output.some((byte) => byte !== 0x0a && (byte < 0x20 || byte > 0x7e))
    ) {
      throw treeEntryError("ci.input.tree-entry-malformed");
    }
    const rows = output.subarray(0, output.byteLength - 1).toString("ascii").split("\n");
    if (rows.length !== exactOids.length) {
      throw treeEntryError("ci.input.tree-entry-identity-mismatch");
    }
    const result = new Map<string, string>();
    for (let index = 0; index < rows.length; index += 1) {
      const expectedOid = exactOids[index]!;
      if (rows[index] === `${expectedOid} missing`) {
        throw treeEntryError("ci.input.tree-entry-unavailable");
      }
      const match = /^([0-9a-f]{40}) (blob|tree|commit|tag)$/u.exec(rows[index]!);
      if (match === null || match[1] !== expectedOid) {
        throw treeEntryError("ci.input.tree-entry-identity-mismatch");
      }
      result.set(match[1], match[2]!);
    }
    return result;
  };

  const requireBlobTypes = (oids: readonly string[]): void => {
    const unknown = [...new Set(oids)].filter((oid) => !actualTypes.has(oid));
    for (const [oid, type] of readObjectTypes(unknown)) {
      actualTypes.set(oid, type);
    }
    for (const oid of oids) {
      if (actualTypes.get(oid) !== "blob") {
        throw treeEntryError("ci.input.tree-entry-identity-mismatch");
      }
    }
  };

  const rereadBlobTypes = (oids: readonly string[]): void => {
    for (const type of readObjectTypes(oids).values()) {
      if (type !== "blob") {
        throw treeEntryError("ci.input.tree-entry-identity-mismatch");
      }
    }
  };

  const rereadTrees = (): void => {
    for (const tree of trees.values()) {
      const reread = treeGitBytes(
        ["cat-file", "tree", "--", tree.oid],
        Math.max(1_024, tree.byteLength + 1),
      );
      if (!reread.equals(tree.bytes)) {
        throw treeEntryError("ci.input.tree-entry-identity-mismatch");
      }
    }
  };

  return {
    loadTree,
    requireBlobType,
    requireBlobTypes,
    rereadBlobTypes,
    rereadTrees,
  };
}

function exactPrimitiveChangePath(
  prefix: Buffer,
  nameKey: string,
  segmentCount: number,
): { bytes: Buffer; path: string; segmentCount: number } {
  const name = Buffer.from(nameKey, "hex");
  const nextSegmentCount = segmentCount + 1;
  const byteLength = prefix.byteLength + (prefix.byteLength === 0 ? 0 : 1)
    + name.byteLength;
  if (
    byteLength > MAX_EXACT_TREE_ENTRY_PATH_BYTES
    || nextSegmentCount > MAX_EXACT_TREE_ENTRY_PATH_SEGMENT_COUNT
  ) {
    throw treeEntryError("ci.input.tree-entry-budget");
  }
  const bytes = prefix.byteLength === 0
    ? name
    : Buffer.concat([prefix, Buffer.from("/"), name], byteLength);
  let path: string;
  try {
    path = UTF8.decode(bytes);
  } catch {
    throw treeEntryError("ci.input.tree-entry-malformed");
  }
  if (
    path.startsWith("/")
    || path.endsWith("/")
    || path.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(path)
    || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw treeEntryError("ci.input.tree-entry-malformed");
  }
  return { bytes, path, segmentCount: nextSegmentCount };
}

function exactLeafType(entry: ParsedRawTreeEntry): ChangeObjectTypeV1 {
  if (entry.objectType === "tree") {
    throw treeEntryError("ci.input.tree-entry-malformed");
  }
  return entry.objectType;
}

export function readExactPrimitiveChangeEvidence(
  cwd: string,
  baseOid: string,
  candidateOid: string,
  primitiveLimit: number,
): ExactPrimitiveChangeEvidenceV1 {
  const commitOids = [...new Set([baseOid, candidateOid])].sort();
  const initialMetadata = readExactCommitMetadata(cwd, commitOids);
  const metadataByOid = new Map(initialMetadata.map((item) => [item.oid, item]));
  const baseMetadata = metadataByOid.get(baseOid);
  const candidateMetadata = metadataByOid.get(candidateOid);
  if (baseMetadata === undefined || candidateMetadata === undefined) {
    throw treeEntryError("ci.input.tree-entry-identity-mismatch");
  }

  const reader = createExactTreeReader(cwd);
  const changes: ChangeFactV1[] = [];
  const requiredBlobOids = new Set<string>();
  let serializedBytes = 0;
  let expandedEntryCount = 0;

  const append = (
    status: Extract<ChangeStatusV1, "added" | "modified" | "deleted">,
    path: string,
    oldEntry: ParsedRawTreeEntry | null,
    newEntry: ParsedRawTreeEntry | null,
  ): void => {
    if (changes.length >= primitiveLimit) {
      throw treeEntryError("ci.input.tree-entry-budget");
    }
    if (oldEntry?.objectType === "tree" || newEntry?.objectType === "tree") {
      throw treeEntryError("ci.input.tree-entry-malformed");
    }
    if (oldEntry !== null && oldEntry.objectType !== "gitlink") {
      requiredBlobOids.add(oldEntry.objectOid);
    }
    if (newEntry !== null && newEntry.objectType !== "gitlink") {
      requiredBlobOids.add(newEntry.objectOid);
    }
    const oldMode = (oldEntry?.mode ?? "000000") as ChangeModeV1;
    const newMode = (newEntry?.mode ?? "000000") as ChangeModeV1;
    const oldObjectOid = oldEntry?.objectOid ?? ZERO_OID;
    const newObjectOid = newEntry?.objectOid ?? ZERO_OID;
    const rawBytes = Buffer.byteLength(
      `:${oldMode} ${newMode} ${oldObjectOid} ${newObjectOid} ${status[0]!.toUpperCase()}\0${path}\0`,
      "utf8",
    );
    serializedBytes += rawBytes;
    if (serializedBytes > MAX_CHANGE_SET_BYTES) {
      throw treeEntryError("ci.input.tree-entry-budget");
    }
    changes.push({
      status,
      path,
      oldPath: null,
      oldMode,
      newMode,
      oldOid: oldObjectOid,
      newOid: newObjectOid,
      oldType: oldEntry === null ? "absent" : exactLeafType(oldEntry),
      newType: newEntry === null ? "absent" : exactLeafType(newEntry),
      similarity: null,
    });
  };

  const walk = (
    oldTreeOid: string | null,
    newTreeOid: string | null,
    prefix: Buffer,
    segmentCount: number,
  ): void => {
    if (oldTreeOid !== null && oldTreeOid === newTreeOid) return;
    const oldEntries = oldTreeOid === null
      ? new Map<string, ParsedRawTreeEntry>()
      : reader.loadTree(oldTreeOid, true).entries!;
    const newEntries = newTreeOid === null
      ? new Map<string, ParsedRawTreeEntry>()
      : reader.loadTree(newTreeOid, true).entries!;
    const names = [...new Set([...oldEntries.keys(), ...newEntries.keys()])]
      .sort((left, right) => Buffer.compare(Buffer.from(left, "hex"), Buffer.from(right, "hex")));

    for (const nameKey of names) {
      expandedEntryCount += 1;
      if (expandedEntryCount > MAX_EXACT_TREE_ENTRY_COUNT) {
        throw treeEntryError("ci.input.tree-entry-budget");
      }
      const oldEntry = oldEntries.get(nameKey) ?? null;
      const newEntry = newEntries.get(nameKey) ?? null;
      const next = exactPrimitiveChangePath(prefix, nameKey, segmentCount);
      if (oldEntry?.objectType === "tree" && newEntry?.objectType === "tree") {
        walk(oldEntry.objectOid, newEntry.objectOid, next.bytes, next.segmentCount);
        continue;
      }
      if (oldEntry?.objectType === "tree") {
        walk(oldEntry.objectOid, null, next.bytes, next.segmentCount);
        if (newEntry !== null) append("added", next.path, null, newEntry);
        continue;
      }
      if (newEntry?.objectType === "tree") {
        if (oldEntry !== null) append("deleted", next.path, oldEntry, null);
        walk(null, newEntry.objectOid, next.bytes, next.segmentCount);
        continue;
      }
      if (oldEntry === null) {
        append("added", next.path, null, newEntry);
      } else if (newEntry === null) {
        append("deleted", next.path, oldEntry, null);
      } else if (
        oldEntry.mode !== newEntry.mode
        || oldEntry.objectOid !== newEntry.objectOid
      ) {
        append("modified", next.path, oldEntry, newEntry);
      }
    }
  };

  walk(baseMetadata.treeOid, candidateMetadata.treeOid, Buffer.alloc(0), 0);

  const lookupBaseEntry = (path: string): {
    mode: Exclude<ChangeModeV1, "000000">;
    objectType: ChangeObjectTypeV1;
    objectOid: string;
  } | null => {
    let treeOid = baseMetadata.treeOid;
    const components = path.split("/");
    for (let index = 0; index < components.length; index += 1) {
      const tree = reader.loadTree(treeOid, true);
      const entry = tree.entries!.get(Buffer.from(components[index]!, "utf8").toString("hex"));
      if (entry === undefined) return null;
      const leaf = index === components.length - 1;
      if (entry.objectType === "tree") {
        if (leaf) return null;
        treeOid = entry.objectOid;
        continue;
      }
      if (!leaf) return null;
      if (entry.objectType !== "gitlink") requiredBlobOids.add(entry.objectOid);
      return {
        mode: entry.mode as Exclude<ChangeModeV1, "000000">,
        objectType: exactLeafType(entry),
        objectOid: entry.objectOid,
      };
    }
    return null;
  };

  const validateObjectTypes = (): void => {
    reader.requireBlobTypes([...requiredBlobOids]);
  };

  const revalidate = (): void => {
    const currentMetadata = readExactCommitMetadata(cwd, commitOids);
    for (const current of currentMetadata) {
      const initial = metadataByOid.get(current.oid);
      if (
        initial === undefined
        || initial.treeOid !== current.treeOid
        || initial.byteLength !== current.byteLength
        || initial.contentSha256 !== current.contentSha256
      ) {
        throw treeEntryError("ci.input.tree-entry-identity-mismatch");
      }
    }
    reader.rereadTrees();
    reader.rereadBlobTypes([...requiredBlobOids]);
  };

  return { changes, lookupBaseEntry, validateObjectTypes, revalidate };
}

function serializeExactRecursiveTreeListing(reader: ExactTreeReader, rootOid: string): Buffer {
  const chunks: Buffer[] = [];
  const pathSeparator = Buffer.from("/");
  const rowTerminator = Buffer.from([0]);
  let outputBytes = 0;
  let expandedEntryCount = 0;

  const visit = (treeOid: string, prefix: Buffer, prefixSegments: number): void => {
    const tree = reader.loadTree(treeOid, true);
    for (const [nameKey, entry] of tree.entries!) {
      expandedEntryCount += 1;
      if (expandedEntryCount > MAX_EXACT_TREE_ENTRY_COUNT) {
        throw treeEntryError("ci.input.tree-entry-budget");
      }
      const name = Buffer.from(nameKey, "hex");
      const pathByteLength = prefix.byteLength + (prefix.byteLength === 0 ? 0 : 1)
        + name.byteLength;
      const segmentCount = prefixSegments + 1;
      if (
        pathByteLength > MAX_EXACT_TREE_ENTRY_PATH_BYTES
        || segmentCount > MAX_EXACT_TREE_ENTRY_PATH_SEGMENT_COUNT
      ) {
        throw treeEntryError("ci.input.tree-entry-budget");
      }
      const path = prefix.byteLength === 0
        ? name
        : Buffer.concat([prefix, pathSeparator, name], pathByteLength);
      if (entry.objectType === "tree") {
        visit(entry.objectOid, path, segmentCount);
        continue;
      }
      const objectType = entry.objectType === "gitlink" ? "commit" : "blob";
      const header = Buffer.from(
        `${entry.mode} ${objectType} ${entry.objectOid}\t`,
        "ascii",
      );
      const rowBytes = header.byteLength + path.byteLength + 1;
      if (rowBytes > MAX_EXACT_AGGREGATE_TREE_BYTES - outputBytes) {
        throw treeEntryError("ci.input.tree-entry-budget");
      }
      chunks.push(header, path, rowTerminator);
      outputBytes += rowBytes;
    }
  };

  visit(rootOid, Buffer.alloc(0), 0);
  return Buffer.concat(chunks, outputBytes);
}

/** Enumerate one exact commit tree through the canonical bounded Git execution boundary. */
export function readExactTreePaths(cwd: string, candidateOid: string): ExactTreePathSetV1 {
  if (typeof candidateOid !== "string" || !FULL_OID.test(candidateOid)) {
    throw treeEntryError("ci.input.tree-entry-malformed");
  }
  let metadata: ExactCommitMetadataV1;
  try {
    metadata = readExactCommitMetadata(cwd, [candidateOid])[0]!;
  } catch (error) {
    mapTreeCommitError(error);
  }
  const bytes = boundedEvidenceGitBytes(
    cwd,
    ["ls-tree", "-rz", "--full-tree", metadata.treeOid],
    MAX_EXACT_AGGREGATE_TREE_BYTES + 1,
    TREE_GIT_CODES,
  );
  const paths = parseExactTreePathListing(bytes);
  const reader = createExactTreeReader(cwd);
  const verifiedListing = serializeExactRecursiveTreeListing(reader, metadata.treeOid);
  reader.rereadTrees();
  if (!bytes.equals(verifiedListing)) {
    throw treeEntryError("ci.input.tree-entry-identity-mismatch");
  }
  return {
    candidateOid,
    treeOid: metadata.treeOid,
    listingDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    paths,
  };
}

export function parseExactTreePathListing(value: Uint8Array): string[] {
  let byteLength: number;
  try {
    if (!utilTypes.isUint8Array(value)) {
      throw treeEntryError("ci.input.tree-entry-malformed");
    }
    byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH, value, []) as number;
  } catch {
    throw treeEntryError("ci.input.tree-entry-malformed");
  }
  if (byteLength > MAX_EXACT_AGGREGATE_TREE_BYTES) {
    throw treeEntryError("ci.input.tree-entry-budget");
  }
  let bytes: Buffer;
  try {
    const buffer = Reflect.apply(TYPED_ARRAY_BUFFER, value, []) as ArrayBufferLike;
    if (utilTypes.isSharedArrayBuffer(buffer)) {
      throw treeEntryError("ci.input.tree-entry-malformed");
    }
    const byteOffset = Reflect.apply(TYPED_ARRAY_BYTE_OFFSET, value, []) as number;
    bytes = Buffer.from(new Uint8Array(buffer, byteOffset, byteLength));
  } catch {
    throw treeEntryError("ci.input.tree-entry-malformed");
  }
  if (bytes.byteLength > 0 && bytes[bytes.byteLength - 1] !== 0) {
    throw treeEntryError("ci.input.tree-entry-malformed");
  }
  const rows = bytes.byteLength === 0
    ? []
    : bytes.subarray(0, bytes.byteLength - 1).toString("binary").split("\0");
  if (rows.length > MAX_EXACT_TREE_ENTRY_COUNT) {
    throw treeEntryError("ci.input.tree-entry-budget");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const paths: string[] = [];
  for (const row of rows) {
    const raw = Buffer.from(row, "binary");
    const tab = raw.indexOf(0x09);
    if (tab <= 0) throw treeEntryError("ci.input.tree-entry-malformed");
    const header = raw.subarray(0, tab).toString("ascii");
    const pathBytes = raw.subarray(tab + 1);
    const match =
      /^(040000|100644|100755|120000|160000) (blob|tree|commit) ([0-9a-f]{40})$/
        .exec(header);
    if (
      match === null
      || LS_TREE_MODE_TYPES[match[1]!] !== match[2]
      || match[3] === ZERO_OID
    ) {
      throw treeEntryError("ci.input.tree-entry-malformed");
    }
    if (pathBytes.byteLength === 0 || pathBytes.byteLength > MAX_EXACT_TREE_ENTRY_PATH_BYTES) {
      throw treeEntryError(pathBytes.byteLength > MAX_EXACT_TREE_ENTRY_PATH_BYTES
        ? "ci.input.tree-entry-budget"
        : "ci.input.tree-entry-malformed");
    }
    let path: string;
    try {
      path = decoder.decode(pathBytes);
    } catch {
      throw treeEntryError("ci.input.tree-entry-malformed");
    }
    if (path.startsWith("/") || path.endsWith("/") || path.includes("\\")
      || /[\u0000-\u001f\u007f]/u.test(path)
      || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw treeEntryError("ci.input.tree-entry-malformed");
    }
    if (paths.length > 0 && compareUtf8(paths.at(-1)!, path) >= 0) {
      throw treeEntryError("ci.input.tree-entry-malformed");
    }
    paths.push(path);
  }
  return paths;
}

export function readExactTreeEntries(
  cwd: string,
  input: ExactTreeLookupInputV1,
): ExactTreeEntrySetV1 {
  const { candidateOid, paths } = validateExactTreeLookupInput(input);
  let metadata: ExactCommitMetadataV1;
  try {
    metadata = readExactCommitMetadata(cwd, [candidateOid])[0]!;
  } catch (error) {
    mapTreeCommitError(error);
  }

  const reader = createExactTreeReader(cwd);
  reader.loadTree(metadata.treeOid, paths.length > 0);
  const entries: ExactTreeEntryV1[] = [];
  for (const path of paths) {
    const components = path.split("/");
    let treeOid = metadata.treeOid;
    let resolved: ExactTreeEntryV1 | null = null;
    for (let index = 0; index < components.length; index += 1) {
      const tree = reader.loadTree(treeOid, true);
      const entry = tree.entries!.get(Buffer.from(components[index]!, "utf8").toString("hex"));
      if (entry === undefined) {
        resolved = { path, presence: "absent", mode: null, objectType: null, objectOid: null };
        break;
      }
      const leaf = index === components.length - 1;
      if (entry.objectType === "tree") {
        reader.loadTree(entry.objectOid, !leaf);
        if (leaf) {
          resolved = {
            path,
            presence: "present",
            mode: entry.mode,
            objectType: entry.objectType,
            objectOid: entry.objectOid,
          };
          break;
        }
        treeOid = entry.objectOid;
        continue;
      }
      if (entry.objectType !== "gitlink") reader.requireBlobType(entry.objectOid);
      resolved = leaf
        ? {
          path,
          presence: "present",
          mode: entry.mode,
          objectType: entry.objectType,
          objectOid: entry.objectOid,
        }
        : { path, presence: "absent", mode: null, objectType: null, objectOid: null };
      break;
    }
    entries.push(resolved!);
  }

  reader.rereadTrees();
  return { candidateOid, treeOid: metadata.treeOid, entries };
}
