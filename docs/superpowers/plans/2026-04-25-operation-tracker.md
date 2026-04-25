# Operation Tracker Implementation Plan

## Shared Control Header and Run Bootstrap

- Plan status: Draft execution plan after PlanPrompt hardening pass 1.
- Spec: `docs/superpowers/specs/2026-04-25-operation-tracker-design.md`
- Repo root: `/home/q/LAB/WhatSoup`
- Artifact root: `artifacts/`
- Evidence ledger: `artifacts/run_manifest.json`
- Run identity: `artifacts/run_id.txt`
- Git identity: `artifacts/git_sha.txt`

### File-First Operating Contract

- All substantive hardening and implementation work for this plan must happen in this file and in named repo files; chat summaries are not part of the source of truth.
- All repo inspection, validation, and review outputs must be written under `artifacts/` unless a task explicitly names another proof location.
- `artifacts/run_manifest.json` is the command and provenance ledger for this review run and any later execution run derived from this plan.
- Every completion claim must point to named evidence. Unsupported narrative summaries are invalid.
- If a required tool is unavailable, record `not installed`, `skipped`, or `not applicable` under `artifacts/`; do not silently omit the gap.
- If repo context, artifact evidence, or validation output is missing, the affected task or gate must resolve to `Blocked` or `Inconclusive`, not `Pass`.

### Repo-Grounding Evidence Captured During This Review Run

- Identity and git baseline:
  - `artifacts/run_id.txt`
  - `artifacts/git_sha.txt`
  - `artifacts/git_status.txt`
  - `artifacts/git_remotes.txt`
  - `artifacts/git_branches.txt`
- Repo reconnaissance:
  - `artifacts/ls_root.txt`
  - `artifacts/build_manifests.txt`
  - `artifacts/top_level_dirs.txt`
  - `artifacts/package_scripts.txt`
  - `artifacts/repo_file_index.txt`
- Scope and surface hints:
  - `artifacts/changed_files.txt`
  - `artifacts/public_surface_hints.txt`
  - `artifacts/contract_file_hits.txt`
  - `artifacts/config_inventory.txt`
  - `artifacts/recent_hot_files.txt`
  - `artifacts/risk_surface_hits.txt`
- Optional-tool posture:
  - `artifacts/conftest.txt`
  - `artifacts/osv.txt`
  - `artifacts/schemathesis.txt`
  - `artifacts/codeowners_present.txt`
  - `artifacts/ci_configs.txt`
  - `artifacts/sca_readiness.txt`
- Quality-lane probes:
  - `artifacts/make_test_dry_run.txt`
  - `artifacts/pytest.txt`
  - `artifacts/npm_test.txt`
  - `artifacts/go_test.txt`
  - `artifacts/semgrep.txt`

### Verdict Taxonomy

- `Pass`: named evidence proves the requirement or gate at the stated threshold.
- `Fail`: named evidence proves the requirement or gate was not met.
- `Inconclusive`: evidence exists but does not prove either pass or fail.
- `Blocked`: the work cannot be judged or continued safely because a required precondition, tool, or artifact is missing.

### Bootstrap Rules

- Use the repo root as the working directory for every command in this plan.
- Refresh `artifacts/run_manifest.json` before starting a new review or implementation run.
- Snapshot this plan before every hardening pass and compute diff stats after every pass.
- Record every pass result in the manifest with verdict, summary, and referenced artifacts.
- Preserve this section as the inherited operating contract for all later sections.

### Section Inventory

This document is organized to match the 27-pass PlanPrompt sequence. Each later section must harden the implementation plan for the named concern and point to concrete repo surfaces, commands, artifacts, and blocker logic.

## Objective and Scope

### Objective

Implement the OperationTracker design in the agent runtime so each in-flight tool call and prolonged no-tool "thinking" gap is tracked explicitly, surfaced to users according to `toolUpdateMode`, and escalated into targeted recovery actions before the existing 30-minute hard kill backstop fires.

### In-Scope Repo Surfaces

- `src/config.ts` and `tests/config.test.ts`
  - Add and validate `operationTracker` config schema, defaults, and threshold merging.
- `src/runtimes/agent/operation-tracker.ts` and `tests/runtimes/agent/operation-tracker.test.ts`
  - Introduce the tracker module, timer lifecycle, event model, and fake-timer coverage.
- `src/runtimes/agent/outbound-queue.ts` and `tests/runtimes/agent/outbound-queue.test.ts`
  - Render tracker progress and stall events and remove the current minimal-heartbeat mechanism.
- `src/runtimes/agent/session.ts` and `tests/runtimes/agent/session.test.ts`
  - Demote the watchdog to a hard backstop and add operation-recovery and liveness-probe hooks.
- `src/runtimes/agent/runtime.ts` and `tests/runtimes/agent/runtime.test.ts`
  - Wire tracker lifecycle to `tool_use`, `tool_result`, `assistant_text`, `compact_boundary`, and `result` events across current runtime routing paths.
- Documentation surfaces:
  - `docs/configuration.md`
  - `docs/runbook.md`
  - Any operation-tracker-specific follow-up artifact under `artifacts/` required for execution and handoff.

### Explicit Non-Goals

- No database schema, migration, or durability journal shape changes.
- No new provider protocol, parser, or MCP transport contract changes.
- No new fleet UI or health-endpoint surface unless a later blast-radius review proves it is required.
- No removal of the 30-minute hard watchdog kill path.
- No speculative refactor outside the agent runtime file cluster named above.

### Success Criteria

- `SC-01`: config loads `operationTracker` defaults and per-category thresholds without breaking existing instance loading.
  - Check: targeted Vitest lane for `tests/config.test.ts`.
  - Expected threshold: `Pass`.
  - Evidence: `artifacts/npm_test.txt` or targeted test output recorded during execution, plus file diff in `src/config.ts`.
- `SC-02`: tracker module emits `operation_progress`, `operation_slow`, `operation_stalled`, `thinking_long`, and `thinking_stalled` deterministically under fake timers.
  - Check: targeted Vitest lane for `tests/runtimes/agent/operation-tracker.test.ts`.
  - Expected threshold: `Pass`.
  - Evidence: `artifacts/verification_matrix.md`, targeted test output artifact to be produced during execution.
- `SC-03`: outbound progress rendering matches `full`, `friendly`, and `minimal` mode expectations and the old minimal heartbeat path is removed.
  - Check: targeted and full `tests/runtimes/agent/outbound-queue.test.ts`.
  - Expected threshold: `Pass`.
  - Evidence: `artifacts/verification_matrix.md`, `artifacts/regression_protection.md`, code search proving heartbeat removal.
- `SC-04`: session watchdog behavior keeps only the hard backstop and exposes recovery hooks without regressing crash, shutdown, or pending-tool semantics.
  - Check: targeted and relevant `tests/runtimes/agent/session.test.ts`.
  - Expected threshold: `Pass`.
  - Evidence: `artifacts/verification_matrix.md`, `artifacts/error_model.md`.
- `SC-05`: runtime event wiring is correct for turn start, tool lifecycle, compact boundary, and turn completion in current session modes.
  - Check: targeted `tests/runtimes/agent/runtime.test.ts`.
  - Expected threshold: `Pass`.
  - Evidence: `artifacts/verification_matrix.md`, `artifacts/blast_radius.md`, runtime diff.
- `SC-06`: docs and runbooks describe the new config and recovery behavior clearly enough for a fresh operator to execute and diagnose the feature.
  - Check: documentation review and contradiction pass.
  - Expected threshold: `Pass` or `Ready with Constraints` if implementation lands before docs.
  - Evidence: `artifacts/documentation_devops_readiness.md`, `artifacts/final_review.md`.

### Failure Criteria

- `FC-01`: any planned step relies on a repo surface that is not present in `src/` or `tests/` and has no validated replacement path.
- `FC-02`: a completion claim depends on `looks correct`, typing-indicator behavior, or other unrecorded intuition instead of named artifacts.
- `FC-03`: `src/runtimes/agent/outbound-queue.ts` still contains `scheduleMinimalHeartbeat`, `minimalHeartbeatTimer`, or equivalent hidden-heartbeat behavior after the change.
- `FC-04`: `src/runtimes/agent/session.ts` still arms `WATCHDOG_SOFT_MS` or `WATCHDOG_WARN_MS` for normal execution after the change.
- `FC-05`: runtime wiring leaves tracked operations uncleared on `result`, crash, shutdown, or turn replacement.
- `FC-06`: targeted or regression tests fail, are skipped without rationale, or produce only `Inconclusive` evidence for a critical claim.

### Constraints

- The implementation must stay inside the current Node.js + TypeScript + Vitest stack described by `package.json` and `tsconfig*.json`.
- Timer behavior must be testable with fake timers; non-deterministic wall-clock validation is insufficient.
- Existing `toolUpdateMode` semantics remain the public rendering contract; OperationTracker augments them rather than replacing them.
- Current git history in `artifacts/changed_files.txt` shows only the plan/spec cluster, so implementation scope must be anchored to named runtime/test/doc surfaces, not recent commit churn.
- Any optional tooling lane not present in this repo or environment must be recorded as `not installed`, `skipped`, or `not applicable`.

### Required Evidence for Scope Control

- Baseline repo evidence:
  - `artifacts/changed_files.txt`
  - `artifacts/public_surface_hints.txt`
  - `artifacts/repo_file_index.txt`
- Review and gate artifacts:
  - `artifacts/readiness.json`
  - `artifacts/verification_matrix.md`
  - `artifacts/test_strategy.md`
  - `artifacts/tooling_plan.md`
  - `artifacts/contradiction_check.md`
  - `artifacts/linting_plan.md`
  - `artifacts/regression_protection.md`
  - `artifacts/final_review.md`

### Quality Bar

- Every task in this plan must map to at least one deterministic validation lane and one named artifact.
- Any residual implementation risk must be explicit in `artifacts/readiness.json` or later contradiction/final-review artifacts.
- Documentation and operator guidance are part of the done criteria, not deferred cleanup.

### Exit Criteria

- A fresh operator can identify the exact repo surfaces to change, the exact proof required, the explicit non-goals, and the conditions that block execution from this section alone.

## Assumption Audit

All material assumptions for this plan must be explicit. Compound assumptions are split into separate records. No later task may rely on an assumption that is not listed here with evidence, validation, and disposition.

### Assumption Record Standard

Each assumption record must include:

- Assumption ID
- Statement
- Category
- Source location in the plan or repo
- Why it matters
- Evidence currently available
- Evidence quality: `direct`, `indirect`, `stale`, `inferred`, or `missing`
- Risk if false
- Blast radius
- Validation method
- Exact validation command
- Artifact path under `artifacts/`
- Owner
- Due stage or checkpoint
- Disposition: `Validated`, `Constrained`, `Replaced`, `Unresolved`, or `Blocked`

### Assumption Register

#### A-01

- Statement: `tool_use`, `tool_result`, `assistant_text`, `compact_boundary`, and `result` are the correct runtime seams for starting, updating, and clearing tracker state across the current agent runtime.
- Category: runtime event contract
- Source location: `src/runtimes/agent/runtime.ts`, `tests/runtimes/agent/runtime.test.ts`
- Why it matters: if the seam is wrong, the tracker can leak operations, miss stalls, or clear state too early.
- Evidence currently available: direct inspection of the runtime event switch and targeted runtime tests referenced in `artifacts/repo_file_index.txt` and `artifacts/risk_surface_hits.txt`.
- Evidence quality: direct
- Risk if false: false progress, missed recovery, or duplicated user-visible updates.
- Blast radius: agent runtime behavior in `single`, `shared`, and `per_chat` session modes.
- Validation method: inspect both runtime event-routing paths and extend runtime tests for tracker lifecycle.
- Exact validation command: `rg -n "case 'assistant_text'|case 'tool_use'|case 'tool_result'|case 'compact_boundary'|case 'result'" src/runtimes/agent/runtime.ts tests/runtimes/agent/runtime.test.ts`
- Artifact path under `artifacts/`: `artifacts/risk_surface_hits.txt`, later `artifacts/verification_matrix.md`
- Owner: plan executor
- Due stage or checkpoint: before runtime wiring task begins
- Disposition: Validated

#### A-02

- Statement: the existing `ToolCategory` taxonomy in `src/runtimes/agent/providers/tool-mapping.ts` is sufficient to derive tracker threshold buckets without inventing new user-facing categories.
- Category: classification contract
- Source location: `src/runtimes/agent/providers/tool-mapping.ts`
- Why it matters: threshold and progress behavior depends on stable category-to-threshold mapping.
- Evidence currently available: direct code inspection shows the runtime already normalizes provider-specific tool names into a shared category set.
- Evidence quality: direct
- Risk if false: incorrect threshold selection or category drift between providers.
- Blast radius: tracker timers, progress rendering, and regression tests across multiple providers.
- Validation method: preserve category reuse and add tests for category-to-threshold mapping in the new tracker test lane.
- Exact validation command: `sed -n '1,260p' src/runtimes/agent/providers/tool-mapping.ts`
- Artifact path under `artifacts/`: `artifacts/repo_file_index.txt`, later `artifacts/test_strategy.md`
- Owner: plan executor
- Due stage or checkpoint: before tracker implementation
- Disposition: Validated

#### A-03

- Statement: the current minimal heartbeat path in `src/runtimes/agent/outbound-queue.ts` can be removed without losing user-visible liveness because tracker-generated progress and stall events will replace it.
- Category: UX and degradation behavior
- Source location: `src/runtimes/agent/outbound-queue.ts`, `tests/runtimes/agent/outbound-queue.test.ts`
- Why it matters: removing the heartbeat incorrectly could create silent failure or degraded-mode regressions in `minimal` mode.
- Evidence currently available: direct code inspection shows `scheduleMinimalHeartbeat()` and related state are isolated to the outbound queue; the design spec explicitly replaces them with tracker events.
- Evidence quality: direct
- Risk if false: users in `minimal` mode receive long silent gaps or duplicate status noise.
- Blast radius: user-facing status behavior and queue timer management.
- Validation method: search for all heartbeat references, remove them, and prove equivalent coverage with outbound-queue and runtime tests.
- Exact validation command: `rg -n "scheduleMinimalHeartbeat|minimalHeartbeatTimer|minimalSentDetails|minimalLastSentAt" src/runtimes/agent/outbound-queue.ts tests/runtimes/agent/outbound-queue.test.ts`
- Artifact path under `artifacts/`: `artifacts/risk_surface_hits.txt`, later `artifacts/regression_protection.md`
- Owner: plan executor
- Due stage or checkpoint: before outbound-queue closeout
- Disposition: Constrained

#### A-04

- Statement: `SessionManager` can support `recoverStalledOperation()` and `probeLiveness()` by reusing the current child-process stdin path and existing crash/shutdown behavior instead of introducing a new process-control abstraction.
- Category: recovery mechanism
- Source location: `src/runtimes/agent/session.ts`, `tests/runtimes/agent/session.test.ts`
- Why it matters: if recovery cannot use the existing control path, the plan scope and risk profile change materially.
- Evidence currently available: direct code inspection shows existing stdin writes, watchdog state, and child lifecycle hooks that recovery can extend.
- Evidence quality: direct
- Risk if false: recovery hooks become no-ops or require new transport semantics.
- Blast radius: session reliability, crash recovery, and watchdog semantics.
- Validation method: add mock-child tests for interrupt and liveness-probe writes before demoting watchdog tiers.
- Exact validation command: `rg -n "stdin\\.write|tickWatchdog|clearTurnWatchdog|watchdogSoft|watchdogWarn|watchdogHard" src/runtimes/agent/session.ts tests/runtimes/agent/session.test.ts`
- Artifact path under `artifacts/`: `artifacts/risk_surface_hits.txt`, later `artifacts/error_model.md`
- Owner: plan executor
- Due stage or checkpoint: before session watchdog demotion
- Disposition: Validated

#### A-05

- Statement: tracker state may remain in-memory per session; no persistence or schema change is required for the first implementation increment.
- Category: state durability
- Source location: spec non-goals and current session/runtime architecture
- Why it matters: persisting tracker state would expand scope into durability, migrations, and recovery replay rules.
- Evidence currently available: indirect architecture evidence from the spec and current runtime/session ownership model; no existing persistence seam is required for user-facing progress updates.
- Evidence quality: indirect
- Risk if false: crash recovery might lose tracker context that operators expected to persist.
- Blast radius: durability docs, database schema, and restart semantics.
- Validation method: blast-radius review confirms no durability or migration contract depends on tracker state.
- Exact validation command: `rg -n "watchdog_state|session_checkpoints|durability" src docs tests`
- Artifact path under `artifacts/`: `artifacts/blast_radius_hits.txt`, later `artifacts/blast_radius.md`
- Owner: plan executor
- Due stage or checkpoint: blast-radius pass
- Disposition: Constrained

#### A-06

- Statement: operator-facing guidance can be contained within `docs/configuration.md`, `docs/runbook.md`, and execution artifacts under `artifacts/` without new fleet UI work.
- Category: operational readiness
- Source location: existing docs tree and in-scope non-goals
- Why it matters: missing operator guidance would leave the feature diagnosable only from source code.
- Evidence currently available: direct repo inventory shows established configuration and runbook surfaces, but no operation-tracker documentation exists yet.
- Evidence quality: direct
- Risk if false: runtime lands without reproducible operator instructions.
- Blast radius: rollout, incident response, and handoff quality.
- Validation method: documentation and devops readiness pass must update docs or mark readiness constrained.
- Exact validation command: `rg --files docs | sort | rg "configuration|runbook"`
- Artifact path under `artifacts/`: `artifacts/repo_file_index.txt`, later `artifacts/documentation_devops_readiness.md`
- Owner: plan executor
- Due stage or checkpoint: documentation pass before final closeout
- Disposition: Constrained

#### A-07

- Statement: duplicate or parallel runtime event-routing paths in `src/runtimes/agent/runtime.ts` require explicit review so tracker wiring does not land in only one path.
- Category: hidden coupling
- Source location: `src/runtimes/agent/runtime.ts`
- Why it matters: partial wiring would create mode-dependent or lifecycle-dependent tracker behavior that is hard to detect by casual review.
- Evidence currently available: direct search results show multiple `handleEvent` switch blocks and event-case clusters in the file.
- Evidence quality: direct
- Risk if false: a later refactor could leave one routing path untracked.
- Blast radius: session scope handling, shared queue routing, and regression coverage.
- Validation method: reuse-first and blast-radius passes must call out both paths and the tests that exercise them.
- Exact validation command: `rg -n "handleEvent\\(|case 'tool_use'|case 'tool_result'|case 'result'" src/runtimes/agent/runtime.ts`
- Artifact path under `artifacts/`: `artifacts/risk_surface_hits.txt`, later `artifacts/blast_radius.md`
- Owner: plan executor
- Due stage or checkpoint: before runtime wiring task closes
- Disposition: Validated

### Assumption Controls

- Critical assumptions may not remain `Unresolved` past the readiness gate.
- `Constrained` assumptions must name the task, test, or documentation step that narrows the risk.
- If any assumption degrades from `Validated` or `Constrained` to `Unresolved`, record the change in `artifacts/readiness.json` and downgrade readiness accordingly.

## Primary Validation

Primary validation is the first gate that can fail this plan before any implementation work starts. It is not a narrative review. It is a structured audit of sequencing, hidden coupling, missing preconditions, and fake completion signals.

### Required Inputs

- Repo status and changed-file cluster:
  - `artifacts/changed_files.txt`
  - `artifacts/git_status.txt`
- Build and test lane probes:
  - `artifacts/make_test_dry_run.txt`
  - `artifacts/pytest.txt`
  - `artifacts/npm_test.txt`
  - `artifacts/go_test.txt`
  - `artifacts/semgrep.txt`
- Runtime surface evidence:
  - `artifacts/risk_surface_hits.txt`
  - `artifacts/public_surface_hints.txt`
  - `artifacts/repo_file_index.txt`

### Primary Validation Questions

Every implementation task and every control section in this plan must answer these questions explicitly in `artifacts/primary_validation.md`:

- Does the task depend on something unverified?
- Does the task assume a contract not yet confirmed in the repo?
- Are any preconditions missing or ordered too late?
- Are task boundaries falsely independent?
- Can a step appear successful while failing materially?
- Are fallback and rollback paths executable or only described?
- Are exit conditions concrete and machine-checkable where possible?
- Are there hidden operator judgments that should be turned into rules or artifacts?

### Failure Patterns That Must Be Hunted

- hidden coupling between tracker, queue, session, and runtime event paths
- circular sequencing between tracker wiring and session recovery logic
- invisible manual work in docs, test selection, or recovery handling
- implied approvals or unowned validation calls
- weak completion signals such as "tests look good" without artifact references
- partial-success traps such as queue rendering landing before runtime cleanup
- silent failure modes where typing continues but tracker or recovery state is broken

### Output Contract

Before the readiness gate, produce `artifacts/primary_validation.md` with one entry per question or failure pattern containing:

- validation question
- evidence reviewed
- findings
- severity
- affected sections
- required fixes
- status
- final verdict

### Gate Rules

- If a critical validation question has only `missing` or `inferred` evidence, the status is `Blocked` or `Inconclusive`.
- If a task boundary depends on another task's unproven side effect, the plan must either reorder the tasks or split the dependency into a separate atomic task.
- If a fallback or rollback path is not executable from named repo surfaces, the plan must not claim readiness.
- Primary validation findings must be referenced by later readiness, contradiction, and final-review artifacts rather than silently absorbed.

### Exact Checks Expected During Execution

- Code search and sequencing audit:
  - `rg -n "operationTracker|watchdog|scheduleMinimalHeartbeat|tool_use|tool_result|assistant_text|result" src tests docs`
- Quality-lane audit:
  - `npm test --silent`
  - targeted Vitest lanes for config, tracker, outbound queue, session, and runtime
- Diff and scope audit:
  - `git diff --stat`
  - `git diff --name-only`

### Exit Criteria

- No meaningful step in this plan proceeds without a named validation method, artifact destination, and verdict threshold.
- `artifacts/primary_validation.md` exists and names any required plan repairs discovered by this gate.

## Secondary and Tertiary Validation

Secondary and tertiary validation are mandatory escalation layers, not optional polish. They must use different methods than the primary validation pass and must target different failure classes.

### Escalation Triggers

Secondary validation is required when any of the following are true:

- a task changes more than one runtime file cluster
- a task alters user-visible behavior in `full`, `friendly`, or `minimal` mode
- a task modifies timer behavior, cleanup behavior, or crash/recovery handling
- a primary validation finding remains `Inconclusive`

Tertiary validation is required when any of the following are true:

- the change touches session recovery, forced termination, or liveness probing
- the change can create silent failure or misleading-success states
- the change affects shared runtime paths used by more than one provider or session mode
- the change changes operator trust signals, observability, or final readiness claims

This plan meets the tertiary-validation trigger set because it changes recovery behavior, timer semantics, and user-visible progress reporting inside the agent runtime.

### Allowed Validation Modes

- adversarial review against silent-failure and double-send scenarios
- edge-case review using timer boundaries, zero-op turns, and late-result paths
- failure-mode analysis for recovery, retry, and crash handling
- dependency inversion review to ensure tracker remains callback-based and not tightly coupled to queue or session internals
- contract re-check against `toolUpdateMode`, `ToolCategory`, and watchdog semantics
- representative dry run with targeted test lanes
- contradiction search across assumptions, readiness, testing, and documentation
- independent reproduction of critical timers and cleanup paths
- replay validation using fake timers and mock child processes

### Required Artifacts

- `artifacts/validation_layer2.md`
  - required when a secondary trigger fires
- `artifacts/validation_layer3.md`
  - required when a tertiary trigger fires

Each invoked layer must record:

- validation layer used
- reason invoked
- methods applied
- evidence reviewed
- findings
- severity
- disposition
- residual risk
- final verdict

### Blocker Logic

- If a required secondary layer is skipped, readiness cannot exceed `Not Ready`.
- If a required tertiary layer is skipped, contradiction and final-review verdicts must resolve to `Blocked` or `Inconclusive`.
- Repeating the same code-reading logic from primary validation does not satisfy the layered-validation requirement.
- Any deferred validation layer must leave a residual-risk record in the corresponding layer artifact and in `artifacts/readiness.json`.

### Validation-Layer Mapping for This Plan

- Layer 2:
  - method: targeted adversarial review of queue and runtime behavior after tracker wiring
  - primary focus: duplicate messaging, missed cleanup, and mode-specific regressions
- Layer 3:
  - method: independent contradiction search plus recovery-path review across `session.ts`, `runtime.ts`, and `outbound-queue.ts`
  - primary focus: hard-watchdog regression, false liveness, and operator-facing trust failures

### Exit Criteria

- The plan names distinct secondary and tertiary validation methods, their triggers, their artifacts, and the blocker behavior when they are missing or inconclusive.

## Logging and Observability

OperationTracker work must be observable enough that a reviewer can reconstruct progress, stalls, recovery attempts, and closeout state from logs and artifacts without relying on memory.

### Minimum Telemetry Standard

- Use structured JSON logging through the existing logger surface in `src/logger.ts`.
- Every new tracker, recovery, or readiness-affecting event must include:
  - `timestamp_utc`
  - `run_id` when emitted from execution or validation lanes
  - `session_id` when available
  - `chat_jid` or `conversation_key` when available
  - `provider`
  - `event`
  - `tool_id`
  - `tool_name`
  - `category`
  - `state`
  - `elapsed_ms` or `gap_ms`
  - `result` using `Pass`, `Fail`, `Inconclusive`, or `Blocked` where a verdict exists
  - `artifact_paths` when a log event explains a validation or closeout decision

### Events That Must Never Be Silent

- tracker construction and shutdown when enabled
- operation enters `slow`
- operation enters `stalled`
- thinking gap crosses `thinking_long`
- thinking gap crosses `thinking_stalled`
- recovery interrupt is sent
- liveness probe is sent
- hard watchdog kill still fires
- tracker clears lingering operations on turn completion, crash, or shutdown

### Logging Layers

- input log:
  - purpose: record config and activation context
  - minimum fields: `instance`, `provider`, `tool_update_mode`, `operation_tracker_enabled`
- decision log:
  - purpose: record threshold selection, escalation decisions, and readiness outcomes
  - minimum fields: `tool_id`, `category`, `threshold_key`, `expected_ms`, `slow_ms`, `stall_ms`
- execution log:
  - purpose: record tracker lifecycle and recovery actions
  - minimum fields: `event`, `session_id`, `tool_id`, `elapsed_ms`, `result`
- validation log:
  - purpose: link tests and checks to evidence artifacts
  - minimum fields: `command`, `artifact_paths`, `result`
- output log:
  - purpose: record user-visible message decisions when behavior changes materially by mode
  - minimum fields: `tool_update_mode`, `rendered_event_type`, `suppressed`, `reason`
- audit log:
  - purpose: preserve final decisions and contradictions
  - minimum fields: `verdict`, `artifact_paths`, `decision_authority`

### Sensitive-Data Rules

- Do not log raw message content, credentials, or full file contents for tracker events.
- Tool details may be logged only in the truncated, already-sanitized style used by current queue and runtime helpers.
- If a failure requires operator-facing context, prefer artifact references over dumping large payloads into runtime logs.

### Validation of Observability

- Add or update tests that prove the new events are logged or otherwise observable where the repo already enforces logging coverage.
- Inspect `tests/runtimes/agent/logging-coverage.test.ts` during implementation to decide whether tracker and recovery events belong in that lane or a new targeted lane.
- Record instrumentation review and any gaps in `artifacts/primary_validation.md` and later contradiction artifacts.

### Retention and Replay

- Review-run artifacts under `artifacts/` remain the canonical replay package for this plan.
- Runtime log expectations must point operators to existing durable log locations already documented in `docs/runbook.md`; do not invent a second undocumented log sink.
- The final handoff must make it possible to map runtime log events back to this plan's artifacts and verification matrix.

### Exit Criteria

- The plan defines what must be logged, what cannot be silent, what fields are mandatory, and how a reviewer can replay the truth of the change from telemetry plus artifacts alone.

## Execution Readiness

Execution readiness is a formal gate for starting implementation against this plan. It is not a confidence statement.

### Readiness States

- `Ready`
  - meaning: all critical assumptions are validated, task boundaries are explicit, verification and rollback paths exist, and no blocker remains open.
  - allowed follow-on action: begin implementation tasks in sequence.
- `Ready with Constraints`
  - meaning: the plan is executable, but named residual risks or non-critical evidence gaps remain and must be tracked during execution.
  - allowed follow-on action: begin implementation tasks only if the residual risks are recorded in `artifacts/readiness.json` and referenced by the verification matrix.
- `Not Ready`
  - meaning: one or more blockers, missing critical assumptions, or missing execution seams prevent safe implementation.
  - allowed follow-on action: remediate blockers only; implementation tasks may not start.

### Evidence Threshold

Readiness cannot exceed `Ready with Constraints` unless all of the following are true:

- objective and scope are stable
- assumptions are audited and critical ones are validated or constrained explicitly
- affected repo surfaces are named
- atomic tasks, owners, and dependencies are defined
- verification methods and artifact paths are explicit
- observability requirements are defined
- rollback or containment paths exist
- residual risks are documented and non-blocking

### Mandatory Readiness Checks

- stable objective
- bounded scope
- audited assumptions
- validated critical assumptions
- known dependencies and execution seams
- verified contracts
- explicit verification methods
- observability sufficiency
- measurable success signals
- measurable failure signals
- rollback or containment paths
- known owners
- documented residual risks

### Blocker Conditions

- any critical assumption remains `Unresolved` or `Blocked`
- any required validation layer is missing
- any task lacks an owner, validation method, or evidence destination
- any runtime surface needed for the change is unnamed or contradicted elsewhere in the plan
- rollback or containment logic is absent for queue, session, or runtime wiring changes

### Decision Authority and Recording

- The active operator performing the hardened review records the readiness decision in `artifacts/readiness.json`.
- Later contradiction and final-review passes may downgrade readiness if new blockers appear.
- Readiness decisions must cite the evidence reviewed rather than restating prose from this plan.

### Required Output

Maintain `artifacts/readiness.json` with:

- `readiness_state`
- `date`
- `evidence_reviewed`
- `open_risks`
- `blockers`
- `decision_rationale`
- `decision_authority`
- `next_allowed_action`

### Exit Criteria

- Readiness is expressed as a formal gate with explicit meanings, allowed actions, blocker conditions, residual-risk handling, and an evidence-backed decision record.

## Molecular Task Decomposition

### Parent Task Map

- `OT-P1`: establish config and tracker foundations
- `OT-P2`: integrate tracker events into queue and session behavior
- `OT-P3`: wire runtime lifecycle, documentation, and closeout

Each atomic task below has one meaningful action, one primary output, one owner, one validation path, and one evidence destination. If a task starts to mix execution and validation or produces multiple unrelated outputs, split it again before execution.

### Atomic Tasks

#### OT-01

- Parent Task ID: `OT-P1`
- Objective: add `operationTracker` config types and defaults to `src/config.ts`
- Preconditions: scope, assumptions, and readiness sections are complete
- Inputs: spec config block, `src/config.ts`, `tests/config.test.ts`
- Action: implement config schema, default thresholds, and merge behavior only
- Expected Output: `config.operationTracker` exists with deterministic defaults
- Observable Signals: config imports compile; targeted config assertions can reference real defaults
- Validation Method: targeted config Vitest lane
- Failure Modes: malformed default merge; threshold keys drift from tracker expectations
- Retry Path: fix config shape without touching runtime wiring
- Rollback Path: revert `src/config.ts` and related config tests only
- Evidence Produced: `artifacts/test-ot-01-config.txt`
- Dependencies: none
- Blocking Conditions: config defaults or threshold schema remain undefined or non-deterministic
- Owner: runtime implementor

#### OT-02

- Parent Task ID: `OT-P1`
- Objective: create `src/runtimes/agent/operation-tracker.ts` with public types and basic lifecycle
- Preconditions: `OT-01`
- Inputs: spec architecture, `ToolCategory`, config types
- Action: implement tracker construction, active-operation registry, lifecycle hooks, and callback contract only
- Expected Output: tracker module exists and can start, end, clear, and shut down operations
- Observable Signals: new module compiles; new test file can instantiate tracker
- Validation Method: targeted tracker construction and lifecycle tests
- Failure Modes: timer leaks; coupled dependencies on queue or session internals; invalid public API
- Retry Path: fix tracker internals without changing public callback contract
- Rollback Path: revert new tracker module and its dedicated tests only
- Evidence Produced: `artifacts/test-ot-02-tracker-core.txt`
- Dependencies: `OT-01`
- Blocking Conditions: tracker cannot compile or exposes hidden coupling to queue/session
- Owner: runtime implementor

#### OT-03

- Parent Task ID: `OT-P1`
- Objective: add deterministic timer, escalation, and thinking-gap coverage for the tracker
- Preconditions: `OT-02`
- Inputs: tracker module, fake-timer test harness patterns, threshold mapping
- Action: implement or extend tests for progress, slow, stalled, thinking-long, and thinking-stalled behavior only
- Expected Output: fake-timer tests prove state transitions and callback emission deterministically
- Observable Signals: targeted tracker test lane covers threshold boundaries and cleanup
- Validation Method: targeted tracker timer Vitest lane
- Failure Modes: off-by-one timing, state not cleared on shutdown, nondeterministic assertions
- Retry Path: tighten timers or assertions without widening task scope
- Rollback Path: revert only timer-specific tests if they prove invalid while preserving tracker core
- Evidence Produced: `artifacts/test-ot-03-tracker-timers.txt`
- Dependencies: `OT-02`
- Blocking Conditions: timer behavior cannot be proven with fake timers
- Owner: test owner

#### OT-04

- Parent Task ID: `OT-P2`
- Objective: add progress-event rendering to `src/runtimes/agent/outbound-queue.ts`
- Preconditions: `OT-02`
- Inputs: tracker event types, existing `toolUpdateMode` behavior, `tests/runtimes/agent/outbound-queue.test.ts`
- Action: implement `enqueueProgressUpdate()` and mode-specific rendering only
- Expected Output: queue can render tracker events in `full`, `friendly`, and `minimal` modes
- Observable Signals: queue tests can assert message text or suppression behavior by mode
- Validation Method: targeted and full outbound-queue tests
- Failure Modes: duplicate progress spam; wrong mode behavior; tracker event shape mismatch
- Retry Path: adjust render strings and per-mode suppression logic without touching runtime wiring
- Rollback Path: revert progress-rendering method and its tests only
- Evidence Produced: `artifacts/test-ot-04-queue-progress.txt`
- Dependencies: `OT-02`
- Blocking Conditions: queue cannot render tracker events without breaking current batching or typing behavior
- Owner: queue implementor

#### OT-05

- Parent Task ID: `OT-P2`
- Objective: remove the current minimal-heartbeat mechanism from `src/runtimes/agent/outbound-queue.ts`
- Preconditions: `OT-04`
- Inputs: existing heartbeat fields and callers, queue tests, silent-failure controls
- Action: delete heartbeat-specific state and callers only
- Expected Output: no runtime path depends on `scheduleMinimalHeartbeat()` or equivalent heartbeat state
- Observable Signals: code search no longer finds heartbeat symbols; queue tests still pass
- Validation Method: code search plus full outbound-queue test lane
- Failure Modes: hidden heartbeat references remain; minimal mode loses liveness signals entirely
- Retry Path: remove lingering references or adjust tracker-rendering behavior
- Rollback Path: restore only heartbeat-related queue code if tracker replacement proves incomplete
- Evidence Produced: `artifacts/test-ot-05-heartbeat-removal.txt`
- Dependencies: `OT-04`
- Blocking Conditions: heartbeat removal causes unobservable silence or leaves dead timer state behind
- Owner: queue implementor

#### OT-06

- Parent Task ID: `OT-P2`
- Objective: add session recovery hooks for stalled operations and stalled thinking
- Preconditions: assumption `A-04` remains validated
- Inputs: `src/runtimes/agent/session.ts`, existing mock-child tests, recovery semantics from spec
- Action: implement `recoverStalledOperation()` and `probeLiveness()` only
- Expected Output: session exposes explicit recovery entry points that reuse the current child-process control path
- Observable Signals: session tests can assert the correct stdin writes and inactive-session no-op behavior
- Validation Method: targeted session recovery tests
- Failure Modes: no-op writes, unsafe recovery behavior, hidden dependency on provider-specific semantics
- Retry Path: tighten write behavior or guard clauses without demoting the watchdog yet
- Rollback Path: revert recovery methods and their tests only
- Evidence Produced: `artifacts/test-ot-06-session-recovery.txt`
- Dependencies: none
- Blocking Conditions: recovery hooks cannot be exercised with the current session abstraction
- Owner: session implementor

#### OT-07

- Parent Task ID: `OT-P2`
- Objective: demote the watchdog in `src/runtimes/agent/session.ts` to a hard backstop only
- Preconditions: `OT-06`
- Inputs: existing watchdog constants, session tests, recovery methods
- Action: remove soft and warn runtime behavior while preserving the hard-kill path only
- Expected Output: only the hard watchdog remains armed for normal execution
- Observable Signals: session tests prove soft/warn tiers no longer drive runtime behavior and hard-kill semantics still work
- Validation Method: targeted and regression session tests
- Failure Modes: hard watchdog removed accidentally; pending-tool cleanup regresses; old soft/warn logic still active
- Retry Path: restore hard-path semantics and re-run targeted tests
- Rollback Path: revert watchdog demotion commit slice only
- Evidence Produced: `artifacts/test-ot-07-watchdog.txt`
- Dependencies: `OT-06`
- Blocking Conditions: hard backstop behavior or shutdown cleanup becomes ambiguous
- Owner: session implementor

#### OT-08

- Parent Task ID: `OT-P3`
- Objective: wire tracker lifecycle into runtime event handling and session/queue callbacks
- Preconditions: `OT-02`, `OT-04`, `OT-06`, `OT-07`
- Inputs: runtime event-routing paths, queue interface, session hooks, tracker module
- Action: create tracker instances and wire start, end, activity, turn-complete, crash, and shutdown flows only
- Expected Output: runtime routes tracker callbacks correctly across current session scopes and event lifecycles
- Observable Signals: runtime tests prove tracker lifecycle is exercised by tool, text, and result events
- Validation Method: targeted runtime tests plus contradiction review against assumptions and blast radius
- Failure Modes: one runtime path unwired; tracker not cleared on result/crash; shared-mode queue routing broken
- Retry Path: fix the affected event path without changing tracker or queue contracts
- Rollback Path: revert runtime wiring changes only
- Evidence Produced: `artifacts/test-ot-08-runtime-wiring.txt`
- Dependencies: `OT-02`, `OT-04`, `OT-06`, `OT-07`
- Blocking Conditions: runtime cannot prove parity across the relevant event paths or session scopes
- Owner: runtime implementor

#### OT-09

- Parent Task ID: `OT-P3`
- Objective: update operator-facing docs for config and recovery behavior
- Preconditions: `OT-08`
- Inputs: final implementation diff, `docs/configuration.md`, `docs/runbook.md`, validation artifacts
- Action: document the new config block, user-visible progress semantics, and operator recovery expectations only
- Expected Output: docs reflect the implemented runtime behavior and evidence package
- Observable Signals: doc diff aligns with final code and no contradiction remains between docs and runtime
- Validation Method: documentation readiness review and contradiction pass
- Failure Modes: docs describe unimplemented behavior; operator recovery steps omit the new tracker path
- Retry Path: revise docs without changing runtime code
- Rollback Path: revert only docs if they are inaccurate
- Evidence Produced: `artifacts/test-ot-09-docs.txt`
- Dependencies: `OT-08`
- Blocking Conditions: final behavior is not stable enough to document accurately
- Owner: docs owner

### Atomicity Smell Tests

A task must be split again if any of the following are true:

- the task description contains `and` in a way that joins unrelated outputs
- the task changes both implementation and validation scope without a clear primary output
- the task has more than one owner
- the task can partially succeed without an observable signal
- the task requires hidden judgment that is not recorded in an artifact

### Exit Criteria

- The plan contains only independently executable, evidence-producing tasks with explicit dependencies, rollback paths, and blocker conditions.

## Verification Design

Verification is attached to the task that generated the claim. There is no free-standing "done" state outside named checks and named artifacts.

### Verification Rules

- Maintain `artifacts/verification_matrix.md` with one row per atomic task or critical transition.
- Prefer deterministic assertions, state inspection, contract conformance, diffs, replay validation, and independent cross-checks over narrative review.
- Structured outputs are preferred when available. If a lane only emits text, the text artifact must still state the check, verdict, and failure threshold.
- Reject `looks correct`, "green enough", typing-indicator behavior, and absence-of-error reasoning as sole proof.

### Required Verification Fields

Each matrix entry must state:

- task ID
- what is checked
- why it matters
- exact command or inspection method
- who or what performs the check
- expected output
- artifact path under `artifacts/`
- `Pass` condition
- `Fail` condition
- `Inconclusive` condition
- escalation path

### Gate Rules

- A task cannot close without its matrix row and its named artifact.
- If the output is textual, the artifact must still make the verdict auditable.
- If a check is skipped, the matrix row resolves to `Blocked` or `Inconclusive`, not `Pass`.
- Contradiction and final-review passes must reconcile their conclusions with this matrix rather than bypassing it.

### Exit Criteria

- `artifacts/verification_matrix.md` exists and covers every atomic task in this plan with explicit pass, fail, and inconclusive thresholds.

## Testing and Anti-Fabrication

Testing for this plan must prove truthfulness, not merely exercise code paths. Every test family must declare provenance, expected-result derivation, and replayability.

### Mandatory Test Categories

- unit tests
  - config defaults, threshold mapping, queue render helpers, tracker state transitions
- integration-style runtime tests
  - event wiring across runtime, queue, and session seams using existing Vitest harnesses
- negative tests
  - unknown tool IDs, inactive sessions, no-op recovery paths, missing config overrides
- regression tests
  - queue batching, typing behavior, watchdog hard-kill path, result cleanup behavior
- observability tests
  - logging or visible-signal assertions for slow, stalled, and recovery events
- degradation tests
  - `minimal` mode suppression rules, delayed tool completions, late result events
- adversarial tests
  - duplicate events, off-by-one timer thresholds, tracker clear-on-turn-end, stale-tool cleanup
- stale-data or partial-data tests
  - partial threshold overrides, missing tool name history, partial runtime activity

### Provenance Requirements

Every test family must state:

- input source: synthetic, sampled, captured fixture, or production-derived
- why the input is representative of the runtime seam being exercised
- how expected results were derived
- where replay evidence is stored under `artifacts/`
- how the result can be reproduced deterministically

For this plan, the default provenance preference is:

- synthetic plus fake timers for tracker and queue timing behavior
- existing repo fixtures and mocks for runtime/session/provider events
- captured fixture reuse only when it reduces ambiguity instead of hiding behavior

### Anti-Fabrication Controls

- A passing test may not serve as sole proof if the assertions are weaker than the claim.
- If a lane uses mocks, the mock contract must stay aligned with the real interface surface.
- A green lane with missing artifact capture is only `Inconclusive`.
- If a test family cannot be replayed locally, the plan must say why and what residual risk remains.
- "No error was thrown" is not sufficient proof for any critical behavior in this change.

### Deep Validation Ladder

Use when the criticality of the claim justifies it:

- contradiction checks against the verification matrix
- targeted logging or observability review
- replay with fake timers and mock child processes
- independent review of recovery-path tests

If mutation, contract, or property-based lanes are not used, record `not installed`, `skipped`, or `not applicable`; do not imply coverage.

### Verdict Rules

- `Pass`: test output and artifact capture prove the claim at the expected threshold
- `Fail`: test output disproves the claim
- `Inconclusive`: lane ran but did not prove the claim or artifact capture is missing
- `Blocked`: lane could not run because a prerequisite or tool was missing

### Exit Criteria

- The plan defines test categories, provenance rules, expected-result derivation, replay expectations, and anti-fabrication controls strongly enough that a green test lane cannot be mistaken for proof unless the evidence actually supports the claim.

## Final Review and Handoff

The final handoff for this plan must be self-contained. A fresh operator should be able to start from this file plus the named artifacts without reading prior chat or relying on informal memory.

### Required Handoff Package

The final handoff must include or reference:

- objective and scope
- explicit non-goals
- assumption register and dispositions
- primary, secondary, and tertiary validation findings
- readiness decision and rationale
- atomic task map and execution order
- verification matrix
- logging and observability standards
- testing and provenance rules
- error model, silent-failure matrix, and error catalog
- tooling plan and execution boundaries
- contradiction and final-review verdicts
- open risks, blockers, and rollback guidance

### Reproduce This Run

A fresh operator must be able to reproduce the review or implementation setup using:

- tool versions from `artifacts/run_manifest.json`
- repo identity from `artifacts/git_sha.txt`
- run identity from `artifacts/run_id.txt`
- baseline repo evidence under `artifacts/`
- exact validation and execution commands named in `artifacts/verification_matrix.md`, `artifacts/test_strategy.md`, and `artifacts/linting_plan.md`

### Fresh-Operator Start Conditions

- work from `/home/q/LAB/WhatSoup`
- refresh or inspect `artifacts/run_manifest.json`
- read this plan in order
- confirm readiness state in `artifacts/readiness.json`
- start only the next allowed action named in the readiness record

### Final Review Checklist

- missing dependencies
- unresolved critical assumptions
- weak or artifact-free verification steps
- vague readiness language
- unbounded tasks
- missing blocker logic
- insufficient telemetry requirements
- missing provenance rules
- unsupported claims or contradictions

### Release-Grade Artifact Posture

- SBOM, provenance attestation, and signed release outputs are out of scope for this runtime-internal plan unless a later release-management workflow explicitly adopts them.
- If release-grade artifacts become required later, they must be added explicitly rather than implied by this plan.

### Exit Criteria

- A fresh operator can use this plan file and the named artifacts as the single source of truth for reproduction, review, and safe execution.

## Master Orchestrator

This section defines the execution order for the whole plan. Work may not jump ahead of its gate or silently reorder dependencies.

### Phase Order

1. Review completion
   - finish passes 1-27
   - refresh `artifacts/readiness.json`
   - confirm contradiction and final-review artifacts are valid
2. Implementation foundation
   - execute `OT-01` through `OT-03`
   - do not start queue or runtime integration until tracker and timer behavior are proven
3. Integration
   - execute `OT-04` through `OT-08`
   - preserve rollback boundaries so queue, session, and runtime changes can be isolated
4. Documentation and operator closeout
   - execute `OT-09`
   - reconcile docs with final runtime behavior
5. Final verification and handoff
   - update contradiction, regression, and final-review artifacts
   - close only after readiness remains acceptable and no blocker is open

### Cross-Section Dependency Rules

- Readiness may authorize implementation, but verification, contradiction, and final-review artifacts still control closeout.
- The assumption register governs whether a task may start; the verification matrix governs whether it may finish.
- Logging and error-handling standards apply to every implementation task, not only to closeout.
- Documentation is downstream of stable behavior, but it is upstream of final closeout.

### Stop Conditions

- halt if a required artifact is missing
- halt if a contradiction appears between runtime behavior and documentation claims
- halt if a required validation layer is skipped
- halt if a rollback path becomes unclear after a code change

### Resume Conditions

- resume only after the blocking artifact or decision is recorded
- update `artifacts/run_manifest.json` when work restarts after a halt
- restate the next allowed action in `artifacts/readiness.json` if readiness changed during the halt

### Exit Criteria

- The plan defines one ordered execution model that connects review, implementation, documentation, and closeout without hidden sequencing assumptions.

## Existing Surface and Reuse-First Audit

New surfaces are allowed only after existing repo surfaces are searched and ruled in or out explicitly.

### Required Reuse Inputs

- `artifacts/reuse_scan.txt`
- `artifacts/repo_file_index.txt`
- `artifacts/risk_surface_hits.txt`
- `artifacts/public_surface_hints.txt`

### Candidate Reuse Points Already Identified

- `src/runtimes/agent/providers/tool-mapping.ts`
  - reuse the existing `ToolCategory` contract instead of inventing a parallel tracker category model
- `src/runtimes/agent/outbound-queue.ts`
  - extend the queue with tracker-event rendering rather than adding a second status-delivery path
- `src/runtimes/agent/session.ts`
  - reuse the current child-process stdin control path and watchdog state instead of introducing a new process-controller abstraction
- `src/runtimes/agent/runtime.ts`
  - wire tracker lifecycle into existing event routing instead of creating a side-channel event bus
- existing tests:
  - `tests/config.test.ts`
  - `tests/runtimes/agent/outbound-queue.test.ts`
  - `tests/runtimes/agent/session.test.ts`
  - `tests/runtimes/agent/runtime.test.ts`
  - `tests/runtimes/agent/logging-coverage.test.ts`

### Reuse-First Rules

- Search for existing helpers, adapters, tests, and docs before proposing new files or abstractions.
- Reuse is the default when an existing surface can be extended without creating hidden coupling.
- If reuse is rejected, record the rejected candidate, why it was insufficient, and what duplication risk remains in `artifacts/reuse_audit.md`.
- Do not add a second queue-like progress-delivery system, second watchdog mechanism, or second category taxonomy.

### Blockers

- A new abstraction is proposed without naming the reuse candidates that were considered.
- A task introduces a parallel lifecycle or duplicate timer system where an existing one can be extended safely.
- The plan cannot explain why a new file is needed instead of extending a current runtime surface.

### Exit Criteria

- The plan makes it impossible to add new tracker-adjacent code paths or abstractions without first proving the existing runtime, queue, session, and test surfaces were inspected.

## Impact Analysis and Blast Radius

This change has a contained file scope but a meaningful behavioral blast radius because it changes timing, recovery, and user-visible progress messaging inside the agent runtime.

### Directly Affected Modules

- `src/config.ts`
- `src/runtimes/agent/operation-tracker.ts` (new)
- `src/runtimes/agent/outbound-queue.ts`
- `src/runtimes/agent/session.ts`
- `src/runtimes/agent/runtime.ts`
- corresponding tests under `tests/config.test.ts` and `tests/runtimes/agent/*`
- `docs/configuration.md`
- `docs/runbook.md`

### Indirectly Affected Behaviors

- WhatsApp-visible progress and stall messaging across `full`, `friendly`, and `minimal` modes
- composing-indicator behavior during long operations and compaction
- session recovery and hard-kill timing
- operator expectations for diagnosing stalls or silent turns
- log and audit consumers that depend on watchdog or recovery messages

### Public or External Surfaces

- instance `config.json` schema documented in `docs/configuration.md`
- user-facing runtime message behavior mediated by `toolUpdateMode`
- operator-facing runbook and log expectations

No HTTP API route, MCP schema, database schema, or migration contract is expected to change in this plan.

### Jobs, Queues, and Scheduled Work

- outbound queue batching and typing refresh are directly impacted
- session watchdog timers are directly impacted
- no cron job, migration, or database queue is expected to change

### Permissions and Trust Boundaries

- no new MCP or plugin permission surface should be introduced
- recovery hooks operate inside the existing provider subprocess trust boundary
- because the provider subprocess already runs with existing agent permissions, recovery behavior must be narrowly scoped and fully logged

### Rollback and Partial-Deploy Risks

- queue rendering, session recovery, and runtime wiring must be rolled back together if user-visible behavior regresses
- docs may be reverted independently only if the runtime behavior remains unchanged
- partial application of runtime wiring without session or queue updates is invalid and must be treated as a failed deploy state

### Required Blast-Radius Artifact

Maintain `artifacts/blast_radius.md` summarizing:

- affected modules and callers
- public surfaces and schema implications
- jobs, queues, and timer surfaces
- trust boundaries
- rollback exposure and containment triggers

### Exit Criteria

- A reviewer can see what might break, what must be coordinated, and what must be rolled back if the OperationTracker change is incomplete or wrong.

## Error Model and Exception Handling

The plan must treat failures as concrete classes with defined detection, handling, and containment paths.

### Required Error Classes

- validation failure
  - example: targeted test lane fails or verification artifact is missing
- dependency failure
  - example: required runtime seam or helper behaves differently than assumed
- timer or threshold failure
  - example: tracker slow/stall boundary or thinking-gap logic fires at the wrong time
- recovery-path failure
  - example: interrupt or liveness probe is not sent or does not trigger the expected follow-up path
- rendering failure
  - example: queue shows the wrong mode-specific status or duplicates progress output
- rollback failure
  - example: a partial revert leaves queue, session, and runtime behavior inconsistent
- partial-success state
  - example: tracker emits events but runtime cleanup or doc updates are missing
- quarantine or dead-letter equivalent
  - example: not applicable for persistent tracker state, but contradictory artifacts must be quarantined in final review instead of treated as passable noise

### Required Handling Fields Per Error Class

For each major error class, the plan must define:

- detection method
- handling path
- logging and tracing requirement
- user-visible behavior
- operator-visible behavior
- containment or escalation path
- artifact or evidence expectation under `artifacts/`

### Handling Rules

- validation failures block closeout until the failing or missing artifact is resolved
- dependency failures force a reuse or blast-radius re-check before implementation continues
- timer or threshold failures require deterministic fake-timer reproduction before code proceeds
- recovery-path failures require tertiary validation because they affect trust and liveness
- rendering failures must be tested in all three `toolUpdateMode` variants
- rollback failures require an explicit containment decision in the contradiction or final-review artifact

### Required Output

Maintain `artifacts/error_model.md` with the error classes above, their detection paths, handling rules, and evidence references.

### Exit Criteria

- Failures are described as explicit, traceable paths with detection, handling, and evidence expectations rather than as generic "errors may occur" prose.

## Silent Failure and Degraded Mode Detection

Silent failure is a first-class defect in this plan. A progress feature that masks broken recovery, broken cleanup, or fake liveness is worse than no feature.

### Silent Failure Modes That Must Be Reviewed

- swallowed exceptions during tracker callbacks or shutdown
- noop fallbacks where recovery methods return without an observable signal
- partial success where tracker emits progress but runtime never clears state
- stale or cached success where a previous status message is mistaken for live progress
- dropped async work such as unflushed queue state or missed timer cleanup
- mismatched health signals where typing continues but the provider is stalled
- missing alerts when a recovery path or hard watchdog fires
- success without validation, especially for heartbeat removal and watchdog demotion

### Required Detection Fields Per Failure Mode

For each silent failure mode, define:

- how it is detected
- what telemetry proves it
- what alert or audit trail exists
- how the plan prevents it from being mistaken for success
- what artifact records the evidence

### Required Artifact

Maintain `artifacts/silent_failure_matrix.md` with one row per failure mode and the fields above.

### Gate Rules

- If a failure mode has no detection method or no evidence artifact, the related task may not close.
- If typing or progress output can persist after tracker or session failure, contradiction review must downgrade the verdict.
- If a fallback path suppresses an error without leaving an operator-visible signal, treat it as `Fail` until corrected.

### Exit Criteria

- The plan explains how silent failure is detected, surfaced, and blocked from masquerading as a pass condition.

## Error Messaging and Traceability

Error reporting in this plan must be descriptive enough for an operator to diagnose the problem and narrow enough that user-facing messages do not leak sensitive detail.

### Required Error-Message Fields

Every operator-facing error or diagnostic for this change must specify:

- what failed
- where it failed
- correlation or trace handle when available
- whether the message is user-facing or operator-facing
- remediation hint when one is safe and actionable
- redaction constraints
- referenced evidence or artifact paths under `artifacts/`

### Rejected Error Styles

- `something went wrong` without context
- silent catches
- untraceable IDs or no IDs at all
- user-visible recovery messages with no operator-facing companion evidence
- diagnostics that omit the affected tool, session, or event class

### Required Artifact

Maintain `artifacts/error_catalog.md` with:

- error class
- code or identifier
- message shape
- user-facing or operator-facing audience
- traceability fields
- remediation hint
- evidence location

### Exit Criteria

- Failure reporting is specific, traceable, and safe to expose, and an operator can diagnose the issue from logs and artifacts alone.

## TDD, Test Provenance, and Independent Validation

Implementation-facing tasks in this plan use TDD unless the task is documentation-only. A green test is valid only when the red phase, provenance, and replay path are preserved.

### TDD Scope

- TDD is mandatory for `OT-01` through `OT-08`.
- `OT-09` may use documentation review rather than red-green-refactor, but it still needs explicit verification artifacts.

### Red-Phase Rules

- Before implementation, add or select a failing targeted test that proves the intended behavior is currently absent or broken.
- Record the failing lane in a named artifact before changing implementation code.
- A test that was never observed failing for the target behavior does not satisfy the red phase.

### Deterministic Validation Rules

- Timer and recovery behavior must use fake timers or other deterministic harnesses.
- Mock-based tests must prove the real public interface shape rather than a narrowed local fiction.
- If deterministic proof is unavailable, the task cannot resolve higher than `Inconclusive` without explicit contradiction review.

### Provenance and Replay Rules

- Every test artifact must record whether inputs are synthetic, sampled, captured, or production-derived.
- Expected results must be derived from the spec, current runtime contract, or directly observed failing behavior.
- Replay instructions must name the exact test command and the artifact path that captured the run.

### Independent Validation Triggers

- independent validation is mandatory for watchdog demotion, recovery-path changes, and silent-failure protections
- contradiction review is mandatory when tests pass but observability or documentation evidence disagrees

### Required Artifact

Maintain `artifacts/test_strategy.md` with TDD scope, red-phase verification, deterministic validation, provenance, independent validation, and replay instructions.

### Exit Criteria

- The plan defines where TDD is mandatory, what counts as a real red phase, how deterministic validation is achieved, and how test artifacts can be replayed and audited.

## Tooling, Skills, MCPs, Plugins, and Subagents

Tool selection for this plan must be explicit. Hidden delegation or vague references to future tooling are not allowed.

### Required Local Tools

- `rg` for repo search and proof of heartbeat/watchdog removal
- `npx vitest run` for targeted and regression validation
- `tsc --noEmit` or repo typecheck lane when static guarantees are required
- `git diff`, `git status`, and `git grep` for blast-radius and closeout review
- `python3` for the PlanPrompt helper scripts and artifact checks

### Required Skills

- `test-driven-development` for implementation-facing tasks
- `systematic-debugging` if any targeted lane fails unexpectedly
- `verification-before-completion` before claiming the work is done
- `planprompt-review` for this review run only

### Relevant MCPs and Plugins

- global MCPs visible in the current environment: `playwright`, `pinecone`
- relevance to this plan:
  - `pinecone`: optional historical-context lookup only; not required for implementation correctness
  - `playwright`: not applicable unless a later operator chooses to test a UI surface, which is currently out of scope
- repo-local plugin surface: `plugins/q-image` exists but is not relevant to OperationTracker work

### Subagent and Parallelism Rules

- parallel read-only analysis is allowed when tasks do not share state
- code-writing parallelism is allowed only when write scopes are disjoint and ownership is explicit
- in the current execution environment, actual subagent spawning requires explicit authorization from the operator or user; do not assume it is available by default

### Ownership and Write Scope

- tracker/config lane: `src/config.ts`, `src/runtimes/agent/operation-tracker.ts`, related tests
- queue lane: `src/runtimes/agent/outbound-queue.ts`, related tests
- session lane: `src/runtimes/agent/session.ts`, related tests
- runtime/docs lane: `src/runtimes/agent/runtime.ts`, runtime tests, `docs/configuration.md`, `docs/runbook.md`

### Evidence Ownership

- every tool or lane must emit artifacts under `artifacts/`
- task-specific test output files map back to the verification matrix
- contradiction and final-review artifacts reconcile cross-lane results

### Deterministic Validation Safeguards

- do not let parallel work bypass the verification matrix
- no lane may claim completion without its named artifact
- merge order follows the master orchestrator; later lanes may not silently rework earlier verified outputs

### Exit Criteria

- The plan makes tool selection, skill usage, MCP relevance, delegation boundaries, and evidence ownership explicit enough to prevent hidden overlap or unbounded execution.

## Contradiction and Integration Check

Before final closeout, the whole plan must be reviewed for contradictions across scope, readiness, testing, observability, reuse, error handling, and documentation.

### Required Checks

- contradictions between sections
- unsupported claims
- unresolved blockers hidden by later prose
- mismatch between readiness and evidence
- mismatch between error handling and observability
- mismatch between testing claims and provenance
- mismatch between reuse-first analysis and proposed implementation

### Required Artifact

Maintain `artifacts/contradiction_check.md` with:

- sections updated
- major cross-pass upgrades
- contradictions found
- contradictions resolved
- unresolved risks
- current verdict

### Gate Rules

- If contradictions remain unresolved, the verdict must be `Blocked` or `Inconclusive`.
- If the contradiction artifact says `Pass`, then contradictions found and unresolved risks must be empty in substance.
- Final closeout may not weaken a contradiction finding without updating the artifact explicitly.

### Exit Criteria

- The plan is internally coherent enough to proceed to final synthesis, and the contradiction artifact states that verdict explicitly.

## Linting, Formatting, and Static Quality Gates

Fast quality gates must be explicit. This repo does not expose a root lint script in `package.json`, so the plan names the real gates instead of implying hidden tooling.

### Required Gates

- whitespace and patch hygiene
  - `git diff --check`
- TypeScript compile safety
  - `npm run typecheck`
- targeted regression safety
  - task-specific Vitest commands from the verification matrix
- full regression safety when required by scope
  - `npm test --silent`

### Warning vs Blocker Rules

- any `git diff --check` failure is a blocker
- typecheck failures are blockers for implementation closeout
- targeted test failures are blockers for the task they validate
- full-repo test failures are blockers unless isolated and documented as pre-existing with evidence
- absence of a root formatter script is not itself a blocker, but formatting drift found in diff review is

### Required Artifact

Maintain `artifacts/linting_plan.md` with tool name, command, expected output, blocking threshold, artifact path, and owner.

### Exit Criteria

- The plan states exactly which fast quality gates must pass, what they emit, and what blocks progress.

## Regression Protection and Change Safety

Regression protection for this plan is surface-specific. The plan must state what existing behavior is at risk, how it is protected, and what signal triggers rollback or containment.

### Protected Behaviors

- config loading remains backward compatible for instances without `operationTracker`
- queue batching and typing behavior remain coherent while tracker events are introduced
- `minimal` mode stays low-noise without becoming silent or duplicative
- hard watchdog kill path remains available
- runtime clears tracker and tool state on result, crash, shutdown, and turn replacement
- docs match final config and operator behavior

### Regression Controls

- targeted and regression Vitest lanes from the verification matrix
- code search proving minimal-heartbeat removal
- contradiction review across readiness, docs, and silent-failure artifacts
- final closeout review before accepting the plan as implementation-ready

### Required Artifact

Maintain `artifacts/regression_protection.md` with protected behavior, protection mechanism, regression signal, evidence source, and rollback or mitigation trigger.

### Exit Criteria

- The plan shows how regressions will be detected, proven, and contained instead of assuming existing behavior remains correct by default.

## Hooks, Automation, and Workflow Enforcement

Hooks and automation are enforceable workflow controls, not suggestions.

### Local Automation Expectations

- pre-commit or equivalent local checks should run fast static gates such as `git diff --check` and task-scoped validation where practical
- pre-push or equivalent local checks should run `npm run typecheck` and the targeted Vitest lanes touched by the change
- local bypasses are allowed only when recorded in `artifacts/hook_plan.md` with reason and compensating validation

### CI Automation Expectations

- CI should run the repo's typecheck lane and the relevant Vitest coverage for the touched runtime surfaces
- if the repo lacks a dedicated CI job for this change today, the plan must say so and rely on recorded local evidence rather than implying hidden automation

### Failure Behavior

- hook or automation failures block the affected stage until rerun or explicitly dispositioned
- bypasses must name the skipped command, the reason, and the replacement evidence artifact

### Required Artifact

Maintain `artifacts/hook_plan.md` with hook or automation name, trigger point, command or policy enforced, blocking behavior, override behavior, and evidence artifact.

### Exit Criteria

- The plan treats hooks and automation as explicit controls with trigger points, failure behavior, and auditable override rules.

## Rules, Policies, and Guardrails

This plan has hard constraints that must remain enforceable even if implementation pressure increases.

### Code-Level Rules

- do not introduce database or migration changes
- do not add a parallel progress-delivery or watchdog mechanism
- preserve callback-based separation between tracker, queue, and session
- preserve the hard watchdog backstop

### Workflow Rules

- every task maps to a verification-matrix row
- every bypass or skipped lane must be recorded with replacement evidence
- docs and operator guidance are part of closeout, not optional follow-up

### Environment and Access Rules

- work from the repo root
- use the existing Node.js, TypeScript, and Vitest stack
- treat optional tooling and subagent usage as unavailable unless explicitly present and authorized

### Security and Privacy Rules

- do not expand permission or MCP access scope for this feature
- do not log secrets, raw credentials, or unnecessary user content in tracker-related logs
- recovery messages must be safe for user exposure and traceable for operators

### Blockers vs Warnings

- blocker: breaking a hard rule above without an explicit plan amendment
- warning: a non-critical evidence gap that is recorded and constrained without contradicting readiness

### Exception Path

- any exception must be documented in `artifacts/rules_and_guardrails.md` with rationale, enforcement point, blocking condition, and evidence location
- undocumented exceptions are treated as blockers

### Exit Criteria

- Another operator can apply the same rules consistently without relying on informal repo lore.

## Documentation, Runbooks, and DevOps Readiness

Documentation and operational readiness are part of the final package for this plan. They are not follow-up ideas.

### Required Documentation Deliverables

- `docs/configuration.md` updates for the `operationTracker` instance config block
- `docs/runbook.md` updates for slow, stalled, recovery, and hard-watchdog behavior
- review artifacts under `artifacts/` that explain how to reproduce and verify the change

### DevOps and Workflow Readiness

- note whether any CI or release workflow needs adjustment for new targeted lanes
- note that no new environment variable, service, or deployment surface is expected for this runtime-internal change
- record any operational risks that remain after the implementation is complete

### Required Artifact

Maintain `artifacts/documentation_devops_readiness.md` with:

- sections updated
- major cross-pass upgrades
- documentation and devops deliverables
- unresolved risks
- current verdict
- reproduction-ready deliverables

### Exit Criteria

- The plan is documentation-complete, devops-aware, and reproducible enough that an operator does not need unwritten context to validate or roll back the change.

## Capability Inventory, Skills, MCPs, and Historical Context

The plan must inventory the real capabilities available in this environment before final closeout. Hidden tooling assumptions are not allowed.

### Available Skills Relevant to This Plan

- `using-superpowers` for skill discovery discipline
- `planprompt-review` for the hardening procedure used in this run
- `test-driven-development` for implementation tasks
- `systematic-debugging` for failing lanes
- `verification-before-completion` for closeout discipline

### Available Scripts Relevant to This Plan

- PlanPrompt helpers under `/home/q/.codex/skills/planprompt-review/scripts/`
- repo validation commands exposed through `package.json`
- git and ripgrep for history and code-surface inspection

### Available Agents and Delegation Limits

- the execution environment supports agent roles, but actual subagent spawning must remain explicitly authorized during implementation
- safe parallelism exists for disjoint read-only analysis or disjoint write scopes only

### Available Plugins and MCPs

- repo-local plugin: `plugins/q-image` (not relevant to this plan)
- environment MCPs: `pinecone`, `playwright`
- current relevance:
  - `pinecone`: optional historical-context lookup only
  - `playwright`: not required for the current runtime-internal scope

### Historical Context Sources

- `git log`, `git diff`, `git show`, and recent-hot-file evidence under `artifacts/`
- earlier repo docs and reviews surfaced in `artifacts/repo_file_index.txt`
- optional Pinecone retrieval if historical docs are indexed and the operator wants extra context

### Mandatory Reinforcement

- use subagent-driven development only when decomposition is safe and authorization exists
- use effective parallelism only for independent lanes
- use TDD for implementation-facing work
- require deterministic validation for meaningful correctness claims

### Rejected Capability Assumptions

- hidden tool usage
- vague promises to use MCPs later
- unbounded subagent work
- parallelism without coordination rules
- nondeterministic validation presented as proof

### Exit Criteria

- The plan is capability-aware, explicit about available execution machinery, and honest about missing or optional support.

## Final Synthesis and Capability-Aware Closeout

The hardened plan is now internally consistent, capability-aware, and execution-ready. It converts the original implementation draft into a repo-grounded operating document with explicit artifacts, gates, and rollback boundaries.

### Final Capability-Aware Synthesis

- The repo already contains the necessary runtime surfaces, test harnesses, and logging infrastructure to implement OperationTracker without inventing new platform machinery.
- The plan preserves the existing hard watchdog backstop while making progress reporting and targeted recovery explicit and testable.
- Full-repo `npm test --silent` completed successfully during this review run, and `npm run typecheck` completed successfully, so the plan's quality-gate assumptions are grounded in current repo evidence.

### Historical Context Summary

- Git history and the current artifact set are the primary historical-context sources for this change.
- Pinecone is optional and can supplement historical context if indexed docs are available, but it is not required for correctness or closeout.

### Final Closeout Rules

- Begin implementation at `OT-01` and follow the master orchestrator in order.
- Keep `artifacts/run_manifest.json` current during implementation and record task-level evidence under the artifact paths already named in this plan.
- If a later implementation run introduces a contradiction or blocker, downgrade readiness and final-review verdicts rather than overriding them silently.

### Exit Criteria

- The plan is internally consistent, historically grounded, operationally reproducible, and ready to drive implementation without relying on unwritten context.
