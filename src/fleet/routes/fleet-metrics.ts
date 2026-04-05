import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonResponse, parseQueryString } from '../../lib/http.ts';
import type { FleetDiscovery } from '../discovery.ts';
import type { FleetDbReader } from '../db-reader.ts';

export interface FleetMetricsDeps {
  discovery: FleetDiscovery;
  dbReader: FleetDbReader;
}

const VALID_RANGES = new Set(['24h', '7d', '30d']);

/**
 * GET /api/metrics?range=24h|7d|30d
 *
 * Aggregate message volume across ALL instances into a single time series.
 * Returns { range, messageVolume: { bucket, inbound, outbound }[] }
 */
export function handleGetFleetMetrics(
  req: IncomingMessage,
  res: ServerResponse,
  deps: FleetMetricsDeps,
): void {
  const qs = parseQueryString(req.url);
  const range = (qs.range || '24h') as '24h' | '7d' | '30d';
  if (!VALID_RANGES.has(range)) {
    jsonResponse(res, 400, { error: 'range must be one of: 24h, 7d, 30d' });
    return;
  }

  const instances = deps.discovery.getInstances();
  const aggregated = new Map<string, { inbound: number; outbound: number }>();

  for (const [, instance] of instances) {
    const result = deps.dbReader.getMetrics(instance.name, instance.dbPath, { range });
    if (!result.ok) continue;

    for (const bucket of result.data.messageVolume) {
      const existing = aggregated.get(bucket.bucket) ?? { inbound: 0, outbound: 0 };
      existing.inbound += bucket.inbound;
      existing.outbound += bucket.outbound;
      aggregated.set(bucket.bucket, existing);
    }
  }

  const messageVolume = Array.from(aggregated.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, v]) => ({ bucket, inbound: v.inbound, outbound: v.outbound }));

  jsonResponse(res, 200, { range, messageVolume });
}
