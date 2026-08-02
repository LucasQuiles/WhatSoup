import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as nodeFs from 'node:fs';

type FsModule = typeof nodeFs;

const FAKE_PYTHON = '/fake/venv/bin/python3';
const FAKE_WHISPER_CLI = '/fake/bin/whisper-cli';
const FAKE_MODEL = '/fake/model.bin';
const FAKE_FASTER_MODEL = 'large-v3-turbo';

const {
  runCommandMock,
  withNormalizedAudioFileMock,
  resolveBinaryPathMock,
  existsSyncMock,
} = vi.hoisted(() => {
  process.env.WHATSOUP_FASTER_WHISPER_PYTHON = '/fake/venv/bin/python3';
  process.env.WHATSOUP_FASTER_WHISPER_MODEL = 'large-v3-turbo';
  process.env.WHATSOUP_WHISPER_CPP_BIN = '/fake/bin/whisper-cli';
  process.env.WHATSOUP_WHISPER_CPP_MODEL = '/fake/model.bin';
  return {
    runCommandMock: vi.fn(),
    withNormalizedAudioFileMock: vi.fn(),
    resolveBinaryPathMock: vi.fn(),
    existsSyncMock: vi.fn(),
  };
});

vi.mock('../../../../../src/runtimes/chat/providers/transcription/local-audio.ts', () => ({
  runCommand: runCommandMock,
  withNormalizedAudioFile: withNormalizedAudioFileMock,
  resolveBinaryPath: resolveBinaryPathMock,
}));

vi.mock('node:fs', async (importOriginal: () => Promise<FsModule>) => {
  const actual = await importOriginal();
  return {
    ...actual,
    existsSync: (path: string) => existsSyncMock(path),
  };
});

vi.mock('../../../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  transcribeWithFasterWhisper,
  fasterWhisperProvider,
} from '../../../../../src/runtimes/chat/providers/transcription/faster-whisper.ts';
import {
  transcribeWithWhisperCpp,
  whisperCppProvider,
} from '../../../../../src/runtimes/chat/providers/transcription/whisper-cpp.ts';

const audioBuffer = Buffer.from('fake-audio-bytes');

beforeEach(() => {
  runCommandMock.mockReset();
  withNormalizedAudioFileMock.mockReset();
  withNormalizedAudioFileMock.mockImplementation(
    async (_buffer: Buffer, _mime: string, cb: (wav: string) => Promise<string>) =>
      cb('/tmp/normalized.wav'),
  );
  resolveBinaryPathMock.mockReset();
  existsSyncMock.mockReset();
  process.env.WHATSOUP_FASTER_WHISPER_PYTHON = FAKE_PYTHON;
  process.env.WHATSOUP_FASTER_WHISPER_MODEL = FAKE_FASTER_MODEL;
  process.env.WHATSOUP_WHISPER_CPP_BIN = FAKE_WHISPER_CLI;
  process.env.WHATSOUP_WHISPER_CPP_MODEL = FAKE_MODEL;
});

afterEach(() => {
  delete process.env.WHATSOUP_FASTER_WHISPER_PYTHON;
  delete process.env.WHATSOUP_FASTER_WHISPER_MODEL;
  delete process.env.WHATSOUP_WHISPER_CPP_BIN;
  delete process.env.WHATSOUP_WHISPER_CPP_MODEL;
});

describe('transcribeWithFasterWhisper', () => {
  it('throws when no python binary is resolvable (env unset, venv missing)', async () => {
    delete process.env.WHATSOUP_FASTER_WHISPER_PYTHON;
    existsSyncMock.mockReturnValue(false);
    await expect(transcribeWithFasterWhisper(audioBuffer, 'audio/ogg')).rejects.toThrow(
      'faster-whisper python runtime is not installed',
    );
  });

  it('throws when wrapper script is missing', async () => {
    existsSyncMock.mockImplementation((p: string) => p === FAKE_PYTHON);
    await expect(transcribeWithFasterWhisper(audioBuffer, 'audio/ogg')).rejects.toThrow(
      /faster-whisper wrapper missing/,
    );
  });

  it('returns trimmed text on a happy-path runCommand result', async () => {
    existsSyncMock.mockReturnValue(true);
    runCommandMock.mockResolvedValueOnce({ stdout: JSON.stringify({ text: '  hello world  ' }) });

    const result = await transcribeWithFasterWhisper(audioBuffer, 'audio/ogg');

    expect(result).toBe('hello world');
    expect(withNormalizedAudioFileMock).toHaveBeenCalledWith(
      audioBuffer,
      'audio/ogg',
      expect.any(Function),
    );
    expect(runCommandMock).toHaveBeenCalledTimes(1);
    const [bin, args, timeout] = runCommandMock.mock.calls[0] as [string, string[], number];
    expect(bin).toBe(FAKE_PYTHON);
    expect(args).toEqual([
      expect.stringMatching(/scripts\/transcribe-faster-whisper\.py$/),
      '--input',
      '/tmp/normalized.wav',
      '--model',
      'large-v3-turbo',
      '--model-dir',
      expect.stringContaining('/.local/share/whatsoup/models/faster-whisper'),
    ]);
    expect(timeout).toBe(30_000);
  });

  it('throws when the model returns an empty transcript', async () => {
    existsSyncMock.mockReturnValue(true);
    runCommandMock.mockResolvedValueOnce({ stdout: JSON.stringify({ text: '   ' }) });
    await expect(transcribeWithFasterWhisper(audioBuffer, 'audio/ogg')).rejects.toThrow(
      /empty transcript/,
    );
  });

  it('throws a descriptive error (not an opaque SyntaxError) when stdout is not valid JSON', async () => {
    existsSyncMock.mockReturnValue(true);
    runCommandMock.mockResolvedValueOnce({ stdout: 'Traceback (most recent call last):\n  RuntimeError: model load failed' });
    await expect(transcribeWithFasterWhisper(audioBuffer, 'audio/ogg')).rejects.toThrow(
      /faster-whisper produced non-JSON output: Traceback \(most recent call last\)/,
    );
  });

  it('propagates errors thrown by runCommand', async () => {
    existsSyncMock.mockReturnValue(true);
    runCommandMock.mockRejectedValueOnce(new Error('subprocess exited 1'));
    await expect(transcribeWithFasterWhisper(audioBuffer, 'audio/ogg')).rejects.toThrow(
      'subprocess exited 1',
    );
  });

  it('honors WHATSOUP_FASTER_WHISPER_MODEL env override on cold module load', async () => {
    process.env.WHATSOUP_FASTER_WHISPER_MODEL = 'tiny.en';
    existsSyncMock.mockReturnValue(true);
    runCommandMock.mockResolvedValueOnce({ stdout: JSON.stringify({ text: 'x' }) });

    vi.resetModules();
    const { transcribeWithFasterWhisper: transcribeWithOverride } = await import(
      '../../../../../src/runtimes/chat/providers/transcription/faster-whisper.ts'
    );

    await expect(transcribeWithOverride(audioBuffer, 'audio/ogg')).resolves.toBe('x');
    const [, args] = runCommandMock.mock.calls[0] as [string, string[], number];
    expect(args).toEqual([
      expect.stringMatching(/scripts\/transcribe-faster-whisper\.py$/),
      '--input',
      '/tmp/normalized.wav',
      '--model',
      'tiny.en',
      '--model-dir',
      expect.stringContaining('/.local/share/whatsoup/models/faster-whisper'),
    ]);
  });
});

describe('fasterWhisperProvider', () => {
  it('reports availability when both python and script exist', () => {
    existsSyncMock.mockReturnValue(true);
    expect(fasterWhisperProvider.isAvailable()).toBe(true);
  });

  it('reports unavailable when python is missing', () => {
    delete process.env.WHATSOUP_FASTER_WHISPER_PYTHON;
    existsSyncMock.mockReturnValue(false);
    expect(fasterWhisperProvider.isAvailable()).toBe(false);
  });

  it('reports unavailable when script is missing', () => {
    existsSyncMock.mockImplementation((p: string) => p === FAKE_PYTHON);
    expect(fasterWhisperProvider.isAvailable()).toBe(false);
  });

  it('has the documented provider name', () => {
    expect(fasterWhisperProvider.name).toBe('faster-whisper');
  });
});

describe('transcribeWithWhisperCpp', () => {
  it('throws when whisper-cli is not resolvable', async () => {
    resolveBinaryPathMock.mockReturnValue(null);
    existsSyncMock.mockReturnValue(true);
    await expect(transcribeWithWhisperCpp(audioBuffer, 'audio/ogg')).rejects.toThrow(
      'whisper-cli is not installed',
    );
  });

  it('throws when the model file is missing', async () => {
    resolveBinaryPathMock.mockReturnValue(FAKE_WHISPER_CLI);
    existsSyncMock.mockReturnValue(false);
    await expect(transcribeWithWhisperCpp(audioBuffer, 'audio/ogg')).rejects.toThrow(
      /whisper.cpp model missing/,
    );
  });

  it('returns cleaned transcript on a happy-path runCommand result', async () => {
    resolveBinaryPathMock.mockReturnValue(FAKE_WHISPER_CLI);
    existsSyncMock.mockReturnValue(true);
    runCommandMock.mockResolvedValueOnce({
      stdout: '[00:00:00.000 --> 00:00:02.000]  hello\n[00:00:02.000 --> 00:00:04.000]  world\n',
    });

    const result = await transcribeWithWhisperCpp(audioBuffer, 'audio/ogg');

    expect(result).toBe('hello world');
    expect(withNormalizedAudioFileMock).toHaveBeenCalledWith(
      audioBuffer,
      'audio/ogg',
      expect.any(Function),
    );
    expect(runCommandMock).toHaveBeenCalledTimes(1);
    const [bin, args, timeout] = runCommandMock.mock.calls[0] as [string, string[], number];
    expect(bin).toBe(FAKE_WHISPER_CLI);
    expect(args).toEqual([
      '-m',
      FAKE_MODEL,
      '-f',
      '/tmp/normalized.wav',
      '-l',
      'auto',
      '-nt',
      '-np',
    ]);
    expect(timeout).toBe(45_000);
  });

  it('honors WHATSOUP_WHISPER_CPP_MODEL env override on cold module load', async () => {
    process.env.WHATSOUP_WHISPER_CPP_MODEL = '/custom/whisper-model.bin';
    resolveBinaryPathMock.mockReturnValue(FAKE_WHISPER_CLI);
    existsSyncMock.mockReturnValue(true);
    runCommandMock.mockResolvedValueOnce({ stdout: 'custom model transcript' });

    vi.resetModules();
    const { transcribeWithWhisperCpp: transcribeWithOverride } = await import(
      '../../../../../src/runtimes/chat/providers/transcription/whisper-cpp.ts'
    );

    await expect(transcribeWithOverride(audioBuffer, 'audio/ogg')).resolves.toBe(
      'custom model transcript',
    );
    const [, args] = runCommandMock.mock.calls[0] as [string, string[], number];
    expect(args).toEqual([
      '-m',
      '/custom/whisper-model.bin',
      '-f',
      '/tmp/normalized.wav',
      '-l',
      'auto',
      '-nt',
      '-np',
    ]);
  });

  it('throws when the transcript is empty after cleanup', async () => {
    resolveBinaryPathMock.mockReturnValue(FAKE_WHISPER_CLI);
    existsSyncMock.mockReturnValue(true);
    runCommandMock.mockResolvedValueOnce({ stdout: '   \n   \n' });
    await expect(transcribeWithWhisperCpp(audioBuffer, 'audio/ogg')).rejects.toThrow(
      /empty transcript/,
    );
  });

  it('strips timestamp brackets from each line during cleanup', async () => {
    resolveBinaryPathMock.mockReturnValue(FAKE_WHISPER_CLI);
    existsSyncMock.mockReturnValue(true);
    runCommandMock.mockResolvedValueOnce({
      stdout: '[00:00:00.000 --> 00:00:01.000] alpha\n[00:00:01.000 --> 00:00:02.000] beta\n',
    });
    const result = await transcribeWithWhisperCpp(audioBuffer, 'audio/ogg');
    expect(result).toBe('alpha beta');
  });

  it('propagates errors thrown by runCommand', async () => {
    resolveBinaryPathMock.mockReturnValue(FAKE_WHISPER_CLI);
    existsSyncMock.mockReturnValue(true);
    runCommandMock.mockRejectedValueOnce(new Error('whisper-cli failed'));
    await expect(transcribeWithWhisperCpp(audioBuffer, 'audio/ogg')).rejects.toThrow(
      'whisper-cli failed',
    );
  });
});

describe('whisperCppProvider', () => {
  it('reports availability when both binary and model exist', () => {
    resolveBinaryPathMock.mockReturnValue(FAKE_WHISPER_CLI);
    existsSyncMock.mockReturnValue(true);
    expect(whisperCppProvider.isAvailable()).toBe(true);
  });

  it('reports unavailable when binary is missing', () => {
    resolveBinaryPathMock.mockReturnValue(null);
    existsSyncMock.mockReturnValue(true);
    expect(whisperCppProvider.isAvailable()).toBe(false);
  });

  it('reports unavailable when model is missing', () => {
    resolveBinaryPathMock.mockReturnValue(FAKE_WHISPER_CLI);
    existsSyncMock.mockReturnValue(false);
    expect(whisperCppProvider.isAvailable()).toBe(false);
  });

  it('has the documented provider name', () => {
    expect(whisperCppProvider.name).toBe('whisper.cpp');
  });
});
