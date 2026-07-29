/**
 * Stable transport error taxonomy shared by core disposition logic and
 * transport adapters.
 */
export const ErrorCode = {
  UNSUPPORTED_CAPABILITY: 'transport.unsupported_capability',
  PAYLOAD_TOO_LARGE: 'transport.payload_too_large',
  CONVERSATION_NOT_FOUND: 'transport.conversation_not_found',
  AUTH_REQUIRED: 'transport.auth_required',
  RATE_LIMITED: 'transport.rate_limited',
  TRANSIENT_PROVIDER: 'transport.transient_provider',
  PERMANENT_PROVIDER: 'transport.permanent_provider',
  SEND_AMBIGUOUS: 'transport.send_ambiguous',
} as const;

export type ErrorCode = typeof ErrorCode[keyof typeof ErrorCode];

export type OperationPhase =
  | 'not_started'
  | 'provider_call_started'
  | 'ack_received';

export function allErrorCodes(): readonly ErrorCode[] {
  return Object.values(ErrorCode);
}

export const TRANSPORT_ERROR_EVIDENCE = Symbol('whatsoup.transport-error-evidence');

export interface TransportErrorEvidence {
  readonly [TRANSPORT_ERROR_EVIDENCE]: true;
  readonly payload: {
    readonly code: string;
    readonly retryable: boolean;
    readonly phase?: OperationPhase;
  };
}

export function isTransportErrorEvidence(value: unknown): value is Error & TransportErrorEvidence {
  if (!(value instanceof Error)) return false;
  const candidate = value as Error & Partial<TransportErrorEvidence>;
  const payload = candidate.payload;
  return candidate[TRANSPORT_ERROR_EVIDENCE] === true
    && typeof payload === 'object'
    && payload !== null
    && typeof payload.code === 'string'
    && typeof payload.retryable === 'boolean'
    && (
      payload.phase === undefined
      || payload.phase === 'not_started'
      || payload.phase === 'provider_call_started'
      || payload.phase === 'ack_received'
    );
}
