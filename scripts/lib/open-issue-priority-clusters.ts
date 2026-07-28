import { z } from "zod";

import { assertNoSecretLike } from "../artifact-redaction.ts";
import { scanTextForPrivateLiterals } from "../publication-guard.ts";
import { scanContentLines } from "../repo-hygiene-guard.ts";
import {
  parseRegistry,
  sha256,
  validateRegistry,
  type OpenIssueRegistry,
} from "./open-issue-triage/model.ts";

export const PRIORITY_CLUSTER_ARTIFACT =
  "docs/triage/open-issue-priority-clusters-20260728.json";
export const PRIORITY_CLUSTER_VIEW =
  "docs/triage/open-issue-priority-clusters-20260728.md";
export const EXPECTED_SOURCE_REGISTRY_ARTIFACT_COMMIT =
  "c5fd3670b20436921e3bd1c2d20129c599e4ffe7";
export const EXPECTED_SOURCE_REGISTRY_REVISION =
  "59166b78357e129ab8140b145e304b5426bcb209";
export const EXPECTED_SOURCE_REGISTRY_SHA256 =
  "8723a28a46976cc174a5c86abd266159e00089047952b6daeb1f2032ff8ccbe0";

const CLUSTER_MEMBERS = {
  TR: [2148, 2150, 2151],
  CORE: [2144, 2145, 2169, 2170, 2354, 2511, 2540, 2566],
  RTH: [2155, 2160],
  PRIV: [2386, 2561, 2564],
  PUBLIC: [2457, 2517],
  LIFE: [
    2356, 2358, 2373, 2385, 2387, 2390, 2392, 2393, 2417, 2419, 2420, 2421,
    2422, 2424, 2425, 2426,
  ],
  DUR: [2427, 2463, 2482, 2485],
  HEALTH: [
    2340, 2341, 2342, 2460, 2462, 2465, 2466, 2483, 2486, 2487, 2503, 2505,
    2546,
  ],
  SELF: [2467, 2468, 2469, 2470, 2471, 2472, 2473, 2475, 2476, 2480],
  CONTRACT: [2147, 2388, 2447, 2506],
  IDENT: [2343, 2355, 2428, 2507, 2533],
  OUT: [2510, 2556, 2557, 2558, 2559, 2560, 2562],
  OPS: [2458, 2459],
  MEM: [2565, 2567, 2568, 2569, 2572],
  SOLO: [2189, 2357, 2512],
} as const;

const positiveInteger = z.number().int().positive();
const sha40 = z.string().regex(/^[0-9a-f]{40}$/u);
const sha64 = z.string().regex(/^[0-9a-f]{64}$/u);
const sortedUniquePositiveIntegers = z
  .array(positiveInteger)
  .min(1)
  .superRefine((values, context) => {
    for (let index = 1; index < values.length; index += 1) {
      if (values[index - 1]! >= values[index]!) {
        context.addIssue({
          code: "custom",
          message: "issue numbers must be sorted without duplicates",
        });
        return;
      }
    }
  });

const countsSchema = z.strictObject({
  P0: z.number().int().nonnegative(),
  P1: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  in_progress: z.number().int().nonnegative(),
  patch_ready: z.number().int().nonnegative(),
  conflict: z.number().int().nonnegative(),
  unclaimed: z.number().int().nonnegative(),
  clusters: z.number().int().positive(),
});

const clusterSchema = z.strictObject({
  id: z.string().regex(/^[A-Z][A-Z0-9-]{1,31}$/u),
  member_issue_numbers: sortedUniquePositiveIntegers,
});

const priorityClusterInventorySchema = z.strictObject({
  schema_version: z.literal(1),
  repository: z.literal("LucasQuiles/WhatSoup"),
  source_registry_artifact_commit: sha40,
  source_registry_revision: sha40,
  source_registry_sha256: sha64,
  source_registry_captured_at: z.string().datetime({ offset: false }),
  priority_scope: z.tuple([z.literal("P0"), z.literal("P1")]),
  counts: countsSchema,
  clusters: z.array(clusterSchema).min(1),
});

export type PriorityClusterInventory = z.infer<
  typeof priorityClusterInventorySchema
>;

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareUtf8(left, right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

function assertPublicProjection(filePath: string, text: string): void {
  const findings = [
    ...scanTextForPrivateLiterals(filePath, text),
    ...scanContentLines(
      text.split("\n").map((line, index) => ({
        filePath,
        line: index + 1,
        text: line,
      })),
    ),
  ];
  if (findings.length > 0) {
    throw new Error(
      `priority cluster publication rejected: ${findings
        .map((finding) => finding.code)
        .join(",")}`,
    );
  }
  assertNoSecretLike(text, filePath);
}

function parseSealedRegistry(registryText: string): OpenIssueRegistry {
  if (sha256(registryText) !== EXPECTED_SOURCE_REGISTRY_SHA256) {
    throw new Error("source registry digest does not match the sealed input");
  }
  const registry = parseRegistry(JSON.parse(registryText));
  const findings = validateRegistry(registry);
  if (findings.length > 0) {
    throw new Error("source registry is invalid");
  }
  if (
    registry.repository !== "LucasQuiles/WhatSoup" ||
    registry.pinned_main_revision !== EXPECTED_SOURCE_REGISTRY_REVISION
  ) {
    throw new Error("source registry binding does not match the sealed input");
  }
  return registry;
}

function deriveCounts(
  priorityIssues: readonly OpenIssueRegistry["issues"][number][],
): PriorityClusterInventory["counts"] {
  let P0 = 0;
  let P1 = 0;
  let inProgress = 0;
  let patchReady = 0;
  let conflict = 0;
  let unclaimed = 0;
  for (const issue of priorityIssues) {
    if (issue.current_labels.includes("P0")) P0 += 1;
    if (issue.current_labels.includes("P1")) P1 += 1;
    const claimed = issue.current_labels.includes("IN PROGRESS");
    const ready = issue.current_labels.includes("PATCH READY");
    if (claimed && ready) conflict += 1;
    else if (claimed) inProgress += 1;
    else if (ready) patchReady += 1;
    else unclaimed += 1;
  }
  return {
    P0,
    P1,
    total: priorityIssues.length,
    in_progress: inProgress,
    patch_ready: patchReady,
    conflict,
    unclaimed,
    clusters: Object.keys(CLUSTER_MEMBERS).length,
  };
}

export function parsePriorityClusterInventory(
  value: unknown,
): PriorityClusterInventory {
  return priorityClusterInventorySchema.parse(value);
}

export function buildPriorityClusterInventory(
  registryText: string,
): PriorityClusterInventory {
  const registry = parseSealedRegistry(registryText);
  const priorityIssues = registry.issues
    .filter(
      (issue) =>
        issue.current_labels.includes("P0") ||
        issue.current_labels.includes("P1"),
    )
    .sort((left, right) => left.issue_number - right.issue_number);
  const clusters = Object.entries(CLUSTER_MEMBERS).map(
    ([id, memberIssueNumbers]) => ({
      id,
      member_issue_numbers: [...memberIssueNumbers],
    }),
  );
  const assigned = clusters
    .flatMap((cluster) => cluster.member_issue_numbers)
    .sort((left, right) => left - right);
  const expected = priorityIssues.map((issue) => issue.issue_number);
  if (
    assigned.length !== new Set(assigned).size ||
    assigned.length !== expected.length ||
    assigned.some((issueNumber, index) => issueNumber !== expected[index])
  ) {
    throw new Error(
      "curated cluster membership does not exactly partition P0/P1 issues",
    );
  }
  return parsePriorityClusterInventory({
    schema_version: 1,
    repository: "LucasQuiles/WhatSoup",
    source_registry_artifact_commit:
      EXPECTED_SOURCE_REGISTRY_ARTIFACT_COMMIT,
    source_registry_revision: EXPECTED_SOURCE_REGISTRY_REVISION,
    source_registry_sha256: EXPECTED_SOURCE_REGISTRY_SHA256,
    source_registry_captured_at: registry.generated_at,
    priority_scope: ["P0", "P1"],
    counts: deriveCounts(priorityIssues),
    clusters,
  });
}

export function canonicalPriorityClusterJson(
  inventory: PriorityClusterInventory,
): string {
  const text = `${JSON.stringify(canonicalize(inventory))}\n`;
  assertPublicProjection(PRIORITY_CLUSTER_ARTIFACT, text);
  return text;
}

export function validatePriorityClusterInventory(
  value: unknown,
  registryText: string,
): PriorityClusterInventory {
  const actual = parsePriorityClusterInventory(value);
  const expected = buildPriorityClusterInventory(registryText);
  if (
    canonicalPriorityClusterJson(actual) !==
    canonicalPriorityClusterJson(expected)
  ) {
    throw new Error(
      "priority cluster inventory differs from the sealed projection",
    );
  }
  return actual;
}

export function renderPriorityClusterMarkdown(
  inventory: PriorityClusterInventory,
): string {
  const lines = [
    "# Open issue priority clusters",
    "",
    "> Generated from the sealed open-issue registry. This projection contains only issue numbers, aggregate counts, and reviewed cluster identifiers.",
    "",
    `- Source registry artifact commit: \`${inventory.source_registry_artifact_commit}\``,
    `- Source registry revision: \`${inventory.source_registry_revision}\``,
    `- Source registry SHA-256: \`${inventory.source_registry_sha256}\``,
    `- Source registry captured at: ${inventory.source_registry_captured_at}`,
    "",
    "| P0 | P1 | Total | In progress | Patch ready | Conflict | Unclaimed | Clusters |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|",
    `| ${inventory.counts.P0} | ${inventory.counts.P1} | ${inventory.counts.total} | ${inventory.counts.in_progress} | ${inventory.counts.patch_ready} | ${inventory.counts.conflict} | ${inventory.counts.unclaimed} | ${inventory.counts.clusters} |`,
    "",
    "| Cluster | Issues | Members |",
    "|---|---:|---|",
    ...inventory.clusters.map(
      (cluster) =>
        `| \`${cluster.id}\` | ${cluster.member_issue_numbers.length} | ${cluster.member_issue_numbers
          .map((issueNumber) => `#${issueNumber}`)
          .join(", ")} |`,
    ),
    "",
  ];
  const text = `${lines.join("\n").trimEnd()}\n`;
  assertPublicProjection(PRIORITY_CLUSTER_VIEW, text);
  return text;
}
