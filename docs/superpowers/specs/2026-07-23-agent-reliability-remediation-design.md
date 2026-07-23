# Agent Reliability Remediation Design

**Date:** 2026-07-23
**Target:** WhatSoup `main` and an affected macOS agent deployment
**Status:** pending — owner decisions incorporated; awaiting written-spec review

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

A halt is permanent for the lifetime of that `TurnQueue` object. This change
does not add an administrative unhalt API or automatic retry of the
unfinalizable turn. Operator recovery is a controlled process restart, which
constructs new queue objects after the durable turn state has been captured.

### Health semantics

- A halted shared/global queue is a complete admission-path outage and makes the
  runtime and top-level health `unhealthy`; `/health` returns HTTP 503.
- One or more halted per-chat queues represent a partial outage and make the
  runtime and top-level health `degraded`; `/health` remains HTTP 200.
- The per-chat rule also applies when every currently materialized per-chat
  queue is halted. The runtime has no complete denominator for future chat
  scopes, so it must not infer a global outage from the current map alone.
- An unhalted queue does not change status.
- Existing, more severe health state wins; the new projection never upgrades
  health.

The response exposes the two content-free fields under `runtime.agent`.

### Tests

Tests will prove:

- a queue reports unhalted initially and halted after an unfinalizable failure;
- a halt persists for the queue-object lifetime and a newly constructed queue is
  unhalted;
- a shared halted queue produces runtime `unhealthy`, top-level `unhealthy`, and
  HTTP 503;
- a per-chat halted queue produces runtime and top-level `degraded` with HTTP
  200;
- multiple per-chat halts are counted;
- health output does not contain the halt error or chat identifier; and
- existing healthy queue behavior is unchanged.

## Suspend-aware Event-loop Health

### Discontinuity model

The event-loop sampler retains its injected monotonic clock source
(`performance.now()` by default); wall-clock time must not be used for sampling
or warning intervals. It observes 20 expected 500 ms timer intervals, for a
10-second bounded window. A scheduling gap is the monotonic difference between
the current observation and the next expected timer observation. A gap strictly
greater than the entire 10-second window cannot be classified meaningfully from
the retained samples and is treated as a clock/scheduling discontinuity.
Exactly 10 seconds remains a starvation sample:

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

Both the timer callback and `snapshot()` call one shared, synchronous
observation transition. That transition compares the current monotonic time,
increments and resets on a discontinuity, and advances the next expected
observation before returning. Whichever caller observes a physical gap first
consumes it; the other caller therefore cannot increment the counter again.
This lets a health request immediately after wake avoid briefly publishing a
false starvation sample.

Health status and metrics are evaluated on every request. Only the duplicate
warning log is rate-limited with a five-minute in-process repeat interval:

- log immediately when the sampler first enters a locally-starved state;
- suppress repeated warnings for five minutes while remaining starved;
- log again five minutes after the most recent warning if starvation persists;
  and
- reset the transition latch once the sampler is no longer starved, so a later
  re-entry logs immediately even if five minutes have not elapsed.

Suppression never changes `locally_starved`, lag metrics, health status, or the
discontinuity counter.

### Launchd and ARC

The generated agent launchd plist will set `WorkingDirectory` to the reviewed
WhatSoup checkout. The health job will therefore find the tracked
`.arc/arc.toml` through its existing repository-root resolution. An explicit,
non-empty `WHATSOUP_REPO_ROOT` takes precedence over the working directory and
must resolve to the same reviewed checkout. A missing or invalid ARC binding is
reported by health; it does not silently resolve from a different directory.

Launchd rendering and drift tests will cover `WorkingDirectory`; ARC health
tests will cover a valid tracked binding and a missing binding.

### Tests

Fake-timer tests will prove:

- ordinary sub-threshold lag is healthy;
- a genuine 250 ms-or-greater lag inside the observation window remains
  starvation;
- an exactly 10-second gap remains a starvation sample while a gap greater than
  10 seconds is a discontinuity;
- a gap longer than the observation window resets samples, increments the
  discontinuity counter, and does not report starvation solely for the gap;
- timer-first and snapshot-first observation of the same gap each increment the
  counter exactly once;
- the discontinuity counter saturates safely;
- repeated health requests do not emit unbounded duplicate warnings;
- leaving and re-entering starvation logs immediately, while continuous
  starvation logs at most once per five minutes;
- warning suppression does not hide degraded health; and
- generated launchd configuration has the reviewed working directory.

## Provider Actor Isolation

### Required invariant

Every non-sandbox per-chat CLI session whose child configuration exposes
WhatSoup MCP tools is eligible and must use the actor-bound Unix socket minted
for its logical per-chat session. Eligibility is capability-driven, not
primary-provider-driven: it is evaluated from the actual provider selected for
each primary, fallback, or routed child. The current supported eligible
providers are:

- Claude CLI
- Codex CLI
- Gemini CLI
- OpenCode CLI

API-only providers that do not launch MCP clients remain outside this path. A
future or unrecognized CLI provider that exposes WhatSoup MCP is eligible and
must fail closed until it can receive the actor-bound socket; it must not use
the static socket merely because it is absent from the current provider list.

### Socket selection

Provider MCP config continues to contain the static `WHATSOUP_SOCKET` as a
compatibility fallback for processes outside eligible per-chat sessions. The
stdio proxy changes socket precedence to:

1. non-empty `WHATSOUP_MCP_SOCKET`;
2. non-empty `WHATSOUP_SOCKET`;
3. fail with a content-free JSON-RPC configuration error.

The configuration error uses JSON-RPC code `-32603`, the fixed message
`MCP transport unavailable`, and no `data` member. It must not include socket
paths, environment values, provider names, session identifiers, chat
identifiers, hostnames, usernames, or request content.

When the agent runtime launches an eligible non-sandbox per-chat CLI session,
it must provide `WHATSOUP_MCP_SOCKET` in that child's explicit environment. The
runtime must verify that the value is non-empty and names its live actor-bound
server before spawning the child. It must fail closed before launch if it
cannot prove those conditions, even when `WHATSOUP_SOCKET` is present. It must
never silently fall back to the global socket in that mode.

### Lifecycle

Actor socket creation precedes provider launch. One socket belongs to one
logical per-chat session and may be reused by sequential primary, fallback, or
routed provider children for that same session; provider children for the same
session must not overlap during a transition. The provider receives the socket
only in its child environment.

The socket lives under a mode-`0700` runtime-owned directory, is mode `0600`,
and is owned by the agent process UID. Its deterministic path is unique to the
logical per-chat session. Before binding, the server unlinks only that exact
known path, which recovers a stale file left by process crash or power loss
without scanning or glob-deleting unrelated sockets.

Session teardown removes the actor-bound socket and server after the child has
stopped. Cleanup is idempotent and applies to normal exit, provider failure,
fallback transitions, kill, and runtime shutdown. A cleanup failure is logged
without identifiers and makes the applicable host acceptance check fail.

The MCP server remains the authorization boundary: actor identity is derived
from the bound socket/server context, not from provider-supplied request
content. The socket context pins the logical conversation, while the server's
per-request actor resolver reads the actor of the currently executing turn and
denies sensitive tools when no owned executing actor exists. A child cannot
select or override either value in request content.

### Tests

Tests will prove:

- proxy precedence chooses `WHATSOUP_MCP_SOCKET` over `WHATSOUP_SOCKET`;
- the static socket remains compatible outside eligible per-chat sessions;
- missing both sockets fails with a redacted JSON-RPC error;
- Claude, Codex, Gemini, and OpenCode per-chat launches receive the actor socket;
- an eligible launch with only `WHATSOUP_SOCKET` present fails before child
  spawn;
- an unrecognized CLI provider exposing WhatSoup MCP also fails closed until
  actor-socket wiring is available;
- fallback and natural-language routing retain the same actor binding;
- an eligible launch with no actor socket fails before child spawn;
- two concurrent chat sessions receive distinct sockets and actors; and
- normal and exceptional teardown remove only the owning session's socket;
- a stale exact-path socket is replaced safely on the next bind; and
- socket permissions and ownership match the runtime contract.

## Host Remediation

### Private operation record

The host operation uses a timestamped JSON record outside every repository
under `$HOME/.local/state/whatsoup/private-ops/`. The directory is mode `0700`
and each record is mode `0600`, owned by the operator account. The record has a
schema version, run ID, creation timestamp, operator identity, target commit,
and an ordered step list. Each step records its action, opaque private target
IDs where required, start and completion timestamps, pre- and post-operation
counts or hashes, result, and any abort reason.

The record never stores credential values, message content, raw errors, full
JIDs, or full phone numbers. It remains in the host's private backed-up state
until all associated pull requests and host acceptance evidence are complete.
Deletion is a separate owner-authorized operation.

### Launchd and credentials

Regenerate the agent plist from reviewed repository tooling with:

- one deterministic program invocation;
- the reviewed checkout as `WorkingDirectory`;
- only non-secret environment and paths in the plist; and
- provider credentials loaded from the supported macOS Keychain or a
  mode-`0600` private token file, as supported by the deployment scripts.

Credential migration and rotation use this order:

1. copy the currently working provider credential from the plist into its
   supported private store without printing it;
2. prove the private store can load that credential;
3. generate and validate a credential-free candidate plist;
4. generate a new local health token directly into the private store;
5. stop the launchd job, wait for zero matching processes and no owner of the
   expected port or sockets, atomically install the candidate plist, and
   bootstrap the job;
6. prove exactly one launchd-managed process, validate health with the new
   token, and prove provider usability; and
7. where supported, issue a new provider credential into the private store,
   validate it, then revoke the exposed credential upstream.

If private-store loading, plist validation, stop convergence, bootstrap,
single-process convergence, health authentication, or provider usability
fails, stop the run and record the abort. Do not continue to quarantine,
access, or Tailscale mutations. Do not restore a plist containing exposed
credentials; correct the credential-free candidate or issue another new
credential. When an upstream provider has no safe, verifiable rotation path,
record that explicit gap after removing the plaintext plist copy. Never print
secret values during migration or validation.

### Quarantine

Use the repository's quarantine retirement script, which creates a database
backup before mutation. Retire only the three locally reviewed row IDs as
`failed_permanent` deliveries. Keep exact IDs in the private operation record,
not the public repository. Do not resend them. Validate:

- the backup exists, is mode `0600`, passes SQLite `quick_check`, and has the
  expected pre-mutation schema and row counts;
- the three exact rows are no longer actionable;
- no additional row changed; and
- no outbound submission or echo was created by the operation.

The backup is forensic evidence and an input to a scoped repair, not a
whole-database rollback image. Never restore it wholesale because that would
make the three intentionally retired rows actionable again. If validation
finds an unintended mutation, stop and repair only the unintended rows in a
new transaction while preserving the three reviewed retirements.

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
- private operation record location, schema, and permissions;
- no halted queue;
- the three quarantine rows retired with backup evidence;
- the access queue resolved or explicitly blocked on identity proof; and
- Tailscale online with key expiry disabled.

Every mutating subsection is a gate. A failed precondition or postcondition
stops later host mutations, records the abort and evidence gathered so far, and
leaves the remaining steps pending.

### Code-to-operation dependencies

| Host operation | Required reviewed code |
| --- | --- |
| Queue-halt health acceptance and restart recovery | Queue-health truth merged to `main` |
| Working directory, ARC, discontinuity, credential-free plist, and launchd restart | Suspend/platform hardening merged to `main` |
| Actor-socket permissions, binding, and provider routing acceptance | Provider actor isolation merged to `main` |
| Quarantine retirement | Existing reviewed retirement script; independent of the three new branches |
| Access-request identity decision | Existing reviewed access tooling; independent of the three new branches |
| Tailscale expiry change | Tailscale admin control plane; independent of the three new branches |

Independent operations still wait for the launchd and credential gate to leave
the agent healthy with exactly one process.

## Rollout and Rollback

Each code change is tested and reviewed independently, then merged to `main`.
The host deploys only reviewed commits. Before every host mutation, capture the
current commit, plist metadata, process state, health response, and database
backup where applicable.

Rollback consists of:

- restoring the prior reviewed `main` commit and regenerating the plist;
- regenerating a credential-free plist rather than restoring a prior plist that
  contains exposed secret values;
- repairing unintended quarantine changes transactionally without restoring the
  database wholesale or reversing the three reviewed retirements; and
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
