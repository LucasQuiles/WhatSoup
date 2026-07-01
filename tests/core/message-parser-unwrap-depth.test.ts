import { describe, it, expect } from 'vitest';
import { unwrapMessage } from '../../src/core/message-parser.ts';

// QR-039: unwrapMessage unwraps Baileys container types. It must bound how deep it
// will follow a wrapper chain so a crafted inbound message with thousands of nested
// wrappers cannot overflow the call stack (a DoS that crashes parseIncomingMessage).
describe('unwrapMessage depth bound (QR-039)', () => {
  it('fully unwraps a legitimate nested wrapper chain', () => {
    const msg = {
      ephemeralMessage: { message: { viewOnceMessageV2: { message: { conversation: 'hi' } } } },
    };
    expect(unwrapMessage(msg)).toEqual({ conversation: 'hi' });
  });

  it('handles each wrapper type one level deep', () => {
    for (const w of [
      'ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2',
      'documentWithCaptionMessage', 'editedMessage',
    ]) {
      expect(unwrapMessage({ [w]: { message: { conversation: w } } })).toEqual({ conversation: w });
    }
  });

  it('does NOT stack-overflow on a deeply-nested adversarial wrapper chain', () => {
    let deep: any = { conversation: 'payload' };
    for (let i = 0; i < 50_000; i++) deep = { ephemeralMessage: { message: deep } };
    // On main this throws RangeError "Maximum call stack size exceeded".
    expect(() => unwrapMessage(deep)).not.toThrow();
  });

  it('returns input unchanged for null / plain (non-wrapper) messages', () => {
    expect(unwrapMessage(null)).toBe(null);
    expect(unwrapMessage(undefined)).toBe(undefined);
    expect(unwrapMessage({ conversation: 'plain' })).toEqual({ conversation: 'plain' });
  });
});
