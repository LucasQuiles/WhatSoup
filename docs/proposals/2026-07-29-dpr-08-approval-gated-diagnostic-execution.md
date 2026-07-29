# operations: execute typed diagnostic recipes behind second-approval gating

**Status:** DRAFT feature-request specification for owner review — documentation
only; no build authorization is claimed, and this pull request must not be
treated as queue-ready.
**Grounding:** operator-local sealed evidence run (2026-07-28); repository
claims re-verified at pinned `origin/main` `c9759467d`. Citation legend:
`[mining run (operator-local): …]` points into the sealed mining addendum
retained outside the repository (per-source filenames neutralized to
`source-NN`); `[verified at pinned main c9759467d]` marks path/symbol claims
re-verified at that commit; `[issue survey …: #N]` marks GET-only issue/PR
survey attribution; `[design relay 2026-07-28 (operator-local): …]` marks
attributed design-relay leads, advisory unless independently verified.


| Field | Value |
|---|---|
| DPR ID | DPR-08 |
| OPP mapping | none — QPI expansion (owner directive 2026-07-28, option 1) |
| Tier | n/a — not mining-adjudicated |
| Adjudication verdict | n/a — no mining adjudication; owner directive option 1 |
| Evidence class | QPI relay 2026-07-28 + this-session verification |
| Provenance | QPI parity relay + this-session verification |
| Pinned live-main SHA | c9759467d297787f2e0eb2739bd6cd38ea09145c |
| Status | draft PR — specification only; owner review required before implementation |

## Problem and evidence boundary

The QPI relay proposed a console execution-approval queue based on peer-system patterns, but its older WhatSoup gap statement is stale. Pinned main already contains the `AskUserQuestion` decision queue, GET and POST approval routes, `pending_poll_decisions`, an approval console tab, and a bounded diagnostic-probe builder. [design relay 2026-07-28 (operator-local): oc-re-whatsoup-parity-debt-register.md#pdr-2-console-exec-tool-approval-queue] [verified at pinned main c9759467d]

Existing approval proves a user decision in the question/poll domain; it does not prove authority to start a host process. This request extends the queue model with a distinct `diagnostic_exec` approval domain whose approval authorizes exactly one invocation of one typed, read-only recipe under a bounded execution policy.

The QPI documents are advisory leads, not repository verification. Every current-system statement in this draft is grounded in the pinned path/symbol receipts or dated issue survey, and no peer implementation is imported as authority. [design relay 2026-07-28 (operator-local): provenance.json#promotion_rule]

The capability is intentionally narrower than a terminal: no arbitrary command string, shell, interactive PTY, uploaded script, free-form SQL, unrestricted path, sudo, or reusable approval.

## Systems, schemas, APIs, runtime paths, and docs touched

- `src/fleet/routes/approvals.ts` supplies verified list and decision route patterns through `handleGetApprovals` and `handlePostApprovalDecision`; the new domain must not silently reuse a decision type that means something else. [verified at pinned main c9759467d]
- `src/runtimes/agent/runtime.ts` contains the verified `pending_poll_decisions` owner. It may enqueue a diagnostic proposal but must not execute from an ordinary poll approval. [verified at pinned main c9759467d]
- `console/src/components/line-detail/ApprovalsTab.tsx` is the verified operator queue surface. It needs a visibly separate diagnostic-execution card with recipe, scope, expiry, and one-shot status. [verified at pinned main c9759467d]
- `src/runtimes/agent/diagnostic-probes.ts` supplies the verified `buildDiagnosticProbes` no-shell starting pattern. New recipes should extend a typed registry rather than accept rendered shell text. [verified at pinned main c9759467d]
- `src/fleet/auth-ticket.ts` provides the verified ticket-store boundary; diagnostic approval and execution require a dedicated authorization scope in addition to an authenticated console session. [verified at pinned main c9759467d]
- `docs/proposals/2026-07-19-approval-queue.md` and `docs/proposals/2026-07-20-terminal-leg-map.md` are the documentation surfaces for domain separation and for explicitly deferring interactive terminal behavior. [verified at pinned main c9759467d]
- `src/core/database.ts`, `src/core/durability.ts`, and `docs/durability.md` own durable request, claim, execution, terminal-receipt, retention, and restart semantics. [verified at pinned main c9759467d]
- `src/config.ts`, `src/instance-loader.ts`, and `src/core/agent-config-validator.ts` own the per-instance recipe allowlist and must reject schema drift. [verified at pinned main c9759467d]

Introduce versioned `diagnostic_exec_requests` and `diagnostic_exec_attempts`, or equivalent durability owners. Requests record an opaque request ID, line scope, recipe ID/version, normalized bounded arguments, argument digest, requester class, expiry, approval state, and idempotency key. Attempts record claim, start, terminal outcome, bounded output classification, duration, truncation, and cleanup disposition.

## Proposed data and control flow

1. An agent or operator selects a registered recipe and typed arguments. The server validates them against the recipe schema before creating a pending request.
2. The request is rendered as data, never as a command preview assembled from untrusted text. It shows recipe purpose, target scope, declared data classes, timeout, maximum output, retention, and expiry.
3. An authenticated operator with `diagnostic_exec:approve` may approve or deny. Deny wins over every allow source. Approval binds the exact request ID, recipe version, normalized-argument digest, line scope, and expiry.
4. Approval creates one claimable execution grant. The worker atomically changes `approved` to `claimed`; a duplicate click, retry, restart, or concurrent worker cannot claim it twice. Immediately before spawn it revalidates current requester/approver authority, deny state, recipe version, instance allowlist, scope, argument digest, and TTL; drift changes the request to denied or expired without starting a process.
5. The recipe resolves a fixed executable and fixed argument constructor and submits it to a supervisor-owned watchdog, not an unowned child. Before spawn, the attempt records an opaque execution identity, owner lease, process-group/cgroup intent, and hard kill deadline. After spawn it records the platform handle plus process-start fingerprint; PID alone is never ownership proof. The watchdog calls `execFile` or an equivalent no-shell primitive with a fixed working directory, explicit environment allowlist, no inherited secret-bearing variables, no sudo, timeout, output-byte cap, and process-tree cleanup. If the spawned-state write fails, the watchdog must reap the process group before returning.
6. Output passes through a recipe-specific structured parser and redaction boundary. The durable receipt contains bounded classes and counts, not raw stdout, stderr, paths, SQL results, process arguments, journal text, or identifiers.
7. Completion records `succeeded`, `failed`, `timed_out`, `denied`, `expired`, `cancelled`, `output_rejected`, or `outcome_unknown`. Queue admission, process start, exit zero, parsed result, and diagnostic verdict remain separate states.
8. Restart reconciliation expires unclaimed grants and resumes no process blindly. For a claimed or spawned attempt without a terminal record, it matches the durable opaque execution identity, platform handle, and start fingerprint; a live owned child is reattached only for monitoring and its pre-approved timeout/cleanup, never for a second execution. A mismatched or unverifiable child is terminated through the watchdog/reaper and the attempt remains `outcome_unknown`. Missing terminal proof can never become success.

Initial recipes are deliberately closed:

- `scoped_process_census`: fixed fields and bounded count for one authorized runtime scope;
- `journal_query`: fixed unit/source classes, fixed time window choices, and bounded records;
- `read_only_db_check`: allowlisted query identifiers implemented in code, never supplied SQL;
- `bounded_file_tail`: allowlisted logical artifact IDs mapped server-side, never supplied paths.

## Prerequisites and dependencies

The shipped approval queue, authenticated fleet routes, durable store, and typed diagnostic-probe pattern are prerequisites. Their presence does not itself authorize execution. [verified at pinned main c9759467d]

DPR-08 has no hard dependency on another packet draft. It should use the shared bounded failure taxonomy where available, but it can define a versioned local namespace and later register it without broadening authority.

DPR-09 may consume pending or terminal diagnostic states for operator notification, but push delivery is a soft consumer. A web-push subscription must never be required to approve, deny, execute, or inspect a diagnostic.

DPR-06’s learning approval is a different plane. Accepting a suggestion to learn from a correction cannot approve diagnostics; approving one diagnostic cannot authorize learning, scheduling, or future executions.

## Implementation slices and sequencing

1. Specify the `diagnostic_exec` domain, state machine, roles/scopes, deny-wins precedence, request digest, TTL, single-use claim, and terminal receipt.
2. Add the typed recipe registry with closed argument schemas, fixed executable builders, environment allowlists, timeout/output budgets, redaction policies, and platform declarations.
3. Implement durable enqueue, approve/deny, atomic claim, pre-spawn authorization recheck, supervisor/watchdog ownership, spawned-handle persistence, terminal write, expiry, idempotency, and restart reconciliation.
4. Add the first four read-only recipes behind an empty-by-default per-instance allowlist.
5. Extend fleet APIs and `ApprovalsTab` with domain-specific cards, explicit second approval, expiry, result state, and bounded receipt navigation.
6. Add aggregate health for queue readability, pending/expired counts, oldest age bucket, running age, terminal outcomes, cleanup failures, and evidence-loss state.
7. Add security tests, crash tests, portability fixtures, documentation, retention, and a static guard that rejects shell invocation or unregistered recipes.

The first implementation PR should land the domain and one synthetic recipe before adding host-facing recipes. This makes approval, idempotency, crash, and projection behavior reviewable without simultaneously expanding operating-system access.

## Security, privacy, authorization, and retention

Execution requires separate `diagnostic_exec:request` and `diagnostic_exec:approve` authority; deployments may further separate `diagnostic_exec:run`. Ordinary approval, line access, or console login is insufficient.

Approvals are per request, single-use, short-lived, and bound to an immutable recipe version and normalized argument digest. Changing recipe code or arguments after approval invalidates the grant.

The registry is allowlist-only. Recipes cannot accept command fragments, shell metacharacters, environment assignments, arbitrary paths, arbitrary unit names, arbitrary SQL, glob expansion, or user-selected executables. No recipe invokes a shell, sudo, an interactive program, or a package manager.

Each child gets an explicit environment and fixed working directory. Timeouts terminate the entire owned process tree. Output is bounded before parsing, redacted before persistence, and rejected if it violates the recipe’s closed schema.

Durable records store metadata-only request and outcome evidence. Raw output, command lines, paths, database rows, journal text, environment, credentials, process owners, and private identifiers are never placed in the queue, fleet API, console receipt, logs, or alerts.

Requests and terminal receipts have finite, separately configured retention. Denied and expired requests may be retained for a shorter audit window; raw diagnostic output is not retained by this feature.

## Migration and backward compatibility

Allocate a new migration at implementation time. Existing `AskUserQuestion` rows remain in their original domain and are never reinterpreted as execution approvals.

API changes are additive and domain-tagged. Old console clients continue to display ordinary approvals. New clients must refuse an unknown domain, recipe version, state, or authority field rather than rendering a generic approve button.

The default recipe allowlist is empty. Instances without the new schema or validator continue existing diagnostic behavior and expose the feature as unavailable, not pending.

Rollback empties the allowlist, rejects new requests, expires unclaimed approvals, and lets already-running children reach the bounded timeout/cleanup path. Historical receipts remain readable until retention expiry.

## Failure, recovery, and observability

- Validation failure creates no executable request and returns a bounded reason.
- Approval persistence failure cannot create a grant. UI optimism must roll back to the observed server state.
- Duplicate approval or worker claims are idempotent; exactly one worker may transition an approved request to running.
- Crash before claim leaves the request approved until TTL or reconciliation. Crash after claim but before spawn releases or expires the lease without execution. Crash after spawn is owned by the independent watchdog; startup matches execution identity plus start fingerprint, reattaches monitoring or reaps the child, records cleanup independently, and never automatically re-executes.
- Timeout or cancellation triggers process-tree cleanup and records cleanup outcome independently from recipe outcome.
- Output overflow stops capture, terminates according to recipe policy, and records `output_rejected` or `truncated` without persisting the bytes.
- Receipt-write failure does not convert execution into success; health exposes bounded evidence loss and the UI reports outcome unavailable.
- Queue unreadability, expired authority, version drift, or authz ambiguity fail closed before process start.

Issue #2548 demonstrates why approval success must be separated from downstream work admission and completion. DPR-08 therefore returns distinct approval, claim, execution, and terminal receipts. [issue survey 2026-07-28: #2548]

Issue #2400 shows that successful diagnostic collection can be misrepresented as a new critical incident. DPR-08 treats results as bounded context unless an independently modeled condition owns severity and recovery. [issue survey 2026-07-28: #2400]

## Test matrix and acceptance criteria

- Every recipe passes valid typed arguments and rejects missing, extra, oversized, malformed, and unknown fields.
- Shell metacharacters, option injection, environment assignments, path traversal, arbitrary SQL, glob patterns, and newline injection remain inert data or are rejected before execution.
- A test spy proves the execution primitive receives a fixed executable plus separately constructed argv and never receives `shell: true`.
- Approval binds exact recipe version, scope, arguments, and TTL; any mutation invalidates it.
- Concurrent double approval, double click, retry, and duplicate workers result in one execution.
- Expired, denied, revoked, unknown-domain, wrong-scope, and deny-wins cases start no process.
- Crash injection before request commit, after approval, after claim, between spawn and spawned-state persistence, after spawned-state persistence, after exit, and before receipt commit proves the watchdog reaps or retains bounded ownership, startup never trusts PID alone, and no path blindly re-executes.
- Timeout, output overflow, parser rejection, signal exit, and cleanup failure produce distinct terminal outcomes.
- Each recipe has Linux/macOS availability fixtures or returns explicit `unsupported_platform`; it never emits an operator snippet that assumes an unavailable timeout utility. [issue survey 2026-07-28: #2260]
- Reserved opaque markers placed in stdout, stderr, paths, environment, database fixtures, journal fixtures, and exceptions are absent from durable rows, APIs, console payloads, logs, and alerts.
- Queue, execution, and receipt retention remain bounded under repeated denied, expired, and failed requests.
- Feature-off and empty-allowlist states preserve current behavior and expose no executable approval control.

Acceptance requires one real child-process fault-injection suite using synthetic fixtures, a no-shell static guard, exact-byte privacy canaries, atomic single-use proof, restart reconciliation, and per-recipe contract tests.

## Conflicts and overlap with existing issues and PRs (2026-07-28 survey)

Issue #2548 owns false success and replay admission after an access approval. DPR-08 shares the approval-versus-execution receipt principle but does not change access decisions or queued-message replay. [issue survey 2026-07-28: #2548]

Issue #2400 owns diagnostic bundle severity and incident correlation. DPR-08 supplies execution receipts; it does not decide that a diagnostic result is an alert or a recovery. [issue survey 2026-07-28: #2400]

Issue #2260 owns a GNU-timeout portability defect in an emitted diagnostic snippet. DPR-08 avoids copy-paste snippets and requires platform-declared recipes with runtime-native timeouts. [issue survey 2026-07-28: #2260]

Issue #2135 owns high-cadence controller diagnostic retention, and issue #2392 owns repeated recovery-clear diagnostics. DPR-08 must not create a raw-output archive or one log record per poll; its terminal receipts and health projections are bounded transitions. [issue survey 2026-07-28: #2135] [issue survey 2026-07-28: #2392]

DPR-06 owns approval to accept a learning suggestion. Its authorization cannot be reused here, and `diagnostic_exec` approval cannot be reused for learning, proactive automation, scheduling, or future recipes.

## Unresolved decisions, alternatives, and non-goals

Owner review must approve the initial recipe catalog, per-recipe executable and arguments, maximum runtime/output, TTL, retention, platform matrix, role split, result schema, and whether running attempts may be cancelled after approval.

An alternative is to keep all diagnostics operator-run and generate copyable commands. That reduces server authority but preserves shell, platform, transcription, and outcome ambiguity. The recommended typed-recipe design is safer only if the registry remains closed and narrowly reviewed.

Another alternative is an isolated general command sandbox. That is explicitly deferred because it expands language, filesystem, network, package, persistence, and escape policy far beyond the evidenced read-only need.

Non-goals are interactive PTY access, arbitrary shell or code execution, mutation or repair recipes, sudo, package installation, unrestricted database queries, arbitrary file reads, recurring diagnostics, silent retries, transferable approvals, or using diagnostic success as a health or recovery verdict.

## Rollout, feature flags, and rollback

The recipe allowlist is the primary feature surface and defaults to empty. A validated per-instance flag enables the queue UI only when at least one recipe is both configured and supported on that platform.

Roll out first with a synthetic no-op recipe in non-production tests, then one read-only recipe on an owner-selected canary line, then expand one recipe at a time after security and evidence-loss metrics remain within budget.

Observe pending age, approval latency, expiry, duplicate-claim prevention, runtime, timeout, cleanup, output rejection, receipt loss, and privacy-canary results. Do not collect raw recipe output as rollout telemetry.

Rollback empties the allowlist and rejects new requests. Unclaimed grants expire; running attempts are bounded by their existing timeout and cleanup contract. No rollback path turns a previously approved request into reusable authority.

## Current-main reconciliation — 2026-07-29

This amendment supersedes current-system instructions pinned to `c9759467d`.
Current main is `5398982e610bb948d671181a04856590c9f3f9e5`.

**Readiness:** `BLOCKED PRE-CODE`.

### Distinct authority domain

`diagnostic_exec` is not `AskUserQuestion`, DPR-06 suggestion acceptance, a
generic tool grant, or host administration. Approval means consent for one
normalized recipe, scope, actor, version, and digest. Existing policy and the
canonical execution owner must independently authorize and admit it.

### Reuse and narrow

Reuse current:

- operator authentication and route authorization;
- approval identity and presentation;
- grants and deny-wins policy;
- child-process supervision and process-tree cleanup;
- durability receipt and registered failure vocabulary.

Add one code-level recipe registry plus one reviewed wrapper around `execFile`
or `spawn` with `shell: false`. A static guard must reject shell invocations,
string commands, dynamic binaries, and unregistered process launch outside the
wrapper. No generic PTY, remote shell, sudo path, or arbitrary command input.

### First slice

The scoped process census, journal query, read-only database check, and bounded
file tail are a backlog, not one implementation PR. The first slice requires:

1. a synthetic no-side-effect canary;
2. one owner-selected, low-risk read-only recipe;
3. the complete authority/digest/state/receipt contract;
4. exact RED tests before the wrapper exists.

### Owner decisions

- first real recipe and evidence of need;
- proposer/approver separation and role matrix;
- normalized digest, actor, scope, grant, and version binding;
- TTL, single-use, idempotency, cancellation, and terminal states;
- supervisor and process-tree owner;
- output byte/time/line bounds, overflow state, redaction, and private logs;
- route, UI, audit, retention, and rollback owners.

### First implementation-plan gate

First RED binding:

- File: `tests/runtimes/agent/diagnostic-exec.test.ts`
- Test: `rejects an approved diagnostic when the normalized recipe digest does not match`
- Command: `npm test -- tests/runtimes/agent/diagnostic-exec.test.ts -t "rejects an approved diagnostic when the normalized recipe digest does not match" --pool=forks`
- Expected RED reason: the typed recipe registry, claim state, and bounded
  execution wrapper do not exist.

Prove deny, expiry, replay, wrong actor/scope/digest, self-approval, permission
revocation, spawn rejection, timeout, cancellation, descendant cleanup,
overflow, redaction, terminal receipt, restart behavior, and feature-off
rollback. The static guard and the runtime canary are both required.

The PR must remain draft and use non-closing references.
