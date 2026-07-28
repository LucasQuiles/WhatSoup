import { describe, expect, it } from "vitest";

import {
  LIVE_LABELS,
  registrySha256,
  sha256,
  type OpenIssueRegistry,
} from "../../scripts/lib/open-issue-triage/model.ts";
import {
  issueRecordSha256,
  parseRegistryReviewBatch,
  reconcileRegistry,
  reconcilePullRequestOverlaps,
  referencedRepositoryNumbers,
  textReferencesRepositoryNumber,
  type RegistryReviewBatch,
  type ReconcileIssueRecord,
  type RefreshClosedIssue,
  type RefreshPullRequest,
} from "../../scripts/lib/open-issue-triage/reconcile.ts";

describe("open issue registry reconciliation references", () => {
  it("recognizes direct local references and bounded forward ranges", () => {
    const text = [
      "Relates to #2517.",
      "See https://github.com/LucasQuiles/WhatSoup/pull/2518 and https://github.com/LucasQuiles/WhatSoup/issues/2519.",
      "Draft PRs #2520 through #2522.",
    ].join("\n");

    expect(referencedRepositoryNumbers(text)).toEqual([
      2517, 2518, 2519, 2520, 2521, 2522,
    ]);
    expect(textReferencesRepositoryNumber(text, 2521)).toBe(true);
  });

  it("does not treat foreign-repository URLs as local references", () => {
    const text = [
      "https://github.com/Other/Repo/issues/2517",
      "https://github.com/Other/Repo/pull/2518",
    ].join("\n");

    expect(referencedRepositoryNumbers(text)).toEqual([]);
    expect(textReferencesRepositoryNumber(text, 2517)).toBe(false);
  });

  it.each([
    "https://github.com/Other/Repo/issues/1#2522",
    "https://github.com/Other/Repo/pull/1?next=#2522",
    "https://github.com/Other/Repo/issues/1/related-#2522",
  ])(
    "does not leak foreign URL suffixes into local shorthand references: %s",
    (text) => {
      expect(referencedRepositoryNumbers(text)).toEqual([]);
    },
  );

  it("accepts the exact local URL target without treating its fragment as another target", () => {
    expect(
      referencedRepositoryNumbers(
        "https://github.com/LucasQuiles/WhatSoup/issues/101#2522",
      ),
    ).toEqual([101]);
  });

  it.each(["Issues #2522 through #2520", "Issues #1 through #999999"])(
    "rejects reversed or excessive ranges: %s",
    (text) => {
      expect(() => referencedRepositoryNumbers(text)).toThrow(/range/i);
    },
  );
});

function issueRecord(
  overlapUpdatedAt = "2026-07-26T12:00:00Z",
): ReconcileIssueRecord {
  return {
    issue_number: 101,
    affected_paths: ["src/example.ts"],
    decisive_source_paths: [],
    decisive_test_paths: [],
    pull_request_owner_pr_number: null,
    pull_request_overlaps: [
      {
        number: 88,
        title: "Registry publication",
        url: "https://github.com/LucasQuiles/WhatSoup/pull/88",
        updated_at: overlapUpdatedAt,
        disposition: "open",
        is_draft: true,
        head_ref: "docs/registry",
        base_ref: "main",
        matched_by: ["issue-reference"],
        overlapping_paths: [],
        assessment: "collision-only",
      },
    ],
  };
}

function pullRequest(updatedAt = "2026-07-26T12:00:00Z"): RefreshPullRequest {
  return {
    number: 88,
    title: "Registry publication",
    body: "Tracks issue #101.",
    url: "https://github.com/LucasQuiles/WhatSoup/pull/88",
    updatedAt,
    disposition: "open",
    isDraft: true,
    headRef: "docs/registry",
    baseRef: "main",
    changedPaths: [],
    closingIssueNumbers: [],
  };
}

describe("open issue pull-request overlap reconciliation", () => {
  it("fails closed when any previously reviewed open overlap changes", () => {
    expect(() =>
      reconcilePullRequestOverlaps({
        issue: issueRecord(),
        issueBody: "",
        openPullRequests: [pullRequest("2026-07-26T13:00:00Z")],
        explicitlyReviewed: false,
      }),
    ).toThrow(/changed after review/i);
  });

  it("accepts changed overlap metadata only from an exact explicit review record", () => {
    const reviewed = issueRecord("2026-07-26T13:00:00Z");
    expect(
      reconcilePullRequestOverlaps({
        issue: reviewed,
        issueBody: "",
        openPullRequests: [pullRequest("2026-07-26T13:00:00Z")],
        explicitlyReviewed: true,
      }),
    ).toEqual(reviewed.pull_request_overlaps);

    reviewed.pull_request_overlaps[0]!.updated_at = "2026-07-26T12:59:59Z";
    expect(() =>
      reconcilePullRequestOverlaps({
        issue: reviewed,
        issueBody: "",
        openPullRequests: [pullRequest("2026-07-26T13:00:00Z")],
        explicitlyReviewed: true,
      }),
    ).toThrow(/explicit review.*live pull request/i);
  });

  it("adds current collisions from touched paths and bidirectional bounded references", () => {
    const issue = issueRecord();
    issue.issue_number = 2521;
    issue.pull_request_overlaps = [];
    issue.affected_paths = ["src/shared.ts"];
    const pull = pullRequest();
    pull.number = 90;
    pull.title = "Draft PRs #2520 through #2522";
    pull.url = "https://github.com/LucasQuiles/WhatSoup/pull/90";
    pull.body = "Foreign: https://github.com/Other/Repo/issues/2521";
    pull.changedPaths = ["src/shared.ts"];

    expect(
      reconcilePullRequestOverlaps({
        issue,
        issueBody: "Implementation notes reference PRs #89 through #90.",
        openPullRequests: [pull],
        explicitlyReviewed: false,
      }),
    ).toEqual([
      expect.objectContaining({
        number: 90,
        assessment: "collision-only",
        matched_by: ["issue-reference", "touched-path"],
        overlapping_paths: ["src/shared.ts"],
      }),
    ]);
  });

  it("does not duplicate the declared owner PR as an overlap", () => {
    const issue = issueRecord();
    issue.pull_request_overlaps = [];
    issue.pull_request_owner_pr_number = 88;
    expect(
      reconcilePullRequestOverlaps({
        issue,
        issueBody: "",
        openPullRequests: [pullRequest()],
        explicitlyReviewed: false,
      }),
    ).toEqual([]);
  });

  it("requires a declared owner PR to be captured and currently open", () => {
    const issue = issueRecord();
    issue.pull_request_overlaps = [];
    issue.pull_request_owner_pr_number = 88;
    expect(() =>
      reconcilePullRequestOverlaps({
        issue,
        issueBody: "",
        openPullRequests: [],
        explicitlyReviewed: false,
      }),
    ).toThrow(/owner pull request #88.*missing/i);

    const transitioned = pullRequest("2026-07-26T13:00:00Z");
    transitioned.disposition = "merged";
    transitioned.isDraft = false;
    expect(() =>
      reconcilePullRequestOverlaps({
        issue,
        issueBody: "",
        openPullRequests: [transitioned],
        explicitlyReviewed: true,
      }),
    ).toThrow(/owner pull request #88.*open/i);
  });

  it("fails if an unreviewed semantic overlap loses all current support", () => {
    const issue = issueRecord();
    issue.pull_request_overlaps[0]!.assessment = "partial";
    const pull = pullRequest();
    pull.body = "";
    expect(() =>
      reconcilePullRequestOverlaps({
        issue,
        issueBody: "",
        openPullRequests: [pull],
        explicitlyReviewed: false,
      }),
    ).toThrow(/no longer supports.*partial/i);
  });

  it("requires exact explicit review for an open-to-merged transition", () => {
    const merged = pullRequest("2026-07-26T14:00:00Z");
    merged.disposition = "merged";
    expect(() =>
      reconcilePullRequestOverlaps({
        issue: issueRecord(),
        issueBody: "",
        openPullRequests: [merged],
        explicitlyReviewed: false,
      }),
    ).toThrow(/changed after review/i);

    const reviewed = issueRecord("2026-07-26T14:00:00Z");
    reviewed.pull_request_overlaps[0]!.disposition = "merged";
    expect(
      reconcilePullRequestOverlaps({
        issue: reviewed,
        issueBody: "",
        openPullRequests: [merged],
        explicitlyReviewed: true,
      })[0],
    ).toMatchObject({ number: 88, disposition: "merged" });
  });
});

function completeRegistry(): OpenIssueRegistry {
  const labels = [...LIVE_LABELS].sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right)),
  );
  return {
    schema_version: 1,
    repository: "LucasQuiles/WhatSoup",
    generated_at: "2026-07-26T12:30:00Z",
    pinned_main_revision: "b".repeat(40),
    inventory: {
      captured_at: "2026-07-26T12:30:00Z",
      open_issue_count: 1,
      open_pull_request_count: 0,
      draft_pull_request_count: 0,
      label_count: labels.length,
      labels,
    },
    issues: [
      {
        issue_number: 101,
        issue_node_id: "I_kwDOExample101",
        title: "Example finding",
        recommended_title: null,
        url: "https://github.com/LucasQuiles/WhatSoup/issues/101",
        updated_at: "2026-07-26T12:00:00Z",
        pre_review_body_sha256: sha256("Owner-authored body.\n"),
        current_labels: ["bug"],
        recommended_labels: ["bug", "reliability"],
        classification: "leaf",
        evidence_state: "verified",
        pinned_revision: "b".repeat(40),
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

function liveIssue() {
  return {
    issueNumber: 101,
    issueNodeId: "I_kwDOExample101",
    title: "Example finding",
    url: "https://github.com/LucasQuiles/WhatSoup/issues/101",
    updatedAt: "2026-07-26T12:00:00Z",
    body: "Owner-authored body.\n",
    labels: ["bug"],
  };
}

function reviewBatch(oldRegistry: OpenIssueRegistry): RegistryReviewBatch {
  return {
    schema_version: 1,
    repository: "LucasQuiles/WhatSoup",
    pinned_main_revision: "b".repeat(40),
    source_registry_sha256: registrySha256(oldRegistry),
    reviewed_at: "2026-07-26T13:01:00Z",
    records: [],
    removals: [],
    retained_issue_states: [],
    retained_overlap_states: [],
  };
}

function closedIssue(
  overrides: Partial<RefreshClosedIssue> = {},
): RefreshClosedIssue {
  return {
    issueNumber: 101,
    issueNodeId: "I_kwDOExample101",
    url: "https://github.com/LucasQuiles/WhatSoup/issues/101",
    updatedAt: "2026-07-26T13:00:00Z",
    body: "Closed owner-authored body.\n",
    state: "closed",
    ...overrides,
  };
}

describe("complete registry reconciliation", () => {
  it("repins an exact source record while retaining exact live label metadata", () => {
    const oldRegistry = completeRegistry();
    const targetMain = "c".repeat(40);
    const live = liveIssue();
    live.updatedAt = "2026-07-26T13:00:00Z";
    live.labels = ["audit", "bug"];
    const sourceRecord = oldRegistry.issues[0]!;
    const batch: RegistryReviewBatch = {
      schema_version: 2,
      repository: "LucasQuiles/WhatSoup",
      source_main_revision: oldRegistry.pinned_main_revision,
      pinned_main_revision: targetMain,
      source_registry_sha256: registrySha256(oldRegistry),
      reviewed_at: "2026-07-26T13:01:00Z",
      records: [],
      repins: [
        {
          issue_number: 101,
          source_record_sha256: issueRecordSha256(sourceRecord),
        },
      ],
      removals: [],
      retained_issue_states: [
        {
          issue_number: 101,
          issue_node_id: live.issueNodeId,
          title: live.title,
          url: live.url,
          updated_at: live.updatedAt,
          pre_review_body_sha256: sha256(live.body),
          current_labels: live.labels,
          recommended_labels: ["audit", "bug", "reliability"],
        },
      ],
      retained_overlap_states: [],
    };

    const result = reconcileRegistry({
      oldRegistry,
      reviewBatch: batch,
      liveIssues: [live],
      closedIssues: [],
      openPullRequests: [],
      labels: oldRegistry.inventory.labels,
      capturedAt: "2026-07-26T13:02:00Z",
      expectedMainOid: targetMain,
    });

    expect(result.registry.pinned_main_revision).toBe(targetMain);
    expect(result.registry.issues[0]).toEqual({
      ...sourceRecord,
      pinned_revision: targetMain,
      updated_at: live.updatedAt,
      current_labels: live.labels,
      recommended_labels: ["audit", "bug", "reliability"],
    });
  });

  it("rejects a cross-main v2 batch without exact source-record coverage", () => {
    const oldRegistry = completeRegistry();
    const targetMain = "c".repeat(40);
    const batch: RegistryReviewBatch = {
      schema_version: 2,
      repository: "LucasQuiles/WhatSoup",
      source_main_revision: oldRegistry.pinned_main_revision,
      pinned_main_revision: targetMain,
      source_registry_sha256: registrySha256(oldRegistry),
      reviewed_at: "2026-07-26T13:01:00Z",
      records: [],
      repins: [],
      removals: [],
      retained_issue_states: [],
      retained_overlap_states: [],
    };

    expect(() =>
      parseRegistryReviewBatch(batch, oldRegistry, targetMain),
    ).toThrow(/coverage/i);
  });

  it.each([
    [
      "source revision drift",
      (batch: RegistryReviewBatch) => {
        batch.source_main_revision = "d".repeat(40);
      },
      /source main revision/i,
    ],
    [
      "target revision drift",
      (batch: RegistryReviewBatch) => {
        batch.pinned_main_revision = "d".repeat(40);
      },
      /main revision.*requested pin/i,
    ],
    [
      "source registry digest drift",
      (batch: RegistryReviewBatch) => {
        batch.source_registry_sha256 = "e".repeat(64);
      },
      /source registry digest/i,
    ],
    [
      "source record digest drift",
      (batch: RegistryReviewBatch) => {
        batch.repins![0]!.source_record_sha256 = "e".repeat(64);
      },
      /source record digest/i,
    ],
    [
      "unknown repin",
      (batch: RegistryReviewBatch) => {
        batch.repins![0]!.issue_number = 102;
      },
      /repin #102.*source registry/i,
    ],
    [
      "duplicate repin",
      (batch: RegistryReviewBatch) => {
        batch.repins!.push(structuredClone(batch.repins![0]!));
      },
      /repin numbers.*sorted|unique/i,
    ],
    [
      "repin and full-record conflict",
      (batch: RegistryReviewBatch) => {
        const replacement = structuredClone(completeRegistry().issues[0]!);
        replacement.pinned_revision = batch.pinned_main_revision;
        batch.records = [replacement];
      },
      /repin #101.*conflicts/i,
    ],
    [
      "repin and removal conflict",
      (batch: RegistryReviewBatch) => {
        batch.removals = [
          {
            issue_number: 101,
            issue_node_id: "I_kwDOExample101",
            url: "https://github.com/LucasQuiles/WhatSoup/issues/101",
            updated_at: "2026-07-26T13:00:00Z",
            pre_review_body_sha256: sha256("Closed owner-authored body.\n"),
            state: "closed",
          },
        ];
      },
      /repin #101.*conflicts/i,
    ],
    [
      "repin metadata source identity drift",
      (batch: RegistryReviewBatch) => {
        batch.retained_issue_states = [
          {
            issue_number: 101,
            issue_node_id: "I_kwDOExample101",
            title: "Substantively changed title",
            url: "https://github.com/LucasQuiles/WhatSoup/issues/101",
            updated_at: "2026-07-26T13:00:00Z",
            pre_review_body_sha256: sha256("Owner-authored body.\n"),
            current_labels: ["bug"],
            recommended_labels: ["bug", "reliability"],
          },
        ];
      },
      /metadata.*source identity/i,
    ],
    [
      "full record and retained overlap conflict",
      (batch: RegistryReviewBatch) => {
        const replacement = structuredClone(completeRegistry().issues[0]!);
        replacement.pinned_revision = batch.pinned_main_revision;
        batch.records = [replacement];
        batch.repins = [];
        batch.retained_overlap_states = [
          {
            issue_number: 101,
            pull_request_number: 88,
            overlap: null,
          },
        ];
      },
      /replace.*retained overlap/i,
    ],
  ])("rejects v2 %s before live reconciliation", (_name, mutate, pattern) => {
    const oldRegistry = completeRegistry();
    const targetMain = "c".repeat(40);
    const batch: RegistryReviewBatch = {
      schema_version: 2,
      repository: "LucasQuiles/WhatSoup",
      source_main_revision: oldRegistry.pinned_main_revision,
      pinned_main_revision: targetMain,
      source_registry_sha256: registrySha256(oldRegistry),
      reviewed_at: "2026-07-26T13:01:00Z",
      records: [],
      repins: [
        {
          issue_number: 101,
          source_record_sha256: issueRecordSha256(oldRegistry.issues[0]!),
        },
      ],
      removals: [],
      retained_issue_states: [],
      retained_overlap_states: [],
    };
    mutate(batch);

    expect(() =>
      parseRegistryReviewBatch(batch, oldRegistry, targetMain),
    ).toThrow(pattern);
  });

  it("rejects source identity drift in same-pin v2 metadata retention", () => {
    const oldRegistry = completeRegistry();
    const batch: RegistryReviewBatch = {
      schema_version: 2,
      repository: "LucasQuiles/WhatSoup",
      source_main_revision: oldRegistry.pinned_main_revision,
      pinned_main_revision: oldRegistry.pinned_main_revision,
      source_registry_sha256: registrySha256(oldRegistry),
      reviewed_at: "2026-07-26T13:01:00Z",
      records: [],
      repins: [],
      removals: [],
      retained_issue_states: [
        {
          issue_number: 101,
          issue_node_id: "I_kwDOExample101",
          title: "Substantively changed title",
          url: "https://github.com/LucasQuiles/WhatSoup/issues/101",
          updated_at: "2026-07-26T13:00:00Z",
          pre_review_body_sha256: sha256("Owner-authored body.\n"),
          current_labels: ["bug"],
          recommended_labels: ["bug", "reliability"],
        },
      ],
      retained_overlap_states: [],
    };

    expect(() =>
      parseRegistryReviewBatch(
        batch,
        oldRegistry,
        oldRegistry.pinned_main_revision,
      ),
    ).toThrow(/metadata.*source identity/i);
  });

  it("accepts a target-pinned full record for a substantive cross-main change", () => {
    const oldRegistry = completeRegistry();
    const targetMain = "c".repeat(40);
    const replacement = structuredClone(oldRegistry.issues[0]!);
    replacement.pinned_revision = targetMain;
    replacement.evidence_summary =
      "The target revision was rereviewed and preserves the ownership finding.";
    const batch: RegistryReviewBatch = {
      schema_version: 2,
      repository: "LucasQuiles/WhatSoup",
      source_main_revision: oldRegistry.pinned_main_revision,
      pinned_main_revision: targetMain,
      source_registry_sha256: registrySha256(oldRegistry),
      reviewed_at: "2026-07-26T13:01:00Z",
      records: [replacement],
      repins: [],
      removals: [],
      retained_issue_states: [],
      retained_overlap_states: [],
    };

    expect(
      reconcileRegistry({
        oldRegistry,
        reviewBatch: batch,
        liveIssues: [liveIssue()],
        closedIssues: [],
        openPullRequests: [],
        labels: oldRegistry.inventory.labels,
        capturedAt: "2026-07-26T13:02:00Z",
        expectedMainOid: targetMain,
      }).registry.issues[0],
    ).toEqual(replacement);
  });

  it("does not let a cross-main repin bypass changed overlap review", () => {
    const oldRegistry = completeRegistry();
    const targetMain = "c".repeat(40);
    oldRegistry.inventory.open_pull_request_count = 1;
    oldRegistry.inventory.draft_pull_request_count = 1;
    oldRegistry.issues[0]!.pull_request_overlaps =
      issueRecord().pull_request_overlaps;
    const batch: RegistryReviewBatch = {
      schema_version: 2,
      repository: "LucasQuiles/WhatSoup",
      source_main_revision: oldRegistry.pinned_main_revision,
      pinned_main_revision: targetMain,
      source_registry_sha256: registrySha256(oldRegistry),
      reviewed_at: "2026-07-26T13:01:00Z",
      records: [],
      repins: [
        {
          issue_number: 101,
          source_record_sha256: issueRecordSha256(oldRegistry.issues[0]!),
        },
      ],
      removals: [],
      retained_issue_states: [],
      retained_overlap_states: [],
    };

    expect(() =>
      reconcileRegistry({
        oldRegistry,
        reviewBatch: batch,
        liveIssues: [liveIssue()],
        closedIssues: [],
        openPullRequests: [pullRequest("2026-07-26T13:00:00Z")],
        labels: oldRegistry.inventory.labels,
        capturedAt: "2026-07-26T13:02:00Z",
        expectedMainOid: targetMain,
      }),
    ).toThrow(/changed after review/i);
  });

  it("requires an exact reviewed record for timestamp drift", () => {
    const oldRegistry = completeRegistry();
    const liveIssue = {
      issueNumber: 101,
      issueNodeId: "I_kwDOExample101",
      title: "Example finding",
      url: "https://github.com/LucasQuiles/WhatSoup/issues/101",
      updatedAt: "2026-07-26T13:00:00Z",
      body: "Owner-authored body.\n",
      labels: ["bug"],
    };
    const reviewBatch: RegistryReviewBatch = {
      schema_version: 1,
      repository: "LucasQuiles/WhatSoup",
      pinned_main_revision: "b".repeat(40),
      source_registry_sha256: registrySha256(oldRegistry),
      reviewed_at: "2026-07-26T13:01:00Z",
      records: [],
      removals: [],
      retained_issue_states: [],
      retained_overlap_states: [],
    };
    const input = {
      oldRegistry,
      reviewBatch,
      liveIssues: [liveIssue],
      closedIssues: [],
      openPullRequests: [],
      labels: oldRegistry.inventory.labels,
      capturedAt: "2026-07-26T13:02:00Z",
      expectedMainOid: "b".repeat(40),
    };

    expect(() => reconcileRegistry(input)).toThrow(
      /changed issue #101.*review/i,
    );

    input.reviewBatch.retained_issue_states = [
      {
        issue_number: 101,
        issue_node_id: liveIssue.issueNodeId,
        title: liveIssue.title,
        url: liveIssue.url,
        updated_at: liveIssue.updatedAt,
        pre_review_body_sha256: sha256(liveIssue.body),
        current_labels: liveIssue.labels,
      },
    ];
    expect(reconcileRegistry(input).registry.issues[0]!.updated_at).toBe(
      liveIssue.updatedAt,
    );
  });

  it("accepts an explicit attestation that a stale collision-only overlap disappeared", () => {
    const oldRegistry = completeRegistry();
    oldRegistry.inventory.open_pull_request_count = 1;
    oldRegistry.inventory.draft_pull_request_count = 1;
    oldRegistry.issues[0]!.pull_request_overlaps =
      issueRecord().pull_request_overlaps;
    const liveIssue = {
      issueNumber: 101,
      issueNodeId: "I_kwDOExample101",
      title: "Example finding",
      url: "https://github.com/LucasQuiles/WhatSoup/issues/101",
      updatedAt: "2026-07-26T12:00:00Z",
      body: "Owner-authored body.\n",
      labels: ["bug"],
    };
    const pull = pullRequest("2026-07-26T13:00:00Z");
    pull.body = "";
    const result = reconcileRegistry({
      oldRegistry,
      reviewBatch: {
        schema_version: 1,
        repository: "LucasQuiles/WhatSoup",
        pinned_main_revision: "b".repeat(40),
        source_registry_sha256: registrySha256(oldRegistry),
        reviewed_at: "2026-07-26T13:01:00Z",
        records: [],
        removals: [],
        retained_issue_states: [],
        retained_overlap_states: [
          {
            issue_number: 101,
            pull_request_number: 88,
            overlap: null,
          },
        ],
      },
      liveIssues: [liveIssue],
      closedIssues: [],
      openPullRequests: [pull],
      labels: oldRegistry.inventory.labels,
      capturedAt: "2026-07-26T13:02:00Z",
      expectedMainOid: "b".repeat(40),
    });

    expect(result.registry.issues[0]!.pull_request_overlaps).toEqual([]);
  });

  it("requires strict runtime-safe review batch objects before reconciliation maps", () => {
    const oldRegistry = completeRegistry();
    const base = {
      oldRegistry,
      reviewBatch: {
        ...reviewBatch(oldRegistry),
        ignored_private_field: ["gh", "p_abcdefghijklmnopqrstuvwxyz"].join(""),
      },
      liveIssues: [liveIssue()],
      closedIssues: [],
      openPullRequests: [],
      labels: oldRegistry.inventory.labels,
      capturedAt: "2026-07-26T13:02:00Z",
      expectedMainOid: "b".repeat(40),
    };
    expect(() => reconcileRegistry(base)).toThrow(
      /review batch|unknown|unrecognized/i,
    );

    const changed = liveIssue();
    changed.updatedAt = "2026-07-26T13:00:00Z";
    const privateBatch = reviewBatch(oldRegistry);
    privateBatch.retained_issue_states = [
      {
        issue_number: 101,
        issue_node_id: changed.issueNodeId,
        title: ["operator", "@", "real-company.com"].join(""),
        url: changed.url,
        updated_at: changed.updatedAt,
        pre_review_body_sha256: sha256(changed.body),
        current_labels: changed.labels,
      },
    ];
    expect(() =>
      reconcileRegistry({
        ...base,
        reviewBatch: privateBatch,
        liveIssues: [changed],
      }),
    ).toThrow(/public|private|email|redaction/i);
  });

  it("binds every reviewed removal to exact captured closed issue evidence", () => {
    const oldRegistry = completeRegistry();
    const closed = closedIssue();
    const batch = reviewBatch(oldRegistry);
    batch.removals = [
      {
        issue_number: 101,
        issue_node_id: closed.issueNodeId,
        url: closed.url,
        updated_at: closed.updatedAt,
        pre_review_body_sha256: sha256(closed.body),
        state: "closed",
      },
    ];
    const input = {
      oldRegistry,
      reviewBatch: batch,
      liveIssues: [],
      closedIssues: [closed],
      openPullRequests: [],
      labels: oldRegistry.inventory.labels,
      capturedAt: "2026-07-26T13:02:00Z",
      expectedMainOid: "b".repeat(40),
    };

    expect(reconcileRegistry(input).removedIssueNumbers).toEqual([101]);
    expect(() =>
      reconcileRegistry({
        ...input,
        closedIssues: [closedIssue({ updatedAt: "2026-07-26T13:00:01Z" })],
      }),
    ).toThrow(/closed issue #101.*exact/i);
    expect(() =>
      reconcileRegistry({
        ...input,
        closedIssues: [],
      }),
    ).toThrow(/closed issue #101.*captured/i);

    const malformed = structuredClone(batch) as unknown as RegistryReviewBatch;
    (malformed.removals[0] as { state: string }).state = "open";
    expect(() =>
      reconcileRegistry({
        ...input,
        reviewBatch: malformed,
      }),
    ).toThrow(/review batch|closed/i);
  });

  it("rejects duplicate or unsorted capture PR and label inventories", () => {
    const oldRegistry = completeRegistry();
    const input = {
      oldRegistry,
      reviewBatch: reviewBatch(oldRegistry),
      liveIssues: [liveIssue()],
      closedIssues: [],
      openPullRequests: [pullRequest(), pullRequest()],
      labels: oldRegistry.inventory.labels,
      capturedAt: "2026-07-26T13:02:00Z",
      expectedMainOid: "b".repeat(40),
    };
    expect(() => reconcileRegistry(input)).toThrow(
      /pull request numbers.*sorted|unique/i,
    );
    expect(() =>
      reconcileRegistry({
        ...input,
        openPullRequests: [],
        labels: [
          ...oldRegistry.inventory.labels,
          oldRegistry.inventory.labels[0]!,
        ],
      }),
    ).toThrow(/labels.*sorted|unique/i);
  });

  it("requires explicit full issue review to clear a transitioned owner PR", () => {
    const oldRegistry = completeRegistry();
    oldRegistry.inventory.open_pull_request_count = 1;
    oldRegistry.inventory.draft_pull_request_count = 1;
    oldRegistry.issues[0]!.proposed_cohort_id = "runtime-owner";
    oldRegistry.issues[0]!.pull_request_owner_pr_number = 88;
    const transitioned = pullRequest("2026-07-26T13:00:00Z");
    transitioned.disposition = "merged";
    transitioned.isDraft = false;
    const batch = reviewBatch(oldRegistry);
    const input = {
      oldRegistry,
      reviewBatch: batch,
      liveIssues: [liveIssue()],
      closedIssues: [],
      openPullRequests: [transitioned],
      labels: oldRegistry.inventory.labels,
      capturedAt: "2026-07-26T13:02:00Z",
      expectedMainOid: "b".repeat(40),
    };

    expect(() => reconcileRegistry(input)).toThrow(
      /owner pull request #88.*review/i,
    );

    const reviewed = structuredClone(oldRegistry.issues[0]!);
    reviewed.proposed_cohort_id = null;
    reviewed.pull_request_owner_pr_number = null;
    batch.records = [reviewed];
    expect(
      reconcileRegistry(input).registry.issues[0]!.pull_request_owner_pr_number,
    ).toBeNull();
  });
});
