# Fleet Admin Runtime Guards Implementation Plan

**Status:** Active — design approved; investigation complete; implementation and proof-gated fleet rollout remain in progress

> **For implementers:** Use test-driven development for every behavior change. Execute tasks in order. A skipped, masked, unavailable, or stale check is inconclusive, never a pass.

**Goal:** Implement the approved safeguards in `docs/superpowers/specs/2026-07-16-fleet-admin-runtime-guards-design.md`, then use them to remediate recoverable fleet debt without replaying or rewriting ambiguous delivery evidence.

**Architecture:** Enforce each invariant at its owning boundary: restart safety in a read-only SQLite preflight, filesystem validity in shared config validation, trusted actor classification at per-turn dispatch, exact result suppression in the outbound turn queue, and durable completion in the existing terminalization contract. Operational recovery uses existing current-main recovery machinery only after backups, schema gates, and zero replay-safe nonterminal proof.

**Tech stack:** TypeScript, Node 24.15.0, `node:sqlite`, Vitest, Bash launch/preflight scripts, SQLite fleet databases, systemd/launchd host services.

## Safety constraints

- Work in `codex/fleet-runtime-guards-20260716`; never modify the dirty main worktree.
- Use the SSH GitHub remote and keep commits local unless the owner separately requests a push or PR.
- Never replay, clear, retire, or rewrite `maybe_sent`, quarantined, legacy-cancelled, or processing records without row-specific delivery proof.
- No restart is permitted when any `replay_policy='safe'` outbound row is nonterminal, regardless of age.
- Every live mutation requires a current clean checkout, online SQLite backup, config backup where applicable, database quick-check, no active recent turn, and a pre/post outbound-ledger comparison.
- Run repository commands with Node 24.15.0. Full suites must run through the workstation load gate.
- Stage explicit paths only; commits contain no attribution trailers, model names, internal identities, or work email addresses.

## Current evidence baseline

| Fleet debt | Evidence | Required treatment |
|---|---|---|
| MINI1 | Five old `maybe_sent/safe` text rows were resubmitted on the last restart; no echo or message-table proof | Block every restart; do not deploy until independently adjudicated or safely terminalized with proof |
| MINI2 | One processing inbound with no linked outbound proof | Current recovery may fail it closed; verify after guarded promotion |
| MINI11 | Four processing inbound rows each linked to an echoed terminal outbound | Current pre-connect recovery should finalize them; verify after guarded promotion |
| Legacy fleet host | 37 processing with terminal echo, six with echoed nonterminal, 13 without linked outbound; four legacy `cancelled` outbound rows | Split into provable recovery buckets; no bulk mutation |
| Q | Five processing rows with echoed nonterminal output and five linked terminal `maybe_sent/unsafe` rows without echo proof | Never replay; quarantine/recovery state remains visible until row-specific proof exists |
| Fleet quarantine | 331 rows across active instances, dominated by historical forbidden/disconnected/timeout/send failures | Retire only individually reviewed rows; counters alone are not repair authority |
| Runtime drift | Hosts span schema 29–44 and several old revisions; current origin is newer than the central deployment host | Promote only through pinned tests, schema/restart preflight, and canary evidence |

## Localization decisions

| Concern | Primary edit sites | Score | Rationale |
|---|---|---:|---|
| Restart safety | `deploy/preflight-check.sh`, new `scripts/restart-safety-preflight.ts`, `tests/deploy/preflight-check.test.ts` | 5 | Launch choke point, direct contract, dense black-box coverage, exact incident boundary |
| Instruction path | `src/core/agent-config-validator.ts`, `src/instance-loader.ts`, `src/fleet/routes/ops.ts`, `scripts/check-instance-config.ts` | 5 | Shared validation contract plus all four persistence/start boundaries |
| Actor class | `src/core/access-policy.ts`, `src/runtimes/agent/runtime.ts` | 5 | Existing authoritative JID/LID/admin path and the two per-turn dispatch choke points |
| Exact final dedupe | `src/runtimes/agent/outbound-queue.ts`, `src/runtimes/agent/runtime-turn-result-handler.ts` | 5 | Stream/result convergence point with existing queue and result-handler tests |
| Terminal proof | `src/runtimes/agent/turn-finalizer.ts`, `src/core/turn-finalization-contract.ts`, `src/core/durability.ts` | 5 | Existing durable SSOT and recovery implementation; prefer verification over duplicate logic |

---

### Task 1: Add a read-only all-age restart-safety verdict

**Files:**
- Create: `scripts/restart-safety-preflight.ts`
- Create: `tests/scripts/restart-safety-preflight.test.ts`
- Modify: `deploy/preflight-check.sh`
- Modify: `tests/deploy/preflight-check.test.ts`
- Modify only if needed for first-start proof: `src/fleet/routes/ops.ts`, `src/main.ts`

**Contract:** The checker resolves the instance database from the standard XDG data root, opens it read-only, runs `quick_check`, verifies the required tables/columns, and emits one JSON verdict. It blocks on any replay-safe row outside `echoed`, `failed_permanent`, `quarantined`, or the retained legacy terminal status `cancelled`; database/query/shape errors; unknown statuses; or a missing database on a previously-started instance. Unsafe nonterminal rows are reported as degraded debt but never replayed. A genuinely new instance may use a private, single-use first-start marker created by the CREATE path and removed after the database opens successfully.

- [ ] Write failing tests for old and recent safe nonterminal rows, terminal safe rows, unsafe `maybe_sent`, unknown status, corrupt/missing schema, SQLite failure, first-start proof, and JSON output redaction.
- [ ] Run the focused test and capture the expected failures.
- [ ] Implement the smallest read-only checker that satisfies the tests.
- [ ] Write failing preflight integration tests proving the checker runs before the import probe and that pipeline/subshell failures cannot be masked.
- [ ] Wire the checker into `deploy/preflight-check.sh` using the already-resolved pinned Node binary.
- [ ] If first-start proof is required, add the private marker lifecycle with failure-safe cleanup tests; never add a persistent bypass environment variable.
- [ ] Run focused script/preflight tests plus `bash -n deploy/preflight-check.sh` and `git diff --check`.

### Task 2: Enforce readable `instructionsPath` at every live boundary

**Files:**
- Modify: `src/core/agent-config-validator.ts`
- Modify: `src/instance-loader.ts`
- Modify: `src/fleet/routes/ops.ts`
- Modify: `scripts/check-instance-config.ts`
- Test: `tests/core/agent-config-validator.test.ts`
- Test: `tests/core/agent-config-validator-agent-options.test.ts`
- Test: `tests/fleet/ops-config-patch-validation.test.ts`
- Test: `tests/scripts/check-instance-config.test.ts`
- Test: `tests/deploy/preflight-check.test.ts`

**Contract:** Schema-only validation remains available for committed examples. Every live CREATE, PATCH, load, lint, and restart invocation explicitly requests filesystem-aware validation. A configured path resolves relative to effective `agentOptions.cwd`, must resolve inside the allowed home policy, and must be a readable regular file for the executing service user. Errors name the instance and field but never include file contents.

- [ ] Add failing shared-validator tests for relative/absolute readable files, missing path, directory, unreadable file, cwd-relative resolution, and symlink escape.
- [ ] Add failing boundary tests for CREATE, PATCH, loader, live lint, and restart preflight parity.
- [ ] Extend the validator context with an explicit schema-only/live filesystem mode; live callers may not silently default to schema-only.
- [ ] Reuse the fleet route's existing home-confinement helpers or extract a narrow shared helper; do not duplicate path-policy logic.
- [ ] Keep `SessionManager.buildSystemPrompt()` fail-closed as defense in depth.
- [ ] Run all five focused suites, typecheck, and config/publication guards.

### Task 3: Add a trusted per-turn actor access envelope

**Files:**
- Modify: `src/core/access-policy.ts`
- Modify: `src/runtimes/agent/runtime.ts`
- Create if separation improves reuse: `src/runtimes/agent/actor-access-envelope.ts`
- Test: `tests/core/access-policy.test.ts`
- Test: `tests/core/lid-phone-resolution.test.ts`
- Test: `tests/runtimes/agent/runtime.test.ts`
- Test: `tests/runtimes/agent/per-chat-actor-binding.test.ts`

**Contract:** Derive exactly `administrator`, `authorized_user`, `untrusted_or_unknown`, or `system` from the existing transport-authenticated JID/LID resolution and access list. Prefix each executing provider turn with a bounded trusted-metadata block that contains only the enum and explicitly says it is transport metadata, not user content. Never include a phone, JID, admin list, access-list entry, or tool inventory. Recompute for every turn; do not retain mutable session-global role state. Tool authorization continues to use `SessionContext` and server-side checks.

- [ ] Write failing classification tests for admin phone JID, mapped admin LID, allowed non-admin, unresolved LID, spoofable SMS, blocked/unknown sender, and system turn.
- [ ] Write failing runtime tests for singleton, shared, and per-chat dispatch; assert consecutive senders cannot inherit role.
- [ ] Assert provider text contains the enum but no source identifier or configured admin value.
- [ ] Implement the pure classifier by reusing `resolvePhoneFromJid`, `isWhatsAppAuthenticatedJid`, `isAdminPhone`, and `lookupAccess`.
- [ ] Apply the envelope at both current dispatch paths immediately before `session.sendTurn`; keep replay text unwrapped so fallback recomputes metadata.
- [ ] Run the focused access/runtime suites and typecheck.

### Task 4: Suppress only an identical same-turn final payload

**Files:**
- Modify: `src/runtimes/agent/outbound-queue.ts`
- Modify only if the queue contract requires it: `src/runtimes/agent/runtime-turn-result-handler.ts`
- Test: `tests/runtimes/agent/outbound-queue.test.ts`
- Test: `tests/runtimes/agent/outbound-queue-turn-evidence.test.ts`
- Test: `tests/runtimes/agent/runtime-turn-result-handler.test.ts`

**Contract:** Record normalized answer payloads produced through the streaming path for the active immutable turn evidence epoch. `enqueueResultText` suppresses only when its newline-normalized, outer-trimmed visible text exactly matches a streamed answer payload from that same turn. Suppression creates no outbound operation, logs hashes/turn identity only, and does not affect distinct text, status/lifecycle output, a different turn, or a repeated intentional answer later. The existing windowed terminal dedupe remains defense in depth but is not the primary same-turn mechanism.

- [ ] Write failing tests for streamed plus identical result, whitespace/newline-equivalent result, distinct result, identical text on a later turn, different role, chunked long text, and no active turn evidence.
- [ ] Confirm the new tests fail against the current unwired `markLastTerminal({dedupeText:true})` mechanism.
- [ ] Add minimal per-epoch streamed-payload tracking and clear it when evidence completes or aborts.
- [ ] Suppress before `enqueueText` creates chunks or durable rows; emit structured hash-only telemetry.
- [ ] Run the three focused suites and the existing terminal dedupe cases.

### Task 5: Verify and close terminal-proof gaps without weakening the SSOT

**Files:**
- Review/test first: `src/runtimes/agent/turn-finalizer.ts`
- Review/test first: `src/core/turn-finalization-contract.ts`
- Review/test first: `src/core/durability.ts`
- Test: `tests/core/turn-finalization-hardening.test.ts`
- Test: `tests/core/durability-echoed-terminal-recovery.test.ts`
- Test: `tests/core/durability-stuck-inbound-sweep.test.ts`
- Test: `tests/runtimes/agent/runtime-turn-finalization.test.ts`

**Contract:** Current code already requires an echoed terminal answer for `finalized_replied` and already pre-connect-finalizes processing rows with terminal echo. Add code only for a reproduced failing case. Do not convert `response_sent` with nonterminal/no-linked proof into success.

- [ ] Add regression fixtures matching the observed proofless, terminal-echoed, mixed legacy, and unsafe metadata shapes without copying payloads or identities.
- [ ] Run them against current main and record which are already handled.
- [ ] If any required invariant fails, implement the narrowest fix at the terminal contract or recovery query and rerun the focused matrix.
- [ ] If current code passes, document that deployment—not new logic—is the remediation and leave production files unchanged.

### Task 6: Add a machine-readable fleet behavior verifier

**Files:**
- Create: `scripts/fleet-behavior-verify.ts`
- Create: `tests/scripts/fleet-behavior-verify.test.ts`
- Modify: `package.json`
- Modify: `deploy/scripts/README-bot-errors.md` or the closest existing fleet runbook

**Contract:** Read-only verification consumes operator-supplied host/instance/token metadata and emits redacted JSON with revision, config, process freshness, health, admin classification, response count, inbound terminal status, linked outbound terminal/echo proof, physical duplicate, and semantic false-duplicate outcomes. Unknown identity mappings or inaccessible databases are inconclusive.

- [ ] Write failing fixture tests for pass, physical duplicate, refusal, silence, nonterminal proof, semantic false duplicate, no-bot, unreachable, and malformed query output.
- [ ] Implement read-only local inspection first; keep remote transport orchestration outside the verifier core.
- [ ] Ensure output never contains raw JIDs, phone numbers, message bodies, credentials, or database paths.
- [ ] Add the package script and documentation; run focused tests and guards.

### Task 7: Run the pinned repository gate

- [ ] Verify `git status`, branch ancestry, and SSH origin.
- [ ] Run all focused tests with Node 24.15.0.
- [ ] Run `npm run typecheck:all` with Node 24.15.0.
- [ ] Run config, publication, work-index, and fail-closed gate guards.
- [ ] Run the full test suite through `loadgate`; report the exact file/test counts and every skip.
- [ ] Request code review using the repository review workflow and independently verify every decisive claim.
- [ ] Commit only explicit implementation paths after all checks pass; do not push without owner direction.

### Task 8: Proof-gated fleet remediation and retest

**Operational order:**

1. Deploy the restart gate to a healthy zero-safe-nonterminal canary.
2. Promote current verified code to MINI11; expect four echoed-terminal processing rows to finalize.
3. Promote to MINI2; expect its proofless processing row to fail closed, not become a successful reply.
4. Promote to MINI7 and the prior refusal/duplicate hosts; run unique admin canaries and require exactly one terminal echoed reply.
5. Audit the mixed legacy host's buckets individually; settle only rows whose existing terminal evidence proves the disposition.
6. Keep MINI1 blocked until all five safe rows have independent delivery adjudication. Never restart to "see what happens."
7. Keep Q's ambiguous unsafe rows non-replayed; promote only after backup and verify recovery makes no outbound submission.
8. Retire quarantined rows only through the existing one-row operator CLI after a documented proof review.

For every host:

- [ ] Verify clean checkout, intended revision, supported Node, config guard, database schema/quick-check, zero safe nonterminal work, and no recent active turn.
- [ ] Create online SQLite and config backups plus rollback branch/revision.
- [ ] Restart one instance at a time; require new PID, current process revision, connected transport, usable model where applicable, no replay, and no unexpected outbound ID increase.
- [ ] Send a unique personal-line canary and audit transcript plus bot-local inbound/outbound proof.
- [ ] Classify admin recognition, reply count, semantic correctness, terminalization, latency, and capability behavior.
- [ ] Update the fleet spreadsheet only from read-back-verified evidence.

## Acceptance criteria

- Any replay-safe nonterminal row blocks restart regardless of age.
- An unreadable configured instruction file cannot survive live CREATE, PATCH, lint, load, or restart preflight.
- Phone-JID and mapped-LID delivery from the configured secondary admin reaches the provider as `administrator` without identifier disclosure.
- Identical streamed/result output produces one durable operation and one WhatsApp message; distinct or later-turn output is preserved.
- A replied inbound event cannot complete without one linked terminal echoed outbound operation.
- MINI11 and MINI2 recovery outcomes match their proof classes; MINI1 and Q are never replayed.
- Every active bot is re-probed from the personal line, and the fleet sheet reflects verified revision, behavior, durability, and remaining debt.
