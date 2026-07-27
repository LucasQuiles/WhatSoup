import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import {
  ExactGitInputError,
  MAX_EXACT_AGGREGATE_BLOB_BYTES,
  MAX_EXACT_BLOB_COUNT,
  MAX_EXACT_SINGLE_BLOB_BYTES,
  canonicalAsciiLine,
  exactInputGitBytes,
  parseBoundedInteger,
  requireFullOid,
  requireSha1ObjectFormat,
} from "./git-input-core.ts";
import type { ExactBlobV1 } from "./git-input-core.ts";

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
