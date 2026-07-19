/**
 * GET /api/lines/:name/checkpoints — read-only feed for the console
 * checkpoint browser tab (spec:
 * oc-re/specs/2026-07-19-checkpoint-browser-ui-spec.md).
 *
 * POST /api/lines/:name/checkpoints/restore — restart-mediated restore
 * (D-1; spec: oc-re/specs/2026-07-19-checkpoint-restore-spec.md).
 *
 * Deliberately narrow imports (http + node:sqlite + type-only
 * discovery/db-reader/platform) so this handler's module graph stays off
 * the config/agent-config-validator chain — keeping its tests runnable in
 * minimal environments.
 *
 * Fail-closed rendering contract (PDR-3): a DB read failure returns 200 with
 * an empty list PLUS `readError: true` so the console shows "unavailable" —
 * never a fake empty state.
 *
 * Restore safety contract (the runtime owns resume semantics — never write
 * checkpoint state behind a running instance's back): the write lands only
 * while the instance is DOWN (stop → guarded write → start), and the
 * boot-time resume gate (src/core/durability.ts:501-506) performs the
 * actual resume. A tripped restart-loop guard is NEVER overridden — the
 * row becomes resumable, but proactive resume stays suppressed for that
 * boot and the operator sees the guard's notice.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { jsonResponse, readBody, requireInstance } from '../../lib/http.ts';
import { publishFeedEvent, publishInstanceStatus } from '../realtime-publisher.ts';
import type { FleetDiscovery } from '../discovery.ts';
import type { FleetDbReader } from '../db-reader.ts';
import type { ServiceManager } from '../platform.ts';
import type { FleetRealtimePublisher } from '../realtime-publisher.ts';

export interface CheckpointsDeps {
  discovery: FleetDiscovery;
  dbReader: FleetDbReader;
}

export interface RestoreCheckpointDeps extends CheckpointsDeps {
  serviceManager: ServiceManager;
  realtime: FleetRealtimePublisher;
}

/** Valid instance name pattern — mirrors ops.ts NAME_RE (mutation routes
 *  validate before the name reaches service-manager / path construction). */
const NAME_RE = /^[a-z][a-z0-9-]*$/;

function validateInstanceName(name: string, res: ServerResponse): boolean {
  if (!NAME_RE.test(name) || name.length < 1 || name.length > 30) {
    jsonResponse(res, 400, { error: 'invalid instance name' });
    return false;
  }
  return true;
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

/**
 * Mark a checkpoint resumable and restart the instance so the LIVE runtime
 * resumes it through its own resume gate. Idempotent: an already-resumable
 * row short-circuits without a stop or write. A checkpoint with no session
 * id can never be made resumable (the gate requires one) — 409, we never
 * invent one.
 */
export async function handleRestoreCheckpoint(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RestoreCheckpointDeps,
  params: { name: string },
): Promise<void> {
  if (!validateInstanceName(params.name, res)) return;
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  let conversationKey: string;
  try {
    const parsed: unknown = JSON.parse(await readBody(req));
    const key = (parsed as { conversationKey?: unknown }).conversationKey;
    if (typeof key !== 'string' || key.length === 0) throw new Error('missing conversationKey');
    conversationKey = key;
  } catch {
    jsonResponse(res, 400, { error: 'invalid JSON body — expected {conversationKey}' });
    return;
  }

  const read = deps.dbReader.getCheckpoints(instance.name, instance.dbPath);
  if (!read.ok) {
    jsonResponse(res, 500, { error: `checkpoint read failed: ${read.error}`, instance: instance.name });
    return;
  }
  const row = read.data.find((r) => r.conversationKey === conversationKey);
  if (!row) {
    jsonResponse(res, 404, { error: 'checkpoint not found', instance: instance.name, conversationKey });
    return;
  }
  if (row.resumable) {
    jsonResponse(res, 200, { status: 'already_resumable', instance: instance.name, conversationKey });
    return;
  }
  if (row.sessionId === null) {
    jsonResponse(res, 409, {
      error: 'checkpoint has no session id — cannot be made resumable',
      instance: instance.name,
      conversationKey,
    });
    return;
  }

  // Write-while-down. Stop must succeed BEFORE any mutation; the guarded
  // UPDATE re-asserts the preconditions decisively in SQL (the read above
  // is advisory); start is attempted even when the write fails.
  try {
    await deps.serviceManager.stop(instance.name);
  } catch (err) {
    jsonResponse(res, 500, {
      error: `restore failed at stop: ${(err as Error).message}`,
      instance: instance.name,
      conversationKey,
    });
    return;
  }

  try {
    const db = new DatabaseSync(instance.dbPath);
    try {
      db.prepare(`
        UPDATE session_checkpoints
        SET session_status = 'suspended', updated_at = datetime('now')
        WHERE conversation_key = ?
          AND session_id IS NOT NULL
          AND session_status NOT IN ('active', 'suspended')
      `).run(conversationKey);
    } finally {
      db.close();
    }
  } catch (err) {
    let restartAttempted = false;
    try {
      await deps.serviceManager.start(instance.name);
      restartAttempted = true;
    } catch { /* start failure reported below as part of the same 500 */ }
    jsonResponse(res, 500, {
      error: `restore failed at write: ${(err as Error).message}`,
      instance: instance.name,
      conversationKey,
      restartAttempted,
    });
    return;
  }

  try {
    await deps.serviceManager.start(instance.name);
  } catch (err) {
    jsonResponse(res, 500, {
      error: `restore write landed but start failed — instance is down: ${(err as Error).message}`,
      instance: instance.name,
      conversationKey,
      instanceDown: true,
    });
    return;
  }

  publishInstanceStatus(deps.realtime, instance.name);
  publishFeedEvent(deps.realtime, instance.name);
  jsonResponse(res, 202, { status: 'restore_requested', instance: instance.name, conversationKey });
}
