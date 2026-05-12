# Provider Attribution — Token & Session Charts + Instances Table

> **Date:** 2026-04-07
> **Status:** completed
> **Scope:** Backend metric collection by provider, frontend chart breakdown, instances table provider column
> **Implementation:** Backend classifier at `src/runtimes/chat/providers/api-error-classifier.ts`; provider KPI on agent summary tab shipped via PR #361.

---

## 1. Goal

Break down token consumption and session activity charts by provider (Claude Code, Codex CLI, etc.) using stacked series. Add a sortable Provider column to the instances table. Establish per-session provider tracking in the data model.

---

## 2. Backend: Schema Changes

### 2.1 Migration 19: `agent_sessions.provider`

```sql
ALTER TABLE agent_sessions ADD COLUMN provider TEXT;
```

The migration only adds the column — it cannot backfill because `Database.open()` has no access to the instance's config. Backfill happens at runtime: the instance process calls a new `backfillSessionProvider(db, provider)` function after opening the DB, using the provider from its config. This function runs once (idempotent — only updates rows where `provider IS NULL`):

```sql
UPDATE agent_sessions SET provider = ? WHERE provider IS NULL
```

Where `?` is the instance's `agentOptions.provider` from config (default `'claude-cli'`).

### 2.2 Session Creation

`createSession()` in `session-db.ts` gains an optional `provider` parameter:

```typescript
export function createSession(
  db: Database,
  claudePid: number,
  startedInDir: string,
  provider?: string,
): number
```

The `provider` value is written to the new column. The runtime passes `this.provider` (from session opts) when creating sessions.

---

## 3. Backend: Metrics Collection

### 3.1 Per-Provider Metric Keys

The `metrics_hourly` table uses `(bucket, metric)` as its composite primary key. Per-provider metrics use a `:provider` suffix on the metric name:

| Aggregate Key | Per-Provider Key Example |
|---------------|--------------------------|
| `agent_tokens_in` | `agent_tokens_in:codex-cli` |
| `agent_tokens_out` | `agent_tokens_out:codex-cli` |
| `sessions_started` | `sessions_started:claude-cli` |
| `sessions_active` | `sessions_active:claude-cli` |

The aggregate keys continue to be written (backwards compatible). Per-provider keys are written alongside them. `chat_tokens_in/out` remain aggregate-only — the chat runtime does not use providers.

### 3.2 Collector Changes

`collectMetricsForWindow` and `querySessionMetrics` are extended:

**Token metrics:** Query `agent_token_events` joined to `agent_sessions` on `agent_session_id`, grouped by `agent_sessions.provider`:

```sql
SELECT s.provider, SUM(e.input_tokens) AS total_in, SUM(e.output_tokens) AS total_out
FROM agent_token_events e
JOIN agent_sessions s ON e.agent_session_id = s.id
WHERE e.timestamp >= ? AND e.timestamp < ?
GROUP BY s.provider
```

Write one `agent_tokens_in:${provider}` and `agent_tokens_out:${provider}` per group, plus the existing aggregate keys.

**Session metrics:** `sessions_started` and `sessions_active` queries add `GROUP BY provider`:

```sql
SELECT provider, COUNT(*) AS cnt
FROM agent_sessions
WHERE unixepoch(started_at) >= ? AND unixepoch(started_at) < ?
GROUP BY provider
```

Write `sessions_started:${provider}` per group, plus aggregate.

**Backfill:** Same pattern — per-provider keys are written during backfill alongside aggregate keys.

### 3.3 Deferred

`messages_in`, `messages_out`, `messages_media` are not provider-attributed. Messages are transport-level, not provider-level.

---

## 4. Backend: API Changes

### 4.1 db-reader

`getMetrics` return type gains:

```typescript
tokenUsageByProvider: Record<string, { bucket: string; input: number; output: number }[]>;
sessionActivityByProvider: Record<string, { bucket: string; active: number; started: number }[]>;
```

The reader queries all metric keys matching `agent_tokens_in:%`, `agent_tokens_out:%`, `sessions_started:%`, `sessions_active:%`, parses the provider suffix, and densifies each provider's series independently.

### 4.2 Fleet API

Response shape extends:

```typescript
interface FleetMetrics {
  range: MetricsRange;
  meta: FleetMetricsMeta;
  messageVolume: MessageVolumeBucket[];
  tokenUsage: TokenUsageBucket[];                              // aggregate (unchanged)
  sessionActivity: SessionActivityBucket[];                    // aggregate (unchanged)
  tokenUsageByProvider: Record<string, TokenUsageBucket[]>;    // NEW
  sessionActivityByProvider: Record<string, SessionActivityBucket[]>; // NEW
}

interface FleetMetricsMeta {
  instancesQueried: number;
  instancesFailed: number;
  hasMessageData: boolean;
  hasTokenData: boolean;
  hasSessionData: boolean;
  providers: string[];   // NEW — list of providers with data
}
```

The fleet handler aggregates per-provider buckets across instances (same Map pattern as aggregate, one Map per provider per metric type).

### 4.3 Per-Line API

Same extension for `LineMetrics` — `tokenUsageByProvider` and `sessionActivityByProvider` added. Single-instance, so no cross-instance aggregation needed.

---

## 5. Frontend: Types

Add to `console/src/types.ts`:

```typescript
// Extend FleetMetrics
tokenUsageByProvider: Record<string, TokenUsageBucket[]>;
sessionActivityByProvider: Record<string, SessionActivityBucket[]>;

// Extend FleetMetricsMeta
providers: string[];

// Extend LineMetrics
tokenUsageByProvider: Record<string, TokenUsageBucket[]>;
sessionActivityByProvider: Record<string, SessionActivityBucket[]>;
```

---

## 6. Frontend: Provider Color Mapping

Add to `console/src/lib/providers.ts`:

```typescript
export const PROVIDER_COLORS: Record<string, { stroke: string; fill: string }> = {
  'claude-cli':    { stroke: 'var(--color-m-agt)', fill: 'var(--color-m-agt)' },
  'codex-cli':     { stroke: 'var(--color-s-ok)',  fill: 'var(--color-s-ok)' },
  'gemini-cli':    { stroke: 'var(--color-s-warn)', fill: 'var(--color-s-warn)' },
  'openai-api':    { stroke: 'var(--color-m-cht)', fill: 'var(--color-m-cht)' },
  'anthropic-api': { stroke: 'var(--color-m-agt)', fill: 'var(--color-m-agt)' },
  'opencode-cli':  { stroke: 'var(--color-t2)',    fill: 'var(--color-t2)' },
};

export function getProviderColor(id: string): { stroke: string; fill: string } {
  return PROVIDER_COLORS[id] ?? { stroke: 'var(--color-t3)', fill: 'var(--color-t3)' };
}
```

---

## 7. Frontend: Chart Components

### 7.1 FleetTokenChart

When `tokenUsageByProvider` has data and multiple providers are present:

- Render one pair of `<Area>` series per provider (output solid, input dashed)
- Each provider gets its color from `getProviderColor`
- Stack ID per provider to keep them visually stacked
- Tooltip shows provider name + token count per series
- Legend shows provider display names

When only one provider has data: render identically to current (single color, no provider labels). This avoids visual clutter for single-provider fleets.

Threshold: show breakdown when `meta.providers.length > 1`.

### 7.2 FleetSessionChart

Same pattern:

- Active sessions: one `<Area>` per provider, stacked, provider-colored
- Sessions started: one `<Bar>` per provider, stacked, provider-colored
- Single-provider: same as current

### 7.3 FleetMetricsChart

No changes. Messages are not provider-attributed.

---

## 8. Frontend: Instances Table

### 8.1 Provider Column

New column in the instances table between "Sessions" and "Tags":

```typescript
{ label: "Provider", widthClass: "w-[var(--sk-col-provider)]", center: false, sortKey: "provider" }
```

Cell content: provider `displayName` from the registry, styled in the provider's color.

```tsx
<td className="c-cell">
  <span className="c-data" style={{ color: getProviderColor(line.provider ?? 'claude-cli').stroke }}>
    {getProvider(line.provider ?? 'claude-cli')?.displayName ?? 'Claude Code'}
  </span>
</td>
```

### 8.2 LineTags Cleanup

Remove the provider tag from `LineTags` — the `getProviderTag` function and its call are removed since provider now has its own column.

### 8.3 Sort Support

Add `provider` to the sort switch:

```typescript
case "provider": av = a.provider ?? 'claude-cli'; bv = b.provider ?? 'claude-cli'; break;
```

### 8.4 LineInstance Type

`LineInstance` gains `provider?: string` at the top level (not nested in `config.agentOptions`). The fleet lines route extracts it from the instance config and includes it in the response.

---

## 9. File Inventory

### Backend

| File | Action |
|------|--------|
| `src/core/database.ts` | Migration 19: `provider TEXT` on `agent_sessions` + backfill |
| `src/runtimes/agent/session-db.ts` | `createSession` gains `provider` param; `backfillSessionProvider` function |
| `src/runtimes/agent/session.ts` | Pass `this.provider` to `createSession` |
| `src/core/metrics-collector.ts` | Per-provider metric keys for token + session metrics |
| `src/fleet/db-reader.ts` | Parse provider-suffixed metrics, densify per provider |
| `src/fleet/routes/fleet-metrics.ts` | Aggregate per-provider buckets, add `providers` to meta |
| `src/fleet/routes/metrics.ts` | Forward per-provider data (spread already handles it) |
| `src/fleet/routes/lines.ts` | Extract `provider` from instance config into line response |

### Frontend

| File | Action |
|------|--------|
| `console/src/types.ts` | Add `tokenUsageByProvider`, `sessionActivityByProvider`, `providers` to types |
| `console/src/lib/providers.ts` | Add `PROVIDER_COLORS` map and `getProviderColor` |
| `console/src/components/FleetTokenChart.tsx` | Multi-provider stacked series |
| `console/src/components/FleetSessionChart.tsx` | Multi-provider stacked series |
| `console/src/components/LineTags.tsx` | Remove provider tag |
| `console/src/pages/SoupKitchen.tsx` | Add Provider column, sort support, pass provider data to charts |

---

## 10. Observability

| Event | Level | Fields | When |
|-------|-------|--------|------|
| `metrics.collect` | info | `bucket`, `metrics` (now includes per-provider keys), `durationMs` | Unchanged event, richer payload |
| `session.created` | info | `agentSessionId`, `provider` | Session creation with provider |

No new structured log events. The existing `metrics.collect` event's `metrics` object naturally gains the per-provider keys.

---

## 11. Out of Scope

- Per-provider token budget/cost tracking (separate feature)
- Provider switching mid-session (sessions are single-provider)
- Provider column on the per-line LineDetail page (follow-up)
- Message attribution by provider (messages are transport-level)
- Provider-filtered KPI cards (KPIs remain fleet-wide aggregates)
