/**
 * #3717c context gauge: the context size of the LAST DISTINCT API request of a
 * scope's session generation, measured from that request's own usage
 * (input + cache_creation + cache_read, see the parser's request_usage event).
 *
 * It replaces summed per-turn or cumulative traffic as the auto-compact
 * convergence measure: a turn of seven 76k-context requests sums to 475k but
 * its context is 76k. Billing is NOT read from here (it stays on the result
 * usage and the DB accumulators).
 *
 * Contract:
 * - Distinct requests are keyed by messageId. The CLI repeats one message per
 *   content block with the same id and usage, so a repeat REPLACES that id's
 *   value and never adds. A late repeat of an earlier id A after B updates A's
 *   stored value but does not make A current: the gauge is the last distinct
 *   request (B). A request without an id is its own distinct request.
 * - Missing or invalid usage on the last distinct request -> unknown. There is
 *   no fallback to an earlier request or to the summed result usage.
 * - A turn closes on its result. A turn that produced no request_usage leaves
 *   the gauge unknown (never a stale value from an earlier turn).
 * - compact_boundary seals the scope: the gauge becomes unknown and every
 *   request_usage is ignored until that compact turn's result, so the summarize
 *   request's usage never becomes the post-compact context on either side of
 *   the boundary.
 * - The gauge belongs to one session generation: a different generation or a
 *   new provider session id starts unknown; cleanup/reset drop the scope; a
 *   JID-alias rekey moves it.
 * - Message ids come from the provider, so retention is bounded: an id longer
 *   than MAX_REQUEST_ID_LENGTH, or a distinct id past MAX_REQUEST_IDS_PER_TURN
 *   in one turn, SATURATES the turn. A saturated turn drops its ids, reads
 *   unknown, and ignores every request_usage (late repeats included, which it
 *   can no longer tell from new requests) until its lifecycle boundary: the
 *   turn's result, compact_boundary, a new generation or session id, or
 *   delete/clear. The result closes it unknown.
 */
import type { SessionManager } from './session.ts';

const MAX_REQUEST_ID_LENGTH = 256;
const MAX_REQUEST_IDS_PER_TURN = 1024;

interface ScopeGauge {
  generation: string;
  sessionId: string | undefined;
  sealed: boolean;
  /** True once the current turn has seen a request_usage; false after its result. */
  turnOpen: boolean;
  /** The current turn exceeded an id bound; unknown until the turn's boundary. */
  saturated: boolean;
  /** Context per distinct message id within the current turn. */
  readonly seen: Map<string, number | undefined>;
  /** Id of the last distinct request, or undefined for an id-less request. */
  currentId: string | undefined;
  current: number | undefined;
}

/** #3717c G4: the context gauge belongs to one session generation (its DB row). */
export function contextGeneration(session: SessionManager | null | undefined): string {
  const rowId = session?.getDbRowId() ?? null;
  return rowId === null ? 'none' : `row:${rowId}`;
}

export class ContextGaugeStore {
  private readonly scopes = new Map<string, ScopeGauge>();

  private scope(scopeKey: string, generation: string): ScopeGauge {
    const existing = this.scopes.get(scopeKey);
    if (existing && existing.generation === generation) return existing;
    const fresh: ScopeGauge = {
      generation,
      sessionId: undefined,
      sealed: false,
      turnOpen: false,
      saturated: false,
      seen: new Map(),
      currentId: undefined,
      current: undefined,
    };
    this.scopes.set(scopeKey, fresh);
    return fresh;
  }

  /**
   * A provider init binds the scope to a session id. The same id keeps the gauge;
   * a different id is a new generation of context. The first init after requests
   * that no init bound cannot attribute them to this session, so it drops their
   * context (unknown) but keeps a compact seal and the open turn.
   */
  observeInit(scopeKey: string, generation: string, sessionId: string): void {
    const gauge = this.scope(scopeKey, generation);
    if (gauge.sessionId === sessionId) return;
    if (gauge.sessionId !== undefined) {
      this.scopes.delete(scopeKey);
      this.scope(scopeKey, generation).sessionId = sessionId;
      return;
    }
    gauge.sessionId = sessionId;
    gauge.seen.clear();
    gauge.currentId = undefined;
    gauge.current = undefined;
  }

  observeRequest(
    scopeKey: string,
    generation: string,
    messageId: string | undefined,
    contextTokens: number | undefined,
  ): void {
    const gauge = this.scope(scopeKey, generation);
    if (gauge.sealed || gauge.saturated) return;
    if (!gauge.turnOpen) {
      gauge.turnOpen = true;
      gauge.seen.clear();
      gauge.currentId = undefined;
      gauge.current = undefined;
    }
    if (
      messageId !== undefined
      && (messageId.length > MAX_REQUEST_ID_LENGTH
        || (!gauge.seen.has(messageId) && gauge.seen.size >= MAX_REQUEST_IDS_PER_TURN))
    ) {
      gauge.saturated = true;
      gauge.seen.clear();
      gauge.currentId = undefined;
      gauge.current = undefined;
      return;
    }
    if (messageId !== undefined && gauge.seen.has(messageId)) {
      gauge.seen.set(messageId, contextTokens);
      if (gauge.currentId === messageId) gauge.current = contextTokens;
      return;
    }
    if (messageId !== undefined) gauge.seen.set(messageId, contextTokens);
    gauge.currentId = messageId;
    gauge.current = contextTokens;
  }

  observeResult(scopeKey: string, generation: string): void {
    const gauge = this.scope(scopeKey, generation);
    if (gauge.sealed || gauge.saturated || !gauge.turnOpen) {
      gauge.current = undefined;
      gauge.currentId = undefined;
    }
    gauge.sealed = false;
    gauge.saturated = false;
    gauge.turnOpen = false;
    gauge.seen.clear();
  }

  observeCompactBoundary(scopeKey: string, generation: string): void {
    const gauge = this.scope(scopeKey, generation);
    gauge.sealed = true;
    gauge.saturated = false;
    gauge.turnOpen = false;
    gauge.seen.clear();
    gauge.currentId = undefined;
    gauge.current = undefined;
  }

  /** The known context of the generation's last distinct request, or undefined (unknown). */
  read(scopeKey: string, generation?: string): number | undefined {
    const gauge = this.scopes.get(scopeKey);
    if (!gauge || gauge.sealed) return undefined;
    if (generation !== undefined && gauge.generation !== generation) return undefined;
    return gauge.current;
  }

  delete(scopeKey: string): void {
    this.scopes.delete(scopeKey);
  }

  rekey(oldKey: string, newKey: string): void {
    const gauge = this.scopes.get(oldKey);
    if (gauge === undefined) return;
    this.scopes.delete(oldKey);
    this.scopes.set(newKey, gauge);
  }

  clear(): void {
    this.scopes.clear();
  }
}
