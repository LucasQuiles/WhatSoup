import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { registerCallTools } from '../../../src/mcp/tools/calls.ts';
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
    rejectCall: vi.fn().mockResolvedValue(undefined),
  } as unknown as WhatsAppSocket;
}

describe('call tools', () => {
  let registry: ToolRegistry;
  let mockSock: WhatsAppSocket;

  beforeEach(() => {
    mockSock = makeMockSock();
    registry = new ToolRegistry();
    registerCallTools(() => mockSock, (tool) => registry.register(tool));
  });

  describe('reject_call', () => {
    it('is registered as global scope', () => {
      const tools = registry.listTools(globalSession());
      expect(tools.find((t) => t.name === 'reject_call')).toBeDefined();
    });

    it('is NOT visible in chat-scoped session', () => {
      const tools = registry.listTools(chatSession('111'));
      expect(tools.find((t) => t.name === 'reject_call')).toBeUndefined();
    });

    it('is rejected when called from a chat-scoped session', async () => {
      const result = await registry.call(
        'reject_call',
        { call_id: 'call123', call_from: '111@s.whatsapp.net' },
        chatSession('111'),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not available in a chat-scoped session/);
    });

    it('calls sock.rejectCall with correct args', async () => {
      const result = await registry.call(
        'reject_call',
        { call_id: 'call123', call_from: '111@s.whatsapp.net' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).rejectCall).toHaveBeenCalledWith('call123', '111@s.whatsapp.net');
    });

    it('returns success with call details', async () => {
      const result = await registry.call(
        'reject_call',
        { call_id: 'call123', call_from: '111@s.whatsapp.net' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as {
        success: boolean;
        callId: string;
        callFrom: string;
      };
      expect(data.success).toBe(true);
      expect(data.callId).toBe('call123');
      expect(data.callFrom).toBe('111@s.whatsapp.net');
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerCallTools(() => null, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call(
        'reject_call',
        { call_id: 'call123', call_from: '111@s.whatsapp.net' },
        globalSession(),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not connected/);
    });

    it('requires call_id (schema validation)', async () => {
      const result = await registry.call(
        'reject_call',
        { call_from: '111@s.whatsapp.net' },
        globalSession(),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Invalid parameters/);
    });
  });
});
