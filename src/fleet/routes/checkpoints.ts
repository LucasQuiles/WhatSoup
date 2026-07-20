/**
 * GET /api/lines/:name/checkpoints — read-only feed for the console
 * checkpoint browser tab (spec:
 * oc-re/specs/2026-07-19-checkpoint-browser-ui-spec.md).
 *
 * Deliberately narrow imports (http + type-only discovery/db-reader) so this
 * handler's module graph stays off the config/agent-config-validator chain —
 * keeping its tests runnable in minimal environments.
 *
 * Fail-closed rendering contract (PDR-3): a DB read failure returns 200 with
 * an empty list PLUS `readError: true` so the console shows "unavailable" —
 * never a fake empty state.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonResponse, requireInstance } from '../../lib/http.ts';
import type { FleetDiscovery } from '../discovery.ts';
import type { FleetDbReader } from '../db-reader.ts';

export interface CheckpointsDeps {
  discovery: FleetDiscovery;
  dbReader: FleetDbReader;
}

export async function handleGetLineCheckpoints(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: CheckpointsDeps,
  params: { name: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  const result = deps.dbReader.getCheckpoints(instance.name, instance.dbPath);
  const observedAt = new Date().toISOString();
  if (!result.ok) {
    jsonResponse(res, 200, { observedAt, checkpoints: [], readError: true });
    return;
  }
  jsonResponse(res, 200, { observedAt, checkpoints: result.data });
}
