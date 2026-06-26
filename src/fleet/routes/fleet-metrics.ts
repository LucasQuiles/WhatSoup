import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonResponse, parseQueryString } from '../../lib/http.ts';
import { VALID_METRICS_RANGES as VALID_RANGES } from '../constants.ts';
import { createChildLogger } from '../../logger.ts';
import type { FleetDiscovery } from '../discovery.ts';
import type { FleetDbReader } from '../db-reader.ts';

const log = createChildLogger('fleet-metrics');

export interface FleetMetricsDeps {
  discovery: FleetDiscovery;
  dbReader: FleetDbReader;
}

/**
 * GET /api/metrics?range=24h|7d|30d
 *
 * Aggregate metrics across ALL instances into combined time series.
 * Returns messageVolume, tokenUsage, sessionActivity, and meta.
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
  const msgMap = new Map<string, { inbound: number; outbound: number; media: number }>();
  const tokMap = new Map<string, { input: number; output: number }>();
  const sesMap = new Map<string, { active: number; started: number }>();
  const provTokMap = new Map<string, Map<string, { input: number; output: number }>>();
  const provSesMap = new Map<string, Map<string, { active: number; started: number }>>();
  const allProviders = new Set<string>();

  let instancesQueried = 0;
  let instancesFailed = 0;
  let hasMessageData = false;
  let hasTokenData = false;
  let hasSessionData = false;

  for (const [, instance] of instances) {
    instancesQueried++;
    const result = deps.dbReader.getMetrics(instance.name, instance.dbPath, { range });
    if (!result.ok) {
      instancesFailed++;
      log.warn({ instance: instance.name, error: result.error }, 'fleet.metrics.instance_skip');
      continue;
    }

    if (result.data.hasMessageData) hasMessageData = true;
    if (result.data.hasTokenData) hasTokenData = true;
    if (result.data.hasSessionData) hasSessionData = true;

    for (const bucket of result.data.messageVolume) {
      const existing = msgMap.get(bucket.bucket) ?? { inbound: 0, outbound: 0, media: 0 };
      existing.inbound += bucket.inbound;
      existing.outbound += bucket.outbound;
      existing.media += bucket.media;
      msgMap.set(bucket.bucket, existing);
    }

    for (const bucket of result.data.tokenUsage) {
      const existing = tokMap.get(bucket.bucket) ?? { input: 0, output: 0 };
      existing.input += bucket.input;
      existing.output += bucket.output;
      tokMap.set(bucket.bucket, existing);
    }

    for (const bucket of result.data.sessionActivity) {
      const existing = sesMap.get(bucket.bucket) ?? { active: 0, started: 0 };
      existing.active += bucket.active;
      existing.started += bucket.started;
      sesMap.set(bucket.bucket, existing);
    }

    for (const provider of (result.data.providers ?? [])) {
      allProviders.add(provider);
    }

    for (const [provider, buckets] of Object.entries(result.data.tokenUsageByProvider ?? {})) {
      if (!provTokMap.has(provider)) provTokMap.set(provider, new Map());
      const pMap = provTokMap.get(provider)!;
      for (const bucket of buckets as { bucket: string; input: number; output: number }[]) {
        const existing = pMap.get(bucket.bucket) ?? { input: 0, output: 0 };
        existing.input += bucket.input;
        existing.output += bucket.output;
        pMap.set(bucket.bucket, existing);
      }
    }

    for (const [provider, buckets] of Object.entries(result.data.sessionActivityByProvider ?? {})) {
      if (!provSesMap.has(provider)) provSesMap.set(provider, new Map());
      const pMap = provSesMap.get(provider)!;
      for (const bucket of buckets as { bucket: string; active: number; started: number }[]) {
        const existing = pMap.get(bucket.bucket) ?? { active: 0, started: 0 };
        existing.active += bucket.active;
        existing.started += bucket.started;
        pMap.set(bucket.bucket, existing);
      }
    }
  }

  const sortEntries = <T>(map: Map<string, T>) =>
    Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b, 'en', { sensitivity: 'base' }));

  const messageVolume = sortEntries(msgMap).map(([bucket, v]) => ({ bucket, ...v }));
  const tokenUsage = sortEntries(tokMap).map(([bucket, v]) => ({ bucket, ...v }));
  const sessionActivity = sortEntries(sesMap).map(([bucket, v]) => ({ bucket, ...v }));

  const tokenUsageByProvider: Record<string, { bucket: string; input: number; output: number }[]> = {};
  for (const [provider, pMap] of provTokMap) {
    tokenUsageByProvider[provider] = sortEntries(pMap).map(([bucket, v]) => ({ bucket, ...v }));
  }

  const sessionActivityByProvider: Record<string, { bucket: string; active: number; started: number }[]> = {};
  for (const [provider, pMap] of provSesMap) {
    sessionActivityByProvider[provider] = sortEntries(pMap).map(([bucket, v]) => ({ bucket, ...v }));
  }

  jsonResponse(res, 200, {
    range,
    meta: { instancesQueried, instancesFailed, hasMessageData, hasTokenData, hasSessionData, providers: Array.from(allProviders).sort() },
    messageVolume,
    tokenUsage,
    sessionActivity,
    tokenUsageByProvider,
    sessionActivityByProvider,
  });
}
