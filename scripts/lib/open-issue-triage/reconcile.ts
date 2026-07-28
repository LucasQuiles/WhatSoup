import { z } from "zod";

import { assertNoSecretLike } from "../../artifact-redaction.ts";
import { scanTextForPrivateLiterals } from "../../publication-guard.ts";
import { scanContentLines } from "../../repo-hygiene-guard.ts";
import { canonicalJson } from "./artifact-transaction-internal.ts";
import {
  parseRegistry,
  registrySha256,
  sha256,
  validateRegistry,
  type OpenIssueRegistry,
} from "./model.ts";

const REPOSITORY_OWNER = "LucasQuiles";
const REPOSITORY_NAME = "WhatSoup";
const MAX_REFERENCE_RANGE_SPAN = 1_000;

export interface ReconcilePullRequestOverlap {
  number: number;
  title: string;
  url: string;
  updated_at: string;
  disposition: "open" | "merged" | "closed-unmerged";
  is_draft: boolean;
  head_ref: string | null;
  base_ref: string | null;
  matched_by: string[];
  overlapping_paths: string[];
  assessment: "owns" | "partial" | "collision-only" | "historical-attempt";
}

export interface ReconcileIssueRecord {
  issue_number: number;
  affected_paths: string[];
  decisive_source_paths: string[];
  decisive_test_paths: string[];
  pull_request_owner_pr_number: number | null;
  pull_request_overlaps: ReconcilePullRequestOverlap[];
}

export interface RefreshPullRequest {
  number: number;
  title: string;
  body: string;
  url: string;
  updatedAt: string;
  disposition: "open" | "merged" | "closed-unmerged";
  isDraft: boolean;
  headRef: string | null;
  baseRef: string | null;
  changedPaths: string[];
  closingIssueNumbers: number[];
}

export interface RefreshIssue {
  issueNumber: number;
  issueNodeId: string;
  title: string;
  url: string;
  updatedAt: string;
  body: string;
  labels: string[];
}

export interface RefreshClosedIssue {
  issueNumber: number;
  issueNodeId: string;
  url: string;
  updatedAt: string;
  body: string;
  state: "closed";
}

export type FullIssueRecord = OpenIssueRegistry["issues"][number];

export interface ReviewedIssueRemoval {
  issue_number: number;
  issue_node_id: string;
  url: string;
  updated_at: string;
  pre_review_body_sha256: string;
  state: "closed";
}

export interface RetainedIssueState {
  issue_number: number;
  issue_node_id: string;
  title: string;
  url: string;
  updated_at: string;
  pre_review_body_sha256: string;
  current_labels: string[];
  recommended_labels?: string[];
}

export interface RetainedOverlapState {
  issue_number: number;
  pull_request_number: number;
  overlap: ReconcilePullRequestOverlap | null;
}

export interface ReviewedIssueRepin {
  issue_number: number;
  source_record_sha256: string;
}

export interface RegistryReviewBatch {
  schema_version: 1 | 2;
  repository: "LucasQuiles/WhatSoup";
  source_main_revision?: string;
  pinned_main_revision: string;
  source_registry_sha256: string;
  reviewed_at: string;
  records: FullIssueRecord[];
  repins?: ReviewedIssueRepin[];
  removals: ReviewedIssueRemoval[];
  retained_issue_states?: RetainedIssueState[];
  retained_overlap_states?: RetainedOverlapState[];
}

const positiveIntegerSchema = z.number().int().positive();
const timestampSchema = z.string().datetime({ offset: false });
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
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
const gitRefSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !/[\u0000-\u0020\u007f~^:?*[\\]/.test(value) &&
      value !== "@" &&
      !value.startsWith("-") &&
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !value.includes("//") &&
      value
        .split("/")
        .every(
          (part) =>
            part !== "" && !part.startsWith(".") && !part.endsWith(".lock"),
        ),
    "ref must be a safe Git reference name",
  );

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function sortedUniqueStringSchema(schema: z.ZodType<string>) {
  return z.array(schema).superRefine((values, context) => {
    if (
      values.some(
        (value, index) =>
          index > 0 && compareUtf8(values[index - 1]!, value) >= 0,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "list must be sorted by UTF-8 byte order without duplicates",
      });
    }
  });
}

const matchedBySchema = sortedUniqueStringSchema(
  z.enum([
    "issue-reference",
    "closing-reference",
    "touched-path",
    "acceptance-criteria",
  ]),
).refine((values) => values.length > 0, "matched_by must be nonempty");
const overlapSchema: z.ZodType<ReconcilePullRequestOverlap> = z
  .object({
    number: positiveIntegerSchema,
    title: z.string().min(1).max(16_384),
    url: z
      .string()
      .url()
      .refine(
        (value) =>
          /^https:\/\/github\.com\/LucasQuiles\/WhatSoup\/pull\/[1-9]\d*$/.test(
            value,
          ),
        "URL must identify a pull request in LucasQuiles/WhatSoup",
      ),
    updated_at: timestampSchema,
    disposition: z.enum(["open", "merged", "closed-unmerged"]),
    is_draft: z.boolean(),
    head_ref: gitRefSchema.nullable(),
    base_ref: gitRefSchema.nullable(),
    matched_by: matchedBySchema,
    overlapping_paths: sortedUniqueStringSchema(repositoryPathSchema),
    assessment: z.enum([
      "owns",
      "partial",
      "collision-only",
      "historical-attempt",
    ]),
  })
  .strict();
const retainedIssueStateShape = {
  issue_number: positiveIntegerSchema,
  issue_node_id: z.string().min(1).max(1_024),
  title: z.string().min(1).max(16_384),
  url: issueUrlSchema,
  updated_at: timestampSchema,
  pre_review_body_sha256: sha256Schema,
  current_labels: sortedUniqueStringSchema(z.string().min(1).max(1_024)),
};
const retainedIssueStateSchema: z.ZodType<RetainedIssueState> = z
  .object(retainedIssueStateShape)
  .strict();
const retainedIssueStateV2Schema = z
  .object({
    ...retainedIssueStateShape,
    recommended_labels: sortedUniqueStringSchema(z.string().min(1).max(1_024)),
  })
  .strict();
const repinSchema: z.ZodType<ReviewedIssueRepin> = z
  .object({
    issue_number: positiveIntegerSchema,
    source_record_sha256: sha256Schema,
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
const retainedOverlapStateSchema: z.ZodType<RetainedOverlapState> = z
  .object({
    issue_number: positiveIntegerSchema,
    pull_request_number: positiveIntegerSchema,
    overlap: overlapSchema.nullable(),
  })
  .strict();
const reviewBatchV1Schema = z
  .object({
    schema_version: z.literal(1),
    repository: z.literal("LucasQuiles/WhatSoup"),
    pinned_main_revision: z.string().regex(/^[0-9a-f]{40}$/),
    source_registry_sha256: sha256Schema,
    reviewed_at: timestampSchema,
    records: z.array(z.unknown()).max(10_000),
    removals: z.array(removalSchema).max(10_000),
    retained_issue_states: z
      .array(retainedIssueStateSchema)
      .max(10_000)
      .optional(),
    retained_overlap_states: z
      .array(retainedOverlapStateSchema)
      .max(100_000)
      .optional(),
  })
  .strict();
const reviewBatchV2Schema = z
  .object({
    schema_version: z.literal(2),
    repository: z.literal("LucasQuiles/WhatSoup"),
    source_main_revision: z.string().regex(/^[0-9a-f]{40}$/),
    pinned_main_revision: z.string().regex(/^[0-9a-f]{40}$/),
    source_registry_sha256: sha256Schema,
    reviewed_at: timestampSchema,
    records: z.array(z.unknown()).max(10_000),
    repins: z.array(repinSchema).max(10_000),
    removals: z.array(removalSchema).max(10_000),
    retained_issue_states: z.array(retainedIssueStateV2Schema).max(10_000),
    retained_overlap_states: z.array(retainedOverlapStateSchema).max(100_000),
  })
  .strict();
const reviewBatchSchema = z.discriminatedUnion("schema_version", [
  reviewBatchV1Schema,
  reviewBatchV2Schema,
]);
const closedIssueSchema: z.ZodType<RefreshClosedIssue> = z
  .object({
    issueNumber: positiveIntegerSchema,
    issueNodeId: z.string().min(1).max(1_024),
    url: issueUrlSchema,
    updatedAt: timestampSchema,
    body: z.string().max(1_000_000),
    state: z.literal("closed"),
  })
  .strict();

function uniqueSortedStrings(values: string[]): string[] {
  return [...new Set(values)].sort(compareUtf8);
}

function positiveSafeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return parsed;
}

/**
 * Extracts issue or pull-request numbers that unambiguously refer to this
 * repository. GitHub URLs for other repositories are removed before the
 * shorthand parser runs, so a foreign `/issues/N` path cannot become a local
 * reference accidentally.
 */
export function referencedRepositoryNumbers(text: string): number[] {
  const numbers = new Set<number>();
  const withoutGitHubUrls = text.replace(
    /https:\/\/github\.com\/[^\s<>"'`]+/gi,
    (token) => {
      const candidate = token.replace(/[)\]},.;:!?]+$/g, "");
      try {
        const url = new URL(candidate);
        const match = /^\/([^/]+)\/([^/]+)\/(?:issues|pull)\/([1-9]\d*)$/.exec(
          url.pathname,
        );
        if (
          match !== null &&
          match[1]!.toLowerCase() === REPOSITORY_OWNER.toLowerCase() &&
          match[2]!.toLowerCase() === REPOSITORY_NAME.toLowerCase()
        ) {
          numbers.add(
            positiveSafeInteger(match[3]!, "repository URL reference"),
          );
        }
      } catch {
        // The complete GitHub-looking token remains excluded from shorthand parsing.
      }
      return " ".repeat(token.length);
    },
  );

  const rangePattern =
    /\b(?:issues?|pull requests?|prs?|draft prs?)\s+#([1-9]\d*)\s*(?:through|to|-)\s*#?([1-9]\d*)\b/gi;
  for (const match of withoutGitHubUrls.matchAll(rangePattern)) {
    const first = positiveSafeInteger(match[1]!, "reference range start");
    const last = positiveSafeInteger(match[2]!, "reference range end");
    if (last < first) {
      throw new Error(
        `reference range is reversed: #${first} through #${last}`,
      );
    }
    if (last - first > MAX_REFERENCE_RANGE_SPAN) {
      throw new Error(
        `reference range exceeds ${MAX_REFERENCE_RANGE_SPAN}: #${first} through #${last}`,
      );
    }
    for (let number = first; number <= last; number += 1) numbers.add(number);
  }

  for (const match of withoutGitHubUrls.matchAll(
    /(?:^|[^A-Za-z0-9])#([1-9]\d*)(?!\d)/g,
  )) {
    numbers.add(positiveSafeInteger(match[1]!, "shorthand reference"));
  }

  return [...numbers].sort((left, right) => left - right);
}

export function textReferencesRepositoryNumber(
  text: string,
  number: number,
): boolean {
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error("reference target must be a positive safe integer");
  }
  return referencedRepositoryNumbers(text).includes(number);
}

function issuePaths(issue: ReconcileIssueRecord): string[] {
  return uniqueSortedStrings([
    ...issue.affected_paths,
    ...issue.decisive_source_paths,
    ...issue.decisive_test_paths,
  ]);
}

function currentDynamicEvidence(
  issue: ReconcileIssueRecord,
  issueBody: string,
  pullRequest: RefreshPullRequest,
): {
  matchedBy: string[];
  overlappingPaths: string[];
} {
  const paths = new Set(pullRequest.changedPaths);
  const overlappingPaths = issuePaths(issue).filter((path) => paths.has(path));
  const matchedBy: string[] = [];
  if (
    textReferencesRepositoryNumber(issueBody, pullRequest.number) ||
    textReferencesRepositoryNumber(
      `${pullRequest.title}\n${pullRequest.body}`,
      issue.issue_number,
    )
  ) {
    matchedBy.push("issue-reference");
  }
  if (pullRequest.closingIssueNumbers.includes(issue.issue_number)) {
    matchedBy.push("closing-reference");
  }
  if (overlappingPaths.length > 0) matchedBy.push("touched-path");
  return {
    matchedBy: uniqueSortedStrings(matchedBy),
    overlappingPaths,
  };
}

function refreshedOverlap(
  issue: ReconcileIssueRecord,
  issueBody: string,
  pullRequest: RefreshPullRequest,
  previous?: ReconcilePullRequestOverlap,
): ReconcilePullRequestOverlap | null {
  if (
    previous === undefined &&
    issue.pull_request_owner_pr_number === pullRequest.number
  ) {
    return null;
  }
  if (previous === undefined && pullRequest.disposition !== "open") return null;
  const dynamic = currentDynamicEvidence(issue, issueBody, pullRequest);
  const retained =
    previous?.matched_by.filter((reason) => reason === "acceptance-criteria") ??
    [];
  const matchedBy = uniqueSortedStrings([...retained, ...dynamic.matchedBy]);
  if (matchedBy.length === 0) return null;
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    updated_at: pullRequest.updatedAt,
    disposition: pullRequest.disposition,
    is_draft: pullRequest.isDraft,
    head_ref: pullRequest.headRef,
    base_ref: pullRequest.baseRef,
    matched_by: matchedBy,
    overlapping_paths: dynamic.overlappingPaths,
    assessment: previous?.assessment ?? "collision-only",
  };
}

function exactOverlap(
  left: ReconcilePullRequestOverlap,
  right: ReconcilePullRequestOverlap,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function overlapMetadataChanged(
  overlap: ReconcilePullRequestOverlap,
  pullRequest: RefreshPullRequest,
): boolean {
  return (
    overlap.title !== pullRequest.title ||
    overlap.url !== pullRequest.url ||
    overlap.updated_at !== pullRequest.updatedAt ||
    overlap.disposition !== pullRequest.disposition ||
    overlap.is_draft !== pullRequest.isDraft ||
    overlap.head_ref !== pullRequest.headRef ||
    overlap.base_ref !== pullRequest.baseRef
  );
}

export function reconcilePullRequestOverlaps(input: {
  issue: ReconcileIssueRecord;
  issueBody: string;
  openPullRequests: RefreshPullRequest[];
  explicitlyReviewed: boolean;
}): ReconcilePullRequestOverlap[] {
  if (input.issue.pull_request_owner_pr_number !== null) {
    const owner = input.openPullRequests.find(
      (pullRequest) =>
        pullRequest.number === input.issue.pull_request_owner_pr_number,
    );
    if (owner === undefined) {
      throw new Error(
        `owner pull request #${input.issue.pull_request_owner_pr_number} is missing from captured pull requests`,
      );
    }
    if (owner.disposition !== "open") {
      throw new Error(
        `owner pull request #${owner.number} must remain open or receive exact issue review`,
      );
    }
  }
  const existingByNumber = new Map(
    input.issue.pull_request_overlaps.map((overlap) => [
      overlap.number,
      overlap,
    ]),
  );
  const capturedNumbers = new Set(
    input.openPullRequests.map((pullRequest) => pullRequest.number),
  );
  for (const overlap of input.issue.pull_request_overlaps) {
    if (
      overlap.disposition === "open" &&
      !capturedNumbers.has(overlap.number)
    ) {
      throw new Error(
        `open pull request #${overlap.number} on issue #${input.issue.issue_number} changed disposition after review`,
      );
    }
  }

  const reconciled = input.issue.pull_request_overlaps.filter(
    (overlap) => !capturedNumbers.has(overlap.number),
  );
  for (const pullRequest of [...input.openPullRequests].sort(
    (left, right) => left.number - right.number,
  )) {
    const previous = existingByNumber.get(pullRequest.number);
    const current = refreshedOverlap(
      input.issue,
      input.issueBody,
      pullRequest,
      previous,
    );
    if (
      previous !== undefined &&
      current === null &&
      previous.assessment !== "collision-only"
    ) {
      throw new Error(
        `open pull request #${pullRequest.number} no longer supports its ${previous.assessment} overlap on issue #${input.issue.issue_number}`,
      );
    }
    if (
      previous !== undefined &&
      overlapMetadataChanged(previous, pullRequest)
    ) {
      if (!input.explicitlyReviewed) {
        throw new Error(
          `open pull request #${pullRequest.number} on issue #${input.issue.issue_number} changed after review`,
        );
      }
      if (current === null || !exactOverlap(previous, current)) {
        throw new Error(
          `explicit review for issue #${input.issue.issue_number} does not match live pull request #${pullRequest.number}`,
        );
      }
    } else if (input.explicitlyReviewed && previous !== undefined) {
      if (current === null || !exactOverlap(previous, current)) {
        throw new Error(
          `explicit review for issue #${input.issue.issue_number} does not match live pull request #${pullRequest.number}`,
        );
      }
    }
    if (current !== null) reconciled.push(current);
  }
  return reconciled.sort((left, right) => left.number - right.number);
}

function assertSortedUniqueNumbers(values: number[], label: string): void {
  for (const [index, value] of values.entries()) {
    if (
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      (index > 0 && values[index - 1]! >= value)
    ) {
      throw new Error(`${label} must be sorted, unique positive integers`);
    }
  }
}

function assertSortedUniqueStrings(values: string[], label: string): void {
  for (const [index, value] of values.entries()) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      (index > 0 && compareUtf8(values[index - 1]!, value) >= 0)
    ) {
      throw new Error(`${label} must be sorted, unique nonempty strings`);
    }
  }
}

function sameStrings(left: string[], right: string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function issueRecordSha256(record: FullIssueRecord): string {
  return sha256(canonicalJson(record));
}

function assertLiveIdentity(
  record: FullIssueRecord,
  live: RefreshIssue,
  expectedMainOid: string,
): void {
  const mismatches: string[] = [];
  if (record.issue_node_id !== live.issueNodeId) mismatches.push("node-id");
  if (record.title !== live.title) mismatches.push("title");
  if (record.url !== live.url) mismatches.push("url");
  if (record.updated_at !== live.updatedAt) mismatches.push("updated-at");
  if (record.pre_review_body_sha256 !== sha256(live.body))
    mismatches.push("body");
  if (!sameStrings(record.current_labels, [...live.labels].sort(compareUtf8))) {
    mismatches.push("labels");
  }
  if (record.pinned_revision !== expectedMainOid)
    mismatches.push("pinned-revision");
  if (mismatches.length > 0) {
    throw new Error(
      `review record for issue #${live.issueNumber} does not match live evidence: ${mismatches.join(",")}`,
    );
  }
}

function assertReviewBatch(
  value: unknown,
  oldRegistry: OpenIssueRegistry,
  expectedMainOid: string,
): RegistryReviewBatch {
  const batch = reviewBatchSchema.parse(value);
  const records = parseRegistry({
    ...oldRegistry,
    inventory: {
      ...oldRegistry.inventory,
      open_issue_count: batch.records.length,
    },
    issues: batch.records,
  }).issues;
  const parsed = { ...batch, records } as RegistryReviewBatch;
  const publicText = `${JSON.stringify(parsed)}\n`;
  const filePath = "docs/triage/reviews/open-issue-registry-review-batch.json";
  const publicationIssues = scanTextForPrivateLiterals(filePath, publicText);
  const hygieneIssues = scanContentLines(
    publicText.split("\n").map((text, index) => ({
      filePath,
      line: index + 1,
      text,
    })),
  );
  if (publicationIssues.length > 0 || hygieneIssues.length > 0) {
    throw new Error(
      `PUBLIC review batch rejected: ${[...publicationIssues, ...hygieneIssues]
        .map((issue) => issue.code)
        .join(", ")}`,
    );
  }
  assertNoSecretLike(publicText, "open issue registry review batch");
  if (batch.repository !== "LucasQuiles/WhatSoup") {
    throw new Error("review batch repository or schema is invalid");
  }
  if (batch.pinned_main_revision !== expectedMainOid) {
    throw new Error(
      "review batch main revision does not match the requested pin",
    );
  }
  if (batch.source_registry_sha256 !== registrySha256(oldRegistry)) {
    throw new Error("review batch source registry digest does not match");
  }
  if (!Number.isFinite(Date.parse(batch.reviewed_at))) {
    throw new Error("review batch reviewed_at is invalid");
  }
  assertSortedUniqueNumbers(
    parsed.records.map((record) => record.issue_number),
    "review batch record numbers",
  );
  assertSortedUniqueNumbers(
    batch.removals.map((removal) => removal.issue_number),
    "review batch removal numbers",
  );
  if (batch.schema_version === 2) {
    assertSortedUniqueNumbers(
      batch.repins.map((repin) => repin.issue_number),
      "review batch repin numbers",
    );
  }
  assertSortedUniqueNumbers(
    (batch.retained_issue_states ?? []).map((state) => state.issue_number),
    "retained issue state numbers",
  );
  const retainedOverlapKeys = (batch.retained_overlap_states ?? []).map(
    (state) => `${state.issue_number}:${state.pull_request_number}`,
  );
  if (
    new Set(retainedOverlapKeys).size !== retainedOverlapKeys.length ||
    JSON.stringify(retainedOverlapKeys) !==
      JSON.stringify([...retainedOverlapKeys].sort(compareUtf8))
  ) {
    throw new Error("retained overlap states must be sorted and unique");
  }
  for (const state of batch.retained_overlap_states ?? []) {
    if (
      !Number.isSafeInteger(state.pull_request_number) ||
      state.pull_request_number <= 0 ||
      (state.overlap !== null &&
        state.overlap.number !== state.pull_request_number)
    ) {
      throw new Error(
        "retained overlap state pull request identity is invalid",
      );
    }
  }
  const recordNumbers = new Set(
    parsed.records.map((record) => record.issue_number),
  );
  if (
    batch.removals.some((removal) => recordNumbers.has(removal.issue_number))
  ) {
    throw new Error("review batch cannot both replace and remove one issue");
  }
  if (
    (batch.retained_issue_states ?? []).some((state) =>
      recordNumbers.has(state.issue_number),
    )
  ) {
    throw new Error("review batch cannot both replace and retain one issue");
  }
  if (
    (batch.retained_overlap_states ?? []).some((state) =>
      recordNumbers.has(state.issue_number),
    )
  ) {
    throw new Error(
      "review batch cannot both replace one issue and include retained overlap state",
    );
  }
  if (batch.schema_version === 2) {
    if (batch.source_main_revision !== oldRegistry.pinned_main_revision) {
      throw new Error(
        "review batch source main revision does not match the source registry",
      );
    }
    const oldByNumber = new Map(
      oldRegistry.issues.map((record) => [record.issue_number, record]),
    );
    const repinNumbers = new Set(
      batch.repins.map((repin) => repin.issue_number),
    );
    const removalNumbers = new Set(
      batch.removals.map((removal) => removal.issue_number),
    );
    const retainedIssueNumbers = new Set(
      batch.retained_issue_states.map((state) => state.issue_number),
    );
    const retainedOverlapNumbers = new Set(
      batch.retained_overlap_states.map((state) => state.issue_number),
    );
    for (const record of parsed.records) {
      if (record.pinned_revision !== expectedMainOid) {
        throw new Error(
          `review record #${record.issue_number} does not match the requested target pin`,
        );
      }
    }
    for (const repin of batch.repins) {
      const source = oldByNumber.get(repin.issue_number);
      if (source === undefined) {
        throw new Error(
          `review repin #${repin.issue_number} is not in the source registry`,
        );
      }
      if (repin.source_record_sha256 !== issueRecordSha256(source)) {
        throw new Error(
          `review repin #${repin.issue_number} source record digest does not match`,
        );
      }
      if (
        recordNumbers.has(repin.issue_number) ||
        removalNumbers.has(repin.issue_number)
      ) {
        throw new Error(
          `review repin #${repin.issue_number} conflicts with another review category`,
        );
      }
    }
    for (const number of removalNumbers) {
      if (
        !oldByNumber.has(number) ||
        retainedIssueNumbers.has(number) ||
        retainedOverlapNumbers.has(number)
      ) {
        throw new Error(
          `reviewed removal #${number} conflicts with the source registry or retained evidence`,
        );
      }
    }
    for (const number of retainedIssueNumbers) {
      if (!oldByNumber.has(number)) {
        throw new Error(
          `retained issue state #${number} is not in the source registry`,
        );
      }
    }
    for (const state of batch.retained_issue_states) {
      const source = oldByNumber.get(state.issue_number)!;
      if (
        state.issue_node_id !== source.issue_node_id ||
        state.title !== source.title ||
        state.url !== source.url ||
        state.pre_review_body_sha256 !== source.pre_review_body_sha256
      ) {
        throw new Error(
          `retained metadata for issue #${state.issue_number} changes source identity`,
        );
      }
    }
    for (const number of retainedOverlapNumbers) {
      if (!oldByNumber.has(number)) {
        throw new Error(
          `retained overlap state #${number} is not in the source registry`,
        );
      }
    }
    if (batch.source_main_revision !== batch.pinned_main_revision) {
      for (const source of oldRegistry.issues) {
        if (
          !recordNumbers.has(source.issue_number) &&
          !repinNumbers.has(source.issue_number) &&
          !removalNumbers.has(source.issue_number)
        ) {
          throw new Error(
            `cross-main review coverage is missing issue #${source.issue_number}`,
          );
        }
      }
    }
  }
  return parsed;
}

export function parseRegistryReviewBatch(
  value: unknown,
  oldRegistry: OpenIssueRegistry,
  expectedMainOid: string,
): RegistryReviewBatch {
  return assertReviewBatch(value, oldRegistry, expectedMainOid);
}

export function reconcileRegistry(input: {
  oldRegistry: OpenIssueRegistry;
  reviewBatch: unknown;
  liveIssues: RefreshIssue[];
  closedIssues: RefreshClosedIssue[];
  openPullRequests: RefreshPullRequest[];
  labels: string[];
  capturedAt: string;
  expectedMainOid: string;
}): {
  registry: OpenIssueRegistry;
  addedIssueNumbers: number[];
  removedIssueNumbers: number[];
} {
  const oldRegistry = parseRegistry(input.oldRegistry);
  const oldFindings = validateRegistry(oldRegistry);
  if (oldFindings.length > 0) {
    throw new Error(
      `source registry validation failed before reconciliation: ${oldFindings[0]!.code}`,
    );
  }
  const reviewBatch = assertReviewBatch(
    input.reviewBatch,
    oldRegistry,
    input.expectedMainOid,
  );
  if (
    oldRegistry.repository !== "LucasQuiles/WhatSoup" ||
    (reviewBatch.schema_version === 1 &&
      oldRegistry.pinned_main_revision !== input.expectedMainOid)
  ) {
    throw new Error("source registry repository or main pin does not match");
  }
  if (!Number.isFinite(Date.parse(input.capturedAt))) {
    throw new Error("capture timestamp is invalid");
  }

  const liveNumbers = input.liveIssues.map((issue) => issue.issueNumber);
  assertSortedUniqueNumbers(liveNumbers, "live issue numbers");
  const closedIssues = z
    .array(closedIssueSchema)
    .max(10_000)
    .parse(input.closedIssues);
  assertSortedUniqueNumbers(
    closedIssues.map((issue) => issue.issueNumber),
    "closed issue numbers",
  );
  assertSortedUniqueNumbers(
    input.openPullRequests.map((pullRequest) => pullRequest.number),
    "pull request numbers",
  );
  assertSortedUniqueStrings(input.labels, "repository labels");
  for (const issue of input.liveIssues) {
    assertSortedUniqueStrings(
      issue.labels,
      `issue #${issue.issueNumber} labels`,
    );
  }
  const oldByNumber = new Map(
    oldRegistry.issues.map((issue) => [issue.issue_number, issue]),
  );
  const reviewedByNumber = new Map(
    reviewBatch.records.map((issue) => [issue.issue_number, issue]),
  );
  const removalByNumber = new Map(
    reviewBatch.removals.map((removal) => [removal.issue_number, removal]),
  );
  const repinByNumber = new Map(
    (reviewBatch.repins ?? []).map((repin) => [repin.issue_number, repin]),
  );
  const retainedIssueByNumber = new Map(
    (reviewBatch.retained_issue_states ?? []).map((state) => [
      state.issue_number,
      state,
    ]),
  );
  const retainedOverlapByIssue = new Map<number, RetainedOverlapState[]>();
  for (const state of reviewBatch.retained_overlap_states ?? []) {
    const states = retainedOverlapByIssue.get(state.issue_number) ?? [];
    states.push(state);
    retainedOverlapByIssue.set(state.issue_number, states);
  }
  const liveNumberSet = new Set(liveNumbers);
  const addedIssueNumbers: number[] = [];
  const records: FullIssueRecord[] = [];

  for (const live of input.liveIssues) {
    const old = oldByNumber.get(live.issueNumber);
    const reviewed = reviewedByNumber.get(live.issueNumber);
    const repin = repinByNumber.get(live.issueNumber);
    const retainedIssue = retainedIssueByNumber.get(live.issueNumber);
    const retainedOverlaps = retainedOverlapByIssue.get(live.issueNumber) ?? [];
    const oldOwner = old?.pull_request_owner_pr_number;
    if (oldOwner !== null && oldOwner !== undefined) {
      const previousOwner = input.openPullRequests.find(
        (pullRequest) => pullRequest.number === oldOwner,
      );
      if (previousOwner === undefined) {
        throw new Error(
          `owner pull request #${oldOwner} is missing from captured pull requests`,
        );
      }
      if (previousOwner.disposition !== "open" && reviewed === undefined) {
        throw new Error(
          `owner pull request #${previousOwner.number} transitioned and requires exact issue review`,
        );
      }
    }
    if (old === undefined && reviewed === undefined) {
      throw new Error(
        `new issue #${live.issueNumber} requires an exact review record`,
      );
    }
    if (
      old !== undefined &&
      reviewed === undefined &&
      retainedIssue === undefined &&
      retainedOverlaps.length === 0
    ) {
      const drift =
        old.issue_node_id !== live.issueNodeId ||
        old.title !== live.title ||
        old.url !== live.url ||
        old.updated_at !== live.updatedAt ||
        old.pre_review_body_sha256 !== sha256(live.body) ||
        !sameStrings(old.current_labels, [...live.labels].sort(compareUtf8)) ||
        (old.pinned_revision !== input.expectedMainOid && repin === undefined);
      if (drift) {
        throw new Error(
          `changed issue #${live.issueNumber} requires an exact review record`,
        );
      }
    }
    const selected = structuredClone(reviewed ?? old!);
    if (repin !== undefined) {
      selected.pinned_revision = input.expectedMainOid;
    }
    if (retainedIssue !== undefined) {
      Object.assign(selected, {
        issue_node_id: retainedIssue.issue_node_id,
        title: retainedIssue.title,
        url: retainedIssue.url,
        updated_at: retainedIssue.updated_at,
        pre_review_body_sha256: retainedIssue.pre_review_body_sha256,
        current_labels: [...retainedIssue.current_labels],
        ...(retainedIssue.recommended_labels === undefined
          ? {}
          : { recommended_labels: [...retainedIssue.recommended_labels] }),
      });
    }
    for (const state of retainedOverlaps) {
      const index = selected.pull_request_overlaps.findIndex(
        (overlap) => overlap.number === state.pull_request_number,
      );
      if (index < 0) {
        throw new Error(
          `retained overlap #${state.pull_request_number} is absent from issue #${live.issueNumber}`,
        );
      }
      if (state.overlap === null) {
        if (
          selected.pull_request_overlaps[index]!.assessment !== "collision-only"
        ) {
          throw new Error(
            `only collision-only overlap #${state.pull_request_number} may be explicitly removed`,
          );
        }
        selected.pull_request_overlaps.splice(index, 1);
      } else {
        selected.pull_request_overlaps[index] = structuredClone(state.overlap);
      }
    }
    assertLiveIdentity(selected, live, input.expectedMainOid);
    selected.pull_request_overlaps = reconcilePullRequestOverlaps({
      issue: selected,
      issueBody: live.body,
      openPullRequests: input.openPullRequests,
      explicitlyReviewed:
        reviewed !== undefined ||
        retainedIssue !== undefined ||
        retainedOverlaps.length > 0,
    });
    records.push(selected);
    if (old === undefined) addedIssueNumbers.push(live.issueNumber);
  }

  const removedIssueNumbers = oldRegistry.issues
    .filter((issue) => !liveNumberSet.has(issue.issue_number))
    .map((issue) => issue.issue_number);
  const closedByNumber = new Map(
    closedIssues.map((issue) => [issue.issueNumber, issue]),
  );
  for (const number of removedIssueNumbers) {
    const old = oldByNumber.get(number)!;
    const removal = removalByNumber.get(number);
    const closed = closedByNumber.get(number);
    if (closed === undefined) {
      throw new Error(
        `closed issue #${number} requires captured closed issue evidence`,
      );
    }
    if (
      removal === undefined ||
      removal.issue_node_id !== old.issue_node_id ||
      removal.url !== old.url ||
      removal.issue_node_id !== closed.issueNodeId ||
      removal.url !== closed.url ||
      removal.updated_at !== closed.updatedAt ||
      removal.pre_review_body_sha256 !== sha256(closed.body) ||
      removal.state !== closed.state
    ) {
      throw new Error(
        `closed issue #${number} requires an exact reviewed removal`,
      );
    }
  }
  for (const number of reviewedByNumber.keys()) {
    if (!liveNumberSet.has(number))
      throw new Error(`review record #${number} is not open`);
  }
  for (const number of retainedIssueByNumber.keys()) {
    if (!liveNumberSet.has(number) || !oldByNumber.has(number)) {
      throw new Error(
        `retained issue state #${number} does not match an existing open issue`,
      );
    }
  }
  for (const number of retainedOverlapByIssue.keys()) {
    if (!liveNumberSet.has(number) || !oldByNumber.has(number)) {
      throw new Error(
        `retained overlap state #${number} does not match an existing open issue`,
      );
    }
  }
  for (const number of removalByNumber.keys()) {
    if (!removedIssueNumbers.includes(number)) {
      throw new Error(
        `reviewed removal #${number} does not match a removed issue`,
      );
    }
  }
  for (const number of closedByNumber.keys()) {
    if (!removedIssueNumbers.includes(number)) {
      throw new Error(
        `captured closed issue #${number} does not match a removed issue`,
      );
    }
  }

  const labels = [...input.labels];
  const candidate = parseRegistry({
    schema_version: 1,
    repository: "LucasQuiles/WhatSoup",
    generated_at: input.capturedAt,
    pinned_main_revision: input.expectedMainOid,
    inventory: {
      captured_at: input.capturedAt,
      open_issue_count: records.length,
      open_pull_request_count: input.openPullRequests.filter(
        (pullRequest) => pullRequest.disposition === "open",
      ).length,
      draft_pull_request_count: input.openPullRequests.filter(
        (pullRequest) =>
          pullRequest.disposition === "open" && pullRequest.isDraft,
      ).length,
      label_count: labels.length,
      labels,
    },
    issues: records.sort(
      (left, right) => left.issue_number - right.issue_number,
    ),
  });
  const findings = validateRegistry(candidate);
  if (findings.length > 0) {
    throw new Error(
      `reconciled registry validation failed: ${findings[0]!.code}`,
    );
  }
  return { registry: candidate, addedIssueNumbers, removedIssueNumbers };
}
