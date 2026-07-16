# Semantic Boundary Hygiene Specification

**Status:** Active — approved for semantic-foundation implementation planning
**Review:** Owner-approved direction on 2026-07-15; rule-catalog and diagnostic extension approved
on 2026-07-16; production enforcement has not started
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

### 2026-07-16 parser, renderer, and stress calibration

The approved extension was probed read-only at exact branch head
`83a55b131b2fa51f9d3c6c8f3f2494140ae4fd03`. Remote `main` was
`2545115c628f3d84c8c5e16cc891b583bbda2812`; two pull requests and 31 issues were open at the
`2026-07-16T08:27:58Z` observation. The repository and GitHub state were not mutated.

The focused six-suite run passed 134/134 tests, both script and repository typechecks exited zero,
the candidate evaluator remained 39/40 with zero false blocks and zero missed critical cases, and
the holdout remained 18/18. Two independent holdout runs were byte-identical. Those positive
controls establish the current baseline; they do not override the following direct falsifiers:

- an enforce-mode receipt with one warning plus incomplete history evidence retained decision
  `warn`, exited zero, and omitted the limitation from human output;
- an unknown runtime finding decision aggregated to `pass`, and a push receipt with a non-Git head
  identity also rendered `PASS`;
- whitespace-only finding fields passed the pre-canonical completeness check and became empty
  diagnostic fields;
- a 1,000-finding synthetic receipt expanded to roughly 85 MB of JSON and human output; a separate
  200-finding/10,000-evidence/5,000-limitation probe produced roughly 20 MB and about 59 MiB of heap
  growth;
- two findings with the same rule ID were order-dependent while retaining the same correlation ID;
- a history provider that ignored cancellation remained pending after the signal was aborted;
- stale, future-dated, zero-page, and complete-with-limitations history observations could authorize
  an empty finding set, while provenance accepted a syntactically valid foreign repository;
- omitting a re-entry packet reduced an exact-task, disposition-bearing resubmission to a path-overlap
  warning; supplying the incomplete packet produced the intended re-entry block.

Current exact-head semantic analysis itself produced 45 warning findings, 513 observations, 90
correction entries, and about 57 KB of human output, including repeated guidance. This proves that
bounded grouping and deduplication are needed for ordinary repository scale, not only adversarial
payloads. The stress result fails promotion criteria until the fail-open decision, evidence binding,
deadline, and feedback-volume cases have executable unsafe and safe controls.

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
- **SBH-013 — Runtime contract validation:** Runtime input is validated after canonicalization.
  Unknown decisions/actions/modes, duplicate singleton options, invalid identities, empty required
  fields, and contradictory metadata are `inconclusive`; TypeScript types are not runtime proof.
- **SBH-014 — Temporal and target binding:** Current-state claims bind evidence to the exact
  repository, action target, trusted clock, observation window, and rule version. Stale, future,
  replayed, foreign-target, or temporally incoherent evidence cannot authorize a clean result.
- **SBH-015 — Postcondition-preserving fallback:** Every success return, including fallback and
  disabled/degraded paths, preserves the original postcondition or returns a typed unrepresentable
  outcome. A fallback is not safe merely because it terminates.
- **SBH-016 — Independent proof and explicit states:** A verifier may not derive its expected roster,
  identity, or completeness claim solely from the producer being verified. `absent`, `valid`,
  `corrupt`, `unavailable`, `stale`, and `unknown` remain distinct when they affect safety.
- **SBH-017 — Emitted and tree-accurate identity:** Runtime reachability follows emitted behavior
  under the effective compiler configuration. Git identity includes path, status, object type, and
  old/new tree modes where those can change behavior.
- **SBH-018 — Bounded deterministic feedback:** Findings, evidence arrays, artifacts, corrections,
  tests, sources, JSON, and human output have deterministic cardinality and byte bounds. Overflow is
  an explicit `inconclusive` finding with bounded structural counts and a descriptor digest, never
  silent truncation, unbounded rejected-content hashing, or log flooding.
- **SBH-019 — Corrective feedback quality:** Feedback completeness requires an observed state,
  expected invariant, consequence, actionable correction, unsafe and neighboring-safe controls,
  verification command, evidence source, and visible limitations. Nonempty placeholders do not pass.
- **SBH-020 — Final-seam and terminal-outcome proof:** Safety and durability rules evaluate the final
  assembled payload or committed state and require a terminal success/failure outcome. Intermediate
  checks, transport success, process exit, or swallowed errors cannot substitute for the final seam.

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

Stored schema-1 findings and receipts use `BoundaryFindingV1` and `BoundaryReceiptV1`; current
production moves to the versioned v2 contracts below.

```ts
type BoundaryDecision = 'pass' | 'warn' | 'block' | 'inconclusive';
type BoundaryActionV1 = 'commit' | 'push' | 'open-pr' | 'reopen-pr' | 'open-issue';

interface BoundaryFindingV1 {
  ruleId: string;
  decision: Exclude<BoundaryDecision, 'pass'>;
  action: BoundaryActionV1;
  summary: string;
  why: string;
  observed: Array<{ label: string; value: string }>;
  matchedArtifacts: Array<{
    kind: 'pull-request' | 'issue' | 'commit' | 'path';
    repository: string;
    id: string;
    url?: string;
    state?: string;
    fingerprintSha256?: string;
  }>;
  correction: string[];
  rerun: string;
  sourceRefs: string[];
}

interface BoundaryReceiptV1 {
  schemaVersion: 1;
  repository: 'LucasQuiles/WhatSoup';
  invocation: string;
  action?: BoundaryActionV1;
  correlationIdSha256?: string;
  enforcementMode: 'shadow' | 'enforce';
  decision: BoundaryDecision;
  base: {
    headOid: string | null;
    baseOid: string | null;
    mergeBaseOid: string | null;
    evidenceSource: string;
  };
  fingerprints: Record<string, string | null>;
  findings: BoundaryFindingV1[];
  limitations: string[];
}
```

This is the exact stored schema-1 compatibility contract observed in the current implementation;
it is not the ten-action schema-2 target model below. In particular, schema 1 never admitted
`update-pr`, `merge`, `tag`, `release`, or `config-write`. Those actions begin at schema 2 and a
schema-1 reader must reject them rather than retroactively widening historical bytes.

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

## Approved Rule-Catalog and Diagnostic Extension

The 2026-07-16 extension keeps SBH-007's single pure engine and adds typed rule metadata and
action-specific observation adapters. It does not authorize a second evaluator, an LLM-only blocker,
or independent shell implementations of policy. A model may summarize or rank already-proven
findings, but it may not create the blocking verdict.

### Rule and observation contracts

```ts
type BoundaryActionV2 =
  | BoundaryActionV1
  | 'update-pr'
  | 'merge'
  | 'tag'
  | 'release'
  | 'config-write';

type EvidenceState =
  | 'observed'
  | 'absent'
  | 'invalid'
  | 'unavailable'
  | 'stale'
  | 'unknown';

type RuleDisposition = 'shadow' | 'warning' | 'block-candidate';

interface BoundaryCommand {
  command: string;
  args: string[];
}

interface BoundaryCorrectionStep {
  operation: 'edit' | 'reuse' | 'remove' | 'refresh' | 'split' | 'retry';
  target: string;
  expected: string;
}

interface BoundaryVerificationStep extends BoundaryCommand {
  expected: string;
}

interface RuleContext {
  action: BoundaryActionV2;
  targetRepository: string;
  targetIdentity: string;
  now: Date;
  ruleCatalogDigestSha256: string;
  enforcementMode: EnforcementMode;
}

interface BoundaryRule<Observation> {
  ruleId: string;
  ruleVersion: number;
  category: 'contract' | 'semantic' | 'history' | 'provenance' | 'supply-chain';
  applicableActions: BoundaryActionV2[];
  defaultDisposition: RuleDisposition;
  requiredEvidence: string[];
  evaluate(observation: Observation, context: RuleContext): RuleEvaluation;
  unsafeControl: string;
  neighboringSafeControl: string;
  falsePositiveControl: string;
  rollback: string;
}

interface RuleEvaluation {
  decision: BoundaryDecision;
  evidenceState: EvidenceState;
  observed: BoundaryEvidenceRecord[];
  expected: string[];
  impact: string[];
  correction: BoundaryCorrectionStep[];
  verification: BoundaryVerificationStep[];
  limitations: string[];
}

interface BoundaryFindingV2 extends Omit<
  BoundaryFindingV1,
  'action' | 'correction' | 'rerun' | 'sourceRefs'
> {
  action: BoundaryActionV2;
  ruleVersion: number;
  evidenceState: EvidenceState;
  expected: string[];
  impact: string[];
  safeControls: string[];
  correction: BoundaryCorrectionStep[];
  verification: BoundaryVerificationStep[];
  rerun: BoundaryCommand;
  rerunPurpose: 'integration-boundary' | 'focused-family-replay';
  sourceRefs: string[];
  limitations: string[];
  findingDigestSha256: string;
}
```

Adapters collect evidence for a real action and convert it into an observation. Pure rules consume
only observations and an injected context containing the exact target, trusted clock, rule catalog
version, and enforcement mode. Renderers consume only validated evaluations and receipts. Network,
Git, filesystem, compiler, and GitHub access remain outside rule evaluation.

The initial observation families are deliberately small and reusable:

- `RuntimeEdgeObservation`: base/head module graphs, effective compiler options, emitted import
  edges, source tree modes, and changed path records;
- `HistorySnapshotObservation`: exact candidate tree entries, task identities, provider repository,
  page sequence, snapshot/watermark identity, observation times, bounds, and prior dispositions;
- `ProvenanceObservationV2`: requested repository, observed repository, remote/local/head/merge-base
  identities, structured path changes including rename/copy sources, counts, and freshness;
- `PostconditionObservation`: original invariant, normal/fallback exit, before/after values, bound,
  and typed failure outcome;
- `ProofObservation`: claimed invariant, every required field, evidence subject, clock/lifetime, and
  source independence;
- `TargetPreflightObservation`: requested target, resolved configuration identity, side-effect-free
  validation stages, and the first permitted mutation;
- `StateVocabularyObservation`: all persistent statuses, terminal failure values, and reachable
  production writers;
- `ConsumerParityObservation`: a config key or enum and its loader, validator, API, fleet, docs,
  monitoring, and explicit-not-applicable consumers.

Source-specific adapters may add evidence, but they may not invent a source-specific variant of the
same rule. A rule that cannot obtain its required observation returns `inconclusive` through a
specific evidence rule such as `history.snapshot-incoherent`; it does not guess from raw prose.

### Runtime validation and decision algebra

The receipt boundary validates values at runtime after trimming, redaction, canonical path handling,
and enum normalization. It rejects or converts to `inconclusive`:

- decisions outside `warn | block | inconclusive` for findings;
- unknown actions or enforcement modes, repeated singleton CLI options, and missing option values;
- invalid or missing Git identities required by commit, push, PR, merge, tag, or release actions;
- missing exact task identity for issue creation and missing resolved target identity for mutations;
- whitespace-only rule IDs, summaries, reasons, evidence labels/values, corrections, tests, reruns,
  and source references after sanitization;
- duplicate finding identities or nondeterministic sort ties;
- a claimed-complete collection with zero pages, no observation time, nonempty limitations,
  regressing page times, an excessive page span, or an unproven snapshot/watermark;
- fingerprints whose algorithm, length, or subject does not match the declared evidence field.

Decision aggregation is evidence-aware:

1. a deterministic block remains a block only when its own required evidence is complete;
2. a limitation relevant to a rule converts that rule to `inconclusive`;
3. top-level incomplete evidence outranks warnings, so `warn + limitation` exits as
   `inconclusive` in enforce mode;
4. unrelated limitations remain visible even when an independently proven block is retained;
5. `pass` requires zero findings, zero limitations, a valid action contract, and all action-required
   identities.

Shadow mode may keep process exit zero, but it never rewrites the recorded decision. Enforce mode
retains distinct nonzero exits for `block` and `inconclusive`. Invalid mode input can never fall back
to shadow.

### Receipt identity and compatibility

The existing `correlationIdSha256` remains a grouping key; it is not promoted into an evidence
attestation. A versioned receipt extension adds:

```ts
interface BoundaryReceiptV2 extends Omit<
  BoundaryReceiptV1,
  'schemaVersion' | 'action' | 'correlationIdSha256' | 'findings'
> {
  schemaVersion: 2;
  action: BoundaryActionV2;
  target: { repository: string; actionTarget: string; headOid: string | null };
  observedAt: string;
  validUntil: string | null;
  correlationIdSha256: string;
  ruleCatalogDigestSha256: string;
  evidenceDigestSha256: string;
  findings: BoundaryFindingV2[];
  overflow: null | {
    reason: 'boundary.evidence-volume-exceeded';
    inputCounts: {
      findings: number;
      observed: number;
      artifacts: number;
      limitations: number;
      fingerprints: number;
      corrections: number;
      verification: number;
      sources: number;
      canonicalRecords: number;
    };
    rejectedBytes: number | null;
    descriptorDigestSha256: string;
    digestCoverage: 'bounded-structural-descriptor';
  };
}
```

Schema-2 target identity separates the mutation destination from the candidate commit. Closed
forms are `commit:<oid>`, `ref:<full-ref>`, `pr-create:<base-ref>..<head-ref>`, `pr:<number>`,
`task:<digest>`, `tag:<full-tag-ref>`, `release:<full-tag-ref>`, and `config:<digest>` for their
corresponding actions. Every repository action other than config-write also carries `headOid`; two
actions against different refs, PRs, tasks, tags, or releases must not share target/evidence
identity merely because the candidate head is the same. `unresolved:<action>` with a null head is
reserved for internally built diagnostic receipts and is never a valid producer-supplied target.
Candidate and commit-target Git OIDs are exactly lowercase 40- or 64-hex values, supporting both
repository object formats without accepting uppercase or arbitrary digest widths.

`evidenceDigestSha256` covers the canonical target, identities, observation times, evidence states,
limitations, rule IDs and versions, and all retained observation values. A head, target, observation,
rule version, or limitation change therefore invalidates the evidence receipt even when the
correlation group stays the same. Schema version 1 remains readable during migration; new producer
behavior is not emitted as version 1 until consumer compatibility is proven.

### Bounded contextual diagnostic contract

Every warning, block, and inconclusive result renders in this order:

1. decision, rule ID/version, actual action, target, and exact head/base when applicable;
2. observed values and evidence state;
3. expected invariant;
4. why the difference matters and the unsafe direction;
5. matched artifacts and exact source locations;
6. neighboring-safe or false-positive control;
7. two to four situational correction steps;
8. tests to add or run, including the unsafe edge;
9. exact rerun command;
10. limitations and what the check did **not** determine;
11. bounded receipt path, correlation ID, and evidence digest.

Limitations are always rendered, including alongside findings. A limitations-only result receives
the same why/correction/test/rerun/source sections; it may not collapse into a short observation with
no recovery guidance. Generic passes name their actual invocation and action instead of always
saying `semantic quality`.

Initial receipt construction limits are policy constants with direct boundary tests: no more than
128 canonical findings, 64 observations per finding, 16 matched artifacts, four corrections,
eight verification steps, 16 source references, or 1 MiB of JSON. Human rendering groups repeated
guidance, shows at most 12 detailed findings, and stays within 64 KiB; it reports every omitted
group/count and points to the bounded JSON receipt and evidence digest. Input beyond the canonical
JSON cardinality or byte budget is rejected before semantic aggregation and becomes
`boundary.evidence-volume-exceeded:inconclusive` with bounded structural counts, a known rejected
byte count when admission can determine it safely, and a descriptor digest. The descriptor is
content-independent: it covers only fixed counters/types, sanitized field-path class, scalar
UTF-16 code-unit count and applicable limit, and rejection reason. It does not
traverse, retain, or hash a rejected scalar prefix, secret/local reference, or the full rejected
content. Target identity remains bound by the outer receipt's `evidenceDigestSha256`, not this
partial overflow descriptor. `digestCoverage` therefore remains the literal
`bounded-structural-descriptor`, and `rejectedBytes` is `null` when determining it would require an
unbounded second pass. Human
summarization alone does not change the semantic decision because the retained JSON evidence remains
complete. These initial numbers accommodate the measured 45-finding current-head run while rejecting
the 200- and 1,000-finding stress cases. They are calibration values, not permanent doctrine;
changing them requires measured repository and CI evidence.

All fields pass centralized redaction. Local paths are detected after quotes, equals signs,
parentheses, and other punctuation; `file:` URLs are local-path references. Provider exceptions are
classified into stable public error categories instead of copying raw messages. Raw GitHub comment
bodies, credentials, query strings, emails, ANSI/control sequences, and operator-local paths do not
enter receipts.

### Example postcondition feedback

```text
WARN [semantic.fallback-postcondition@1] while updating PR #1887
Target: LucasQuiles/WhatSoup head=<exact-head> base=<exact-base>
Evidence state: observed

Observed:
  - exit_path: marker-fallback
  - estimated_tokens: 106.25
  - token_budget: 100

Expected invariant:
  - every successful return satisfies estimated_tokens <= token_budget

Why this matters:
  - the fallback recreates the oversized request that trimming was meant to prevent

Neighboring safe control:
  - estimated_tokens=81.25 with token_budget=100 remains successful

Correction:
  - reserve marker cost before trimming or trim again after marker insertion
  - return a typed unrepresentable result when no valid payload fits

Verification:
  - unsafe edge 106.25/100 must not return success
  - neighboring edge 81.25/100 must remain successful

Rerun: npm run <targeted-check>
Limitations: synthetic control-flow measurement; provider request behavior was not observed
Evidence: <repo-relative source>; receipt=<bounded path>; digest=<sha256>
```

The example is a measured synthetic control-flow case, not evidence that an automatic producer
already exists. A rule is not implemented until a real adapter produces the observation from the
changed code or execution seam.

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

## Evidence-Ranked Rule Catalog

The catalog below deduplicates the 2026-07-16 audits against SBH-001 through SBH-020 and the
existing history/provenance rules. “Block-candidate” still means shadow-first under SBH-008. A
contract failure described as “inconclusive” blocks only at a boundary whose enforcement promotion
has separately been authorized.

### Immediate fail-closed contract corrections

| Rule | Observed unsafe case | Required behavior |
|---|---|---|
| `boundary.contract-invalid` | Unknown runtime decision or malformed mode can aggregate/fall back to pass/shadow; whitespace fields survive pre-canonical validation | Runtime-validate after canonicalization; invalid contract is inconclusive and nonzero in enforce mode |
| `boundary.action-identity-unproven` | A push receipt with `headOid=not-a-git-object` rendered pass | Require action-specific head/task/target identities before pass |
| `boundary.evidence-incomplete` | `warn + limitation` exited zero; limitations alongside findings were hidden | Relevant incompleteness outranks warn; always render limitations and recovery guidance |
| `boundary.receipt-evidence-unbound` | Correlation identity is unchanged when evidence source/limitations change | Add a separate digest over target, observations, limitations, and rule versions |
| `boundary.feedback-contract-incomplete` | Empty/generic evidence and “fix it” satisfy structural completeness | Require expected invariant, consequence, controls, verification, and meaningful fields |
| `boundary.evidence-volume-exceeded` | Ordinary output reached 57 KB; synthetic output reached 20–85 MB | Reject over-budget input as bounded inconclusive evidence with structural counts and an explicitly partial descriptor digest; never hash rejected content without bounds |
| `boundary.finding-identity-conflict` | Duplicate rule IDs are input-order-dependent with one correlation ID | Reject duplicate finding identities or sort by a full canonical evidence key |
| `boundary.renderer-action-mismatch` | A generic history pass renders `PASS semantic quality` | Render the actual invocation, action, target, and exact identity |
| `boundary.provider-deadline-unowned` | A provider ignoring `AbortSignal` remains pending | Enforce an owned deadline/watchdog outside cooperative cancellation |
| `boundary.local-reference-unredacted` | Quoted/assigned local paths and `file:` URLs survive current redaction | Centralize punctuation-aware local-path and URI classification |
| `history.collection-contract-invalid` | Complete-with-limitations, zero-page complete, and empty-observation collections can return no findings | Validate complete collection metadata independently before comparison |
| `provenance.target-mismatch` | A syntactically valid foreign repository can return no findings | Bind observation repository to the exact requested target |
| `semantic.policy-path-noncanonical` | Active allowlist `src/./feature.ts` misses canonical `src/feature.ts` and false-blocks | Canonicalize once or reject aliases during policy validation |

These are corrections to the meaning of the existing boundary contract, not evidence that any new
domain detector is complete. Their first tests must reproduce the exact unsafe case before changing
implementation.

### Deterministic shadow and blocker candidates

| Rule | Unsafe control | Neighboring safe/false-positive control | Placement |
|---|---|---|---|
| `semantic.erased-import-edge` | Value-syntax import used only in a type position is erased by the effective compiler but counted as runtime reachability | Side-effect import or value-position runtime use emits an edge | semantic pre-push/PR |
| `semantic.reachability-regression` | Deleting the sole bridge/import or root registration orphans unchanged production modules | Deleting an already-unreachable file creates no new regression | semantic pre-push/PR |
| `semantic.nonregular-source-entry` | A committed `120000` `.ts` symlink is parsed as link-target text and appears clean | Regular `100644`/`100755` TypeScript source is analyzed; unsupported tree entries are inconclusive | exact-tree adapter |
| `history.tree-entry-evidence-incomplete` | Opposite executable-bit transitions share path/blob/status identity | Same old/new mode and object type preserve exact identity | fingerprint/history |
| `history.renamed-patch-open-pr` | Same stable patch under renamed paths has an existing open PR but returns no finding | Different patch remains clean | PR producer/history |
| `history.reentry-packet-omitted` | Exact task identity plus prior disposition becomes warning-only when the packet is omitted | Material delta with independently discovered disposition and complete packet passes re-entry | PR reopen/update producer |
| `boundary.evidence-observation-freshness` | Internally consistent 2000/2099 observations authorize clean history/provenance | Observation within declared trusted-clock age/skew budget | history/provenance adapters |
| `history.snapshot-incoherent` | Page times regress or span years yet terminal cursor marks complete | Monotonic bounded page acquisition under one snapshot/watermark | history provider |
| `provenance.rename-path-incomplete` | Rename destination only makes an upstream source-path change appear disjoint | Structured change record contains both source and destination | pre-push/PR provenance |
| `semantic.health-receipt-incomplete` | HTTP 200 with malformed, stale, wrong-identity, or semantically unhealthy body is green | Current schema-valid body with expected identity and healthy semantics | health/release preflight |
| `semantic.observation-collapsed` | Corrupt/unavailable/stale becomes cached `0`, `false`, `null`, or empty | Explicit unavailable/corrupt state remains distinguishable from measured zero/absence | persistence/aggregation |
| `semantic.circular-oracle` | Producer and verifier share one mutable roster, allowing omitted members to disappear | Independent expected roster/digest with expected/observed/unknown counts | fleet/collection proof |
| `semantic.fallback-postcondition` | Fallback success returns a value outside the original bound | Normal and fallback success both preserve the bound; unrepresentable is typed | changed fallback seam |
| `semantic.target-unproven` | Named mutation preflight does not load or validate the named target configuration | Exact target/config identity is resolved before the first mutation | config/restart/release |
| `semantic.failure-unrepresentable` | Durability table has no terminal failure value or no production writer | Terminal failure exists and a tested production path writes it | migrations/persistence |
| `semantic.final-seam-unprotected` | Per-fragment/path checks allow a split or sibling payload through final send | Final assembled payload passes the same policy at the send/commit seam | egress/state mutation |

For exact history, task identity is discovered independently from the candidate's optional re-entry
packet. A packet cannot be the only source that tells the verifier which prior disposition to
enforce. Candidate path/blob records become tree-entry records containing old/new path, old/new
mode, object type, and blob identity. Missing required mode/type evidence is inconclusive rather
than an exact match.

Runtime reachability compares base and head, not merely changed head files. It loads the effective
project compiler configuration and follows emitted runtime edges. Deleting or changing a bridge can
therefore surface a reachable-to-unreachable transition in otherwise unchanged modules. Source
inventory retains Git tree mode/type; non-regular TypeScript entries do not become source text by
accident.

### Warning-only candidates

The following remain warnings until separate evidence proves a deterministic unsafe boundary:

- `history.renamed-patch-merged-pr`: stable-patch equivalence to merged work asks for current-main
  reachability/reuse proof;
- `history.task-layout-similarity`: whitespace-relaxed task identity warns, while blocker-grade
  task identity preserves Markdown-significant newlines/indentation after only CRLF normalization;
- `semantic.proof-evidence-incomplete`: a claim omits a required field, such as explicit zero
  reconnect attempts;
- `semantic.proof-source-mismatch`: a process-lifetime clock is used to prove a connection-lifetime
  claim, or evidence describes the wrong subject;
- `semantic.consumer-parity`: a new config key or enum lacks a loader, validator, API, fleet, docs,
  monitoring, or explicit-not-applicable record;
- `semantic.numeric-domain-unproven`: numeric logic lacks NaN, positive/negative infinity,
  negative, zero, fractional, and platform-ceiling controls appropriate to its type;
- `semantic.timeout-work-unowned`: caller latency is bounded, but underlying work, cancellation,
  cost, or late side effects are not owned;
- `semantic.identifier-log-unclassified`: a persistent identifier enters structured logs without
  classification, sanitization, and bounded retention;
- `semantic.outcome-dimension-collapsed`: OS exit mechanism, transport connection, health, and
  terminal operation outcome are represented as one status;
- `semantic.high-cadence-side-effect`: a polling loop repeatedly performs credential/OS reads or
  emits steady-state warnings without cache, invalidation, and transition telemetry;
- `semantic.state-transition-unreconciled`: a state change does not reconcile dependent durable
  records under a controlled interleaving;
- `semantic.error-feedback-swallowed`: swallowed errors erase breaker, administrator, or terminal
  operation feedback;
- `semantic.nested-timeout-budget-unproven`: sequential/nested deadlines can exceed the enclosing
  supervisor or shutdown budget;
- `semantic.scope-ownership-mismatch`: claimed PR scope, changed ownership domain, and executed
  tests do not align. Raw line/file counts alone never block.

### Parsing and filtering rules

Canonicalization is domain-specific and happens once:

- CLI singleton arguments reject duplicates, missing values, case typos, and unknown values;
- receipt enums and nested fields are runtime-validated after sanitization;
- repository paths reject noncanonical policy aliases or canonicalize them through the same path
  function used for graph and fingerprint evidence;
- blocker-grade task fingerprints preserve Markdown structure; relaxed whitespace fingerprints are
  stored separately and warning-only;
- history pages prove repository, terminal pagination, monotonic bounded observation times, one
  snapshot/watermark, and no limitations;
- provenance compares the observed repository to the requested repository and accepts structured
  path changes rather than a destination-only string set;
- base/head reachability, tree modes, symlinks, submodules, deletions, copies, and renames remain
  explicit instead of being filtered away before evaluation;
- state values never use truthiness to collapse `0`, `false`, absence, corruption, unavailability,
  stale evidence, and unknown evidence;
- evidence filters report rejected counts/reasons and cannot silently turn a nonempty unsafe input
  into an empty clean set.

## Validation and Feedback-Efficacy Extension

Every block candidate has an unsafe fixture, neighboring-safe fixture, and false-positive control.
Every warning has a false-positive fixture. Parser and filter tests mutate one field at a time and
assert both decision and complete rendered guidance. At minimum, the next plan includes:

- unknown/missing/duplicate CLI options and runtime enum values;
- post-canonical empty fields and invalid action-specific identities;
- warning plus limitation, block plus unrelated limitation, and limitations-only rendering;
- stale/future/foreign-target/zero-page/complete-with-limitations evidence;
- monotonic and regressing pagination plus snapshot-span bounds;
- tree modes, symlink/submodule source entries, rename/copy source paths, and chmod-only changes;
- explicit type import, erased value-syntax type import, emitted value use, side-effect import, and
  base-to-head orphan transitions;
- stable patches against open, closed-unmerged, merged, and unrelated artifacts;
- omitted, incomplete, material, and owner-overridden re-entry packets discovered independently;
- punctuation-delimited local paths, `file:` URLs, secret/query URLs, ANSI, control characters, and
  oversized arrays;
- deterministic repeated runs, duplicate finding identities, JSON/human semantic equivalence, and
  exact receipt digest invalidation when head/evidence/rule version changes;
- overflow admission at the exact cardinality/byte boundary, one-over rejection without reading a
  hostile tail, stable bounded-descriptor identity, `rejectedBytes: null` when total size is unsafe
  to determine, and proof that rejected secret/local-path content is neither retained nor hashed;
- providers that honor cancellation, throw timeout, and ignore cancellation under an owned
  watchdog.

Feedback usefulness is measured with matched correction trials. A fresh agent receives the same
unsafe action with either the current or candidate diagnostic. Record whether its next attempt:

1. changes the cited unsafe condition;
2. preserves the neighboring-safe behavior;
3. avoids introducing another boundary finding;
4. uses the supplied test/rerun path without rediscovering the failure source;
5. requests missing evidence when the result is inconclusive instead of guessing.

Retain the verbose diagnostic only when it improves exact next-attempt correction without adding
false blocks or causing material context overflow. Record raw counts and durations, not claims of
token, latency, or capability savings inferred from role or message length.

Implementation priority is fail-open-first:

1. runtime contract parsing, action identity, decision aggregation, limitations rendering,
   evidence digest, deterministic finding identity, output bounds, redaction, and owned deadline;
2. history/provenance freshness, target binding, collection coherence, structured path changes,
   tree-entry identity, stable-patch state matrix, and omitted re-entry discovery;
3. emitted-edge and base/head reachability plus non-regular tree-entry handling;
4. real observation producers for fallback postconditions, proof completeness, consumer parity,
   state vocabulary, health semantics, and final-seam controls.

No generic receipt fixture counts as implementation of a rule producer. Each priority begins with a
failing behavioral fixture and remains shadow-only until its own promotion packet is complete.

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
9. runtime schema tests proving unknown enums, invalid identities, contradictory completeness, and
   post-canonical empty values cannot yield pass;
10. evidence receipts bind the exact target, head, observation lifetime, and rule version, and a
    one-field change invalidates the evidence digest;
11. output/cardinality bounds and an ignored-cancellation provider complete with explicit
    inconclusive results under the owned deadline;
12. human and JSON renderers expose the same decision, limitations, correction, verification, and
    evidence identity.

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
- A value-syntax import erased by the effective TypeScript compiler does not prove runtime
  reachability, while an emitted value/side-effect import passes.
- Removing the sole composition edge surfaces the newly orphaned unchanged modules.
- Chmod-only and non-regular tree entries cannot collide with regular path/blob identity or appear
  as clean TypeScript source.
- A stable patch already present in an open PR routes work to that PR even when paths changed.
- Stale, future, foreign-repository, zero-page, complete-with-limitations, and temporally incoherent
  observations are inconclusive.
- Warning plus incomplete evidence exits inconclusive in enforce mode and renders the limitation.
- Unknown runtime decisions/modes, invalid action identities, whitespace-only feedback, duplicate
  finding identities, and over-budget evidence cannot produce pass.
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

The 2026-07-16 extension requires its own reviewed implementation plan before code changes. That
plan starts with the current-core fail-open contract cases and must distinguish a receipt renderer
from a real rule producer. No hook, workflow, ruleset, GitHub provider, or external producer is
promoted by approval or commitment of this design document.
