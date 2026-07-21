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
import { jsonResponse, readBody, requireInstance } from '../../lib/http.ts';
import { proxyToInstance } from '../http-proxy.ts';
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
    jsonResponse(res, 400, { error: `invalid decision body: ${(err as Error).message}` });
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
    jsonResponse(res, 502, {
      error: `line ${instance.name} is offline or unreachable — decision NOT delivered; retry when the line is up`,
      instance: instance.name,
    });
    return;
  }
  if (proxy.status === 409) {
    // Already resolved elsewhere (WhatsApp vote or another console) — relay
    // the instance's verdict verbatim; the operator must see the race.
    jsonResponse(res, 409, JSON.parse(proxy.body) as Record<string, unknown>);
    return;
  }
  if (proxy.status >= 400) {
    jsonResponse(res, proxy.status, JSON.parse(proxy.body) as Record<string, unknown>);
    return;
  }
  jsonResponse(res, 202, { status: 'decision_delivered', instance: instance.name, mapKey: decision.mapKey });
}
