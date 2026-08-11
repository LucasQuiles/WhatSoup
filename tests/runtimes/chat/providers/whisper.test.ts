import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockTranscriptionsCreate } = vi.hoisted(() => ({
  mockTranscriptionsCreate: vi.fn(),
}));

vi.mock('openai', () => {
  const MockOpenAI = vi.fn();
  return { default: MockOpenAI };
});

vi.mock('../../../../src/logger.ts', async () => (await import('../../../helpers/logger-mock.ts')).loggerMock());

import OpenAI from 'openai';
import { transcribeAudio, FALLBACK_TEXT } from '../../../../src/runtimes/chat/providers/whisper.ts';
import { _testing, transcribeWithOpenAI } from '../../../../src/runtimes/chat/providers/transcription/openai-whisper.ts';

function makeAudioBuffer(): Buffer {
  return Buffer.from([0x00, 0x01, 0x02, 0x03]);
}

describe('transcribeWithOpenAI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = 'sk-test';
    _testing.reset();
    vi.mocked(OpenAI).mockImplementation(function (this: Record<string, unknown>) {
      this.audio = {
        transcriptions: { create: mockTranscriptionsCreate },
      };
    } as unknown as () => OpenAI);
  });

  it('re-exports chain symbols through the shim path', () => {
    expect(typeof transcribeAudio).toBe('function');
    expect(FALLBACK_TEXT).toContain('unavailable');
  });

  it('returns transcription text on success', async () => {
    mockTranscriptionsCreate.mockResolvedValueOnce({ text: 'Hello world' });
    const result = await transcribeWithOpenAI(makeAudioBuffer(), 'audio/ogg');
    expect(result).toBe('Hello world');
  });

  it('returns exact transcription text without modification', async () => {
    const verbatim = 'The quick brown fox jumps over the lazy dog.';
    mockTranscriptionsCreate.mockResolvedValueOnce({ text: verbatim });
    const result = await transcribeWithOpenAI(makeAudioBuffer(), 'audio/webm');
    expect(result).toBe(verbatim);
  });

  it('throws on AbortError (timeout) after a single attempt', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    mockTranscriptionsCreate.mockRejectedValueOnce(abortErr);
    await expect(transcribeWithOpenAI(makeAudioBuffer(), 'audio/ogg')).rejects.toThrow('aborted');
    expect(mockTranscriptionsCreate).toHaveBeenCalledOnce();
  });

  it('throws on API error after a single attempt', async () => {
    mockTranscriptionsCreate.mockRejectedValueOnce(new Error('Internal Server Error'));
    await expect(transcribeWithOpenAI(makeAudioBuffer(), 'audio/mp4')).rejects.toThrow('Internal Server Error');
    expect(mockTranscriptionsCreate).toHaveBeenCalledOnce();
  });

  it('does not leak stack trace details through the fallback constant', async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(transcribeWithOpenAI(makeAudioBuffer(), 'audio/ogg')).rejects.toThrow('OPENAI_API_KEY not set');
    expect(FALLBACK_TEXT).not.toContain('Error');
    expect(FALLBACK_TEXT).not.toContain('at ');
  });
});
