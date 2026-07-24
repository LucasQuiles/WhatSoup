/**
 * perf — runtime performance instrumentation (T5 b-12; 19-performance-budget
 * §2). Three lightweight meters, always-on with sampled logging:
 *
 * 1. WS throughput meter — per-line and global 1s-window rates against the
 *    budget caps (per-line 10/s, global 200/s). Over-cap is a debug note,
 *    never a thrown error (transport discipline is a server concern; this
 *    meter reports).
 * 2. Long-task observer — PerformanceObserver('longtask'), sampled 1%,
 *    counting tasks > 50ms.
 * 3. React Profiler callback — dev-mode render-duration log per surface.
 *
 * Counters surface on window.__soupPerf for diagnostics; nothing here
 * affects the render path's behavior.
 */

export interface PerfCounters {
  wsGlobalRate: number
  wsLineRates: Record<string, number>
  wsOverCapEvents: number
  longtasks: number
}

declare global {
  interface Window {
    __soupPerf?: PerfCounters
  }
}

/* ── WS throughput meter ── */

const LINE_CAP = 10 // 19-§1: per-line cap 10/s
const GLOBAL_CAP = 200 // 19-§1: global cap 200/s
const WINDOW_MS = 1000

class WsMeter {
  private lineEvents = new Map<string, number[]>()
  private globalEvents: number[] = []
  private counters: PerfCounters = { wsGlobalRate: 0, wsLineRates: {}, wsOverCapEvents: 0, longtasks: 0 }

  record(instance: string, now = Date.now()): void {
    const cutoff = now - WINDOW_MS
    this.globalEvents.push(now)
    this.globalEvents = this.globalEvents.filter((t) => t > cutoff)
    const line = this.lineEvents.get(instance) ?? []
    line.push(now)
    this.lineEvents.set(instance, line.filter((t) => t > cutoff))

    const globalRate = this.globalEvents.length
    const lineRate = this.lineEvents.get(instance)!.length
    this.counters.wsGlobalRate = globalRate
    this.counters.wsLineRates = { ...this.counters.wsLineRates, [instance]: lineRate }

    if (globalRate > GLOBAL_CAP || lineRate > LINE_CAP) {
      this.counters.wsOverCapEvents += 1
      if (this.counters.wsOverCapEvents <= 5) {
        console.debug(`[perf] ws rate over budget: global ${globalRate}/s, ${instance} ${lineRate}/s`)
      }
    }
    window.__soupPerf = this.counters
  }
}

export const wsMeter = new WsMeter()

/* ── Long-task observer (19-§2: > 50ms, sampled 1%) ── */

export function startLongtaskObserver(sampleRate = 0.01): () => void {
  if (typeof PerformanceObserver === 'undefined') return () => {}
  const counters: PerfCounters = window.__soupPerf ?? {
    wsGlobalRate: 0,
    wsLineRates: {},
    wsOverCapEvents: 0,
    longtasks: 0,
  }
  let observer: PerformanceObserver | null = null
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (Math.random() > sampleRate) continue
        counters.longtasks += 1
        console.debug(`[perf] longtask ${Math.round(entry.duration)}ms`)
      }
      window.__soupPerf = counters
    })
    observer.observe({ type: 'longtask', buffered: true })
  } catch {
    // longtask unsupported in this engine — the meter simply stays absent
    return () => {}
  }
  return () => observer?.disconnect()
}

/* ── React Profiler callback (19-§2: per-surface render profiler, dev) ── */

export function surfaceProfilerCallback(
  id: string,
  phase: 'mount' | 'update' | 'nested',
  actualDuration: number,
): void {
  if (!import.meta.env.DEV) return
  console.debug(`[perf] render ${id} ${phase}: ${actualDuration.toFixed(1)}ms`)
}
