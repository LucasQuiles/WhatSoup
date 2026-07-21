// tests/transport/unsupported-operation.test.ts
// Shared helper for graceful capability degradation: detects the typed error
// all three transport bridges (signal/twilio/imessage) throw when an MCP tool
// or runtime calls a method the transport does not implement, and converts it
// to a clean agent-actionable tool error.
import { describe, it, expect } from 'vitest';
import {
  isUnsupportedTransportOperation,
  unsupportedToolError,
} from '../../src/transport/unsupported-operation.ts';
import { UnsupportedTransportOperationError } from '../../src/transport/signal/connection-bridge.ts';
import { UnsupportedTransportOperationError as TwilioUnsupported } from '../../src/transport/twilio/connection-bridge.ts';
import { UnsupportedTransportOperationError as ImessageUnsupported } from '../../src/transport/imessage/connection-bridge.ts';

describe('isUnsupportedTransportOperation', () => {
  it('returns true for the signal bridge error', () => {
    const err = new UnsupportedTransportOperationError('sendMedia');
    expect(isUnsupportedTransportOperation(err)).toBe(true);
  });

  it('returns true for the twilio bridge error (cross-transport parity)', () => {
    // A caller that gets passed any of the three transport errors must
    // recognize all of them — the helper is bridge-agnostic.
    const err = new TwilioUnsupported('sendRaw');
    expect(isUnsupportedTransportOperation(err)).toBe(true);
  });

  it('returns true for the imessage bridge error', () => {
    const err = new ImessageUnsupported('sendPollMessage');
    expect(isUnsupportedTransportOperation(err)).toBe(true);
  });

  it('returns true for a duck-typed plain object with matching name + code', () => {
    // Defends against error-class identity divergence across realms / builds.
    const err = {
      name: 'UnsupportedTransportOperationError',
      code: 'UNSUPPORTED_TRANSPORT_OPERATION',
      message: 'sendRaw is not supported',
    };
    expect(isUnsupportedTransportOperation(err)).toBe(true);
  });

  it('returns true for an Error subclass that sets name but not code (defensive)', () => {
    // The bridges set BOTH, but a downstream wrap might lose one. The helper
    // accepts either signal so a wrapped error is still recognized.
    const err = new Error('x');
    err.name = 'UnsupportedTransportOperationError';
    expect(isUnsupportedTransportOperation(err)).toBe(true);
  });

  it('returns false for an unrelated error', () => {
    expect(isUnsupportedTransportOperation(new Error('unrelated'))).toBe(false);
    expect(isUnsupportedTransportOperation({ message: 'x' })).toBe(false);
  });

  it('returns false for null/undefined (defensive — caller may pass a missing error)', () => {
    expect(isUnsupportedTransportOperation(null)).toBe(false);
    expect(isUnsupportedTransportOperation(undefined)).toBe(false);
  });

  it('returns false for strings / numbers (non-error inputs)', () => {
    expect(isUnsupportedTransportOperation('UnsupportedTransportOperationError')).toBe(false);
    expect(isUnsupportedTransportOperation(42)).toBe(false);
  });
});

describe('unsupportedToolError', () => {
  it('produces a stable tool-error shape naming the unsupported operation', () => {
    const result = unsupportedToolError('sendRaw');
    expect(result).toEqual({
      error: 'unsupported_transport',
      message: 'sendRaw is not supported on this transport.',
    });
  });

  it('produces a human-readable message for each operation we wrap', () => {
    // Spot-check the operations messaging.ts actually wraps.
    expect(unsupportedToolError('sendRaw').message).toMatch(/sendRaw/);
    expect(unsupportedToolError('sendPollMessage').message).toMatch(/sendPollMessage/);
    expect(unsupportedToolError('sendMedia').message).toMatch(/sendMedia/);
  });

  it('always returns the same error code (agents key on this)', () => {
    expect(unsupportedToolError('sendRaw').error).toBe('unsupported_transport');
    expect(unsupportedToolError('sendPollMessage').error).toBe('unsupported_transport');
  });
});
