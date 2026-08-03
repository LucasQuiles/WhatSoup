/**
 * Clock abstraction — the SSOT for time access in src/.
 *
 * Functions that read the wall clock are not pure: their output depends on an
 * ambient input (the system clock) that no signature declares. This module
 * establishes a process-wide clock interface so tests can override time
 * atomically via FakeClock, rather than wiring vi.useFakeTimers() through
 * every call site.
 *
 * Convention:
 *   - Production code reads time via `systemClock` (or a Clock injected at
 *     construction). Never call `Date.now()` / `new Date()` directly in src/.
 *   - Tests inject `fakeClock(initialMs)` and call `.advance(deltaMs)` /
 *     `.set(epochMs)` to control time deterministically.
 *
 * Migration status: this module is the foundation. Call sites are migrated
 * incrementally; the ratchet at tests/scripts/clock-budget.test.ts locks the
 * raw Date.now() count at its pre-migration baseline (365) and prevents
 * regression as slices land.
 *
 * See #2200 for the full migration plan.
 */

export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
  /** ISO 8601 UTC string. */
  nowIso(): string;
  /** Epoch seconds (integer, floored). */
  nowUnixSec(): number;
}

class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
  nowIso(): string {
    return new Date().toISOString();
  }
  nowUnixSec(): number {
    return Math.floor(Date.now() / 1000);
  }
}

class FakeClock implements Clock {
  private current: number;

  constructor(current = 0) {
    this.current = current;
  }

  now(): number {
    return this.current;
  }
  nowIso(): string {
    return new Date(this.current).toISOString();
  }
  nowUnixSec(): number {
    return Math.floor(this.current / 1000);
  }

  /** Advance the fake clock by deltaMs milliseconds. */
  advance(deltaMs: number): void {
    this.current += deltaMs;
  }

  /** Set the fake clock to an absolute epoch-ms value. */
  set(epochMs: number): void {
    this.current = epochMs;
  }
}

/** The singleton system clock. Production code reads time through this. */
export const systemClock: Clock = new SystemClock();

/**
 * Factory for a fake clock, for use in tests.
 * @param initial - starting epoch-ms (default 0)
 */
export const fakeClock = (initial = 0): FakeClock => new FakeClock(initial);
