import { describe, it, expect, vi } from 'vitest';
import type { TranscriptionProvider } from '../../../../src/runtimes/chat/providers/transcription/types.ts';
import { FALLBACK_TEXT, transcribeAudioWithProviders } from '../../../../src/runtimes/chat/providers/transcription/chain.ts';

function provider(name: string, opts: {
  available?: boolean;
  result?: string;
  error?: Error;
} = {}): TranscriptionProvider {
  return {
    name,
    isAvailable: () => opts.available !== false,
    transcribe: vi.fn(async () => {
      if (opts.error) throw opts.error;
      return opts.result ?? `${name} transcript`;
    }),
  };
}

describe('transcription chain', () => {
  it('returns the first successful transcript', async () => {
    const openai = provider('openai', { result: 'cloud transcript' });
    const local = provider('local', { result: 'local transcript' });

    const result = await transcribeAudioWithProviders(Buffer.from('abc'), 'audio/ogg', [openai, local]);

    expect(result).toBe('cloud transcript');
    expect(openai.transcribe).toHaveBeenCalledOnce();
    expect(local.transcribe).not.toHaveBeenCalled();
  });

  it('skips unavailable providers and uses the next one', async () => {
    const openai = provider('openai', { available: false });
    const local = provider('local', { result: 'local transcript' });

    const result = await transcribeAudioWithProviders(Buffer.from('abc'), 'audio/ogg', [openai, local]);

    expect(result).toBe('local transcript');
    expect(local.transcribe).toHaveBeenCalledOnce();
  });

  it('falls through after provider failure', async () => {
    const openai = provider('openai', { error: new Error('boom') });
    const local = provider('local', { result: 'recovered transcript' });

    const result = await transcribeAudioWithProviders(Buffer.from('abc'), 'audio/ogg', [openai, local]);

    expect(result).toBe('recovered transcript');
    expect(openai.transcribe).toHaveBeenCalledOnce();
    expect(local.transcribe).toHaveBeenCalledOnce();
  });

  it('returns an empty transcript immediately without cascading', async () => {
    const openai = provider('openai', { result: '' });
    const local = provider('local', { result: 'should not be used' });

    const result = await transcribeAudioWithProviders(Buffer.from('abc'), 'audio/ogg', [openai, local]);

    expect(result).toBe('');
    expect(openai.transcribe).toHaveBeenCalledOnce();
    expect(local.transcribe).not.toHaveBeenCalled();
  });

  it('returns the fallback text when every provider is unavailable or fails', async () => {
    const openai = provider('openai', { available: false });
    const local = provider('local', { error: new Error('offline') });

    const result = await transcribeAudioWithProviders(Buffer.from('abc'), 'audio/ogg', [openai, local]);

    expect(result).toBe(FALLBACK_TEXT);
  });
});
