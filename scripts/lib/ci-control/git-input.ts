import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import { cleanGitEnv } from "../../../src/lib/git-env.ts";

export const MAX_CHANGE_SET_BYTES = 16 * 1024 * 1024;
export const MAX_CHANGE_FACT_COUNT = 50_000;
export const MAX_EXACT_COMMIT_COUNT = 4_096;
export const MAX_EXACT_COMMIT_RANGE_BYTES = 1 * 1_024 * 1_024;
export const MAX_EXACT_BLOB_COUNT = 50_000;
export const MAX_EXACT_SINGLE_BLOB_BYTES = 4 * 1_024 * 1_024;
export const MAX_EXACT_AGGREGATE_BLOB_BYTES = 16 * 1_024 * 1_024;

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

export interface ExactBlobV1 {
  oid: string;
  byteLength: number;
  contentSha256: `sha256:${string}`;
  bytes: Uint8Array;
}

export type ExactGitInputErrorCode =
  | "ci.input.revision-unavailable"
  | "ci.input.commit-range-unavailable"
  | "ci.input.commit-range-malformed"
  | "ci.input.commit-range-budget"
  | "ci.input.blob-set-malformed"
  | "ci.input.blob-set-budget"
  | "ci.input.blob-unavailable"
  | "ci.input.blob-type-unsupported"
  | "ci.input.blob-identity-mismatch"
  | "ci.input.git-execution-timeout"
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
    if (!oid || parentOids.length === 0 || commits.has(oid)) {
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
