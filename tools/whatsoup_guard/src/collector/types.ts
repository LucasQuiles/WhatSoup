import type { ProbeDoc } from '../types.ts';

export interface Collector {
  readonly id: string;
  run(scopeId: string): Promise<ProbeDoc>;
}

export interface CollectorProbeErrorOptions {
  collectorId: string;
  scopeId: string;
  message: string;
  cause?: unknown;
}

export class CollectorProbeError extends Error {
  readonly kind = 'probe_error';
  readonly collector_id: string;
  readonly scope_id: string;

  constructor(opts: CollectorProbeErrorOptions) {
    const message = `probe_error collector_id=${opts.collectorId} scope_id=${opts.scopeId}: ${opts.message}`;
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'CollectorProbeError';
    this.collector_id = opts.collectorId;
    this.scope_id = opts.scopeId;
  }
}
