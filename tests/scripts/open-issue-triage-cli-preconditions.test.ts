import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  run,
  type CliRuntime,
} from "../../scripts/open-issue-triage.ts";
import type { GitHubIssueClient } from "../../scripts/lib/open-issue-triage/github.ts";
import {
  LIVE_LABELS,
  canonicalRegistryJson,
  sha256,
  type OpenIssueRegistry,
} from "../../scripts/lib/open-issue-triage/model.ts";
import { trackTmpDirs } from "../helpers/tmp-dir.ts";

const MAIN_SHA = "b".repeat(40);
const OWNER_BODY = "Owner-authored body.\n";
const REPOSITORY = "LucasQuiles/WhatSoup";
const tmp = trackTmpDirs("");

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
      labels: [...LIVE_LABELS].sort(),
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

function fixtureRoot(): string {
  const root = tmp.make("whatsoup-triage-preconditions");
  mkdirSync(join(root, "docs/triage/plans"), { recursive: true });
  writeFileSync(
    join(root, "docs/triage/open-issue-registry.json"),
    canonicalRegistryJson(registry()),
  );
  return root;
}

function harness(git: CliRuntime["git"] = () => ({
  status: 0,
  stdout: "",
  stderr: "",
})): {
  stdout: string[];
  stderr: string[];
  runtime: CliRuntime;
} {
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

function clientMustRemainUncalled(): GitHubIssueClient {
  return new Proxy({} as GitHubIssueClient, {
    get() {
      throw new Error("GitHub client accessed before local validation completed");
    },
  });
}

describe("open issue triage CLI local preconditions", () => {
  it("refuses untracked or dirty apply plans before client access", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "docs/triage/plans/batch-101.json"), "[]\n");
    const args = [
      "issue",
      "apply",
      "--registry",
      "docs/triage/open-issue-registry.json",
      "--plan",
      "docs/triage/plans/batch-101.json",
      "--confirm-plan-sha256",
      "c".repeat(64),
      "--confirm-issues",
      "101",
      "--idempotency-key",
      "batch-101-v1",
    ];
    const untracked = harness((gitArgs) =>
      gitArgs[0] === "ls-files"
        ? { status: 1, stdout: "", stderr: "" }
        : { status: 0, stdout: "", stderr: "" },
    );
    expect(
      await run(args, root, clientMustRemainUncalled(), untracked.runtime),
    ).toBe(4);

    const dirty = harness((gitArgs) =>
      gitArgs[0] === "ls-files"
        ? {
            status: 0,
            stdout: "docs/triage/plans/batch-101.json\n",
            stderr: "",
          }
        : { status: 1, stdout: "", stderr: "" },
    );
    expect(
      await run(args, root, clientMustRemainUncalled(), dirty.runtime),
    ).toBe(4);
  });

  it("emits one bounded structured error on stderr and leaves stdout empty", async () => {
    const root = fixtureRoot();
    writeFileSync(
      join(root, "docs/triage/open-issue-registry.json"),
      "{broken",
    );
    const io = harness();

    expect(
      await run(
        ["check", "--registry", "docs/triage/open-issue-registry.json"],
        root,
        clientMustRemainUncalled(),
        io.runtime,
      ),
    ).toBe(2);
    expect(io.stdout).toEqual([]);
    expect(io.stderr).toHaveLength(1);
    const error = JSON.parse(io.stderr[0]!) as Record<string, unknown>;
    expect(error).toMatchObject({
      schema_version: 1,
      ok: false,
      kind: "invalid-json",
      retryable: false,
    });
    expect(error.message).toEqual(expect.any(String));
    expect(error.hint).toEqual(expect.any(String));
    expect(JSON.stringify(error).length).toBeLessThan(4096);
  });

  it("classifies PUBLIC-safety rejection as workflow policy rather than schema invalidity", async () => {
    const root = fixtureRoot();
    const unsafe = registry();
    unsafe.issues[0]!.evidence_summary = [
      "",
      "Users",
      "privateoperator",
      "project",
    ].join("/");
    writeFileSync(
      join(root, "docs/triage/open-issue-registry.json"),
      canonicalRegistryJson(unsafe),
    );
    const io = harness();

    expect(
      await run(
        ["check", "--registry", "docs/triage/open-issue-registry.json"],
        root,
        clientMustRemainUncalled(),
        io.runtime,
      ),
    ).toBe(4);
    expect(io.stdout).toEqual([]);
    expect(JSON.parse(io.stderr.join(""))).toMatchObject({
      kind: "public-safety-rejection",
      retryable: false,
    });
  });
});
