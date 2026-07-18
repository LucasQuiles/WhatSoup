import { describe, expect, it } from 'vitest'

import { queryFreshness } from '../../console/src/lib/freshness.js'

const NOW = 1_800_000_000_000 // fixed instant; injected clock keeps these deterministic
const INTERVAL = 60_000

describe('queryFreshness (GUI-5 metrics-plane freshness)', () => {
  it('reports fresh live data with its observation time', () => {
    const f = queryFreshness({ dataUpdatedAt: NOW - 5_000, refetchFailed: false, now: NOW })
    expect(f.stale).toBe(false)
    expect(f.observedAt).toBe(NOW - 5_000)
  })

  it('flags carried data older than the stale threshold', () => {
    const f = queryFreshness({ dataUpdatedAt: NOW - 121_000, refetchFailed: false, now: NOW })
    expect(f.stale).toBe(true)
    expect(f.observedAt).toBe(NOW - 121_000)
  })

  it('is not stale exactly at the threshold boundary (strictly-greater rule)', () => {
    const f = queryFreshness({ dataUpdatedAt: NOW - 120_000, refetchFailed: false, now: NOW })
    expect(f.stale).toBe(false)
  })

  it('is stale one millisecond past the threshold', () => {
    const f = queryFreshness({ dataUpdatedAt: NOW - 120_001, refetchFailed: false, now: NOW })
    expect(f.stale).toBe(true)
  })

  it('flags a failed refetch even when the last success is inside the threshold', () => {
    const f = queryFreshness({ dataUpdatedAt: NOW - 1_000, refetchFailed: true, now: NOW })
    expect(f.stale).toBe(true)
    expect(f.observedAt).toBe(NOW - 1_000)
  })

  it('never flags a first load with no observation yet (no false-stale)', () => {
    const f = queryFreshness({ dataUpdatedAt: 0, refetchFailed: false, now: NOW })
    expect(f.stale).toBe(false)
    expect(f.observedAt).toBeNull()
  })

  it('honours a custom threshold', () => {
    const f = queryFreshness({
      dataUpdatedAt: NOW - 11_000,
      refetchFailed: false,
      now: NOW,
      staleAfterMs: 10_000,
    })
    expect(f.stale).toBe(true)
  })

  it('clears after a successful refresh inside the threshold (recovery)', () => {
    const stale = queryFreshness({ dataUpdatedAt: NOW - INTERVAL * 3, refetchFailed: true, now: NOW })
    expect(stale.stale).toBe(true)
    const recovered = queryFreshness({ dataUpdatedAt: NOW - 2_000, refetchFailed: false, now: NOW })
    expect(recovered.stale).toBe(false)
  })
})
