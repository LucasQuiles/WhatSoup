import { describe, expect, it } from "vitest";

import {
  bodyFreeRegistrySnapshot,
  materializeRegistryReviewBatch,
  parseRegistryReviewManifest,
} from "../../scripts/lib/open-issue-triage/refresh-manifest.ts";
import {
  sha256,
  type OpenIssueRegistry,
} from "../../scripts/lib/open-issue-triage/model.ts";
import type { RegistryCapture } from "../../scripts/lib/open-issue-triage/github.ts";

const MAIN_SHA = "a".repeat(40);
const RECORD_PATH = "docs/triage/reviews/open-issue-refresh-20260726/101.json";

function record(): OpenIssueRegistry["issues"][number] {
  return {
    issue_number: 101,
    issue_node_id: "I_example101",
    title: "Example issue",
    recommended_title: null,
    url: "https://github.com/LucasQuiles/WhatSoup/issues/101",
    updated_at: "2026-07-26T12:00:00Z",
    pre_review_body_sha256: sha256("owner body"),
    current_labels: ["bug"],
    recommended_labels: ["bug"],
    classification: "leaf",
    evidence_state: "verified",
    pinned_revision: MAIN_SHA,
    decisive_source_paths: ["src/example.ts"],
    decisive_test_paths: ["tests/example.test.ts"],
    evidence_summary: "The behavior is directly reproduced.",
    falsifier_or_remaining_gap: "Run the focused test.",
    partial_findings: [],
    suggested_remediation: "Preserve the contract.",
    impact: "The operation can fail.",
    blast_radius: "One path.",
    affected_paths: ["src/example.ts"],
    owner_boundary: "example-owner",
    acceptance_criteria: ["The focused test passes."],
    dependency_issue_numbers: [],
    duplicate_of_issue_number: null,
    implementation_after_issue_numbers: [],
    pull_request_overlaps: [],
    proposed_cohort_id: null,
    pull_request_owner_pr_number: null,
    review_confidence: "high",
    lead_verification_obligations: ["Re-read the decisive source."],
  };
}

function manifest(recordText: string) {
  return {
    schema_version: 1,
    repository: "LucasQuiles/WhatSoup",
    pinned_main_revision: MAIN_SHA,
    source_registry_sha256: "b".repeat(64),
    reviewed_at: "2026-07-26T12:30:00Z",
    record_files: [
      {
        issue_number: 101,
        path: RECORD_PATH,
        sha256: sha256(recordText),
      },
    ],
    removals: [],
    retained_issue_states: [],
    retained_overlap_states: [],
  };
}

describe("registry refresh manifest", () => {
  it("materializes only exact sorted record files into the strict review batch", () => {
    const recordText = `${JSON.stringify(record(), null, 2)}\n`;
    const parsed = parseRegistryReviewManifest(manifest(recordText));
    const batch = materializeRegistryReviewBatch(
      parsed,
      new Map([[RECORD_PATH, recordText]]),
    );

    expect(batch).toMatchObject({
      schema_version: 1,
      repository: "LucasQuiles/WhatSoup",
      records: [{ issue_number: 101 }],
      removals: [],
    });
  });

  it.each([
    ["unknown manifest field", { extra: true }],
    [
      "unsorted duplicate record paths",
      {
        record_files: [
          {
            issue_number: 102,
            path: "docs/triage/reviews/z/102.json",
            sha256: "c".repeat(64),
          },
          { issue_number: 101, path: RECORD_PATH, sha256: "d".repeat(64) },
        ],
      },
    ],
    [
      "unsafe record path",
      {
        record_files: [
          { issue_number: 101, path: "../101.json", sha256: "c".repeat(64) },
        ],
      },
    ],
  ])("rejects %s", (_label, patch) => {
    const recordText = `${JSON.stringify(record(), null, 2)}\n`;
    expect(() =>
      parseRegistryReviewManifest({
        ...manifest(recordText),
        ...patch,
      }),
    ).toThrow();
  });

  it("rejects record byte drift and issue-number substitution", () => {
    const recordText = `${JSON.stringify(record(), null, 2)}\n`;
    const parsed = parseRegistryReviewManifest(manifest(recordText));
    expect(() =>
      materializeRegistryReviewBatch(
        parsed,
        new Map([[RECORD_PATH, `${recordText} `]]),
      ),
    ).toThrow(/digest/i);

    const substituted = {
      ...record(),
      issue_number: 102,
      url: "https://github.com/LucasQuiles/WhatSoup/issues/102",
    };
    const substitutedText = `${JSON.stringify(substituted, null, 2)}\n`;
    const substitutedManifest = parseRegistryReviewManifest({
      ...manifest(substitutedText),
      record_files: [
        {
          issue_number: 101,
          path: RECORD_PATH,
          sha256: sha256(substitutedText),
        },
      ],
    });
    expect(() =>
      materializeRegistryReviewBatch(
        substitutedManifest,
        new Map([[RECORD_PATH, substitutedText]]),
      ),
    ).toThrow(/issue number/i);
  });
});

describe("body-free registry snapshot", () => {
  it("projects complete capture facts without issue or pull-request bodies or refs", () => {
    const capture: RegistryCapture = {
      repository: "LucasQuiles/WhatSoup",
      issues: [
        {
          number: 101,
          nodeId: "I_example101",
          title: "Example issue",
          url: "https://github.com/LucasQuiles/WhatSoup/issues/101",
          body: "owner body must not be published",
          updatedAt: "2026-07-26T12:00:00Z",
          labels: ["bug"],
        },
      ],
      pullRequests: [
        {
          number: 201,
          title: "Example pull request",
          body: "pull request body must not be published",
          url: "https://github.com/LucasQuiles/WhatSoup/pull/201",
          updatedAt: "2026-07-26T12:10:00Z",
          disposition: "open",
          isDraft: true,
          headRefName: "private/operator/ref",
          baseRefName: "main",
          changedFiles: 1,
          files: ["src/example.ts"],
          closingIssueNumbers: [101],
        },
      ],
      labels: ["bug"],
      pagination: {
        issuesComplete: true,
        pullRequestsComplete: true,
        labelsComplete: true,
        changedFilesComplete: true,
        closingReferencesComplete: true,
      },
    };

    const snapshot = bodyFreeRegistrySnapshot({
      capture,
      capturedAt: "2026-07-26T12:30:00Z",
      mainOid: MAIN_SHA,
      reviewManifestSha256: "c".repeat(64),
    });
    const text = JSON.stringify(snapshot);
    expect(snapshot).toMatchObject({
      counts: {
        open_issues: 1,
        open_pull_requests: 1,
        draft_pull_requests: 1,
      },
      open_issue_numbers: [101],
      pull_requests: [
        {
          number: 201,
          disposition: "open",
          changed_files: 1,
        },
      ],
    });
    expect(text).not.toContain("owner body");
    expect(text).not.toContain("pull request body");
    expect(text).not.toContain("private/operator/ref");
  });
});
