# Metrics, Realtime, and Watch Completeness Implementation Plan

**Status:** Pending implementation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finalize hourly metrics with explicit freshness, preserve realtime last-known-good state on observation failures, and reject public watch kinds without executors.

**Architecture:** Advance one SQLite collection watermark transactionally after finalizing crossed hours, then carry `complete`/`partial`/`unknown` quality through API and UI. Keep realtime snapshots per successful probe, and share one executable-watch tuple while retaining broader internal legacy types for fail-closed row handling.

**Tech Stack:** Node.js 24, TypeScript 5.9, node:sqlite, Zod 3, React 19, Recharts 3, Vitest 4 fake clocks, Vitest Browser/Playwright.

## Global Constraints

- Audited base: `7330bafbe77d7a15febce32eb09b304e8778862f` (`origin/main`).
- Publication boundary: Local branch and commits only. Publishing branches or Draft PRs still requires explicit approval.
- This is a remediation program, not a license for a broad rewrite.
- Realtime poll failure preserves last-known-good state and emits no business event.
- Metrics expose freshness/completeness watermarks; missing collection is not rendered as measured zero.
- Metrics labels remain low-cardinality and never use raw conversation identities.
- Creation schema exposes only wired kinds; legacy rows continue fail-closed/TTL behavior.
- Add no runtime dependency; use `scripts/run-with-pinned-npm.sh` for every command.
- Migration 42 follows the Wave-1 sequence through migration 41; if current main has advanced, reserve the next free version and update this plan atomically before implementation.

---

## File Structure

- `src/core/database.ts` and `metrics-collector.ts` own migration 42 and the receipt.
- `src/fleet/db-reader.ts` and metric routes carry quality/freshness.
- `console/src/lib/metrics-quality.ts` and `MetricsCompletenessNotice.tsx` prevent false-zero rendering.
- `src/fleet/realtime-event-poller.ts` owns per-probe LKG and health.
- `src/core/substrate/types.ts` owns the executable public tuple; MCP/docs consume it.

### Task 1: Finalize Crossed Hours and Persist the Receipt

**Files:**
- Modify: `src/core/database.ts:520-910`
- Modify: `src/core/metrics-collector.ts:1-314`
- Test: `tests/core/metrics-collector.test.ts`
- Test: `tests/core/migration-safety.test.ts`

**Interfaces:**
- `MetricsCollectionState = { lastCollectedAt: string; completeThrough: string }`.
- `completeThrough` is exclusive: buckets before it are finalized.

- [ ] **Step 1: Add failing fake-clock tests**

~~~ts
it('finalizes a crossed hour and advances completeness', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-09T10:59:30.000Z'))
  insertMessage(db, {
    timestamp: toUnixSeconds('2026-07-09T10:15:00Z'),
    fromMe: false, contentType: 'text', messageId: 'first',
  })
  collectHourlyMetrics(db, new Date(Date.now()))
  insertMessage(db, {
    timestamp: toUnixSeconds('2026-07-09T10:59:59Z'),
    fromMe: false, contentType: 'text', messageId: 'late',
  })
  vi.setSystemTime(new Date('2026-07-09T11:01:00.000Z'))
  collectHourlyMetrics(db, new Date(Date.now()))
  const row = db.raw.prepare(
    "SELECT value FROM metrics_hourly WHERE bucket=? AND metric='messages_in'",
  ).get('2026-07-09T10:00:00.000Z') as { value: number }
  expect(row.value).toBe(2)
  expect(getMetricsCollectionState(db)).toEqual({
    lastCollectedAt: '2026-07-09T11:01:00.000Z',
    completeThrough: '2026-07-09T11:00:00.000Z',
  })
  vi.useRealTimers()
})

it('restart backfill advances only after repairing closed hours', () => {
  insertMessage(db, {
    timestamp: toUnixSeconds('2026-07-09T08:20:00Z'),
    fromMe: true, contentType: 'text', messageId: 'downtime',
  })
  backfillMetrics(db, 1, new Date('2026-07-09T12:05:00.000Z'))
  expect(getMetricsCollectionState(db)?.completeThrough)
    .toBe('2026-07-09T12:00:00.000Z')
})
~~~

Run:

~~~bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/metrics-collector.test.ts tests/core/migration-safety.test.ts --pool=forks
~~~

Expected: FAIL because migration/helper are absent and the prior bucket is stale.

- [ ] **Step 2: Add migration 42**

Register `[42, runMigration42]` after the Wave-1 migrations:

~~~ts
function runMigration42(db: DatabaseSync): void {
  db.exec(String.raw`
    CREATE TABLE IF NOT EXISTS metrics_collection_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      last_collected_at TEXT NOT NULL,
      complete_through TEXT NOT NULL
    );
  `)
}
~~~

- [ ] **Step 3: Implement complete collector state**

~~~ts
export interface MetricsCollectionState {
  lastCollectedAt: string
  completeThrough: string
}

export function getMetricsCollectionState(
  db: Database,
): MetricsCollectionState | null {
  const row = db.raw.prepare(
    'SELECT last_collected_at, complete_through '
    + 'FROM metrics_collection_state WHERE singleton=1',
  ).get() as {
    last_collected_at: string
    complete_through: string
  } | undefined
  return row ? {
    lastCollectedAt: row.last_collected_at,
    completeThrough: row.complete_through,
  } : null
}

function writeState(db: Database, state: MetricsCollectionState): void {
  db.raw.prepare(String.raw`
    INSERT INTO metrics_collection_state
      (singleton, last_collected_at, complete_through)
    VALUES (1, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET
      last_collected_at=excluded.last_collected_at,
      complete_through=excluded.complete_through
  `).run(state.lastCollectedAt, state.completeThrough)
}
~~~

Replace `collectHourlyMetrics`:

~~~ts
export function collectHourlyMetrics(
  db: Database,
  now = new Date(),
): MetricsCollectionState {
  const current = toHourWindow(now)
  const previous = getMetricsCollectionState(db)
  const cursor = previous
    ? Math.floor(Date.parse(previous.completeThrough) / 1000)
    : current.startSec
  db.raw.exec('BEGIN')
  try {
    for (let sec = cursor; sec < current.startSec; sec += 3600) {
      collectMetricsForWindow(db, {
        bucket: new Date(sec * 1000).toISOString(),
        startSec: sec,
        endSec: sec + 3600,
      })
    }
    collectMetricsForWindow(db, current)
    const state = {
      lastCollectedAt: now.toISOString(),
      completeThrough: current.bucket,
    }
    writeState(db, state)
    db.raw.exec('COMMIT')
    return state
  } catch (error) {
    db.raw.exec('ROLLBACK')
    throw error
  }
}
~~~

Before `backfillMetrics` commits, call `writeState` with `now.toISOString()` and `currentHour.bucket`. Add a trigger-injected failure test proving metric writes and receipt roll back together.

- [ ] **Step 4: Verify and commit**

~~~bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/metrics-collector.test.ts tests/core/migration-safety.test.ts --pool=forks
bash scripts/run-with-pinned-npm.sh run typecheck:all
git add src/core/database.ts src/core/metrics-collector.ts tests/core/metrics-collector.test.ts tests/core/migration-safety.test.ts
git commit -m "fix(metrics): finalize crossed hours"
~~~

Expected: tests PASS; typecheck exits 0.

### Task 2: Carry Completeness Through API and UI

**Files:**
- Modify: `src/fleet/db-reader.ts:270-460`
- Modify: `src/fleet/routes/metrics.ts`
- Modify: `src/fleet/routes/fleet-metrics.ts`
- Create: `console/src/lib/metrics-quality.ts`
- Create: `console/src/components/MetricsCompletenessNotice.tsx`
- Modify: `console/src/types.ts:100-155`
- Modify: `console/src/pages/Metrics.tsx`
- Modify: `console/src/components/line-detail/MetricsTab.tsx`
- Test: `tests/fleet/db-reader-metrics.test.ts`
- Test: `tests/browser/metrics-completeness.test.tsx`

**Interfaces:**
- `MetricBucketQuality = 'complete' | 'partial' | 'unknown'`.
- Missing rows before watermark are measured zero; a present current bucket is partial; a missing bucket at/after watermark is unknown.

- [ ] **Step 1: Add failing reader and browser tests**

~~~ts
expect(result.data.collection).toEqual({
  lastCollectedAt: '2026-04-05T18:10:00.000Z',
  completeThrough: '2026-04-05T18:00:00.000Z',
})
expect(result.data.messageVolume.find(
  (bucket) => bucket.bucket === '2026-04-05T17:00:00.000Z',
)).toMatchObject({ inbound: 0, quality: 'complete' })
expect(result.data.messageVolume.at(-1))
  .toMatchObject({ inbound: 4, quality: 'partial' })
~~~

Create browser test:

~~~tsx
it('labels missing collection rather than showing measured zero', async () => {
  const screen = await render(
    <MetricsCompletenessNotice
      collection={{ lastCollectedAt: null, completeThrough: null }}
      summary={{ known: 0, partial: 0, unknown: 24 }}
    />,
  )
  await expect.element(
    screen.getByText(/24 hours have no collection receipt/i),
  ).toBeVisible()
  expect(document.body.textContent).not.toContain('0 messages')
})
~~~

Run both; expect missing fields/modules.

- [ ] **Step 2: Implement reader quality**

~~~ts
function bucketQuality(
  bucket: string,
  completeThrough: string | null,
  hasRequiredRows: boolean,
): MetricBucketQuality {
  if (completeThrough !== null && bucket < completeThrough) return 'complete'
  return hasRequiredRows ? 'partial' : 'unknown'
}
~~~

Read the singleton receipt in `getMetrics`. Add `quality` to message buckets only when all three message rows exist, token buckets when all four token rows exist, and session buckets when both rows exist. Return `collection`. Fleet aggregation uses the earliest successful `completeThrough`/`lastCollectedAt`; any failed/unknown instance caps aggregate quality at `partial`.

- [ ] **Step 3: Implement complete UI helpers**

Create `metrics-quality.ts`:

~~~ts
import type { MetricBucketQuality } from '../types'

export interface MetricCompletenessSummary {
  known: number
  partial: number
  unknown: number
}

export function knownMetricBuckets<T extends {
  quality?: MetricBucketQuality
}>(buckets: readonly T[]): T[] {
  return buckets.filter((bucket) => bucket.quality !== 'unknown')
}

export function summarizeMetricCompleteness(
  buckets: readonly { quality?: MetricBucketQuality }[],
): MetricCompletenessSummary {
  return buckets.reduce((summary, bucket) => {
    if (bucket.quality === 'unknown') summary.unknown += 1
    else {
      summary.known += 1
      if (bucket.quality === 'partial') summary.partial += 1
    }
    return summary
  }, { known: 0, partial: 0, unknown: 0 })
}
~~~

Create `MetricsCompletenessNotice.tsx`:

~~~tsx
import type { MetricCompletenessSummary } from '../lib/metrics-quality'
import type { MetricsCollectionStatus } from '../types'

interface Props {
  collection: MetricsCollectionStatus
  summary: MetricCompletenessSummary
}

export function MetricsCompletenessNotice({ collection, summary }: Props) {
  if (summary.unknown === 0 && summary.partial === 0) return null
  const gaps = summary.unknown > 0
    ? `${summary.unknown} hour${summary.unknown === 1 ? '' : 's'} have no collection receipt.`
    : ''
  const partial = summary.partial > 0
    ? `${summary.partial} hour${summary.partial === 1 ? '' : 's'} are partial.`
    : ''
  const freshness = collection.lastCollectedAt
    ? `Last collection: ${new Date(collection.lastCollectedAt).toLocaleString()}.`
    : 'No successful collection is recorded.'
  return <div role="status">{[gaps, partial, freshness].filter(Boolean).join(' ')}</div>
}
~~~

Filter unknown buckets before charts, KPIs, sparklines, and totals. Show `—` when no known bucket and prefix partial totals with `≥`. CSV headers include `quality` and output unknown as `bucket,,,,unknown`.

- [ ] **Step 4: Verify and commit**

~~~bash
bash scripts/run-with-pinned-npm.sh test -- tests/fleet/db-reader-metrics.test.ts tests/fleet/routes/metrics.test.ts tests/fleet/routes/fleet-metrics.test.ts tests/console/metrics-page.test.tsx tests/console/metrics-tab.test.tsx tests/console/metrics-sparklines.test.ts tests/console/preferences-csv.test.ts --pool=forks
bash scripts/run-with-pinned-npm.sh run test:browser -- tests/browser/metrics-completeness.test.tsx
bash scripts/run-with-pinned-npm.sh run typecheck:all
git add src/fleet/db-reader.ts src/fleet/routes/metrics.ts src/fleet/routes/fleet-metrics.ts console/src/lib/metrics-quality.ts console/src/components/MetricsCompletenessNotice.tsx console/src/types.ts console/src/pages/Metrics.tsx console/src/components/line-detail/MetricsTab.tsx console/src/lib/metrics-sparklines.ts console/src/lib/csv-export.ts tests/fleet/db-reader-metrics.test.ts tests/fleet/routes/metrics.test.ts tests/fleet/routes/fleet-metrics.test.ts tests/console/metrics-page.test.tsx tests/console/metrics-tab.test.tsx tests/console/metrics-sparklines.test.ts tests/console/preferences-csv.test.ts tests/browser/metrics-completeness.test.tsx
git commit -m "fix(metrics): expose collection completeness"
~~~

Expected: tests PASS, one browser test passes, typecheck exits 0.

### Task 3: Preserve Realtime Last-Known-Good State

**Files:**
- Modify: `src/fleet/realtime-event-poller.ts:1-211`
- Test: `tests/fleet/realtime-event-poller.test.ts`
- Test: `tests/fleet/realtime-event-poller-log.test.ts`

**Interfaces:**

~~~ts
export type RealtimeProbeErrorType =
  | 'db_unavailable'
  | 'typing_http'
  | 'typing_invalid_json'
  | 'typing_unreachable'

export interface RealtimeProbeHealth {
  lastSuccessAt: string | null
  failureStreak: number
  degradedSince: string | null
  degradedForMs: number
  errorType: RealtimeProbeErrorType | null
}
~~~

Constructor adds `now = () => Date.now()`; `getStatus()` returns marker/typing health by instance.

- [ ] **Step 1: Add failing LKG/fake-clock tests**

~~~ts
it('keeps marker LKG on failure and emits the genuine recovery delta', async () => {
  let result: any = {
    ok: true,
    data: {
      latestMessagePk: 10,
      latestMessageMarker: '10:a',
      latestAccessMarker: 'a',
    },
  }
  const dbReader = { getLatestMarkers: vi.fn(() => result) } as any
  const poller = new FleetRealtimeEventPoller({
    discovery: makeDiscovery({
      test: {
        name: 'test', dbPath: '/tmp/test.db',
        logDir: '/tmp/logs', healthPort: 0,
      },
    }),
    dbReader,
    realtime: publisher,
  })
  await poller.poll()
  publisher.calls.length = 0
  result = { ok: false, error: 'db locked' }
  await poller.poll()
  expect(publisher.calls).toEqual([])
  result = {
    ok: true,
    data: {
      latestMessagePk: 11,
      latestMessageMarker: '11:b',
      latestAccessMarker: 'a',
    },
  }
  await poller.poll()
  expect(publisher.calls.map((event) => event.type))
    .toEqual(expect.arrayContaining(['message_received', 'chat_updated']))
})

it('does not publish composing false when typing returns 503', async () => {
  mockProxyToInstance
    .mockResolvedValueOnce({
      status: 200,
      body: '{"composing":[{"jid":"group@g.us","since":30}]}',
    })
    .mockResolvedValueOnce({ status: 503, body: 'unavailable' })
  const poller = new FleetRealtimeEventPoller({
    discovery: makeDiscovery({
      test: {
        name: 'test', dbPath: '/tmp/test.db',
        logDir: '/tmp/logs', healthPort: 9099,
      },
    }),
    dbReader: makeDbReader(),
    realtime: publisher,
  })
  await poller.poll()
  publisher.calls.length = 0
  await poller.poll()
  expect(publisher.calls).toEqual([])
})

it('exposes failure streak and dwell with an injected clock', async () => {
  let now = Date.parse('2026-07-09T12:00:00.000Z')
  const poller = new FleetRealtimeEventPoller({
    discovery: makeDiscovery({
      test: {
        name: 'test', dbPath: '/tmp/test.db',
        logDir: '/tmp/logs', healthPort: 0,
      },
    }),
    dbReader: {
      getLatestMarkers: vi.fn(() => ({ ok: false, error: 'db' })),
    } as any,
    realtime: publisher,
  }, 2000, () => now)
  await poller.poll()
  now += 7000
  await poller.poll()
  expect(poller.getStatus().instances.test.markers).toMatchObject({
    failureStreak: 2,
    degradedSince: '2026-07-09T12:00:00.000Z',
    degradedForMs: 7000,
    errorType: 'db_unavailable',
  })
})
~~~

Run:

~~~bash
bash scripts/run-with-pinned-npm.sh test -- tests/fleet/realtime-event-poller.test.ts tests/fleet/realtime-event-poller-log.test.ts --pool=forks
~~~

Expected: FAIL because failures currently overwrite snapshots and `getStatus` is absent.

- [ ] **Step 2: Implement probe health**

~~~ts
interface MutableProbeHealth {
  lastSuccessAt: string | null
  failureStreak: number
  degradedSince: string | null
  errorType: RealtimeProbeErrorType | null
}

function recordSuccess(health: MutableProbeHealth, now: number): void {
  health.lastSuccessAt = new Date(now).toISOString()
  health.failureStreak = 0
  health.degradedSince = null
  health.errorType = null
}

function recordFailure(
  health: MutableProbeHealth,
  now: number,
  errorType: RealtimeProbeErrorType,
): void {
  health.failureStreak += 1
  health.degradedSince ??= new Date(now).toISOString()
  health.errorType = errorType
}
~~~

Store marker and typing health per instance. `getSnapshot` returns a discriminated `{ ok, value }`; on `ok:false` record failure, log `probe`/`failureStreak`/`degradedSince`/`errorType`, and do not call `snapshots.set`.

- [ ] **Step 3: Reconcile typing only after successful observation**

Replace the fleet-wide temporary map with `lastTypingByInstance: Map<string, Map<string, number>>`. For each instance:

~~~ts
if (result.status !== 200) {
  recordFailure(health.typing, this.now(), 'typing_http')
  return
}
let data: unknown
try { data = JSON.parse(result.body) } catch {
  recordFailure(health.typing, this.now(), 'typing_invalid_json')
  return
}
if (
  typeof data !== 'object'
  || data === null
  || !Array.isArray((data as { composing?: unknown }).composing)
) {
  recordFailure(health.typing, this.now(), 'typing_invalid_json')
  return
}
const current = new Map<string, number>()
for (const entry of (data as { composing: unknown[] }).composing) {
  if (isTypingHealthEntry(entry)) current.set(entry.jid.trim(), entry.since)
}
const previous = this.lastTypingByInstance.get(inst.name) ?? new Map()
for (const [jid, since] of current) {
  if (previous.get(jid) !== since) {
    publishTypingUpdate(this.deps.realtime, inst.name, jid, true)
  }
}
for (const jid of previous.keys()) {
  if (!current.has(jid)) {
    publishTypingUpdate(this.deps.realtime, inst.name, jid, false)
  }
}
this.lastTypingByInstance.set(inst.name, current)
recordSuccess(health.typing, this.now())
~~~

Delete snapshots/typing/health on instance removal and clear them on stop.

- [ ] **Step 4: Verify and commit**

~~~bash
bash scripts/run-with-pinned-npm.sh test -- tests/fleet/realtime-event-poller.test.ts tests/fleet/realtime-event-poller-log.test.ts tests/fleet/realtime-publisher.test.ts --pool=forks
bash scripts/run-with-pinned-npm.sh run typecheck:all
git add src/fleet/realtime-event-poller.ts tests/fleet/realtime-event-poller.test.ts tests/fleet/realtime-event-poller-log.test.ts
git commit -m "fix(realtime): preserve last known good state"
~~~

Expected: tests PASS; typecheck exits 0.

### Task 4: Reject Public Watch Kinds Without Executors

**Files:**
- Modify: `src/core/substrate/types.ts:1-12`
- Modify: `src/mcp/tools/substrate.ts:225-285`
- Modify: `tests/mcp/tools/substrate.test.ts:330-430`
- Modify: `tests/core/substrate/triggers.test.ts`
- Modify: `tests/core/substrate/poller.test.ts`
- Modify: `docs/tools.md:348-380`
- Modify: `docs/runbooks/personal-line-watch.md:60-230`

**Interfaces:**

~~~ts
export const EXECUTABLE_WATCH_KINDS = [
  'poll.url',
  'poll.file',
  'poll.sqlite',
  'poll.pinecone',
] as const
export type ExecutableWatchKind =
  typeof EXECUTABLE_WATCH_KINDS[number]
~~~

Internal `TriggerKind` retains `poll.email`, `poll.shell`, and `event.message` solely for legacy fail-closed/TTL handling.

- [ ] **Step 1: Add failing public rejection tests**

~~~ts
it.each(['poll.email', 'event.message'])(
  'rejects public source %s without persistence',
  async (source) => {
    const result = await registry.call('create_watch', {
      source,
      criteria: source === 'poll.email'
        ? { source: 'gmail' }
        : { match: 'mention', value: '@me' },
      report_chat: 'watch-report@s.whatsapp.net',
    }, adminSession)
    expect(result.isError).toBe(true)
    const beads = parseResult(await registry.call(
      'list_beads', { owner_jid: adminPhone }, adminSession,
    ))
    const triggers = parseResult(await registry.call(
      'list_triggers', {}, adminSession,
    ))
    expect(beads.beads).toEqual([])
    expect(triggers.triggers).toEqual([])
  },
)
~~~

Switch unrelated successful `create_watch` fixtures from `poll.email` to safe `poll.sqlite` criteria. Keep core tests that directly persist legacy kinds.

Run:

~~~bash
bash scripts/run-with-pinned-npm.sh test -- tests/mcp/tools/substrate.test.ts tests/core/substrate/triggers.test.ts tests/core/substrate/poller.test.ts --pool=forks
~~~

Expected: MCP tests FAIL because inert kinds are still public; legacy core tests pass.

- [ ] **Step 2: Restrict creation to the shared tuple**

Export the tuple above from `types.ts`, import it in `substrate.ts`, and use:

~~~ts
source: z.enum(EXECUTABLE_WATCH_KINDS),
~~~

Type the parsed source as `ExecutableWatchKind`. Keep the existing default-off `poll.url` gate before bead creation.

- [ ] **Step 3: Align public docs while preserving legacy truth**

The `docs/tools.md` source row becomes:

~~~markdown
| source | `"poll.url"` \| `"poll.file"` \| `"poll.sqlite"` \| `"poll.pinecone"` | required | Executable source. `poll.url` is rejected unless `advanced.enableUrlWatch` is true. |
~~~

Move `poll.email`, `poll.shell`, and `event.message` under “Legacy persisted rows” in the runbook. State they cannot be created publicly; old rows retain existing no-op/fail-closed/TTL semantics.

- [ ] **Step 4: Verify and commit**

~~~bash
bash scripts/run-with-pinned-npm.sh test -- tests/mcp/tools/substrate.test.ts tests/core/substrate/triggers.test.ts tests/core/substrate/poller.test.ts --pool=forks
bash scripts/run-with-pinned-npm.sh run guard:doc-drift
bash scripts/run-with-pinned-npm.sh run guard:public-surface-drift
bash scripts/run-with-pinned-npm.sh run guard:doc-tally
bash scripts/run-with-pinned-npm.sh run typecheck:all
git add src/core/substrate/types.ts src/mcp/tools/substrate.ts tests/mcp/tools/substrate.test.ts tests/core/substrate/triggers.test.ts tests/core/substrate/poller.test.ts docs/tools.md docs/runbooks/personal-line-watch.md
git commit -m "fix(substrate): expose only executable watches"
~~~

Expected: all commands exit 0.

### Task 5: Full Verification

**Files:** Verify only.

- [ ] **Step 1: Run focused evidence**

~~~bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/metrics-collector.test.ts tests/core/migration-safety.test.ts tests/fleet/db-reader-metrics.test.ts tests/fleet/routes/metrics.test.ts tests/fleet/routes/fleet-metrics.test.ts tests/fleet/realtime-event-poller.test.ts tests/fleet/realtime-event-poller-log.test.ts tests/mcp/tools/substrate.test.ts tests/core/substrate/triggers.test.ts tests/core/substrate/poller.test.ts tests/console/metrics-page.test.tsx tests/console/metrics-tab.test.tsx tests/console/metrics-sparklines.test.ts tests/console/preferences-csv.test.ts --pool=forks
bash scripts/run-with-pinned-npm.sh run test:browser -- tests/browser/metrics-completeness.test.tsx
bash scripts/run-with-pinned-npm.sh run typecheck:all
bash scripts/run-with-pinned-npm.sh run guard:doc-drift
bash scripts/run-with-pinned-npm.sh run guard:public-surface-drift
~~~

Expected: all commands exit 0; browser reports one passing completeness test.

- [ ] **Step 2: Run release gate**

~~~bash
bash scripts/run-with-pinned-npm.sh run verify:release
~~~

Expected: exit 0. Report missing browser/provider/live-service prerequisites as proof gaps; masked failures are inconclusive.

## Self-Review Notes

- Coverage: Tasks 1–2 = WS-C04, Task 3 = WS-C05, Task 4 = WS-C06.
- Type consistency: `completeThrough` is exclusive everywhere; quality/error enum spellings are stable.
- Browser/fake-clock proof: Task 1 crosses an hour with fake time; Task 3 injects dwell time; Task 2 renders unknown state in Chromium.
- Residual uncertainty: real process downtime, fleet clock skew, and live operator cadence require staging evidence.
