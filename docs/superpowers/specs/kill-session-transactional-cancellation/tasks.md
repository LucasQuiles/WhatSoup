# Transactional `/kill-session` Cancellation Implementation Tasks

> **Status:** pending
> **Spec:** `docs/superpowers/specs/kill-session-transactional-cancellation/`
> **REQUIRED COMPANION SKILL:** `superpowers:spec-driven-development`
> **For agentic workers:** Execute one task at a time, preserve RED evidence,
> request review at the named checkpoints, and do not deploy before merge.

**Goal:** Make targeted `/kill-session` preemptive, generation-fenced, durably
accounted, replay-unsafe, recoverable, and isolated across all session scopes.

**Architecture:** A dedicated local control lane captures an exact session target;
a focused cancellation coordinator closes queue admission, terminalizes turns by
publication state through existing durability owners, stops only the target child,
and releases or reopens state through an idempotent proof barrier.

**Tech Stack:** TypeScript, Vitest, Node 24 `node:sqlite`, WhatSoup
`DurabilityEngine`, `RuntimeTurnSupervisor`, `SessionOwnershipRegistry`,
`TurnQueue`, `SessionManager`, and the existing repository guards.

---

## Planning Preamble

- Work in a fresh branch from the then-current `origin/main`; reconcile this
  plan's baseline before implementation and record any drift as an amendment.
- Use existing repository dependencies and pinned wrappers. Do not run a raw
  installer, replace state/settings, or deploy from a worktree.
- Preserve unrelated user changes and do not modify the provider-event lifecycle
  or whole-service shutdown branches.
- Every production slice begins from a focused failing test and ends with a
  focused commit. Do not combine all state-machine changes into one commit.
- The exact twelve-case RED matrix is normative. The earlier eleven-count folded
  unaffected-chat continuity into terminal-sink retention; `CHK-012` now owns that
  distinct isolation setup.

## Sequencing and Dependencies

```text
TSK-001 RED suite/harness
   -> TSK-002 taxonomy contract
   -> TSK-003 per-chat queue + terminalization slice
   -> TSK-004 preemptive shared/single control slice
   -> TSK-005 retained recovery, fencing, alias, and isolation hardening
   -> TSK-006 full verification, review, PR, and post-merge targeted rollout
```

`TSK-002` may begin only after the RED suite compiles against baseline behavior.
`TSK-003` and `TSK-004` must not weaken the failures owned by `TSK-005`.
`TSK-006` begins only when all behavior checks are green and the working tree has
been audited for scope.

## Risks and Rollback

- **False success after terminal failure:** retain the exact target graph and
  return degraded; rollback is code-only because no schema changes are allowed.
- **Wrong target after numeric-index shift:** capture object identity before
  serialization; a stale operation never re-resolves its index.
- **Evidence destruction or replay:** abort presentation with
  `preserveEvidence: true`, latch replay false before finalization, and assert
  blocked-unsafe recovery for pending/submitted/maybe-sent evidence.
- **Completion deadlock:** after-terminal callbacks mark proof and schedule release;
  they never await queue idle or an unbounded recovery waiter.
- **LID alias race:** all post-capture map access resolves the mutable scope ref and
  still checks captured object identity.
- **Stale generation output:** global and per-chat callbacks reject mismatched
  session object/manager/generation before any event or crash handler.
- **Collateral outage:** no service restart fallback; `CHK-012` keeps an unrelated
  chat live while the target remains degraded.

## Validation Strategy

The focused suite uses a real in-memory `Database`, real `DurabilityEngine`, and
real `TurnQueue`; session/provider/outbound seams are controllable fakes. Each
conformance test carries one planned `@check` and one fully qualified `@traces`
marker. Test failures must be bounded with deferred promises or fake timers so a
regression reports an assertion rather than hanging the suite.

The implementation is complete only after focused tests, schema/terminal tests,
typecheck, lint, test-integrity, publication/work-index guards, full tests, and two
independent reviews pass. Deployment is a separate, post-merge targeted operation.

---

## Tasks

#### TSK-001: Build the real-durability RED conformance harness
- **Status:** pending
- **Traces-from:** CON-003, CON-004, DES-009
- **Owns-AC:** CON-003.AC-03, CON-004.AC-01
- **Checks:** CHK-024, CHK-025
- **Files:**
  - Create: `tests/runtimes/agent/kill-session-transactional-cancellation.test.ts`
  - Create: `tests/runtimes/agent/lib/kill-session-cancellation-harness.ts`
  - Reference: `tests/runtimes/agent/lib/runtime-terminal-coordinator-harness.ts`
  - Reference: `tests/runtimes/agent/runtime-terminal-coordinator-integration.test.ts`
  - Reference: `tests/runtimes/agent/runtime.test.ts`
- **Steps:**
  1. Build a harness around `new Database(':memory:')`, `db.open()`, a real
     `DurabilityEngine`, a real `TurnQueue`, deterministic inbound rows, deferred
     provider/session/evidence promises, and outbound/session fakes that expose
     stop, evidence, and callback order without mocking terminal persistence.
  2. Keep the suite and helper separately reviewable; reuse the canonical runtime
     terminal harness rather than copying its database/context builders when the
     existing exports are sufficient.
  3. Add these twelve tests, with the marker pair as the first two lines inside
     each test body:

     | Check | Trace | RED scenario and required assertions |
     |---|---|---|
     | `CHK-001` | `REQ-002.AC-01` | Published active per-chat turn records one `failed/operator_cancelled`, preserves evidence, settles completion, releases exact owners, then a fresh third turn dispatches. Baseline fails because published work is skipped and state is deleted. |
     | `CHK-002` | `REQ-002.AC-02` | Active-unpublished, pending-at-close, and late-admission turns become operator-cancelled/admission-rejected without FIFO drift or provider dispatch. Baseline fails because pending turns receive the active scope and cancellation is crash-typed. |
     | `CHK-003` | `REQ-002.AC-03` | Shared active plus cross-chat pending turns are all accounted, and the original global queue is reopened/reused. Baseline fails because shared cancellation does not finalize the queue. |
     | `CHK-004` | `REQ-001.AC-01` | Singleton provider turn remains blocked, yet `/kill-session` reaches target shutdown before provider release. Baseline fails because the command is behind `turnChain`. |
     | `CHK-005` | `REQ-003.AC-01` | LID rekey occurs while evidence flush is blocked; release follows the mutable ref and cleans only the final canonical key once. Baseline fails through stale-key deletion/leak. |
     | `CHK-006` | `REQ-003.AC-02` | Parameterize pending, submitted, and maybe-sent answer evidence; each transfer is replay-unsafe, blocked from runnable replay, and retains evidence. Baseline fails because kill aborts without evidence preservation or skips the published context. |
     | `CHK-007` | `REQ-003.AC-03` | Inject terminal-sink failure: target child stops, state remains retained/degraded, no clean acknowledgement is sent, and a later successful retry releases exactly once. Baseline deletes state and reports success after failure. |
     | `CHK-008` | `REQ-002.AC-04` | A journaled queued turn without immutable context stops the child but retains the closed queue/owner and reports invariant degradation. Baseline silently skips and deletes it. |
     | `CHK-009` | `REQ-001.AC-04` | Invoke a late old singleton/shared event/result callback after replacement; it cannot mutate new state or enqueue output. Baseline callback closures route directly to current global handlers. |
     | `CHK-010` | `REQ-001.AC-02` | Two concurrent identical kills capture one target; the second cannot kill the session that shifts into index 1 after release. Baseline re-resolves inside serialized message handling and kills the shifted target. |
     | `CHK-011` | `REQ-001.AC-03` | With target provider still blocked or target finalization retained, the command inbound reaches `local_command_handled` exactly once while target rows remain independently owned. Baseline command durability is blocked behind the target turn. |
     | `CHK-012` | `REQ-004.AC-01` | During retained target failure, a separately seeded chat dispatches/completes and its maps/rows stay unchanged while the target graph remains retained. Baseline fails the target-retention half; this separate second-chat setup prevents future collateral cleanup. |

  4. Add `CHK-024` as a harness contract proving real SQLite, real durability,
     real queue, unique inbound identities, and controlled external seams.
  5. Run the focused suite against the untouched baseline. Every `CHK-001` through
     `CHK-012` must fail for the named behavioral reason, not a missing import,
     unhandled rejection, leaked timer, or TypeScript compile error. `CHK-024`
     should pass as harness proof.
  6. Preserve the exact RED output in the task/review evidence before changing
     production files. If any named case unexpectedly passes, stop and amend its
     setup or the requirement; never weaken the assertion to manufacture RED.
- **Verification:**
  - `npm test -- tests/runtimes/agent/kill-session-transactional-cancellation.test.ts --pool=forks --fileParallelism=false --retry=0`
  - `npm run guard:test-integrity`
- **Commit:** `test(agent): specify transactional kill-session cancellation`

#### TSK-002: Add the code-bounded `operator_cancelled` terminal contract
- **Status:** pending
- **Traces-from:** CON-001, DES-006
- **Owns-AC:** CON-001.AC-01, CON-001.AC-02, CON-001.AC-03
- **Checks:** CHK-016, CHK-017, CHK-018
- **Files:**
  - Modify: `src/runtimes/agent/turn-terminal.ts`
  - Modify: `src/core/inbound-failure-class.ts`
  - Modify: `src/core/turn-finalization-contract.ts`
  - Modify: `tests/runtimes/agent/turn-terminal-model.test.ts`
  - Modify: `tests/core/inbound-failure-class.test.ts`
  - Modify: `tests/core/turn-finalization-hardening.test.ts`
  - Modify: `tests/core/durability-schema.test.ts`
  - Modify: `tests/core/migration-safety.test.ts`
- **Steps:**
  1. Add failing contract tests: exact `operator_cancelled` is accepted; unknown
     strings remain coerced/rejected; terminal persistence writes
     `attempt_kind='failed'`, `attempt_failure_class='operator_cancelled'`, inbound
     `failure_class='operator_cancelled'`, and existing `terminal_reason='error'`.
  2. Extend `AttemptOutcome`, `InboundFailureClass`, `INBOUND_FAILURE_CLASSES`,
     `toInboundMutation`, `TERMINAL_PROVIDER_FAILURE_CLASSES`-adjacent validation,
     and `expectedTerminalInboundFailureClass` with the smallest exact mapping.
     Do not classify operator cancellation as provider failure or session crash.
  3. Add schema assertions that both failure-class columns remain existing TEXT
     fields with the current CHECK-free/code-bounded contract. Assert no new
     migration number or migration file exists in the diff.
  4. Run the focused terminal/schema tests, then typecheck. Inspect
     `git diff -- src/core/database*` and prove it is empty.
- **Verification:**
  - `npm test -- tests/runtimes/agent/turn-terminal-model.test.ts tests/core/inbound-failure-class.test.ts tests/core/turn-finalization-hardening.test.ts tests/core/durability-schema.test.ts tests/core/migration-safety.test.ts --pool=forks --fileParallelism=false --retry=0`
  - `npm run typecheck:all`
  - `test -z "$(git diff --name-only -- 'src/core/database*.ts')"`
- **Commit:** `feat(agent): classify operator-cancelled turns without migration`

#### TSK-003: Implement per-chat admission fencing and exact turn terminalization
- **Status:** pending
- **Traces-from:** REQ-002, REQ-003, DES-003, DES-004
- **Owns-AC:** REQ-002.AC-01, REQ-002.AC-02, REQ-002.AC-04, REQ-003.AC-01
- **Checks:** CHK-001, CHK-002, CHK-005, CHK-008
- **Files:**
  - Create: `src/runtimes/agent/runtime-session-cancellation.ts`
  - Modify: `src/runtimes/agent/turn-queue.ts`
  - Modify: `src/runtimes/agent/runtime-turn-coordinator.ts`
  - Modify: `src/runtimes/agent/runtime.ts`
  - Modify: `tests/runtimes/agent/turn-queue.test.ts`
  - Modify: `tests/runtimes/agent/kill-session-transactional-cancellation.test.ts`
  - Modify: `tests/runtimes/agent/lib/kill-session-cancellation-harness.ts`
- **Steps:**
  1. Add failing `TurnQueue` unit tests for non-destructive close/snapshot,
     fence-scoped pending drain, late rejection, stale-fence rejection, and guarded
     reopen only when empty/idle/non-halted.
  2. Add the opaque admission-fence epoch APIs from `DES-003`; keep existing queue
     enqueue/processor error behavior unchanged outside a closed epoch.
  3. Replace the crash-specific undispatched cancellation set with an outcome-
     aware latch keyed by immutable logical-turn identity. The dispatch guard and
     processor-error path must await the same exact finalization but must not use
     a per-chat FIFO scope before publication.
  4. Implement the per-chat target/preflight arm in the new coordinator: capture
     session, owner generation, queue object, scope ref, published context, and
     pending contexts; close admission before awaits; fail closed on missing
     context; mark every context replay-unsafe; finalize published work with
     preserved evidence and unpublished/pending work with the table in `DES-004`.
  5. Make immediate undispatched terminalization run the same after-terminal hook
     as supervisor-recovered terminalization. The hook only records proof; it does
     not await queue idle.
  6. Follow `scopeRef.value` through a forced LID rekey and use guarded map deletion
     (`map.get(finalKey) === capturedObject`) during release.
  7. Remove `terminalizePerChatTurnQueueForKill` only after `CHK-001`, `CHK-002`,
     `CHK-005`, and `CHK-008` pass with exact terminal rows and no provider
     dispatch. Re-run existing crash/shutdown queue tests to prove no semantic
     borrowing.
- **Verification:**
  - `npm test -- tests/runtimes/agent/turn-queue.test.ts tests/runtimes/agent/kill-session-transactional-cancellation.test.ts tests/runtimes/agent/runtime-terminal-coordinator-integration.test.ts tests/runtimes/agent/crash-fifo-discard.test.ts --pool=forks --fileParallelism=false --retry=0`
  - `npm run typecheck:all`
- **Commit:** `feat(agent): terminalize per-chat kill-session turns transactionally`

#### TSK-004: Add preemptive shared/single control and stable command ownership
- **Status:** pending
- **Traces-from:** REQ-001, REQ-002, DES-001, DES-002, DES-007
- **Owns-AC:** REQ-001.AC-01, REQ-001.AC-02, REQ-001.AC-03, REQ-001.AC-05, REQ-002.AC-03
- **Checks:** CHK-003, CHK-004, CHK-010, CHK-011, CHK-013
- **Files:**
  - Modify: `src/runtimes/agent/runtime.ts`
  - Modify: `src/runtimes/agent/runtime-session-cancellation.ts`
  - Modify: `src/runtimes/agent/runtime-turn-coordinator.ts`
  - Modify: `tests/runtimes/agent/kill-session-transactional-cancellation.test.ts`
  - Modify: `tests/runtimes/agent/runtime.test.ts`
- **Steps:**
  1. Add `CHK-013` for admin/usage/no-active parity plus proof that an early
     `/kill-session` from an otherwise cold chat does not create a provider
     session or runtime queue.
  2. Add a text-only early classifier in `handleMessageInner`. For a valid local
     kill, resolve admin/index and capture the exact target synchronously, append
     work to `killSessionControlChain`, and bypass imperative/session/turn setup.
     Leave every non-kill input on the existing path.
  3. Complete the command inbound in the control operation's exact-once `finally`.
     Do not reuse the command sequence as a target sequence. Preserve silent
     non-admin handling and existing usage/out-of-range responses.
  4. Implement shared capture: fence the original global queue, classify the
     current published/active turn, drain all pending cross-chat entries after
     context preflight, stop the exact shared child, and guarded-reopen the same
     queue object after release proof.
  5. Implement singleton capture: snapshot pending/current context around
     `sendTurnToSession`, install the cancellation latch, and initiate exact child
     shutdown without waiting for the provider result or ordinary `turnChain`.
  6. Serialize duplicate operations on their pre-captured target identity. A
     duplicate may join/retry the same operation, but must never enumerate current
     sessions again or mutate a replacement.
  7. Run command regression tests and confirm the baseline public messages change
     only where degraded truth replaces the current false-success suffix.
- **Verification:**
  - `npm test -- tests/runtimes/agent/kill-session-transactional-cancellation.test.ts tests/runtimes/agent/runtime.test.ts tests/runtimes/agent/commands.test.ts --pool=forks --fileParallelism=false --retry=0`
  - `npm run typecheck:all`
- **Commit:** `feat(agent): preempt sessions through a fenced kill control lane`

#### TSK-005: Harden replay, generation, retained recovery, and isolation
- **Status:** pending
- **Traces-from:** REQ-001, REQ-003, REQ-004, CON-003, DES-002, DES-005, DES-007, DES-008
- **Owns-AC:** REQ-001.AC-04, REQ-003.AC-02, REQ-003.AC-03, REQ-003.AC-04, REQ-004.AC-01, REQ-004.AC-02, CON-003.AC-01, CON-003.AC-02
- **Checks:** CHK-006, CHK-007, CHK-009, CHK-012, CHK-014, CHK-015, CHK-022, CHK-023
- **Files:**
  - Modify: `src/runtimes/agent/runtime-session-cancellation.ts`
  - Modify: `src/runtimes/agent/runtime-turn-coordinator.ts`
  - Modify: `src/runtimes/agent/runtime.ts`
  - Modify: `tests/runtimes/agent/kill-session-transactional-cancellation.test.ts`
  - Modify: `tests/runtimes/agent/runtime-turn-supervisor.test.ts`
  - Modify: `tests/runtimes/agent/outbound-queue-turn-evidence.test.ts`
- **Steps:**
  1. Add `CHK-014` proving bounded degraded completion without awaiting an
     exhausted recovery waiter; add `CHK-015` proving only the captured child stop
     is called and no service/fleet restart surface is invoked.
  2. Mark captured contexts replay-unsafe before abort/finalization. Preserve
     outbound turn evidence and assert pending/submitted/maybe-sent states create
     the existing recovery transfer with `replaySafe=false` and no runnable replay.
  3. Add the release barrier's exact-once state and proofs. Turn after-terminal
     callbacks mark completion and schedule a detached release check; queue idle is
     awaited outside finalizer post-effects. Clean acknowledgement is impossible
     until all proofs are present.
  4. On terminal or alert dual-sink failure, still attempt targeted child stop,
     leave owner/maps/context/completion/scope ref/evidence intact, keep admission
     closed, and return a bounded retained-degraded result. Wire supervisor retry
     and duplicate already-captured control operations to the same idempotent
     release path; a new command must not reconstruct an inactive target from a
     stale numeric index.
  5. Wrap all singleton/shared/per-chat event, result, crash, resume, and completion
     callbacks with session object plus manager/generation checks before routing.
     Prove the old callback cannot enqueue output after replacement.
  6. Add bounded, content-free logs for operation state, target scope, manager/
     generation correlation, turn counts, proof gaps, and final outcome. Capture a
     unique content canary and assert it is absent from logs.
  7. Run `CHK-012` with two real per-chat lanes: force target retention while the
     other chat reaches terminal completion; assert no cross-map or cross-row
     mutation. Do not satisfy the check with only a spy that a method was called.
- **Verification:**
  - `npm test -- tests/runtimes/agent/kill-session-transactional-cancellation.test.ts tests/runtimes/agent/runtime-turn-supervisor.test.ts tests/runtimes/agent/outbound-queue-turn-evidence.test.ts --pool=forks --fileParallelism=false --retry=0`
  - `npm run guard:test-integrity`
  - `npm run typecheck:all`
- **Commit:** `fix(agent): retain failed cancellation and fence stale generations`

#### TSK-006: Verify boundaries, obtain review, merge, and roll out only after main
- **Status:** pending
- **Traces-from:** CON-002, CON-004, DES-008, DES-009
- **Owns-AC:** CON-002.AC-01, CON-002.AC-02, CON-002.AC-03, CON-004.AC-02
- **Checks:** CHK-019, CHK-020, CHK-021, CHK-026
- **Files:**
  - Modify: `docs/superpowers/specs/kill-session-transactional-cancellation/requirements.md` only for approved amendments
  - Modify: `docs/superpowers/specs/kill-session-transactional-cancellation/design.md` only for approved amendments
  - Modify: `docs/superpowers/specs/kill-session-transactional-cancellation/tasks.md` task/check statuses only
  - Generate the spec-driven conformance artifact at execution/final stage; it is
    intentionally absent while this plan remains pending.
  - Modify: `docs/publication-audit.md`
  - Regenerate: `docs/work-index.json`
  - Regenerate: `docs/work-index.md`
- **Steps:**
  1. Generate conformance evidence and run traceability lint at execution/final
     stages. Confirm every active AC has one owner and one applicable check, every
     marker references the registry, and the twelve RED cases remain separate.
  2. Audit the diff: no migration/schema file, provider parser/gate/quarantine/
     tombstone file, deploy manifest/installer, systemd service, or whole-shutdown
     behavior may appear. `turn_terminal_records` and `turn_recovery_jobs` remain
     the only terminal/recovery owners.
  3. Run the full focused verification block below with fresh output. Fix causes,
     never lower thresholds or skip required gates.
  4. Request two independent reviews: one adversarial lifecycle/concurrency review
     and one test-integrity/replay-safety review. Address findings through the same
     RED-first process and record exact reviewer verdicts.
  5. Rebase on current `origin/main`, rerun focused and full verification, maintain
     focused commits, push the branch, open a PR that names the DGX residual and
     explicit non-goals, wait for required checks/reviews, and merge only when all
     are green.
  6. After merge, use the canonical targeted source-update mechanism. Compare
     installed runtime/wrapper/settings/state paths to repository artifacts before
     changing anything; do not reinstall raw. Restart only the affected WhatSoup
     instance if the normal rollout requires it, never the fleet. Verify the
     previously affected chat and at least one control chat, then report hashes,
     counts, residual limits, and reviewer verdicts.
- **Verification:**
  - `~/.codex/superpowers/skills/spec-driven-development/scripts/traceability-lint.sh docs/superpowers/specs/kill-session-transactional-cancellation --stage=final --test-root=tests`
  - `npm test -- tests/runtimes/agent/kill-session-transactional-cancellation.test.ts tests/runtimes/agent/turn-queue.test.ts tests/runtimes/agent/runtime-turn-supervisor.test.ts tests/runtimes/agent/runtime-terminal-coordinator-integration.test.ts tests/runtimes/agent/outbound-queue-turn-evidence.test.ts tests/runtimes/agent/turn-terminal-model.test.ts tests/core/inbound-failure-class.test.ts tests/core/turn-finalization-hardening.test.ts tests/core/durability-schema.test.ts tests/core/migration-safety.test.ts --pool=forks --fileParallelism=false --retry=0`
  - `npm run typecheck:all`
  - `npm run guard:lint:src`
  - `npm run guard:test-integrity:required`
  - `npm run guard:publication:all`
  - `npm run guard:publication:staged`
  - `npm run guard:doc-drift`
  - `npm run guard:work-index`
  - `npm run guard:doc-tally`
  - `npm test -- tests/scripts/work-index.test.ts tests/scripts/publication-guard.test.ts tests/scripts/doc-drift-check.test.ts tests/scripts/guard-doc-tally.test.ts --pool=forks --fileParallelism=false --retry=0`
  - `npm test -- --pool=forks --fileParallelism=false --retry=0`
- **Commit:** `docs(agent): record kill-session cancellation conformance`

## Planned Check Registry

| Check | Type | Target | Planned evidence |
|---|---|---|---|
| `CHK-001` | acceptance | `REQ-002.AC-01` | Published per-chat cancellation integration test |
| `CHK-002` | concurrency | `REQ-002.AC-02` | Unpublished/pending/late admission race test |
| `CHK-003` | acceptance | `REQ-002.AC-03` | Shared active/pending queue reuse integration test |
| `CHK-004` | concurrency | `REQ-001.AC-01` | Blocked singleton preemption test |
| `CHK-005` | concurrency | `REQ-003.AC-01` | LID rekey during blocked evidence test |
| `CHK-006` | acceptance | `REQ-003.AC-02` | Delivery-state matrix with replay/no-destruction assertions |
| `CHK-007` | failure-injection | `REQ-003.AC-03` | Terminal sink retention and later exact release test |
| `CHK-008` | invariant | `REQ-002.AC-04` | Missing immutable context fail-closed test |
| `CHK-009` | concurrency | `REQ-001.AC-04` | Stale generation callback rejection test |
| `CHK-010` | concurrency | `REQ-001.AC-02` | Duplicate kill target-stability test |
| `CHK-011` | durability | `REQ-001.AC-03` | Command/target inbound ownership separation test |
| `CHK-012` | isolation | `REQ-004.AC-01` | Unaffected second-chat continuity test |
| `CHK-013` | regression | `REQ-001.AC-05` | Admin/usage/no-session-creation parity test |
| `CHK-014` | boundedness | `REQ-003.AC-04` | Exhausted recovery waiter bounded-completion test |
| `CHK-015` | isolation | `REQ-004.AC-02` | Captured-child-only stop/no restart review test |
| `CHK-016` | contract | `CON-001.AC-01` | Bounded taxonomy unit tests |
| `CHK-017` | schema | `CON-001.AC-02` | CHECK-free TEXT/no-migration schema assertions |
| `CHK-018` | durability | `CON-001.AC-03` | Exact persisted cancellation tuple test |
| `CHK-019` | architecture | `CON-002.AC-01` | Terminal/recovery owner diff and integration review |
| `CHK-020` | scope-review | `CON-002.AC-02` | Provider lifecycle exclusion diff audit |
| `CHK-021` | scope-review | `CON-002.AC-03` | Shutdown/deploy/schema exclusion diff audit |
| `CHK-022` | boundedness | `CON-003.AC-01` | Control deadline and detached release test |
| `CHK-023` | privacy | `CON-003.AC-02` | Content-canary log capture test |
| `CHK-024` | test-integrity | `CON-003.AC-03` | Real SQLite/durability/queue harness contract |
| `CHK-025` | test-integrity | `CON-004.AC-01` | Preserved RED/green evidence plus marker audit |
| `CHK-026` | verification | `CON-004.AC-02` | Full gate outputs and independent reviewer verdicts |
