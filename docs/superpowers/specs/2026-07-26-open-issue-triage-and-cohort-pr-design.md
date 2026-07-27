# Open-Issue Triage and Cohort PR Design

**Status:** active
**Date:** 2026-07-26
**Pinned baseline:** `10555644722d739615da0e3bd3f091545d8447bc`

## Purpose

Turn the open-issue backlog into an evidence-backed delivery queue without creating
duplicate implementations, empty tracking branches, or broad pull requests whose
blast radius cannot be reviewed safely.

The workflow must:

- review every open issue against current source, tests, and open pull requests;
- distinguish verified findings from stale, duplicate, measurement-only, and
  operationally unverified claims;
- add missing remediation, impact, blast-radius, and dependency information;
- apply the existing label taxonomy consistently;
- group only code-coherent leaf issues into draft pull requests;
- preserve issue and Git estate history through deterministic, idempotent ledgers; and
- leave no untracked work, temporary worktree, stash, or unowned branch behind.

## Observed Baseline

The live inventory at the pinned baseline contained:

- 168 open issues;
- 57 issues with no labels;
- no issue assignees or milestones;
- 21 open pull requests, including 7 drafts;
- 8 issues whose titles were malformed body excerpts; and
- 47 local worktrees, 11 dirty worktrees, 1 conflicted worktree, 85 local branches,
  and no stashes or prunable worktrees.

The primary checkout is conflicted and is not a safe mutation surface. All writes for
this program use a dedicated worktree created from the latest observed `origin/main`.

## Evidence Model

Every issue receives one of these review states:

| State | Meaning | Required evidence |
|---|---|---|
| `verified` | The decisive source seam remains on the pinned main revision. | Source or test location plus a run falsifier when practical. |
| `partial` | Part of an umbrella issue remains, but some findings are fixed, stale, or separately owned. | Per-finding disposition and surviving scope. |
| `measurement-required` | Static evidence is insufficient to establish the reported behavior. | Bounded reproduction or measurement plan. |
| `contradicted` | Current main disproves the issue's load-bearing claim. | Direct counterexample and suggested disposition. |
| `live-revalidation-required` | Repository source cannot prove current deployment or fleet state. | Owner-safe live probe plan with no private evidence in public text. |

Worker findings remain advisory until the lead rechecks the decisive source, diff, test,
or runtime receipt. Missing, interrupted, masked, stale, or partial worker output is
recorded as inconclusive.

## Canonical Registry and Mutation Ledger

The implementation will add:

- `docs/triage/open-issue-registry.json` as the machine-readable source of truth;
- a generated human-readable `open-issue-registry` view beside that source; and
- `docs/triage/open-issue-review-ledger.jsonl` as the append-only mutation receipt.

Each registry record contains:

- issue number, title, URL, update timestamp, and pre-review body hash;
- current and recommended labels;
- leaf, tracker, duplicate, stale, or measurement-only classification;
- evidence state and pinned revision;
- decisive source and test paths;
- falsifier or remaining evidence gap;
- suggested remediation;
- impact and blast-radius analysis;
- dependencies, duplicate relationships, and implementation ordering;
- open, merged, and closed-unmerged pull-request overlap;
- proposed cohort identifier and pull-request owner; and
- review confidence and lead-verification obligations.

The ledger records the exact before/after body hashes, label delta, title delta, captured
issue update timestamp, operation result, and verification timestamp. It does not copy
entire issue bodies into the repository.

## Issue-Body Updates

Issue-body enrichment is append-only and idempotent. The managed section is bounded by:

```markdown
<!-- triage-review:start -->
## Triage review
...
<!-- triage-review:end -->
```

The updater replaces only that managed block on a repeat run. It refuses to mutate an
issue when the live update timestamp or pre-review body hash differs from the registry.
Every successful edit is re-read from the API and its body hash and labels are compared
with the expected result.

Already-rich issues receive a concise delta review rather than duplicated evidence.
No issue comments are posted by this workflow. Public text must contain no private host,
account, path, message, chat, event, or operator identifiers.

## Label Policy

The first pass uses existing labels only. Labels describe:

- work type: `bug`, `enhancement`, `refactor`, `documentation`;
- domain: `alerts`, `chat`, `config`, `console`, `fleet`, `mcp`, `ops`,
  `scheduler`, `transport`;
- quality concern: `audit`, `reliability`, `security`, `portability`, `tech-debt`,
  `type-safety`, `DRY`, `SOC`, `SSOT`, `dead-code`; and
- disposition where proven: `duplicate`, `invalid`.

Priority is not inferred from prose or severity language. New priority or workflow labels
require a separately reviewed taxonomy change.

## Tracker and Leaf Rules

An issue is a tracker when it spans independent ownership, persistence, or failure
boundaries. Trackers retain dependency and progress information but are not treated as
one implementation pull request.

A leaf issue must have:

- one primary owner boundary;
- one falsifiable behavior change;
- bounded affected paths;
- explicit dependency and collision notes; and
- acceptance criteria that can be exercised in one branch.

Umbrella audit issues are split into leaves for high- and medium-impact findings.
Low-impact findings may remain on the tracker until a coherent cleanup batch exists.

## Draft Pull-Request Cohorts

A new draft pull request is allowed only when:

- the branch contains a real design, test, or implementation commit;
- its issues share one source owner or persistence boundary;
- dependencies are either landed or explicitly represented in the draft;
- no open pull request already owns the same acceptance criteria;
- touched-file overlap with open pull requests has been inspected;
- the pull-request body links every included leaf and names trackers without closing
  them; and
- the cohort remains reviewable, normally two to eight leaf issues.

No empty, placeholder, or documentation-only tracking pull request is created for an
implementation cohort. This design and the generated registry are themselves a
documentation deliverable, so their initial draft pull request is substantive.

Initial candidate sequences are:

1. alert schema and producer-authority foundations;
2. dispatcher acceptance and durable episode fencing;
3. collector claim identity and content-bound acknowledgement;
4. producer-specific durable recovery lifecycles;
5. agent turn finalization and replay ownership;
6. narrow SSOT, type-safety, portability, and test-integrity leaves.

Cross-boundary omnibus pull requests are prohibited even when their issues share a broad
label such as `alerts` or `tech-debt`.

## Existing Pull-Request Reconciliation

Before creating a cohort branch, the workflow checks open and historical pull requests
for issue references, closing references, touched paths, and matching acceptance
criteria.

Competing implementations are compared with `git range-diff`, `git cherry -v`, focused
diff inspection, and targeted tests. A branch is not called superseded, closed, or
deleted from a title/body reference alone. Closed-unmerged attempts are treated as owner
feedback and require a materially different remediation or explicit reuse decision.

## Main-Branch Realignment

Each publication batch captures:

- the current `origin/main` object ID;
- live issue, label, and pull-request counts;
- issue update timestamps and body hashes;
- local worktree, dirty-worktree, branch, conflict, stash, and prunable counts; and
- the branch's ahead/behind relation to main.

If main advances before mutation or publication, the batch stops, refreshes affected
source evidence and pull-request overlap, then rebases the isolated branch. It does not
rewrite or auto-resolve unrelated work.

## Validation and Safety Gates

Before an issue mutation batch:

- validate the registry schema and unique issue coverage;
- prove that every live open issue has exactly one registry record;
- reject unknown labels and invalid dependency references;
- scan generated public text for private identifiers and prohibited attribution;
- assert unchanged issue timestamps and pre-review body hashes; and
- run in dry-run mode and inspect the exact title, label, and body deltas.

Before a push:

- run focused tests for changed generators and guards;
- regenerate and check the repository work index;
- run documentation, publication, repository-hygiene, and source-runtime guards;
- verify the pushed commit equals the locally tested commit; and
- create or update only the intended draft pull request against `main`.

A masked, skipped, missing, or environment-blocked check is inconclusive and is reported
as such.

## Cleanup and Completion

After each published batch:

- re-read the draft pull request and changed issues from the API;
- confirm the remote branch tip matches the verified local commit;
- remove the program's local worktree after confirming it is clean;
- retain only branches that own an open pull request or explicitly recorded follow-up;
- create no stash;
- run worktree and branch inventory again; and
- update the registry and ledger with the publication receipt.

Issue closure, pull-request merge, and deletion of pre-existing worktrees or branches are
outside this design unless separately authorized and verified.
