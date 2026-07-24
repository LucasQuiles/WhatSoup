import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { TextDecoder, types as utilTypes } from "node:util";

import { cleanGitEnv } from "../../../src/lib/git-env.ts";

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

export type ChangeStatusV1 =
  "added" | "modified" | "deleted" | "renamed" | "copied";
export type ChangeModeV1 = "000000" | "100644" | "100755" | "120000" | "160000";
export type ChangeObjectTypeV1 =
  "absent" | "blob" | "executable" | "symlink" | "gitlink";
export type ExactTreeModeV1 = Exclude<ChangeModeV1, "000000"> | "040000";
export type ExactTreeObjectTypeV1 = Exclude<ChangeObjectTypeV1, "absent"> | "tree";

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
      candidate.code === "ETIMEDOUT" || candidate.signal === "SIGKILL"
        ? "ci.classification.execution-timeout"
        : candidate.code === "ENOBUFS"
        ? "ci.classification.change-set-budget"
        : code;
    throw new ExactGitInputError(failureCode, failureCode);
  }
}

function exactInputGitBytes(
  cwd: string,
  args: readonly string[],
  failureCode: ExactGitInputErrorCode,
  budgetCode: Extract<
    ExactGitInputErrorCode,
    "ci.input.commit-range-budget" | "ci.input.blob-set-budget"
  >,
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
    const code = candidate.code === "ETIMEDOUT"
      ? "ci.input.git-execution-timeout"
      : candidate.code === "ENOBUFS"
      ? budgetCode
      : failureCode;
    throw new ExactGitInputError(code, code);
  }
}

function requireSha1ObjectFormat(
  cwd: string,
  malformedCode: Extract<
    ExactGitInputErrorCode,
    "ci.input.commit-range-malformed" | "ci.input.blob-set-malformed"
  >,
  unavailableCode: Extract<
    ExactGitInputErrorCode,
    "ci.input.commit-range-unavailable" | "ci.input.blob-unavailable"
  >,
  budgetCode: Extract<
    ExactGitInputErrorCode,
    "ci.input.commit-range-budget" | "ci.input.blob-set-budget"
  >,
): void {
  const format = canonicalAsciiLine(exactInputGitBytes(
    cwd,
    ["rev-parse", "--show-object-format"],
    unavailableCode,
    budgetCode,
    64,
  ), malformedCode);
  if (format !== "sha1") {
    throw new ExactGitInputError(malformedCode, malformedCode);
  }
}

function canonicalAsciiLine(
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

function requireFullOid(
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

function parseBoundedInteger(
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
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new ExactGitInputError(
      "ci.input.commit-range-malformed",
      "ci.input.commit-range-malformed",
    );
  }
  const keys = Reflect.ownKeys(value).sort((left, right) =>
    String(left).localeCompare(String(right)));
  if (
    keys.length !== 3
    || keys[0] !== "baseOid"
    || keys[1] !== "localOid"
    || keys[2] !== "remoteOid"
  ) {
    throw new ExactGitInputError(
      "ci.input.commit-range-malformed",
      "ci.input.commit-range-malformed",
    );
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
    throw new ExactGitInputError(
      "ci.input.commit-range-malformed",
      "ci.input.commit-range-malformed",
    );
  }
  const baseOid = requireFullOid(base.value, "ci.input.commit-range-malformed");
  const remoteOid = remote.value === null
    ? null
    : requireFullOid(remote.value, "ci.input.commit-range-malformed");
  const localOid = requireFullOid(local.value, "ci.input.commit-range-malformed");
  return { baseOid, remoteOid, localOid };
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
  const format = metadataAsciiLine(boundedEvidenceGitBytes(
    cwd,
    ["rev-parse", "--show-object-format"],
    64,
    COMMIT_METADATA_GIT_CODES,
  ));
  if (format !== "sha1") {
    throw commitMetadataError("ci.input.commit-metadata-malformed");
  }
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

function rawTreeEntryCount(bytes: Buffer, remainingCount: number): number {
  let cursor = 0;
  let count = 0;
  while (cursor < bytes.byteLength) {
    const modeEnd = bytes.indexOf(0x20, cursor);
    if (modeEnd <= cursor) throw treeEntryError("ci.input.tree-entry-malformed");
    const nameEnd = bytes.indexOf(0x00, modeEnd + 1);
    if (nameEnd <= modeEnd + 1 || nameEnd + 21 > bytes.byteLength) {
      throw treeEntryError("ci.input.tree-entry-malformed");
    }
    const rawMode = bytes.subarray(cursor, modeEnd).toString("ascii");
    if (!Object.hasOwn(RAW_TREE_MODE_TYPES, rawMode)) {
      throw treeEntryError("ci.input.tree-entry-malformed");
    }
    const name = bytes.subarray(modeEnd + 1, nameEnd);
    if (name.includes(0x2f)) throw treeEntryError("ci.input.tree-entry-malformed");
    const objectOid = bytes.subarray(nameEnd + 1, nameEnd + 21);
    if (objectOid.every((byte) => byte === 0)) {
      throw treeEntryError("ci.input.tree-entry-malformed");
    }
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
    const rawMode = bytes.subarray(cursor, modeEnd).toString("ascii");
    const mapping = RAW_TREE_MODE_TYPES[rawMode]!;
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

/** Enumerate one exact commit tree through the canonical bounded Git execution boundary. */
export function readExactTreePaths(cwd: string, candidateOid: string): ExactTreePathSetV1 {
  if (!FULL_OID.test(candidateOid)) throw treeEntryError("ci.input.tree-entry-malformed");
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
  return {
    candidateOid,
    treeOid: metadata.treeOid,
    listingDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    paths,
  };
}

export function parseExactTreePathListing(value: Uint8Array): string[] {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value);
  } catch {
    throw treeEntryError("ci.input.tree-entry-malformed");
  }
  if (bytes.byteLength > MAX_EXACT_AGGREGATE_TREE_BYTES) {
    throw treeEntryError("ci.input.tree-entry-budget");
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
    if (!/^(?:040000|100644|100755|120000|160000) (?:blob|tree|commit) [0-9a-f]{40}$/.test(header)) {
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

  const trees = new Map<string, LoadedTree>();
  const actualTypes = new Map<string, string>();
  let aggregateTreeBytes = 0;
  let aggregateEntryCount = 0;

  const loadTree = (oid: string, materializeEntries: boolean): LoadedTree => {
    const cached = trees.get(oid);
    if (cached !== undefined) {
      if (materializeEntries && cached.entries === null) {
        cached.entries = parseRawTreeEntries(cached.bytes);
      }
      return cached;
    }
    const type = treeAsciiLine(boundedEvidenceGitBytes(
      cwd,
      ["cat-file", "-t", "--", oid],
      64,
      TREE_GIT_CODES,
    ));
    if (type !== "tree") throw treeEntryError("ci.input.tree-entry-identity-mismatch");
    let byteLength: number;
    try {
      byteLength = parseBoundedInteger(
        boundedEvidenceGitBytes(
          cwd,
          ["cat-file", "-s", "--", oid],
          64,
          TREE_GIT_CODES,
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
    const bytes = boundedEvidenceGitBytes(
      cwd,
      ["cat-file", "tree", "--", oid],
      Math.max(1_024, byteLength + 1),
      TREE_GIT_CODES,
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
    const actual = cached ?? treeAsciiLine(boundedEvidenceGitBytes(
      cwd,
      ["cat-file", "-t", "--", oid],
      64,
      TREE_GIT_CODES,
    ));
    actualTypes.set(oid, actual);
    if (actual !== "blob") {
      throw treeEntryError("ci.input.tree-entry-identity-mismatch");
    }
  };

  loadTree(metadata.treeOid, paths.length > 0);
  const entries: ExactTreeEntryV1[] = [];
  for (const path of paths) {
    const components = path.split("/");
    let treeOid = metadata.treeOid;
    let resolved: ExactTreeEntryV1 | null = null;
    for (let index = 0; index < components.length; index += 1) {
      const tree = loadTree(treeOid, true);
      const entry = tree.entries!.get(Buffer.from(components[index]!, "utf8").toString("hex"));
      if (entry === undefined) {
        resolved = { path, presence: "absent", mode: null, objectType: null, objectOid: null };
        break;
      }
      const leaf = index === components.length - 1;
      if (entry.objectType === "tree") {
        loadTree(entry.objectOid, !leaf);
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
      if (entry.objectType !== "gitlink") requireBlobType(entry.objectOid);
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

  for (const tree of trees.values()) {
    const reread = boundedEvidenceGitBytes(
      cwd,
      ["cat-file", "tree", "--", tree.oid],
      Math.max(1_024, tree.byteLength + 1),
      TREE_GIT_CODES,
    );
    if (!reread.equals(tree.bytes)) {
      throw treeEntryError("ci.input.tree-entry-identity-mismatch");
    }
  }
  return { candidateOid, treeOid: metadata.treeOid, entries };
}

interface BlobPreflight {
  oid: string;
  byteLength: number;
}

function preflightBlob(cwd: string, oid: string): BlobPreflight {
  const type = canonicalAsciiLine(exactInputGitBytes(
    cwd,
    ["cat-file", "-t", "--", oid],
    "ci.input.blob-unavailable",
    "ci.input.blob-set-budget",
    64,
  ), "ci.input.blob-set-malformed");
  if (type !== "blob") {
    throw new ExactGitInputError(
      "ci.input.blob-type-unsupported",
      "ci.input.blob-type-unsupported",
    );
  }
  const byteLength = parseBoundedInteger(
    exactInputGitBytes(
      cwd,
      ["cat-file", "-s", "--", oid],
      "ci.input.blob-unavailable",
      "ci.input.blob-set-budget",
      64,
    ),
    "ci.input.blob-set-malformed",
  );
  if (byteLength > MAX_EXACT_SINGLE_BLOB_BYTES) {
    throw new ExactGitInputError(
      "ci.input.blob-set-budget",
      "ci.input.blob-set-budget",
    );
  }
  return { oid, byteLength };
}

export function readExactBlobs(
  cwd: string,
  objectOids: readonly string[],
): ExactBlobV1[] {
  return readExactBlobsWithinAggregateBudget(
    cwd,
    objectOids,
    MAX_EXACT_AGGREGATE_BLOB_BYTES,
  );
}

export function readExactBlobsWithinAggregateBudget(
  cwd: string,
  objectOids: readonly string[],
  aggregateByteLimit: number,
): ExactBlobV1[] {
  if (!Array.isArray(objectOids)) {
    throw new ExactGitInputError(
      "ci.input.blob-set-malformed",
      "ci.input.blob-set-malformed",
    );
  }
  if (objectOids.length > MAX_EXACT_BLOB_COUNT) {
    throw new ExactGitInputError(
      "ci.input.blob-set-budget",
      "ci.input.blob-set-budget",
    );
  }
  const validatedOids: string[] = [];
  for (let index = 0; index < objectOids.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(objectOids, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new ExactGitInputError(
        "ci.input.blob-set-malformed",
        "ci.input.blob-set-malformed",
      );
    }
    validatedOids.push(requireFullOid(
      descriptor.value,
      "ci.input.blob-set-malformed",
    ));
  }
  requireSha1ObjectFormat(
    cwd,
    "ci.input.blob-set-malformed",
    "ci.input.blob-unavailable",
    "ci.input.blob-set-budget",
  );
  const oids = [...new Set(validatedOids)].sort();

  const preflight: BlobPreflight[] = [];
  let aggregateBytes = 0;
  for (const oid of oids) {
    const blob = preflightBlob(cwd, oid);
    aggregateBytes += blob.byteLength;
    if (aggregateBytes > aggregateByteLimit) {
      throw new ExactGitInputError(
        "ci.input.blob-set-budget",
        "ci.input.blob-set-budget",
      );
    }
    preflight.push(blob);
  }

  const blobs: ExactBlobV1[] = [];
  for (const blob of preflight) {
    const content = exactInputGitBytes(
      cwd,
      ["cat-file", "blob", "--", blob.oid],
      "ci.input.blob-unavailable",
      "ci.input.blob-set-budget",
      Math.max(1_024, blob.byteLength + 1),
    );
    const identity = createHash("sha1")
      .update(`blob ${blob.byteLength}\0`)
      .update(content)
      .digest("hex");
    if (content.byteLength !== blob.byteLength || identity !== blob.oid) {
      throw new ExactGitInputError(
        "ci.input.blob-identity-mismatch",
        "ci.input.blob-identity-mismatch",
      );
    }
    blobs.push({
      oid: blob.oid,
      byteLength: blob.byteLength,
      contentSha256: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      bytes: Uint8Array.from(content),
    });
  }
  return blobs;
}
