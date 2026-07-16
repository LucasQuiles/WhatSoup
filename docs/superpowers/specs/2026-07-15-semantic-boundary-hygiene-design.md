# Semantic Boundary Hygiene Specification

**Status:** Active — approved for semantic-foundation implementation planning
**Review:** Owner-approved direction on 2026-07-15; production enforcement has not started
**Date:** 2026-07-15
**Owner:** Lucas Quiles
**Scope:** WhatSoup repository quality boundaries and the read-only contract used by external PR/issue producers
**Implementation plan:** `docs/superpowers/plans/2026-07-15-semantic-boundary-foundation.md`
**Implementation notes:** `docs/superpowers/handoffs/2026-07-15-semantic-boundary-hygiene-implementation-notes.md`

## Outcome

WhatSoup should stop treating a syntactically clean, well-tested, or CI-green change as
proof that the change is integrated, novel, current, and safe to reconsider. The repository
will add semantic reachability checks, upstream provenance checks, deterministic duplicate
fingerprints, disposition-aware re-entry checks, and contextual feedback receipts at the
commit, push, pull-request, and release boundaries.

The checks must tell an agent exactly what action was evaluated, what evidence was observed,
why the action was allowed, warned, blocked, or considered inconclusive, and what concrete
change or command can resolve the finding. Passing output stays concise; warnings and blocks
are intentionally explicit.

## Authority and Tranche Boundary

This specification defines the full semantic-boundary program. The approved first implementation
tranche is narrower: semantic production reachability, executable negative-control proof for guard
tests, structural decision-poll verification, contextual receipts, and shadow-mode local/CI wiring.
It does not authorize GitHub writes, ruleset changes, blocking required-check promotion, automatic
comments or labels, supply-chain pin replacement, or external producer changes.

The first tranche must remain independently reviewable and reversible. Provenance/history,
local enforcement, GitHub enforcement, and external producer integration each receive a separate
implementation plan after the preceding tranche supplies measured false-positive, latency, and
feedback-correction evidence. The existing experiment evaluator is evidence and a reusable test
oracle; it is not itself the production guard architecture.

## Measured Calibration

The direction was evaluated before implementation on an isolated experiment branch.

| Evaluation | Correct | Accuracy | False blocks | Missed block cases |
|---|---:|---:|---:|---:|
| Current gates, locked visible/synthetic corpus | 13/40 | 32.5% | 0 | 19 |
| Candidate, same locked corpus | 40/40 | 100% | 0 | 0 |
| Frozen candidate, later holdout | 18/18 | 100% | 0 | 0 |

The locked corpus contains 10 recent visible PR snapshots and 30 synthetic cases. The holdout adds
17 adversarial synthetic cases plus the newly wired current head of PR #1835. Seven main-corpus
Git revisions and one holdout revision were traversed from exact Git objects. Required feedback
fields were present in every candidate intervention finding.

These measurements justify prioritizing the semantic foundation. They do **not** justify enabling
blocking enforcement immediately: the examples are curated, synthetic labels encode this policy,
GitHub provider behavior was not exercised end-to-end, and structural feedback completeness does
not prove that an agent understands or acts on the feedback. Shadow observation and agent
correction-rate measurement remain mandatory promotion gates.

## Normative Requirements

- **SBH-001 — Exact candidate identity:** Every decision records the exact candidate head and the
  evidence source used to inspect it. Working-tree content may not silently stand in for a pushed
  commit.
- **SBH-002 — Runtime reachability:** An added production TypeScript/TSX module is integrated only
  when a runtime edge connects it to a declared production root. Type-only imports, tests,
  comments, strings, and unresolved computed imports do not establish the edge.
- **SBH-003 — Honest unknowns:** Missing Git objects, parse failures, unavailable upstream state,
  incomplete pagination, and timeouts produce `inconclusive`, never `pass`.
- **SBH-004 — Exact before heuristic:** Exact fingerprints and stable patch evidence may block;
  similarity and path overlap warn until a separately proven deterministic rule applies.
- **SBH-005 — Re-entry evidence:** A prior architectural or runtime-wiring disposition remains in
  force until a material delta, complete re-entry packet, or scoped owner override is present.
- **SBH-006 — Feedback completeness:** Every warning, block, or inconclusive decision contains the
  action, observed evidence, reason, correction, exact rerun command, and source references.
- **SBH-007 — One engine, many adapters:** Hooks, local commands, workflows, and external producer
  preflights consume the same policy functions and receipt schema.
- **SBH-008 — Shadow before block:** A new blocker is first observed in shadow mode and requires a
  negative control, positive control, false-positive control, rollback path, and measured owner or
  agent review before promotion.
- **SBH-009 — No ambient bypass:** Overrides are owner-authored, rule- and fingerprint-scoped,
  time-bounded records. Environment variables and magic comments are not durable overrides.
- **SBH-010 — Read-only GitHub access:** Repository-side history checks use read-only contents,
  pull-request, and issue permissions and never execute untrusted head code with a privileged token.
- **SBH-011 — Immutable upstream identity:** Enforced third-party action and image references use
  full immutable identifiers plus a reviewable provenance record.
- **SBH-012 — Bounded execution:** Boundary processes have an external deadline and owned
  process-group cleanup. A deadline expiry is `inconclusive` and boundary-blocking once enforced.

## Evidence Behind the Design

- PR #1835 is a production-orphaned capability grant manager. Its targeted 41-test suite and
  all GitHub checks pass even though zero/negative durations grant capability, `arm()` works
  before startup reconciliation, and a store-write failure can leave policy elevated without
  a durable record.
- PRs #1838 and #1848 contained byte-identical source and test blobs. The owner comment on
  issue #1873 identifies the same two GitHub blob OIDs in both closed-unmerged PRs and asks for
  pre-creation changed-path/blob comparison plus a durable closure disposition.
- PR #1857 was reopened after a hygiene-only correction without addressing its architectural
  duplication or missing production caller.
- PRs #1832, #1845, and #1846 fixed checks that inspected a promising textual/loop/symlink
  shape without proving the protected behavior.
- PR #1860 fixed a test-harness teardown hang. The local pre-push driver still has no outer
  wall-clock/process-group boundary.
- The active ruleset requires only `quality (24.x)` and `quality (25.x)`. There is no separate
  required semantic-boundary result.
- Current workflows use mutable action tags such as `actions/checkout@v4`; the Docker base is
  patch-pinned (`node:24.15.0-slim`) but not digest-pinned.

## Design Principles

1. **Behavior before shape.** Comments, strings, tests, declarations, and disconnected source
   islands do not prove runtime integration.
2. **One decision, many adapters.** Local hooks and GitHub Actions invoke the same check
   functions and render the same receipt; they do not reimplement policy in shell/YAML.
3. **Exact evidence before similarity.** Exact blob/content matches may block. Heuristic
   similarity warns unless a durable owner disposition supplies a stronger deterministic rule.
4. **History includes rejected work.** Open and closed PRs/issues are both relevant. A closed
   unmerged artifact is not forgotten merely because its branch or PR number changed.
5. **Unknown is not clean.** Network/API/parse failures become an explicit `inconclusive`
   decision at blocking boundaries.
6. **Feedback is part of the control.** A block without observed evidence, corrective steps,
   and a rerun command is an incomplete guard.
7. **No automatic GitHub conversation writes in this tranche.** Results appear in hook output,
   workflow annotations, and job summaries. PR/issue comments or labels require a separate
   owner-approved mutation design.

## Enforcement Architecture

### 1. Semantic production reachability

Build a TypeScript/TSX module graph rooted at the real production entrypoints. Static imports,
re-exports, dynamic imports with literal specifiers, and known composition registrations form
edges. Tests, fixtures, comments, strings, and source modules unreachable from a production
root do not satisfy integration.

The initial production roots are exactly:

- `src/main.ts`;
- `src/bootstrap.ts`;
- `src/bootstrap-auth.ts`;
- `src/fleet/standalone.ts`;
- `src/transport/auth.ts`.

Changing this list is a policy change with a positive and negative fixture. Added/renamed modules
are the first block-capable delta. Modified pre-existing islands and full-tree export inventory
start as warnings so the tranche does not convert historical debt into an unrelated hard stop.

The first implementation reuses WS-D03 from
`docs/superpowers/plans/2026-07-09-architecture-and-verification-quality.md`:

- add `scripts/semantic-quality-check.ts` backed by focused modules under
  `scripts/lib/semantic-quality/`;
- replace text-counting tests with fixture-driven reachability tests;
- require guard companion tests to import, invoke, and prove a failure path;
- make decision-poll checks structural and executable;
- remove the production-orphaned delegation-receipt API unless separately wired;
- expose one `verify:semantic` package command.

An allowlist entry is path-qualified and must include an owner, reason, expiry date, and re-entry
condition. Missing, malformed, or expired entries block.

### 2. Upstream and branch provenance

The boundary receipt records these values separately:

- `remote_tip_oid`: current `refs/heads/main` observed from the remote/API;
- `local_tracking_oid`: local `refs/remotes/origin/main`;
- `merge_base_oid`: merge base of the candidate head and remote tip;
- `head_oid`: candidate commit;
- `base_distance`: ahead/behind counts;
- `observed_at`: UTC timestamp and observation source.

Local pre-push uses `git ls-remote origin refs/heads/main` and the local object graph. GitHub
Actions uses the pull-request API/event plus a full-history checkout where needed. A local
tracking OID that does not equal the remotely observed tip is a block because subsequent diff
and duplicate claims would be based on stale evidence.

After tip parity is established, an older merge base is:

- a **block** when upstream changes overlap candidate paths or touch entrypoints, boundary
  policy, workflows, lockfiles, generated manifests, or other declared high-coupling surfaces;
- a **warning** when the upstream delta is demonstrably disjoint, including the behind count
  and the recommended fetch/rebase command;
- **inconclusive** when the remote tip, merge base, changed paths, or overlap cannot be proven.

This avoids both stale-base false confidence and a blanket “every branch must be rebased” rule.

### 3. Proposal and content fingerprints

Git object IDs are used as repository identity, not as a cryptographic security claim. A
portable SHA-256 digest is layered over a canonical record so duplicate detection is independent
of Git's object-format choice.

For each candidate, compute:

- `path_blob_set`: sorted `(status, old_path?, path, blob_oid)` records;
- `content_fingerprint_sha256`: SHA-256 of the canonical path/blob set, excluding PR number,
  branch name, base, and head so the same content remains detectable after recreation;
- `patch_id_stable`: `git patch-id --stable` when a complete patch is locally available;
- `proposal_fingerprint_sha256`: SHA-256 over content fingerprint plus base/head provenance and
  normalized task identity;
- `changed_symbols`: AST-derived declarations and imports for contextual feedback.

The GitHub pull-file API is authoritative for historical PR path/blob records. Locally staged
content uses the index blob. The check queries open and closed PRs, paginates completely, and
records the query timestamp and repository.

Decision rules:

- exact content fingerprint matching a closed-unmerged PR: **block** by default;
- exact content fingerprint matching an open PR: **block** and direct work to the existing PR;
- exact subset/superset blob reuse: **warn**, because legitimate shared refactors exist;
- stable patch match with path renames: **block** when the prior artifact was closed-unmerged;
- changed-path overlap without exact content: **warn** and show the prior artifacts;
- same branch/task identity with only hygiene, formatting, docs, or assertion changes after an
  architectural/runtime-wiring rejection: **block** unless a resubmission packet proves the
  recorded re-entry condition;
- exact normalized issue title/body fingerprint: **block at the external producer boundary**;
- issue title, referenced paths/symbols, or acceptance-criteria similarity: **warn**, never block
  solely on heuristic similarity.

### 4. Durable disposition and re-entry packet

The durable producer-side record uses this taxonomy initially:

- `duplicate-existing-mechanism`
- `reproduced-correctness-defect`
- `production-unreachable`
- `out-of-scope`
- `needs-specific-repro`
- `superseded`
- `accepted-for-reentry`

A resubmission packet names every prior PR/issue, the prior disposition, the material delta,
evidence for each closure reason, the current production owner/caller, and an explicit override
reference when applicable. Cosmetic, test-only, formatting-only, or generic “CI fixed” deltas
cannot satisfy architectural or runtime-wiring dispositions.

WhatSoup owns the schema, validators, and read-only check. The automated producer that creates
or reopens GitHub artifacts appears to live outside this repository; persisting dispositions and
calling the pre-creation check must be implemented at that producer boundary. Until located and
updated, producer-side prevention remains incomplete even if repository PR checks are blocking.

### 5. Upstream supply-chain hashes

A separate supply-chain guard prevents “upstream hash” from being conflated with PR identity:

- third-party GitHub Action `uses:` references must be pinned to a full commit SHA with a nearby
  human-readable release comment;
- Docker base images must use the canonical Node patch and an immutable image digest;
- action/image pin changes must update a small provenance manifest containing source, version,
  immutable identifier, update reason, and verification command;
- `ubuntu-latest` and floating Node matrix entries remain explicit warnings until a deliberate
  runner/runtime support policy promotes them to blocking;
- missing or malformed immutable pins block; inability to verify an upstream identifier is
  inconclusive, not clean.

This guard should use fixtures and parsed YAML/Dockerfile structures rather than raw string
presence.

## Contextual Feedback Contract

Every finding is represented as a `BoundaryFinding` and every invocation emits one
`BoundaryReceipt`.

```ts
type BoundaryDecision = 'pass' | 'warn' | 'block' | 'inconclusive';

interface BoundaryFinding {
  ruleId: string;
  decision: BoundaryDecision;
  action: 'commit' | 'push' | 'open-pr' | 'reopen-pr' | 'update-pr' | 'open-issue' | 'merge' | 'tag';
  summary: string;
  why: string;
  observed: Array<{ label: string; value: string }>;
  matchedArtifacts: Array<{ kind: 'pr' | 'issue'; number: number; url: string; state: string }>;
  disposition?: string;
  correction: string[];
  rerun: string;
  sourceRefs: string[];
}

interface BoundaryReceipt {
  schemaVersion: 1;
  repository: string;
  invocation: string;
  decision: BoundaryDecision;
  base: Record<string, string | number | null>;
  fingerprints: Record<string, string | null>;
  findings: BoundaryFinding[];
  limitations: string[];
}
```

Human rendering on warning/block/inconclusive follows this order:

1. decision, rule ID, and attempted action;
2. the actual base/head/path/symbol/fingerprint evidence;
3. the matching PRs/issues and their current states;
4. the applicable owner disposition and why this action violates it;
5. situational correction steps, naming existing production owners or files when known;
6. the exact rerun command;
7. a JSON receipt path or CI summary reference.

Pass output is one line plus receipt location. GitHub rendering adds `::error`/`::warning`
annotations and a structured `$GITHUB_STEP_SUMMARY`; local rendering writes actionable detail to
stderr so the driving agent receives it in the same tool context. `--format json` supports an
external producer's preflight without scraping prose.

### Example feedback

**Production island block**

```text
BLOCK [semantic.production-reachability] while pushing qpi/capability-grant
Observed: src/lib/capability-grant.ts exports runtime values; no path from any declared production
root reaches the module. Only tests import it.
Why: tests prove the isolated primitive, not a WhatSoup runtime behavior.
Correction: integrate at the named composition owner and add a behavior test through that owner,
or remove the module. Do not allowlist a proposed feature.
Rerun: npm run verify:semantic
```

**Exact rejected duplicate block**

```text
BLOCK [history.exact-closed-pr] while opening a pull request
Observed: content fingerprint ... matches closed-unmerged PR #1838 and PR #1848; both source and
test blobs are byte-identical. Prior disposition: duplicate-existing-mechanism plus reproduced-
correctness-defect.
Correction: extend the existing ingestion owner, or provide a resubmission packet that links the
prior PRs and proves both the architecture and stale-timer defect changed.
```

**Stale upstream overlap block**

```text
BLOCK [provenance.stale-overlap] while pushing
Observed: local origin/main=A, remote main=B, candidate head=C. Upstream changed
src/transport/outbound-governor.ts, which this branch also changes.
Correction: fetch origin, rebase/merge deliberately, rerun the targeted governor tests, then rerun
the boundary check. No duplicate verdict was issued because the base evidence was stale.
```

**Likely issue overlap warning**

```text
WARN [history.related-issue] while preparing a PR
Observed: changed symbol wrapWithOutboundGovernor and path src/transport/outbound-governor.ts are
already discussed in open issue #1783. This is not an exact duplicate.
Correction: link #1783, state which acceptance criterion this change closes, and identify any
remaining tiers. Continue only after the PR body carries that mapping.
```

**Supply-chain block**

```text
BLOCK [supply-chain.mutable-action] while committing .github/workflows/quality.yml
Observed: actions/checkout@v4 is a mutable tag.
Correction: pin the reviewed release to its full commit SHA, retain `# v4.x.y` for readability,
and update the provenance manifest. Rerun: npm run guard:upstream-pins
```

## Boundary Placement

| Boundary | Checks | Result delivery |
|---|---|---|
| Pre-commit | staged semantic island delta, guard negative-control coverage, workflow/image pin syntax | stderr + local JSON receipt |
| Pre-push | remote-tip parity, stale overlap, semantic reachability, local exact fingerprint history, bounded branch gate | stderr + local JSON receipt |
| Pull request | definitive GitHub open/closed PR comparison, disposition packet, semantic job, upstream pins | required check annotations + job summary |
| Reopen/update PR | prior disposition and material-delta proof | required check annotations + job summary |
| Main/tag | provenance receipt, semantic tree scan, immutable upstream pins, bounded release gate | required/release check summary |
| External issue/PR producer | issue/PR dedupe before mutation, suppression receipt, owner override | JSON contract consumed before create/reopen |

The GitHub history workflow must be read-only (`contents: read`, `pull-requests: read`,
`issues: read`) and must not execute pull-request code with a privileged token. Prefer a
base-owned implementation that retrieves candidate metadata/blobs via the GitHub API. Never use
`pull_request_target` together with a checkout or execution of untrusted head content.

## Additional Warning Candidates

These are useful feedback signals but should start warning-only until fixtures establish a low
false-positive rate:

- a new exported `*Guard`, `*Policy`, `*Cache`, `*Manager`, or `*Limiter` with no production owner;
- a runtime-feature PR whose diff is test-only or whose body admits “not wired”;
- a new symbol name equal or highly similar to an existing exported symbol in the same domain;
- a new module whose imports duplicate an existing module's dependency neighborhood;
- a PR touching a previously rejected path/symbol without linking the prior artifact;
- assertions changed without a corresponding production delta after a correctness rejection;
- only formatting/hygiene files changed between close and reopen;
- guard source changed without a negative-control fixture change;
- workflow steps added locally but absent from the canonical command, or vice versa;
- shell/process commands without a bounded timeout and owned-process-group cleanup;
- warning counts that increase under a non-blocking ratchet;
- a security/reliability claim without failure injection, restart/reconcile, or persistence-error
  coverage appropriate to the changed boundary;
- PR title/body scope that does not match changed production paths and executed tests;
- a changed generated artifact whose recorded source OID is absent, stale, or unreachable;
- a branch based on a current tip but carrying a patch already reachable from main.

Warnings graduate to blockers only after a negative control, positive control, false-positive
fixture, actionable remediation message, and rollback/override policy are present.

## Local and CI Composition

`verify:semantic` becomes the semantic source of truth. A later `verify:boundary` composes
semantic, provenance, history, and supply-chain checks. Hooks and workflows call these commands
rather than listing their internal steps independently.

The pre-push driver receives an external watchdog that owns and reaps its process group. Timeout
is `inconclusive` and blocking, with the active phase and rerun command in the receipt. Time
budgets should be set from observed local/CI percentiles with slack, not guessed once and frozen.

PR A adds one pinned-Node-24 shadow step to the existing Quality workflow. After shadow
observation, a later GitHub-enforcement tranche may split that step into a fast `semantic-quality`
job before the expensive matrix and add `workflow-hygiene` for parsed workflow/Docker pin checks,
`actionlint`, and `shellcheck`. Only after the promotion gates pass may those contexts be proposed
for ruleset `16319133`; ruleset mutation is a separate explicitly authorized operation.

## Validation Strategy

Minimum fixtures include:

- production import/call versus comment/string/test-only references;
- disconnected multi-module island;
- dynamic literal import and unresolved dynamic import;
- exact duplicate under a new PR number;
- identical patch after path rename;
- open-PR duplicate;
- subset/superset reuse that warns rather than blocks;
- cosmetic-only reopen after architectural rejection;
- material root-cause correction with a complete re-entry packet;
- explicit owner override;
- unrelated proposal sharing one filename;
- current remote tip, stale local tracking ref, disjoint stale base, overlapping stale base, and
  unavailable remote;
- mutable and immutable GitHub Action pins;
- patch-pinned-but-undigested and fully digested Docker bases;
- human, JSON, and GitHub annotation rendering snapshots;
- feedback redaction and bounded owner-disposition excerpts;
- timeout/process-group cleanup.

Every blocking rule needs a test that proves the unsafe input is rejected and a neighboring safe
input passes. Every warning rule needs a false-positive fixture.

## Rollout

1. **PR A — semantic foundation:** execute the dedicated implementation plan, introduce
   `verify:semantic`, upgrade guard proof checks, and wire local/CI shadow reporting. No required
   context or hard blocker is promoted in this PR.
2. **PR B — boundary core:** provenance and canonical fingerprint library, receipt schema,
   renderer, and synthetic history/provider interfaces.
3. **PR C — local enforcement:** changed-file pre-commit adapter, pre-push remote/history adapter,
   process-group watchdog, and local receipt storage under Git state rather than tracked files.
4. **PR D — GitHub enforcement:** read-only semantic/history workflow, workflow hygiene, job
   summaries, and ruleset-readiness documentation.
5. **External producer change:** locate the artifact producer, persist dispositions, call the JSON
   preflight before issue/PR create or reopen, and emit suppression receipts. This is outside the
   WhatSoup repository until its owner surface is identified.

PR #1835 remains a separate code-review stream. P0 issue #1783 remains separate product/security
work; neither is adjudicated or bundled by the quality-infrastructure PRs.

## Promotion Gates

A rule can move from shadow to warning only when its real-repository inventory is explainable and
its feedback receipt names a correction that a reviewer can execute without rediscovery. A warning
can move to blocking only when all of the following are recorded:

1. a deterministic unsafe fixture and a neighboring legitimate fixture;
2. a false-positive fixture derived from a real or adversarial example;
3. at least 20 shadow observations or every applicable PR in a 14-day window, whichever is larger;
4. zero unexplained false blocks in that observation set;
5. measured local and CI duration distributions with a separately approved timeout;
6. a rule-scoped rollback and owner-authored override path;
7. an agent-feedback trial that records whether the next attempt corrected the cited condition;
8. explicit owner authorization for ruleset or required-check mutation.

Exact duplicate evidence may reach blocking before heuristic similarity, but it is not exempt from
the observation, feedback, rollback, and authorization requirements. Supply-chain enforcement also
requires a baseline migration so current mutable references are not converted into surprise global
failures.

## Rollback and Overrides

- Each new blocker begins in shadow/warn mode against recent PR fixtures, then promotes only after
  false-positive review.
- A promoted rule can be rolled back independently by removing its composition entry while
  leaving receipt generation active for diagnosis.
- Overrides are explicit, scoped to one fingerprint and rule, owner-authored, time-bounded, and
  visible in the receipt. Environment-variable bypasses are not accepted as durable overrides.
- Network-dependent local checks offer a diagnostic read-only mode, but the actual push/PR
  boundary remains fail-closed on inconclusive evidence.
- No branch, PR, issue, comment, label, ruleset, or remote setting is mutated by the check itself.

## Success Criteria

- A PR equivalent to #1835 is blocked for production unreachability before the expensive matrix.
- A PR equivalent to #1848 is blocked with links to #1838/#1848 and the exact matching blobs.
- A reopen equivalent to #1857 is blocked until the architectural disposition is addressed.
- A stale local `origin/main` cannot produce a clean duplicate or overlap verdict.
- Mutable action/image references produce contextual findings and immutable pins pass.
- The same finding has equivalent human and JSON meaning in pre-commit, pre-push, CI, and external
  producer contexts.
- Feedback names the attempted action, actual evidence, prior artifacts, correction, and rerun
  command without requiring the driving agent to rediscover the failure.
- Passing checks remain concise; warnings, blocks, and inconclusive states are visible and
  auditable.

## Implementation Readiness

The semantic-foundation plan is ready for execution only after this specification, its plan, and
the implementation notes are committed together. Completion of those documents does not mean the
production guard exists. The first implementation task must begin with a failing fixture and may
reuse experiment logic only after moving it behind the production interfaces named in the plan.
