// DRAFT — intended repo path: tests/mcp/tools/voice.test.ts (EXTEND existing file)
// These tests target the uncovered branches in src/mcp/tools/voice.ts:
//   - line 58-59: !chatJid branch (stmt 10, branch 1[0])
//   - line 67 branch 3[1]: err NOT instanceof Error (non-Error throw from synthesizeSpeech)
//   - line 73 branch 4[0]: mimeType.includes('ogg') => true => ext = 'ogg'
//   - line 81 branch 5[0]: mimeType.includes('ogg') => true => mimetype = 'audio/ogg; codecs=opus'
//   - line 85-88: sendMedia throws (stmts 20-22, branch 6[0]/6[1])
//
// Merge these describe blocks into the existing voice.test.ts file's
// 'send_voice_reply' describe.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';

vi.mock('../../../src/runtimes/chat/providers/elevenlabs.ts', () => ({
  synthesizeSpeech: vi.fn(),
}));

vi.mock('../../../src/core/media-download.ts', () => ({
  writeTempFile: vi.fn().mockReturnValue('/tmp/whatsoup-media/voice-reply.ogg'),
}));

import { synthesizeSpeech } from '../../../src/runtimes/chat/providers/elevenlabs.ts';
import { writeTempFile } from '../../../src/core/media-download.ts';
import { registerVoiceTools, type VoiceDeps } from '../../../src/mcp/tools/voice.ts';

const mockSynthesize = vi.mocked(synthesizeSpeech);
const mockWriteTempFile = vi.mocked(writeTempFile);

function chatSessionWithJid(conversationKey: string): SessionContext {
  return {
    tier: 'chat-scoped',
    conversationKey,
    deliveryJid: `${conversationKey}@s.whatsapp.net`,
  };
}

/** Chat-scoped session with NO deliveryJid (covers !chatJid branch) */
function chatSessionNoJid(): SessionContext {
  return { tier: 'chat-scoped', conversationKey: 'conv1' };
}

function globalSession(): SessionContext {
  return { tier: 'global' };
}

describe('voice tools — coverage gaps', () => {
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
    // -----------------------------------------------------------------------
    // Branch: !chatJid (line 58-59, stmt 10, branch 1[0])
    // The injected targetMode handler receives chatJid from session.deliveryJid.
    // A chat-scoped session with no deliveryJid should trigger the guard.
    // -----------------------------------------------------------------------
    // NOTE: the tool's own no_target branch is fronted by registry-level scope
    // rejection for a chat session lacking a delivery target (returns a plain-text
    // error, not the tool's JSON), so a direct unit test of that branch is omitted.

    // -----------------------------------------------------------------------
    // Branch: non-Error thrown from synthesizeSpeech (line 67, branch 3[1])
    // err is NOT instanceof Error → String(err) path
    // -----------------------------------------------------------------------
    it('coerces non-Error synthesis failure to string', async () => {
      // Throw a plain string — not an Error instance
      mockSynthesize.mockRejectedValueOnce('ElevenLabs rate limit hit');

      const result = await registry.call(
        'send_voice_reply',
        { text: 'Hello' },
        chatSessionWithJid('111'),
      );

      const data = JSON.parse(result.content[0].text) as { error: string; message: string };
      expect(result.isError).toBe(true);
      expect(data.error).toBe('synthesis_failed');
      expect(data.message).toBe('ElevenLabs rate limit hit');
    });

    // -----------------------------------------------------------------------
    // Branch: ogg mimeType (lines 73, 81, branch 4[0] and 5[0])
    // result.mimeType contains 'ogg' → ext = 'ogg', mimetype = 'audio/ogg; codecs=opus'
    // -----------------------------------------------------------------------
    it('uses ogg extension and opus mimetype when synthesized mimeType includes ogg', async () => {
      mockSynthesize.mockResolvedValueOnce({
        buffer: Buffer.from('fake-ogg-data'),
        duration: 4,
        mimeType: 'audio/ogg',
      });

      const result = await registry.call(
        'send_voice_reply',
        { text: 'Ogg test' },
        chatSessionWithJid('222'),
      );

      expect(result.isError).toBeUndefined();

      // writeTempFile should be called with 'ogg' extension
      expect(mockWriteTempFile).toHaveBeenCalledWith(Buffer.from('fake-ogg-data'), 'ogg');

      // sendMedia should use 'audio/ogg; codecs=opus' mimetype
      expect(mediaSent).toHaveLength(1);
      const media = mediaSent[0].media as Record<string, unknown>;
      expect(media.mimetype).toBe('audio/ogg; codecs=opus');
      expect(media.ptt).toBe(true);
    });

    // -----------------------------------------------------------------------
    // Branch: sendMedia throws an Error (stmts 20-22, branch 6[0])
    // sendMedia rejects with an Error instance
    // -----------------------------------------------------------------------
    it('returns send_failed error when sendMedia throws an Error', async () => {
      mockSynthesize.mockResolvedValueOnce({
        buffer: Buffer.from('audio'),
        duration: 3,
        mimeType: 'audio/mpeg',
      });

      (connection.sendMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Socket closed unexpectedly'),
      );

      const result = await registry.call(
        'send_voice_reply',
        { text: 'Send fail test' },
        chatSessionWithJid('333'),
      );

      const data = JSON.parse(result.content[0].text) as { error: string; message: string };
      expect(result.isError).toBe(true);
      expect(data.error).toBe('send_failed');
      expect(data.message).toContain('Socket closed unexpectedly');
    });

    // -----------------------------------------------------------------------
    // Branch: sendMedia throws a non-Error (branch 6[1])
    // sendMedia rejects with a plain string
    // -----------------------------------------------------------------------
    it('returns send_failed error when sendMedia throws a non-Error', async () => {
      mockSynthesize.mockResolvedValueOnce({
        buffer: Buffer.from('audio'),
        duration: 3,
        mimeType: 'audio/mpeg',
      });

      (connection.sendMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce('ECONNRESET');

      const result = await registry.call(
        'send_voice_reply',
        { text: 'Non-error send fail' },
        chatSessionWithJid('444'),
      );

      const data = JSON.parse(result.content[0].text) as { error: string; message: string };
      expect(result.isError).toBe(true);
      expect(data.error).toBe('send_failed');
      expect(data.message).toContain('ECONNRESET');
    });
  });
});
