import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  renderRegistryMarkdown,
  run,
  type CliRuntime,
} from "../../scripts/open-issue-triage.ts";
import { assertNoSecretLike } from "../../scripts/artifact-redaction.ts";
import {
  type GitHubIssueClient,
  type GitHubWriteResult,
  type IssuePatch,
  type LiveInventory,
  type LiveIssue,
  type RegistryCapture,
} from "../../scripts/lib/open-issue-triage/github.ts";
import {
  LIVE_LABELS,
  canonicalRegistryJson,
  registrySha256,
  sha256,
  type OpenIssueRegistry,
} from "../../scripts/lib/open-issue-triage/model.ts";
import { scanTextForPrivateLiterals } from "../../scripts/publication-guard.ts";
import { scanContentLines } from "../../scripts/repo-hygiene-guard.ts";

const MAIN_SHA = "b".repeat(40);
const OWNER_BODY = "Owner-authored body.\n";
const REPOSITORY = "LucasQuiles/WhatSoup";
const roots: string[] = [];

function utf8Sort(values: readonly string[]): string[] {
  return [...values].sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right)),
  );
}

function registry(): OpenIssueRegistry {
  return {
    schema_version: 1,
    repository: REPOSITORY,
    generated_at: "2026-07-26T12:30:00Z",
    pinned_main_revision: MAIN_SHA,
    inventory: {
      captured_at: "2026-07-26T12:30:00Z",
      open_issue_count: 1,
      open_pull_request_count: 0,
      draft_pull_request_count: 0,
      label_count: LIVE_LABELS.length,
      labels: utf8Sort(LIVE_LABELS),
    },
    issues: [
      {
        issue_number: 101,
        issue_node_id: "I_kwDOExample101",
        title: "Example finding",
        recommended_title: null,
        url: "https://github.com/LucasQuiles/WhatSoup/issues/101",
        updated_at: "2026-07-26T12:00:00Z",
        pre_review_body_sha256: sha256(OWNER_BODY),
        current_labels: ["bug"],
        recommended_labels: ["bug", "reliability"],
        classification: "leaf",
        evidence_state: "verified",
        pinned_revision: MAIN_SHA,
        decisive_source_paths: ["src/example.ts"],
        decisive_test_paths: ["tests/example.test.ts"],
        evidence_summary: "The production caller does not preserve ownership.",
        falsifier_or_remaining_gap: "Run the focused example test.",
        partial_findings: [],
        suggested_remediation: "Give the operation one durable owner.",
        impact: "Accepted work can be lost.",
        blast_radius: "One runtime path.",
        affected_paths: ["src/example.ts"],
        owner_boundary: "runtime-owner",
        acceptance_criteria: ["The focused ownership test passes."],
        dependency_issue_numbers: [],
        duplicate_of_issue_number: null,
        implementation_after_issue_numbers: [],
        pull_request_overlaps: [],
        proposed_cohort_id: null,
        pull_request_owner_pr_number: null,
        review_confidence: "high",
        lead_verification_obligations: [
          "Re-read the decisive source before mutation.",
        ],
      },
    ],
  };
}

function liveIssue(): LiveIssue {
  return {
    number: 101,
    nodeId: "I_kwDOExample101",
    repository: REPOSITORY,
    url: "https://github.com/LucasQuiles/WhatSoup/issues/101",
    title: "Example finding",
    body: OWNER_BODY,
    labels: ["bug"],
    state: "open",
    updatedAt: "2026-07-26T12:00:00Z",
    isPullRequest: false,
  };
}

function inventory(): LiveInventory {
  return {
    repository: REPOSITORY,
    openIssueNumbers: [101],
    openPullRequests: [],
    labels: utf8Sort(LIVE_LABELS),
    counts: {
      openIssues: 1,
      openPullRequests: 0,
      draftPullRequests: 0,
      labels: LIVE_LABELS.length,
    },
    pagination: {
      issuesComplete: true,
      pullRequestsComplete: true,
      labelsComplete: true,
    },
  };
}

function registryCapture(): RegistryCapture {
  return {
    repository: REPOSITORY,
    issues: [
      {
        number: 101,
        nodeId: "I_kwDOExample101",
        title: "Example finding",
        url: "https://github.com/LucasQuiles/WhatSoup/issues/101",
        body: OWNER_BODY,
        updatedAt: "2026-07-26T12:00:00Z",
        labels: ["bug"],
      },
    ],
    pullRequests: [],
    labels: utf8Sort(LIVE_LABELS),
    pagination: {
      issuesComplete: true,
      pullRequestsComplete: true,
      labelsComplete: true,
      changedFilesComplete: true,
      closingReferencesComplete: true,
    },
  };
}

class FakeClient implements GitHubIssueClient {
  readonly calls: string[] = [];
  capture = registryCapture();

  async readMainSha(): Promise<string> {
    this.calls.push("main");
    return MAIN_SHA;
  }

  async readInventory(): Promise<LiveInventory> {
    this.calls.push("inventory");
    return inventory();
  }

  async readIssue(): Promise<{ issue: LiveIssue; etag: string | null }> {
    this.calls.push("issue:101");
    return { issue: liveIssue(), etag: '"fixture-etag"' };
  }

  async updateIssue(
    _number: number,
    _patch: IssuePatch,
  ): Promise<GitHubWriteResult> {
    throw new Error("unexpected update");
  }

  async readRegistryCapture(): Promise<RegistryCapture> {
    this.calls.push("registry-capture");
    return structuredClone(this.capture);
  }
}

interface Harness {
  stdout: string[];
  stderr: string[];
  runtime: CliRuntime;
}

function harness(git: CliRuntime["git"]): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    runtime: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      now: () => "2026-07-26T14:00:00Z",
      delay: async () => undefined,
      git,
    },
  };
}

function fixtureRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "whatsoup-title-projection-")),
  );
  roots.push(root);
  mkdirSync(join(root, "docs/triage/plans"), { recursive: true });
  mkdirSync(join(root, "docs/triage/reviews"), { recursive: true });
  mkdirSync(join(root, "docs/triage/snapshots"), { recursive: true });
  writeFileSync(
    join(root, "docs/triage/open-issue-registry.json"),
    canonicalRegistryJson(registry()),
  );
  writeFileSync(
    join(root, "docs/triage/open-issue-registry.md"),
    renderRegistryMarkdown(registry()),
  );
  writeFileSync(join(root, "docs/triage/open-issue-review-ledger.jsonl"), "\n");
  writeFileSync(
    join(root, "docs/publication-audit.md"),
    [
      "# Publication Audit",
      "",
      "**Total classification rows:** 4",
      "",
      "| Classification | Count |",
      "|---|---:|",
      "| PUBLIC | 4 |",
      "| PRIVATE-ARCHIVE | 0 |",
      "| SANITIZE | 0 |",
      "| DELETE | 0 |",
      "| Total | 4 |",
      "",
      "| Path | Classification | Rationale |",
      "|---|---|---|",
      "| `docs/triage/open-issue-registry.json` | PUBLIC | Fixture registry. |",
      "| `docs/triage/open-issue-registry.md` | PUBLIC | Fixture view. |",
      "| `docs/triage/open-issue-review-ledger.jsonl` | PUBLIC | Fixture ledger. |",
      "| `docs/triage/reviews/refresh.json` | PUBLIC | Fixture review manifest. |",
      "",
    ].join("\n"),
  );
  return root;
}

function reconcileCheckArgs(): string[] {
  return [
    "registry",
    "reconcile",
    "--check",
    "--registry",
    "docs/triage/open-issue-registry.json",
    "--reviews",
    "docs/triage/reviews/refresh.json",
    "--snapshot",
    "docs/triage/snapshots/reconciled.json",
    "--expected-main-oid",
    MAIN_SHA,
  ];
}

function reconcileGit(root: string): CliRuntime["git"] {
  const commonDirectory = `${root}-git-common`;
  if (!existsSync(commonDirectory)) {
    mkdirSync(commonDirectory);
    roots.push(commonDirectory);
  }
  return (args) => {
    if (args[0] === "remote" && args[1] === "get-url") {
      return {
        status: 0,
        stdout: "git@github.com:LucasQuiles/WhatSoup.git\n",
        stderr: "",
      };
    }
    if (args[0] === "rev-parse" && args.includes("--git-common-dir")) {
      return { status: 0, stdout: `${commonDirectory}\n`, stderr: "" };
    }
    if (args[0] === "rev-parse" && args.at(-1) === "refs/remotes/origin/main") {
      return { status: 0, stdout: `${MAIN_SHA}\n`, stderr: "" };
    }
    if (args[0] === "ls-remote") {
      return {
        status: 0,
        stdout: `${MAIN_SHA}\trefs/heads/main\n`,
        stderr: "",
      };
    }
    if (args[0] === "ls-files") {
      return { status: 0, stdout: `${args.at(-1)!}\n`, stderr: "" };
    }
    if (args[0] === "diff") {
      return { status: 0, stdout: "", stderr: "" };
    }
    return {
      status: 1,
      stdout: "",
      stderr: `unexpected git command: ${args.join(" ")}`,
    };
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    execFileSync("rm", ["-rf", root]);
  }
});

describe("open issue triage pull request title projection", () => {
  it("projects unsafe PR titles while preserving raw reference evidence", async () => {
    const root = fixtureRoot();
    const source = registry();
    const privatePathTitle = [
      "Operator checkout:",
      ["~", "LAB", "Hidden"].join("/"),
    ].join(" ");
    const internalLabelTitle = [
      "Internal workstream",
      ["WS", "8"].join("-"),
    ].join(" ");
    const secretLikeTitle = ["Bearer", "A".repeat(16)].join(" ");
    const titleOnlyEvidence = [privatePathTitle, "references", "#101"].join(
      " ",
    );
    const bodyCanary = "Body content without a repository reference.";
    const bodyOnlyEvidence = "Body-only reference evidence for issue #101.";
    const placeholder = (number: number): string =>
      `Pull request #${number} (title withheld by publication policy)`;
    const publicationCodes = (title: string): string[] =>
      scanTextForPrivateLiterals(
        "docs/triage/open-issue-registry.json",
        title,
      ).map((issue) => issue.code);
    const hygieneCodes = (title: string): string[] =>
      scanContentLines([
        {
          filePath: "docs/triage/open-issue-registry.json",
          line: 1,
          text: title,
        },
      ]).map((issue) => issue.code);

    expect(publicationCodes(privatePathTitle)).toContain("local-home-path");
    expect(hygieneCodes(privatePathTitle)).toEqual([]);
    expect(() =>
      assertNoSecretLike(privatePathTitle, "synthetic pull request title"),
    ).not.toThrow();
    expect(publicationCodes(internalLabelTitle)).toEqual([]);
    expect(hygieneCodes(internalLabelTitle)).toContain(
      "internal-workstream-label",
    );
    expect(() =>
      assertNoSecretLike(internalLabelTitle, "synthetic pull request title"),
    ).not.toThrow();
    expect(publicationCodes(secretLikeTitle)).toEqual([]);
    expect(hygieneCodes(secretLikeTitle)).toEqual([]);
    expect(() =>
      assertNoSecretLike(secretLikeTitle, "synthetic pull request title"),
    ).toThrow(/redaction_violation/);

    type PullRequestOverlap =
      OpenIssueRegistry["issues"][number]["pull_request_overlaps"][number];
    const overlap = (
      number: number,
      title: string,
      matchedBy: PullRequestOverlap["matched_by"],
      overlappingPaths: string[],
    ): PullRequestOverlap => ({
      number,
      title,
      url: `https://github.com/LucasQuiles/WhatSoup/pull/${number}`,
      updated_at: "2026-07-26T12:10:00Z",
      disposition: "open",
      is_draft: true,
      head_ref: null,
      base_ref: "main",
      matched_by: matchedBy,
      overlapping_paths: overlappingPaths,
      assessment: "collision-only",
    });
    const historicalOverlaps = [
      overlap(88, "Safe grouped patch", ["touched-path"], ["src/example.ts"]),
      overlap(
        89,
        "Previously reviewed title 89",
        ["touched-path"],
        ["src/example.ts"],
      ),
      overlap(
        90,
        "Previously reviewed title 90",
        ["touched-path"],
        ["src/example.ts"],
      ),
      overlap(
        91,
        "Previously reviewed title 91",
        ["touched-path"],
        ["src/example.ts"],
      ),
      overlap(92, "Previously reviewed title 92", ["issue-reference"], []),
      overlap(93, "Previously reviewed title 93", ["issue-reference"], []),
    ];
    const projectedOverlaps = historicalOverlaps.map((item) =>
      item.number === 88
        ? item
        : {
            ...item,
            title: placeholder(item.number),
          },
    );
    source.inventory.open_pull_request_count = projectedOverlaps.length;
    source.inventory.draft_pull_request_count = projectedOverlaps.length;
    source.issues[0]!.pull_request_overlaps = historicalOverlaps;
    writeFileSync(
      join(root, "docs/triage/open-issue-registry.json"),
      canonicalRegistryJson(source),
    );
    writeFileSync(
      join(root, "docs/triage/open-issue-registry.md"),
      renderRegistryMarkdown(source),
    );
    writeFileSync(
      join(root, "docs/triage/reviews/refresh.json"),
      `${JSON.stringify({
        schema_version: 1,
        repository: REPOSITORY,
        pinned_main_revision: MAIN_SHA,
        source_registry_sha256: registrySha256(source),
        reviewed_at: "2026-07-26T13:00:00Z",
        record_files: [],
        removals: [],
        retained_issue_states: [],
        retained_overlap_states: projectedOverlaps
          .filter((item) => item.number !== 88)
          .map((item) => ({
            issue_number: 101,
            pull_request_number: item.number,
            overlap: item,
          })),
      })}\n`,
    );

    const client = new FakeClient();
    client.capture.pullRequests = [
      {
        number: 88,
        title: "Safe grouped patch",
        body: "",
        url: historicalOverlaps[0]!.url,
        updatedAt: historicalOverlaps[0]!.updated_at,
        disposition: "open",
        isDraft: true,
        headRefName: null,
        baseRefName: "main",
        changedFiles: 1,
        files: ["src/example.ts"],
        closingIssueNumbers: [],
      },
      {
        number: 89,
        title: privatePathTitle,
        body: "",
        url: historicalOverlaps[1]!.url,
        updatedAt: historicalOverlaps[1]!.updated_at,
        disposition: "open",
        isDraft: true,
        headRefName: null,
        baseRefName: "main",
        changedFiles: 1,
        files: ["src/example.ts"],
        closingIssueNumbers: [],
      },
      {
        number: 90,
        title: internalLabelTitle,
        body: "",
        url: historicalOverlaps[2]!.url,
        updatedAt: historicalOverlaps[2]!.updated_at,
        disposition: "open",
        isDraft: true,
        headRefName: null,
        baseRefName: "main",
        changedFiles: 1,
        files: ["src/example.ts"],
        closingIssueNumbers: [],
      },
      {
        number: 91,
        title: secretLikeTitle,
        body: "",
        url: historicalOverlaps[3]!.url,
        updatedAt: historicalOverlaps[3]!.updated_at,
        disposition: "open",
        isDraft: true,
        headRefName: null,
        baseRefName: "main",
        changedFiles: 1,
        files: ["src/example.ts"],
        closingIssueNumbers: [],
      },
      {
        number: 92,
        title: titleOnlyEvidence,
        body: bodyCanary,
        url: historicalOverlaps[4]!.url,
        updatedAt: historicalOverlaps[4]!.updated_at,
        disposition: "open",
        isDraft: true,
        headRefName: null,
        baseRefName: "main",
        changedFiles: 0,
        files: [],
        closingIssueNumbers: [],
      },
      {
        number: 93,
        title: privatePathTitle,
        body: bodyOnlyEvidence,
        url: historicalOverlaps[5]!.url,
        updatedAt: historicalOverlaps[5]!.updated_at,
        disposition: "open",
        isDraft: true,
        headRefName: null,
        baseRefName: "main",
        changedFiles: 0,
        files: [],
        closingIssueNumbers: [],
      },
    ];

    const first = harness(reconcileGit(root));
    const second = harness(reconcileGit(root));
    expect(await run(reconcileCheckArgs(), root, client, first.runtime)).toBe(
      0,
    );
    expect(await run(reconcileCheckArgs(), root, client, second.runtime)).toBe(
      0,
    );
    expect(first.stdout).toEqual(second.stdout);
    expect(first.stderr).toEqual([]);
    expect(second.stderr).toEqual([]);
    expect(
      client.calls.filter((call) => call === "registry-capture"),
    ).toHaveLength(6);
    for (const value of [
      privatePathTitle,
      internalLabelTitle,
      secretLikeTitle,
      titleOnlyEvidence,
      bodyCanary,
      bodyOnlyEvidence,
    ]) {
      expect(first.stdout.join("")).not.toContain(value);
      expect(first.stderr.join("")).not.toContain(value);
      expect(second.stdout.join("")).not.toContain(value);
      expect(second.stderr.join("")).not.toContain(value);
    }
    for (const item of projectedOverlaps.slice(1)) {
      expect(publicationCodes(item.title)).toEqual([]);
      expect(hygieneCodes(item.title)).toEqual([]);
      expect(() =>
        assertNoSecretLike(item.title, "projected pull request title"),
      ).not.toThrow();
    }
  });
});
