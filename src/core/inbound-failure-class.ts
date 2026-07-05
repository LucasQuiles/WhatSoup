/**
 * Bounded, content-free failure taxonomy for inbound_events.
 *
 * inbound_events.terminal_reason stays exactly 'error' for every failed row (an
 * external matcher contract), so failures are un-triageable in aggregate. This
 * module supplies a small, closed vocabulary that the durability layer stamps
 * onto the separate failure_class column, letting the telemetry miner split the
 * ~2,239 collapsed 'error' rows by driver WITHOUT recording any message content.
 *
 * The vocabulary is intentionally bounded: coerceInboundFailureClass maps any
 * out-of-vocabulary or absent value to 'unknown', and classifyErrorForInbound
 * only ever returns a member of the set. There is deliberately NO schema CHECK
 * constraint — this code is the single gate, so the taxonomy can evolve without
 * a migration.
 */

export type InboundFailureClass =
  | 'provider_failure'
  | 'transport_send_failed'
  | 'transport_disconnected'
  | 'timeout'
  | 'db_error'
  | 'session_crash'
  | 'session_spawn_failed'
  | 'crash_recovery'
  | 'stale_reclaim'
  | 'unknown';

export const INBOUND_FAILURE_CLASSES: ReadonlySet<string> = new Set<string>([
  'provider_failure',
  'transport_send_failed',
  'transport_disconnected',
  'timeout',
  'db_error',
  'session_crash',
  'session_spawn_failed',
  'crash_recovery',
  'stale_reclaim',
  'unknown',
]);

/**
 * Map a caller-supplied value onto the bounded vocabulary. Any absent or
 * out-of-vocabulary value collapses to 'unknown' so a stray string can never
 * reach the column.
 */
export function coerceInboundFailureClass(value: string | undefined): InboundFailureClass {
  return value !== undefined && INBOUND_FAILURE_CLASSES.has(value)
    ? (value as InboundFailureClass)
    : 'unknown';
}

// Unrecoverable-SQLite family — copied (not imported) from the inline-extractor
// detection in src/runtimes/agent/runtime.ts so the two stay independent.
const UNRECOVERABLE_SQLITE = /SQLITE_(FULL|READONLY|CORRUPT|IOERR|CANTOPEN|NOTADB)/i;
// Transport-disconnect family — the ECONNRESET/EPIPE/ENOTCONN/"socket hang up"
// subset of the transport regex in src/mcp/registry.ts. ETIMEDOUT is handled
// separately below as 'timeout' rather than a disconnect.
const TRANSPORT_DISCONNECT = /ECONNRESET|EPIPE|ENOTCONN|socket hang up/i;

function errText(err: unknown): { message: string; code: string; name: string } {
  if (typeof err === 'string') return { message: err, code: '', name: '' };
  if (err !== null && typeof err === 'object') {
    const rec = err as { message?: unknown; code?: unknown; name?: unknown };
    return {
      message: typeof rec.message === 'string' ? rec.message : '',
      code: typeof rec.code === 'string' ? rec.code : '',
      name: typeof rec.name === 'string' ? rec.name : '',
    };
  }
  return { message: '', code: '', name: '' };
}

/**
 * Best-effort classification of a thrown value into the bounded vocabulary.
 * Order is specificity-first: a DB error that also mentions a socket must land
 * as 'db_error'. Anything unmatched is 'unknown' — never a raw string.
 */
export function classifyErrorForInbound(err: unknown): InboundFailureClass {
  const { message, code, name } = errText(err);

  if (UNRECOVERABLE_SQLITE.test(message) || UNRECOVERABLE_SQLITE.test(code)) {
    return 'db_error';
  }
  if (code === 'ETIMEDOUT' || /ETIMEDOUT/.test(message) || name === 'AbortError') {
    return 'timeout';
  }
  if (TRANSPORT_DISCONNECT.test(message) || TRANSPORT_DISCONNECT.test(code)) {
    return 'transport_disconnected';
  }
  return 'unknown';
}
