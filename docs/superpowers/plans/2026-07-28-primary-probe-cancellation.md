# Primary Probe Cancellation Implementation Plan

**Status:** active

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make primary-model probe deadlines cancel queued gate waits and running probe processes so a timeout cannot leave work that starts or continues later.

**Architecture:** Treat the caller signal and the probe deadline as one cancellation lifecycle. The primary probe composes those inputs, forwards the resulting signal through every adapter, and does not report its timeout until the adapter has acknowledged cancellation. OpenCode gate waits consume the signal before admission; spawned CLI probes terminate on abort and retain the execution lease until the child closes. Diagnostic probes forward their existing per-probe signal into the same lifecycle without changing the diagnostic orchestrator's bounded best-effort contract.

**Tech Stack:** TypeScript, Node 24.15.0, Vitest

## Global Constraints

- Keep the change scoped to issue #2160; do not change provider-selection policy or public health schemas.
- Exercise the real `ProviderExecutionGate` and real adapter wiring for the queue regression.
- Preserve the binary process lifetime rule: the OpenCode lease releases only after `close`, never merely when a timeout result is produced.
- Keep caller and deadline abort handling idempotent and remove listeners after settlement.
- Preserve successful API and CLI probe behavior.
- Use Node 24.15.0 for every test and validation command.
- Public commits, PR text, and issue comments must contain no workstation, user, fleet, credential, model-worker, or private-path details.

---

### Task 1: Lock the real queued-timeout regression

**Files:**

- Modify: `tests/runtimes/agent/primary-model-usability-adapters.test.ts`
- Reference: `src/runtimes/agent/provider-execution-gate.ts`
- Reference: `src/runtimes/agent/providers/primary-model-usability.ts`
- Reference: `src/runtimes/agent/providers/primary-model-usability-adapters.ts`

- [ ] Add a test that acquires the real gate as an active turn, invokes `probePrimaryModelUsability` through `createPrimaryModelProbeAdapters`, and gives the probe a short deadline.
- [ ] Assert the probe reports `timeout`, the waiter is removed before the active turn releases, and `abortedWaits` increments.
- [ ] Release the active turn and prove the provider process boundary was never invoked later.
- [ ] Run the focused test and record the expected red failure under current code.

Run:

```bash
npm test -- tests/runtimes/agent/primary-model-usability-adapters.test.ts --pool=forks
```

Expected before implementation: the timed-out probe remains queued or starts after the held turn releases.

### Task 2: Propagate one composed cancellation signal

**Files:**

- Modify: `src/runtimes/agent/providers/primary-model-usability.ts`
- Modify: `src/runtimes/agent/providers/primary-model-usability-adapters.ts`
- Modify: `tests/runtimes/agent/primary-model-usability.test.ts`
- Modify: `tests/runtimes/agent/primary-model-usability-adapters.test.ts`

- [ ] Change both `PrimaryModelProbeAdapters` callbacks to accept an `AbortSignal`.
- [ ] Add `signal?: AbortSignal` to `PrimaryModelProbeOptions`.
- [ ] Replace the abandon-on-timeout helper with a cancellation-aware helper that composes caller abort and deadline abort.
- [ ] For nonpositive deadlines and pre-aborted callers, return `timeout` without invoking an adapter.
- [ ] On deadline/caller abort, abort the adapter and wait for its cancellation acknowledgement before returning `timeout`.
- [ ] Preserve `probe-threw` for genuine adapter errors while treating the expected abort path as `timeout`.
- [ ] Forward the signal into `ProviderExecutionGate.acquire`.
- [ ] Make queued gate cancellation return a typed timeout result without spawning a process or leaking a lease.
- [ ] Run the focused usability and adapter tests until green.

Run:

```bash
npm test -- tests/runtimes/agent/primary-model-usability.test.ts tests/runtimes/agent/primary-model-usability-adapters.test.ts --pool=forks
```

### Task 3: Terminate running binary probes on caller abort

**Files:**

- Modify: `src/runtimes/agent/providers/binary-preflight.ts`
- Modify: `tests/runtimes/agent/providers/binary-preflight.test.ts`
- Modify: `tests/runtimes/agent/primary-model-usability-adapters.test.ts`

- [ ] Add `signal?: AbortSignal` to `BinaryCommandProbeOptions`.
- [ ] Add a red test proving caller abort sends the normal termination signal but does not call `onProcessClosed` before `close`.
- [ ] Prove repeated abort/timeout/close events cannot kill, settle, or notify process closure more than once beyond the existing escalation contract.
- [ ] Remove the abort listener when the child closes or spawn is proven absent.
- [ ] Forward the composed signal from the primary CLI adapter to `probeBinaryCommand`.
- [ ] Preserve the existing SIGTERM-to-SIGKILL escalation and output capture behavior.
- [ ] With a real gate, prove a post-grant abort holds the lease until the simulated child closes and then releases it exactly once.
- [ ] Run binary-preflight and adapter tests until green.

Run:

```bash
npm test -- tests/runtimes/agent/providers/binary-preflight.test.ts tests/runtimes/agent/primary-model-usability-adapters.test.ts --pool=forks
```

### Task 4: Forward diagnostic cancellation into primary probes

**Files:**

- Modify: `src/runtimes/agent/diagnostic-probes.ts`
- Modify: `src/runtimes/agent/runtime.ts`
- Modify: `tests/runtimes/agent/diagnostic-probes.test.ts`
- Modify: `tests/runtimes/agent/runtime-edge-coverage.test.ts`
- Review: `src/runtimes/agent/diagnostic-bundle.ts`

- [ ] Change primary diagnostic dependency signatures to accept an optional `AbortSignal`.
- [ ] Add red tests proving both primary diagnostic probes forward their exact incoming signal.
- [ ] Pass the diagnostic signal into `probePrimaryModelUsability` and `probePrimaryProviderRecovered`.
- [ ] Extend `probePrimaryProviderRecovered` with an optional signal without changing recovery evidence.
- [ ] Preserve the diagnostic bundle's current parallel bounded behavior; do not introduce an unbounded cleanup wait into the general orchestrator.
- [ ] Run diagnostic and runtime wiring tests until green.

Run:

```bash
npm test -- tests/runtimes/agent/diagnostic-probes.test.ts tests/runtimes/agent/runtime-edge-coverage.test.ts tests/runtimes/agent/recovery-probe-validity.test.ts --pool=forks
```

### Task 5: Validate the cancellation contract and blast radius

**Files:**

- Modify if needed: `tests/runtimes/agent/primary-model-usability.test.ts`
- Modify if needed: `tests/runtimes/agent/primary-model-usability-adapters.test.ts`
- Modify if needed: `tests/runtimes/agent/providers/binary-preflight.test.ts`
- Modify if needed: `tests/runtimes/agent/diagnostic-probes.test.ts`

- [ ] Cover caller-aborted-before-start, deadline abort, successful early completion, genuine rejection, queued cancellation, post-grant child termination, close-after-abort, and double-event idempotence.
- [ ] Verify no caller breaks from the adapter signature change.
- [ ] Run the four-file focused baseline plus all newly affected runtime tests.
- [ ] Run TypeScript checks and lint.

Run:

```bash
npm test -- tests/runtimes/agent/primary-model-usability.test.ts tests/runtimes/agent/primary-model-usability-adapters.test.ts tests/runtimes/agent/diagnostic-probes.test.ts tests/runtimes/agent/provider-execution-gate.test.ts tests/runtimes/agent/providers/binary-preflight.test.ts tests/runtimes/agent/recovery-probe-validity.test.ts tests/runtimes/agent/runtime-edge-coverage.test.ts --pool=forks
npm run typecheck
npm run guard:lint:src
```

### Task 6: Document, review, and prepare the draft

**Files:**

- Modify: `docs/work-index.md`
- Modify: `docs/publication-audit.md`
- Modify if public behavior warrants it: `CHANGELOG.md`

- [ ] Update the work index and public change notes with the cancellation guarantee and reproducible tests.
- [ ] Regenerate the publication audit and inspect the diff.
- [ ] Run independent implementation, test-integrity, privacy, and historical-regression reviews.
- [ ] Resolve every actionable finding or document why it is out of scope.
- [ ] Run the repository's complete push gate without masking failures.
- [ ] Rebase onto the current remote base if needed, inspect the range diff, rerun decisive checks, and push over SSH.
- [ ] Open a public-safe draft PR referencing #2160 with impact analysis and exact reproducible commands.
- [ ] Confirm the issue's automatic cross-reference; add the draft PR reference comment if needed.
- [ ] Wait for every required check on the exact hosted head to pass.
- [ ] Replace `IN PROGRESS` with `PATCH READY` and post the exact-head verification receipt on #2160.
