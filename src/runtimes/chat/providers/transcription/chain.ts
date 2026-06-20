import { createChildLogger } from '../../../../logger.ts';
import { fasterWhisperProvider } from './faster-whisper.ts';
import { openAIWhisperProvider } from './openai-whisper.ts';
import { FALLBACK_TEXT, type TranscriptionProvider } from './types.ts';
import { whisperCppProvider } from './whisper-cpp.ts';
import { errorMessage } from '../../../../lib/error-message.ts';

const log = createChildLogger('transcription-chain');

function defaultProviders(): TranscriptionProvider[] {
  return [openAIWhisperProvider, fasterWhisperProvider, whisperCppProvider];
}

export async function transcribeAudioWithProviders(
  buffer: Buffer,
  mimeType: string,
  providers: TranscriptionProvider[],
): Promise<string> {
  for (const provider of providers) {
    if (!provider.isAvailable()) {
      log.debug({ provider: provider.name }, 'transcription provider unavailable');
      continue;
    }

    try {
      const text = await provider.transcribe(buffer, mimeType);
      log.info({ provider: provider.name, textLength: text.length }, 'transcription complete');
      return text;
    } catch (err) {
      const message = errorMessage(err);
      log.warn({ provider: provider.name, error: message }, 'transcription provider failed');
    }
  }

  return FALLBACK_TEXT;
}

export async function transcribeAudio(buffer: Buffer, mimeType: string): Promise<string> {
  return await transcribeAudioWithProviders(buffer, mimeType, defaultProviders());
}

export { FALLBACK_TEXT } from './types.ts';
