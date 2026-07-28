import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
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
import type {
  GitHubIssueClient,
  GitHubWriteResult,
  IssuePatch,
  LiveInventory,
  LiveIssue,
  RegistryCapture,
} from "../../scripts/lib/open-issue-triage/github.ts";
import {
  LIVE_LABELS,
  canonicalRegistryJson,
  registrySha256,
  sha256,
  type OpenIssueRegistry,
} from "../../scripts/lib/open-issue-triage/model.ts";
import { issueRecordSha256 } from "../../scripts/lib/open-issue-triage/reconcile.ts";

const SOURCE_MAIN = "b".repeat(40);
const TARGET_MAIN = "c".repeat(40);
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
    pinned_main_revision: SOURCE_MAIN,
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
        pinned_revision: SOURCE_MAIN,
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

class NoNetworkClient implements GitHubIssueClient {
  readonly calls: string[] = [];

  async readMainSha(): Promise<string> {
    this.calls.push("main");
    throw new Error("unexpected network call");
  }

  async readInventory(): Promise<LiveInventory> {
    this.calls.push("inventory");
    throw new Error("unexpected network call");
  }

  async readIssue(
    number: number,
  ): Promise<{ issue: LiveIssue; etag: string | null }> {
    this.calls.push(`issue:${number}`);
    throw new Error("unexpected network call");
  }

  async updateIssue(
    number: number,
    _patch: IssuePatch,
  ): Promise<GitHubWriteResult> {
    this.calls.push(`update:${number}`);
    throw new Error("unexpected network call");
  }

  async readRegistryCapture(): Promise<RegistryCapture> {
    this.calls.push("registry-capture");
    throw new Error("unexpected network call");
  }
}

function fixtureRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "whatsoup-cli-v2-")));
  roots.push(root);
  mkdirSync(join(root, "docs/triage/reviews/refresh-records"), {
    recursive: true,
  });
  mkdirSync(join(root, "docs/triage/snapshots"), { recursive: true });
  writeFileSync(
    join(root, "docs/triage/open-issue-registry.json"),
    canonicalRegistryJson(registry()),
  );
  writeFileSync(
    join(root, "docs/triage/open-issue-registry.md"),
    renderRegistryMarkdown(registry()),
  );
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
      "| `docs/triage/reviews/refresh.json` | PUBLIC | Fixture review. |",
      "",
    ].join("\n"),
  );
  return root;
}

function gitRuntime(root: string): CliRuntime["git"] {
  const commonDirectory = `${root}-git-common`;
  mkdirSync(commonDirectory);
  roots.push(commonDirectory);
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
      return { status: 0, stdout: `${TARGET_MAIN}\n`, stderr: "" };
    }
    if (args[0] === "ls-remote") {
      return {
        status: 0,
        stdout: `${TARGET_MAIN}\trefs/heads/main\n`,
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

function runtime(root: string): {
  stderr: string[];
  runtime: CliRuntime;
} {
  const stderr: string[] = [];
  return {
    stderr,
    runtime: {
      stdout: () => undefined,
      stderr: (text) => stderr.push(text),
      now: () => "2026-07-26T14:00:00Z",
      delay: async () => undefined,
      git: gitRuntime(root),
    },
  };
}

function reconcileArgs(): string[] {
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
    TARGET_MAIN,
  ];
}

function writeManifest(root: string, overrides: Record<string, unknown>): void {
  writeFileSync(
    join(root, "docs/triage/reviews/refresh.json"),
    `${JSON.stringify({
      schema_version: 2,
      repository: REPOSITORY,
      source_main_revision: SOURCE_MAIN,
      pinned_main_revision: TARGET_MAIN,
      source_registry_sha256: registrySha256(registry()),
      reviewed_at: "2026-07-26T13:00:00Z",
      record_files: [],
      repins: [],
      removals: [],
      retained_issue_states: [],
      retained_overlap_states: [],
      ...overrides,
    })}\n`,
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("open issue triage CLI v2 preflight", () => {
  it("classifies retained source identity drift before any network capture", async () => {
    const root = fixtureRoot();
    const source = registry().issues[0]!;
    writeManifest(root, {
      repins: [
        {
          issue_number: 101,
          source_record_sha256: issueRecordSha256(source),
        },
      ],
      retained_issue_states: [
        {
          issue_number: 101,
          issue_node_id: source.issue_node_id,
          title: "Substantively changed title",
          url: source.url,
          updated_at: "2026-07-26T13:00:00Z",
          pre_review_body_sha256: source.pre_review_body_sha256,
          current_labels: source.current_labels,
          recommended_labels: source.recommended_labels,
        },
      ],
    });
    const client = new NoNetworkClient();
    const io = runtime(root);

    expect(await run(reconcileArgs(), root, client, io.runtime)).toBe(3);
    expect(client.calls).toEqual([]);
    expect(JSON.parse(io.stderr.join(""))).toMatchObject({
      kind: "review-precondition-failed",
      details: {
        reason: expect.stringMatching(/metadata.*source identity/i),
      },
    });
  });

  it("classifies unsafe full records as public safety failures before network capture", async () => {
    const root = fixtureRoot();
    const replacement = structuredClone(registry().issues[0]!);
    replacement.pinned_revision = TARGET_MAIN;
    replacement.title = `Contact ${["operator", "real-company.com"].join("@")}`;
    const recordPath = "docs/triage/reviews/refresh-records/101.json";
    const recordText = `${JSON.stringify(replacement)}\n`;
    writeFileSync(join(root, recordPath), recordText);
    writeManifest(root, {
      record_files: [
        {
          issue_number: 101,
          path: recordPath,
          sha256: sha256(recordText),
        },
      ],
    });
    const client = new NoNetworkClient();
    const io = runtime(root);

    expect(await run(reconcileArgs(), root, client, io.runtime)).toBe(4);
    expect(client.calls).toEqual([]);
    expect(JSON.parse(io.stderr.join(""))).toMatchObject({
      kind: "review-public-safety-rejection",
    });
  });
});
