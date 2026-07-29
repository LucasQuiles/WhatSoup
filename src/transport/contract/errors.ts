// src/transport/contract/errors.ts
import type { ChannelId } from '../../core/transport-refs.ts';
import type { OperationPhase } from '../../core/transport-error-taxonomy.ts';
import { ErrorCode } from './error-codes.ts';

export type ErrorScope = 'request' | 'conversation' | 'channel' | 'provider' | 'runtime';
export type CallerKind = 'internal' | 'mcp' | 'tool' | 'reconciliation';
export type { OperationPhase } from '../../core/transport-error-taxonomy.ts';

export interface TransportErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
  readonly retryable: boolean;
  readonly providerCode?: string;
  readonly channelId: ChannelId;
  readonly operation: string;
  readonly correlationId: string;
  readonly idempotencyKey?: string;
  readonly scope: ErrorScope;
  readonly phase?: OperationPhase;
  readonly callerKind?: CallerKind;
  /** Set on RateLimitedError. Preserved structurally so retry logic does not regex-parse `hint`. */
  readonly retryAfterMs?: number;
}

export abstract class TransportError extends Error {
  abstract readonly payload: TransportErrorPayload;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

interface BaseInput {
  readonly channelId: ChannelId;
  readonly operation: string;
  readonly correlationId: string;
  readonly message: string;
  readonly scope: ErrorScope;
  readonly hint?: string;
  readonly providerCode?: string;
  readonly idempotencyKey?: string;
  readonly callerKind?: CallerKind;
  readonly phase?: OperationPhase;
}

function build(code: string, retryable: boolean, input: BaseInput, extra: Partial<TransportErrorPayload> = {}): TransportErrorPayload {
  return { code, retryable, ...input, ...extra };
}

export class UnsupportedCapabilityError extends TransportError {
  readonly payload: TransportErrorPayload;
  constructor(input: BaseInput) {
    super(input.message);
    this.payload = build(ErrorCode.UNSUPPORTED_CAPABILITY, false, input);
  }
}

export class PayloadTooLargeError extends TransportError {
  readonly payload: TransportErrorPayload;
  constructor(input: BaseInput) {
    super(input.message);
    this.payload = build(ErrorCode.PAYLOAD_TOO_LARGE, false, input);
  }
}

export class ConversationNotFoundError extends TransportError {
  readonly payload: TransportErrorPayload;
  constructor(input: BaseInput) {
    super(input.message);
    this.payload = build(ErrorCode.CONVERSATION_NOT_FOUND, false, input);
  }
}

export class AuthRequiredError extends TransportError {
  readonly payload: TransportErrorPayload;
  constructor(input: BaseInput) {
    super(input.message);
    this.payload = build(ErrorCode.AUTH_REQUIRED, false, input);
  }
}

export interface RateLimitedInput extends BaseInput {
  readonly retryAfterMs?: number;
}
export class RateLimitedError extends TransportError {
  readonly payload: TransportErrorPayload;
  constructor(input: RateLimitedInput) {
    super(input.message);
    this.payload = build(ErrorCode.RATE_LIMITED, true, input, {
      hint: input.retryAfterMs !== undefined ? `retry-after-ms=${input.retryAfterMs}` : input.hint,
      retryAfterMs: input.retryAfterMs,
    });
  }
}

export class TransientProviderError extends TransportError {
  readonly payload: TransportErrorPayload;
  constructor(input: BaseInput) {
    super(input.message);
    this.payload = build(ErrorCode.TRANSIENT_PROVIDER, true, input);
  }
}

export class PermanentProviderError extends TransportError {
  readonly payload: TransportErrorPayload;
  constructor(input: BaseInput) {
    super(input.message);
    this.payload = build(ErrorCode.PERMANENT_PROVIDER, false, input);
  }
}

export interface SendAmbiguousInput extends BaseInput {
  readonly phase: OperationPhase;
}
export class SendAmbiguousError extends TransportError {
  readonly payload: TransportErrorPayload;
  constructor(input: SendAmbiguousInput) {
    super(input.message);
    this.payload = build(ErrorCode.SEND_AMBIGUOUS, false, input, { phase: input.phase });
  }
}
