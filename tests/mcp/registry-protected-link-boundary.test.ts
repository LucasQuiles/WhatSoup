/**
 * The MCP response boundary redacts protected links from every tool result,
 * success or error, whichever handler produced it, and refuses a result it
 * cannot scan whole.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/protected-delivery-pins.ts', async (importOriginal) =>
  (await import('../helpers/protected-delivery-pins.ts')).mockProtectedDeliveryPins(importOriginal as never));
vi.mock('../../src/lib/protected-delivery-pins.ts', async (importOriginal) =>
  (await import('../helpers/protected-delivery-pins.ts')).mockProtectedDeliveryPins(importOriginal as never));
vi.mock('../../src/logger.ts', async () => (await import('../helpers/logger-mock.ts')).loggerMock());

import { z } from 'zod';
import { PROTECTED_MESSAGE_MARKER } from '../../src/core/protected-message.ts';
import { errorResult } from '../../src/mcp/types.ts';
import { TEST_LINK_HOST } from '../helpers/protected-delivery-pins.ts';
import { ToolRegistry } from '../helpers/resolved-tool-registry.ts';

const LINK = `https://${TEST_LINK_HOST}/s/#v3.${'Q'.repeat(22)}.${'Z'.repeat(43)}`;

async function callProbe(handler: () => unknown): Promise<{ text: string; isError?: boolean }> {
  const registry = new ToolRegistry();
  registry.register({
    name: 'probe_reader',
    description: 'probe',
    schema: z.object({}),
    scope: 'global',
    targetMode: 'caller-supplied',
    handler: async () => handler(),
  });
  const result = await registry.call('probe_reader', {}, { tier: 'global' });
  expect(result.content).toHaveLength(1);
  return { text: result.content[0]!.text, ...(result.isError ? { isError: true } : {}) };
}

function expectRedacted(text: string): void {
  expect(text).not.toContain(TEST_LINK_HOST.slice(0, 6));
  expect(text).not.toContain('Q'.repeat(22));
  expect(text).toContain(PROTECTED_MESSAGE_MARKER);
}

describe('MCP response boundary', () => {
  it('redacts an object result from a handler that does not sanitize', async () => {
    const result = await callProbe(() => ({ subject: `Team ${LINK}` }));

    expect(result.isError).toBeUndefined();
    expectRedacted(result.text);
    expect(JSON.parse(result.text)).toEqual({ subject: `Team ${PROTECTED_MESSAGE_MARKER}` });
  });

  it('redacts a string result', async () => {
    const result = await callProbe(() => `see ${LINK}`);

    expect(result.text).toBe(`see ${PROTECTED_MESSAGE_MARKER}`);
  });

  it('redacts application error text from a rejected handler', async () => {
    const result = await callProbe(() => { throw new Error(`remote metadata failed for ${LINK}`); });

    expect(result.isError).toBe(true);
    expectRedacted(result.text);
    expect(result.text).toContain('remote metadata failed for');
  });

  it('redacts a returned error payload and keeps it an error', async () => {
    const result = await callProbe(() => errorResult(`lookup failed for ${LINK}`));

    expect(result.isError).toBe(true);
    expectRedacted(result.text);
  });

  it('replaces a binary leaf whose bytes carry a protected link', async () => {
    const plaintext = Buffer.concat([Buffer.from([0x0a, 0x60]), Buffer.from(`see ${LINK}`)]);
    const result = await callProbe(() => ({ plaintext }));

    expect(JSON.parse(result.text)).toEqual({ plaintext: PROTECTED_MESSAGE_MARKER });
  });

  it('refuses a result string with more than 128 links as a tool error', async () => {
    const result = await callProbe(() => ({ text: `${LINK} `.repeat(129) }));

    expect(result.isError).toBe(true);
    expect(result.text).toContain('too large to check for protected links');
    expect(result.text).not.toContain(TEST_LINK_HOST.slice(0, 6));
  });
});
