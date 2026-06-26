import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonResponse, requireInstance, parseQueryString } from '../../lib/http.ts';
import { VALID_METRICS_RANGES as VALID_RANGES } from '../constants.ts';
import type { FleetDiscovery } from '../discovery.ts';
import type { FleetDbReader } from '../db-reader.ts';

export interface MetricsDeps {
  discovery: FleetDiscovery;
  dbReader: FleetDbReader;
}

/** GET /api/lines/:name/metrics?range=24h|7d|30d — hourly metrics for a line. */
export function handleGetMetrics(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MetricsDeps,
  params: { name: string },
): void {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  const qs = parseQueryString(req.url);
  const range = (qs.range || '24h') as '24h' | '7d' | '30d';
  if (!VALID_RANGES.has(range)) {
    jsonResponse(res, 400, { error: 'range must be one of: 24h, 7d, 30d' });
    return;
  }

  const result = deps.dbReader.getMetrics(instance.name, instance.dbPath, { range });
  if (!result.ok) {
    jsonResponse(res, 500, { error: result.error });
    return;
  }

  jsonResponse(res, 200, { range, ...result.data });
}
