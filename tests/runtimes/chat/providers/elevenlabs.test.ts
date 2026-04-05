import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fetch globally before importing the module
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock execFileSync for API key retrieval (safe - no shell injection)
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn().mockReturnValue(Buffer.from('sk-test-elevenlabs-key\n')),
}));

// Must import after mocks are set up
const { synthesizeSpeech, _testing } = await import(
  '../../../../src/runtimes/chat/providers/elevenlabs.ts'
);

describe('elevenlabs TTS provider', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    _testing.resetBreaker();
  });

  it('calls ElevenLabs API with correct URL and headers', async () => {
    const audioBuffer = new Uint8Array([0x4f, 0x67, 0x67, 0x53]).buffer;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'audio/mpeg' }),
      arrayBuffer: async () => audioBuffer,
    });

    const result = await synthesizeSpeech('Hello world');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/v1/text-to-speech/');
    expect(opts.method).toBe('POST');
    expect(opts.headers['xi-api-key']).toBe('sk-test-elevenlabs-key');
    expect(opts.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(opts.body);
    expect(body.text).toBe('Hello world');

    expect(result.buffer).toBeInstanceOf(Buffer);
    expect(result.buffer.length).toBe(4);
    expect(result.mimeType).toBe('audio/mpeg');
  });

  it('uses custom voiceId and modelId when provided', async () => {
    const audioBuffer = new Uint8Array([1, 2, 3]).buffer;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'audio/mpeg' }),
      arrayBuffer: async () => audioBuffer,
    });

    await synthesizeSpeech('Test', {
      voiceId: 'custom-voice-id',
      modelId: 'eleven_turbo_v2_5',
      stability: 0.8,
      similarityBoost: 0.9,
    });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('custom-voice-id');
    const body = JSON.parse(opts.body);
    expect(body.model_id).toBe('eleven_turbo_v2_5');
    expect(body.voice_settings.stability).toBe(0.8);
    expect(body.voice_settings.similarity_boost).toBe(0.9);
  });

  it('throws on API error (non-200)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      text: async () => 'Rate limit exceeded',
    });

    await expect(synthesizeSpeech('Hello')).rejects.toThrow();
  });

  it('trips circuit breaker after 5 consecutive failures', async () => {
    const makeFailure = () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'Server error',
    });

    // Trip the breaker with 5 failures (each has 1 retry = 10 fetch calls)
    for (let i = 0; i < 5; i++) {
      mockFetch.mockResolvedValueOnce(makeFailure());
      mockFetch.mockResolvedValueOnce(makeFailure()); // retry
      try { await synthesizeSpeech('fail'); } catch { /* expected */ }
    }

    // Next call should fail immediately without calling fetch
    const fetchCountBefore = mockFetch.mock.calls.length;
    await expect(synthesizeSpeech('blocked')).rejects.toThrow(/circuit breaker open/i);
    expect(mockFetch.mock.calls.length).toBe(fetchCountBefore);
  });

  it('resets circuit breaker on success', async () => {
    const makeFailure = () => ({
      ok: false,
      status: 500,
      statusText: 'Error',
      text: async () => 'error',
    });

    // Cause some failures (but not enough to trip)
    for (let i = 0; i < 3; i++) {
      mockFetch.mockResolvedValueOnce(makeFailure());
      mockFetch.mockResolvedValueOnce(makeFailure());
      try { await synthesizeSpeech('fail'); } catch { /* expected */ }
    }

    // Success should reset counter
    const audioBuffer = new Uint8Array([1, 2, 3]).buffer;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'audio/mpeg' }),
      arrayBuffer: async () => audioBuffer,
    });

    const result = await synthesizeSpeech('success');
    expect(result.buffer).toBeInstanceOf(Buffer);
  });
});
