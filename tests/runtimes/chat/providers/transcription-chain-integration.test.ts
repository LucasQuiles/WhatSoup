import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Mock node:child_process.spawn so the real withNormalizedAudioFile (file
// writes, tmp dir lifecycle, runCommand control flow) executes end-to-end
// while the underlying ffmpeg/whisper invocations are simulated.
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const spawnMock = vi.fn();
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    accessSync: (
      path: Parameters<typeof actual.accessSync>[0],
      mode?: Parameters<typeof actual.accessSync>[1],
    ) => {
      if (path === '/virtual/bin/ffmpeg' && mode === actual.constants.X_OK) return;
      throw new Error('not executable');
    },
  };
});

const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');

function fakeSuccessfulChild(stdout = '', stderr = ''): EventEmitter {
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    kill: (signal?: string) => boolean;
  };
  child.stdout = Readable.from([Buffer.from(stdout)]);
  child.stderr = Readable.from([Buffer.from(stderr)]);
  child.kill = () => true;
  setImmediate(() => child.emit('close', 0, null));
  return child;
}

const { transcribeAudio, transcribeAudioWithProviders } = await import(
  '../../../../src/runtimes/chat/providers/whisper.ts'
);
const localAudio = await import(
  '../../../../src/runtimes/chat/providers/transcription/local-audio.ts'
);
const { FALLBACK_TEXT } = await import(
  '../../../../src/runtimes/chat/providers/transcription/types.ts'
);
type TranscriptionProvider = import(
  '../../../../src/runtimes/chat/providers/transcription/types.ts'
).TranscriptionProvider;

const FIXTURE_PATH = join(process.cwd(), 'tests/fixtures/audio/hello.ogg');
const STUB_TRANSCRIPT = 'hello whatsoup stub transcript';

function stubProvider(
  name: string,
  opts: { available?: boolean; result?: string; error?: Error } = {},
): TranscriptionProvider {
  return {
    name,
    isAvailable: () => opts.available !== false,
    transcribe: vi.fn(async () => {
      if (opts.error) throw opts.error;
      return opts.result ?? `${name}-transcript`;
    }),
  };
}

// A provider that exercises the real withNormalizedAudioFile flow but with the
// ffmpeg spawn stubbed via the module-level mock above.
function normalizingStubProvider(name: string, result: string): TranscriptionProvider {
  return {
    name,
    isAvailable: () => true,
    transcribe: async (buffer, mimeType) => {
      return await localAudio.withNormalizedAudioFile(buffer, mimeType, async (wavPath) => {
        // Exercise the contract: callback receives a normalized wav path.
        if (!wavPath.endsWith('normalized.wav')) {
          throw new Error(`unexpected wav path: ${wavPath}`);
        }
        return result;
      });
    },
  };
}

describe('transcription chain integration (CI-runnable, stub providers)', () => {
  it('routes through the public transcribeAudio entry when defaults are unavailable', async () => {
    // The default providers (openai/faster-whisper/whisper.cpp) are unavailable
    // in a clean CI env, so transcribeAudio should return the fallback text.
    delete process.env.OPENAI_API_KEY;
    const buffer = actualFs.existsSync(FIXTURE_PATH)
      ? await readFile(FIXTURE_PATH)
      : Buffer.from('synthetic-audio-bytes');

    const result = await transcribeAudio(buffer, 'audio/ogg');
    expect(result).toBe(FALLBACK_TEXT);
  });

  it('exercises the shared chain with deterministic stub providers (priority order)', async () => {
    const primary = stubProvider('primary', { result: STUB_TRANSCRIPT });
    const secondary = stubProvider('secondary', { result: 'should-not-run' });

    const result = await transcribeAudioWithProviders(
      Buffer.from('synthetic-audio'),
      'audio/ogg',
      [primary, secondary],
    );

    expect(result).toBe(STUB_TRANSCRIPT);
    expect(primary.transcribe).toHaveBeenCalledOnce();
    expect(secondary.transcribe).not.toHaveBeenCalled();
  });

  it('falls through unavailable providers and recovers from failures', async () => {
    const offline = stubProvider('offline', { available: false });
    const broken = stubProvider('broken', { error: new Error('whisper crashed') });
    const recovery = stubProvider('recovery', { result: STUB_TRANSCRIPT });

    const result = await transcribeAudioWithProviders(
      Buffer.from('synthetic-audio'),
      'audio/ogg',
      [offline, broken, recovery],
    );

    expect(result).toBe(STUB_TRANSCRIPT);
    expect(offline.transcribe).not.toHaveBeenCalled();
    expect(broken.transcribe).toHaveBeenCalledOnce();
    expect(recovery.transcribe).toHaveBeenCalledOnce();
  });

  it('drives withNormalizedAudioFile end-to-end with ffmpeg stubbed out', async () => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => fakeSuccessfulChild());
    const originalPath = process.env.PATH;
    process.env.PATH = '/virtual/bin';

    try {
      const buffer = actualFs.existsSync(FIXTURE_PATH)
        ? await readFile(FIXTURE_PATH)
        : Buffer.from('synthetic-audio-bytes');

      const normalizing = normalizingStubProvider('normalizing', STUB_TRANSCRIPT);
      const result = await transcribeAudioWithProviders(buffer, 'audio/ogg', [normalizing]);

      expect(result).toBe(STUB_TRANSCRIPT);
      // The stubbed ffmpeg invocation should have been called exactly once with
      // the canonical normalization args (16kHz mono wav).
      expect(spawnMock).toHaveBeenCalledOnce();
      const [binary, args] = spawnMock.mock.calls[0] as [string, string[], unknown];
      expect(binary).toBe('/virtual/bin/ffmpeg');
      expect(args).toContain('-ar');
      expect(args).toContain('16000');
      expect(args).toContain('-ac');
      expect(args).toContain('1');
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it('returns the fallback text when every injected provider is unavailable or failing', async () => {
    const offline = stubProvider('offline', { available: false });
    const broken = stubProvider('broken', { error: new Error('boom') });

    const result = await transcribeAudioWithProviders(
      Buffer.from('synthetic-audio'),
      'audio/ogg',
      [offline, broken],
    );

    expect(result).toBe(FALLBACK_TEXT);
  });
});
