import { execFileSync } from "node:child_process";
import { TextDecoder } from "node:util";

import { cleanGitEnv } from "../../../src/lib/git-env.ts";

export const MAX_CHANGE_SET_BYTES = 16 * 1024 * 1024;
export const MAX_CHANGE_FACT_COUNT = 50_000;

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

export type ExactGitInputErrorCode =
  | "ci.input.revision-unavailable"
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
