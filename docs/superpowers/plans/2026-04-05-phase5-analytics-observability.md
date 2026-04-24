# Phase 5: Analytics & Observability

**Status:** SPEC — team consensus pending  
**Date:** 2026-04-05  
**Contributors:** Q (orchestrator), Shannon (data model analysis)

## Overview

Add time-series metrics collection, metrics API, and dashboard charts to replace fake sparklines and fill the disabled Metrics tab in LineDetail.

## Current State

### Existing Metrics Data (already served)
- Health endpoint: `uptime_seconds`, `messages_total`, `enrichment` stats, runtime details
- Lines API: `messagesToday`, `messageStats` (sent/received/images/audio/docs), `totalSessions`, `tokenUsage`, `lastActive`
- SoupKitchen sparklines: currently fake/normalized from `messagesToday`

### SQLite Sources for Time-Series
- `messages` table: `timestamp`, `is_from_me`, `content_type`, `conversation_key` — message volume + heatmaps
- `agent_sessions`: `started_at`, `last_message_at`, `message_count`, token totals — session metrics
- Durability tables: `inbound_events.received_at`, `outbound_ops.submitted_at` — partial response time

### Gap: Response Time
Not cleanly stored today. Need to persist as a first-class metric.

### UI Surfaces Waiting
- `LineDetail` has disabled Metrics tab placeholder
- `SoupKitchen` sparklines use fake data

## Deliverables

### 5.1 — Metrics Table & Collection (backend)

**New migration:** Add `metrics_hourly` table per instance DB:
```sql
CREATE TABLE IF NOT EXISTS metrics_hourly (
  bucket TEXT NOT NULL,        -- ISO hour: '2026-04-05T14:00:00Z'
  metric TEXT NOT NULL,        -- 'messages_in', 'messages_out', 'sessions', 'avg_response_ms'
  value REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, metric)
);
CREATE INDEX idx_metrics_bucket ON metrics_hourly(bucket);
```

**Collection:** Hourly aggregation job (piggyback on existing enrichment interval):
- Count messages by `is_from_me` per hour from `messages.timestamp`
- Count sessions from `agent_sessions.started_at`
- Compute avg response time from durability `inbound→outbound` deltas

**Backfill:** On first run, aggregate from existing `messages` table (last 30 days).

**Effort:** Small-medium (1-2 sessions)

### 5.2 — Metrics API (fleet routes)

**Endpoints:**
```
GET /api/lines/:name/metrics?range=24h|7d|30d
GET /api/metrics/fleet?range=24h|7d|30d
```

**Per-line response:**
```typescript
{
  messageVolume: { bucket: string; inbound: number; outbound: number }[];
  activeHours: number[][];           // 7×24 heatmap (day-of-week × hour)
  sessions?: { bucket: string; count: number; avgDuration: number }[];
  responseTimes?: { bucket: string; avgMs: number; p95Ms: number }[];
}
```

**Fleet response:** Aggregated across all instances.

**Effort:** Small (1 session)

### 5.3 — Dashboard Charts (console)

**Library:** Recharts (already in console/package.json)

**LineDetail Metrics tab:**
- Message volume bar chart (inbound/outbound stacked, hourly for 24h, daily for 7d/30d)
- Active hours heatmap (7×24 grid, color intensity from design tokens)
- Session timeline (agent lines only)
- Response time line chart (if data available)

**SoupKitchen sparklines:**
- Replace fake normalized data with real `messageVolume` from fleet metrics API
- KPI cards show real totals from metrics

**Design tokens to use:**
- Chart colors: `--color-m-pas` (inbound), `--color-m-cht` (outbound), `--color-m-agt` (sessions)
- Grid/axis: `--color-t5`, `--font-size-xs`, IBM Plex Mono
- Tooltip: `.c-card` class with `--shadow-md`

**Effort:** Medium (2 sessions)

## Implementation Order

1. **Metrics table + collection** (backend, enables everything else)
2. **Metrics API** (fleet routes, serves data to console)
3. **Dashboard charts** (console, consumes API)

## Milestones

| Milestone | Deliverable | Tests | Verification |
|-----------|-------------|-------|-------------|
| M1 | metrics_hourly table + aggregation job | DB migration test + aggregation test | Hourly buckets populated |
| M2 | Metrics API endpoints | Route tests + integration | JSON response matches spec |
| M3 | LineDetail Metrics tab + SoupKitchen sparklines | Component tests | Charts render with real data |

## RAG Context

RAG_DEGRADED: Spec authored from direct codebase analysis. Shannon audited health.ts, lines.ts, database.ts, and agent_sessions schema. Recharts confirmed in console/package.json. No Pinecone retrieval needed.
