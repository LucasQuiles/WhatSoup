# Task: BOT ERRORS Fleet Reliability Protocol

**ID:** bot-errors-reliability-20260531
**Created:** 2026-05-31
**Status:** closed — superseded by the 2026-06-13 bot-errors consolidation close-out
**Profile:** REPAIR + HARDEN
**Scope owner:** Lucas, with Q review gate in BOT ERRORS

## Objective

Ensure no WhatSoup agent, bot, fleet monitor, or maintenance command fails silently across the managed fleet:

- development hosts
- lab relay hosts
- managed mini hosts
- the relay and personal-line alert path

Non-WhatSoup infrastructure is explicitly out of scope for this protocol.

## Success Criteria

1. Critical BOT ERRORS events are written to a durable local outbox before any network send attempt.
2. Relay dispatcher drains local and remote outboxes to the BOT ERRORS group through the operator alert line.
3. Dispatcher, collector, q-loop, deadman, and daily health checks are supervised and independently watched.
4. Daily health checks verify required WhatSoup tools, configs, credentials, plugin/skill coverage, disk, clock, boot, and service state.
5. Agent runtime tool failures emit provider-wide BOT ERRORS alerts without duplicating normal Claude PostToolUse hook logs.
6. Hook-call failures that never produce runtime tool_result events still alert through PostToolUseFailure.
7. Alert rendering cannot be corrupted by WhatsApp mention formatting.
8. Fleet profiles do not confuse phone/account identities with systemd or launchd instance names.
9. Operator/coordination commands have a failure-reporting wrapper or an accepted residual-risk note.
10. Every deploy step is verified one machine at a time before the protocol is considered ready for Lucas's absence.

## Closure Note

This packet is no longer the active implementation tracker. The repo-side bot-errors
hardening arc landed through PRs #781, #787, #788, #797, #802, #805, #809, #811,
#812, and #815. The remaining work is consolidation rather than this packet's
original implementation scope:

- fleet parity and host currency for the already-shipped scripts;
- activation of shipped-but-inert `expected_head_sha` runtime-skew checks and the drift hook;
- corpus validation after fleet propagation;
- estate, rollback-anchor, and human-gated close-out.

The operator-local close-out SSOT lives under
`~/.claude/plans/whatsoup-stabilization/` (`RESUME-NOTE.md`,
`CURRENT-SNAPSHOT.md`, `NEXT-PHASE-GOALS.md`, and `STATUS-LEDGER.md`). Keep this
repo packet as historical evidence; do not use it as the active queue.

## Phase Log

| Phase | Status | Evidence |
|---|---|---|
| Normalize | complete | Existing emitAlert, outbox, health, dispatcher, collector, q-loop, and runner surfaces mapped. |
| Frame | complete | Fleet scope set to managed development, relay, and mini hosts; non-WhatSoup infrastructure excluded. |
| Scout | complete | Tool-result, PostToolUse, dispatcher rendering, stale numeric identity, and operator-command gaps identified. |
| Architect | closed | Superseded by the landed PR train and consolidation notes above. |
| Execute | closed | Bot-errors alert-pipeline hardening landed; residual fleet propagation is tracked as C2/C3/C4 close-out. |
| Synthesize | closed | Runtime evidence and closure certificates moved to the operator-local close-out SSOT. |

## Current Verification Evidence

Local development host:

```text
npx vitest run --pool=forks tests/runtimes/agent/runtime.test.ts tests/hooks/rgp-hooks.test.ts tests/core/workspace.test.ts tests/hooks/poll-interaction-lint.test.ts tests/lib/emit-alert.test.ts
5 files passed, 239 tests passed
```

```text
npx vitest run --pool=forks tests/scripts/bot-errors-dispatcher.test.ts
1 file passed, 4 tests passed
```

Relay host:

```text
npx vitest run --pool=forks tests/runtimes/agent/runtime.test.ts tests/hooks/rgp-hooks.test.ts tests/core/workspace.test.ts tests/hooks/poll-interaction-lint.test.ts tests/lib/emit-alert.test.ts tests/scripts/bot-errors-dispatcher.test.ts
6 files passed, 232 tests passed
```

After B5 redaction hardening:

```text
npx vitest run --pool=forks tests/runtimes/agent/runtime.test.ts tests/hooks/rgp-hooks.test.ts tests/core/workspace.test.ts tests/hooks/poll-interaction-lint.test.ts tests/lib/emit-alert.test.ts tests/scripts/bot-errors-dispatcher.test.ts tests/scripts/bot-errors-emit.test.ts tests/scripts/bot-errors-runner.test.ts
8 files passed, 238 tests passed
```

Expected workspace symlink-refusal logs appear during `tests/core/workspace.test.ts`; these are assertion-path logs, not failures.

## Residual Ownership

This packet has no open implementation gates. Residuals are intentionally carried
outside this historical packet:

1. C2/C3/C4: fleet script parity, deployed-vs-intended host currency, and `expected_head_sha` / drift-hook activation.
2. C7: real alert corpus validation after parity propagation.
3. C8/C10: estate pruning, rollback-anchor retirement, and human-gated ceremonies.
4. Wave-owned runtime/provider residuals remain with their current PR lanes, not this SDLC packet.
