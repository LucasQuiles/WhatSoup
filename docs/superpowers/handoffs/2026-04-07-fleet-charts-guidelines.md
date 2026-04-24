# Fleet Charts — Expectations and Guidelines

**Status:** deferred — inherits from parent epic `docs/sdlc/closed/fleet-charts-20260407/` (Phase 4-Execute incomplete, 11 beads unimplemented).

> **Audience:** Agents and contributors joining this project mid-stream
> **Companion documents:** Project Statement, SOP, Kickoff (same directory)

---

## 1. What We Expect From You

### 1.1 Read Before You Write

Before touching any code:

1. Read the **design spec** (`docs/superpowers/specs/2026-04-07-soup-kitchen-fleet-charts.md`). This is the source of truth for what to build and why. It includes data models, API contracts, UI states, observability requirements, and verification criteria.

2. Read the **kickoff document** (`docs/superpowers/handoffs/2026-04-07-fleet-charts-kickoff.md`). It has 12 specific gotchas that will waste hours if you hit them unprepared.

3. Read the **implementation plan** for your assigned task (`docs/superpowers/plans/2026-04-07-fleet-charts.md`). Each task has exact code, exact test commands, and exact commit messages. Understand what the task does and why before starting.

4. Read the **source files** your task touches. The plan references specific line numbers and function signatures. Verify they haven't changed since the plan was written. If they have, adapt — but flag the discrepancy.

### 1.2 Follow the Plan, Don't Improve It

The plan was written with full context of the codebase, the spec, and the design decisions. It reflects deliberate choices about ordering, scope, and approach.

**Do:**
- Follow the plan steps in order
- Use the exact code provided (adapting only for changes that occurred since the plan was written)
- Commit with the exact message provided
- Flag issues you find

**Don't:**
- Reorder steps or skip steps
- Add features not in the plan
- Refactor code outside your task's scope
- Change function names, type names, or API shapes without updating the spec
- Decide a test is unnecessary and skip it

If you believe the plan is wrong about something, report it. Don't silently "fix" it.

### 1.3 Test-Driven, Not Test-After

Tests come first. Not as a formality — as a design tool. The test defines the contract. The implementation fulfills it.

If you find yourself writing implementation code and thinking "I'll add the test later," stop. Go back and write the test. The plan provides all test code — there is no reason to defer.

### 1.4 Small Commits, Clear Messages

One commit per task. The commit captures a single coherent unit of work: the test and the implementation that makes it pass. If a task has multiple sub-steps, they all go in one commit.

Do not batch multiple tasks into one commit. Do not split a single task across commits. The commit history should read as a clean narrative:

```
feat(backend): migration 18
feat(backend): token event writer
feat(backend): extended collector
feat(backend): densification
feat(backend): API routes
feat(console): types + utils
feat(console): ChartPanel
feat(console): FleetMetricsChart media
feat(console): FleetTokenChart
feat(console): FleetSessionChart
feat(console): SoupKitchen integration
```

---

## 2. Code Quality Expectations

### 2.1 No Dead Code

Do not leave commented-out code, unused imports, empty catch blocks, or TODO comments. If code isn't needed, delete it. If it might be needed later, it will be in git history.

### 2.2 No Hardcoded Values

The design system has tokens for everything: colors, spacing, font sizes, border radii, shadows, z-index, opacity, element sizes. Use them.

```tsx
// Wrong
style={{ padding: '16px 20px', fontSize: '12.5px', color: '#a0aec0' }}

// Right
className="py-[var(--sp-4)] px-[var(--sp-5)] text-data text-t2"
```

The ESLint config will catch most violations, but not all. Review your own code for token compliance before committing.

### 2.3 No Over-Engineering

Build what the spec says. Not more.

- Don't add configuration options the spec doesn't call for
- Don't build abstractions "in case we need them later"
- Don't handle error cases the spec doesn't mention
- Don't add loading states beyond what the spec defines

The spec was reviewed multiple times with adversarial feedback. If something seems missing, it was either deliberately excluded or genuinely overlooked. In the former case, don't add it. In the latter, flag it.

### 2.4 Type Safety

TypeScript strict mode is enabled. Do not use `any`. Do not use `as` casts except where the plan explicitly shows them (e.g., casting DB query results).

If you find yourself fighting the type system, it's usually a signal that the data shape doesn't match what you think it is. Read the type definitions. Read the spec's interface definitions. Check that your code matches.

### 2.5 Error Handling

Backend errors use structured Pino logs. The spec's observability section (section 10) defines exactly which events to log, at which level, with which fields. Follow it.

Frontend errors use the `ChartPanel` wrapper's error state. Individual chart components should not catch errors — let them propagate to the wrapper.

Do not swallow errors with empty `catch` blocks. Do not log errors to `console.error` (use the structured logger).

---

## 3. Frontend-Specific Guidelines

### 3.1 Design System Compliance

The design system spec (`docs/specs/2026-03-31-whatsoup-console-design-system.md`) is law. Key rules:

- **Monospace for data, sans-serif for chrome.** If a value came from the backend (a number, a timestamp, a status), it's monospace. If it's UI text (a heading, a label, a button), it's sans-serif.
- **4px spacing grid.** All padding, margin, and gap values must be on the 4px grid or use documented half-steps (3px, 6px, 10px).
- **Mode colors are the information architecture.** Passive = green, Chat = cyan, Agent = violet. Don't use mode colors decoratively.
- **Status colors communicate urgency.** OK = green, Warn = amber, Crit = red. Don't use status colors for non-status purposes.

### 3.2 Component Patterns

Follow the existing component patterns:

**Chart components** receive data as props, not query results. The parent page owns the data fetching. The chart component renders what it's given.

**CSS component classes** (`c-card`, `c-btn`, `c-section`, etc.) handle structural styling. Tailwind utilities handle contextual overrides (color, spacing adjustments). Don't replicate what a CSS class already provides.

**Composite typography classes** (`c-data`, `c-label`, `c-heading`, `c-body`, `c-meta`, `c-section-label`, `c-col-header`, `c-kpi-value`) encode font-family + font-size + font-weight + color + letter-spacing. Use them instead of assembling those properties manually.

### 3.3 Accessibility

- All interactive elements must be keyboard-accessible
- Buttons must have `type="button"` (enforced by ESLint)
- Charts are inherently non-accessible — the KPI cards above them serve as the accessible data surface
- Modals and dialogs must have proper `aria-label` / `aria-labelledby` attributes
- Color is never the only signifier — pair it with text labels or icons

### 3.4 Chart Component Structure

Each chart component follows this pattern:

```tsx
import { Area, AreaChart, ResponsiveContainer, ... } from 'recharts';
import { AXIS_TICK, TOOLTIP_STYLE, CHART_MARGIN, formatBucketLabel } from '../lib/chart-utils';

export function FleetXxxChart({ data, range }: { data: XxxBucket[]; range: MetricsRange }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={CHART_MARGIN}>
        <CartesianGrid stroke="var(--b1)" vertical={false} />
        <XAxis ... tick={AXIS_TICK} tickFormatter={(v) => formatBucketLabel(v, range)} />
        <YAxis ... tick={AXIS_TICK} />
        <Tooltip contentStyle={TOOLTIP_STYLE} ... />
        <Area ... />
      </AreaChart>
    </ResponsiveContainer>
  );
}
```

Key points:
- `ResponsiveContainer` wraps every chart. Height is set by the parent (`ChartPanel`), not the chart.
- Shared constants (`AXIS_TICK`, `TOOLTIP_STYLE`, `CHART_MARGIN`) come from `chart-utils.ts`. Do not inline them.
- `formatBucketLabel` takes the `range` parameter to format appropriately (hours for 24h, days for 7d/30d).
- `fillOpacity` must be a numeric literal (e.g., `0.3`), not a CSS custom property string. Recharts passes it to SVG, which does not reliably support CSS variables in presentation attributes.

---

## 4. Backend-Specific Guidelines

### 4.1 Database Patterns

**Migrations are append-only.** Never modify an existing migration. Add a new one at the next version number.

**Schema changes are additive.** Add columns, add tables, add indexes. Never drop or rename columns in a migration that runs on production data.

**Queries use parameterized values.** Never interpolate user input into SQL strings. The existing codebase uses `.prepare(sql).run(...params)` consistently.

**Transactions are explicit.** Use `db.raw.exec('BEGIN')` / `db.raw.exec('COMMIT')` with try/catch/rollback. The metrics collector's backfill function shows the pattern.

### 4.2 Metrics Collector Patterns

**`upsertMetric(db, bucket, metric, value)`** is the single write path for all metrics. It uses `INSERT ... ON CONFLICT DO UPDATE`. Always use it — do not write custom insert queries for `metrics_hourly`.

**`countMessages(db, sql, ...params)`** is the single read path for counting rows. It returns a number. Use it for new metrics that count rows (e.g., sessions_started). For SUM queries (token amounts), write a similar helper.

**Backfill runs in a transaction.** All new backfill logic must be inside the existing `BEGIN`/`COMMIT` block. Do not add a nested transaction.

### 4.3 Fleet Route Patterns

**`deps.discovery.getInstances()`** returns a `Map<string, InstanceInfo>`. Iterate it with `for (const [, instance] of instances)`.

**`deps.dbReader.getMetrics(name, dbPath, { range })`** returns `DbResult<T>` — an object with `{ ok: boolean, data?, error? }`. Check `result.ok` before accessing `result.data`. If `!result.ok`, count it as a failed instance and `continue`.

**`jsonResponse(res, statusCode, body)`** is the single response helper. Always use it.

---

## 5. What "Done" Looks Like

A task is done when:

1. The test exists and passes
2. The implementation matches the plan
3. The full test suite passes
4. TypeScript compiles
5. ESLint passes (frontend)
6. The commit is clean with the correct message

The project is done when all 11 tasks are committed, all quality gates pass (see SOP section 4), and the visual verification checklist is complete.

---

## 6. What to Do When Things Go Wrong

| Situation | Action |
|-----------|--------|
| Test fails for the wrong reason | Fix the test setup (imports, fixtures), not the test assertion |
| Implementation doesn't match the plan because source code changed | Adapt the implementation to the current code. Flag the discrepancy. |
| A task is too complex or unclear | Stop. Report what's unclear. Do not guess. |
| You discover a bug in existing code | Note it. Do not fix it unless it blocks your task. File it as a follow-up. |
| ESLint rejects your code | Read the error message. The ESLint config has a cheat sheet. Fix the violation. Do not suppress it. |
| Pre-commit hook blocks your commit | Fix the violations. Do not use `--no-verify`. |
| The fleet server won't start after migration | Check the migration ran: look for schema_migrations entry. Check the error log: `journalctl --user -u whatsoup-fleet.service -n 50`. |
| The API returns unexpected data | Compare against the spec's response shape. Check that the collector ran (look for `metrics.collect` log entries). Check that densification is producing the right bucket count. |
| A chart renders but looks wrong | Check the data in the browser's Network tab. If the data is right, the chart props are wrong. If the data is wrong, the backend has an issue. |
| You're stuck and don't know why | Report: what you tried, what you expected, what happened. Include the exact error output. |
