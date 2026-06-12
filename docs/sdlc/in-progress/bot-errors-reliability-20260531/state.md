# Task: BOT ERRORS Fleet Reliability Protocol

**ID:** bot-errors-reliability-20260531
**Created:** 2026-05-31
**Status:** in-progress
**Profile:** REPAIR + HARDEN
**Scope owner:** Lucas, with Q review gate in BOT ERRORS

## Objective

Ensure no WhatSoup agent, bot, fleet monitor, or maintenance command fails silently across:

- MACLAB
- MWLAB
- mini1 through mini11
- nucles relay and personal line

Brick is explicitly out of scope because it is not running WhatSoup and is not part of the Mac fleet for this protocol.

## Success Criteria

1. Critical BOT ERRORS events are written to a durable local outbox before any network send attempt.
2. nucles dispatcher drains local and remote outboxes to the BOT ERRORS group through Lucas's personal line.
3. Dispatcher, collector, q-loop, deadman, and daily health checks are supervised and independently watched.
4. Daily health checks verify required WhatSoup tools, configs, credentials, plugin/skill coverage, disk, clock, boot, and service state.
5. Agent runtime tool failures emit provider-wide BOT ERRORS alerts without duplicating normal Claude PostToolUse hook logs.
6. Hook-call failures that never produce runtime tool_result events still alert through PostToolUseFailure.
7. Alert rendering cannot be corrupted by WhatsApp mention formatting.
8. Fleet profiles do not confuse phone/account identities with systemd or launchd instance names.
9. Operator/coordination commands have a failure-reporting wrapper or an accepted residual-risk note.
10. Every deploy step is verified one machine at a time before the protocol is considered ready for Lucas's absence.

## Phase Log

| Phase | Status | Evidence |
|---|---|---|
| Normalize | complete | Existing emitAlert, outbox, health, dispatcher, collector, q-loop, and runner surfaces mapped. |
| Frame | complete | Fleet scope set to MACLAB, MWLAB, mini1-11, and nucles; brick excluded. |
| Scout | complete | Tool-result, PostToolUse, dispatcher rendering, stale numeric identity, and operator-command gaps identified. |
| Architect | in-progress | Q accepted runtime tool_result as canonical provider-wide path with PostToolUseFailure as fallback. |
| Execute | in-progress | Tool-failure and mention-safe rendering slices implemented locally and synced to nucles for review. |
| Synthesize | pending | Requires Q review, commit, deploy, and per-machine validation. |

## Current Verification Evidence

Local MACLAB:

```text
npx vitest run --pool=forks tests/runtimes/agent/runtime.test.ts tests/hooks/rgp-hooks.test.ts tests/core/workspace.test.ts tests/hooks/poll-interaction-lint.test.ts tests/lib/emit-alert.test.ts
5 files passed, 239 tests passed
```

```text
npx vitest run --pool=forks tests/scripts/bot-errors-dispatcher.test.ts
1 file passed, 4 tests passed
```

nucles:

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

## Open Gates

1. Q review of runtime tool-failure slice, mention-safe renderer slice, and B5 redaction hardening.
2. Commit only the intended files on nucles, preserving unrelated dirty work.
3. Deploy without restarting MACLAB personal agent unless Lucas approves.
4. Validate controlled failure drills per machine, one machine at a time.
5. Close or explicitly document residuals for hung tools, stale numeric instance identity, and operator command wrapping.
