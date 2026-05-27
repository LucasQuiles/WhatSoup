# Anabot Reliability Platform Extraction

**Date:** 2026-05-21  
**Status:** proposed  
**Branch:** `infra/anabot-reliability-tracker`  
**Source evidence:** MINI1 `ana-bot` WhatSoup DB, Anabot estimating refinement audit, and live health snapshot from `/Users/anabot/.claude/skills/anabot-ops-guardrails/scripts/health_snapshot.sh`.

## Purpose

Separate reusable WhatSoup platform/infrastructure work from Ana-specific estimating workflow work. The estimating repo should own QBO/Pete/ClickUp/OneDrive business behavior. WhatSoup should own messaging durability, fleet health, MCP/tool observability, recovery, telemetry, and cross-workflow enforcement.

This tracker is documentation-only. It creates a reviewable PR boundary before any runtime changes are made.

## Observed Evidence

From MINI1 health snapshot on 2026-05-21:

- `tool_calls` count is `0`, while `ana-bot` stdout contains recent agent tool errors.
- `outbound_ops` has `48` stale `pending/safe` rows from 2026-05-03 through 2026-05-05.
- `outbound_ops` has `9` `quarantined/unsafe` rows.
- One `heal_reports` row remains in `attempt_1` from 2026-05-05.
- `enrichment_runs` count is `0`; all `9713` messages have `enrichment_processed_at IS NULL`.
- `com.whatsoup.personal` is not running while `com.whatsoup.ana-bot` is healthy; fleet health is therefore partial, not globally healthy.
- `pinecone` MCP fails in `/Users/anabot`; WhatSoup MCP is connected there, but repo-local MCP health can drift by cwd.
- Recent logs include Graph 404/403-style failures, Bash/test-integrity failures, media download HTTP 410, keepalive reconnects, and oversized read/tool errors.

## PR Split

### Platform PR Scope

Put these in WhatSoup:

- agent tool-call observability and DB/metrics capture
- stale outbound/quarantine health and operator alerts
- replay-policy defaults and replay safety checks
- fleet partial-health reporting across configured lines
- enrichment/recovery/heal freshness in health output
- MCP cwd/config drift detection
- structured platform error codes for messaging, media, MCP, Graph, and browser-adjacent automation hooks
- per-chat/per-line mutating endpoint policy enforcement or a first-class deployable pregate proxy

### Estimating Repo Scope

Keep these in `/Users/anabot/LAB/bes-ana-estimating`:

- QBO field rules, prose style, filename conventions, PDF post-processing
- Pete voice memo grouping/classification
- Ana-specific registries for customers, folders, contacts, exclusions, and tax forms
- ClickUp task conventions for BES estimates
- estimating-specific pressure tests and training examples

## Platform Work Items

| ID | Requirement | Candidate files/modules | Tests | Blocks |
|---|---|---|---|---|
| INFRA-001 | Persist agent tool-call attempts/results into DB or structured metrics so `tool_calls` is not empty when logs show tool errors. Include tool name, status, error class, session, conversation, and timestamps. | `src/runtimes/agent/*`, `src/core/database.ts`, migrations, `src/core/health.ts` | unit test for insert on success/failure; health test showing recent tool error counts | Phase 0 observability claims |
| INFRA-002 | Surface stale outbound durability state in health: pending/quarantined counts, oldest age, replay policy, terminal state, and degraded status when stale. | `src/core/durability.ts`, `src/core/health.ts`, `src/fleet/db-reader.ts`, fleet metrics routes | temp SQLite health test with old pending/quarantine rows | Send-and-verify reliability |
| INFRA-003 | Review outbound replay policy defaults. Require explicit safe replay classification or operator review for old queued messages; prevent blind replay of unsafe or stale content. | `src/core/outbound-sends.ts`, `src/core/durability.ts`, recovery paths | replay policy unit tests; negative control for unsafe stale replay | WhatsApp delivery safety |
| INFRA-004 | Add fleet partial-health semantics. A fleet with one line healthy and another configured line down must report degraded, not healthy. | `src/fleet/health-poller.ts`, `src/fleet/routes/lines.ts`, `src/fleet/routes/fleet-metrics.ts` | route test with one down target; console health metadata test if UI changes | Operator health accuracy |
| INFRA-005 | Add enrichment/recovery/heal freshness to health output: last run, backlog, unresolved reports, oldest unresolved age, and recent recovery action counts. | `src/core/health.ts`, `src/fleet/db-reader.ts`, `src/core/heal.ts`, recovery modules | DB fixture tests for stale heal/enrichment state | Bot reliability dashboard |
| INFRA-006 | Add MCP cwd/config drift check or documented doctor command. Detect stale absolute paths and disconnected required MCPs in active repo cwd. | deploy scripts, docs/runbook, optional `scripts/doctor-*` | script test with fixture `.mcp.json` containing stale `/home/q` path | Multi-agent tool reliability |
| INFRA-007 | Define stable platform error codes for messaging/media/MCP/Graph/fleet failures and map logs/health output to those codes. | `src/errors.ts`, MCP tool handlers, media, fleet routes | classification tests for 403/404/410/timeout/verify mismatch | Operator-safe error handling |
| INFRA-008 | Move the 15-mutating-endpoint WhatsApp pregate/proxy requirement into a platform-owned design, or explicitly mark it as a deploy-only local proxy. | `src/fleet/routes/*`, `src/fleet/index.ts`, deploy proxy scripts | endpoint matrix tests for all mutating paths; wrong-chat and disabled-guard negative controls | Estimating silent-mode safety |

## Acceptance Criteria For The Platform PR

- Adds or updates tests for every changed platform behavior.
- Uses structured error codes rather than opaque strings for new failure handling.
- Adds negative controls proving guards fail when disabled or misconfigured.
- Does not mutate Ana-specific estimating behavior.
- Does not rely on live MINI1 state for tests; live state is evidence only.
- Updates docs/runbook or a dedicated runbook section for any new health/deploy command.
- Provides rollback notes for launchd/proxy/health changes.

## Current Tracking State

- Worktree created from `origin/main`: `/Users/anabot/LAB/WhatSoup-infra-anabot-pr`.
- Existing dirty work in `/Users/anabot/LAB/WhatSoup` is untouched.
- Remote is SSH: `git@github.com:LucasQuiles/WhatSoup.git`.
- No push or PR has been opened.
