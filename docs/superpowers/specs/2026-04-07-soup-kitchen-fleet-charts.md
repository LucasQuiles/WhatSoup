# Soup Kitchen Fleet Charts Expansion

**Status:** deferred — inherits from parent epic `docs/sdlc/closed/fleet-charts-20260407/` (Phase 4-Execute incomplete, 11 beads unimplemented). _Originally marked "Draft"._

> **Date:** 2026-04-07
> **Scope:** Backend metric collection + frontend chart panels for Soup Kitchen page

---

## 1. Goal

Add token consumption and session activity charts to the Soup Kitchen page alongside the existing message volume chart. Surface `messages_media` as a third series on the message volume chart. Add a shared range picker (`24h | 7d | 30d`). Support KPI-driven chart expansion (click a KPI card to zoom its associated chart to full width).

---

## 2. Backend: Schema Changes

### 2.1 New Table: `agent_token_events`

Timestamped token usage events captured from the agent stream parser. One row per `token_usage` event.

```sql
CREATE TABLE IF NOT EXISTS agent_token_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_session_id INTEGER NOT NULL REFERENCES agent_sessions(id),
  timestamp INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_agent_token_events_ts ON agent_token_events(timestamp);
CREATE INDEX idx_agent_token_events_session_ts ON agent_token_events(agent_session_id, timestamp);
```

**Writer:** `src/runtimes/agent/session-db.ts` — on each `token_usage` event from the stream parser, insert a row with the current unix timestamp and the delta tokens reported. **Both the event insert and the existing session-level token accumulation (`total_input_tokens` / `total_output_tokens`) must happen in the same transaction.** The existing accumulation already participates in a durability transaction (`src/core/durability.ts:356`); the event insert must join that same transaction. If either write fails, both roll back, and a structured error log is emitted with the session ID and event payload for manual recovery.

### 2.2 Schema Change: `agent_sessions.ended_at`

```sql
ALTER TABLE agent_sessions ADD COLUMN ended_at TEXT;
```

```sql
CREATE INDEX idx_agent_sessions_started_epoch ON agent_sessions(unixepoch(started_at));
CREATE INDEX idx_agent_sessions_ended_epoch ON agent_sessions(unixepoch(ended_at));
```

Expression indexes so the `unixepoch()` predicates in the collector queries are indexed. SQLite supports expression indexes since 3.9.0.

**Writer:** `src/runtimes/agent/session-db.ts` — set `ended_at = new Date().toISOString()` on any terminal status transition. The canonical rule: **any status that means the session is no longer running sets `ended_at`**. The full list of terminal statuses from the live codebase:

| Status | Source | Sets `ended_at`? |
|--------|--------|-----------------|
| `ended` | `session.ts` normal completion | Yes |
| `completed` | legacy alias | Yes |
| `crashed` | unhandled error | Yes |
| `resume_failed` | resume attempt failed | Yes |
| `orphaned` | PID gone, no clean exit | Yes |
| `suspended` | user-initiated pause | **No** — session may resume, leave `ended_at` null |
| `active` | running | No (initial state) |

If a `suspended` session later transitions to `ended` or `crashed`, `ended_at` is set at that point. If a suspended session resumes (back to `active`), `ended_at` remains null.

### 2.3 Migration

Add a new migration entry in `src/core/database.ts` at the next schema version. The migration:
1. Creates the `agent_token_events` table with both indexes.
2. Adds the `ended_at TEXT` column to `agent_sessions`.
3. Creates both `agent_sessions` indexes (`started_at`, `ended_at`).
4. Backfills `ended_at` for all existing terminal-status sessions: `UPDATE agent_sessions SET ended_at = COALESCE(last_message_at, started_at) WHERE status IN ('ended', 'completed', 'crashed', 'resume_failed', 'orphaned') AND ended_at IS NULL`.

---

## 3. Backend: Metric Collection

### 3.1 Extended Hourly Collector

Extend `src/core/metrics-collector.ts` to collect 6 new metrics per hour window, in addition to the existing 3 (`messages_in`, `messages_out`, `messages_media`):

| Metric | Source | Query |
|--------|--------|-------|
| `agent_tokens_in` | `agent_token_events` | `SUM(input_tokens) WHERE timestamp >= start AND timestamp < end` |
| `agent_tokens_out` | `agent_token_events` | `SUM(output_tokens) WHERE timestamp >= start AND timestamp < end` |
| `chat_tokens_in` | `messages` | `SUM(input_tokens) WHERE timestamp >= start AND timestamp < end AND input_tokens > 0` |
| `chat_tokens_out` | `messages` | `SUM(output_tokens) WHERE timestamp >= start AND timestamp < end AND output_tokens > 0` |
| `sessions_started` | `agent_sessions` | `COUNT(*) WHERE unixepoch(started_at) >= start AND unixepoch(started_at) < end` |
| `sessions_active` | `agent_sessions` | `COUNT(*) WHERE unixepoch(started_at) < end AND (ended_at IS NULL OR unixepoch(ended_at) > start) AND status != 'suspended'` |

All comparison timestamps are unix seconds. `started_at` and `ended_at` in `agent_sessions` are ISO TEXT strings — queries use `unixepoch()` for comparison.

`messages_media` is already collected but not read by `db-reader.ts`. No collector change needed for it.

**Token chart scope:** The token chart represents **total fleet token consumption** — both agent tokens (from `agent_token_events`) and chat tokens (from `messages.input_tokens` / `messages.output_tokens`). The API sums `agent_tokens_in + chat_tokens_in` into `input` and `agent_tokens_out + chat_tokens_out` into `output` in the `TokenUsageBucket` response. This matches the existing fleet token totals shown elsewhere in the UI (which combine both runtimes in `src/fleet/routes/lines.ts:189`).

### 3.2 Backfill

Extend `backfillMetrics()` to backfill the new metrics. The backfill strategy differs by metric type:

**Message and token metrics** (`messages_in/out/media`, `agent_tokens_in/out`, `chat_tokens_in/out`): Scan source tables for hours with activity (existing pattern — only materialize hours that have data).

**Session metrics** (`sessions_started`, `sessions_active`): **Iterate every hour in the lookback window**, not just hours with detected activity. This is required because `sessions_active` is an overlap calculation — a session running from 01:00 to 05:00 must register as active in hours 02, 03, and 04 even if no events occurred in those hours. Skipping empty hours would produce false zeroes after densification.

The backfill runs inside a transaction (existing pattern). For session metrics, the full-window iteration means up to 720 hours for a 30-day backfill — acceptable since the queries are indexed.

### 3.3 Deferred: `metrics_daily`

Nightly rollup of hourly buckets into daily aggregates. **Explicitly deferred** — not in this phase. The hourly data is sufficient for `24h | 7d | 30d` ranges at the current fleet scale.

---

## 4. Backend: Fleet Metrics API

### 4.1 Extended Response

Extend `GET /api/metrics?range=24h|7d|30d` in `src/fleet/routes/fleet-metrics.ts`. The handler already iterates instances and sums `messages_in` / `messages_out` per bucket. Extend to also sum `messages_media`, `agent_tokens_in + chat_tokens_in`, `agent_tokens_out + chat_tokens_out`, `sessions_started`, `sessions_active`.

**Response shape:**

```ts
interface FleetMetrics {
  range: MetricsRange;
  messageVolume: MessageVolumeBucket[];
  tokenUsage: TokenUsageBucket[];
  sessionActivity: SessionActivityBucket[];
}

interface MessageVolumeBucket {
  bucket: string;     // ISO datetime
  inbound: number;
  outbound: number;
  media: number;      // NEW — messages_media
}

interface TokenUsageBucket {
  bucket: string;
  input: number;      // agent_tokens_in + chat_tokens_in
  output: number;     // agent_tokens_out + chat_tokens_out
}

interface SessionActivityBucket {
  bucket: string;
  active: number;     // sessions_active (concurrent count)
  started: number;    // sessions_started (new launches)
}
```

### 4.2 Bucket Densification

**Owned by `src/fleet/db-reader.ts`** so both fleet and per-line routes share it. The reader returns zero-filled buckets for the full selected range:

- `24h`: 24 hourly buckets ending at the current hour
- `7d`: 168 hourly buckets (7 x 24)
- `30d`: 720 hourly buckets (30 x 24)

Implementation: generate the full bucket sequence, build a `Map<string, values>` from DB results, iterate the sequence and emit DB values or zeroes. This replaces the current sparse-return behavior.

### 4.3 Per-Line Metrics

The per-line endpoint `GET /api/lines/:name/metrics` in `src/fleet/routes/metrics.ts` gains the same new response fields. `LineMetrics` type must also be extended:

```ts
interface LineMetrics {
  range: MetricsRange;
  messageVolume: MessageVolumeBucket[];
  tokenUsage: TokenUsageBucket[];            // NEW
  sessionActivity: SessionActivityBucket[];  // NEW
  activeHours: number[][];                   // existing
}
```

Densification is shared from `db-reader.ts`.

---

## 5. Frontend: Types

Update `console/src/types.ts`:

```ts
// Extend existing
interface MessageVolumeBucket {
  bucket: string;
  inbound: number;
  outbound: number;
  media: number;        // NEW
}

// New
interface TokenUsageBucket {
  bucket: string;
  input: number;
  output: number;
}

interface SessionActivityBucket {
  bucket: string;
  active: number;
  started: number;
}

// Extend existing
interface FleetMetrics {
  range: MetricsRange;
  messageVolume: MessageVolumeBucket[];
  tokenUsage: TokenUsageBucket[];           // NEW
  sessionActivity: SessionActivityBucket[]; // NEW
}

// Extend existing
interface LineMetrics {
  range: MetricsRange;
  messageVolume: MessageVolumeBucket[];
  tokenUsage: TokenUsageBucket[];           // NEW
  sessionActivity: SessionActivityBucket[]; // NEW
  activeHours: number[][];
}
```

---

## 6. Frontend: Soup Kitchen Layout

### 6.1 Chart Row

Three chart panels in a horizontal row below the KPI strip, above the instances table. Each panel is a `c-card` with equal flex width (`flex-1`). Shared height: 120px (matching current `FleetMetricsChart`).

```
[KPI Strip — 7 cards]
[Range Picker: 24h | 7d | 30d]
[Message Volume (1/3)] [Token Usage (1/3)] [Session Activity (1/3)]
[AlertBanner]
[Instances Table | Activity Feed]
```

### 6.2 KPI-Driven Expansion

New state: `expandedChart: 'messages' | 'tokens' | 'sessions' | null`. Separate from `activeKpi` (which filters the instances table).

- Clicking a KPI card associated with a chart sets `expandedChart` to that chart's key. The associated chart expands to full width; the other two collapse to zero width with a CSS transition.
- Clicking the same KPI card again (or clicking the expanded chart's collapse button) resets `expandedChart` to `null`, restoring the 3-up row.
- The expanded chart gets more height (200px) for detail.
- Each chart panel header is also clickable to toggle expansion (for the token chart which has no KPI card).

**KPI-to-chart mapping:**

| KPI | Chart | expandedChart key |
|-----|-------|------------------|
| Lines Connected | none | — |
| Need Attention | none | — |
| Messages Sent | Message Volume | `'messages'` |
| Messages Received | Message Volume | `'messages'` |
| Agent Sessions | Session Activity | `'sessions'` |
| Unread | none | — |
| Media Processed | Message Volume | `'messages'` |

### 6.3 Range Picker

A row of filter pills (`24h`, `7d`, `30d`) positioned above the chart row. Reuse the `FilterPill` component pattern from `console/src/components/line-detail/MetricsTab.tsx:28`. State: `chartRange: MetricsRange` defaulting to `'24h'`. Passed to `useFleetMetrics(chartRange)`.

### 6.4 Sparklines on KPI Cards

Extend the sparkline derivation to feed all applicable KPI cards:

| KPI | sparkData source |
|-----|-----------------|
| Messages Sent | `messageVolume[].outbound` (existing) |
| Messages Received | `messageVolume[].inbound` (existing) |
| Agent Sessions | `sessionActivity[].active` (new) |
| Media Processed | `messageVolume[].media` (new) |

Lines Connected, Need Attention, and Unread remain without sparklines (they're instantaneous values, not time-series).

---

## 7. Frontend: Chart Components

### 7.1 Color Scheme

One dominant color per chart, series differentiated by opacity:

| Chart | Color token | Primary series | Secondary series |
|-------|------------|----------------|-----------------|
| Message Volume | `--color-m-cht` (cyan) | Outbound: solid stroke, 0.3 fill | Inbound: `--color-m-pas` (green), solid stroke, 0.3 fill |
| Token Usage | `--color-m-agt` (violet) | Output tokens: solid stroke, 0.3 fill | Input tokens: dashed stroke, 0.15 fill |
| Session Activity | `--color-s-ok` (green) | Active count: solid area, 0.3 fill | Started: bars overlaid, 0.6 opacity |

**Exception:** Message Volume keeps its existing two-color scheme (green inbound, cyan outbound) since it's already established. The `media` series uses `--color-s-warn` (amber) with 0.2 fill opacity to distinguish from the message series.

### 7.2 FleetMetricsChart (Modified)

Extend existing component to accept `media` field. Add a third `<Area>` series for media in amber. No other changes to the existing chart.

### 7.3 FleetTokenChart (New)

New component: `console/src/components/FleetTokenChart.tsx`

- `AreaChart` with two series: output tokens (violet solid) and input tokens (violet dashed, lower opacity)
- Same axis configuration as `FleetMetricsChart` (shared `AXIS_TICK`, `formatBucketLabel`)
- Tooltip shows bucket timestamp, input token count, output token count, total

### 7.4 FleetSessionChart (New)

New component: `console/src/components/FleetSessionChart.tsx`

- Composite chart: `ComposedChart` with `<Area>` for active session count (green fill) and `<Bar>` for sessions started (green bars, narrower)
- Same axis configuration
- Tooltip shows bucket timestamp, active count, new starts

### 7.5 Shared Chart Infrastructure

Extract into `console/src/lib/chart-utils.ts`:
- Shared tooltip content style object (currently inlined in each chart)
- Chart margin constant
- `formatBucketLabel` already exists — extend for 7d/30d ranges (show "Mon", "Tue" or "Mar 29" instead of hour-only)

---

## 8. File Inventory

### Backend (new/modified)

| File | Action |
|------|--------|
| `src/core/database.ts` | New migration: `agent_token_events` table + indexes, `agent_sessions.ended_at` column + indexes, backfill existing terminal sessions |
| `src/runtimes/agent/session-db.ts` | Insert `agent_token_events` row on `token_usage` events; set `ended_at` on terminal transitions (ended, crashed, resume_failed, orphaned) |
| `src/core/metrics-collector.ts` | Add `agent_tokens_in/out`, `chat_tokens_in/out`, `sessions_started`, `sessions_active` collection; full-window backfill for session metrics |
| `src/fleet/db-reader.ts` | Extend metrics query to read all 9 metrics; add shared bucket densification |
| `src/fleet/routes/fleet-metrics.ts` | Extend response with `tokenUsage`, `sessionActivity`; add `media` to `messageVolume` |
| `src/fleet/routes/metrics.ts` | Same extension for per-line endpoint |

### Frontend (new/modified)

| File | Action |
|------|--------|
| `console/src/types.ts` | Add `TokenUsageBucket`, `SessionActivityBucket`; extend `MessageVolumeBucket` with `media`; extend `FleetMetrics` and `LineMetrics` |
| `console/src/components/FleetMetricsChart.tsx` | Add `media` area series in amber |
| `console/src/components/FleetTokenChart.tsx` | **New** — token usage area chart |
| `console/src/components/FleetSessionChart.tsx` | **New** — session activity composed chart |
| `console/src/pages/SoupKitchen.tsx` | Add `expandedChart` state, range picker, 3-up chart row with expansion, sparkline wiring |
| `console/src/lib/chart-utils.ts` | Extract shared tooltip style, add multi-range `formatBucketLabel` |
| `console/src/lib/metrics-sparklines.ts` | Extend sparkline derivation for media + sessions (this file owns `deriveFleetMessageSparklines`) |

---

## 9. Frontend States and Hardening

### 9.1 Chart Panel Wrapper

Introduce a shared `ChartPanel` wrapper component (`console/src/components/ChartPanel.tsx`) that handles title, expand/collapse toggle, and state rendering for all three charts. Each chart component receives only its data; the wrapper owns:

- **Loading:** Skeleton shimmer (reuse existing `animate-shimmer` utility) at 120px height.
- **Error:** Inline error message with retry button (pattern from `MetricsTab.tsx:57`).
- **Empty (no historical data):** `EmptyState` component with chart-appropriate icon and "No data yet" message. Triggered when the API returns successfully but all values in the array are zero.
- **Valid data:** Render the chart component.
- **Partial fleet degradation:** If the response includes `meta.instancesFailed > 0`, show a non-blocking warning pill in the panel header: "{N} instance(s) unavailable" in `--s-warn` color.

### 9.2 Densification vs Empty State

Bucket densification always returns a full array of zero-filled buckets. To distinguish "no data yet" from "data exists but happens to be zero this period":

- The API response adds a `meta` field:
  ```ts
  interface FleetMetricsMeta {
    instancesQueried: number;
    instancesFailed: number;
    hasMessageData: boolean;   // true if messageVolume has at least one non-zero bucket
    hasTokenData: boolean;     // true if tokenUsage has at least one non-zero bucket
    hasSessionData: boolean;   // true if sessionActivity has at least one non-zero bucket
  }
  ```
- Frontend uses the per-panel flags (`meta.hasMessageData`, `meta.hasTokenData`, `meta.hasSessionData`) to show EmptyState on panels with no history, while rendering charts on panels that have data.

### 9.3 Range Change Behavior

When the user changes the range picker, the chart area shows the loading skeleton until the new data arrives. The previous range data is not shown during the transition (avoids confusing stale-data flash). TanStack Query's `placeholderData: keepPreviousData` is explicitly NOT used for range changes — only for polling refreshes within the same range.

---

## 10. Observability

### 10.1 Backend Structured Logs

All logs use Pino (existing pattern). Required structured log events:

| Event | Level | Fields | When |
|-------|-------|--------|------|
| `metrics.collect` | info | `bucket`, `metrics` (object with all 9 values), `durationMs` | Each hourly collection run |
| `metrics.backfill` | info | `days`, `bucketsProcessed`, `durationMs` | Migration backfill completion |
| `metrics.backfill.skip` | debug | `bucket`, `reason` | Skipped bucket during backfill |
| `fleet.metrics.instance_skip` | warn | `instance`, `error` | Instance query failed during fleet aggregation |
| `token_event.write_fail` | error | `sessionId`, `agentSessionId`, `error` | Token event + accumulation transaction failed |
| `session.ended` | info | `agentSessionId`, `status`, `endedAt` | Session terminal transition |

### 10.2 API Response Metadata

The fleet metrics response includes `meta`:

```ts
{
  range: MetricsRange;
  meta: FleetMetricsMeta;
  messageVolume: MessageVolumeBucket[];
  tokenUsage: TokenUsageBucket[];
  sessionActivity: SessionActivityBucket[];
}
```

---

## 11. Verification

### 11.1 Backend Tests

| Test | Scope | Key assertions |
|------|-------|----------------|
| Migration test | `database.ts` | `agent_token_events` table created, `ended_at` column exists, expression indexes created, backfill populates `ended_at` for terminal sessions |
| Collector test — tokens | `metrics-collector.ts` | `agent_tokens_in/out` and `chat_tokens_in/out` correctly sum from respective tables; zero when no events |
| Collector test — sessions_active | `metrics-collector.ts` | Long-running session counted in all overlapping hours; `suspended` sessions excluded; `ended_at IS NULL` + `status = 'active'` counted |
| Collector test — sessions_started | `metrics-collector.ts` | Sessions counted in their start hour only |
| Backfill test — session window | `metrics-collector.ts` | Full-window iteration: session spanning hours 1-5 appears in all 5 hourly `sessions_active` buckets |
| Densification test | `db-reader.ts` | Sparse DB data produces full zero-filled bucket array for all three ranges |
| Fleet route test — partial failure | `fleet-metrics.ts` | One instance fails, response still returns data from healthy instances, `meta.instancesFailed = 1` |
| Token event atomicity | `session-db.ts` | Event insert + accumulation both succeed or both roll back; verify via count + sum after forced failure |
| Dual-write consistency | `session-db.ts` | `SUM(agent_token_events)` for a session equals `agent_sessions.total_input/output_tokens` |

### 11.2 Frontend Tests

| Test | Scope | Key assertions |
|------|-------|----------------|
| ChartPanel — loading | `ChartPanel.tsx` | Shows shimmer skeleton when query is pending |
| ChartPanel — error | `ChartPanel.tsx` | Shows error message + retry button; retry refetches |
| ChartPanel — empty | `ChartPanel.tsx` | Shows EmptyState when `meta.hasHistoricalData === false` |
| ChartPanel — partial | `ChartPanel.tsx` | Shows warning pill when `meta.instancesFailed > 0` |
| Expansion toggle | `SoupKitchen.tsx` | Click KPI → expandedChart set, chart fills width; click again → resets to 3-up; expandedChart independent of activeKpi |
| Range picker | `SoupKitchen.tsx` | Changing range passes new value to hook; shows loading state during transition |
| Sparkline wiring | `SoupKitchen.tsx` | Media and session KPI cards receive sparkData arrays |

---

## 12. File Inventory (Revised)

### Backend (new/modified)

| File | Action |
|------|--------|
| `src/core/database.ts` | New migration: `agent_token_events` table + expression indexes, `agent_sessions.ended_at` column + expression indexes, backfill terminal sessions |
| `src/runtimes/agent/session-db.ts` | Atomic insert of `agent_token_events` within existing durability transaction; set `ended_at` on terminal transitions (ended, crashed, resume_failed, orphaned); exclude suspended from active |
| `src/core/metrics-collector.ts` | Add 6 new metrics; full-window backfill for session metrics |
| `src/fleet/db-reader.ts` | Read all 9 metrics; shared bucket densification; `hasHistoricalData` flag |
| `src/fleet/routes/fleet-metrics.ts` | Extend response with `tokenUsage`, `sessionActivity`, `meta`; add `media` to `messageVolume` |
| `src/fleet/routes/metrics.ts` | Same extension for per-line endpoint |

### Frontend (new/modified)

| File | Action |
|------|--------|
| `console/src/types.ts` | Add `TokenUsageBucket`, `SessionActivityBucket`, `FleetMetricsMeta`; extend `MessageVolumeBucket`, `FleetMetrics`, `LineMetrics` |
| `console/src/components/ChartPanel.tsx` | **New** — shared wrapper: title, expand/collapse, loading/error/empty/partial states |
| `console/src/components/FleetMetricsChart.tsx` | Add `media` area series in amber |
| `console/src/components/FleetTokenChart.tsx` | **New** — token usage area chart |
| `console/src/components/FleetSessionChart.tsx` | **New** — session activity composed chart |
| `console/src/pages/SoupKitchen.tsx` | Add `expandedChart` state, range picker, 3-up chart row with ChartPanel wrappers, sparkline wiring |
| `console/src/lib/chart-utils.ts` | Extract shared tooltip style, chart margin, multi-range `formatBucketLabel` |
| `console/src/lib/metrics-sparklines.ts` | Extend sparkline derivation for media + sessions |

---

## 13. Out of Scope

- `metrics_daily` nightly rollup — explicitly deferred
- Token budget / cost tracking — separate feature
- Per-line token/session charts on LineDetail page — natural follow-up but not this phase
- Fleet-wide `activeHours` heatmap aggregation — separate feature
