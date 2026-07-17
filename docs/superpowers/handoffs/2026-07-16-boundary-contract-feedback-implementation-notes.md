# Boundary Contract and Feedback Hardening Implementation Notes

**Status:** Active — BCF-00A recovery amendment; planning closeout and commit identity are external hash-bound state
**Verification:** Inconclusive — the recovered validator scaffold is uncommitted and no committed-helper verification has run
**Historical specification baseline:** `1a7336984ea5bada47f0820e10c9decd53ad57f3`
**Execution planning anchor:** the operator-observed amendment commit frozen as `BCF_VALIDATOR_BASE`; its self-referential Git hash is deliberately not embedded in its own tree
**Branch:** `experiment/jul16-boundary-core-history`
**Specification:** `docs/superpowers/specs/2026-07-15-semantic-boundary-hygiene-design.md`
**Implementation plan:** `docs/superpowers/plans/2026-07-16-boundary-contract-feedback-hardening.md`

## Outcome

This packet defines the evidence and execution ledger for the first approved 2026-07-16 hardening
tranche. The tranche closes runtime-contract and feedback fail-open behavior before extending
history, provenance, reachability, supply-chain, hooks, workflows, or external producers.

No tracked production code has changed under this packet. A recovered untracked Task 0 validator
scaffold exists but is not accepted implementation evidence. No local hook, GitHub workflow, required check,
ruleset, issue, pull request, comment, review, label, merge, workflow run, or external service has
been created or mutated.

## BCF-00A Recovery Amendment

The previous Codex terminal lane stopped during Task 0 validator construction without a commit.
Recovery re-proved branch `experiment/jul16-boundary-core-history`, head
`0f6cc67609024dd2deb343d2d9a4e5f17de5ac48`, a clean tracked diff, and the preserved owner file
`experiment-results.tsv` with SHA-256
`f93e0c1b42bc10fc8f8a2488d0efe7a12f671088e00f31bf772161d8bd15e9a3`. The only additional paths are
the untracked provisional scaffold:

- `scripts/lib/verification/boundary-run-manifest.ts`
- `scripts/verify-boundary-run.ts`
- `tests/scripts/verify-boundary-run.test.ts`

The stopped lane reported an advisory scaffold RED and a zero-exit scaffold typecheck. It also
observed an intermediate one-test GREEN. None can satisfy BCF-00: the helper was uncommitted, the
complete registered validator suite did not run, and no committed-helper manifest exists.

Recovery identified seven completion-critical ambiguities and closed them in the authoritative
plan before resuming implementation: declared-output admission ordering; active versus finalized
`verify`; the exact 33-marker BCF-00 roster; exhaustive fixed-key/canonical wire formats; attempt
entry/terminal/transition head anchors; nonexistent derived-root symlink/TOCTOU handling; and the
sole exact bare bootstrap commit. At recovery entry, no fetch, merge, semantic BCF change, staging,
or bootstrap commit is permitted. Once the amendment has both a fresh fail-closed external
plan-review receipt and a local commit frozen as operator-observed `BCF_VALIDATOR_BASE`, the next
permitted action is a fresh advisory BCF-00A RED against the amended contract, followed by its
three-file implementation.

The revived TDD lane later exposed one additional wire contradiction before predecessor code was
written: `CompletionReceipt` hashes the completed ledger, but the `ChainRow` table still named that
same completion-receipt digest even though the adjacent prose prohibited the reverse edge. The
closed row now uses `previousLedgerSha256`—null only for the genesis row and equal to the exact
predecessor ledger digest thereafter—so receipt-to-ledger hashing is acyclic. The prior planning
receipt and planning-base commit predate this correction and cannot authorize the bootstrap parent;
the operator must bind fresh exact-input review to a successor planning commit before resuming the
bootstrap lane.

The revived attempt-table implementation then exposed a second dynamic-argv omission before any
child process ran: the three required liveness probes consume decimal identities emitted by the
watchdog canary, but the closed placeholder allowlist did not name those prerequisite-derived
values. The plan now permits only `watchdog-parent-pid`, `watchdog-child-pid`, and
`watchdog-group-pgid`, parsed by the helper from the admitted canary PID artifact and never accepted
from callers. This correction likewise requires a fresh exact-input review and successor planning
commit before the bootstrap validator commit.

The next revived implementation pass stopped again before inventing four completion-critical
internal-check contracts. The plan named readiness, producer inventory/version decision, feedback
measurements, and documentation lineage checks but did not freeze exhaustive result keysets,
canonical row order, exact producer/token/hash relations, or a caller-independent source for every
lineage endpoint. The authoritative plan now defines closed `ReadinessRecord`,
`ConsumerVersionDecision`, `FeedbackMeasurements`, and `DocsLineageReport` objects and makes each a
helper-derived result. No caller-authored JSON, endpoint environment variable, or result path can
satisfy those checks. This amendment requires a fresh never-reused 27-pass plan-review closeout plus the
repository documentation guards before validator implementation resumes.

The same pass refreshed the SSH remote and observed `origin/main`
`5d16cd401e1250f417f7bde481a4cc8b0ad1df55`. Read-only `git merge-tree` and an isolated detached
merge probe from feature head `ea9a3dcb37f7b349cf0cbd4aaac5278dd4dfed5c` both reported exactly
two conflicts: `docs/work-index.json` and `docs/work-index.md`. In the isolated probe, the canonical
pinned work-index generator produced 68 rows; staging only the regenerated pair left no unmerged
entries or conflict markers, `git diff --check` passed, and `guard:work-index` reported clean. The
plan therefore authorizes only that exact helper-owned generated-index recovery, with recorded
stage OIDs, direct generator/guard statuses, exact-path checks, and full abort/restoration on any
neighboring failure. A different upstream OID or conflict set still stops for another explicit
amendment; no general auto-resolution policy exists.

Before this amendment, the committed feature state through
`ea9a3dcb37f7b349cf0cbd4aaac5278dd4dfed5c` was pushed to the SSH remote without bypassing hooks.
The full pre-push chain passed 39 test files/742 tests, 14 design-guard files/182 tests, 87 tokenomics
tests, both TypeScript checks, documentation/publication/work-index guards, test-integrity with no
new findings, and console lint/build. The sibling ARC full-content comparison was unavailable and
only its clean vendored pin was observed, so full ARC parity remains unclaimed. The untracked
validator scaffold remains outside that pushed commit and is not accepted evidence.

## Planning Review Evidence

The 27-pass deterministic plan review completed under the external artifact root recorded in the
local operator handoff as `PLAN_REVIEW_ARTIFACTS`. The machine-local value is intentionally not
published in this repository.

The pre-commit review must report `valid: true`, 27 ordered passes, nine legacy artifact contracts,
seven cross-artifact consistency rules, all 15 current contracts through a separate `--all`
receipt, and final manifest status `completed`. Its unique root must preserve every failed attempt;
none is converted to clean evidence by a later passing neighbor.

The prior hash-locked copied tool snapshot's unfiltered suite ran 185 tests with three failures:
bundle synchronization plus native/source parity for `task-graph.v1.schema.json` and
`policy-decisions.v1.schema.json` against a changing external source tree. That historical lane
remains Inconclusive, not clean. Before this amendment's snapshot was created, the live installation
exposed the 33-pass inventory and its unfiltered suite ran 239 tests with zero failures; that live
observation is preliminary only. The amendment review must copy the complete selected tool closure,
make it read-only, and rerun the suite there before using its result. The direct 15-contract receipt
and legacy complete-run 27/9/7 receipt remain separate and both are required. Even after those direct receipts pass, execution is `Not Ready` for
BCF-01: A-08 upstream/predecessor reconciliation, A-09 immutable artifact identity, and A-10
lifecycle/oracle disposition must pass first. A-02 remains due before BCF-02, A-03 before BCF-05,
and A-06 before BCF-08C. This does not claim that any production change, schema-2 receipt, provider
deadline, feedback budget, test, hook, workflow, hosted check, or agent-correction trial passes.

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
accepted closeout. These are planning contracts only; none is committed or authoritative yet.
Uncommitted validator TDD may exist in the working tree, but it is advisory until the exact
three-file bootstrap commit and post-commit replay.

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

The 2026-07-16 validator revival also found that `record-review --review-path` had no frozen input
keyset or source-versus-parent semantics, and finding-specific reproduction IDs were not bound to
literal commands. The plan now defines canonical source `reviewInput` rows, profile-owned review
aliases/dedupe keys, imported-manifest parent binding, review evidence closure, exact
`reproductionContract` rows, and the sole constrained dynamic-attempt lane in `bcf-reproduction`.
No implementation was invented before that contract was written and re-reviewed.

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

## 2026-07-16 committed-helper recovery

Bootstrap validator commit `e781ae26bccad5f9af6c6cdc1c6f232c16213de4` passed its recorded
57-test postcommit suite and `typecheck:scripts`. Its first immutable observation run,
`bcf00-observation-e781ae26b`, then preserved the planned generated-index preview with direct Git
exit 1, leading tree `0cb7789cf68a84e8d653906e40ab3007ba2d7fc6`, complete stage-1/2/3 rows,
and conflicts only in `docs/work-index.json` and `docs/work-index.md`. The attempt remained
Inconclusive because the bootstrap contract incorrectly required exit 0 and OID-only stdout. Do not
reuse or overwrite that run. The approved recovery is one plan/notes commit followed by the exact
three-validator-file correction `fix(quality): accept conflict merge previews`, then a fresh full
observation run.

## 2026-07-16 postmerge validator recovery

Fresh observation run `bcf00-observation-8a4e34828` passed and pinned origin/main at
`5d16cd401e1250f417f7bde481a4cc8b0ad1df55`. Reconciliation run
`bcf00-reconciliation-8a4e34828` then created merge
`39023446bcbf6795a51d2142678b7fcdb836fe3e`, with validator commit
`8a4e348282a7c7be17576f352208a52802bce1eb` as first parent and the pinned upstream as second
parent. Its helper-owned generated-index resolution passed for exactly `docs/work-index.json` and
`docs/work-index.md`. The subsequent required `postmerge-validator-suite` did not pass: the
pinned-conflict regression cloned the current postmerge head, so the pinned parent was already an
ancestor and the fixture could not recreate the expected conflict. The failed attempt, run, merge,
and original branch remain preserved and non-retryable.

Recovery continues on `experiment/jul16-boundary-core-history-recovery` from validator commit
`8a4e348282a7c7be17576f352208a52802bce1eb`. After this plan/notes amendment, make exactly one
three-validator-file correction with subject
`fix(quality): make pinned merge regression head-independent`. Centralize the profile-owned pinned
OID and make the regression select the historical merge's first parent before building its local
fixture. Then create new observation and reconciliation run IDs; no result from the failed run may
be promoted or overwritten.

## 2026-07-17 executable-marker recovery

Fresh run `bcf00-observation-ccfec077-20260717a` preserved a zero-exit validator child with 58
passing assertions and identical pre/post snapshots, then correctly remained Inconclusive because
structured admission found reserved marker `[BCF00-S01]` outside the frozen 33-marker registry. The
marker was introduced by the later exit-parser regression; expanding the registry would contradict
the approved contract. Preserve the failed run. The corrective commit keeps that regression
unmarked and adds a bounded executable-roster check through `vitest list`. Its focused RED showed
only the extra marker, and its focused GREEN passed all 59 assertions. A fresh observation must
re-run the suite and typecheck after the corrective commit; the failed run is never retried or
promoted.

## 2026-07-17 work-index gate recovery

Reconciliation run `bcf00-reconciliation-3e4b6bf21-20260717a` created the exact helper-owned merge
`25a18f7b7eb0147daad946c321144f1dfb229320` with corrective commit
`3e4b6bf21a195867d5e53a0e9ae2c5a8b620831d` first and pinned upstream
`2862bc0e6bd4157449503bd9c405e67d34cf0256` second. Postmerge validator admission, both typechecks,
the focused predecessor suites, and the 13/40, 39/40, and 18/18 evaluator predicates passed. The
required branch gate exited 1 at `guard:work-index`: scanner comparison found only the handoff row's
checked-in `last_modified: 2026-07-16` versus Git-derived `2026-07-17`. This occurred because the
index was regenerated before the documentation commit that advanced that date. Preserve the run,
gate logs, merge, and original branch as Inconclusive. Recovery starts from `3e4b6bf21a195867d5e53a0e9ae2c5a8b620831d`
on a distinct branch, commits this amendment with newly generated index artifacts, verifies the
index after commit, and uses new observation/reconciliation IDs. No prior Pass attempt substitutes
for the failed required gate.

## 2026-07-17 nested-console capability recovery

Reconciliation run `bcf00-reconciliation-02c955ca4-20260717a` created helper-owned merge
`9abc8d11aadce6e1ad621b8c912fdeaeb2177035` and passed the corrected work-index check, postmerge
validator admission, focused suites, typechecks, and locked evaluator predicates. Its required
branch gate later exited 1 when `console` shadow lint could not resolve
`eslint-plugin-react-hooks`. Root dependency installation does not materialize the separate
`console/package-lock.json` tree. Preserve that run, merge, logs, and branch as Inconclusive.
Recovery starts from `02c955ca41444ca6a1d616abda4bb5607e00c61b` on another branch, installs
both root and console lockfiles through the pinned wrapper before run initialization, and verifies
the missing package is readable. Those setup checks are not BCF Pass evidence. The full immutable
observation/reconciliation and branch gate must run again under new IDs.

## 2026-07-17 predecessor-closure alias recovery

Fresh reconciliation run `bcf00-reconciliation-75e3290bc-20260717a` finalized Pass at merge
`303ff8dbcc3194219a10e3cfff9ef0dc78a88c1c` after all required validator, typecheck, focused,
evaluator, branch-gate, readiness, lifecycle, lock, and verification checks passed. That exact head
was pushed on `experiment/jul17-boundary-contract-feedback-hardening-recovery2`. The first BCF-01
`init` correctly created no successor run, but rejected predecessor admission because its closure
contained the same `readiness.json` physical file through two congruent manifest roles: the
`readiness-check` structured result and its registered artifact. Both records have the same
producer, path, SHA-256, and byte count; the current closure builder nevertheless reports a
duplicate logical path.

Preserve the finalized BCF-00 run and pushed branch. Recovery starts from pre-merge documentation
commit `75e3290bc94e88f5ef75f9d1f5783883c5e34d76` on a new branch, after replaying both pinned root
and console dependency installations. Add a focused RED/GREEN regression and permit only an exact
same-producer structured-result/artifact alias to contribute one closure row. Different producers,
digests, byte counts, or any unrelated repeated path remain fail-closed. Then rerun the complete
BCF-00 observation/reconciliation chain under fresh IDs before another BCF-01 initialization.

## 2026-07-17 structured-stream alias recovery

Recovery3 finalized BCF-00 Pass at merge `247e0eaf2297f0caa5dbfe8355f84dd5f21efc94` and pushed
`experiment/jul17-boundary-contract-feedback-hardening-recovery3`. Its first BCF-01 initialization
again created no successor run. The corrected closure admitted `readiness.json`, then reported the
remaining duplicate paths at the baseline, candidate, and holdout evaluator stdout logs. Each
evaluator's closed contract uses the exact JSON stdout stream as its structured result; path,
SHA-256, byte count, and producing attempt all agree.

Preserve the finalized run and pushed branch. Recovery4 starts from pre-merge validator commit
`96c81767bd392319ec8e3278d17a326640bd7b42` with both dependency preflights replayed. The next
focused regression admits only an attempt's exact own-stdout/structured-result alias as one closure
row. Any mismatched digest or byte count, a structured result that aliases another attempt's stream,
or an unrelated duplicate path remains fail-closed. A fresh observation/reconciliation chain is
required before the next BCF-01 import attempt.

## 2026-07-17 profile-owned work-transition recovery

Recovery4 finalized BCF-00 Pass at merge `b17f65e2c39b7c79d0a6ec172717185c2dc8218e` and pushed
`experiment/jul17-boundary-contract-feedback-hardening-recovery4`. The first BCF-01 initialization
successfully imported that predecessor. After the profile-owned parser tests were edited, the
reserved `parser-red` command was rejected before spawn as `attempt-pre-snapshot-drift`. A second
initialization after the edit correctly rejected the finalized predecessor because read-only
source verification observed the live edit. Together those results prove the documented
clean-init, edit, RED-command sequence is unreachable under exact pre-snapshot equality; the same
equality would also reject the later unstaged-to-staged representation change before commit.

Preserve recovery4, its finalized BCF-00 evidence, the failed successor evidence, and its local RED
test tranche. Recovery5 starts from `26468adb50fac15ab52e3a8addd0f23ecc5aeb16`. Predecessor
verification remains exact. The bounded correction admits only profile-owned unstaged tracked
deltas before commands and only a hash-identical unstaged-to-staged transfer before commit.
Regressions must reject foreign tracked paths, index drift before commands, owner/untracked drift,
and any staged bytes that differ from the last accepted unstaged snapshot. A fresh immutable
BCF-00 chain is required before BCF-01 is recreated.

## 2026-07-17 loadgate-capacity recovery

Recovery5 merged at `92614ea365c2dd5820d7093fca864a1be41fef26` after the validator and all
focused, typecheck, and evaluator attempts passed. The required branch gate itself never started:
its strict loadgate measured load1 54.48 above the 28 ceiling, waited the full 120 seconds, then
still measured 37.28 and exited 75. The helper recorded empty stdout, the bounded refusal on
stderr, raw exit 75, and identical pre/post snapshots. The run now has a deferred/inconclusive/current
lifecycle and verifies as Inconclusive; Pass-only finalization correctly rejected it.

The same merge later passed the repository pre-push gate once capacity eased and was pushed on
`experiment/jul17-boundary-contract-feedback-hardening-recovery5`. That is useful root-cause
corroboration, not substitute BCF evidence. Recovery6 starts from
`19b75bb7871b313e4bdcab9af01bfab55cb67427`, replays both pinned dependency installs, and requires
a strict setup-only load canary before creating new observation/reconciliation IDs. No threshold,
timeout, required-attempt set, or failed-run record is edited.

## 2026-07-17 RED-selection predicate recovery

Recovery6 finalized and verified BCF-00 Pass at merge
`a1a7bb027f1dcd368bd62ee31bbf1793ae0f96fc`, then pushed
`experiment/jul17-boundary-contract-feedback-hardening-recovery6`. Its BCF-01 successor imported
that exact predecessor. A raw focused preflight proved six exact unsafe sentinel failures and one
passing safe control, but the helper-owned `parser-red` attempt classified 41 assertions excluded
by its own `--testNamePattern` as selected pending/unregistered failures. Vitest's JSON report keeps
those unselected legacy and neighbor assertions as `skipped` rows and counts them as pending, so
the current predicate makes every planned RED attempt unreachable.

Preserve the failed attempt and active Inconclusive successor; its lifecycle cannot be closed
without the profile-owned commit transition. Recovery7 starts from
`19b75bb7871b313e4bdcab9af01bfab55cb67427`, carries forward the loadgate amendment, and binds RED
validation to selected U/S assertions while still rejecting a selected skip/todo, an unknown BCF
marker, or any report-count mismatch. GREEN remains strict over every collected assertion. The
BCF-01 test tranche is preserved in the named stash
`bcf01 markers after red predicate failure` until a fresh finalized BCF-00 chain can import it.

## 2026-07-17 versionless capability recovery

Recovery7 finalized and pushed BCF-00 Pass at
`4b56d9a7d51e8cfbb30b46a5700e4376a1d4ce7d`, then completed, finalized, verified, and pushed
BCF-01 at `2f0eabe49f9ef0aaac17c1dcc5db0c0c6fc5f045`. BCF-02 initialization failed before a run was
created because the helper resolves its required `tr` capability by invoking `--version`.
macOS `/usr/bin/tr` rejects that GNU-only option; `/usr/bin/wc`, `/usr/bin/test`, and
`/usr/bin/kill` have the same portability boundary for later closed profiles.

Recovery8 starts from pre-merge validator commit
`56b1e28e5cb1eca817fb0704a5bb189daacb5b36`. The correction keeps realpath and complete executable
SHA-256 binding for every tool. Only `kill`, `test`, `tr`, and `wc` may use the deterministic
`content-sha256:<digest>` version surrogate after a nonzero or empty version probe; all other tools
still require a successful nonempty version string, and GNU timeout identity remains mandatory.
Fresh BCF-00 and BCF-01 chains are required before BCF-02 can be initialized again.

## Authorization Boundary

The planning packet's initial approval authorized writing and committing the local specification,
plan, and implementation notes, then implementing and locally verifying the planned code tranche.
It did not authorize creating or mutating GitHub issues, pull requests, comments, reviews, labels,
merges, workflow runs, rulesets, required contexts, repository settings, or external producers.

The current owner instruction explicitly authorizes committing, pushing, opening the integration
pull request, and merging this boundary-contract lane into the `LucasQuiles/WhatSoup` repository
after its required evidence is complete. That authorization does not include issues, unrelated
comments, settings, rulesets, required-check changes, workflow reruns, or other external producers.
