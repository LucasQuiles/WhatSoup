import { z } from "zod";

import type { RegistryCapture } from "./github.ts";
import { sha256 } from "./model.ts";
import type {
  RegistryReviewBatch,
  RetainedIssueState,
  RetainedOverlapState,
  ReviewedIssueRepin,
  ReviewedIssueRemoval,
} from "./reconcile.ts";

const repositoryPathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !/[\u0000-\u001f\u007f]/.test(value) &&
      value
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    "path must be a safe repository-relative POSIX path",
  );
const reviewRecordPathSchema = repositoryPathSchema.refine(
  (value) =>
    /^docs\/triage\/reviews\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[1-9]\d*\.json$/.test(
      value,
    ),
  "record path must be an issue JSON file in one canonical review directory",
);
const positiveIntegerSchema = z.number().int().positive();
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const timestampSchema = z.string().datetime({ offset: false });
const issueUrlSchema = z
  .string()
  .url()
  .refine(
    (value) =>
      /^https:\/\/github\.com\/LucasQuiles\/WhatSoup\/issues\/[1-9]\d*$/.test(
        value,
      ),
    "URL must identify an issue in LucasQuiles/WhatSoup",
  );

const recordFileSchema = z
  .object({
    issue_number: positiveIntegerSchema,
    path: reviewRecordPathSchema,
    sha256: sha256Schema,
  })
  .strict();
const removalSchema: z.ZodType<ReviewedIssueRemoval> = z
  .object({
    issue_number: positiveIntegerSchema,
    issue_node_id: z.string().min(1).max(1_024),
    url: issueUrlSchema,
    updated_at: timestampSchema,
    pre_review_body_sha256: sha256Schema,
    state: z.literal("closed"),
  })
  .strict();
const retainedIssueStateShape = {
  issue_number: positiveIntegerSchema,
  issue_node_id: z.string().min(1).max(1_024),
  title: z.string().min(1).max(16_384),
  url: issueUrlSchema,
  updated_at: timestampSchema,
  pre_review_body_sha256: sha256Schema,
  current_labels: z.array(z.string().min(1).max(1_024)).max(10_000),
};
const retainedIssueStateSchema: z.ZodType<RetainedIssueState> = z
  .object(retainedIssueStateShape)
  .strict();
const retainedIssueStateV2Schema = z
  .object({
    ...retainedIssueStateShape,
    recommended_labels: z.array(z.string().min(1).max(1_024)).max(10_000),
  })
  .strict();
const repinSchema: z.ZodType<ReviewedIssueRepin> = z
  .object({
    issue_number: positiveIntegerSchema,
    source_record_sha256: sha256Schema,
  })
  .strict();
const overlapSchema = z
  .object({
    number: positiveIntegerSchema,
    title: z.string().min(1).max(16_384),
    url: z.string().url(),
    updated_at: timestampSchema,
    disposition: z.enum(["open", "merged", "closed-unmerged"]),
    is_draft: z.boolean(),
    head_ref: z.string().min(1).max(255).nullable(),
    base_ref: z.string().min(1).max(255).nullable(),
    matched_by: z
      .array(
        z.enum([
          "issue-reference",
          "closing-reference",
          "touched-path",
          "acceptance-criteria",
        ]),
      )
      .min(1)
      .max(4),
    overlapping_paths: z.array(repositoryPathSchema).max(100_000),
    assessment: z.enum([
      "owns",
      "partial",
      "collision-only",
      "historical-attempt",
    ]),
  })
  .strict();
const retainedOverlapStateSchema: z.ZodType<RetainedOverlapState> = z
  .object({
    issue_number: positiveIntegerSchema,
    pull_request_number: positiveIntegerSchema,
    overlap: overlapSchema.nullable(),
  })
  .strict();

const manifestV1Schema = z
  .object({
    schema_version: z.literal(1),
    repository: z.literal("LucasQuiles/WhatSoup"),
    pinned_main_revision: z.string().regex(/^[0-9a-f]{40}$/),
    source_registry_sha256: sha256Schema,
    reviewed_at: timestampSchema,
    record_files: z.array(recordFileSchema).max(10_000),
    removals: z.array(removalSchema).max(10_000),
    retained_issue_states: z.array(retainedIssueStateSchema).max(10_000),
    retained_overlap_states: z.array(retainedOverlapStateSchema).max(100_000),
  })
  .strict();
const manifestV2Schema = z
  .object({
    schema_version: z.literal(2),
    repository: z.literal("LucasQuiles/WhatSoup"),
    source_main_revision: z.string().regex(/^[0-9a-f]{40}$/),
    pinned_main_revision: z.string().regex(/^[0-9a-f]{40}$/),
    source_registry_sha256: sha256Schema,
    reviewed_at: timestampSchema,
    record_files: z.array(recordFileSchema).max(10_000),
    repins: z.array(repinSchema).max(10_000),
    removals: z.array(removalSchema).max(10_000),
    retained_issue_states: z.array(retainedIssueStateV2Schema).max(10_000),
    retained_overlap_states: z.array(retainedOverlapStateSchema).max(100_000),
  })
  .strict();
const manifestSchema = z.discriminatedUnion("schema_version", [
  manifestV1Schema,
  manifestV2Schema,
]);

export type RegistryReviewManifest = z.infer<typeof manifestSchema>;

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function assertSortedUnique<T>(
  values: readonly T[],
  key: (value: T) => string,
  label: string,
): void {
  for (const [index, value] of values.entries()) {
    const current = key(value);
    if (
      current.length === 0 ||
      (index > 0 && compareUtf8(key(values[index - 1]!), current) >= 0)
    ) {
      throw new Error(`${label} must be sorted and unique`);
    }
  }
}

export function parseRegistryReviewManifest(
  value: unknown,
): RegistryReviewManifest {
  const manifest = manifestSchema.parse(value);
  assertSortedUnique(
    manifest.record_files,
    (entry) => String(entry.issue_number).padStart(20, "0"),
    "review record issue numbers",
  );
  const recordPaths = new Set<string>();
  for (const record of manifest.record_files) {
    if (
      recordPaths.has(record.path) ||
      !record.path.endsWith(`/${record.issue_number}.json`)
    ) {
      throw new Error(
        "review record paths must be unique and match issue numbers",
      );
    }
    recordPaths.add(record.path);
  }
  assertSortedUnique(
    manifest.removals,
    (entry) => String(entry.issue_number).padStart(20, "0"),
    "review removals",
  );
  if (manifest.schema_version === 2) {
    assertSortedUnique(
      manifest.repins,
      (entry) => String(entry.issue_number).padStart(20, "0"),
      "review repins",
    );
  }
  assertSortedUnique(
    manifest.retained_issue_states,
    (entry) => String(entry.issue_number).padStart(20, "0"),
    "retained issue states",
  );
  assertSortedUnique(
    manifest.retained_overlap_states,
    (entry) =>
      `${String(entry.issue_number).padStart(20, "0")}:${String(entry.pull_request_number).padStart(20, "0")}`,
    "retained overlap states",
  );
  return manifest;
}

export function materializeRegistryReviewBatch(
  manifest: RegistryReviewManifest,
  recordTexts: ReadonlyMap<string, string>,
): RegistryReviewBatch {
  if (recordTexts.size !== manifest.record_files.length) {
    throw new Error("review record file set does not match the manifest");
  }
  const records = manifest.record_files.map((entry) => {
    const text = recordTexts.get(entry.path);
    if (text === undefined) {
      throw new Error(`review record file is missing: ${entry.path}`);
    }
    if (sha256(text) !== entry.sha256) {
      throw new Error(`review record digest mismatch: ${entry.path}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`review record JSON is invalid: ${entry.path}`);
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("issue_number" in parsed) ||
      parsed.issue_number !== entry.issue_number
    ) {
      throw new Error(`review record issue number mismatch: ${entry.path}`);
    }
    return parsed as RegistryReviewBatch["records"][number];
  });
  return {
    schema_version: manifest.schema_version,
    repository: manifest.repository,
    pinned_main_revision: manifest.pinned_main_revision,
    ...(manifest.schema_version === 2
      ? {
          source_main_revision: manifest.source_main_revision,
          repins: structuredClone(manifest.repins),
        }
      : {}),
    source_registry_sha256: manifest.source_registry_sha256,
    reviewed_at: manifest.reviewed_at,
    records,
    removals: structuredClone(manifest.removals),
    retained_issue_states: structuredClone(manifest.retained_issue_states),
    retained_overlap_states: structuredClone(manifest.retained_overlap_states),
  };
}

export function bodyFreeRegistrySnapshot(input: {
  capture: RegistryCapture;
  capturedAt: string;
  mainOid: string;
  reviewManifestSha256: string;
  idempotencyKey?: string;
}): Record<string, unknown> {
  const openPullRequests = input.capture.pullRequests.filter(
    (pullRequest) => pullRequest.disposition === "open",
  );
  return {
    schema_version: 1,
    repository: input.capture.repository,
    captured_at: input.capturedAt,
    main_oid: input.mainOid,
    review_manifest_sha256: input.reviewManifestSha256,
    ...(input.idempotencyKey === undefined
      ? {}
      : { operation_id: input.idempotencyKey }),
    counts: {
      open_issues: input.capture.issues.length,
      open_pull_requests: openPullRequests.length,
      draft_pull_requests: openPullRequests.filter(
        (pullRequest) => pullRequest.isDraft,
      ).length,
      labels: input.capture.labels.length,
    },
    labels: [...input.capture.labels],
    open_issue_numbers: input.capture.issues.map((issue) => issue.number),
    pull_requests: input.capture.pullRequests.map((pullRequest) => ({
      number: pullRequest.number,
      url: pullRequest.url,
      updated_at: pullRequest.updatedAt,
      disposition: pullRequest.disposition,
      is_draft: pullRequest.isDraft,
      changed_files: pullRequest.changedFiles,
      closing_issue_numbers: [...pullRequest.closingIssueNumbers],
    })),
    pagination: structuredClone(input.capture.pagination),
  };
}
