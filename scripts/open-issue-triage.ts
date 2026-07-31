import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import { assertNoSecretLike } from "./artifact-redaction.ts";
import { scanTextForPrivateLiterals } from "./publication-guard.ts";
import { scanContentLines } from "./repo-hygiene-guard.ts";
import {
  applyIssueBatch,
  ApplyIssueBatchError,
  issueIdentityMatches,
  validateIssuePlanBatch,
} from "./lib/open-issue-triage/apply.ts";
import { TriagePublicSafetyError } from "./lib/open-issue-triage/body.ts";
import {
  GhCliIssueClient,
  GitHubClientError,
  type GitHubIssueClient,
  type LiveInventory,
  type LiveIssue,
  type RegistryCapture,
} from "./lib/open-issue-triage/github.ts";
import {
  canonicalRegistryJson,
  parseLedger,
  parseRegistry,
  registrySha256,
  sha256,
  validateRegistry,
  type OpenIssueRegistry,
} from "./lib/open-issue-triage/model.ts";
import {
  canonicalPlanJson,
  IssuePlanningError,
  planIssueBatch,
} from "./lib/open-issue-triage/planner.ts";
import {
  applyArtifactTransaction,
  ArtifactTransactionError,
  recoverArtifactTransaction,
} from "./lib/open-issue-triage/artifact-transaction.ts";
import {
  assertRealAncestors,
  identity,
  loadRegistry,
  readUnknownJson,
  renderRegistryMarkdown,
  resolveExistingFile,
  safeRelativePath,
  writeExclusive,
  writeGeneratedView,
} from "./lib/open-issue-triage/cli-artifacts.ts";
import {
  CANONICAL_LEDGER,
  CANONICAL_REGISTRY,
  CliFailure,
  EFFECTS,
  EXPECTED_ORIGIN,
  GENERATED_VIEW,
  PLAN_OUTPUT,
  PUBLICATION_AUDIT,
  REPOSITORY,
  REVIEW_OUTPUT,
  SCHEMA_VERSION,
  SHA40,
  SHA64,
  SNAPSHOT_OUTPUT,
  commandSchema,
  parseArgs,
  type ArtifactHookContext,
  type CliRuntime,
  type CommandName,
  type OutputFormat,
  type SnapshotField,
} from "./lib/open-issue-triage/cli-command.ts";
import { addPublicTriageRow } from "./lib/open-issue-triage/publication-audit.ts";
import {
  bodyFreeRegistrySnapshot,
  materializeRegistryReviewBatch,
  parseRegistryReviewManifest,
  type RegistryReviewManifest,
} from "./lib/open-issue-triage/refresh-manifest.ts";
import {
  parseRegistryReviewBatch,
  referencedRepositoryNumbers,
  reconcileRegistry,
  type RefreshClosedIssue,
  type RefreshIssue,
  type RefreshPullRequest,
} from "./lib/open-issue-triage/reconcile.ts";
import { isRecord } from "../src/lib/type-guards.ts";

export { commandSchema, parseArgs, renderRegistryMarkdown };
export type { ArtifactHookContext, CliRuntime };

interface PlanSummary {
  issueNumber: number;
  issueNodeId: string;
  repository: string;
  expectedMainSha: string;
  planSha256: string;
  desired: { titleSha256: string; bodySha256: string; labels: string[] };
  before: { titleSha256: string; bodySha256: string; labels: string[] };
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const observed = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new CliFailure(
      2,
      "plan-schema-invalid",
      `${label} has unknown or missing fields`,
      "Regenerate the plan using issue dry-run.",
    );
  }
}

function stringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new CliFailure(
      2,
      "plan-schema-invalid",
      `${label} must be a string array`,
      "Regenerate the plan using issue dry-run.",
    );
  }
  return [...value];
}

function parsePlanSummaries(value: unknown): PlanSummary[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CliFailure(
      2,
      "plan-schema-invalid",
      "Plan must be a nonempty array",
      "Regenerate the plan using issue dry-run.",
    );
  }
  const summaries = value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new CliFailure(
        2,
        "plan-schema-invalid",
        `plan[${index}] must be an object`,
        "Regenerate the plan using issue dry-run.",
      );
    }
    const plan = entry;
    exactKeys(
      plan,
      [
        "schema_version",
        "repository",
        "issue_number",
        "issue_node_id",
        "expected_main_sha",
        "etag",
        "expected_before",
        "managed_block",
        "desired",
        "title_delta",
        "label_delta",
        "body_delta",
        "intent_sha256",
        "registry_sha256",
        "plan_sha256",
        "changed",
      ],
      `plan[${index}]`,
    );
    if (!isRecord(plan.expected_before)) {
      throw new CliFailure(
        2,
        "plan-schema-invalid",
        `plan[${index}].expected_before must be an object`,
        "Regenerate the plan using issue dry-run.",
      );
    }
    const before = plan.expected_before;
    if (!isRecord(plan.desired)) {
      throw new CliFailure(
        2,
        "plan-schema-invalid",
        `plan[${index}].desired must be an object`,
        "Regenerate the plan using issue dry-run.",
      );
    }
    const desired = plan.desired;
    exactKeys(
      before,
      ["updated_at", "body_sha256", "title_sha256", "labels"],
      `plan[${index}].expected_before`,
    );
    exactKeys(
      desired,
      ["title", "labels", "title_sha256", "body_sha256"],
      `plan[${index}].desired`,
    );
    if (
      plan.schema_version !== 1 ||
      plan.repository !== REPOSITORY ||
      !Number.isSafeInteger(plan.issue_number) ||
      typeof plan.expected_main_sha !== "string" ||
      !SHA40.test(plan.expected_main_sha) ||
      typeof plan.plan_sha256 !== "string" ||
      !SHA64.test(plan.plan_sha256) ||
      typeof before.title_sha256 !== "string" ||
      !SHA64.test(before.title_sha256) ||
      typeof before.body_sha256 !== "string" ||
      !SHA64.test(before.body_sha256) ||
      typeof desired.title_sha256 !== "string" ||
      !SHA64.test(desired.title_sha256) ||
      typeof desired.body_sha256 !== "string" ||
      !SHA64.test(desired.body_sha256)
    ) {
      throw new CliFailure(
        2,
        "plan-schema-invalid",
        `plan[${index}] has invalid scalar fields`,
        "Regenerate the plan using issue dry-run.",
      );
    }
    return {
      issueNumber: plan.issue_number as number,
      issueNodeId: plan.issue_node_id as string,
      repository: plan.repository as string,
      expectedMainSha: plan.expected_main_sha,
      planSha256: plan.plan_sha256,
      desired: {
        titleSha256: desired.title_sha256,
        bodySha256: desired.body_sha256,
        labels: stringArray(desired.labels, `plan[${index}].desired.labels`),
      },
      before: {
        titleSha256: before.title_sha256,
        bodySha256: before.body_sha256,
        labels: stringArray(
          before.labels,
          `plan[${index}].expected_before.labels`,
        ),
      },
    };
  });
  if (
    summaries.some(
      (summary, index) =>
        index > 0 && summaries[index - 1]!.issueNumber >= summary.issueNumber,
    )
  ) {
    throw new CliFailure(
      2,
      "plan-schema-invalid",
      "Plan issue numbers must be sorted and unique",
      "Regenerate the plan using issue dry-run.",
    );
  }
  if (
    new Set(summaries.map((summary) => summary.expectedMainSha)).size !== 1 ||
    new Set(summaries.map((summary) => summary.planSha256)).size !== 1
  ) {
    throw new CliFailure(
      2,
      "plan-schema-invalid",
      "Plan batch hashes or main revisions disagree",
      "Regenerate the complete plan batch.",
    );
  }
  return summaries;
}

function assertPlanTrackedClean(
  root: string,
  relativePath: string,
  runtime: CliRuntime,
): string {
  if (!PLAN_OUTPUT.test(relativePath)) {
    throw new CliFailure(
      4,
      "unsafe-plan-path",
      "Apply plan is outside docs/triage/plans",
      "Use a reviewed plan in the canonical tracked subtree.",
    );
  }
  const tracked = runtime.git(
    ["ls-files", "--error-unmatch", "--", relativePath],
    root,
  );
  if (tracked.status !== 0 || tracked.stdout.trim() !== relativePath) {
    throw new CliFailure(
      4,
      "plan-untracked",
      "Apply plan is not proven tracked",
      "Commit the reviewed plan before apply.",
    );
  }
  const worktree = runtime.git(["diff", "--quiet", "--", relativePath], root);
  const index = runtime.git(
    ["diff", "--cached", "--quiet", "--", relativePath],
    root,
  );
  if (worktree.status !== 0 || index.status !== 0) {
    throw new CliFailure(
      4,
      "plan-dirty",
      "Apply plan differs in the index or worktree",
      "Commit the exact reviewed plan before apply.",
    );
  }
  return resolveExistingFile(root, relativePath, "plan");
}

function assertTrackedCleanFile(
  root: string,
  relativePath: string,
  label: string,
  runtime: CliRuntime,
): string {
  const tracked = runtime.git(
    ["ls-files", "--error-unmatch", "--", relativePath],
    root,
  );
  if (tracked.status !== 0 || tracked.stdout.trim() !== relativePath) {
    throw new CliFailure(
      4,
      `${label}-untracked`,
      `${label} is not proven tracked`,
      `Commit the exact ${label} before registry reconciliation.`,
    );
  }
  const worktree = runtime.git(["diff", "--quiet", "--", relativePath], root);
  const index = runtime.git(
    ["diff", "--cached", "--quiet", "--", relativePath],
    root,
  );
  if (worktree.status !== 0 || index.status !== 0) {
    throw new CliFailure(
      4,
      `${label}-dirty`,
      `${label} differs in the index or worktree`,
      `Commit the exact ${label} before registry reconciliation.`,
    );
  }
  return resolveExistingFile(root, relativePath, label);
}

interface TrackedFileEvidence {
  path: string;
  text: string;
  sha256: string;
  devIno: string;
}

function readTrackedCleanFile(
  root: string,
  relativePath: string,
  label: string,
  runtime: CliRuntime,
): TrackedFileEvidence {
  const path = assertTrackedCleanFile(root, relativePath, label, runtime);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1) {
      throw new CliFailure(
        4,
        `${label}-identity-changed`,
        `${label} is no longer a single-link regular file`,
        `Stop sibling writers and re-prove the exact ${label}.`,
      );
    }
    const text = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor);
    const pathname = lstatSync(path);
    if (
      identity(before) !== identity(after) ||
      identity(after) !== identity(pathname) ||
      after.size !== Buffer.byteLength(text, "utf8")
    ) {
      throw new CliFailure(
        4,
        `${label}-identity-changed`,
        `${label} changed while it was being read`,
        `Stop sibling writers and re-prove the exact ${label}.`,
      );
    }
    const reprovedPath = assertTrackedCleanFile(
      root,
      relativePath,
      label,
      runtime,
    );
    if (reprovedPath !== path) {
      throw new CliFailure(
        4,
        `${label}-identity-changed`,
        `${label} resolved to a different path after its cleanliness proof`,
        `Stop sibling writers and re-prove the exact ${label}.`,
      );
    }
    return {
      path,
      text,
      sha256: sha256(text),
      devIno: identity(after),
    };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readReviewManifest(
  root: string,
  relativePath: string,
  runtime: CliRuntime,
): {
  manifest: RegistryReviewManifest;
  batch: ReturnType<typeof materializeRegistryReviewBatch>;
  text: string;
} {
  if (!REVIEW_OUTPUT.test(relativePath)) {
    throw new CliFailure(
      4,
      "unsafe-review-path",
      "Review manifest is outside docs/triage/reviews",
      "Use a committed JSON manifest in the canonical review subtree.",
    );
  }
  const manifestEvidence = readTrackedCleanFile(
    root,
    relativePath,
    "review-manifest",
    runtime,
  );
  const text = manifestEvidence.text;
  if (Buffer.byteLength(text, "utf8") > 16 * 1024 * 1024) {
    throw new CliFailure(
      2,
      "review-manifest-too-large",
      "Review manifest exceeds the fixed byte budget",
      "Split the review into a bounded committed batch.",
    );
  }
  let manifest: RegistryReviewManifest;
  try {
    const value = JSON.parse(text) as unknown;
    manifest = parseRegistryReviewManifest(value);
  } catch {
    throw new CliFailure(
      2,
      "review-manifest-invalid",
      "Review manifest violates the strict schema",
      "Regenerate the body-free manifest and commit its exact record set.",
    );
  }
  const recordTexts = new Map<string, string>();
  for (const record of manifest.record_files) {
    const recordText = readTrackedCleanFile(
      root,
      record.path,
      "review-record",
      runtime,
    ).text;
    if (Buffer.byteLength(recordText, "utf8") > 4 * 1024 * 1024) {
      throw new CliFailure(
        2,
        "review-record-too-large",
        `Review record #${record.issue_number} exceeds the fixed byte budget`,
        "Regenerate the body-free evidence record without unbounded content.",
      );
    }
    recordTexts.set(record.path, recordText);
  }
  try {
    return {
      manifest,
      batch: materializeRegistryReviewBatch(manifest, recordTexts),
      text,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const drift =
      message.includes("digest mismatch") ||
      message.includes("file is missing") ||
      message.includes("file set does not match");
    throw new CliFailure(
      drift ? 3 : 2,
      drift ? "review-record-drift" : "review-record-invalid",
      drift
        ? "A review record no longer matches the manifest"
        : "A review record is not valid JSON with the declared issue identity",
      drift
        ? "Restore or regenerate the exact committed review record set."
        : "Regenerate the strict body-free review record and manifest.",
    );
  }
}

function gitOutput(
  runtime: CliRuntime,
  root: string,
  args: string[],
  kind: string,
): string {
  const result = runtime.git(args, root);
  if (result.status !== 0 || result.stdout.trim().length === 0) {
    throw new CliFailure(
      4,
      kind,
      "A required local Git estate fact could not be proven",
      "Inspect the origin, tracking refs, common directory, and repository state before retrying.",
    );
  }
  return result.stdout.trim();
}

async function assertMainAgreement(
  root: string,
  runtime: CliRuntime,
  client: GitHubIssueClient,
  expectedMainOid: string,
): Promise<void> {
  const origin = gitOutput(
    runtime,
    root,
    ["remote", "get-url", "origin"],
    "origin-unavailable",
  );
  if (origin !== EXPECTED_ORIGIN) {
    throw new CliFailure(
      4,
      "origin-mismatch",
      "Origin is not the required WhatSoup SSH remote",
      `Set origin to ${EXPECTED_ORIGIN} before any remote reconciliation read.`,
    );
  }
  const tracking = gitOutput(
    runtime,
    root,
    ["rev-parse", "refs/remotes/origin/main"],
    "tracking-main-unavailable",
  );
  if (tracking !== expectedMainOid) {
    throw new CliFailure(
      3,
      "main-revision-disagreement",
      "Tracking origin/main differs from the requested main revision",
      "Fetch origin/main and regenerate evidence on the exact tracking revision.",
      false,
      { tracking_matches: false },
    );
  }
  const remoteResult = runtime.git(
    ["ls-remote", "--exit-code", "origin", "refs/heads/main"],
    root,
  );
  if (remoteResult.status !== 0 || remoteResult.stdout.trim().length === 0) {
    throw new CliFailure(
      6,
      "remote-main-unavailable",
      "The SSH remote main revision could not be read",
      "Verify SSH authentication and GitHub availability before retrying.",
      true,
    );
  }
  const remoteLine = remoteResult.stdout.trim();
  const remoteMatch = /^([0-9a-f]{40})\trefs\/heads\/main$/.exec(remoteLine);
  const apiMain = await client.readMainSha();
  if (remoteMatch?.[1] !== expectedMainOid || apiMain !== expectedMainOid) {
    throw new CliFailure(
      3,
      "main-revision-disagreement",
      "SSH origin, tracking main, remote main, API main, and requested main do not agree",
      "Fetch origin/main, inspect the complete estate, and regenerate evidence on one exact revision.",
      false,
      {
        origin_matches: true,
        tracking_matches: true,
        remote_matches: remoteMatch?.[1] === expectedMainOid,
        api_matches: apiMain === expectedMainOid,
      },
    );
  }
}

interface RegistryCaptureClient extends GitHubIssueClient {
  readRegistryCapture(
    previouslyOpenPrNumbers: number[],
  ): Promise<RegistryCapture>;
}

function registryCaptureClient(
  client: GitHubIssueClient,
): RegistryCaptureClient {
  if (
    !("readRegistryCapture" in client) ||
    typeof client.readRegistryCapture !== "function"
  ) {
    throw new CliFailure(
      1,
      "capture-adapter-unavailable",
      "The selected GitHub client cannot produce a complete registry capture",
      "Use the bounded GitHub CLI registry-capture adapter.",
    );
  }
  return client as RegistryCaptureClient;
}

function previousPullRequestNumbers(registry: OpenIssueRegistry): number[] {
  const numbers = new Set<number>();
  for (const issue of registry.issues) {
    if (issue.pull_request_owner_pr_number !== null) {
      numbers.add(issue.pull_request_owner_pr_number);
    }
    for (const overlap of issue.pull_request_overlaps) {
      if (overlap.disposition === "open") numbers.add(overlap.number);
    }
  }
  return [...numbers].sort((left, right) => left - right);
}

function exactCapture(left: RegistryCapture, right: RegistryCapture): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function publicGitRef(value: string | null): string | null {
  if (value === null) return null;
  if (
    scanTextForPrivateLiterals("docs/triage/open-issue-registry.json", value)
      .length > 0 ||
    scanContentLines([
      {
        filePath: "docs/triage/open-issue-registry.json",
        line: 1,
        text: value,
      },
    ]).length > 0
  ) {
    return null;
  }
  try {
    assertNoSecretLike(value, "pull request ref");
  } catch {
    return null;
  }
  return value;
}

function publicPullRequestTitle(number: number, value: string): string {
  const withheld = `Pull request #${number} (title withheld by publication policy)`;
  if (
    scanTextForPrivateLiterals("docs/triage/open-issue-registry.json", value)
      .length > 0 ||
    scanContentLines([
      {
        filePath: "docs/triage/open-issue-registry.json",
        line: 1,
        text: value,
      },
    ]).length > 0
  ) {
    return withheld;
  }
  try {
    assertNoSecretLike(value, "pull request title");
  } catch {
    return withheld;
  }
  return value;
}

function refreshIssues(capture: RegistryCapture): RefreshIssue[] {
  return capture.issues.map((issue) => ({
    issueNumber: issue.number,
    issueNodeId: issue.nodeId,
    title: issue.title,
    url: issue.url,
    updatedAt: issue.updatedAt,
    body: issue.body,
    labels: [...issue.labels],
  }));
}

function refreshPullRequests(capture: RegistryCapture): RefreshPullRequest[] {
  return capture.pullRequests.map((pullRequest) => ({
    number: pullRequest.number,
    title: publicPullRequestTitle(pullRequest.number, pullRequest.title),
    referenceNumbers: referencedRepositoryNumbers(
      `${pullRequest.title}\n${pullRequest.body}`,
    ),
    url: pullRequest.url,
    updatedAt: pullRequest.updatedAt,
    disposition: pullRequest.disposition,
    isDraft: pullRequest.isDraft,
    headRef: publicGitRef(pullRequest.headRefName),
    baseRef: publicGitRef(pullRequest.baseRefName),
    changedPaths: [...pullRequest.files],
    closingIssueNumbers: [...pullRequest.closingIssueNumbers],
  }));
}

function exactLiveIssue(left: LiveIssue, right: LiveIssue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function readClosedIssues(
  client: GitHubIssueClient,
  oldRegistry: OpenIssueRegistry,
  capture: RegistryCapture,
): Promise<{ first: LiveIssue[]; closed: RefreshClosedIssue[] }> {
  const openNumbers = new Set(capture.issues.map((issue) => issue.number));
  const removedNumbers = oldRegistry.issues
    .map((issue) => issue.issue_number)
    .filter((number) => !openNumbers.has(number));
  const first: LiveIssue[] = [];
  const closed: RefreshClosedIssue[] = [];
  for (const number of removedNumbers) {
    const issue = (await client.readIssue(number)).issue;
    if (issue.state !== "closed" || issue.isPullRequest) {
      throw new CliFailure(
        3,
        "removed-issue-state-drift",
        `Issue #${number} is absent from the open inventory without exact closed-issue evidence`,
        "Refresh the complete inventory and review the issue transition.",
      );
    }
    first.push(issue);
    closed.push({
      issueNumber: issue.number,
      issueNodeId: issue.nodeId,
      url: issue.url,
      updatedAt: issue.updatedAt,
      body: issue.body,
      state: "closed",
    });
  }
  return { first, closed };
}

async function stableRegistryCapture(
  client: GitHubIssueClient,
  registry: OpenIssueRegistry,
): Promise<{ capture: RegistryCapture; closedIssues: RefreshClosedIssue[] }> {
  const captureClient = registryCaptureClient(client);
  const priorPullRequests = previousPullRequestNumbers(registry);
  const first = await captureClient.readRegistryCapture(priorPullRequests);
  const second = await captureClient.readRegistryCapture(priorPullRequests);
  if (!exactCapture(first, second)) {
    throw new CliFailure(
      3,
      "registry-capture-drift",
      "Repeated complete registry captures disagree",
      "Wait for the issue and pull-request estate to stabilize, then re-review changed evidence.",
    );
  }
  const closed = await readClosedIssues(client, registry, second);
  for (const issue of closed.first) {
    const reread = (await client.readIssue(issue.number)).issue;
    if (!exactLiveIssue(issue, reread)) {
      throw new CliFailure(
        3,
        "closed-issue-capture-drift",
        `Closed issue #${issue.number} changed during capture`,
        "Re-review the exact closed-issue state before retrying.",
      );
    }
  }
  const final = await captureClient.readRegistryCapture(priorPullRequests);
  if (!exactCapture(second, final)) {
    throw new CliFailure(
      3,
      "registry-capture-drift",
      "Final complete registry capture differs from the reviewed capture",
      "Wait for the estate to stabilize and refresh changed evidence.",
    );
  }
  for (const issue of closed.first) {
    const reread = (await client.readIssue(issue.number)).issue;
    if (!exactLiveIssue(issue, reread)) {
      throw new CliFailure(
        3,
        "closed-issue-capture-drift",
        `Closed issue #${issue.number} changed after final capture`,
        "Re-review the exact closed-issue state before retrying.",
      );
    }
  }
  return { capture: final, closedIssues: closed.closed };
}

function gitCommonDirectory(root: string, runtime: CliRuntime): string {
  const common = gitOutput(
    runtime,
    root,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    "git-common-dir-unavailable",
  );
  if (!isAbsolute(common)) {
    throw new CliFailure(
      4,
      "git-common-dir-invalid",
      "Git common directory is not absolute",
      "Repair the worktree metadata before retrying.",
    );
  }
  let stat: Stats;
  try {
    stat = lstatSync(common);
  } catch {
    throw new CliFailure(
      4,
      "git-common-dir-invalid",
      "Git common directory does not exist",
      "Repair the worktree metadata before retrying.",
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CliFailure(
      4,
      "git-common-dir-invalid",
      "Git common directory is not a real directory",
      "Repair the worktree metadata before retrying.",
    );
  }
  return realpathSync(common);
}

function reconcileOperationPaths(snapshotPath: string): string[] {
  return [
    CANONICAL_REGISTRY,
    GENERATED_VIEW,
    PUBLICATION_AUDIT,
    snapshotPath,
  ].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

function reconcileAuthorizationDigest(input: {
  expectedMainOid: string;
  idempotencyKey: string;
  reviewManifestSha256: string;
  snapshotPath: string;
}): string {
  return sha256(
    canonicalJson({
      schema_version: 1,
      repository: REPOSITORY,
      expected_main_oid: input.expectedMainOid,
      idempotency_key: input.idempotencyKey,
      review_manifest_sha256: input.reviewManifestSha256,
      operation_paths: reconcileOperationPaths(input.snapshotPath),
    }),
  );
}

function assertNoPendingReconcileJournal(commonDirectory: string): void {
  const journalPath = join(
    commonDirectory,
    "open-issue-triage-registry-reconcile.journal.json",
  );
  for (const path of [journalPath, `${journalPath}.candidate`]) {
    try {
      lstatSync(path);
      throw new CliFailure(
        5,
        "pending-registry-transaction",
        "A registry reconciliation journal requires exact write recovery",
        "Preserve all transaction artifacts and rerun the exact confirmed --write command.",
      );
    } catch (error) {
      if (error instanceof CliFailure) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new CliFailure(
          5,
          "pending-registry-transaction-unknown",
          "Registry reconciliation journal state cannot be proven absent",
          "Inspect the Git common-directory transaction artifacts before proceeding.",
        );
      }
    }
  }
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function snapshotDocument(
  mainOid: string,
  inventory: LiveInventory,
  fields: readonly SnapshotField[],
  limit: number,
): Record<string, unknown> {
  const output: Record<string, unknown> = {
    schema_version: 1,
    fields,
  };
  const truncated: Record<string, boolean> = {};
  const arrays: Partial<Record<SnapshotField, unknown[]>> = {
    labels: inventory.labels,
    open_issue_numbers: inventory.openIssueNumbers,
    open_pull_requests: inventory.openPullRequests,
  };
  for (const field of fields) {
    if (field in arrays) {
      const values = arrays[field]!;
      output[field] = values.slice(0, limit);
      truncated[field] = values.length > limit;
      continue;
    }
    if (field === "main_oid") output[field] = mainOid;
    if (field === "repository") output[field] = inventory.repository;
    if (field === "counts") output[field] = inventory.counts;
    if (field === "pagination") output[field] = inventory.pagination;
  }
  output.truncated = truncated;
  return output;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

function issueState(
  issue: LiveIssue,
  summary: PlanSummary,
): "desired" | "before" | "third-state" {
  if (
    !issueIdentityMatches(issue, {
      issue_number: summary.issueNumber,
      issue_node_id: summary.issueNodeId,
      repository: summary.repository,
    })
  ) {
    return "third-state";
  }
  const titleHash = sha256(issue.title);
  const bodyHash = sha256(issue.body);
  const labels = [...issue.labels].sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right)),
  );
  if (
    titleHash === summary.desired.titleSha256 &&
    bodyHash === summary.desired.bodySha256 &&
    sameStrings(labels, summary.desired.labels)
  )
    return "desired";
  if (
    titleHash === summary.before.titleSha256 &&
    bodyHash === summary.before.bodySha256 &&
    sameStrings(labels, summary.before.labels)
  )
    return "before";
  return "third-state";
}

function defaultRuntime(): CliRuntime {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    isTTY: process.stdout.isTTY,
    now: () => new Date().toISOString(),
    delay: async (milliseconds) =>
      new Promise((resolveDelay) => {
        setTimeout(resolveDelay, milliseconds);
      }),
    git: (args, cwd) => {
      const result = spawnSync("git", args, {
        cwd,
        encoding: "utf8",
        shell: false,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      return {
        status: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    },
  };
}

function successDocument(
  command: CommandName,
  summary: Record<string, unknown>,
  warnings: string[] = [],
): Record<string, unknown> {
  return {
    schema_version: SCHEMA_VERSION,
    ok: true,
    command,
    effects: EFFECTS[command],
    summary,
    warnings,
  };
}

function emitSuccess(
  runtime: CliRuntime,
  format: OutputFormat,
  document: Record<string, unknown>,
): void {
  if (format === "json") {
    runtime.stdout(`${JSON.stringify(document)}\n`);
    return;
  }
  const command = String(document.command);
  const summary = document.summary as Record<string, unknown>;
  runtime.stdout(`${command}: ${String(summary.status ?? "ok")}\n`);
}

function normalizeFailure(error: unknown): CliFailure {
  if (error instanceof CliFailure) return error;
  if (error instanceof ApplyIssueBatchError) {
    return new CliFailure(
      error.exitClass,
      error.code,
      "Issue apply did not reach a fully verified durable result",
      error.retryable
        ? "Re-read the plan before an explicit retry."
        : "Follow the receipt recovery runbook before any retry.",
      error.retryable,
      { issue_number: error.issueNumber },
    );
  }
  if (error instanceof GitHubClientError) {
    return new CliFailure(
      6,
      error.code,
      "GitHub access failed before a verified mutation result",
      "Verify CLI authentication, API availability, and rate limits, then re-read before retrying.",
      error.retryable,
      { operation: error.operation },
    );
  }
  if (error instanceof IssuePlanningError) {
    if (
      error.code === "render-failed" &&
      error.cause instanceof TriagePublicSafetyError
    ) {
      return new CliFailure(
        4,
        "public-safety-rejection",
        "The live issue content cannot be rendered into a PUBLIC review safely",
        "Remove or sanitize private runtime identifiers before regenerating the plan.",
        false,
        { issue_number: error.issueNumber },
      );
    }
    return new CliFailure(
      3,
      error.code,
      "Live state no longer matches the pinned registry preconditions",
      "Refresh evidence and regenerate the registry or plan.",
      false,
      { issue_number: error.issueNumber },
    );
  }
  if (error instanceof ArtifactTransactionError) {
    const ambiguous =
      new Set([
        "durability-failed",
        "mutation-outcome-unknown",
        "post-write-verification-failed",
        "journal-removal-failed",
      ]).has(error.code) || error.recoveryPacket !== undefined;
    const policy = new Set([
      "invalid-input",
      "unsafe-path",
      "lock-unavailable",
      "lock-identity-changed",
      "journal-malformed",
      "candidate-invalid",
    ]).has(error.code);
    const packet = error.recoveryPacket;
    return new CliFailure(
      ambiguous ? 5 : policy ? 4 : 3,
      `artifact-transaction-${error.code}`,
      ambiguous
        ? "Registry artifact transaction outcome requires recovery"
        : "Registry artifact transaction did not satisfy its preconditions",
      "Preserve the common-directory journal and candidates; rerun only with the exact confirmed manifest and idempotency key.",
      error.code === "lock-unavailable",
      packet === undefined
        ? {}
        : {
            recovery_transaction_id: packet.transactionId,
            recovery_journal_path: packet.journalPath,
            recovery_paths: packet.paths.slice(0, 20),
            recovery_paths_truncated: packet.paths.length > 20,
          },
    );
  }
  return new CliFailure(
    1,
    "internal-invariant",
    "The triage command failed an internal invariant",
    "Inspect local logs and rerun the deterministic offline checks before proceeding.",
  );
}

function emitFailure(runtime: CliRuntime, failure: CliFailure): void {
  const details = Object.fromEntries(
    Object.entries(failure.details).slice(0, 20),
  );
  runtime.stderr(
    `${JSON.stringify({
      schema_version: SCHEMA_VERSION,
      ok: false,
      kind: failure.kind.slice(0, 128),
      message: failure.message.slice(0, 512),
      hint: failure.hint.slice(0, 512),
      retryable: failure.retryable,
      details,
    })}\n`,
  );
}

export async function run(
  argv: string[],
  root = process.cwd(),
  injectedClient?: GitHubIssueClient,
  injectedRuntime?: CliRuntime,
): Promise<number> {
  const runtime = injectedRuntime ?? defaultRuntime();
  try {
    const command = parseArgs(argv);
    if (command.name === "schema") {
      const schema = commandSchema(command.schemaCommand);
      emitSuccess(runtime, command.format, {
        ...successDocument("schema", {
          status: "schema",
          command_count: (schema.commands as unknown[]).length,
        }),
        ...schema,
      });
      return 0;
    }

    if (command.name === "registry reconcile --write") {
      if (command.registry !== CANONICAL_REGISTRY) {
        throw new CliFailure(
          4,
          "noncanonical-registry-path",
          "Registry reconciliation only updates the canonical registry",
          `Use --registry ${CANONICAL_REGISTRY}.`,
        );
      }
      const manifestEvidence = readTrackedCleanFile(
        root,
        command.reviews,
        "review-manifest",
        runtime,
      );
      const reviewSha256 = sha256(manifestEvidence.text);
      if (command.confirmReviewSha256 !== reviewSha256) {
        throw new CliFailure(
          3,
          "confirmed-review-digest-mismatch",
          "Confirmed review digest differs from the committed manifest bytes",
          "Re-read the committed manifest and pass its exact byte SHA-256.",
        );
      }
      const commonDirectory = gitCommonDirectory(root, runtime);
      const lockPath = join(
        commonDirectory,
        "open-issue-triage-registry-reconcile.lock",
      );
      const journalPath = join(
        commonDirectory,
        "open-issue-triage-registry-reconcile.journal.json",
      );
      const authorizationDigest = reconcileAuthorizationDigest({
        expectedMainOid: command.expectedMainOid,
        idempotencyKey: command.idempotencyKey!,
        reviewManifestSha256: reviewSha256,
        snapshotPath: command.snapshot,
      });
      try {
        const recovered = recoverArtifactTransaction({
          root: realpathSync(root),
          lockPath,
          journalPath,
          authorizationDigest,
          expectedOperationPaths: reconcileOperationPaths(command.snapshot),
          interruptionHook: runtime.registryTransactionHook,
        });
        emitSuccess(
          runtime,
          command.format,
          successDocument(command.name, {
            status: "recovered",
            review_manifest_sha256: reviewSha256,
            snapshot_path: command.snapshot,
            operation_id: command.idempotencyKey,
            transaction: {
              transaction_id: recovered.transactionId,
              recovered: recovered.recovered,
              operation_count: recovered.operationCount,
            },
          }),
        );
        return 0;
      } catch (error) {
        if (
          !(error instanceof ArtifactTransactionError) ||
          error.code !== "journal-state-conflict" ||
          error.recoveryPacket !== undefined
        ) {
          throw error;
        }
      }
    }

    const { registry, value: registryValue } = loadRegistry(
      root,
      command.registry,
    );
    const rendered = renderRegistryMarkdown(registry);
    if (command.name === "check" || command.name === "render --check") {
      const ledger = resolveExistingFile(root, CANONICAL_LEDGER, "ledger");
      try {
        parseLedger(readFileSync(ledger, "utf8"));
      } catch {
        throw new CliFailure(
          2,
          "ledger-invalid",
          "Receipt ledger validation failed",
          "Follow the ledger recovery runbook before continuing.",
        );
      }
      const view = resolveExistingFile(root, GENERATED_VIEW, "generated view");
      if (readFileSync(view, "utf8") !== rendered) {
        throw new CliFailure(
          1,
          "generated-view-drift",
          "Generated registry Markdown differs byte-for-byte",
          "Run render --write, inspect the diff, and commit it with the registry.",
        );
      }
      emitSuccess(
        runtime,
        command.format,
        successDocument(command.name, {
          status: "verified",
          issue_count: registry.issues.length,
          registry_sha256: registrySha256(registry),
        }),
      );
      return 0;
    }
    if (command.name === "render --write") {
      resolveExistingFile(root, CANONICAL_LEDGER, "ledger");
      writeGeneratedView(root, rendered, runtime);
      emitSuccess(
        runtime,
        command.format,
        successDocument(command.name, {
          status: "written",
          artifact_path: GENERATED_VIEW,
          issue_count: registry.issues.length,
        }),
      );
      return 0;
    }

    const client = injectedClient ?? new GhCliIssueClient();
    if (
      command.name === "registry reconcile --check" ||
      command.name === "registry reconcile --write"
    ) {
      if (command.registry !== CANONICAL_REGISTRY) {
        throw new CliFailure(
          4,
          "noncanonical-registry-path",
          "Registry reconciliation only updates the canonical registry",
          `Use --registry ${CANONICAL_REGISTRY}.`,
        );
      }
      const reconcileCommonDirectory = gitCommonDirectory(root, runtime);
      assertNoPendingReconcileJournal(reconcileCommonDirectory);
      const registryEvidence = readTrackedCleanFile(
        root,
        command.registry,
        "registry",
        runtime,
      );
      if (registryEvidence.text !== canonicalRegistryJson(registry)) {
        throw new CliFailure(
          3,
          "registry-read-drift",
          "Canonical registry bytes changed after initial validation",
          "Stop sibling writers and restart reconciliation from one committed registry.",
        );
      }
      const viewEvidence = readTrackedCleanFile(
        root,
        GENERATED_VIEW,
        "generated-view",
        runtime,
      );
      if (viewEvidence.text !== renderRegistryMarkdown(registry)) {
        throw new CliFailure(
          3,
          "generated-view-before-state-drift",
          "Committed generated view does not match the source registry",
          "Repair and commit the source registry view before reconciliation.",
        );
      }
      const auditEvidence = readTrackedCleanFile(
        root,
        PUBLICATION_AUDIT,
        "publication-audit",
        runtime,
      );
      const review = readReviewManifest(root, command.reviews, runtime);
      try {
        review.batch = parseRegistryReviewBatch(
          review.batch,
          registry,
          command.expectedMainOid,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const publicSafety =
          message.startsWith("PUBLIC review batch rejected:") ||
          message.startsWith("PUBLIC registry rejected:") ||
          message.startsWith("redaction_violation:");
        const reviewPrecondition =
          /main revision does not match|requested (?:target )?pin|source registry digest|source record digest|source identity|cross-main review coverage|review repin|conflicts with the source registry|not in the source registry/i.test(
            message,
          );
        throw new CliFailure(
          publicSafety ? 4 : reviewPrecondition ? 3 : 2,
          publicSafety
            ? "review-public-safety-rejection"
            : reviewPrecondition
              ? "review-precondition-failed"
              : "review-record-schema-invalid",
          publicSafety
            ? "The committed review batch violates the PUBLIC artifact policy"
            : reviewPrecondition
              ? "The committed review batch does not match the requested source and target evidence"
              : "A committed review record violates the strict registry schema",
          publicSafety
            ? "Remove private runtime identifiers, secrets, and complete bodies before retrying."
            : reviewPrecondition
              ? "Regenerate the exact digest-bound review contract from the committed source registry."
              : "Regenerate and recommit the exact body-free review record.",
          false,
          reviewPrecondition ? { reason: message.slice(0, 256) } : undefined,
        );
      }
      const reviewSha256 = sha256(review.text);
      if (
        command.name === "registry reconcile --write" &&
        command.confirmReviewSha256 !== reviewSha256
      ) {
        throw new CliFailure(
          3,
          "confirmed-review-digest-mismatch",
          "Confirmed review digest differs from the committed manifest bytes",
          "Re-read the committed manifest and pass its exact byte SHA-256.",
        );
      }
      await assertMainAgreement(root, runtime, client, command.expectedMainOid);
      const stable = await stableRegistryCapture(client, registry);
      await assertMainAgreement(root, runtime, client, command.expectedMainOid);
      const capturedAt = runtime.now();
      let reconciled: ReturnType<typeof reconcileRegistry>;
      try {
        reconciled = reconcileRegistry({
          oldRegistry: registry,
          reviewBatch: review.batch,
          liveIssues: refreshIssues(stable.capture),
          closedIssues: stable.closedIssues,
          openPullRequests: refreshPullRequests(stable.capture),
          labels: [...stable.capture.labels],
          capturedAt,
          expectedMainOid: command.expectedMainOid,
        });
      } catch (error) {
        throw new CliFailure(
          3,
          "registry-review-precondition-failed",
          "The committed review set does not exactly reconcile with the stable live capture",
          "Review the changed issue, pull-request, label, or ownership evidence and commit a new manifest.",
          false,
          {
            reason:
              error instanceof Error
                ? error.message.slice(0, 256)
                : "unknown reconciliation failure",
          },
        );
      }
      const registryText = canonicalRegistryJson(reconciled.registry);
      const viewText = renderRegistryMarkdown(reconciled.registry);
      const auditText = auditEvidence.text;
      let auditCandidate: string;
      try {
        auditCandidate = addPublicTriageRow(
          auditText,
          command.snapshot,
          "Body-free complete registry reconciliation seal bound to the committed review manifest and exact main revision.",
        );
      } catch {
        throw new CliFailure(
          4,
          "snapshot-publication-audit-invalid",
          "The reconciliation snapshot cannot be added to the PUBLIC audit deterministically",
          "Use a new canonical snapshot path and repair the publication audit before retrying.",
        );
      }
      const snapshotParts = safeRelativePath(command.snapshot, "snapshot");
      const snapshotRoot = realpathSync(root);
      const snapshotParent = assertRealAncestors(
        snapshotRoot,
        snapshotParts.slice(0, -1),
      );
      const snapshotAbsolute = join(snapshotParent, snapshotParts.at(-1)!);
      if (existsSync(snapshotAbsolute)) {
        throw new CliFailure(
          3,
          "snapshot-already-exists",
          "The requested immutable reconciliation snapshot already exists",
          "Use a new snapshot path, or preserve pending transaction state for exact recovery.",
        );
      }
      if (command.name === "registry reconcile --check") {
        emitSuccess(
          runtime,
          command.format,
          successDocument(command.name, {
            status: "ready",
            issue_count: reconciled.registry.issues.length,
            added_issue_numbers: reconciled.addedIssueNumbers,
            removed_issue_numbers: reconciled.removedIssueNumbers,
            registry_sha256: registrySha256(reconciled.registry),
            review_manifest_sha256: reviewSha256,
            snapshot_path: command.snapshot,
          }),
        );
        return 0;
      }
      const snapshotText = canonicalJson(
        bodyFreeRegistrySnapshot({
          capture: stable.capture,
          capturedAt,
          mainOid: command.expectedMainOid,
          reviewManifestSha256: reviewSha256,
          idempotencyKey: command.idempotencyKey!,
        }),
      );
      for (const evidence of [
        {
          relativePath: command.registry,
          label: "registry",
          value: registryEvidence,
        },
        {
          relativePath: GENERATED_VIEW,
          label: "generated-view",
          value: viewEvidence,
        },
        {
          relativePath: PUBLICATION_AUDIT,
          label: "publication-audit",
          value: auditEvidence,
        },
      ]) {
        const current = readTrackedCleanFile(
          root,
          evidence.relativePath,
          evidence.label,
          runtime,
        );
        if (
          current.sha256 !== evidence.value.sha256 ||
          current.devIno !== evidence.value.devIno
        ) {
          throw new CliFailure(
            3,
            "artifact-before-state-drift",
            `${evidence.label} changed after candidate construction`,
            "Stop sibling writers, inspect the complete estate, and restart the check.",
          );
        }
      }
      await assertMainAgreement(root, runtime, client, command.expectedMainOid);
      const authorizationDigest = reconcileAuthorizationDigest({
        expectedMainOid: command.expectedMainOid,
        idempotencyKey: command.idempotencyKey!,
        reviewManifestSha256: reviewSha256,
        snapshotPath: command.snapshot,
      });
      const transaction = applyArtifactTransaction({
        root: snapshotRoot,
        lockPath: join(
          reconcileCommonDirectory,
          "open-issue-triage-registry-reconcile.lock",
        ),
        journalPath: join(
          reconcileCommonDirectory,
          "open-issue-triage-registry-reconcile.journal.json",
        ),
        authorizationDigest,
        interruptionHook: runtime.registryTransactionHook,
        operations: [
          {
            path: command.registry,
            expectedBeforeSha256: registryEvidence.sha256,
            desiredText: registryText,
          },
          {
            path: GENERATED_VIEW,
            expectedBeforeSha256: viewEvidence.sha256,
            desiredText: viewText,
          },
          {
            path: PUBLICATION_AUDIT,
            expectedBeforeSha256: auditEvidence.sha256,
            desiredText: auditCandidate,
          },
          {
            path: command.snapshot,
            expectedBeforeSha256: null,
            desiredText: snapshotText,
          },
        ],
      });
      emitSuccess(
        runtime,
        command.format,
        successDocument(command.name, {
          status: "written",
          issue_count: reconciled.registry.issues.length,
          added_issue_numbers: reconciled.addedIssueNumbers,
          removed_issue_numbers: reconciled.removedIssueNumbers,
          registry_sha256: registrySha256(reconciled.registry),
          review_manifest_sha256: reviewSha256,
          snapshot_path: command.snapshot,
          snapshot_sha256: sha256(snapshotText),
          operation_id: command.idempotencyKey,
          transaction: {
            transaction_id: transaction.transactionId,
            recovered: transaction.recovered,
            operation_count: transaction.operationCount,
          },
        }),
      );
      return 0;
    }
    if (command.name === "snapshot") {
      const [mainOid, liveInventory] = await Promise.all([
        client.readMainSha(),
        client.readInventory(),
      ]);
      const snapshot = snapshotDocument(
        mainOid,
        liveInventory,
        command.fields,
        command.limit,
      );
      const text = canonicalJson(snapshot);
      writeExclusive(root, command.output, SNAPSHOT_OUTPUT, text, runtime);
      emitSuccess(
        runtime,
        command.format,
        successDocument(command.name, {
          status: "created",
          artifact_path: command.output,
          artifact_sha256: sha256(text),
          fields: command.fields,
        }),
      );
      return 0;
    }
    if (command.name === "issue dry-run") {
      const plans = await planIssueBatch({
        expectedMainSha: command.expectedMainOid,
        registry,
        targetIssueNumbers: command.issueNumbers,
        client,
      });
      const text = canonicalPlanJson(plans);
      writeExclusive(root, command.output, PLAN_OUTPUT, text, runtime);
      emitSuccess(
        runtime,
        command.format,
        successDocument(command.name, {
          status: "planned",
          artifact_path: command.output,
          plan_sha256: plans[0]!.plan_sha256,
          issue_numbers: plans.map((plan) => plan.issue_number),
          changed_count: plans.filter((plan) => plan.changed).length,
        }),
      );
      return 0;
    }
    if (command.name === "issue apply") {
      const planPath = assertPlanTrackedClean(root, command.plan, runtime);
      const planValue = readUnknownJson(planPath, "plan");
      const summaries = parsePlanSummaries(planValue);
      const issueNumbers = summaries.map((summary) => summary.issueNumber);
      if (
        !sameStrings(
          issueNumbers.map(String),
          command.confirmIssues.map(String),
        )
      ) {
        throw new CliFailure(
          3,
          "confirmed-issues-mismatch",
          "Confirmed issue list differs from the tracked plan",
          "Re-read the tracked plan and pass its exact sorted issue list.",
        );
      }
      if (summaries[0]!.planSha256 !== command.confirmPlanSha256) {
        throw new CliFailure(
          3,
          "confirmed-plan-digest-mismatch",
          "Confirmed plan digest differs from the tracked plan",
          "Re-read the tracked plan and pass its exact canonical digest.",
        );
      }
      const ledgerPath = resolveExistingFile(root, CANONICAL_LEDGER, "ledger");
      const receipts = await applyIssueBatch({
        expectedMainSha: summaries[0]!.expectedMainSha,
        plans: planValue,
        registry: registryValue,
        client,
        ledgerPath,
        now: runtime.now,
        delay: runtime.delay,
        confirmedPlanSha256: command.confirmPlanSha256,
        idempotencyKey: command.idempotencyKey,
      });
      const targetReceipts = receipts.filter(
        (receipt) =>
          receipt.receipt_type === "target_verified" ||
          receipt.receipt_type === "target_unknown",
      );
      emitSuccess(
        runtime,
        command.format,
        successDocument(command.name, {
          status: "verified",
          operation_id: command.idempotencyKey,
          receipt_count: receipts.length,
          issue_results: targetReceipts.map((receipt) => ({
            issue_number: receipt.issue_number,
            result: receipt.operation_result,
            receipt_sha256: receipt.receipt_sha256,
          })),
        }),
      );
      return 0;
    }

    if (command.name !== "issue re-read") {
      throw new CliFailure(
        1,
        "internal-invariant",
        "Parsed command did not reach a command handler",
        "Inspect the command dispatch table before retrying.",
      );
    }
    const planPath = assertPlanTrackedClean(root, command.plan, runtime);
    const validated = validateIssuePlanBatch(
      readUnknownJson(planPath, "plan"),
      registryValue,
    );
    const summaries = validated.plans.map((plan) => ({
      issueNumber: plan.issue_number,
      issueNodeId: plan.issue_node_id,
      repository: plan.repository,
      expectedMainSha: plan.expected_main_sha,
      planSha256: plan.plan_sha256,
      desired: {
        titleSha256: plan.desired.title_sha256,
        bodySha256: plan.desired.body_sha256,
        labels: [...plan.desired.labels],
      },
      before: {
        titleSha256: plan.expected_before.title_sha256,
        bodySha256: plan.expected_before.body_sha256,
        labels: [...plan.expected_before.labels],
      },
    }));
    const mainOid = await client.readMainSha();
    if (mainOid !== summaries[0]!.expectedMainSha) {
      throw new CliFailure(
        3,
        "main-sha-drift",
        "Live main differs from the plan",
        "Refresh evidence and regenerate the plan.",
      );
    }
    const states = [];
    for (const summary of summaries) {
      const issue = (await client.readIssue(summary.issueNumber)).issue;
      states.push({
        issue_number: summary.issueNumber,
        state: issueState(issue, summary),
      });
    }
    emitSuccess(
      runtime,
      command.format,
      successDocument(command.name, {
        status: states.every((state) => state.state === "desired")
          ? "desired"
          : "review-required",
        issues: states,
      }),
    );
    return 0;
  } catch (error) {
    const failure = normalizeFailure(error);
    emitFailure(runtime, failure);
    return failure.exitCode;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const exitCode = await run(process.argv.slice(2));
  process.exitCode = exitCode;
}
