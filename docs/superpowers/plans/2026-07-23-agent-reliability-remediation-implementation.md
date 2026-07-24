# Agent Reliability Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development or superpowers:executing-plans.
> Every behavior change follows test-first red-green-refactor. Between cycles,
> run verification, gap analysis, hypothesis falsification, duplication review,
> and architectural fitness/simplification.

**Goal:** Make halted queues visible, make event-loop health suspend-aware,
preserve per-chat MCP actor isolation across every eligible CLI provider, and
remediate the affected macOS host without replaying unsafe deliveries or
exposing secrets.

**Architecture:** Deliver three independent branches from refreshed `main`.
Provider actor isolation lands first because it closes the highest-risk
authorization gap and extracts current runtime code before the file-size
ratchet tightens. Queue-health truth and suspend/platform hardening remain
separate main-based changes. Host operations are fail-closed and recorded in a
private schema-version-1 receipt.

**Tech Stack:** TypeScript 5.9, Node.js 24, Vitest 4, Unix sockets, launchd,
SQLite, macOS private credential stores, ARC, and Tailscale admin controls.

## Implementation Checkpoint

As of 2026-07-24, the contract lane and three code lanes are committed, pushed,
and published as four open pull requests against `main`. Each branch was
reconciled through an ordinary merge with `main` at
`82a4ae1550297070614ca6634f5cc4cde9269049`; this preserved the published
lineage without force-pushing active reviews. Branch-local push gates pass at
every recorded head. GitHub checks are head-bound and must be read live before
merge; this checkpoint records delivery identity rather than making a timeless
green-CI claim. The pull requests remain unmerged; merge-order integration and
every host mutation remain pending.

| Deliverable | Branch | Pull request | Recorded code head |
| --- | --- | --- | --- |
| Contract, design, and implementation ledger | `fix/agent-queue-health-20260723` | #2142 | This document's commit |
| Provider actor isolation and canary proof | `fix/agent-provider-actor-isolation-20260723` | #2128 | `aee8c7d34` |
| Queue-health truth | `fix/agent-queue-health-truth-20260723` | #2129 | `17a07ef4d` |
| Suspend and platform hardening | `fix/agent-suspend-platform-hardening-20260723` | #2130 | `564bb9c0d` |

The first upstream reconciliation found one substantive overlap: `main` extracted
the legacy per-chat transport helpers from `AgentRuntime` while the actor lane
replaced that legacy socket lifecycle with `PerChatMcpSocketManager`. The
resolution keeps `chat-transport.ts` as the orchestration boundary and the
manager as the sole socket lifecycle owner; the superseded socket/config
implementation was removed rather than duplicated.

The second reconciliation incorporated the upstream durable turn-recovery
supervisor. The actor and suspend lanes required no behavioral resolution.
Queue health retained the existing `runtimeTurnRecoveryIsDegraded` predicate,
consumed upstream's `getTurnRecoveryHealthDetails` helper, and composed the
result with halted-queue health. This avoids a second recovery-health extractor
or competing degradation rule. The documentation and suspend lanes only
conflicted in generated work-index files, which were regenerated from their
reconciled trees. Queue and suspend must still refresh after provider actor
isolation merges, as required by the merge order below.

Dry merge-tree checks across the three recorded heads found no code conflict.
Actor/queue and actor/suspend conflict only in the generated work index;
queue/suspend additionally conflict in the generated public-surface registry.
After each preceding pull request lands, the next branch must merge the new
`main`, regenerate those registries, and rerun its complete gate. The current
independent green heads are not evidence that the later landing refresh can be
skipped.

Each reconciliation cycle ran verification, gap analysis, a falsifiable
integration hypothesis, duplication review, and architecture/fitness
simplification. One queue push attempt was inconclusive because a locally
rebuilt native dependency matched the shell's Node ABI rather than the
repository-pinned Node 24 ABI. Rebuilding it through the pinned npm wrapper,
rerunning the two recovery suites, and rerunning the complete push gate passed;
the failed attempt is not counted as verification.

A third reconciliation incorporated the upstream guard mute-duration and alert
routing fix. Dry merge-tree checks and ordinary merges were conflict-free in
all four lanes. The change does not touch the agent runtime, health contracts,
socket lifecycle, platform probes, or host-remediation tooling; focused lane
tests and the complete push gates remain the acceptance evidence.

A fourth reconciliation incorporated the upstream empty-stdin fail-closed
pre-push guard. All four dry merge-tree checks and ordinary merges were
conflict-free. The guard's 62 focused tests pass in each applicable tree; the
complete branch push gates exercise the updated guard before publication.

The unpushed `fix/agent-provider-canary-proof-20260723` precursor was compared
with `git range-diff` and `git cherry`. Its actor and canary work is incorporated
and expanded in PR #2128, so its clean local worktree and branch were retired;
it never had a remote branch or pull request.

Thirteen bounded external design, implementation, and pull-request reviews
were accepted after lead source verification. Eight additional attempts were
recorded as inconclusive because of controller, capacity, or watchdog
termination before a valid result. All accepted decisions are incorporated in
the design, plan, or reviewed code. The exact completed review-cache
directories may therefore be removed while the durable dispatch ledger and
active session journals remain intact.

There is no stash attributable to this lane. The four remaining lane
worktrees are clean, active review surfaces for the open pull requests, not
stale worktrees. They must be removed with their local branches only after the
corresponding pull request is merged or explicitly abandoned.

## Global Constraints

- Refresh live `origin/main` and inspect overlapping open PRs before every
  branch. Preserve merged route/fallback behavior; do not import stacked work.
- Do not increase runtime or test fitness baselines. Extract cohesive code
  before adding new runtime behavior.
- Masked, partial, stale-head, empty-scope, or environment-invalid checks are
  inconclusive.
- Never expose raw JIDs, chat identifiers, socket paths, secrets, message
  content, or raw host errors in new health, logs, or JSON-RPC errors.
- Use the configured SSH remote, one PR per branch, and no merge without
  separate authorization.
- Host mutations require the private operation record and exact precondition
  checks. Never restore an exposed plist or make retired deliveries replayable.

## Task 1: Finalize and publish the contract

- [x] Amend the approved design with strict `> 250 ms` lag semantics, exhaustive
  provider capability mapping, awaitable socket readiness, state-root socket
  placement, Tailscale-first ordering, exact host timeouts, and acceptance
  predicates.
- [x] Regenerate the work index and pass publication, tally, documentation,
  non-vacuity, diff, and repository staged guards.
- [x] Commit and push the design and this plan on
  `fix/agent-queue-health-20260723`.

## Task 2: Provider actor isolation

Create `fix/agent-provider-actor-isolation-20260723` from refreshed `main`.

- [x] RED: add exhaustive provider MCP-mode, socket readiness, proxy precedence,
  content-free error, actor-bound child environment, concurrent-chat,
  request-override, rekey, stale-socket, cleanup, and fallback non-overlap tests.
- [x] GREEN: add the exhaustive MCP capability to the closed provider registry;
  extract a per-chat MCP socket manager below the runtime state root; make socket
  startup awaitable; await readiness at the central child-spawn boundary; and
  preserve the actual routed/fallback provider selected by current `main`.
- [x] Exact-path collision handling distinguishes a live duplicate socket from
  an unreachable same-UID stale socket. Reject live, foreign-owned, symlink, and
  non-socket paths without unlinking them.
- [x] Keep static `WHATSOUP_SOCKET` compatibility only outside eligible
  per-chat CLI sessions. Eligible sessions receive a live
  `WHATSOUP_MCP_SOCKET` or fail before child spawn.
- [ ] Prove with one real-provider integration canary per eligible CLI that the
  provider child propagates `WHATSOUP_MCP_SOCKET` to its MCP proxy despite the
  static compatibility config. The actual provider process group must launch
  the checked-in proxy, complete `initialize` and `tools/list` on the dynamic
  socket, make zero static-socket connections, and be fully reaped without a
  model turn or WhatsApp operation. Bind a redacted host-local receipt to the
  provider binary, platform, proxy, and canary contract. A missing, stale, or
  unproven receipt blocks only that provider in sensitive non-sandbox per-chat
  mode.
  The implementation and hermetic provider-shaped canaries pass; one
  host-local eligible provider binary remained unavailable, so its exact
  real-provider receipt is still pending.
- [x] Derive eligibility from the actual session/provider child, not the
  instance default. Use one provider-config adapter in production and canaries.
  Use one generic per-chat transition barrier across CLI and API modes; retain
  the actor socket after failed stop proof and remove it only after final
  logical-session teardown with successful child-stop proof.
- [x] Keep the shared/global socket actorless in every non-sandbox per-chat
  runtime. Publish actor FIFO state only to the actual eligible session socket.
- [x] Run targeted tests and typechecks, then the requested verification, gap,
  hypothesis, deduplication, and fitness pass. Fix blocking findings.
- [x] Pass applicable repository guards, commit, push, and open a main-based PR.

## Task 3: Queue-health truth

Create `fix/agent-queue-health-truth-20260723` from refreshed `main`.

- [x] RED: test queue-object lifetime halt state, active-mode aggregation,
  shared/per-chat/all-materialized-per-chat severity and HTTP behavior, scope
  counts, composition with stronger health states, and privacy.
- [x] GREEN: expose a content-free halt accessor and publish only
  `turnQueueHalted` and `turnQueueHaltedScopes` under `runtime.agent`.
- [x] Preserve process-lifetime recovery semantics with a halted-scope latch
  driven by the queue's actual halt transition. The latch survives
  `/kill-session` deletion, delayed halt races, and LID/JID rekeying; admission
  consults it before creating any replacement queue. Restart clears it.
- [x] A shared halt is unhealthy/503; any per-chat halt is degraded/200.
  Existing stronger health wins. Do not add an unhalt API.
- [x] Update the stable public health contract. Extend exact-cause alerting only
  if its interface has merged to `main`; otherwise preserve generic alerting.
- [x] Run targeted tests/typechecks and the five requested review passes, then
  applicable guards. Commit, push, and open a main-based PR.

## Task 4: Suspend and platform hardening

Create `fix/agent-suspend-platform-hardening-20260723` from refreshed `main`.

- [x] RED: cover exactly-250/greater-than-250 ms; prove an exactly-10-second
  observation is retained without incrementing the discontinuity counter
  (without assuming one outlier makes p95 starved); prove greater-than-10
  seconds resets without retaining the gap; and cover timer/snapshot single
  consumption, saturation, sampler restart, warning entry/re-entry/rate
  limiting, poller behavior, launchd working directory, ARC root precedence,
  and private-operation-record validation.
- [x] GREEN: share one monotonic observation transition; publish a saturating
  process-local discontinuity counter; rate-limit only warning logs; add
  deterministic launchd working directory and non-empty explicit ARC-root
  precedence; add the schema-version-1 private record validator.
- [x] The validator uses closed action, step-status, and abort-reason registries;
  receipts contain structured counts/hashes/statuses and never free-form raw
  errors. It enforces the seven-action host dependency order, a
  completed/skipped prefix, and a planned suffix after the first planned or
  aborted gate.
- [x] Expose `validate-private-operation-record schema` and a read-only
  `validate --record <absolute-path> --format json` command. Emit one
  schema-valid JSON object; use exit `0` for valid, `1` for actionable record
  failure, and `2` for infrastructure/read failure.
- [x] Preserve health evaluation on every request and existing strict
  `p95 > 250 ms` behavior.
- [x] Run targeted tests/typechecks and the five requested review passes, then
  applicable guards. Commit, push, and open a main-based PR.

## Task 5: Cross-lane verification and host remediation

- [x] Review every PR diff against the design, current `main`, public surfaces,
  upstream overlap, runtime fitness, and cross-lane compatibility. Resolve all
  critical/important findings and rerun fresh verification.
- [ ] Merge order is provider actor isolation first; then rebase queue-health
  truth and suspend/platform hardening independently onto the resulting
  `main`. Resolve their stable health-contract overlap in each rebased PR and
  rerun its complete gate. Do not merge without separate owner authorization.
- [ ] Create and validate the private operation record. Verify the exact
  Tailscale node and disable key expiry as the first host mutation.
- [ ] After suspend/platform hardening is merged, create the private record with
  the merged validator. After all three PRs merge, migrate credentials into
  private stores,
  validate a credential-free plist, stop and converge within 30 seconds,
  bootstrap, and converge health within 60 seconds.
- [ ] Prove one process, healthy authenticated status, WhatsApp connectivity,
  model usability, SQLite/ARC integrity, secret-free plist, private modes,
  unhalted queues, and actor-socket ownership.
- [ ] Dry-run and retire only the three reviewed quarantine rows. Resolve access
  only with exact identity proof. Record every receipt or abort.
- [ ] Finish after merge and host acceptance with no stale worktrees, local
  branches, stashes, or temporary review artifacts; four main-based pull
  requests (one contract and three code); and an explicit list of skipped or
  inconclusive checks.
