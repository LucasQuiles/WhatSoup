import type { Logger } from 'pino';

type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Simple in-memory circuit breaker.
 *
 * - **closed** — requests flow normally; failures are counted.
 * - **open** — requests are rejected; after `resetMs` the breaker transitions to half-open.
 * - **half-open** — one probe request is allowed; success closes, failure re-opens.
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private lastFailureAt = 0;

  readonly name: string;
  readonly threshold: number;
  readonly resetMs: number;
  private readonly logger: Logger | undefined;

  constructor(name: string, threshold: number = 3, resetMs: number = 30_000, logger?: Logger) {
    this.name = name;
    this.threshold = threshold;
    this.resetMs = resetMs;
    this.logger = logger;
  }

  /** Returns true when the breaker is open and calls should be skipped. */
  isOpen(): boolean {
    if (this.state === 'closed') return false;

    if (this.state === 'open' && Date.now() - this.lastFailureAt >= this.resetMs) {
      this.transition('half-open');
      return false; // allow one probe
    }

    return this.state === 'open';
  }

  /** Record a successful call — resets the breaker to closed. */
  recordSuccess(): void {
    if (this.state !== 'closed') {
      this.transition('closed');
    }
    this.failures = 0;
  }

  /** Record a failed call — increments the counter and trips to open at threshold. */
  recordFailure(): void {
    this.failures += 1;
    this.lastFailureAt = Date.now();

    if (this.failures >= this.threshold && this.state !== 'open') {
      this.transition('open');
    }
  }

  private transition(next: CircuitState): void {
    const prev = this.state;
    this.state = next;
    this.logger?.info(
      { name: this.name, old: prev, new: next, failures: this.failures },
      'circuit_breaker_state_change',
    );
  }
}
