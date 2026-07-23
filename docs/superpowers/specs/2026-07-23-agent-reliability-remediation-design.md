# Agent Reliability Remediation Design

**Date:** 2026-07-23
**Target:** WhatSoup `main` and an affected macOS agent deployment
**Status:** pending — approved design awaiting written-spec review

## Context

The deployment investigation found that the affected agent is presently online
and serving from a clean `main` checkout, but several recent incidents expose
gaps in health truth, host configuration, and actor isolation:

- A turn finalization failure halted a runtime queue. The queue
  correctly stopped advancing, but `/health` did not report the halt.
- The seven-day host record contains hundreds of WhatsApp timeout disconnects
  and event-loop-starvation warnings. The host entered hundreds of sleep
  intervals in the same period; every timeout and starvation warning occurred
  during sleep or within 30 seconds of wake. The laptop was on battery for the
  incident and its battery sleep policy was enabled; AC sleep was disabled.
- A duplicate agent process caused a burst of `connectionReplaced` closures.
  launchd subsequently converged to one process.
- Three outbound deliveries remain quarantined. Their content is unsafe
  to replay automatically, and no evidence shows that they were submitted or
  echoed.
- Non-sandbox, per-chat CLI sessions can inherit provider MCP configuration
  pointing at a shared static Unix socket. Concurrent fallback senders can
  therefore lose the actor identity that should be bound to one chat.
- The live launchd job has neither `WorkingDirectory` nor
  `WHATSOUP_REPO_ROOT`. Health consequently resolves ARC state from an
  unsuitable current directory even though `.arc/arc.toml` is tracked.
- The launchd plist contains provider and health credentials directly instead
  of using the repository's supported private credential stores.
- One access request is pending, and the host's Tailscale node key has a
  near-term expiry.

This design treats the sleep-correlated warnings as a host discontinuity, not as
evidence of an unproven WhatsApp transport defect. Genuine event-loop stalls
must remain observable.

## Goals

1. Make `/health` reflect every halted turn queue without exposing chat
   identifiers or raw errors.
2. Distinguish machine suspend/resume discontinuities from genuine scheduler
   starvation while preserving the existing 250 ms starvation threshold.
3. Ensure every eligible per-chat CLI provider connects through the actor-bound
   socket for that session, including fallback providers.
4. Make the launchd job deterministic, ARC-aware, and free of embedded
   plaintext credentials.
5. Resolve the quarantined deliveries, access request, and Tailscale expiry with
   auditable, fail-closed operations.
6. Deliver reviewable changes as three narrow branches and pull requests based
   directly on `main`.

## Non-goals

- Do not change WhatsApp reconnect behavior based only on the sleep-correlated
  evidence.
- Do not replay any of the three quarantined deliveries.
- Do not force Tailscale reauthentication over the remote session.
- Do not change the host's current Tailscale tag.
- Do not expose raw queue errors, chat JIDs, phone numbers, message content, or
  secrets in health output or logs added by this work.
- Do not combine unrelated existing pull requests or changes from the dirty
  primary checkout.

## Delivery Structure

The work is split into three independently reviewable `main`-based changes:

1. **Queue-health truth:** runtime queue state, health projection, and tests.
2. **Suspend/platform hardening:** sampler discontinuities, warning
   deduplication, launchd working directory, ARC resolution, and tests.
3. **Provider actor isolation:** per-session socket selection, fail-closed
   provider wiring, and cross-provider tests.

The deployment remediation is an audited host operation performed after the
applicable changes are reviewed and merged or, when safe and independent,
through existing operational scripts. No host-only secret is committed.

## Queue-health Truth

### Runtime contract

`TurnQueue` already retains a halt flag and error after an unfinalizable
processor failure. It will expose a boolean, content-free halt accessor. The
agent runtime health snapshot will aggregate:

- the shared/global queue halt state; and
- the number of halted per-chat queues.

The runtime snapshot will add:

- `turnQueueHalted: boolean`
- `turnQueueHaltedScopes: number`

`turnQueueHalted` means that any queue in the active admission mode is halted.
`turnQueueHaltedScopes` is a count only. It must not contain map keys, JIDs, raw
errors, or error strings. In shared mode, the shared queue contributes one
halted scope. In per-chat mode, each halted per-chat queue contributes one; the
otherwise-unused shared queue is not counted.

### Health semantics

- A halted shared/global queue is a complete admission-path outage and makes the
  runtime and top-level health `unhealthy`; `/health` returns HTTP 503.
- One or more halted per-chat queues represent a partial outage and make the
  runtime and top-level health `degraded`; `/health` remains HTTP 200.
- An unhalted queue does not change status.
- Existing, more severe health state wins; the new projection never upgrades
  health.

The response exposes the two content-free fields under `runtime.agent`.

### Tests

Tests will prove:

- a queue reports unhalted initially and halted after an unfinalizable failure;
- a shared halted queue produces runtime `unhealthy`, top-level `unhealthy`, and
  HTTP 503;
- a per-chat halted queue produces runtime and top-level `degraded` with HTTP
  200;
- multiple per-chat halts are counted;
- health output does not contain the halt error or chat identifier; and
- existing healthy queue behavior is unchanged.

## Suspend-aware Event-loop Health

### Discontinuity model

The event-loop sampler observes 20 expected 500 ms timer intervals, for a
10-second bounded window. A single scheduling gap longer than that entire
window cannot be classified meaningfully from the retained samples and is
treated as a clock/scheduling discontinuity:

1. discard the pre-gap observation window;
2. start a new window from the current observation;
3. increment a bounded, monotonic-in-process discontinuity counter; and
4. do not count the discontinuity itself as a starvation sample.

The counter saturates at `Number.MAX_SAFE_INTEGER` rather than wrapping. Health
adds `event_loop.discontinuity_count`. This is process-local diagnostic state,
not a durable incident counter.

Scheduling delays at or above the existing 250 ms threshold that do not exceed
the full observation window remain starvation samples. This keeps genuine
CPU/event-loop blocking visible.

### Warning deduplication

Both the timer callback and `snapshot()` apply the same discontinuity
observation so a health request immediately after wake cannot briefly publish a
false starvation sample. One physical gap increments the counter at most once.

Health status and metrics are evaluated on every request. Only the duplicate
warning log is rate-limited with a five-minute in-process repeat interval:

- log immediately when the sampler first enters a locally-starved state;
- suppress repeated warnings for five minutes while remaining starved;
- log again after the interval if starvation persists; and
- reset the transition latch once the sampler is no longer starved.

Suppression never changes `locally_starved`, lag metrics, health status, or the
discontinuity counter.

### Launchd and ARC

The generated agent launchd plist will set `WorkingDirectory` to the reviewed
WhatSoup checkout. The health job will therefore find the tracked
`.arc/arc.toml` through its existing repository-root resolution. If an explicit
`WHATSOUP_REPO_ROOT` is used, it must resolve to the same reviewed checkout.

Launchd rendering and drift tests will cover `WorkingDirectory`; ARC health
tests will cover a valid tracked binding and a missing binding.

### Tests

Fake-timer tests will prove:

- ordinary sub-threshold lag is healthy;
- a genuine 250 ms-or-greater lag inside the observation window remains
  starvation;
- a gap longer than the observation window resets samples, increments the
  discontinuity counter, and does not report starvation solely for the gap;
- the discontinuity counter saturates safely;
- repeated health requests do not emit unbounded duplicate warnings;
- warning suppression does not hide degraded health; and
- generated launchd configuration has the reviewed working directory.

## Provider Actor Isolation

### Required invariant

Every non-sandbox per-chat CLI session eligible to call WhatSoup MCP tools must
use the actor-bound Unix socket minted for that session. The invariant applies
equally to primary, fallback, and routed CLI providers:

- Claude CLI
- Codex CLI
- Gemini CLI
- OpenCode CLI

API-only providers that do not launch MCP clients remain outside this path.

### Socket selection

Provider MCP config continues to contain the static `WHATSOUP_SOCKET` as a
compatibility fallback for provider processes that do not receive a
session-bound socket. The stdio proxy changes socket precedence to:

1. non-empty `WHATSOUP_MCP_SOCKET`;
2. non-empty `WHATSOUP_SOCKET`;
3. fail with a content-free JSON-RPC configuration error.

When the agent runtime launches an eligible non-sandbox per-chat CLI session,
it must provide `WHATSOUP_MCP_SOCKET` for that exact session. The runtime must
fail closed before launching an eligible session if it cannot produce the
actor-bound socket. It must never silently fall back to the global socket in
that mode.

### Lifecycle

Actor socket creation precedes provider launch. The provider receives the socket
only in its child environment. Session teardown removes the actor-bound socket
and server after the child has stopped. Cleanup is idempotent and applies to
normal exit, provider failure, fallback transitions, kill, and runtime shutdown.

The MCP server remains the authorization boundary: actor identity is derived
from the bound socket/server context, not from provider-supplied request
content.

### Tests

Tests will prove:

- proxy precedence chooses `WHATSOUP_MCP_SOCKET` over `WHATSOUP_SOCKET`;
- the static socket remains compatible outside eligible per-chat sessions;
- missing both sockets fails with a redacted JSON-RPC error;
- Claude, Codex, Gemini, and OpenCode per-chat launches receive the actor socket;
- fallback and natural-language routing retain the same actor binding;
- an eligible launch with no actor socket fails before child spawn;
- two concurrent chat sessions receive distinct sockets and actors; and
- normal and exceptional teardown remove only the owning session's socket.

## Host Remediation

### Launchd and credentials

Regenerate the agent plist from reviewed repository tooling with:

- one deterministic program invocation;
- the reviewed checkout as `WorkingDirectory`;
- only non-secret environment and paths in the plist; and
- provider credentials loaded from the supported macOS Keychain or a
  mode-`0600` private token file, as supported by the deployment scripts.

Rotate the exposed local health token. Rotate provider credentials through their
upstream provider controls when the provider supports a safe, verifiable
rotation path; otherwise record the rotation gap explicitly and remove the
plaintext plist copy only after confirming the private store works. Never print
secret values during migration or validation.

Restart through launchd, then prove exactly one agent process owns its expected
port and socket.

### Quarantine

Use the repository's quarantine retirement script, which creates a database
backup before mutation. Retire only the three locally reviewed row IDs as
`failed_permanent` deliveries. Keep exact IDs in the private operation record,
not the public repository. Do not resend them. Validate:

- the backup exists;
- the three exact rows are no longer actionable;
- no additional row changed; and
- no outbound submission or echo was created by the operation.

### Access request

Resolve the single pending request only after comparing its normalized identity
to the configured primary/admin identity without printing the full phone
number. If it matches the verified owner identity, allow it. If identity cannot
be proven, leave it pending and report that as an explicit operational blocker;
do not guess or block it automatically.

### Tailscale

Use the Tailscale admin control plane to disable key expiry for the exact node
ID recorded in the private operation record. Verify that the node remains
online and no expiry is reported. Do not run `tailscale up --force-reauth`
remotely because it can sever the only access path.

### Host acceptance checks

After remediation, verify:

- one launchd-managed agent process;
- expected port and socket ownership;
- `/health` status and HTTP code;
- WhatsApp connected state and bounded recent churn;
- model usability;
- SQLite quick check and expected schema;
- ARC binding present;
- no plaintext credentials in the plist;
- private credential/token file permissions;
- no halted queue;
- the three quarantine rows retired with backup evidence;
- the access queue resolved or explicitly blocked on identity proof; and
- Tailscale online with key expiry disabled.

## Rollout and Rollback

Each code change is tested and reviewed independently, then merged to `main`.
The host deploys only reviewed commits. Before every host mutation, capture the
current commit, plist metadata, process state, health response, and database
backup where applicable.

Rollback consists of:

- restoring the prior reviewed `main` commit and regenerating the plist;
- restoring the prior plist only if it contains no exposed secret values;
- restoring the quarantine database backup only if validation proves the
  retirement operation changed unintended rows; and
- re-enabling Tailscale expiry through the admin control plane if policy
  requires it.

Quarantined messages are not made replayable as part of rollback. Credential
rotation is not rolled back to exposed values; a new credential is issued
instead.

## Evidence and Completion

Every pull request records its targeted tests and full applicable validation.
The host run records timestamps, commit SHAs, row IDs, counts, and redacted
health results. Masked, truncated, or environment-invalid test runs are
inconclusive and are reported as such.

Completion requires all owned branches pushed, all owned changes committed, no
owned untracked files, clean worktrees, pull requests based on `main`, and an
explicit list of any checks that could not be completed.
