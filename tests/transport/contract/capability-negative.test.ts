// tests/transport/contract/capability-negative.test.ts
import { describe, it, expect } from 'vitest';
import { MinimalTextAdapter } from '../../../src/transport/testing/minimal-text.ts';
import {
  isMediaCapable,
  isVoiceCapable,
  isReactive,
  isEditable,
  isDeletable,
  isTypingCapable,
  isPresenceCapable,
  isGroupsCapable,
  isReadReceiptCapable,
  isInlineKeyboardCapable,
  hasOutboundStatus,
} from '../../../src/transport/contract/extensions.ts';
import { UnsupportedCapabilityError } from '../../../src/transport/contract/errors.ts';
import { makeChannelId } from '../../../src/core/transport-refs.ts';

describe('Capability negatives — MinimalTextAdapter', () => {
  it('N1: every extension type guard returns false', () => {
    const adapter = new MinimalTextAdapter();
    expect(isMediaCapable(adapter)).toBe(false);
    expect(isVoiceCapable(adapter)).toBe(false);
    expect(isReactive(adapter)).toBe(false);
    expect(isEditable(adapter)).toBe(false);
    expect(isDeletable(adapter)).toBe(false);
    expect(isTypingCapable(adapter)).toBe(false);
    expect(isPresenceCapable(adapter)).toBe(false);
    expect(isGroupsCapable(adapter)).toBe(false);
    expect(isReadReceiptCapable(adapter)).toBe(false);
    expect(isInlineKeyboardCapable(adapter)).toBe(false);
    expect(hasOutboundStatus(adapter)).toBe(false);
  });

  it('N2: extensions set is empty', () => {
    const adapter = new MinimalTextAdapter();
    expect(adapter.capabilities.extensions.size).toBe(0);
    expect([...adapter.capabilities.extensions]).toEqual([]);
  });

  it('N3: type guards prevent compile-time access to extension methods', () => {
    const adapter = new MinimalTextAdapter();
    // The narrowing pattern: branches guarded by type guards must not execute,
    // and extension methods must not exist on the bare adapter at runtime.
    if (isMediaCapable(adapter)) {
      throw new Error('unreachable: MinimalTextAdapter must not narrow to SupportsMedia');
    }
    if (isReactive(adapter)) {
      throw new Error('unreachable: MinimalTextAdapter must not narrow to SupportsReactions');
    }
    if (isEditable(adapter)) {
      throw new Error('unreachable: MinimalTextAdapter must not narrow to SupportsEdit');
    }
    if (isDeletable(adapter)) {
      throw new Error('unreachable: MinimalTextAdapter must not narrow to SupportsDelete');
    }
    // Runtime corollary of the compile-time guard: the methods are simply absent.
    const a = adapter as unknown as Record<string, unknown>;
    expect(typeof a.sendMedia).toBe('undefined');
    expect(typeof a.fetchAttachment).toBe('undefined');
    expect(typeof a.react).toBe('undefined');
    expect(typeof a.editText).toBe('undefined');
    expect(typeof a.deleteMessage).toBe('undefined');
    expect(typeof a.setTyping).toBe('undefined');
    expect(typeof a.markRead).toBe('undefined');
    expect(typeof a.sendWithButtons).toBe('undefined');
    expect(typeof a.sendVoiceNote).toBe('undefined');
    expect(typeof a.getGroupMetadata).toBe('undefined');
  });

  it('N4: forced internal call throws UnsupportedCapabilityError with scope=runtime, callerKind=internal', () => {
    const adapter = new MinimalTextAdapter();
    const channelId = adapter.capabilities.channel;
    expect(channelId).toBe(makeChannelId('whatsapp', 'minimal-test'));

    // Simulate an internal caller bypassing the type guard and invoking a
    // capability the adapter does not declare. The contract says this MUST
    // raise UnsupportedCapabilityError tagged scope=runtime, callerKind=internal.
    const forcedCall = (): never => {
      if (!isMediaCapable(adapter)) {
        throw new UnsupportedCapabilityError({
          channelId,
          operation: 'sendMedia',
          correlationId: 'min-neg-1',
          scope: 'runtime',
          callerKind: 'internal',
          message: `capability 'media' not declared on ${channelId}`,
        });
      }
      // Unreachable — kept for type completeness.
      throw new Error('unreachable');
    };

    expect(forcedCall).toThrow(UnsupportedCapabilityError);

    try {
      forcedCall();
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedCapabilityError);
      const e = err as UnsupportedCapabilityError;
      expect(e.payload.code).toBe('transport.unsupported_capability');
      expect(e.payload.scope).toBe('runtime');
      expect(e.payload.callerKind).toBe('internal');
      expect(e.payload.operation).toBe('sendMedia');
      expect(e.payload.channelId).toBe(channelId);
      expect(e.payload.correlationId).toBe('min-neg-1');
      expect(e.payload.retryable).toBe(false);
    }
  });
});
