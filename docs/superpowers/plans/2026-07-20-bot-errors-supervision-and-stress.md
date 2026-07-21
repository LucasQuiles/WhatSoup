# BOT ERRORS Supervision and Stress Implementation Plan

**Status:** Pending implementation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing BOT ERRORS coordination loop into a read-first, cursor-safe supervisor that correlates chat observations with dispatcher state and queue health, emits bounded evidence receipts, and is proven under replay, outage, concurrency, and sustained load.

**Architecture:** Extend `bot-errors-q-loop.py` instead of creating another monitor. The instance MCP socket is the authoritative chat read; the local message database is an explicitly labeled fallback. The dispatcher incident ledger remains incident truth, queue directories remain delivery truth, and the q-loop stores only its cursor, health receipt, classifications, and operator coordination state. Sending is opt-in and target-bonded; monitoring never posts acknowledgement-only messages.

**Tech Stack:** Python 3, Unix-domain MCP JSON-RPC, SQLite read-only fallback, existing BOT ERRORS state directories, Python `unittest`, Vitest structural guards, deterministic subprocess fault injection, and manifest-verified deploy bundles.

## Global Constraints

- Reuse `bot-errors-q-loop.py`, its file lock, atomic private state, dynamic wait policy, redaction helper, and heartbeat watchdog contract.
- Reuse dispatcher `incident_key` and stored incident records; the supervisor may classify but must not create a competing incident ledger.
- Authoritative socket reads use bounded fresh connections and a timestamp/message cursor. Database fallback is marked `fallback_incomplete` and cannot prove recovery.
- Default execution is read-only. Sending requires an explicit command flag, expected-group identity match, and the existing target validation.
- Post only a new actionable incident, accepted transition, requested decision, or remediation receipt. Do not post routine acknowledgements or unchanged snapshots.
- Never include private message bodies or identities in repository fixtures or public logs. Live state remains mode 0600 under a private directory.
- Monitoring does not authorize deployment, service restart, database mutation, credential/link changes, physical actions, or message sends beyond the explicitly bonded target/flag.
- Every timeout, skipped check, fallback, partial read, or truncated response remains visible and inconclusive.

## File Structure

- Modify `deploy/scripts/bot-errors-q-loop.py` and its Python/Vitest tests.
- Create `deploy/scripts/bot_errors_supervision.py` for pure cursor/correlation/receipt logic.
- Create `deploy/scripts/bot-errors-protocol-stress.py` and focused tests.
- Modify the heartbeat watchdog only where the new receipt contract changes liveness evidence.
- Update runtime manifest/install packaging and BOT ERRORS operating documentation.

---

### Task 1: Make monitoring read-only and sending explicitly bonded

**Files:**
- Modify: `deploy/scripts/bot-errors-q-loop.py`
- Modify: `tests/scripts/bot-errors-q-loop.test.ts`
- Create: `deploy/scripts/tests/test_bot_errors_q_loop_authorization.py`
- Modify: `deploy/bot-errors-q-loop.service`

**Interfaces:**
- Adds `--allow-send` as the only send-enabling flag; `--no-send` remains accepted temporarily as a deprecated no-op.
- Requires `BOT_ERRORS_EXPECTED_JID` equality and group shape whenever sending is enabled.

- [ ] **Step 1: Write failing authorization tests**

Assert default invocation never calls `send_message`; `--allow-send` without expected target fails before socket mutation; mismatch fails; exact bonded group succeeds; acknowledgement-only frames are suppressed; and every send attempt gets a durable bounded receipt.

- [ ] **Step 2: Prove the red state**

Run: `python3 -m unittest deploy.scripts.tests.test_bot_errors_q_loop_authorization` and `bash scripts/run-with-pinned-npm.sh test -- tests/scripts/bot-errors-q-loop.test.ts --pool=forks`.

Expected: FAIL because sending is currently enabled unless `--no-send` is supplied.

- [ ] **Step 3: Invert the default safely**

Gate all bootstrap, nudge, and checkpoint calls behind `--allow-send`. Keep target validation fail-closed. Update the service template to remain read-only; any future send-enabled override must be a separately reviewed drop-in with the bonded expected target.

- [ ] **Step 4: Verify and commit**

Run authorization, service-template, redaction, and atomic-write tests.

Expected: PASS with no default outbound side effect.

Commit: `fix(ops): make incident supervision read only`

### Task 2: Add authoritative socket reads with an honest fallback

**Files:**
- Modify: `deploy/scripts/bot-errors-q-loop.py`
- Create: `deploy/scripts/bot_errors_supervision.py`
- Create: `deploy/scripts/tests/test_bot_errors_supervision_cursor.py`
- Modify: `tests/scripts/bot-errors-q-loop.test.ts`

**Interfaces:**
- Produces `read_authoritative_thread(socket, chat_jid, cursor, limit)` using the existing MCP RPC helper.
- Produces `ReadReceipt` with `source`, `cursorBefore`, `cursorAfter`, `complete`, `observedAt`, and bounded error class.

- [ ] **Step 1: Write failing socket/cursor tests**

Cover ordered pages, duplicate page boundaries, same-timestamp messages, out-of-order response entries, reconnect after partial frame, response truncation, timeout, malformed JSON-RPC, wrong chat identity, and cursor restart. Assert no unseen message is skipped and exact replay is idempotent.

- [ ] **Step 2: Write failing fallback tests**

When the socket is unavailable, query SQLite read-only with the existing primary-key cursor and label the receipt `fallback_incomplete`. Assert fallback cannot mark an incident recovered or advance an authoritative cursor beyond unobserved socket data.

- [ ] **Step 3: Prove the red state**

Run: `python3 -m unittest deploy.scripts.tests.test_bot_errors_supervision_cursor`

Expected: FAIL because the loop currently reads only SQLite and has no authoritative read receipt.

- [ ] **Step 4: Implement bounded authoritative reads**

Reuse `rpc_call`, the socket lock, fresh timeouts, and the configured group identity. Normalize the MCP response into content-redacted metadata before persistence. Advance the authoritative cursor only after the complete page is classified and state is durably saved.

- [ ] **Step 5: Verify and commit**

Run cursor, q-loop, socket-lock, redaction, and restart tests.

Expected: PASS; fallback paths remain visible in JSON output and state.

Commit: `feat(ops): add authoritative incident thread cursor`

### Task 3: Correlate chat, incident ledger, and queues

**Files:**
- Modify: `deploy/scripts/bot_errors_supervision.py`
- Modify: `deploy/scripts/bot-errors-q-loop.py`
- Create: `deploy/scripts/tests/test_bot_errors_supervision_correlation.py`

**Interfaces:**
- Produces classifications: `repeat_observation`, `accepted_transition`, `new_root`, `inhibited_symptom`, `resolved`, `owner_required`, `physical_required`, and `inconclusive`.
- Produces one bounded `SupervisionReceipt` per completed loop.

- [ ] **Step 1: Write failing correlation tests**

Use synthetic chat metadata, dispatcher delivery receipts, incident-state fixtures, and isolated queue directories. Cover repeated open alerts, real close/reopen, rejected clear, root inhibition, stale ledger, missing queue directory, corrupt state, physical action, owner-required action, queue backlog, and no-change cycles.

- [ ] **Step 2: Prove the red state**

Run: `python3 -m unittest deploy.scripts.tests.test_bot_errors_supervision_correlation`

Expected: FAIL because the loop tracks activity roles but does not correlate incident or queue truth.

- [ ] **Step 3: Implement pure correlation**

Read incident state, bounded dispatch-log receipts, and queue counts without mutation; correlate chat arrival metadata to the durable delivery event ID/incident key; and classify by stable identity and stored state. Reuse protocol reason/action codes rather than parsing formatted message prose. Treat missing, ambiguous, corrupt, or stale sources as `inconclusive`.

- [ ] **Step 4: Persist a compact receipt**

Store last authoritative read, last queue inspection, last incident-ledger read, cursor, classifications, blockers, next proof due, and fallback state. Cap lists and rotate event/activity logs by age and size without deleting the current cursor or unresolved references.

- [ ] **Step 5: Verify and commit**

Run correlation, cursor, atomic-write, redaction, and heartbeat tests.

Expected: PASS with unchanged cycles producing no outbound candidate.

Commit: `feat(ops): correlate incident supervision evidence`

### Task 4: Make supervisor liveness independently verifiable

**Files:**
- Modify: `deploy/scripts/bot-errors-heartbeat-watchdog.py`
- Modify: `deploy/scripts/bot-errors-q-loop.py`
- Modify: `deploy/scripts/tests/test_bot_errors_heartbeat_watchdog_intent.py`
- Modify: `deploy/scripts/tests/test_bot_errors_q_loop_capacity_severity.py`
- Create: `deploy/scripts/tests/test_bot_errors_supervision_health.py`

**Interfaces:**
- Watchdog consumes the supervision receipt timestamps/source/completeness, not only `state.json.updated_at`.

- [ ] **Step 1: Write failing liveness tests**

Cover fresh authoritative read, fresh fallback-only read, stale queue inspection, stale incident-ledger inspection, stuck cursor with active arrivals, corrupt receipt, q-loop capacity pause, socket outage, and recovery. Assert fallback degrades health but does not claim chat authority.

- [ ] **Step 2: Prove the red state**

Run the three focused Python suites.

Expected: FAIL because heartbeat currently proves loop iteration age rather than all supervision obligations.

- [ ] **Step 3: Extend the watchdog contract**

Keep the existing loop-age ceiling, then independently evaluate authoritative-read age, queue-inspection age, ledger-read age, and cursor progress. Emit one stable monitoring incident identity with typed evidence; clear it only after all required receipts recover.

- [ ] **Step 4: Verify and commit**

Run heartbeat, q-loop, transient-tiering, inhibition, and runtime-manifest tests.

Expected: PASS without stale/recovered sawtooth from normal idle cadence.

Commit: `fix(ops): verify supervision health receipts`

### Task 5: Build deterministic protocol stress and soak tooling

**Files:**
- Create: `deploy/scripts/bot-errors-protocol-stress.py`
- Create: `deploy/scripts/tests/test_bot_errors_protocol_stress.py`
- Modify: `package.json`
- Modify: `deploy/scripts/README-bot-errors.md`

**Interfaces:**
- Command accepts `--seed`, `--observations`, `--incident-keys`, `--workers`, `--restart-every`, `--fault`, and an isolated `--state-root`.
- Emits one JSON receipt with correctness counts, seed, environment, duration, peak RSS, and state sizes.

- [ ] **Step 1: Write the harness contract and negative controls**

Assert the harness refuses a live/default state root, requires explicit isolated paths, preserves child exit codes, records its seed, closes owned handles, and detects intentionally broken replay and false-clear invariants.

- [ ] **Step 2: Prove the red state**

Run: `python3 -m unittest deploy.scripts.tests.test_bot_errors_protocol_stress`

Expected: FAIL because the stress command does not exist.

- [ ] **Step 3: Implement deterministic workload generation**

Generate mixed version-1/version-2 events with duplicates, collisions, reorderings, valid/invalid proofs, root/symptom relations, transitions, and remediation attempts. Invoke the real pure protocol evaluator and dispatcher filesystem paths against temporary state only.

- [ ] **Step 4: Add fault injection and restart loops**

Inject SQLite busy for cleanup integration, permission denial, rename failure, truncated JSON, disk-full substitute, process termination, concurrent producers, concurrent dispatcher claim, and repeated supervisor reconnect. Each fault must write an occurrence receipt before its assertion.

- [ ] **Step 5: Establish correctness gates**

For 100,000 observations across at least 1,000 keys, assert exact replay idempotency, no close without proof, no repeat-fault reopen count, bounded state/log sizes, full queue ownership, no leaked child processes, and cursor convergence. Record timing/RSS as a baseline, not a fixed CI threshold.

- [ ] **Step 6: Verify and commit**

Run unit/negative-control stress tests in CI-sized mode and one non-CI full run through `loadgate`. Preserve the receipt path and exact exit status.

Expected: PASS with no live network or live state access.

Commit: `test(ops): add incident protocol stress harness`

### Task 6: Package, document, and rehearse rollback

**Files:**
- Modify: `deploy/bot-errors-runtime-manifest.json`
- Modify: dispatcher/q-loop installer and parity allowlists.
- Modify: `deploy/scripts/README-bot-errors.md`
- Modify: `docs/runbooks/error-response-workflows.md`
- Modify: focused manifest/deployer/service tests.

- [ ] **Step 1: Update packaging fail-closed**

Include both pure helper modules and the stress command where appropriate. Prove missing/hash-drifted helpers block replacement before service mutation.

- [ ] **Step 2: Document the operator loop**

Document cursor semantics, authoritative versus fallback reads, classification vocabulary, post criteria, supervision health, private handoff fields, stress receipts, rollout, and rollback. Keep all examples synthetic.

- [ ] **Step 3: Run complete verification**

Run q-loop, watchdog, dispatcher protocol, stress, service, manifest, deployer, simulation, redaction, critical-surface, typecheck, architecture fitness, SSOT, boundary, publication, work-index, doc-tally, and test-integrity gates. Compare fitness warnings against the pre-change baseline.

- [ ] **Step 4: Rehearse local rollback**

In an isolated staged bundle, install/verify the new payload, stop the simulated services, restore prior scripts/state snapshot, and replay only queue items without committed receipts. Prove the old supervisor starts read-only and the preserved cursor is not advanced by the rehearsal.

- [ ] **Step 5: Produce the rollout handoff**

Record exact commits, test exits, stress seeds/measurements, rollback receipt, gaps, and separately gated live deployment/service actions. A successful local rehearsal does not assert that any open fleet incident recovered.
