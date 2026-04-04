import { describe, it, expect, vi, beforeEach } from 'vitest';

const FALLBACK_TEXT = '[🎤 Voice note received — transcription unavailable]';

// Use vi.hoisted so the mock fn is available inside vi.mock factory (which is hoisted)
const { mockTranscriptionsCreate } = vi.hoisted(() => ({
  mockTranscriptionsCreate: vi.fn(),
}));

vi.mock('openai', () => {
  const MockOpenAI = vi.fn();
  return { default: MockOpenAI };
});

vi.mock('../../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import OpenAI from 'openai';
// Import AFTER mocks are registered
import { transcribeAudio } from '../../../../src/runtimes/chat/providers/whisper.ts';

function makeAudioBuffer(): Buffer {
  return Buffer.from([0x00, 0x01, 0x02, 0x03]);
}

describe('transcribeAudio (Whisper)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Wire up the mock constructor implementation each time so the lazy
    // singleton (on first construction) gets the correct audio client shape.
    vi.mocked(OpenAI).mockImplementation(function (this: OpenAI) {
      (this as unknown as { audio: unknown }).audio = {
        transcriptions: { create: mockTranscriptionsCreate },
      };
    });
  });

  // ── Positive tests ─────────────────────────────────────────────────────────

  it('returns transcription text on success', async () => {
    mockTranscriptionsCreate.mockResolvedValueOnce({ text: 'Hello world' });
    const result = await transcribeAudio(makeAudioBuffer(), 'audio/ogg');
    expect(result).toBe('Hello world');
  });

  it('returns exact transcription text without modification', async () => {
    const verbatim = 'The quick brown fox jumps over the lazy dog.';
    mockTranscriptionsCreate.mockResolvedValueOnce({ text: verbatim });
    const result = await transcribeAudio(makeAudioBuffer(), 'audio/webm');
    expect(result).toBe(verbatim);
  });

  // ── Negative tests ────────────────────────────────────────────────────────

  it('returns fallback text on AbortError (timeout)', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    mockTranscriptionsCreate.mockRejectedValueOnce(abortErr);
    const result = await transcribeAudio(makeAudioBuffer(), 'audio/ogg');
    expect(result).toBe(FALLBACK_TEXT);
  });

  it('returns fallback text on API error', async () => {
    mockTranscriptionsCreate.mockRejectedValueOnce(new Error('Internal Server Error'));
    const result = await transcribeAudio(makeAudioBuffer(), 'audio/mp4');
    expect(result).toBe(FALLBACK_TEXT);
  });

  it('fallback text does not contain stack trace or error details', async () => {
    mockTranscriptionsCreate.mockRejectedValueOnce(new Error('some internal error details'));
    const result = await transcribeAudio(makeAudioBuffer(), 'audio/ogg');
    expect(result).not.toContain('some internal error details');
    expect(result).not.toContain('Error');
    expect(result).not.toContain('at ');
  });
});
