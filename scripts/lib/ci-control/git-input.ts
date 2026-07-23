import { execFileSync } from "node:child_process";
import { types as utilTypes } from "node:util";

import {
  ExactGitInputError,
  FULL_OID,
  GIT_TIMEOUT_MS,
  HEADER,
  MAX_CHANGE_FACT_COUNT,
  MAX_CHANGE_SET_BYTES,
  MAX_EXACT_ADDED_LINE_BUDGET_V1,
  MAX_EXACT_ADDED_LINE_PATCH_BYTES,
  MAX_EXACT_ADDED_LINE_PATCH_ROW_COUNT,
  MODE_TYPES,
  UTF8,
  ZERO_OID,
  gitBytes,
  gitEnvironment,
  readExactBlobsWithinAggregateBudget,
} from "./git-input-core.ts";
import type {
  ChangeFactV1,
  ChangeModeV1,
  ChangeStatusV1,
  ExactAddedLineBudgetAccountingV1,
  ExactAddedLineBudgetV1,
  ExactAddedLineInputV1,
  ExactAddedLineSetV1,
  ExactAddedLineV1,
  ExactBlobV1,
  ExactBudgetedAddedLineInputV1,
  ExactBudgetedAddedLineSetV1,
  ExactChangeWithAddedLinesV1,
  ExactGitInputErrorCode,
} from "./git-input-core.ts";

export {
  ExactGitInputError,
  MAX_CHANGE_SET_BYTES,
  MAX_CHANGE_FACT_COUNT,
  MAX_EXACT_COMMIT_COUNT,
  MAX_EXACT_COMMIT_PARENT_EDGE_COUNT,
  MAX_EXACT_COMMIT_RANGE_BYTES,
  MAX_EXACT_SINGLE_COMMIT_METADATA_BYTES,
  MAX_EXACT_AGGREGATE_COMMIT_METADATA_BYTES,
  MAX_EXACT_BLOB_COUNT,
  MAX_EXACT_SINGLE_BLOB_BYTES,
  MAX_EXACT_AGGREGATE_BLOB_BYTES,
  MAX_EXACT_ADDED_LINE_CHANGE_COUNT,
  MAX_EXACT_ADDED_LINE_COUNT,
  MAX_EXACT_ADDED_LINE_SOURCE_LINE_COUNT,
  MAX_EXACT_ADDED_LINE_PATCH_BYTES,
  MAX_EXACT_ADDED_LINE_PATCH_ROW_COUNT,
  MAX_EXACT_ADDED_LINE_PATCH_TOTAL_BYTES,
  MAX_EXACT_ADDED_LINE_BYTES,
  MAX_EXACT_ADDED_LINE_BUDGET_V1,
  MAX_EXACT_TREE_ENTRY_PATH_COUNT,
  MAX_EXACT_TREE_ENTRY_PATH_BYTES,
  MAX_EXACT_TREE_ENTRY_PATH_SEGMENT_COUNT,
  MAX_EXACT_SINGLE_TREE_BYTES,
  MAX_EXACT_AGGREGATE_TREE_BYTES,
  MAX_EXACT_TREE_ENTRY_COUNT,
  readExactCommitRange,
  readExactCommitMetadata,
  readExactTreeEntries,
  readExactTreePaths,
  parseExactTreePathListing,
  readExactBlobs,
} from "./git-input-core.ts";
export type {
  ChangeStatusV1,
  ChangeModeV1,
  ChangeObjectTypeV1,
  ExactTreeModeV1,
  ExactTreeObjectTypeV1,
  ChangeFactV1,
  ExactCommitRangeInputV1,
  ExactCommitV1,
  ExactCommitRangeV1,
  ExactCommitMetadataV1,
  ExactBlobV1,
  ExactTreeLookupInputV1,
  ExactTreeEntryV1,
  ExactTreeEntrySetV1,
  ExactTreePathSetV1,
  ExactAddedLineInputV1,
  ExactAddedLineBudgetV1,
  ExactAddedLineBudgetAccountingV1,
  ExactBudgetedAddedLineInputV1,
  ExactAddedLineV1,
  ExactChangeWithAddedLinesV1,
  ExactAddedLineSetV1,
  ExactBudgetedAddedLineSetV1,
  ExactGitInputErrorCode,
} from "./git-input-core.ts";

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

function parseChangeFacts(
  bytes: Buffer,
  maxFactCount = MAX_CHANGE_FACT_COUNT,
): ChangeFactV1[] {
  if (bytes.byteLength > MAX_CHANGE_SET_BYTES) {
    throw new ExactGitInputError(
      "ci.classification.change-set-budget",
      "ci.classification.change-set-budget: raw diff exceeds the byte budget",
    );
  }
  const fields = splitNulFields(bytes);
  const facts: ChangeFactV1[] = [];

  for (let index = 0; index < fields.length;) {
    if (facts.length >= maxFactCount) {
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
  return readExactChangeFactsWithinLimit(
    cwd,
    baseOid,
    candidateOid,
    MAX_CHANGE_FACT_COUNT,
  );
}

function readExactChangeFactsWithinLimit(
  cwd: string,
  baseOid: string,
  candidateOid: string,
  maxFactCount: number,
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
  const preflightFactLimit = maxFactCount > Math.floor(MAX_CHANGE_FACT_COUNT / 2)
    ? MAX_CHANGE_FACT_COUNT
    : Math.min(MAX_CHANGE_FACT_COUNT, maxFactCount * 2);
  if (nulCount % 2 !== 0 || nulCount / 2 > preflightFactLimit) {
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
  return parseChangeFacts(bytes, maxFactCount);
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

const EXACT_ADDED_LINE_BUDGET_KEYS = [
  "changeCount",
  "sourceBlobBytes",
  "sourceLineCount",
  "patchBytes",
  "addedLineCount",
  "addedTextBytes",
] as const satisfies readonly (keyof ExactAddedLineBudgetV1)[];

function validateExactAddedLineBudget(value: unknown): ExactAddedLineBudgetV1 {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || utilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw addedLinesError("ci.input.added-lines.input-malformed");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== EXACT_ADDED_LINE_BUDGET_KEYS.length
    || keys.some((key) => typeof key !== "string")
    || EXACT_ADDED_LINE_BUDGET_KEYS.some((key) => !keys.includes(key))
  ) {
    throw addedLinesError("ci.input.added-lines.input-malformed");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const budget = {} as ExactAddedLineBudgetV1;
  for (const key of EXACT_ADDED_LINE_BUDGET_KEYS) {
    const descriptor = descriptors[key];
    const maximum = MAX_EXACT_ADDED_LINE_BUDGET_V1[key];
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable
      || typeof descriptor.value !== "number"
      || !Number.isSafeInteger(descriptor.value)
      || Object.is(descriptor.value, -0)
      || descriptor.value < 0
      || descriptor.value > maximum
    ) {
      throw addedLinesError("ci.input.added-lines.input-malformed");
    }
    budget[key] = descriptor.value;
  }
  return budget;
}

function validateExactBudgetedAddedLineInput(
  value: unknown,
): ExactBudgetedAddedLineInputV1 {
  try {
    if (
      typeof value !== "object"
      || value === null
      || Array.isArray(value)
      || utilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype
    ) {
      throw addedLinesError("ci.input.added-lines.input-malformed");
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== 3
      || keys.some((key) => typeof key !== "string")
      || !keys.includes("baseOid")
      || !keys.includes("candidateOid")
      || !keys.includes("budget")
    ) {
      throw addedLinesError("ci.input.added-lines.input-malformed");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const base = descriptors.baseOid;
    const candidate = descriptors.candidateOid;
    const budget = descriptors.budget;
    if (
      base === undefined || !("value" in base) || !base.enumerable
      || candidate === undefined || !("value" in candidate) || !candidate.enumerable
      || budget === undefined || !("value" in budget) || !budget.enumerable
      || typeof base.value !== "string" || !FULL_OID.test(base.value)
      || typeof candidate.value !== "string" || !FULL_OID.test(candidate.value)
    ) {
      throw addedLinesError("ci.input.added-lines.input-malformed");
    }
    return {
      baseOid: base.value,
      candidateOid: candidate.value,
      budget: validateExactAddedLineBudget(budget.value),
    };
  } catch {
    throw addedLinesError("ci.input.added-lines.input-malformed");
  }
}

function copyExactAddedLineBudget(
  value: ExactAddedLineBudgetV1,
): ExactAddedLineBudgetV1 {
  return {
    changeCount: value.changeCount,
    sourceBlobBytes: value.sourceBlobBytes,
    sourceLineCount: value.sourceLineCount,
    patchBytes: value.patchBytes,
    addedLineCount: value.addedLineCount,
    addedTextBytes: value.addedTextBytes,
  };
}

function freezeExactAddedLineBudget(
  value: ExactAddedLineBudgetV1,
): ExactAddedLineBudgetV1 {
  return Object.freeze(copyExactAddedLineBudget(value));
}

function exactAddedLineBudgetAccounting(
  limit: ExactAddedLineBudgetV1,
  consumed: ExactAddedLineBudgetV1,
): ExactAddedLineBudgetAccountingV1 {
  const remaining = {} as ExactAddedLineBudgetV1;
  for (const key of EXACT_ADDED_LINE_BUDGET_KEYS) {
    remaining[key] = limit[key] - consumed[key];
  }
  return Object.freeze({
    limit: freezeExactAddedLineBudget(limit),
    consumed: freezeExactAddedLineBudget(consumed),
    remaining: freezeExactAddedLineBudget(remaining),
  });
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

function mapAddedLineTerminalError(error: unknown): never {
  if (error instanceof ExactGitInputError) {
    if (error.code === "ci.input.git-execution-timeout") {
      throw addedLinesError("ci.input.added-lines.timeout");
    }
    if (error.code === "ci.input.blob-unavailable") {
      throw addedLinesError("ci.input.added-lines.unavailable");
    }
    if (
      error.code === "ci.input.blob-set-malformed"
      || error.code === "ci.input.blob-set-budget"
      || error.code === "ci.input.blob-type-unsupported"
      || error.code === "ci.input.blob-identity-mismatch"
    ) {
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

function readExactAddedLinesCore(
  cwd: string,
  baseOid: string,
  candidateOid: string,
  budget: ExactAddedLineBudgetV1,
): ExactBudgetedAddedLineSetV1 {
  let facts: ChangeFactV1[];
  try {
    facts = readExactChangeFactsWithinLimit(
      cwd,
      baseOid,
      candidateOid,
      budget.changeCount,
    );
  } catch (error) {
    mapAddedLineInputError(error);
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
    exactBlobs = readExactBlobsWithinAggregateBudget(
      cwd,
      objectOids,
      budget.sourceBlobBytes,
    );
  } catch (error) {
    mapAddedLineInputError(error);
  }
  const blobs = new Map(exactBlobs.map((blob) => [blob.oid, blob]));
  const preflightByOid = new Map<string, ExactTextPreflight>();
  let physicalLineCount = 0;
  for (const blob of exactBlobs) {
    const preflight = preflightExactTextBlob(blob);
    physicalLineCount += preflight.lineCount;
    if (physicalLineCount > budget.sourceLineCount) {
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
        newPreflight.lineCount > budget.addedLineCount - addedLineCount
        || newPreflight.textBytes > budget.addedTextBytes - addedLineBytes
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
        const remainingPatchBytes = budget.patchBytes
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
          budget.addedLineCount - addedLineCount,
          budget.addedTextBytes - addedLineBytes,
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
          cached.length > budget.addedLineCount - addedLineCount
          || cachedTextBytes > budget.addedTextBytes - addedLineBytes
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
        addedLineCount > budget.addedLineCount
        || addedLineBytes > budget.addedTextBytes
      ) {
        throw addedLinesError("ci.input.added-lines.budget");
      }
    }
    result.push({ ...fact, addedLines });
  }

  let reread: ExactBlobV1[];
  try {
    reread = readExactBlobsWithinAggregateBudget(
      cwd,
      objectOids,
      budget.sourceBlobBytes,
    );
  } catch (error) {
    mapAddedLineTerminalError(error);
  }
  requireBlobSetUnchanged(blobs, reread);
  const consumed: ExactAddedLineBudgetV1 = {
    changeCount: facts.length,
    sourceBlobBytes: exactBlobs.reduce((total, blob) => total + blob.byteLength, 0),
    sourceLineCount: physicalLineCount,
    patchBytes: patchBytesTotal,
    addedLineCount,
    addedTextBytes: addedLineBytes,
  };
  return {
    baseOid,
    candidateOid,
    changes: result,
    accounting: exactAddedLineBudgetAccounting(budget, consumed),
  };
}

export function readExactAddedLinesWithinBudget(
  cwd: string,
  input: ExactBudgetedAddedLineInputV1,
): ExactBudgetedAddedLineSetV1 {
  const { baseOid, candidateOid, budget } = validateExactBudgetedAddedLineInput(input);
  return readExactAddedLinesCore(cwd, baseOid, candidateOid, budget);
}

export function readExactAddedLines(
  cwd: string,
  input: ExactAddedLineInputV1,
): ExactAddedLineSetV1 {
  const { baseOid, candidateOid } = validateExactAddedLineInput(input);
  const result = readExactAddedLinesCore(
    cwd,
    baseOid,
    candidateOid,
    MAX_EXACT_ADDED_LINE_BUDGET_V1,
  );
  return { baseOid, candidateOid, changes: result.changes };
}
