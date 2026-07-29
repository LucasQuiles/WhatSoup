# Primary Probe Cancellation Design

**Status:** completed
**Issue:** #2160

## Goal

Make a primary-model probe deadline cancel the work that lost the timeout race.
A probe that times out while queued must leave the execution gate before the
caller receives `timeout`; a probe that times out after acquiring the gate must
stop its process and release the lease exactly once before cancellation is
complete.

## Scope

This change owns the cancellation chain across:

- `probePrimaryModelUsability()` and its outer deadline;
- the primary-model adapter contract;
- OpenCode execution-gate acquisition;
- the binary probe process lifetime;
- primary-usability and primary-recovery diagnostic bindings.

It does not change provider selection, model selection, probe-result
classification, execution-gate FIFO ordering, or ordinary turn execution.

## Considered Approaches

### 1. One composed abort signal from caller through process close

Give `probePrimaryModelUsability()` a caller signal and let its timeout helper
own a deadline controller. Compose those sources into one signal, pass it
through the adapter contract, use it for execution-gate acquisition, and pass
it to the binary process boundary. The timeout result is not returned until the
losing operation has acknowledged cancellation.

This is the selected approach. It gives one owner for the complete lifecycle,
reuses the gate's existing abort support, and preserves serialization when a
process has already started.

### 2. Cancel only execution-gate waiters

Pass a signal only to `ProviderExecutionGate.acquire()`. This fixes the proven
queued-wait leak but leaves a probe that crosses the grant/timeout race running
after its caller has returned.

### 3. Independent gate and process timeouts

Keep the outer timeout and add separate gate/process timers. This creates
competing clocks and makes it possible for the caller to settle before the gate
wait or process lifetime has reached a terminal state.

## Cancellation Contract

The adapter functions accept an optional `AbortSignal` with their target. The
outer probe API accepts an optional caller signal in
`PrimaryModelProbeOptions`. For each invocation:

1. A nonpositive timeout returns `timeout` without starting an adapter.
2. A pre-aborted caller signal returns `timeout` without starting an adapter.
3. Each invocation owns a fresh deadline controller. Caller abort and deadline
   expiry both abort that controller; repeated aborts are idempotent.
4. The composed signal reaches the adapter, execution-gate wait, and binary
   process boundary.
5. If cancellation wins while queued, the gate removes the waiter and rejects
   acquisition. The adapter maps that expected cancellation to `timeout`.
6. If cancellation wins after grant, the binary probe terminates the child and
   invokes its process-closed callback. The lease is released exactly once.
7. The timeout helper waits for the losing operation to acknowledge abort
   before returning its own `timeout` result. In the queued path that
   acknowledgement is waiter removal. In the running path it is process
   closure and lease release.
8. An ordinary adapter rejection still maps to `probe-threw`; a provider's own
   typed timeout still maps to `timeout`.

Cancellation of one probe does not affect unrelated active or queued work.
Gate FIFO order remains unchanged.

## Diagnostic Contract

`DiagnosticProbe` already receives a per-probe `AbortSignal`. The
`primary-model-usability` and `primary-recovery-probe` bindings must pass it to
their injected runtime functions. Their dependency signatures therefore accept
an optional signal.

The diagnostic bundle's timeout finding is a separate, weaker receipt: it may
still be produced at the bundle deadline and does not attest that asynchronous
process termination has finished. Aborting the signal removes a queued gate
waiter synchronously, so queued work cannot start after that finding. If a
process had already started, its lease remains held while termination finishes,
preventing later serialized work from overlapping it.

## Process Boundary

`BinaryCommandProbeOptions` is the canonical process-lifetime boundary. It must
accept the composed signal and terminate the child on abort while retaining the
existing timeout and `onProcessClosed` semantics. Termination uses the existing
polite-kill then force-kill escalation. If both timeout and abort fire, result
settlement, child termination, and `onProcessClosed` each occur at most once.

The execution lease stays held until `onProcessClosed` observes the child
`close` event. If even forceful termination does not produce `close`, the path
fails closed by retaining the lease instead of allowing another serialized
operation to overlap an unconfirmed process; the diagnostic orchestrator
remains independently bounded. Injected test adapters that do not own a real
child continue to use their returned promise as the complete process-lifetime
contract.

## Observability and Privacy

Use the gate's existing aggregate aborted-wait accounting. Do not add command
arguments, provider output, environment values, credentials, process IDs,
paths, model names, or routing identifiers to health, logs, or alerts.

No new public-health field or durable schema is required.

## Test Strategy

Tests use the real `ProviderExecutionGate` and real primary adapter wiring:

1. Hold the gate, start a probe with a short outer deadline, and observe the
   existing bug: the caller returns `timeout` while one waiter remains.
2. After the fix, assert the caller returns `timeout`, pending waiters return to
   zero, aborted-wait accounting increments, and releasing the held lease never
   invokes the provider boundary.
3. Repeat cancellation to prove no waiter or pressure leak.
4. Grant the probe, abort during the controlled process lifetime, and prove the
   process-close callback releases the lease exactly once before the next
   waiter can run.
5. Race timeout, gate grant, adapter completion, caller abort, and process close;
   assert exactly-once settlement and no unhandled rejection.
6. Verify a caller-aborted diagnostic probe forwards its signal to both primary
   bindings.
7. Preserve successful probes, provider-reported timeouts, nonpositive
   timeouts, adapter throws, and unrelated FIFO ordering.

Focused verification covers primary usability, adapters, the execution gate,
binary preflight, diagnostic probes/bundle, runtime wiring, and test
typechecking. The draft also runs the repository branch gate before push.
