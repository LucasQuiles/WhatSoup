# Inline Proposal Admission and Cleanup Implementation Plan

**Status:** Pending implementation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admit inline proposals only from explicit, authenticated, start-anchored text imperatives; link each proposal to its stored source message; make retries idempotent; and retire the known false backlog with a reversible audited operator command.

**Architecture:** The message store remains the source of message identity, `inline-extractor.ts` remains the sole lexical classifier, and the bead substrate remains the sole transaction and event owner. Ingest threads the stored message primary key into `IncomingMessage`; a partial unique index plus an idempotent substrate operation enforces one inline proposal per source. Cleanup reuses the same classifier and bead transition/event implementation and never deletes rows.

**Tech Stack:** TypeScript ESM, Node.js 24, `node:sqlite`, Vitest, existing ingest/message/bead substrate APIs, repository guards, and isolated SQLite fixtures.

## Global Constraints

- Start from the approved design in `docs/superpowers/specs/2026-07-20-durable-incident-remediation-protocol-design.md`.
- Local commits only. Live database writes, deployment, service changes, and outbound messages remain separately authorized operations.
- Keep private message bodies, chat identities, host labels, and database paths out of fixtures, logs, documentation, and commits.
- Classifier rejection is fail-closed and content-free; unexpected classifier or storage failure stays operator-visible.
- Reuse `storeMessageIfNew`, `createBead`, `writeBeadEvent`, and bead status transitions. Do not add a runtime parser, content-hash dedupe, or a second bead transaction implementation.
- A distinct source message may intentionally create an identical proposal. Only the stored source primary key is unique.
- Every red-state command must fail for the asserted behavior. Runner/setup failure is inconclusive.
- Use pinned repository wrappers and `loadgate` for heavy checks. Never mask a decisive exit code.

## File Structure

- Modify `src/core/substrate/inline-extractor.ts` and its focused tests for the typed anchored classifier.
- Modify `src/core/messages.ts`, `src/core/ingest.ts`, `src/core/types.ts`, and focused tests to thread the stored message primary key.
- Modify `src/core/database-schema-version.ts` and `src/core/database.ts` for migration 45.
- Modify `src/core/substrate/beads.ts` and tests for idempotent admission and batch audited rejection.
- Modify `src/runtimes/agent/runtime.ts` and focused runtime tests to enforce message-shape and source-link gates.
- Create `scripts/inline-proposal-cleanup.ts` and focused tests for plan/apply/verify/rollback.
- Update `docs/runbooks/substrate-slice-1.md` and `docs/configuration.md` with the admission and rollback contracts.

---

### Task 1: Replace unanchored matching with one typed classifier

**Files:**
- Modify: `src/core/substrate/inline-extractor.ts`
- Modify: `tests/core/substrate/inline-extractor.test.ts`
- Create: `tests/fixtures/inline-proposal-structure-corpus.json`

**Interfaces:**
- Produces `classifyInlineImperative(text): InlineImperativeResult`.
- Keeps `matchImperative` and `extractImperativeTarget` only as compatibility wrappers over the classifier until all callers move.

- [ ] **Step 1: Add failing table tests for the approved grammar**

Cover BOM, NFKC, leading horizontal whitespace, optional `please`, every approved verb, separators, multiline targets, byte limits, empty targets, quotes, forward markers, fences, status prose, URLs, JSON, stack traces, homoglyphs, lone surrogates, and words occurring only mid-message. Assert the bounded rejection reason and prove the original body is unchanged.

- [ ] **Step 2: Add a privacy-safe captured-structure corpus test**

Use synthetic bodies with aggregate categories matching the audited false/valid distribution. Assert 733 false structures reject and four valid structures admit without embedding any live text or identity.

- [ ] **Step 3: Prove the red state**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/core/substrate/inline-extractor.test.ts --pool=forks`

Expected: FAIL because current regular expressions accept mid-message report prose and return no typed rejection reason.

- [ ] **Step 4: Implement the minimal classifier**

Use one start-anchored grammar after bounded normalization. Return either:

```ts
type InlineImperativeResult =
  | { admitted: true; verb: ImperativeVerb; normalizedTarget: string; matchedText: string }
  | { admitted: false; reason: InlineImperativeRejectionReason };
```

Keep the reason vocabulary content-free. Measure the 8 KiB limit in UTF-8 bytes. Reject unsupported Unicode input without throwing.

- [ ] **Step 5: Verify and commit**

Run the focused test above, then `npm run guard:lint:src` and `npm run guard:test-integrity -- tests/core/substrate/inline-extractor.test.ts` through the pinned wrappers/load gate.

Expected: focused tests PASS; fitness warnings may remain at baseline but no new warning may be introduced in changed files.

Commit: `fix(substrate): anchor inline proposal classification`

### Task 2: Thread stored message identity into runtime admission

**Files:**
- Modify: `src/core/messages.ts`
- Modify: `src/core/ingest.ts`
- Modify: `src/core/types.ts`
- Modify: `tests/core/messages.test.ts`
- Modify: `tests/core/ingest.test.ts`

**Interfaces:**
- Produces `getMessagePkById(db, messageId): number | null`.
- Extends `StoredIncomingMessage` with `messagePk` and `IncomingMessage` with optional `sourceMessagePk`.

- [ ] **Step 1: Write failing persistence/linkage tests**

Assert a new live insert returns its row primary key, a history-placeholder upgrade resolves the existing primary key, a duplicate delivery remains skipped, and only a newly stored/upgraded message receives `sourceMessagePk` before runtime dispatch.

- [ ] **Step 2: Prove the red state**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/core/messages.test.ts tests/core/ingest.test.ts --pool=forks`

Expected: FAIL because the message primary key is not exposed or threaded.

- [ ] **Step 3: Add the canonical read and thread the key**

Keep `storeMessageIfNew`'s boolean contract unchanged. Resolve the primary key from `messages.message_id` immediately after a successful insert/upgrade, reject a missing row as a persistence error, return it from `persistIncomingMessage`, and assign it to the runtime-bound message before any dispatch branch.

- [ ] **Step 4: Verify and commit**

Run the focused tests plus `tests/core/database-schema-ceiling.test.ts`.

Expected: PASS with no duplicate runtime dispatch.

Commit: `feat(ingest): thread source message identity`

### Task 3: Enforce one inline proposal per source in the database

**Files:**
- Modify: `src/core/database-schema-version.ts`
- Modify: `src/core/database.ts`
- Modify: `src/core/substrate/beads.ts`
- Modify: `tests/core/database-schema-ceiling.test.ts`
- Create: `tests/core/migration-45-inline-proposal-source.test.ts`
- Modify: `tests/core/substrate/beads.test.ts`

**Interfaces:**
- Adds migration 45 and partial unique index `idx_beads_inline_source_unique`.
- Produces `createInlineProposal(db, args): { bead: BeadRow; created: boolean }`.

- [ ] **Step 1: Write failing migration and idempotency tests**

Assert the index applies only to non-null inline-imperative proposal sources; two different source keys may share content; 100 attempts through independent connections to one temporary database produce one bead and one initial event; an exact retry returns the existing row; and a same-source conflict in owner/chat/verb/target fails as a typed collision.

- [ ] **Step 2: Add transaction fault-injection tests**

Inject failure before bead insert, after bead insert, after event insert, and before commit. Assert each result is zero complete captures or one bead/event pair, never a half-pair.

- [ ] **Step 3: Prove the red state**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/core/migration-45-inline-proposal-source.test.ts tests/core/substrate/beads.test.ts --pool=forks`

Expected: FAIL because migration 45 and idempotent create do not exist.

- [ ] **Step 4: Implement migration 45 and idempotent admission**

Bump the schema ceiling to 45. Before index creation, fail with a bounded migration error if existing non-null inline sources collide. Add the partial unique index over `source_message_pk` where it is non-null and `proposal_reason` is an inline imperative. Implement `createInlineProposal` by calling `createBead`; on the unique constraint, load the existing bead, compare stable identity fields, return an exact match, and reject any collision. Do not duplicate bead/event insertion SQL.

- [ ] **Step 5: Verify and commit**

Run the focused migration, schema-ceiling, migration-safety, and substrate tests.

Expected: PASS, including crash and retry invariants.

Commit: `feat(substrate): make inline proposals idempotent`

### Task 4: Apply all runtime admission gates

**Files:**
- Modify: `src/runtimes/agent/runtime.ts`
- Modify: `tests/runtimes/agent/runtime.test.ts`

**Interfaces:**
- Consumes the typed classifier, transport-authenticated grant resolver, `contentType`, `isSyntheticJob`, and `sourceMessagePk`.
- Calls only `createInlineProposal` for admitted messages.

- [ ] **Step 1: Add failing runtime matrix tests**

Cover authenticated admin text, spoofable transport, non-admin, media captions, transcripts, synthetic jobs, outbound echoes, missing source key, quoted/fenced bodies, repeated delivery, and group mention stripping. Assert rejected messages create no bead/event and admitted rows carry the exact source key.

- [ ] **Step 2: Prove the red state**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/runtimes/agent/runtime.test.ts --pool=forks -t "inline imperative"`

Expected: FAIL because the runtime currently scans all content types and writes a null source key.

- [ ] **Step 3: Replace the runtime hook**

Require authenticated admin grant, real inbound text, non-synthetic input, and non-null `sourceMessagePk`. Classify once, use the returned verb/target, and call `createInlineProposal`. Log bounded reason codes only at debug level; keep extractor exceptions, idempotency collisions, and unrecoverable storage faults visible through the existing failure path.

- [ ] **Step 4: Verify and commit**

Run focused runtime, classifier, ingest, and bead tests.

Expected: PASS; no private content appears in logs asserted by tests.

Commit: `fix(runtime): gate inline proposal admission`

### Task 5: Add atomic audited batch rejection for cleanup

**Files:**
- Modify: `src/core/db-tx.ts`
- Modify: `src/core/substrate/beads.ts`
- Modify: `tests/core/db-tx.test.ts`
- Modify: `tests/core/substrate/beads.test.ts`

**Interfaces:**
- Produces `withImmediateTransaction` and `rejectProposalsBatch`.
- Reuses one internal transition implementation for single and batch rejection.

- [ ] **Step 1: Write failing atomicity tests**

Assert the batch validates every proposed row before mutation, writes one status event per row, uses one immediate transaction, rolls the entire batch back on row drift/event failure, rejects terminal/non-proposed rows, and returns exact affected/event counts.

- [ ] **Step 2: Prove the red state**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/core/db-tx.test.ts tests/core/substrate/beads.test.ts --pool=forks`

Expected: FAIL because no immediate transaction or batch transition exists.

- [ ] **Step 3: Refactor without duplicating transition logic**

Extract an internal transition operation that assumes an open transaction. Keep existing single-row public APIs wrapping it in the canonical transaction runner. Add `withImmediateTransaction` using a prepared `BEGIN IMMEDIATE`, and implement batch rejection as validate-all then transition-all within that runner.

- [ ] **Step 4: Verify and commit**

Run focused transaction/substrate tests and the repository transaction-pattern guard.

Expected: PASS with the injected event-write failure proving full rollback.

Commit: `refactor(substrate): share audited batch transitions`

### Task 6: Build the reversible cleanup command

**Files:**
- Create: `scripts/inline-proposal-cleanup.ts`
- Create: `tests/scripts/inline-proposal-cleanup.test.ts`
- Modify: `docs/runbooks/substrate-slice-1.md`
- Modify: `docs/configuration.md`

**Interfaces:**
- Commands: `plan`, `apply`, `verify`, `rollback`.
- Private artifacts: manifest, database/WAL/SHM snapshot, apply receipt, verification receipt.

- [ ] **Step 1: Write failing plan/apply/verify/rollback tests**

Use isolated temporary databases. Cover valid/invalid mixtures, stale fingerprints, ambiguous source events, unknown classifier version, missing WAL/SHM, busy/read-only/full databases, changed rows, repeated apply, repeated rollback, and rollback blocked by later edits. Assert plan mode performs no writes.

- [ ] **Step 2: Add a negative control**

Run the harness against an intentionally permissive classifier fixture and assert it detects retained-valid drift. Remove the intentional break after proving the control.

- [ ] **Step 3: Prove the red state**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/scripts/inline-proposal-cleanup.test.ts --pool=forks`

Expected: FAIL because the command does not exist.

- [ ] **Step 4: Implement plan and snapshot creation**

Resolve exact paths, copy the database with WAL/SHM companions into a private operator-selected directory, verify snapshot readability, classify only `status='proposed'`/`actor='inline'` rows, and write an atomic mode-0600 manifest containing hashes and prior state but no message body.

- [ ] **Step 5: Implement apply, verify, and rollback**

Require an exact manifest/database fingerprint, re-read all rows, use `rejectProposalsBatch`, compare affected/event counts, run integrity and retained-valid checks, and emit a private receipt. Rollback only rows whose status and cleanup event still exactly match the manifest; otherwise stop for review.

- [ ] **Step 6: Verify and commit**

Run focused cleanup/substrate/classifier tests, `npm run guard:repo:branch-diff`, `npm run guard:publication:staged`, and test-integrity scanning.

Expected: PASS. No command is run against a live database in this task.

Commit: `feat(ops): add reversible inline proposal cleanup`

### Task 7: Complete local verification and shadow classification

**Files:**
- Modify only documentation or tests found inaccurate by the verification pass.

- [ ] **Step 1: Run the complete focused suite**

Run classifier, messages, ingest, schema, beads, runtime admission, cleanup, and integrity tests with pinned tools. Record exact exits.

- [ ] **Step 2: Run architecture and repository gates**

Run typecheck, `guard:lint:src`, `guard:ssot-patterns`, `guard:boundaries`, repository/publication/work-index/doc-tally guards, and test-integrity. Compare warnings with the pre-change baseline; new warnings are failures even when the ring is non-blocking.

- [ ] **Step 3: Run private shadow classification read-only**

Against copied databases only, report total, admitted, rejected-by-reason, null-source legacy count, and content hashes. Required aggregate result: four reviewed valid structures admitted and 733 audited false structures rejected. Any body-level discrepancy blocks cleanup.

- [ ] **Step 4: Produce the handoff**

Record commit, tests, shadow counts, skipped/inconclusive checks, rollback command, and the still-gated live cleanup/deployment steps. Do not claim the backlog repaired until an authorized live apply has an independent verification receipt.
