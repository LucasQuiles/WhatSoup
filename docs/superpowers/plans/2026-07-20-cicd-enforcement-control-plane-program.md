# Recursive CI/CD Enforcement Control Plane Program

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this program through its referenced plans. Every implementation bead also requires superpowers:test-driven-development, superpowers:test-integrity, and superpowers:verification-before-completion.

**Status:** Active

**Goal:** Establish an authoritative, efficient, traceable, bypass-resistant CI/CD control plane while preserving existing canonical detectors and preventing uncertain evidence from becoming a passing decision.

**Architecture:** Build the control plane in serial trust layers. A strict manifest and neutral result envelope bind existing native controls without recomputing their decisions. An exact-Git-object classifier chooses the smallest trustworthy work set. Thin local and workflow adapters consume those contracts. Protected evaluation, portability, artifacts, and deployment are promoted only after their own unsafe/safe proofs and external trust prerequisites exist.

**Tech Stack:** TypeScript, Node.js 24.15.0 and 25.x validation, Vitest 4, Git object plumbing, Husky, GitHub Actions, YAML structural parsing, macOS arm64 and Linux x64 hosted runners, SHA-256 evidence.

## Global Constraints

- Preserve `repo-hygiene-guard.ts`, `publication-guard.ts`, semantic-quality policy/receipt code, fitness rules, and boundary-run evidence as their native decision owners.
- Do not create a second privacy catalog, risk classifier, exception mechanism for the same scope, serializer, artifact identity model, or aggregate-gate implementation.
- Label every finding `Proven`, `Inconclusive`, or `Proposed`; only a proven reachable failure may enter a blocking production bead.
- Every bead starts with a patch admission packet naming exact revisions, structural location, unsafe fixture, safe neighbor, expected decision/exit, smallest repair, unchanged controls, verification, and rollback.
- Every control emits exactly one `PASS`, `WARN`, `BLOCK`, `INCONCLUSIVE`, or `NOT_APPLICABLE` outcome. Aggregate gates derive only `PASS`, `BLOCK`, or `INCONCLUSIVE`. Warnings remain visible but cannot satisfy mandatory evidence; not-applicable requires trusted classifier proof. Missing, stale, malformed, cancelled, timed-out, masked, or unexpectedly skipped mandatory evidence is never pass.
- Bind authoritative evidence to exact Git object IDs, policy/manifest/tool digests, trust class, producer, platform, freshness, and artifact digest where applicable.
- Bind every lane to a lineage lease containing base/candidate/tested-merge/remote OIDs plus manifest, policy, toolchain, plan, and prerequisite-receipt digests. Apply the declared dependency invalidation matrix whenever any lease input changes.
- Require validated preconditions, direct child statuses, strict shell semantics where shell is unavoidable, process-group termination proof, terminal atomic receipts, append-only attempts, exact workspace-set reconciliation, and irreversible candidate/cache/artifact taint before interpreting a result.
- Produce all human and agent feedback from one validated canonical object with stable versioned domain codes, causal grouping, safe structural locations, canonical owner, allowed/prohibited patch scope, reproduction preconditions, focused verification, retry/exception semantics, related findings, and stable fingerprint.
- Version the reason catalog as an immutable semantic registry. Active codes use `<plane>.<domain>.<object>.<condition>` and declare lifecycle, default outcome/severity, stages, confidence, retry/remediation classes, required bindings, owner, disclosure, template, fixtures, and escalation/expiry. Historical V1 codes are readable only through explicit deprecated/superseded mappings; meanings are never repurposed.
- Give every warning an owner, repair SLA, expiry, escalation condition, and distinct successor code. Warning evidence remains advisory and cannot satisfy a mandatory set.
- Distinguish claimed versus observed scope and public versus private evidence references. Missing scope disclosure, stale reviewer evidence, unproven process identity, or concurrent writer ownership is inconclusive and invalidates dependent evidence.
- Accept worker or reviewer evidence only after tool self-tests/source digest, task/scope/mode/schema/result digest, sources/commands/changes, observed model/tool identity when available, confidence/risks, terminal status, and lead reproduction are validated.
- Use synthetic fixtures. Public output never repeats a private match, source excerpt, absolute local path, environment dump, registry value, or reversible low-entropy fingerprint.
- Keep hooks fast and non-destructive; remote equivalents remain authoritative.
- Preserve existing required GitHub checks until replacement gates pass real PR canaries and,
  only when repository topology and separately authorized queue settings support it, real
  merge-group canaries; a separate hosted-settings change must still be authorized and read
  back.
- No live service, keyring, deployment, artifact publication, credential, repository-rule, environment, runner-group, or cloud mutation occurs under this source-only program approval.
- Stop immediately on unexpected `HEAD`, remote, worktree, index, runtime, artifact, receipt, or owned-process-group drift.
- Use ordinary commits and reversible source changes. Never rewrite public history or automatically remediate public metadata.

Named P0 scenarios include `integrity.writer.worktree.concurrent`,
`integrity.lineage.review.stale`, `integrity.process.identity.unproven`,
`execution.shell.failure.masked`, `execution.process-group.child-live`,
`evidence.receipt.state.nonterminal`, and `integrity.remote.readback.mismatch`. A separate resumed
client or worker that can mutate the same worktree/branch invalidates every overlapping
review and verification receipt even when its resulting commit is clean or uses an approved
author. Preserve the state, establish one observed writer by PID/start/process-group/CWD and
ownership evidence, quarantine stale results, and reconcile lineage before resuming.

## Frozen Evidence and Resumption Lease

- **Historical admission:** the program was first drafted at `f43b877ffab07bd3b75f1be645c4552f3a127b18` with `origin/main` `24bb5e5528c7909a8df5f4d490d83e21604f3646`.
- **Durability checkpoint:** live SSH readback initially bound local and remote design branch to `9fc8a640845d581025b6e7997c0de70b55478a1e` and remote `main` to `24bb5e5528c7909a8df5f4d490d83e21604f3646`. The `9fc8a640…` commit explicitly bypassed hooks and remains preservation evidence, not verified closure.
- **Last implementation-source commit:** `1bdd8ea37c7c9f3fb600fe0f5a68901398c50ca3`; the later documentation-only planning admission is `b8f485477a71dcc6fc6572bc3dafe0a31d5e8482`. At that admission the locally observed `origin/main` tracking ref was `6fb5ee72e6f2ae6f4ddc858b7fc0db0fae825c0c`, and the design branch's upstream tracking ref remained `9fc8a640845d581025b6e7997c0de70b55478a1e`. These are local Git observations, not fresh hosted readback. The tracked worktree/index sets were clean immediately after the planning admission, and the workflow/portability plan is now tracked; every later bead must freeze its own current lease rather than inheriting this historical observation.
- **Current planning state:** the design, program, and foundation plan are tracked. `2026-07-20-cicd-workflow-portability.md` is reviewed as a separate source-only canary plan and remains blocked on CP-F2f, CP-WA1, CP-H1c, CP-GL1, CP-H1d, CP-F4, and CP-F5. Plan digests and prerequisite receipts are refreshed before each mutation, promotion, and closeout; a changed digest invalidates dependent evidence.
- **Current integration observation:** local merge commit `308b08069da327ce38b16c7e0206593a5eee4529`
  preserves the evidence-bearing topic history through first parent
  `c6b7540ad3fb969c544997b132975a0b97159fa2` and incorporates locally observed
  `origin/main` `2be8a2c9a57642a2f43e39dedac39dbcd4330193` without rebasing. The earlier second-parent
  workflow has source-level `merge_group` wiring, keeps merge-group runs out of
  cancel-in-progress, and uses 14/14 direct external full-SHA references. Those source facts
  invalidate the older workflow-gap reviews; they do not prove reviewed action provenance,
  protected-policy execution, exact-set merge authorization, or a live merge queue. The
  latest six-path main delta changes fail-closed and session/fleet transaction code; it is
  disjoint from the staged planning paths but invalidates prior merge-sensitive and aggregate
  receipts.
- **Review history:** stale pre-resumption manifests, terminal Luna/Terra reviews on the superseded `d7a443cb…` lease, Terra capability/bootstrap failures, a publication-CAS failure, a Luna publication-recovery failure, and runs stopped on upstream drift remain preserved as advisory or inconclusive evidence. No verdict or draft edit transfers without independent validation on the current reconciled bytes.
- **Proven:** `scripts/required-suites.ts` is informational, falls back when its merge base cannot be resolved, and exits zero on internal failure. It is not an authoritative classifier.
- **Proven:** CP-F1, CP-F2/CP-F2e, CP-F3, CP-H1a, and CP-H1b now exist through ordinary source commits: the strict control manifest, neutral five-outcome result/taxonomy/precondition/attempt contracts, exact-object classifier/lineage lease, report-only hook-identity guard, and report-only ref policy are present. `verify:fast`, `verify:pr`, `verify:portability`, `verify:deploy`, `portability-gate`, and `policy-gate` remain absent.
- **Proven:** `.husky/pre-push` invokes `scripts/pre-push-guard.ts`, which classifies stdin but runs verification against ambient `HEAD`; delete-only ref updates are skipped.
- **Proven:** `guard:hooks-installed` exists, current `core.hooksPath` resolves to
  repository-relative `.husky`, and the installed-byte guard passes at the reconciled HEAD.
  The active pre-push adapter still does not invoke that guard or the report-only ref policy
  authoritatively. Hook/ref atomic cutover remains CP-H1d; the current local hook identity is
  a commit precondition, not remote authorization.
- **Proven:** `quality.yml` now handles `merge_group` and all 14 direct external workflow
  references are full-SHA pinned. No stable exact-set aggregate or authenticated
  merge-result receipt exists; native macOS coverage remains narrow; browser failure
  screenshots still lack a proven publication scan; and a candidate-controlled pull-request
  job still receives a private test-integrity deploy key after candidate execution.
- **Inconclusive:** current hosted required-check/App bindings, CodeQL requirement and
  merge-group behavior, merge-queue state, action-pin provenance/enforcement, native macOS
  requirement, environments, runners, bypass actors, `CODEOWNERS` enforcement, and tag
  rulesets remain unknown until a fresh authenticated hosted-state receipt binds the exact
  producer, attempt, timestamp, and observed settings. The tracked checklist documents one
  classic-protection approval for non-admins, admin bypass, and queue unavailability on the
  current user-owned repository; this program treats those as documented observations, not
  authenticated hosted evidence.
- **Proven:** release snapshots read ambient worktree bytes while labelling a resolved Git ref, and current application release evidence lacks exact artifact closure, SBOM, provenance, attestation, immutable publication, artifact-digest runtime readback, and application rollback.
- **Inconclusive:** organization/enterprise required workflows, inherited runner isolation, full ruleset precedence, and legacy tag protection.
- **Proposed:** OCI publication, cloud OIDC, GitHub-hosted deployment, Kubernetes/GitOps admission, and extra target architectures. These do not authorize code or hosted changes until product topology is declared.

## Program Dependency Graph

```text
CP-F1 manifest/schema/inventory
  -> CP-F2/CP-F2e neutral result/reason/serializer
    -> CP-F2f versioned agent recovery and remediation closure

CP-F2/CP-F2e
  -> CP-F3 exact-revision classifier
    -> CP-H1a/H1b additive hook/ref/object evidence

CP-F2f + CP-F3
  -> CP-H1c neutral exact-object integration

CP-F3 + CP-WA1
  -> CP-GL1 coordinator remote observation and drift receipts

CP-H1c + CP-GL1
  -> CP-H1d exact-ref transport cutover
      -> CP-F4 canonical fast/PR facades
        -> CP-F5 manifest self-protection, exceptions, dual-run parity, atomic ownership
          -> CP-W1 protected workflow-policy evaluator
            -> CP-W2 stable gates and immutable workflow dependencies
              -> CP-P1 native Linux/macOS portability
              -> CP-G1 source ownership + hosted-settings verifier

CP-F2f + CP-F3 + CP-F4 + CP-F5 + CP-W1 + CP-W2 + CP-P1 + CP-G1
  -> ART-01 exact-source host artifact contract
    -> owner product/trust declaration
      -> ART-02 target artifact/SBOM/provenance
        -> ART-03 protected publication/attestation
          -> DEP-01 dry-run deployment/readback
            -> SCH-01 scheduled artifact/recovery recursion

CP-F1 + CP-F2 + CP-F4
  -> CP-M1 bounded metrics and advisory-promotion feedback

CP-F2 preconditions
  -> CP-WA1 exact workspace-transition preservation
```

Every consumer after CP-F2 requires current diagnostic, precondition, and terminal-attempt
receipts. Every consumer after CP-F4 requires current execution-kernel, taint, and exact-set
receipts. CP-F5 parity and atomic ownership proof precede any hook, workflow, aggregate-gate,
artifact, or deployment promotion. ART-01 begins only after Wave 2's protected workflow,
stable-gate, native-portability, and source-governance receipts are current; earlier
source-export experiments remain non-promotable proposals and cannot satisfy ART-01.

The post-CP-F2 migrations `CP-F2e` and `CP-F2f` are prerequisites for H1c neutral-receipt
integration and H1d cutover. CP-F2f preserves V1/V2 historical bytes while adding the
versioned current agent-recovery and remediation-closure contract. H1c may develop native
exact-object RED fixtures and additive readers in parallel, but no new adapter may invent
missing enriched fields or an alternate taxonomy. CP-GL1 consumes CP-WA1 and CP-F3, observes the exact protected main plus leased
topic ref set from a coordinator-owned clone, and precedes H1d transport, remote review,
and workflow canaries. H1d also consumes CP-GL1, CP-WA1 workspace reconciliation, and a
typed current-writer/reviewer receipt before authority transfer.

CP-W1 keeps producer authentication and protected decision provenance independent:

| Proof | Required binding | Missing or mismatched result |
|---|---|---|
| producer authentication | App/integration identity, workflow ref and exact SHA, run/attempt, credential audience | `INCONCLUSIVE` when absent; `BLOCK` when a proven unauthorized producer acts |
| protected policy provenance | protected policy/manifest/tool digests, exact inputs, native evidence digests, revision bindings | `INCONCLUSIVE` when unavailable; `BLOCK` when proven candidate-controlled or altered |
| observed executor identity | runner claim plus observed OS, architecture, runtime, executables, filesystem/native capabilities | `INCONCLUSIVE` when unproven; `BLOCK` on deterministic policy-prohibited mismatch |

## Program Ledger

| Lane | Evidence state | Detailed plan required before mutation | Promotion boundary |
|---|---|---|---|
| Foundation manifest, result, classifier, facades | Proven gaps | `2026-07-20-cicd-control-foundation.md` | source commit only |
| Exact-ref hooks and hook identity | Proven bypass | foundation plan Task 4 | source commit only |
| Workspace-transition preservation | Proven preservation gap, separate from push authorization | admit CP-WA1 before any automated stash/archive transition | exact named-set round trip; source commit only |
| Coordinator Git lineage and drift observation | Proven orchestration gap | admit a separate CP-GL1 plan before source mutation | exact protected main/topic ref-set receipt; no transport or merge authority |
| Manifest self-protection, exceptions, dual-run parity, atomic ownership | Proven partial ownership | foundation plan Task 6 / CP-F5 | exact old/new parity plus unsafe/safe proof before one atomic source-only cutover |
| Protected workflow evaluation and trust split | Proven bypass | admit `2026-07-20-cicd-workflow-portability.md` before mutation | independently sourced evaluator plus separate producer/policy receipts |
| Stable aggregate gates and exact merge authority | Proven partial trigger coverage and aggregate gap | admit `2026-07-20-cicd-workflow-portability.md` before mutation | exact-set real PR canaries plus synthetic/source merge-group proof; real merge-group canary only after supported topology and separate queue authorization |
| Native Linux/macOS portability | Proven partial coverage | admit `2026-07-20-cicd-workflow-portability.md` before mutation | real observed-host native receipts |
| `CODEOWNERS` and hosted repository policy | Proven source/hosted gap | admit `2026-07-20-cicd-governance.md` before mutation | verified public owners plus separate explicit hosted mutation approval |
| Exact-source host artifact | Proven gap | admit `2026-07-20-cicd-artifact-assurance.md` before mutation | source-only artifact builder first |
| SBOM/provenance/publication/attestation | Proven gap, topology conditional | admit `2026-07-20-cicd-artifact-assurance.md` before mutation | owner artifact-store/trust declaration plus reusable redaction/provenance receipt |
| Dry-run deployment/readback | Proven application gap, topology conditional | admit `2026-07-20-cicd-deployment-readback.md` before mutation | owner target/environment/canary declaration |
| Live deployment/promotion | Proposed | no plan until dry-run proof | new explicit production boundary |
| Scheduled artifact/recovery assurance | Proven gap, external recovery conditional | admit `2026-07-20-cicd-scheduled-recovery.md` before mutation | terminal synthetic scheduled/drift/recovery receipts; no external restore or live recovery |
| Metrics and recursive feedback | Proposed report-only | admit `2026-07-20-cicd-feedback-metrics.md` before mutation | bounded inputs; no blocking thresholds without measured baseline |

Missing referenced plan/admission artifacts block their lane; they do not inherit authority
from this umbrella. Findings from feedback metrics create a new admitted bead and never
silently expand or mutate an active one. All public-output or artifact lanes require the
foundation's all-channel redaction and worker/reviewer provenance receipt first.

## Lane Authority, Promotion, and Stop Contract

Each implementation lane is a bounded bead with one named owner, one immutable patch
admission packet, one lineage lease, one dedupe key, one allowed source-write scope, and
one explicit promotion or stop boundary. A lane may consume only receipts whose exact
inputs still match its lease. A changed base, candidate, tested-merge, remote, manifest,
policy, toolchain, plan, prerequisite receipt, or required hosted observation invalidates
the dependent lane and returns it to admission; it never inherits a predecessor's pass.

Every row consumes the common exact base/candidate/tested-merge/remote, manifest, policy,
toolchain, selected-plan, and prerequisite-receipt lease. Its patch-admission packet may
narrow the listed paths but may not add a path family without a new reviewed program change.

| Lane | Accountable owner ID | Dedupe key | Allowed source-write scope | Promotion proof / mandatory stop |
|---|---|---|---|---|
| CP-F1 | `ci.manifest.owner` | `ci-control/cp-f1` | `controls/ci-control-manifest.json`, `scripts/lib/ci-control/manifest.ts`, `scripts/ci-control-manifest.ts`, its tests, `package.json`, `docs/public-surface.md` | Strict manifest unsafe/safe proof and source commit / stop on lease drift, graph ambiguity, or any other path |
| CP-F2 | `ci.evidence.owner` | `ci-control/cp-f2` | `scripts/lib/ci-control/{result,reasons,preconditions,attempt,native-adapter}.ts` and their tests | Exact diagnostic/native-adapter/taxonomy truth table / stop on native-decision recomputation, code repurposing, warning without governance, scope overclaim, leak, or invalid terminal receipt |
| CP-F3 | `ci.classifier.owner` | `ci-control/cp-f3` | `scripts/lib/ci-control/{git-input,classifier}.ts`, `scripts/ci-control-classify.ts`, manifest/package entries, and their tests | Exact-object unsafe/safe classifier proof / stop on ambient bytes, caller-selected risk, or unresolved graph input |
| CP-H1 | `ci.hooks.owner` plus the existing repository-hygiene and publication decision owners for H1c only | `ci-control/cp-h1` | `.husky/pre-push`, `scripts/{pre-push-guard,hooks-installed-guard,safeguard-diagnostics,repo-hygiene-guard,publication-guard}.ts`, policy-neutral exact-object additions in `scripts/lib/ci-control/git-input.ts`, thin native adapter/reason registrations, manifest/package entries, and their existing companion tests | Exact multi-ref, hook-byte, and owner-native exact-range receipt proof / stop on foreign hook identity, unresolved ref, ambient source reads, partial traversal, native-owner duplication, or automatic hook mutation |
| CP-WA1 | `ci.workspace-transition.owner` | `ci-control/cp-wa1` | separately admitted workspace snapshot/transition module, precondition schema adapter, and their tests | Exact named workspace-set round trip / stop on omitted ignored path, partial-staging drift, type/mode drift, or unexpected patch member |
| CP-GL1 | `ci.git-lineage.owner` | `ci-control/cp-gl1` | only paths admitted by the separate CP-GL1 plan for coordinator observation, drift classification, and detached exact-OID review checkout | Exact protected main/topic ref-set and drift receipt / stop on uncoordinated fetch, missing/extra/duplicate/role-swapped ref, shared-ref mutation, or any transport/merge attempt |
| CP-F4 | `ci.runner.owner` | `ci-control/cp-f4` | `scripts/ci-control-run.ts`, `package.json`, manifest command entries, `.husky/{pre-commit,pre-push}`, and their tests | Exact execution set, taint, and process-terminal proof / stop on shell substitution, missing child, or privilege after taint |
| CP-F5 | `ci.self-protection.owner` | `ci-control/cp-f5` | safeguard/test-integrity owners and tests, `controls/ci-control-exceptions.json`, `scripts/lib/ci-control/exceptions.ts`, and manifest registrations | Old/new exact parity plus one atomic ownership cutover / stop on any parity difference, inline bypass, or ambiguous exception |
| CP-W1 | `ci.protected-policy.owner` | `ci-control/cp-w1` | paths admitted by `2026-07-20-cicd-workflow-portability.md` under `.github/workflows/**`, protected evaluator code/tests, and manifest registrations | Independent producer and protected-policy receipts / stop on candidate execution, missing provenance, or undeclared path |
| CP-W2 | `ci.aggregate-gate.owner` | `ci-control/cp-w2` | admitted workflow/gate validators, immutable dependency declarations, manifest registrations, and tests | Exact-set PR canaries plus synthetic/source merge-group proof; require a real merge-group canary only on a supported, separately authorized queue topology / stop on skipped/missing/duplicate result or mutable dependency |
| CP-P1 | `ci.portability.owner` | `ci-control/cp-p1` | admitted portability scripts/tests/fixtures, Linux/macOS workflow lanes, and manifest registrations | Observed-host Linux/macOS receipts / stop on runner-label-only proof, live host mutation, or missing native lane |
| CP-G1 | `ci.governance.owner` | `ci-control/cp-g1` | admitted `CODEOWNERS`, declared governance policy/verifier/tests, and no hosted settings | Verified public owners and source verifier / stop before hosted mutation or when live readback is unavailable |
| ART-01 | `release.source-artifact.owner` | `ci-control/art-01` | paths admitted by `2026-07-20-cicd-artifact-assurance.md` for exact-source export/build plus tests | Exact Git-tree closure and source-only artifact proof / stop on ambient bytes, target ambiguity, or publication |
| ART-02 | `release.assurance.owner` | `ci-control/art-02` | admitted target packaging, SBOM/provenance schemas/builders, manifests, and tests | Immutable target artifact/SBOM/provenance digest set / stop on undefined product topology, taint, or incomplete scan |
| ART-03 | `release.publication.owner` | `ci-control/art-03` | admitted publication/attestation source workflows, policy, and tests only | Declared store/trust identity plus protected canary / stop before credential use or any actual publication without new authority |
| DEP-01 | `deployment.admission.owner` | `ci-control/dep-01` | paths admitted by `2026-07-20-cicd-deployment-readback.md` for dry-run admission/readback/rollback plus tests | Declared target and no-mutation dry-run/rollback proof / stop before live target mutation or on missing readback |
| SCH-01 | `runtime.recovery.owner` | `ci-control/sch-01` | paths admitted by `2026-07-20-cicd-scheduled-recovery.md` for scheduled workflows, drift/recovery verifiers, synthetic drill fixtures, and tests | Terminal scheduled artifact/recovery receipts / stop when the named plan is absent, on any path outside its admission, external backup restore, live recovery, or missing runtime identity |
| CP-M1 | `ci.feedback.owner` | `ci-control/cp-m1` | paths admitted by `2026-07-20-cicd-feedback-metrics.md` for bounded report-only schemas, collectors, reports, and tests | Measured advisory baseline / stop on unbounded data, inferred blocking threshold, or automatic policy mutation |

Protected workflow evaluation keeps three non-substitutable receipt families: producer
authentication proves who initiated the evaluation; protected policy provenance proves the
decision used protected policy, manifest, tool, native evidence, and revision bytes; and
observed executor identity proves the actual runner and native capability. A valid receipt
in one family cannot fill a missing receipt in another. CP-F5's old/new parity and atomic
ownership cutover remain prerequisites for every hook, workflow, aggregate-gate, artifact,
and deployment promotion.

## Recursive Operating Loop

For each ledger row:

1. Inventory canonical owners, callers, schemas, workflows, hooks, tests, public outputs, and hosted state.
2. Prove or falsify the reachable bypass with valid prerequisites.
3. Compare existing behavior with the design and later-stage evidence.
4. Create the unsafe fixture and adjacent safe neighbor at the real boundary.
5. Freeze and review the patch admission packet.
6. Patch the smallest canonical owner through red-green-refactor.
7. Run focused, surrounding, then stage-appropriate verification without filters that hide mandatory work.
8. Obtain independent source-line review and resolve every finding.
9. Commit through hooks and produce local source evidence. Stop before any remote write unless the current owner request explicitly authorizes the exact branch/repository action; after authorization, consume a coordinator-owned remote observation, classify drift without moving the frozen base, reconcile through the integrator when required, push through the exact-ref guard, and bind remote evidence to the pushed OID.
10. Re-run inventory. Convert newly exposed gaps into `Proven`, `Inconclusive`, or `Proposed` rows; do not silently expand the active bead.

## Patch Admission Packet Template

```text
Packet ID:
Evidence label: Proven | Inconclusive | Proposed
Frozen base OID:
Frozen candidate OID:
Control owner and decision owner:
File and structural location:
Reachable failure or bypass:
Synthetic unsafe fixture:
Adjacent safe neighbor:
Expected decision and exit:
Precondition receipt and causal group:
Lineage lease and invalidation dependencies:
Smallest authoritative repair:
Controls and behavior that remain unchanged:
Focused RED command and expected failure:
Focused GREEN and surrounding regression commands:
Public-output leak assertion:
Worker/reviewer receipt and lead reproduction:
Rollback or revert strategy:
External trust assumptions:
Stop conditions:
```

## Commit and Integration Protocol

- Stage only the named bead files. Inspect `git diff --cached --name-status` and `git diff --cached --check` before each commit.
- Commit through the installed hooks after `guard:hooks-installed` exists; before then, record the active hook path and compare its bytes with the current worktree before committing.
- Ordinary linked-worktree workers never fetch. Before mutation, final verification, or an authorized push, consume a coordinator-owned remote observation and retain the immutable `baseOid` separately from `observedMainOid`. Classify incoming path/dependency impact, invalidate only the dependent evidence closure, and require the integrator to perform any admitted merge or reconstruction. Policy/workflow drift stops the lane; disjoint drift still requires fresh classification, proposed-merge, and aggregate evidence but does not rewrite the base or discard eligible candidate-only receipts.
- Verify the configured `origin` uses SSH and resolves to the declared WhatSoup repository before any authorized remote operation.
- Local source completion ends before push or merge. A remote write requires a current owner request that explicitly names or clearly entails the exact repository and branch action.
- When authorized, push the exact local OID through pre-push and verify the remote branch OID equals the scanned OID.
- Preserve current required checks while replacement gates are canaries. Treat any missing, stale, cancelled, skipped, or masked hosted result as inconclusive.
- When separately authorized, merge only after exact-head checks are terminal and current. Read back the merged OID and prove the implementation head is an ancestor of `origin/main`.

## Definition of Program Completion

Completion requires every design evidence-map row to have current-head evidence, including the unsafe block, safe-neighbor pass, actionable result, exact revision/policy/trust binding, removal/weakening mutation failure, remote readback, and explicit disclosure of advisory or unavailable lanes. Conditional artifact and deployment rows remain visibly incomplete until the owner declares their product and trust topology; they cannot be summarized as pass.
