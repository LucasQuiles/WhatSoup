# Historical Pending-Bead Dispositions

Status: active ledger. Updated: 2026-06-13T02:45:00Z.

Purpose: give the 37 historical pending beads and one transport-layer draft a tracked disposition so the active reliability runner does not depend on ignored `.codex` artifacts.

## Quarantined BOT ERRORS Tests

Disposition: resolved. The five quarantined BOT ERRORS hub archives are superseded by live `tests/scripts/*` suites and should remain private historical archives unless live coverage regresses.

Verification:

```bash
npm test -- tests/scripts/bot-errors-runner.test.ts tests/scripts/bot-errors-dispatcher.test.ts tests/scripts/bot-errors-collector.test.ts tests/scripts/bot-errors-heartbeat-watchdog.test.ts tests/scripts/bot-errors-health-check.test.ts --pool=forks
```

Result recorded 2026-06-13T02:32Z: 5 files passed, 196 tests passed.

## Pending-Bead Inventory

- `docs/sdlc/closed/mark-read-api-20260408` (3): `MR-01-health-handler`, `MR-02-fleet-endpoint`, `MR-03-console-ui`.
- `docs/sdlc/closed/multi-provider-runtime-2026-0404` (7): `B01-provider-interface`, `B02-extract-claude-provider`, `B03-config-schema`, `B04-codex-provider`, `B05-api-provider`, `B06-anthropic-api-provider`, `B07-mcp-bridge`.
- `docs/sdlc/completed/codex-transport-gaps-20260404` (14): `B02-system-prompt-identity`, `B03-opencode-parser-concurrency`, `B04-codex-session-resume`, `B04a-codex-threadid-persistence`, `B05-event-driven-ready-signal`, `B06-wire-provider-budget`, `B07-approval-prefilter`, `B08-mcp-config-centralize`, `B09-integration-verification`, `B10-council-review`, `B11-followup-gemini-token-tracking`, `B12-followup-opencode-dual-impl`, `B12a-remove-dead-opencode-adapter`, `B13-gemini-resume-investigation`.
- `docs/sdlc/completed/transport-hardening-20260404` (6): `H01-budget-burst-mitigation`, `H02-budget-test-coverage`, `H03-approval-key-ordering`, `H04-codex-turn-integration-test`, `H05-fitness-sweep`, `H06-council-review`.
- `docs/sdlc/completed/whatsoup-full-hardening-20260331` (7): `B01-fix-test-failures`, `B02-chatruntime-send-retry`, `B03-trivial-p2-fixes`, `B04-docs-configuration`, `B05-docs-tool-reference`, `B06-docs-runbook`, `B07-docs-durability`.
- Separate normalization/spec item: `docs/superpowers/specs/2026-04-25-transport-layer-design.md`.

## Terminal Dispositions

| Source | Items | Disposition | Evidence / residual |
|---|---|---|---|
| `docs/sdlc/closed/mark-read-api-20260408` | `MR-01-health-handler`, `MR-02-fleet-endpoint`, `MR-03-console-ui` | RESOLVED | `/mark-read` is implemented in `src/core/health.ts` and `src/core/mark-read.ts`, proxied through `src/fleet/routes/ops.ts` and `src/fleet/index.ts`, wired in `console/src/lib/api.ts` and `console/src/pages/Inbox.tsx`, and covered by `tests/core/mark-read.test.ts`, `tests/core/health-mark-read.test.ts`, and `tests/fleet/mark-read-endpoint.test.ts`. |
| `docs/sdlc/closed/multi-provider-runtime-2026-0404` | `B01-provider-interface` | RESOLVED | `src/runtimes/agent/providers/types.ts` defines the provider session contract; descriptor/registry invariants are covered by provider hardening and registry tests. |
| `docs/sdlc/closed/multi-provider-runtime-2026-0404` | `B02-extract-claude-provider` | DEFERRED | `src/runtimes/agent/providers/claude.ts` exists, but production `claude-cli` behavior remains partly inline in `src/runtimes/agent/session.ts`; this is non-blocking refactor debt. |
| `docs/sdlc/closed/multi-provider-runtime-2026-0404` | `B03-config-schema` | RESOLVED | `src/instance-loader.ts`, `src/config.ts`, and validator tests accept and validate `agentOptions.provider`, `providerConfig`, and budget settings. |
| `docs/sdlc/closed/multi-provider-runtime-2026-0404` | `B04-codex-provider` | RESOLVED/SUPERSEDED | Codex is implemented through the persistent app-server/session path and `src/runtimes/agent/providers/codex-parser.ts`; resume/thread behavior is covered by session and session-db tests. |
| `docs/sdlc/closed/multi-provider-runtime-2026-0404` | `B05-api-provider` | DEFERRED | `src/runtimes/agent/providers/openai-api.ts` ships a managed OpenAI-compatible provider, but the exact shared `providers/api-loop.ts` extraction is absent. |
| `docs/sdlc/closed/multi-provider-runtime-2026-0404` | `B06-anthropic-api-provider` | RESOLVED | `src/runtimes/agent/providers/anthropic-api.ts` implements the managed Anthropic provider; API/MCP behavior is covered by provider bridge tests. |
| `docs/sdlc/closed/multi-provider-runtime-2026-0404` | `B07-mcp-bridge` | RESOLVED | `src/runtimes/agent/providers/mcp-bridge.ts`, `src/core/provider-mcp-config.ts`, and runtime/workspace writers provide provider-aware MCP config/native bridges. |
| `docs/sdlc/completed/codex-transport-gaps-20260404` | `B02-system-prompt-identity` | RESOLVED | `src/runtimes/agent/session.ts` has provider display names and tests cover provider-specific personal-agent prompt identity. |
| `docs/sdlc/completed/codex-transport-gaps-20260404` | `B03-opencode-parser-concurrency` | RESOLVED | `SessionManager` owns a per-session `createOpenCodeParser()` instance; OpenCode parser isolation is covered in provider parser tests. |
| `docs/sdlc/completed/codex-transport-gaps-20260404` | `B04-codex-session-resume`, `B04a-codex-threadid-persistence` | RESOLVED | Codex thread IDs are captured, persisted as `session_id`, and used for resume/fresh-thread fallback in session and DB tests. |
| `docs/sdlc/completed/codex-transport-gaps-20260404` | `B05-event-driven-ready-signal` | RESOLVED | `providerReadyPromise` replaces busy waiting for Codex/Gemini readiness in `src/runtimes/agent/session.ts`; Gemini tests cover ready-event resolution and timeout. |
| `docs/sdlc/completed/codex-transport-gaps-20260404` | `B06-wire-provider-budget` | RESOLVED | `ProviderBudget` is wired through `SessionManager` and covered by budget, budget-and-mapping, and session-budget tests. |
| `docs/sdlc/completed/codex-transport-gaps-20260404` | `B07-approval-prefilter` | RESOLVED | Codex JSON-RPC approval filtering checks for `jsonrpc` without key-order assumptions; session tests cover non-first-key `jsonrpc`. |
| `docs/sdlc/completed/codex-transport-gaps-20260404` | `B08-mcp-config-centralize` | RESOLVED | Provider MCP config is centralized in `src/runtimes/agent/providers/mcp-bridge.ts` and `src/core/provider-mcp-config.ts`. |
| `docs/sdlc/completed/codex-transport-gaps-20260404` | `B09-integration-verification`, `B10-council-review` | RESOLVED/HISTORICAL | The completed epic state records synthesis approval with critical remediation applied; focused provider/session tests remain the active regression evidence. |
| `docs/sdlc/completed/codex-transport-gaps-20260404` | `B11-followup-gemini-token-tracking` | RESOLVED | `src/runtimes/agent/providers/gemini-acp-parser.ts` extracts token usage from session/prompt and update events; tests cover both `usage` shapes. |
| `docs/sdlc/completed/codex-transport-gaps-20260404` | `B12-followup-opencode-dual-impl`, `B12a-remove-dead-opencode-adapter` | RESOLVED | `src/runtimes/agent/providers/opencode-adapter.ts` is absent, and production uses the SessionManager/OpenCode parser path. |
| `docs/sdlc/completed/codex-transport-gaps-20260404` | `B13-gemini-resume-investigation` | DEFERRED | Gemini ACP session IDs are captured and persisted through generic init handling, but startup still creates a new Gemini ACP session instead of proving provider-supported crash resume. |
| `docs/sdlc/completed/transport-hardening-20260404` | `H01-budget-burst-mitigation`, `H02-budget-test-coverage` | RESOLVED | Provider budget throttling, pending slots, burst limits, daily limits, and reset behavior are covered in provider budget tests. |
| `docs/sdlc/completed/transport-hardening-20260404` | `H03-approval-key-ordering` | RESOLVED | Same current JSON-RPC approval prefilter evidence as `B07-approval-prefilter`. |
| `docs/sdlc/completed/transport-hardening-20260404` | `H04-codex-turn-integration-test` | RESOLVED | `tests/runtimes/agent/codex-turn-lifecycle.test.ts` covers token usage/result separation, single completion, and usage-limit cleanup. |
| `docs/sdlc/completed/transport-hardening-20260404` | `H05-fitness-sweep`, `H06-council-review` | RESOLVED/HISTORICAL | Completed state records synthesis approval; current provider/transport tests are the active regression signal. |
| `docs/sdlc/completed/whatsoup-full-hardening-20260331` | `B01-fix-test-failures` | RESOLVED/HISTORICAL | Historical epic; current focused tests cover affected mark-read/provider/transport/chat surfaces, while full release gates are tracked separately. |
| `docs/sdlc/completed/whatsoup-full-hardening-20260331` | `B02-chatruntime-send-retry` | RESOLVED | Chat runtime send retry and warnings are covered in chat runtime retry tests. |
| `docs/sdlc/completed/whatsoup-full-hardening-20260331` | `B03-trivial-p2-fixes` | RESOLVED | Message chunking, stable admin logs, and legacy import mismatch handling are covered by core message/admin/database tests. |
| `docs/sdlc/completed/whatsoup-full-hardening-20260331` | `B04-docs-configuration`, `B05-docs-tool-reference`, `B06-docs-runbook`, `B07-docs-durability` | RESOLVED | `docs/configuration.md`, `docs/tools.md`, `docs/runbook.md`, and `docs/durability.md` exist and are covered by doc/public-surface drift gates. |
| `docs/superpowers/specs/2026-04-25-transport-layer-design.md` | Transport v2 draft spec | DEFERRED | Current source has a transport contract, testing adapters, Baileys runtime bridge, and Twilio transport, but the draft's Telegram adapter, WhatsApp-v2 strangler, `transport.useV2`, transport-status, and schema checklist are not complete. |

## Residual

`docs/work-index.json` still records the historical bead/spec source rows as `pending`. This ledger and `docs/reliability-runner/feature-matrix.md` are the current triage sources for this reliability wave. Rewriting historical bead files or regenerating the work index is a separate cleanup decision.
