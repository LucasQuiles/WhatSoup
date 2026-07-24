/**
 * perf instrumentation — meter contracts (T5 b-12; 19-performance-budget §2).
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { wsMeter, startLongtaskObserver } from '../../console/src/lib/perf'

describe('wsMeter (19-§1: per-line 10/s, global 200/s caps)', () => {
  afterEach(() => {
    delete window.__soupPerf
  })

  it('tracks per-line and global 1s-window rates on window.__soupPerf', () => {
    const t0 = 1_000_000
    wsMeter.record('line-a', t0)
    wsMeter.record('line-a', t0 + 100)
    wsMeter.record('line-b', t0 + 200)
    const c = window.__soupPerf!
    expect(c.wsLineRates['line-a']).toBe(2)
    expect(c.wsLineRates['line-b']).toBe(1)
    expect(c.wsGlobalRate).toBe(3)
  })

  it('window expiry drops events older than 1s', () => {
    const t0 = 1_000_000
    wsMeter.record('line-a', t0)
    wsMeter.record('line-a', t0 + 2000)
    const c = window.__soupPerf!
    // the 1s window only holds the newer event
    expect(c.wsLineRates['line-a']).toBe(1)
  })

  it('over-cap rates increment the over-cap counter (never throws)', () => {
    const t0 = 2_000_000
    for (let i = 0; i < 12; i += 1) wsMeter.record('hot-line', t0 + i)
    const c = window.__soupPerf!
    expect(c.wsLineRates['hot-line']).toBe(12) // > 10/s cap
    expect(c.wsOverCapEvents).toBeGreaterThan(0)
  })
})

describe('startLongtaskObserver', () => {
  it('returns a no-op teardown when PerformanceObserver is absent', () => {
    const teardown = startLongtaskObserver()
    expect(typeof teardown).toBe('function')
    expect(() => teardown()).not.toThrow()
  })

  it('observes longtask entries when the API exists (sampled)', () => {
    const observed: string[] = []
    class FakeObserver {
      constructor(private cb: (list: { getEntries: () => Array<{ duration: number }> }) => void) {
        observed.push('constructed')
      }
      observe(opts: { type: string }) {
        observed.push(opts.type)
        this.cb({ getEntries: () => [{ duration: 120 }] })
      }
      disconnect() {
        observed.push('disconnect')
      }
    }
    vi.stubGlobal('PerformanceObserver', FakeObserver)
    vi.spyOn(Math, 'random').mockReturnValue(0) // always sample
    const teardown = startLongtaskObserver()
    expect(observed).toContain('longtask')
    expect(window.__soupPerf?.longtasks).toBeGreaterThan(0)
    teardown()
    expect(observed).toContain('disconnect')
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })
})
