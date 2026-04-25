import { describe, it, expect } from 'vitest';
import {
  TransportError,
  UnsupportedCapabilityError, PayloadTooLargeError, ConversationNotFoundError,
  AuthRequiredError, RateLimitedError,
  TransientProviderError, PermanentProviderError, SendAmbiguousError,
} from '../../../src/transport/contract/errors.ts';
import { ErrorCode, allErrorCodes } from '../../../src/transport/contract/error-codes.ts';
import { makeChannelId } from '../../../src/core/transport-refs.ts';

const ch = makeChannelId('whatsapp', 'test');

describe('Error code registry', () => {
  it('has no duplicates', () => {
    const codes = allErrorCodes();
    expect(codes.length).toBe(new Set(codes).size);
  });
});

describe('TransportError subclasses', () => {
  const base = {
    channelId: ch,
    operation: 'sendText',
    correlationId: 'abc-123',
  };

  it.each([
    ['UnsupportedCapability', new UnsupportedCapabilityError({ ...base, scope: 'runtime', message: 'm' }), ErrorCode.UNSUPPORTED_CAPABILITY, false],
    ['PayloadTooLarge',       new PayloadTooLargeError({ ...base, scope: 'request', message: 'm' }),       ErrorCode.PAYLOAD_TOO_LARGE, false],
    ['ConversationNotFound',  new ConversationNotFoundError({ ...base, scope: 'conversation', message: 'm' }), ErrorCode.CONVERSATION_NOT_FOUND, false],
    ['AuthRequired',          new AuthRequiredError({ ...base, scope: 'provider', message: 'm' }),         ErrorCode.AUTH_REQUIRED, false],
    ['RateLimited',           new RateLimitedError({ ...base, scope: 'provider', message: 'm' }),          ErrorCode.RATE_LIMITED, true],
    ['TransientProvider',     new TransientProviderError({ ...base, scope: 'provider', message: 'm' }),    ErrorCode.TRANSIENT_PROVIDER, true],
    ['PermanentProvider',     new PermanentProviderError({ ...base, scope: 'request', message: 'm' }),     ErrorCode.PERMANENT_PROVIDER, false],
    ['SendAmbiguous',         new SendAmbiguousError({ ...base, scope: 'request', message: 'm', phase: 'provider_call_started' }), ErrorCode.SEND_AMBIGUOUS, false],
  ])('%s carries the right code and retryable default', (_name, err, code, retryable) => {
    expect(err).toBeInstanceOf(TransportError);
    expect(err).toBeInstanceOf(Error);
    expect(err.payload.code).toBe(code);
    expect(err.payload.retryable).toBe(retryable);
    expect(err.payload.channelId).toBe(ch);
    expect(err.payload.operation).toBe('sendText');
    expect(err.payload.correlationId).toBe('abc-123');
  });

  it('SendAmbiguousError requires a phase', () => {
    const e = new SendAmbiguousError({ ...base, scope: 'request', message: 'm', phase: 'provider_call_started' });
    expect(e.payload.phase).toBe('provider_call_started');
  });

  it('UnsupportedCapabilityError captures caller_kind', () => {
    const e = new UnsupportedCapabilityError({
      ...base,
      scope: 'request',
      message: 'm',
      callerKind: 'mcp',
    });
    expect(e.payload.callerKind).toBe('mcp');
  });
});
