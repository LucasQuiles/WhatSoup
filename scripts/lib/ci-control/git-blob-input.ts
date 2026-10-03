import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import {
  ExactGitInputError,
  MAX_EXACT_AGGREGATE_BLOB_BYTES,
  MAX_EXACT_BLOB_COUNT,
  MAX_EXACT_SINGLE_BLOB_BYTES,
  readObjectBatch,
  requireFullOid,
  requireSha1ObjectFormat,
} from "./git-input-core.ts";
import type { EvidenceGitErrorCodes, ExactBlobV1 } from "./git-input-core.ts";

const UINT8_ARRAY_FROM = Uint8Array.from.bind(Uint8Array);

const BLOB_GIT_CODES: EvidenceGitErrorCodes = {
  unavailable: "ci.input.blob-unavailable",
  timeout: "ci.input.git-execution-timeout",
  budget: "ci.input.blob-set-budget",
};

interface BlobPreflight {
  oid: string;
  byteLength: number;
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
  let validatedOids: string[];
  try {
    if (
      !Array.isArray(objectOids)
      || utilTypes.isProxy(objectOids)
      || Object.getPrototypeOf(objectOids) !== Array.prototype
    ) {
      throw new Error();
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(objectOids, "length");
    if (
      lengthDescriptor === undefined
      || !("value" in lengthDescriptor)
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
    ) {
      throw new Error();
    }
    const length = lengthDescriptor.value as number;
    if (length > MAX_EXACT_BLOB_COUNT) {
      throw new ExactGitInputError(
        "ci.input.blob-set-budget",
        "ci.input.blob-set-budget",
      );
    }
    const keys = Reflect.ownKeys(objectOids);
    if (
      keys.length !== length + 1
      || !keys.includes("length")
      || keys.some((key) => typeof key !== "string")
    ) {
      throw new Error();
    }
    validatedOids = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(objectOids, String(index));
      if (
        descriptor === undefined
        || !("value" in descriptor)
        || !descriptor.enumerable
      ) {
        throw new Error();
      }
      validatedOids.push(requireFullOid(
        descriptor.value,
        "ci.input.blob-set-malformed",
      ));
    }
  } catch (error) {
    if (
      error instanceof ExactGitInputError
      && error.code === "ci.input.blob-set-budget"
    ) {
      throw error;
    }
    throw new ExactGitInputError(
      "ci.input.blob-set-malformed",
      "ci.input.blob-set-malformed",
    );
  }
  requireSha1ObjectFormat(
    cwd,
    "ci.input.blob-set-malformed",
    "ci.input.blob-unavailable",
    "ci.input.blob-set-budget",
  );
  const oids = [...new Set(validatedOids)].sort();

  // One check batch, then one content batch. The rows keep the per-object order
  // of checks: missing, then type, then the single and aggregate budgets.
  const checks = readObjectBatch(
    cwd,
    oids,
    "check",
    BLOB_GIT_CODES,
    "ci.input.blob-set-malformed",
    oids.length * 128 + 1_024,
  );
  const preflight: BlobPreflight[] = [];
  let aggregateBytes = 0;
  for (const row of checks) {
    if (row.kind === "missing") {
      throw new ExactGitInputError(
        "ci.input.blob-unavailable",
        "ci.input.blob-unavailable",
      );
    }
    if (row.type !== "blob") {
      throw new ExactGitInputError(
        "ci.input.blob-type-unsupported",
        "ci.input.blob-type-unsupported",
      );
    }
    if (row.size > MAX_EXACT_SINGLE_BLOB_BYTES) {
      throw new ExactGitInputError(
        "ci.input.blob-set-budget",
        "ci.input.blob-set-budget",
      );
    }
    aggregateBytes += row.size;
    if (aggregateBytes > aggregateByteLimit) {
      throw new ExactGitInputError(
        "ci.input.blob-set-budget",
        "ci.input.blob-set-budget",
      );
    }
    preflight.push({ oid: row.oid, byteLength: row.size });
  }

  const contents = readObjectBatch(
    cwd,
    oids,
    "content",
    BLOB_GIT_CODES,
    "ci.input.blob-set-malformed",
    aggregateBytes + oids.length * 128 + 1_024,
  );
  const blobs: ExactBlobV1[] = [];
  for (const [index, blob] of preflight.entries()) {
    const row = contents[index]!;
    // `cat-file blob` failed on a missing object or another type; so does this.
    if (row.kind === "missing" || row.type !== "blob" || row.bytes === null) {
      throw new ExactGitInputError(
        "ci.input.blob-unavailable",
        "ci.input.blob-unavailable",
      );
    }
    const content = row.bytes;
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
      bytes: UINT8_ARRAY_FROM(content),
    });
  }
  return blobs;
}
