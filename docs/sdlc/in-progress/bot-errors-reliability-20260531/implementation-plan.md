# BOT ERRORS Fleet Reliability Implementation Plan

## Bead Manifest

| Bead | Status | Scope | Verification |
|---|---|---|---|
| BE-01 Durable bus | complete | Outbox, dispatcher, collector, q-loop, deadman, daily health, heartbeat watchdog | Existing service tests and live service status checks |
| BE-02 Process failure runner | complete | `deploy/scripts/bot-errors-runner.py` plus health launchd/systemd wiring | Runner tests; fleet queue checks on MACLAB, MWLAB, mini1-11, nucles |
| BE-03 Runtime tool failure alerts | review | `src/runtimes/agent/runtime.ts`, `src/core/workspace.ts`, `deploy/hooks/post-tool-use-log.mjs` | Runtime, hook, workspace, poll-lint, emit-alert focused tests |
| BE-04 Mention-safe dispatch rendering | review | `deploy/scripts/bot-errors-dispatcher.py` | Dispatcher dry-send regression |
| BE-05 B5 redaction gate | review | TypeScript outbox, Claude hook, Python emit/runner, dispatcher | Secret-shape tests for AWS keys, GitHub tokens, JWTs, PEM private keys, URL userinfo |
| BE-06 Hung tool watchdog | pending | OperationTracker/SSE/MCP timeout surfaces | Add tests for stalled tools that never emit `tool_result` |
| BE-07 Stale numeric instance identity | pending | Fleet health discovery/profile canonicalization | Regression for phone/account identity mapping to canonical service name |
| BE-08 Operator command wrapping | pending | Coordinator/operator shell commands | Document wrapper requirement and add runner-backed helpers |
| BE-09 Fleet deploy and drills | pending | MACLAB, MWLAB, mini1-11 | One-by-one controlled failure drills with BOT ERRORS receipt and Q action |

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

## Required Next Tests

1. Runtime alert dry-run with a controlled tool error and local outbox capture.
2. Dispatcher dry-send rendering check for service names and JIDs.
3. Hung tool simulation with no `tool_result` event.
4. Stale numeric instance profile test for Q account identity versus canonical `q` instance.
5. Runner-wrapped operator command failure drill.
6. Per-machine health check drill: MACLAB, MWLAB, mini1 through mini11.

## Deploy Gate

Do not mark complete until:

- Q has reviewed the diff and evidence in BOT ERRORS.
- Focused tests pass on nucles after final patch.
- Staged guard passes on the exact files to commit.
- Fleet rollout is performed one machine at a time.
- Each machine produces expected alert evidence for at least one controlled failure mode.
- Q confirms it can interpret and act on the alert end to end.
