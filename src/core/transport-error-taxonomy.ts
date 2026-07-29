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
