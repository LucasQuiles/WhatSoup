import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { registerBusinessTools } from '../../../src/mcp/tools/business.ts';
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
    getBusinessProfile: vi.fn().mockResolvedValue({ jid: 'biz@s.whatsapp.net', description: 'Test Biz' }),
    updateBussinesProfile: vi.fn().mockResolvedValue(undefined),
    updateCoverPhoto: vi.fn().mockResolvedValue(undefined),
    removeCoverPhoto: vi.fn().mockResolvedValue(undefined),
    getCatalog: vi.fn().mockResolvedValue({ products: [], cursor: null }),
    getCollections: vi.fn().mockResolvedValue({ collections: [] }),
    productCreate: vi.fn().mockResolvedValue({ id: 'prod-123', name: 'Widget' }),
    productUpdate: vi.fn().mockResolvedValue({ id: 'prod-123', name: 'Widget Updated' }),
    productDelete: vi.fn().mockResolvedValue({ deleted: ['prod-123'] }),
    getOrderDetails: vi.fn().mockResolvedValue({ id: 'order-999', products: [] }),
    addOrEditQuickReply: vi.fn().mockResolvedValue(undefined),
    removeQuickReply: vi.fn().mockResolvedValue(undefined),
    addLabel: vi.fn().mockResolvedValue(undefined),
    addChatLabel: vi.fn().mockResolvedValue(undefined),
    removeChatLabel: vi.fn().mockResolvedValue(undefined),
    addMessageLabel: vi.fn().mockResolvedValue(undefined),
    removeMessageLabel: vi.fn().mockResolvedValue(undefined),
  } as unknown as WhatsAppSocket;
}

describe('business tools', () => {
  let registry: ToolRegistry;
  let mockSock: WhatsAppSocket;

  beforeEach(() => {
    mockSock = makeMockSock();
    registry = new ToolRegistry();
    registerBusinessTools(() => mockSock, (tool) => registry.register(tool));
  });

  const globalTools = [
    'get_business_profile',
    'update_business_profile',
    'update_cover_photo',
    'remove_cover_photo',
    'get_catalog',
    'get_collections',
    'product_create',
    'product_update',
    'product_delete',
    'get_order_details',
    'add_or_edit_quick_reply',
    'remove_quick_reply',
    'manage_labels',
  ];

  it.each(globalTools)('%s is registered', (name) => {
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

  // ─── get_business_profile ───────────────────────────────────────────────

  describe('get_business_profile', () => {
    it('calls getBusinessProfile with jid', async () => {
      const result = await registry.call(
        'get_business_profile',
        { jid: 'biz@s.whatsapp.net' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).getBusinessProfile).toHaveBeenCalledWith('biz@s.whatsapp.net');
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerBusinessTools(() => null, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call(
        'get_business_profile',
        { jid: 'biz@s.whatsapp.net' },
        globalSession(),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not connected/);
    });
  });

  // ─── update_business_profile ────────────────────────────────────────────

  describe('update_business_profile', () => {
    it('calls updateBussinesProfile with all fields', async () => {
      const result = await registry.call(
        'update_business_profile',
        { category: 'retail', description: 'A great shop', email: 'info@shop.com' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).updateBussinesProfile).toHaveBeenCalledWith({
        category: 'retail',
        description: 'A great shop',
        email: 'info@shop.com',
      });
    });

    it('returns success: true', async () => {
      const result = await registry.call('update_business_profile', {}, globalSession());
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as { success: boolean };
      expect(data.success).toBe(true);
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerBusinessTools(() => null, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call('update_business_profile', {}, globalSession());
      expect(result.isError).toBe(true);
    });
  });

  // ─── update_cover_photo ─────────────────────────────────────────────────

  describe('update_cover_photo', () => {
    it('calls updateCoverPhoto with a Buffer decoded from base64', async () => {
      const b64 = Buffer.from('fakeimage').toString('base64');
      const result = await registry.call('update_cover_photo', { photo: b64 }, globalSession());
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).updateCoverPhoto).toHaveBeenCalledWith(
        expect.any(Buffer),
      );
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerBusinessTools(() => null, (tool) => nullRegistry.register(tool));
      const b64 = Buffer.from('img').toString('base64');
      const result = await nullRegistry.call('update_cover_photo', { photo: b64 }, globalSession());
      expect(result.isError).toBe(true);
    });
  });

  // ─── remove_cover_photo ─────────────────────────────────────────────────

  describe('remove_cover_photo', () => {
    it('calls removeCoverPhoto with id', async () => {
      const result = await registry.call('remove_cover_photo', { id: 'asset-42' }, globalSession());
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).removeCoverPhoto).toHaveBeenCalledWith('asset-42');
      const data = JSON.parse(result.content[0].text) as { success: boolean; id: string };
      expect(data.success).toBe(true);
      expect(data.id).toBe('asset-42');
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerBusinessTools(() => null, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call('remove_cover_photo', { id: 'asset-42' }, globalSession());
      expect(result.isError).toBe(true);
    });
  });

  // ─── get_catalog ────────────────────────────────────────────────────────

  describe('get_catalog', () => {
    it('calls getCatalog with jid, limit, cursor', async () => {
      const result = await registry.call(
        'get_catalog',
        { jid: 'biz@s.whatsapp.net', limit: 10, cursor: 'abc' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).getCatalog).toHaveBeenCalledWith({
        jid: 'biz@s.whatsapp.net',
        limit: 10,
        cursor: 'abc',
      });
    });

    it('calls getCatalog with all optional fields undefined when not provided', async () => {
      await registry.call('get_catalog', {}, globalSession());
      expect((mockSock as any).getCatalog).toHaveBeenCalledWith({
        jid: undefined,
        limit: undefined,
        cursor: undefined,
      });
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerBusinessTools(() => null, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call('get_catalog', {}, globalSession());
      expect(result.isError).toBe(true);
    });
  });

  // ─── get_collections ────────────────────────────────────────────────────

  describe('get_collections', () => {
    it('calls getCollections with jid and limit', async () => {
      const result = await registry.call(
        'get_collections',
        { jid: 'biz@s.whatsapp.net', limit: 5 },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).getCollections).toHaveBeenCalledWith('biz@s.whatsapp.net', 5);
    });

    it('calls getCollections with undefined when not provided', async () => {
      await registry.call('get_collections', {}, globalSession());
      expect((mockSock as any).getCollections).toHaveBeenCalledWith(undefined, undefined);
    });
  });

  // ─── product_create ─────────────────────────────────────────────────────

  describe('product_create', () => {
    it('calls productCreate with product data', async () => {
      const result = await registry.call(
        'product_create',
        { name: 'Widget', price: 999, currency: 'USD' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).productCreate).toHaveBeenCalledWith({
        name: 'Widget',
        price: 999,
        currency: 'USD',
      });
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerBusinessTools(() => null, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call('product_create', { name: 'Widget' }, globalSession());
      expect(result.isError).toBe(true);
    });

    it('errors when name is missing', async () => {
      const result = await registry.call('product_create', {}, globalSession());
      expect(result.isError).toBe(true);
    });
  });

  // ─── product_update ─────────────────────────────────────────────────────

  describe('product_update', () => {
    it('calls productUpdate with productId and update object', async () => {
      const result = await registry.call(
        'product_update',
        { productId: 'prod-123', name: 'Widget Updated', price: 1199 },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).productUpdate).toHaveBeenCalledWith(
        'prod-123',
        { name: 'Widget Updated', price: 1199 },
      );
    });

    it('errors when productId is missing', async () => {
      const result = await registry.call('product_update', { name: 'Widget' }, globalSession());
      expect(result.isError).toBe(true);
    });
  });

  // ─── product_delete ─────────────────────────────────────────────────────

  describe('product_delete', () => {
    it('calls productDelete with productIds array', async () => {
      const result = await registry.call(
        'product_delete',
        { productIds: ['prod-1', 'prod-2'] },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).productDelete).toHaveBeenCalledWith(['prod-1', 'prod-2']);
    });

    it('returns fallback result when Baileys returns null', async () => {
      (mockSock as any).productDelete = vi.fn().mockResolvedValue(null);
      const result = await registry.call(
        'product_delete',
        { productIds: ['prod-1'] },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as { success: boolean; deleted: number };
      expect(data.success).toBe(true);
      expect(data.deleted).toBe(1);
    });

    it('errors when productIds is missing', async () => {
      const result = await registry.call('product_delete', {}, globalSession());
      expect(result.isError).toBe(true);
    });
  });

  // ─── get_order_details ──────────────────────────────────────────────────

  describe('get_order_details', () => {
    it('calls getOrderDetails with orderId and tokenBase64', async () => {
      const result = await registry.call(
        'get_order_details',
        { orderId: 'order-999', tokenBase64: 'dG9rZW4=' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).getOrderDetails).toHaveBeenCalledWith('order-999', 'dG9rZW4=');
    });

    it('errors when tokenBase64 is missing', async () => {
      const result = await registry.call('get_order_details', { orderId: 'order-999' }, globalSession());
      expect(result.isError).toBe(true);
    });
  });

  // ─── add_or_edit_quick_reply ────────────────────────────────────────────

  describe('add_or_edit_quick_reply', () => {
    it('calls addOrEditQuickReply with quickReply object', async () => {
      const result = await registry.call(
        'add_or_edit_quick_reply',
        { shortcut: '/hello', message: 'Hello there!', keywords: ['hi', 'hey'] },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).addOrEditQuickReply).toHaveBeenCalledWith({
        shortcut: '/hello',
        message: 'Hello there!',
        keywords: ['hi', 'hey'],
      });
      const data = JSON.parse(result.content[0].text) as { success: boolean; shortcut: string };
      expect(data.success).toBe(true);
      expect(data.shortcut).toBe('/hello');
    });

    it('errors when shortcut is missing', async () => {
      const result = await registry.call('add_or_edit_quick_reply', { message: 'Hello' }, globalSession());
      expect(result.isError).toBe(true);
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerBusinessTools(() => null, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call(
        'add_or_edit_quick_reply',
        { shortcut: '/hi', message: 'Hi!' },
        globalSession(),
      );
      expect(result.isError).toBe(true);
    });
  });

  // ─── remove_quick_reply ─────────────────────────────────────────────────

  describe('remove_quick_reply', () => {
    it('calls removeQuickReply with timestamp', async () => {
      const result = await registry.call(
        'remove_quick_reply',
        { timestamp: '1711234567890' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).removeQuickReply).toHaveBeenCalledWith('1711234567890');
      const data = JSON.parse(result.content[0].text) as { success: boolean; timestamp: string };
      expect(data.success).toBe(true);
      expect(data.timestamp).toBe('1711234567890');
    });

    it('errors when timestamp is missing', async () => {
      const result = await registry.call('remove_quick_reply', {}, globalSession());
      expect(result.isError).toBe(true);
    });
  });

  // ─── manage_labels ──────────────────────────────────────────────────────

  describe('manage_labels', () => {
    describe('add_label action', () => {
      it('calls addLabel per label with chat_jid', async () => {
        const labels = [{ id: 'lbl-1', name: 'Important', color: 1 }];
        const result = await registry.call(
          'manage_labels',
          { action: 'add_label', chat_jid: '111@s.whatsapp.net', labels },
          globalSession(),
        );
        expect(result.isError).toBeUndefined();
        // Baileys addLabel takes a single label object — called once per label
        expect((mockSock as any).addLabel).toHaveBeenCalledTimes(1);
        expect((mockSock as any).addLabel).toHaveBeenCalledWith('111@s.whatsapp.net', labels[0]);
        const data = JSON.parse(result.content[0].text) as { success: boolean; count: number };
        expect(data.success).toBe(true);
        expect(data.count).toBe(1);
      });

      it('errors when labels array is missing', async () => {
        const result = await registry.call(
          'manage_labels',
          { action: 'add_label', chat_jid: '111@s.whatsapp.net' },
          globalSession(),
        );
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/non-empty labels array/);
      });

      it('errors when labels array is empty', async () => {
        const result = await registry.call(
          'manage_labels',
          { action: 'add_label', chat_jid: '111@s.whatsapp.net', labels: [] },
          globalSession(),
        );
        expect(result.isError).toBe(true);
      });

      it('errors when chat_jid is missing for add_label', async () => {
        const labels = [{ id: 'lbl-1', name: 'Important' }];
        const result = await registry.call(
          'manage_labels',
          { action: 'add_label', labels },
          globalSession(),
        );
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/chat_jid/);
      });
    });

    describe('add_chat_label action', () => {
      it('calls addChatLabel with chat_jid and label_id', async () => {
        const result = await registry.call(
          'manage_labels',
          { action: 'add_chat_label', label_id: 'lbl-1', chat_jid: '111@s.whatsapp.net' },
          globalSession(),
        );
        expect(result.isError).toBeUndefined();
        expect((mockSock as any).addChatLabel).toHaveBeenCalledWith('111@s.whatsapp.net', 'lbl-1');
        const data = JSON.parse(result.content[0].text) as { success: boolean };
        expect(data.success).toBe(true);
      });

      it('errors when label_id is missing', async () => {
        const result = await registry.call(
          'manage_labels',
          { action: 'add_chat_label', chat_jid: '111@s.whatsapp.net' },
          globalSession(),
        );
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/label_id/);
      });

      it('errors when chat_jid is missing', async () => {
        const result = await registry.call(
          'manage_labels',
          { action: 'add_chat_label', label_id: 'lbl-1' },
          globalSession(),
        );
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/chat_jid/);
      });
    });

    describe('remove_chat_label action', () => {
      it('calls removeChatLabel with chat_jid and label_id', async () => {
        const result = await registry.call(
          'manage_labels',
          { action: 'remove_chat_label', label_id: 'lbl-1', chat_jid: '111@s.whatsapp.net' },
          globalSession(),
        );
        expect(result.isError).toBeUndefined();
        expect((mockSock as any).removeChatLabel).toHaveBeenCalledWith('111@s.whatsapp.net', 'lbl-1');
      });

      it('errors when label_id is missing', async () => {
        const result = await registry.call(
          'manage_labels',
          { action: 'remove_chat_label', chat_jid: '111@s.whatsapp.net' },
          globalSession(),
        );
        expect(result.isError).toBe(true);
      });
    });

    describe('add_message_label action', () => {
      it('calls addMessageLabel with all required fields', async () => {
        const result = await registry.call(
          'manage_labels',
          {
            action: 'add_message_label',
            label_id: 'lbl-1',
            chat_jid: '111@s.whatsapp.net',
            message_id: 'msg-abc',
          },
          globalSession(),
        );
        expect(result.isError).toBeUndefined();
        expect((mockSock as any).addMessageLabel).toHaveBeenCalledWith(
          '111@s.whatsapp.net',
          'msg-abc',
          'lbl-1',
        );
        const data = JSON.parse(result.content[0].text) as { success: boolean; message_id: string };
        expect(data.success).toBe(true);
        expect(data.message_id).toBe('msg-abc');
      });

      it('errors when message_id is missing', async () => {
        const result = await registry.call(
          'manage_labels',
          { action: 'add_message_label', label_id: 'lbl-1', chat_jid: '111@s.whatsapp.net' },
          globalSession(),
        );
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/message_id/);
      });
    });

    describe('remove_message_label action', () => {
      it('calls removeMessageLabel with all required fields', async () => {
        const result = await registry.call(
          'manage_labels',
          {
            action: 'remove_message_label',
            label_id: 'lbl-1',
            chat_jid: '111@s.whatsapp.net',
            message_id: 'msg-abc',
          },
          globalSession(),
        );
        expect(result.isError).toBeUndefined();
        expect((mockSock as any).removeMessageLabel).toHaveBeenCalledWith(
          '111@s.whatsapp.net',
          'msg-abc',
          'lbl-1',
        );
      });

      it('errors when message_id is missing', async () => {
        const result = await registry.call(
          'manage_labels',
          { action: 'remove_message_label', label_id: 'lbl-1', chat_jid: '111@s.whatsapp.net' },
          globalSession(),
        );
        expect(result.isError).toBe(true);
      });
    });

    it('rejects invalid action', async () => {
      const result = await registry.call(
        'manage_labels',
        { action: 'invalid_action' },
        globalSession(),
      );
      expect(result.isError).toBe(true);
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerBusinessTools(() => null, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call(
        'manage_labels',
        { action: 'add_label', chat_jid: '111@s.whatsapp.net', labels: [{ id: 'lbl-1', name: 'Test' }] },
        globalSession(),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not connected/);
    });
  });
});
