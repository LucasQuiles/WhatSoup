import { describe, expect, it } from "vitest";

import {
  GhCliIssueClient,
  GitHubClientError,
  type GhSpawn,
  type GitHubIssueClient,
  type IssuePatch,
  type LiveInventory,
  type LiveIssue,
} from "../../scripts/lib/open-issue-triage/github.ts";
import {
  IssuePlanningError,
  canonicalPlanJson,
  planIssueBatch,
} from "../../scripts/lib/open-issue-triage/planner.ts";
import {
  mergeReviewBlock,
  renderReviewBlock,
} from "../../scripts/lib/open-issue-triage/body.ts";
import {
  ADDABLE_LABELS,
  LIVE_LABELS,
  registrySha256,
  sha256,
  type OpenIssueRegistry,
} from "../../scripts/lib/open-issue-triage/model.ts";

const MAIN_SHA = "b".repeat(40);
const OWNER_BODY = "Owner-authored body.\r\n";
const REPOSITORY = "LucasQuiles/WhatSoup";
const ISSUE_URL = "https://github.com/LucasQuiles/WhatSoup/issues/101";

type ReviewRecord = OpenIssueRegistry["issues"][number];

function utf8Sort(values: readonly string[]): string[] {
  return [...values].sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right)),
  );
}

function canonicalizeForTest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeForTest);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
      .map(([key, nested]) => [key, canonicalizeForTest(nested)]),
  );
}

function record(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    issue_number: 101,
    issue_node_id: "I_kwDOExample101",
    title: "Example finding",
    recommended_title: null,
    url: ISSUE_URL,
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
    ...overrides,
  };
}

function registry(issues: ReviewRecord[] = [record()]): OpenIssueRegistry {
  return {
    schema_version: 1,
    repository: REPOSITORY,
    generated_at: "2026-07-26T12:30:00Z",
    pinned_main_revision: MAIN_SHA,
    inventory: {
      captured_at: "2026-07-26T12:30:00Z",
      open_issue_count: issues.length,
      open_pull_request_count: 2,
      draft_pull_request_count: 1,
      label_count: LIVE_LABELS.length,
      labels: utf8Sort(LIVE_LABELS),
    },
    issues,
  };
}

function liveIssue(overrides: Partial<LiveIssue> = {}): LiveIssue {
  return {
    number: 101,
    nodeId: "I_kwDOExample101",
    repository: REPOSITORY,
    url: ISSUE_URL,
    title: "Example finding",
    body: OWNER_BODY,
    labels: ["bug"],
    state: "open",
    updatedAt: "2026-07-26T12:00:00Z",
    isPullRequest: false,
    ...overrides,
  };
}

function inventory(overrides: Partial<LiveInventory> = {}): LiveInventory {
  return {
    repository: REPOSITORY,
    openIssueNumbers: [101],
    openPullRequests: [
      { number: 88, isDraft: true },
      { number: 89, isDraft: false },
    ],
    labels: utf8Sort(LIVE_LABELS),
    counts: {
      openIssues: 1,
      openPullRequests: 2,
      draftPullRequests: 1,
      labels: LIVE_LABELS.length,
    },
    pagination: {
      issuesComplete: true,
      pullRequestsComplete: true,
      labelsComplete: true,
    },
    ...overrides,
  };
}

class InMemoryClient implements GitHubIssueClient {
  mainSha = MAIN_SHA;
  liveInventory = inventory();
  readonly issues = new Map<number, LiveIssue>([[101, liveIssue()]]);
  readonly updates: Array<{ number: number; patch: IssuePatch }> = [];
  readonly events: string[] = [];

  async readMainSha(): Promise<string> {
    this.events.push("main");
    return this.mainSha;
  }

  async readInventory(): Promise<LiveInventory> {
    this.events.push("inventory");
    return structuredClone(this.liveInventory);
  }

  async readIssue(
    number: number,
  ): Promise<{ issue: LiveIssue; etag: string | null }> {
    this.events.push(`issue:${number}`);
    const issue = this.issues.get(number);
    if (issue === undefined) throw new Error(`missing fixture issue ${number}`);
    return { issue: structuredClone(issue), etag: `"etag-${number}"` };
  }

  async updateIssue(
    number: number,
    patch: IssuePatch,
  ): Promise<{
    kind: "success";
    issue: LiveIssue;
    etag: string | null;
  }> {
    this.events.push(`update:${number}`);
    this.updates.push({ number, patch: structuredClone(patch) });
    const before = this.issues.get(number);
    if (before === undefined)
      throw new Error(`missing fixture issue ${number}`);
    const after = {
      ...before,
      title: patch.title,
      body: patch.body,
      labels: [...patch.labels],
    };
    this.issues.set(number, after);
    return {
      kind: "success",
      issue: structuredClone(after),
      etag: `"etag-${number}-after"`,
    };
  }
}

function expectedBody(reviewRecord: ReviewRecord): string {
  return mergeReviewBlock(OWNER_BODY, renderReviewBlock(reviewRecord)).body;
}

describe("open issue mutation planner", () => {
  it("plans a selected subset while reconciling the complete registry", async () => {
    const client = new InMemoryClient();
    const secondRecord = record({
      issue_number: 102,
      issue_node_id: "I_kwDOExample102",
      url: "https://github.com/LucasQuiles/WhatSoup/issues/102",
    });
    client.liveInventory = inventory({
      openIssueNumbers: [101, 102],
      counts: {
        openIssues: 2,
        openPullRequests: 2,
        draftPullRequests: 1,
        labels: LIVE_LABELS.length,
      },
    });
    client.issues.set(
      102,
      liveIssue({
        number: 102,
        nodeId: "I_kwDOExample102",
        url: "https://github.com/LucasQuiles/WhatSoup/issues/102",
      }),
    );

    const plans = await planIssueBatch({
      expectedMainSha: MAIN_SHA,
      registry: registry([record(), secondRecord]),
      targetIssueNumbers: [101],
      client,
    });

    expect(plans.map((plan) => plan.issue_number)).toEqual([101]);
    expect(client.events).toEqual(["main", "inventory", "issue:101"]);
    expect(client.updates).toEqual([]);

    const multiClient = new InMemoryClient();
    multiClient.liveInventory = structuredClone(client.liveInventory);
    multiClient.issues.set(102, structuredClone(client.issues.get(102)!));
    const multiPlans = await planIssueBatch({
      expectedMainSha: MAIN_SHA,
      registry: registry([record(), secondRecord]),
      targetIssueNumbers: [101, 102],
      client: multiClient,
    });
    expect(multiPlans.map((plan) => plan.issue_number)).toEqual([101, 102]);
    expect(multiPlans[0]?.plan_sha256).not.toBe(plans[0]?.plan_sha256);
  });

  it.each([
    ["empty", [], "invalid-target-selection"],
    ["duplicate", [101, 101], "invalid-target-selection"],
    ["unsorted", [102, 101], "invalid-target-selection"],
    ["nonpositive", [0], "invalid-target-selection"],
    ["non-integer", [1.5], "invalid-target-selection"],
    ["registry-absent", [999], "target-not-in-registry"],
  ])(
    "rejects %s target selection before target reads",
    async (_name, targetIssueNumbers, code) => {
      const client = new InMemoryClient();

      await expect(
        planIssueBatch({
          expectedMainSha: MAIN_SHA,
          registry: registry(),
          targetIssueNumbers,
          client,
        }),
      ).rejects.toMatchObject({ code });
      expect(client.events).toEqual(["main", "inventory"]);
    },
  );

  it("plans exact title, label, and body deltas without writing", async () => {
    const client = new InMemoryClient();
    const reviewRecord = record();
    const inputRegistry = registry([reviewRecord]);
    const plans = await planIssueBatch({
      expectedMainSha: MAIN_SHA,
      registry: inputRegistry,
      targetIssueNumbers: [101],
      client,
    });

    expect(plans).toHaveLength(1);
    expect(plans[0]).toEqual(
      expect.objectContaining({
        schema_version: 1,
        repository: REPOSITORY,
        issue_number: 101,
        issue_node_id: "I_kwDOExample101",
        expected_main_sha: MAIN_SHA,
        etag: '"etag-101"',
        title_delta: null,
        label_delta: { add: ["reliability"], remove: [] },
        changed: true,
      }),
    );
    expect(plans[0]?.body_delta).toEqual({
      before_sha256: sha256(OWNER_BODY),
      after_sha256: sha256(expectedBody(reviewRecord)),
    });
    expect(plans[0]?.managed_block).toBe(renderReviewBlock(reviewRecord));
    expect(plans[0]?.desired).toEqual({
      title: "Example finding",
      labels: ["bug", "reliability"],
      title_sha256: sha256("Example finding"),
      body_sha256: sha256(expectedBody(reviewRecord)),
    });
    expect(plans[0]?.intent_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(plans[0]?.registry_sha256).toBe(registrySha256(inputRegistry));
    expect(plans[0]?.plan_sha256).toMatch(/^[0-9a-f]{64}$/);
    const canonical = canonicalPlanJson(plans);
    expect(canonical).not.toContain(OWNER_BODY.trim());
    expect(canonical).not.toContain('"expected_body"');
    expect(canonical).not.toContain('"body":"');
    const recomputed = mergeReviewBlock(
      liveIssue().body,
      plans[0]!.managed_block,
    );
    expect(sha256(recomputed.body)).toBe(plans[0]?.desired.body_sha256);
    expect(mergeReviewBlock(recomputed.body, plans[0]!.managed_block)).toEqual({
      body: recomputed.body,
      changed: false,
    });
    expect(client.events).toEqual(["main", "inventory", "issue:101"]);
    expect(client.updates).toEqual([]);
  });

  it.each([
    [
      "main SHA",
      "main-sha-drift",
      (client: InMemoryClient) => {
        client.mainSha = "c".repeat(40);
      },
    ],
    [
      "updated timestamp",
      "issue-updated-at-drift",
      (client: InMemoryClient) => {
        client.issues.set(
          101,
          liveIssue({ updatedAt: "2026-07-26T12:00:01Z" }),
        );
      },
    ],
    [
      "raw body bytes",
      "issue-body-drift",
      (client: InMemoryClient) => {
        client.issues.set(
          101,
          liveIssue({ body: OWNER_BODY.replace("\r\n", "\n") }),
        );
      },
    ],
  ])("refuses the entire batch when %s drifts", async (_name, code, mutate) => {
    const client = new InMemoryClient();
    mutate(client);

    await expect(
      planIssueBatch({
        expectedMainSha: MAIN_SHA,
        registry: registry(),
        targetIssueNumbers: [101],
        client,
      }),
    ).rejects.toMatchObject({ code });
    expect(client.updates).toEqual([]);
  });

  it("converges to an exact unchanged no-op plan", async () => {
    const client = new InMemoryClient();
    const initial = record();
    const body = expectedBody(initial);
    const noOpRecord = record({
      pre_review_body_sha256: sha256(body),
      current_labels: ["bug", "reliability"],
      recommended_labels: ["bug", "reliability"],
    });
    client.issues.set(
      101,
      liveIssue({
        body,
        labels: ["bug", "reliability"],
      }),
    );

    const plans = await planIssueBatch({
      expectedMainSha: MAIN_SHA,
      registry: registry([noOpRecord]),
      targetIssueNumbers: [101],
      client,
    });

    expect(plans[0]).toEqual(
      expect.objectContaining({
        title_delta: null,
        label_delta: { add: [], remove: [] },
        body_delta: null,
        changed: false,
      }),
    );
    expect(plans[0]?.expected_before.body_sha256).toBe(
      plans[0]?.desired.body_sha256,
    );
    expect(client.updates).toEqual([]);
  });

  it.each([
    ["closed target", "issue-not-open", { state: "closed" as const }],
    [
      "pull-request-shaped target",
      "issue-is-pull-request",
      { isPullRequest: true },
    ],
    ["node identity", "issue-node-id-drift", { nodeId: "I_kwDOOther" }],
    [
      "repository identity",
      "issue-repository-drift",
      { repository: "other/repository" },
    ],
    [
      "canonical URL",
      "issue-url-drift",
      {
        url: "https://github.com/LucasQuiles/WhatSoup/issues/999",
      },
    ],
    ["title", "issue-title-drift", { title: "Concurrent retitle" }],
    ["complete label set", "issue-labels-drift", { labels: ["bug", "ops"] }],
  ])("rejects immutable/precondition drift: %s", async (_name, code, drift) => {
    const client = new InMemoryClient();
    client.issues.set(101, liveIssue(drift));

    await expect(
      planIssueBatch({
        expectedMainSha: MAIN_SHA,
        registry: registry(),
        targetIssueNumbers: [101],
        client,
      }),
    ).rejects.toMatchObject({ code, issueNumber: 101 });
    expect(client.updates).toEqual([]);
  });

  it.each([
    [
      "incomplete issues",
      "inventory-pagination-incomplete",
      {
        pagination: {
          issuesComplete: false,
          pullRequestsComplete: true,
          labelsComplete: true,
        },
      },
    ],
    [
      "wrong open issue count",
      "inventory-count-drift",
      {
        counts: {
          openIssues: 2,
          openPullRequests: 2,
          draftPullRequests: 1,
          labels: LIVE_LABELS.length,
        },
      },
    ],
    [
      "missing registry issue",
      "inventory-open-issue-set-drift",
      {
        openIssueNumbers: [101, 102],
        counts: {
          openIssues: 2,
          openPullRequests: 2,
          draftPullRequests: 1,
          labels: LIVE_LABELS.length,
        },
      },
    ],
  ])("fails closed on %s before target reads", async (_name, code, drift) => {
    const client = new InMemoryClient();
    client.liveInventory = inventory(drift as Partial<LiveInventory>);

    await expect(
      planIssueBatch({
        expectedMainSha: MAIN_SHA,
        registry: registry(),
        targetIssueNumbers: [101],
        client,
      }),
    ).rejects.toMatchObject({ code });
    expect(client.events).toEqual(["main", "inventory"]);
    expect(client.updates).toEqual([]);
  });

  it("reads every target before rejecting a target precondition", async () => {
    const client = new InMemoryClient();
    const secondRecord = record({
      issue_number: 102,
      issue_node_id: "I_kwDOExample102",
      url: "https://github.com/LucasQuiles/WhatSoup/issues/102",
    });
    client.liveInventory = inventory({
      openIssueNumbers: [101, 102],
      counts: {
        openIssues: 2,
        openPullRequests: 2,
        draftPullRequests: 1,
        labels: LIVE_LABELS.length,
      },
    });
    client.issues.set(
      102,
      liveIssue({
        number: 102,
        nodeId: "I_kwDOExample102",
        url: "https://github.com/LucasQuiles/WhatSoup/issues/102",
        title: "Concurrent retitle",
      }),
    );

    await expect(
      planIssueBatch({
        expectedMainSha: MAIN_SHA,
        registry: registry([record(), secondRecord]),
        targetIssueNumbers: [101, 102],
        client,
      }),
    ).rejects.toMatchObject({ code: "issue-title-drift", issueNumber: 102 });
    expect(client.events).toEqual([
      "main",
      "inventory",
      "issue:101",
      "issue:102",
    ]);
    expect(client.updates).toEqual([]);
  });

  it.each([
    [
      "case-ambiguous live catalogue",
      "case-ambiguous-label",
      () => {
        const labels = utf8Sort([...LIVE_LABELS, "Bug"]);
        return {
          liveInventory: inventory({
            labels,
            counts: {
              openIssues: 1,
              openPullRequests: 2,
              draftPullRequests: 1,
              labels: labels.length,
            },
          }),
          reviewRecord: record(),
        };
      },
    ],
    [
      "case-mismatched recommendation",
      "case-ambiguous-label",
      () => ({
        liveInventory: inventory(),
        reviewRecord: record({
          recommended_labels: ["bug", "Reliability"],
        } as Partial<ReviewRecord>),
      }),
    ],
    [
      "unknown recommendation",
      "unknown-label",
      () => ({
        liveInventory: inventory(),
        reviewRecord: record({
          recommended_labels: ["bug", "unknown-label"],
        } as Partial<ReviewRecord>),
      }),
    ],
    [
      "non-addable addition",
      "label-not-addable",
      () => ({
        liveInventory: inventory(),
        reviewRecord: record({
          recommended_labels: ["bug", "help wanted"],
        } as Partial<ReviewRecord>),
      }),
    ],
  ])("rejects %s", async (_name, code, setup) => {
    const client = new InMemoryClient();
    const configured = setup();
    client.liveInventory = configured.liveInventory;

    await expect(
      planIssueBatch({
        expectedMainSha: MAIN_SHA,
        registry: registry([configured.reviewRecord]),
        targetIssueNumbers: [101],
        client,
      }),
    ).rejects.toMatchObject({ code });
    expect(client.updates).toEqual([]);
  });

  it("preserves existing live non-addable labels", async () => {
    const client = new InMemoryClient();
    const reviewRecord = record({
      current_labels: ["bug", "help wanted"],
      recommended_labels: ["bug", "help wanted", "reliability"],
    });
    client.issues.set(101, liveIssue({ labels: ["bug", "help wanted"] }));

    const plans = await planIssueBatch({
      expectedMainSha: MAIN_SHA,
      registry: registry([reviewRecord]),
      targetIssueNumbers: [101],
      client,
    });

    expect(plans[0]?.label_delta).toEqual({ add: ["reliability"], remove: [] });
    expect(plans[0]?.desired.labels).toEqual([
      "bug",
      "help wanted",
      "reliability",
    ]);
  });

  it("sorts plans and produces byte-stable canonical JSON and hashes", async () => {
    const makeClient = (): InMemoryClient => {
      const client = new InMemoryClient();
      client.liveInventory = inventory({
        openIssueNumbers: [101, 102],
        counts: {
          openIssues: 2,
          openPullRequests: 2,
          draftPullRequests: 1,
          labels: LIVE_LABELS.length,
        },
      });
      client.issues.set(
        102,
        liveIssue({
          number: 102,
          nodeId: "I_kwDOExample102",
          url: "https://github.com/LucasQuiles/WhatSoup/issues/102",
        }),
      );
      return client;
    };
    const second = record({
      issue_number: 102,
      issue_node_id: "I_kwDOExample102",
      url: "https://github.com/LucasQuiles/WhatSoup/issues/102",
    });

    const forward = await planIssueBatch({
      expectedMainSha: MAIN_SHA,
      registry: registry([record(), second]),
      targetIssueNumbers: [101, 102],
      client: makeClient(),
    });
    const reverse = await planIssueBatch({
      expectedMainSha: MAIN_SHA,
      registry: registry([record(), second]),
      targetIssueNumbers: [101, 102],
      client: makeClient(),
    });

    expect(forward.map((plan) => plan.issue_number)).toEqual([101, 102]);
    expect(reverse).toEqual(forward);
    expect(canonicalPlanJson(forward)).toBe(canonicalPlanJson(reverse));
    expect(canonicalPlanJson(forward).endsWith("\n")).toBe(true);
    expect(JSON.parse(canonicalPlanJson(forward))).toEqual(forward);
    expect(JSON.stringify(forward)).not.toContain("undefined");
    const plansWithoutHash = forward.map(
      ({ plan_sha256: _planSha256, ...plan }) => plan,
    );
    const expectedBatchHash = sha256(
      `${JSON.stringify(canonicalizeForTest(plansWithoutHash))}\n`,
    );
    expect([...new Set(forward.map((plan) => plan.plan_sha256))]).toEqual([
      expectedBatchHash,
    ]);
  });

  it("uses the shared addable-label contract", () => {
    expect(ADDABLE_LABELS).toContain("reliability");
    expect(ADDABLE_LABELS).not.toContain("help wanted");
  });
});

interface FakeSpawnCall {
  command: string;
  args: readonly string[];
  options: Record<string, unknown>;
}

function spawnResult(
  stdout: string,
  overrides: Record<string, unknown> = {},
): ReturnType<GhSpawn> {
  return {
    pid: 123,
    output: [null, stdout, ""],
    stdout,
    stderr: "",
    status: 0,
    signal: null,
    error: undefined,
    ...overrides,
  } as ReturnType<GhSpawn>;
}

function jsonResponse(value: unknown): ReturnType<GhSpawn> {
  return spawnResult(JSON.stringify(value));
}

function includedJsonResponse(
  value: unknown,
  etag = '"fixture-etag"',
): ReturnType<GhSpawn> {
  return spawnResult(
    `HTTP/2 200 OK\r\netag: ${etag}\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(value)}`,
  );
}

function apiIssue(number = 101): Record<string, unknown> {
  return {
    number,
    node_id: `I_kwDOExample${number}`,
    repository_url: "https://api.github.com/repos/LucasQuiles/WhatSoup",
    html_url: `https://github.com/LucasQuiles/WhatSoup/issues/${number}`,
    title: "Example finding",
    body: OWNER_BODY,
    labels: [{ name: "bug" }],
    state: "open",
    updated_at: "2026-07-26T12:00:00Z",
  };
}

function apiPull(
  number = 88,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number,
    title: `Pull request ${number}`,
    body: `Implements #${number + 13}.`,
    html_url: `https://github.com/LucasQuiles/WhatSoup/pull/${number}`,
    updated_at: "2026-07-26T12:10:00Z",
    state: "open",
    merged_at: null,
    draft: false,
    head: { ref: `feature/pr-${number}` },
    base: {
      ref: "main",
      repo: { full_name: REPOSITORY },
    },
    changed_files: 1,
    ...overrides,
  };
}

function closingReferencePage(
  numbers: number[],
  hasNextPage: boolean,
  endCursor: string | null,
): ReturnType<GhSpawn> {
  return jsonResponse({
    data: {
      repository: {
        pullRequest: {
          closingIssuesReferences: {
            nodes: numbers.map((number) => ({ number })),
            pageInfo: { hasNextPage, endCursor },
          },
        },
      },
    },
  });
}

describe("gh CLI issue client", () => {
  it("paginates issues, pull requests, and labels to a proven terminal page", async () => {
    const calls: FakeSpawnCall[] = [];
    const responses = [
      jsonResponse([
        { ...apiIssue(101), body: null },
        { ...apiIssue(88), pull_request: {} },
      ]),
      jsonResponse([]),
      jsonResponse([
        { number: 88, draft: true },
        { number: 89, draft: false },
      ]),
      jsonResponse([]),
      jsonResponse([{ name: "bug" }, { name: "reliability" }]),
      jsonResponse([]),
    ];
    const spawn: GhSpawn = ((command, args, options) => {
      calls.push({
        command,
        args,
        options: options as unknown as Record<string, unknown>,
      });
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected spawn");
      return response;
    }) as GhSpawn;
    const client = new GhCliIssueClient({
      spawn,
      pageSize: 2,
      maxPages: 4,
    });

    const result = await client.readInventory();

    expect(result).toEqual({
      repository: REPOSITORY,
      openIssueNumbers: [101],
      openPullRequests: [
        { number: 88, isDraft: true },
        { number: 89, isDraft: false },
      ],
      labels: ["bug", "reliability"],
      counts: {
        openIssues: 1,
        openPullRequests: 2,
        draftPullRequests: 1,
        labels: 2,
      },
      pagination: {
        issuesComplete: true,
        pullRequestsComplete: true,
        labelsComplete: true,
      },
    });
    expect(calls).toHaveLength(6);
    expect(calls.every((call) => call.command === "gh")).toBe(true);
    expect(calls.every((call) => call.args.includes("--method"))).toBe(true);
    expect(calls.every((call) => call.args.includes("GET"))).toBe(true);
    expect(
      calls.every((call) =>
        call.args.includes("X-GitHub-Api-Version: 2022-11-28"),
      ),
    ).toBe(true);
    expect(calls.every((call) => call.options.shell === false)).toBe(true);
    expect(calls.every((call) => call.options.timeout === 30_000)).toBe(true);
    expect(calls.map((call) => call.args[1])).toEqual([
      expect.stringContaining("issues?state=open&per_page=2&page=1"),
      expect.stringContaining("issues?state=open&per_page=2&page=2"),
      expect.stringContaining("pulls?state=open&per_page=2&page=1"),
      expect.stringContaining("pulls?state=open&per_page=2&page=2"),
      expect.stringContaining("labels?per_page=2&page=1"),
      expect.stringContaining("labels?per_page=2&page=2"),
    ]);
  });

  it("captures complete deterministic registry evidence through every top and nested continuation", async () => {
    const calls: FakeSpawnCall[] = [];
    const responses = [
      jsonResponse([apiIssue(101)]),
      jsonResponse([{ ...apiIssue(88), pull_request: {} }]),
      jsonResponse([]),
      jsonResponse([{ number: 88, draft: false }]),
      jsonResponse([]),
      jsonResponse([{ name: "reliability" }]),
      jsonResponse([]),
      jsonResponse(apiPull(88)),
      jsonResponse([{ filename: "src/z.ts" }]),
      jsonResponse([]),
      closingReferencePage([101], true, "closing-cursor-1"),
      closingReferencePage([102], false, null),
      jsonResponse(apiPull(88)),
      jsonResponse([apiIssue(101)]),
      jsonResponse([{ ...apiIssue(88), pull_request: {} }]),
      jsonResponse([]),
      jsonResponse([{ number: 88, draft: false }]),
      jsonResponse([]),
      jsonResponse([{ name: "reliability" }]),
      jsonResponse([]),
    ];
    const spawn: GhSpawn = ((command, args, options) => {
      calls.push({
        command,
        args,
        options: options as unknown as Record<string, unknown>,
      });
      const response = responses.shift();
      if (response === undefined)
        throw new Error(`unexpected spawn: ${args.join(" ")}`);
      return response;
    }) as GhSpawn;
    const client = new GhCliIssueClient({
      spawn,
      pageSize: 1,
      maxPages: 4,
    });

    const result = await client.readRegistryCapture([]);

    expect(result).toEqual({
      repository: REPOSITORY,
      issues: [
        {
          number: 101,
          nodeId: "I_kwDOExample101",
          title: "Example finding",
          url: ISSUE_URL,
          body: OWNER_BODY,
          updatedAt: "2026-07-26T12:00:00Z",
          labels: ["bug"],
        },
      ],
      pullRequests: [
        {
          number: 88,
          title: "Pull request 88",
          body: "Implements #101.",
          url: "https://github.com/LucasQuiles/WhatSoup/pull/88",
          updatedAt: "2026-07-26T12:10:00Z",
          disposition: "open",
          isDraft: false,
          headRefName: "feature/pr-88",
          baseRefName: "main",
          changedFiles: 1,
          files: ["src/z.ts"],
          closingIssueNumbers: [101, 102],
        },
      ],
      labels: ["reliability"],
      pagination: {
        issuesComplete: true,
        pullRequestsComplete: true,
        labelsComplete: true,
        changedFilesComplete: true,
        closingReferencesComplete: true,
      },
    });
    expect(responses).toEqual([]);
    expect(calls.map((call) => call.args[1])).toEqual([
      expect.stringContaining("issues?state=open&per_page=1&page=1"),
      expect.stringContaining("issues?state=open&per_page=1&page=2"),
      expect.stringContaining("issues?state=open&per_page=1&page=3"),
      expect.stringContaining("pulls?state=open&per_page=1&page=1"),
      expect.stringContaining("pulls?state=open&per_page=1&page=2"),
      expect.stringContaining("labels?per_page=1&page=1"),
      expect.stringContaining("labels?per_page=1&page=2"),
      "repos/LucasQuiles/WhatSoup/pulls/88",
      expect.stringContaining("pulls/88/files?per_page=1&page=1"),
      expect.stringContaining("pulls/88/files?per_page=1&page=2"),
      "graphql",
      "graphql",
      "repos/LucasQuiles/WhatSoup/pulls/88",
      expect.stringContaining("issues?state=open&per_page=1&page=1"),
      expect.stringContaining("issues?state=open&per_page=1&page=2"),
      expect.stringContaining("issues?state=open&per_page=1&page=3"),
      expect.stringContaining("pulls?state=open&per_page=1&page=1"),
      expect.stringContaining("pulls?state=open&per_page=1&page=2"),
      expect.stringContaining("labels?per_page=1&page=1"),
      expect.stringContaining("labels?per_page=1&page=2"),
    ]);
    const graphQlPayloads = calls
      .filter((call) => call.args[1] === "graphql")
      .map(
        (call) =>
          JSON.parse(String(call.options.input)) as {
            variables: { endCursor: string | null };
          },
      );
    expect(
      graphQlPayloads.map((payload) => payload.variables.endCursor),
    ).toEqual([null, "closing-cursor-1"]);
    expect(calls.every((call) => call.command === "gh")).toBe(true);
    expect(calls.every((call) => call.options.shell === false)).toBe(true);
  });

  it("captures a previously-open pull request after it transitions to merged", async () => {
    const transitionedPull = apiPull(90, {
      state: "closed",
      merged_at: "2026-07-26T12:20:00Z",
      changed_files: 0,
    });
    const responses = [
      jsonResponse([]),
      jsonResponse([]),
      jsonResponse([]),
      jsonResponse(transitionedPull),
      jsonResponse([]),
      closingReferencePage([101], false, null),
      jsonResponse(transitionedPull),
      jsonResponse([]),
      jsonResponse([]),
      jsonResponse([]),
    ];
    const spawn: GhSpawn = (() => {
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected spawn");
      return response;
    }) as GhSpawn;
    const client = new GhCliIssueClient({ spawn, pageSize: 2, maxPages: 3 });

    const result = await client.readRegistryCapture([90]);

    expect(result.pullRequests).toEqual([
      expect.objectContaining({
        number: 90,
        disposition: "merged",
        files: [],
        closingIssueNumbers: [101],
      }),
    ]);
    expect(responses).toEqual([]);
  });

  it("fails incomplete when issue and pull-request inventories disagree about open PRs", async () => {
    const responses = [
      jsonResponse([{ ...apiIssue(88), pull_request: {} }]),
      jsonResponse([]),
      jsonResponse([]),
    ];
    const spawn: GhSpawn = (() => {
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected spawn");
      return response;
    }) as GhSpawn;

    await expect(
      new GhCliIssueClient({
        spawn,
        pageSize: 2,
      }).readRegistryCapture([]),
    ).rejects.toMatchObject({
      code: "capture-incomplete",
      operation: "read-registry-open-pull-requests",
      retryable: true,
    });
    expect(responses).toEqual([]);
  });

  it("fails incomplete when exact PR metadata changes during nested capture", async () => {
    const responses = [
      jsonResponse([{ ...apiIssue(88), pull_request: {} }]),
      jsonResponse([{ number: 88, draft: false }]),
      jsonResponse([]),
      jsonResponse(apiPull(88, { changed_files: 0 })),
      jsonResponse([]),
      closingReferencePage([], false, null),
      jsonResponse(
        apiPull(88, {
          body: "Changed while nested evidence was being captured.",
          changed_files: 0,
        }),
      ),
    ];
    const spawn: GhSpawn = (() => {
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected spawn");
      return response;
    }) as GhSpawn;

    await expect(
      new GhCliIssueClient({
        spawn,
        pageSize: 2,
      }).readRegistryCapture([]),
    ).rejects.toMatchObject({
      code: "capture-incomplete",
      operation: "read-registry-pull-request-88",
      retryable: true,
    });
    expect(responses).toEqual([]);
  });

  it("fails incomplete when the normalized top inventory changes during capture", async () => {
    const responses = [
      jsonResponse([apiIssue(101)]),
      jsonResponse([]),
      jsonResponse([]),
      jsonResponse([apiIssue(102)]),
      jsonResponse([]),
      jsonResponse([]),
    ];
    const spawn: GhSpawn = (() => {
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected spawn");
      return response;
    }) as GhSpawn;

    await expect(
      new GhCliIssueClient({
        spawn,
        pageSize: 2,
      }).readRegistryCapture([]),
    ).rejects.toMatchObject({
      code: "capture-incomplete",
      operation: "read-registry-stabilization",
      retryable: true,
    });
    expect(responses).toEqual([]);
  });

  it("bounds registry capture by the raw previously-open target count", async () => {
    let calls = 0;
    const spawn: GhSpawn = (() => {
      calls += 1;
      return jsonResponse([]);
    }) as GhSpawn;

    await expect(
      new GhCliIssueClient({
        spawn,
        maxCapturePullRequests: 1,
      }).readRegistryCapture([90, 91]),
    ).rejects.toMatchObject({
      code: "capture-budget-exceeded",
      operation: "read-registry-capture",
      retryable: true,
    });
    expect(calls).toBe(0);
  });

  it("bounds aggregate registry capture requests", async () => {
    let calls = 0;
    const spawn: GhSpawn = (() => {
      calls += 1;
      return jsonResponse([]);
    }) as GhSpawn;

    await expect(
      new GhCliIssueClient({
        spawn,
        maxCaptureRequests: 2,
      }).readRegistryCapture([]),
    ).rejects.toMatchObject({
      code: "capture-budget-exceeded",
      operation: "read-registry-labels",
      retryable: true,
    });
    expect(calls).toBe(2);
  });

  it("bounds aggregate registry capture output bytes", async () => {
    let calls = 0;
    const spawn: GhSpawn = (() => {
      calls += 1;
      return jsonResponse([]);
    }) as GhSpawn;

    await expect(
      new GhCliIssueClient({
        spawn,
        maxCaptureOutputBytes: 5,
      }).readRegistryCapture([]),
    ).rejects.toMatchObject({
      code: "capture-budget-exceeded",
      operation: "read-registry-labels",
      retryable: true,
    });
    expect(calls).toBe(3);
  });

  it("bounds total registry capture duration with a monotonic clock", async () => {
    let now = 0;
    let calls = 0;
    const spawn: GhSpawn = (() => {
      calls += 1;
      now = 11;
      return jsonResponse([]);
    }) as GhSpawn;

    await expect(
      new GhCliIssueClient({
        spawn,
        maxCaptureDurationMs: 10,
        now: () => now,
      }).readRegistryCapture([]),
    ).rejects.toMatchObject({
      code: "capture-budget-exceeded",
      operation: "read-registry-issues",
      retryable: true,
    });
    expect(calls).toBe(1);
  });

  it("rejects a closing-reference cursor cycle before claiming terminal pagination", async () => {
    const responses = [
      jsonResponse([{ ...apiIssue(88), pull_request: {} }]),
      jsonResponse([{ number: 88, draft: false }]),
      jsonResponse([]),
      jsonResponse(apiPull(88, { changed_files: 0 })),
      jsonResponse([]),
      closingReferencePage([101], true, "cursor-a"),
      closingReferencePage([102], true, "cursor-b"),
      closingReferencePage([103], true, "cursor-a"),
      closingReferencePage([104], false, null),
    ];
    const spawn: GhSpawn = (() => {
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected spawn");
      return response;
    }) as GhSpawn;

    await expect(
      new GhCliIssueClient({
        spawn,
        pageSize: 2,
        maxPages: 4,
      }).readRegistryCapture([]),
    ).rejects.toMatchObject({
      code: "gh-malformed-response",
      operation: "read-registry-closing-references-88",
      retryable: false,
    });
    expect(responses).toHaveLength(1);
  });

  it("fails incomplete when exact changed-file count disagrees with the paginated paths", async () => {
    const responses = [
      jsonResponse([{ ...apiIssue(88), pull_request: {} }]),
      jsonResponse([{ number: 88, draft: false }]),
      jsonResponse([]),
      jsonResponse(apiPull(88, { changed_files: 2 })),
      jsonResponse([{ filename: "src/only.ts" }]),
    ];
    const spawn: GhSpawn = (() => {
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected spawn");
      return response;
    }) as GhSpawn;
    const client = new GhCliIssueClient({ spawn, pageSize: 2, maxPages: 3 });

    await expect(client.readRegistryCapture([])).rejects.toMatchObject({
      code: "capture-incomplete",
      operation: "read-registry-pull-request-files-88",
      retryable: true,
    });
  });

  it("fails closed when registry capture exhausts a page bound", async () => {
    const spawn: GhSpawn = (() => jsonResponse([apiIssue(101)])) as GhSpawn;
    const client = new GhCliIssueClient({ spawn, pageSize: 1, maxPages: 1 });

    await expect(client.readRegistryCapture([])).rejects.toMatchObject({
      code: "pagination-incomplete",
      operation: "read-registry-issues",
      retryable: true,
    });
  });

  it("rejects malformed exact pull-request and closing-reference payloads", async () => {
    const malformedPullResponses = [
      jsonResponse([{ ...apiIssue(88), pull_request: {} }]),
      jsonResponse([{ number: 88, draft: false }]),
      jsonResponse([]),
      jsonResponse({ ...apiPull(88), head: 42 }),
    ];
    const malformedPullSpawn: GhSpawn = (() => {
      const response = malformedPullResponses.shift();
      if (response === undefined) throw new Error("unexpected spawn");
      return response;
    }) as GhSpawn;
    await expect(
      new GhCliIssueClient({
        spawn: malformedPullSpawn,
        pageSize: 2,
      }).readRegistryCapture([]),
    ).rejects.toMatchObject({
      code: "gh-malformed-response",
      operation: "read-registry-pull-request-88",
    });

    const malformedClosingResponses = [
      jsonResponse([{ ...apiIssue(88), pull_request: {} }]),
      jsonResponse([{ number: 88, draft: false }]),
      jsonResponse([]),
      jsonResponse(apiPull(88, { changed_files: 0 })),
      jsonResponse([]),
      jsonResponse({
        data: {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
        errors: [{ message: "partial GraphQL result" }],
      }),
    ];
    const malformedClosingSpawn: GhSpawn = (() => {
      const response = malformedClosingResponses.shift();
      if (response === undefined) throw new Error("unexpected spawn");
      return response;
    }) as GhSpawn;
    await expect(
      new GhCliIssueClient({
        spawn: malformedClosingSpawn,
        pageSize: 2,
      }).readRegistryCapture([]),
    ).rejects.toMatchObject({
      code: "gh-malformed-response",
      operation: "read-registry-closing-references-88",
    });

    const foreignIssueResponses = [
      jsonResponse([
        {
          ...apiIssue(101),
          repository_url: "https://api.github.com/repos/Other/Repo",
        },
      ]),
      jsonResponse([]),
      jsonResponse([]),
    ];
    const foreignIssueSpawn: GhSpawn = (() => {
      const response = foreignIssueResponses.shift();
      if (response === undefined) throw new Error("unexpected spawn");
      return response;
    }) as GhSpawn;
    await expect(
      new GhCliIssueClient({
        spawn: foreignIssueSpawn,
        pageSize: 2,
      }).readRegistryCapture([]),
    ).rejects.toMatchObject({
      code: "gh-malformed-response",
      operation: "read-registry-issues",
    });
  });

  it("uses an explicit API version, no shell, stdin payloads, and included ETags", async () => {
    const calls: FakeSpawnCall[] = [];
    const responses = [
      jsonResponse({ object: { sha: MAIN_SHA } }),
      includedJsonResponse(apiIssue()),
      includedJsonResponse(
        {
          ...apiIssue(),
          title: "Retitled",
          body: "Expected body",
          labels: [{ name: "bug" }, { name: "reliability" }],
        },
        '"after-etag"',
      ),
    ];
    const spawn: GhSpawn = ((command, args, options) => {
      calls.push({
        command,
        args,
        options: options as unknown as Record<string, unknown>,
      });
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected spawn");
      return response;
    }) as GhSpawn;
    const client = new GhCliIssueClient({ spawn });

    expect(await client.readMainSha()).toBe(MAIN_SHA);
    await expect(client.readIssue(101)).resolves.toMatchObject({
      etag: '"fixture-etag"',
    });
    await expect(
      client.updateIssue(101, {
        title: "Retitled",
        body: "Expected body",
        labels: ["bug", "reliability"],
      }),
    ).resolves.toMatchObject({ kind: "success", etag: '"after-etag"' });

    expect(
      calls.map((call) => call.args[call.args.indexOf("--method") + 1]),
    ).toEqual(["GET", "GET", "PATCH"]);
    expect(
      calls.every((call) =>
        call.args.includes("X-GitHub-Api-Version: 2022-11-28"),
      ),
    ).toBe(true);
    expect(calls.every((call) => call.options.shell === false)).toBe(true);
    expect(calls[2]?.options.input).toBe(
      JSON.stringify({
        title: "Retitled",
        body: "Expected body",
        labels: ["bug", "reliability"],
      }),
    );
    expect(calls[2]?.args).toContain("--input");
    expect(calls[2]?.args).toContain("-");
  });

  it("fails closed when max-page exhaustion cannot prove pagination complete", async () => {
    const spawn: GhSpawn = (() => jsonResponse([apiIssue(101)])) as GhSpawn;
    const client = new GhCliIssueClient({ spawn, pageSize: 1, maxPages: 1 });

    await expect(client.readInventory()).rejects.toMatchObject({
      code: "pagination-incomplete",
      operation: "read-inventory-issues",
    });
  });

  it.each([
    [
      "timeout",
      spawnResult("", {
        status: null,
        error: Object.assign(new Error("spawnSync gh ETIMEDOUT"), {
          code: "ETIMEDOUT",
        }),
      }),
      "transport-timeout",
    ],
    [
      "termination",
      spawnResult("", {
        status: null,
        signal: "SIGTERM",
      }),
      "process-terminated",
    ],
    [
      "HTTP or transport failure",
      spawnResult("", {
        status: 1,
        stderr: "gh: HTTP 503",
      }),
      "write-disposition-unknown",
    ],
    [
      "bounded-output failure",
      spawnResult("x".repeat(257)),
      "output-bound-exceeded",
    ],
    ["empty response", spawnResult("  \n"), "empty-response"],
    [
      "malformed response",
      spawnResult("{not-included-json"),
      "malformed-response",
    ],
  ])(
    "returns one explicit ambiguous PATCH result for %s",
    async (_name, response, diagnosticCode) => {
      let calls = 0;
      const spawn: GhSpawn = (() => {
        calls += 1;
        return response;
      }) as GhSpawn;
      const client = new GhCliIssueClient({ spawn, maxOutputBytes: 256 });

      await expect(
        client.updateIssue(101, {
          title: "Retitled",
          body: "Expected body",
          labels: ["bug"],
        }),
      ).resolves.toEqual({ kind: "ambiguous", diagnosticCode });
      expect(calls).toBe(1);
    },
  );

  it.each([
    [
      "missing gh",
      spawnResult("", {
        status: null,
        error: Object.assign(new Error("spawnSync gh ENOENT"), {
          code: "ENOENT",
        }),
      }),
      "gh-not-found",
    ],
    [
      "authentication refusal",
      spawnResult("", {
        status: 1,
        stderr: "authentication required: run gh auth login",
      }),
      "gh-auth-failed",
    ],
  ])(
    "keeps proven pre-write %s as a typed throw",
    async (_name, response, code) => {
      const spawn: GhSpawn = (() => response) as GhSpawn;
      const client = new GhCliIssueClient({ spawn });

      await expect(
        client.updateIssue(101, {
          title: "Retitled",
          body: "Expected body",
          labels: ["bug"],
        }),
      ).rejects.toMatchObject({ code });
    },
  );

  it.each([
    ["empty stderr", ""],
    ["unrelated stderr", "request could not be completed"],
  ])(
    "treats authoritative status 4 with %s as one definite auth throw",
    async (_name, stderr) => {
      let calls = 0;
      const spawn: GhSpawn = (() => {
        calls += 1;
        return spawnResult("", { status: 4, stderr });
      }) as GhSpawn;
      const client = new GhCliIssueClient({ spawn });

      await expect(
        client.updateIssue(101, {
          title: "Retitled",
          body: "Expected body",
          labels: ["bug"],
        }),
      ).rejects.toMatchObject({
        code: "gh-auth-failed",
        retryable: false,
      });
      expect(calls).toBe(1);
    },
  );

  it.each([
    ["ENOENT", "gh-not-found"],
    ["ETIMEDOUT", "gh-timeout"],
  ])(
    "classifies a thrown %s on reads without retry",
    async (errnoCode, code) => {
      let calls = 0;
      const spawn: GhSpawn = (() => {
        calls += 1;
        throw Object.assign(new Error(`spawnSync gh ${errnoCode}`), {
          code: errnoCode,
        });
      }) as GhSpawn;
      const client = new GhCliIssueClient({ spawn });

      await expect(client.readMainSha()).rejects.toMatchObject({ code });
      expect(calls).toBe(1);
    },
  );

  it.each([
    ["ENOENT", "throw", "gh-not-found"],
    ["ETIMEDOUT", "ambiguous", "transport-timeout"],
    ["EUNKNOWN", "ambiguous", "write-disposition-unknown"],
  ])(
    "classifies a thrown %s on PATCH without retry",
    async (errnoCode, outcome, code) => {
      let calls = 0;
      const spawn: GhSpawn = (() => {
        calls += 1;
        throw Object.assign(new Error(`spawnSync gh ${errnoCode}`), {
          code: errnoCode,
        });
      }) as GhSpawn;
      const client = new GhCliIssueClient({ spawn });
      const update = client.updateIssue(101, {
        title: "Retitled",
        body: "Expected body",
        labels: ["bug"],
      });

      if (outcome === "throw") {
        await expect(update).rejects.toMatchObject({ code });
      } else {
        await expect(update).resolves.toEqual({
          kind: "ambiguous",
          diagnosticCode: code,
        });
      }
      expect(calls).toBe(1);
    },
  );

  it.each([
    [
      "missing gh",
      spawnResult("", {
        status: null,
        error: Object.assign(new Error("spawnSync gh ENOENT"), {
          code: "ENOENT",
        }),
      }),
      "gh-not-found",
    ],
    [
      "authentication failure",
      spawnResult("", {
        status: 1,
        stderr:
          "authentication required: run gh auth login with a private token",
      }),
      "gh-auth-failed",
    ],
    [
      "HTTP/CLI failure",
      spawnResult("", {
        status: 1,
        stderr: "gh: HTTP 503",
      }),
      "gh-api-failed",
    ],
    ["malformed JSON", spawnResult("{not-json"), "gh-malformed-json"],
    ["empty output", spawnResult("  \n"), "gh-empty-output"],
    ["oversized output", spawnResult("x".repeat(257)), "gh-output-too-large"],
  ])("returns a bounded typed error for %s", async (_name, response, code) => {
    const spawn: GhSpawn = (() => response) as GhSpawn;
    const client = new GhCliIssueClient({
      spawn,
      maxOutputBytes: 256,
    });

    const error = await client.readMainSha().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitHubClientError);
    expect(error).toMatchObject({
      code,
      operation: "read-main",
      retryable: expect.any(Boolean),
    });
    expect(JSON.stringify(error).length).toBeLessThan(2_000);
  });

  it("rejects malformed included responses and issue payloads", async () => {
    const missingHeaders: GhSpawn = (() => jsonResponse(apiIssue())) as GhSpawn;
    await expect(
      new GhCliIssueClient({ spawn: missingHeaders }).readIssue(101),
    ).rejects.toMatchObject({ code: "gh-malformed-response" });

    const malformedIssue: GhSpawn = (() =>
      includedJsonResponse({
        ...apiIssue(),
        body: 42,
      })) as GhSpawn;
    await expect(
      new GhCliIssueClient({ spawn: malformedIssue }).readIssue(101),
    ).rejects.toMatchObject({ code: "gh-malformed-response" });
  });

  it("exposes exit-safe planning errors with stable fields", () => {
    const error = new IssuePlanningError("main-sha-drift", "main changed", {
      issueNumber: null,
    });
    expect(error.toJSON()).toEqual({
      name: "IssuePlanningError",
      code: "main-sha-drift",
      message: "main changed",
      issueNumber: null,
      retryable: false,
    });
  });
});
