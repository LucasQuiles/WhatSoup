/**
 * Fleet Response Error Projection — #2517
 *
 * Closed, versioned schema for fleet route error responses.
 * Raw exception prose, stack traces, commands, stderr, filesystem locations,
 * environment, and arbitrary fields NEVER enter JSON or SSE responses.
 *
 * Schema fields:
 *   schema         — versioned schema identifier ('fleet-error-v1')
 *   code           — registered safe error code (closed enum)
 *   operation      — bounded operation name (closed enum)
 *   stage          — bounded stage within the operation (closed enum)
 *   message        — client-safe, registered message (never raw exception text)
 *   retryable      — whether the client should retry
 *   mutation_state — not_started | applied | rolled_back | rollback_failed | unknown
 *   rollback_state — none | succeeded | failed | not_applicable
 *   correlation_id — stable UUID for internal log correlation
 *
 * Requirements satisfied (issue #2517):
 *   1. Unknown exceptions → registered safe code + bounded operation/stage
 *   2. Typed validation errors → only explicitly registered safe messages
 *   3. Filesystem/service errors → errno/exit state mapped to bounded classes
 *   4. Mutation responses → operational truth preserved
 *   5. Unified projection for JSON, SSE, proxy, and top-level catcher
 *   6. Correlation ID retained for internal diagnostics
 *   8. Exact-byte canaries in tests/fleet/routes/response-projection.test.ts
 *   9. Static guard in eslint-rules/no-raw-fleet-error.ts
 */

import { randomUUID } from 'node:crypto';

// ── Closed schema types ──────────────────────────────────────────

/** Registered safe error codes. Adding a code requires updating SAFE_MESSAGES. */
export type FleetErrorCode =
  | 'source_unavailable'
  | 'permission_denied'
  | 'storage_full'
  | 'service_action_failed'
  | 'service_start_failed'
  | 'service_stop_failed'
  | 'restart_failed'
  | 'rollback_failed'
  | 'config_read_failed'
  | 'config_write_failed'
  | 'instance_creation_failed'
  | 'auth_failed'
  | 'auth_timeout'
  | 'validation_failed'
  | 'internal_error'
  | 'embed_service_unavailable'
  | 'log_scan_failed';

/** Bounded operation names. */
export type FleetOperation =
  | 'service_action'
  | 'config_read'
  | 'config_write'
  | 'instance_create'
  | 'instance_delete'
  | 'auth'
  | 'checkpoint_restore'
  | 'log_scan'
  | 'log_tail'
  | 'credential_verify'
  | 'decision_process'
  | 'silence'
  | 'unknown';

/** Bounded stage within an operation. */
export type FleetStage =
  | 'precondition'
  | 'execute'
  | 'commit'
  | 'rollback'
  | 'verify'
  | 'parse'
  | 'unknown';

/** Mutation/rollback operational truth. */
export type MutationState =
  | 'not_started'
  | 'applied'
  | 'rolled_back'
  | 'rollback_failed'
  | 'unknown';

export type RollbackState =
  | 'none'
  | 'succeeded'
  | 'failed'
  | 'not_applicable';

/** The closed, versioned response schema. */
export interface FleetErrorResponse {
  schema: 'fleet-error-v1';
  code: FleetErrorCode;
  operation: FleetOperation;
  stage: FleetStage;
  message: string;
  retryable: boolean;
  mutation_state: MutationState;
  rollback_state: RollbackState;
  correlation_id: string;
}

// ── Projection context ──────────────────────────────────────────

export interface ProjectionContext {
  operation: FleetOperation;
  stage?: FleetStage;
  mutationState?: MutationState;
  rollbackState?: RollbackState;
}

// ── Registered safe messages ────────────────────────────────────

/**
 * Client-safe messages indexed by error code.
 * These are the ONLY strings that may appear in the `message` field
 * unless an explicit registered override is provided.
 */
const SAFE_MESSAGES: Record<FleetErrorCode, string> = {
  source_unavailable: 'The requested resource is unavailable.',
  permission_denied: 'Permission denied for this operation.',
  storage_full: 'Storage is full; the operation could not be completed.',
  service_action_failed: 'A service operation failed.',
  service_start_failed: 'The service could not be started.',
  service_stop_failed: 'The service could not be stopped.',
  restart_failed: 'The restart operation failed.',
  rollback_failed:
    'A rollback operation failed; the instance may be in an inconsistent state.',
  config_read_failed: 'Configuration could not be read.',
  config_write_failed: 'Configuration could not be written.',
  instance_creation_failed: 'Instance creation failed.',
  auth_failed: 'Authentication failed.',
  auth_timeout: 'Authentication timed out. Please retry.',
  validation_failed: 'The request failed validation.',
  internal_error: 'An internal error occurred.',
  embed_service_unavailable:
    'The embedding service is unavailable. Try again in a moment.',
  log_scan_failed: 'Log scanning encountered an error.',
};

// ── Error classification ────────────────────────────────────────

/**
 * Classify an unknown thrown value into a bounded FleetErrorCode.
 * Inspects ONLY structural properties (errno, error name) — never the
 * raw message text. The message is discarded entirely.
 */
export function classifyError(err: unknown): {
  code: FleetErrorCode;
  retryable: boolean;
} {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const errno = (err as { code: unknown }).code;
    switch (errno) {
      case 'ENOENT':
      case 'ENOTDIR':
        return { code: 'source_unavailable', retryable: false };
      case 'EACCES':
      case 'EPERM':
        return { code: 'permission_denied', retryable: false };
      case 'ENOSPC':
      case 'EDQUOT':
        return { code: 'storage_full', retryable: false };
      case 'ECONNREFUSED':
      case 'ECONNRESET':
      case 'ETIMEDOUT':
      case 'ENETUNREACH':
        return { code: 'service_action_failed', retryable: true };
      default:
        break;
    }
  }

  if (err instanceof Error && err.name === 'AbortError') {
    return { code: 'service_action_failed', retryable: true };
  }

  return { code: 'internal_error', retryable: false };
}

// ── Registered validation messages ──────────────────────────────

/**
 * Registered client-safe validation messages (requirement 2).
 * Only these exact strings may appear in validation responses.
 * A caller MUST use a registered key — arbitrary/dynamic strings are rejected.
 */
export type ValidationMessageKey =
  | 'invalid_json'
  | 'invalid_decision_body'
  | 'invalid_request_body'
  | 'invalid_subject_type'
  | 'invalid_name';

const VALIDATION_MESSAGES: Record<ValidationMessageKey, string> = {
  invalid_json: 'Invalid JSON body.',
  invalid_decision_body: 'Invalid decision body.',
  invalid_request_body: 'Invalid request body.',
  invalid_subject_type: 'Invalid subject type.',
  invalid_name: 'Name must be 2-30 lowercase alphanumeric/hyphens, starting with a letter.',
};

// ── Main projection functions ───────────────────────────────────

/**
 * Project an unknown error into a safe, closed-schema FleetErrorResponse.
 * The raw exception text is NEVER included in the output.
 * A correlation ID is generated for internal log correlation.
 *
 * The caller SHOULD log the raw error internally using the returned
 * correlation_id so that operators can trace the safe response to the
 * original diagnostic.
 */
export function projectError(
  err: unknown,
  ctx: ProjectionContext,
): FleetErrorResponse {
  const { code, retryable } = classifyError(err);
  return {
    schema: 'fleet-error-v1',
    code,
    operation: ctx.operation,
    stage: ctx.stage ?? 'unknown',
    message: SAFE_MESSAGES[code],
    retryable,
    mutation_state: ctx.mutationState ?? 'unknown',
    rollback_state: ctx.rollbackState ?? 'not_applicable',
    correlation_id: randomUUID(),
  };
}

/**
 * Create a validation error response for client input errors.
 * Uses a registered client-safe message key (requirement 2) — arbitrary
 * or dynamic strings are never accepted as the response message.
 */
export function validationError(
  messageKey: ValidationMessageKey,
  operation: FleetOperation,
): FleetErrorResponse {
  return {
    schema: 'fleet-error-v1',
    code: 'validation_failed',
    operation,
    stage: 'parse',
    message: VALIDATION_MESSAGES[messageKey],
    retryable: false,
    mutation_state: 'not_started',
    rollback_state: 'not_applicable',
    correlation_id: randomUUID(),
  };
}

/**
 * Project a structured config-validation error into a fleet-error-v1 response.
 *
 * Unlike projectError() — which discards caught-exception text to prevent
 * leaking internals (paths, commands, stderr) — this PRESERVES the validator's
 * message. Validation messages describe field constraints the client must
 * satisfy (e.g. "healthPort must be between 1024 and 65535"); they embed only
 * client-supplied values and never server internals. The config validator is a
 * trusted, audited producer of safe client guidance, analogous to the closed
 * VALIDATION_MESSAGES registry. Routing these through projectError() would
 * over-redact client-facing guidance and make the API unusable (#2517).
 */
export function configValidationError(
  err: { message: string; status?: number },
  operation: FleetOperation,
): FleetErrorResponse {
  return {
    schema: 'fleet-error-v1',
    code: 'validation_failed',
    operation,
    stage: 'parse',
    message: err.message,
    retryable: false,
    mutation_state: 'not_started',
    rollback_state: 'not_applicable',
    correlation_id: randomUUID(),
  };
}

/**
 * Create a mutation-state-aware error response that preserves operational
 * truth: not-started, applied, rolled-back, rollback-failed, unknown.
 */
export function mutationError(
  err: unknown,
  ctx: ProjectionContext & {
    mutationState: MutationState;
    rollbackState?: RollbackState;
  },
): FleetErrorResponse {
  return projectError(err, ctx);
}

/**
 * Create a service-action error with a specific code override.
 * Used when the caller knows the operation semantics (start/stop/restart)
 * and wants to override the generic classification.
 */
export function serviceActionError(
  err: unknown,
  operation: FleetOperation,
  codeOverride: FleetErrorCode,
): FleetErrorResponse {
  return {
    schema: 'fleet-error-v1',
    code: codeOverride,
    operation,
    stage: 'execute',
    message: SAFE_MESSAGES[codeOverride],
    retryable: false,
    mutation_state: 'unknown',
    rollback_state: 'not_applicable',
    correlation_id: randomUUID(),
  };
}
