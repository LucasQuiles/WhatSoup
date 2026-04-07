# Fleet Charts — Project Statement

> **Project:** Soup Kitchen Fleet Charts Expansion
> **Date:** 2026-04-07
> **Owner:** Q
> **Status:** Ready for implementation

---

## 1. Problem Statement

The WhatSoup Soup Kitchen page is the fleet-level operational dashboard. It currently provides real-time KPI cards (lines connected, messages sent/received, agent sessions, unread, media processed) and a single message volume chart showing inbound/outbound messages over a fixed 24-hour window.

Operators lack visibility into two critical operational dimensions:

**Token consumption** — The fleet runs 6 WhatsApp instances, each backed by Claude (agent mode) or direct LLM API calls (chat mode). There is no time-series visibility into how many tokens are being consumed across the fleet, which instances are token-heavy, or how consumption trends over days/weeks. The only token data currently surfaced is a lifetime total per session, visible only in the per-line Metrics tab. At fleet scale, this makes cost anomaly detection impossible without manual DB queries.

**Session activity** — Agent sessions are the primary unit of work. Operators can see instantaneous active session counts on KPI cards, but there is no historical view. Questions like "how many sessions were running overnight?", "is session churn increasing?", or "did a restart storm happen at 3 AM?" require log archaeology. The absence of `ended_at` on session records further limits any retrospective analysis.

Secondary gaps:
- The `messages_media` metric is already collected hourly but never surfaced in the UI — media processing volume is invisible beyond the lifetime KPI total.
- The fleet chart is locked to a 24-hour window with no range selector, despite the backend and per-line views already supporting 7d and 30d ranges.
- KPI cards have sparklines for messages sent/received but not for agent sessions or media — even though the data infrastructure to derive them exists (or will after this project).

## 2. Proposed Solution

Add two new chart panels (token usage, session activity) alongside the existing message volume chart in a horizontal 3-up row. Extend the backend with new metric collectors, a token event stream, and session lifecycle tracking. Add a shared range picker and KPI-driven chart expansion.

The solution is decomposed into:

1. **Schema additions** — `agent_token_events` table for granular token tracking; `ended_at` column on `agent_sessions` for session lifecycle closure.
2. **Metric collector extensions** — 6 new hourly metrics (agent/chat tokens in/out, sessions started/active) added to the existing `metrics_hourly` collection pipeline.
3. **API extensions** — Fleet and per-line metrics endpoints extended with token usage, session activity, and response metadata (partial failure counts, per-panel data availability flags).
4. **Bucket densification** — The metrics reader produces zero-filled bucket arrays for the full selected range, eliminating chart gaps and enabling proper empty-state detection.
5. **Frontend chart components** — `ChartPanel` shared wrapper (loading/error/empty/partial states), `FleetTokenChart`, `FleetSessionChart`, modified `FleetMetricsChart` with media series.
6. **Soup Kitchen integration** — 3-up chart row, range picker, `expandedChart` state for KPI-driven zoom, extended sparklines on KPI cards.

## 3. Success Criteria

| Criterion | Measurement |
|-----------|-------------|
| Token visibility | Fleet-wide token consumption (agent + chat) visible as a time-series chart with input/output breakdown |
| Session visibility | Concurrent active sessions and new session starts visible as a time-series chart |
| Media visibility | `messages_media` surfaced as a third series on the message volume chart |
| Range flexibility | Operator can switch between 24h, 7d, and 30d views on all three charts simultaneously |
| Chart expansion | Clicking a KPI card expands the associated chart to full width; clicking again restores the 3-up row |
| Sparklines | Messages sent, messages received, agent sessions, and media processed KPI cards show sparkline trends |
| Resilience | Partial instance failures produce charts with warning indicators, not errors or missing data |
| Empty handling | New instances with no history show "No data yet" per panel, not flat-zero charts |
| Data integrity | Hourly token metric sums equal session-level token totals (dual-write consistency) |
| No regressions | Existing message volume chart, KPI cards, instances table, and activity feed continue to function |

## 4. Scope

### In scope

- Backend: `agent_token_events` table, `agent_sessions.ended_at` column, 6 new hourly metrics, bucket densification, API extensions with metadata
- Frontend: `ChartPanel` wrapper, `FleetTokenChart`, `FleetSessionChart`, modified `FleetMetricsChart`, `SoupKitchen` integration with range picker and chart expansion
- Backfill: Historical metric generation for existing data on migration
- Observability: Structured logs for collector runs, backfill operations, instance failures, token write errors

### Out of scope

- `metrics_daily` nightly rollup (deferred — hourly granularity sufficient at current fleet scale)
- Token budget/cost tracking (separate feature)
- Per-line token/session charts on the LineDetail page (natural follow-up, not this phase)
- Fleet-wide active hours heatmap aggregation (separate feature)
- Frontend component testing framework (no vitest/jest for React — verification is typecheck + visual + backend integration tests)

## 5. Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| 30-day backfill is slow on large instances | Medium | Low | Backfill runs in a transaction with indexed queries; 720 iterations is bounded. Monitor via `metrics.backfill` structured log with `durationMs`. |
| Token event volume overwhelms SQLite writes | Low | Medium | Token events are batched within existing durability transactions. No new write path — piggybacks on existing `completeTurn`. |
| Expression indexes not supported on deployed SQLite | Low | High | SQLite expression indexes require 3.9.0+ (2015). Node 23.10's built-in SQLite is well above this. Verify with `sqlite3 --version` on deployment target. |
| Frontend chart performance with 720 hourly buckets (30d) | Medium | Low | Recharts handles thousands of data points. The 720-point series is well within performance bounds. If needed, downsample to 6-hour buckets for 30d in a future iteration. |
| Partial fleet failure hides data quality issues | Medium | Medium | `meta.instancesFailed` count + warning pill in chart header makes degradation visible. Structured log `fleet.metrics.instance_skip` with instance name and error for investigation. |

## 6. Timeline Estimate

The implementation plan has 11 tasks. At the pace established in this session (subagent-driven development with review checkpoints):

- **Backend (Tasks 1-5):** Sequential, each depends on the previous. Estimate: 1 session.
- **Frontend (Tasks 6-11):** Mostly sequential with some parallelism possible (Tasks 8-10 are independent). Estimate: 1 session.
- **Visual verification + fixes:** Based on the design system work, plan for a visual debug pass after frontend integration. Estimate: 0.5 session.

Total: approximately 2-3 working sessions for a single agent, or 1-2 sessions with parallel backend/frontend agents after Task 5.

## 7. Deliverables

| Deliverable | Path |
|-------------|------|
| Design spec | `docs/superpowers/specs/2026-04-07-soup-kitchen-fleet-charts.md` |
| Implementation plan | `docs/superpowers/plans/2026-04-07-fleet-charts.md` |
| Team kickoff | `docs/superpowers/handoffs/2026-04-07-fleet-charts-kickoff.md` |
| This document | `docs/superpowers/handoffs/2026-04-07-fleet-charts-project-statement.md` |
| SOP | `docs/superpowers/handoffs/2026-04-07-fleet-charts-sop.md` |
| Guidelines | `docs/superpowers/handoffs/2026-04-07-fleet-charts-guidelines.md` |
