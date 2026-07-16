# Boundary Contract and Feedback Hardening Implementation Notes

**Status:** Active
**Verification:** Inconclusive — history and contract-audit amendments require a fresh exact-hash closeout; production changes and implementation verification have not started
**Planning head:** `1a7336984ea5bada47f0820e10c9decd53ad57f3`
**Branch:** `experiment/jul16-boundary-core-history`
**Specification:** `docs/superpowers/specs/2026-07-15-semantic-boundary-hygiene-design.md`
**Implementation plan:** `docs/superpowers/plans/2026-07-16-boundary-contract-feedback-hardening.md`

## Outcome

This packet defines the evidence and execution ledger for the first approved 2026-07-16 hardening
tranche. The tranche closes runtime-contract and feedback fail-open behavior before extending
history, provenance, reachability, supply-chain, hooks, workflows, or external producers.

No production code has changed under this packet. No local hook, GitHub workflow, required check,
ruleset, issue, pull request, comment, review, label, merge, workflow run, or external service has
been created or mutated.

## Planning Review Evidence

The 27-pass deterministic plan review completed under the external artifact root recorded in the
local operator handoff as `PLAN_REVIEW_ARTIFACTS`. The machine-local value is intentionally not
published in this repository.

The unfiltered closeout command exited zero and reported `valid: true`, 27 ordered passes, nine
supported artifact contracts, and seven passing cross-artifact consistency rules. The final
manifest status is `completed`. The review preserves its failed attempts, including invalid manifest
arguments, the first pass-18 artifact contract, a masked capability-version probe, the first final
consistency check, and the first wrapper-level closeout attempt. None is counted as clean evidence.

That closeout applied to the reviewed input bytes before the history/provenance amendment described
below. The amended plan is **Inconclusive until exact-hash re-closeout**. Even after a clean plan
closeout, execution is `Not Ready` for BCF-01: A-08 upstream/predecessor reconciliation, A-09
immutable artifact identity, and A-10 lifecycle/oracle disposition must pass first. A-02 remains due
before BCF-02, A-03 before BCF-05, and A-06 before BCF-08C. This does not claim that any production
change, schema-2 receipt, provider deadline, feedback budget, test, hook, workflow, hosted check, or
agent-correction trial passes.

The installed review runtime now exposes 15 artifact contracts rather than the nine used by that
historical closeout. Its local self-test run on July 16 reported 156 passing tests and one unmasked
stale-fixture failure: the legacy complete-run fixture omits the five structured review artifacts
that support six newer contracts. Fresh closeout must satisfy all 15 live contracts and preserve
this tool-integrity gap; the older nine-contract result cannot be promoted as current evidence.
The shared installation then changed during this review; a later exact rerun observed 164 tests with
five failures and five errors in JSON-schema/native-contract parity checks. The final review must
therefore execute from one hash-locked copied tool snapshot and preserve those installed-runtime
attempts as historical, inconclusive evidence. A subsequent fresh copied candidate snapshot ran
185 unfiltered tests clean. Its complete-run helper intentionally embeds the nine legacy contracts,
so fresh closeout requires two direct receipts: the separate `--all` validator must prove all 15
live contracts, while the complete-run validator must prove 27 ordered passes, nine legacy
contracts, and seven consistency rules. Neither receipt may stand in for the other.

Three bounded read-only reviewers audited the older calibration head
`83a55b131b2fa51f9d3c6c8f3f2494140ae4fd03`. Their advisory findings were preserved in the plan
review artifacts and split deliberately:

- in scope for this tranche: invalid CLI fallback, runtime enum/identity validation,
  limitation-aware aggregation/rendering, corrective feedback quality, punctuation/`file:` path
  redaction, cardinality/byte bounds, duplicate identity ordering, and owned provider-call
  settlement;
- deferred to detector-policy plans: evidence freshness/target/snapshot coherence, rename/copy
  paths, tree modes and non-regular entries, stable-patch open/merged states, strict Markdown task
  identity, compiler-emitted import edges, base/head reachability regression, and canonical policy
  aliases.

Reviewer test counts and synthetic probes describe that older head only. The implementation lead
must reproduce every decisive unsafe case and nearest safe control at the current implementation
head before accepting it as RED evidence.

## History, Remote-Host, and Artifact Audit Amendment

Three additional bounded read-only lanes inspected local Git lineage, on-disk artifacts, and
WhatSoup repositories on a pre-authorized remote audit host. Host/user identity remains in local-only
evidence; no remote file, ref, service, or external system was changed. A local SSH fetch at that
audit checkpoint observed:

- planning head `1a7336984ea5bada47f0820e10c9decd53ad57f3`;
- `origin/main` `bf8e03cd82e66fc37c55a980526388a2fd3d98fb`;
- merge base `b3452a27e168daf48a825acbf408b3f5e43932fc`;
- 61 commits behind and 30 ahead.

Those values are historical, not a freshness promise. Later shared-workspace metadata showed cached
`origin/main` `6a9e569c81e4362ecd100ed84bbb5905867c1e6a` and 63 behind / 30 ahead without this lane performing
another fetch. Live remote state is therefore unknown until BCF-00 performs and hash-binds its own
SSH observation.

The semantic/history branch was patch-unique against the observed main at audit time. July 15 head
`a15b3d953589641c81fd8c228e34afeb1cba2d39` is an ancestor of July 16 head
`83a55b131b2fa51f9d3c6c8f3f2494140ae4fd03`. Direct
`git merge-base --is-ancestor a15b3d953589641c81fd8c228e34afeb1cba2d39 83a55b131b2fa51f9d3c6c8f3f2494140ae4fd03`
exited zero; directional
`git cherry -v 83a55b131b2fa51f9d3c6c8f3f2494140ae4fd03 a15b3d953589641c81fd8c228e34afeb1cba2d39`
also exited zero with no rows. The reverse direction is not equivalent evidence. This supports
successor lineage, not branch deletion. No branch was deleted.

Local history also proved a genuine independent recommit: commits
`e2184312d1a0467cf79754379de48e793aff3538` and
`c883badd3cc3aaeae3ad86b98cd3e3f2d05640fe` have identical stable patch ID
`8c7a57e0779400bbf9a0b2097289f8615d07f2ac`, identical blob transitions, and neither contains the
other. Generated work-index documentation has additional exact patch clusters. This supports a
warning-only local stable-patch adapter; recreate-after-revert can be legitimate, so local patch ID
alone does not block. Exact canonical content may block for complete open or closed-unmerged PR
evidence. Stable patch blocks only complete closed-unmerged PR evidence under current policy;
stable-patch open/merged state remains warning/deferred. Title, branch, path, symbol, and semantic
similarity remain warnings.

The on-disk audit found a critical provenance failure: a generic semantic run manifest still looked
valid after its referenced readiness and final-review files had been overwritten by an unrelated
run. It carried no child artifact hashes. That generic root is quarantined as mixed historical
evidence. Every future task/review/final run must use a unique directory and hash-bind the
spec/plan/notes, head/diff, upstream OID, argv/status/logs, and every referenced artifact; a one-byte
post-finalization change invalidates the run.

The predecessor history/provenance handoff records focused verification but a pending final branch
gate. Its historical 40/40 evaluator file is a superseded invalid oracle; the corrected result is
39/40, but no raw same-head per-case 39/40 artifact exists. BCF production work therefore starts
only after BCF-00 reconciles upstream, completes the predecessor focused/evaluator/branch gates, and
produces the canonical lifecycle record plus raw corrected oracle.

## Scope and Non-Goals

The implementation scope is:

- strict singleton CLI parsing and enforce-mode diagnostic fallback;
- runtime validation after canonicalization;
- stable rule guidance and rule versions;
- schema-2 target, observation, rule-catalog, and evidence identity;
- limitation-aware decision aggregation;
- deterministic finding ordering and identity conflicts;
- bounded JSON and human feedback with explicit overflow evidence;
- punctuation-aware local-path and `file:` URL redaction;
- bounded history-provider page decisions when a provider ignores cancellation;
- schema-1 read/render compatibility and unchanged semantic policy classifications.

The tranche does not change semantic policy, history match policy, provenance policy, supply-chain
policy, GitHub adapters, process-owned provider cancellation, local hooks, hosted workflows, branch
protection, required checks, rulesets, or agent-correction promotion.

## Direct Falsifiers Before Implementation

At read-only calibration head `83a55b131b2fa51f9d3c6c8f3f2494140ae4fd03`, the focused six-suite
positive control passed 134/134 tests, script and repository typechecks exited zero, the candidate
evaluator scored 39/40 with zero false blocks and zero missed critical cases, and the holdout scored
18/18 in two byte-identical runs. Those controls did not detect these independently reproduced
unsafe cases:

| Falsifier | Observed unsafe result | Required neighboring control |
|---|---|---|
| Warning plus incomplete history | Receipt stayed `warn`, exited zero, and hid the limitation in human output | Warning without a limitation remains warning; warning with a limitation becomes visible `inconclusive` |
| Unknown runtime decision | Aggregation returned `pass` | Every declared decision validates and preserves its intended result |
| Non-Git push head | Receipt rendered `PASS` | An exact lowercase 40- or 64-hex committed head remains accepted |
| Whitespace-only required fields | Pre-canonical completeness passed, then emitted empty diagnostics | Complete nonblank canonical fields remain accepted |
| Evidence volume | 1,000 findings expanded to about 85 MB; a second probe produced about 20 MB and roughly 59 MiB heap growth | Exact at-limit receipts remain complete and byte-stable |
| Duplicate rule identities | Reversing two same-rule findings changed receipt bytes under the same correlation ID | Distinct evidence identities sort byte-identically; exact duplicate identities reject |
| Provider ignores cancellation | Collection remained pending after abort | Resolve, throw, and honor-abort controls settle without late-work claims |

The current exact-head semantic analysis also produced 45 warning findings, 513 observations, 90
correction entries, and about 57 KB of repeated human feedback. This makes bounded grouping an
ordinary-scale requirement, not only a synthetic stress defense.

Separate calibration probes showed that stale/future/zero-page/foreign-repository history evidence
and an omitted re-entry packet can evade current detector policy. Those are decisive inputs for the
deferred history/provenance tranche, not direct falsifiers of this schema/feedback tranche. BCF must
preserve them as limitations and must not claim to fix their classification.

## Commit Record

| Commit | Outcome |
|---|---|
| `1a7336984ea5bada47f0820e10c9decd53ad57f3` | Approved semantic-boundary diagnostic hardening specification |
| Not yet recorded | Reviewed boundary-contract implementation plan and these implementation notes |
| Not started | Strict CLI parsing |
| Not started | Rule guidance catalog |
| Not started | Runtime contract validation |
| Not started | Schema-2 evidence receipts |
| Not started | Bounded contextual renderer |
| Not started | Provider page-decision deadline |
| Not started | CLI/evaluator integration |
| Not started | Public contract documentation and final evidence |

Replace each `Not started` or `Not yet recorded` row only with an observed 40-hex commit after the
corresponding task's focused tests pass. A partial or failed task remains explicit.

## Lifecycle and Supersession Record

This tracked table is the current sanitized disposition mirror. BCF-00 must reproduce it as
run-scoped JSON with exact plan hashes, completion commits, final-gate artifacts, successor links,
and oracle identities before dispatching implementation work.

| Packet | Current disposition | Completion commit | Final gate | Successor / supersession | Oracle disposition |
|---|---|---|---|---|---|
| Semantic-boundary foundation | Implemented historically; immutable plan marker is stale | Recorded in its completed handoff; BCF-00 must normalize the exact 40-hex value | Historical focused evidence; verify lifecycle source | July 15 semantic evaluator | Not applicable |
| July 15 semantic evaluator | Ancestrally subsumed candidate; no deletion authorized | `a15b3d953589641c81fd8c228e34afeb1cba2d39` | Historical gate is stale at current upstream | July 16 history/provenance | Historical evaluator inputs only |
| July 16 history/provenance | Focused verification recorded; predecessor final gate pending | `83a55b131b2fa51f9d3c6c8f3f2494140ae4fd03` | **Pending; blocks BCF-01** | BCF contract/feedback tranche | 40/40 superseded/invalid; raw 39/40 required |
| BCF contract/feedback | Plan amendment active; implementation not started | `null` | Not run | `null` | Must preserve 13/40, raw 39/40, and 18/18 |

Work-index state is generated from current tracked status markers, not treated as an independent
completion oracle. Any conflict between this table, a handoff, a run manifest, or a plan marker is
inconclusive until the lifecycle record names the controlling exact evidence.

## Focused Verification

No implementation verification is claimed yet. The implementation plan requires red/green focused
tests per task, script and repository typechecks, direct test-integrity scanning, documentation and
publication guards, and the complete branch gate at one exact head.

The current plan also requires a hash-chained predecessor ledger across BCF-00 through BCF-08B,
clean task-path entry snapshots, helper-owned process-group watchdogs for every external child,
structured U/S/N test markers and per-case evaluator receipts, content-independent overflow
descriptors, review-finding verdict aggregation, and an authoritative negative-control matrix before
accepted closeout. These are planning contracts only; none is implemented or passing yet.

The plan intentionally commits the eventual tracked handoff while its post-commit final gate is
still pending. A unique ignored helper-owned final manifest and sibling hash-locked closeout receipt
initialized at that docs commit are authoritative for the later upstream refresh, watchdog, branch
gate, and closeout. The tracked
handoff is not rewritten to claim its own commit identity or evidence produced after that commit.
Likewise, the run validator is committed and post-commit tested before any fetch or merge; its
pre-commit bootstrap logs are advisory and cannot satisfy A-08–10.

Planning-packet verification observed:

- deterministic plan-review closeout: exit 0, `valid: true`, 27 passes, nine supported contracts,
  seven consistency rules;
- documentation guard attempt 1: Fail because the two ignored private docs had audit rows before
  they were force-added; after explicit staging and index regeneration, work-index, publication,
  drift, and tally guards each exited zero;
- documentation regression tests: 4 files and 57 tests passed;
- staged repository-hygiene attempt 1: Fail with 18 internal-label/operator-path findings; the docs
  were sanitized to repository-relative or local-variable references and the rerun exited zero.

The failed attempts remain part of the evidence trail. Their later passing controls do not turn the
failed invocations into clean results.

The complete branch gate must run under the installed GNU process-group timeout with strict
`loadgate` admission inside the deadline. Timeout status 124/137, load-admission status 75, a signal,
missing output, or any masked pipeline is inconclusive, not clean.

## Evaluator Results

The pre-implementation regression oracle is:

| Corpus | Required score during this tranche | Policy constraint |
|---|---:|---|
| Locked baseline | 13/40 | Existing weak baseline remains frozen |
| Candidate | 39/40 | Zero false blocks and zero missed critical cases |
| Holdout | 18/18 | No candidate logic changes to satisfy the holdout |

The remaining candidate mismatch is the warning-only similar-issue case. This contract tranche must
not convert similarity into blocker-grade evidence.

## Feedback and Output Measurements

Final implementation evidence must record:

- exact JSON bytes at the declared limit and the one-over-limit overflow receipt bytes;
- exact human bytes at the declared limit, including the final newline;
- detailed finding count, grouped count, omitted count, and retained evidence digest;
- visible section order for observed, expected, impact, safe control, correction, verification,
  rerun, sources, limitations, and receipt evidence;
- warning-plus-limitation and block-plus-unrelated-limitation exit/output behavior;
- provider deadline duration and whether underlying late work cancellation remained unproven.

No agent-correction rate has been measured. Structurally complete feedback is not evidence that an
agent understood or corrected the condition.

## Known Limitations

- Current execution is blocked before BCF-01 by upstream divergence, the predecessor's missing
  final gate, artifact-identity negative controls, and lifecycle/oracle normalization.
- The prior 27-pass review does not cover the amended plan/notes bytes until exact-hash closeout is
  rerun. The mixed generic artifact root is not evidence for either version.
- GitHub provider behavior has not been exercised end-to-end by this tranche.
- An internal `Promise.race` can bound the collector's decision but cannot prove external work was
  canceled; the receipt must retain `history.provider-late-work-unproven`.
- History freshness, coherent pagination snapshots, same-target provenance, rename/copy evidence,
  tree modes, stable-patch state coverage, and independent re-entry discovery remain a later plan.
- Effective-compiler emitted edges, deleted-edge reachability regression, and non-regular source
  entries remain a later plan.
- Supply-chain pins, local hooks, hosted CI promotion, rulesets, required checks, and external
  producers remain unimplemented and unauthorized by this packet.
- Package version remains `0.1.0`; no first-party changelog/changeset or product-version tag was
  found. Task 4 must record the schema 1 → 2 compatibility/version decision before changing the
  producer; BCF-08A publishes that same observed decision.

## Deferred Follow-On Plans

1. History/provenance target, freshness, pagination, tree-entry, stable-patch, and re-entry
   hardening. Reuse the existing fingerprint/history/provider/provenance/receipt modules and start
   local stable-patch/merged/superseded/generated-doc rules as warnings; incomplete live provider
   evidence is inconclusive.
2. Effective-compiler reachability, deleted-edge blast radius, and non-regular source handling.
3. Domain observers for proof completeness, fallback postconditions, numeric domains, topology,
   durability, health, and final-seam behavior.
4. Measured shadow feedback trials followed by separately authorized hook, workflow, provider, and
   required-check promotion decisions.

The first follow-on must not add a second receipt path, history scanner, or work-index generator.
Patch identity alone never authorizes branch deletion; a fresh `git cherry -v` and `git range-diff`
must explain every changed or dropped patch before any supersession cleanup.

## Authorization Boundary

The current approval authorizes writing and committing the local specification, plan, and
implementation-notes packet, then implementing and locally verifying the planned code tranche. It
does not authorize creating or mutating GitHub issues, pull requests, comments, reviews, labels,
merges, workflow runs, rulesets, required contexts, repository settings, or external producers.

Stop after local commit and verification unless a current owner instruction explicitly names the
external action and target.
