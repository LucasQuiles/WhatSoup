import { describe, it, expect } from 'vitest';
import { isVoiceCallCapable } from '../../src/transport/contract/voice.ts';
import { MinimalTextAdapter } from '../../src/transport/testing/minimal-text.ts';

describe('voice contract', () => {
  it('isVoiceCallCapable is false for adapters without the marker', () => {
    expect(isVoiceCallCapable(new MinimalTextAdapter())).toBe(false);
  });
});
