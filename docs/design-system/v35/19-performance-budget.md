# 19 — Performance Budget (WS6)

Scale set by owner: **200 lines** on Fleet. All targets are at N=200 lines unless noted.
Owner approval requested on the numbers (§1) before they become CI-enforced.

## 1. Budget doc (6.1) — proposed targets

| Metric | Target | Rationale |
|---|---|---|
| Fleet first paint (cold, prod build) | ≤ 1.5s on reference laptop | console must feel instant |
| Fleet first paint (warm) | ≤ 600ms | cached shell + data resume |
| Update frame cost (any single line event) | < 16ms | one event never drops a frame at 60fps |
| Full-table re-render (200 lines) | < 50ms | structural updates (sort/filter) |
| Chart/spark updates | throttled to 1/s per cell, batched 250ms | sparkbars are scan aids, not tickers |
| WS message rate | per-line cap 10/s, global cap 200/s, backpressure → 1s poll fallback | transport discipline |
| Feed append | ≤ 1 DOM insert per event, no list re-render | append-only |
| Memory (24h session, fleet open) | flat within ±10% after hour 1 | no leak slope |
| Bundle | console shell ≤ 250KB gzip JS (app code only) | paint target enabler |

## 2. Instrumentation plan (6.2)

| Point | Tool | Cadence |
|---|---|---|
| Render profiler (per surface) | React Profiler API, dev+staging | every PR touching a surface |
| WS throughput | per-line token bucket + global meter | runtime, always on |
| Long-task observer | `PerformanceObserver('longtask')` > 50ms | runtime, sampled 1% |
| Memory | `performance.memory` hourly snapshot (self-heal watchdog surface) | hourly |
| CI perf lane | headless Chrome: cold/warm paint + 200-line mount + event-storm frame cost | per PR, budget-fail CI |

## 3. Virtualization audit (6.3) — per-surface ruling

| Surface | List type | N (owner scale) | Ruling |
|---|---|---|---|
| Fleet lines table | fixed-height rows | 200 | **Virtualize** above 50 rows (react-virtual); below, plain render |
| Fleet activity feed | append-only | unbounded | **Virtualize** + cap DOM at 200 with windowing |
| Inbox message thread | variable-height bubbles | per-thread | **Virtualize** (already the v3 pattern — carry) |
| Inbox conversation list | fixed rows | ~200 | Virtualize above 50 |
| Agents roster / instances | small cards | ≤ 50 | plain render |
| Skills hub result list | cards | 214 | **Virtualize** above 40 |
| Dream-lab queue + history | cards/rows | ≤ 100 | plain render |
| LogStream | log lines | unbounded | see §DD-22 |

## 4. DD-22 decision (6.4) — LogStream live-tail

**Recommendation: DEFER.** Keep bounded poll snapshots (current v3 behavior).

Rationale: at the 200-line scale, poll snapshots at 2s meet the operator's freshness need;
live-tail adds a permanent WS stream, unbounded DOM pressure, and a second freshness
paradigm to one surface — cost exceeds value at this scale. Revisit if the owner scale
moves above 200 lines or if ops usage shows poll-lag complaints. **Decision requested:**
defer ☐ · ship live-tail ☐ · ship as opt-in toggle ☐

## 5. Staleness affordances (DD-28 fold target)

Every data surface declares its freshness: `live` pulse when the WS is healthy, `stale
<age>` chip when a poll/WS source exceeds 2× its expected interval, `offline` banner on
transport loss. Staleness is a **state with a shape**, never inferred from silence.
Chart/spark cells freeze their last value with a stale chip (no fake motion).

## Acceptance

- §1 numbers owner-approved (or amended) → CI perf lane per §2 enforces them.
- §3 rulings adopted into build-phase task lists (T5).
- DD-22 recorded per owner choice; DD-28 closes on sign-off of §5.
