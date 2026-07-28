/**
 * Fleet response-error projection (issue #2517, initial schema introduction).
 *
 * Single source of truth for the closed, versioned fleet response-error
 * schema. Every fleet JSON and SSE response that originates from an unknown
 * thrown value, an upstream filesystem/service/child-process failure, or an
 * arbitrary `detail`/`error` field MUST be projected through
 * {@link projectFleetError} (or its thin wrappers) before crossing the HTTP
 * or SSE boundary.
 *
 * ## Contract (issue #2517 § "Required contract")
 *
 * 1. Unknown exceptions become a registered safe {@link FleetResponseCode}
 *    with a bounded operation/stage; raw message, stack, command, stderr,
 *    location, environment, and arbitrary fields never enter JSON or SSE.
 * 2. Typed validation errors may expose only explicitly registered safe
 *    messages via {@link registeredClientSafeMessage}. Being an `Error` or
 *    carrying `statusCode` is NOT sufficient.
 * 3. Filesystem and service errors map errno/exit state to bounded classes
 *    (`source_unavailable`, `permission_denied`, `storage_full`,
 *    `service_action_failed`, `rollback_failed`).
 * 4. Mutation responses preserve operational truth via
 *    {@link MutationState} (`not_started`, `applied`, `rolled_back`,
 *    `rollback_failed`, `unknown`).
 * 5. JSON, SSE, proxied error adapters, and the top-level request catcher
 *    use the same projection.
 * 6. Internal diagnostics retain a {@link FleetResponseError.correlationId}
 *    and bounded classification. Any private exception logging remains
 *    subject to #2164's metadata-only sink contract.
 * 7. Console error views render the safe code, impact, next action, and
 *    correlation identifier without interpolating a raw response body.
 *
 * The projection is deliberately total: every input maps to a closed schema
 * with no `message`, `stack`, `cause`, `detail`, or arbitrary passthrough.
 * The raw exception is never reachable from the projection result.
 */

/**
 * Closed set of safe response codes that may appear in
 * {@link FleetResponseError.code}.
 *
 * Adding a value here is a schema change: console renderers, integration
 * tests, and operator runbooks all key off this enumeration. The string
 * literal type and the {@link FLEET_RESPONSE_CODES} constant are paired by
 * a type-level exhaustiveness check (see
 * `tests/fleet/lib/response-error.test.ts`).
 */
export const FLEET_RESPONSE_CODES = [
  // Validation / request-shape class.
  'invalid_request',
  // Filesystem / source availability class.
  'source_unavailable',
  // Permission / authorization-at-rest class.
  'permission_denied',
  // Storage capacity / quota class.
  'storage_full',
  // Service-manager action class (restart/stop/disable failed).
  'service_action_failed',
  // Mutation rollback class — paired with mutation_state='rollback_failed'.
  'rollback_failed',
  // Checkpoint / restore class.
  'restore_failed',
  // Credential store / keyring class.
  'credential_store_unavailable',
  // MCP transport class.
  'transport_unavailable',
  // Log source inspector class.
  'log_source_unavailable',
  // Catch-all for every throw that does not map to a more specific class.
  // Raw message/stack/cause are NEVER exposed; only this code is published.
  'internal_error',
] as const;

export type FleetResponseCode = (typeof FLEET_RESPONSE_CODES)[number];

/**
 * Mutation outcome truth. Required field on every mutation response error
 * so operators and clients can make reliable retry/reconcile decisions
 * without parsing prose.
 *
 * - `not_started`     — the mutation never began (validation or preflight failed).
 * - `applied`         — the mutation succeeded before the response error
 *                       (rare; e.g. response serialization failed post-commit).
 * - `rolled_back`     — the mutation failed and rollback completed cleanly.
 * - `rollback_failed` — the mutation failed AND rollback failed; pair with
 *                       code `rollback_failed`.
 * - `unknown`         — the mutation state cannot be determined (process
 *                       crash mid-mutation, lost connection, etc).
 */
export const MUTATION_STATES = [
  'not_started',
  'applied',
  'rolled_back',
  'rollback_failed',
  'unknown',
] as const;

export type MutationState = (typeof MUTATION_STATES)[number];

/**
 * Bounded retry hint. The string values are part of the public response
 * contract; clients branch on them. Do NOT interpolate arbitrary text.
 */
export type Retryable = 'yes' | 'no' | 'unknown';

/**
 * Closed response-error schema. Every field is bounded; nothing here can
 * carry raw exception text, paths, commands, stack, or stderr.
 *
 * The `correlationId` is the ONLY handle that links a published response
 * to internal diagnostics. It MUST be a UUID-shaped opaque string; it
 * carries no semantic information about the failure.
 */
export interface FleetResponseError {
  /** Closed schema version. Bumped on additive or breaking change. */
  readonly schema: 'fleet-response-error/v1';
  /** Closed {@link FleetResponseCode}. Never a free-form string. */
  readonly code: FleetResponseCode;
  /**
   * Bounded operation name (e.g. `restart`, `stop`, `checkpoint.restore`,
   * `config.write`). Drawn from a closed enumeration maintained alongside
   * the route map. See {@link knownOperationName}.
   */
  readonly operation: string;
  /**
   * Bounded stage within the operation (e.g. `preflight`, `execute`,
   * `rollback`, `serialize`). See {@link knownStageName}.
   */
  readonly stage: string;
  /** Retry hint for the client. */
  readonly retryable: Retryable;
  /** Mutation outcome truth. Required on every mutation response. */
  readonly mutationState: MutationState;
  /**
   * Opaque correlation handle. UUID v4 by default. Carries no semantic
   * information; links the response to internal diagnostics only.
   */
  readonly correlationId: string;
  /**
   * Optional explicitly registered client-safe message. Only set when the
   * producer has called {@link registeredClientSafeMessage} to register an
   * operator-approved literal; never set from arbitrary exception text.
   */
  readonly message?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Registered client-safe messages.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Marker symbol attached to operator-approved safe message literals.
 *
 * A string is only publishable as `FleetResponseError.message` if it carries
 * this symbol. The only way to attach it is via
 * {@link registeredClientSafeMessage}, which is the SSOT chokepoint for
 * operator review of every published literal.
 *
 * The symbol is intentionally not exported outside this module: the only
 * way to read it is via {@link isRegisteredClientSafeMessage}, which is
 * itself only used inside {@link projectFleetError}.
 */
const CLIENT_SAFE_MARKER: unique symbol = Symbol('fleet.client-safe-message');

export interface RegisteredClientSafeMessage {
  readonly text: string;
  readonly [CLIENT_SAFE_MARKER]: true;
}

/**
 * Register an operator-approved client-safe message literal. The argument
 * MUST be a string literal that has been reviewed for publication — it will
 * appear verbatim in fleet responses and console error views.
 *
 * The function is intentionally trivial; its value is the symbol marker,
 * which creates a closed type that cannot be forged by exception text.
 */
export function registeredClientSafeMessage(text: string): RegisteredClientSafeMessage {
  return { text, [CLIENT_SAFE_MARKER]: true } as const;
}

function isRegisteredClientSafeMessage(v: unknown): v is RegisteredClientSafeMessage {
  if (
    typeof v !== 'object' ||
    v === null ||
    !(CLIENT_SAFE_MARKER in v) ||
    (v as Record<symbol, unknown>)[CLIENT_SAFE_MARKER] !== true
  ) {
    return false;
  }
  return typeof (v as { text?: unknown }).text === 'string';
}

// ─────────────────────────────────────────────────────────────────────────
// Operation / stage name registry.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Closed operation-name set. Adding a value is a schema change because
 * console renderers and operator runbooks key off these literals.
 *
 * The set is deliberately bounded to current fleet route operations; any
 * new operation MUST be added here before it can appear in a response.
 */
export const FLEET_OPERATIONS = [
  'restart',
  'stop',
  'start',
  'delete',
  'create',
  'disable',
  'config.read',
  'config.write',
  'workspace.write',
  'checkpoint.read',
  'checkpoint.restore',
  'checkpoint.stop',
  'checkpoint.write',
  'log.scan',
  'log.tail',
  'feed.read',
  'silence.update',
  'approval.decide',
  'credential.write',
  'transport.proxy',
  'unknown',
] as const;

export type FleetOperation = (typeof FLEET_OPERATIONS)[number];

/**
 * Closed stage-name set. Stages are operation steps; the same stage can
 * appear in multiple operations (e.g. `preflight`, `execute`, `rollback`).
 */
export const FLEET_STAGES = [
  'preflight',
  'parse',
  'read',
  'execute',
  'write',
  'commit',
  'rollback',
  'serialize',
  'stream',
  'unknown',
] as const;

export type FleetStage = (typeof FLEET_STAGES)[number];

function knownOperationName(op: string): FleetOperation {
  return (FLEET_OPERATIONS as readonly string[]).includes(op)
    ? (op as FleetOperation)
    : 'unknown';
}

function knownStageName(stage: string): FleetStage {
  return (FLEET_STAGES as readonly string[]).includes(stage)
    ? (stage as FleetStage)
    : 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────
// Errno / exit-state classifier.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Map a Node.js errno string to a bounded {@link FleetResponseCode}.
 *
 * The mapping is intentionally conservative: unrecognised errnos fall
 * through to `internal_error`, never to a misleading specific class. Only
 * errnos with a clear filesystem/service interpretation are mapped.
 */
export function classifyErrno(errno: unknown): FleetResponseCode | null {
  if (typeof errno !== 'string') return null;
  switch (errno) {
    case 'ENOENT':
    case 'ENOTDIR':
    case 'ENODATA':
    case 'ECONNREFUSED':
    case 'ECONNRESET':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'ETIMEDOUT':
      return 'source_unavailable';
    case 'EACCES':
    case 'EPERM':
      return 'permission_denied';
    case 'ENOSPC':
    case 'EDQUOT':
    case 'EFBIG':
      return 'storage_full';
    default:
      return null;
  }
}

/**
 * Classify a thrown value into a bounded {@link FleetResponseCode}.
 *
 * The classifier is the ONLY place that maps exceptions to codes. It is
 * total: every input produces a code. It never exposes the original
 * message, stack, cause, name, or arbitrary properties — those are
 * deliberately discarded by the caller before serialization.
 *
 * Classification precedence:
 *   1. Registered client-safe message objects (return `invalid_request`).
 *   2. NodeJS.ErrnoException `code`/`errno`.
 *   3. Object with a recognised `fleetErrorClass` hint (internal API).
 *   4. Default → `internal_error`.
 */
export function classifyFleetError(err: unknown): FleetResponseCode {
  if (isRegisteredClientSafeMessage(err)) return 'invalid_request';
  if (typeof err === 'object' && err !== null) {
    const e = err as { code?: unknown; errno?: unknown; fleetErrorClass?: unknown };
    const fromErrno = classifyErrno(e.errno) ?? classifyErrno(e.code);
    if (fromErrno !== null) return fromErrno;
    if (typeof e.fleetErrorClass === 'string') {
      const direct = classifyErrno(e.fleetErrorClass);
      if (direct !== null) return direct;
      if ((FLEET_RESPONSE_CODES as readonly string[]).includes(e.fleetErrorClass)) {
        return e.fleetErrorClass as FleetResponseCode;
      }
    }
  }
  return 'internal_error';
}

// ─────────────────────────────────────────────────────────────────────────
// Retry hint derivation.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Derive a bounded retry hint from the classified code. Clients branch on
 * these literals; they MUST NOT be interpolated from arbitrary text.
 */
export function retryHintFor(code: FleetResponseCode): Retryable {
  switch (code) {
    case 'invalid_request':
    case 'permission_denied':
      return 'no';
    case 'source_unavailable':
    case 'transport_unavailable':
    case 'log_source_unavailable':
      return 'yes';
    case 'storage_full':
    case 'service_action_failed':
    case 'rollback_failed':
    case 'restore_failed':
    case 'credential_store_unavailable':
    case 'internal_error':
      return 'unknown';
    default: {
      // Exhaustiveness guard: every FleetResponseCode must appear above.
      // Adding a code without a retry hint is a compile error here.
      const _exhaustive: never = code;
      void _exhaustive;
      return 'unknown';
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Correlation ID generation.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Cryptographically random UUID v4, or a process-unique fallback when the
 * runtime lacks `crypto.randomUUID`. The correlation ID carries no semantic
 * information; it is an opaque handle linking the published response to
 * internal diagnostics only.
 */
export function newCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: 16 bytes from PRNG seeded with entropy. Not cryptographic, but
  // unique enough for response/diagnostic correlation within a process.
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  // RFC 4122 v4 variant bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Projection entry point.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Options for {@link projectFleetError}. Every field has a safe default so
 * the simplest call site (`projectFleetError(err, { operation: 'restart',
 * stage: 'execute' })`) produces a complete, well-formed projection.
 */
export interface ProjectFleetErrorOptions {
  /** Operation name. Unknown values collapse to `'unknown'`. */
  operation: string;
  /** Stage name. Unknown values collapse to `'unknown'`. */
  stage: string;
  /**
   * Mutation state. Defaults to `'unknown'`. Mutation routes (restart,
   * stop, create, delete, checkpoint.restore, config.write) MUST pass an
   * explicit value derived from observed state — never from exception text.
   */
  mutationState?: MutationState;
  /**
   * Optional registered client-safe message. Only values produced by
   * {@link registeredClientSafeMessage} are honored; arbitrary strings are
   * ignored. This is the chokepoint that prevents exception text from
   * reaching the `message` field.
   */
  safeMessage?: RegisteredClientSafeMessage;
  /**
   * Optional correlation ID. Generated if absent. Callers SHOULD pass an
   * externally-generated ID when one exists (e.g. from a request middleware).
   */
  correlationId?: string;
  /**
   * Optional explicit code override. When set, bypasses
   * {@link classifyFleetError}. Use sparingly: the classifier is the SSOT
   * for code derivation. The override MUST be a member of
   * {@link FLEET_RESPONSE_CODES}.
   */
  code?: FleetResponseCode;
}

/**
 * Project an arbitrary thrown value into the closed
 * {@link FleetResponseError} schema. This is the single chokepoint that
 * every fleet JSON and SSE response MUST use before serialization.
 *
 * The projection is total and closed:
 *   - Raw message/stack/cause/name are never reachable from the result.
 *   - The only way to publish a `message` is via a
 *     {@link registeredClientSafeMessage}, which carries a non-forgeable
 *     symbol marker.
 *   - Operation and stage names collapse to `'unknown'` if not in the
 *     closed registry.
 *   - The correlation ID is always present.
 *
 * The caller is responsible for emitting the projection via
 * `jsonResponse` or `writeSSE`. Internal diagnostic logging of the raw
 * error remains subject to #2164's metadata-only sink contract.
 */
export function projectFleetError(
  err: unknown,
  opts: ProjectFleetErrorOptions,
): FleetResponseError {
  const code = opts.code ?? classifyFleetError(err);
  const base: FleetResponseError = {
    schema: 'fleet-response-error/v1',
    code,
    operation: knownOperationName(opts.operation),
    stage: knownStageName(opts.stage),
    retryable: retryHintFor(code),
    mutationState: opts.mutationState ?? 'unknown',
    correlationId: opts.correlationId ?? newCorrelationId(),
  };
  // The ONLY way `message` is set is via a registered client-safe object,
  // which carries the non-forgeable CLIENT_SAFE_MARKER symbol. Arbitrary
  // strings, Error.message, and stringified throwables never reach here.
  if (opts.safeMessage !== undefined && isRegisteredClientSafeMessage(opts.safeMessage)) {
    return { ...base, message: opts.safeMessage.text };
  }
  return base;
}

/**
 * Convenience wrapper for non-mutation responses (read, scan, tail, feed,
 * proxy). Equivalent to `projectFleetError` with `mutationState: 'unknown'`.
 */
export function projectReadError(err: unknown, opts: Omit<ProjectFleetErrorOptions, 'mutationState'>): FleetResponseError {
  return projectFleetError(err, { ...opts, mutationState: 'unknown' });
}

/**
 * JSON-serializable shape (the interface is already serializable; this alias
 * documents the wire contract). Suitable for direct use as the `body`
 * argument to `jsonResponse` or as an SSE event payload field.
 */
export type FleetResponseErrorJson = FleetResponseError;
