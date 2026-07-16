# Boundary Core History and Provenance Implementation Plan

**Status:** Pending — approved full-program specification and current mining evidence are complete

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Each implementation task begins with a failing behavioral test and ends with
> focused verification and an explicit-path commit.

**Goal:** Build PR B's pure canonical fingerprint, bounded history-provider, disposition-aware
re-entry, upstream provenance, and generic contextual receipt core without composing any new
enforcement boundary.

**Architecture:** Pure deterministic modules live under `scripts/lib/semantic-quality/`. Provider
interfaces accept sanitized, paginated evidence but contain no GitHub or network client. History
and provenance evaluators produce complete boundary findings; the generic receipt layer aggregates
and renders them while preserving the PR A semantic adapter. The experiment evaluator imports the
production core so its frozen 40-case and 18-case holdout remain regression oracles instead of a
second implementation.

**Tech Stack:** Node `24.15.0`, npm `11.12.1`, TypeScript `5.9.3`, Vitest `4.1.8`, Node crypto,
existing exact-tree Git helpers, and the existing semantic receipt implementation.

## Execution and Evidence Contract

- Run every task from the repository root shown by `git rev-parse --show-toplevel`. A missing Git
  repository, mismatched worktree, or unexpected branch is `Blocked`; do not infer project state.
- `artifacts/` is the local evidence root for implementation runs. It is diagnostic and untracked;
  do not stage it. Stable implementation conclusions are summarized in the tracked mining handoff.
- Initialize `artifacts/run_manifest.json` with a run ID, exact Git SHA, UTC timestamp, tool
  versions, commands, exit codes, output paths, and per-task verdicts. Record requested and observed
  runtime configuration separately; unknown configuration remains unknown.
- Use only `Pass`, `Fail`, `Inconclusive`, or `Blocked` for task and gate verdicts. `Pass` requires
  the named command output or deterministic artifact. A missing artifact, missing tool, skipped
  check, timeout, signal, stale output, fallback, or masked exit is `Inconclusive` unless it prevents
  all safe progress, in which case it is `Blocked`.
- Capture focused test output, typecheck output, evaluator scores, timing, review findings, final
  diff, status, remote, branch, and push receipt under predictable `artifacts/` paths. Redact secrets
  and do not store raw GitHub comment bodies.
- Before a task changes code, record its RED command and expected failure. Before its commit, record
  the GREEN command, exact exit, changed paths, and remaining limitations. Do not claim readiness or
  safety from prose, source inspection alone, or a worker report without checking the decisive
  source, diff, test, log, or runtime receipt.
- If a required tool is absent, record `not installed` with the attempted command. If a surface is
  unauthorized or unavailable, record `skipped` plus the authority or availability reason. Neither
  state is equivalent to a clean check.

## Objective, Scope, and Exit Criteria

**Objective:** Add one production implementation of deterministic proposal fingerprints, bounded
history collection, disposition-aware re-entry, upstream provenance evaluation, and contextual
receipt rendering under `scripts/lib/semantic-quality/`, then make
`scripts/experiments/semantic-boundary-eval.ts` consume that implementation.

**In scope:** the four new pure modules, additive receipt types/rendering, precise semantic
inconclusive rule identities, sanitized fixtures under `tests/fixtures/boundary-core/`, focused
Vitest suites under `tests/scripts/`, experiment delegation, and tracked implementation evidence.
The affected exported surface is the script-library TypeScript API listed in File Structure; no
runtime service or user-facing API is changed.

**Non-goals:** concrete GitHub or network providers; `git ls-remote`; pre-commit/pre-push adapters;
package or workflow composition; branch protection; required checks; issue/PR mutation;
supply-chain pin migration; fixing PR #1835; persisting dispositions in an external producer.

| Criterion | Required check and threshold | Evidence |
|---|---|---|
| Canonical identity | All fingerprint tests pass; #1838/#1848-derived records have equal content and patch identities; malformed records reject | `artifacts/task1-tests.txt`, `tests/fixtures/boundary-core/history.json` |
| Complete history | All provider tests pass; every partial, cyclic, mismatched, failed, or truncated query returns `complete: false` | `artifacts/task2-tests.txt` |
| Exact-first policy | All history tests pass; exact/re-entry unsafe cases block and every title/branch/path-only false-positive fixture does not block | `artifacts/task3-tests.txt` |
| Honest provenance | All provenance tests pass; tracking mismatch and proven overlap block, proven disjoint staleness warns, missing evidence is inconclusive | `artifacts/task4-tests.txt` |
| Accurate feedback | Receipt/CLI tests pass and assert every required feedback field; unreadable policy never renders reachability language | `artifacts/task5-tests.txt` |
| Single implementation | Evaluator delegation test passes; baseline is 13/40, candidate 40/40, holdout 18/18, all with zero candidate false blocks | `artifacts/task6-tests.txt`, `artifacts/evaluator-scores.txt` |
| Repository compatibility | Focused suites, script/all typechecks, test-integrity, documentation guards, and complete branch gate exit 0 without masking | `artifacts/focused-verification.txt`, `artifacts/branch-gate.txt` |
| Publication boundary | Final diff contains no hook/workflow/provider/external-service mutation and no raw comment bodies or secrets | `artifacts/final-diff.txt`, `artifacts/final-status.txt` |

**Failure criteria:** any required unsafe fixture passes; a false-positive control blocks; provider
incompleteness yields pass; stable scores change without an approved policy explanation; semantic
unknowns reuse reachability language; the evaluator retains duplicate logic; receipt schema
compatibility breaks; a required command is nonzero, killed, timed out, skipped, or masked; or the
diff crosses a non-goal boundary.

**Quality bar:** deterministic sorted output, bounded errors/evidence, no ambient bypass, exact
artifact references, full intervention feedback, behavior-first tests, no second implementation,
and zero unexplained false blocks in the locked corpus.

**Exit:** every criterion above has a `Pass` artifact, independent review findings are resolved or
recorded as explicit limitations, the tracked handoff contains exact commits/results, the worktree
contains no unintended path, and the verified exact branch is pushed over the SSH origin. Missing
CI, live-provider, external-producer, or supply-chain evidence remains explicitly out of scope and
must not be reported as passing.

## Assumption Audit

Each record uses disposition `Validated`, `Constrained`, `Replaced`, `Unresolved`, or `Blocked`.
An unresolved assumption may not authorize a pass; the named rule must degrade to inconclusive or
the implementation stops at its due checkpoint.

### A-01 — Runtime and test toolchain

- **Statement / category:** pinned Node/npm/TypeScript/Vitest commands are locally executable;
  environment.
- **Source / why / blast radius:** `package.json`, `.nvmrc`, `scripts/run-with-pinned-node.sh`; every
  task and final gate depends on it.
- **Evidence / quality:** installed dependencies and PR A gate output; direct but host-local.
- **Risk if false:** no trustworthy RED/GREEN or typecheck evidence.
- **Validation / command / artifact:** run `node --version`, pinned Node/npm version probes, and the
  first focused test; save `artifacts/tool-versions.txt` and `artifacts/task1-red.txt`.
- **Owner / due / disposition:** implementation lead; before Task 1; `Constrained` to the observed
  host until CI evidence exists.

### A-02 — Additive receipt schema compatibility

- **Statement / category:** broadening unions and adding optional data under schema version 1 does
  not break the existing semantic CLI or known readers; interface compatibility.
- **Source / why / blast radius:** `scripts/lib/semantic-quality/receipt.ts` and
  `tests/scripts/semantic-quality-check.test.ts`; a break would invalidate PR A output and local CI.
- **Evidence / quality:** existing receipt tests cover current JSON; direct but incomplete for
  unknown external consumers.
- **Risk if false:** agents or workflows reject or misread receipts.
- **Validation / command / artifact:** snapshot the current semantic JSON, run Task 5 compatibility
  tests and `rg -n "BoundaryReceipt|schemaVersion" scripts src tests`; save
  `artifacts/receipt-consumers.txt` and `artifacts/task5-tests.txt`.
- **Owner / due / disposition:** Task 5 owner; before Task 5 commit; `Unresolved` until the consumer
  inventory and snapshots pass. Unknown external consumers remain an explicit limitation.

### A-03 — Supported Git identity forms

- **Statement / category:** repository evidence can use 40- or 64-hex Git object IDs; data format.
- **Source / why / blast radius:** Git's SHA-1/SHA-256 object formats and the fingerprint validator;
  rejecting a valid provider OID would make history unusable.
- **Evidence / quality:** current repository supplies 40-hex OIDs; 64-hex support is inferred.
- **Risk if false:** false inconclusive or malformed canonical identities.
- **Validation / command / artifact:** unit-test both lengths plus malformed neighbors; save
  `artifacts/task1-tests.txt`.
- **Owner / due / disposition:** Task 1 owner; Task 1 GREEN; `Constrained` to explicitly tested forms.

### A-04 — Historical artifact evidence availability

- **Statement / category:** a future read-only provider can supply repository identity, complete
  path/blob records, stable patch IDs when available, state, URL, and disposition references;
  external interface.
- **Source / why / blast radius:** GitHub pull-file evidence for #1838/#1848 and PR B provider types;
  exact blocking depends on complete fields.
- **Evidence / quality:** current read-only mining supplied the fields for selected PRs; direct but
  not a production-provider proof.
- **Risk if false:** the guard could miss a duplicate or overstate completeness.
- **Validation / command / artifact:** synthetic provider omits each field in turn and must return
  incomplete; save `artifacts/task2-tests.txt`.
- **Owner / due / disposition:** Task 2 owner; Task 2 GREEN; `Replaced` by a fail-closed interface—PR
  B never assumes missing provider evidence is clean.

### A-05 — Pagination bounds can complete a live query

- **Statement / category:** configured page/artifact bounds will be sufficient for a future live
  repository query; scale.
- **Source / why / blast radius:** 1,625 historical PRs required complete pagination; too-small
  bounds would truncate the decisive artifact.
- **Evidence / quality:** current one-time API inventory is direct; future growth and provider page
  behavior are unknown.
- **Risk if false:** a false clean history verdict.
- **Validation / command / artifact:** boundary tests exhaust each bound and assert
  `complete: false`; live calibration is deferred to PR D; save `artifacts/task2-tests.txt`.
- **Owner / due / disposition:** Task 2 owner; Task 2 GREEN; `Replaced` by inconclusive-on-truncation.

### A-06 — Sanitized fixtures preserve decisive evidence

- **Statement / category:** the #1838/#1848/#1857-derived fixture preserves path/blob, patch,
  state, and delta-kind facts without copied comment bodies; provenance.
- **Source / why / blast radius:** mining handoff and `tests/fixtures/boundary-core/history.json`;
  incorrect transcription invalidates the visible-example claims.
- **Evidence / quality:** exact GitHub/Git values were captured in the handoff; direct.
- **Risk if false:** a passing test would measure an invented case.
- **Validation / command / artifact:** compare fixture identities to the handoff and recompute the
  canonical digest in Task 1; save `artifacts/fixture-provenance.txt`.
- **Owner / due / disposition:** implementation lead; before Task 1 commit; `Unresolved` until the
  fixture-provenance artifact is reviewed.

### A-07 — Frozen evaluator labels remain the policy oracle

- **Statement / category:** the locked 40-case and post-freeze 18-case expected labels remain the
  approved policy for PR B extraction; product policy.
- **Source / why / blast radius:** committed corpus, holdout, approved specification, and PR A
  handoff; score drift could hide a behavioral change.
- **Evidence / quality:** owner-approved design and committed results; direct.
- **Risk if false:** extraction silently changes policy or fixtures encode stale doctrine.
- **Validation / command / artifact:** run all three evaluator commands and require exact 13/40,
  40/40, and 18/18 results; save `artifacts/evaluator-scores.txt`.
- **Owner / due / disposition:** Task 6 owner; before Task 6 commit; `Validated` for this tranche,
  with any requested policy change requiring a separate documented decision.

### A-08 — Time-bound overrides can be evaluated deterministically

- **Statement / category:** UTC ISO timestamps and an injected `now` are sufficient for override
  expiry; time semantics.
- **Source / why / blast radius:** disposition override schema; local timezone or wall-clock parsing
  could create an ambient bypass.
- **Evidence / quality:** current plan specifies timestamps but implementation does not exist;
  missing.
- **Risk if false:** expired overrides remain active or valid overrides fail unpredictably.
- **Validation / command / artifact:** fixed-clock tests for boundary instants, invalid offsets, and
  expired/future records; save `artifacts/task3-tests.txt`.
- **Owner / due / disposition:** Task 3 owner; Task 3 GREEN; `Unresolved` until fixed-clock tests pass.

### A-09 — PR B has no public runtime-service surface

- **Statement / category:** the change is limited to repository tooling exports and does not alter
  fleet/MCP/HTTP runtime behavior; scope seam.
- **Source / why / blast radius:** File Structure and public-surface reconnaissance in
  `artifacts/public_surface_hints.txt`; crossing the seam would require a different review plan.
- **Evidence / quality:** planned paths are direct; final diff is not yet available.
- **Risk if false:** unreviewed runtime or API compatibility impact.
- **Validation / command / artifact:** inspect `git diff --name-only` and `git diff` before every
  commit and final push; save `artifacts/final-diff.txt`.
- **Owner / due / disposition:** implementation lead; every checkpoint; `Constrained` by the explicit
  path allowlist and final-diff failure criterion.

### A-10 — Optional policy scanners are not PR B evidence

- **Statement / category:** `conftest` and `osv-scanner` are optional reconnaissance tools, not
  acceptance gates for this library-only tranche; tooling.
- **Source / why / blast radius:** `artifacts/conftest.txt` and `artifacts/osv.txt` report both tools
  not installed; treating absence as pass would be misleading.
- **Evidence / quality:** direct tool lookup.
- **Risk if false:** a missing unrelated scanner blocks work or is falsely reported clean.
- **Validation / command / artifact:** retain the `not installed` receipts; use repository-native
  typecheck, tests, dependency lock, and branch gate as the actual evidence.
- **Owner / due / disposition:** implementation lead; plan review; `Constrained` and explicitly
  non-authoritative for PR B readiness.

## Primary Validation

Before implementation and again before final verification, write `artifacts/primary_validation.md`
with one row per question: validation question, evidence reviewed, finding, severity, affected plan
sections, required fix, status, and final verdict. The artifact's final verdict must be one of the
four execution verdicts. Any unresolved critical finding makes execution `Blocked`.

| Validation question | Evidence and detectable threshold |
|---|---|
| Does a step depend on unverified evidence? | Cross-check Assumption Audit and task inputs. Any `Unresolved` input without an inconclusive path is `Fail`. |
| Is a contract unconfirmed? | Compare exported interfaces, consumer inventory, and compile order. An imported type/function not created by an earlier task is `Fail`. |
| Are preconditions missing? | Each task must name repo/branch, prior commits, RED state, tools, input fixture, and artifact output. Missing mandatory state is `Fail`. |
| Are dependencies ordered? | Required order is documentation gate → shared types/fingerprint → provider/types → history → provenance → receipts/CLI → evaluator → verification. A forward import is `Fail`. |
| Are boundaries falsely independent? | Provider completeness gates history; provenance parity gates downstream comparisons; receipt changes gate evaluator adaptation. Parallel execution across those seams is `Fail`. |
| Can material failure look successful? | Pipelines must preserve the producer exit; timeouts/signals/skips are inconclusive; decision-only feedback tests fail. Any masked path is `Fail`. |
| Are fallbacks executable? | Only focused pinned tests and the existing branch gate are acceptance lanes. Described but unexecuted network/CI/scanner fallbacks are `Inconclusive`, never pass. |
| Is rollback specific and safe? | Revert only PR B commits/composition; no destructive Git commands, history deletion, or remote mutation. An ambiguous rollback is `Fail`. |
| Are exit conditions concrete? | Every objective criterion must map to an existing artifact and exact expected threshold. Missing mapping is `Fail`. |
| Is operator judgment hidden? | Similarity thresholds, “material” re-entry, artifact completeness, and high-coupling paths must be typed/fixture-backed. Unbounded discretion is `Fail`. |

The plan review's broad `npm test --silent` reconnaissance was interrupted after unbounded, noisy
execution and its tee pipeline did not preserve the test exit. Its verdict is `Inconclusive`, not
clean. Make, pytest, Go, Semgrep, Conftest, and OSV lanes were unavailable for this repository/host.
These are recorded under `artifacts/`; they are not PR B acceptance lanes. Implementation uses the
pinned focused commands in each task and the repository's existing complete branch gate.

The first audit found and resolves these sequencing defects before code starts:

- `BoundaryAction` and `BoundaryFinding` were needed by history/provenance before receipt
  generalization. Task 1 now extracts additive common types into `boundary-types.ts`; Task 5 imports
  and re-exports them while preserving the semantic adapter.
- `DispositionRecord` was referenced by the provider before history created it. Task 2 now creates
  `history-types.ts`; both provider and policy import the one definition.
- deletion records cannot use a null blob without conflating deletion of different content. Every
  record now carries the relevant blob OID; for deletion this is the base/deleted blob identity.
- ignored planning docs must be force-added by exact path before work-index regeneration. The
  documentation gate performs that step before any production-code task.

No circular dependency remains: `boundary-types` and `fingerprint` are leaves;
`history-types` depends only on them; `history-provider` depends on those leaves; `history` consumes
the collection; `provenance` consumes common types; `receipt` consumes common findings; the CLI and
experiment remain adapters.

## Layered Validation and Escalation

PR B changes agent-facing trust-boundary decisions and can suppress or block future repository
actions. Primary, secondary, and tertiary validation are therefore mandatory. Repeating the same
source review at another layer does not count.

Every layer writes an artifact containing: layer, invocation reason, methods, evidence reviewed,
findings, severity, disposition, residual risk, and final verdict.

| Layer | Trigger | Distinct failure class and method | Required artifact | Blocker rule |
|---|---|---|---|---|
| Primary | Every task and plan revision | Logic/order/contract audit; compile and focused positive/negative tests | `artifacts/primary_validation.md` | Any unresolved high/critical sequencing, contract, or masked-success finding is `Blocked` |
| Secondary | Exact blocker, provider boundary, canonicalization, override, or inconclusive path changes | Adversarial edge cases, fault injection, counterfactual neighboring-safe inputs, cursor replay, fixed-clock expiry, malformed records, and frozen-corpus replay | `artifacts/validation_layer2.md` | Missing unsafe, safe-neighbor, or false-positive control is `Blocked`; any deterministic mismatch is `Fail` |
| Tertiary | Mandatory for this tranche because findings steer agents and future Git/GitHub boundaries | Independent code/test review, contradiction search against the specification/mining handoff, independent reproduction of #1838/#1848/#1857 cases, test-integrity scan, and duplicate-implementation review | `artifacts/validation_layer3.md` | Skipped independent review or unresolved critical finding is `Blocked`; advisory findings require lead reproduction and disposition |

Secondary validation must include these counterfactual pairs:

- same exact content on open/closed-unmerged versus same filename/title only;
- stable patch equivalence across rename versus a related but different refactor;
- cosmetic re-entry versus material complete re-entry;
- incomplete/cyclic provider evidence versus a fully terminated page stream;
- stale overlapping/high-coupling provenance versus proven stale-disjoint provenance;
- unavailable policy versus computed unreachable production module;
- exact scoped unexpired override versus wrong-rule, wrong-fingerprint, or expired override.

Tertiary reviewers receive exact immutable inputs, allowed read-only paths, acceptance criteria, and
result contract. They do not mutate the branch or GitHub. The lead checks every decisive source,
diff, test, or replay before accepting a finding. Reviewer silence, progress-only output, stale-head
analysis, or a recommendation without evidence is `Inconclusive`.

Use independent reproduction rather than a third phrasing of policy review: recompute canonical
records/digests, replay synthetic pages, and execute evaluator cases through the exported production
functions. Use contradiction search to compare every finding rule and correction against the
approved specification, task matrix, and semantic CLI output. Use fault injection for provider
throws/aborts and receipt-write failures.

OpenAPI/Schemathesis and web DAST do not apply: reconnaissance found no OpenAPI specification and
PR B has no authorized web target. Their receipts are `artifacts/schemathesis.txt` and
`artifacts/dast_note.txt`; they are `skipped`, not pass evidence. If implementation crosses into a
web/network adapter, scope validation fails and a new security test plan is required.

Intentional deferral is allowed only for an explicitly out-of-scope surface. Record the surface,
reason, owner, follow-up tranche, and residual risk in the applicable layer artifact. Deferral cannot
waive a PR B acceptance criterion. All three final layer verdicts must be `Pass` before Task 8 push.

## Logging, Receipts, and Observability

PR B does not add a runtime logging service. Its observable products are structured boundary
receipts and local implementation evidence. A reviewer must be able to reconstruct an input,
decision, command, validation, change, and final push from those artifacts without relying on
operator memory or prose claims.

| Layer | Purpose and minimum fields | Actor/correlation | Storage and replay use |
|---|---|---|---|
| Input | Exact repository, head/base/remote/merge-base OIDs, action, canonical paths, provider repository/cursor/page, observation time, and limitations | `run_id`; receipt invocation/action; future adapter actor identifier | Receipt plus sanitized fixture; recreates the evaluated candidate without working-tree substitution |
| Decision | Rule ID, verdict, summary, observed evidence, matched artifacts, reason, correction, rerun, source references, action, and fingerprints | `run_id`; deterministic receipt correlation SHA-256 is the decision handle; proposal fingerprint remains an input identity | JSON receipt; reproduces aggregation and explains why the action changed course |
| Execution | Command, cwd/repo, requested runtime, observed runtime/tool version, start/end UTC, exit/signal/timeout, stdout/stderr artifacts | `run_id`, command sequence, optional `trace_id`/`span_id` only when an actual tracer exists | `artifacts/run_manifest.json` and task outputs; proves commands occurred and preserves exits |
| Validation | Layer, method, exact input revision, expected threshold, actual result, finding severity/disposition, residual risk | `run_id`, task ID, reviewer assignment when independent | `artifacts/primary_validation.md`, `validation_layer2.md`, `validation_layer3.md`; supports replay and contradiction review |
| Output | Final receipt/score, decision counts, false blocks, limitations, branch/head, and artifact references | `run_id`, exact head, receipt correlation SHA-256, and proposal fingerprint when available | Task result and handoff; supports delivery audit |
| Change | Commit OID, parent, staged paths, diff-check result, task mapping, and rollback commit/range | `run_id`, task ID, commit OID | Git history plus `artifacts/final-diff.txt`; detects scope drift |
| Audit | Authorization boundary, external reads, skipped/missing tools, owner override proof, review disposition, push target/result | `run_id`, artifact/rule/fingerprint scope, owner identity from durable record | Manifest/receipt/handoff; proves no ambient bypass or unauthorized write |

Execution JSON records use this minimum shape; `trace_id` and `span_id` are omitted or explicitly
`not-instrumented` when no tracer exists and must never be fabricated:

```json
{
  "timestamp_utc": "2026-07-16T00:00:00Z",
  "run_id": "20260716T000000Z-a15b3d953",
  "service": "whatsoup-boundary-core",
  "env": "dev",
  "trace_id": "not-instrumented",
  "span_id": "not-instrumented",
  "event": "input|decision|execution|validation|output|change|audit",
  "action": "fingerprint|history|provenance|test|review|push",
  "result": "Pass|Fail|Inconclusive|Blocked",
  "inputs": {
    "git_sha": "a15b3d953589641c81fd8c228e34afeb1cba2d39",
    "changed_files_artifact": "artifacts/changed_files.txt"
  },
  "evidence": {
    "artifact_paths": ["artifacts/run_manifest.json"]
  },
  "error": {
    "type": "",
    "message": ""
  }
}
```

The following must never be silent: provider failure/truncation/cursor cycle/repository mismatch;
invalid canonical input; unresolved remote/head/merge base; stale tracking; disposition validation;
override acceptance/rejection; receipt-write failure; timeout/signal; skipped tool; test or typecheck
failure; score drift; independent-review disagreement; rollback; and push failure. Confidence-
affecting actions require manifest entries with evidence paths and the four-state verdict.

Never log secrets, tokens, credential-bearing remotes, raw comment bodies, full environment dumps,
private local paths from external artifacts, or unbounded exception/provider payloads. Keep only
bounded error type/message, sanitized repository identifiers, OIDs, rule IDs, artifact URLs, and
owner-authored disposition references. Tests inject secret-like sentinels and assert they are absent
from human, JSON, manifest, and snapshot output.

Instrumentation validation is behavioral: receipt tests assert every required field and ordering;
provider/provenance failure tests assert an observable inconclusive/block finding; manifest
validation checks command entries and evidence paths; final review compares fixture/rule inventory
to receipt snapshots. Any rule or failure branch lacking a receipt assertion is telemetry coverage
regression and `Fail`.

Local `artifacts/` evidence remains reviewable until the branch is merged or explicitly abandoned.
Before cleanup, durable results, limitations, and commit OIDs are copied into the tracked handoff.
The untracked evidence directory is not a confidentiality boundary or a long-term archive; sensitive
content is prohibited even when the path is ignored.

## Execution Readiness Gate

Readiness is decided from `artifacts/readiness.json`, not confidence language.

| State | Evidence threshold | Allowed next action |
|---|---|---|
| `Ready` | Every mandatory check below is direct/validated, no blockers, and no constraint affects execution evidence | Begin the next planned task |
| `Ready with Constraints` | No blocker; objective/scope/task graph are stable; every remaining risk is bounded by an inconclusive path, non-goal, or named checkpoint | Begin only the `next_allowed_action`; re-evaluate at each due checkpoint |
| `Not Ready` | Any critical assumption lacks containment, task order/contract is invalid, required authority is absent, or required evidence is missing/masked | No code or push; resolve blockers and regenerate the record |

The readiness record contains state, UTC date, evidence reviewed, open risks, blockers, decision
rationale, decision authority, and next allowed action. Residual risks name owner, due checkpoint,
containment, and what outcome becomes inconclusive if the risk materializes.

Mandatory checks before Task 0 and before each later task are:

- stable objective and bounded scope/non-goals;
- assumption audit with critical assumptions validated, replaced by fail-closed behavior, or due at
  the current task's first checkpoint;
- dependency graph with all imported contracts created earlier;
- verified repository/worktree/branch, tools, fixture inputs, and execution seams;
- decomposed task with exact RED/GREEN commands and artifact paths;
- primary/secondary/tertiary validation method appropriate to the task risk;
- sufficient receipt/manifest observability and anti-redaction tests;
- measurable success and failure thresholds;
- commit-scoped rollback/containment and no destructive Git operation;
- implementation/test/review owners and decision authority;
- documented residual risk and next permitted action.

Blockers include an unexpected branch/head, absent approved specification, uncontained critical
assumption, circular/forward dependency, missing fixture provenance, schema-breaking receipt change,
unavailable mandatory pinned toolchain, scope crossing into GitHub/network/workflow mutation,
missing required validation layer, or an unresolved high/critical reviewer finding.

The repository owner authorizes scope and external mutation; the implementation lead decides local
task readiness after checking evidence. A reviewer or worker may produce findings but cannot approve
their own unresolved high-risk output or broaden authority. CODEOWNERS is absent at the repository
root, so no ownership claim is inferred from that file. Existing workflows are inventory evidence,
not permission to change or rerun them. No active repository-native SCA command was found for this
tranche; dependency scanning is not reported as passing.

Current plan-review state is `Ready with Constraints`: Task 0 documentation is the only allowed next
action; the broad unbounded npm reconnaissance remains inconclusive and live provider/CI evidence is
deferred by scope. Those constraints do not authorize a clean provider or CI claim and are
re-evaluated before final push.

## Molecular Task Decomposition

Every numbered step below is an atomic work packet. Before execution, add its Task ID, Parent Task
ID, objective, preconditions, inputs, one action, expected output, observable signals, validation,
failure modes, retry, rollback, evidence, dependencies, and blocking conditions to the run manifest.
The task owner is the implementation lead unless the ID says `reviewer`.

Common rules:

- entry requires the preceding ID's `Pass`, exact branch/head, and no unexpected tracked change;
- the primary output is the named file set, test result, commit, or push receipt—never several
  unrelated outcomes;
- validation preserves the real exit and writes the named artifact;
- nonzero, signal, timeout, missing output, or unexpected diff is `Fail` or `Inconclusive` as defined
  by the execution contract;
- retry occurs only after diagnosing the failed assertion/command; do not rewrite expected behavior
  merely to make the test pass;
- rollback is the current task's uncommitted explicit-path patch, or a new revert of its isolated
  commit after commit; never use destructive Git commands;
- a task containing hidden judgment, unrelated outputs, unclear execution/validation mixing, or
  undetectable partial success must be split before it starts. The word “and” in an objective is a
  decomposition smell that requires review, although an atomic test matrix may contain multiple
  neighboring cases for one rule.

| Task ID | One action / primary output | Validation and threshold | Evidence | Dependency |
|---|---|---|---|---|
| T0.1 | Stage exact reviewed docs/inventory inputs | staged paths equal allowlist | `artifacts/t0-staged.txt` | readiness gate |
| T0.2 | Regenerate/validate doc inventories | all four doc commands and diff-check exit 0 | `artifacts/t0-validation.txt` | T0.1 |
| T0.3 | Commit documentation packet | one commit with exact five paths | `artifacts/t0-commit.txt` | T0.2 |
| T1.1 | Add failing canonicalization tests/fixture | expected module-missing failure only | `artifacts/task1-red.txt` | T0.3 |
| T1.2 | Implement common types/fingerprint module | requested exports exist; no adapter/network code | `artifacts/task1-diff.txt` | T1.1 |
| T1.3 | Validate fingerprint behavior | focused tests/typecheck exit 0 | `artifacts/task1-tests.txt` | T1.2 |
| T1.4 | Commit fingerprint unit | exact Task 1 paths in one commit | `artifacts/task1-commit.txt` | T1.3 |
| T2.1 | Add failing provider/type tests | expected missing-module failure only | `artifacts/task2-red.txt` | T1.4 |
| T2.2 | Implement history types/provider collector | no concrete network provider; incomplete paths fail closed | `artifacts/task2-diff.txt` | T2.1 |
| T2.3 | Validate provider behavior | focused tests/typecheck exit 0 | `artifacts/task2-tests.txt` | T2.2 |
| T2.4 | Commit provider unit | exact Task 2 paths in one commit | `artifacts/task2-commit.txt` | T2.3 |
| T3.1 | Add failing history/re-entry tests | expected missing-module failure only | `artifacts/task3-red.txt` | T2.4 |
| T3.2 | Implement exact-first history policy | exact rules precede/suppress weaker warnings | `artifacts/task3-diff.txt` | T3.1 |
| T3.3 | Validate history/re-entry behavior | focused tests/typecheck exit 0; all false-positive controls non-blocking | `artifacts/task3-tests.txt` | T3.2 |
| T3.4 | Commit history unit | exact Task 3 paths in one commit | `artifacts/task3-commit.txt` | T3.3 |
| T4.1 | Add failing provenance tests | expected missing-module failure only | `artifacts/task4-red.txt` | T3.4 |
| T4.2 | Implement ordered provenance policy | parity checked before overlap/disjoint decision | `artifacts/task4-diff.txt` | T4.1 |
| T4.3 | Validate provenance behavior | focused tests/typecheck exit 0 | `artifacts/task4-tests.txt` | T4.2 |
| T4.4 | Commit provenance unit | exact Task 4 paths in one commit | `artifacts/task4-commit.txt` | T4.3 |
| T5.1 | Add failing receipt/CLI feedback tests | expected assertions fail on old hard-coded language/types | `artifacts/task5-red.txt` | T4.4 |
| T5.2 | Generalize receipt compatibility adapter | existing semantic shape preserved; generic findings render | `artifacts/task5-receipt-diff.txt` | T5.1 |
| T5.3 | Split semantic unknown rule identities | each failure maps to one actual failed operation | `artifacts/task5-cli-diff.txt` | T5.2 |
| T5.4 | Validate receipt/CLI compatibility | focused tests plus script/all typechecks exit 0 | `artifacts/task5-tests.txt` | T5.3 |
| T5.5 | Commit receipt unit | exact Task 5 paths in one commit | `artifacts/task5-commit.txt` | T5.4 |
| T6.1 | Add failing evaluator-delegation proof | duplicate/local implementation is detected | `artifacts/task6-red.txt` | T5.5 |
| T6.2 | Replace evaluator history/provenance branches | production functions are sole implementation | `artifacts/task6-diff.txt` | T6.1 |
| T6.3 | Replay frozen/holdout corpus | exact 13/40, 40/40, 18/18 thresholds | `artifacts/evaluator-scores.txt` | T6.2 |
| T6.4 | Commit evaluator adapter | exact Task 6 paths in one commit | `artifacts/task6-commit.txt` | T6.3 |
| T7.1 | Run combined focused verification | every focused suite/typecheck exits 0 | `artifacts/focused-verification.txt` | T6.4 |
| T7.2 | Run changed-test integrity analysis | zero new/unexplained findings | `artifacts/test-integrity.txt` | T7.1 |
| T7.3 (`reviewer`) | Perform independent tertiary review | evidence-complete verdict; lead dispositions all findings | `artifacts/validation_layer3.md` | T7.2 |
| T7.4 | Update handoff/inventories | doc guards exit 0 and exact results are recorded | `artifacts/t7-docs.txt` | T7.3 |
| T7.5 | Commit validation record | exact Task 7 docs/inventories in one commit | `artifacts/task7-commit.txt` | T7.4 |
| T8.1 | Assert exact branch/head/remote/status | SSH origin, intended branch, only allowed untracked paths | `artifacts/final-status.txt` | T7.5 |
| T8.2 | Run complete branch gate | process exit 0; no mask/signal/timeout | `artifacts/branch-gate.txt` | T8.1 |
| T8.3 | Audit final diff/history/authorship | diff-check exit 0; no prohibited attribution/scope path | `artifacts/final-diff.txt` | T8.2 |
| T8.4 | Push exact verified head | SSH push exit 0 and remote head equals verified head | `artifacts/push-receipt.txt` | T8.3 |

If a row produces more than its primary output or requires an unlisted choice, stop and add a new
row. A partial artifact never satisfies the dependency of the next row.

## Verification Design

`artifacts/verification_matrix.md` contains one row for every molecular Task ID and transition. Each
row names what is checked, why, the exact command/inspection, checker, expected output, evidence
path, `Pass`/`Fail`/`Inconclusive` conditions, and escalation. Update the row with the actual result
before its dependent task begins.

Verification attaches to the claim-producing task:

- deterministic assertions prove canonical and policy behavior;
- schema/type checks prove contract shape;
- state inspection proves repository, branch, remote, cursor, and artifact completeness;
- diffs/checksums prove exact changed content and visible-example identity;
- replay proves frozen evaluator and provider behavior;
- independent evidence-linked review probes ambiguity, bypass, leakage, and duplicate logic.

Prefer native JSON, structured receipt snapshots, normalized score summaries, and machine-readable
manifest entries. When a command has only text output, preserve full bounded output and a separate
exit/verdict record pointing to it. Never use a pipeline that loses the producer exit.

Reject “looks correct,” narrative-only validation, intuition as sole proof, unsupported completion,
tests without thresholds, or a worker/reviewer recommendation without decisive evidence. A missing
artifact, stale head, masked exit, non-deterministic result, or unexplained mismatch is
`Inconclusive`; escalation is focused reproduction, then lead review, then `Blocked` if decisive
evidence remains unavailable.

The matrix and run manifest must agree on task verdict, command, head, and artifact. A discrepancy
is `Fail`. Task 8 may begin only when every T0–T7 row is `Pass`; push may occur only after T8.1–T8.3
are `Pass`.

## Testing and Test-Data Provenance

Tests measure behavior and evidence quality, not the presence of a file or absence of an exception.
Each fixture family records input source, provenance type (`synthetic`, `sampled`, `captured`, or
`production-derived`), representativeness, expected-result derivation, evidence path under
`artifacts/test_evidence/`, and an exact replay command.

TDD is mandatory for every behavior-bearing change in Tasks 1–6, including error language,
compatibility behavior, and evaluator delegation. A real RED phase is a focused test that executes
the intended public seam and fails for the named missing/incorrect behavior, not a syntax error,
missing unrelated dependency, fixture typo, broad-suite timeout, or assertion deliberately made
impossible. Before production edits, preserve the command, tested head, nonzero producer exit, and
the relevant failing assertion under `artifacts/test_evidence/task-N-red.*`; inspect it to confirm the
failure reason. A test already green before implementation is either a regression lock or an invalid
RED and must be relabeled before proceeding. GREEN reruns the identical focused command and preserves
zero producer exit under `task-N-green.*`; then typecheck and the applicable combined suite run.

Determinism comes from pure inputs, fixed clocks, explicit promise control, stable sort/serialization,
bounded page/count limits, isolated Vitest forks, exact OIDs, and per-case expected results. No test
may depend on wall-clock sleeps, network availability, live GitHub state, unordered object traversal,
ambient environment, or current branch contents without recording them as inputs. Remaining
nondeterminism is limited to tool duration and OS scheduling; it must not affect assertions. If it
does, the run is `Inconclusive`, not retry-until-green.

| Test family | Source and provenance | Expected-result derivation | Counterexample / negative control | Deterministic, contract, mutation, and replay lane |
| --- | --- | --- | --- | --- |
| Fingerprint/path/OID | Synthetic closed tables plus production-derived #1838/#1848 OIDs/blobs/patch ID from immutable API/Git captures | SBH canonicalization contract written before implementation | Rename/delete, separator, traversal, case, duplicate, one-field neighbor, and record-order permutations | Exact canonical bytes/SHA-256; schema/typecheck; repeated/permuted replay; mutation of any decisive field must change expected digest |
| Provider collection | Synthetic page callbacks modeled from bounded GitHub response fields; no raw comments | Completeness/repository/pagination invariants | Throw, timeout category, truncation, cursor loop, duplicate/conflict, wrong repo, cap boundary, deferred/rejected promise | Fixed page sequence/counters; provider contract tests; async negative controls; replay from sanitized page fixture |
| History/disposition/re-entry | Production-derived #1838/#1848/#1857 facts plus synthetic collision controls | Approved block/warn/no-finding matrix and durable disposition rules | Title/branch/path-only similarity, exact merged, subset/superset, cosmetic vs material re-entry, override scope/expiry | Fixed clock and exact artifact identities; receipt schema; decision-table mutation; replay case by case |
| Upstream provenance | Synthetic OID/path observations representing current, ahead, mismatched, stale disjoint/overlap/high-coupling, and missing-base states | Ordered fail-closed policy in Task 4 | A later disjoint fact cannot override earlier tracking mismatch; malformed counts/times/OIDs | Pure ordered evaluator; exhaustive decision table/typecheck; order-mutation negative control; replay exact observations |
| Receipt and semantic CLI | Existing receipt tests plus synthetic fault injection for each failed operation | Existing schema v1 compatibility and named situational language contract | Secret sentinel, missing feedback field, unknown argument, write-stage failure, unreadable policy explicitly rejecting reachability text | Human/JSON parity snapshots; completeness/schema/typecheck; delete-field negative control; exact CLI replay |
| Evaluator/regression corpus | Locked `cases.json` and `holdout.json`, with provenance already recorded in mining handoff | Pre-implementation labels: 13/40 baseline, 40/40 candidate, 18/18 holdout, zero false blocks | Case-result swap preserving totals, duplicate implementation, legitimate reuse/material re-entry | Per-case plus aggregate assertions; import/delegation contract; production-function mutation reaches evaluator; pinned replay |

Independent contradiction validation is required after Tasks 3, 5, and 6 and before final push:
another reviewer/replay lane attempts to falsify canonical equivalence, fail-closed ordering, receipt
compatibility/redaction, and absence of duplicate evaluator logic. The lead then verifies the exact
source, diff, test output, or receipt behind every decisive claim. Disagreement remains
`Inconclusive` until a reproducing fixture resolves it; reviewer consensus alone is not validation.

| Category | PR B responsibility | Required false-confidence control |
|---|---|---|
| Unit | Canonical path/OID/task hashing; page collection; history/re-entry; provenance; rendering | Neighboring input changes one decisive field and changes only the expected rule |
| Integration | History/provider findings enter generic receipt; semantic adapter stays compatible; evaluator calls production core | A complete lower layer with an incomplete upstream layer remains inconclusive |
| End-to-end | Sanitized proposal/page/re-entry/provenance input flows through pure core to human and JSON receipt/evaluator score | No live GitHub/network claim; adapter absence is explicit |
| Negative | Malformed path/OID/time/cursor/artifact/override/policy/head/write inputs | Unsafe input must cause the exact fail-closed rule, not a generic success/error |
| Regression | #1838/#1848 exact recreation, #1857 cosmetic re-entry, historical policy-unavailable language | Exact rule/artifact/correction snapshot, not decision-only assertion |
| Observability | Every non-pass branch emits complete bounded feedback and no secret sentinel | Remove one required field and prove completeness validation fails |
| Adversarial | Cursor cycles, repository swaps, conflicting duplicates, rename patch, wrong-scope override, title/branch/path-only collisions | Legitimate shared refactor/material re-entry remains non-blocking |
| Stale data | tracking mismatch, older base, stale observation timestamp, wrong repository | Stale evidence cannot authorize downstream clean comparison |
| Partial data | truncated pages, missing path/blob/patch evidence, missing merge base/paths | Partial collection returns inconclusive even when retained artifacts look clean |
| Degradation | provider throw/abort/timeout, analysis failure, receipt-write failure | Exact failed operation appears in rule/language and enforce exit is nonzero |

Fixture provenance is recorded in `artifacts/test_evidence/provenance.md` and the tracked mining
handoff. Production-derived fixtures contain only OIDs, paths, states, timestamps, URLs, disposition
categories/references, and delta classification verified against immutable Git/API evidence. Raw
comments, credentials, private paths, and copied user text are prohibited. Synthetic fixtures name
the policy clause that establishes the expected result; sampled cases name selection criteria and
cannot be relabeled after implementation without a documented policy decision.

Expected results come from the approved SBH requirements and the pre-implementation locked corpus,
not from current implementation output. When a new adversarial case is added, write its expected
rule/decision/rationale before changing production code. Hash or snapshot test evidence with the
exact Git head in the run manifest when supported; signatures/attestations are `not applicable` for
unpublished local artifacts and must not be implied.

Anti-fabrication controls require preserved RED and GREEN exits, immutable fixture provenance,
assertions over full intervention meaning, exact score counts, changed-test integrity analysis,
independent replay, and lead inspection of decisive artifacts. No “green,” empty output, missing
finding, or process survival is a verdict. Only `Pass`, `Fail`, `Inconclusive`, or `Blocked` is
accepted.

Replay uses pinned Node/npm commands from the task sections and writes bounded output plus exit to
`artifacts/test_evidence/`. Replaying from another head is a different observation. A flaky,
non-deterministic, timed-out, killed, skipped, or masked run is inconclusive until the exact input is
reproduced deterministically.

Deep validation for this tranche consists of closed-schema/property tables, contract/type checks,
contradiction checks, provider/failure injection, frozen replay, and independent review. Mutation
testing is deferred unless an existing repository lane supports the changed modules; absence is
recorded as `not applicable`, not coverage. Live contract/E2E provider testing and supply-chain
attestation belong to later adapters and remain `skipped` by scope.

`artifacts/test_strategy.md` is the test-family ledger and `artifacts/test_evidence/provenance.md`
records every fixture/capture. Each Task 1–6 commit requires its RED/GREEN artifact pair and tested
head; final replay artifacts live under `artifacts/test_evidence/`. A missing, stale, or mismatched
artifact blocks the dependent task even if a later broad suite is green.

## Final Review and Handoff

The single-source handoff package is this plan, the approved specification, and
`docs/superpowers/handoffs/2026-07-16-boundary-core-history-mining.md`. Before Task 8, the tracked
handoff must summarize the objective/scope/non-goals, assumption dispositions, validation findings,
readiness decision, task/commit map, verification results, receipt/observability contract, test-data
provenance, anti-fabrication controls, execution order, open risks/blockers, and commit-scoped
rollback/containment.

A fresh operator begins only when:

- the checkout is the linked worktree on `experiment/jul16-boundary-core-history` at the exact
  documented head and the origin URL is SSH;
- the approved specification and Task 0 documentation commit exist;
- unexpected tracked or untracked files are absent; the documented experiment log and local
  `artifacts/` are the only allowed untracked/ignored evidence;
- Node `24.15.0`, npm `11.12.1`, TypeScript `5.9.3`, and Vitest `4.1.8` are observed through pinned
  wrappers; Git and `loadgate` are available or their absence is recorded;
- `artifacts/run_manifest.json`, `readiness.json`, `primary_validation.md`, and
  `verification_matrix.md` are regenerated for the fresh run rather than assumed current.

### Reproduce this run

From the repository root, record the output/exit of:

```bash
git rev-parse --show-toplevel
git rev-parse HEAD
git status --short --branch
git remote -v
node --version
bash scripts/run-with-pinned-node.sh --version
bash scripts/run-with-pinned-npm.sh --version
```

Then execute Task 0 and the T1–T8 molecular rows in dependency order. Use each task's exact command;
do not substitute the unbounded broad npm reconnaissance. Expected evidence includes run identity,
Git state, tools, staged paths, RED/GREEN output, diffs, commits, fixture provenance, evaluator
scores, three validation layers, test integrity, doc guards, complete branch gate, final audit, and
SSH push identity under the artifact paths in the verification matrix.

The local `artifacts/` directory is not transported by Git. A new operator regenerates evidence
against their exact head; the tracked handoff supplies prior durable results and limitations for
comparison. A result from another head, runtime, or provider observation is separate evidence.

This is not a release or dependency tranche. SBOM generation, artifact signing, build provenance,
and supply-chain attestation are `not applicable` to PR B and must not be claimed. If a dependency,
workflow, image, Action pin, published package, or release artifact enters the diff, scope validation
fails and a release/supply-chain plan is required.

Final review checks every item below and records evidence or a blocker:

- no missing/forward dependency or unresolved critical assumption;
- no weak, narrative-only, decision-only, unbounded, or masked verification;
- no vague readiness, hidden operator judgment, or oversized task;
- all non-pass branches have sufficient telemetry and complete contextual feedback;
- every production-derived fixture has provenance and replay instructions;
- no unsupported claim about CI, live provider, external producer, supply chain, or PR #1835;
- no prohibited attribution, secret, raw comment body, unauthorized mutation, or non-goal path;
- exact rollback/containment exists for every commit and the push is bound to the verified head.

Any missing item is `Fail` or `Inconclusive`; unresolved high/critical risk is `Blocked`. Completion
requires the final handoff, matrix, manifest, and Git state to agree.

## Master Orchestrator

The implementation lead owns decomposition, permissions, integration, evidence, and final claims.
Execute one molecular task at a time in this order; no phase starts from narrative confidence:

1. **Bootstrap:** assert repo/worktree/branch/head/SSH remote; initialize run manifest; evaluate
   readiness.
2. **Documentation gate:** T0.1–T0.3. Stop unless the specification, mining handoff, plan,
   publication audit, and work index are committed together.
3. **Pure leaves:** T1.1–T2.4. Establish common types, canonical fingerprints, history types, and
   bounded provider collection.
4. **Policy core:** T3.1–T4.4. Establish exact-first history/re-entry and ordered provenance.
5. **Feedback compatibility:** T5.1–T5.5. Generalize receipts and correct situational semantic
   unknowns without breaking PR A.
6. **Single-engine integration:** T6.1–T6.4. Remove experiment duplication and replay locked scores.
7. **Promotion evidence:** T7.1–T7.5. Run combined verification, integrity, independent review,
   handoff/inventory update, and commit the record.
8. **Delivery:** T8.1–T8.4. Bind the full gate and final audit to one head, then push that exact head
   over SSH.

At each transition, read the verification-matrix row and run-manifest predecessor. Continue only on
`Pass`. `Fail` returns to the producing task after diagnosis; `Inconclusive` invokes the row's
escalation and cannot advance a trust boundary; `Blocked` stops the run until the named authority or
evidence changes.

No task is delegated unless it is independent, read-only or owns non-overlapping paths, and carries
a bounded work packet with exact head, outcome, inputs, allowed mutations, validation, timeout, stop
conditions, and result contract. Worker output is advisory until lead verification. Parallelism is
not used across the provider→history, common-types→policy, receipt→evaluator, or verification→push
dependency edges.

After every commit, record OID/parent/paths and re-evaluate unexpected worktree drift. After any
scope, policy, interface, or expected-score change, return to Objective, Assumption Audit, Primary
Validation, Readiness, and Verification Design before resuming. After any masked, killed, timed-out,
or missing command, record `Inconclusive`; never substitute a later unrelated green command.

The run is complete only when all matrix rows are `Pass`, three validation layers agree, the tracked
handoff contains exact evidence/limitations, the branch gate is unmasked zero, and the remote branch
OID equals the verified local head. The orchestrator does not create a PR/issue/comment or mutate a
workflow/ruleset/external producer.

## Tooling, Runtime, and Execution Orchestration

The lead owns decomposition, permissions, integration, Git state, decisive-source verification, and
all final claims. Tool availability does not authorize mutation. `artifacts/tooling_plan.md` records
the selected tool/runtime, task, write scope, evidence contract, observed version/receipt, and why any
parallel or delegated lane is safe.

### Required local toolchain

- `git` over the existing SSH remote for branch/diff/history/OID verification; `rg`/`rg --files` for
  reuse, caller, duplicate, and scope searches; shell only for bounded commands with producer exit
  preserved.
- Repository wrappers `scripts/run-with-pinned-node.sh` and `scripts/run-with-pinned-npm.sh` for
  exact runtime selection, Vitest focused/combined lanes, typecheck, work-index, publication, and
  branch gates. Record requested and observed versions separately.
- `apply_patch` for edits. Never use destructive cleanup. Stage exact paths, and use exact `git add
  -f` only for the two ignored planning documents named by Task 0.
- Python structured-review helpers are review-only and produce ignored `artifacts/`; they are not
  product runtime dependencies. Optional scanners absent from the host remain explicitly skipped.

### Skills and runtime realms

The current agent runtime uses planning, hypothesis, TDD, test-integrity, fail-closed gate,
deduplication, verification, and WhatSoup PR-review procedures as their trigger points require. The
lead must read each selected skill before its action and record procedure-driven pauses or constraints.

The alternate plugin-runtime realm is reachable only through the documented tmup dispatch surface;
it is not silently invoked from the current runtime. No alternate-realm plugin is required for this
bounded TypeScript tranche, and no cross-runtime process lane is planned. If later requested, tmup
must use the live runtime catalog, a bounded self-contained packet, leaf status, explicit
permissions/write scope, watchdog/timeout, dedupe key, and result contract; output remains advisory
until lead verification.

GitHub community/API/CLI reads were used only for the mined evidence captured in the handoff. PR B
adds no GitHub adapter and performs no external write. Playwright, Sentry, Render, Pinecone, Google
Workspace, fleet, and other MCPs/plugins are not applicable: there is no browser/UI, runtime error
service, deploy, semantic-doc lookup need, workspace mutation, or live fleet operation in scope. They
must not be used as substitute evidence. If scope expands onto one of those surfaces, readiness
returns to `Fail` pending a new permission and validation plan.

### Delegation and parallelism policy

Implementation Tasks 0–6 remain lead-owned and sequential because their contracts/types, RED/GREEN
evidence, receipt compatibility, and evaluator extraction form a dependency chain in one worktree.
Parallel write lanes would create overlap and weaken proof of which change made a test green, so they
are not justified. Read-only independent review/replay after Tasks 3, 5, and 6 is safely parallelizable
because each lane gets an exact commit/head, immutable fixture set, distinct attack surface, no write
authority, a lease/dedupe key, bounded timeout, and required evidence record. The two completed PR
#1835 reviewers were such read-only lanes; their claims remain advisory and the lead already checked
the decisive current source.

No worker may delegate further. A work packet must contain outcome, inputs/head, allowed paths and
mutations (`none` for review), commands/tools, acceptance thresholds, timeout/stop conditions,
artifact destination, and result fields: status, sources/files inspected, evidence, validation,
confidence, risks, and lead-verification claims. One owner and dedupe key exist per lane; quiet work
is not duplicated before terminal failure or lease expiry. Any malformed, progress-only, stale,
masked, or unverified result is `Inconclusive`.

Parallel deterministic validation uses immutable commit OIDs and independent artifact paths; no lane
shares a mutable fixture/output file. The lead replays the decisive command on the integration head,
compares head/input hashes, resolves contradictions, and alone updates the verification matrix. If a
reviewer needs a code change, it reports a reproducer and proposed paths; the lead writes the RED and
implementation sequentially.

## Existing Surface and Reuse-First Audit

Before creating any file or exported function, update `artifacts/reuse_audit.md` with the search
query, inspected path, candidate surface, reuse decision, reason, and duplication risk. Code/docs/
test searches are mandatory; `artifacts/reuse_scan.txt` and `artifacts/reuse_targeted.txt` preserve
the broad and targeted inventories.

| Need | Existing candidate | Decision and constraint |
|---|---|---|
| Content canonicalization | `contentFingerprint()` in `scripts/experiments/semantic-boundary-eval.ts` | Extract behavior into production `fingerprint.ts`; evaluator imports it. Do not retain a wrapper with parallel logic. |
| Decision/finding types and aggregation | `BoundaryDecision`, `BoundaryFinding`, `aggregateBoundaryDecision()` in `receipt.ts` | Extract only dependency-leaf types to `boundary-types.ts`; keep aggregation in receipt and re-export compatible names. |
| Complete feedback validation | `isBoundaryFindingComplete()` in `receipt.ts` | Reuse and expand tests; do not add history-specific completeness logic. |
| Human/JSON receipt and atomic local write | `receipt.ts`, `writeSemanticReceipt()`, `writeLocalReceipt()` | Extend additively; do not create a second renderer or writer. |
| Exact committed Git trees | `git-tree.ts` plus `cleanGitEnv()` | Keep as future adapter foundation; PR B pure provider inputs do not shell out. |
| Experiment cases | locked `cases.json`, `holdout.json`, evaluator scoring | Reuse as regression oracle; add sanitized boundary fixture only for provider/disposition detail absent from the corpus. |
| History/provenance decisions | experiment-only branches | Extract into production policy functions; remove those branches from evaluator. |
| Read-only GitHub pagination | no repository PR-history provider found | Create interface/collector only. Existing product pagination is domain-specific and is not reused for GitHub evidence. |
| Path normalization | domain-specific filesystem/workspace helpers | Reject reuse because those helpers resolve host files, symlinks, or user paths; fingerprint paths require pure case-sensitive repo-relative POSIX validation. |
| Supply-chain pins | experiment branch and workflow/Docker inventories | Do not extract in PR B; separate baseline migration avoids speculative coupling. |

Reuse is rejected only with an inspected-path and contract mismatch. “Cleaner,” “new,” or naming
preference is not justification. If an existing helper supplies at least the same semantics without
pulling a higher layer into a leaf, extend it and add a regression test. If reuse creates a circular
dependency or mixes filesystem/network state into a pure function, extract the smallest stable type
or primitive downward.

DRY review runs after every task: search the changed concepts/functions, compare evaluator and
production branches, and inspect tests for copied builders/expected-language tables. A new
abstraction requires at least two current consumers or a specification-mandated adapter seam; do not
invent a registry/factory/plugin layer for hypothetical providers. Duplicate or speculative logic is
`Fail` and blocks the task commit.

## Impact Analysis and Blast Radius

PR B is deliberately bounded to a deterministic TypeScript library, its tests, the existing semantic
receipt/CLI path, and the local evaluator. It does not add a GitHub client, network call, hook,
workflow, package-script composition, fleet/MCP/HTTP route, database record, queue, scheduled job, or
deployment mutation.

| Consumer or boundary | Expected effect | Decisive validation | Rollback / containment | Risk |
| --- | --- | --- | --- | --- |
| New fingerprint, history-provider, history-policy, and provenance modules | Pure exported functions become available to tests and the evaluator; no runtime service imports them | Focused unit tests, script typecheck, repository-wide typecheck, duplicate-implementation review | Revert the owning task commit; modules are inert until imported | Canonicalization ambiguity, incomplete provider evidence, or ordering could produce a false block/pass |
| `scripts/lib/semantic-quality/receipt.ts` and `policy.ts` | Receipt vocabulary becomes additive and generic while the existing semantic compatibility adapter remains | Existing and new receipt snapshots/assertions plus schema-version and one-line pass compatibility tests | Revert Task 5; no persisted schema migration is required | Consumers could depend on exact text or optional-field omission |
| `scripts/semantic-quality-check.ts` | Existing shadow semantic command reports the actual failed operation instead of mislabeling every unknown as production reachability | CLI fault-injection tests for candidate, policy, source-tree, analysis, invocation, and receipt-write failures | Revert Task 5 to restore prior shadow output | Situational feedback changes immediately for current local/CI callers even though enforcement mode remains unchanged |
| `scripts/experiments/semantic-boundary-eval.ts` | Frozen and holdout fixtures delegate fingerprint/history/provenance decisions to the production core | Delegation/anti-duplication tests and exact 13/40, 40/40, and 18/18 score receipts | Revert Task 6; production core remains independently testable | Adapter mistakes could preserve apparent totals while misclassifying individual cases, so per-case assertions remain required |
| Changed tests and sanitized fixtures | Add fault, boundary, false-positive, re-entry, and pagination coverage without live GitHub data | Focused Vitest lanes and test-integrity review | Revert the corresponding test task | Sanitized fixtures can omit a decisive live-field nuance; this limitation remains explicit |
| Documentation and work index | Record provenance, implementation contract, validation, and known limitations | Publication/work-index/doc-tally guards | Revert documentation commits and regenerate the index | Ignored plan/handoff paths require exact `git add -f`; broad force-add is forbidden |

### Public interfaces and compatibility

The changed interfaces are repository-local TypeScript exports and the existing semantic receipt
output. There is no user-facing fleet, MCP, HTTP, database, or deployment API change. Receipt schema
version 1 remains unchanged; new fields are optional/additive, and the semantic adapter preserves its
current invocation/action values and concise pass line. Any required-field addition, version bump, or
text regression outside the named situational failures stops the task.

### State, permissions, and external coordination

There is no data migration, backfill, job, queue, or scheduled task. History and provenance inputs are
caller-supplied observations; this tranche neither accepts a GitHub token nor contacts GitHub. A
future read-only GitHub/remote-tip adapter is explicitly deferred. No issue, PR, comment, review,
workflow run, ruleset, or required context is created or changed. PR A is the stacked base for this
branch; PR #1835 is an independently reviewed source of future fault-injection candidates and is not
modified by this tranche.

### Partial-change and rollback hazards

Every task must typecheck before its commit. Tasks 1–4 are inert library slices until imported, but a
partial type/interface change can still break script compilation. Task 5 changes a currently invoked
shadow command and must land atomically with its compatibility and fault-injection tests. Task 6 must
not remove the evaluator's previous implementation until delegation tests are RED and the frozen
case-by-case outcome is reproduced. Rollback is task-commit reversion; there is no external or
irreversible state to unwind. A killed, timed-out, skipped, or masked validation leaves the affected
surface inconclusive rather than deployable.

### Observability and operational visibility

Human and JSON receipts remain the primary observable output, supplemented by local focused-test,
score, and review artifacts recorded in the handoff. This tranche changes no dashboard, metric,
alert, logger, or production telemetry. Consequently, a live adapter or enforcement integration
cannot be claimed validated from these pure-core results.

## Error and Exception Model

The core uses explicit findings and typed provider results for expected boundary failures. It throws
only for programmer/contract errors that cannot be represented safely. No caught exception may be
converted to `pass`, and no partial provider result may be treated as complete. Every failure test
must preserve the rule identity, observed evidence, reason, correction, rerun command, source, and
whether the state is retryable.

| Error class | Detection | Handling and retry | User-visible behavior | Operator-visible evidence | Containment / escalation |
| --- | --- | --- | --- | --- | --- |
| Validation or contract failure | Schema/type guards reject an OID, path, duplicate canonical record, disposition, timestamp, count, repository identity, cursor, or provider artifact | Deterministic local input defects return `block` when the action itself is unsafe or `inconclusive` when evidence cannot support a decision; retry only after correcting the named input | Situational finding names the invalid field/value class without echoing secrets or full comment bodies | JSON receipt plus focused test/log under `artifacts/`; no stack-only diagnosis | Stop the action; do not evaluate lower-priority evidence or accept an override that does not scope the exact rule/artifact |
| Dependency/tool failure | Pinned npm/node wrapper, typechecker, test runner, scanner, or git command exits nonzero, is absent, or produces malformed output | No automatic semantic retry; one bounded rerun is allowed only for a documented transient. Missing optional tools are `Inconclusive`, not substituted by a weaker green lane | Validation summary names the failed command class and says the tranche is not verified | Command, exit status, duration, and stderr/stdout artifact with secrets redacted | Stop the owning task commit; escalate persistent toolchain failure in the handoff |
| Provider/network failure | Provider callback throws, returns an error, repository mismatch, incomplete artifact, pagination truncation, cursor loop, or malformed next cursor | Collector returns `inconclusive`; a future adapter may perform bounded backoff outside the pure core, but PR B performs no network retry | Receipt says which history/provenance evidence is unavailable and gives the exact rerun | Provider summary records pages/items/cursor/repository/completeness and sanitized error category | No duplicate/history `pass`; caller must retry with a complete observation or stop |
| Timeout or cancellation | External watchdog/test runner reports timeout, signal, kill, or cancellation; provider input may explicitly report timeout | Never infer the producer exit from a pipeline. Do not retry an unbounded command. One bounded retry requires an idempotent read and a fresh artifact | Mark the affected check `Inconclusive` with elapsed time and retry guidance | Preserve watchdog/exit receipt and whether the process group was reaped | Stop commit/push for the affected surface; timeout cannot be overridden into pass |
| Idempotency/collision failure | Repeated canonical input yields a different digest/finding, duplicate canonical records appear, cursor repeats, or disposition/override identifiers collide | Reject ambiguous duplicates; deterministic re-evaluation of identical complete input must be byte-stable except explicitly time-derived expiry state | Name the collision or nondeterministic field and require canonical input repair | Record both sanitized inputs/digests and deterministic-clock fixture | Block unsafe action; do not silently choose first/last record |
| Receipt persistence failure | Atomic local receipt writer cannot create, fsync/close, or rename the durable file | Preserve the computed decision in memory but emit `semantic.receipt-write-failed`; retry only to a validated local path and never claim durable success | Explicitly state that analysis completed but its evidence was not durably written | stderr plus target path class and write stage, never file contents containing secrets | Stop boundary action when a durable receipt is required; clean only owned temporary files |
| Partial-success state | Some pages/artifacts/commits are complete but any required page, blob identity, patch ID, merge base, remote tip, or disposition field is missing | Return `inconclusive` for the whole dependent decision. Independent complete findings may remain visible but cannot upgrade the aggregate | Human/JSON output separates observed complete facts from the missing decisive evidence | Completeness flags and counts in receipt/artifact | No dead-letter queue applies; quarantine the observation as unusable input until recollected |
| Rollback or cleanup failure | Task reversion, owned temporary-file removal, or branch-state restoration fails/nonzero | Stop further implementation/push; preserve the worktree and evidence. Never use destructive cleanup commands | State that rollback is incomplete and name the remaining path/commit boundary | Status, diff, failed command, and last known-good OID under `artifacts/` | Escalate for owner review; do not layer new changes over unknown rollback state |
| Internal/programmer exception | Unexpected throw reaches the CLI/evaluator boundary or violates an exhaustiveness assertion | Convert at the outer boundary to the correct `analysis-unavailable`/validation `Inconclusive` receipt; retain sanitized stack locally; never retry blindly | Situational error with rerun and source, without internal secrets | Sanitized exception type/stack and reproducing fixture | Stop the task; add a RED regression before correction |

There is no queue or dead-letter service in scope. The equivalent quarantine is an explicit
`inconclusive` observation that is excluded from pass/block inference until a complete replacement is
collected. Overrides may only acknowledge policy findings that their schema expressly permits; they
cannot suppress dependency, timeout, provider-completeness, receipt-write, or rollback failures.

The implementation run maintains `artifacts/error_model.md` as the executed matrix: each row records
the test/command, observed exit or finding, receipt path, retry taken (if any), and final disposition.
The final handoff links that artifact and calls out every row not proven by a deterministic test.

## Silent Failure and Misleading-Success Audit

Silent failure is a release-blocking defect for this tranche. A pass requires affirmative complete
evidence; absence of a finding, exception, page, artifact, changed path, or command output is never
interpreted as success. The implementation maintains `artifacts/silent_failure_matrix.md` with the
actual detector, telemetry/receipt, audit trail, negative-control test, and result for every row.

| Failure mode | Deterministic detection | Proof / audit trail | Prevention of false success |
| --- | --- | --- | --- |
| Swallowed exception | Inject provider, analyzer, and receipt-writer throws; assert the exact unavailable/write-failed finding and non-pass aggregate | JSON receipt and focused fault-injection test output; sanitized exception category in local artifact | Outer boundaries must convert throws to explicit findings; an empty finding list after a throw fails the test |
| No-op fallback | Force missing policy/source/candidate and assert distinct rule identities; mutation/spy verifies the intended branch executed | Per-scenario receipt plus branch/delegation assertion | Generic production-reachability fallback is forbidden; default/pass fallback requires complete evidence |
| Partial provider success | Supply one missing page/artifact/blob/patch/base/tip/disposition field and mismatched counts | Provider observation records complete/page/item/cursor counts and the dependent `inconclusive` finding | Any required `complete !== true` or count mismatch short-circuits before history/provenance pass inference |
| Stale or cached success | Use local tracking OID different from observed remote tip; use stale prior receipt/fingerprint with current candidate | Receipt carries current candidate/base/remote/tracking fingerprints and timestamps; test fixes the clock | Tracking mismatch blocks; a previous receipt cannot be reused unless its full identity tuple matches current input |
| Dropped async work | Provider collector awaits every page callback; tests use deferred/rejecting promises and assert no result before settlement | Page-call trace and test completion assertion | No fire-and-forget work exists; unresolved/rejected page work cannot yield `complete: true` |
| Mismatched health signals | Compare focused suites, typecheck, evaluator per-case outcomes, aggregate scores, work-index guards, and final branch gate | Verification matrix records each independent layer, command, exit, duration, and artifact | One green layer cannot override another fail/inconclusive layer; final verdict is the least-safe unresolved state |
| Missing alert or visibility | Verify every non-pass finding renders both human and JSON reason/correction/rerun/source, and final handoff enumerates inconclusive rows | Receipt parity tests and handoff limitation section | No production alerting is in scope, so lack of a dashboard is explicit; local receipt/handoff is mandatory and cannot be called an operational alert |
| Success without validation | Inject skipped/killed/timed-out/masked commands and assert readiness/final matrices remain non-pass | Watchdog/exit receipts and manifest status | Pipeline status without producer status is inconclusive; zero findings without completeness evidence is inconclusive |
| Aggregate-score camouflage | Swap two per-case classifications while preserving total score in a negative-control fixture | Per-case expected decision/rule assertions plus aggregate score output | Exact totals are necessary but insufficient; every frozen and holdout case must retain its expected result |
| Duplicate implementation drift | Search/spy verifies evaluator calls production canonicalization/history/provenance exports; mutation changes production behavior and reaches evaluator tests | Reuse audit, symbol search, and delegation test output | A second normalizer or decision tree is a review failure even when both implementations currently agree |

Because PR B adds no production monitoring surface, “alert” means the deterministic boundary receipt,
test failure, run-manifest verdict, and durable handoff entry. A future hook/workflow/provider adapter
must separately define delivery/SLO alerting. Until then, this plan must not describe local receipts
as proof that a live agent received or acted on feedback.

## Error Messaging and Traceability

Every non-pass path must be diagnosable from its receipt and linked local evidence without guessing
which operation failed. Vague text (`something went wrong`, `failed`, `unknown error`), empty catches,
random IDs with no lookup surface, and diagnostics without an operator action are test/review
failures.

The stable external error code is the finding `ruleId`. The correlation handle is a deterministic
SHA-256 over the safe receipt tuple (repository, invocation, action, base identities, sorted
fingerprints, and sorted finding rule IDs), so candidate-unavailable paths remain traceable without
inventing a proposal identity. The run-manifest `run_id` plus command sequence correlates local
execution failures. `trace_id`/`span_id` appear only when an actual tracer produced them; otherwise
they are omitted or `not-instrumented`, never synthesized. Intervention human output prints a short
receipt-correlation handle; JSON preserves the full digest. The existing concise semantic pass line
does not change.

Each failure message/receipt must provide:

1. **What and where:** failed operation (`candidate-read`, `policy-parse`, `source-tree`, `analysis`,
   `history-page`, `provenance`, `receipt-write`, `validation`, or `push`) and safe component/stage.
2. **Impact:** `warn`, `block`, or `inconclusive`, the boundary action affected, and whether any
   independent evidence remains usable.
3. **Correlation:** rule ID, proposal fingerprint or `run_id`/command sequence, and matched artifact
   ID/URL when public and relevant.
4. **Remediation:** a concrete correction plus exact safe rerun command; non-retryable validation
   defects say which input class must change.
5. **Audience:** concise user/agent text in the human receipt; bounded operator detail in JSON/local
   artifacts. Stack traces and provider payload categories remain local and sanitized.
6. **Evidence:** product receipts use repository-relative source references, public artifact URLs,
   and exact safe Git OIDs; implementation/operator diagnostics additionally link artifact-relative
   paths under `artifacts/`. A local absolute path must not be copied into external/public output.

Redaction removes tokens, credential-bearing remote URLs, query strings, raw comment bodies, full
environment dumps, owner emails, and secret-like sentinel values. Provider messages are bounded and
classified; they are not passed through verbatim. Repository, public artifact number/URL, rule ID,
Git OID, stable patch ID, SHA-256 proposal fingerprint, canonical repo-relative path, page/count, and
sanitized exception type are allowed. Tests inject secret-looking strings into every external error
source and assert absence from both renderers and evidence summaries.

`artifacts/error_catalog.md` is the implementation ledger for error classes, stable codes, stage,
audience, required message fields, correlation lookup, redaction, remediation, test, and evidence.
Task 5 may not commit until every CLI failure identity is catalogued and asserted. Final review
reconciles the catalog against reachable throw/error branches; an uncatalogued or untraceable branch
is `Fail`.

## Contradiction and Integration Check

The whole-plan audit is recorded in `artifacts/contradiction_check.md`. Current verdict: `Pass` for
internal plan coherence and `Ready with Constraints` for execution; these are not claims that code,
live adapters, CI delivery, or enforcement has passed. Task 0 remains the only next allowed action.

The audit found and resolved these cross-section mismatches:

- “pure core” previously obscured that Task 5 changes an already-invoked shadow CLI. Impact,
  compatibility, atomic commit, rollback, and fault-injection requirements now name that effect.
- generic pass receipts had no finding from which to recover the boundary action, and candidate-read
  failures may lack a proposal fingerprint. Task 5 now requires an input/top-level action and a
  deterministic safe-tuple receipt correlation digest while keeping fields optional in the exported
  type for schema-v1 source compatibility.
- local `artifacts/` paths were described as if they belonged in public product output. Product
  receipts now use safe repository/public references; local artifact links remain operator-only.
- “does not promote a blocker” conflicted linguistically with pure evaluators returning `block`.
  The non-goal now specifically prohibits hook/workflow enforcement composition, not pure policy
  results.
- readiness could have appeared to override the interrupted broad npm run. The readiness record is
  explicitly constrained, only focused pinned lanes and the final branch gate are authoritative, and
  the killed/masked run remains inconclusive.
- aggregate score claims could conceal per-case swaps, and parallel writes could obscure which change
  made a RED test green. Per-case assertions are mandatory and Tasks 0–6 remain sequential lead-owned
  writes; only immutable read-only contradiction/replay lanes may run in parallel.
- new policy modules risked duplicating the experiment and receipt implementations. The reuse audit,
  task ordering, delegation tests, and removal/search criteria now require extraction and one engine.

No unresolved contradiction currently invalidates the task graph. Residual risks are explicit:
stable patch IDs and live GitHub completeness depend on a future adapter; no hook/workflow delivery,
production alert, CI run, supply-chain blocker, or external producer is exercised; sanitized fixtures
may omit a live-field nuance; and the complete branch gate is still pending. Each risk either remains
out of scope or has an inconclusive/block path and cannot support a broader success claim.

A fresh contradiction check is mandatory after implementation/review evidence is complete and before
the final synthesis/Task 8. It reconciles objective, readiness, error model, observability, test
provenance, reuse audit, actual diff, receipt snapshots, evaluator results, validation layers, and
handoff. Any unsupported claim, changed scope, hidden blocker, stale artifact/head, or mismatch among
those surfaces changes the verdict to `Inconclusive`/`Blocked` until resolved.

## Linting, Formatting, and Static Quality Gates

`artifacts/linting_plan.md` is authoritative for commands, expected output, threshold, evidence path,
and owner. All commands run from the repository root through pinned wrappers where a package script
exists; outputs preserve the producer exit. A skipped, killed, timed-out, config-failed, or masked
gate is `Inconclusive`, never clean.

The root package has no formatter/check script and no Prettier/Biome/dprint configuration. Do not
invent or auto-apply a formatter in this tranche. Formatting expectations are the surrounding
TypeScript/Markdown style, stable import/order conventions, and `git diff --check` with zero
whitespace errors. Reviewer-visible style drift in changed lines is corrected explicitly; a generic
“formatted” claim is forbidden.

For every code task, run the focused test, `typecheck:scripts`, `git diff --check`, and the ESLint
fitness guard before commit. Task 5 and the combined/final lanes also run `typecheck:all`. The final
branch gate includes repository boundaries, test integrity, ESLint fitness, typecheck-all, semantic
shadow, and repository hygiene. Do not run bare `eslint` with a different config and call it
equivalent.

The ESLint fitness wrapper intentionally reports configured warnings without a nonzero exit; parser,
configuration/runtime, fatal, and configured-error findings block. Existing unrelated warnings are
visible non-blockers, but any new warning in a PR B changed path is a task-level regression and must
be fixed or explicitly dispositioned as `Inconclusive` before commit. Compare changed-path findings
against the pre-task artifact rather than suppressing or changing the lint configuration. TypeScript,
import-boundary, test-integrity, diff-check, doc guard, and branch-gate warnings/errors are blocking
whenever their command exits nonzero or expected structured threshold is violated.

Optional Semgrep, Conftest, OSV, Python, Make, and Go checks are not installed/applicable and are not
substitutes for native gates. No root Python quality configuration was found. Their absence remains a
recorded limitation, not a passing static-analysis result.

## Regression Protection and Change Safety

`artifacts/regression_protection.md` maps each protected behavior to its baseline, mechanism,
regression signal, and rollback/mitigation trigger. Baselines must be captured from the exact pre-task
head before modifying that behavior; a baseline generated after the change cannot prove preservation.

The protected existing behavior includes semantic receipt schema-v1 assignability and JSON meaning,
the concise human pass line, atomic private receipt writing, current semantic policy rule meaning,
frozen evaluator case labels/scores, pinned toolchain/typecheck behavior, test-integrity/import
boundaries, document inventories, branch hygiene, and the absence of live network/enforcement/external
mutation. New behavior at risk includes canonical hash stability, provider fail-closed completeness,
exact-history false-positive control, durable re-entry/override scope, provenance ordering, safe
correlation/redaction, and one-engine evaluator delegation.

Before Tasks 1, 5, and 6, preserve the applicable existing focused test output/snapshot and evaluator
per-case/aggregate output under `artifacts/regression_baselines/` with exact head and command. After
the change, replay the identical command plus the new counterexample tests. Compare structured
receipt fields and per-case classifications, not only process exit or totals. Fixtures and expected
snapshots remain reviewed inputs; implementation output never silently rewrites them.

Negative controls intentionally perturb one decisive field: path/status/blob/provenance; provider
completeness/cursor/repository; artifact state/disposition/re-entry/override; remote/tracking/base/path;
receipt action/rule/correlation/secret; or evaluator delegation/case mapping. Each control must change
only the expected finding/digest. Neighboring legitimate shared refactors, merged history, material
complete re-entry, current/ahead provenance, and exact-scoped unexpired override must not false-block.

During implementation, any pre-existing focused regression, changed-path lint warning, type error,
schema/text incompatibility, fixture relabel, score/case drift, duplicate engine, unexpected scope, or
weaker fail-closed outcome stops the task before commit. Diagnose with the smallest reproducer; add a
RED regression for confirmed defects. Roll back uncommitted explicit-path edits or create a new revert
for the isolated task commit—never destructively rewrite the worktree/history.

This tranche has no live rollout. Post-push detection is limited to remote-OID equality, unchanged
local branch-gate evidence, and later PR/CI observations that are explicitly not exercised here. A
future provider/hook/workflow rollout must replay this corpus, contract snapshots, negative controls,
and fault lanes against the live adapter and define delivery/alert/rollback evidence before enabling
enforcement. A later report cannot retroactively turn the current skipped live surface into Pass.

## Hooks, Automation, and Workflow Enforcement

`artifacts/hook_plan.md` inventories each trigger, policy, blocking/override behavior, and evidence.
PR B verifies and passes through existing automation but does not edit `.husky/`, `package.json`, or
`.github/workflows/` and does not promote the new pure history/provenance findings into a hook or CI
blocker. That composition is a subsequent measured tranche, not an ambient side effect of library
code.

Existing local controls are repo-scoped via `core.hooksPath=.husky`:

- **pre-commit** blocks unapproved commit identity, staged repo/publication/design/node/settings
  violations, and applicable console lint failures. Its architectural drift probes are warn-only and
  may be skipped locally, but the same relevant checks are hard-enforced later.
- **commit-msg** blocks prohibited attribution, malformed policy, and unsafe message content through
  `guard:repo:commit-msg`.
- **pre-push** routes branch/tag updates through `scripts/pre-push-guard.ts` to the appropriate
  complete verification script, then runs deterministic design metrics/burndown blockers. A producer
  error, malformed input, nonzero gate, or incomplete update aborts the push.

Task commits preserve their hook output/exit in task artifacts; Task 8 captures the pre-push producer
and SSH push receipt. `--no-verify` is not an approved implementation shortcut. Git cannot prevent it
locally, so bypass detection is layered: inspect actual commit identities/messages/diff before push,
run the complete gate explicitly, and rely on PR/main CI when a PR is later opened. Environment skip
variables are forbidden for final validation; the branch script explicitly unsets named skip flags.
Any unavoidable owner-approved bypass must name hook, reason, exact commit/OID, expiry, compensating
command/result, and source reference in the handoff; without that durable record the verdict is
`Blocked`.

Existing CI `quality.yml` runs on pull requests and main pushes with read-only contents permission,
full-history checkout, two Node versions, semantic shadow receipt, three typechecks, boundaries,
hygiene/authorship/message smoke, required test-integrity, lint, doc/publication/work-index guards,
coverage/full suites, and bounded timeout. `tag-release-gate.yml` separately protects `v*` tags; the
tool-specific workflow protects its own paths. PR B makes no workflow claim because only an
authorized SSH branch push is planned and that trigger does not run `quality.yml`; a later PR run is
future evidence, not current proof.

The subsequent adapter/composition tranche must proceed shadow-first: add read-only bounded GitHub
history and remote-tip observation, emit/upload human+JSON receipts, replay the frozen/holdout/live
sample, and measure false blocks, misses, unavailable evidence, latency, and agent correction. Only
after thresholds and override audit pass may pre-commit/pre-push/CI enforcement be proposed. Promotion
requires exact test paths in the canonical local gate, matching CI behavior, fail-closed producer
exits, scoped expiring owner overrides, negative bypass tests, and rollback to shadow mode. No override
may convert provider incompleteness, timeout, tracking mismatch, receipt-write failure, or masked test
execution into Pass.

## Rules, Policies, and Guardrails

`artifacts/rules_and_guardrails.md` is the operator matrix for source/rationale, enforcement point,
block threshold, exception path, and evidence. The repository instruction hierarchy and current owner
request outrank this plan; tool or filesystem access never expands mutation authority.

### Code and evidence rules

- Implement only the exact files/contracts in Tasks 1–7. Reuse existing receipt/writer/evaluator/Git
  primitives; no second renderer, canonicalizer, history/provenance engine, or speculative registry.
- Canonical identity uses validated fixed-key records and SHA-256; stable patch IDs remain separately
  observed provider facts. Title, branch, symbol, or filename similarity alone never blocks.
- Required evidence that is absent, incomplete, mismatched, stale, truncated, timed out, killed,
  skipped, or masked is `inconclusive`. Never infer a pass from zero findings or a pipeline wrapper.
- Every intervention finding contains action, rule, summary, observed facts, matched artifacts,
  reason, correction, rerun, sources, and safe correlation. Every unsafe and neighboring-safe branch
  has a deterministic assertion.
- Expected fixture labels are policy inputs written before production changes. Do not regenerate,
  relabel, or weaken them to fit implementation output. Preserve real RED/GREEN producer exits.
- Code changes obey local TypeScript style, pass focused tests, typechecks, lint/diff checks, and
  changed-test integrity. Comments/error paths unrelated to changed behavior and speculative
  abstractions are prohibited.

### Workflow and review rules

- Tasks execute in dependency order with one lead write owner. Task commits stage exact paths and
  pass their hook/gate; read-only reviewers work from immutable OIDs and cannot approve their own
  unresolved findings.
- The lead verifies every decisive reviewer claim against current source, diff, test, receipt, log,
  or runtime receipt. Missing/progress-only/stale/masked worker output is inconclusive.
- Before deleting or declaring branches superseded, use `git range-diff`/`git cherry -v`; no branch
  deletion is planned. Never use `git clean`, `git checkout --`, `git restore .`, or `git reset
  --hard`; preserve/recover with non-destructive explicit edits or an owned stash/revert.
- Commit messages and public artifacts contain no coauthor trailers, model/internal names,
  generated-by attribution, or disallowed email. Repository hooks and final history audit enforce
  the approved public identity.
- `experiment-results.tsv` and structured-review artifacts remain unstaged. Ignored plan/handoff paths use
  exact force-add only; broad force-add is forbidden.

### Access, security, and external-action rules

- Origin remains the LucasQuiles SSH remote. GitHub/Internet reads are allowed for evidence; only the
  named branch SSH push is authorized externally. Do not create/modify a PR, issue, comment, review,
  merge, workflow run, ruleset, release, required check, or repository content through an external
  API.
- PR B accepts pure sanitized observations; it does not read tokens, call GitHub, fetch remote tips,
  mutate hooks/workflows/package composition, or touch fleet/MCP/HTTP/database/deploy surfaces.
- Never log or fixture credentials, raw comments, credential-bearing remotes, full environment dumps,
  private absolute paths, or unbounded provider/exception payloads. Secret-like sentinel tests cover
  human/JSON/operator artifacts.
- Local artifacts are not a confidentiality boundary. Durable safe evidence is summarized in the
  tracked handoff; secrets are never staged or relied on for later cleanup.

### Decisions, warnings, blockers, and exceptions

Policy findings use the closed precedence `block` > `inconclusive` > `warn` > `pass`. Exact open or
closed-unmerged content/stable patch and unsatisfied disposition/re-entry may block. Invalid
tracking parity or high-risk stale overlap/high-coupling may block. Exact merged, subset/superset, and
path overlap warn. Heuristic title/branch/path-only collisions do not block. Provider or proof gaps
are inconclusive, not warnings.

Process violations—unauthorized external mutation, scope expansion, destructive Git, prohibited
attribution/identity, secret exposure, schema break, missing mandatory evidence, false/masked pass,
fixture relabel, duplicate engine, unresolved high/critical review, or nonzero mandatory gate—block
the task/push. Changed-path lint warnings block the task; unrelated baseline fitness warnings remain
visible warnings.

Exceptions exist only where a rule explicitly defines them. Policy overrides require exact rule and
fingerprint, owner, reason, expiry, source reference, and eligible finding; disposition re-entry also
requires every cited condition and prior artifact. Process/validation/access rules have no ambient
override. An owner-approved exceptional bypass must be recorded in the tracked handoff with scope,
expiry, authority, compensating validation, residual risk, and rollback; it cannot convert evidence
failure into pass. A rule violation is first reproduced, then classified, fixed or explicitly
dispositioned, independently reviewed when high-risk, and linked to its artifact. Silence or reviewer
agreement without evidence is not disposition.

## Documentation, Runbook, and DevOps Readiness

`artifacts/documentation_devops_readiness.md` is the readiness ledger. The tracked delivery package
is the authoritative specification, this reviewed implementation plan, the mining/implementation
handoff, publication audit, and regenerated work indexes. Task 0 publishes the pre-code contract;
Task 7 appends exact commits, results, timings, scores, review dispositions, limitations, rollback,
and reproduction commands to the handoff and regenerates inventories.

No end-user configuration or fleet/operator runbook changes are required for PR B because it adds no
service, HTTP/MCP/API, environment variable, token, hook, workflow, deployment unit, database, queue,
schedule, dashboard, alert, or enforcement composition. The plan's reproduction section and handoff
are the operator instructions for the pure core: pinned setup/tool versions, exact fixture provenance,
focused/combined commands, expected case results, receipt locations, Git OIDs, failure interpretation,
and rollback by isolated task commit. If implementation introduces any runtime/config/deploy surface,
this verdict immediately becomes `Fail` and the appropriate user docs/runbook/migration/rollback must
be added before continuing.

CI/release implications are explicit but unchanged: existing PR quality/full-suite coverage should
exercise committed tests when a PR is later opened, while the current authorized branch-only push
does not trigger that workflow. The local focused lanes and complete pre-push branch gate are current
evidence; no CI status is claimed. No release/tag is authorized. Existing mutable Action/container
references and supply-chain pin migration remain a separately measured backlog item and cannot be
presented as remediated by this tranche.

Dashboards, alerts, Sentry, Render, fleet health, and deployment telemetry are not applicable to a
pure local library. Human/JSON receipts and tracked handoff evidence are observability, not proof of
live delivery to an agent or operator. The future adapter/composition runbook must define provider
credentials/permissions, bounded pagination/retry/timeout, receipt storage/retention, alert delivery,
shadow metrics, override approval/audit/expiry, enforcement promotion, rollback-to-shadow, CI check
names, and incident response for false blocks or unavailable evidence.

Open operational risks remain visible: broad npm reconnaissance was interrupted; live GitHub/remote
observation and agent-feedback delivery are unproven; no production alert exists; sanitized fixtures
may omit a live-field nuance; supply-chain pinning is deferred; and branch-only push yields no CI run.
These risks are bounded by scope and explicit no-claim language, so documentation/devops planning is
`Pass` while implementation readiness remains `Ready with Constraints`. Any missing tracked handoff
result, stale work index, nonzero doc guard, or undocumented scope/config change blocks Task 8.

Reproduction-ready deliverables require exact repository/branch/head, SSH remote, pinned commands,
fixture/capture provenance and hashes, RED/GREEN/combined outputs, per-case and aggregate evaluator
results, human/JSON receipt examples, validation-layer dispositions, final diff/authorship/gate
receipts, and remote-OID equality. Local structured-review artifacts are supporting evidence only; safe
durable outcomes are copied to the tracked handoff before push.

## Capability and Historical-Context Inventory

`artifacts/final_review.md` and `artifacts/capability_*` record the observed capability inventory.
Requested and observed runtime versions remain separate: the interactive host currently exposes
Git, ripgrep, Bash, Node/npm, Python, `gh`, `jq`, and `loadgate`, while product commands must still run
through repository-pinned Node/npm wrappers. Presence is not proof that a tool was used or that its
output is valid.

| Capability class | Available and relevant surface | Planned use and evidence | Ownership / write boundary |
| --- | --- | --- | --- |
| Current-runtime procedures | Planning, hypothesis-driven work, TDD, test integrity, fail-closed gates, deduplication, verification, and WhatSoup PR review | Apply at named checkpoints; record plan passes, RED/GREEN, integrity, reviews, and final proof | Lead selects/reads procedures; availability grants no extra repo/external authority |
| Repository scripts | pinned Node/npm wrappers; semantic evaluator/CLI; work-index/publication/repo/boundary/lint/integrity guards; pre-push router | Deterministic tests/typechecks/guards/scores/docs/final gate under task artifacts | Lead runs from repo root and edits only exact task paths |
| Native local tools | `git`, `rg`, shell, `apply_patch`, `loadgate`, `gh`/web reads, `jq`, Python review helpers | Source/history search, exact edits, bounded heavy commands, GitHub mining, JSON/evidence review | `apply_patch` for writes; GitHub/Internet reads only; only authorized SSH branch push writes externally |
| Agents/subagents | Lead plus bounded native read-only reviewers; tmup/cross-runtime lanes exist generally | Completed #1835 independent probes; future contradiction/replay lanes only when immutable and non-overlapping | Lead owns all code/integration; review lanes have no writes, one owner/dedupe key, timeout, leaf status, result contract |
| Plugins | GitHub and Google Drive plugins are installed per runtime topology; the alternate SDLC/tmux/plugin estate exists in its own realm | GitHub plugin is unnecessary because `gh`/API evidence is captured; Drive/alternate-realm plugins are not relevant | No plugin mutation; alternate realm only through an approved tmup packet, not implicit invocation |
| MCPs/connectors | Pinecone and browser/Playwright/Render/fleet/workspace surfaces are configured in the broader workstation estate; direct session availability varies | None is needed for PR B. Pinecone may retrieve historical context; browser/Render/fleet/workspace surfaces are out of scope | Read-only discovery only if needed; no SaaS/workspace/fleet mutation; unavailable/unprobed remains unknown |
| Browser/runtime/devops | Repo Playwright/browser suites and GitHub Actions exist; local `loadgate` governs heavy commands | No UI/web target in PR B; final branch gate may transit existing console/browser lanes; CI files are inspected only | No browser screenshots, deploy, workflow rerun/edit, tag, or release in this tranche |
| Historical context | Git log/show/blame/diff/range-diff/cherry/patch IDs; GitHub PR/issues/comments/checks; prior spec/plan/handoff/run artifacts | Mine exact immutable OIDs/artifacts, compare prior/current policy, retain provenance in handoff | Reads only; source claims verified by lead; raw comments/secrets excluded |
| Semantic/vector history | `pinecone-search` skill and configured Pinecone path | Optional secondary discovery for prior docs/patterns if local Git/docs are insufficient; every hit must be traced to decisive source | No index/update; retrieval cannot override current source/Git/API evidence |

Subagent-driven development is used only where decomposition is actually safe. In this dependency
chain, parallel code writes are not safe; effective parallelism is reserved for independent read-only
review/replay with immutable inputs and separate artifacts. If later tasks become genuinely
independent with non-overlapping files/contracts, the lead may create bounded packets, but must retain
single integration ownership and deterministic replay. No hidden worker, nested delegation, vague
“use an MCP later,” shared mutable output, or unbounded process lane is allowed.

TDD remains mandatory for Tasks 1–6, with verified intended-reason RED and identical-command GREEN.
Every correctness claim requires deterministic input, threshold, producer exit, artifact, exact head,
and replay; wall-clock/network/model judgment or retry-until-green is not proof. Worker/plugin/MCP
output is advisory until the lead checks the decisive source/diff/test/receipt/runtime evidence.

Capability gaps are non-critical to PR B but explicit: no live GitHub/remote adapter, no provider
contract/E2E, no production alert/delivery surface, no current CI run, optional scanners absent, and
direct MCP status not needed/proven. Scope containment makes the capability verdict `Pass` for this
pure-core plan; those gaps prohibit claims about live automation or enforcement.

## Final Structured-Review Synthesis

The 27-pass plan review is internally coherent and complete enough to begin Task 0. Its verdict is
`Pass` for the written plan and `Ready with Constraints` for execution—not Pass for implementation,
root tests, CI, push, merge, live provider behavior, feedback delivery, or enforcement.

First-hand final state is bound to branch `experiment/jul16-boundary-core-history`, HEAD
`a15b3d953589641c81fd8c228e34afeb1cba2d39`, and merge-base
`043c531e3dae51635dc60a5a85238e866ccbe291`. The branch is 13 commits ahead and 4 behind
`origin/main`; it has no upstream/remote ref, and the exact HEAD has zero GitHub check runs. The new
plan/handoff are intentionally ignored and untracked until Task 0, structured-review artifacts remain local,
and no PR B production code exists. These facts match readiness rather than contradict it because the
only permitted next action is the documentation commit.

`artifacts/final_verification_bank.md` records all 320 supplied bank questions in the mandatory
evidence format. The bank substantially targets a separate event-ledger/watchdog `whatsoup-guard`
product. Questions about `runCycle`, `EventKind`, SQLite/JSONL, sinks, mutes, watchdogs, profiles, and
simulator scenarios have no matching SBH plan/spec surface and are marked `INCONCLUSIVE`, never
fabricated as passes or imported as scope. Relevant repository, traceability, TDD, security,
reliability, DRY, orchestration, and merge-readiness questions are answered from Git/source/artifact
commands; implementation/CI/merge questions remain partial or inconclusive until their tasks run.

The fresh contradiction audit found no unresolved internal contradiction. It confirms: pure modules
versus current shadow-CLI impact is explicit; schema-v1 additive compatibility includes action and
safe receipt correlation; evidence gaps fail closed; reuse removes duplicate evaluator logic; TDD
and per-case oracles precede code; local/CI/hook claims are separated; no external mutation exceeds
the authorized branch push; and deferred adapter/alert/supply-chain work cannot masquerade as live.

Git/GitHub/tracked documents supplied decisive historical context. Pinecone remains an available
secondary retrieval opportunity for discovering older design notes, but was not needed and no vector
hit is treated as policy truth. The interrupted broad npm run, missing live adapter/E2E, absent CI on
this SHA, no production alert/delivery, sanitized-fixture limitations, and deferred supply-chain
pinning are honest nondeterministic/capability gaps. Focused pinned validation, independent replay,
the complete branch gate, SSH push, remote-OID proof, and later PR CI remain mandatory checkpoints.

Documentation and operational readiness are sufficient for the pure-core tranche: spec, plan,
handoff, publication classification, indexes, reproduction steps, failure/rollback rules, and future
adapter runbook requirements are all named. Safe durable outcomes must move from ignored artifacts to
the tracked handoff before publication. A fresh operator can reproduce the plan verdict from the
manifest, per-pass artifacts, numbered bank evidence, Git commands, and Task 0–8 command blocks
without chat history.

## Global Constraints

- The authoritative design is
  `docs/superpowers/specs/2026-07-15-semantic-boundary-hygiene-design.md`; the measured evidence and
  tranche boundary are in
  `docs/superpowers/handoffs/2026-07-16-boundary-core-history-mining.md`.
- PR B implements pure SBH-001, SBH-003, SBH-004, SBH-005, SBH-006, SBH-007, SBH-008, and SBH-010
  primitives. It does not compose any new finding into hook/workflow enforcement or implement
  SBH-011 supply-chain enforcement; pure evaluators may still return block decisions for callers.
- Do not add a GitHub client, `git ls-remote` adapter, hook, package-script composition, workflow,
  required check, ruleset mutation, or external producer write in PR B.
- Exact content/stable-patch evidence and unsatisfied durable dispositions may produce a block
  decision in the pure evaluator. Exact merged history, subset/superset reuse, path overlap, and
  issue/title/branch/symbol similarity remain warnings or no finding.
- Missing, partial, mismatched, stale, timed-out, or truncated provider evidence is
  `inconclusive`, never `pass`. A local tracking OID that differs from the observed remote tip is a
  block because all downstream comparison evidence is invalid.
- Canonical paths are case-sensitive repository-relative POSIX paths. Strip a leading `./`, collapse
  redundant separators, reject absolute paths and `..`, and reject duplicate canonical records.
- Sort canonical records by status, old path, path, and blob OID. Serialize a fixed-key JSON shape
  and hash it with SHA-256. Git OIDs remain identity inputs; SHA-256 supplies the portable digest.
- A stable patch ID is an observed provider value. PR B validates and compares it but does not run
  the patch command in provider code.
- Disposition records contain bounded categories and references, never copied comment bodies.
  Owner overrides are rule- and fingerprint-scoped, owner-authored, time-bounded, and non-expired.
- Preserve `BoundaryReceipt.schemaVersion: 1` with additive fields and broader value unions. Do not
  break existing PR A receipt readers or semantic snapshot meaning.
- Feedback tests assert rule, action, summary, observed evidence, reason, correction, rerun, source
  references, and matched artifacts. Decision-only assertions are insufficient.
- The experiment evaluator imports production fingerprint/history/provenance functions after each
  extraction. Frozen results must remain baseline 13/40, candidate 40/40, and holdout 18/18.
- Node commands use `bash scripts/run-with-pinned-node.sh`; npm commands use
  `bash scripts/run-with-pinned-npm.sh`. Heavy verification runs through `loadgate` when available.
- Stage explicit paths only. Never stage the intentionally untracked `experiment-results.tsv`.
- Commit messages contain no attribution trailers, model names, internal names, or email addresses.
- New documentation under `docs/superpowers/` requires a `PRIVATE-ARCHIVE` publication row and
  regenerated `docs/work-index.json` and `docs/work-index.md`.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `scripts/lib/semantic-quality/boundary-types.ts` | create | Shared actions, artifacts, findings, decisions, and evidence records |
| `scripts/lib/semantic-quality/fingerprint.ts` | create | Canonical path/blob, task, proposal, and stable-patch identities |
| `scripts/lib/semantic-quality/history-types.ts` | create | Historical artifact and disposition record schema |
| `scripts/lib/semantic-quality/history-provider.ts` | create | Bounded paginated provider contract and fail-closed collection |
| `scripts/lib/semantic-quality/history.ts` | create | Exact history, overlap warnings, disposition, re-entry, and override policy |
| `scripts/lib/semantic-quality/provenance.ts` | create | Pure remote-tip/tracking/merge-base/overlap policy |
| `scripts/lib/semantic-quality/receipt.ts` | modify | Generic actions/artifacts/findings and additive receipt construction/rendering |
| `scripts/lib/semantic-quality/policy.ts` | modify | Accurate semantic inconclusive rule identities |
| `scripts/semantic-quality-check.ts` | modify | Accurate candidate/policy/invocation/write failure feedback |
| `scripts/experiments/semantic-boundary-eval.ts` | modify | Import PR B production functions; remove duplicate policy branches |
| `tests/scripts/semantic-fingerprint.test.ts` | create | Canonicalization, digest, malformed input, and rename cases |
| `tests/scripts/semantic-history-provider.test.ts` | create | Pagination completeness, bounds, cursor, mismatch, and failure cases |
| `tests/scripts/semantic-history.test.ts` | create | Open/closed/merged/subset/overlap/disposition/re-entry behavior |
| `tests/scripts/semantic-provenance.test.ts` | create | Current, stale, overlap, high-coupling, disjoint, and unavailable evidence |
| `tests/scripts/semantic-quality-check.test.ts` | modify | Full situational feedback and receipt compatibility assertions |
| `tests/scripts/semantic-boundary-eval.test.ts` | modify | Delegation proof and frozen-score regression |
| `tests/fixtures/boundary-core/history.json` | create | Sanitized PR #1838/#1848/#1857-derived and adversarial records |
| `docs/superpowers/handoffs/2026-07-16-boundary-core-history-mining.md` | modify | Append actual implementation and validation record |
| `docs/publication-audit.md` | modify | Classify PR B plan and handoff |
| `docs/work-index.json` / `docs/work-index.md` | regenerate | Track the new plan and handoff |

---

### Task 0: Commit the reviewed planning packet

**Files:**
- Add: `docs/superpowers/handoffs/2026-07-16-boundary-core-history-mining.md`
- Add: `docs/superpowers/plans/2026-07-16-boundary-core-history-provenance.md`
- Modify: `docs/publication-audit.md`
- Regenerate: `docs/work-index.json`
- Regenerate: `docs/work-index.md`

- [ ] **Step 1: Force-add only the ignored planning documents**

```bash
git add -f docs/superpowers/handoffs/2026-07-16-boundary-core-history-mining.md docs/superpowers/plans/2026-07-16-boundary-core-history-provenance.md
git add docs/publication-audit.md
bash scripts/run-with-pinned-npm.sh run work-index:regen
git add docs/work-index.json docs/work-index.md
```

- [ ] **Step 2: Validate publication and plan inventories**

```bash
bash scripts/run-with-pinned-npm.sh run guard:publication:all
bash scripts/run-with-pinned-npm.sh run guard:work-index
bash scripts/run-with-pinned-npm.sh run guard:doc-tally
git diff --cached --check
git status --short
```

Expected: every command exits 0; staged paths are exactly the five named documentation/inventory
files; `experiment-results.tsv` and `artifacts/` remain unstaged.

- [ ] **Step 3: Commit the documentation gate**

```bash
git commit -m "docs(quality): plan boundary history core"
```

Do not begin Task 1 until this commit exists and the worktree contains no unexpected tracked
change.

---

### Task 1: Lock canonical fingerprint behavior

**Files:**
- Create: `scripts/lib/semantic-quality/boundary-types.ts`
- Create: `scripts/lib/semantic-quality/fingerprint.ts`
- Create: `tests/scripts/semantic-fingerprint.test.ts`
- Create: `tests/fixtures/boundary-core/history.json`

**Interfaces:**

```ts
export type PathBlobStatus = 'added' | 'copied' | 'modified' | 'renamed' | 'deleted';

export interface PathBlobRecord {
  status: PathBlobStatus;
  oldPath?: string | null;
  path: string;
  blobOid: string;
}

export interface ProposalIdentity {
  contentFingerprintSha256: string;
  patchIdStable: string | null;
  proposalFingerprintSha256: string;
  taskFingerprintSha256: string | null;
}

export function canonicalPathBlobRecords(
  records: ReadonlyArray<PathBlobRecord>,
): PathBlobRecord[];
export function contentFingerprintSha256(records: ReadonlyArray<PathBlobRecord>): string;
export function taskFingerprintSha256(input: { title: string; body: string }): string;
export function buildProposalIdentity(input: {
  records: ReadonlyArray<PathBlobRecord>;
  patchIdStable?: string | null;
  baseOid?: string | null;
  headOid?: string | null;
  task?: { title: string; body: string } | null;
}): ProposalIdentity;
```

- [ ] **Step 1: Write RED tests from visible and adversarial evidence**

Create table-driven tests proving:

- the sanitized #1838 and #1848 records have the same content digest despite different proposal,
  head, and base identities;
- input order and a leading `./` do not change the digest;
- path case, status, old path, blob content identity, or deletion state does change the digest;
- a rename record includes both old and new path;
- stable patch ID is validated and preserved independently of the content digest;
- proposal identity changes with provenance while content identity does not;
- task normalization changes line endings and surrounding/repeated whitespace only;
- absolute paths, parent traversal, empty paths, malformed or missing OIDs, and duplicate canonical
  records throw a bounded validation error. A deletion uses the deleted/base blob OID so deletions
  of different content cannot collide.

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/semantic-fingerprint.test.ts --pool=forks --fileParallelism=false
```

Expected RED: module import failure because `fingerprint.ts` does not exist.

- [ ] **Step 2: Implement fixed-key canonicalization and SHA-256 identities**

Use `JSON.stringify` only after constructing objects with the fixed key order
`status`, `oldPath`, `path`, `blobOid`. Sort a cloned array and never mutate caller input. Use
`createHash('sha256')`; do not concatenate fields with an ambiguous delimiter.

Treat SHA-1 and SHA-256-length lowercase hexadecimal Git identities as valid. Normalize hexadecimal
case to lowercase. Every status requires the relevant blob OID. Validate a stable patch ID with the
same Git-identity helper but keep it as a distinct field.

Create `boundary-types.ts` as the dependency leaf for `BoundaryDecision`, `BoundaryAction`,
`BoundaryArtifact`, evidence records, and `BoundaryFinding`. Move no rendering or aggregation into
the leaf. Existing receipt exports remain unchanged until Task 5 imports and re-exports these types.

- [ ] **Step 3: Run focused GREEN and script typecheck**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/semantic-fingerprint.test.ts --pool=forks --fileParallelism=false
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
```

- [ ] **Step 4: Commit Task 1 with explicit paths**

```bash
git add scripts/lib/semantic-quality/boundary-types.ts scripts/lib/semantic-quality/fingerprint.ts tests/scripts/semantic-fingerprint.test.ts tests/fixtures/boundary-core/history.json
git commit -m "feat(quality): add canonical proposal fingerprints"
```

---

### Task 2: Add bounded history-provider collection

**Files:**
- Create: `scripts/lib/semantic-quality/history-types.ts`
- Create: `scripts/lib/semantic-quality/history-provider.ts`
- Create: `tests/scripts/semantic-history-provider.test.ts`

**Interfaces:**

```ts
export interface HistoryArtifactRecord {
  repository: string;
  kind: 'pull-request' | 'issue';
  number: number;
  state: 'open' | 'closed-unmerged' | 'merged';
  url: string;
  pathBlobSet?: PathBlobRecord[];
  patchIdStable?: string | null;
  taskFingerprintSha256?: string | null;
  disposition?: DispositionRecord | null;
}

export type DispositionCategory =
  | 'duplicate-existing-mechanism'
  | 'reproduced-correctness-defect'
  | 'production-unreachable'
  | 'out-of-scope'
  | 'needs-specific-repro'
  | 'superseded'
  | 'accepted-for-reentry';

export interface DispositionRecord {
  category: DispositionCategory;
  artifactRefs: string[];
  reentryConditions: string[];
  recordedAt: string;
}

export interface HistoryPage {
  repository: string;
  observedAt: string;
  items: HistoryArtifactRecord[];
  nextCursor: string | null;
}

export interface HistoryProvider {
  readPage(input: {
    repository: string;
    cursor: string | null;
    signal?: AbortSignal;
  }): Promise<HistoryPage>;
}

export interface HistoryCollection {
  repository: string;
  observedAt: string[];
  artifacts: HistoryArtifactRecord[];
  pageCount: number;
  complete: boolean;
  limitations: string[];
}
```

- [ ] **Step 1: Write RED provider tests**

Cover a complete three-page query and these negative controls:

- page throws or rejects;
- repository identity changes between pages;
- cursor repeats or cycles;
- invalid/missing observation time;
- duplicate artifact identity with conflicting evidence;
- maximum page or artifact count reached while a next cursor remains;
- aborted request;
- incomplete artifacts that cannot support their advertised exact comparison.

Every unsafe case must return `complete: false` with a bounded limitation. Partial artifacts may be
retained for diagnosis but cannot authorize a clean history verdict.

- [ ] **Step 2: Implement the collector without a concrete network provider**

Put `HistoryArtifactRecord`, `DispositionCategory`, and `DispositionRecord` in `history-types.ts`;
the provider and Task 3 policy import them. Default bounds are explicit inputs in tests and
conservative production constants in the library.
Track every cursor before use. Sort final artifacts by kind and number. Reject repository mismatch
before accepting page items. Never catch an error and return `complete: true`.

- [ ] **Step 3: Run focused GREEN and typecheck**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/semantic-history-provider.test.ts --pool=forks --fileParallelism=false
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
```

- [ ] **Step 4: Commit Task 2**

```bash
git add scripts/lib/semantic-quality/history-types.ts scripts/lib/semantic-quality/history-provider.ts tests/scripts/semantic-history-provider.test.ts
git commit -m "feat(quality): add bounded history provider contract"
```

---

### Task 3: Evaluate exact history and disposition-aware re-entry

**Files:**
- Create: `scripts/lib/semantic-quality/history.ts`
- Create: `tests/scripts/semantic-history.test.ts`
- Modify: `tests/fixtures/boundary-core/history.json`

**Interfaces:**

```ts
import type { BoundaryAction, BoundaryFinding } from './boundary-types.ts';
import type { DispositionRecord } from './history-types.ts';

export interface ReentryPacket {
  priorArtifactRefs: string[];
  addressedConditions: string[];
  deltaKind: 'material' | 'test-only' | 'docs-only' | 'format-only' | 'fixture-hygiene';
  productionOwner?: string | null;
  override?: {
    owner: string;
    ruleId: string;
    fingerprintSha256: string;
    reason: string;
    expiresAt: string;
    sourceRef: string;
  } | null;
}

export function evaluateHistory(input: {
  action: BoundaryAction;
  candidate: ProposalIdentity & { pathBlobSet: PathBlobRecord[] };
  collection: HistoryCollection;
  reentry?: ReentryPacket | null;
  now: Date;
}): BoundaryFinding[];
```

- [ ] **Step 1: Write RED behavior tests**

Assert the full finding content for:

- exact open PR content: block and route to the existing PR;
- exact closed-unmerged content: block and cite disposition when present;
- stable patch match on a closed-unmerged renamed proposal: block;
- exact merged PR content: warn and request current-main reachability proof;
- exact subset/superset blob reuse: warn;
- path overlap without exact content: warn;
- same filename only, repeated normalized title only, or branch reuse only: no block;
- exact issue task identity: block only when `action === 'open-issue'`, otherwise warn context;
- incomplete provider collection: one `history.evidence-incomplete` inconclusive finding before any
  clean conclusion;
- cosmetic/test/docs/fixture-only re-entry after an architectural disposition: block;
- material but incomplete re-entry: block;
- material re-entry addressing every condition and naming a production owner: no re-entry block;
- valid exact-scope owner override: no re-entry block;
- expired, wrong-rule, wrong-fingerprint, ownerless, or unreferenced override: block.

Include the #1838/#1848 exact records and the #1857 cosmetic-reentry record from the sanitized
fixture. Add neighboring legitimate false-positive records for shared refactors and merged work.

- [ ] **Step 2: Implement exact-first multi-signal classification**

Compare content digests first, stable patch second, blob-set relationships third, and path overlap
last. Sort matches deterministically by artifact kind and number. One candidate may produce exact
and disposition findings, but suppress weaker overlap warnings for an artifact already reported as
an exact match.

Validate disposition and packet structure before policy evaluation. Require every prior artifact
and every condition. An `accepted-for-reentry` disposition is not an ambient bypass; it still needs
the cited packet or a valid scoped override.

- [ ] **Step 3: Run focused GREEN and typecheck**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/semantic-history.test.ts --pool=forks --fileParallelism=false
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
```

- [ ] **Step 4: Commit Task 3**

```bash
git add scripts/lib/semantic-quality/history.ts tests/scripts/semantic-history.test.ts tests/fixtures/boundary-core/history.json
git commit -m "feat(quality): enforce exact history and reentry policy"
```

---

### Task 4: Add pure upstream provenance policy

**Files:**
- Create: `scripts/lib/semantic-quality/provenance.ts`
- Create: `tests/scripts/semantic-provenance.test.ts`

**Interfaces:**

```ts
export interface ProvenanceObservation {
  repository: string;
  remoteTipOid: string | null;
  localTrackingOid: string | null;
  mergeBaseOid: string | null;
  headOid: string | null;
  aheadCount: number | null;
  behindCount: number | null;
  candidatePaths: string[] | null;
  upstreamPaths: string[] | null;
  highCouplingPaths: string[];
  observedAt: string | null;
  evidenceSource: string;
  complete: boolean;
  limitations: string[];
}

export function evaluateProvenance(input: {
  action: BoundaryAction;
  observation: ProvenanceObservation;
}): BoundaryFinding[];
```

- [ ] **Step 1: Write RED provenance tests**

Cover current parity/pass, remote unavailable/inconclusive, incomplete paths/inconclusive, tracking
mismatch/block, no merge base/inconclusive, older disjoint/warn, direct overlap/block, upstream
high-coupling change/block, current-but-ahead/pass, invalid OIDs/inconclusive, and malformed counts or
timestamps/inconclusive. Assert that a stale tracking block prevents a later “disjoint” finding.

- [ ] **Step 2: Implement ordered fail-closed evaluation**

Validate completeness first, remote/tracking parity second, merge-base evidence third, and
overlap/high-coupling classification last. Normalize paths with the fingerprint path helper. High-
coupling means the upstream delta touches a declared high-coupling path; name the actual path in the
finding. Do not infer overlap from titles or branch names.

- [ ] **Step 3: Run focused GREEN and typecheck**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/semantic-provenance.test.ts --pool=forks --fileParallelism=false
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
```

- [ ] **Step 4: Commit Task 4**

```bash
git add scripts/lib/semantic-quality/provenance.ts tests/scripts/semantic-provenance.test.ts
git commit -m "feat(quality): add upstream provenance policy"
```

---

### Task 5: Generalize receipts and correct situational feedback

**Files:**
- Modify: `scripts/lib/semantic-quality/receipt.ts`
- Modify: `scripts/lib/semantic-quality/policy.ts`
- Modify: `scripts/semantic-quality-check.ts`
- Modify: `tests/scripts/semantic-quality-check.test.ts`

**Interfaces:**

```ts
export type BoundaryAction = 'commit' | 'push' | 'open-pr' | 'reopen-pr' | 'open-issue';

export interface BoundaryArtifact {
  kind: 'pull-request' | 'issue' | 'commit' | 'path';
  repository: string;
  id: string;
  url?: string;
  state?: string;
  fingerprintSha256?: string;
}

export interface BuildBoundaryReceiptInput {
  invocation: string;
  action: BoundaryAction;
  enforcementMode: EnforcementMode;
  base: BoundaryReceipt['base'];
  fingerprints?: Record<string, string | null>;
  findings: BoundaryFinding[];
  limitations?: string[];
}

export function buildBoundaryReceipt(input: BuildBoundaryReceiptInput): BoundaryReceipt;
```

- [ ] **Step 1: Expand tests before production types**

Add RED tests that build and render history/provenance findings with matched artifacts and all five
actions. Preserve the existing PR A semantic JSON shape and one-line pass output.

For missing head, unreadable policy, missing source tree/root, analysis failure, unknown argument,
and receipt write failure, assert the exact distinct rule identity from the mining notes plus the
situational summary, observed label, reason, correction, rerun, and source. The unreadable-policy
test must explicitly reject the phrase “production module is not reachable.”

- [ ] **Step 2: Add a generic additive receipt builder**

Broaden `action`, `matchedArtifacts`, and `invocation` without changing `schemaVersion`. Add optional
top-level `action` and `correlationIdSha256` fields to the exported receipt type so existing literal
consumers remain source-compatible; the generic builder always emits both and verifies every finding
action matches the input action. Compute the correlation digest from fixed-key JSON containing the
safe receipt tuple, not from random UUIDs, error text, comment bodies, timestamps, or local paths.
Deduplicate and sort fingerprints, limitations, rule IDs, and source references. Render matched
artifacts after observed evidence and before the reason. Keep the existing pass output concise;
intervention output includes the short correlation handle.

`buildSemanticReceipt` remains a compatibility adapter. It maps semantic policy findings to the
generic builder and retains `invocation: 'semantic-quality'` and action `push`. Add tests that
existing semantic receipt literals remain assignable and that identical safe tuples produce the same
correlation while a changed action/base/rule changes it.

- [ ] **Step 3: Split semantic unknowns by actual failed operation**

Replace the hard-coded `semantic.production-reachability` fallback with:

- `semantic.candidate-unavailable` for unresolved head/candidate evidence;
- `semantic.policy-unavailable` for read/parse failure;
- `semantic.source-tree-unavailable` for incomplete tree or missing root;
- `semantic.analysis-unavailable` for graph/analysis failure;
- `semantic.invocation-invalid` for CLI arguments;
- `semantic.receipt-write-failed` for durable write failure.

Invalid allowlist structure remains the existing block rule. Do not collapse a parse/read failure
and a semantically invalid but readable allowlist.

- [ ] **Step 4: Run receipt/CLI GREEN and typecheck**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/semantic-quality-check.test.ts --pool=forks --fileParallelism=false
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
bash scripts/run-with-pinned-npm.sh run typecheck:all
```

- [ ] **Step 5: Commit Task 5**

```bash
git add scripts/lib/semantic-quality/receipt.ts scripts/lib/semantic-quality/policy.ts scripts/semantic-quality-check.ts tests/scripts/semantic-quality-check.test.ts
git commit -m "fix(quality): make boundary feedback situationally accurate"
```

---

### Task 6: Make the experiment consume the production core

**Files:**
- Modify: `scripts/experiments/semantic-boundary-eval.ts`
- Modify: `tests/scripts/semantic-boundary-eval.test.ts`

- [ ] **Step 1: Add RED delegation assertions**

Spy or compare exported production functions so the evaluator's content fingerprint, history,
re-entry, and provenance results demonstrably come from PR B modules. A second local canonicalizer
or parallel decision branch fails the test/review.

- [ ] **Step 2: Replace experiment-only duplicate logic**

Retain fixture parsing, baseline mapping, Git revision traversal, score calculation, and
supply-chain experiment branches. Convert fixture records into production inputs and adapt complete
production findings back into the experiment result. Do not move supply-chain rules into PR B.

- [ ] **Step 3: Prove frozen and holdout scores**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/semantic-boundary-eval.test.ts --pool=forks --fileParallelism=false
bash scripts/run-with-pinned-node.sh scripts/experiments/semantic-boundary-eval.ts baseline tests/fixtures/semantic-boundary-eval/cases.json
bash scripts/run-with-pinned-node.sh scripts/experiments/semantic-boundary-eval.ts candidate tests/fixtures/semantic-boundary-eval/cases.json
bash scripts/run-with-pinned-node.sh scripts/experiments/semantic-boundary-eval.ts candidate tests/fixtures/semantic-boundary-eval/holdout.json
```

Expected: baseline 13/40 with 19 missed block cases and zero false blocks; candidate 40/40 with zero
false blocks; holdout 18/18 with zero false blocks. Any score movement stops implementation until
the fixture conversion or policy change is explained.

- [ ] **Step 4: Commit Task 6**

```bash
git add scripts/experiments/semantic-boundary-eval.ts tests/scripts/semantic-boundary-eval.test.ts
git commit -m "refactor(quality): share boundary history core"
```

---

### Task 7: Validate the tranche and update the durable handoff

**Files:**
- Modify: `docs/superpowers/handoffs/2026-07-16-boundary-core-history-mining.md`
- Modify: `docs/publication-audit.md`
- Regenerate: `docs/work-index.json`
- Regenerate: `docs/work-index.md`

- [ ] **Step 1: Run focused suites together**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/semantic-fingerprint.test.ts \
  tests/scripts/semantic-history-provider.test.ts \
  tests/scripts/semantic-history.test.ts \
  tests/scripts/semantic-provenance.test.ts \
  tests/scripts/semantic-quality-check.test.ts \
  tests/scripts/semantic-boundary-eval.test.ts \
  --pool=forks --fileParallelism=false
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
bash scripts/run-with-pinned-npm.sh run typecheck:all
```

- [ ] **Step 2: Run test-integrity against every changed test**

Use the repository test-integrity command on the changed test set. Skipped, masked, timed-out, or
fallback validation is inconclusive and must be recorded as such.

- [ ] **Step 3: Request independent review**

Review at least these attack surfaces: canonicalization ambiguity, pagination truncation, provider
repository mismatch, stale-provenance ordering, cosmetic re-entry, override scope/expiry, secret or
comment-body leakage, receipt backward compatibility, and duplicate implementation in the
experiment. The lead verifies every decisive finding against source and tests before changing code.

- [ ] **Step 4: Update documentation inventories**

```bash
bash scripts/run-with-pinned-npm.sh run work-index:regen
bash scripts/run-with-pinned-npm.sh run guard:publication:all
bash scripts/run-with-pinned-npm.sh run guard:work-index
bash scripts/run-with-pinned-npm.sh run guard:doc-tally
```

Append exact commit OIDs, focused results, timing, frozen scores, review outcomes, and limitations to
the mining handoff. Explicitly state that no live GitHub provider, remote-tip adapter, hook/workflow
composition, external producer, CI run, or supply-chain blocker was exercised.

- [ ] **Step 5: Commit Task 7**

```bash
git add docs/superpowers/handoffs/2026-07-16-boundary-core-history-mining.md docs/publication-audit.md docs/work-index.json docs/work-index.md
git commit -m "docs(quality): record boundary core validation"
```

---

### Task 8: Final branch verification and authorized SSH push

- [ ] **Step 1: Inspect exact branch state**

Confirm branch name, exact HEAD, SSH origin, changed paths against PR A, and status. The only
permitted unrelated untracked path is `experiment-results.tsv`; it must remain unstaged.

- [ ] **Step 2: Run the complete branch gate**

```bash
loadgate run -- bash scripts/run-with-pinned-npm.sh run verify:push:branch
```

If `loadgate` is unavailable, record that fact and run the underlying command directly. A killed,
timed-out, masked, or skipped gate is inconclusive, not passing.

- [ ] **Step 3: Verify publication, history, and authorship state**

```bash
git diff --check origin/main...HEAD
git log --format='%H%x09%an%x09%ae%x09%s' a15b3d953589641c81fd8c228e34afeb1cba2d39..HEAD
git status --short
git remote get-url origin
```

Verify that every new commit contains only intended files and no prohibited attribution or email.

- [ ] **Step 4: Push the exact verified branch over SSH**

Push only after asserting that `HEAD`, branch name, remote URL, and worktree state still match the
verified receipt. Set upstream for `experiment/jul16-boundary-core-history`. Do not create a pull
request, issue, comment, review, or workflow rerun.

## Completion Criteria

- #1838/#1848-derived records compare equal by both canonical content and stable patch evidence.
- #1857-derived cosmetic re-entry blocks until its disposition conditions are materially addressed.
- Provider truncation, failure, cursor loops, mismatch, and incomplete artifacts are inconclusive.
- Proven remote/tracking mismatch blocks; stale overlap/high-coupling blocks; stale disjoint warns.
- Title/branch/path-only false-positive fixtures do not block.
- Historical policy absence renders `semantic.policy-unavailable`, not production unreachability.
- Human and JSON receipts carry equivalent action, evidence, reason, correction, rerun, source, and
  artifact meaning.
- The evaluator contains no second fingerprint/history/provenance implementation and remains 40/40
  plus 18/18 with zero false blocks.
- No hook, workflow, required context, ruleset, external service, issue, comment, or PR is mutated.
- The complete branch gate exits zero without masking; skipped external surfaces remain explicit.
