import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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

export type ChangeStatusV1 =
  "added" | "modified" | "deleted" | "renamed" | "copied";
export type ChangeModeV1 = "000000" | "100644" | "100755" | "120000" | "160000";
export type ChangeObjectTypeV1 =
  "absent" | "blob" | "executable" | "symlink" | "gitlink";

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

export interface ExactAddedLineInputV1 {
  baseOid: string;
  candidateOid: string;
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

export type ExactGitInputErrorCode =
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

const FULL_OID = /^[0-9a-f]{40}$/;
const ZERO_OID = "0".repeat(40);
const HEADER =
  /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([AMD]|[RC](\d{1,3}))$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const GIT_TIMEOUT_MS = 30_000;
const MODE_TYPES: Readonly<Record<ChangeModeV1, ChangeObjectTypeV1>> = {
  "000000": "absent",
  "100644": "blob",
  "100755": "executable",
  "120000": "symlink",
  "160000": "gitlink",
};

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...cleanGitEnv(),
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

function gitBytes(
  cwd: string,
  args: readonly string[],
  code: ExactGitInputErrorCode,
  maxBuffer: number,
): Buffer {
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
    throw new ExactGitInputError(failureCode, failureCode, { cause: error });
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
    throw new ExactGitInputError(code, code, { cause: error });
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

function commitMetadataGitBytes(
  cwd: string,
  args: readonly string[],
  maxBuffer: number,
): Buffer {
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
      throw commitMetadataError("ci.input.commit-metadata-timeout");
    }
    if (candidate.code === "ENOBUFS") {
      throw commitMetadataError("ci.input.commit-metadata-budget");
    }
    throw commitMetadataError("ci.input.commit-metadata-unavailable");
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
  const format = metadataAsciiLine(commitMetadataGitBytes(
    cwd,
    ["rev-parse", "--show-object-format"],
    64,
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
    const type = metadataAsciiLine(commitMetadataGitBytes(
      cwd,
      ["cat-file", "-t", "--", oid],
      64,
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
        commitMetadataGitBytes(cwd, ["cat-file", "-s", "--", oid], 64),
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
    const bytes = commitMetadataGitBytes(
      cwd,
      ["cat-file", "commit", "--", item.oid],
      item.byteLength + 1,
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
    const reread = commitMetadataGitBytes(
      cwd,
      ["cat-file", "commit", "--", item.oid],
      item.byteLength + 1,
    );
    if (!reread.equals(bodies.get(item.oid)!)) {
      throw commitMetadataError("ci.input.commit-metadata-identity-mismatch");
    }
  }
  return metadata;
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
    if (aggregateBytes > MAX_EXACT_AGGREGATE_BLOB_BYTES) {
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

function requireCommit(
  cwd: string,
  value: string,
  label: "base" | "candidate",
): string {
  if (!FULL_OID.test(value)) {
    throw new ExactGitInputError(
      "ci.input.revision-unavailable",
      `ci.input.revision-unavailable: ${label} must be a full lowercase 40-hex commit OID`,
    );
  }
  const type = gitBytes(
    cwd,
    ["cat-file", "-t", "--", value],
    "ci.input.revision-unavailable",
    1_024,
  )
    .toString("ascii")
    .trim();
  if (type !== "commit") {
    throw new ExactGitInputError(
      "ci.input.revision-unavailable",
      `ci.input.revision-unavailable: ${label} OID is not a commit`,
    );
  }
  return value;
}

function readMergeBase(
  cwd: string,
  baseOid: string,
  candidateOid: string,
): string {
  const output = gitBytes(
    cwd,
    ["merge-base", "--all", baseOid, candidateOid],
    "ci.classification.merge-base-unavailable",
    1_024,
  ).toString("ascii");
  const rows = output.split(/\r?\n/).filter(Boolean);
  if (rows.length !== 1 || !FULL_OID.test(rows[0]!)) {
    throw new ExactGitInputError(
      "ci.classification.merge-base-unavailable",
      "ci.classification.merge-base-unavailable: Git did not produce exactly one full commit OID",
    );
  }
  return rows[0]!;
}

function splitNulFields(bytes: Buffer): Buffer[] {
  if (bytes.byteLength === 0) return [];
  if (bytes[bytes.byteLength - 1] !== 0) {
    throw new ExactGitInputError(
      "ci.classification.change-set-malformed",
      "ci.classification.change-set-malformed: raw diff is not NUL terminated",
    );
  }
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0) continue;
    fields.push(bytes.subarray(start, index));
    start = index + 1;
  }
  return fields;
}

function decodeAscii(field: Buffer, label: string): string {
  if (field.some((byte) => byte > 0x7f)) {
    throw new ExactGitInputError(
      "ci.classification.change-set-malformed",
      `ci.classification.change-set-malformed: ${label} is not ASCII`,
    );
  }
  return field.toString("ascii");
}

function decodePath(field: Buffer): string {
  if (field.byteLength === 0 || field.byteLength > 1_024) {
    throw new ExactGitInputError(
      "ci.classification.change-set-malformed",
      "ci.classification.change-set-malformed: path length is invalid",
    );
  }
  let value: string;
  try {
    value = UTF8.decode(field);
  } catch (error) {
    throw new ExactGitInputError(
      "ci.classification.change-set-malformed",
      "ci.classification.change-set-malformed: path is not valid UTF-8",
      { cause: error },
    );
  }
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new ExactGitInputError(
      "ci.classification.change-set-malformed",
      "ci.classification.change-set-malformed: path is not a canonical safe repository path",
    );
  }
  return value;
}

function mode(value: string): ChangeModeV1 {
  if (!Object.hasOwn(MODE_TYPES, value)) {
    throw new ExactGitInputError(
      "ci.classification.change-set-malformed",
      "ci.classification.change-set-malformed: raw diff contains an unsupported mode",
    );
  }
  return value as ChangeModeV1;
}

function validateModeOidPair(changeMode: ChangeModeV1, oid: string): void {
  if ((changeMode === "000000") !== (oid === ZERO_OID)) {
    throw new ExactGitInputError(
      "ci.classification.change-set-malformed",
      "ci.classification.change-set-malformed: mode and object identity disagree",
    );
  }
}

function compareFacts(left: ChangeFactV1, right: ChangeFactV1): number {
  const leftKey = `${left.path}\0${left.oldPath ?? ""}\0${left.status}\0${left.oldMode}\0${left.newMode}\0${left.oldOid}\0${left.newOid}`;
  const rightKey = `${right.path}\0${right.oldPath ?? ""}\0${right.status}\0${right.oldMode}\0${right.newMode}\0${right.oldOid}\0${right.newOid}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function parseChangeFacts(bytes: Buffer): ChangeFactV1[] {
  if (bytes.byteLength > MAX_CHANGE_SET_BYTES) {
    throw new ExactGitInputError(
      "ci.classification.change-set-budget",
      "ci.classification.change-set-budget: raw diff exceeds the byte budget",
    );
  }
  const fields = splitNulFields(bytes);
  const facts: ChangeFactV1[] = [];

  for (let index = 0; index < fields.length;) {
    if (facts.length >= MAX_CHANGE_FACT_COUNT) {
      throw new ExactGitInputError(
        "ci.classification.change-set-budget",
        "ci.classification.change-set-budget: raw diff exceeds the fact-count budget",
      );
    }
    const header = decodeAscii(fields[index++]!, "raw diff header");
    const match = HEADER.exec(header);
    if (!match) {
      throw new ExactGitInputError(
        "ci.classification.change-set-malformed",
        "ci.classification.change-set-malformed: raw diff header is invalid",
      );
    }
    const oldMode = mode(match[1]!);
    const newMode = mode(match[2]!);
    const oldOid = match[3]!;
    const newOid = match[4]!;
    const rawStatus = match[5]!;
    validateModeOidPair(oldMode, oldOid);
    validateModeOidPair(newMode, newOid);

    const statusCode = rawStatus[0]!;
    const statusByCode: Readonly<Record<string, ChangeStatusV1>> = {
      A: "added",
      M: "modified",
      D: "deleted",
      R: "renamed",
      C: "copied",
    };
    const status = statusByCode[statusCode]!;
    const hasTwoPaths = status === "renamed" || status === "copied";
    const firstPath = fields[index++];
    const secondPath = hasTwoPaths ? fields[index++] : undefined;
    if (!firstPath || (hasTwoPaths && !secondPath)) {
      throw new ExactGitInputError(
        "ci.classification.change-set-malformed",
        "ci.classification.change-set-malformed: raw diff path fields are incomplete",
      );
    }
    const decodedFirst = decodePath(firstPath);
    const oldPath = hasTwoPaths ? decodedFirst : null;
    const path = hasTwoPaths ? decodePath(secondPath!) : decodedFirst;
    const similarity = hasTwoPaths ? Number(rawStatus.slice(1)) : null;
    if (
      similarity !== null &&
      (!Number.isSafeInteger(similarity) || similarity < 0 || similarity > 100)
    ) {
      throw new ExactGitInputError(
        "ci.classification.change-set-malformed",
        "ci.classification.change-set-malformed: rename or copy similarity is invalid",
      );
    }

    if (
      (status === "added" && (oldMode !== "000000" || newMode === "000000")) ||
      (status === "deleted" &&
        (oldMode === "000000" || newMode !== "000000")) ||
      ((status === "modified" || hasTwoPaths) &&
        (oldMode === "000000" || newMode === "000000"))
    ) {
      throw new ExactGitInputError(
        "ci.classification.change-set-malformed",
        "ci.classification.change-set-malformed: status and modes disagree",
      );
    }

    facts.push({
      status,
      path,
      oldPath,
      oldMode,
      newMode,
      oldOid,
      newOid,
      oldType: MODE_TYPES[oldMode],
      newType: MODE_TYPES[newMode],
      similarity,
    });
  }

  return facts.sort(compareFacts);
}

export function readExactChangeFacts(
  cwd: string,
  baseOid: string,
  candidateOid: string,
): ChangeFactV1[] {
  const exactBase = requireCommit(cwd, baseOid, "base");
  const exactCandidate = requireCommit(cwd, candidateOid, "candidate");
  readMergeBase(cwd, exactBase, exactCandidate);
  const preflight = gitBytes(
    cwd,
    [
      "diff-tree",
      "--raw",
      "-z",
      "--no-commit-id",
      "-r",
      "--abbrev=40",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=none",
      exactBase,
      exactCandidate,
      "--",
    ],
    "ci.classification.change-set-malformed",
    MAX_CHANGE_SET_BYTES + 1,
  );
  let nulCount = 0;
  for (const byte of preflight) if (byte === 0) nulCount += 1;
  if (nulCount % 2 !== 0 || nulCount / 2 > MAX_CHANGE_FACT_COUNT) {
    throw new ExactGitInputError(
      "ci.classification.change-set-budget",
      "ci.classification.change-set-budget: preflight change count is invalid or over budget",
    );
  }
  const bytes = gitBytes(
    cwd,
    [
      "-c",
      `diff.renameLimit=${MAX_CHANGE_FACT_COUNT}`,
      "diff-tree",
      "--raw",
      "-z",
      "--no-commit-id",
      "-r",
      "--abbrev=40",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=none",
      "--find-renames",
      "--find-copies",
      "--find-copies-harder",
      exactBase,
      exactCandidate,
      "--",
    ],
    "ci.classification.change-set-malformed",
    MAX_CHANGE_SET_BYTES + 1,
  );
  return parseChangeFacts(bytes);
}

interface ExactTextLine {
  raw: string;
  text: string;
  terminated: boolean;
}

function addedLinesError(
  code: Extract<ExactGitInputErrorCode, `ci.input.added-lines.${string}`>,
): ExactGitInputError {
  return new ExactGitInputError(code, code);
}

function validateExactAddedLineInput(value: unknown): ExactAddedLineInputV1 {
  try {
    if (
      typeof value !== "object"
      || value === null
      || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
    ) {
      throw addedLinesError("ci.input.added-lines.input-malformed");
    }
    const keys = Reflect.ownKeys(value).sort((left, right) =>
      String(left).localeCompare(String(right)));
    if (
      keys.length !== 2
      || keys[0] !== "baseOid"
      || keys[1] !== "candidateOid"
    ) {
      throw addedLinesError("ci.input.added-lines.input-malformed");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const base = descriptors.baseOid;
    const candidate = descriptors.candidateOid;
    if (
      base === undefined || !("value" in base) || !base.enumerable
      || candidate === undefined || !("value" in candidate) || !candidate.enumerable
      || typeof base.value !== "string" || !FULL_OID.test(base.value)
      || typeof candidate.value !== "string" || !FULL_OID.test(candidate.value)
    ) {
      throw addedLinesError("ci.input.added-lines.input-malformed");
    }
    return { baseOid: base.value, candidateOid: candidate.value };
  } catch {
    throw addedLinesError("ci.input.added-lines.input-malformed");
  }
}

function mapAddedLineInputError(error: unknown): never {
  if (error instanceof ExactGitInputError) {
    if (
      error.code === "ci.input.git-execution-timeout"
    ) {
      throw addedLinesError("ci.input.added-lines.timeout");
    }
    if (
      error.code === "ci.input.blob-set-budget"
      || error.code === "ci.classification.change-set-budget"
    ) {
      throw addedLinesError("ci.input.added-lines.budget");
    }
    if (error.code === "ci.input.blob-identity-mismatch") {
      throw addedLinesError("ci.input.added-lines.identity-mismatch");
    }
  }
  throw addedLinesError("ci.input.added-lines.unavailable");
}

function addedLineGitBytes(
  cwd: string,
  args: readonly string[],
  maxBuffer: number,
): Buffer {
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
    if (candidate.code === "ETIMEDOUT") {
      throw addedLinesError("ci.input.added-lines.timeout");
    }
    if (candidate.code === "ENOBUFS") {
      throw addedLinesError("ci.input.added-lines.budget");
    }
    throw addedLinesError("ci.input.added-lines.unavailable");
  }
}

interface ExactTextPreflight {
  decoded: string;
  lineCount: number;
  textBytes: number;
}

function preflightExactTextBlob(blob: ExactBlobV1): ExactTextPreflight {
  if (blob.bytes.includes(0)) {
    throw addedLinesError("ci.input.added-lines.binary");
  }
  let decoded: string;
  try {
    decoded = UTF8.decode(blob.bytes);
  } catch {
    throw addedLinesError("ci.input.added-lines.invalid-utf8");
  }
  let lineCount = 0;
  let strippedCrBytes = 0;
  for (let index = 0; index < blob.bytes.byteLength; index += 1) {
    if (blob.bytes[index] !== 0x0a) continue;
    lineCount += 1;
    if (index > 0 && blob.bytes[index - 1] === 0x0d) strippedCrBytes += 1;
  }
  if (blob.bytes.byteLength > 0 && blob.bytes[blob.bytes.byteLength - 1] !== 0x0a) {
    lineCount += 1;
  }
  return {
    decoded,
    lineCount,
    textBytes: blob.bytes.byteLength - (lineCount - (
      blob.bytes.byteLength > 0 && blob.bytes[blob.bytes.byteLength - 1] !== 0x0a ? 1 : 0
    )) - strippedCrBytes,
  };
}

function exactTextLines(preflight: ExactTextPreflight): ExactTextLine[] {
  const { decoded } = preflight;
  if (decoded.length === 0) return [];
  const rawLines = decoded.split("\n");
  const hasTerminalLf = decoded.endsWith("\n");
  if (hasTerminalLf) rawLines.pop();
  return rawLines.map((raw, index) => {
    const terminated = index < rawLines.length - 1 || hasTerminalLf;
    return {
      raw,
      text: terminated && raw.endsWith("\r") ? raw.slice(0, -1) : raw,
      terminated,
    };
  });
}

function sameTextLine(
  left: ExactTextLine | undefined,
  right: ExactTextLine | undefined,
): boolean {
  return left !== undefined
    && right !== undefined
    && left.raw === right.raw
    && left.terminated === right.terminated;
}

function requirePatchLine(
  actual: ExactTextLine | undefined,
  content: string,
  terminated: boolean,
): void {
  if (
    actual === undefined
    || actual.raw !== content
    || actual.terminated !== terminated
  ) {
    throw addedLinesError("ci.input.added-lines.patch-malformed");
  }
}

function parseAddedLinesPatch(
  patchBytes: Buffer,
  oldOid: string,
  newOid: string,
  path: string,
  oldLines: readonly ExactTextLine[],
  newLines: readonly ExactTextLine[],
  remainingLineCount: number,
  remainingTextBytes: number,
  remainingPatchBytes: number,
): ExactAddedLineV1[] {
  if (
    patchBytes.byteLength === 0
    || patchBytes.byteLength > MAX_EXACT_ADDED_LINE_PATCH_BYTES
    || patchBytes.byteLength > remainingPatchBytes
    || patchBytes[patchBytes.byteLength - 1] !== 0x0a
    || patchBytes.includes(0)
  ) {
    throw addedLinesError(
      patchBytes.byteLength > MAX_EXACT_ADDED_LINE_PATCH_BYTES
        || patchBytes.byteLength > remainingPatchBytes
        ? "ci.input.added-lines.budget"
        : "ci.input.added-lines.patch-malformed",
    );
  }
  let patchRowCount = 0;
  for (const byte of patchBytes) if (byte === 0x0a) patchRowCount += 1;
  if (patchRowCount > MAX_EXACT_ADDED_LINE_PATCH_ROW_COUNT) {
    throw addedLinesError("ci.input.added-lines.budget");
  }
  let decoded: string;
  try {
    decoded = UTF8.decode(patchBytes);
  } catch {
    throw addedLinesError("ci.input.added-lines.patch-malformed");
  }
  const rows = decoded.split("\n");
  rows.pop();
  if (
    rows.length < 5
    || rows[0] !== `diff --git ${oldOid} ${newOid}`
    || rows[1] !== `index ${oldOid}..${newOid} 100644`
    || rows[2] !== `--- ${oldOid}`
    || rows[3] !== `+++ ${newOid}`
  ) {
    throw addedLinesError("ci.input.added-lines.patch-malformed");
  }

  const added: ExactAddedLineV1[] = [];
  let rowIndex = 4;
  let oldCursor = 0;
  let newCursor = 0;
  let sawHunk = false;
  let addedTextBytes = 0;
  while (rowIndex < rows.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(
      rows[rowIndex++]!,
    );
    if (!header) {
      throw addedLinesError("ci.input.added-lines.patch-malformed");
    }
    sawHunk = true;
    const oldStart = Number(header[1]);
    const oldCount = header[2] === undefined ? 1 : Number(header[2]);
    const newStart = Number(header[3]);
    const newCount = header[4] === undefined ? 1 : Number(header[4]);
    if (
      !Number.isSafeInteger(oldStart) || !Number.isSafeInteger(oldCount)
      || !Number.isSafeInteger(newStart) || !Number.isSafeInteger(newCount)
    ) {
      throw addedLinesError("ci.input.added-lines.patch-malformed");
    }
    const oldTarget = oldCount === 0 ? oldStart : oldStart - 1;
    const newTarget = newCount === 0 ? newStart : newStart - 1;
    if (
      oldTarget < oldCursor || newTarget < newCursor
      || oldTarget > oldLines.length || newTarget > newLines.length
      || oldTarget - oldCursor !== newTarget - newCursor
    ) {
      throw addedLinesError("ci.input.added-lines.patch-malformed");
    }
    while (oldCursor < oldTarget) {
      if (!sameTextLine(oldLines[oldCursor]!, newLines[newCursor]!)) {
        throw addedLinesError("ci.input.added-lines.patch-malformed");
      }
      oldCursor += 1;
      newCursor += 1;
    }

    let consumedOld = 0;
    let consumedNew = 0;
    while (consumedOld < oldCount || consumedNew < newCount) {
      const row = rows[rowIndex++];
      if (row === undefined || row.length === 0) {
        throw addedLinesError("ci.input.added-lines.patch-malformed");
      }
      const prefix = row[0]!;
      if (prefix !== "-" && prefix !== "+" && prefix !== " ") {
        throw addedLinesError("ci.input.added-lines.patch-malformed");
      }
      const content = row.slice(1);
      const noFinalLf = rows[rowIndex] === "\\ No newline at end of file";
      if (noFinalLf) rowIndex += 1;
      const terminated = !noFinalLf;
      if (prefix === "-") {
        requirePatchLine(oldLines[oldCursor], content, terminated);
        oldCursor += 1;
        consumedOld += 1;
      } else if (prefix === "+") {
        requirePatchLine(newLines[newCursor], content, terminated);
        const textBytes = Buffer.byteLength(newLines[newCursor]!.text, "utf8");
        if (
          added.length >= remainingLineCount
          || addedTextBytes + textBytes > remainingTextBytes
        ) {
          throw addedLinesError("ci.input.added-lines.budget");
        }
        addedTextBytes += textBytes;
        added.push({
          path,
          newBlobOid: newOid,
          newLineNumber: newCursor + 1,
          text: newLines[newCursor]!.text,
        });
        newCursor += 1;
        consumedNew += 1;
      } else {
        requirePatchLine(oldLines[oldCursor], content, terminated);
        requirePatchLine(newLines[newCursor], content, terminated);
        oldCursor += 1;
        newCursor += 1;
        consumedOld += 1;
        consumedNew += 1;
      }
      if (consumedOld > oldCount || consumedNew > newCount) {
        throw addedLinesError("ci.input.added-lines.patch-malformed");
      }
    }
  }
  if (!sawHunk) {
    throw addedLinesError("ci.input.added-lines.patch-malformed");
  }
  while (oldCursor < oldLines.length) {
    if (!sameTextLine(oldLines[oldCursor]!, newLines[newCursor]!)) {
      throw addedLinesError("ci.input.added-lines.patch-malformed");
    }
    oldCursor += 1;
    newCursor += 1;
  }
  if (newCursor !== newLines.length) {
    throw addedLinesError("ci.input.added-lines.patch-malformed");
  }
  return added;
}

function requireBlobSetUnchanged(
  before: ReadonlyMap<string, ExactBlobV1>,
  after: readonly ExactBlobV1[],
): void {
  if (before.size !== after.length) {
    throw addedLinesError("ci.input.added-lines.identity-mismatch");
  }
  for (const blob of after) {
    const original = before.get(blob.oid);
    if (
      original === undefined
      || original.byteLength !== blob.byteLength
      || original.contentSha256 !== blob.contentSha256
      || !Buffer.from(original.bytes).equals(Buffer.from(blob.bytes))
    ) {
      throw addedLinesError("ci.input.added-lines.identity-mismatch");
    }
  }
}

export function readExactAddedLines(
  cwd: string,
  input: ExactAddedLineInputV1,
): ExactAddedLineSetV1 {
  const { baseOid, candidateOid } = validateExactAddedLineInput(input);
  let facts: ChangeFactV1[];
  try {
    facts = readExactChangeFacts(cwd, baseOid, candidateOid);
  } catch (error) {
    mapAddedLineInputError(error);
  }
  if (facts.length > MAX_EXACT_ADDED_LINE_CHANGE_COUNT) {
    throw addedLinesError("ci.input.added-lines.budget");
  }
  if (facts.some((fact) => fact.oldType === "gitlink" || fact.newType === "gitlink")) {
    throw addedLinesError("ci.input.added-lines.gitlink");
  }

  const objectOids = [...new Set(facts.flatMap((fact) => {
    if (fact.status === "deleted" || fact.oldOid === fact.newOid) return [];
    if (fact.status === "added") return [fact.newOid];
    return [fact.oldOid, fact.newOid];
  }))].sort();
  let exactBlobs: ExactBlobV1[];
  try {
    exactBlobs = readExactBlobs(cwd, objectOids);
  } catch (error) {
    mapAddedLineInputError(error);
  }
  const blobs = new Map(exactBlobs.map((blob) => [blob.oid, blob]));
  const preflightByOid = new Map<string, ExactTextPreflight>();
  let physicalLineCount = 0;
  for (const blob of exactBlobs) {
    const preflight = preflightExactTextBlob(blob);
    physicalLineCount += preflight.lineCount;
    if (physicalLineCount > MAX_EXACT_ADDED_LINE_SOURCE_LINE_COUNT) {
      throw addedLinesError("ci.input.added-lines.budget");
    }
    preflightByOid.set(blob.oid, preflight);
  }
  const linesByOid = new Map<string, ExactTextLine[]>();
  for (const blob of exactBlobs) {
    linesByOid.set(blob.oid, exactTextLines(preflightByOid.get(blob.oid)!));
  }

  const patchCache = new Map<string, ExactAddedLineV1[]>();
  const result: ExactChangeWithAddedLinesV1[] = [];
  let patchBytesTotal = 0;
  let addedLineCount = 0;
  let addedLineBytes = 0;
  for (const fact of facts) {
    let addedLines: ExactAddedLineV1[];
    if (fact.newOid === ZERO_OID || fact.oldOid === fact.newOid) {
      addedLines = [];
    } else if (fact.oldOid === ZERO_OID) {
      const newPreflight = preflightByOid.get(fact.newOid)!;
      if (
        newPreflight.lineCount > MAX_EXACT_ADDED_LINE_COUNT - addedLineCount
        || newPreflight.textBytes > MAX_EXACT_ADDED_LINE_BYTES - addedLineBytes
      ) {
        throw addedLinesError("ci.input.added-lines.budget");
      }
      addedLines = (linesByOid.get(fact.newOid) ?? []).map((line, index) => ({
        path: fact.path,
        newBlobOid: fact.newOid,
        newLineNumber: index + 1,
        text: line.text,
      }));
    } else {
      const cacheKey = `${fact.oldOid}:${fact.newOid}`;
      const cached = patchCache.get(cacheKey);
      if (cached === undefined) {
        const remainingPatchBytes = MAX_EXACT_ADDED_LINE_PATCH_TOTAL_BYTES
          - patchBytesTotal;
        const patch = addedLineGitBytes(cwd, [
          "-c",
          "diff.algorithm=myers",
          "diff",
          "--patch",
          "--unified=0",
          "--no-indent-heuristic",
          "--text",
          "--full-index",
          "--no-prefix",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          fact.oldOid,
          fact.newOid,
          "--",
        ], Math.min(
          MAX_EXACT_ADDED_LINE_PATCH_BYTES + 1,
          remainingPatchBytes + 1,
        ));
        const parsed = parseAddedLinesPatch(
          patch,
          fact.oldOid,
          fact.newOid,
          fact.path,
          linesByOid.get(fact.oldOid) ?? [],
          linesByOid.get(fact.newOid) ?? [],
          MAX_EXACT_ADDED_LINE_COUNT - addedLineCount,
          MAX_EXACT_ADDED_LINE_BYTES - addedLineBytes,
          remainingPatchBytes,
        );
        patchBytesTotal += patch.byteLength;
        patchCache.set(cacheKey, parsed.map((line) => ({ ...line, path: "" })));
        addedLines = parsed;
      } else {
        let cachedTextBytes = 0;
        for (const line of cached) {
          cachedTextBytes += Buffer.byteLength(line.text, "utf8");
        }
        if (
          cached.length > MAX_EXACT_ADDED_LINE_COUNT - addedLineCount
          || cachedTextBytes > MAX_EXACT_ADDED_LINE_BYTES - addedLineBytes
        ) {
          throw addedLinesError("ci.input.added-lines.budget");
        }
        addedLines = cached.map((line) => ({ ...line, path: fact.path }));
      }
    }
    for (const line of addedLines) {
      addedLineCount += 1;
      addedLineBytes += Buffer.byteLength(line.text, "utf8");
      if (
        addedLineCount > MAX_EXACT_ADDED_LINE_COUNT
        || addedLineBytes > MAX_EXACT_ADDED_LINE_BYTES
      ) {
        throw addedLinesError("ci.input.added-lines.budget");
      }
    }
    result.push({ ...fact, addedLines });
  }

  let reread: ExactBlobV1[];
  try {
    reread = readExactBlobs(cwd, objectOids);
  } catch (error) {
    mapAddedLineInputError(error);
  }
  requireBlobSetUnchanged(blobs, reread);
  return { baseOid, candidateOid, changes: result };
}
