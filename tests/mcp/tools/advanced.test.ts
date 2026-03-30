import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { registerAdvancedTools } from '../../../src/mcp/tools/advanced.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';
import type { WhatsAppSocket } from '../../../src/transport/connection.ts';

function globalSession(): SessionContext {
  return { tier: 'global' };
}

function chatSession(conversationKey: string): SessionContext {
  return { tier: 'chat-scoped', conversationKey, deliveryJid: `${conversationKey}@s.whatsapp.net` };
}

function makeMockSock(): WhatsAppSocket {
  return {
    createCallLink: vi.fn().mockResolvedValue({ link: 'https://call.whatsapp.com/abc123' }),
    sendMessage: vi.fn().mockResolvedValue({ status: 'sent' }),
    requestPairingCode: vi.fn().mockResolvedValue('ABCD-1234'),
    getBotListV2: vi.fn().mockResolvedValue([{ id: 'bot1', name: 'Test Bot' }]),
    logout: vi.fn().mockResolvedValue(undefined),
    resyncAppState: vi.fn().mockResolvedValue(undefined),
    relayMessage: vi.fn().mockResolvedValue({ messageId: 'msg123' }),
  } as unknown as WhatsAppSocket;
}

describe('advanced tools', () => {
  let registry: ToolRegistry;
  let mockSock: WhatsAppSocket;

  beforeEach(() => {
    mockSock = makeMockSock();
    registry = new ToolRegistry();
    registerAdvancedTools(() => mockSock, (tool) => registry.register(tool));
  });

  // -------------------------------------------------------------------------
  // Scope enforcement: global tools must not be visible in chat-scoped sessions
  // -------------------------------------------------------------------------

  const globalTools = [
    'create_call_link',
    'share_phone_number',
    'request_phone_number',
    'send_product_message',
    'request_pairing_code',
    'get_bots_list',
    'logout',
    'resync_app_state',
    'relay_message',
  ];

  const chatScopedTools = [
    'send_button_reply',
    'send_list_reply',
    'send_limit_sharing',
  ];

  it.each(globalTools)('%s is registered in global session', (name) => {
    const tools = registry.listTools(globalSession());
    expect(tools.find((t) => t.name === name)).toBeDefined();
  });

  it.each(globalTools)('%s is NOT visible in chat-scoped session', (name) => {
    const tools = registry.listTools(chatSession('111'));
    expect(tools.find((t) => t.name === name)).toBeUndefined();
  });

  it.each(globalTools)('%s is rejected when called from chat-scoped session', async (name) => {
    const result = await registry.call(name, {}, chatSession('111'));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not available in a chat-scoped session/);
  });

  it.each(chatScopedTools)('%s is registered in global session', (name) => {
    // chat-scoped tools ARE visible to global callers (superset)
    const tools = registry.listTools(globalSession());
    expect(tools.find((t) => t.name === name)).toBeDefined();
  });

  it.each(chatScopedTools)('%s is registered in chat-scoped session', (name) => {
    const tools = registry.listTools(chatSession('111'));
    expect(tools.find((t) => t.name === name)).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // create_call_link
  // -------------------------------------------------------------------------

  describe('create_call_link', () => {
    it('calls createCallLink with type', async () => {
      const result = await registry.call('create_call_link', { type: 'video' }, globalSession());
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).createCallLink).toHaveBeenCalledWith('video', undefined, undefined);
    });

    it('calls createCallLink with all params', async () => {
      await registry.call(
        'create_call_link',
        { type: 'audio', event: 'meeting', timeoutMs: 3600000 },
        globalSession(),
      );
      expect((mockSock as any).createCallLink).toHaveBeenCalledWith('audio', 'meeting', 3600000);
    });

    it('returns the call link result', async () => {
      const result = await registry.call('create_call_link', { type: 'video' }, globalSession());
      const data = JSON.parse(result.content[0].text) as { link: string };
      expect(data.link).toBe('https://call.whatsapp.com/abc123');
    });

    it('rejects invalid type', async () => {
      const result = await registry.call('create_call_link', { type: 'fax' }, globalSession());
      expect(result.isError).toBe(true);
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerAdvancedTools(() => null, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call('create_call_link', { type: 'audio' }, globalSession());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not connected/);
    });
  });

  // -------------------------------------------------------------------------
  // share_phone_number
  // -------------------------------------------------------------------------

  describe('share_phone_number', () => {
    it('calls sendMessage with sharePhoneNumber: true', async () => {
      const result = await registry.call(
        'share_phone_number',
        { jid: '111@s.whatsapp.net' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).sendMessage).toHaveBeenCalledWith('111@s.whatsapp.net', {
        sharePhoneNumber: true,
      });
    });

    it('returns sent: true with jid', async () => {
      const result = await registry.call(
        'share_phone_number',
        { jid: '111@s.whatsapp.net' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { sent: boolean; jid: string };
      expect(data.sent).toBe(true);
      expect(data.jid).toBe('111@s.whatsapp.net');
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerAdvancedTools(() => null, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call('share_phone_number', { jid: '111@s.whatsapp.net' }, globalSession());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not connected/);
    });

    it('requires jid (schema validation)', async () => {
      const result = await registry.call('share_phone_number', {}, globalSession());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Invalid parameters/);
    });
  });

  // -------------------------------------------------------------------------
  // request_phone_number
  // -------------------------------------------------------------------------

  describe('request_phone_number', () => {
    it('calls sendMessage with requestPhoneNumber: true', async () => {
      const result = await registry.call(
        'request_phone_number',
        { jid: '111@s.whatsapp.net' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).sendMessage).toHaveBeenCalledWith('111@s.whatsapp.net', {
        requestPhoneNumber: true,
      });
    });

    it('returns sent: true with jid', async () => {
      const result = await registry.call(
        'request_phone_number',
        { jid: '111@s.whatsapp.net' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { sent: boolean; jid: string };
      expect(data.sent).toBe(true);
      expect(data.jid).toBe('111@s.whatsapp.net');
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerAdvancedTools(() => null, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call('request_phone_number', { jid: '111@s.whatsapp.net' }, globalSession());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not connected/);
    });
  });

  // -------------------------------------------------------------------------
  // send_product_message
  // -------------------------------------------------------------------------

  describe('send_product_message', () => {
    const product = { productId: 'prod_001', title: 'Test Product', currencyCode: 'USD', priceAmount1000: 9990 };

    it('calls sendMessage with product content', async () => {
      const result = await registry.call(
        'send_product_message',
        { jid: '111@s.whatsapp.net', product },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).sendMessage).toHaveBeenCalledWith('111@s.whatsapp.net', { product });
    });

    it('returns sent: true with jid', async () => {
      const result = await registry.call(
        'send_product_message',
        { jid: '111@s.whatsapp.net', product },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { sent: boolean; jid: string };
      expect(data.sent).toBe(true);
      expect(data.jid).toBe('111@s.whatsapp.net');
    });

    it('requires jid and product (schema validation)', async () => {
      const result = await registry.call('send_product_message', { jid: '111@s.whatsapp.net' }, globalSession());
      expect(result.isError).toBe(true);
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerAdvancedTools(() => null, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call(
        'send_product_message',
        { jid: '111@s.whatsapp.net', product },
        globalSession(),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not connected/);
    });
  });

  // -------------------------------------------------------------------------
  // request_pairing_code
  // -------------------------------------------------------------------------

  describe('request_pairing_code', () => {
    it('calls requestPairingCode with phoneNumber', async () => {
      const result = await registry.call(
        'request_pairing_code',
        { phoneNumber: '14155551234' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).requestPairingCode).toHaveBeenCalledWith('14155551234', undefined);
    });

    it('calls requestPairingCode with customCode', async () => {
      await registry.call(
        'request_pairing_code',
        { phoneNumber: '14155551234', customCode: 'MYCODE' },
        globalSession(),
      );
      expect((mockSock as any).requestPairingCode).toHaveBeenCalledWith('14155551234', 'MYCODE');
    });

    it('returns pairingCode from Baileys', async () => {
      const result = await registry.call(
        'request_pairing_code',
        { phoneNumber: '14155551234' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { pairingCode: string };
      expect(data.pairingCode).toBe('ABCD-1234');
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerAdvancedTools(() => null, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call('request_pairing_code', { phoneNumber: '14155551234' }, globalSession());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not connected/);
    });

    it('requires phoneNumber (schema validation)', async () => {
      const result = await registry.call('request_pairing_code', {}, globalSession());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Invalid parameters/);
    });
  });

  // -------------------------------------------------------------------------
  // get_bots_list
  // -------------------------------------------------------------------------

  describe('get_bots_list', () => {
    it('calls getBotListV2', async () => {
      const result = await registry.call('get_bots_list', {}, globalSession());
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).getBotListV2).toHaveBeenCalled();
    });

    it('returns bots array', async () => {
      const result = await registry.call('get_bots_list', {}, globalSession());
      const data = JSON.parse(result.content[0].text) as { bots: unknown[] };
      expect(Array.isArray(data.bots)).toBe(true);
      expect(data.bots).toHaveLength(1);
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerAdvancedTools(() => null, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call('get_bots_list', {}, globalSession());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not connected/);
    });
  });

  // -------------------------------------------------------------------------
  // send_button_reply
  // -------------------------------------------------------------------------

  describe('send_button_reply', () => {
    const params = {
      chatJid: 'group1@g.us',
      displayText: 'Yes',
      id: 'btn_yes',
      type: 1,
    };

    it('calls sendMessage with buttonReply content', async () => {
      const result = await registry.call('send_button_reply', params, globalSession());
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).sendMessage).toHaveBeenCalledWith('group1@g.us', {
        buttonReply: { displayText: 'Yes', id: 'btn_yes', type: 1 },
      });
    });

    it('returns sent: true with chatJid and id', async () => {
      const result = await registry.call('send_button_reply', params, globalSession());
      const data = JSON.parse(result.content[0].text) as { sent: boolean; chatJid: string; id: string };
      expect(data.sent).toBe(true);
      expect(data.chatJid).toBe('group1@g.us');
      expect(data.id).toBe('btn_yes');
    });

    it('works from chat-scoped session', async () => {
      const result = await registry.call('send_button_reply', params, chatSession('group1@g.us'));
      expect(result.isError).toBeUndefined();
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerAdvancedTools(() => null, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call('send_button_reply', params, globalSession());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not connected/);
    });

    it('requires all fields (schema validation)', async () => {
      const result = await registry.call('send_button_reply', { chatJid: 'group1@g.us' }, globalSession());
      expect(result.isError).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // send_list_reply
  // -------------------------------------------------------------------------

  describe('send_list_reply', () => {
    const params = {
      chatJid: 'group1@g.us',
      title: 'Selected item',
      listType: 1,
      selectedRowId: 'row_001',
    };

    it('calls sendMessage with listReply content', async () => {
      const result = await registry.call('send_list_reply', params, globalSession());
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).sendMessage).toHaveBeenCalledWith('group1@g.us', {
        listReply: {
          title: 'Selected item',
          listType: 1,
          singleSelectReply: { selectedRowId: 'row_001' },
        },
      });
    });

    it('returns sent: true with chatJid and selectedRowId', async () => {
      const result = await registry.call('send_list_reply', params, globalSession());
      const data = JSON.parse(result.content[0].text) as {
        sent: boolean;
        chatJid: string;
        selectedRowId: string;
      };
      expect(data.sent).toBe(true);
      expect(data.chatJid).toBe('group1@g.us');
      expect(data.selectedRowId).toBe('row_001');
    });

    it('works from chat-scoped session', async () => {
      const result = await registry.call('send_list_reply', params, chatSession('group1@g.us'));
      expect(result.isError).toBeUndefined();
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerAdvancedTools(() => null, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call('send_list_reply', params, globalSession());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not connected/);
    });
  });

  // -------------------------------------------------------------------------
  // send_limit_sharing
  // -------------------------------------------------------------------------

  describe('send_limit_sharing', () => {
    it('calls sendMessage with limitSharing: true', async () => {
      const result = await registry.call(
        'send_limit_sharing',
        { chatJid: '111@s.whatsapp.net' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).sendMessage).toHaveBeenCalledWith('111@s.whatsapp.net', {
        limitSharing: true,
      });
    });

    it('returns sent: true with chatJid', async () => {
      const result = await registry.call(
        'send_limit_sharing',
        { chatJid: '111@s.whatsapp.net' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { sent: boolean; chatJid: string };
      expect(data.sent).toBe(true);
      expect(data.chatJid).toBe('111@s.whatsapp.net');
    });

    it('works from chat-scoped session', async () => {
      const result = await registry.call(
        'send_limit_sharing',
        { chatJid: '111@s.whatsapp.net' },
        chatSession('111'),
      );
      expect(result.isError).toBeUndefined();
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerAdvancedTools(() => null, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call(
        'send_limit_sharing',
        { chatJid: '111@s.whatsapp.net' },
        globalSession(),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not connected/);
    });
  });

  // -------------------------------------------------------------------------
  // logout
  // -------------------------------------------------------------------------

  describe('logout', () => {
    it('calls sock.logout with no message', async () => {
      const result = await registry.call('logout', {}, globalSession());
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).logout).toHaveBeenCalledWith(undefined);
    });

    it('calls sock.logout with optional message', async () => {
      await registry.call('logout', { msg: 'signing off' }, globalSession());
      expect((mockSock as any).logout).toHaveBeenCalledWith('signing off');
    });

    it('returns loggedOut: true', async () => {
      const result = await registry.call('logout', {}, globalSession());
      const data = JSON.parse(result.content[0].text) as { loggedOut: boolean };
      expect(data.loggedOut).toBe(true);
    });

    it('description contains WARNING', () => {
      const tools = registry.listTools(globalSession());
      const tool = tools.find((t) => t.name === 'logout');
      expect(tool?.description).toMatch(/WARNING/);
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerAdvancedTools(() => null, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call('logout', {}, globalSession());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not connected/);
    });
  });

  // -------------------------------------------------------------------------
  // resync_app_state
  // -------------------------------------------------------------------------

  describe('resync_app_state', () => {
    it('calls resyncAppState with collections and isInitialSync', async () => {
      const result = await registry.call(
        'resync_app_state',
        { collections: ['critical', 'regular_high'], isInitialSync: false },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).resyncAppState).toHaveBeenCalledWith(
        ['critical', 'regular_high'],
        false,
      );
    });

    it('returns synced: true with collections', async () => {
      const result = await registry.call(
        'resync_app_state',
        { collections: ['critical'], isInitialSync: true },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { synced: boolean; collections: string[] };
      expect(data.synced).toBe(true);
      expect(data.collections).toEqual(['critical']);
    });

    it('requires both collections and isInitialSync (schema validation)', async () => {
      const result = await registry.call('resync_app_state', { collections: ['critical'] }, globalSession());
      expect(result.isError).toBe(true);
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerAdvancedTools(() => null, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call(
        'resync_app_state',
        { collections: ['critical'], isInitialSync: false },
        globalSession(),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not connected/);
    });
  });

  // -------------------------------------------------------------------------
  // relay_message
  // -------------------------------------------------------------------------

  describe('relay_message', () => {
    const proto = { conversation: 'hello from relay' };

    it('calls relayMessage with jid and proto', async () => {
      const result = await registry.call(
        'relay_message',
        { jid: '111@s.whatsapp.net', proto },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).relayMessage).toHaveBeenCalledWith('111@s.whatsapp.net', proto, {});
    });

    it('calls relayMessage with opts', async () => {
      await registry.call(
        'relay_message',
        { jid: '111@s.whatsapp.net', proto, opts: { messageId: 'custom_id', participant: 'part@s.whatsapp.net' } },
        globalSession(),
      );
      expect((mockSock as any).relayMessage).toHaveBeenCalledWith(
        '111@s.whatsapp.net',
        proto,
        { messageId: 'custom_id', participant: 'part@s.whatsapp.net' },
      );
    });

    it('returns relayed: true with jid', async () => {
      const result = await registry.call(
        'relay_message',
        { jid: '111@s.whatsapp.net', proto },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { relayed: boolean; jid: string };
      expect(data.relayed).toBe(true);
      expect(data.jid).toBe('111@s.whatsapp.net');
    });

    it('requires jid and proto (schema validation)', async () => {
      const result = await registry.call('relay_message', { jid: '111@s.whatsapp.net' }, globalSession());
      expect(result.isError).toBe(true);
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerAdvancedTools(() => null, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call(
        'relay_message',
        { jid: '111@s.whatsapp.net', proto },
        globalSession(),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not connected/);
    });
  });
});
