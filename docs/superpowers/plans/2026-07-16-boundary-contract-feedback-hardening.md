# Boundary Contract and Feedback Hardening Implementation Plan

**Status:** Pending

**Planning state:** Specification approved and direct in-scope falsifiers recorded; implementation
has not started.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing semantic-boundary contract fail closed on malformed or incomplete
runtime evidence and emit bounded, deterministic, action-specific feedback that can guide an
implementer's next attempt.

**Architecture:** Keep history, provenance, and semantic evaluators pure and unchanged in policy.
Add one runtime contract/canonicalization module and one rule-guidance catalog beneath
`scripts/lib/semantic-quality/`; make receipt version 2 bind the exact target, observation, rule
catalog, and evidence while retaining a version-1 reader. The CLI remains the only semantic adapter,
and history collection gains a bounded page-read decision without claiming cancellation of external
work that ignores its signal.

**Tech Stack:** Node `24.15.0`, npm `11.12.1`, TypeScript `5.9.3`, Vitest `4.1.8`, Node crypto,
existing Git helpers, existing atomic private-file writer, and no new runtime dependency.

**Specification:** `docs/superpowers/specs/2026-07-15-semantic-boundary-hygiene-design.md`

**Implementation notes:**
`docs/superpowers/handoffs/2026-07-16-boundary-contract-feedback-implementation-notes.md`

## Shared Evidence Contract

- Work from the exact repository root recorded by `git rev-parse --show-toplevel`; a command run from
  another directory is not evidence for this plan.
- The historical specification baseline is `1a7336984ea5bada47f0820e10c9decd53ad57f3`.
  `BCF_VALIDATOR_BASE` is instead the later, operator-observed planning-amendment commit whose tree
  contains the exact plan/specification/notes bytes used by Task 0; it is frozen from `git rev-parse
  HEAD` after this packet is committed and is never inferred from the historical hash. Each
  implementation task records its own exact pre-test and post-test head. Uncommitted state uses one canonical
  `BoundaryWorktreeSnapshot`: HEAD, index tree OID, HEAD-relative tracked binary-patch SHA-256,
  unstaged binary-patch SHA-256, sorted allowed-untracked regular-file path/mode/size/SHA-256 records,
  and sorted preserved owner-path records. Its fixed-key JSON SHA-256 is the diff identity. Bare
  `git diff`, staged-only output, or an untracked-blind digest is invalid evidence.
- Plan-review evidence is rooted at the external directory supplied through
  `PLAN_REVIEW_ARTIFACTS`; its machine-local value remains in the local operator handoff, not this
  public repository. Implementation evidence is rooted at
  `artifacts/verification/boundary-contract-feedback/<phase>/<run-id>/` and uses one immutable,
  non-reused run directory per task, review, reconciliation, or final gate. The generic
  `artifacts/` root and any reused `final/` directory are quarantined historical inputs and cannot
  satisfy this plan.
- Each run-scoped `run_manifest.json` is the evidence ledger for exactly one run. Before execution
  it records run ID, plan/spec/notes SHA-256, exact Git head and binary-diff SHA-256, observed
  `origin/main`, merge base, requested and observed tool versions, and exact argv. After execution
  it records direct exit/signal, UTC interval, stdout/stderr SHA-256, verdict, and SHA-256 for every
  referenced artifact. Finalization is append-only: changing or replacing a referenced artifact
  invalidates the manifest rather than silently retaining a green verdict.
- Verdicts are only `Pass`, `Fail`, `Inconclusive`, or `Blocked`. `Pass` requires every named
  artifact at the exact `entry|terminal|transition` head anchor owned by its closed attempt
  contract; no caller selects an anchor. A reproduced direct falsifier is `Fail`; missing authority is
  `Blocked`; missing tools, repo context, output, identity, timeout ownership, or complete evidence
  is `Inconclusive`.
- Preserve failed and superseded receipts under distinct paths. Never overwrite an earlier failure
  with a rerun, infer a producer status from a pipeline, or turn a skipped/unavailable tool into a
  clean result.
- If a named tool is unavailable, record the failed preflight and use only the fallback explicitly
  named in that task. If no fallback is named, stop that evidence lane as `Inconclusive`.

## Global Constraints

- This plan implements only priority 1 of the approved 2026-07-16 extension: runtime parsing,
  action identity, decision aggregation, limitation rendering, receipt identity, deterministic
  ordering, bounded output, redaction, and bounded history-provider settlement.
- Do not change semantic reachability, history matching/re-entry policy, provenance overlap policy,
  supply-chain policy, hooks, workflow composition, branch protection, required checks, or any
  external producer.
- All new decisions remain in the existing shadow composition. This plan does not authorize a
  ruleset or required-check promotion.
- Missing, malformed, stale, timed-out, over-budget, or contradictory **task/verification evidence**
  is `inconclusive`, never `pass`. Domain-specific history/provenance freshness remains a deferred
  detector-policy tranche.
- A valid deterministic block retains block precedence, but every unrelated limitation remains
  visible. A top-level limitation outranks warning/pass.
- Invalid CLI mode input and duplicate singleton options exit nonzero; they never fall back to
  shadow semantics.
- Runtime validation occurs after canonicalization. TypeScript types are not runtime evidence.
- `correlationIdSha256` remains a grouping identity. A separate `evidenceDigestSha256` covers the
  target, observation, limitations, rule versions, and canonical evidence.
- Human output is at most 64 KiB and shows at most 12 detailed findings. Canonical JSON is at most
  1 MiB and accepts at most 128 findings; per finding it accepts 64 observations, 16 artifacts,
  eight limitations, four corrections, eight verification steps, and 16 sources. Top-level
  limitations, fingerprints, total canonical records, and every public string have their own
  admission limits in `DEFAULT_BOUNDARY_BUDGETS`.
- Human grouping may summarize evidence retained in JSON. Evidence rejected from canonical JSON
  produces `boundary.evidence-volume-exceeded:inconclusive`; it is not silently truncated.
- Provider page reads receive an internal deadline and the collector settles if a provider ignores
  cancellation. The receipt must explicitly say that late provider work cancellation is unproven.
  External process-group ownership remains a later adapter task under SBH-012.
- Receipts contain no raw GitHub comments, secrets, emails, credential/query URLs, ANSI/control
  sequences, operator-local paths, or `file:` URLs.
- Use pinned runners: `bash scripts/run-with-pinned-node.sh` and
  `bash scripts/run-with-pinned-npm.sh`.
- Tests use `--pool=forks --fileParallelism=false` where process or timer cleanup matters. No raw
  sleeps; use fake timers, deterministic deferred promises, or bounded child-process probes.
- Preserve every pre-existing unrelated untracked path recorded by the local preflight and do not
  stage or modify it.
- Stage explicit paths. Commit messages contain no attribution trailers, model names, internal
  names, or personal/work email addresses.
- No GitHub issue, comment, review, label, PR, merge, workflow rerun, ruleset, or repository setting
  mutation is authorized by this plan.

## Orchestration State Machine

1. Complete deterministic plan-review passes 1–27 in ascending order and require the fail-closed
   closeout gate.
2. Run repository documentation/publication/index guards and commit only the specification, plan,
   implementation notes, audit rows, and regenerated index.
3. Implement and commit the three-file run validator before any fetch or merge; accept no bootstrap
   completion claim until the committed helper re-runs its positive and negative controls.
4. Create unique observation and reconciliation runs, refresh the remote, reconcile the planning
   lineage without discarding work, and complete the predecessor focused/evaluator/branch gates.
   Produce the corrected per-case 39/40 oracle; the historical 40/40 file remains superseded.
5. Refresh run-scoped `readiness.json`; begin BCF-01 only if those prerequisites pass and the state
   becomes `Ready with Constraints`.
6. Execute BCF-01 through BCF-07 sequentially. Before each task, verify its dependency commits,
   exact entry head/diff, owner/write scope, due assumptions, and artifact directory.
7. Dispatch the three independent read-only reviews in unique review runs after BCF-07. Require the
   lead to reproduce every decisive finding before BCF-08A.
8. Execute BCF-08A documentation/index guards and finalize its unchanged-head dirty-docs snapshot;
   then execute BCF-08B pre-commit verification, lineage/staged scope audits, explicitly record the
   post-commit final gate as pending in tracked notes, and commit the evidence-backed docs locally.
9. Initialize the unique final run at that exact docs commit, join the review/reproduction receipts,
   refresh upstream, prove A-06, run the complete branch gate, finalize/hash-lock, and verify.
10. Report the ignored helper-owned final manifest/closeout receipt as authoritative for post-commit outcomes;
    do not rewrite the tracked handoff to self-report evidence produced after its own commit. Stop
    before external mutation.

At every transition, update the active manifest. Update the tracked implementation notes only
through the BCF-08B documentation commit; BCF-08C transitions write only the ignored helper-owned
final manifest and closeout receipt. A missing artifact, contradictory verdict, new falsifier,
scope change, overlapping writer, or stale head returns the state to the last verified checkpoint.
Fluent summaries, progress-only worker output, or an earlier green run do not advance the state.

---

## Scope and Exit Criteria

The plan is complete only when all of these are proven at one exact Git head:
For readability, every subsequent artifact reference that omits `<phase>/<run-id>` is a logical
manifest-relative name inside its unique
`artifacts/verification/boundary-contract-feedback/<phase>/<run-id>/` directory, even when the
printed prefix appears complete. It is hash-listed by that run's manifest; no printed fixed path is
reusable evidence.

| Criterion | Required proof | Required evidence artifact |
|---|---|---|
| CLI fails closed | Invalid/missing/duplicate singleton options emit `semantic.invocation-invalid`, record enforce semantics, and exit 2 | `artifacts/verification/boundary-contract-feedback/task01/semantic-quality-check.log` |
| Runtime contract is closed | Unknown decisions/actions/modes, invalid identities, blank nested fields, invalid fingerprints, and duplicate finding identities cannot produce a receipt pass | `artifacts/verification/boundary-contract-feedback/task03/boundary-contract-tests.log` |
| Decision algebra is honest | `warn + limitation` is inconclusive/exit 2; a complete block plus unrelated limitation remains block and visibly renders the limitation | `artifacts/verification/boundary-contract-feedback/task04/receipt-contract-tests.log` |
| Feedback is corrective | Every non-pass result renders observed, expected, impact, safe control, correction, verification, rerun, sources, and limitations | `artifacts/verification/boundary-contract-feedback/task05/renderer-tests.log` |
| Evidence is bound | Changing target, head, observation time, limitation, rule version, or evidence changes `evidenceDigestSha256`; prose-only summary changes do not change the evidence digest | `artifacts/verification/boundary-contract-feedback/task04/evidence-digest-tests.log` |
| Output is bounded | Human and JSON byte/cardinality boundaries have exact at-limit and one-over-limit tests; rejected evidence is reported with counts/digest | `artifacts/verification/boundary-contract-feedback/task05/output-budget.json` |
| Ordering is deterministic | Reversing input findings with distinct canonical identities produces byte-identical receipts; exact duplicate identities fail closed | `artifacts/verification/boundary-contract-feedback/task04/ordering-tests.log` |
| Redaction is complete | Quoted, assigned, parenthesized, and `file:` local paths redact alongside existing secret/query controls | `artifacts/verification/boundary-contract-feedback/task03/redaction-tests.log` |
| Provider decision settles | A provider that resolves, throws timeout, honors abort, or ignores abort produces a bounded terminal collection result | `artifacts/verification/boundary-contract-feedback/task06/provider-deadline-tests.log` |
| Compatibility is visible | Schema-1 receipts still render/read; schema-2 is emitted by current builders; all known consumers are inventoried and tested | `artifacts/verification/boundary-contract-feedback/task07/consumer-inventory.txt` |
| Regression oracle holds | Baseline 13/40, candidate 39/40 with zero false blocks/missed critical cases, holdout 18/18 | `artifacts/verification/boundary-contract-feedback/task07/evaluator-results.json` |
| Repository gates hold | Focused suites, script/all typechecks, test-integrity, docs/publication/index guards, watchdog canary, and final branch gate complete without masking | `artifacts/verification/boundary-contract-feedback/final/<run-id>/run_manifest.json` |

Failure of a required command, timeout, signal, missing artifact, skipped check, or masked pipeline is
`Inconclusive`, not a passing result. A direct falsifier that still reproduces makes the tranche
`Fail` even if the existing focused suite remains green.

## Assumption Register

### A-01 — All receipt-builder consumers are locally discoverable

- **Statement/category:** Every in-repository TypeScript caller of `buildBoundaryReceipt()` or
  `buildSemanticReceipt()` is discoverable by exact source search; compatibility remains an
  interface assumption for consumers outside this repository.
- **Source/importance:** `scripts/lib/semantic-quality/receipt.ts` and Task 4. A missed local caller
  creates a compile/runtime regression; an external schema-1 consumer can break on producer change.
- **Evidence/quality:** Direct for local source via `rg`; missing for unknown external consumers.
- **Risk/blast radius:** Receipt creation, evaluator, CLI, tests, and any unobserved external reader.
- **Validation:** Run
  `rg -n "buildBoundaryReceipt\(|buildSemanticReceipt\(|schemaVersion" scripts tests docs --glob '*.ts' --glob '*.md'`
  and save `artifacts/verification/boundary-contract-feedback/task04/consumer-inventory.txt`.
- **Owner/due/disposition:** Task 4 implementer; before signature change; **Constrained** by schema-1
  read/render compatibility and a no-fabricated-v2-target rule.

### A-02 — The current rule inventory is complete for this tranche

- **Statement/category:** The Task 2 catalog covers every rule emitted by current semantic,
  history, provenance, CLI, receipt, and provider paths; later-tranche rule IDs are excluded.
- **Source/importance:** `CURRENT_RULES` in Task 2. Missing catalog entries must fail closed rather
  than invent generic feedback.
- **Evidence/quality:** Direct source inventory is available but must be refreshed after Task 1.
- **Risk/blast radius:** Canonical finding construction for every boundary action.
- **Validation:** Use only Task 2 Step 1's four helper-owned inventory attempts and exact source
  list/pattern, including `boundary|semantic|history|provenance|supply-chain|process` and
  `scripts/experiments/semantic-boundary-eval.ts`. Require its immutable normalized 29-ID artifact,
  then perform the stated four-way producer/planned/catalog/fixture comparison in
  `artifacts/verification/boundary-contract-feedback/task02/rule-inventory.diff`. A shorter ad hoc
  `rg` result cannot resolve A-02.
- **Owner/due/disposition:** Task 2 implementer; before catalog commit; **Unresolved** until the
  generated inventory has no unexplained entry on either side.

### A-03 — Declared output budgets are usable at ordinary repository scale

- **Statement/category:** 1 MiB canonical JSON, 64 KiB human output, 128 findings, and 12 detailed
  human findings retain enough corrective context for current repository observations.
- **Source/importance:** Approved specification and Task 5. Too-low bounds create routine
  inconclusive results; too-high bounds recreate log/context exhaustion.
- **Evidence/quality:** Indirect calibration: 45 findings, 513 observations, 90 corrections, and
  about 57 KB of repetitive human output at the prior exact head.
- **Risk/blast radius:** Local agents, CI logs, receipt storage, and every non-pass action.
- **Validation:** Run exact at-limit/one-over-limit fixtures plus the frozen current-head fixture;
  save byte/count results in
  `artifacts/verification/boundary-contract-feedback/task05/output-budget.json`.
- **Owner/due/disposition:** Task 5 implementer; before renderer commit; **Constrained**. Do not
  promote enforcement if ordinary complete evidence overflows after grouping.

### A-04 — An internal deadline can bound a decision but not prove cancellation

- **Statement/category:** `Promise.race` plus an internal abort controller settles collection even
  when a provider ignores abort; it cannot prove that the provider's external work stopped.
- **Source/importance:** `history-provider.ts` and Task 6. Conflating decision settlement with work
  ownership can leak requests or processes after the check returns.
- **Evidence/quality:** Direct unsafe ignored-abort probe; external cancellation remains missing.
- **Risk/blast radius:** Provider resources, late writes, test process liveness, and action evidence.
- **Validation:** Four fake-time controls and late resolve/reject observation; save
  `artifacts/verification/boundary-contract-feedback/task06/provider-deadline-tests.log`.
- **Owner/due/disposition:** Task 6 implementer; before provider commit; **Replaced** for this tranche
  by explicit `history.provider-late-work-unproven`. Process ownership stays deferred.

### A-05 — Frozen evaluator scores are a regression oracle, not a generalization claim

- **Statement/category:** Baseline 13/40, candidate 39/40, and holdout 18/18 detect unintended policy
  drift while leaving the warning-only similar-issue mismatch unchanged.
- **Source/importance:** Approved corpus/holdout and Task 7. Changing labels or policy to make the
  contract work would invalidate the experiment boundary.
- **Evidence/quality:** Direct prior deterministic runs; stale until replayed at the implementation
  head.
- **Risk/blast radius:** Semantic/history/provenance decision policy and claimed false-block rate.
- **Validation:** Run all three exact Task 7 evaluator commands; save structured output in
  `artifacts/verification/boundary-contract-feedback/task07/evaluator-results.json`.
- **Owner/due/disposition:** Task 7 implementer; before integration commit; **Constrained**. Any score
  change blocks this contract-only tranche pending root-cause review.

### A-06 — Final verification tools exist and own the claimed boundary

- **Statement/category:** The installed test-integrity executable is callable, and GNU timeout—not
  `loadgate`—owns the complete branch-gate process group and deadline.
- **Source/importance:** Task 8 final verification. Tool presence or admission control alone is not
  timeout/cancellation evidence.
- **Evidence/quality:** Direct `file`/help preflight observed during planning; runtime ownership canary
  is still missing.
- **Risk/blast radius:** Final completion claim and any child process left after timeout.
- **Validation:** Preflight both executables, run a harmless child-process deadline canary before the
  branch gate, and save status/process evidence under
  `artifacts/verification/boundary-contract-feedback/final/<run-id>/watchdog-canary/`.
- **Owner/due/disposition:** Final verifier; before full branch gate; **Unresolved** until the canary
  proves the owned child group is reaped.

### A-07 — No enforcement or external mutation is authorized

- **Statement/category:** Current approval covers local docs, implementation, tests, and commits,
  but no GitHub or external producer mutation and no hook/workflow/ruleset promotion.
- **Source/importance:** Owner request, repository instructions, and this plan's global constraints.
- **Evidence/quality:** Direct current authority boundary.
- **Risk/blast radius:** Public repository state, collaborators, and agent enforcement behavior.
- **Validation:** Inspect final changed paths and external-action ledger; save
  `artifacts/verification/boundary-contract-feedback/final/<run-id>/scope-audit.txt`.
- **Owner/due/disposition:** Lead; every task and handoff; **Validated** for this plan. Stop if later
  work needs a broader action.

### A-08 — Upstream and predecessor evidence must be reconciled before implementation

- **Statement/category:** The planning head was 61 commits behind and 30 commits ahead of the
  audit-time fetched `origin/main` observation `bf8e03cd82e66fc37c55a980526388a2fd3d98fb`;
  later shared metadata moved to `6a9e569c81e4362ecd100ed84bbb5905867c1e6a` and 63/30 without this
  lane fetching, so live state is unknown. The predecessor
  semantic/history tranche has focused evidence but no completed final branch-gate receipt.
- **Source/importance:** Direct local Git observation after SSH fetch plus the predecessor handoff.
  Schema work on a stale base or an unclosed predecessor can repeat already-landed changes and reuse
  invalid green evidence.
- **Evidence/quality:** Direct for the observed remote-tracking OID, merge base
  `b3452a27e168daf48a825acbf408b3f5e43932fc`, and ahead/behind counts; live state becomes stale on the
  next upstream move. The missing predecessor gate is directly documented.
- **Risk/blast radius:** Every shared semantic-quality source, test, gate, and schema consumer.
- **Validation:** In a unique pre-implementation run, fetch through the SSH remote, record the new
  remote OID, inspect overlap, reconcile without destructive Git, rerun predecessor focused suites
  and all per-case evaluators, then run its complete branch gate with direct process ownership.
- **Owner/due/disposition:** Lead; before BCF-01 RED; **Unresolved blocker**. Only reconciliation and
  evidence collection are allowed while unresolved; no BCF production mutation may start.

### A-09 — Artifact identity is immutable and run-scoped

- **Statement/category:** Existing generic artifact paths contain a semantic run manifest whose
  referenced readiness/final-review files were later replaced by an unrelated run while validation
  remained green.
- **Source/importance:** Direct on-disk manifest/hash audit. Reusable paths let stale or foreign
  evidence impersonate current proof.
- **Evidence/quality:** Direct for the observed mixed root; that root is quarantined, not repaired or
  relabeled clean.
- **Risk/blast radius:** Plan review, task readiness, reviewer joins, branch gates, and final claims.
- **Validation:** Every new run uses a unique directory and a manifest containing target document
  hashes, head/diff, command status, log hashes, and all artifact hashes. A validator must fail after
  any referenced artifact byte changes or any head/diff mismatch.
- **Owner/due/disposition:** Lead and each task owner; before accepting any new artifact;
  **Unresolved blocker** until the pre-implementation manifest negative control passes.

### A-10 — Lifecycle and evaluator-oracle disposition are canonical

- **Statement/category:** Immutable plans, handoffs, work indexes, and evaluator outputs currently
  disagree about pending/completed state, predecessor final-gate status, and the superseded 40/40
  candidate result.
- **Source/importance:** Direct tracked-doc and on-disk artifact comparison. Agents can otherwise
  repeat completed work or optimize against an invalid oracle.
- **Evidence/quality:** Direct for the conflicting status fields and historical artifacts. The
  corrected 39/40 outcome is documented but lacks a same-head raw per-case receipt.
- **Risk/blast radius:** Task dispatch, duplicate implementation, score tuning, branch supersession,
  and completion claims.
- **Validation:** Maintain a machine-readable run-scoped lifecycle record with plan/status,
  completion commit, final-gate state, successor/supersession links, and oracle disposition. Replay
  all cases and bind the raw corrected 39/40 result to the reconciled head; totals without cases fail.
- **Owner/due/disposition:** Lead; before BCF-01 RED; **Unresolved blocker**. The old 40/40 file is a
  preserved failed attempt and never a positive control.

## Primary Validation Rules

Every task uses the exact command printed in that task and writes stdout/stderr plus the direct exit
status beneath its required evidence directory. Do not pipe the test command through `tee`; if live
display is needed, run it through a wrapper that separately preserves the producer status. A red
phase passes only when the new assertion fails for the predicted missing behavior. A green phase
passes only when the same assertion and its neighboring safe control pass at the same working-tree
diff. An unexpected red failure is `Inconclusive` until classified.

| Validation question | Current evidence | Required check and threshold | Failure disposition |
|---|---|---|---|
| Does a step depend on something unverified? | A-02, A-03, A-06, A-08, A-09, and A-10 remain unresolved/constrained | Satisfy each assumption at its named checkpoint before the dependent commit | Stop that task as `Inconclusive` or `Blocked` per the assumption |
| Is an interface contract unconfirmed? | Current receipt types and all callers are source-visible; external readers are unknown | Task 4 inventory must cover every local builder/schema consumer; schema-1 read fixture must pass | No schema-2 integration commit |
| Are preconditions missing? | Pinned Node/npm wrappers, exact repo root, unique evidence root, reconciled task base, and preserved unrelated work are named | Preflight paths, versions, exact head/diff, upstream OID, lifecycle record, and unrelated paths before every task | Preserve receipt and stop before mutation |
| Are dependencies out of order? | Task 4 consumes Tasks 2–3; Task 5 consumes Task 4; Task 7 consumes Tasks 1–6; Task 8 consumes all | `git log --oneline` and focused test artifact must show each producer task completed first | Reorder; do not fabricate compatibility shims |
| Are task boundaries falsely independent? | Tasks share receipt/types/tests and therefore are intentionally sequential | One owner edits shared files at a time; independent read-only review may run concurrently | Overlapping writers block dispatch |
| Can a step look green while failing? | Known traps include shadow fallback, warning-plus-limitation, duplicate identity order, ignored abort, and masked pipelines | Run every named unsafe/safe pair and assert exact decision, output field, byte count, and process status | Reproduced falsifier is `Fail` |
| Are fallbacks executable? | Only test-integrity has a named repository fallback; provider cancellation has no process-owned fallback | Preflight the primary tool; execute only the named fallback and retain both receipts | Missing unnamed fallback is `Inconclusive` |
| Is rollback specific and safe? | Task-level commits and dependency-aware rollback order are named | `git show --stat` must prove the rollback slice; use `git revert`, never destructive reset/restore | Stop if the slice overlaps unrelated work |
| Are exit conditions concrete? | Scope table binds each criterion to a run-scoped artifact | Final manifest must hash every artifact at one exact head/diff and all required commands must exit zero | Any gap or post-finalization byte change prevents plan completion |
| Is hidden operator judgment left? | Rule strings, budgets, precedence, schema, and provider limitation are fixed in this plan | Any semantic-policy or budget change requires a plan/spec amendment before code | Unplanned judgment is `Blocked` pending owner review |

The primary validation record is
`artifacts/verification/boundary-contract-feedback/primary_validation.md` with columns for validation
question, evidence reviewed, finding, severity, affected task/section, required fix, status, and final
verdict. It explicitly hunts hidden coupling, circular dependencies, sequencing gaps, invisible
manual work, implied approvals, weak completion signals, partial-success traps, and silent failure.
The record may conclude `Pass` for plan executability while implementation remains pending or
blocked by named preconditions; it may not claim implementation correctness or execution readiness.

## Layered Validation Escalation

This tranche changes an agent-facing trust boundary, decision algebra, durable evidence identity,
and timeout behavior. Secondary and tertiary validation are mandatory; repeating the focused unit
suite or paraphrasing its assertions is not an independent layer.

| Layer | Trigger and failure class | Distinct required methods | Evidence artifact | Blocking rule |
|---|---|---|---|---|
| Primary | Every task; direct implementation error | Red-before-green unsafe/safe controls, focused Vitest, exact exit/byte assertions | Per-task logs named in the scope table and `primary_validation.md` | Unexpected red, any nonzero green, or missing producer status is `Inconclusive` |
| Secondary | Runtime trust, receipt identity, redaction, async settlement, or shared-interface change | Counterfactual one-field digest tests; reversed-order replay; at-limit/one-over-limit stress; fault-injected receipt write/provider timeout; schema-1 consumer inventory | `artifacts/verification/boundary-contract-feedback/validation_layer2.md` plus raw task artifacts | Any unexplained false pass, false block, leak, order drift, or consumer gap is `Fail` |
| Tertiary | Agentic/safety boundary and final completion claim | Independent read-only review of the exact diff; lead reproduction of decisive findings; frozen corpus/holdout replay; test-integrity scan; process-group watchdog canary; complete branch gate | `artifacts/verification/boundary-contract-feedback/validation_layer3.md` plus final manifest | Skipped independent review, unowned timeout, changed oracle, or masked branch gate is `Inconclusive`; reproduced critical falsifier is `Fail` |

Each layer artifact records layer, reason invoked, methods, exact head/diff identity, evidence
reviewed, findings and severity, disposition, residual risk, and verdict. Secondary validation
targets semantic counterexamples and failure injection; tertiary validation targets independent
reproduction, orchestration integrity, and whole-branch composition.

OpenAPI fuzzing, browser DAST, deployment canaries, and live GitHub-provider tests are **Not
applicable** to this local pure-library/CLI tranche. That scope mismatch is recorded rather than
silently skipped. If later implementation adds a network route, live provider, hook promotion, or
hosted enforcement surface, this classification becomes stale and the tranche is `Blocked` pending
a plan amendment with authorized environment-specific validation.

## Evidence and Observability Schema

This is execution/review telemetry for the boundary tranche, not a new application logging
subsystem. Each task appends fixed-key JSONL events beneath its run directory and references the raw
stdout/stderr, test, diff, and receipt artifacts. A summary without the raw producer status is not
evidence.

```json
{
  "timestamp_utc": "RFC3339 UTC",
  "run_id": "boundary-contract-taskNN-unique",
  "service": "whatsoup-boundary-quality",
  "env": "local|ci",
  "trace_id": "correlationIdSha256 or null",
  "span_id": null,
  "event": "input|decision|execution|validation|output|change|audit",
  "action": "parse|canonicalize|build-receipt|render|collect-history|test|typecheck|branch-gate",
  "actor": "lead|task-owner|test-runner|boundary-cli",
  "result": "Pass|Fail|Inconclusive|Blocked",
  "inputs": {
    "git_sha": "40-hex exact head",
    "diff_identity": "sha256 or null",
    "target_identity": "redacted public boundary target"
  },
  "evidence": {
    "artifact_paths": ["artifacts/verification/boundary-contract-feedback/taskNN/output.log"]
  },
  "error": {
    "type": "bounded public error class or empty",
    "message": "bounded redacted diagnostic or empty"
  }
}
```

| Event layer | Purpose and minimum fields | Storage/replay rule |
|---|---|---|
| Input | Exact head/diff, action, repository/target identity, tool versions, budgets, provider deadline | Retain the canonical input/receipt identity; never retain raw comments, secrets, emails, query URLs, local paths, or `file:` URLs |
| Decision | Rule/version, decision, evidence state/digest, limitations, overflow counts | Receipt JSON is authoritative; human output must be reproducible from it |
| Execution | Exact argv, cwd, start/end UTC, direct exit/signal, duration, stdout/stderr paths, timeout owner | Preserve each attempt separately, including failed and superseded attempts |
| Validation | Test IDs/counts, expected red/green reason, direct status, exact head/diff, artifact paths | Re-run from the printed command; an unexpected red is not accepted evidence |
| Output | JSON/human byte counts, detailed/grouped/omitted counts, receipt digest/path | Compare human and JSON semantic fields and declared budgets |
| Change | Task/commit, changed paths, before/after schema, rollback commit/slice | Bind to `git show --stat` and the implementation-notes commit table |
| Audit | Owner/actor, authorization boundary, external-action count, skipped/unavailable tools, final verdict | Final manifest and handoff must reconstruct all confidence-affecting decisions |

Unknown runtime values, parse fallback, evidence limitation, receipt-write failure, overflow,
provider timeout/late work, tool absence, signal, deadline, load-admission failure, skipped layer,
oracle drift, and rollback are never silent. Tests validate the event/receipt fields, redaction, and
human/JSON equivalence; the final scope audit rejects any missing referenced artifact. Coverage
regresses if a new decision/error exit lacks a rule, receipt/event assertion, and replay command.

Keep the complete task/final artifact set reviewable until the branch is integrated or abandoned
and the final owner decision is recorded. Preserve the implementation notes and tracked tests after
artifact retirement; never delete task evidence during an active review or replace a failed attempt
with a successful rerun.

## Execution Readiness Gate

| State | Evidence threshold | Allowed next action |
|---|---|---|
| `Ready` | Objective/scope stable; all critical assumptions validated; dependencies/contracts/execution seams verified; tasks, validation, telemetry, owners, rollback, and success/failure signals complete; no open risks or blockers | Begin the next task's red phase |
| `Ready with Constraints` | Plan evidence is complete enough to begin, no current blocker exists, and every residual risk has an owner, checkpoint, artifact, and stop condition before its dependent task | Begin only the next action named in `readiness.json`; do not cross a constrained checkpoint |
| `Not Ready` | Missing authority, unstable scope, unresolved critical assumption due now, unverified contract, missing execution seam, overlapping writer, or absent validation/rollback evidence | No implementation mutation; gather named evidence or amend the plan |

The helper-owned `readiness-check` derives and records
`artifacts/verification/boundary-contract-feedback/readiness/<run-id>/readiness.json` before Task 1
and refreshes it in a new run after any scope, interface, tool, authority, upstream, or falsifier
change. Its complete keyset, value grammar, evidence relations, and canonical order are the closed
`ReadinessRecord` contract below; no lead-authored prose file is accepted as readiness evidence. The
owner authorizes scope and external actions; the lead owns the evidence-backed local execution
decision. A worker or green test cannot self-authorize crossing a readiness blocker.

Current execution state is **Not Ready for BCF-01**. The objective, scope, tasks, falsifiers,
validation layers, telemetry, owners, and rollback are explicit, but A-08, A-09, and A-10 are due
before the first RED and are unresolved blockers. The only allowed next action is the read-only or
Git-normal reconciliation preflight: create the immutable manifest negative control, refresh and
reconcile upstream without discarding work, close the predecessor final gate, and produce the
canonical lifecycle plus raw per-case 39/40 oracle. After those pass, readiness may become `Ready
with Constraints` for BCF-01; A-02 remains due before Task 2, A-03 before Task 5, and A-06 before the
final branch gate. Any new policy behavior, external mutation, enforcement promotion, or unexpected
corpus score keeps or returns the state to `Not Ready` until resolved.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `scripts/lib/verification/boundary-run-manifest.ts` | create | Canonical worktree snapshot, run/artifact/lifecycle schemas, hash validation, and immutable finalization |
| `scripts/verify-boundary-run.ts` | create | Exact `init`, `record-command`, `record-internal-check`, `record-git-transition`, `record-artifact`, `record-child-run`, `record-review`, `set-upstream`, `set-lifecycle`, `finalize`, `verify`, `closeout`, and `verify-closeout` CLI |
| `tests/scripts/verify-boundary-run.test.ts` | create | Staged/unstaged/untracked identity, expectation, artifact registration/mutation, foreign-head, lifecycle, finding-level review join, and finalized-run controls |
| `scripts/lib/semantic-quality/boundary-types.ts` | modify | Separate untrusted finding input, canonical v2 finding, receipt target, overflow, and schema-1/v2 types |
| `scripts/lib/semantic-quality/rule-guidance.ts` | create | Stable current-rule versions and expected/control/verification guidance; catalog digest |
| `scripts/lib/semantic-quality/boundary-contract.ts` | create | Runtime enum/identity/nested-field validation, canonical evidence, deterministic finding identity, redaction, and limits |
| `scripts/lib/semantic-quality/receipt.ts` | modify | Build schema-2 receipts, aggregate limitations honestly, render bounded contextual output, retain schema-1 reader and atomic writer |
| `scripts/semantic-quality-check.ts` | modify | Reject duplicate/malformed options and make invalid invocation exit 2 without shadow fallback |
| `scripts/lib/semantic-quality/history-provider.ts` | modify | Add bounded page-read settlement and explicit late-work limitation |
| `scripts/lib/semantic-quality/policy.ts` | modify | Adapt current semantic findings to catalog-owned structured guidance and explicit evidence state |
| `scripts/lib/semantic-quality/history.ts` | modify | Adapt current history findings to catalog-owned structured guidance and explicit evidence state |
| `scripts/lib/semantic-quality/provenance.ts` | modify | Adapt current provenance findings to catalog-owned structured guidance and explicit evidence state |
| `tests/scripts/semantic-boundary-contract.test.ts` | create | Runtime contract, action identity, digest, ordering, redaction, and cardinality boundary tests |
| `tests/scripts/semantic-rule-guidance.test.ts` | create | Catalog coverage, version, corrective-field, and digest tests |
| `tests/scripts/semantic-quality-check.test.ts` | modify | CLI, decision algebra, renderer, schema compatibility, and byte-budget integration tests |
| `tests/scripts/semantic-history-provider.test.ts` | modify | Resolving, throwing, aborting, and cancellation-ignoring provider deadline tests |
| `tests/scripts/semantic-quality-policy.test.ts` | modify | Guidance-free semantic producer inputs and unchanged decision fixtures |
| `tests/scripts/semantic-history.test.ts` | modify | Guidance-free history producer inputs and unchanged duplicate-policy fixtures |
| `tests/scripts/semantic-provenance.test.ts` | modify | Guidance-free provenance producer inputs and unchanged stale-overlap fixtures |
| `tests/scripts/semantic-boundary-eval.test.ts` | modify | Schema-2 delegation and per-case decision/rule regression assertions |
| `docs/public-surface.md` | modify | Document schema-2 evidence identity, output bounds, exits, and schema-1 read compatibility |
| `docs/publication-audit.md` | verify unchanged during implementation | Planning commit already classifies this plan and implementation notes as `PRIVATE-ARCHIVE`; BCF-08 reruns the guard without duplicating rows |
| `docs/work-index.json` / `docs/work-index.md` | regenerate | Keep tracked planning inventory current |
| `docs/superpowers/handoffs/2026-07-16-boundary-contract-feedback-implementation-notes.md` | modify | Replace planning placeholders with exact falsifiers, commits, verification receipts, limitations, and deferred tranches before its tracked commit |

`boundary-contract.ts` owns runtime trust and canonicalization. `rule-guidance.ts` owns stable rule
metadata. `receipt.ts` composes those modules and owns rendering/storage; it must not grow a second
validator or policy catalog.

## Reuse-First Decision Record

Before each new symbol/file, refresh
`artifacts/verification/boundary-contract-feedback/reuse_audit.md` with exact `rg` results across
source, tests, docs, and Git history. Reuse or extend the existing owner unless the table's rejection
reason still holds. A second sanitizer, decision aggregator, receipt writer, policy evaluator,
provider collector, rule catalog, or renderer blocks the task.

| Need | Existing surface inspected | Decision and reason |
|---|---|---|
| Runtime finding/target types | `boundary-types.ts` | Extend and preserve `BoundaryFinding` alias during migration; do not create a parallel public type tree |
| Secret/query/local-reference safety | `artifact-redaction.ts`, receipt sanitizers, private writer | Reuse `assertNoSecretLike`, existing reference/identity semantics, and atomic writer; centralize post-canonical field validation in `boundary-contract.ts` because the current completeness check runs too early |
| Stable rule language | `receipt.ts` `FINDING_LANGUAGE`, history/provenance finding factories | Replace the semantic-only language map with one rule-guidance SSOT; distributed producer `why`/correction remains input evidence, not a second version catalog |
| Receipt build/render/write | `receipt.ts` | Extend the existing module and keep compatibility aliases; no second receipt implementation or storage path |
| Decision aggregation | `aggregateBoundaryDecision()` | Extend the existing function with limitations; do not add action-specific aggregators |
| CLI parsing | Existing `choice()`, option loop, and `runSemanticQuality()` | Reuse the loop/choice checks and add singleton/value guards; no parser dependency or second CLI |
| Provider deadline | `collectHistory()` plus `HistoryProvider.readPage()` | Extend the current collector with per-page settlement; no wrapper provider or claimed external cancellation layer |
| Evaluator logic | Production graph/policy/history/provenance/receipt imports | Adapt to schema 2 only; anti-duplication tests reject local contract/guidance/renderer definitions |
| Test execution and artifact writing | Pinned Node/npm wrappers, Vitest, current private writer, repository gates | Reuse exact runners/gates; add no dependency, test harness, hook, or workflow in this tranche |

Reject speculative generalization: repository identity remains the approved literal, rule versions
remain integer `1`, budgets remain one frozen default object, and provider deadlines remain a
collector input. General multi-repository schemas, plugin registries, pluggable renderers, or a new
logging framework require observed demand and a separate plan.

## Blast Radius and Containment

| Surface | Direct/indirect impact | Coordination and proof | Containment/rollback |
|---|---|---|---|
| `boundary-types.ts` | Direct type change; history, provenance, receipt, CLI, evaluator, and tests import `BoundaryFinding` | Preserve temporary alias and run script/all typechecks plus consumer inventory | Revert dependents before BCF-03 types |
| `boundary-contract.ts` | New sole trust boundary for target/finding/limitation/digest/budgets/redaction | Contract tests must cover every nested field and safe neighbor | Remove only after receipt/evaluator no longer import it |
| `rule-guidance.ts` | New version/expected/control/verification SSOT for all current rules | A-02 inventory parity and catalog digest tests | Revert after schema-2 canonical findings are removed |
| `receipt.ts` | Producer schema changes 1→2; aggregation, digest, human output, byte budgets, aliases, and atomic writes affect CLI/evaluator/test consumers | Inventory every local caller/reader; retain schema-1 read/render fixture; document producer change | Revert BCF-07, then BCF-05/04; no stored-data migration |
| `semantic-quality-check.ts` | Invalid invocation now always exits 2/enforce; valid shadow invocations still exit zero | Subprocess tests assert argv, direct status, JSON/human, and receipt write failure | Revert BCF-07 then BCF-01 |
| `history-provider.ts` | Page decisions gain 5-second default; callers may now receive timeout/late-work limitations instead of hanging | Inventory collector callers; four lifecycle controls; no cancellation claim | Revert BCF-06 independently; retain unsafe fixture |
| Evaluator/corpora | Schema adaptation only; policy scores/labels must not change | Anti-duplication imports and frozen 13/40, 39/40, 18/18 replay | Revert BCF-07; never relabel corpus |
| Public CLI/receipt schema | JSON consumers see v2 fields and deterministic sorting; human consumers see richer bounded sections | `docs/public-surface.md`, schema-1 compatibility, external consumers reported unknown | Keep v1 reader; rollback producer integration if a named consumer breaks |
| Agent/CI context | Fewer repeated details, visible limitations, explicit next action; no enforcement promotion | Exact byte/section equivalence and later correction-rate trial | Shadow remains; remove integration while retaining diagnostic library |

No database migration, queue, cron, scheduler, service route, RBAC/role, runtime permission, feature
flag, deployment, dashboard, or alerting backend changes in this tranche. The trust boundary is the
local CLI/library accepting untrusted runtime/provider values and producing agent-visible/durable
receipts. If implementation touches any excluded operational surface, readiness becomes `Not Ready`
until scope and validation are amended.

Partial commits are not deployable milestones. Each task must typecheck and pass its focused tests,
but only BCF-08C can support a whole-branch completion claim. Schema-2 producer rollout has no data
migration because receipts are ephemeral evidence; unknown durable/external readers remain a
reported compatibility risk, not an assumed clean surface.

## Error and Exception Model

| Error class | Detection and handling | User/agent-visible result | Operator evidence and containment |
|---|---|---|---|
| Invalid CLI option/value/duplicate | Strict parser throws; diagnostic options ignore malformed target/path/mode | `semantic.invocation-invalid`, enforce, inconclusive, exit 2 | Direct argv/status/stdout artifact; correct invocation only, no automatic retry |
| Invalid runtime contract | Post-canonical enum/identity/nested-field validation returns exact codes | `boundary.contract-invalid` or action-specific inconclusive guidance; never pass | Contract error codes plus rejected-field class, no raw value; isolate one-field falsifier |
| Missing action identity | V2 builder validates exact Git head or task fingerprint | `boundary.action-identity-unproven:inconclusive` with safe correction/rerun | Target/head evidence digest; stop commit/push/PR/issue action |
| Incomplete/contradictory evidence | Canonical limitations and provider completeness checks | Block remains block with visible limitation; otherwise limitation makes decision inconclusive | Receipt limitations, sources, evidence digest; repair named source and rerun whole action |
| Evidence volume | Cardinality/byte check raises only the named contract code | One bounded overflow receipt with structural counts/partial descriptor digest; enforce exit 2 | Output-budget JSON and bounded admission descriptor; reduce/page producer evidence |
| Receipt-write failure | Atomic writer error is composed through v2 builder | `semantic.receipt-write-failed:inconclusive`; in-memory result is not durable proof | Destination class, direct write error, retained original findings; repair destination and rerun |
| Provider exception/timeout/ignore-abort | Page promise is observed and raced against owned timer | Incomplete history plus timeout and late-work-unproven limitations | Timer/listener lifecycle log; no page retry and no cancellation claim; stop pagination |
| Missing Git/tool/dependency | Preflight or direct process status | Inconclusive diagnostic; no clean fallback except named test-integrity repository lane | Attempt receipt and fallback receipt; missing unnamed fallback stops the lane |
| Network/provider failure | No live network call in this tranche; supplied provider failure is incomplete evidence | Inconclusive history/provenance language, not “no duplicate” | Provider source/page/error class; external retries remain adapter-owned and deferred |
| Test/typecheck/oracle failure | Direct nonzero status, score/count mismatch, unexpected red | No user receipt; task verdict Fail or Inconclusive by matrix | Raw logs at exact head/diff; one retry only after recorded deterministic root cause |
| Final timeout/load/signal | GNU timeout/loadgate/direct status, watchdog canary | No completion claim | Status 124/137/75 or signal, process evidence, stdout/stderr; one bounded rerun after cause |
| Rollback conflict/failure | `git revert --no-commit` slice inspection and test rerun | No forward task advancement | Revert diff/log; stop without destructive Git and ask owner if unrelated work overlaps |

Pure builders/renderers are deterministic and side-effect free. Atomic receipt writing is the only
mutating code path; rerunning to the same approved target must be safe and produce a complete new
receipt or an explicit write failure. Do not automatically retry validation, contract rejection,
overflow, provider page reads, or unknown exceptions.

Partial success is never collapsed: valid findings survive alongside unrelated limitations;
overflow never silently truncates; provider partial pages never authorize pass; and receipt-write
failure never reuses an in-memory decision as durable evidence. Dead-letter queues and quarantine
stores are `Not applicable` because this tranche has no job/queue system. The bounded overflow
receipt is diagnostic containment, not a queue or evidence archive.

## Silent Failure Matrix

| Misleading green/degraded mode | Detection and proof | Prevention/audit trail |
|---|---|---|
| Invalid mode/duplicate option falls back to shadow | Subprocess asserts exact argv, enforce field, decision, and exit 2 | Diagnostic fallback ignores malformed mode/target/path; CLI log retained |
| Unknown runtime decision aggregates to pass | Post-canonical enum test plus aggregation assertion | Contract rejection/inconclusive; exact error code in receipt/event |
| Required text canonicalizes to blank | Whitespace/control-character nested-field fixtures | Validate after canonicalization; never use pre-trim truthiness |
| Warning hides incomplete evidence | Warning-plus-limitation JSON/human/exit test | Top-level limitation outranks warn/pass and renders in every non-pass output |
| Block hides unrelated limitation | Block-plus-limitation renderer test | Block precedence remains, but limitations are always visible/auditable |
| Unknown action identity renders pass | Push/open-PR/open-issue identity negative/neighbor tests | Synthesize action-identity inconclusive finding before pass finalization |
| Receipt write fails after clean analysis | Failure-injected writer and schema-2 rebuild assertion | Receipt-write finding preserves original evidence; no in-memory completion claim |
| Oversized evidence is silently truncated | At-limit/one-over-limit cardinality and byte assertions | Bounded overflow receipt with counts/digest; rejected evidence is not canonicalized as complete |
| Duplicate/order drift looks stable via correlation ID | Reverse-order byte comparison and exact-duplicate rejection | Separate evidence digest and canonical `(ruleId,digest)` ordering |
| Provider ignores abort or late reject is dropped | Fake-time settlement plus late resolve/reject observation twice | Timer bounds decision, handlers observe late settlement, late-work remains unproven |
| Stale/cached earlier green is reused | Every event/artifact records exact head/diff/time; final manifest same-head check | Earlier runs cannot satisfy a later task/head; refresh readiness after change |
| Pipeline masks test/branch failure | Direct producer status and separate stdout/stderr; no `tee` inference | `set -euo pipefail`, external watchdog, and manifest status; missing status is inconclusive |
| Human output and JSON disagree | Field/section equivalence and byte tests | One canonical receipt/renderer; compatibility alias only |
| Evaluator locally reimplements contract | Source import/definition anti-duplication assertion | Production modules remain SSOT; score replay catches policy drift |
| No service alert exists | Not applicable: no daemon/health endpoint changes; CLI stderr/JSON, exit, receipt, and manifest are the alert/audit surfaces | Any valid non-pass must be visible in selected format; receipt-write failure stays non-pass |
| Success is claimed without validation | Final checklist and manifest completeness/contract/consistency gate | No completion wording until BCF-08C and the ignored helper-owned closeout receipt cites raw exact-commit artifacts |

The implementation creates
`artifacts/verification/boundary-contract-feedback/silent_failure_matrix.md` and records the test or
inspection that closes each row. Any uncovered row is an open risk; a critical uncovered row makes
readiness `Not Ready`. Logging alone is insufficient unless a direct verdict/exit prevents the state
from masquerading as pass.

## Diagnostic Message and Traceability Contract

Every non-pass user/agent message names the attempted action, exact public target identity, decision,
rule ID/version, what and where the boundary failed, bounded observed evidence, expected invariant,
impact, safe control, correction, verification, rerun, sources, limitations, and the first 12 hex
characters of both correlation and evidence digests. Full digests remain in JSON. “Something went
wrong,” “invalid input” without a field/option, silent catches, random/unresolvable IDs, and messages
without a correction or operator clue are rejected.

User/agent diagnostics may contain only canonical public repository references and redacted bounded
evidence. They never contain raw comments, secrets, emails, credentials, query URLs, ANSI/control
sequences, absolute local paths, `file:` URLs, stack traces, temp paths, or artifact-root paths.
Operator events additionally record `run_id`, task ID, exact head/diff, error class/code, direct
process status/signal, and local artifact references; their diagnostic message is still sanitized.

Trace identities have distinct meanings:

- `correlationIdSha256` groups one invocation/action/configuration and is not evidence identity;
- `evidenceDigestSha256` binds the exact target, observation, rule catalog, evidence, and limitations;
- `findingDigestSha256` binds one canonical rule/evidence identity;
- `run_id` and Task ID locate local execution artifacts;
- provider page/cursor and artifact IDs remain bounded source references, never trace substitutes.

`artifacts/verification/boundary-contract-feedback/error_catalog.md` records each rule/error code,
audience, message shape, required trace fields, exit behavior, correction, redaction class, and test.
Renderer tests assert complete section order and trace handles; contract tests assert redaction; CLI
tests assert the exact status and selected output channel. A diagnostic that cannot be tied from
human text → JSON digest → run/task artifact is `Inconclusive`.

## Required Interfaces

Task implementers must use these exact names across tasks:

```ts
// boundary-types.ts
export type BoundaryDecision = 'pass' | 'warn' | 'block' | 'inconclusive';
export type FindingDecision = Exclude<BoundaryDecision, 'pass'>;
export type EvidenceState =
  | 'observed' | 'absent' | 'invalid' | 'unavailable' | 'stale' | 'unknown';
export type BoundaryActionV1 =
  | 'commit' | 'push' | 'open-pr' | 'reopen-pr' | 'open-issue';
export type BoundaryAction =
  | BoundaryActionV1 | 'update-pr' | 'merge' | 'tag' | 'release' | 'config-write';
export type EnforcementMode = 'shadow' | 'enforce';

export interface BoundaryCorrectionStep {
  operation: 'edit' | 'reuse' | 'remove' | 'refresh' | 'split' | 'retry';
  target: string;
  expected: string;
}

export interface BoundaryCommand {
  command: string;
  args: string[];
}

export interface BoundaryVerificationStep extends BoundaryCommand {
  expected: string;
}

export interface BoundaryFindingV1 {
  ruleId: string;
  decision: FindingDecision;
  action: BoundaryActionV1;
  summary: string;
  why: string;
  observed: BoundaryEvidenceRecord[];
  matchedArtifacts: BoundaryArtifact[];
  correction: string[];
  rerun: string;
  sourceRefs: string[];
}

// Retained export for source and stored-schema compatibility.
export type BoundaryFinding = BoundaryFindingV1;

export interface BoundaryFindingInput {
  ruleId: string;
  decision: FindingDecision;
  action: BoundaryAction;
  evidenceState: EvidenceState;
  summary: string;
  why: string;
  observed: BoundaryEvidenceRecord[];
  matchedArtifacts: BoundaryArtifact[];
  limitations?: string[];
}

export interface CanonicalBoundaryFinding extends BoundaryFindingInput {
  ruleVersion: number;
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

export interface BoundaryTarget {
  repository: 'LucasQuiles/WhatSoup';
  actionTarget: string;
  headOid: string | null;
}

`actionTarget` identifies the mutation destination; `headOid` independently identifies the Git
candidate. The closed target grammars are: `commit:<git-oid>`; `ref:<full-git-ref>` for push;
`pr-create:<full-base-ref>..<full-head-ref>` for open-pr; `pr:<positive-decimal>` for
reopen-pr/update-pr/merge; `task:<64hex>` for open-issue; `tag:<full-refs/tags/...>` for tag;
`release:<full-refs/tags/...>` for release; and `config:<64hex>` for config-write. Full refs must pass
Git ref-format validation, and the `..` delimiter is unambiguous because valid refs cannot contain
that sequence. The reserved private diagnostic form `unresolved:<action>` is never accepted from a
public producer input. Every non-config action requires a lowercase 40- or 64-hex `headOid`;
config-write alone may
use null, apart from the reserved private diagnostic form.

export interface BoundaryReceiptBase {
  headOid: string | null;
  baseOid: string | null;
  mergeBaseOid: string | null;
  evidenceSource: string;
}

export interface BoundaryOverflow {
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
}
```

```ts
// rule-guidance.ts
export interface BoundaryRuleGuidance {
  ruleVersion: number;
  expected: string[];
  impact: string[];
  safeControls: string[];
  correction: BoundaryCorrectionStep[];
  verification: BoundaryVerificationStep[];
  rerun: BoundaryCommand;
  rerunPurpose: 'integration-boundary' | 'focused-family-replay';
  sourceRefs: string[];
}

export function guidanceForRule(ruleId: string): BoundaryRuleGuidance;
export function evidenceStateForRule(ruleId: string): EvidenceState;
export function catalogRuleIds(): string[];
export function ruleCatalogDigestSha256(): string;
```

```ts
// boundary-contract.ts
export interface BoundaryBudgets {
  maxFindings: number;
  maxObservedPerFinding: number;
  maxArtifactsPerFinding: number;
  maxLimitationsPerFinding: number;
  maxTopLevelLimitations: number;
  maxFingerprints: number;
  maxCanonicalRecords: number;
  maxCorrectionsPerFinding: number;
  maxVerificationPerFinding: number;
  maxSourcesPerFinding: number;
  maxPublicTextBytes: number;
  maxJsonBytes: number;
  maxHumanBytes: number;
  maxHumanReservedSummaryBytes: number;
  maxHumanDetailedFindings: number;
}

export const DEFAULT_BOUNDARY_BUDGETS: Readonly<BoundaryBudgets>;
export type BoundaryContractCode =
  | 'boundary.contract-invalid'
  | 'boundary.finding-identity-conflict'
  | 'boundary.artifact-identity-conflict'
  | 'boundary.evidence-volume-exceeded';
export interface BoundaryContractIssue {
  code: BoundaryContractCode;
  fieldPath: string;
  identity: string | null;
  count: number | null;
  descriptorDigestSha256: string | null;
}
// Module-private runtime value; declared here only to make the constructor contract explicit.
declare const BOUNDARY_CONTRACT_ISSUER: unique symbol;
interface IssuedBoundaryContractPayload {
  code: BoundaryContractCode;
  issues: readonly BoundaryContractIssue[];
  overflow: BoundaryOverflow | null;
}
declare const ISSUED_BOUNDARY_ERRORS: WeakMap<
  BoundaryContractError,
  IssuedBoundaryContractPayload
>;
export class BoundaryContractError extends Error {
  constructor(
    issuer: typeof BOUNDARY_CONTRACT_ISSUER,
    code: BoundaryContractCode,
    issues: readonly BoundaryContractIssue[],
    overflow: BoundaryOverflow | null,
  );
  readonly code: BoundaryContractCode;
  readonly issues: readonly BoundaryContractIssue[];
  readonly overflow: BoundaryOverflow | null;
}
export interface BoundaryEvidenceDigestInput {
  target: BoundaryTarget;
  observedAt: string;
  validUntil: string | null;
  base: BoundaryReceiptBase;
  fingerprints: Record<string, string | null>;
  findings: CanonicalBoundaryFinding[];
  limitations: string[];
  ruleCatalogDigestSha256: string;
}
export function canonicalBoundaryFinding(
  input: BoundaryFindingInput,
): CanonicalBoundaryFinding;
export function canonicalBoundaryTarget(
  action: BoundaryAction,
  input: unknown,
): BoundaryTarget;
export function canonicalBoundaryLimitations(input: unknown): string[];
export const ENFORCEMENT_MODES: readonly ['shadow', 'enforce'];
export function canonicalEnforcementMode(input: unknown): EnforcementMode;
export function evidenceDigestSha256(input: BoundaryEvidenceDigestInput): string;
export function assertReceiptWithinBudgets(
  receipt: BoundaryReceiptV2,
  budgets?: BoundaryBudgets,
): void;
```

```ts
// receipt.ts
export interface BoundaryReceiptV1 {
  schemaVersion: 1;
  repository: 'LucasQuiles/WhatSoup';
  invocation: string;
  action?: BoundaryActionV1;
  correlationIdSha256?: string;
  enforcementMode: EnforcementMode;
  decision: BoundaryDecision;
  base: BoundaryReceiptBase;
  fingerprints: Record<string, string | null>;
  findings: BoundaryFindingV1[];
  limitations: string[];
}
export interface BoundaryReceiptV2 {
  schemaVersion: 2;
  repository: 'LucasQuiles/WhatSoup';
  invocation: string;
  action: BoundaryAction;
  target: BoundaryTarget;
  observedAt: string;
  validUntil: string | null;
  correlationIdSha256: string;
  ruleCatalogDigestSha256: string;
  evidenceDigestSha256: string;
  enforcementMode: EnforcementMode;
  decision: BoundaryDecision;
  base: BoundaryReceiptBase;
  fingerprints: Record<string, string | null>;
  findings: CanonicalBoundaryFinding[];
  limitations: string[];
  overflow: BoundaryOverflow | null;
}
export type BoundaryReceipt = BoundaryReceiptV1 | BoundaryReceiptV2;
export interface BoundaryDiagnosticContext {
  invocation: string;
  action: BoundaryAction;
  target: BoundaryTarget;
  observedAt: string;
  enforcementMode: EnforcementMode;
  base: BoundaryReceiptBase;
  fingerprints: Record<string, string | null>;
  limitations: string[];
}
export interface BuildBoundaryReceiptInput {
  invocation: string;
  action: BoundaryAction;
  target: BoundaryTarget;
  observedAt: string;
  validUntil?: string | null;
  enforcementMode: EnforcementMode;
  base: BoundaryReceiptBase;
  fingerprints?: Record<string, string | null>;
  findings: BoundaryFindingInput[];
  limitations?: string[];
}
export interface BuildSemanticReceiptInput {
  tree: CandidateTree;
  policyFindings: SemanticPolicyFinding[];
  enforcementMode: EnforcementMode;
  evidenceSource: string;
  limitations?: string[];
  targetRef: string | null;
  now?: Date;
}
export function buildBoundaryReceipt(input: BuildBoundaryReceiptInput): BoundaryReceiptV2;
export function buildBoundaryDiagnosticReceipt(
  error: unknown,
  context: BoundaryDiagnosticContext,
): BoundaryReceiptV2;
export function parseBoundaryReceipt(input: unknown): BoundaryReceipt;
export function renderBoundaryReceipt(receipt: BoundaryReceipt): string;
export const renderSemanticReceipt: typeof renderBoundaryReceipt;
export function semanticExitCode(receipt: BoundaryReceipt): 0 | 1 | 2;
```

`BoundaryOverflow` is an output-only receipt field. It is absent from
`BuildBoundaryReceiptInput`, producer finding inputs, and every public caller-controlled diagnostic
shape. `BoundaryDiagnosticContext` carries no error fields or producer-owned receipt fields.
`buildBoundaryDiagnosticReceipt()` accepts its error separately and admits only a
module-issued `BoundaryContractError`; it canonicalizes the context again before producing output.
Contract errors carry a runtime issuer brand created from a
module-private token; a structural lookalike, subclass, public-constructor attempt, foreign-realm
error, or caller getter that throws an error is rejected rather than admitted to diagnostic
construction. At issuance, the module deep-clones and deep-freezes the canonical code/issues/
overflow payload, stores that authoritative snapshot in module-private `ISSUED_BOUNDARY_ERRORS`,
and exposes only separate frozen diagnostic copies on public readonly fields. The builder requires
the exact prototype and WeakMap membership and reads only the WeakMap snapshot—never public error
fields—so post-catch property, nested-count/digest, array, or prototype mutation cannot alter an
issued diagnostic. Only this brand-and-snapshot-checked path may derive overflow from the bounded structural fields of the caught typed
`boundary.evidence-volume-exceeded` issue. An input object containing `overflow`,
`descriptorDigestSha256`, `digestCoverage`, or rejected-count aliases is an unknown-key contract
error; it is never trusted as a precomputed overflow receipt.

---

## Atomic Task Contract

One sequential task owner has write scope for the named files. Read-only reviewers may run in
parallel only when their dedupe keys and evidence outputs do not overlap. Each checkbox step is one
atomic action or one inseparable validation group; if it produces unrelated outputs, needs hidden
judgment, or can partially succeed without an explicit verdict, split it before dispatch.

| Task ID / parent | Objective and action | Preconditions / inputs | Primary output and observable signal | Validation / evidence | Failure, retry, rollback | Dependencies / blocker |
|---|---|---|---|---|---|---|
| BCF-00 / BCF | Reconcile provenance, add the reviewed run validator, close predecessor gates, lifecycle, and oracle | Approved plan; SSH remote; preserved working tree; A-08–10 | Reconciled-base receipt; validator tests/commit; unique hash-bound preflight manifest; predecessor final gate; lifecycle record; raw per-case 39/40 | `preflight/<run-id>/run_manifest.json` plus hashed child artifacts | Preserve every attempt; no destructive Git; any mixed/stale/masked/missing result remains blocked | Only the named validator files may change before A-08–10 resolve; no semantic BCF mutation |
| BCF-01 / BCF | Make singleton CLI parsing fail closed | BCF-00 pass; current CLI/tests; Task 1 owner | Parser plus CLI tests; every invalid invocation exits 2/enforce | Task 1 focused command; `task01/<run-id>/semantic-quality-check.log` | Unexpected red is inconclusive; fix only parser/tests; revert BCF-01 commit | A-08–10 resolved; malformed fallback still exiting zero blocks exit |
| BCF-02 / BCF | Add the complete versioned rule catalog | BCF-01 rule inventory; current producers | One catalog module/test; inventory diff has no unexplained ID | Task 2 command; `task02/rule-inventory.diff` | Register missing current rule or remove unexplained stale test entry; revert BCF-02 commit | A-02 must be resolved; policy expansion blocks task |
| BCF-03 / BCF | Canonicalize and runtime-validate untrusted finding/target input | BCF-02; current redaction/identity helpers | Contract module/types/tests; unsafe cases throw exact contract class and safe neighbors pass | Task 3 command; `task03/boundary-contract-tests.log` | Classify unexpected rejection before code change; revert BCF-03 after dependents | BCF-02; generic fallback or unbounded field blocks exit |
| BCF-04 / BCF | Emit deterministic evidence-bound schema-2 receipts | BCF-02–03; all local call sites inventoried | V2 builder plus schema-1 reader; exact digest/order/decision assertions pass | Task 4 command; `task04/receipt-contract-tests.log` | Update every caller, never fabricate v2 identity; revert BCF-04 only after dependents | BCF-02–03; consumer or identity gap blocks exit |
| BCF-05 / BCF | Render bounded complete action-specific feedback | BCF-04 canonical receipts; approved budgets | One renderer/overflow path; exact section/byte/count assertions pass | Task 5 command; `task05/output-budget.json` and renderer log | Tune only within approved budget or amend plan; revert BCF-05 with BCF-04 if schema coupling requires | BCF-04 and A-03; ordinary complete evidence overflow blocks exit |
| BCF-06 / BCF | Bound each history-provider page decision | Existing provider tests; fake timers; no external ownership claim | Deadline race plus tests; all four provider controls settle with no unhandled rejection | Task 6 command twice; `task06/provider-deadline-tests.log` | Repair listener/timer cleanup; preserve late-work limitation; revert BCF-06 commit | None for code, BCF-04 for final receipt composition; late-work “canceled” claim blocks exit |
| BCF-07 / BCF | Integrate v2 through CLI/evaluator without duplicating policy | BCF-01–06 | CLI/evaluator updates; focused suites and frozen scores pass | Task 7 commands; `task07/evaluator-results.json` | Root-cause any score drift; do not relabel corpus; revert BCF-07 commit | BCF-01–06; policy drift or duplicate evaluator logic blocks exit |
| BCF-08A / BCF-08 | Document current public contract and regenerate indexes | BCF-07 exact head; review joins | Public-surface/notes/index diff, unchanged pre-registered audit rows, doc guards exit zero | Task 8 Steps 1–3; docs-run artifacts | Correct docs/index only; revert documentation slice | BCF-07/review joins; unobserved behavior claim blocks exit |
| BCF-08B / BCF-08 | Prove pre-commit behavior, scope, and commit the pending-gate handoff | BCF-08A; exact worktree snapshot | Focused/typecheck/integrity/evaluator receipts, scope audit, docs commit, finalized docs run | Task 8 Steps 4–5; docs-run manifest | Preserve every failed attempt; retry only after named root cause; revert docs commit only for a proven tracked defect | BCF-08A; masked/missing/nonzero lane or unrelated staged file blocks exit |
| BCF-08C / BCF-08 | Prove exact-commit final behavior and close evidence | BCF-08B docs commit; review/docs joins; fresh upstream; A-06 | Watchdog/branch-gate/lifecycle receipts and immutable final manifest | Task 8 Steps 6–8; final manifest plus sibling closeout receipt/locks | Preserve failure in the immutable run; create a new run after root cause; never rewrite tracked notes to self-report | BCF-08B; stale upstream, artifact mutation, external mutation, or any incomplete join blocks exit |

Every dispatched work packet repeats its Task ID, dedupe key, exact allowed paths, entry head/diff,
timeout, stop conditions, result schema, and artifact directory. A progress-only or malformed worker
result is inconclusive. The lead inspects the decisive diff/test/log before accepting task output.

### Mandatory task-run protocol

After BCF-00 lands the validator, every BCF-01–08 RED, GREEN, review, docs, static, and branch-gate
command is executed through the exact committed helper; a fixed path shown elsewhere is only the
logical artifact name:

```bash
bash scripts/run-with-pinned-node.sh scripts/verify-boundary-run.ts init \
  --run-dir "$BCF_TASK_RUN_DIR" --task "$BCF_TASK_ID" \
  --profile "$BCF_RUN_PROFILE" \
  --predecessor-run-dir "$BCF_PREDECESSOR_RUN_DIR" \
  --predecessor-pin "$BCF_PREDECESSOR_PIN" \
  --child-pin "$BCF_REQUIRED_CHILD_PIN" \
  --allow-path "$BCF_TASK_PATH" \
  --allow-untracked "$BCF_TASK_UNTRACKED_PATH" \
  --preserve-owner-path "$BCF_OWNER_PATH"
bash scripts/run-with-pinned-node.sh scripts/verify-boundary-run.ts record-command \
  --run-dir "$BCF_TASK_RUN_DIR" --attempt "$BCF_ATTEMPT" --expect-exit 0 \
  --output-path "$BCF_ARTIFACT_REL" -- \
  <exact-command> --output "$BCF_TASK_RUN_DIR/$BCF_ARTIFACT_REL"
bash scripts/run-with-pinned-node.sh scripts/verify-boundary-run.ts record-artifact \
  --run-dir "$BCF_TASK_RUN_DIR" --producer-attempt "$BCF_ATTEMPT" \
  --path "$BCF_ARTIFACT_REL" --role output
bash scripts/run-with-pinned-node.sh scripts/verify-boundary-run.ts record-child-run \
  --run-dir "$BCF_TASK_RUN_DIR" --alias "$BCF_CHILD_ALIAS" \
  --kind "$BCF_CHILD_KIND" --child-run-dir "$BCF_CHILD_RUN_DIR" \
  --expect-task "$BCF_CHILD_TASK" --expect-head "$BCF_CHILD_HEAD" \
  --expect-run-id "$BCF_CHILD_RUN_ID" \
  --expect-manifest-sha256 "$BCF_CHILD_MANIFEST_SHA256"
bash scripts/run-with-pinned-node.sh scripts/verify-boundary-run.ts verify \
  --run-dir "$BCF_TASK_RUN_DIR" --expect-current-snapshot
```

Repeat each path option once per declared path and `--child-pin` once per profile-required child;
omit an option class when it has no values instead of passing an empty value. Supply the two
predecessor options together exactly when `RUN_PREDECESSOR_CONTRACTS` requires them; observation
omits both. `--predecessor-pin` is one closed
`task,profile,run-id,terminal-head,manifest-sha256,completion-receipt-sha256,ledger-sha256` record;
the source directory is location-only and is never identity. The single environment
variables above are placeholders for one row of those repeatable declarations, not a one-value
limit. `--profile` is singular and must be the closed profile authorized for the supplied task ID.
Each child pin is a closed `alias,head,run-id,manifest-sha256` record; task/profile/kind/head relation
come from the profile and cannot be overridden. `init` parses those records into the manifest's
canonical `run.requiredChildPins` array, sorted by alias, and requires its alias set to equal
`run.requiredChildAliases`. The caller-facing hyphenated field names map only to the exact wire keys
`alias`, `head`, `runId`, and `manifestSha256`; no sidecar, environment value, or later import option
may replace or edit the manifest-bound pins.

Canonical active-manifest storage is not the immutability boundary. During the same exclusive init
operation, the helper also exclusively writes canonical `run_init.json` and its exact
`run_init.sha256` lock before returning success. `RunInitAnchor` freezes the init-owned projection:
run/task/profile/phase/creation time, entry head/snapshot digest, helper identity, all path sets,
required attempt/child sets and child pins, completion flags, tool capability rows, reserved roots,
the nullable predecessor pin/tree digest, entry-test-roster digest, and the canonical document-hash digest. Every later operation and both
active/finalized verification modes recompute that projection from the manifest and require exact
anchor bytes plus lock. Neither file is ever rewritten. A caller that consistently substitutes the
pin array, imported child, expected CLI fields, and predecessor row still fails the init-anchor
comparison; redundant mutable fields or file permissions are not accepted as an immutability proof.

`reconciledBase` is never caller-supplied. Observation and reconciliation init store the explicit
state `not-observed`. Only reconciliation's successful helper-owned merge transition may atomically
single-assign it to the proven merge commit; failure/abort leaves `not-observed`. Every later profile
derives the exact value from its verified predecessor completion receipt/ledger and rejects an
inconsistent local Git state. No `--reconciled-base` option exists.

#### Closed validator wire/state contract

`RUN_WIRE_SCHEMAS` is a closed helper constant and part of the generated contract snapshot digest.
It owns every JSON object key, value type, enum, nullability rule, byte bound, canonicalization rule,
and lock-file grammar below. There are no extension maps or caller-defined metadata keys. Every
listed key is always present; an inactive conditional field is exactly `null` or `[]` as declared,
never absent or an empty-string substitute. A schema/version mismatch, unknown or missing key,
wrong type, duplicate key at any nesting depth, or out-of-bound value exits nonzero before any
state-bearing write.

The JSON reader first scans the UTF-8 bytes and rejects a BOM, invalid UTF-8, CR, duplicate object
key, non-JSON number, fractional integer field, `-0`, or trailing bytes before ordinary parsing can
erase that evidence. All schema keys and enums are ASCII. Canonical JSON recursively orders object
keys by ascending UTF-8 bytes, emits no insignificant whitespace, preserves declared semantic-array
order, sorts set-valued arrays by their schema identity tuple, and ends in exactly one LF. Strings
reject NUL/control bytes except escaped LF in bounded diagnostic text. Timestamps are exactly 24
ASCII bytes matching a real UTC instant rendered `YYYY-MM-DDTHH:mm:ss.sssZ`. Hashes are lowercase
64-hex; Git OIDs are lowercase 40-hex; byte/count/deadline fields are nonnegative safe integers.
Normalized paths are at most 1,024 UTF-8 bytes, argv/environment/diagnostic strings at most 4,096,
reason/counterevidence text at most 4,096, and tool names/versions at most 256. Existing tighter
profile limits still win. A SHA lock is exactly `<64-lowerhex>  <locked-basename>\n`; it may name
only its sibling JSON file and contains no path separator.

The exact schema-1 object key sets are:

| Object | Exact keys |
|---|---|
| `RunManifest` | `schemaVersion`, `manifestState`, `run`, `entrySnapshot`, `currentSnapshot`, `attempts`, `artifacts`, `children`, `predecessor`, `entryTestRoster`, `reviews`, `lifecycle`, `documentHashes`, `upstream`, `overallVerdict` |
| `RunInitAnchor` | `schemaVersion`, `runId`, `taskId`, `profileId`, `phase`, `createdAtUtc`, `entryHead`, `entrySnapshotDigestSha256`, `helperCommit`, `helperSha256`, `allowedPaths`, `allowedUntrackedPaths`, `preservedOwnerPaths`, `requiredAttemptIds`, `requiredChildAliases`, `requiredChildPins`, `predecessorPin`, `predecessorTreeDigestSha256`, `mayComplete`, `chainAppend`, `requestedTools`, `observedTools`, `reservedDerivedRoots`, `entryTestRosterDigestSha256`, `documentHashesDigestSha256` |
| `run` | `runId`, `taskId`, `profileId`, `phase`, `createdAtUtc`, `finalizedAtUtc`, `entryHead`, `terminalHead`, `reconciledBase`, `helperCommit`, `helperSha256`, `allowedPaths`, `allowedUntrackedPaths`, `preservedOwnerPaths`, `requiredAttemptIds`, `requiredChildAliases`, `requiredChildPins`, `transitionCount`, `mayComplete`, `chainAppend`, `requestedTools`, `observedTools`, `reservedDerivedRoots` |
| `snapshot` | `head`, `indexTreeOid`, `trackedPatchSha256`, `unstagedPatchSha256`, `allowedUntracked`, `preservedOwner`, `digestSha256` |
| `snapshotPath` | `path`, `type`, `mode`, `bytes`, `sha256` |
| `attempt` | `id`, `operation`, `headAnchor`, `argv`, `cwd`, `startedAtUtc`, `endedAtUtc`, `expectedExit`, `rawExit`, `rawSignal`, `expectationMet`, `watchdogOwner`, `innerTimeoutOwner`, `deadlineMs`, `killGraceMs`, `preSnapshot`, `postSnapshot`, `stdout`, `stderr`, `declaredOutputs`, `outputAdmissions`, `structuredResult`, `verdict` |
| `stream` | `path`, `sha256`, `bytes` |
| `outputAdmission` | `path`, `state`, `role`, `sha256`, `bytes` |
| `artifact` | `path`, `role`, `producerAttemptId`, `sha256`, `bytes` |
| `child` | `alias`, `kind`, `taskId`, `profileId`, `runId`, `entryHead`, `terminalHead`, `snapshotDigestSha256`, `sourceManifestSha256`, `importedFiles`, `treeDigestSha256`, `overallVerdict`, `dedupeKey` |
| `childPin` | `alias`, `head`, `runId`, `manifestSha256` |
| `importedFile` | `path`, `sha256`, `bytes` |
| `predecessor` | `pin`, `sourceManifestSha256`, `importedFiles`, `treeDigestSha256`, `overallVerdict` |
| `predecessorPin` | `taskId`, `profileId`, `runId`, `terminalHead`, `manifestSha256`, `completionReceiptSha256`, `ledgerSha256` |
| `entryTestRoster` | `files`, `digestSha256` |
| `testRosterFile` | `path`, `state`, `testNames` |
| `reviewInput` | `schemaVersion`, `reviewId`, `dedupeKey`, `head`, `snapshotDigestSha256`, `reportPath`, `reportSha256`, `metaPath`, `metaSha256`, `stderrPath`, `stderrSha256`, `findings`, `reproductionContracts` |
| `review` | `reviewId`, `alias`, `dedupeKey`, `head`, `snapshotDigestSha256`, `reportPath`, `reportSha256`, `metaPath`, `metaSha256`, `stderrPath`, `stderrSha256`, `findings`, `reproductionContracts` |
| `finding` | `findingId`, `severity`, `requiresFix`, `requiresReproduction`, `evidencePath`, `evidenceSha256`, `disposition`, `resolution`, `reason`, `counterevidenceRefs`, `reproductionAttemptIds`, `counterReproductionAttemptIds`, `fixedAtHead`, `fixReproductionAttemptIds`, `fixReviewId` |
| `reproductionContract` | `attemptId`, `argv`, `expectedExit`, `toolName`, `deadlineMs`, `killGraceMs` |
| `lifecycle` | `status`, `completionCommit`, `finalGate`, `artifactSha256`, `successor`, `supersededBy`, `oracle`, `branchDeletionAuthorized` |
| `documentHashes` | `spec`, `plan`, `notes`, `helper` |
| `documentHash` | `path`, `sha256`, `bytes` |
| `upstream` | `remoteUrl`, `observedOid`, `mergeBase`, `ahead`, `behind`, `remotePaths`, `localPaths`, `observationManifestSha256`, `mergeCommit`, `mergeParents` |
| `tool` | `name`, `realPath`, `version`, `sha256` |
| `reservedDerivedRoot` | `kind`, `path`, `parentDevice`, `parentInode`, `state` |
| `ReadinessRecord` | `schemaVersion`, `runId`, `taskId`, `profileId`, `head`, `snapshotDigestSha256`, `readinessState`, `evaluatedAtUtc`, `evidence`, `assumptions`, `risks`, `blockers`, `decisionRationale`, `decisionAuthority`, `nextAllowedAction`, `overallVerdict` |
| `readinessEvidence` | `evidenceId`, `artifactPath`, `producerAttemptId`, `sha256`, `verdict` |
| `readinessAssumption` | `assumptionId`, `disposition`, `evidenceRefs` |
| `readinessRisk` | `riskId`, `owner`, `checkpoint`, `artifactPath`, `artifactSha256`, `stopCondition` |
| `readinessBlocker` | `blockerId`, `reason`, `evidenceRefs` |
| `ConsumerVersionDecision` | `schemaVersion`, `runId`, `taskId`, `profileId`, `head`, `snapshotDigestSha256`, `packageVersion`, `currentProducerSchema`, `proposedProducerSchema`, `supportStage`, `inventoryQuerySha256`, `inventoryMatches`, `localConsumers`, `externalConsumers`, `compatibilityReader`, `rollbackCommit`, `decision`, `releaseNoteRequired`, `limitations`, `overallVerdict` |
| `consumerInventoryMatch` | `path`, `line`, `column`, `matchKind`, `matchedToken`, `lineSha256` |
| `localConsumer` | `consumerId`, `kind`, `path`, `symbol`, `schemaSupport`, `matchRefs` |
| `FeedbackMeasurements` | `schemaVersion`, `runId`, `taskId`, `profileId`, `producerAttemptId`, `head`, `snapshotDigestSha256`, `tokenSha256`, `budgets`, `scenarios`, `overallVerdict` |
| `boundaryBudgets` | `maxFindings`, `maxObservedPerFinding`, `maxArtifactsPerFinding`, `maxLimitationsPerFinding`, `maxTopLevelLimitations`, `maxFingerprints`, `maxCanonicalRecords`, `maxCorrectionsPerFinding`, `maxVerificationPerFinding`, `maxSourcesPerFinding`, `maxPublicTextBytes`, `maxJsonBytes`, `maxHumanBytes`, `maxHumanReservedSummaryBytes`, `maxHumanDetailedFindings` |
| `feedbackScenario` | `ordinal`, `scenario`, `subject`, `inputBytes`, `limitBytes`, `humanBytes`, `jsonBytes`, `detailedFindings`, `omittedFindings`, `renderedObservations`, `omittedObservations`, `evidenceDigestSha256`, `descriptorDigestSha256`, `expectedDisposition`, `observedDisposition` |
| `DocsLineageReport` | `schemaVersion`, `runId`, `taskId`, `profileId`, `head`, `snapshotDigestSha256`, `anchors`, `operations`, `pathClasses`, `bEntryIdentity`, `overallVerdict` |
| `docsLineageAnchors` | `validatorBase`, `validatorCommit`, `upstreamMerge`, `upstreamFirstParent`, `upstreamSecondParent`, `originMain`, `reconciledBase`, `docsEntryHead`, `docsCurrentHead` |
| `docsLineageOperation` | `ordinal`, `operationId`, `argv`, `rawExit`, `rawSignal`, `stdoutSha256`, `stderrSha256`, `parsedOids`, `parsedPaths`, `expectationMet`, `verdict` |
| `docsLineagePathClass` | `path`, `status`, `source` |
| `docsBEntryIdentity` | `snapshotDigestSha256`, `publicSurfaceSha256`, `publicationAuditSha256`, `handoffSha256`, `workIndexJsonSha256`, `workIndexMarkdownSha256` |
| `MergeConflictResolutionReport` | `schemaVersion`, `policy`, `beforeHead`, `expectedSecondParent`, `conflictPaths`, `indexStages`, `generatorArgv`, `generatorRawExit`, `generatorRawSignal`, `resolvedPaths`, `unmergedPaths`, `conflictMarkerPaths`, `diffCheckRawExit`, `diffCheckRawSignal`, `workIndexGuardRawExit`, `workIndexGuardRawSignal`, `preStateDigestSha256`, `resolvedStateDigestSha256`, `verdict` |
| `mergeConflictIndexStage` | `path`, `stage`, `mode`, `oid` |

The exact value grammar uses these aliases: `Id` is the operational-ID grammar already declared;
`Path` is a normalized bounded relative path; `Sha256` and `Oid` are the lowercase hashes above;
`Time` is the exact UTC timestamp; `Verdict` is `Pass|Fail|Inconclusive|Blocked`; `StatusOrSignal`
means exactly one of integer `rawExit` and POSIX-name `rawSignal` is non-null. Object/array/scalar
types are not interchangeable.

- `RunManifest` has integer `schemaVersion: 1`; `manifestState:
  active|finalized|verified-pass-closeout-rejected`; the named object fields; arrays of their named
  row type; nullable `predecessor`; and root `overallVerdict: Verdict`.
- `RunInitAnchor` has integer `schemaVersion: 1`, exact copies of the named init-owned scalar and
  set-valued fields, the same closed child-pin/predecessor-pin/tool/reserved-root row types, three
  required `Sha256` projection digests, and the nullable predecessor-tree `Sha256`. Its path arrays
  and row arrays use the same canonical order as the manifest.
  Observation uses exact null/null predecessor fields; every other profile copies the closed
  predecessor pin and imported-tree digest. Its lock is exactly `<sha256>  run_init.json\n`.
- `run` uses `Id` for run/profile, a literal task ID from the profile table, and profile-derived
  `phase: observation|reconciliation|task01|task02|task03|task04|task05|task06|task07|review|reproduction|docs-a|docs-b|final`.
  Creation/finalization are `Time`/`null|Time`; entry/helper commits are `Oid`; terminal head is
  `null|Oid`; reconciled base is `not-observed|Oid`; helper digest is `Sha256`. Path and required-ID
  fields are sorted unique string arrays; transition count is integer `0|1`; `mayComplete` and
  `chainAppend` are booleans. Requested tools are sorted unique names; observed tools are sorted
  `tool[]`; reserved roots are sorted `reservedDerivedRoot[]`.
- `snapshot` uses `Oid` for head/index tree and `Sha256` for both patch/digest fields. Its two row
  arrays are sorted by path. `snapshotPath` is `Path`, literal `type: regular`, six-digit ASCII-octal
  Git mode, nonnegative byte count, and content `Sha256`; non-regular allowed-untracked or preserved
  owner paths are rejected rather than coerced.
- `attempt` uses `Id`, closed operation and head-anchor enums, exact string `argv[]`, absolute
  canonical `cwd`, two `Time` values, normalized expected-exit string, `StatusOrSignal`, boolean
  `expectationMet`, literal `watchdogOwner: helper-watchdog|null`,
  `innerTimeoutOwner: gnu-timeout|null`, positive integer deadline/grace, two `snapshot` objects, two
  `stream` objects, sorted unique `Path[]` declarations, same-order `outputAdmission[]`,
  `null|stream` structured result, and `Verdict`. Internal checks alone use null watchdog owner;
  external children require `helper-watchdog`.
- `stream` and `importedFile` are `Path`, `Sha256`, and nonnegative bytes. `outputAdmission` is
  `Path`, `state: missing|pending|admitted`, and `null` role/hash/bytes until admitted; admitted rows
  use the artifact role enum, `Sha256`, and nonnegative bytes. `artifact` uses the same role enum,
  producer `Id`, `Path`, `Sha256`, and bytes.
- `child` uses IDs for alias/profile/run, a closed kind/task, two `Oid` heads, snapshot/source/tree
  `Sha256`, sorted `importedFile[]`, `Verdict`, and bounded unique dedupe key. `predecessor` uses one
  `predecessorPin`, source/tree hashes, sorted imported files, and `Verdict`; its pin uses closed
  task/profile/run IDs, terminal `Oid`, and three `Sha256` values. `predecessor` is null exactly when
  its profile forbids one.
- `entryTestRoster.files` is path-sorted `testRosterFile[]` plus `Sha256`; each file has `Path`,
  `state: present|absent`, and a sorted unique bounded full-test-name string array, which is empty
  exactly when absent.
- `reviewInput` has integer `schemaVersion: 1`; otherwise it is the exact `review` object without the
  helper-owned `alias`. `review` uses IDs/dedupe key, `Oid`, snapshot/report/meta/stderr
  `Path`/`Sha256` pairs, finding-ID-sorted `finding[]`, and attempt-ID-sorted
  `reproductionContract[]`. A reproduction contract uses `Id`, a nonempty bounded literal argv,
  normalized expected-exit, a tool name already frozen by the reproduction profile, and the exact
  900,000 ms/30,000 ms deadline/grace. A finding uses bounded finding ID, the closed severity/disposition/
  resolution enums, two booleans, evidence `Path`/`Sha256`, `null|bounded string` reason, sorted
  bounded counterevidence strings and attempt IDs, `null|Oid` fixed head, and `null|Id` fix review.
  Rejected requires nonempty counterevidence and counter-reproduction arrays; fixed requires head,
  fix-attempt IDs, and fix-review ID; incompatible fields are exactly null/empty arrays. Every
  reproduction/counter/fix attempt ID occurs in exactly one reproduction contract, every contract is
  referenced, and the same attempt ID cannot carry two argv/status contracts across reviews.
- `lifecycle` uses the declared lifecycle/final-gate/oracle enums, `null|Oid` completion,
  `null|Sha256` artifact, `null|Path` successor/supersession, and literal
  `branchDeletionAuthorized: false`. Each `documentHashes` field is a `documentHash`; those and
  `tool` use their listed bounded strings/paths, nonnegative bytes, and hashes.
- `upstream` uses `not-observed|bounded SSH URL`, `not-observed|Oid` for OID/base/merge commit,
  `not-observed|nonnegative integer` for counts, sorted unique path arrays, `not-observed|Sha256`
  observation hash, and semantic-order `Oid[]` merge parents of length zero or two. An observation
  uses the explicit not-observed scalars/empty parents until set; no null represents unknown.
- `reservedDerivedRoot` uses `kind: run|completion|closeout|closeout-failure`, absolute canonical
  path, positive integer parent device/inode, and `state: reserved|created`. Set arrays everywhere
  sort by path, ID, alias, or tool name; semantic arrays retain the specifically declared order.

The four completion-critical internal-check results above are helper-derived state, never
caller-authored JSON. Their `schemaVersion` is integer `1`; their run/task/profile/head/snapshot
fields are exact copies of the active manifest at the attempt's owned head anchor. The helper writes
each canonical object as that internal check's `structuredResult`, atomically registers the same
bytes under its profile-owned artifact path, and rejects a pre-existing, caller-selected, copied,
or post-write-mutated result. There is no CLI option for any result field or result path.

`ReadinessRecord` is produced only by `readiness-check` as `readiness.json`. Evidence rows sort by
`evidenceId` and name an admitted manifest artifact, its owning required attempt, current hash, and
direct `Verdict`. Assumption rows are exactly `A-08`, `A-09`, and `A-10` in that order, use
`disposition: validated|blocked`, and contain sorted unique evidence IDs that resolve to the evidence
array. Risk and blocker rows sort by ID; a risk has nonempty bounded owner/checkpoint/stop-condition
text plus a current admitted artifact path/hash, while a blocker has a nonempty reason and evidence
references. `decisionAuthority` is literal `implementation-lead`; `nextAllowedAction` is
`BCF-01|null`. `Ready with Constraints` requires all three assumptions validated, no blockers,
every required reconciliation attempt/child Pass, lifecycle `completed`, final gate `pass`, oracle
`current`, at least one bounded risk row for every residual limitation, literal next action
`BCF-01`, and root `overallVerdict: Pass`. `Not Ready` requires null next action, at least one blocked
assumption or blocker, and non-pass verdict. Literal `Ready` is rejected for BCF-00 because A-02,
A-03, and A-06 remain constrained at later checkpoints. The rationale is bounded diagnostic text
derived from the ordered failed/pending conditions, not caller prose.

`ConsumerVersionDecision` is produced only by `receipt-producer-scan` as
`consumer-version-decision.json`. Its exact query is A-01's literal direct `rg` argv; the helper
hashes the canonical argv and requires `inventoryQuerySha256` to match. Inventory matches sort by
`path,line,column,matchKind,matchedToken`, use positive line/column integers,
`matchKind: producer-call|compatibility-read|schema-reference`, a bounded literal token from the
query match, and the SHA-256 of the complete matched source line. Every match is referenced exactly
once by `localConsumers[].matchRefs`; consumer rows sort by `consumerId` and use
`kind: producer|reader|test|documentation`, a normalized tracked path, bounded symbol,
`schemaSupport: schema-1|schema-1-read-schema-2-write|schema-1-and-2`, and sorted unique references.
The fixed scalar decision is package `0.1.0`, current schema `1`, proposed schema `2`,
`supportStage: beta-shadow-only`, `externalConsumers: unknown`,
`compatibilityReader: schema-1-read-render`, `rollbackCommit` equal to the verified BCF-03 terminal
head, `decision: pre-1.0-shadow-compatible`, `releaseNoteRequired: false`, and `overallVerdict: Pass`.
Limitations are the one-element semantic array `external-consumers-unknown`. A named external
consumer, stable/public compatibility promise, missing/unclassified match, package/version drift,
or rollback-head mismatch makes the check non-pass and it emits no passing decision artifact.

`FeedbackMeasurements` is exclusively written through the helper-created one-use Task 5 channel
and admitted by `feedback-green`; `feedback-budget` reparses those exact bytes and producer/hash
relations without copying them. The `budgets` object contains the exact 15
`DEFAULT_BOUNDARY_BUDGETS` integer values declared in Task 3. Scenario rows have contiguous
ordinals and the semantic order `ordinary`, `human-at-limit`, `human-one-over`, `json-at-limit`,
`json-one-over`, `multibyte`. Subject is `aggregate|public-text|canonical-json|utf8-text`; input,
limit, output, and count fields are nonnegative safe integers; all digests are `Sha256`; and both
dispositions are `accepted|diagnostic-inconclusive`. The two at-limit rows require input bytes equal
the relevant limit and accepted disposition; the two one-over rows require exactly limit plus one
and diagnostic-inconclusive; `ordinary` must be accepted; `multibyte` must prove independently
computed UTF-8 byte rather than code-point counts. Every human result, including the diagnostic,
is at most `maxHumanBytes` including its final LF; every JSON result is at most `maxJsonBytes`;
detailed findings are at most 12; and rendered plus omitted counts and both digests must equal the
independent fixture oracle. The token is never serialized; only its helper-computed `tokenSha256`
appears. Duplicate scenario, wrong order/producer/token/head, production-derived counters, or a
one-byte bound error is non-pass.

`DocsLineageReport` is produced only by `docs-lineage-scope` as `docs-lineage.json`. No lineage
anchor is read from an environment variable or CLI field. The helper derives validator commit from
the verified BCF-00 reconciliation completion receipt's `entryHead`, validator base from that
commit's sole parent, upstream merge and reconciled base from its `terminalHead`/`reconciledBase`,
upstream second parent from `upstreamObservedOid`, docs entry/current heads from BCF-08B manifest
state, and `originMain` from the final `git rev-parse` operation. It requires the two stored
reconciliation heads and two derived merge parents to agree before running later operations.
Operations have ordinals 1–10 and exact IDs `diff-check`, `status-short`, `validator-endpoints`,
`validator-name-status`, `validator-stat`, `merge-origin`, `upstream-name-status`, `upstream-stat`,
`authored-name-status`, `authored-stat`; argv is exactly the ten Step 5 arrays after helper-only OID
substitution. Each row records direct status and stream hashes plus parsed OIDs/paths; rows sort only
by ordinal. Path classifications sort by `path,source,status`, use Git name-status grammar, and
`source: validator|upstream|authored|b-delta`; every parsed changed path has exactly one applicable
classification. `bEntryIdentity` copies the B entry snapshot plus exact five file hashes; public
surface, publication audit, and the A-produced bytes remain unchanged as Task 8 requires. Any
caller endpoint, moving `origin/main`, missing/extra operation, unclassified path, nonzero/signal,
three-file validator interval drift, parent mismatch, forbidden authored path, owner/staging change,
or B delta outside handoff plus the two generated indexes is non-pass.

`MergeConflictResolutionReport` exists only inside the reconciliation transition attempt when the
closed generated-index exception is exercised. It has integer `schemaVersion: 1`, literal policy
`regenerate-generated-work-index`, `beforeHead` equal the frozen transition entry head,
`expectedSecondParent` equal literal `5d16cd401e1250f417f7bde481a4cc8b0ad1df55`, exact sorted conflict/resolved path arrays
containing only `docs/work-index.json` and `docs/work-index.md`, and stage rows sorted by
`path,stage`. A stage is integer `1|2|3`, mode is six-digit ASCII-octal Git mode, and OID is lowercase
40-hex. Generator argv is the one closed array; each raw exit/signal pair follows
`StatusOrSignal`; successful resolution requires exit 0/null for generator, diff check, and guard,
empty unmerged/conflict-marker arrays, two snapshot `Sha256` values, and `verdict: Pass`. The report
is nested in the transition structured result and is never an independently admitted substitute for
the transition. On rejection it preserves every reached direct status and conflicting stage but can
never be promoted to Pass by a later retry under the same run ID.

The sibling completion and final-closeout objects are equally closed:

| Object | Exact keys |
|---|---|
| `CompletionReceipt` | `schemaVersion`, `taskId`, `profileId`, `runId`, `entryHead`, `terminalHead`, `manifestSha256`, `manifestLockSha256`, `ledgerSha256`, `predecessorReceiptSha256`, `predecessorLedgerSha256`, `reconciledBase`, `upstreamObservedOid`, `corpusDigests`, `oracleDigest`, `lifecycleStatus`, `finalGate`, `overallVerdict` |
| `ChainLedger` | `schemaVersion`, `rows`, `reconciledBase`, `upstreamObservedOid`, `corpusDigests`, `oracleDigest` |
| `ChainRow` | `ordinal`, `taskId`, `profileId`, `runId`, `entryHead`, `terminalHead`, `manifestSha256`, `previousLedgerSha256`, `overallVerdict` |
| `corpusDigests` | `cases`, `holdout` |
| `CloseoutCore` | `schemaVersion`, `runId`, `taskId`, `profileId`, `terminalHead`, `snapshotDigestSha256`, `helperCommit`, `helperSha256`, `runManifestSha256`, `runManifestLockSha256`, `finalizeRawExit`, `finalizeRawSignal`, `verifyRawExit`, `verifyRawSignal`, `completionReceiptSha256`, `completionReceiptLockSha256`, `ledgerSha256`, `ledgerLockSha256`, `startedAtUtc`, `endedAtUtc`, `lifecycleStatus`, `requiredAttemptIds`, `requiredChildAliases`, `internalStatus`, `overallVerdict` |
| `CloseoutInternalStatus` | `stage`, `rawExit`, `rawSignal`, `expectationMet`, `verdict` |
| `CloseoutNegativeReport` | `schemaVersion`, `runId`, `closeoutCoreSha256`, `cases`, `startedAtUtc`, `endedAtUtc`, `overallVerdict` |
| `CloseoutNegativeCase` | `ordinal`, `mutationId`, `fixturePath`, `expectedReasonCode`, `rawExit`, `rawSignal`, `expectationMet`, `stdoutSha256`, `stderrSha256`, `treeDigestSha256`, `verdict` |
| `CloseoutReceipt` | `schemaVersion`, `kind`, `runId`, `taskId`, `profileId`, `terminalHead`, `snapshotDigestSha256`, `helperCommit`, `helperSha256`, `runManifestSha256`, `runManifestLockSha256`, `finalizeRawExit`, `finalizeRawSignal`, `verifyRawExit`, `verifyRawSignal`, `completionReceiptSha256`, `completionReceiptLockSha256`, `ledgerSha256`, `ledgerLockSha256`, `startedAtUtc`, `endedAtUtc`, `lifecycleStatus`, `requiredAttemptIds`, `requiredChildAliases`, `closeoutCoreSha256`, `negativeControlReportSha256`, `failedStage`, `runVerdict`, `rawExit`, `rawSignal`, `reasonCode`, `manifestState`, `overallVerdict` |

Completion/ledger `schemaVersion` is integer `1`. Receipt IDs/tasks/profiles and lifecycle/gate/
verdict fields use their closed types; heads are `Oid`; manifest/lock/ledger/corpus/oracle values are
`Sha256`; predecessor receipt/ledger values are null only for the BCF-00 genesis; reconciled/upstream
values are `Oid`; and `corpusDigests` is exactly two `Sha256` fields. Ledger rows use contiguous
positive integer ordinals, closed IDs, two heads, a manifest `Sha256`, nullable
`previousLedgerSha256`, and `Verdict`; the first row alone uses null, while every later row names
the exact predecessor ledger digest. Row order is the implementation-chain order and is never
sorted after append. A row never names its own completion-receipt digest: the receipt hashes the
completed ledger, so that reverse edge would create an uncomputable hash cycle.

Closeout/core/report `schemaVersion` is integer `1`; IDs/tasks/profiles, lifecycle, required arrays,
and verdicts use their closed types; heads/helper commits are `Oid`; every named digest is `Sha256`;
times are `Time`; and each raw-exit/raw-signal pair follows `StatusOrSignal` when its stage ran or is
the exact null/null pair when it did not. `internalStatus` is a fixed ordered array of stage name,
raw-exit/raw-signal, expectation boolean, and verdict rows owned by the closeout implementation; it
is not caller metadata. Negative cases have contiguous fixed positive ordinals, closed mutation and
reason IDs, confined fixture `Path`, `StatusOrSignal`, boolean expectation, three `Sha256` values,
and `Verdict`.

`kind` is `accepted|rejected`; both variants use that same key set and profile-derived disjoint
paths. Accepted requires every identity/digest/status field, `failedStage: null`, `reasonCode: null`,
`manifestState: finalized`, `runVerdict: Pass`, `rawExit: 0`, `rawSignal: null`, and
`overallVerdict: Pass`. Rejected requires `failedStage:
finalize|verify|verdict|negative-control|completion`, a bounded closed `reasonCode`, explicit
`manifestState: not-produced|produced-unverified|verified-nonpass|verified-pass-closeout-rejected`,
and non-pass `overallVerdict`; a digest/status for a stage never reached is null, while every value
for a reached/produced stage is non-null. `CloseoutNegativeCase` rows use the fixed matrix ordinal,
not caller order. Receipt, ledger, manifest, core, and negative-report locks use the exact lock
grammar above. Tests snapshot every exact key set and canonical byte string, then exercise one nearest
invalid and one valid neighbor for duplicate keys, unknown/missing keys, nullability, ordering,
timestamp grammar, numeric grammar, string/path bounds, lock basenames, and one-byte mutation.

The manifest state machine is also closed. `init` exclusively creates an `active` manifest plus the
immutable init anchor/lock, with no final manifest lock or completion bundle. Read-only `verify`
detects state from canonical manifest bytes and first verifies the init anchor/lock;
it has no caller-selectable active/finalized mode. For `active`, it checks the active schema,
document/helper/current-snapshot hashes, admitted closure, and the required absence of every final
lock/bundle; success reports `verificationScope: active` and remains non-promotable Inconclusive.
For `finalized` or `verified-pass-closeout-rejected`, it requires and recomputes the manifest lock,
completion receipt/lock, ledger/lock, recursive imports, and exact terminal snapshot. An active
manifest with a final file, a finalized manifest missing one, or a caller-supplied state selector is
non-pass. `--expect-current-snapshot` adds only the live snapshot equality assertion.

Head ownership is profile- and attempt-owned. `entrySnapshot` never changes;
`currentSnapshot == entrySnapshot` at init. Every `RUN_ATTEMPT_CONTRACTS` entry has exact
`headAnchor: entry|terminal|transition`. Observation and no-transition profiles use `entry` and must
finish with equal entry/terminal heads. Code/docs profiles run all non-transition attempts at
`entry`; their commit attempt uses `transition` and atomically establishes `terminal`/current state.
Reconciliation uses `transition` for the merge and `terminal` for every post-merge, predecessor, and
readiness attempt. Lifecycle completion, finalization, verification, and every artifact admission
bind the owning attempt's anchor; the transition record owns both pre-entry and post-terminal
snapshots. A globally same-head shortcut, caller-selected anchor, or artifact at the wrong anchor is
non-pass.

`init` uses exclusive directory creation and fails if the path exists. Before any leaf exists, the
helper resolves the evidence root strictly, requires it to be an existing real directory outside
the tracked/allowed-untracked/preserved-owner closures, and walks each fixed phase parent one segment
at a time with `lstat`; no ancestor may be a symlink. It records each parent device/inode. A derived
run/completion/closeout/failure leaf is computed lexically below that canonical parent, must be
`ENOENT`, and is reserved in the manifest. Immediately before creation the helper repeats every
ancestor check and parent device/inode comparison, then calls one-segment, non-recursive exclusive
`mkdir`, resolves the new leaf strictly, and proves its realpath is the expected descendant and its
parent identity is unchanged. On mismatch it removes only a still-empty leaf whose device/inode it
created and recorded; it never removes or adopts a foreign path. Completion/closeout/failure leaves
remain reserved-and-absent until their owning operation repeats the same algorithm. Tests replace an
ancestor, race the parent, precreate the leaf, substitute a symlink, and use a valid fresh sibling.

The helper then computes the canonical worktree snapshot, rejects unexplained untracked paths, and
records every preserved owner path's type/mode/size/hash without admitting it as a task output. The
snapshot excludes only the strictly resolved active helper-owned run and its reserved derived roots;
the profile-owned sibling completion-receipt root is excluded under the same rules. Those paths must
already be Git-ignored and have no symlink or ancestor/descendant overlap with any tracked,
allowed-untracked, or preserved-owner path. Their closed manifest-declared closure is hashed
separately. Every other ignored or untracked path remains in the worktree snapshot, so recorder
writes cannot create self-reference and the exclusion cannot hide task output. `record-command` owns direct
stdout/stderr files, exit/signal/start/end/argv/cwd, and the pre/post snapshot; it never uses a
pipeline. Repeatable `--allow-path`, `--allow-untracked`, and `--preserve-owner-path` options are
closed repository-relative declarations: an allowed path may change, an allowed-untracked regular
file may be created, and a preserved owner path must not change. Repeatable `record-command
--output-path` declarations instead name normalized run-relative non-symlink regular files below the
run and are frozen before the child process starts. Empty, absolute, escaping, reserved, or duplicate
declarations exit 2. After execution, each declared output is recorded as `missing` or `pending`;
stdout/stderr and a structured-result file are helper-owned logs, not implicit artifact admissions.
An expectation-met child with any `missing|pending` declared output retains direct status and
`expectationMet: true` but its attempt verdict remains Inconclusive. An unsuccessful child may leave
an output `missing`, but every output it did create is `pending` and must still be admitted.
`record-artifact` is the only operation that promotes one matching pending output to `admitted`; the
last required admission atomically promotes the attempt to Pass only when its exit/result predicates
already pass. Finalize rejects every `pending` output and every existing unregistered file. It may
preserve `missing` only on an expectation-unmet non-pass attempt; `missing` on an expectation-met
attempt or in any overall Pass is non-pass.
Every operational profile, run, attempt, and child-alias ID uses canonical grammar
`[a-z][a-z0-9-]{0,63}`; empty, control-bearing, path-like, overlength, duplicate, or case-variant IDs
exit 2 before mutation. Task IDs come only from the closed profile table, artifact identity is its
normalized relative path, and review finding IDs retain their separately validated contract grammar.
`record-command --expect-exit` accepts only `nonzero` or a
comma-separated set of decimal statuses in `0..255`; omission means `0`, and the observed direct
status must satisfy the declaration without changing the recorded raw status.

After the validator exists, `record-git-transition` is the only operation allowed to move a run's
Git head. The sole pre-run exception is the BCF-00A bootstrap commit in Task 0 Step 2. Its parent must
be exact `BCF_VALIDATOR_BASE`; its staged set is exactly
`scripts/lib/verification/boundary-run-manifest.ts`, `scripts/verify-boundary-run.ts`, and
`tests/scripts/verify-boundary-run.test.ts`; and its literal subject is
`feat(quality): add boundary run validator`. Hooks remain enabled; amend, rewrite, bypass flags,
extra parents, or any other Git mutation are forbidden. Immediately before the bare commit, the
lead freezes the index tree, full status, and preserved-owner snapshot; afterward it requires one
parent equal the base, commit tree equal the frozen index tree, no remaining delta on the three
paths, and byte-identical owner state. The direct receipt is advisory bootstrap evidence only. A
failed commit or failed postcondition stops without retrying or altering that index; Step 3 must
re-prove the immutable commit/helper identity before any accepted run or fetch.

For every subsequent mutation, the selected
profile authorizes exactly one closed transition kind `merge` or `commit`; all other profiles reject
it. It verifies the current head and full snapshot before mutation, owns the direct Git child, and
captures stdout/stderr/status/signal plus pre/post index, tree, parent, and worktree identities. For
`merge`, the helper itself invokes `git merge --no-edit <expected-second-parent>`, requires first
parent equal the frozen pre-head and second parent equal the declared observation OID, and normally
treats every nonzero/conflict as failed: it records the paths and index stages, invokes
`git merge --abort`, and proves exact pre-state restoration. The sole closed exception is
`merge-transition` in profile `bcf00-reconciliation` when the pinned expected second parent is
exactly `5d16cd401e1250f417f7bde481a4cc8b0ad1df55` and both the pinned preview and direct merge report
exactly `docs/work-index.json` and `docs/work-index.md` as the complete conflict set with no other
path unmerged. Its attempt contract owns
`conflictPolicy: regenerate-generated-work-index`, the literal pinned
`bash scripts/run-with-pinned-npm.sh run work-index:regen` generator argv, and the literal pinned
`bash scripts/run-with-pinned-npm.sh run guard:work-index` guard argv; callers cannot request the
policy or supply resolved bytes. The helper records every stage-1/2/3 mode/OID in a
`MergeConflictResolutionReport`, runs the generator under its existing transition watchdog, proves
that only the two generated files changed during resolution, stages exactly those two files,
requires zero unmerged entries and zero conflict-marker matches, then runs `git diff --check` and
the work-index guard directly. It records every direct status and the resolved-state digest before
allowing the original merge commit to complete. Any extra/missing conflict, generator or guard
nonzero/signal, extra generated path, symlink/non-regular file, remaining stage/marker, index/head/
parent drift, commit failure, or failed postcondition invokes `git merge --abort`, must restore the
exact frozen head/index/worktree/owner snapshot, and leaves the transition non-pass. A future OID
whose OID or conflict set differs by even one value is not covered by this amendment and stops for
a new conflict-specific plan amendment. For `commit`, it verifies the exact staged allowlist and bounded
`--message-subject` hygiene before invoking `git commit -m <declared-subject>`, then requires one parent
equal the pre-head, a commit tree equal the frozen index tree, and no uncommitted allowed-path delta.
Only a successful exact transition atomically advances the run's expected head/snapshot anchor;
the reconciliation merge transition also single-assigns `reconciledBase` to that exact merge commit;
foreign parents, amend/rewrite, hook bypass, index drift, extra paths, incomplete abort, or a second
transition exit nonzero. Snapshot tests cover the exact current generated-index neighbor plus an
extra conflict, a missing conflict, generator extra-path write, marker survival, guard failure,
parent/head drift, rollback mismatch, and a second transition. This operation replaces bare Git mutation for the Task 0 merge, every
BCF-01–07 code commit, and the Task 8 documentation commit.

`finalize` requires every declared output admitted and every admitted artifact hash-current, recursively
validates imported child runs, review joins, and lifecycle records, writes all hashes, marks the run
immutable, and fails if the snapshot changed outside the task allowlist. `verify` follows the
active/finalized auto-detection contract above and recomputes the closure appropriate to that state.
After the manifest/lock are durable, `finalize` exclusively writes the closed completion receipt and
ledger bundle described above; bundle creation failure leaves the manifest preserved but the run
Inconclusive and unusable as a predecessor. A retry uses a new run rather than overwriting either
root. At finalization it also computes immutable
root `overallVerdict` from the closed lifecycle state and the exact required attempt and child sets
owned by the selected `RUN_CONTRACT_PROFILES` entry; callers cannot add, remove, or replace those
sets. A required attempt must exist with `expectationMet: true` and
verdict `Pass` for an overall Pass. Every admitted child is aggregated, and every profile-required
child alias must exist with the exact declared kind and child `overallVerdict: Pass`; a structurally
valid non-pass child can be archived but never absorbed into a passing parent. Non-pass aggregation
uses deterministic precedence `Blocked > Fail > Inconclusive > Pass`.

Review findings are part of the same algebra, not advisory metadata. The closed finding schema owns
`severity: blocker|critical|major|minor|note`, `requiresFix`, `disposition:
accepted|rejected|deferred`, and `resolution: open|fixed|not-applicable`. An accepted reproduced
`blocker`/`critical` with `requiresFix: true` and no later fixed proof maps the parent to Blocked; an
accepted unresolved `major|minor` maps Fail. A deferred required blocker/critical maps Blocked and
any other deferred required finding maps Inconclusive. `note` may be non-actionable only with
`requiresFix: false` and a bounded reason. `fixed` requires a later exact-head lead reproduction
that makes the original unsafe case pass, preserves its registered safe control, and is joined to a
new review row; the review child cannot certify its own fix. `rejected` requires bounded
counterevidence plus a lead reproduction attempt proving the cited unsafe case does not reproduce
and the neighboring control still passes. Missing counterevidence or reproduction is Inconclusive.
BCF-08A and BCF-08C recompute this finding algebra across their exact direct/recursive review
closures, so a structurally Pass review run with one confirmed critical finding cannot close the
parent. Tests cover open accepted critical/major, deferred, unsupported rejection, valid rejection,
fixed at wrong head, valid later-head fix, and no-finding neighbors.

Lifecycle `blocked` or final
gate `blocked` maps Blocked; a deterministic failed required attempt or final gate `fail` maps Fail;
lifecycle `pending|active|deferred`, final gate `not-run|inconclusive`, or any missing required item
maps Inconclusive. Only the profile's terminal lifecycle plus final gate `pass` can permit Pass. The
terminal lifecycle is `completed` for every profile except non-completing `bcf00-observation`, where
it is `closed`; that closed Pass can satisfy a child join but cannot advance BCF-00. A missing
helper, direct status,
allowed-untracked record, output registration, child closure, or current-snapshot match is
Inconclusive; no manual receipt substitutes for this protocol.

`record-artifact` is the only admission path for a non-log child artifact. It accepts one
run-relative regular non-symlink file below the run, one existing producer-attempt ID, and one closed
role `input|output|receipt|review|lifecycle|oracle|scope|measurement`. It rejects the manifest/lock
files, path escape, duplicate logical paths, producer mismatch, unknown roles, and any file outside
the producer attempt's declared output allowlist or not currently `pending`. Registration records
path/role/producer/hash/bytes, atomically changes that output admission to `admitted`, and applies the
attempt-promotion rule above; it never manufactures or overwrites the producer's status. Finalization
recomputes every admission and rejects automatic directory discovery or unregistered files
referenced by a verdict.
`record-child-run` is the only cross-run admission path. It accepts a unique alias matching
`[a-z][a-z0-9-]{0,63}`, a closed kind
`observation|docs|review|reproduction|predecessor`, and a finalized
helper-owned child run. It first executes the same read-only verification as `verify`, then imports
only the child manifest/final lock, immutable init anchor/lock, and manifest-declared attempt,
artifact, predecessor, and recursive-child closure into an exclusively created `children/<alias>/`
directory. The join record stores kind, child task/run ID, child head/snapshot,
source manifest hash, sorted imported relative-path/hash/byte rows, and a canonical tree digest;
source paths are never authoritative. It rejects mutable/unfinalized children, unknown files
referenced by a verdict, alias reuse, cycles, any nested depth above two except the one exact
profile-owned depth-three BCF-08 closeout chain defined below, hash/path mismatch, or a child
whose task/head/run ID/manifest digest does not exactly equal the required `--expect-task`,
`--expect-head`, `--expect-run-id`, and `--expect-manifest-sha256` declarations. The expected digest
is compared before import and again against the copied lock; the source cannot self-select its
parent identity.

`record-review` has two closed modes; no mode is inferred from a caller flag. In a source review
profile (`bcf-review-contract|bcf-review-redaction|bcf-review-integration`), `--alias` must be the
profile-owned alias `review-contract|review-redaction|review-integration`, and `--review-path` is a
run-relative canonical `reviewInput` JSON file inside the active run. The profile also owns the
dedupe key respectively `contract-cli-review|redaction-async-review|integration-blast-review`.
The helper requires the input head/snapshot to equal the run entry, verifies the exact bytes/hashes
of report, meta, stderr, and every finding evidence path under the run root, rejects symlinks or
unreferenced reproduction contracts, and stores the alias-added `review` row. This source-mode check
validates reproduction declarations but does not pretend the later lead attempts already ran.
`review-schema-check` revalidates that stored row and closure; child import includes every stored
review report/meta/stderr/evidence path in addition to the manifest-declared attempt/artifact closure.

In a parent profile with imported review children, `--alias` must name one exact imported review
child and `--review-path` must be the literal imported path
`children/<alias>/run_manifest.json`. The helper requires that child manifest to contain exactly one
source-mode review whose alias/dedupe/head/snapshot equal the child contract, prefixes its evidence
paths with `children/<alias>/`, and stores that bound row in the parent. It then loads proof attempts
only from the already imported `lead-reproduction` child. Each proof must have the same ID, literal
argv, expected exit, frozen tool, 900,000 ms/30,000 ms deadline/grace, exact review head/snapshot,
direct exit-or-signal, `expectationMet: true`, and `Pass` as its unique reproduction contract.
Missing, extra, reused, harmless-command-substituted, foreign-head, stale-snapshot, or non-pass proof
is Inconclusive. Parent finalization requires all three role rows and runs the complete finding join;
source review finalization requires schema/closure validity but never upgrades an unexecuted proof.
Docs and reproduction joins use their corresponding imported aliases. Finalize and verify recursively
recompute the imported closure and never rediscover files by directory walk.

`RUN_CONTRACT_PROFILES` is a closed helper constant and the runtime SSOT for completion-critical
attempts, child joins, transition authority, and whether a run may complete its task. `init` accepts
only the task/profile pair below plus its profile-owned predecessor pin and copies its immutable sets
into the manifest; no caller-supplied
required-attempt or required-child override exists. Every profile's terminal lifecycle is
`completed` except `bcf00-observation`, whose terminal lifecycle is `closed` and whose
`mayComplete: false` prevents a task-state transition.

| Profile | Task | Required attempt IDs | Required child alias/kind | Head transition | May complete task |
|---|---|---|---|---|---|
| `bcf00-observation` | `BCF-00` | `validator-suite-postcommit`, `validator-typecheck-postcommit`, `upstream-root`, `upstream-head`, `upstream-status`, `upstream-remote`, `upstream-fetch`, `upstream-origin-oid`, `upstream-merge-base`, `upstream-ahead-behind`, `upstream-remote-diff`, `upstream-local-diff`, `merge-preview` | none | none | no |
| `bcf00-reconciliation` | `BCF-00` | `merge-transition`, `postmerge-validator-suite`, `postmerge-validator-typecheck`, `predecessor-focused`, `predecessor-typecheck-scripts`, `predecessor-typecheck-all`, `predecessor-baseline-eval`, `predecessor-candidate-eval`, `predecessor-holdout-eval`, `predecessor-branch-gate`, `readiness-check` | `upstream-observation:observation` | one merge | yes |
| `bcf01-parser` | `BCF-01` | `parser-red`, `parser-green`, `parser-typecheck`, `parser-scope`, `parser-commit-transition` | none | one commit | yes |
| `bcf02-catalog` | `BCF-02` | `catalog-inventory-raw`, `catalog-inventory-strip`, `catalog-inventory-sort`, `catalog-inventory-count`, `catalog-red`, `catalog-green`, `catalog-typecheck`, `catalog-scope`, `catalog-commit-transition` | none | one commit | yes |
| `bcf03-contract` | `BCF-03` | `contract-red`, `contract-green`, `contract-typecheck`, `contract-scope`, `contract-commit-transition` | none | one commit | yes |
| `bcf04-receipt` | `BCF-04` | `receipt-red`, `receipt-green`, `receipt-typecheck`, `receipt-producer-scan`, `receipt-staged-scope`, `receipt-commit-transition` | none | one commit | yes |
| `bcf05-feedback` | `BCF-05` | `feedback-red`, `feedback-green`, `feedback-budget`, `feedback-typecheck`, `feedback-scope`, `feedback-commit-transition` | none | one commit | yes |
| `bcf06-provider` | `BCF-06` | `provider-red`, `provider-green-one`, `provider-green-two`, `provider-typecheck`, `provider-scope`, `provider-commit-transition` | none | one commit | yes |
| `bcf07-integration` | `BCF-07` | `integration-red`, `integration-focused`, `integration-typecheck-scripts`, `integration-baseline-eval`, `integration-candidate-eval`, `integration-holdout-eval`, `integration-scope`, `integration-commit-transition` | none | one commit | yes |
| `bcf-review-contract` | `BCF-REVIEW` | `review-schema-check`, `review-scope-check` | none | none | yes |
| `bcf-review-redaction` | `BCF-REVIEW` | `review-schema-check`, `review-scope-check` | none | none | yes |
| `bcf-review-integration` | `BCF-REVIEW` | `review-schema-check`, `review-scope-check` | none | none | yes |
| `bcf-reproduction` | `BCF-REPRODUCTION` | `reproduction-suite`, `reproduction-scope-check` | none | none | yes |
| `bcf08a-docs` | `BCF-08A` | `docs-work-index-regen`, `docs-work-index-guard`, `docs-publication`, `docs-drift`, `docs-tally`, `docs-authoring-scope` | `review-contract:review`, `review-redaction:review`, `review-integration:review`, `lead-reproduction:reproduction` | none | yes |
| `bcf08b-docs` | `BCF-08B` | `docs-focused`, `docs-typecheck-scripts`, `docs-typecheck-all`, `docs-test-integrity-preflight`, `docs-test-integrity-scan`, `docs-baseline-eval`, `docs-candidate-eval`, `docs-holdout-eval`, `docs-work-index-regen`, `docs-work-index-guard`, `docs-publication`, `docs-drift`, `docs-tally`, `docs-lineage-scope`, `docs-staged-scope`, `docs-commit-transition` | `docs-precommit:docs` | one commit | yes |
| `bcf08-final` | `BCF-08C` | `final-upstream-remote`, `final-upstream-refresh`, `final-upstream-origin-oid`, `final-upstream-merge-base`, `final-upstream-ahead-behind`, `final-upstream-remote-diff`, `final-upstream-local-diff`, `watchdog-canary`, `watchdog-parent-dead`, `watchdog-child-dead`, `watchdog-group-dead`, `final-branch-gate` | `docs:docs`, `review-contract:review`, `review-redaction:review`, `review-integration:review`, `lead-reproduction:reproduction` | none | yes |

`RUN_PREDECESSOR_CONTRACTS` is a separate closed constant that prevents direct task entry or a local
Pass from bypassing earlier evidence. Finalization first writes and locks the immutable run manifest,
then exclusively creates a derived sibling `<evidence-root>/completion/<run-id>/` containing
`chain_ledger.json`, `chain_ledger.sha256`, `completion_receipt.json`, and
`completion_receipt.sha256`. The closed receipt contains task/profile/run ID, entry/terminal head,
manifest/lock digests, ledger digest, predecessor receipt/ledger digests, reconciled base, upstream
observation OID, corpus/oracle digests, lifecycle/final-gate state, and computed verdict. The flat
ledger contains the ordered implementation-chain rows; a row contains the current manifest digest
and previous-ledger digest but never its own completion-receipt digest, avoiding a hash cycle. The
sibling receipt is not admitted back into the finalized manifest.
The sole exception is BCF-08C: it has no successor, so its completion bundle is prepared beneath the
accepted closeout directory and published with that directory in one atomic rename, never in the
generic sibling completion root.

`init` accepts only the exact paired predecessor options defined in Mandatory task-run protocol. It
verifies the source manifest/lock, completion receipt/lock, and ledger/lock with the committed helper;
compares every pin field before and after copying; imports the six manifest/receipt/ledger files plus
the manifest-declared minimal verification closure under `predecessor/`; requires predecessor verdict Pass and the profile-owned head/
ledger relation; then freezes their hashes in the new manifest root. It never trusts a caller
summary or mutable source path. A source disappearing after verification, copy/hash mismatch, or a
receipt whose manifest/ledger digest disagrees is Inconclusive and leaves no initialized run. The
flat ledger is not a child-artifact closure and does not increase review/docs nesting depth.

| Profile | Exact predecessor profile | Required relation |
|---|---|---|
| `bcf00-observation` | none | non-completing observation; completion receipt has `chainAppend:false` and the canonical empty ledger |
| `bcf00-reconciliation` | `bcf00-observation` | predecessor pin and required observation-child pin identify the same run/manifest/completion receipt/empty ledger; same entry head; reconciliation creates the completing-chain genesis only after Pass |
| `bcf01-parser` | `bcf00-reconciliation` | predecessor terminal head equals entry head; import reconciled/oracle digests |
| `bcf02-catalog` | `bcf01-parser` | predecessor terminal head equals entry head |
| `bcf03-contract` | `bcf02-catalog` | predecessor terminal head equals entry head |
| `bcf04-receipt` | `bcf03-contract` | predecessor terminal head equals entry head |
| `bcf05-feedback` | `bcf04-receipt` | predecessor terminal head equals entry head |
| `bcf06-provider` | `bcf05-feedback` | predecessor terminal head equals entry head |
| `bcf07-integration` | `bcf06-provider` | predecessor terminal head equals entry head; exact inherited evaluator corpus/oracle digests |
| each `bcf-review-*` and `bcf-reproduction` | `bcf07-integration` | read-only run entry head equals BCF-07 terminal head; pairwise distinct run identity |
| `bcf08a-docs` | `bcf07-integration` | entry head equals BCF-07 terminal head; its four child runs carry the same ledger digest |
| `bcf08b-docs` | `bcf08a-docs` | existing `docs-precommit` child and ledger refer to the same run/manifest; same entry head/snapshot relation defined below |
| `bcf08-final` | `bcf08b-docs` | existing `docs` child and ledger refer to the same run/manifest; predecessor terminal head equals final entry head |

Every implementation-chain ledger transition preserves all prior rows byte-for-byte, appends exactly
one authorized profile, and recomputes the digest. Observation finalization emits
`chainAppend: false` with the one canonical empty ledger and never creates a BCF-00 row. Reconciliation rejects
unless its predecessor import and `upstream-observation` child import are byte-identical pins for
that same observation run; its Pass creates the sole BCF-00 genesis row. Review/reproduction
finalization likewise emits its own completion receipt with `chainAppend: false` and the unchanged
BCF-07 ledger; it does not append a task row. `bcf08-final` rejects standalone `finalize`; BCF-08C appends and emits its completion
bundle only inside authoritative closeout after the built-in negative matrix passes. Final closeout requires exactly one Pass row in order for BCF-00 reconciliation,
BCF-01–07, BCF-08A, BCF-08B, and the atomically finalized BCF-08C row; its direct
reviews/reproduction must bind the BCF-07 ledger digest,
and its docs child must bind the full BCF-08B ledger. Reconciled base, upstream OID, corpus digests,
case-label oracle digest, and historical 39/40 disposition are immutable inherited fields. Tests
reject direct BCF-02–08 init, missing/non-pass/foreign predecessor, same-head wrong manifest,
observation predecessor/child splicing, nonempty observation ledger, observation chain append,
forked/reordered/duplicate ledger, changed oracle digest, child/ledger disagreement, review at a
different BCF-07 ledger, and forged final history; the exact next-profile neighbor passes.

`RUN_ATTEMPT_CONTRACTS` is the second closed helper constant. It contains exactly one entry for the
union of required IDs above, with fields `operation: command|internal-check|git-transition`, literal
normalized argv template, closed internal-check name, or transition kind, `expectedExit`,
`watchdogOwner: helper-watchdog` for external children, optional
`innerTimeoutOwner: null|gnu-timeout`, exact `deadlineMs`/`killGraceMs`, and sorted run-relative
`outputPaths`, optional prior-attempt `stdinSource`, optional closed `stdoutPredicate`, optional
helper-owned structured-result path and closed `resultPredicate`, plus a closed environment
allowlist, and exact `headAnchor: entry|terminal|transition`. Transition entries additionally own the exact message subject (commit),
parent relation, and staged/merge-path allowlist source. The argv templates are the exact direct command arrays in Tasks 0–8; one child
process equals one attempt. The four Task 2 inventory commands, five documentation/index commands,
three evaluator invocations, two typechecks, and every other displayed multi-command block therefore
retain separate IDs as shown above. Allowed placeholders are only `run-dir`, `entry-head`,
`reconciled-base`, `observed-upstream-oid`, `observed-merge-base`, `watchdog-parent-pid`,
`watchdog-child-pid`, and `watchdog-group-pgid`; each is resolved from immutable run fields or the
validated stdout/artifact of the named prerequisite attempt. The three watchdog identities are
positive decimal integers parsed exclusively from the admitted `watchdog-canary` PID artifact;
callers cannot supply or override them. Every executable in a template
comes from the closed tool-name set
`bash|git|rg|tr|sort|wc|test|kill|ps|sleep|test-integrity|gnu-timeout|loadgate`
and is resolved to a real path, version, and file hash by the helper-owned capability preflight
before comparison or spawn.

No required external child has timeout owner `none`. `record-command` and
`record-git-transition` are the external watchdog for every child: they create a new process group,
start the closed monotonic deadline before spawn, capture stdout/stderr directly, send TERM to the
group on expiry, send KILL after the closed grace, reap the leader, prove the group is dead, and
record timeout/signal/survivor as Inconclusive. They never infer status through a pipe or wrapper.
The contract snapshot assigns exact outer deadlines from this closed table: local Git/read/inventory 120 s,
network fetch 300 s, focused tests and typechecks 900 s, evaluator runs 300 s, docs guards 600 s,
Git transitions 300 s, and the complete branch gate 1,860 s around its exact 1,800 s inner GNU
deadline; every class uses a 30 s kill grace. The canary has a 61 s helper deadline around its exact
1 s inner GNU deadline. `gnu-timeout` remains the independently preflighted inner owner for the
canary and branch gate, while the helper watchdog owns the 60 s outer margin and final reaping. An implementer cannot
increase a deadline or select a class at invocation. Timeout tests cover TERM exit, ignored TERM,
forked descendants, child/group disappearance, outer-owner expiry, and a valid neighboring command.

The two authoritative helper processes that are not attempt children are separately fail-closed:
the caller must run `closeout` under a 600 s external GNU-timeout process-group deadline and
`verify-closeout` under a 300 s deadline, each with a 30 s TERM-to-KILL grace and no `--foreground`.
Status 124/137, signal, missing rejection receipt, or any surviving group is Inconclusive. Task 0
snapshot-tests those exact production constants and Task 8 wrapper argv. Behavioral
hanging/forking fixtures exercise the same process-group/TERM/KILL/reap implementation through a
module-internal test-only clock/deadline injection of at most 250 ms plus 100 ms grace; no CLI or
production override exists. Both behavioral cases plus teardown must finish below 10 s, prove the
group is reaped, and retain an unchanged neighboring closeout. No bare final-seam helper invocation
is authoritative evidence.

Required command children run with a reconstructed environment, not ambient inheritance: only resolved
`PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `TZ`, and the helper-resolved test-integrity path may be
present when a contract needs them. The sole additional test channel is helper-created
`BCF_MEASUREMENT_PATH` plus a one-use non-secret `BCF_MEASUREMENT_TOKEN` for `feedback-green`; the
caller cannot select either value. The helper exclusively creates the empty regular file below the
run, passes its canonical path/token through the exact npm→Vitest wrapper, and records the token hash,
declared artifact role/path, device/inode, mode, and close/fsync state. Both variables are absent from
every other child. Tests reject caller injection, symlink/path substitution, token reuse, wrong
inode, and a measurement written by any attempt other than `feedback-green`.
Values are recorded with secrets/local paths redacted from
public output while their hashes remain bound in the ignored manifest. Every `SKIP_*`, `NO_VERIFY`,
CI-mode override, hook bypass, credential, or undeclared variable is removed and its attempted use
is a contract failure.

`RUN_CONTRACT_PROFILES` also owns the exact tracked path set named in each Task's **Files** block.
At init, supplied `--allow-path` values must equal that set. The two dynamic exceptions are closed:
the reconciliation merge set must equal the pinned observation child's previewed upstream paths,
and a review/reproduction profile has no tracked write paths. Both `bcf08a-docs` and `bcf08b-docs`
own the same four Task 8 commit paths—public surface, two generated indexes, and implementation
notes; A may leave only those paths modified and unstaged,
while B may stage/commit exactly those bytes. Relative to B's A-terminal entry snapshot, B may
change only the implementation-notes handoff and the two generated work-index files;
`docs/public-surface.md` must remain byte/mode-equal to A. `docs/publication-audit.md` is a read-only
guard input outside both write sets and must remain equal to the run's preserved-owner snapshot.
Commit-transition contracts require
their literal Task subject, parent equal the profile entry head, and index paths equal that exact
profile set; merge-transition requires the pinned observation OID/preview set. A hygienic but
different subject, subset/superset allowlist, different parent, or right transition kind under the
wrong required ID exits 2 before Git runs.

Entry ownership is fail-closed. `init` for every BCF-01–07 code profile and BCF-08A requires its
entire tracked path set to match the predecessor terminal tree byte/mode exactly, with no staged or
unstaged delta and no allowed-untracked creation already present; preserved owner/unrelated paths may
remain dirty only when their exact snapshot is recorded and subsequently unchanged. The only
exceptions are reconciliation's profile-owned dynamic merge set and BCF-08B's exact A-terminal
dirty-docs snapshot/path hashes. An allowed path is authorization for this run's later mutation, not
permission to absorb pre-entry work. Tests place a one-byte edit, mode change, staged edit, and
allowed-untracked file on an otherwise authorized path and require init to reject without changing
or stashing it; the clean entry and exact A→B handoff neighbors pass.

Required IDs are reserved. Before spawn, `record-command` must load the selected entry and compare
operation, normalized executable/argv, expected-exit declaration, watchdog/inner-timeout owners,
deadlines, head anchor, and output paths
byte-for-byte; declared stdin provenance and stdout predicates are helper-owned and cannot be
supplied at invocation. Extra environment assignments, unlisted shell wrappers, aliases, wildcards, pipes, redirects,
or arguments exit 2. `record-internal-check --run-dir <run> --attempt <id>` accepts no arbitrary
argv and exclusively owns `internal-check` IDs; `record-git-transition` exclusively owns
`git-transition` IDs. Each subcommand rejects IDs owned by either other operation. The RED contracts expect `nonzero`, the
merge preview expects `0,1` under its result predicate, the watchdog canary expects `124,137`, the
three liveness probes expect `nonzero`, and all other required commands/transitions expect `0`;
only the canary and branch gate add inner timeout owner
`gnu-timeout` inside the mandatory helper watchdog. Exit status alone never satisfies a RED contract. Every RED and GREEN Vitest entry
appends the fixed `--reporter=json --outputFile <run-relative-result-path>` arguments to its displayed
selection prefix and predeclares that ignored helper-owned result path. Its closed
`resultPredicate` parses the JSON and binds the exact expected test file, named new falsifier tests,
preserved-behavior RED controls, nearest-valid GREEN controls, and exact registered-marker cardinality from the generated contract snapshot. RED passes
only when every named new falsifier is collected and fails for its declared assertion reason, every
safe control is collected and passes, and there is no import/module/collection/syntax/unhandled or
zero-test diagnostic. GREEN passes only when the same identities are collected and all pass without
such diagnostics. The exact complete registered unsafe-sentinel set plus passing preserved controls makes the RED
attempt Pass despite its expected nonzero child status. A missing module, syntax/collection error,
malformed result, zero tests, or missing marker is Inconclusive evidence; a different deterministic
assertion/regression or failed preserved-safe control is Fail. Both non-pass classes stop promotion,
but retain the correct diagnosis and correction. The Task 0
bootstrap RED remains advisory and cannot satisfy any completion profile until the committed helper
enforces this predicate. Generic non-required attempts are accepted only by `bcf-reproduction`, only
with a tool already frozen at init, entry head/snapshot, null inner-timeout owner, no output path,
and the fixed 900,000 ms/30,000 ms watchdog bounds. They never directly contribute to
`overallVerdict`; they contribute indirectly only when a parent `record-review` matches their exact
ID/argv/status/tool/bounds to one immutable reproduction contract. All other profiles reject a
non-required attempt before spawn. A generated snapshot test asserts the complete profile/attempt-contract digest
and exact coverage in both directions, then proves `final-branch-gate -- true`, wrong evaluator
corpus, collapsed inventory/docs commands, missing output declaration, wrong timeout owner, and a
transition ID sent through `record-command` are rejected before child execution. It also proves a
missing test, zero-test run, collection/import failure, unrelated assertion failure, failed safe
control, malformed result, and right nonzero for the wrong falsifier cannot satisfy RED, while the
complete declared unsafe set paired with all passing controls can.

`RUN_TEST_CONTRACTS` is the third closed helper constant and is included in the generated contract
snapshot digest. RED commands add a fixed `--testNamePattern` selecting every registered unsafe `U`
marker and preserved-behavior `S` marker for that task. Nearest-valid new-behavior neighbors use `N`
markers and are GREEN-only because a not-yet-implemented renderer/parser cannot truthfully pass its
future valid-input contract during RED. The following ordered case registry is exact: every displayed
range expands to every integer in the inclusive range with no gaps. The structured result must
contain each RED marker exactly once in the named file set. GREEN removes the filter and requires all
U/S/N markers plus every other selected test to pass. Mutable prose after a marker is not identity.

BCF-00 uses one exact bootstrap marker and sixteen exact unsafe/nearest-valid pairs. The constant
stores the 33 fully expanded literal IDs—`[BCF00-B01]`, `[BCF00-U01]` through `[BCF00-U16]`, and
`[BCF00-N01]` through `[BCF00-N16]`—not ranges or a prefix predicate. Each marker occurs exactly
once in `tests/scripts/verify-boundary-run.test.ts`; no unregistered `[BCF00-*]` marker is allowed.
`B01` is the advisory scaffold case: before implementation it must reach the exported validator and
fail only with `boundary run validator not implemented`; in every committed/post-merge suite it
must accept that same complete valid snapshot and pass. Each U/N test owns exactly the assertions in
its row:

| Pair | Exact unsafe rejection / nearest-valid acceptance |
|---|---|
| `U01` / `N01` | staged-, unstaged-, mode-, allowed-untracked-, unexpected-untracked-, and preserved-owner-blind snapshot / complete canonical snapshot with unchanged owner |
| `U02` / `N02` | unknown, duplicate, path-like, control-bearing, case-variant, or overlength CLI/operational ID / one closed subcommand with canonical unique IDs |
| `U03` / `N03` | absolute/escaping/overlapping derived root, precreated leaf, symlink ancestor, or parent device/inode race / fresh exclusively created confined sibling |
| `U04` / `N04` | rewritten raw exit, signal satisfying numeric exit, missing status, wrong watchdog/inner owner, or changed deadline / direct expected status with exact owners and deadline |
| `U05` / `N05` | undeclared, missing, pending, duplicate, producer/role-mismatched, or post-admission-mutated output / declared pending file admitted once by its producer and hash-current |
| `U06` / `N06` | wrong task/profile, omitted/extra required set, wrong argv/environment/tool capability, or operation-ID substitution / exact generated profile and attempt contract |
| `U07` / `N07` | missing/zero/skipped/todo/renamed test, collection/import/unhandled error, wrong RED sentinel, or weakened roster / exact nonzero structured roster and declared result predicate |
| `U08` / `N08` | missing/foreign/spliced predecessor, receipt/ledger mismatch, changed inherited oracle, or duplicate/reordered/forked row / exact immutable predecessor pin and authorized append |
| `U09` / `N09` | child alias/kind/task/profile/head/run/digest mismatch, cycle/depth escape, path collision, or imported-byte mutation / one profile-pinned recursively verified import |
| `U10` / `N10` | duplicate finding/review, invalid severity/disposition/resolution fields, missing reproduction, unsupported rejection, or wrong-head fix / unique finding with disposition-valid exact-head proof |
| `U11` / `N11` | caller-substituted upstream field, repeated assignment, wrong transition parent/tree/index/path, incomplete merge abort, or second transition / profile-owned upstream derivation and sole exact transition |
| `U12` / `N12` | invalid lifecycle, wrong terminal state, active/finalized file mixing, snapshot drift, or incomplete required aggregation / coherent profile-terminal lifecycle and auto-detected verification state |
| `U13` / `N13` | duplicate/unknown/missing schema key, invalid UTF-8/BOM/CR/number/timestamp/nullability/order/bound, or malformed lock / exact canonical JSON and sibling lock bytes |
| `U14` / `N14` | manifest/completion/ledger/core/report/receipt substitution, accepted/rejected path collision, reused root, or partial publication / exclusive hash-joined bundle at its derived path |
| `U15` / `N15` | timeout/signal/surviving parent-child-group, wrong wrapper deadline, or masked closeout/verify-closeout status / bounded process group fully reaped with direct status |
| `U16` / `N16` | finalized-byte mutation, helper/document hash drift, reserved-root TOCTOU, owner-path mutation, or retry overwrite / immutable closure with stable ancestors/owner and new-run retry |

Each semicolon-free comma item above is a required subcase inside its named test; the test reports
which fixed subcase failed but retains the marker as its sole identity. A generated snapshot asserts
the literal 33-ID array, the exact row-to-subcase arrays, uniqueness, and bidirectional coverage.
The postcommit and postmerge validator suites select the file directly, require all 33 markers to
pass, require nonzero collected tests and no skip/todo/collection/unhandled error, and reject any
additional or missing contract marker. Thus a generic “all BCF00” name match cannot hide an omitted
negative or neighbor.

| RED / GREEN attempt | Exact test file set | Exact unsafe/safe marker roster and ordered case classes |
|---|---|---|
| `parser-red` / `parser-green` | `semantic-quality-check.test.ts` | `[BCF01-U01–U06]`: mode case, missing value, duplicate mode, duplicate head, duplicate no-receipt, duplicate target-ref; `[BCF01-S01]` preserves a current valid no-op invocation; `[BCF01-N01–N06]` are lowercase valid mode, present value, and one occurrence of each singleton including one full target ref |
| `catalog-red` / `catalog-green` | `semantic-rule-guidance.test.ts` | `[BCF02-U01–U04]`: exact roster coverage, complete versioned guidance, unknown-rule rejection, stable catalog digest; `[BCF02-S01]` preserves frozen schema-1 read/render; `[BCF02-N01–N04]` are exact roster, registered lookup, registered/unknown pair, and repeated same-input digest |
| `contract-red` / `contract-green` | `semantic-boundary-contract.test.ts` | `[BCF03-U01–U10]`: decision/action enums, post-canonical blanks, producer-owned-field injection, target/head identity, local/file redaction, secret/query redaction, timestamp interval, cardinality/UTF-8 admission, duplicate/sort identity, finding-level limitation certainty; `[BCF03-S01]` preserves the legacy schema-1 finding; `[BCF03-N01–N10]` are exact at-boundary valid neighbors, including 64 observations for N10 |
| `receipt-red` / `receipt-green` | `semantic-boundary-contract.test.ts`, `semantic-quality-check.test.ts` | `[BCF04-U01–U09]`: schema discrimination, relevant/unrelated limitation algebra, evidence-digest invalidation, input-order/duplicate identity, action identity, typed diagnostic mapping, producer/version decision enforcement, timestamp canonicalization, malicious stored receipt; `[BCF04-S01]` preserves frozen schema-1 byte-compatible read/render; `[BCF04-N01–N09]` are exact valid schema/head/evidence neighbors |
| `feedback-red` / `feedback-green` | `semantic-boundary-contract.test.ts`, `semantic-quality-check.test.ts` | `[BCF05-U01–U10]`: warn sections, block sections, inconclusive sections, limitation combinations, action-specific pass, 45-finding grouping, detail-count bound, 64-KiB ASCII bound, multibyte boundary, bounded structural overflow; `[BCF05-S01]` preserves frozen schema-1 rendering; `[BCF05-N01–N10]` are complete/in-order/at-limit neighbors and U08–U10 are one-over/hostile-tail cases |
| `provider-red` / `provider-green-one`, `provider-green-two` | `semantic-history-provider.test.ts` | `[BCF06-U01]`: ignore-abort settlement; `[BCF06-S01–S03]`: resolve before deadline, provider-thrown timeout, provider honoring abort; second GREEN repeats the exact roster while checking open handles and late rejection |
| `integration-red` / `integration-focused` | exact seven Task 7 suite files | `[BCF07-U01–U04]`: schema-2 CLI/exit payload, evaluator adaptation, receipt-write failure composition, production-import anti-duplication; `[BCF07-S01]` preserves the frozen per-case oracle and `[BCF07-S02]` preserves Task 1 invalid-invocation exit 2; `[BCF07-N01–N04]` preserve decision/labels, successful write, and production-owner imports |

An unsafe marker's exact RED sentinel is mechanically derived as
`BCF_EXPECTATION_UNMET:<task>-<two-digit-case>`, for example
`BCF_EXPECTATION_UNMET:BCF03-07`; the constant stores the fully expanded strings, not ranges. Each
unsafe test isolates one comparison and throws only that fixed sentinel when the expected new
behavior is absent. Task 2/3 scaffolds translate only their exact explicit not-implemented error
into the applicable sentinel; every other exception escapes and is Inconclusive. The RED predicate
requires exact sentinel equality after ANSI stripping. GREEN requires no sentinel. Sentinel strings
contain no observed values or secrets. Any marker rename/duplicate/wrong file, safe-control failure,
production exception, or wrong sentinel invalidates the attempt with the diagnostic class above.

The structured-result requirement applies to every required Vitest attempt, not only RED/GREEN.
`validator-suite-postcommit` and `postmerge-validator-suite` select only
`tests/scripts/verify-boundary-run.test.ts` and require the exact literal 33-marker BCF-00 registry
above plus every unmarked pre-existing test in the frozen entry roster. `predecessor-focused`
instead selects exactly the six
pre-existing files displayed in Task 0 Step 5, requires their post-reconciliation entry rosters with
nonzero tests and no skip/todo/error/failure, and requires no future `[BCF01-*]` marker or Task 2 file.
The successful merge transition captures that six-file roster under its watchdog as an immutable
post-transition field before any predecessor test runs; it does not reuse the pre-merge init roster.
`integration-focused`, `reproduction-suite`, and `docs-focused` select the exact seven Task 7 suite files and require all
`[BCF01-*]` through `[BCF07-*]` markers. Each contract binds the exact normalized file list, requires
every selected file to contribute at least one test, every required marker exactly once, nonzero
collected/passed counts, zero skipped/todo tests, zero collection/unhandled errors, and zero failures
except that a RED attempt's failure set must equal its fully expanded declared `U` marker set, with
each failure carrying that marker's exact sentinel and every declared `S` control passing. No `N`
marker is selected during RED. The helper derives a canonical sorted
`file + full test name` roster and digest from the structured result and stores it; later
integration/reproduction/docs attempts at the same BCF-07 code snapshot must equal that digest.
A zero-test success, `.skip`, `.todo`, narrowed file selection, missing marker, renamed marker, or
weakened later roster is Fail. Tests mutate each condition and retain an unchanged neighbor.

The anti-weakening baseline is captured before edits, not from the first GREEN. At `init`, every
profile that owns a Vitest attempt runs the helper-owned, watchdog-bounded pinned Vitest list mode
over its exact existing file set and stores the canonical `file + full test name` entry roster/digest
in immutable run state. A planned file not yet present contributes an explicit absent row; creating
it is allowed, silently removing an existing file/test is not. RED/GREEN results must retain every
entry identity plus the profile's registered U/S/N markers. This tranche declares no profile-owned
test rename/removal exceptions. A post-edit deleted unmarked old test, renamed parameterized case,
missing previously absent-now-required file, or entry-roster mutation is rejected; the exact
retained-old-tests-plus-new-markers neighbor passes.

`RUN_EVAL_CONTRACTS` is a fourth closed constant for all nine required evaluator attempts. The
reconciliation run hash-locks `cases.json` and `holdout.json` after the upstream merge, parses their
independent case-ID/expected-label oracle rosters, and stores their canonical digests in immutable
run state; later profiles inherit those exact digests rather than accepting a caller-selected
corpus. Each evaluator result path is predeclared, contains closed JSON, and must match engine,
corpus digest, every case ID exactly once, every expected/observed label, criticality, disposition,
false-block flag, missed-critical flag, and aggregate. The three baseline attempts require 13/40 on
`cases.json`; the three candidate attempts require 39/40, zero false blocks, zero missed critical,
and only the one cataloged warning-only similarity mismatch; the three holdout attempts require
18/18 with zero false blocks/missed critical. Totals cannot substitute for per-case rows. Snapshot
tests reject a wrong score, changed/missing/duplicate case ID, changed label, foreign corpus digest,
different mismatch, hidden false block, missed critical, malformed JSON, and exit-zero empty result;
the exact oracle neighbor passes.

The IDs without external Task argv are not left to implementer judgment; they are these exact
helper-owned contracts:

| Required ID set | Operation/check contract |
|---|---|
| `parser-scope`, `catalog-scope`, `contract-scope`, `feedback-scope`, `provider-scope`, `integration-scope`, `reproduction-scope-check` | `internal-check: worktree-scope` recomputes head/index/staged/unstaged/untracked/mode/submodule state and requires only the profile path set plus unchanged owner paths |
| `readiness-check` | `internal-check: readiness-contract` derives and atomically registers the closed `ReadinessRecord` from A-08–10 evidence, required predecessor attempts/children, lifecycle/oracle state, and the only allowed next action `BCF-01`; it accepts no caller readiness JSON |
| `review-schema-check` | `internal-check: review-contract` validates the closed report/review/finding schema, exact review head, dedupe key, report/meta/stderr hashes, and reproduction declarations |
| `review-scope-check` | `internal-check: read-only-scope` requires identical pre/post worktree/head and only helper-owned report artifacts |
| `reproduction-suite` | exact `integration-focused` seven-suite pinned Vitest argv from Task 7, at the frozen review head; finding-specific generic attempts are additionally required by each `record-review` row but cannot replace this suite |
| `feedback-budget` | `internal-check: output-budget-contract` consumes only the immutable `feedback-green` attempt's predeclared `FeedbackMeasurements` artifact and producer hash, validates its exact scenario order and independent human/JSON byte/count/digest relations against Task 5, and rejects missing/duplicate/foreign-producer records |
| `receipt-producer-scan` | `internal-check: producer-inventory-contract` reruns the closed A-01 `rg` query over source, tests, docs, and package metadata and derives/registers `ConsumerVersionDecision`; it rejects an omitted or unclassified match, unknown external consumer mislabeled absent, unsupported version claim, rollback-head drift, or any tracked-file mutation |
| `docs-authoring-scope` | `internal-check: docs-authoring-scope` requires the BCF-07 entry/terminal head to remain identical, no staged paths, and the exact Task 8 documentation allowlist as the only changed tracked paths; it also validates the four immutable review/reproduction child joins and rejects owner-path or helper-artifact leakage |
| `docs-lineage-scope` | `internal-check: docs-lineage-scope` derives every endpoint from verified completion/manifest state, recomputes all ten Step 5 Git operations, and registers `DocsLineageReport`; it enforces the three-file validator interval, pinned upstream second parent, classified upstream paths, exact Required File Interface authored paths, untouched/unstaged owner paths, and B-entry delta limited to handoff plus two generated indexes with A's public-surface/audit bytes unchanged |
| `docs-staged-scope` | `internal-check: staged-scope` recomputes the index and requires the exact BCF-08B documentation allowlist, with no omission, addition, mode surprise, submodule entry, or unrelated staged path |

`internal-check` emits its own bounded JSON artifact, direct internal status, snapshot, and verdict;
it cannot accept arbitrary argv or an output path. A closed check may use only the helper's
hash-locked Git/read executor and its mandatory process-group watchdog; executable, argv, deadline,
environment, and output predicates come from the check definition rather than the caller. Nearest-invalid tests change one scope path, readiness
field, review hash/head, or internal-check ID and require nonzero without a Pass artifact.

All remaining required IDs bind to the literal Task command/transition, not implementer-selected
aliases. This table is normative together with `RUN_ATTEMPT_CONTRACTS`:

| Required ID set | Exact binding |
|---|---|
| `validator-typecheck-postcommit`, `postmerge-validator-typecheck` | pinned `typecheck:scripts` at the committed helper head / reconciled head respectively |
| `merge-transition` | Task 0 helper-owned merge of the pinned observation OID with exact parent/preview set |
| `predecessor-typecheck-scripts`, `predecessor-typecheck-all` | pinned `typecheck:scripts` and `typecheck:all` in that order |
| `predecessor-baseline-eval`, `predecessor-candidate-eval`, `predecessor-holdout-eval` | closed evaluator engines/corpora/result predicates from `RUN_EVAL_CONTRACTS` |
| `predecessor-branch-gate` | Task 0 exact helper-watchdog/GNU-timeout/loadgate `verify:push:branch` argv |
| `parser-typecheck`, `catalog-typecheck`, `contract-typecheck`, `receipt-typecheck`, `feedback-typecheck`, `provider-typecheck` | each Task's pinned `typecheck:scripts` command at its GREEN snapshot |
| `parser-commit-transition`, `catalog-commit-transition`, `contract-commit-transition`, `receipt-commit-transition`, `feedback-commit-transition`, `provider-commit-transition`, `integration-commit-transition` | each Task's displayed literal subject and exact profile path/index/parent contract |
| `integration-typecheck-scripts` | Task 7 pinned `typecheck:scripts` after the seven-suite GREEN |
| `integration-baseline-eval`, `integration-candidate-eval`, `integration-holdout-eval` | Task 7 closed evaluator engines/corpora/result predicates |
| `docs-work-index-regen`, `docs-work-index-guard`, `docs-publication`, `docs-drift`, `docs-tally` | Task 8 Step 3's five displayed pinned commands in order, one process per ID; required once in A and replayed under the same closed IDs in B after the Step-4 notes update |
| `docs-typecheck-scripts`, `docs-typecheck-all` | Task 8 Step 4's pinned typechecks in order |
| `docs-test-integrity-preflight`, `docs-test-integrity-scan` | exact executable preflight and five-file scan; unavailable preflight is Inconclusive and cannot be replaced by the repository fallback |
| `docs-baseline-eval`, `docs-candidate-eval`, `docs-holdout-eval` | Task 8 replay of the closed evaluator engines/corpora/result predicates |
| `docs-commit-transition` | Task 8 literal docs subject and exact four-path BCF-08B index/parent contract |
| `watchdog-canary`, `watchdog-parent-dead`, `watchdog-child-dead`, `watchdog-group-dead` | Task 8 exact canary plus the three PID-derived `/bin/kill -0` liveness probes |
| `final-branch-gate` | Task 8 exact 1,800 s inner GNU-timeout/loadgate branch gate under the 1,860 s helper watchdog |

Snapshot equality tests assert every required ID appears in exactly one operation/check/transition
binding even when one reusable contract ID occurs in multiple profiles.

Required child identities are also profile-owned:

| Parent profile / alias | Required child kind | Required task/profile | Required head relation |
|---|---|---|---|
| `bcf00-reconciliation` / `upstream-observation` | `observation` | `BCF-00` / `bcf00-observation` | child entry/terminal head equals parent entry head; child run/manifest/completion-receipt/empty-ledger pins equal the separately required predecessor pins byte-for-byte |
| `bcf08a-docs` / `review-contract` | `review` | `BCF-REVIEW` / `bcf-review-contract`; dedupe `contract-cli-review` | child entry/terminal head equals parent entry head |
| `bcf08a-docs` / `review-redaction` | `review` | `BCF-REVIEW` / `bcf-review-redaction`; dedupe `redaction-async-review` | child entry/terminal head equals parent entry head |
| `bcf08a-docs` / `review-integration` | `review` | `BCF-REVIEW` / `bcf-review-integration`; dedupe `integration-blast-review` | child entry/terminal head equals parent entry head |
| `bcf08a-docs` / `lead-reproduction` | `reproduction` | `BCF-REPRODUCTION` / `bcf-reproduction`; dedupe `lead-reproduction` | child entry/terminal head equals parent entry head |
| `bcf08b-docs` / `docs-precommit` | `docs` | `BCF-08A` / `bcf08a-docs`; dedupe `docs-precommit` | child entry/terminal head equals parent entry head; child terminal worktree snapshot/diff digest and exact allowed-path hashes equal parent entry snapshot before any B attempt |
| `bcf08-final` / `docs` | `docs` | `BCF-08B` / `bcf08b-docs`; dedupe `docs` | child terminal head equals parent entry head |
| `bcf08-final` / `review-contract` | `review` | `BCF-REVIEW` / `bcf-review-contract`; dedupe `contract-cli-review` | child head equals docs child's entry head |
| `bcf08-final` / `review-redaction` | `review` | `BCF-REVIEW` / `bcf-review-redaction`; dedupe `redaction-async-review` | child head equals docs child's entry head |
| `bcf08-final` / `review-integration` | `review` | `BCF-REVIEW` / `bcf-review-integration`; dedupe `integration-blast-review` | child head equals docs child's entry head |
| `bcf08-final` / `lead-reproduction` | `reproduction` | `BCF-REPRODUCTION` / `bcf-reproduction`; dedupe `lead-reproduction` | child head equals docs child's entry head |

At parent init, each required alias must have one immutable dynamic pin containing the expected child
head/run ID/manifest SHA-256 and profile-owned dedupe key. Each review profile owns exactly its named
dedupe key; `record-review` enforces that identity, and one child run ID or manifest digest cannot be
registered under multiple direct aliases or roles in the same parent. The BCF-08C direct-versus-
recursive equality check below is the sole required recurrence and is not a second direct alias.
`record-child-run` later requires the source to match
the exact manifest-bound `run.requiredChildPins` row and the fixed table row. Init rejects a
missing, extra, duplicate, malformed, or relation-inconsistent pin before creating the run; import
rejects any invocation whose expected head/run/digest differs from the frozen row. Finalization and
read-only verification require every frozen pin to have exactly one matching imported child and
reject a pin-array mutation even if the imported child remains otherwise valid. The only permitted depth-three closure is the exact
`bcf08-final/docs` → `bcf08b-docs/docs-precommit` → `bcf08a-docs/{review-contract,
review-redaction,review-integration,lead-reproduction}` chain; every other closure above depth two
and every closure above depth three is rejected. BCF-08B finalization recursively verifies BCF-08A's
exact review/reproduction closure. BCF-08C finalization cross-checks its direct review/reproduction
manifest digests against the same manifests recursively imported through `docs` →
`docs-precommit`; a freshly substituted but otherwise valid review cannot satisfy the join.
Missing, duplicate, self-selected-at-import, cross-profile, or relation-inconsistent pins exit
nonzero. `bcf08b-docs` initialization and every later attempt recompute the A terminal
`BoundaryWorktreeSnapshot`, canonical diff digest, and each of the four allowed-path hashes; a
one-byte edit, mode change, staged-state change, or untracked-path difference between A finalization
and B entry is rejected before child execution. A new child run requires a new parent run; pins are
never edited.

Profile tests assert exact table equality, reject every wrong task/profile pair and omitted/extra
completion ID, prove observation `closed` can Pass without completing BCF-00, reject `completed` for
that profile, and show that a non-pass or substituted required child deterministically prevents
parent Pass. The BCF-08 relation fixtures additionally reject the exact one-byte-between-A-and-B
TOCTOU mutation, same review under two roles, a wrong dedupe key, a substituted direct final review,
the permitted exact depth-three chain with one wrong edge, and every depth-four chain; the unchanged
neighboring closure passes.

For each BCF-01–07 code task and BCF-08B, the commit transition is the final required
mutation: afterward set lifecycle `completed`/final gate `pass`, finalize, and verify at the advanced
anchor before initializing the successor. A failed transition preserves its run as non-pass and
cannot be retried under the same run ID.

`verify --expect-staged-allowlist` additionally requires every staged path to be one of the run's
declared task paths and every task path expected for that atomic commit to be staged; it prints the
sorted exact difference and exits nonzero on either omission or addition.

`closeout --run-dir <final-run> --attempt-id <closeout-attempt>` is the only authoritative final
writer; it accepts only task/profile `BCF-08C`/`bcf08-final`, and callers do not choose receipt
paths. For a run at `<evidence-root>/final/<run-id>`, a passing
closeout exclusively creates `<evidence-root>/closeout/<run-id>`. Any rejection exclusively creates
`<evidence-root>/closeout-failures/<run-id>/<closeout-attempt>`; attempt reuse exits 2 and a retry
uses the next canonical attempt ID without overwriting history. The command performs finalization
and immediate post-finalization verification in one process, but holds the BCF-08C completion bundle
as a candidate. It first writes immutable `closeout_core.json`, containing every accepted semantic
field except negative-control results and the final receipt/report digests. Before the completion
bundle or final receipt can be published, it creates helper-owned sibling copies under the derived
failure-control root and runs the closed negative matrix against the manifest/artifact closure,
`closeout_core.json`, and candidate completion bundle: foreign artifact, one-byte artifact mutation,
head mismatch, diff mismatch, missing child receipt, changed manifest, changed/substituted core,
missing/changed/substituted candidate completion receipt or chain ledger, and forged successful
internal status. Every mutation must be rejected with its exact reason and the unchanged copy must
verify. The matrix paths, mutation IDs, direct internal statuses, and tree digests are written once
to immutable `negative_control_report.json`, which binds the exact core SHA-256. The final accepted
receipt is then derived from and binds both `closeoutCoreSha256` and
`negativeControlReportSha256`; neither input contains the final receipt digest or the other's future
digest. Matrix results are not inlined into the core, and the final receipt is not an input to its
own matrix, eliminating a self-hash cycle. Task 0 verifier fixtures separately mutate/substitute the
final receipt and lock. Missing/misclassified/pass-on-mutation evidence makes closeout Inconclusive
and writes only a rejected receipt. After that authoritative matrix passes, closeout fsyncs a
prepared directory containing `completion/` with the BCF-08C ledger/receipt/locks,
`closeout_core.json`, `negative_control_report.json`, and closed-schema
`closeout_receipt.json`/`closeout_receipt.sha256`, then atomically renames that one directory to the
derived accepted closeout path. No partial accepted completion/closeout state is observable.

The receipt is the fixed-key discriminated union in `RUN_WIRE_SCHEMAS`; accepted and rejected use
the same keys with its exact nullability rules. `kind: accepted` requires every declared
run/task/profile/head/snapshot/helper/manifest/status/completion/ledger/time/lifecycle/required-set/
core/report identity and computed verdict `Pass`. `kind: rejected` requires the declared
`failedStage`, non-pass closeout verdict, distinct `runVerdict`, direct raw status/signal, bounded
closed reason code, and explicit manifest state; manifest/lock hashes are present for every produced
state and not-yet-reached fields are exactly null. `failedStage: negative-control|completion`
after a verified Pass manifest requires `runVerdict: Pass`, `manifestState:
verified-pass-closeout-rejected`, no published BCF-08C completion bundle, and closeout verdict
`Fail` for a deterministic mutation-acceptance defect or `Inconclusive` for unavailable/failed
publication evidence. Structural finalize/verify success cannot promote the closeout verdict. Closeout returns
zero and writes the accepted path only when lifecycle is `completed`, final gate is `pass`, every
profile-required attempt and child is Pass, and all required artifacts/children are verified.
Every other outcome writes the derived rejected receipt when the helper remains able to do so and
exits nonzero; a crash with no valid rejection receipt is Inconclusive.

`verify-closeout --run-dir <final-run>` is read-only and derives the accepted receipt path; the
separate `verify-closeout --failure-receipt-dir <canonical-failure-dir>` mode validates a preserved
rejection. Both check the receipt lock/schema/path identity, exact head/diff, helper identity,
manifest state, and every recursively imported artifact applicable to the discriminator. Accepted
verification checks all four manifest/closeout/completion-receipt/chain-ledger locks, their
cross-recorded digests, the exact bound closeout-core and negative-control-report bytes/digests, the
report-to-core identity, the exact final ledger roster/order, and every imported predecessor/child
hash. A missing, substituted, or mutated core, report, or terminal completion bundle is non-pass
even when the manifest and closeout receipt alone are unchanged.
Receipt-directory reuse, manual construction, manifest substitution, accepted/non-pass mismatch,
or an accepted receipt with a nonzero internal status exits nonzero.

## Tooling and Delegation

- **Required local tools:** Git/SSH, `rg`, pinned Node/npm wrappers, TypeScript, Vitest, the existing
  repository guards, test-integrity executable, `loadgate` for admission, and GNU timeout for final
  process-group ownership. Preflight each tool; record requested and observed versions separately.
- **Required skills:** use test-driven-development per BCF-01–07, systematic-debugging for any
  unexpected failure, writing-fail-closed-gates for process/deadline or shell status changes,
  hypothesis-driven for competing root causes, subagent-driven-development for sequential task
  ownership, requesting-code-review after BCF-07, and verification-before-completion for BCF-08B/C.
  Skill guidance does not expand mutation authority.
- **Lead-runtime realm:** the lead owns decomposition, permissions, shared-file integration,
  commits, verification, and final claims. Native read-only workers are advisory and bounded; no
  worker delegates further. A separate process lane is unnecessary unless a mechanically distinct
  permission/runtime boundary is later proven and its catalog/watchdog are attested.
- **Cross-runtime realm:** no cross-runtime plugin or coordinator is required for this local
  tranche. Any later process lane requires an explicitly approved bounded packet under workspace
  doctrine; it does not replace this plan's evidence or authority. Static role names are not
  capability evidence.
- **MCPs/plugins:** GitHub reads were already mined into the approved specification and are not
  needed to implement this contract tranche. GitHub writes, Playwright, Sentry, Render, Pinecone,
  Google/Microsoft surfaces, and live WhatsApp/fleet tools are `Not applicable`; using them would add
  external state or an unrelated validation method and requires a scope/authority review.

Implementation write ownership is sequential: one BCF task owner writes only its named files and
artifact directory. Effective parallelism is limited to read-only post-BCF-07 probes with unique
dedupe keys:

1. `contract-cli-review`: parser/runtime/schema/exit/consumer audit;
2. `redaction-async-review`: sensitive-data, output-budget, timer/listener/late-work audit;
3. `integration-blast-review`: evaluator SSOT, docs, rollback, and excluded-surface audit.

Each reviewer records status, exact head/diff, files inspected, findings with severity, decisive
source/test evidence, validation performed, confidence, risks, and claims needing lead reproduction
under its unique `validation_layer3/review-*` path. Reviewers are read-only and cannot commit, push,
post, merge, rerun, change rulesets, or edit shared artifacts. Silence, progress-only output,
malformed results, stale heads, or duplicate dedupe keys are inconclusive and do not trigger a
replacement until a terminal failure or expired bounded lease.

The lead accepts no worker claim until inspecting the cited diff/test/log and rerunning decisive
controls. Parallel test processes are not used for these shared timer/process suites;
`--fileParallelism=false`, fixed fixtures, unique temp/artifact roots, direct statuses, and load
admission preserve deterministic validation.

## Contradiction and Integration Check

The whole-plan review must be repeated after any scope, interface, readiness, or evidence change and
again immediately before final synthesis. It compares the specification, assumptions, readiness,
atomic tasks, interface signatures, error model, observability, test provenance, reuse decisions,
tool ownership, and handoff claims. The durable result is the review-run artifact referenced by
`$PLAN_REVIEW_ARTIFACTS/contradiction_check.md`; a repository-generic or narrative-only assertion is
inconclusive.

The current cross-pass integration resolves these apparent conflicts:

- The provider's five-second race owns settlement of the local call, but does not claim that ignored
  asynchronous work was canceled. The final GNU-timeout lane separately owns and reaps the complete
  verification process group. A-04 and A-06 therefore govern different boundaries.
- Schema-1 compatibility means read/render support for existing data, not continued schema-1
  production. BCF-04 emits schema 2 only after every local consumer is inventoried.
- `block` retains decision precedence, yet limitations are always visible. A limitation raises
  `pass` or `warn` to `inconclusive`; it does not erase a valid block or its evidence.
- Feedback completeness is corrective quality, not structural non-emptiness. Expected state, impact,
  safe control, correction, verification, rerun, sources, and visible limitations are mandatory.
- Reviewer-mined runtime contract failures—invalid enums, blank nested evidence, duplicate finding
  identity, redaction gaps, output cardinality, and timeout/limitation composition—belong to
  BCF-01/03/05/06. New detection policy—freshness budgets, target binding, snapshot coherence,
  rename/tree-mode/stable-patch variants, emitted import edges, and base/head reachability—remains in
  Deferred Follow-On Plans and cannot silently enter this tranche.
- `Not Ready` authorizes only BCF-00 reconciliation while A-08–10 are unresolved. After they pass,
  `Ready with Constraints` may authorize BCF-01; A-02 gates BCF-02, A-03 gates BCF-05, and A-06
  gates BCF-08C. A later checklist cannot override those checkpoints.
- Existing helpers are extended in place. The rule catalog and canonical contract are the only new
  owners; no parallel evaluator, renderer, history collector, or enforcement workflow is proposed.
- Synthetic and production-derived probes establish behavior, not promotion efficacy. Enforcement,
  hooks, external providers, and an agent-correction trial remain explicitly excluded.

Current contradiction verdict: **Inconclusive pending fresh exact-byte closeout; Not Ready for
implementation**. The amended contracts are intended to resolve the prior review findings, but no
Pass is claimed until the 27-pass lane re-runs against the final spec/plan/notes hashes and its
mechanical hash checks and unfiltered checker both pass. Named execution-readiness blockers remain
separate checkpoints after plan review closes.

## Linting, Formatting, and Static Gates

Run these fast gates after each BCF code task that changes their inputs and again at BCF-08B. Save
direct stdout/stderr and status under the listed artifact path; a terminal summary without raw output
is insufficient. The repository has no root formatter command, so changed TypeScript/Markdown must
match adjacent style and `git diff --check` is the mechanical whitespace gate. Do not install or
silently substitute a formatter during this tranche.

| Tool | Exact command | Expected output | Blocking threshold | Artifact | Owner |
|---|---|---|---|---|---|
| Git whitespace check | `git diff --check` | No output; exit 0 | Any diagnostic or nonzero status blocks the task | `artifacts/verification/boundary-contract-feedback/static/diff-check.log` | Current BCF writer |
| Source ESLint fitness | `bash scripts/run-with-pinned-npm.sh run guard:lint:src` | Existing budget and changed-source rules pass; exit 0 | Nonzero, new warning, or unexplained baseline drift is Fail | `artifacts/verification/boundary-contract-feedback/static/lint-src.log` | BCF-03/04/05/06/07 writer |
| Scripts typecheck | `bash scripts/run-with-pinned-npm.sh run typecheck:scripts` | TypeScript reports no errors; exit 0 | Any diagnostic or nonzero status is Fail | `artifacts/verification/boundary-contract-feedback/static/typecheck-scripts.log` | Current code-task writer |
| Full test typecheck | `bash scripts/run-with-pinned-npm.sh run typecheck:all` | TypeScript reports no errors; exit 0 | Any diagnostic or nonzero status is Fail | `artifacts/verification/boundary-contract-feedback/static/typecheck-all.log` | BCF-07 and BCF-08B owner |
| Test-integrity primary | `"$TEST_INTEGRITY_BIN" scan tests/scripts/semantic-boundary-contract.test.ts tests/scripts/semantic-rule-guidance.test.ts tests/scripts/semantic-quality-check.test.ts tests/scripts/semantic-history-provider.test.ts tests/scripts/semantic-boundary-eval.test.ts` after an executable-path preflight | No integrity finding; direct exit 0 | Finding/nonzero is Fail; unavailable tool is Inconclusive and triggers only the named fallback | `artifacts/verification/boundary-contract-feedback/static/test-integrity-primary.log` | BCF-08B owner |
| Test-integrity fallback | `bash scripts/run-with-pinned-npm.sh run guard:test-integrity` | Repository acceptance lane exits 0 | Nonzero is Fail; fallback Pass does not convert the unavailable primary to a clean primary result | `artifacts/verification/boundary-contract-feedback/static/test-integrity-fallback.log` | BCF-08B owner |
| Documentation/static indexes | Five separate processes in order: `bash scripts/run-with-pinned-npm.sh run work-index:regen`; `bash scripts/run-with-pinned-npm.sh run guard:work-index`; `bash scripts/run-with-pinned-npm.sh run guard:publication:all`; `bash scripts/run-with-pinned-npm.sh run guard:doc-drift`; `bash scripts/run-with-pinned-npm.sh run guard:doc-tally`. IDs are respectively `docs-work-index-regen`, `docs-work-index-guard`, `docs-publication`, `docs-drift`, `docs-tally` | Each direct process exits 0 with its own raw output/status | Any omitted/collapsed/masked process, missing child status, warning promoted by a guard, or nonzero is Fail | The five attempt-owned stdout/stderr files and manifest records; no combined shell log | BCF-08A once, then BCF-08B replay after the handoff update |

Warnings are never reclassified in prose. A command-owned warning is accepted only when the command
exits zero and its named budget/baseline remains unchanged; any new warning or baseline movement is
Fail until explained and approved. Missing tools, truncated logs, masked pipeline statuses, or an
unknown formatter/linter substitution are Inconclusive. Static gates complement, rather than
replace, behavioral red/green tests and the final process-owned branch gate.

## Regression Protection and Change Safety

Capture the pre-implementation head, dirty-state paths, focused suite results, schema-1 fixture,
corpus/holdout per-case results, exact output sizes, and rule inventory before BCF-01. Each BCF task
then compares its direct evidence against that immutable baseline and the previous accepted task
commit. Never refresh a baseline merely because the implementation differs.

| Protected behavior | Protection mechanism | Regression signal | Evidence source | Rollback or mitigation trigger |
|---|---|---|---|---|
| Valid CLI invocations and exit semantics | Existing CLI tests plus invalid/valid one-field neighbors | A formerly valid argv changes target/mode/output or exit | `task01/semantic-quality-check.log` | Revert BCF-01 parser slice if strict parsing alters valid grammar |
| Existing rule IDs and single policy owner | Generated inventory compared with every producer/test | Missing current ID, unexplained new ID, duplicate ID, or evaluator-local policy | `task02/rule-inventory.diff` | Stop BCF-02; reconcile inventory without expanding policy |
| Schema-1 stored receipt readability | Frozen literal read/render fixture | Existing schema-1 data fails or is silently treated as schema 2 | `task04/schema1-compatibility.log` | Revert producer integration; retain v1 reader before continuing |
| Deterministic schema-2 identity | Reversed-order, exact-duplicate, one-field digest controls | Byte/digest drift for equivalent input or collision for changed evidence | `task04/receipt-contract-tests.log` | Revert BCF-04; isolate canonicalization or tie-break defect |
| Decision precedence and evidence honesty | `block > inconclusive > warn > pass` matrix including limitations | Warn/pass with a limitation exits cleanly, block disappears, or limitation is hidden | `task04/receipt-contract-tests.log` and `task05/renderer-tests.log` | Revert BCF-07 integration, then repair aggregation/rendering owner |
| Redaction and bounded agent context | Punctuation/quote/equals/`file:` controls plus at-limit/one-over-limit budgets | Sensitive path/URL survives, complete evidence truncates silently, or output exceeds budget | `task05/output-budget.json` | Disable v2 integration; retain failing fixture and overflow receipt |
| Provider behavior and finite settlement | Resolve/reject/timeout/ignore-abort controls run twice with fake timers restored | Hang, unhandled rejection, leaked listener/timer, missing late-work limitation | `task06/provider-deadline-tests.log` | Revert BCF-06 independently; preserve unsafe fixture |
| Semantic evaluator accuracy | Frozen per-case corpus and holdout labels/scores | Baseline not 13/40, candidate not 39/40, holdout not 18/18, any false block/missed critical | `task07/evaluator-results.json` | Revert BCF-07; investigate without relabeling oracle data |
| Existing hooks/workflows/enforcement posture | Scope diff and complete branch gate | Hook/action/ruleset change, shadow→enforce promotion, or unexpected workflow diff | `final/<run-id>/scope-audit.txt` and `final/<run-id>/run_manifest.json` | Remove out-of-scope change; require a separate approved promotion plan |
| Documentation/publication classification | Work index and publication/drift/tally guards | Unregistered private plan, stale index, unsupported public claim | `static/docs-guards.log` | Correct through new BCF-08A/B runs; revert only the BCF-08B docs commit for a proven tracked defect |

Every regression test has an unsafe input and a nearest valid control. Unexpected red is Fail when
the changed behavior is reproduced, Inconclusive when the environment/tool/evidence is missing, and
never converted to Pass by a later broad suite. Before each commit, inspect the scoped diff and task
artifacts; after local integration, BCF-08B replays focused, frozen evaluator, static, integrity, and
whole-branch gates at one exact head under the external watchdog.

There is no hosted rollout or enforcement promotion in this tranche. Post-rollout detection is
therefore **Not applicable**. A future hook/CI/provider promotion must reuse these baselines, add
shadow telemetry and a measured agent-correction trial, define rollback thresholds, and obtain
separate authority before any external mutation.

## Hooks, Automation, and Workflow Enforcement

The observed repository hook path is `.husky`. This tranche changes no hook, GitHub
workflow, required check, or ruleset. It changes the semantic CLI/library beneath existing local and
CI shadow invocations, then proves the complete existing branch gate still passes. The scope audit
must report any `.husky/**`, `.github/workflows/**`, `scripts/pre-push-guard.ts`, or enforcement-mode
diff as Fail.

| Hook or automation | Trigger point | Command or policy | Blocking behavior | Override behavior | Evidence artifact |
|---|---|---|---|---|---|
| BCF task gate | Before each local task commit | Task-specific red/green test, relevant static gates, `git diff --check`, scoped diff review | Any reproduced regression/nonzero blocks that task | No environment bypass; missing tool/evidence is Inconclusive | Named `taskNN/*` logs and commit receipt |
| Existing `commit-msg` | Local commit message | `npm run guard:repo:commit-msg -- "$1"` | Existing nonzero rejects the commit | No new override; any `--no-verify` use must be recorded and cannot satisfy BCF-08C | Git hook stderr plus commit attempt record |
| Existing `pre-commit` | Local commit | Repository staged/publication/design/node/config guards; architectural drift warnings remain governed by existing pre-push enforcement | Existing blockers reject commit; existing warn-only checks do not become stronger here | No new skip variable; bypassed hook means local evidence is Inconclusive until direct commands pass | BCF commit log plus direct static artifacts |
| Existing `pre-push` | Local branch/release push | `scripts/pre-push-guard.ts` selects `verify:push:branch` or `verify:release`; delete-only remains its existing explicit skip | Nonzero blocks push | This plan does not authorize or normalize `--no-verify`; direct BCF-08C branch-gate evidence is still required | `final/<run-id>/run_manifest.json` and pre-push output if a later push is authorized |
| Existing GitHub quality shadow | PR/push workflow on Node 24 | `npm run guard:semantic-quality -- --mode shadow --base "$base" --receipt "$SEMANTIC_RECEIPT"` | Workflow command must exit zero; semantic findings remain shadow per current policy | No workflow/env override added; missing/malformed receipt fails the step | GitHub job receipt/summary only if a later authorized push runs it |
| Existing complete branch gate | BCF-08C before completion | `verify:push:branch` with skip variables unset under loadgate plus process-group timeout | Any direct nonzero/signal/timeout blocks completion | No retry until named root cause; no masked pipeline; timeout is Inconclusive | `final/<run-id>/stdout.log`, `final/<run-id>/stderr.log`, `final/<run-id>/run_manifest.json` |

Hook output is advisory evidence until the lead checks its direct status and exact head. Local hook
success cannot substitute for the task tests; CI success cannot substitute for local deterministic
falsifiers. A bypass or override never creates Pass: record actor/authority, exact command, reason,
head, skipped checks, and compensating direct run, or classify the affected boundary Inconclusive.

Promotion to pre-commit/pre-push blocking or a required hosted check is a deferred follow-on. It
requires the stable schema-2 contract, false-positive/critical-miss thresholds, observed correction
rate and context-byte measurements, shadow duration/sample size, owner-approved exception syntax,
rollback criteria, and explicit GitHub mutation authority. Until then, preserve current shadow
behavior and emit richer diagnostics without changing enforcement.

## Rules, Policies, and Guardrails

The following rules are normative for this tranche. The implementation may make them more explicit,
but may not weaken or silently reinterpret them.

| Rule or policy | Source or rationale | Enforcement point | Blocking condition | Exception path | Evidence location |
|---|---|---|---|---|---|
| Runtime input is untrusted | TypeScript types do not protect JSON/provider/argv values | BCF-01/03 canonical parser and contract tests | Unknown enum, invalid identity, blank nested field, duplicate singleton/finding can reach pass/shadow | None; correct input and rerun | Task 1/3 logs |
| One owner per semantic decision | Avoid evaluator/renderer policy drift | Rule catalog plus existing evaluator delegation | Duplicate rule ID, unexplained inventory delta, or second aggregator/policy map | Amend approved spec/plan before code | `task02/rule-inventory.diff`, scope audit |
| Canonical output is deterministic and bounded | Receipts steer agents and enter logs | BCF-04/05 digest/order/budget tests | Input-order drift, collision, leak, silent truncation, or limit overrun | Owner-approved budget change through A-03 and plan update | Task 4/5 artifacts |
| Incomplete evidence cannot prove clean | Missing history/provider data invalidates absence claims | Aggregation, renderer, provider settlement | Limitation preserves pass/warn, is hidden, or timeout hangs | None; repair evidence source and rerun | Task 4/5/6 logs |
| Blocker/warning taxonomy is stable | Prevent severity laundering | Runtime schema, catalog, receipt precedence | Unknown decision/action, downgraded block, or new severity without catalog/version | Separate approved policy expansion | Task 2/3/4 artifacts |
| Redact secrets and machine-local context | Public logs/agent context must be safe | Canonical sanitizer and publication guards | Credential/query/local path/file URL survives or redaction changes semantic identity silently | None for secret/local path; sanitized source reference only | Task 3/5 logs |
| Tests precede implementation | Direct falsifiers anchor intent | Every BCF code task | Missing/wrong red, missing safe neighbor, masked status, or relabeled corpus | None; capture valid red first | Task manifest and raw test logs |
| One sequential writer; reviewers read-only | Shared worktree and timer fixtures need deterministic ownership | Task dispatch/integration | Overlapping writes, stale reviewer head, malformed or unverified worker claim | Replan ownership; never accept duplicate quiet work | Worker result and lead reproduction |
| Exact-head evidence only | Prevent stale-green reuse | Every artifact and final manifest | Artifact head/diff differs from reviewed implementation | Rerun at current head; do not copy prior verdict | Event log and final manifest |
| Preserve repository and owner boundaries | User work and external state are not disposable | Git status/staging/scope audit | Touch a pre-existing unrelated untracked path, use destructive Git, use an HTTPS LucasQuiles remote, or perform an unauthorized GitHub write/push | New explicit owner authority for the exact external mutation; no destructive exception | Preflight/scope audit/remote receipt |
| Public commit hygiene | Global repo policy | Commit-msg/repo/publication guards | Attribution trailer, model/internal name, prohibited email, unregistered private doc | Correct metadata/content and rerun | Commit guard and publication artifacts |

Decision disposition is exact: `block` means a proven unsafe action and exits 1 in enforce mode;
`inconclusive` means required evidence/tool/authority is absent, invalid, stale, timed out, or
contradictory and exits 2 in enforce mode; `warn` is a proven non-blocking concern with corrective
feedback; `pass` requires complete evidence and no findings. A warning may not hide a limitation,
and a missing check is never a warning or pass.

Existing semantic exceptions remain where their current policy owner stores them and must include
valid owner, reason, and expiry evidence. This tranche adds no environment bypass or anonymous
allowlist. Any new exception requires an approved specification/plan change, catalog/version update,
unsafe and safe tests, named owner/reason/expiry, exact affected scope, and durable artifact. On a
violation, preserve the raw receipt, classify Fail/Inconclusive/Blocked, stop the dependent task,
correct or explicitly rescope it, and replay every affected downstream gate.

## Documentation and DevOps Readiness

BCF-08A is an implementation deliverable, not optional cleanup. It updates `docs/public-surface.md`
with schema-2 target/evidence identity, decision and exit semantics, bounded human/JSON sections,
provider limitations, receipt-write behavior, and schema-1 read compatibility. It completes the
implementation notes with observed commands/statuses/measurements/limits, verifies the private plan
and notes rows already committed to `docs/publication-audit.md` without re-adding them, regenerates
both work indexes, and runs all four named documentation guards.

BCF-08A publishes the versioning decision made before Task 4 production changes. The repository currently reports package
version `0.1.0`, has no first-party changelog/changeset or product-version tag, and emits receipt
schema 1. `docs/public-surface.md` must add a dated contract-evolution record for schema 1 → 2 with
the rule-catalog digest, validation head, compatibility boundary, and rollback. Keeping package
`0.1.0` is allowed only if the inventory proves the producer is beta, shadow-only/pre-1.0, and no
named external consumer exists. For this decision, an active `beta` public-surface row and the
first-party quality workflow are named local consumers, not a stable external compatibility
commitment; they require atomic schema-1 compatibility tests and a dated public-surface evolution
record. A `stable` row, named out-of-repository consumer, or published compatibility commitment is a
supported public producer and requires a separate approved version/release-note change before
schema-2 integration. Silence is not a compatibility decision.

The operator path is reproduction-ready when it names:

- pinned-tool preflight, exact worktree/branch/SSH remote, clean-scope rules, and artifact root;
- valid and invalid CLI examples for pass/warn/block/inconclusive, direct exit meanings, schema-2
  receipt location, and what to do with a limitation or overflow receipt;
- the five-second provider-call settlement semantics without claiming cancellation of ignored work;
- the complete BCF-01 through BCF-08C replay order, task entry/exit rules, raw artifact locations,
  rollback order, and the current external-action stop;
- every unavailable, skipped, deferred, or external surface as `Inconclusive` or `Not applicable`,
  never as implicitly covered.

Operational surface review is explicit:

| Surface | Tranche impact | Required proof | Failure disposition |
|---|---|---|---|
| Existing GitHub quality shadow | Schema-2 retains `decision` and `findings` consumed by the summary step; workflow stays unchanged | Local CLI JSON fixture and scope audit; hosted run only after an authorized push | Consumer mismatch is Fail; no hosted run is claimed |
| Existing local pre-push branch gate | Underlying semantic shadow receives richer bounded output; hook/script stays unchanged | Process-owned `verify:push:branch` at exact head | Nonzero/signal/timeout is Fail/Inconclusive per manifest |
| Config/environment/secrets | No new variable, credential, config file, database, queue, or migration | Exact scoped diff and secret/local-path redaction probes | Any such change is out-of-scope Fail |
| Deployment/release/runtime service | No deploy, restart, image, release, migration, or live provider call | Absence from diff/artifacts plus authorization stop | Any mutation is Blocked without new authority |
| Dashboards/alerts/on-call | No new hosted enforcement or service SLO; receipt/event artifacts are local | `Not applicable` recorded in notes; future promotion plan required | Do not invent dashboard/alert validation |
| Stored/external receipt consumers | Local readers inventoried; external consumers remain unknown | Schema-1 fixture, local consumer scan, documented rollback | Unknown external compatibility remains a named limitation; named break is Fail |

Open operational risks are controlled rather than hidden: external schema-1 consumers are unknown;
provider work that ignores abort may continue after local settlement; output budgets need A-03
approval; final process ownership needs A-06. These are already bound to Task 4, 5, 6, and 8B
checkpoints. They do not authorize deployment or enforcement promotion.

Current documentation/DevOps plan review is **Inconclusive pending fresh exact-byte closeout**, and
overall execution is `Not Ready` until A-08–10 resolve. No deploy/runbook, dashboard, alert, environment, or migration
deliverable is missing because those surfaces are not changed. Implementation completion still
requires the version decision and observed BCF-08A/B artifacts; until then the implementation notes
remain Inconclusive and make no operational-success claim.

## Capability and Historical-Context Inventory

Use only capabilities named here and record their observed version/availability before relying on
them. Hidden tool calls, role-name capability assumptions, vague future MCP use, unbounded workers,
overlapping parallel writes, or nondeterministic output presented as proof are prohibited.

| Capability class | Available and relevant | Intended use | Evidence output | Ownership/write scope |
|---|---|---|---|---|
| Local runtime/tools | Git 2.50.1, pinned Node 24.15.0/npm 11.12.1, `rg` 15.1.0, TypeScript/Vitest, GNU timeout 9.10, `loadgate`, installed test-integrity | Source/history inspection, TDD, static checks, bounded final verification | Plan-review `capability_versions.txt`; implementation preflight/task/final logs | Lead invokes; task writer changes only named files; timeout owns final process group |
| Repository scripts | Pinned wrappers, semantic evaluator, work-index/publication/doc/static guards, `verify:push:branch` | Reuse existing owners and complete branch gate | Named task/static/final artifacts | No script duplication; changes limited to files in Required File Interfaces |
| Skills | brainstorming/spec already completed; writing and deterministic plan review for this packet; TDD, systematic debugging, fail-closed-gate writing, hypothesis-driven, bounded worker development, code review, verification-before-completion for execution | Govern red-first work, debugging, deterministic gate design, bounded review, and final claims | Plan-review run; task hypotheses/tests/review/verification artifacts | Guidance never expands mutation authority; lead verifies decisive output |
| Native subagents | Three planning reviewers already returned bounded read-only advisory findings; three post-BCF-07 implementation review lanes are defined | Mine missed signatures and independently review CLI/contract, redaction/async, and integration blast radius | Reviewer packet with exact head/files/evidence plus lead reproduction | Read-only, unique dedupe key, no delegation, no commits/external actions |
| Plugins | The deterministic review bundle is active for plan review; installed test-integrity is a verification tool. Cross-runtime orchestration is not required | Deterministic 27-pass plan closeout and behavioral test-quality scan | This plan-review artifact root and final integrity log | Lead-controlled; plugin result advisory until checked; no plugin writes to repo beyond approved plan artifacts |
| MCPs/connectors | GitHub read evidence was mined into the approved spec; GitHub write, Pinecone, browser/Playwright, Render/Sentry, Google/Microsoft, and WhatsApp/fleet surfaces are unnecessary | No in-tranche call. Re-open only for a named evidence gap that local source/git/spec cannot answer | If later approved: exact query/target/result/citation/limitations artifact | Reads stay bounded; every external mutation requires current explicit owner authority |
| Browser/runtime/DevOps | Local subprocesses and Git are sufficient; no browser, container, deploy, service restart, or hosted runner is required | Local CLI/E2E and process-owned branch verification only | Direct subprocess status/signal/stdout/stderr and scope audit | No deployment or hosted-state mutation |

Subagent-driven development is used only where decomposition is safe. BCF writers remain sequential;
effective parallelism begins after BCF-07 and is limited to the three independent read-only lanes.
Each packet has one owner, dedupe key, allowed paths, timeout, stop conditions, result contract, and
unique evidence root. Test-driven development governs every implementation-facing behavior. Every
meaningful correctness claim requires deterministic fixed inputs/clocks, unsafe and safe neighbors,
direct exit/status evidence, exact head/diff, and lead reproduction; worker consensus or wall-clock
sleep is not proof.

Historical context is retrieved in this order:

1. Read the approved specification, this plan, implementation notes, run-scoped plan-review
   manifest/snapshots, prior evaluator artifacts, and the three advisory reviewer packets. Reject
   the generic mixed artifact root and the superseded 40/40 oracle. Reviewer findings were captured
   at `83a55b131b2fa51f9d3c6c8f3f2494140ae4fd03` and must be source/test-reproduced by the lead before
   they support an implementation claim.
2. Run exact local Git inspection as needed: `git log --oneline --decorate --all -- <path>`,
   `git show --stat --oneline <sha>`, `git show --raw <sha> -- <path>`, `git blame -L <start>,<end>
   <sha> -- <path>`, and `git diff <base>...HEAD -- <path>`. Record command, SHA/range, output, and
   inference. Before any future branch deletion claimed as superseded, also run `git range-diff` and
   `git cherry -v`; no branch deletion exists in this plan.
3. Use current PR/issue/comment evidence only through bounded read access when the approved local
   packet lacks decisive provenance. Record repository, query, pagination/completeness, observed
   timestamp, item URLs/identities, and limitations. Do not post, edit, merge, rerun, or change rules.
4. Pinecone retrieval is available but unnecessary because direct source, Git history, approved
   specification, and durable run artifacts are more authoritative for this tranche. If a later
   semantic-history gap justifies it, record namespace/index, query, filters, top-k, returned IDs,
   scores, source citations, and freshness; retrieval remains advisory until checked against source.

Current direct history establishes two distinct controls. First, stable patch
`8c7a57e0779400bbf9a0b2097289f8615d07f2ac` was independently recommitted under
`e2184312d1a0467cf79754379de48e793aff3538` and
`c883badd3cc3aaeae3ad86b98cd3e3f2d05640fe`; generated documentation has additional exact patch
clusters. Second, July 15 semantic head `a15b3d953589641c81fd8c228e34afeb1cba2d39` is an ancestor of
July 16 head `83a55b131b2fa51f9d3c6c8f3f2494140ae4fd03`, so that pair is successor lineage rather than an
independent duplicate. The follow-on local adapter therefore emits warning-only
`history.patch-already-present`, `history.patch-already-merged`,
`lineage.ancestor-superseded`, and `docs.generated-patch-replay` findings from stable patch,
containment, `git cherry -v`, and `git range-diff` evidence. It emits
`history.live-provider-unavailable:inconclusive` when remote disposition is incomplete. Exact
canonical content may keep the existing blocker policy for a completely observed open or
closed-unmerged PR. Stable-patch identity blocks only a completely observed closed-unmerged PR under
current policy; stable-patch open/merged classification remains warning/deferred. Title, branch,
path, symbol, and semantic similarity alone never block.

Current capability verdict: **Pass for local planning and reconciliation only**. Local execution and
deterministic validation support is observed, but A-08–10 block BCF production changes. Hosted
validation and external consumer discovery remain explicitly outside scope, not hidden capability
gaps.

## Verification Design

The execution root contains
`artifacts/verification/boundary-contract-feedback/verification_matrix.md`, with one row for every
BCF task/transition. Each row records task ID, checked claim, why it matters, exact command or
inspection, verifier, expected output, artifact path, and separate Pass/Fail/Inconclusive/escalation
conditions. Commands are the exact task commands below; references such as “run tests” or “inspect
the diff” are invalid.

Prefer deterministic assertions, parsed state, schema conformance, fixed-key digests, byte counts,
Git diffs, replay, and independent reproduction. Use native JSON where available and normalized
summaries only when they retain links to raw stdout/stderr and direct status. A human review records
the exact file/head/diff and cited finding; “looks correct,” intuition, narrative-only validation,
artifact-free completion, and tests without thresholds are rejected.

A task cannot be `Pass` when its artifact is missing, its producer status is inferred/masked, its
head/diff differs from the reviewed input, its expected red failure is different, or its safe
neighbor was skipped. A reproduced unsafe case is `Fail`. Tool absence, timeout, signal, malformed
result, unexpected red, or conflicting methods is `Inconclusive` and follows the row's escalation
path. Missing authority is `Blocked`.

## Test Evidence and Anti-Fabrication Standard

| Test category | This tranche's proof surface |
|---|---|
| Unit | Rule catalog, canonical contract, digest, aggregation, renderer budgets, provider page race |
| Integration | Receipt builder plus CLI emission/write failure; evaluator delegation to production modules |
| End-to-end | Subprocess CLI status/stdout/receipt behavior and the complete branch gate; no live GitHub/service E2E is claimed |
| Negative | Every direct falsifier and malformed enum/identity/nested field/option |
| Regression | Schema-1 read/render fixture, existing semantic/history/provenance suites, frozen 13/40 and 39/40/18/18 scores |
| Observability | Human/JSON semantic equivalence, limitation visibility, evidence/overflow digest, execution manifest fields |
| Adversarial | Reversed inputs, exact duplicates, cardinality/byte boundaries, punctuation paths, `file:` URLs, late resolve/reject |
| Stale-data | Existing history/provenance regression suites only; new freshness/target policy is explicitly deferred |
| Partial-data | Warning plus limitation, limitations-only, incomplete provider page, receipt-write failure |
| Degradation | Overflow receipt, provider timeout/ignore-abort, load admission, process deadline, unavailable test-integrity fallback |

Each test family records its input source, provenance type (`synthetic`, `sampled`, `captured`, or
`production-derived`), representativeness rationale, expected-result authority, raw artifact path,
and replay command in
`artifacts/verification/boundary-contract-feedback/test_provenance.md`. Expected results come from
the approved specification and pre-implementation direct falsifiers, not from the implementation's
current output. Production-derived inputs are reduced and sanitized; no untrusted comment body,
secret, email, query URL, local path, or live external mutation enters a fixture.

False-positive controls sit beside every unsafe case and differ by one relevant field where
possible. Corpus/holdout labels remain frozen; a score change is investigated, never relabeled to
make the run green. Fake timers must restore in `finally`; subprocess tests assert direct status,
signal, stdout, stderr, and receipt. Raw receipts/logs are preserved under the exact head/diff, and
test-integrity plus an independent read-only review checks that assertions exercise behavior rather
than source strings or fixture-only clones.

Table-driven schema/property boundaries, replay, contradiction checks, and fault injection are the
applicable deep lanes. General mutation testing, signed attestations, network contract testing, and
live DAST are `Not applicable` to this local tranche unless added by a plan amendment. Git OIDs,
SHA-256 digests, and local commit signatures are identities/integrity evidence only; do not call
them third-party attestations. Only `Pass`, `Fail`, `Inconclusive`, or `Blocked` is valid, and absence
of an exception or process error is never sufficient proof.

## TDD Discipline

TDD is mandatory for BCF-01 through BCF-07. Add the exact unsafe case and its nearest safe control
before implementation. Run only the focused command, preserve the failing output/direct status, and
confirm the failure names the planned missing behavior. A compile error, missing module, timeout,
unrelated assertion, or existing failure is not an accepted red phase. If the intended assertion
already passes, inspect whether behavior exists or the test is weak; do not implement until the
discrepancy is resolved.

Implement the smallest change that makes the same focused command green, then run the task's wider
typecheck/regression layer. Do not weaken expected values, delete safe controls, relabel evaluator
cases, expand timeouts/budgets, or catch exceptions merely to obtain green. Each red and green
attempt uses distinct immutable artifact paths and records exact head/diff; the implementation notes
link the accepted pair.

Determinism comes from injected clocks, fake timers in `try/finally`, explicit deferred promises,
temporary committed Git histories, fixed corpus/holdout inputs, sorted canonical data, exact byte
counts, and direct process status. Shared-host load and complete branch-gate duration remain
nondeterministic; admission/deadline outcomes are reported explicitly and cannot override focused
deterministic failures.

The test-provenance record supplies input source/type, expected-result derivation, replay,
counterexample, and artifact for every family. Contract/schema tables, digest properties, replay,
fault injection, and contradiction review are applicable; broad mutation testing is not required.
Independent read-only validation is mandatory after BCF-07 and before BCF-08B, and the lead must
reproduce every decisive finding rather than accepting worker output. Replay artifacts live below
`artifacts/verification/boundary-contract-feedback/test_evidence/`.

### Task 0: Reconcile lineage, predecessor evidence, and immutable run identity

**Files:**
- Before any fetch or merge, create only `scripts/lib/verification/boundary-run-manifest.ts`,
  `scripts/verify-boundary-run.ts`, `tests/scripts/verify-boundary-run.test.ts`, and ignored
  run-scoped artifacts. No semantic-quality source may change before A-08–10 resolve.
- No BCF-authored production or semantic test source may change during upstream reconciliation;
  incoming merge paths are audited separately by merge parents.
- A local merge commit may reconcile `origin/main` only after the committed helper passes its
  post-commit self-verification. Do not rebase/rewrite the 30-commit lineage because historical
  evidence names those commit identities.

**Interfaces:**
- Consumes: SSH `origin`, current planning commit, predecessor plan/handoff, corpus/holdout, existing
  focused suites, and existing branch gate.
- Produces: reconciled exact head/diff; immutable manifest/hash negative controls; predecessor
  focused/evaluator/branch-gate evidence; lifecycle/oracle JSON; run-scoped readiness.

- [ ] **Step 1: Freeze the bootstrap boundary without changing remote or worktree state**

Require this amended planning packet to be committed and the only unrelated state to be the
preflighted owner paths. Set `BCF_VALIDATOR_BASE=$(git rev-parse HEAD)` to that exact amendment
commit; record its plan/specification/notes blob hashes in the advisory bootstrap receipt and reject
the historical specification baseline as a substitute. Before the recorder exists, run only
read-only local identity commands through the lead's direct execution surface:

```bash
git rev-parse --show-toplevel
git rev-parse HEAD
git status --short
git remote get-url origin
```

The remote must be the SSH URL for `LucasQuiles/WhatSoup`. These bootstrap observations preserve
owner work and authorize only creation of the recorder; they are not accepted A-08–10 evidence and
cannot support a Pass. Before the committed helper exists, only the advisory scaffold RED/GREEN
tests and typechecks in Step 2 may run; no fetch, merge, branch gate, semantic mutation, or accepted
A-08–10 test evidence is permitted. If status contains an unexplained path or identity is wrong,
stop as Blocked; do not stash, delete, or overwrite owner work.

- [ ] **Step 2: Implement and commit the recorder before reconciliation**

Create the two typed helper files with only schema declarations and an explicit
`boundary run validator not implemented` result. The scaffold must typecheck; it is not accepted
behavior. Add the validator test and run it through pinned Vitest. RED is accepted only as advisory
bootstrap TDD evidence when the test reaches the exported validator and fails because a valid
staged/unstaged/allowed-untracked snapshot is rejected by that explicit result. Missing module,
syntax/type error, zero tests, or unrelated failure is Inconclusive.

Implement the closed contracts below, including the exact `RUN_WIRE_SCHEMAS` and 33-marker BCF-00
registry, run the complete focused suite and `typecheck:scripts`, inspect the three-file diff, then
freeze the index tree/full status/owner snapshot and perform the sole bare commit exactly as follows:

```bash
git add scripts/lib/verification/boundary-run-manifest.ts \
  scripts/verify-boundary-run.ts \
  tests/scripts/verify-boundary-run.test.ts
git commit -m "feat(quality): add boundary run validator"
```

Apply every bootstrap parent/tree/index/owner postcondition from Mandatory task-run protocol and set
`BCF_VALIDATOR_COMMIT` to that commit. Any different subject, staged path, parent, tree, hook mode, or
remaining allowed-path delta stops Task 0. Because
the recorder cannot attest its own creation, no completion claim rests on the pre-commit RED/GREEN
logs; Step 3 re-executes all decisive positive and negative controls from the immutable committed
helper before any remote mutation.

Implement exactly the closed schema-1 roots, nested key sets, canonical bytes, bounds, locks,
nullability, state machine, head anchors, output-admission transitions, and derived-root algorithm in
Mandatory task-run protocol. For finding conditions, compatible proof fields are nonempty and exact;
incompatible proof fields remain present as `null` or `[]` according to `RUN_WIRE_SCHEMAS`. Every
`requiresReproduction: true` row requires at least one joined lead attempt with matching snapshot,
direct status, and expectation; no review-level success can stand in for a finding join. Do not add
an implementation-selected key, marker, state, anchor, bootstrap subject, or path rule.

The CLI has only `init`, `record-command`, `record-internal-check`, `record-git-transition`,
`record-artifact`, `record-child-run`, `record-review`, `set-upstream`, `set-lifecycle`, `finalize`,
`verify`, `closeout`, and `verify-closeout`.
`set-upstream` is single-use and records the SSH remote URL, observed remote OID, merge base,
ahead/behind counts, observation-manifest hash, merge commit, and both merge parents; absent values
use the explicit state `not-observed`, never null-by-guess. It derives/cross-checks remote, OID,
merge-base, counts, and path identities from the selected profile's accepted required-attempt stdout,
child pin, and Git transition record; raw caller field substitution is rejected. Unknown/duplicate options or schema keys
exit 2. `init --predecessor-run-dir` and `--predecessor-pin` are a profile-required, singular,
all-or-none pair with the exact closed pin shape above; no other command accepts them. The only
repeatable path declarations on `init` are `--allow-path`, `--allow-untracked`, and
`--preserve-owner-path`; each accepts a normalized, repository-relative non-symlink path with the
distinct semantics defined in Mandatory task-run protocol. `record-command --output-path` is the
only pre-execution child-output declaration, while `record-command --expect-exit` accepts `nonzero`
or a comma-separated set of statuses in `0..255`, defaults to `0`, and never rewrites the observed
raw status. `init`, predecessor/child import, completion receipt/ledger creation, and closeout receipt
creation use exclusive creation. `finalize`
rejects missing direct statuses or expectation fields, path escape/symlink/non-regular files,
unregistered or duplicate artifacts/attempts/reviews, head/snapshot drift, lifecycle conflict,
missing finding join, missing or mutated child closure, or mutable finalized state. Tests cover
staged-only, unstaged-only, mode-only, allowed-untracked-only, unexpected-untracked, preserved-owner
mutation, expected numeric/nonzero status and signal mismatch, timeout-owner mutation, undeclared/
missing/duplicate output, artifact producer/role/path collision and one-byte mutation, foreign
head/diff, operational-ID grammar/length/duplicate rejection, stale document hash, duplicate
review/finding, missing or unrelated finding reproduction, accepted critical/major finding
aggregation, deferred required finding, unsupported and valid rejection, fixed proof at wrong and
later exact head, incompatible resolution fields, child import
alias/kind/cycle/depth/task/head/run-ID/expected-digest/hash/path/mutation rejection,
wrong-kind/foreign observation rejection, exact profile/task/required-set equality, non-pass child
aggregation, observation empty-ledger/`chainAppend:false` genesis and predecessor/child pin equality,
upstream single-assignment/parent mismatch, commit/merge transition parent/tree/index/
abort/second-transition rejection, invalid lifecycle enum, closeout accepted/rejected path and
discriminator exclusivity, closeout-core/negative-report binding and mutation/substitution,
final-receipt/lock mutation/substitution, schema/lock/internal-status/manifest-substitution rejection,
snapshot-locked 600 s/300 s outer closeout watchdog contracts plus short test-owned
hanging/forking process-group reaping through the same implementation,
structurally valid Fail/Inconclusive/Blocked run preservation, non-pass closeout exit, finalize
failure before manifest creation, missing/foreign predecessor options, receipt/ledger digest
mismatch, append-by-review, duplicate/reordered chain row, completion-root reuse, and every nearest
valid neighbor. Closeout-state fixtures include a verified-Pass run followed by deterministic
negative-matrix failure and by completion-publication failure, with exact distinct run/closeout
verdicts and the `verified-pass-closeout-rejected` manifest state.

- [ ] **Step 3: Initialize the immutable observation run and trust the committed helper**

Initialize a unique upstream-observation run through the committed helper. Re-run the complete
validator suite and typecheck through `record-command`; register their logs. Run the artifact,
foreign-head, expectation, review-join, and lifecycle mutation controls on sibling copies and
require their declared nonzero statuses. Record exact spec/plan/notes/helper hashes. Only after
those controls pass, record through the helper:

The direct `git merge-tree --write-tree --messages HEAD origin/main` preview has the closed expected-exit set
`0,1`: exit 0 requires stdout to be exactly one tree OID, while exit 1 requires a leading tree OID,
one or more complete stage-1/2/3 rows, and conflict diagnostics whose canonical path set equals the
stage-row path set. A signal, any other exit, missing stage, malformed row, path disagreement, or
unparseable diagnostic is Inconclusive. The helper records the conflict preview as accepted
evidence; it does not treat exit 1 as a clean merge or mutate the worktree.

Recovery note for preserved run `bcf00-observation-e781ae26b`: the first committed helper correctly
preserved its direct exit-1 preview but incorrectly declared `merge-preview` as exit-0/OID-only, so
that run remains Inconclusive. Commit this plan/notes correction first, set `BCF_VALIDATOR_BASE` to
that documentation commit, then make one three-validator-file corrective commit with subject
`fix(quality): accept conflict merge previews`. Re-run the complete postcommit validator suite and
typecheck from a new observation run; never edit or reuse the failed run. For lineage purposes the
corrective interval `BCF_VALIDATOR_BASE..BCF_VALIDATOR_COMMIT` must still contain exactly the three
validator paths and no documentation path.

Second recovery note for preserved run `bcf00-reconciliation-8a4e34828`: merge transition
`39023446bcbf6795a51d2142678b7fcdb836fe3e` correctly joined first parent
`8a4e348282a7c7be17576f352208a52802bce1eb` and pinned second parent
`5d16cd401e1250f417f7bde481a4cc8b0ad1df55`, regenerated only the two authorized work-index
conflicts, and recorded a passing conflict-resolution report. Its required
`postmerge-validator-suite` then failed because the pinned-conflict regression cloned the current
postmerge head, where the pinned parent was already an ancestor, instead of reconstructing the
historical first-parent fixture. Preserve that reconciliation run and the original branch at the
merge; neither is retryable evidence. Recover on a distinct branch from `8a4e348282a7c7be17576f352208a52802bce1eb`
with one plan/notes commit followed by the exact three-validator-file correction
`fix(quality): make pinned merge regression head-independent`. The fixture must select the first
parent of a reachable merge whose second parent is the profile-owned pinned OID, when present, and
otherwise retain the current premerge head. Re-run the full observation and reconciliation under
new run IDs; only their fresh immutable receipts may advance BCF-00.

```bash
git rev-parse --show-toplevel
git rev-parse HEAD
git status --short
git remote get-url origin
git fetch origin
git rev-parse origin/main
git merge-base HEAD origin/main
git rev-list --left-right --count origin/main...HEAD
git diff --name-status <observed-merge-base>...origin/main
git diff --name-status <observed-merge-base>...HEAD
git merge-tree --write-tree --messages HEAD origin/main
```

Map those displayed commands in order to `upstream-root`, `upstream-head`, `upstream-status`,
`upstream-remote`, `upstream-fetch`, `upstream-origin-oid`, `upstream-merge-base`,
`upstream-ahead-behind`, `upstream-remote-diff`, `upstream-local-diff`, and `merge-preview`.
`<observed-merge-base>` is not shell substitution: the helper resolves it only from the validated
40-hex stdout of required attempt `upstream-merge-base` and injects it into the two exact argv
templates. A missing, multiline, non-hex, or stale prerequisite blocks both diff attempts.

Register the merge preview/path inventory, call `set-upstream` with the observation fields and
`mergeCommit: not-observed`, set the observation profile lifecycle to `closed` with final gate
`pass`, then finalize, hash-lock, and verify its Pass without completing BCF-00. Recompute rather
than expect the planning values. If an owner path collides with an upstream path, fetch/preview
fails, or output is incomplete, stop before merge.

- [ ] **Step 4: Reconcile upstream through a new helper-owned run**

Initialize a distinct reconciliation run that hash-joins the finalized observation manifest and
declares every previewed upstream path as an allowed merge path. Admit it as alias
`upstream-observation`/kind `observation` using the exact observed task, head, run ID, and locked
manifest SHA-256; any mismatch blocks reconciliation. Require the observation remote OID to still
equal `origin/main`, then run the profile-authorized transition:

```bash
bash scripts/run-with-pinned-node.sh scripts/verify-boundary-run.ts record-git-transition \
  --run-dir "$BCF_RECONCILIATION_RUN_DIR" --attempt merge-transition --kind merge \
  --expect-before "$BCF_VALIDATOR_COMMIT" \
  --expect-second-parent "$BCF_OBSERVED_UPSTREAM_OID"
```

If Git reports conflicts outside the exact closed generated-work-index policy, the helper saves the
conflict path/status/stage artifacts, runs `git merge --abort`, and must verify the pre-merge
head/status are restored; then stop for another conflict-specific plan amendment. For the currently
pinned upstream only, an exact two-path conflict on `docs/work-index.json` and
`docs/work-index.md` follows the helper-owned regeneration contract above; no caller content choice,
strategy override, or other conflict resolution is authorized. On success, record the merge commit,
both parents, new `origin/main...HEAD` count, merge-base binary-diff identity, and post-merge helper
tests. Call `set-upstream` once with the exact joined observation manifest and merge identities. Set
both `BCF_UPSTREAM_MERGE` and `BCF_RECONCILED_BASE` to the merge commit; its first parent must equal
`BCF_VALIDATOR_COMMIT` and second parent the observed remote OID. The reconciliation receipt
separately proves which paths came from each merge parent.

- [ ] **Step 5: Reproduce predecessor focused and per-case evaluator evidence**

Run without `tee`, recording argv, stdout, stderr, and direct status separately:

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
bash scripts/run-with-pinned-node.sh scripts/experiments/semantic-boundary-eval.ts \
  --engine baseline --corpus tests/fixtures/semantic-boundary-eval/cases.json --format json
bash scripts/run-with-pinned-node.sh scripts/experiments/semantic-boundary-eval.ts \
  --engine candidate --corpus tests/fixtures/semantic-boundary-eval/cases.json --verify-git --format json
bash scripts/run-with-pinned-node.sh scripts/experiments/semantic-boundary-eval.ts \
  --engine candidate --corpus tests/fixtures/semantic-boundary-eval/holdout.json --verify-git --format json
```

Require the focused count observed at the reconciled head, baseline 13/40, candidate 39/40 with the
single named warning-only similarity mismatch, holdout 18/18, zero false blocks, zero missed
critical candidate/holdout cases, and the expected result for every individual case. Totals without
per-case records, the historical 40/40 file, a changed label, masked status, or a score change block
BCF-01.

- [ ] **Step 6: Complete the predecessor branch gate**

Run `verify:push:branch` with skip variables unset under the installed GNU process-group timeout,
with strict `loadgate` admission inside the deadline, using the same status/signal/stdout/stderr
contract as Task 8. This closes predecessor evidence only; it does not satisfy the later BCF-08C
gate. A nonzero, signal, timeout, load-admission failure, missing output, or inferred pipeline status
is Inconclusive and leaves A-08 Blocked.

- [ ] **Step 7: Write lifecycle/oracle disposition and readiness**

Write `lifecycle.json` with one object per packet containing `planPath`, `planSha256`, `status`,
`completionCommit`, `finalGateState`, `finalGateArtifactSha256`, `successor`, `supersededBy`, and
`oracleDisposition`. Mark the historical 40/40 artifact `superseded-invalid-oracle`, point the
current oracle to the raw reconciled 39/40 per-case artifact, and leave branch deletion false. Then
register the lifecycle and oracle artifacts under their closed producer attempts and call
`set-lifecycle` with status `completed`, final gate `pass`, and oracle `current`; this declaration
does not make the run Pass while required `readiness-check` is still absent. Then
invoke `readiness-check`; it derives the closed run-scoped `ReadinessRecord` from the immutable
manifest and emits `Ready with Constraints` plus next action BCF-01 only if every Step 1–6 artifact
and direct status passes, otherwise `Not Ready` plus exact blockers. Do not author or import a
readiness file outside that internal check.

After `readiness-check` atomically registers its own result, finalize the
reconciliation manifest with every child hash, generate `run_manifest.sha256`, and rerun all
hash/field checks. The validator and reconciled merge are separate commits;
`BCF_VALIDATOR_BASE..BCF_VALIDATOR_COMMIT` owns only the three validator files, while
`BCF_RECONCILED_BASE` is the verified merge commit used for later authored-scope comparisons. The
ignored evidence remains local. BCF-01 starts only from that exact verified head.

### Task 1: Make CLI option parsing fail closed

**Files:**
- Modify: `scripts/semantic-quality-check.ts:22-113, 285-329`
- Modify: `tests/scripts/semantic-quality-check.test.ts` in the CLI describe block

**Interfaces:**
- Consumes: existing `SemanticQualityCliOptions`, `choice()`, `runSemanticQuality()`.
- Produces: strict `parseSemanticQualityArgs()` and diagnostic-only
  `fallbackDiagnosticOptions()` whose enforcement mode is always `enforce` after parse failure.

- [ ] **Step 1: Add failing table-driven CLI tests**

Add these cases to `tests/scripts/semantic-quality-check.test.ts`:

```ts
it.each([
  ['case typo', ['--mode', 'ENFORCE']],
  ['missing value', ['--mode']],
  ['duplicate mode', ['--mode', 'enforce', '--mode', 'shadow']],
  ['duplicate head', ['--head', 'HEAD', '--head', 'origin/main']],
  ['duplicate target ref', ['--target-ref', 'refs/heads/a', '--target-ref', 'refs/heads/b']],
] as const)('fails closed for %s', (_name, args) => {
  const repo = makeHistory().repo;
  const result = runCli(repo, [...args, '--format', 'json', '--no-receipt']);
  expect(result.status).toBe(2);
  const parsed = JSON.parse(result.stdout) as BoundaryReceipt;
  expect(parsed).toMatchObject({
    decision: 'inconclusive',
    enforcementMode: 'enforce',
    findings: [expect.objectContaining({ ruleId: 'semantic.invocation-invalid' })],
  });
});

it('fails closed for duplicate --no-receipt', () => {
  const repo = makeHistory().repo;
  const result = runCli(repo, [
    '--format', 'json', '--no-receipt', '--no-receipt',
  ]);
  expect(result.status).toBe(2);
  const parsed = JSON.parse(result.stdout) as BoundaryReceipt;
  expect(parsed).toMatchObject({
    decision: 'inconclusive',
    enforcementMode: 'enforce',
    findings: [expect.objectContaining({ ruleId: 'semantic.invocation-invalid' })],
  });
});
```

- [ ] **Step 2: Run the CLI tests and capture RED**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/semantic-quality-check.test.ts \
  --pool=forks --fileParallelism=false
```

Expected: the typo and duplicate-mode cases exit 0 or parse the last value; duplicate singleton
cases are not rejected.

- [ ] **Step 3: Implement singleton tracking and diagnostic fallback**

Add `targetRef: string | null` to `SemanticQualityCliOptions`, default it to `null`, and parse the
optional `--target-ref <full-ref>` without consulting ambient environment state. Add exact singleton
tracking:

```ts
const SINGLETON_FLAGS = new Set([
  '--scope', '--head', '--base', '--target-ref', '--mode', '--format', '--receipt', '--no-receipt',
]);

function markSingleton(seen: Set<string>, flag: string): void {
  if (!SINGLETON_FLAGS.has(flag)) return;
  if (seen.has(flag)) throw new Error(`${flag} may be supplied only once`);
  seen.add(flag);
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}
```

Call `markSingleton(seen, arg)` before every recognized flag is applied. Replace
`fallbackOptions()` with:

```ts
function fallbackDiagnosticOptions(argv: string[]): SemanticQualityCliOptions {
  const exactFormat = argv.filter((value) => value === '--format').length === 1
    ? rawValue(argv, '--format')
    : undefined;
  return {
    scope: 'branch',
    head: 'HEAD',
    base: 'origin/main',
    targetRef: null,
    mode: 'enforce',
    format: exactFormat === 'json' ? 'json' : 'human',
    receiptPath: null,
    noReceipt: true,
  };
}
```

In the parse-error branch set `options = fallbackDiagnosticOptions(argv)` and retain the existing
`semantic.invocation-invalid` finding. Do not reuse a malformed receipt path or scope/head/base input.

- [ ] **Step 4: Run CLI tests GREEN**

Run the Step 2 command. Expected: all CLI and receipt tests pass and every invalid invocation exits
2 with recorded `enforcementMode: "enforce"`.

- [ ] **Step 5: Commit Task 1**

```bash
git add scripts/semantic-quality-check.ts tests/scripts/semantic-quality-check.test.ts
bash scripts/run-with-pinned-node.sh scripts/verify-boundary-run.ts record-git-transition \
  --run-dir "$BCF_TASK_RUN_DIR" --attempt parser-commit-transition --kind commit \
  --expect-before "$BCF_TASK_ENTRY_HEAD" \
  --message-subject "fix(quality): fail closed on invalid semantic options"
```

---

### Task 2: Add stable rule guidance and versioning

**Files:**
- Modify: `scripts/lib/semantic-quality/boundary-types.ts` for shared guidance types only
- Create: `scripts/lib/semantic-quality/rule-guidance.ts`
- Create: `tests/scripts/semantic-rule-guidance.test.ts`
- Create compile-only scaffold: `scripts/lib/semantic-quality/boundary-contract.ts`
- Create compile-only scaffold: `tests/scripts/semantic-boundary-contract.test.ts`

**Interfaces:**
- Consumes: current rule IDs emitted by semantic policy, history, provenance, and operational
  receipt paths.
- Produces: shared `EvidenceState`/command/correction types, `guidanceForRule()` and
  `ruleCatalogDigestSha256()` used by Tasks 3–4, plus explicitly non-behavioral Task 3 scaffolds.

- [ ] **Step 1: Generate and freeze the current producer inventory**

Run the four literal commands through `record-command`. The helper opens each prior accepted
attempt's immutable stdout log as the next attempt's stdin; no shell, pipeline, redirection,
assignment, or ambient variable participates. The `wc` attempt contract applies the closed stdout
predicate `trimmed decimal integer equals 29`. Each direct child has its own raw status, stdout,
stderr, and hash:

```bash
rg --no-filename -o \
  "'(?:boundary|semantic|history|provenance|supply-chain|process)\.[a-z0-9.-]+'" \
  scripts/lib/semantic-quality/policy.ts \
  scripts/lib/semantic-quality/history.ts \
scripts/lib/semantic-quality/provenance.ts \
  scripts/semantic-quality-check.ts \
  scripts/experiments/semantic-boundary-eval.ts
tr -d "'"
sort -u
wc -l
```

Invoke them as attempts `catalog-inventory-raw`, `catalog-inventory-strip`,
`catalog-inventory-sort`, and `catalog-inventory-count`. Require all four direct statuses zero and
the final stdout predicate to pass. The sort attempt's owned stdout is the immutable
`rule-producer-inventory.txt` logical artifact; register that exact log without copying it.

Expected at the planning baseline: 29 current producer IDs, including the evaluator-only
`boundary.timeout`, three `supply-chain.*` IDs, `process.unbounded-primitive`, and
`semantic.guard-negative-control`. Inspect every matched source line; a string in a comment/test is
not a producer. Store planned contract-only IDs separately. A-02 resolves only when the inspected
current producer set, planned contract set, catalog keys, and integration fixture set have an empty
four-way difference. `catalogRuleIds()` and the integration fixture are compared by the test, not by
visual inspection. Missing output, nonzero producer/normalizer status, count other than 29, or an
unexplained ID blocks BCF-02.

- [ ] **Step 2: Write failing catalog coverage tests**

Create `tests/scripts/semantic-rule-guidance.test.ts`:

```ts
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  catalogRuleIds,
  evidenceStateForRule,
  guidanceForRule,
  ruleCatalogDigestSha256,
} from '../../scripts/lib/semantic-quality/rule-guidance.ts';

const CURRENT_RULES = [
  'boundary.action-identity-unproven',
  'boundary.contract-invalid',
  'boundary.evidence-incomplete',
  'boundary.evidence-volume-exceeded',
  'boundary.finding-identity-conflict',
  'boundary.artifact-identity-conflict',
  'boundary.timeout',
  'semantic.production-reachability',
  'semantic.export-ownership',
  'semantic.unresolved-runtime-edge',
  'semantic.invalid-allowlist',
  'semantic.candidate-unavailable',
  'semantic.policy-unavailable',
  'semantic.source-tree-unavailable',
  'semantic.analysis-unavailable',
  'semantic.invocation-invalid',
  'semantic.receipt-write-failed',
  'semantic.guard-negative-control',
  'supply-chain.mutable-action',
  'supply-chain.mutable-image',
  'supply-chain.floating-runner',
  'process.unbounded-primitive',
  'history.evidence-incomplete',
  'history.exact-open-pr',
  'history.exact-merged-pr',
  'history.exact-closed-pr',
  'history.renamed-patch-closed-pr',
  'history.blob-subset',
  'history.path-overlap',
  'history.exact-issue',
  'history.incomplete-reentry',
  'provenance.unavailable',
  'provenance.stale-tracking-ref',
  'provenance.stale-overlap',
  'provenance.stale-disjoint',
] as const;

describe('boundary rule guidance', () => {
  it.each(CURRENT_RULES)('%s has corrective versioned guidance', (ruleId) => {
    const guidance = guidanceForRule(ruleId);
    expect(guidance.ruleVersion).toBe(1);
    for (const values of [
      guidance.expected,
      guidance.impact,
      guidance.safeControls,
    ]) {
      expect(values.length).toBeGreaterThan(0);
      expect(values.every((value) => value.trim().length >= 12)).toBe(true);
    }
    expect(guidance.correction.length).toBeGreaterThanOrEqual(2);
    expect(guidance.correction.length).toBeLessThanOrEqual(4);
    expect(guidance.correction.every((step) =>
      step.target.trim().length >= 12 && step.expected.trim().length >= 24,
    )).toBe(true);
    expect(guidance.verification.length).toBeGreaterThan(0);
    expect(guidance.verification.every((step) =>
      step.command.trim().length > 0
      && step.args.length > 0
      && step.expected.trim().length >= 12,
    )).toBe(true);
    expect(guidance.rerun.command.trim().length).toBeGreaterThan(0);
    expect(guidance.rerun.args.length).toBeGreaterThan(0);
    expect(guidance.rerunPurpose).toMatch(/^(integration-boundary|focused-family-replay)$/);
    expect(guidance.sourceRefs.length).toBeGreaterThan(0);
    expect(guidance.sourceRefs.every((source) =>
      /^(?:scripts|tests|docs|config)\/[A-Za-z0-9._/-]+(?::\d+)?$|^boundary-contract:[a-z0-9-]+$/.test(source),
    )).toBe(true);
    expect(guidance.sourceRefs.every((source) =>
      source.startsWith('boundary-contract:') || existsSync(source.replace(/:\d+$/, '')),
    )).toBe(true);
    expect(evidenceStateForRule(ruleId)).toMatch(/^(observed|absent|invalid|unavailable|stale|unknown)$/);
    const prose = JSON.stringify(guidance).toLowerCase();
    expect(prose).not.toMatch(/"(?:fix it|fix this|retry|run tests|npm test|check logs|do better)"/);
    for (const command of guidance.verification) {
      expect(command.command).toBe('bash');
      expect(command.args[0]).toMatch(/^scripts\/run-with-pinned-(?:npm|node)\.sh$/);
      expect(existsSync(command.args[0]!)).toBe(true);
      const testFile = command.args.find((arg) => arg.startsWith('tests/'));
      expect(testFile && existsSync(testFile)).toBe(true);
    }
    expect(guidance.rerun.command).toBe('bash');
    expect(guidance.rerun.args[0]).toMatch(/^scripts\/run-with-pinned-(?:npm|node)\.sh$/);
    expect(existsSync(guidance.rerun.args[0]!)).toBe(true);
    const rerunTestFile = guidance.rerun.args.find((arg) => arg.startsWith('tests/'));
    if (rerunTestFile) expect(existsSync(rerunTestFile)).toBe(true);
    else expect(guidance.rerun.args).toContain('guard:semantic-quality');
  });

  it('rejects an unregistered rule instead of inventing generic guidance', () => {
    expect(() => guidanceForRule('unknown.rule')).toThrow(/unregistered boundary rule/i);
  });

  it('produces a stable catalog digest', () => {
    expect(ruleCatalogDigestSha256()).toMatch(/^[0-9a-f]{64}$/);
    expect(ruleCatalogDigestSha256()).toBe(ruleCatalogDigestSha256());
  });

  it('covers exactly the inspected producer plus contract rule set', () => {
    expect(catalogRuleIds()).toEqual([...CURRENT_RULES].sort());
  });
});
```

- [ ] **Step 3: Add shared types/scaffolds and capture catalog RED**

Move `EvidenceState`, `BoundaryCorrectionStep`, `BoundaryCommand`, and
`BoundaryVerificationStep` into `boundary-types.ts` before `rule-guidance.ts` imports them. Preserve
every pre-existing type unchanged. Create a compile-only `rule-guidance.ts` scaffold exporting the
required functions; each function throws `rule guidance catalog not implemented` and
`catalogRuleIds()` returns an empty array. Also create compile-only Task 3 module/test scaffolds so
the catalog's contract-family source and test references exist; the module exports only an explicit
`boundary contract not implemented` function and the test file imports it without any accepted
behavior. Neither scaffold is Task 3 RED or contract evidence.

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/semantic-rule-guidance.test.ts \
  --pool=forks --fileParallelism=false
```

Expected: the test imports the module, executes the public API, and fails on the explicit
not-implemented/empty-catalog behavior. Missing import, syntax/type error, zero tests, or unrelated
failure is Inconclusive.

- [ ] **Step 4: Implement the catalog without generic fallback**

Create `rule-guidance.ts` with this shape:

```ts
import { createHash } from 'node:crypto';

export interface BoundaryRuleGuidance {
  ruleVersion: number;
  expected: string[];
  impact: string[];
  safeControls: string[];
  correction: BoundaryCorrectionStep[];
  verification: BoundaryVerificationStep[];
  rerun: BoundaryCommand;
  rerunPurpose: 'integration-boundary' | 'focused-family-replay';
  sourceRefs: string[];
}

const define = (
  expected: string,
  impact: string,
  safeControl: string,
  verification: string,
): RuleInvariantGuidance => ({
  ruleVersion: 1,
  expected: [expected],
  impact: [impact],
  safeControls: [safeControl],
  verificationExpected: verification,
});

type RuleInvariantGuidance = Omit<BoundaryRuleGuidance,
  'correction' | 'verification' | 'rerun' | 'rerunPurpose' | 'sourceRefs'> & {
    verificationExpected: string;
  };

const RULE_GUIDANCE: Record<string, RuleInvariantGuidance> = {
  'boundary.action-identity-unproven': define(
    'The action has the exact required repository, target, and committed candidate identity.',
    'A decision bound to an unknown target can authorize a different action than the one reviewed.',
    'A valid action-specific Git or task identity remains accepted.',
    'Rerun the boundary with the exact target and assert its identity in JSON output.',
  ),
  'boundary.contract-invalid': define(
    'Every runtime enum and required nested field is valid after canonicalization.',
    'Malformed runtime values can bypass compile-time types and collapse to pass.',
    'A complete canonical finding retains its original decision.',
    'Replay the rejected field and its nearest valid neighbor through the contract tests.',
  ),
  'boundary.evidence-incomplete': define(
    'Every evidence source required by the action completed without limitations.',
    'Partial evidence cannot prove that no unsafe condition exists.',
    'A complete observation with no limitations may preserve its warn or pass decision.',
    'Repair the named evidence source and rerun the complete boundary action.',
  ),
  'boundary.evidence-volume-exceeded': define(
    'Canonical evidence remains within declared cardinality and byte budgets.',
    'Unbounded evidence can exhaust CI logs or remove corrective guidance from agent context.',
    'An at-limit receipt remains complete and byte-stable.',
    'Run the at-limit and one-over-limit receipt budget tests.',
  ),
  'boundary.finding-identity-conflict': define(
    'Every finding has one stable rule-and-evidence identity.',
    'Conflicting duplicates make receipt bytes depend on provider input order.',
    'Distinct evidence digests under one rule sort deterministically.',
    'Reverse the input order and compare complete receipt bytes.',
  ),
  'boundary.artifact-identity-conflict': define(
    'Each matched artifact identity appears once with one canonical state and fingerprint.',
    'Duplicate or conflicting artifact records make receipt identity depend on provider order.',
    'Distinct artifact identities in reversed order produce byte-identical receipts.',
    'Run exact-duplicate and conflicting-artifact reversal controls.',
  ),
  'boundary.timeout': define(
    'Every bounded evaluator action settles before its owned deadline.',
    'An unbounded evaluation can consume the agent or CI execution window without a decision.',
    'A neighboring action that settles before the same deadline remains accepted.',
    'Run the evaluator timeout fixture and its resolve-before-deadline control.',
  ),
  'semantic.production-reachability': define(
    'Every changed production module is reachable from a declared runtime root.',
    'Disconnected production code can pass isolated tests without affecting runtime behavior.',
    'A runtime import and behavior test through the declared owner remains accepted.',
    'Run npm run verify:semantic with the exact candidate and base.',
  ),
  'semantic.export-ownership': define(
    'Every reachable runtime export has a current production owner.',
    'Orphan exports preserve disconnected APIs and invite duplicate implementations.',
    'An export called by its reachable production owner remains accepted.',
    'Run the export-ownership fixtures and npm run verify:semantic.',
  ),
  'semantic.unresolved-runtime-edge': define(
    'Every literal relative runtime edge resolves in the exact candidate tree.',
    'An unresolved edge makes the claimed composition path unprovable.',
    'A valid literal edge to a committed source remains accepted.',
    'Run the unresolved-edge fixture and its valid neighboring import.',
  ),
  'semantic.invalid-allowlist': define(
    'Every allowlist record is canonical, owned, reasoned, current, and path-qualified.',
    'Malformed overrides can hide semantic evidence or false-block canonical paths.',
    'A canonical unexpired record with every required field remains accepted.',
    'Run policy validation and the canonical-path neighbor fixture.',
  ),
  'semantic.candidate-unavailable': define(
    'The requested candidate resolves to an exact committed tree.',
    'Without a candidate tree, semantic analysis cannot describe the proposed action.',
    'A neighboring valid commit identity resolves and is analyzed.',
    'Fetch the candidate and rerun npm run verify:semantic with --head.',
  ),
  'semantic.policy-unavailable': define(
    'The semantic policy is readable from the exact candidate revision.',
    'Missing policy leaves roots, source scope, and exceptions unknown.',
    'A readable schema-valid policy remains accepted.',
    'Restore config/semantic-quality.json and rerun policy tests.',
  ),
  'semantic.source-tree-unavailable': define(
    'The exact candidate source tree and every declared root are readable.',
    'Partial source inventory makes reachability conclusions incomplete.',
    'A complete source tree with every configured root remains accepted.',
    'Restore the missing tree entry and rerun the exact-tree test.',
  ),
  'semantic.analysis-unavailable': define(
    'Parsing, graph construction, reachability, and ownership analysis complete.',
    'Partial graph output cannot prove semantic safety.',
    'A parseable neighboring source graph remains accepted.',
    'Correct the named analysis failure and rerun the focused semantic suite.',
  ),
  'semantic.invocation-invalid': define(
    'The CLI has one valid value for each singleton option.',
    'Ambiguous options can evaluate a different mode, target, or scope than requested.',
    'A single exact option value remains accepted.',
    'Correct the invocation and rerun the exact command shown by the finding.',
  ),
  'semantic.receipt-write-failed': define(
    'The complete receipt is written atomically to a private non-symlink path.',
    'An in-memory decision without durable evidence cannot prove boundary completion.',
    'A private regular destination remains writable and durable.',
    'Repair the destination and rerun the entire boundary action.',
  ),
  'semantic.guard-negative-control': define(
    'Every changed guard has a fixture proving its unsafe input is rejected.',
    'A guard without a negative control can exist in source while never detecting its target.',
    'A guard with both unsafe and nearest-safe fixtures remains accepted.',
    'Run the evaluator negative-control fixture and the named guard test.',
  ),
  'supply-chain.mutable-action': define(
    'Every workflow action reference is pinned to an immutable commit identity.',
    'A mutable action tag can change executed code without a repository diff.',
    'An exact immutable action commit reference remains accepted.',
    'Run the mutable-action evaluator fixture and its pinned neighbor.',
  ),
  'supply-chain.mutable-image': define(
    'Every workflow or deploy image reference is pinned to an immutable digest.',
    'A mutable image tag can change runtime bytes without a repository diff.',
    'An exact image digest reference remains accepted.',
    'Run the mutable-image evaluator fixture and its digest-pinned neighbor.',
  ),
  'supply-chain.floating-runner': define(
    'Every safety-relevant runner contract is version-bounded by the repository policy.',
    'A floating runner label can change toolchain behavior without a controlled version transition.',
    'A policy-approved version-bounded runner remains accepted.',
    'Run the floating-runner evaluator fixture and its version-bounded neighbor.',
  ),
  'process.unbounded-primitive': define(
    'Every bare process primitive is owned by a deadline and process-group reaper.',
    'An unowned child can outlive the gate and make a timeout look complete.',
    'A process-group-owned bounded child remains accepted.',
    'Run the unbounded-process evaluator fixture and watchdog canary.',
  ),
  'history.evidence-incomplete': define(
    'History proves the repository identity, coherent observation, and terminal page.',
    'Partial history cannot prove that an equivalent pull request or issue is absent.',
    'A complete bounded collection with a terminal cursor remains accepted.',
    'Repair the named provider limitation, run the focused history verification, then execute the catalog rerun command.',
  ),
  'history.exact-open-pr': define(
    'A new boundary action does not recreate content already present in an open pull request.',
    'Exact canonical path-and-blob identity proves the existing proposal already owns the work.',
    'Materially different committed content with a different fingerprint remains accepted.',
    'Continue through the named open pull request or rerun after a material content change.',
  ),
  'history.exact-merged-pr': define(
    'Recreated merged work includes proof that current main lacks the required reachable behavior.',
    'Merged content may have been reverted, but recreating it without reachability proof repeats work.',
    'A proven current-main behavior gap plus a material delta remains reviewable.',
    'Link the merged artifact, prove the current gap, run focused history verification, then execute the catalog rerun command.',
  ),
  'history.exact-closed-pr': define(
    'Closed-unmerged content is not recreated without satisfying its recorded disposition.',
    'Exact content survives branch deletion and proposal recreation and otherwise repeats prior work.',
    'A complete material re-entry packet satisfying every prior condition remains reviewable.',
    'Cite the closed artifact, satisfy its disposition, run focused history verification, then execute the catalog rerun command.',
  ),
  'history.renamed-patch-closed-pr': define(
    'A renamed candidate does not reproduce a stable patch from a closed-unmerged pull request.',
    'Stable patch identity detects recreated work even when paths and proposal commits change.',
    'A materially different patch with a different stable identity remains accepted.',
    'Resolve the prior disposition or change the implementation, then rerun the history fixture.',
  ),
  'history.blob-subset': define(
    'Reused candidate blobs have an explicit relationship to every matching prior pull request.',
    'Exact blob reuse is strong duplicate context even when a shared refactor is legitimate.',
    'Intentional reuse with a distinct production owner and documented behavior delta remains reviewable.',
    'Link the matched artifacts, explain each reused blob, run focused history verification, then execute the catalog rerun command.',
  ),
  'history.path-overlap': define(
    'Shared repository paths have a documented behavior-level distinction from prior proposals.',
    'Path overlap is contextual evidence that can expose repetition but is not duplicate proof alone.',
    'A distinct behavior on an overlapping path remains accepted as a warning-level case.',
    'Link the overlapping artifact, describe the behavioral delta, and rerun the history check.',
  ),
  'history.exact-issue': define(
    'A new issue has a materially distinct normalized task identity or continues the existing issue.',
    'An exact normalized title-and-body identity means the task already has an issue artifact.',
    'Materially distinct acceptance criteria produce a different task fingerprint.',
    'Continue on the named issue or revise the task body, run focused history verification, then execute the catalog rerun command.',
  ),
  'history.incomplete-reentry': define(
    'A resubmission cites every prior artifact, satisfies every condition, and names a changed owner.',
    'Cosmetic deltas or ambient overrides cannot cure a recorded architectural disposition.',
    'A material owner change or a current fingerprint-scoped owner override remains reviewable.',
    'Complete the re-entry packet and rerun the disposition fixtures before reopening work.',
  ),
  'provenance.unavailable': define(
    'One coherent observation proves repository, remote tip, tracking tip, merge base, counts, and paths.',
    'Missing or contradictory upstream evidence makes duplicate and collision comparisons untrustworthy.',
    'A complete internally consistent observation from the configured upstream remains accepted.',
    'Fetch the upstream, recompute every field from one observation, and rerun provenance checks.',
  ),
  'provenance.stale-tracking-ref': define(
    'The local tracking ref equals the remotely observed tip before downstream comparison.',
    'A stale tracking identity invalidates merge-base, overlap, and duplicate conclusions.',
    'A fetched tracking ref equal to the observed remote tip remains accepted.',
    'Fetch the configured upstream, assert both OIDs match, and rerun provenance checks.',
  ),
  'provenance.stale-overlap': define(
    'The candidate reconciles upstream changes that overlap candidate or high-coupling paths.',
    'Unreconciled safety-relevant overlap can invalidate the implementation and its verification.',
    'A current candidate or deliberately reconciled overlap with focused tests remains accepted.',
    'Rebase or merge, test every named path, and rerun provenance plus semantic boundaries.',
  ),
  'provenance.stale-disjoint': define(
    'An older candidate explicitly acknowledges and reviews a disjoint upstream delta.',
    'Disjoint paths lower immediate collision risk but do not make stale-base risk disappear.',
    'A current candidate or reviewed disjoint delta remains warning-level rather than blocked.',
    'Review the upstream delta, update when policy requires it, and rerun provenance checks.',
  ),
};

type RuleFamily = 'contract' | 'cli' | 'semantic' | 'history' | 'provenance' | 'evaluator';

const FAMILY_EXECUTION: Record<RuleFamily, {
  testFile: string;
  sourceRef: string;
  rerunArgs: string[];
  rerunPurpose: BoundaryRuleGuidance['rerunPurpose'];
}> = {
  contract: {
    testFile: 'tests/scripts/semantic-boundary-contract.test.ts',
    sourceRef: 'scripts/lib/semantic-quality/boundary-contract.ts',
    rerunArgs: ['scripts/run-with-pinned-npm.sh', 'run', 'guard:semantic-quality', '--',
      '--scope', 'branch', '--mode', 'shadow', '--format', 'json', '--no-receipt'],
    rerunPurpose: 'integration-boundary',
  },
  cli: {
    testFile: 'tests/scripts/semantic-quality-check.test.ts',
    sourceRef: 'scripts/semantic-quality-check.ts',
    rerunArgs: ['scripts/run-with-pinned-npm.sh', 'run', 'guard:semantic-quality', '--',
      '--scope', 'branch', '--mode', 'shadow', '--format', 'json', '--no-receipt'],
    rerunPurpose: 'integration-boundary',
  },
  semantic: {
    testFile: 'tests/scripts/semantic-quality-policy.test.ts',
    sourceRef: 'scripts/lib/semantic-quality/policy.ts',
    rerunArgs: ['scripts/run-with-pinned-npm.sh', 'run', 'guard:semantic-quality', '--',
      '--scope', 'branch', '--mode', 'shadow', '--format', 'json', '--no-receipt'],
    rerunPurpose: 'integration-boundary',
  },
  history: {
    testFile: 'tests/scripts/semantic-history.test.ts',
    sourceRef: 'scripts/lib/semantic-quality/history.ts',
    rerunArgs: ['scripts/run-with-pinned-npm.sh', 'test', '--',
      'tests/scripts/semantic-history.test.ts', '--pool=forks', '--fileParallelism=false'],
    rerunPurpose: 'focused-family-replay',
  },
  provenance: {
    testFile: 'tests/scripts/semantic-provenance.test.ts',
    sourceRef: 'scripts/lib/semantic-quality/provenance.ts',
    rerunArgs: ['scripts/run-with-pinned-npm.sh', 'test', '--',
      'tests/scripts/semantic-provenance.test.ts', '--pool=forks', '--fileParallelism=false'],
    rerunPurpose: 'focused-family-replay',
  },
  evaluator: {
    testFile: 'tests/scripts/semantic-boundary-eval.test.ts',
    sourceRef: 'scripts/experiments/semantic-boundary-eval.ts',
    rerunArgs: ['scripts/run-with-pinned-npm.sh', 'test', '--',
      'tests/scripts/semantic-boundary-eval.test.ts', '--pool=forks', '--fileParallelism=false'],
    rerunPurpose: 'focused-family-replay',
  },
};

function familyForRule(ruleId: string): RuleFamily {
  if (ruleId.startsWith('history.')) return 'history';
  if (ruleId.startsWith('provenance.')) return 'provenance';
  if (ruleId === 'semantic.invocation-invalid' || ruleId === 'semantic.receipt-write-failed') return 'cli';
  if (ruleId.startsWith('supply-chain.') || ruleId.startsWith('process.')
      || ruleId === 'semantic.guard-negative-control' || ruleId === 'boundary.timeout') return 'evaluator';
  if (ruleId.startsWith('semantic.')) return 'semantic';
  return 'contract';
}

function operationForRule(ruleId: string): BoundaryCorrectionStep['operation'] {
  if (ruleId === 'history.exact-open-pr' || ruleId === 'history.exact-issue') return 'reuse';
  if (ruleId.startsWith('provenance.') || ruleId === 'history.evidence-incomplete') return 'refresh';
  if (ruleId === 'history.incomplete-reentry' || ruleId === 'boundary.timeout') return 'retry';
  return 'edit';
}

function executionForRule(ruleId: string, expected: string): Pick<BoundaryRuleGuidance,
  'correction' | 'verification' | 'rerun' | 'rerunPurpose' | 'sourceRefs'> {
  const family = FAMILY_EXECUTION[familyForRule(ruleId)];
  const verification = {
    command: 'bash',
    args: ['scripts/run-with-pinned-npm.sh', 'test', '--', family.testFile,
      '--pool=forks', '--fileParallelism=false'],
  };
  const rerun = {
    command: 'bash',
    args: [...family.rerunArgs],
  };
  return {
    correction: [{
      operation: operationForRule(ruleId),
      target: `the concrete field, path, or artifact named by ${ruleId} observed evidence`,
      expected,
    }],
    verification: [{ ...verification, expected }],
    rerun,
    rerunPurpose: family.rerunPurpose,
    sourceRefs: [family.sourceRef],
  };
}

const RULE_EVIDENCE_STATE: Record<keyof typeof RULE_GUIDANCE, EvidenceState> = {
  'boundary.action-identity-unproven': 'absent',
  'boundary.contract-invalid': 'invalid',
  'boundary.evidence-incomplete': 'unavailable',
  'boundary.evidence-volume-exceeded': 'invalid',
  'boundary.finding-identity-conflict': 'invalid',
  'boundary.artifact-identity-conflict': 'invalid',
  'boundary.timeout': 'unavailable',
  'semantic.production-reachability': 'observed',
  'semantic.export-ownership': 'observed',
  'semantic.unresolved-runtime-edge': 'observed',
  'semantic.invalid-allowlist': 'invalid',
  'semantic.candidate-unavailable': 'unavailable',
  'semantic.policy-unavailable': 'unavailable',
  'semantic.source-tree-unavailable': 'unavailable',
  'semantic.analysis-unavailable': 'unavailable',
  'semantic.invocation-invalid': 'invalid',
  'semantic.receipt-write-failed': 'unavailable',
  'semantic.guard-negative-control': 'absent',
  'supply-chain.mutable-action': 'observed',
  'supply-chain.mutable-image': 'observed',
  'supply-chain.floating-runner': 'observed',
  'process.unbounded-primitive': 'observed',
  'history.evidence-incomplete': 'unavailable',
  'history.exact-open-pr': 'observed',
  'history.exact-merged-pr': 'observed',
  'history.exact-closed-pr': 'observed',
  'history.renamed-patch-closed-pr': 'observed',
  'history.blob-subset': 'observed',
  'history.path-overlap': 'observed',
  'history.exact-issue': 'observed',
  'history.incomplete-reentry': 'absent',
  'provenance.unavailable': 'unavailable',
  'provenance.stale-tracking-ref': 'stale',
  'provenance.stale-overlap': 'stale',
  'provenance.stale-disjoint': 'stale',
};
```

This is the authoritative generated execution mapping; there is no 34-entry implementation blank.
Contract/CLI/semantic rules rerun the integration boundary action, while history, provenance, and
evaluator rules rerun their exact focused family because the semantic CLI does not collect those
providers. The renderer labels each command `integration boundary rerun` or `focused family replay`
from that family classification and never implies the latter retried an external PR/issue action.
The catalog test proves every rule maps to one existing test file and source file, every package
script/wrapper exists, the evidence-state key set equals the invariant key set, and every generated
command is pinned/non-vague. Producer-supplied attempts to override catalog guidance are rejected.

Do not add a generic fallback. Export:

```ts
export function guidanceForRule(ruleId: string): BoundaryRuleGuidance {
  const invariant = RULE_GUIDANCE[ruleId];
  if (!invariant) throw new Error(`unregistered boundary rule: ${ruleId}`);
  const execution = executionForRule(ruleId, invariant.expected[0]!);
  return structuredClone({
    ruleVersion: invariant.ruleVersion,
    expected: invariant.expected,
    impact: invariant.impact,
    safeControls: invariant.safeControls,
    correction: execution.correction,
    verification: execution.verification.map((step) => ({
      ...step,
      expected: invariant.verificationExpected,
    })),
    rerun: execution.rerun,
    rerunPurpose: execution.rerunPurpose,
    sourceRefs: execution.sourceRefs,
  });
}

export function evidenceStateForRule(ruleId: string): EvidenceState {
  if (!(ruleId in RULE_EVIDENCE_STATE)) throw new Error(`unregistered boundary rule: ${ruleId}`);
  return RULE_EVIDENCE_STATE[ruleId as keyof typeof RULE_EVIDENCE_STATE];
}

export function catalogRuleIds(): string[] {
  return Object.keys(RULE_GUIDANCE).sort();
}

export function ruleCatalogDigestSha256(): string {
  const canonical = Object.fromEntries(
    Object.keys(RULE_GUIDANCE).sort().map((ruleId) => [ruleId, guidanceForRule(ruleId)]),
  );
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
```

- [ ] **Step 5: Run catalog tests and script typecheck GREEN**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/semantic-rule-guidance.test.ts \
  --pool=forks --fileParallelism=false
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
```

Expected: catalog test passes; typecheck exits zero.

- [ ] **Step 6: Commit Task 2**

```bash
git add scripts/lib/semantic-quality/rule-guidance.ts \
  scripts/lib/semantic-quality/boundary-types.ts \
  scripts/lib/semantic-quality/boundary-contract.ts \
  tests/scripts/semantic-rule-guidance.test.ts \
  tests/scripts/semantic-boundary-contract.test.ts
bash scripts/run-with-pinned-node.sh scripts/verify-boundary-run.ts record-git-transition \
  --run-dir "$BCF_TASK_RUN_DIR" --attempt catalog-commit-transition --kind commit \
  --expect-before "$BCF_TASK_ENTRY_HEAD" \
  --message-subject "feat(quality): add boundary rule guidance catalog"
```

---

### Task 3: Add runtime contract validation and canonical finding identity

**Files:**
- Modify: `scripts/lib/semantic-quality/boundary-types.ts`
- Modify Task 2 scaffold: `scripts/lib/semantic-quality/boundary-contract.ts`
- Modify Task 2 scaffold: `tests/scripts/semantic-boundary-contract.test.ts`

**Interfaces:**
- Consumes: Task 2 `guidanceForRule()`, existing secret scanner, Git OID conventions.
- Produces: the `boundary-contract.ts` interfaces listed above for Task 4.

- [ ] **Step 1: Write failing unsafe and neighboring-safe contract tests**

Create tests that pass values through `canonicalBoundaryFinding()`:

```ts
const VALID_FINDING: BoundaryFindingInput = {
  ruleId: 'semantic.production-reachability',
  decision: 'block',
  action: 'push',
  evidenceState: evidenceStateForRule('semantic.production-reachability'),
  summary: 'A production module is unreachable from the runtime entry graph.',
  why: 'Unreachable production behavior cannot satisfy its claimed runtime contract.',
  observed: [{ label: 'module', value: 'src/example.ts' }],
  matchedArtifacts: [{
    kind: 'path', repository: 'LucasQuiles/WhatSoup', id: 'src/example.ts',
  }],
  limitations: [],
};

it.each([
  ['pass decision', { decision: 'pass' }],
  ['unknown decision', { decision: 'allow' }],
  ['unknown action', { action: 'deploy' }],
  ['blank rule', { ruleId: '   ' }],
  ['blank observed label', { observed: [{ label: ' ', value: 'unsafe' }] }],
  ['blank observed value', { observed: [{ label: 'state', value: ' ' }] }],
  ['producer correction override', { correction: ['fix it'] }],
  ['producer rerun override', { rerun: 'npm test' }],
  ['producer source override', { sourceRefs: ['x'] }],
] as const)('rejects %s after canonicalization', (_name, overrides) => {
  expect(() => canonicalBoundaryFinding({ ...VALID_FINDING, ...overrides } as never))
    .toThrow(BoundaryContractError);
});

it('accepts the complete neighboring finding', () => {
  expect(canonicalBoundaryFinding(VALID_FINDING)).toMatchObject({
    ruleId: VALID_FINDING.ruleId,
    decision: 'block',
    ruleVersion: 1,
    evidenceState: 'observed',
    findingDigestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
});
```

Add target tests for invalid repository, blank action target, invalid repository-action heads, valid
lowercase 40- and 64-hex heads for commit/push/open-pr/reopen-pr/update-pr/open-issue/merge/tag/release,
uppercase/wrong-width rejections, and every exact
action-target grammar above. Include two different refs, PR numbers, tag refs, and release tag refs
at the same head and require distinct target/evidence identities; include malformed/full-ref
neighbors, the open-issue task fingerprint target, and the config-write resolved-target digest. Add
quoted/assigned/parenthesized/`file:` local path tests and existing secret/query controls.
Add `canonicalEnforcementMode('audit')` and `canonicalEnforcementMode(null)` rejections beside
`shadow`/`enforce` controls. Unknown object keys are contract errors, so a producer cannot override
catalog-owned correction, verification, rerun, or sources with structurally nonblank but vague text.

- [ ] **Step 2: Run the contract test and capture RED**

Expand the Task 2 test scaffold with the Step 1 behavioral tests. The existing compile-only module
still throws `boundary contract not implemented`; it must typecheck and contains no accepted
canonicalization behavior.

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/semantic-boundary-contract.test.ts \
  --pool=forks --fileParallelism=false
```

Expected: the test imports the module, reaches `canonicalBoundaryFinding()`, and fails on the
explicit not-implemented behavior. Missing import/module, syntax/type error, zero tests, or unrelated
failure is Inconclusive.

- [ ] **Step 3: Complete and verify the split input/canonical types**

In `boundary-types.ts`, preserve the exact existing shape as `BoundaryFindingV1`—including the
absence of a `limitations` field—and retain
`type BoundaryFinding = BoundaryFindingV1` for stored/source compatibility. Add the distinct
guidance-free `BoundaryFindingInput`, `CanonicalBoundaryFinding`, `BoundaryTarget`, and
`FindingDecision` exactly as shown in Required Interfaces; reuse the guidance types and
`EvidenceState` already introduced by Task 2. Task 3 tests only the new contract;
it does not retag legacy findings or change current producers. Task 4 migrates every named producer
and builder atomically while the schema-1 reader continues to return `BoundaryFindingV1`.

- [ ] **Step 4: Implement post-canonical runtime validation**

Create `boundary-contract.ts`. Use explicit sets and SHA-256 over fixed-key JSON:

```ts
const FINDING_DECISIONS = new Set(['warn', 'block', 'inconclusive']);
const ACTIONS = new Set([
  'commit', 'push', 'open-pr', 'reopen-pr', 'update-pr', 'open-issue',
  'merge', 'tag', 'release', 'config-write',
]);
const GIT_OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const LOCAL_PATH_RE =
  /(?:^|[\s'"=([{,:;])\/(?:Users|home|private|tmp|var\/folders)\/[^\s'"\])},;]+/;
const FILE_URL_RE = /(?:^|[\s'"=([{,:;])file:\/\/\/[^\s'"\])},;]+/i;

function redactBoundaryText(value: string): string {
  try {
    assertNoSecretLike(value, 'boundary public text');
  } catch {
    return 'redacted-sensitive-value';
  }
  if (FILE_URL_RE.test(value) || LOCAL_PATH_RE.test(value)) return 'redacted-local-reference';
  if (hasCredentialOrQueryUrl(value)) return 'redacted-credential-url';
  return value;
}

function requiredText(value: unknown, fieldPath: string, budgets: BoundaryBudgets): string {
  if (typeof value !== 'string') throw contractInvalid(fieldPath);
  const inputMeasure = measureBoundedUtf8(value, budgets.maxPublicTextBytes);
  if (!inputMeasure.withinBudget) {
    throw volumeExceeded(fieldPath, boundedScalarDescriptor(fieldPath, value.length));
  }
  const canonical = redactBoundaryText(value)
    .replace(/[\u0000-\u001f\u007f\u001b]+/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!canonical) throw contractInvalid(fieldPath);
  const canonicalMeasure = measureBoundedUtf8(canonical, budgets.maxPublicTextBytes);
  if (!canonicalMeasure.withinBudget) {
    throw volumeExceeded(fieldPath, boundedScalarDescriptor(fieldPath, canonical.length));
  }
  return canonical;
}
```

`redactBoundaryText()` is owned only by `boundary-contract.ts`; `receipt.ts` deletes its divergent
pre-truncation sanitizer and calls this owner. It reuses `assertNoSecretLike()` as the secret
detector, replacing the entire scalar with the fixed marker on detection. It replaces an entire
local/`file:` reference or credential/query URL scalar with its fixed marker rather than attempting
partial preservation. `hasCredentialOrQueryUrl()` parses URL candidates and is covered for
username/password/query variants. After replacement/canonicalization, call `assertNoSecretLike()`
again and assert neither local-path nor `file:` regex matches. No rejected raw scalar appears in a
typed issue, digest descriptor, log, or error message.

Admission order is exact: validate container/object keys and scalar type; validate array length;
measure original UTF-8 bytes with a bounded probe; redact; whitespace-canonicalize; require nonblank;
measure canonical UTF-8 bytes with the same bounded probe; only then append to a canonical array or
hash. `measureBoundedUtf8()` uses `TextEncoder.encodeInto()` with a fixed
`maxPublicTextBytes + 1` buffer and reports in-budget only when the entire scalar was read and no more
than the budget was written. On overflow it does not continue scanning the tail.
`boundedScalarDescriptor()` is content-independent: it contains only the sanitized field-path class,
scalar type, UTF-16 code-unit count, applicable limit, and rejection reason. It never retains or
hashes a raw prefix, total UTF-8 bytes, normalized rejected text, secret, or local reference;
`rejectedBytes` is therefore `null` for this case. Rejection allocates bounded new memory.

Validate every array element, artifact enum/identity, fingerprint, decision, and action. Call
`guidanceForRule()`. Before digesting, canonicalize any finding with nonempty finding-level
limitations to effective decision `inconclusive`, without adding an observation or other record;
this is the Task 3 contract owner for relevant-evidence certainty. Compute `findingDigestSha256`
from rule ID/version, action, effective decision,
evidence state, observed evidence, matched artifact identities, and limitations; exclude summary
prose and corrections from the evidence identity.

- [ ] **Step 5: Add explicit default budgets and boundary assertions**

Use:

```ts
export const DEFAULT_BOUNDARY_BUDGETS = Object.freeze({
  maxFindings: 128,
  maxObservedPerFinding: 64,
  maxArtifactsPerFinding: 16,
  maxLimitationsPerFinding: 8,
  maxTopLevelLimitations: 16,
  maxFingerprints: 64,
  maxCanonicalRecords: 2_048,
  maxCorrectionsPerFinding: 4,
  maxVerificationPerFinding: 8,
  maxSourcesPerFinding: 16,
  maxPublicTextBytes: 512,
  maxJsonBytes: 1024 * 1024,
  maxHumanBytes: 64 * 1024,
  maxHumanReservedSummaryBytes: 16 * 1024,
  maxHumanDetailedFindings: 12,
});
```

Before constructing canonical arrays or strings, read only top-level array lengths and at most the
declared number of finding records. Reject one-over-limit findings, observations, artifacts,
per-finding/top-level limitations, fingerprints, catalog corrections/verifications/sources, public
UTF-8 text bytes, or total canonical records with `BoundaryContractError` code
`boundary.evidence-volume-exceeded`. At-limit inputs remain valid. A rejected input gets a bounded
structural descriptor containing counts, types, and at most the first 256 content-independent scalar
descriptors; it never hashes a rejected scalar prefix, concatenates, or canonicalizes the full
rejected payload. The JSON byte assertion runs only
after bounded canonical receipt construction in Task 4.

Compute `canonicalRecords` before allocation with overflow-safe addition: top-level limitations +
fingerprint entries +, for each finding, `1 + observed + artifacts + finding limitations + catalog
corrections + catalog verifications + catalog sources`. Artifact fields and observation label/value
count as their enclosing record, not extra records. Tests identify the exact addition that crosses
2,048 and verify byte admission occurs both before and after redaction/canonicalization.

- [ ] **Step 6: Run contract tests and typecheck GREEN**

Run the Step 2 command and `bash scripts/run-with-pinned-npm.sh run typecheck:scripts`. Expected:
tests pass and typecheck exits zero.

- [ ] **Step 7: Commit Task 3**

```bash
git add scripts/lib/semantic-quality/boundary-types.ts \
  scripts/lib/semantic-quality/boundary-contract.ts \
  tests/scripts/semantic-boundary-contract.test.ts
bash scripts/run-with-pinned-node.sh scripts/verify-boundary-run.ts record-git-transition \
  --run-dir "$BCF_TASK_RUN_DIR" --attempt contract-commit-transition --kind commit \
  --expect-before "$BCF_TASK_ENTRY_HEAD" \
  --message-subject "feat(quality): validate boundary runtime contracts"
```

---

### Task 4: Emit schema-2 evidence-bound receipts

**Files:**
- Modify: `scripts/lib/semantic-quality/receipt.ts:23-425`
- Modify: `scripts/lib/semantic-quality/policy.ts` finding adapters only
- Modify: `scripts/lib/semantic-quality/history.ts` finding adapters only
- Modify: `scripts/lib/semantic-quality/provenance.ts` finding adapters only
- Modify: `scripts/semantic-quality-check.ts` diagnostic adapter only
- Modify: `scripts/experiments/semantic-boundary-eval.ts` finding adapters only
- Modify: `tests/scripts/semantic-quality-check.test.ts` receipt describe blocks
- Modify: `tests/scripts/semantic-quality-policy.test.ts`
- Modify: `tests/scripts/semantic-history.test.ts`
- Modify: `tests/scripts/semantic-provenance.test.ts`
- Modify: `tests/scripts/semantic-boundary-eval.test.ts`
- Modify: `tests/scripts/semantic-boundary-contract.test.ts`

**Interfaces:**
- Consumes: Tasks 2–3 canonical findings, catalog digest, target, limitations, and budgets.
- Produces: schema-2 builders, `evidenceDigestSha256`, schema-1 read compatibility, deterministic
  ordering, and honest decision aggregation.

- [ ] **Step 0: Resolve consumer and version disposition before changing the producer**

Run `receipt-producer-scan`; it executes A-01's exact direct inventory argv, classifies every match,
and derives/registers the closed `ConsumerVersionDecision` with package `0.1.0`, current schema 1,
proposed schema 2, beta/shadow-only composition, all named local producer/reader/test/documentation
consumers, external consumers `unknown`, compatibility reader, the verified BCF-03 terminal head as
rollback commit, and the fixed pre-1.0 decision. No caller-written version decision is accepted.
Apply the exact supported-public-producer definition in Documentation and DevOps Readiness. If a named
external consumer, stable surface, or published compatibility commitment is found, stop before Task
4 code and require the separate approved version/release-note change. Otherwise
record the explicit pre-1.0 shadow decision and continue; BCF-08A later publishes the same decision,
not a new one.

- [ ] **Step 1: Add failing schema, identity, limitation, and ordering tests**

Add tests for:

```ts
it('makes warning plus limitation inconclusive in enforce mode', () => {
  const built = buildBoundaryReceipt({
    ...VALID_RECEIPT_INPUT,
    findings: [genericFinding('push', { decision: 'warn' })],
    limitations: ['history page 2 timed out'],
  });
  expect(built.decision).toBe('inconclusive');
  expect(semanticExitCode(built)).toBe(2);
});

it.each(['warn', 'block', 'inconclusive'] as const)(
  'does not retain %s certainty when that finding has incomplete evidence',
  (decision) => {
    const built = buildBoundaryReceipt({
      ...VALID_RECEIPT_INPUT,
      findings: [genericFinding('push', {
        decision,
        limitations: ['the finding-specific comparison page was unavailable'],
      })],
    });
    expect(built.findings[0]?.decision).toBe('inconclusive');
    expect(built.decision).toBe('inconclusive');
  },
);

it('changes evidence digest for evidence but not summary prose', () => {
  const baseline = buildBoundaryReceipt(VALID_RECEIPT_INPUT);
  const changedEvidence = buildBoundaryReceipt({
    ...VALID_RECEIPT_INPUT,
    limitations: ['different limitation'],
  });
  const changedSummary = buildBoundaryReceipt({
    ...VALID_RECEIPT_INPUT,
    findings: [genericFinding('push', { summary: 'different explanation' })],
  });
  expect(changedEvidence.evidenceDigestSha256).not.toBe(baseline.evidenceDigestSha256);
  expect(changedSummary.evidenceDigestSha256).toBe(baseline.evidenceDigestSha256);
});

it('is byte-stable when distinct findings are reversed', () => {
  const forward = buildBoundaryReceipt({ ...VALID_RECEIPT_INPUT, findings: [FIRST, SECOND] });
  const reverse = buildBoundaryReceipt({ ...VALID_RECEIPT_INPUT, findings: [SECOND, FIRST] });
  expect(JSON.stringify(reverse)).toBe(JSON.stringify(forward));
});

it('rejects exact duplicate finding identities', () => {
  expect(() => buildBoundaryReceipt({
    ...VALID_RECEIPT_INPUT,
    findings: [FIRST, structuredClone(FIRST)],
  })).toThrow(/finding identity conflict/i);
});
```

Add one-field digest invalidation cases for target, head, `observedAt`, rule version, and observed
value. Add exact-duplicate and same-key/conflicting-state matched-artifact cases; reverse both input
orders and require `boundary.artifact-identity-conflict`, while distinct artifact keys remain
byte-stable. Call `buildBoundaryReceipt()` at runtime with `enforcementMode: 'audit' as never` and
require `BoundaryContractError`; the CLI neighbor must turn that exact error into an enforce-mode
diagnostic receipt and exit 2. Retain the existing schema-1 literal test.

- [ ] **Step 2: Run receipt/contract tests and capture RED**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/semantic-boundary-contract.test.ts \
  tests/scripts/semantic-quality-check.test.ts \
  --pool=forks --fileParallelism=false
```

Expected: schema remains 1, warning plus limitation remains warn, and no evidence digest exists.

- [ ] **Step 3: Define schema-1/v2 receipt types and build input**

Keep schema-1 fields unchanged. Define schema 2 with exact fields:

```ts
export interface BoundaryReceiptV2 {
  schemaVersion: 2;
  repository: 'LucasQuiles/WhatSoup';
  invocation: string;
  action: BoundaryAction;
  target: BoundaryTarget;
  observedAt: string;
  validUntil: string | null;
  correlationIdSha256: string;
  ruleCatalogDigestSha256: string;
  evidenceDigestSha256: string;
  enforcementMode: EnforcementMode;
  decision: BoundaryDecision;
  base: BoundaryReceiptBase;
  fingerprints: Record<string, string | null>;
  findings: CanonicalBoundaryFinding[];
  limitations: string[];
  overflow: null | BoundaryOverflow;
}
```

Implement `parseBoundaryReceipt(input: unknown)` as the only stored-JSON reader. It validates a
parsed object, discriminates schema 1 versus 2, and applies a closed schema-specific validator:
exact required/optional keys, nested object/array shapes, runtime enums, identities, public-text
byte bounds, array/record bounds, and secret/local-path/control-character rejection. It rejects
unknown schema versions, extra/missing keys, and unsafe stored evidence, and never fabricates
schema-2 target/evidence fields for schema 1. Schema 1 uses its exact legacy finding shape with no
finding-level `limitations` and accepts only the five `BoundaryActionV1` values; a schema-1 fixture
using `update-pr`, `merge`, `tag`, `release`, or `config-write` is rejected. Schema 2 accepts exactly
the ten `BoundaryAction` values. The compatibility test must
`JSON.parse()` a frozen schema-1 string, pass the unknown value through this reader, render the
returned receipt, and assert the existing schema-1 decision/fields plus the explicit legacy label.
A TypeScript literal assigned directly to `BoundaryReceiptV1` is not read-compatibility evidence.
Add malicious schema-1 and schema-2 fixtures for every extra/missing key class, malformed nested
record, enum, over-budget array/text, secret/query URL, local/`file:` path, ANSI/control character,
all five schema-2-only actions under schema 1, all ten actions under schema 2, an unknown `deploy`
action, and the nearest safe value. A rejected stored receipt raises the typed contract error; it is never
partially sanitized into a different historical receipt.

Migrate every current producer named in Task 2's inspected inventory from legacy
`BoundaryFindingV1` construction to guidance-free `BoundaryFindingInput`: producers retain only
rule/decision/action/evidence state/summary/why/observations/artifacts/limitations. Rule version,
expected/impact/safe control/correction/verification/rerun/sources come only from the catalog. Use
`evidenceStateForRule(ruleId)` unless a contract-only diagnostic supplies the same cataloged value;
tests assert all 35 mappings. Do not alter semantic/history/provenance decisions or observed facts.
The schema-1 parser still returns the untouched legacy correction/rerun/source fields from stored
JSON; only current schema-2 production uses catalog guidance.

Extend `BuildBoundaryReceiptInput` with required `target`, `observedAt`, and optional `validUntil`.
`buildSemanticReceipt()` supplies target repository `LucasQuiles/WhatSoup` and an injected
observation time. Add `now?: Date` plus required `targetRef: string | null` to
`BuildSemanticReceiptInput`; the CLI uses the singular `--target-ref` value when present, otherwise
resolves `git symbolic-ref --quiet HEAD` through the existing clean Git execution boundary, and
supplies `actionTarget: ref:<targetRef>`. It never reads a CI/environment ref fallback.
Detached/unresolvable destination state supplies `targetRef: null` and
produces the reserved private diagnostic target plus `boundary.action-identity-unproven`; it cannot
reuse the candidate OID as the mutation target. Tests do not use ambient time or ambient branch
state.

Runtime time syntax is closed and separate from deferred freshness policy. Reuse the exported,
rollover-safe `isValidHistoryTimestamp()` from `history-provider.ts` for RFC3339 syntax and offset
bounds; do not add a second timestamp parser. Accept strings
with an explicit `Z` or numeric offset only when that helper passes; canonicalize with
`new Date(value).toISOString()`. Reject nonexistent/rollover dates by round-tripping parsed calendar
fields, reject `validUntil < observedAt`, and digest only canonical UTC strings. At least one `Z`,
positive-offset, negative-offset, invalid-date, missing-zone, and reverse-interval test is required.

Inventory every production and test call site before changing the signature:

```bash
rg -n "buildBoundaryReceipt\(|buildSemanticReceipt\(" scripts tests --glob '*.ts'
```

Update every reported call site in the same task. Git-bound fixtures cover exact lowercase 40- and
64-hex heads as candidate identities and the independently supplied action-specific target: commit OID, push
ref, PR-create base/head refs, existing PR number, tag ref, or release tag ref. At least two
same-head/different-target fixtures per target family prove that target and candidate identities do
not collapse. Open-issue fixtures provide a 64-hex `task_fingerprint_sha256` and an `actionTarget`
constructed as `` `task:${taskFingerprintSha256}` ``. Config-write fixtures require a separately
resolved 64-hex target-configuration digest and `actionTarget: config:<digest>`; `headOid` may be
null only for that non-Git target. Do not add a compatibility overload that fabricates target or
observation identity.

- [ ] **Step 4: Implement evidence-aware aggregation and canonical sorting**

Before the aggregate call, require Task 3's already-canonical evidence certainty. A nonempty
finding-level `limitations` array is the explicit signal that the limitation is relevant to that
finding; assert its canonical decision is `inconclusive` before sorting or aggregation, even when
the producer input supplied `warn` or `block`. Do not synthesize an observation or other record for the superseded claimed
decision; the input is not authoritative evidence and adding a record would violate at-limit
cardinality. A top-level limitation remains collection-wide; it
cannot weaken a separately complete block. Replace the current aggregate call with:

```ts
export function aggregateBoundaryDecision(
  findings: ReadonlyArray<{ decision: BoundaryDecision }>,
  limitations: ReadonlyArray<string> = [],
): BoundaryDecision {
  if (findings.some((finding) => finding.decision === 'block')) return 'block';
  if (limitations.length > 0) return 'inconclusive';
  if (findings.some((finding) => finding.decision === 'inconclusive')) return 'inconclusive';
  if (findings.some((finding) => finding.decision === 'warn')) return 'warn';
  return 'pass';
}
```

Canonicalize findings before aggregation. Sort by `ruleId`, then `findingDigestSha256`. Reject an
exact repeated `(ruleId, findingDigestSha256)` pair. Within a finding, sort artifacts by
`kind/repository/id`; reject any repeated artifact key, whether byte-identical or conflicting, with
`boundary.artifact-identity-conflict`. Build `evidenceDigestSha256` from fixed-key JSON
containing schema version, target, observation time/validity, base identities, fingerprints,
canonical limitations, rule catalog digest, and finding evidence identities.

Add neighboring tests for: a complete block plus an unrelated top-level limitation remains block;
a block with its own limitation becomes inconclusive; a warning with its own limitation becomes
inconclusive; an already-inconclusive limited finding stays inconclusive; and an empty
finding-level limitation preserves the complete finding's declared decision.
The limited neighbor with exactly 64 existing observations must remain valid and inconclusive
without gaining a sixty-fifth record.

- [ ] **Step 5: Add action-identity fail-closed synthesis**

Before a pass is finalized, require a valid head for
commit/push/open-pr/reopen-pr/update-pr/open-issue/merge/tag/release. The routing split
is closed: a present non-null malformed head is rejected during Task 3 canonical target validation
as typed `boundary.contract-invalid`; only a canonical `null`/absent required head reaches this step
and synthesizes `boundary.action-identity-unproven`. For that absent case append the canonical finding with observed target/head,
decision `inconclusive`, and source `boundary-contract:action-identity`. Open-issue action identity
requires a 64-hex `task_fingerprint_sha256` entry. Config-write requires the resolved
`config:<64-hex-digest>` target and permits null head only for that action. Do not throw away other
valid findings. Independently require the exact target grammar associated with the action; a valid
head with the wrong/missing ref, PR, tag, release, task, or config identity is contract-invalid and
never falls back to `candidate:<head>`.

Before aggregation, nonempty top-level limitations synthesize exactly one canonical
`boundary.evidence-incomplete` finding when that rule is not already present. Its evidence state is
`unavailable`; observed records contain only limitation count and the canonical limitation digest;
the catalog supplies all guidance and sources. If a producer already emitted that rule, merge the
top-level limitation count/digest into its observations and reject a conflicting duplicate identity.
This gives limitations-only receipts the same actionable renderer path without copying raw
limitations into correction text.

Add separate malformed-non-null and canonical-null head tests and assert their exact distinct rule
IDs, catalog guidance, evidence digests, and exit 2; neither route may fall through to the other.

- [ ] **Step 6: Map known contract failures to fixed diagnostic receipts**

Direct library validation continues to throw `BoundaryContractError`. The CLI/evaluator outer
boundary catches an unknown value and passes it as the separate first argument to
`buildBoundaryDiagnosticReceipt()` with already validated fallback
action/mode/target/observation/base/fingerprint/limitation context. That function performs the
module-private issuer-brand check; forged `BoundaryContractError` structures/instances/subclasses
and foreign errors throw and are never mapped. Invalid CLI identity never reuses raw argv values:
action is `push`, target is repository plus the reserved diagnostic-only
`actionTarget: 'unresolved:push'` and `headOid: null`, observation is the injected canonical
clock, base OIDs are null with evidence source `semantic-quality-cli:invalid-invocation`,
fingerprints are empty, and mode is `enforce`. Map typed `BoundaryContractIssue` values as follows;
never parse `Error.message`:

| Contract code | Diagnostic rule | Safe payload |
|---|---|---|
| invalid enum/key/text/target | `boundary.contract-invalid` | code plus sanitized field path |
| repeated finding key | `boundary.finding-identity-conflict` | rule ID plus bounded duplicate count/digest |
| repeated artifact key | `boundary.artifact-identity-conflict` | artifact kind/repository/ID plus bounded state digests |
| budget/admission overflow | `boundary.evidence-volume-exceeded` | bounded structural descriptor only |

The fixed helper obtains correction/verification/rerun/sources from the catalog, retains no invalid
caller guidance or raw rejected payload, emits schema 2 with decision `inconclusive`, and exits 2 in
enforce mode. `unresolved:<action>` is valid only on a stored or private-built diagnostic receipt
that contains the matching identity-unproven/contract-invalid finding; public producer input cannot
select it. Unknown programmer exceptions are not converted to these receipts. Add CLI and
evaluator tests for every mapping plus the valid neighboring receipt, structural lookalike,
public-constructor attempt, subclass, foreign-realm error, caller getter throw, and a genuine
module-issued error. For the genuine control, catch one issued overflow error, attempt replacement
of its public `issues`/`overflow`, nested count/digest mutation, array mutation, and prototype
mutation using runtime casts/reflection. Frozen-field mutations must throw or leave the builder's
WeakMap-derived receipt byte-identical to the pre-mutation control; prototype mutation must be
rejected. A mutated public copy must never change counts, descriptor digest, or coverage.

- [ ] **Step 7: Run receipt/contract tests GREEN and typecheck**

Run the Step 2 command plus `bash scripts/run-with-pinned-npm.sh run typecheck:scripts`. Expected:
all pass.

- [ ] **Step 8: Commit Task 4**

```bash
git add scripts/lib/semantic-quality/receipt.ts \
  scripts/lib/semantic-quality/policy.ts \
  scripts/lib/semantic-quality/history.ts \
  scripts/lib/semantic-quality/provenance.ts \
  scripts/semantic-quality-check.ts \
  scripts/experiments/semantic-boundary-eval.ts \
  tests/scripts/semantic-boundary-contract.test.ts \
  tests/scripts/semantic-quality-check.test.ts \
  tests/scripts/semantic-quality-policy.test.ts \
  tests/scripts/semantic-history.test.ts \
  tests/scripts/semantic-provenance.test.ts \
  tests/scripts/semantic-boundary-eval.test.ts
bash scripts/run-with-pinned-node.sh scripts/verify-boundary-run.ts record-command \
  --run-dir "$BCF_TASK_RUN_DIR" --attempt receipt-staged-scope --expect-exit 0 -- \
  git diff --cached --name-only
bash scripts/run-with-pinned-node.sh scripts/verify-boundary-run.ts verify \
  --run-dir "$BCF_TASK_RUN_DIR" --expect-staged-allowlist
bash scripts/run-with-pinned-node.sh scripts/verify-boundary-run.ts record-git-transition \
  --run-dir "$BCF_TASK_RUN_DIR" --attempt receipt-commit-transition --kind commit \
  --expect-before "$BCF_TASK_ENTRY_HEAD" \
  --message-subject "feat(quality): bind boundary receipts to evidence"
```

The `receipt-staged-scope` stdout predicate requires the sorted exact 12-path profile allowlist;
the helper-owned stdout is the staged-path receipt. No redirected count file or outer-shell status
can substitute for `verify --expect-staged-allowlist`.

---

### Task 5: Render bounded, complete, action-specific guidance

**Files:**
- Modify: `scripts/lib/semantic-quality/receipt.ts:427-473`
- Modify: `tests/scripts/semantic-quality-check.test.ts`
- Modify: `tests/scripts/semantic-boundary-contract.test.ts`

**Interfaces:**
- Consumes: Task 4 schema-2 canonical findings and budgets.
- Produces: `renderBoundaryReceipt()`, compatibility alias `renderSemanticReceipt`, bounded human
  grouping, visible limitations, and generic action-specific pass output.

- [ ] **Step 1: Add failing renderer sequence and budget tests**

Assert this exact section order for warn/block/inconclusive:

```ts
const labels = [
  'Observed:',
  'Expected invariant:',
  'Why this matters:',
  'Safe control:',
  'Correction:',
  'Verification:',
  'Rerun:',
  'Sources:',
  'Limitations:',
  'Receipt evidence:',
];
for (const label of labels) {
  expect(output).toContain(label);
  expect(output.indexOf(label)).toBeGreaterThanOrEqual(0);
}
for (let index = 1; index < labels.length; index += 1) {
  expect(output.indexOf(labels[index]!)).toBeGreaterThan(output.indexOf(labels[index - 1]!));
}
```

Run that complete presence/order assertion separately for a warning, a block, and an inconclusive
receipt so one decision's renderer cannot stand in for the other two. Add:

- warning plus limitation contains the limitation;
- block plus unrelated limitation retains block and contains the limitation;
- limitations-only output contains why, correction, verification, rerun, source, and digest;
- generic `boundary-history` pass says `PASS boundary-history while open-pr`, not semantic quality;
- 45 findings group repeated guidance and stay below 64 KiB;
- at most 12 detailed findings render, and the summary names omitted count/digest;
- maximum-byte ASCII and multibyte public values across observations, limitations, corrections,
  verification, and sources still stay within 64 KiB; exact at-limit values pass and a one-byte
  public value overflow becomes the fixed diagnostic receipt;
- when fewer than 12 groups or fewer than all observations fit the byte budget, the human output
  names rendered/omitted finding and observation counts plus the digest of evidence retained in
  JSON;
- at-limit JSON passes; one-over-limit produces a bounded evidence-volume inconclusive receipt;
- no human output exceeds `maxHumanBytes` including the final newline.

The `[BCF05-*]` GREEN tests compute the ordinary, at-limit, one-over, multibyte, detailed-count,
omitted-count, JSON-byte, human-byte, and descriptor-digest measurements independently of production
budget counters. On `feedback-green` only, the helper exclusively creates the predeclared ignored
artifact `feedback-measurements.json` and passes its canonical path plus one-use token as
`BCF_MEASUREMENT_PATH`/`BCF_MEASUREMENT_TOKEN` through the exact pinned npm wrapper. The test opens
that existing non-symlink file without following links, verifies it is empty, and writes exactly one
closed `FeedbackMeasurements` object in the required six-scenario semantic order; the token itself
is used for the write handshake but only `tokenSha256` is serialized. After the child exits, the helper proves the same
device/inode/mode, fsyncs, parses it, and consumes the token. Only after the reporter predicate and
measurement schema both pass does the helper bind both artifact hashes under the same immutable
attempt record and register measurement path/hash/bytes with producer `feedback-green`. Missing,
duplicate, malformed,
foreign-token/attempt, caller-path, or post-close mutation is Fail. `feedback-budget` consumes only this
registered artifact; no console scraping or ambient output can satisfy it.

- [ ] **Step 2: Run receipt tests and capture RED**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/semantic-boundary-contract.test.ts \
  tests/scripts/semantic-quality-check.test.ts \
  --pool=forks --fileParallelism=false
```

Expected: missing sections, hidden limitations, generic pass label, or over-budget output fails.

- [ ] **Step 3: Implement one renderer and compatibility alias**

Rename the primary renderer to `renderBoundaryReceipt`. For each schema-2 finding render the exact
section sequence from Step 1. Render top-level limitations after every finding group. For schema-1,
retain current semantics but label the output `legacy receipt schema=1` and never infer v2 evidence
fields.

Group findings only when `ruleId`, `ruleVersion`, decision, expected, impact, safe controls,
correction, verification, rerun, rerun purpose, and limitations are identical. Under the `Rerun:`
section render purpose as `integration boundary` or `focused family replay` so a test replay is
never described as retrying an external action. Preserve each grouped finding's
observed values and artifact identities in JSON. Human grouping reports the group count and lists
bounded distinct observations.

Use a UTF-8 byte allocator, not character slicing:

1. render the action/decision header and reserve `maxHumanReservedSummaryBytes` for top-level
   limitations, omission counts/digest, receipt evidence, and the final newline;
2. sort groups and observations canonically; before appending a complete labeled section, check
   `Buffer.byteLength(candidate, 'utf8') + reservedFooterBytes <= maxHumanBytes`;
3. append only complete UTF-8 sections. When the next section does not fit, stop detailed rendering,
   count the omitted findings/observations, and retain their full evidence only in bounded JSON;
4. render the reserved footer with explicit rendered/omitted counts and `evidenceDigestSha256`;
5. assert the final newline-inclusive byte length is at most `maxHumanBytes`; a footer that cannot
   fit is a contract bug and must not be sliced or returned.

`maxHumanDetailedFindings` is a count ceiling, not a promise that 12 maximum-size findings fit. The
allocator may render fewer and must say why. Tests independently compute `Buffer.byteLength` and
exercise one-byte and one-multibyte-code-point boundaries.

Export:

```ts
export const renderSemanticReceipt = renderBoundaryReceipt;
```

- [ ] **Step 4: Add bounded overflow receipt construction**

Catch only `BoundaryContractError` with code `boundary.evidence-volume-exceeded` at the receipt
builder boundary. Construct the fallback through this fixed private helper; its numeric counts and
descriptor digest come only from the bounded typed issue created by admission, never from a public
build input or producer finding:

```ts
function volumeExceededFinding(
  action: BoundaryAction,
  overflow: BoundaryOverflow,
): BoundaryFindingInput {
  return {
    ruleId: 'boundary.evidence-volume-exceeded',
    decision: 'inconclusive',
    action,
    evidenceState: evidenceStateForRule('boundary.evidence-volume-exceeded'),
    summary: 'Boundary evidence exceeded the declared receipt budget.',
    why: 'Rejected evidence cannot be silently truncated or treated as a complete clean result.',
    observed: [
      { label: 'finding_count', value: String(overflow.inputCounts.findings) },
      { label: 'observation_count', value: String(overflow.inputCounts.observed) },
      { label: 'artifact_count', value: String(overflow.inputCounts.artifacts) },
      { label: 'rejected_bytes', value: String(overflow.rejectedBytes ?? 'not-materialized') },
      { label: 'descriptor_sha256', value: overflow.descriptorDigestSha256 },
      { label: 'digest_coverage', value: overflow.digestCoverage },
    ],
    matchedArtifacts: [],
    limitations: ['The rejected evidence was not admitted into the canonical receipt.'],
  };
}
```

Compute `descriptorDigestSha256` from fixed-key top-level counts/types and at most the first 256
content-independent bounded scalar descriptors; set `digestCoverage` honestly and never describe it
as a full rejected evidence digest. Do not hash a rejected scalar prefix. Populate `rejectedBytes`
only when the bounded serializer measured it without traversing an over-budget tail; otherwise use
`null`. Catalog guidance supplies correction, verification, rerun, and sources. Do not catch
programmer errors or unknown exceptions as volume errors. The overflow receipt decision is
`inconclusive`; enforce exit is 2 and shadow exit remains 0.
The same structural overflow under two targets has the same partial descriptor digest, while the two
outer receipt `evidenceDigestSha256` values differ; tests assert both facts so the descriptor is not
misrepresented as target/evidence identity.
Add explicit unknown-key tests showing a caller-supplied `overflow`, rejected counts, descriptor
digest, or digest-coverage value is rejected and cannot change the private derived receipt.

- [ ] **Step 5: Run renderer tests GREEN**

Run the Step 2 command. Expected: all pass, including exact byte and section-order assertions.

- [ ] **Step 6: Commit Task 5**

```bash
git add scripts/lib/semantic-quality/receipt.ts \
  tests/scripts/semantic-boundary-contract.test.ts \
  tests/scripts/semantic-quality-check.test.ts
bash scripts/run-with-pinned-node.sh scripts/verify-boundary-run.ts record-git-transition \
  --run-dir "$BCF_TASK_RUN_DIR" --attempt feedback-commit-transition --kind commit \
  --expect-before "$BCF_TASK_ENTRY_HEAD" \
  --message-subject "feat(quality): bound contextual boundary feedback"
```

---

### Task 6: Bound history-provider page settlement

**Files:**
- Modify: `scripts/lib/semantic-quality/history-provider.ts:32-40, 288-461`
- Modify: `tests/scripts/semantic-history-provider.test.ts`

**Interfaces:**
- Consumes: existing `HistoryProvider.readPage()` and optional external signal.
- Produces: `pageTimeoutMs` input, one internal controller per page, terminal
  `history.provider-timeout`, and `history.provider-late-work-unproven` limitation.

- [ ] **Step 1: Add four deterministic provider controls**

Use fake timers and deferred promises:

```ts
it('[BCF06-U01] settles when a provider ignores abort', async () => {
  vi.useFakeTimers();
  try {
    const never = new Promise<HistoryPage>(() => undefined);
    const pending = collectHistory({
      repository: REPOSITORY,
      provider: { readPage: () => never },
      pageTimeoutMs: 50,
    });
    let settled: HistoryCollection | null = null;
    let rejected: unknown = null;
    void pending.then(
      (value) => { settled = value; },
      (error) => { rejected = error; },
    );
    await vi.advanceTimersByTimeAsync(51);
    if (rejected) throw rejected;
    if (!settled) throw new Error('BCF_EXPECTATION_UNMET:BCF06-01');
    expect(settled).toMatchObject({
      complete: false,
      limitations: [
        expect.stringMatching(/^history\.provider-timeout:/),
        expect.stringMatching(/^history\.provider-late-work-unproven:/),
      ],
    });
  } finally {
    vi.useRealTimers();
  }
});
```

Add controls for resolve-before-deadline, provider-thrown `TimeoutError`, and provider honoring
abort. Assert no unhandled rejection after a late provider resolve/reject.

- [ ] **Step 2: Run provider tests and capture RED**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/semantic-history-provider.test.ts \
  --pool=forks --fileParallelism=false
```

Expected: ignore-abort case never settles under fake time or `pageTimeoutMs` is unknown.
The RED test never awaits the intentionally pending pre-fix promise: its attached handlers observe
any terminal result, fake time advances past the owned deadline, and an unsettled state throws the
exact sentinel. The unresolved provider promise owns no timer/socket/descriptor and is not an open
handle. Any production rejection escapes as Inconclusive rather than being rewritten as RED.

- [ ] **Step 3: Implement a bounded page-decision race**

Add `pageTimeoutMs?: number` to `CollectHistoryInput`, default 5,000 ms, positive safe integer only.
For each page, create an internal controller and forward an external abort into it. Race the
provider promise against a timer promise. Always attach fulfillment/rejection handlers to the
provider promise before racing so a late rejection is observed.

On timeout:

1. abort the internal controller;
2. append `history.provider-timeout`;
3. append `history.provider-late-work-unproven` because the provider did not settle by the deadline;
4. stop pagination and return without awaiting the provider again;
5. clear timer/listeners in `finally`.

Do not claim the underlying external work was canceled. That requires the later process-owned
adapter.

- [ ] **Step 4: Run provider tests GREEN and leak check**

Run the Step 2 command twice. Expected: both runs pass; Vitest reports no unhandled rejection or open
handle warning.

- [ ] **Step 5: Commit Task 6**

```bash
git add scripts/lib/semantic-quality/history-provider.ts \
  tests/scripts/semantic-history-provider.test.ts
bash scripts/run-with-pinned-node.sh scripts/verify-boundary-run.ts record-git-transition \
  --run-dir "$BCF_TASK_RUN_DIR" --attempt provider-commit-transition --kind commit \
  --expect-before "$BCF_TASK_ENTRY_HEAD" \
  --message-subject "fix(quality): bound history provider decisions"
```

---

### Task 7: Integrate schema 2 without duplicating the evaluator

**Files:**
- Modify: `scripts/semantic-quality-check.ts`
- Modify: `scripts/experiments/semantic-boundary-eval.ts`
- Modify: `tests/scripts/semantic-quality-check.test.ts`
- Modify: `tests/scripts/semantic-boundary-eval.test.ts`

**Interfaces:**
- Consumes: Tasks 1–6 builders/renderers and existing evaluator delegation.
- Produces: schema-2 CLI output, exact exit behavior, and unchanged per-case policy classifications.

- [ ] **Step 1: Add failing integration assertions**

For valid human and JSON CLI runs assert schema 2, target, observation, catalog/evidence digests,
complete finding guidance, and exact head. For invalid invocation assert exit 2 even with malformed
mode. Update evaluator tests to assert each intervention receipt has expected/control/verification
fields and still delegates to production functions.

- [ ] **Step 2: Run CLI/evaluator tests and capture RED**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/semantic-quality-check.test.ts \
  tests/scripts/semantic-boundary-eval.test.ts \
  --pool=forks --fileParallelism=false
```

Expected: at least schema/guidance assertions fail before integration.

- [ ] **Step 3: Update CLI emission and receipt-write failure composition**

Use `renderBoundaryReceipt()` for all human output. Pass one injected `now` through evaluation and
receipt construction so the receipt observation is internally consistent. When receipt writing
fails, rebuild through `buildBoundaryReceipt()` with the original schema-2 target, observation,
findings, and a `semantic.receipt-write-failed` finding; do not downgrade to schema 1.

Keep explicit invalid-invocation process exit 2 even if a future renderer or shadow mode changes.

- [ ] **Step 4: Update evaluator adaptation only**

The evaluator may read new canonical finding fields and `schemaVersion: 2`; it must not implement
contract validation, guidance, aggregation, or digest logic. Extend the anti-duplication test to
require imports of production `canonicalBoundaryFinding`, `buildBoundaryReceipt`, and
`renderBoundaryReceipt` and reject local definitions with those names.

- [ ] **Step 5: Prove focused integration and frozen scores**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/semantic-boundary-contract.test.ts \
  tests/scripts/semantic-rule-guidance.test.ts \
  tests/scripts/semantic-quality-check.test.ts \
  tests/scripts/semantic-history-provider.test.ts \
  tests/scripts/semantic-history.test.ts \
  tests/scripts/semantic-provenance.test.ts \
  tests/scripts/semantic-boundary-eval.test.ts \
  --pool=forks --fileParallelism=false
bash scripts/run-with-pinned-node.sh scripts/experiments/semantic-boundary-eval.ts \
  --engine baseline --corpus tests/fixtures/semantic-boundary-eval/cases.json --format json
bash scripts/run-with-pinned-node.sh scripts/experiments/semantic-boundary-eval.ts \
  --engine candidate --corpus tests/fixtures/semantic-boundary-eval/cases.json \
  --verify-git --format json
bash scripts/run-with-pinned-node.sh scripts/experiments/semantic-boundary-eval.ts \
  --engine candidate --corpus tests/fixtures/semantic-boundary-eval/holdout.json \
  --verify-git --format json
```

Expected: all suites pass; baseline 13/40; candidate 39/40 with zero false blocks/missed critical
cases; holdout 18/18. The warning-only similar-issue case remains the known candidate mismatch.

- [ ] **Step 6: Commit Task 7**

```bash
git add scripts/semantic-quality-check.ts \
  scripts/experiments/semantic-boundary-eval.ts \
  tests/scripts/semantic-quality-check.test.ts \
  tests/scripts/semantic-boundary-eval.test.ts
bash scripts/run-with-pinned-node.sh scripts/verify-boundary-run.ts record-git-transition \
  --run-dir "$BCF_TASK_RUN_DIR" --attempt integration-commit-transition --kind commit \
  --expect-before "$BCF_TASK_ENTRY_HEAD" \
  --message-subject "feat(quality): integrate evidence-bound boundary receipts"
```

---

### Task 8: Document, verify, and hand off without promoting enforcement

**Files:**
- Modify: `docs/public-surface.md`
- Read/verify unchanged: `docs/publication-audit.md`
- Regenerate: `docs/work-index.json`
- Regenerate: `docs/work-index.md`
- Modify:
  `docs/superpowers/handoffs/2026-07-16-boundary-contract-feedback-implementation-notes.md`

**Interfaces:**
- Consumes: exact commits and verification receipts from Tasks 1–7.
- Produces: public contract documentation and durable internal evidence; no hook/workflow mutation.

**Entry precondition:** Freeze the BCF-07 code snapshot. Dispatch the three named read-only lanes
into distinct helper-owned review runs; the lead inspects each report and records every decisive
finding reproduction in its own helper-owned lead-review run. Each `record-review` finding row and
reproduction attempt is validated before Step 1. A missing, stale, progress-only, conflicting,
mutated, or unreproduced result is inconclusive. Do not initialize the final run yet: tracked docs
must first be written, verified, scope-audited, and committed so the final run can start and finish
at one immutable commit. After the finding joins pass, initialize unique `BCF_DOCS_A_RUN_DIR` at the
frozen BCF-07 head and pre-authoring snapshot. Initialize `BCF_DOCS_B_RUN_DIR` later at that same Git
head but only from A's verified terminal dirty-docs snapshot. The first selects `bcf08a-docs`,
pins/imports the three role-specific review runs
plus lead reproduction run, owns Steps 1–3, and finalizes without a head transition after
`docs-authoring-scope`. The second selects `bcf08b-docs`, pins/imports the finalized first run as
`docs-precommit`, owns Step 4, the narrow post-verification handoff/index refresh, and Step 5, and is
the only docs run authorized to commit. Its
`docs-lineage-scope` and separate `docs-staged-scope` must pass before its commit transition. Step 6
recursively joins the finalized B run, its A closure, and the same direct review/reproduction
manifests and proves the intervening commit changed docs only.

- [ ] **Step 1: Update public-surface rows with exact behavior**

For `guard-semantic-quality`, `verify-semantic`, and `verify-semantic-shadow`, document:

- schema 2 is the current producer format;
- schema 1 remains read/render compatible;
- enforce exits are pass/warn 0, block 1, inconclusive 2;
- invalid invocation is always exit 2;
- shadow preserves decisions but exits zero for valid invocations;
- human/JSON bounds and the evidence digest;
- no live history/provenance provider or required-check promotion exists.

Add the dated schema-evolution/version decision required by Documentation and DevOps Readiness.
Record package version, schema transition, catalog digest, exact validation head, compatibility and
consumer-inventory result, rollback, and whether a separate package/release-note change is required.

- [ ] **Step 2: Write implementation notes from actual evidence**

The handoff must contain these headings and only observed values:

```markdown
# Boundary Contract and Feedback Hardening Implementation Notes

**Status:** Inconclusive — post-commit final verification is pending
**Verified working snapshot:** Record the pre-commit head plus canonical worktree diff identity

## Outcome
## Scope and Non-Goals
## Direct Falsifiers Before Implementation
## Commit Record
## Focused Verification
## Evaluator Results
## Feedback and Output Measurements
## Known Limitations
## Deferred Follow-On Plans
## Authorization Boundary
```

During BCF-08A, populate only evidence already observed through BCF-07/review reproduction and mark
the A documentation guards, B pre-commit commands, final upstream refresh, watchdog, branch gate,
final commit identity, and manifest closeout pending. Point to the ignored helper-owned final
manifest/closeout receipt that will become authoritative after the tracked handoff is committed. Do not claim live provider,
agent-correction, hosted CI, hook enforcement, ruleset, or external producer validation unless it was
actually observed.

Include a canonical lifecycle/supersession table for the foundation, semantic-evaluator,
history/provenance, and BCF packets. Each row records plan path, current status, completion commit or
`null`, final-gate state/artifact, successor, superseded-by, and oracle disposition. The final
run-scoped machine-readable lifecycle JSON is authoritative for execution; the tracked table is its
sanitized durable mirror. A stale immutable plan may remain historically pending only when this
table explicitly points agents to the current disposition.

- [ ] **Step 3: Verify private-doc registration and regenerate index**

Assert the planning commit's existing `PRIVATE-ARCHIVE` rows for this plan and handoff appear
exactly once in `docs/publication-audit.md`; do not add or rewrite either row. Then run:

```bash
bash scripts/run-with-pinned-npm.sh run work-index:regen
bash scripts/run-with-pinned-npm.sh run guard:work-index
bash scripts/run-with-pinned-npm.sh run guard:publication:all
bash scripts/run-with-pinned-npm.sh run guard:doc-drift
bash scripts/run-with-pinned-npm.sh run guard:doc-tally
```

Expected: every command exits zero.

Run each Step 3 command under its corresponding `bcf08a-docs` required attempt. Then execute
`docs-authoring-scope`, set BCF-08A lifecycle to `completed` with final gate `pass`, finalize, and
verify `BCF_DOCS_A_RUN_DIR` at the unchanged BCF-07 head. Initialize `BCF_DOCS_B_RUN_DIR` with
profile `bcf08b-docs` at that same head/snapshot and import the immutable A run under alias
`docs-precommit`, using its predeclared run ID and manifest digest. Initialization must prove the A
terminal worktree snapshot/diff digest and all four owned documentation path hashes byte-equal the B entry
snapshot before it permits Step 4. Never edit the imported A run. B may change only its authorized
inherited four-path working snapshot, and B's own entry-to-terminal delta may contain only the
handoff plus `docs/work-index.json` and `docs/work-index.md`: the post-Step-4 handoff evidence update
and resulting generated-index changes are permitted only with the required B docs-guard replay.
`docs/public-surface.md` must remain byte-equal to B's entry snapshot, and the read-only
`docs/publication-audit.md` must remain byte-equal to the preserved-owner snapshot.
Any correction to A's public contract/version content requires new A and B runs.

- [ ] **Step 4: Run pre-commit focused verification**

Run the seven-suite/evaluator commands from Task 7, then:

```bash
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
bash scripts/run-with-pinned-npm.sh run typecheck:all
: "${TEST_INTEGRITY_BIN:?set to the installed test-integrity executable}"
test -x "$TEST_INTEGRITY_BIN"
"$TEST_INTEGRITY_BIN" scan \
  tests/scripts/semantic-boundary-contract.test.ts \
  tests/scripts/semantic-rule-guidance.test.ts \
  tests/scripts/semantic-quality-check.test.ts \
  tests/scripts/semantic-history-provider.test.ts \
  tests/scripts/semantic-boundary-eval.test.ts
```

If the preflighted test-integrity executable is unavailable, record the attempted command as
inconclusive and run `bash scripts/run-with-pinned-npm.sh run guard:test-integrity`; do not call the
missing tool clean.

After every Step 4 attempt reaches a terminal recorded state, BCF-08B may update only the tracked
handoff's pending evidence fields with the actual A Step 3 and B Step 4 command, direct exit, test
count, evaluator case/count, byte measurement, and limitation values. It must not write the later
docs commit identity, upstream refresh, watchdog, branch gate, or closeout result. Regenerate the
work index and replay all five Step 3 commands under B's required `docs-work-index-*`/publication/
drift/tally attempts against those final pre-commit bytes. Any notes correction after that replay
requires a new B run and another complete five-command replay.

- [ ] **Step 5: Scope-audit and commit the pre-gate tracked handoff**

Run the following as the single helper-owned `docs-lineage-scope` internal check through
`BCF_DOCS_B_RUN_DIR` before its finalization. The check executes and validates all ten operations;
the displayed commands define its closed contract and are not ten caller-recorded attempts:

```bash
git diff --check
git status --short
git rev-parse "$BCF_VALIDATOR_BASE" "$BCF_VALIDATOR_COMMIT"
git diff --name-status "$BCF_VALIDATOR_BASE" "$BCF_VALIDATOR_COMMIT"
git diff --stat "$BCF_VALIDATOR_BASE" "$BCF_VALIDATOR_COMMIT"
git rev-parse "$BCF_UPSTREAM_MERGE^1" "$BCF_UPSTREAM_MERGE^2" origin/main
git diff --name-status "$BCF_UPSTREAM_MERGE^1" "$BCF_UPSTREAM_MERGE"
git diff --stat "$BCF_UPSTREAM_MERGE^1" "$BCF_UPSTREAM_MERGE"
git diff --name-status "$BCF_RECONCILED_BASE"...HEAD
git diff --stat "$BCF_RECONCILED_BASE"...HEAD
```

The validator interval may contain only the three Task 0 validator files. The merge-parent receipt
must show that its first parent is `BCF_VALIDATOR_COMMIT`, its second parent is the hash-bound
upstream OID, and separately classify every upstream-brought path. Only Required File Interface
paths may appear after `BCF_RECONCILED_BASE`; owner paths remain untouched and unstaged.
The uppercase endpoint names in the displayed commands are explanatory aliases, not environment
inputs: `docs-lineage-scope` derives them from the verified BCF-00 completion receipt, Git parents,
and BCF-08B manifest exactly as specified by `DocsLineageReport`, executes the ten direct operations,
and atomically registers that report. A caller-supplied endpoint or report is rejected.

Stage the exact documentation allowlist, verify there is no staged path outside it, then commit:

```bash
git add docs/public-surface.md docs/work-index.json docs/work-index.md
git add -f \
  docs/superpowers/handoffs/2026-07-16-boundary-contract-feedback-implementation-notes.md
bash scripts/run-with-pinned-node.sh scripts/verify-boundary-run.ts record-internal-check \
  --run-dir "$BCF_DOCS_B_RUN_DIR" --attempt docs-staged-scope
bash scripts/run-with-pinned-node.sh scripts/verify-boundary-run.ts record-git-transition \
  --run-dir "$BCF_DOCS_B_RUN_DIR" --attempt docs-commit-transition --kind commit \
  --expect-before "$BCF_TASK_ENTRY_HEAD" \
  --message-subject "docs(quality): record boundary feedback hardening"
```

Set `BCF_DOCS_COMMIT` to the resulting exact commit. The tracked handoff intentionally leaves the
post-commit final gate pending; it cannot truthfully contain its own commit or later gate outcome.
Register the commit/scope receipts, finalize and verify `BCF_DOCS_B_RUN_DIR`, and never mutate either
docs run.

- [ ] **Step 6: Initialize the exact-commit final run, join reviews, refresh upstream, and prove the watchdog**

Initialize `BCF_FINAL_RUN_DIR` exclusively through the helper at `BCF_DOCS_COMMIT`, with no tracked
path allowlist and only the final run's ignored artifact paths allowed. Select profile `bcf08-final`
and assert the helper-frozen attempts/children exactly match its `RUN_CONTRACT_PROFILES` row; a retry
uses a new run rather than changing that set. Use `record-child-run` to
verify and import the finalized B docs run, three review runs, and lead reproduction run under unique
closed-kind aliases before parent-mode `record-review` calls bind the three imported child manifests.
For each finding, validate its stable ID/report evidence, literal reproduction-command contract,
exact lead attempt, and imported source-manifest hash. Prove the code diff from
the reviewer snapshot to `BCF_DOCS_COMMIT` is empty and the only intervening paths are the Step 5
documentation allowlist. The final run must prove that each direct review/reproduction manifest
digest equals its counterpart recursively imported through `docs` → `docs-precommit`; pairwise
distinct run IDs/digests and role-specific dedupe keys are mandatory.

Run the exact final upstream sequence through its seven required attempt IDs:

```bash
git remote get-url origin
git fetch origin
git rev-parse origin/main
git merge-base HEAD origin/main
git rev-list --left-right --count origin/main...HEAD
git diff --name-status <observed-merge-base>...origin/main
git diff --name-status <observed-merge-base>...HEAD
```

For profile `bcf08-final`, the helper resolves `<observed-merge-base>` only from validated 40-hex stdout of
`final-upstream-merge-base`. Map the commands in order to `final-upstream-remote`,
`final-upstream-refresh`, `final-upstream-origin-oid`, `final-upstream-merge-base`,
`final-upstream-ahead-behind`, `final-upstream-remote-diff`, and `final-upstream-local-diff`.
`set-upstream` derives and cross-checks every final remote/OID/base/count/path field from those
immutable attempt outputs; it rejects caller-supplied substitutions. If the observed OID differs
from the reconciliation run's pinned upstream OID, close this final run Inconclusive and stop this
plan. Do not retry ordinary Task 0: its merge-parent contract is anchored to the historical
validator commit and cannot execute from the later docs commit without rewriting history. Recovery
requires an approved plan amendment defining a new current-terminal-head drift-reconciliation
profile, its predecessor/ledger transition, merge parents/path preview, downstream replay set, and
new final run. A disjoint guess or reuse of the old observation cannot authorize completion. If the
OID is identical, write/register the
manifest-bound `Ready with Constraints` transition with next action BCF-08C.

Run this exact harmless process-group canary through `record-command --expect-exit 124,137` with
timeout owner `gnu-timeout`:

```bash
: "${BCF_FINAL_RUN_DIR:?set to the unique initialized final run directory}"
bash scripts/run-with-pinned-node.sh scripts/verify-boundary-run.ts record-command \
  --run-dir "$BCF_FINAL_RUN_DIR" --attempt watchdog-canary --expect-exit 124,137 \
  --timeout-owner gnu-timeout --output-path watchdog-canary/pids.txt -- \
  "$HOME/bin/timeout" --kill-after=1s 1s \
  bash -c 'trap "" TERM; bash -c '\''trap "" TERM; sleep 300'\'' & child=$!; \
    pgid=$(ps -o pgid= -p $$); pgid=${pgid//[[:space:]]/}; \
    printf "parent=%s\nchild=%s\npgid=%s\n" "$$" "$child" "$pgid" > "$1"; \
    wait "$child"' _ "$BCF_FINAL_RUN_DIR/watchdog-canary/pids.txt"
```

Declare the PID file with `--output-path` before execution, then register it with its producer
attempt. Read its three decimal identities.
`/bin/kill -0 <parent>`, `/bin/kill -0 <child>`, and `/bin/kill -0 -<pgid>` must each exit nonzero;
record their raw statuses as attempts `watchdog-parent-dead`, `watchdog-child-dead`, and
`watchdog-group-dead`, respectively, with `--expect-exit nonzero`. Any survivor, unexpected timeout
status/signal, missing PID file, or inferred result leaves A-06 unresolved.

- [ ] **Step 7: Run the complete branch gate with an external deadline**

Preflight the installed GNU timeout owner, then run the repository branch gate under its process
group and place load admission inside that deadline:

```bash
test -x "$HOME/bin/timeout"
: "${BCF_FINAL_RUN_DIR:?set to the unique initialized final run directory}"
bash scripts/run-with-pinned-node.sh scripts/verify-boundary-run.ts record-command \
  --run-dir "$BCF_FINAL_RUN_DIR" --attempt final-branch-gate --expect-exit 0 \
  --timeout-owner gnu-timeout -- \
  "$HOME/bin/timeout" --kill-after=30s 30m \
  loadgate --label boundary-contract-branch --max-wait 120 --strict -- \
  bash scripts/run-with-pinned-npm.sh run verify:push:branch
```

GNU timeout runs the supervised command in its own process group because `--foreground` is absent;
on deadline it sends TERM and then KILL after 30 seconds. Record start/end UTC, exact head, status,
duration, stdout/stderr paths, and whether status was 124/137 (deadline/kill), 75 (load admission),
or another command failure. Any nonzero status, timeout, signal, missing log, or masked status is not
a pass; classify the cause in the helper-owned closeout receipt, not by rewriting tracked notes.

- [ ] **Step 8: Finalize and hash-lock the exact-commit run**

Record direct argv/status/signal/start/end, head/diff, stdout/stderr hashes, focused/typecheck/
integrity/docs/evaluator/branch-gate/review-join/canary artifact hashes, verdict, and lifecycle/oracle
disposition through `set-lifecycle`. Invoke the only authoritative forms:

```bash
"$HOME/bin/timeout" --kill-after=30s 10m \
  bash scripts/run-with-pinned-node.sh scripts/verify-boundary-run.ts \
  closeout --run-dir "$BCF_FINAL_RUN_DIR" --attempt-id closeout-one
"$HOME/bin/timeout" --kill-after=30s 5m \
  bash scripts/run-with-pinned-node.sh scripts/verify-boundary-run.ts \
  verify-closeout --run-dir "$BCF_FINAL_RUN_DIR"
```

The first performs finalization plus immediate verification and writes the immutable
final `run_manifest.json`/lock, and atomically writes the sibling closeout receipt/lock only after
their direct internal statuses are known. The second is read-only and mechanically checks the manifest and closeout locks, exact
head/diff/helper identity, and every recursively imported artifact. It also verifies the nested
BCF-08C completion receipt and chain-ledger locks/digests, so accepted closeout requires all four
lock families plus the bound closeout core/negative-control report rather than only manifest/receipt. On separately named copied
negative-control runs and receipt directories, diagnostic replay of the same matrix must produce the
same reason codes, but the authoritative matrix already ran inside `closeout` before acceptance.
Preserve each negative-control pair separately; never mutate or overwrite the accepted finalized run
or derived closeout directory. GNU timeout owns each outer process group; 124/137, signal, survivor,
or missing receipt is Inconclusive. `closeout` and `verify-closeout` are outer closeout operations,
not attempts appended after immutability. No
tracked file or Git head changes after `BCF_FINAL_RUN_DIR` initialization.

- [ ] **Step 9: Stop before external mutation**

Report exact commits, verification, limitations, and branch status. Do not push, create/update a PR,
post comments, rerun workflows, or change rulesets without a current owner instruction naming that
external action.

---

## Fresh-Operator Handoff and Reproduction

A fresh operator starts only when this plan, its approved specification, and the implementation
notes are readable; `HEAD` contains the planning baseline
`1a7336984ea5bada47f0820e10c9decd53ad57f3` in its ancestry or a newer planning/docs commit whose
scope is proven below; and every unrelated dirty/untracked path from the local preflight is still
present and unchanged.

Run from the repository root:

```bash
pwd
git rev-parse HEAD
git branch --show-current
git status --short
git remote get-url origin
bash scripts/run-with-pinned-npm.sh exec -- node --version
bash scripts/run-with-pinned-npm.sh --version
test -r docs/superpowers/specs/2026-07-15-semantic-boundary-hygiene-design.md
test -r docs/superpowers/plans/2026-07-16-boundary-contract-feedback-hardening.md
test -r docs/superpowers/handoffs/2026-07-16-boundary-contract-feedback-implementation-notes.md
```

Expected: the absolute worktree path matches the Shared Evidence Contract; branch is
`experiment/jul16-boundary-core-history`; origin is the SSH URL for `LucasQuiles/WhatSoup`; pinned
versions are Node `24.15.0` and npm `11.12.1`; no unexplained modified/staged path exists. A newer
planning/docs commit is acceptable only after `git show --stat` proves it contains this approved
packet, the implementation notes identify it as the operator-observed `BCF_VALIDATOR_BASE`, and a
local bootstrap receipt records its exact 40-hex head plus plan/specification/notes blob hashes. The
commit hash is not embedded in its own tree because that would be self-referential.

The plan-review evidence/tool/temp roots are local-only values. Planning closeout writes their
locations to one ignored, run-scoped
`artifacts/verification/boundary-contract-feedback/planning/<run-id>/operator.env`; it contains no
credentials and is never a verdict. Preflight that pointer and assign only its three allowlisted
keys, then run:

```bash
set -euo pipefail
: "${BCF_PLAN_REVIEW_POINTER:?set to the run-scoped operator.env path}"
test -r "$BCF_PLAN_REVIEW_POINTER"
while IFS='=' read -r key value; do
  case "$key" in
    PLAN_REVIEW_TOOL_ROOT) PLAN_REVIEW_TOOL_ROOT=$value ;;
    PLAN_REVIEW_ARTIFACTS) PLAN_REVIEW_ARTIFACTS=$value ;;
    PLAN_REVIEW_TEMP) PLAN_REVIEW_TEMP=$value ;;
    ''|'#'*) ;;
    *) printf 'unexpected operator key: %s\n' "$key" >&2; exit 2 ;;
  esac
done < "$BCF_PLAN_REVIEW_POINTER"
: "${PLAN_REVIEW_TOOL_ROOT:?missing allowlisted tool root}"
: "${PLAN_REVIEW_ARTIFACTS:?missing allowlisted artifact root}"
: "${PLAN_REVIEW_TEMP:?missing allowlisted temp root}"
test -r "$PLAN_REVIEW_ARTIFACTS/run_manifest.json"
test -r "$PLAN_REVIEW_ARTIFACTS/review-inputs.sha256"
test -r "$PLAN_REVIEW_ARTIFACTS/tool-snapshot.sha256"
test -r "$PLAN_REVIEW_ARTIFACTS/artifact-tree.sha256"
REPO_ROOT=$(git rev-parse --show-toplevel)
python3 - "$PLAN_REVIEW_TOOL_ROOT" "$PLAN_REVIEW_ARTIFACTS" <<'PY'
import os
import re
import sys
from pathlib import Path

tool_root = Path(sys.argv[1]).resolve(strict=True)
artifacts = Path(sys.argv[2]).resolve(strict=True)
checksum_line = re.compile(r"^[0-9a-f]{64}  (.+)$")

def declared_paths(manifest):
    declared = []
    for line_number, line in enumerate(manifest.read_text(encoding="utf-8").splitlines(), 1):
        match = checksum_line.fullmatch(line)
        if match is None:
            raise SystemExit(f"malformed checksum line {manifest.name}:{line_number}")
        relative = Path(match.group(1))
        if relative.is_absolute() or ".." in relative.parts:
            raise SystemExit(f"unsafe checksum path {manifest.name}:{line_number}")
        value = relative.as_posix()
        if value in declared:
            raise SystemExit(f"duplicate checksum path in {manifest.name}: {value}")
        declared.append(value)
    return set(declared)

def actual_regular_paths(root, excluded=()):
    excluded = set(excluded)
    actual = set()
    def walk_error(error):
        raise SystemExit(f"unable to enumerate checksum root: {error}")
    for directory, dirnames, filenames in os.walk(
        root,
        followlinks=False,
        onerror=walk_error,
    ):
        directory_path = Path(directory)
        for name in [*dirnames, *filenames]:
            candidate = directory_path / name
            relative = candidate.relative_to(root).as_posix()
            if candidate.is_symlink():
                raise SystemExit(f"symlink forbidden in checksum root: {relative}")
        for name in filenames:
            candidate = directory_path / name
            relative = candidate.relative_to(root).as_posix()
            if relative in excluded:
                continue
            if "\n" in relative or "\r" in relative or not candidate.is_file():
                raise SystemExit(f"unsafe or non-regular checksum entry: {relative}")
            actual.add(relative)
    return actual

tool_declared = declared_paths(artifacts / "tool-snapshot.sha256")
tool_actual = actual_regular_paths(tool_root)
if tool_declared != tool_actual:
    raise SystemExit(
        f"tool snapshot closure mismatch: missing={sorted(tool_actual - tool_declared)}, "
        f"foreign={sorted(tool_declared - tool_actual)}"
    )

review_expected = {
    "docs/superpowers/specs/2026-07-15-semantic-boundary-hygiene-design.md",
    "docs/superpowers/plans/2026-07-16-boundary-contract-feedback-hardening.md",
    "docs/superpowers/handoffs/2026-07-16-boundary-contract-feedback-implementation-notes.md",
}
review_declared = declared_paths(artifacts / "review-inputs.sha256")
if review_declared != review_expected:
    raise SystemExit(
        f"review-input closure mismatch: missing={sorted(review_expected - review_declared)}, "
        f"foreign={sorted(review_declared - review_expected)}"
    )

artifact_declared = declared_paths(artifacts / "artifact-tree.sha256")
artifact_actual = actual_regular_paths(artifacts, {"artifact-tree.sha256"})
if artifact_declared != artifact_actual:
    raise SystemExit(
        f"artifact closure mismatch: missing={sorted(artifact_actual - artifact_declared)}, "
        f"foreign={sorted(artifact_declared - artifact_actual)}"
    )
PY
( cd "$PLAN_REVIEW_TOOL_ROOT" && \
  shasum -a 256 -c "$PLAN_REVIEW_ARTIFACTS/tool-snapshot.sha256" )
( cd "$REPO_ROOT" && \
  shasum -a 256 -c "$PLAN_REVIEW_ARTIFACTS/review-inputs.sha256" )
( cd "$PLAN_REVIEW_ARTIFACTS" && \
  shasum -a 256 -c artifact-tree.sha256 )
contract_json=$(python3 "$PLAN_REVIEW_TOOL_ROOT/scripts/check_artifact_contract.py" \
  --artifacts-dir "$PLAN_REVIEW_ARTIFACTS" \
  --all \
  --json)
closeout_json=$(python3 "$PLAN_REVIEW_TOOL_ROOT/scripts/check_review_run.py" \
  --artifacts-dir "$PLAN_REVIEW_ARTIFACTS" \
  --temp-dir "$PLAN_REVIEW_TEMP" \
  --json)
CONTRACT_JSON="$contract_json" CLOSEOUT_JSON="$closeout_json" python3 - <<'PY'
import json
import os

contracts = json.loads(os.environ["CONTRACT_JSON"])
closeout = json.loads(os.environ["CLOSEOUT_JSON"])
contract_results = contracts.get("results")
legacy_results = closeout.get("contract_result", {}).get("results")
consistency = closeout.get("consistency_result", {})
if contracts.get("valid") is not True or contracts.get("errors") != []:
    raise SystemExit("all-contract verdict is not clean")
if not isinstance(contract_results, list) or len(contract_results) != 15:
    raise SystemExit("all-contract result count must equal 15")
if closeout.get("valid") is not True or closeout.get("errors") != []:
    raise SystemExit("complete-run verdict is not clean")
if closeout.get("pass_count") != 27 or closeout.get("contract_count") != 9:
    raise SystemExit("complete-run counts must equal 27 passes and nine legacy contracts")
if not isinstance(legacy_results, list) or len(legacy_results) != 9:
    raise SystemExit("complete-run legacy result list must contain nine entries")
if consistency.get("valid") is not True or consistency.get("rule_count") != 7:
    raise SystemExit("complete-run consistency must contain seven passing rules")
PY
printf '%s\n' "$contract_json"
printf '%s\n' "$closeout_json"
```

Planning closeout must use newly created, never-reused tool-snapshot, artifact, and temp roots. Copy
only the selected skill's instructions, prompts/references, schemas, scripts, and tests into the tool
snapshot; exclude mutable `runs/`, caches, and prior artifacts, then make the copy read-only before
pass 1. `tool-snapshot.sha256` covers every copied regular file by tool-root-relative path and the
self-test receipt records the direct unfiltered result without converting failures to clean. The
repository-relative `review-inputs.sha256` covers exactly the spec, plan, and notes. The
artifact-relative `artifact-tree.sha256` covers `review-inputs.sha256`, the finalized manifest, all
27 pass inputs/outputs, all artifacts required by the 15 live-registry contracts (including
`assurance_case.json`, `task_graph.json`, `failure_analysis.json`, `provenance.json`, and
`policy_decisions.json`), `tool-snapshot.sha256` and the unfiltered tool self-test receipt, seven
consistency-rule evidence artifacts, contradiction/readiness/final-review records, and child-review
receipts; it excludes only itself. Reproducible checker stdout/stderr stay in the terminal or the
separate temp root and never enter the artifact tree. The closure verifier rejects every symlink,
non-regular entry, manifest omission, manifest duplicate, and unlisted artifact before any digest
or semantic verdict can pass.
Expected after review closeout: all three `shasum -c` commands print only `OK`; the unfiltered
all-contract validator returns JSON with `valid: true` and exactly 15 supported contracts; and the
unfiltered complete-run validator returns JSON with `valid: true`, 27 ordered passes, its nine
legacy manifest-era contracts, and seven consistent readiness/contradiction/final-review rules.
The two contract counts are independent, required receipts: the complete-run helper intentionally
embeds the legacy aggregate and does not replace the 15-contract `--all` check. A reused root, stale
input hash, foreign or unlisted artifact, changed tool snapshot, missing pointer, count mismatch, or
any other result makes the plan-review lane `Inconclusive`; it does not erase the plan file.

Implementation proceeds BCF-00 → BCF-01 → BCF-02 → BCF-03 → BCF-04 → BCF-05 → BCF-06 → BCF-07 →
BCF-08A → BCF-08B → BCF-08C. The handoff package is this plan plus the implementation notes and
contains objective/scope/non-goals, assumptions, validation/readiness, task/verification maps,
telemetry, test provenance/anti-fabrication controls, execution order, risks/blockers, and rollback.
Each task creates the exact artifact named in the scope and atomic-task tables; implementation notes
then record its command, direct status, count/bytes, head/diff, commit, limitation, and verdict.

SBOM generation, dependency attestation, release signing, image/action pin provenance, deployment,
and release canaries are **Not applicable** to this contract-only local tranche. Existing supply-chain
behavior must not be weakened. Adding or claiming any of those outputs requires its own approved
plan and observed verification.

## Deferred Follow-On Plans

This plan intentionally does not implement the following approved specification priorities:

1. history/provenance freshness, target binding, coherent pagination snapshots, structured
   rename/copy paths, tree-entry modes, stable-patch open/merged state matrix, strict/relaxed task
   identity, and omitted re-entry discovery;
2. effective-compiler emitted edges, base/head reachability regression, and non-regular source
   entries;
3. observation producers for fallback postconditions, proof completeness/source matching, consumer
   parity, numeric domains, explicit observation states, independent rosters, target preflight,
   durability failure vocabulary, health semantics, and final-seam protection;
4. local pre-commit/pre-push enforcement, live read-only GitHub provider, external producer,
   required check, ruleset, or agent-correction promotion trial.

The first history follow-on must reuse `fingerprint.ts`, `history-provider.ts`, `history.ts`,
`provenance.ts`, `receipt.ts`, `.husky/pre-push`, `pre-push-guard.ts`, and `work-index.ts`; it must
not introduce a parallel receipt, history scanner, or documentation indexer. Its local-ref adapter
starts with warning-only `history.patch-already-present`, `history.patch-already-merged`,
`lineage.ancestor-superseded`, and `docs.generated-patch-replay`, plus
`history.live-provider-unavailable:inconclusive`. Promotion requires real shadow measurements and a
specific recreate-after-revert control. No branch is deleted on these warnings; any future
supersession cleanup requires a fresh current-head `git cherry -v` and `git range-diff` with all
changed/dropped patches explained.

Each follow-on becomes a separate plan after this contract tranche provides stable receipt
semantics and measured feedback bounds.

## Rollback

- Revert Task 7 integration first to restore schema-1 production while leaving v2 modules available
  for diagnosis.
- Revert Task 6 independently if page settlement regresses provider behavior; preserve the stress
  fixture and record the resulting unowned deadline.
- Revert Tasks 5/4 together if schema-2 rendering/building cannot retain compatibility.
- Revert Task 3 only after Tasks 4–7 no longer import its contract types.
- Revert Task 2 last among code tasks because schema-2 canonical findings depend on its versions.
- Rollback changes only local commits; it does not delete branches, reset unrelated work, mutate
  GitHub, or remove any pre-existing unrelated untracked path.

## Final Review Checklist

- [ ] A-08–10 resolved in a unique preflight run before the first BCF code RED.
- [ ] Predecessor focused/evaluator/branch gates and corrected raw per-case 39/40 oracle share the reconciled head.
- [ ] Every manifest artifact hash, head, diff, and target input survives the mutation/foreign-artifact negative controls.
- [ ] Every unsafe direct probe from the specification has a failing-then-passing test.
- [ ] Every contract rejection has a valid neighboring control.
- [ ] No unknown runtime value can aggregate to pass or shadow fallback.
- [ ] Warning plus limitation is inconclusive and visibly actionable.
- [ ] Schema-1 compatibility is read/render only; current builders emit schema 2.
- [ ] Evidence digest changes only for target/evidence/rule-version inputs.
- [ ] Human and JSON output remain semantically equivalent and within measured bounds.
- [ ] Provider ignore-abort case settles and states that late work cancellation is unproven.
- [ ] Evaluator retains 13/40, 39/40, and 18/18 with per-case assertions.
- [ ] No semantic/history/provenance policy expansion or enforcement promotion entered the diff.
- [ ] Schema/version/changelog disposition and canonical lifecycle/supersession record are explicit.
- [ ] Final handoff names every skipped/unavailable/external surface as inconclusive or out of scope.

## Final Plan-Review Synthesis

All applicable requirements now reach a named BCF task, BCF-00 prerequisite, or an explicit
no-action/deferred decision,
a falsifiable claim, a verifier, an evidence path, and a rollback or stop condition. BCF-01 through
BCF-08C form one reachable sequential implementation graph; only the three independent read-only
post-BCF-07 reviews may fork, and the lead-verification join must complete before BCF-08A. No writer,
artifact root, policy owner, or process-owner conflict remains.

The assurance case is bounded honestly: this packet proves the plan is executable, not that the
implementation exists or passes. Current execution readiness is `Not Ready` for BCF-01 and permits
only BCF-00 reconciliation/evidence work. A-08–10 gate the first production mutation; A-02, A-03,
and A-06 gate their named later tasks. Reviewer probes at the older audit head remain advisory until
their RED cases and safe controls are reproduced at the implementation head. Failed, masked, mixed,
superseded, and invalid attempts stay distinct and cannot count as accepted evidence.

Capability and policy decisions are complete: observed local tools/scripts/skills support the task
graph; writers are sequential; subagent parallelism is read-only and bounded; TDD and deterministic
validation are mandatory; GitHub writes, hooks/workflow promotion, hosted enforcement, Pinecone,
browser, deploy, and live-provider surfaces are unnecessary or separately authorized. Direct local
source, Git, the approved specification, and durable artifacts are the primary history chain.

The final plan-review sink is Pass for executability only when all 27 passes are recorded once in
order; the separate all-contract receipt proves all 15 live-registry contracts; cross-artifact
consistency proves all seven rules; the manifest is finalized `completed`; its plan/spec/notes
hashes match current bytes; and the unfiltered complete-run command returns direct status 0 with
`valid: true`, 27 passes, and nine legacy contracts. Any missing/stale/malformed/foreign artifact,
nonzero, count or digest mismatch, unresolved plan-review defect, or failed ancestor changes plan
review to `Inconclusive` or `Blocked`. A-08–10 are execution-readiness blockers, not plan-review
defects, and remain visible rather than being relabeled as implementation success.
