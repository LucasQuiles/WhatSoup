# BOT ERRORS Tool-Call and Silent-Failure Audit

Date: 2026-05-31
**Status:** completed - historical audit snapshot; remaining residual risks are explicitly named below and are not hidden queue items.

## Scope

Audit of WhatSoup paths that call tools, send WhatsApp messages, proxy MCP calls, or intentionally catch failures. Goal: identify whether failures reach BOT ERRORS in real time, are covered by a health/cadence monitor, or remain accepted residual risk.

## Covered Now

| Area | Path | Coverage |
|------|------|----------|
| Fleet instance health | `src/fleet/health-poller.ts` | Emits `emitAlert()` for unreachable, degraded, and logged-out instances with persisted throttle. |
| Agent respawn exhaustion | `src/runtimes/agent/runtime.ts` | Emits `agent_respawn_failed`; recovery clears the alert source on successful auto-respawn. |
| Agent unrecoverable inline DB failure | `src/runtimes/agent/runtime.ts` | Emits BOT ERRORS on disk/full/readonly/corrupt/CANTOPEN/NOTADB class failures and fails the inbound event. |
| Chat LLM total failure | `src/runtimes/chat/runtime.ts` | Emits `llm_total_failure` after non-retryable auth/rate errors or full fallback failure; clears on recovery. |
| Pinecone and Whisper degradation | `src/runtimes/chat/providers/pinecone.ts`, `src/runtimes/chat/providers/transcription/openai-whisper.ts` | Emit and clear dedicated degraded alerts. |
| Agent outbound send exhaustion | `src/runtimes/agent/outbound-queue.ts` | Added `outbound_send_failed` BOT ERRORS alert after all WhatsApp send attempts fail. |
| Chat outbound send exhaustion | `src/runtimes/chat/runtime.ts` | Added `outbound_send_failed` BOT ERRORS alert after all WhatsApp send attempts fail. |
| Dispatcher send failure | `deploy/scripts/bot-errors-dispatcher.py` | Retries durable events and can use email fallback for quarantine/meta failure. |
| Health/deadman direct send failure | `deploy/scripts/bot-errors-health-check.py` | Deadman attempts direct WhatsApp, then Resend fallback when allowed/configured. |
| Q-loop send failure | `deploy/scripts/bot-errors-q-loop.py` | Logs send failures; independent heartbeat watchdog now detects q-loop silence. |
| Agent tool-result failures | `src/runtimes/agent/runtime.ts` | Runtime `tool_result` with `isError=true` emits throttled provider-wide BOT ERRORS alerts with instance, provider, chat, tool, cwd, classification, and error excerpt. |
| Claude hook-call failures | `deploy/hooks/post-tool-use-log.mjs` | Normal PostToolUse errors remain local breadcrumbs; PostToolUseFailure queues a fallback BOT ERRORS alert for hook-call failures that do not produce runtime `tool_result`. |
| WhatsApp mention-safe rendering | `deploy/scripts/bot-errors-dispatcher.py` | Delivered BOT ERRORS message text renders at-signs as ` at ` after redaction so unit names and JIDs are not corrupted by WhatsApp mention formatting. |
| B5 expanded redaction | `src/lib/bot-errors-outbox.ts`, `deploy/hooks/post-tool-use-log.mjs`, `deploy/scripts/bot-errors-{emit,runner,dispatcher}.py` | Redacts key/value, Bearer, AWS access key IDs, GitHub tokens, JWT-looking values, PEM private-key blocks, and URL userinfo before alert delivery. |

## Covered By Health or Watchdog Instead of Per-Call Alert

| Area | Path | Reason |
|------|------|--------|
| Personal WhatSoup tool inventory | `bot-errors-health-check.py` | Daily health verifies required tools (`send_message`, `list_chats`, `search_messages`, `get_chat`, `get_group_metadata`) on the personal line. |
| q-loop/daily-health silence | `bot-errors-heartbeat-watchdog.py` | Separate process/timer emits durable alerts for stale q-loop, dispatcher, collector, or daily-health cadence. |
| Host-specific service state | `bot-errors-health-check.py` + `deploy/health-profiles/*.json` | Profiles prevent false positives and still assert expected always-on bot hosts. |
| Disk pressure and clock skew | `bot-errors-health-check.py` | Daily health now reports free-space thresholds, clock sync/offset, and boot context. |

## Accepted Non-Incident Paths

| Path | Classification | Why |
|------|----------------|-----|
| `src/mcp/tools/messaging.ts` handler-level errors | Non-incident by default | Tool handlers return sanitized `isError` envelopes to the calling agent/user. Many are user/input errors, not infrastructure failures. |
| `src/fleet/group-resolver.ts` group metadata fallback | Non-incident unless health also fails | MCP failure falls through to HTTP health route. If both are down, fleet health and daily profile checks report the instance. |
| `src/fleet/routes/ops.ts` passive send MCP fallback | Non-incident unless both routes fail | MCP socket failure falls back to HTTP `/send`; HTTP failure returns to caller. Outbound instance health and profile checks cover persistent service failure. |
| `src/fleet/routes/update.ts` git/status fallback catches | Non-incident | These preserve local state and return HTTP failures; not a bot runtime/error-reporting path. |

## Remaining Gaps

| Gap | Severity | Owner Decision |
|-----|----------|----------------|
| Hung or stalled tools that never emit a runtime `tool_result` remain invisible to runtime tool-result alerting. | High | Add OperationTracker/SSE/MCP timeout watchdog coverage so stalled calls queue BOT ERRORS without waiting for provider completion. |
| Stale numeric instance identities can still create false fleet-health alerts if discovery treats a phone/account identity as a service name. | Medium | Add profile canonicalization and a regression for Q's phone/account identity mapping to canonical instance `q`. |
| Operator/coordination shell commands can still fail outside `bot-errors-runner.py` if launched ad hoc. | Medium | Provide runner-backed helper commands or document a hard operator rule with a testable wrapper. |
| Fleet MCP proxy per-call failures (`src/fleet/mcp-client.ts`, `src/fleet/routes/mcp-proxy.ts`) return HTTP errors but do not emit BOT ERRORS. | Medium | Covered by daily tool inventory and instance health for persistent failures. Add per-call alerts only for supervisor-critical tools if Q observes blind spots during drills. |
| Central-dark failure (nucles + personal line down) cannot be observed by the local bus. | High residual G3 | Not closed without explicit Lucas approval for out-of-band Resend deadman/canary firing. Must remain named residual if approval is not granted. |

## Review Result

The highest-risk silent delivery path found in the initial audit was outbound send exhaustion after all retries. It is now instrumented in both agent and chat runtimes.

2026-05-31 update: provider-wide runtime tool-result alerting, mention-safe rendering, and B5 expanded redaction are implemented and under Q review with focused local and nucles tests. Remaining per-tool risk is specifically the hung/no-result class, not ordinary completed tool errors.
