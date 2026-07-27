/**
 * Pins the canonical UnsupportedTransportOperationError (#2202).
 *
 * The class was declared three times — once per non-WhatsApp bridge — with
 * `code`, `name`, and the constructor shape duplicated verbatim. Consolidating
 * them is only safe if the operator-facing messages come out byte-identical,
 * and before this file NOTHING asserted them: `git grep "is not supported on
 * the" -- tests/` returned zero hits. A silent wording change would have
 * shipped green.
 *
 * The expected strings below are the pre-consolidation messages copied from
 * main @ 04c8b633354d, so this file is a regression pin, not a restatement of
 * the new implementation.
 */
import { describe, it, expect } from 'vitest';
import {
  REQUIRES_WHATSAPP_DETAIL,
  UnsupportedTransportOperationError,
} from '../../src/transport/unsupported-operation.ts';
import { UnsupportedTransportOperationError as FromImessage } from '../../src/transport/imessage/connection-bridge.ts';
import { UnsupportedTransportOperationError as FromSignal } from '../../src/transport/signal/connection-bridge.ts';
import { UnsupportedTransportOperationError as FromTwilio } from '../../src/transport/twilio/connection-bridge.ts';

describe('UnsupportedTransportOperationError — canonical shape', () => {
  it('carries the stable machine-readable code and name', () => {
    const err = new UnsupportedTransportOperationError('SignalConnection', 'Signal', 'sendMedia');
    expect(err.code).toBe('UNSUPPORTED_TRANSPORT_OPERATION');
    expect(err.name).toBe('UnsupportedTransportOperationError');
    expect(err).toBeInstanceOf(Error);
  });

  it('is ONE class across all three bridge re-exports', () => {
    // The point of #2202: three declarations could drift independently. If a
    // bridge ever re-declares its own, this identity check fails.
    expect(FromImessage).toBe(UnsupportedTransportOperationError);
    expect(FromSignal).toBe(UnsupportedTransportOperationError);
    expect(FromTwilio).toBe(UnsupportedTransportOperationError);
  });

  it('omits the trailing sentence when no detail is given', () => {
    const err = new UnsupportedTransportOperationError('SignalConnection', 'Signal', 'sendRaw');
    expect(err.message).toBe('[SignalConnection] "sendRaw" is not supported on the Signal transport');
    expect(err.message).not.toContain('WhatsApp');
  });
});

describe('UnsupportedTransportOperationError — messages match pre-consolidation main', () => {
  // Verbatim from main @ 04c8b633354d, before the three classes were merged.
  it.each([
    [
      'iMessage',
      new UnsupportedTransportOperationError('ImessageConnection', 'iMessage', 'sendMedia', REQUIRES_WHATSAPP_DETAIL),
      '[ImessageConnection] "sendMedia" is not supported on the iMessage transport. '
        + 'This operation requires a WhatsApp connection.',
    ],
    [
      'Signal',
      new UnsupportedTransportOperationError('SignalConnection', 'Signal', 'sendMedia'),
      '[SignalConnection] "sendMedia" is not supported on the Signal transport',
    ],
    [
      'SMS',
      new UnsupportedTransportOperationError('TwilioConnection', 'SMS', 'sendMedia', REQUIRES_WHATSAPP_DETAIL),
      '[TwilioConnection] "sendMedia" is not supported on the SMS transport. '
        + 'This operation requires a WhatsApp connection.',
    ],
  ])('%s message is unchanged', (_name, err, expected) => {
    expect(err.message).toBe(expected);
  });

  it('interpolates the operation name verbatim', () => {
    const err = new UnsupportedTransportOperationError('TwilioConnection', 'SMS', 'sendPollMessage', REQUIRES_WHATSAPP_DETAIL);
    expect(err.message).toContain('"sendPollMessage"');
  });
});
