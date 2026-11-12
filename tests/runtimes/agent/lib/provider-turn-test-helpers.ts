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
