import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, jsonResponse } from '../../lib/http.ts';
import { listActiveSilences, addSilence, removeSilence } from '../silence-manager.ts';

/** GET /api/fleet/silences — list active silences */
export async function handleGetSilences(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const silences = listActiveSilences();
  jsonResponse(res, 200, { silences });
}

/** POST /api/fleet/silence — add a silence */
export async function handleAddSilence(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (err) {
    jsonResponse(res, 400, { error: (err as Error).message });
    return;
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    jsonResponse(res, 400, { error: 'invalid JSON' });
    return;
  }

  const instance = data['instance'];
  const duration_minutes = data['duration_minutes'];
  const reason = data['reason'];

  if (typeof instance !== 'string' || !instance) {
    jsonResponse(res, 400, { error: 'instance is required' });
    return;
  }
  if (typeof duration_minutes !== 'number' || duration_minutes <= 0) {
    jsonResponse(res, 400, { error: 'duration_minutes must be a positive number' });
    return;
  }

  const rule = addSilence(
    instance,
    duration_minutes,
    typeof reason === 'string' ? reason : 'manual silence',
    'fleet-api',
  );
  jsonResponse(res, 200, { ok: true, rule });
}

/** DELETE /api/fleet/silence/:instance — remove a silence */
export async function handleRemoveSilence(
  _req: IncomingMessage,
  res: ServerResponse,
  params: { instance: string },
): Promise<void> {
  const removed = removeSilence(params.instance);
  if (!removed) {
    jsonResponse(res, 404, { error: 'no silence found for instance' });
    return;
  }
  jsonResponse(res, 200, { ok: true });
}
