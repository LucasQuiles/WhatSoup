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
  // Admission-rejection subclasses (#1750). A turn admitted-then-rejected is
  // NOT one bucket: benign backpressure (queue_full / queue_closed) must be
  // separable from fault conditions (queue_halted / pre_dispatch_error /
  // scope_blocked_recovery) so alerting can page on deadlocks without
  // false-positiving on capacity sheds. The names mirror AdmissionRejectClass.
  | 'queue_full'
  | 'queue_halted'
  | 'queue_closed'
  | 'pre_dispatch_error'
  | 'scope_blocked_recovery'
  // Recovery-owner reclaim (#1749): a terminally non-echoed recovery-owned
  // inbound released by the stuck-inbound sweep (bucket 4).
  | 'recovery_owner_reclaimed'
  // Turn-processor exception (e.g. a queued turn dispatched into a session
  // torn down by a system-request quarantine). Previously collapsed into
  // 'unknown', which hid the reply-guarantee-breach driver from mining.
  | 'processor_throw'
  | 'unknown';

const INBOUND_FAILURE_CLASS_PRESENCE: Readonly<Record<InboundFailureClass, true>> = {
  provider_failure: true,
  transport_send_failed: true,
  transport_disconnected: true,
  timeout: true,
  db_error: true,
  session_crash: true,
  session_spawn_failed: true,
  crash_recovery: true,
  stale_reclaim: true,
  queue_full: true,
  queue_halted: true,
  queue_closed: true,
  pre_dispatch_error: true,
  scope_blocked_recovery: true,
  recovery_owner_reclaimed: true,
  processor_throw: true,
  unknown: true,
};

export const INBOUND_FAILURE_CLASSES: ReadonlySet<string> = new Set(
  Object.keys(INBOUND_FAILURE_CLASS_PRESENCE),
);

export const QUEUE_ADMISSION_TERMINALIZATION_ERROR_CODE =
  'QUEUE_ADMISSION_TERMINALIZATION_FAILED' as const;

/** Preserve queue-capacity ownership when ingest retries a failed terminal write. */
export class QueueAdmissionTerminalizationError extends Error {
  readonly code = QUEUE_ADMISSION_TERMINALIZATION_ERROR_CODE;

  constructor(cause: unknown) {
    super(
      cause instanceof Error
        ? cause.message
        : 'Queue rejection terminalization failed',
      { cause },
    );
    this.name = 'QueueAdmissionTerminalizationError';
  }
}

/**
 * Distinct reasons an admitted turn can be rejected before dispatch (#1750).
 * Each maps 1:1 onto the same-named InboundFailureClass so the durable
 * failure_class column carries the operator-facing driver split. Absent (a
 * legacy/undifferentiated rejection) collapses to 'unknown', preserving the
 * pre-#1750 null attempt_failure_class invariant for those rows.
 */
export type AdmissionRejectClass =
  | 'queue_full'
  | 'queue_halted'
  | 'queue_closed'
  | 'pre_dispatch_error'
  | 'scope_blocked_recovery';

const ADMISSION_REJECT_CLASS_PRESENCE: Readonly<Record<AdmissionRejectClass, true>> = {
  queue_full: true,
  queue_halted: true,
  queue_closed: true,
  pre_dispatch_error: true,
  scope_blocked_recovery: true,
};

export const ADMISSION_REJECT_CLASSES: ReadonlySet<string> = new Set(
  Object.keys(ADMISSION_REJECT_CLASS_PRESENCE),
);

/**
 * Shared lockstep mapping from an admission-rejection subclass (as carried on
 * the durable attempt_failure_class column, or absent) to its distinct inbound
 * failure_class. Both the agent-side mapper (turn-terminal.ts) and the core
 * finalization contract (turn-finalization-contract.ts) call THIS function so
 * their two ternaries can never drift. Absent → 'unknown'; a known subclass →
 * the same-named class; anything else is a contract violation.
 */
export function admissionRejectInboundFailureClass(
  admissionClass: string | null | undefined,
): InboundFailureClass {
  if (admissionClass === null || admissionClass === undefined) return 'unknown';
  if (ADMISSION_REJECT_CLASSES.has(admissionClass)) {
    return admissionClass as InboundFailureClass;
  }
  throw new Error('admission_rejected terminal disposition has an invalid rejection class');
}

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

  if (code === QUEUE_ADMISSION_TERMINALIZATION_ERROR_CODE) {
    return 'queue_full';
  }
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
