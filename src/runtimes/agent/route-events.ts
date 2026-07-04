import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Fail-closed route-event + delegation-receipt sidecar (slice 4 — full
 * taxonomy per the grounding appendix §10/§5; the minimal shape landed in
 * slice 2).
 *
 * Contract: append-only per-instance NDJSON inside the trusted per-instance
 * boundary (same boundary as bot.db). Events carry route METADATA only —
 * never message bodies and never sender identities (conversationKey is the
 * runtime's internal chat identity; senders are never recorded, so sender
 * scope is pseudonymous by construction). An invalid event is NOT written
 * (UH-018) and emit failure degrades to a warning — neither ever blocks or
 * delays a turn. Retention is size-bounded (B1 seam 8): each sink rotates to
 * a single `.1` generation once it exceeds the byte cap. Events are RECORDS,
 * never triggers: consumers must not treat a line as an authorization.
 */

export type RouteEventType =
  | 'runtime_selected'
  | 'runtime_switched'
  | 'model_preference_set'
  | 'model_preference_cleared'
  | 'auto_fallback_started'
  | 'auto_fallback_cleared'
  | 'user_pin_unreachable'
  | 'delegation_started'
  | 'delegation_finished'
  | 'approval_required';

export type RouteChatScope = 'dm' | 'group' | 'instance';

export interface ModelRouteEvent {
  ts: number;
  event: RouteEventType;
  instance: string;
  /** Runtime-internal chat identity; null for instance-scoped events
   *  (fallback windows are instance-global, B1 seam 2). */
  conversationKey: string | null;
  chatScope: RouteChatScope;
  provider: string;
  modelRef: string | null;
  source: 'default' | 'user' | 'auto_fallback' | 'operator';
  /** Route events RECORD reasoning-route decisions; they never carry or
   *  grant authority (capability-preserved routing). */
  authority: 'advisory_only';
  /** Whether a user-visible notice accompanied this decision. */
  userVisible: boolean;
  reasonCode: string;
}

const EVENT_TYPES: ReadonlySet<string> = new Set([
  'runtime_selected',
  'runtime_switched',
  'model_preference_set',
  'model_preference_cleared',
  'auto_fallback_started',
  'auto_fallback_cleared',
  'user_pin_unreachable',
  'delegation_started',
  'delegation_finished',
  'approval_required',
]);
const SOURCES: ReadonlySet<string> = new Set(['default', 'user', 'auto_fallback', 'operator']);

/** Size-bounded retention: rotate the sink past this many bytes. */
export const ROUTE_EVENTS_MAX_BYTES = 5 * 1024 * 1024;

export function deriveChatScope(conversationKey: string | null): RouteChatScope {
  if (conversationKey === null) return 'instance';
  return conversationKey.endsWith('@g.us') ? 'group' : 'dm';
}

function routeEventProblem(ev: ModelRouteEvent): string | null {
  if (!EVENT_TYPES.has(ev.event)) return `unknown event type: ${String(ev.event).slice(0, 40)}`;
  if (!SOURCES.has(ev.source)) return `unknown source: ${String(ev.source).slice(0, 40)}`;
  if (typeof ev.instance !== 'string' || ev.instance.length === 0) return 'empty instance';
  if (typeof ev.provider !== 'string' || ev.provider.length === 0) return 'empty provider';
  if (typeof ev.reasonCode !== 'string' || ev.reasonCode.length === 0) return 'empty reasonCode';
  if (ev.authority !== 'advisory_only') return 'route events are advisory_only records';
  return null;
}

/** Rotate-then-append; any filesystem failure degrades to `warn`. */
function appendBounded(
  dir: string,
  file: string,
  line: string,
  warn: (msg: string) => void,
  maxBytes: number,
): void {
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, file);
    try {
      if (statSync(path).size > maxBytes) renameSync(path, `${path}.1`);
    } catch {
      // No sink file yet — nothing to rotate.
    }
    appendFileSync(path, line);
  } catch (err) {
    // Fail-closed for the TURN, not the evidence: a broken sink loses one
    // line, never a user reply.
    warn(`route-event emit failed: ${String(err)}`);
  }
}

export function emitRouteEvent(
  dir: string,
  ev: ModelRouteEvent,
  warn: (msg: string) => void,
  maxBytes: number = ROUTE_EVENTS_MAX_BYTES,
): void {
  const problem = routeEventProblem(ev);
  if (problem) {
    warn(`route-event rejected (${problem}) - not written (UH-018)`);
    return;
  }
  appendBounded(dir, 'route-events.ndjson', JSON.stringify(ev) + '\n', warn, maxBytes);
}

export type DelegationReason =
  | 'runtime-safety-review'
  | 'complex-research'
  | 'code-review'
  | 'user-requested-review';

const DELEGATION_REASONS: ReadonlySet<string> = new Set([
  'runtime-safety-review',
  'complex-research',
  'code-review',
  'user-requested-review',
]);

/**
 * Receipt for a delegated (reviewer/worker) pass — makes delegation visible,
 * never magical (B2 §5). Workers are advisory only; a receipt is a record of
 * what advised, not an authorization of anything.
 */
export interface DelegationReceipt {
  ts: number;
  instance: string;
  conversationKey: string | null;
  delegationUsed: true;
  reason: DelegationReason;
  workers: string[];
  modelsOrHarnesses: string[];
  authority: 'advisory_only';
  /** Never claim without evidence (UH-017): callers set true only after the
   *  lead actually verified the worker output. */
  leadVerified: boolean;
  /** The `/why`-renderable summary; a receipt without one is observability-
   *  incomplete and is rejected at emit. */
  userVisibleSummary: string;
}

function receiptProblem(r: DelegationReceipt): string | null {
  if (!DELEGATION_REASONS.has(r.reason)) return `unknown reason: ${String(r.reason).slice(0, 40)}`;
  if (!Array.isArray(r.workers) || r.workers.length === 0) return 'empty workers';
  if (typeof r.instance !== 'string' || r.instance.length === 0) return 'empty instance';
  if (r.authority !== 'advisory_only') return 'delegation is advisory_only';
  if (typeof r.userVisibleSummary !== 'string' || r.userVisibleSummary.trim().length === 0) {
    return 'missing userVisibleSummary (observability-incomplete, UH-017)';
  }
  return null;
}

export function emitDelegationReceipt(
  dir: string,
  receipt: DelegationReceipt,
  warn: (msg: string) => void,
  maxBytes: number = ROUTE_EVENTS_MAX_BYTES,
): void {
  const problem = receiptProblem(receipt);
  if (problem) {
    warn(`delegation-receipt rejected (${problem}) - not written (UH-018)`);
    return;
  }
  appendBounded(dir, 'delegation-receipts.ndjson', JSON.stringify(receipt) + '\n', warn, maxBytes);
}
