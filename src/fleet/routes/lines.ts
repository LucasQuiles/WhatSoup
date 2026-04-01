import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonResponse } from '../../lib/http.ts';
import type { FleetDiscovery } from '../discovery.ts';
import type { HealthPoller } from '../health-poller.ts';
import type { FleetDbReader } from '../db-reader.ts';

export interface LinesDeps {
  discovery: FleetDiscovery;
  healthPoller: HealthPoller;
  dbReader: FleetDbReader;
}

/** GET /api/lines — list all instances with their poller status. */
export function handleGetLines(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: LinesDeps,
): void {
  const instances = deps.discovery.getInstances();
  const statuses = deps.healthPoller.getStatuses();

  const lines = Array.from(instances.values()).map((inst) => {
    const poll = statuses.get(inst.name);
    return {
      name: inst.name,
      type: inst.type,
      accessMode: inst.accessMode,
      healthPort: inst.healthPort,
      socketPath: inst.socketPath,
      status: poll?.status ?? 'unknown',
      lastPollAt: poll?.lastPollAt ?? null,
      error: poll?.error ?? null,
    };
  });

  jsonResponse(res, 200, lines);
}

/** GET /api/lines/:name — detailed view of a single instance. */
export async function handleGetLine(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: LinesDeps,
  params: { name: string },
): Promise<void> {
  const instance = deps.discovery.getInstance(params.name);
  if (!instance) {
    jsonResponse(res, 404, { error: `instance '${params.name}' not found` });
    return;
  }

  const poll = deps.healthPoller.getStatus(params.name);
  const dbStats = deps.dbReader.getSummaryStats(instance.name, instance.dbPath);

  jsonResponse(res, 200, {
    name: instance.name,
    type: instance.type,
    accessMode: instance.accessMode,
    healthPort: instance.healthPort,
    dbPath: instance.dbPath,
    stateRoot: instance.stateRoot,
    logDir: instance.logDir,
    configPath: instance.configPath,
    socketPath: instance.socketPath,
    gui: instance.gui,
    guiPort: instance.guiPort,
    status: poll?.status ?? 'unknown',
    health: poll?.health ?? null,
    dbStats: dbStats.ok ? dbStats.data : null,
  });
}
