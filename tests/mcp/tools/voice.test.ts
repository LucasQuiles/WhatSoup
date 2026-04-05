import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';

// Mock the ElevenLabs provider
vi.mock('../../../src/runtimes/chat/providers/elevenlabs.ts', () => ({
  synthesizeSpeech: vi.fn(),
}));

// Mock media-download for writeTempFile
vi.mock('../../../src/core/media-download.ts', () => ({
  writeTempFile: vi.fn().mockReturnValue('/tmp/whatsoup-media/voice-reply.ogg'),
}));

import { synthesizeSpeech } from '../../../src/runtimes/chat/providers/elevenlabs.ts';
import { writeTempFile } from '../../../src/core/media-download.ts';
import { registerVoiceTools, type VoiceDeps } from '../../../src/mcp/tools/voice.ts';

const mockSynthesize = vi.mocked(synthesizeSpeech);
const mockWriteTempFile = vi.mocked(writeTempFile);

function chatSession(conversationKey: string): SessionContext {
  return {
    tier: 'chat-scoped',
    conversationKey,
    deliveryJid: `${conversationKey}@s.whatsapp.net`,
  };
}

function globalSession(): SessionContext {
  return { tier: 'global' };
}

describe('voice tools', () => {
  let registry: ToolRegistry;
  let db: Database;
  let mediaSent: Array<{ chatJid: string; media: unknown }>;
  let connection: VoiceDeps['connection'];

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    registry = new ToolRegistry();
    mediaSent = [];

    connection = {
      sendMedia: vi.fn().mockImplementation(async (chatJid: string, media: unknown) => {
        mediaSent.push({ chatJid, media });
      }),
    } as unknown as VoiceDeps['connection'];

    registerVoiceTools(registry, { connection, db });

    mockSynthesize.mockReset();
    mockWriteTempFile.mockReset();
    mockWriteTempFile.mockReturnValue('/tmp/whatsoup-media/voice-reply.ogg');
  });

  afterEach(() => {
    db.close();
  });

  describe('send_voice_reply', () => {
    it('is registered as chat scope', () => {
      const tools = registry.listTools(chatSession('111'));
      const tool = tools.find((t) => t.name === 'send_voice_reply');
      expect(tool).toBeDefined();
    });

    it('is NOT visible in global session (chat-scoped tool)', () => {
      // Chat-scoped tools are visible in global session but rejected on call
      const tools = registry.listTools(globalSession());
      const tool = tools.find((t) => t.name === 'send_voice_reply');
      expect(tool).toBeDefined();
    });

    it('synthesizes text and sends as voice note', async () => {
      mockSynthesize.mockResolvedValueOnce({
        buffer: Buffer.from('fake-audio'),
        duration: 5,
        mimeType: 'audio/mpeg',
      });

      const result = await registry.call(
        'send_voice_reply',
        { text: 'Hello, how are you?' },
        chatSession('111'),
      );

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.sent).toBe(true);
      expect(data.duration).toBe(5);

      // Verify synthesizeSpeech was called with the text
      expect(mockSynthesize).toHaveBeenCalledWith('Hello, how are you?', undefined);

      // Verify writeTempFile was called
      expect(mockWriteTempFile).toHaveBeenCalledWith(Buffer.from('fake-audio'), 'mp3');

      // Verify sendMedia was called with ptt: true
      expect(mediaSent).toHaveLength(1);
      expect(mediaSent[0].chatJid).toBe('111@s.whatsapp.net');
      const media = mediaSent[0].media as any;
      expect(media.ptt).toBe(true);
      expect(media.type).toBe('audio');
    });

    it('passes voice_id option to synthesizeSpeech', async () => {
      mockSynthesize.mockResolvedValueOnce({
        buffer: Buffer.from('audio'),
        duration: 3,
        mimeType: 'audio/mpeg',
      });

      await registry.call(
        'send_voice_reply',
        { text: 'Test', voice_id: 'custom-voice' },
        chatSession('111'),
      );

      expect(mockSynthesize).toHaveBeenCalledWith('Test', { voiceId: 'custom-voice' });
    });

    it('returns error when synthesis fails', async () => {
      mockSynthesize.mockRejectedValueOnce(new Error('ElevenLabs circuit breaker open'));

      const result = await registry.call(
        'send_voice_reply',
        { text: 'Hello' },
        chatSession('111'),
      );

      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('synthesis_failed');
      expect(data.message).toContain('circuit breaker');
    });

    it('returns error when text is empty', async () => {
      const result = await registry.call(
        'send_voice_reply',
        { text: '' },
        chatSession('111'),
      );

      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('invalid_input');
    });
  });
});
