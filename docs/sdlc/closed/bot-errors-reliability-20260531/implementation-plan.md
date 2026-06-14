# BOT ERRORS Fleet Reliability Historical Plan

Status: closed — superseded by the 2026-06-13 bot-errors consolidation close-out.

This file is retained as historical planning evidence. It is not the active
implementation queue. The active tracked trunk is
`docs/reliability-runner/README.md`, with current status rows in
`docs/reliability-runner/feature-matrix.md`.

## Bead Manifest

| Bead | Status | Scope | Verification |
|---|---|---|---|
| BE-01 Durable bus | complete | Outbox, dispatcher, collector, q-loop, deadman, daily health, heartbeat watchdog | Existing service tests and live service status checks |
| BE-02 Process failure runner | complete | `deploy/scripts/bot-errors-runner.py` plus health launchd/systemd wiring | Runner tests; fleet queue checks on managed development, relay, and mini hosts |
| BE-03 Runtime tool failure alerts | superseded | `src/runtimes/agent/runtime.ts`, `src/core/workspace.ts`, `deploy/hooks/post-tool-use-log.mjs` | Runtime/provider residuals moved to current provider-failure lanes. |
| BE-04 Mention-safe dispatch rendering | superseded | `deploy/scripts/bot-errors-dispatcher.py` | Dispatcher alert-pipeline hardening landed in the PR train. |
| BE-05 B5 redaction gate | superseded | TypeScript outbox, Claude hook, Python emit/runner, dispatcher | Redaction/logging follow-up moved to the current logging PR train. |
| BE-06 Hung tool watchdog | superseded | OperationTracker/SSE/MCP timeout surfaces | Not owned by this closed packet; carry only through a current owner lane. |
| BE-07 Stale numeric instance identity | superseded | Fleet health discovery/profile canonicalization | Not owned by this closed packet; carry only through C2/C3 host-currency work if still applicable. |
| BE-08 Operator command wrapping | superseded | Coordinator/operator shell commands | Not owned by this closed packet; carry only through C10/operator ceremony lanes if still applicable. |
| BE-09 Fleet deploy and drills | superseded | Managed development, relay, and mini hosts | Reframed as C2/C3/C4 consolidation: script parity, host currency, and activation proof. |

## Implemented Slice: BE-03

Runtime `tool_result` with `isError=true` is now the canonical provider-wide alert point. It covers normalized tool-result events from Claude, Codex, Gemini, OpenCode, OpenAI API, and Anthropic API because all providers pass through `AgentRuntime` after parser normalization.

`post-tool-use-log.mjs` remains the Claude-local breadcrumb writer. Normal PostToolUse errors do not queue BOT ERRORS by default, preventing duplicate alerts once runtime alerting is active. PostToolUseFailure remains a fallback because hook invocation failures may not produce runtime `tool_result` events.

Alert evidence includes:

- runtime source
- instance
- provider
- session scope
- mention-safe chat JID
- tool scope key and map key
- tool id and name
- classification and detail
- cwd
- error excerpt

Runtime duplicates are suppressed for 60 seconds per runtime by `(instance, provider, tool, category, error excerpt)`.

## Implemented Slice: BE-04

The dispatcher now renders at-sign-bearing text as ` at ` in the WhatsApp message body after redaction. This preserves the underlying event JSON while preventing WhatsApp mention rewriting from corrupting service names or JIDs in delivered diagnostics.

## Implemented Slice: BE-05

B5 broadens redaction before any canary deploy. The TypeScript outbox, Claude hook fallback, Python emit CLI, Python runner, and dispatcher now redact:

- AWS access key IDs
- GitHub classic/fine-grained token prefixes
- JWT-looking values
- PEM private-key blocks
- URL userinfo credentials
- existing key/value, Authorization Bearer, and Bearer token shapes

nucles evidence:

```text
npx vitest run --pool=forks tests/runtimes/agent/runtime.test.ts tests/hooks/rgp-hooks.test.ts tests/core/workspace.test.ts tests/hooks/poll-interaction-lint.test.ts tests/lib/emit-alert.test.ts tests/scripts/bot-errors-dispatcher.test.ts tests/scripts/bot-errors-emit.test.ts tests/scripts/bot-errors-runner.test.ts
8 files passed, 238 tests passed
```

## Closed Packet Boundary

Do not reopen this historical packet for new implementation. Use the current
close-out lanes instead:

1. C2/C3/C4 for fleet propagation, deployed-vs-intended host tables, and inert-feature activation.
2. C7 for real alert corpus validation after propagation.
3. C8/C9/C10 for estate, documentation, rollback-anchor, and ceremony close-out.
