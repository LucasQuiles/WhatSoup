# Fleet Charts — Team Kickoff

**Status:** deferred — inherits from parent epic `docs/sdlc/closed/fleet-charts-20260407/` (Phase 4-Execute incomplete, 11 beads unimplemented).

> **Date:** 2026-04-07
> **Handoff from:** Design system audit + fleet charts design session
> **Status:** Spec locked, plan written, ready for implementation

---

## What This Is

The Soup Kitchen page (fleet dashboard at `/`) currently has one chart — a stacked area showing message volume over 24h. We're adding two more chart panels (token consumption, session activity), a shared range picker, KPI-driven chart expansion, and the backend infrastructure to power it all.

This is a full-stack feature: new DB tables, metric collectors, API extensions, and 4 new frontend components.

---

## Documents You Need

| Document | Path | What it covers |
|----------|------|---------------|
| **Design spec** | `docs/superpowers/specs/2026-04-07-soup-kitchen-fleet-charts.md` | Architecture, data model, API contracts, UI states, observability, verification criteria |
| **Implementation plan** | `docs/superpowers/plans/2026-04-07-fleet-charts.md` | 11 TDD tasks with exact code, test commands, and commit messages |
| **Design system spec** | `docs/specs/2026-03-31-whatsoup-console-design-system.md` | Token system, typography rules, color scheme — all frontend code must comply |

Read the design spec first (it's the source of truth), then the implementation plan (it's the execution guide). The plan has complete code for every step — it's not a summary, it's a recipe.

---

## What Was Already Done (This Session)

Before this feature was designed, we completed a full design system compliance audit and remediation:

- **806 ESLint violations fixed** across 57 files (inline styles migrated to className, raw px to tokens, missing type="button")
- **CSS architecture fixed** — c-btn transition cascade, modal borders normalized, !important removed, z-index stacking corrected
- **Typography corrected** — mono/sans mismatches, icon sizing (11px to 15px), font sizing on buttons and section labels
- **3 new ESLint rules** added (named color keywords, hsl() colors, strokeWidth)
- **form-styles.ts dissolved** into proper CSS classes (c-select, c-helper, c-error, c-checkbox-row)
- **ESLint: 0 violations.** This is enforced by pre-commit hook (husky + lint-staged). Any file you touch must pass `eslint --max-warnings 0`.

**Why this matters for you:** The design system is now strictly enforced. Every component you write must use design tokens, not raw values. The ESLint config at `console/eslint.config.js` has a comprehensive cheat sheet in its header comments mapping pixel values to tokens.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────┐
│  Per-Instance SQLite (6 instances)                    │
│                                                       │
│  metrics_hourly ─── 9 metrics per hour bucket         │
│    messages_in, messages_out, messages_media           │
│    agent_tokens_in, agent_tokens_out     ← NEW        │
│    chat_tokens_in, chat_tokens_out       ← NEW        │
│    sessions_started, sessions_active     ← NEW        │
│                                                       │
│  agent_token_events ────────────────────── NEW TABLE   │
│    raw timestamped token deltas per session            │
│                                                       │
│  agent_sessions ────────────────────────── MODIFIED    │
│    + ended_at TEXT column for session lifecycle        │
└─────────────┬────────────────────────────────────────┘
              │ db-reader.ts reads + densifies
              ▼
┌─────────────────────────────────────────┐
│  Fleet Server (port 9099)               │
│                                         │
│  GET /api/metrics?range=24h|7d|30d      │
│    → { meta, messageVolume,             │
│         tokenUsage, sessionActivity }   │
└─────────────┬───────────────────────────┘
              │ useFleetMetrics(range) hook
              ▼
┌─────────────────────────────────────────┐
│  Soup Kitchen Page                      │
│                                         │
│  [KPI Strip — 7 cards with sparklines]  │
│  [Range Picker: 24h | 7d | 30d]        │
│  [Messages] [Tokens] [Sessions]  ← 3-up│
│  [Instances Table | Activity Feed]      │
└─────────────────────────────────────────┘
```

---

## Task Sequence and Dependencies

```
Task 1: Migration (schema)
  └─→ Task 2: Token event writer + ended_at (session-db)
       └─→ Task 3: Extended metrics collector
            └─→ Task 4: Bucket densification (db-reader)
                 └─→ Task 5: Fleet + per-line API routes
                      │
                      ▼ ── backend complete, frontend can start ──
                      │
Task 6: Types + chart-utils + sparklines (no backend dependency)
  └─→ Task 7: ChartPanel wrapper component
       ├─→ Task 8: FleetMetricsChart (modify — add media series)
       ├─→ Task 9: FleetTokenChart (new)
       ├─→ Task 10: FleetSessionChart (new)
       └─→ Task 11: SoupKitchen integration
```

**Tasks 1-5 are strictly sequential** — each depends on the previous. Task 6 can start in parallel once types are defined (it doesn't need the backend running). Tasks 8-10 are independent of each other but all need Task 7. Task 11 integrates everything.

---

## Key Decisions Already Made

These were debated and locked during design. Don't revisit them unless you find a blocking issue.

| Decision | Rationale |
|----------|-----------|
| **Token chart = agent + chat tokens combined** | Matches existing fleet token totals in the UI. Agent-only would disagree with the rest of the dashboard. |
| **`expandedChart` is separate from `activeKpi`** | `activeKpi` already filters the instances table. Reusing it would cause clicking a KPI to both zoom a chart AND mutate table filters. |
| **Session metrics backfill iterates every hour** | Unlike message/token metrics which only materialize hours with activity, `sessions_active` is an overlap calculation. A session running 01:00-05:00 must appear in hours 02-04 even with no events. |
| **`suspended` sessions excluded from `sessions_active`** | Suspending marks a session non-running. Including it would inflate active counts after pauses. |
| **`ended_at` is TEXT (ISO string)** | Matches existing `started_at` and `last_message_at` column types. Expression indexes on `unixepoch()` handle query performance. |
| **Bucket densification in db-reader.ts** | Shared by both fleet and per-line routes. Don't duplicate it in route handlers. |
| **Per-panel history flags (not one boolean)** | `hasMessageData`, `hasTokenData`, `hasSessionData` — because a fleet with messages but no agent activity would show a zero chart for tokens instead of the proper EmptyState. |
| **One color per chart, opacity for series** | Messages = cyan/green (existing), Tokens = violet, Sessions = green. Media series = amber. |
| **ChartPanel shared wrapper** | DRY: loading/error/empty/partial states handled once, not per chart. |

---

## Gotchas You'll Hit

### Backend

1. **`agent_sessions.started_at` is TEXT, not INTEGER.** All queries comparing timestamps must use `unixepoch(started_at)`. The expression indexes (`idx_agent_sessions_started_epoch`) cover this, but forgetting `unixepoch()` will result in a full table scan.

2. **Token event insert must be atomic with session accumulation.** The existing token accumulation (`accumulateSessionTokens`) runs inside a durability transaction in `src/core/durability.ts:356`. Your new `insertTokenEvent` call must join that same transaction — not open a separate one.

3. **The `messages` table has `input_tokens` and `output_tokens` columns** for chat-runtime tokens. These are set in `src/runtimes/chat/runtime.ts:443`. The chat token metrics (`chat_tokens_in/out`) sum from these columns — they're already timestamped per message, no new event stream needed.

4. **`metrics_hourly` uses `(bucket, metric)` as its composite primary key.** The upsert pattern is `INSERT ... ON CONFLICT(bucket, metric) DO UPDATE SET value = excluded.value`. Don't try to add a separate ID column.

5. **The fleet metrics handler iterates instances via `deps.discovery.getInstances()`.** If an instance's DB is locked or corrupted, `dbReader.getMetrics()` returns `{ ok: false, error }`. The current handler silently `continue`s. Your extension must track these failures for `meta.instancesFailed`.

6. **Session terminal statuses in live code:** `ended`, `crashed`, `resume_failed`, `orphaned`. NOT `completed` or `timeout` (those are in the spec as legacy aliases — check `session.ts` and `session-db.ts` for the actual strings used). The spec table at section 2.2 is authoritative.

### Frontend

7. **ESLint pre-commit is strict.** `eslint --max-warnings 0` runs on every staged `.ts/.tsx` file. If you touch a file, ALL violations in that file must be resolved — not just yours. The batch files were cleaned in this session, but if you create new files, they must be clean from the start.

8. **Tailwind CSS v4 — no config file.** There's no `tailwind.config.js`. Tokens are defined in `console/src/index.css` via `@theme {}` and `:root {}` blocks. Custom utilities use `@utility` syntax. If you need a new utility class, add it to `index.css`.

9. **The KpiCard sparkline expects normalized 0-1 values.** The normalization happens in `metrics-sparklines.ts`, not in the component. Your new sparkline derivation functions must normalize the same way (divide by `Math.max(...values, 1)`).

10. **`FleetMetricsChart` currently has a hardcoded title** "Fleet Message Volume (24h)". When you add range support, the title must be dynamic. The chart also hardcodes `height={120}` — the expanded state needs 200px.

11. **`useFleetMetrics('24h')` is hardcoded** at `SoupKitchen.tsx:76`. You'll need to replace the literal with the `chartRange` state variable.

12. **The chart renders conditionally** on `messageVolume.length > 0` at `SoupKitchen.tsx:235`. With densification, this is always true. Replace with ChartPanel's `hasMessageData` check.

---

## How to Run Things

```bash
# Backend tests
cd /home/q/LAB/WhatSoup
npx vitest run --pool=forks tests/path/to/test.ts

# Backend typecheck
npm run typecheck

# Frontend build
cd console && npm run build

# Frontend typecheck
cd console && npx tsc --noEmit

# Frontend lint (what pre-commit runs)
cd console && npx eslint src/ --max-warnings 0

# Start fleet server (after changes)
systemctl --user restart whatsoup-fleet.service

# Check fleet server
curl -s -H "Authorization: Bearer $(cat ~/.config/whatsoup/fleet-token)" \
  http://localhost:9099/api/metrics?range=24h | python3 -m json.tool | head -20

# Run all WhatSoup instances
systemctl --user restart 'whatsoup@*.service'
```

---

## Test Strategy

The plan uses TDD throughout. For each task:

1. Write the failing test
2. Run it — verify it fails for the RIGHT reason (not an import error)
3. Write minimal implementation
4. Run it — verify it passes
5. Commit

**Backend tests** live in `tests/` mirroring `src/` structure. Use real SQLite (`:memory:` databases). The project uses vitest with `--pool=forks` for stability.

**Frontend tests** are primarily type checks (`tsc --noEmit`) and build verification (`npm run build`). The project does not have a frontend test runner (no jest/vitest for React components). The verification section in the spec lists component tests, but the actual testing will be visual + typecheck unless you set up vitest for the console.

---

## Definition of Done

- [ ] All 11 tasks completed and committed
- [ ] `npx vitest run --pool=forks` passes (backend)
- [ ] `cd console && npx eslint src/ --max-warnings 0` passes (0 violations)
- [ ] `cd console && npx tsc --noEmit` passes (0 type errors)
- [ ] `cd console && npm run build` succeeds
- [ ] Fleet server restarts cleanly with new migration
- [ ] All 6 instances register and report metrics
- [ ] Soup Kitchen shows 3 charts in a row (messages, tokens, sessions)
- [ ] Range picker switches between 24h/7d/30d
- [ ] Clicking a KPI card expands the associated chart
- [ ] KPI cards show sparklines for messages sent/received, agent sessions, media
- [ ] Empty instances show EmptyState (not flat-zero charts)
- [ ] If an instance is down, charts show with a warning pill

---

## Questions? Look Here First

| Topic | Where to look |
|-------|--------------|
| Design token values | `console/src/index.css` (`:root` and `@theme` blocks) |
| ESLint rules + cheat sheet | `console/eslint.config.js` (header comment) |
| Existing chart patterns | `console/src/components/FleetMetricsChart.tsx` |
| API response shapes | `console/src/types.ts` |
| Metric collector pattern | `src/core/metrics-collector.ts` |
| Session lifecycle | `src/runtimes/agent/session.ts` (search for status transitions) |
| Fleet route pattern | `src/fleet/routes/fleet-metrics.ts` |
| Design system rules | `docs/specs/2026-03-31-whatsoup-console-design-system.md` |
