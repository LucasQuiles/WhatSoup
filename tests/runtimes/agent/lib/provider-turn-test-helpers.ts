import { expect } from 'vitest';

export function trustedProviderTurn(userText: string): object {
  return expect.objectContaining({
    userText,
    applicationContext: expect.arrayContaining([
      expect.stringContaining('[WhatSoup trusted transport metadata'),
    ]),
  });
}

export function providerUserText(input: unknown): string {
  return typeof input === 'string'
    ? input
    : (input as { userText: string }).userText;
}

/**
 * Every text a mocked sendTurn received: plain string turns, plus the
 * application context and user text of structured turns. A negative
 * `not.toHaveBeenCalledWith('text')` passes vacuously for structured turns.
 */
export function providerTurnTexts(calls: ReadonlyArray<ReadonlyArray<unknown>>): string[] {
  return calls.flatMap(([input]) => {
    if (typeof input === 'string') return [input];
    const turn = input as { applicationContext: readonly string[]; userText: string };
    return [...turn.applicationContext, turn.userText];
  });
}

interface MemoryConfigHarness {
  [key: string]: unknown;
  memory?: { adminJid: string | null; sweep: { reviewByDays: number } };
}

export function setMockMemoryConfig(config: MemoryConfigHarness): () => void {
  const previous = config.memory;
  config.memory = { adminJid: null, sweep: { reviewByDays: 7 } };
  return () => {
    if (previous === undefined) delete config.memory;
    else config.memory = previous;
  };
}
