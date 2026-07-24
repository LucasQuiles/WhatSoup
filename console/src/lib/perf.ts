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

/** The ONE shared counters object — every meter mutates it in place (the
 *  window.__soupPerf pointer is never reassigned, so meters can't discard
 *  each other's state; cross-review F1). */
const counters: PerfCounters = { wsGlobalRate: 0, wsLineRates: {}, wsOverCapEvents: 0, longtasks: 0 }
window.__soupPerf = counters

/* ── WS throughput meter ── */

const LINE_CAP = 10 // 19-§1: per-line cap 10/s
const GLOBAL_CAP = 200 // 19-§1: global cap 200/s
const WINDOW_MS = 1000

class WsMeter {
  private lineEvents = new Map<string, number[]>()
  private globalEvents: number[] = []

  record(instance: string, now = Date.now()): void {
    const cutoff = now - WINDOW_MS
    this.globalEvents.push(now)
    this.globalEvents = this.globalEvents.filter((t) => t > cutoff)
    const line = this.lineEvents.get(instance) ?? []
    line.push(now)
    this.lineEvents.set(instance, line.filter((t) => t > cutoff))

    const globalRate = this.globalEvents.length
    const lineRate = this.lineEvents.get(instance)!.length
    counters.wsGlobalRate = globalRate
    counters.wsLineRates[instance] = lineRate

    if (globalRate > GLOBAL_CAP || lineRate > LINE_CAP) {
      counters.wsOverCapEvents += 1
      if (counters.wsOverCapEvents <= 5) {
        console.debug(`[perf] ws rate over budget: global ${globalRate}/s, ${instance} ${lineRate}/s`)
      }
    }
  }

  /** Test seam: drop all accumulated window state (the shared object identity
   *  survives; the window pointer is re-asserted defensively). */
  reset(): void {
    this.lineEvents.clear()
    this.globalEvents = []
    counters.wsGlobalRate = 0
    counters.wsLineRates = {}
    counters.wsOverCapEvents = 0
    window.__soupPerf = counters
  }
}

export const wsMeter = new WsMeter()

/* ── Long-task observer (19-§2: > 50ms, sampled 1%) ── */

export function startLongtaskObserver(sampleRate = 0.01): () => void {
  if (typeof PerformanceObserver === 'undefined') return () => {}
  let observer: PerformanceObserver | null = null
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (Math.random() > sampleRate) continue
        counters.longtasks += 1
        console.debug(`[perf] longtask ${Math.round(entry.duration)}ms`)
      }
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
  phase: 'mount' | 'update' | 'nested-update',
  actualDuration: number,
): void {
  if (!import.meta.env.DEV) return
  console.debug(`[perf] render ${id} ${phase}: ${actualDuration.toFixed(1)}ms`)
}
