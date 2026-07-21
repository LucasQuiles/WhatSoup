// src/mcp/tools/voice.ts
// Voice synthesis tools: send_voice_reply (ElevenLabs TTS -> PTT voice note).

import { z } from 'zod';
import type { ToolRegistry } from '../registry.ts';
import { toolError, type SessionContext } from '../types.ts';
import type { Database } from '../../core/database.ts';
import type { RuntimeConnection } from '../../transport/runtime-connection.ts';
import { synthesizeSpeech } from '../../runtimes/chat/providers/elevenlabs.ts';
import { writeTempFile } from '../../core/media-download.ts';
import { createChildLogger } from '../../logger.ts';
import { errorMessage } from '../../lib/error-message.ts';
import {
  isUnsupportedTransportOperation,
  unsupportedToolError,
} from '../../transport/unsupported-operation.ts';

const log = createChildLogger('mcp:voice');

function errorResult(error: string, message: string) {
  return toolError({ error, message });
}

// ---------------------------------------------------------------------------
// Deps interface (Pattern 1 — options-object)
// ---------------------------------------------------------------------------

export interface VoiceDeps {
  connection: RuntimeConnection;
  db: Database;
}

// ---------------------------------------------------------------------------
// Register voice tools
// ---------------------------------------------------------------------------

export function registerVoiceTools(
  registry: ToolRegistry,
  deps: VoiceDeps,
): void {
  const { connection } = deps;

  registry.register({
    name: 'send_voice_reply',
    description:
      'Synthesize text to speech via ElevenLabs and send as a WhatsApp voice note (PTT). Use this to reply with a spoken voice message.',
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'unsafe',
    schema: z.object({
      text: z.string().describe('Text to synthesize and send as a voice note'),
      voice_id: z.string().optional().describe('ElevenLabs voice ID (defaults to instance config)'),
    }),
    handler: async (params, session: SessionContext) => {
      const text = (params['text'] as string).trim();
      const voiceId = params['voice_id'] as string | undefined;

      if (!text) {
        return errorResult('invalid_input', 'Text cannot be empty.');
      }

      const chatJid = session.deliveryJid;
      if (!chatJid) {
        return errorResult('no_target', 'No delivery JID in session context.');
      }

      // Synthesize speech
      let result;
      try {
        result = await synthesizeSpeech(text, voiceId ? { voiceId } : undefined);
      } catch (err) {
        const message = errorMessage(err);
        log.warn({ error: message, textLength: text.length }, 'voice synthesis failed');
        return errorResult('synthesis_failed', message);
      }

      // Write to temp file (for audit trail / replay)
      const ext = result.mimeType.includes('ogg') ? 'ogg' : 'mp3';
      const filePath = writeTempFile(result.buffer, ext);

      // Send as voice note (PTT) — use buffer directly (already in memory)
      try {
        await connection.sendMedia(chatJid, {
          type: 'audio' as const,
          buffer: result.buffer,
          mimetype: result.mimeType.includes('ogg') ? 'audio/ogg; codecs=opus' : result.mimeType,
          ptt: true,
          seconds: result.duration,
        });
      } catch (err) {
        // Voice notes are media; transports with no media support (Signal v1,
        // SMS, iMessage) throw UnsupportedTransportOperationError here. Surface
        // it as a distinct error code so the agent doesn't retry an op the
        // transport will never support.
        if (isUnsupportedTransportOperation(err)) {
          return toolError(unsupportedToolError('sendMedia'));
        }
        const message = errorMessage(err);
        log.error({ err, chatJid }, 'failed to send voice note');
        return errorResult('send_failed', `Failed to send voice note: ${message}`);
      }

      return {
        sent: true,
        duration: result.duration,
        file_path: filePath,
      };
    },
  });
}
