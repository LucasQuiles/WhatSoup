/**
 * GET /api/lines/:name/rate-limits — windowed per-sender throttle feed for
 * the console RateLimitsCard (D-5; design/implementation lineage:
 * PR #1937).
 *
 * The `rate_limits` table is per-SENDER chat throttling (successful
 * responses), NOT provider quota (correction landed in PR #1937).
 *
 * Limit/window resolution: read from the instance's config.json with the
 * same fallback chain as src/config.ts (rateLimitPerHour ?? 45;
 * rateLimitWindowMs ?? rateLimitNoticeWindowMs ?? 1h). ENV overrides
 * (RATE_LIMIT_PER_HOUR) are fleet-invisible — `limitSource` declares
 * which seam the values came from ('config' when ANY knob came from the
 * file, 'default' otherwise).
 *
 * Fail-closed (PDR-3): a DB read failure returns 200 with `readError:
 * true` and NO count fields — the console shows "unavailable", never a
 * fake-zero calm state.
 *
 * Deliberately narrow imports (http + fs + type-only discovery/db-reader)
 * so this handler's module graph stays off the
 * config/agent-config-validator chain — keeping its tests runnable in
 * minimal environments.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { jsonResponse, requireInstance } from '../../lib/http.ts';
import { MS_PER_HOUR } from '../../lib/time-units.ts';
import type { FleetDiscovery } from '../discovery.ts';
import type { FleetDbReader } from '../db-reader.ts';

export interface RateLimitsDeps {
  discovery: FleetDiscovery;
  dbReader: FleetDbReader;
}

const DEFAULT_RATE_LIMIT_PER_HOUR = 45;
const DEFAULT_RATE_WINDOW_MS = MS_PER_HOUR;

/** Resolve limit + window from the instance config.json, mirroring
 *  src/config.ts's fallback chain. Returns the values plus which seam
 *  supplied them (env overrides are fleet-invisible — see module doc). */
function resolveLimitConfig(configPath: string): { limit: number; windowMs: number; limitSource: 'config' | 'default' } {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    const cfg = (parsed ?? {}) as Record<string, unknown>;
    const limit = typeof cfg.rateLimitPerHour === 'number' ? cfg.rateLimitPerHour : DEFAULT_RATE_LIMIT_PER_HOUR;
    const windowMs = typeof cfg.rateLimitWindowMs === 'number'
      ? cfg.rateLimitWindowMs
      : typeof cfg.rateLimitNoticeWindowMs === 'number'
        ? cfg.rateLimitNoticeWindowMs
        : DEFAULT_RATE_WINDOW_MS;
    const fromConfig = typeof cfg.rateLimitPerHour === 'number'
      || typeof cfg.rateLimitWindowMs === 'number'
      || typeof cfg.rateLimitNoticeWindowMs === 'number';
    return { limit, windowMs, limitSource: fromConfig ? 'config' : 'default' };
  } catch {
    return { limit: DEFAULT_RATE_LIMIT_PER_HOUR, windowMs: DEFAULT_RATE_WINDOW_MS, limitSource: 'default' };
  }
}

export async function handleGetRateLimits(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: RateLimitsDeps,
  params: { name: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  const { limit, windowMs, limitSource } = resolveLimitConfig(instance.configPath);
  const observedAt = new Date().toISOString();

  const result = deps.dbReader.getRateLimits(instance.name, instance.dbPath, { limit, windowMs });
  if (!result.ok) {
    jsonResponse(res, 200, { observedAt, limit, limitSource, windowMs, readError: true });
    return;
  }
  jsonResponse(res, 200, { observedAt, limit, limitSource, windowMs, ...result.data });
}
