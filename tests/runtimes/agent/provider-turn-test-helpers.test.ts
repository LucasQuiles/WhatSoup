import { describe, expect, it, vi } from 'vitest';
import { providerTurnTexts } from './lib/provider-turn-test-helpers.ts';

describe('providerTurnTexts', () => {
  // B9 gate finding: negative assertions on plain strings stopped seeing
  // provider turns once turns became structured.
  it('sees the texts of a structured turn that a negative string matcher misses', () => {
    const sendTurn = vi.fn();
    sendTurn({ applicationContext: ['context entry'], userText: 'forbidden text' });
    sendTurn('plain turn');

    expect(sendTurn).not.toHaveBeenCalledWith('forbidden text');
    expect(providerTurnTexts(sendTurn.mock.calls)).toEqual(['context entry', 'forbidden text', 'plain turn']);
  });
});
