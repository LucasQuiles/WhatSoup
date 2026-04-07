# Soup Kitchen Fleet Charts Expansion

> **Date:** 2026-04-07
> **Status:** Draft
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

**Writer:** `src/runtimes/agent/session-db.ts` — on each `token_usage` event from the stream parser, insert a row with the current unix timestamp and the delta tokens reported. The existing accumulation onto `agent_sessions.total_input_tokens` / `total_output_tokens` continues unchanged.

### 2.2 Schema Change: `agent_sessions.ended_at`

```sql
ALTER TABLE agent_sessions ADD COLUMN ended_at TEXT;
```

```sql
CREATE INDEX idx_agent_sessions_started ON agent_sessions(started_at);
CREATE INDEX idx_agent_sessions_ended ON agent_sessions(ended_at);
```

**Writer:** `src/runtimes/agent/session-db.ts` — set `ended_at = new Date().toISOString()` on terminal status transitions (`completed`, `crashed`, `timeout`, `cancelled`). Null means session is still active.

### 2.3 Migration

Add a new migration entry in `src/core/database.ts` at the next schema version. The migration creates the `agent_token_events` table with indexes and adds the `ended_at` column + indexes to `agent_sessions`.

---

## 3. Backend: Metric Collection

### 3.1 Extended Hourly Collector

Extend `src/core/metrics-collector.ts` to collect 5 new metrics per hour window, in addition to the existing 3 (`messages_in`, `messages_out`, `messages_media`):

| Metric | Source | Query |
|--------|--------|-------|
| `tokens_in` | `agent_token_events` | `SUM(input_tokens) WHERE timestamp >= start AND timestamp < end` |
| `tokens_out` | `agent_token_events` | `SUM(output_tokens) WHERE timestamp >= start AND timestamp < end` |
| `sessions_started` | `agent_sessions` | `COUNT(*) WHERE started_at >= start AND started_at < end` |
| `sessions_active` | `agent_sessions` | `COUNT(*) WHERE started_at < end AND (ended_at IS NULL OR ended_at > start)` |

All timestamps are unix seconds. `started_at` and `last_message_at` in `agent_sessions` are stored as ISO TEXT strings. Queries must use `unixepoch(started_at)` for comparison. The new `ended_at` column should also be TEXT (ISO string) for consistency with the existing schema, not INTEGER.

`messages_media` is already collected but not read. No collector change needed for it.

### 3.2 Backfill

Extend `backfillMetrics()` to also backfill the new metrics for historical hours. The backfill should scan `agent_token_events.timestamp` and `agent_sessions.started_at` for hour buckets with activity, same pattern as the existing message backfill.

### 3.3 Deferred: `metrics_daily`

Nightly rollup of hourly buckets into daily aggregates. **Explicitly deferred** — not in this phase. The hourly data is sufficient for `24h | 7d | 30d` ranges at the current fleet scale.

---

## 4. Backend: Fleet Metrics API

### 4.1 Extended Response

Extend `GET /api/metrics?range=24h|7d|30d` in `src/fleet/routes/fleet-metrics.ts`. The handler already iterates instances and sums `messages_in` / `messages_out` per bucket. Extend to also sum `messages_media`, `tokens_in`, `tokens_out`, `sessions_started`, `sessions_active`.

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
  input: number;      // tokens_in
  output: number;     // tokens_out
}

interface SessionActivityBucket {
  bucket: string;
  active: number;     // sessions_active (concurrent count)
  started: number;    // sessions_started (new launches)
}
```

### 4.2 Bucket Densification

The current `db-reader.ts` query returns only buckets that have data. The API must emit zero-filled buckets for the full selected range:

- `24h`: 24 hourly buckets ending at the current hour
- `7d`: 168 hourly buckets (7 x 24)
- `30d`: 720 hourly buckets (30 x 24)

Generate the full bucket sequence in the handler, left-join with the DB results, default missing values to 0. This ensures charts render continuous lines without gaps.

### 4.3 Per-Line Metrics

The per-line endpoint `GET /api/lines/:name/metrics` in `src/fleet/routes/metrics.ts` should also be extended with the same new fields. This is not required for the Soup Kitchen charts but maintains API consistency.

---

## 5. Frontend: Types

Update `src/types.ts`:

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

Token Usage has no KPI card currently. Options: (a) add a "Tokens Used" KPI card, or (b) token chart expands only via direct click on the chart panel header. Going with (b) — no new KPI card. Each chart panel has a clickable header that toggles expansion.

### 6.3 Range Picker

A row of filter pills (`24h`, `7d`, `30d`) positioned above the chart row. Reuse the `FilterPill` component pattern from MetricsTab. State: `chartRange: MetricsRange` defaulting to `'24h'`. Passed to `useFleetMetrics(chartRange)`.

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

New component: `src/components/FleetTokenChart.tsx`

- `AreaChart` with two series: output tokens (violet solid) and input tokens (violet dashed, lower opacity)
- Same axis configuration as `FleetMetricsChart` (shared `AXIS_TICK`, `formatBucketLabel`)
- Tooltip shows bucket timestamp, input token count, output token count, total

### 7.4 FleetSessionChart (New)

New component: `src/components/FleetSessionChart.tsx`

- Composite chart: `ComposedChart` with `<Area>` for active session count (green fill) and `<Bar>` for sessions started (green bars, narrower)
- Same axis configuration
- Tooltip shows bucket timestamp, active count, new starts

### 7.5 Shared Chart Infrastructure

Extract into `chart-utils.ts`:
- Shared tooltip content style object (currently inlined in each chart)
- Chart margin constant
- `formatBucketLabel` already exists — extend for 7d/30d ranges (show "Mon", "Tue" or "Mar 29" instead of hour-only)

---

## 8. File Inventory

### Backend (new/modified)

| File | Action |
|------|--------|
| `src/core/database.ts` | New migration: `agent_token_events` table + indexes, `agent_sessions.ended_at` column + indexes |
| `src/runtimes/agent/session-db.ts` | Insert `agent_token_events` row on `token_usage` events; set `ended_at` on terminal transitions |
| `src/core/metrics-collector.ts` | Add `tokens_in`, `tokens_out`, `sessions_started`, `sessions_active` collection + backfill |
| `src/fleet/db-reader.ts` | Extend metrics query to read all 7 metrics; add bucket densification |
| `src/fleet/routes/fleet-metrics.ts` | Extend response with `tokenUsage`, `sessionActivity`; add `media` to `messageVolume` |
| `src/fleet/routes/metrics.ts` | Same extension for per-line endpoint (consistency) |

### Frontend (new/modified)

| File | Action |
|------|--------|
| `src/types.ts` | Add `TokenUsageBucket`, `SessionActivityBucket`; extend `MessageVolumeBucket` with `media`; extend `FleetMetrics` |
| `src/components/FleetMetricsChart.tsx` | Add `media` area series in amber |
| `src/components/FleetTokenChart.tsx` | **New** — token usage area chart |
| `src/components/FleetSessionChart.tsx` | **New** — session activity composed chart |
| `src/pages/SoupKitchen.tsx` | Add `expandedChart` state, range picker, 3-up chart row with expansion, sparkline wiring |
| `src/lib/chart-utils.ts` | Extract shared tooltip style, add multi-range `formatBucketLabel` |
| `src/lib/compute-kpis.ts` | Add `totalTokens` KPI from fleet metrics (optional) |
| `src/hooks/use-metrics.ts` | No change needed — `useFleetMetrics` already accepts `MetricsRange` |

---

## 9. Out of Scope

- `metrics_daily` nightly rollup — deferred to a future phase
- Token budget / cost tracking — separate feature
- Per-line token/session charts on the LineDetail page — natural follow-up but not this phase
- Fleet-wide `activeHours` heatmap aggregation — separate feature
