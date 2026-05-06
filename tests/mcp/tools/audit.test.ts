import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { createOutboundSendsWriter } from '../../../src/core/outbound-sends.ts';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { registerOutboundAuditTools } from '../../../src/mcp/tools/audit.ts';
import type { SessionContext, ToolDeclaration } from '../../../src/mcp/types.ts';

function globalSession(): SessionContext {
  return { tier: 'global' };
}

function chatSession(conversationKey: string): SessionContext {
  return { tier: 'chat-scoped', conversationKey, deliveryJid: `${conversationKey}@s.whatsapp.net` };
}

describe('outbound audit tools', () => {
  let db: Database;
  let registry: ToolRegistry;
  let capturedTools: ToolDeclaration[];

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    registry = new ToolRegistry();
    capturedTools = [];
    const register = registry.register.bind(registry);
    registry.register = (tool: ToolDeclaration) => {
      capturedTools.push(tool);
      register(tool);
    };
    registerOutboundAuditTools(registry, {
      writer: createOutboundSendsWriter({ db: db.raw, line: 'personal' }),
    });
  });

  afterEach(() => {
    db.close();
  });

  it('registers read_outbound_sends as a global read-only tool', () => {
    const globalTools = registry.listTools(globalSession());
    const chatTools = registry.listTools(chatSession('111'));

    expect(globalTools.find((tool) => tool.name === 'read_outbound_sends')).toBeDefined();
    expect(chatTools.find((tool) => tool.name === 'read_outbound_sends')).toBeUndefined();
    expect(capturedTools.find((tool) => tool.name === 'read_outbound_sends')).toMatchObject({
      scope: 'global',
      replayPolicy: 'read_only',
    });
  });

  it('returns bounded outbound send rows without text content', async () => {
    const writer = createOutboundSendsWriter({ db: db.raw, line: 'personal' });
    const id = writer.writeIntent({
      caller: 'mcp',
      chatJid: '111@s.whatsapp.net',
      targetKind: 'chatJid',
      profile: 'notify',
      text: 'private body',
    });
    writer.markSuccess(id, 'wamid.audit');

    const result = await registry.call('read_outbound_sends', { limit: 10 }, globalSession());

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text) as {
      outbound_sends: Array<Record<string, unknown>>;
    };
    expect(body.outbound_sends).toHaveLength(1);
    expect(body.outbound_sends[0]).toMatchObject({
      id,
      chat_jid: '111@s.whatsapp.net',
      status: 'sent',
      profile: 'notify',
      transport_id: 'wamid.audit',
    });
    expect(body.outbound_sends[0]).not.toHaveProperty('text');
  });

  it('filters by raw chatJid', async () => {
    const writer = createOutboundSendsWriter({ db: db.raw, line: 'personal' });
    writer.writeIntent({
      caller: 'mcp',
      chatJid: '111@s.whatsapp.net',
      targetKind: 'chatJid',
      text: 'include',
    });
    writer.writeIntent({
      caller: 'health',
      chatJid: '222@s.whatsapp.net',
      targetKind: 'chatJid',
      text: 'exclude',
    });

    const result = await registry.call(
      'read_outbound_sends',
      { chatJid: '111@s.whatsapp.net' },
      globalSession(),
    );
    const body = JSON.parse(result.content[0].text) as {
      outbound_sends: Array<{ chat_jid: string }>;
    };

    expect(body.outbound_sends.map((row) => row.chat_jid)).toEqual(['111@s.whatsapp.net']);
  });

  it('rejects unknown arguments instead of silently stripping them', async () => {
    const result = await registry.call(
      'read_outbound_sends',
      { text: '' },
      globalSession(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Invalid parameters/);
  });
});
