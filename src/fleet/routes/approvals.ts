/**
 * Approvals routes (D-4 build):
 *  GET  /api/lines/:name/approvals          — the pending decision queue
 *  POST /api/lines/:name/approvals/decision — deliver a console decision
 *
 * Design: docs/proposals/2026-07-19-approval-queue.md (D1 v1 scope:
 * AskUserQuestion pending polls; D2(a) live instance proxy with an
 * offline-honest 502; the offline durable fallback is a named v1.1 follow).
 *
 * Safety contract (handoff §6): the fleet NEVER writes the pending_polls
 * row itself — a decision is DELIVERED to the owning runtime through its
 * health server (proxyToInstance), which resolves it through the same
 * poll-resolution path a WhatsApp vote takes (UX-20 parity). Failure
 * honesty: 400 malformed, 404 unknown line/checkpoint, 409 already
 * resolved elsewhere (relayed verbatim), 502 instance unreachable —
 * the operator always knows whether the decision landed.
 *
 * Deliberately narrow imports (http + http-proxy + type-only
 * discovery/db-reader) so this handler's module graph stays off the
 * config/agent-config-validator chain — keeping its tests runnable in
 * minimal environments.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { jsonResponse, readBody, requireInstance } from '../../lib/http.ts';
import { SQLITE_BUSY_TIMEOUT_PRAGMA } from '../../lib/sqlite-constants.ts';
import { proxyToInstance } from '../http-proxy.ts';
import { validationError } from '../response-error-projection.ts';
import type { FleetDiscovery } from '../discovery.ts';
import type { FleetDbReader } from '../db-reader.ts';

export interface ApprovalsDeps {
  discovery: FleetDiscovery;
  dbReader: FleetDbReader;
}

export async function handleGetApprovals(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: ApprovalsDeps,
  params: { name: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  const result = deps.dbReader.getPendingPolls(instance.name, instance.dbPath);
  const observedAt = new Date().toISOString();
  if (!result.ok) {
    jsonResponse(res, 200, { observedAt, readError: true });
    return;
  }
  jsonResponse(res, 200, {
    observedAt,
    supported: result.data.supported,
    approvals: result.data.pending,
    parseErrors: result.data.parseErrors,
  });
}

interface DecisionBody {
  mapKey: string;
  questionIndex: number;
  selectedOptions: string[];
}

export async function handlePostApprovalDecision(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApprovalsDeps,
  params: { name: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  let decision: DecisionBody;
  try {
    const parsed: unknown = JSON.parse(await readBody(req));
    const p = parsed as Partial<DecisionBody>;
    if (typeof p.mapKey !== 'string' || p.mapKey.length === 0) throw new Error('mapKey');
    if (typeof p.questionIndex !== 'number' || p.questionIndex < 0) throw new Error('questionIndex');
    if (!Array.isArray(p.selectedOptions) || p.selectedOptions.length === 0
        || !p.selectedOptions.every((o) => typeof o === 'string' && o.length > 0)) {
      throw new Error('selectedOptions');
    }
    decision = p as DecisionBody;
  } catch (err) {
    jsonResponse(res, 400, validationError('Invalid decision body.', 'decision_process'));
    return;
  }

  const proxy = await proxyToInstance(
    instance.healthPort,
    '/poll-decision',
    'POST',
    JSON.stringify(decision),
    instance.healthToken,
  );

  if (proxy.status === 502) {
    // v1.1 offline durable fallback (design D2(b)): queue the decision in the
    // instance's own DB for boot-time consumption. A 502 proves the health
    // endpoint is unreachable, not that the process has stopped writing its DB,
    // so the connection waits through transient lock contention before writing.
    // Boot rehydrate consumes the row through the same poll-resolution path. If
    // the write itself fails we fall back to the honest 502 (never fake-queue).
    try {
      const db = new DatabaseSync(instance.dbPath);
      try {
        db.prepare(SQLITE_BUSY_TIMEOUT_PRAGMA).run();
        db.exec(`
          CREATE TABLE IF NOT EXISTS pending_poll_decisions (
            map_key TEXT NOT NULL,
            question_index INTEGER NOT NULL,
            selected_options TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            via TEXT NOT NULL,
            PRIMARY KEY (map_key, question_index)
          );
        `);
        db.prepare(`
          INSERT OR REPLACE INTO pending_poll_decisions
            (map_key, question_index, selected_options, via)
          VALUES (?, ?, ?, ?)
        `).run(decision.mapKey, decision.questionIndex, JSON.stringify(decision.selectedOptions), 'console');
      } finally {
        db.close();
      }
      jsonResponse(res, 202, {
        status: 'decision_queued',
        instance: instance.name,
        mapKey: decision.mapKey,
        notice: `line ${instance.name} is unreachable — decision queued durably and consumed at the line's next boot; if the line is actually up, retry instead`,
      });
      return;
    } catch {
      jsonResponse(res, 502, {
        error: `line ${instance.name} is offline or unreachable — decision NOT delivered (durable queue write also failed); retry when the line is up`,
        instance: instance.name,
      });
      return;
    }
  }
  if (proxy.status === 409) {
    // Already resolved elsewhere (WhatsApp vote or another console) — relay
    // the instance's verdict verbatim; the operator must see the race.
    try {
      jsonResponse(res, 409, JSON.parse(proxy.body) as Record<string, unknown>);
    } catch {
      jsonResponse(res, 409, {
        error: 'decision already resolved elsewhere (instance returned unparseable response)',
        instance: instance.name,
        mapKey: decision.mapKey,
      });
    }
    return;
  }
  if (proxy.status >= 400) {
    try {
      jsonResponse(res, proxy.status, JSON.parse(proxy.body) as Record<string, unknown>);
    } catch {
      jsonResponse(res, proxy.status, {
        error: `instance returned an unparseable error response (status ${proxy.status})`,
        instance: instance.name,
        mapKey: decision.mapKey,
      });
    }
    return;
  }
  jsonResponse(res, 202, { status: 'decision_delivered', instance: instance.name, mapKey: decision.mapKey });
}
