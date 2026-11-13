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
import { Database } from '../../src/core/database.ts';
import { createProfileRegistry } from '../../src/core/profiles.ts';
import { PROTECTED_MESSAGE_MARKER, PROTECTED_TEXT_WITHHELD_MARKER } from '../../src/core/protected-message.ts';
import { registerAdvancedTools } from '../../src/mcp/tools/advanced.ts';
import { registerMessagingTools } from '../../src/mcp/tools/messaging.ts';
import { registerProfileTools } from '../../src/mcp/tools/profile.ts';
import { makeSockTool } from '../../src/mcp/tools/sock-tool-factory.ts';
import { errorResult, isToolErrorPayload } from '../../src/mcp/types.ts';
import { TEST_LINK_HOST } from '../helpers/protected-delivery-pins.ts';
import { ToolRegistry } from '../helpers/resolved-tool-registry.ts';

const LINK = `https://${TEST_LINK_HOST}/s/#v3.${'Q'.repeat(22)}.${'Z'.repeat(43)}`;
const OVER_BOUND = `${LINK} `.repeat(129);

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

  it('redacts a protected link used as an object key', async () => {
    const result = await callProbe(() => ({ [LINK]: 'value', nested: { [`see ${LINK}`]: 1 } }));

    expect(result.isError).toBeUndefined();
    expectRedacted(result.text);
    expect(JSON.parse(result.text)).toEqual({
      [PROTECTED_MESSAGE_MARKER]: 'value',
      nested: { [`see ${PROTECTED_MESSAGE_MARKER}`]: 1 },
    });
  });

  it('keeps an existing key whose text equals a redacted key', async () => {
    const result = await callProbe(() => ({
      [`label ${PROTECTED_MESSAGE_MARKER}`]: { id: 'existing-record' },
      [`label ${LINK}`]: { id: 'link-record' },
    }));

    expect(result.isError).toBeUndefined();
    expectRedacted(result.text);
    expect(JSON.parse(result.text)).toEqual({
      [`label ${PROTECTED_MESSAGE_MARKER}`]: { id: 'existing-record' },
      [`label ${PROTECTED_MESSAGE_MARKER} [2]`]: { id: 'link-record' },
    });
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

  // Only the final text pass sees a rejected handler's text. JSON-encoded text
  // in it carries escapes whose letter reads as a host character.
  it.each(['\\n', '\\t'])('redacts a scheme-less host after an escaped %s in rejected handler text', async (escape) => {
    const bare = LINK.slice('https://'.length);
    const result = await callProbe(() => { throw new Error(`metadata {"note":"line${escape}${bare}"} unreadable`); });

    expect(result.isError).toBe(true);
    expectRedacted(result.text);
    expect(result.text).toContain(`line${escape}${PROTECTED_MESSAGE_MARKER}`);
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

  // The handler has completed, so its effect stands: a result too large to
  // scan whole is withheld, and the handler's own success or error is kept.
  it('withholds a completed result with more than 128 links and keeps it a success', async () => {
    const result = await callProbe(() => ({ text: OVER_BOUND }));

    expect(result.isError).toBeUndefined();
    expect(result.text).toBe(PROTECTED_TEXT_WITHHELD_MARKER);
  });

  it('withholds a returned error payload with more than 128 links and keeps it an error', async () => {
    const result = await callProbe(() => errorResult(OVER_BOUND));

    expect(result.isError).toBe(true);
    expect(result.text).toBe(PROTECTED_TEXT_WITHHELD_MARKER);
  });

  it('reports a delivered send_message whose result is too large to scan as a success, sent once', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const sent: unknown[] = [];
      const registry = new ToolRegistry();
      registerMessagingTools(registry, {
        connection: {
          contactsDir: { contacts: new Map<string, string>(), getLidMappings: () => undefined },
          sendRaw: async (jid: string, content: unknown) => {
            sent.push({ jid, content });
            return { waMessageId: null };
          },
        } as never,
        db: db.raw,
        dbWrapper: db,
        adminPhones: new Set<string>(),
        instanceName: 'self',
        profiles: createProfileRegistry({}),
      });

      const result = await registry.call(
        'send_message',
        { text: OVER_BOUND },
        { tier: 'chat-scoped', conversationKey: '15550100001', deliveryJid: '15550100001@s.whatsapp.net' },
      );

      expect(sent).toHaveLength(1);
      expect(result.isError).toBeUndefined();
      expect(result.content).toEqual([{ type: 'text', text: PROTECTED_TEXT_WITHHELD_MARKER }]);
    } finally {
      db.close();
    }
  });
});

// A factory tool scans its result after the socket call has completed, so a
// result too large to scan whole is withheld there too and keeps its success.
describe('factory tools after the socket call has completed', () => {
  const BARE = LINK.slice('https://'.length);

  async function sendListReply(selectedRowId: string): Promise<{ sent: unknown[]; result: Awaited<ReturnType<ToolRegistry['call']>> }> {
    const sent: unknown[] = [];
    const registry = new ToolRegistry();
    registerAdvancedTools(() => ({
      sendMessage: async (jid: string, content: unknown) => {
        sent.push({ jid, content });
        return { key: { id: 'synthetic' } };
      },
    }) as never, (tool) => registry.register(tool));
    const result = await registry.call(
      'send_list_reply',
      { title: 'Select', listType: 1, selectedRowId },
      { tier: 'chat-scoped', conversationKey: '15550100001', deliveryJid: '15550100001@s.whatsapp.net' },
    );
    return { sent, result };
  }

  it.each([
    ['a bare host after an escaped newline', `\\n${BARE} `],
    ['a scheme-bearing link', `${LINK} `],
  ])('send_list_reply echoing 129 links (%s) is sent once and reported as a success', async (_, unit) => {
    const { sent, result } = await sendListReply(unit.repeat(129));

    expect(sent).toHaveLength(1);
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: 'text', text: PROTECTED_TEXT_WITHHELD_MARKER }]);
  });

  it('control: send_list_reply echoing 128 links stays a redacted success', async () => {
    const { sent, result } = await sendListReply(`${LINK} `.repeat(128));

    expect(sent).toHaveLength(1);
    expect(result.isError).toBeUndefined();
    expectRedacted(result.content[0]!.text);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      sent: true, selectedRowId: `${PROTECTED_MESSAGE_MARKER} `.repeat(128),
    });
  });

  // A factory callback that returns an error result keeps the error flag, as
  // on main and as a hand-built tool does.
  describe('a callback that returns an error result', () => {
    function errorFactoryTool(message: string) {
      return makeSockTool(() => ({}) as never, {
        name: 'probe_factory',
        description: 'probe',
        schema: z.object({}),
        call: async () => errorResult(message),
      });
    }

    async function callErrorFactoryTool(message: string) {
      const registry = new ToolRegistry();
      registry.register(errorFactoryTool(message));
      return registry.call('probe_factory', {}, { tier: 'global' });
    }

    it('keeps isError with the error text redacted', async () => {
      const result = await callErrorFactoryTool(`lookup failed for ${LINK}`);

      expect(result.isError).toBe(true);
      expectRedacted(result.content[0]!.text);
      expect(JSON.parse(result.content[0]!.text)).toEqual({ error: `lookup failed for ${PROTECTED_MESSAGE_MARKER}` });
    });

    it('still redacts and marks the result its handler returns', async () => {
      const out = await errorFactoryTool(`lookup failed for ${LINK}`).handler({}, {} as never, undefined);

      expect(isToolErrorPayload(out)).toBe(true);
      expect(out).toEqual({ error: `lookup failed for ${PROTECTED_MESSAGE_MARKER}` });
    });

    it('keeps isError and returns only the withheld marker past the scan bound', async () => {
      const result = await callErrorFactoryTool(OVER_BOUND);

      expect(result).toEqual({ content: [{ type: 'text', text: PROTECTED_TEXT_WITHHELD_MARKER }], isError: true });
    });
  });

  it('update_privacy_settings echoing a value with 129 links is applied once and reported as a success', async () => {
    const applied: unknown[] = [];
    const db = new Database(':memory:');
    db.open();
    try {
      const registry = new ToolRegistry();
      registerProfileTools(() => ({
        updateDisableLinkPreviewsPrivacy: async (disabled: boolean) => { applied.push(disabled); },
      }) as never, db, (tool) => registry.register(tool));

      const result = await registry.call(
        'update_privacy_settings',
        { setting: 'link_previews', value: `${LINK} `.repeat(129) },
        { tier: 'global' },
      );

      expect(applied).toEqual([false]);
      expect(result.isError).toBeUndefined();
      expect(result.content).toEqual([{ type: 'text', text: PROTECTED_TEXT_WITHHELD_MARKER }]);
    } finally {
      db.close();
    }
  });
});
