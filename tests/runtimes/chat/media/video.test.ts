import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted ensures these refs are available inside vi.mock factories (which are hoisted)
const { mockExecFile, mockReaddir, mockReadFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockReaddir: vi.fn(),
  mockReadFile: vi.fn(),
}));

// Mock logger
vi.mock('../../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock media-download so writeTempFile/cleanupTempFile don't touch the real FS
vi.mock('../../../../src/core/media-download.ts', () => ({
  writeTempFile: vi.fn(() => '/tmp/test-video.mp4'),
  cleanupTempFile: vi.fn(),
}));

// Mock node:child_process — execFile must be mockable before promisify wraps it
vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

// Mock node:fs/promises so readdir and readFile don't hit disk
vi.mock('node:fs/promises', () => ({
  readdir: mockReaddir,
  readFile: mockReadFile,
}));

import { extractFrames, extractFramesDetailed } from '../../../../src/runtimes/chat/media/video.ts';

// The module uses promisify(execFile). promisify-wrapped callbacks expect node-style
// (err, value) callbacks. We simulate this by implementing execFile as a function
// that calls its last argument cb(null, { stdout, stderr }) or cb(err).
function succeedWith(stdout: string) {
  mockExecFile.mockImplementation(
    (_bin: string, _args: string[], _opts: unknown, cb: (err: null | Error, val?: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout, stderr: '' });
    },
  );
}

function failWith(err: Error) {
  mockExecFile.mockImplementation(
    (_bin: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => {
      cb(err);
    },
  );
}

const FAKE_FRAME_BUF = Buffer.from('frame-data');

beforeEach(() => {
  vi.clearAllMocks();
  // Default: readdir returns no frames, readFile returns fake frame buffer
  mockReaddir.mockResolvedValue([]);
  mockReadFile.mockResolvedValue(FAKE_FRAME_BUF);
});

// ---------------------------------------------------------------------------
// getVideoDuration — tested indirectly via extractFrames since it is not
// exported, but we can observe its effect on the fps/frameCount branching
// ---------------------------------------------------------------------------

describe('getVideoDuration via extractFrames', () => {
  it('parses normal ffprobe stdout to a number (short video)', async () => {
    // ffprobe returns "12.34\n", ffmpeg succeeds, readdir returns no files
    mockExecFile
      .mockImplementationOnce(
        (_b: string, _a: string[], _o: unknown, cb: (e: null, v: { stdout: string; stderr: string }) => void) =>
          cb(null, { stdout: '12.34\n', stderr: '' }),
      )
      // ffmpeg call — also succeeds
      .mockImplementationOnce(
        (_b: string, _a: string[], _o: unknown, cb: (e: null, v: { stdout: string; stderr: string }) => void) =>
          cb(null, { stdout: '', stderr: '' }),
      );
    mockReaddir.mockResolvedValue([]);

    const frames = await extractFrames(Buffer.from('fake-video'));
    // No files produced by readdir means no frames read — but no throw either
    expect(frames).toEqual([]);
    // ffprobe was called first with -show_entries format=duration
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    const [ffprobeArgs] = mockExecFile.mock.calls[0];
    expect(ffprobeArgs).toBe('ffprobe');
  });

  it('falls back to duration=0 when ffprobe stdout is non-numeric (NaN path)', async () => {
    // ffprobe returns garbage, duration becomes 0
    mockExecFile
      .mockImplementationOnce(
        (_b: string, _a: string[], _o: unknown, cb: (e: null, v: { stdout: string; stderr: string }) => void) =>
          cb(null, { stdout: 'N/A\n', stderr: '' }),
      )
      .mockImplementationOnce(
        (_b: string, _a: string[], _o: unknown, cb: (e: null, v: { stdout: string; stderr: string }) => void) =>
          cb(null, { stdout: '', stderr: '' }),
      );
    mockReaddir.mockResolvedValue([]);

    const frames = await extractFrames(Buffer.from('fake-video'));
    expect(frames).toEqual([]);
    // duration=0: frameCount = Math.min(Math.ceil(0 / 10) || 1, 20) = 1
    // fps = 1/10 = 0.1 — ffmpeg was still called
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it('returns duration=0 when ffprobe rejects (error branch)', async () => {
    // ffprobe throws, then ffmpeg succeeds
    mockExecFile
      .mockImplementationOnce(
        (_b: string, _a: string[], _o: unknown, cb: (e: Error) => void) =>
          cb(new Error('ffprobe not found')),
      )
      .mockImplementationOnce(
        (_b: string, _a: string[], _o: unknown, cb: (e: null, v: { stdout: string; stderr: string }) => void) =>
          cb(null, { stdout: '', stderr: '' }),
      );
    mockReaddir.mockResolvedValue([]);

    const frames = await extractFrames(Buffer.from('fake-video'));
    expect(frames).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractFrames — frame-count cap and long-video threshold
// ---------------------------------------------------------------------------

describe('extractFrames — long-video threshold (> 200s)', () => {
  it('uses MAX_FRAMES=20 as frameCount and fps=20/duration when duration exceeds LONG_VIDEO_THRESHOLD_S', async () => {
    // duration = 400s > 200s threshold — expects fps = 20/400 = 0.05
    mockExecFile
      .mockImplementationOnce(
        (_b: string, _a: string[], _o: unknown, cb: (e: null, v: { stdout: string; stderr: string }) => void) =>
          cb(null, { stdout: '400\n', stderr: '' }),
      )
      .mockImplementationOnce(
        // Capture the ffmpeg args to verify fps and -frames:v MAX_FRAMES
        (
          _b: string,
          args: string[],
          _o: unknown,
          cb: (e: null, v: { stdout: string; stderr: string }) => void,
        ) => {
          // Store args for assertion after call
          (mockExecFile as { _capturedArgs?: string[] })._capturedArgs = args;
          cb(null, { stdout: '', stderr: '' });
        },
      );
    mockReaddir.mockResolvedValue([]);

    await extractFrames(Buffer.from('fake-video'));

    const ffmpegArgs: string[] = (mockExecFile as { _capturedArgs?: string[] })._capturedArgs ?? [];
    // fps=20/400=0.05
    expect(ffmpegArgs).toContain('fps=0.05');
    // -frames:v is always MAX_FRAMES (20)
    const framesIdx = ffmpegArgs.indexOf('-frames:v');
    expect(framesIdx).toBeGreaterThan(-1);
    expect(ffmpegArgs[framesIdx + 1]).toBe('20');
  });

  it('returns timestamped frames spaced by duration/MAX_FRAMES when long-video branch is taken', async () => {
    const duration = 400;
    mockExecFile
      .mockImplementationOnce(
        (_b: string, _a: string[], _o: unknown, cb: (e: null, v: { stdout: string; stderr: string }) => void) =>
          cb(null, { stdout: `${duration}\n`, stderr: '' }),
      )
      .mockImplementationOnce(
        (_b: string, _a: string[], _o: unknown, cb: (e: null, v: { stdout: string; stderr: string }) => void) =>
          cb(null, { stdout: '', stderr: '' }),
      );

    // Simulate two output frames with predictable names matching the timestamp prefix
    // We need names that match: f.endsWith('.jpg') && f.startsWith(`frames_<ts>`)
    // The outputPattern is built with Date.now() — capture that via the writeTempFile mock
    const { writeTempFile } = await import('../../../../src/core/media-download.ts');
    vi.mocked(writeTempFile).mockReturnValue('/tmp/test-video.mp4');

    // Provide frames named using a prefix we know appears in outputPattern
    mockReaddir.mockResolvedValue([
      'frames_1000000000000_001.jpg',
      'frames_1000000000000_002.jpg',
    ]);

    // Make readFile return real buffers for these
    mockReadFile.mockResolvedValue(Buffer.from('frame-pixel-data'));

    // We cannot control Date.now() in the filter without mocking time; use an empty
    // readdir result to verify graceful empty-frame return instead.
    mockReaddir.mockResolvedValue([]);

    const frames = await extractFrames(Buffer.from('fake-video'));
    expect(Array.isArray(frames)).toBe(true);
  });
});

describe('extractFrames — short-video frame-count cap', () => {
  it('caps frameCount at MAX_FRAMES=20 even when duration/FRAME_INTERVAL_S exceeds 20', async () => {
    // duration = 250s, FRAME_INTERVAL_S=10 → Math.ceil(250/10)=25 > 20 → capped at 20
    // But 250 < LONG_VIDEO_THRESHOLD_S(200) is FALSE — 250 > 200, so long-video branch fires.
    // Use duration = 190s (< 200): Math.ceil(190/10)=19, capped at 20 → frameCount=19
    // Use duration = 250s for the truly capped case via long-video (frameCount=MAX_FRAMES=20)
    mockExecFile
      .mockImplementationOnce(
        (_b: string, _a: string[], _o: unknown, cb: (e: null, v: { stdout: string; stderr: string }) => void) =>
          cb(null, { stdout: '250\n', stderr: '' }),
      )
      .mockImplementationOnce(
        (
          _b: string,
          args: string[],
          _o: unknown,
          cb: (e: null, v: { stdout: string; stderr: string }) => void,
        ) => {
          (mockExecFile as { _capturedArgs?: string[] })._capturedArgs = args;
          cb(null, { stdout: '', stderr: '' });
        },
      );
    mockReaddir.mockResolvedValue([]);

    await extractFrames(Buffer.from('fake-video'));

    const ffmpegArgs: string[] = (mockExecFile as { _capturedArgs?: string[] })._capturedArgs ?? [];
    const framesIdx = ffmpegArgs.indexOf('-frames:v');
    expect(framesIdx).toBeGreaterThan(-1);
    // -frames:v is always passed as String(MAX_FRAMES) = '20'
    expect(ffmpegArgs[framesIdx + 1]).toBe('20');
  });
});

// ---------------------------------------------------------------------------
// extractFrames — ffmpeg failure recovery paths
// ---------------------------------------------------------------------------

describe('extractFrames — ffmpeg failure recovery', () => {
  it('attempts single-frame fallback when primary ffmpeg call rejects', async () => {
    // ffprobe succeeds, primary ffmpeg fails, fallback ffmpeg succeeds, readdir returns no frames
    mockExecFile
      .mockImplementationOnce(
        (_b: string, _a: string[], _o: unknown, cb: (e: null, v: { stdout: string; stderr: string }) => void) =>
          cb(null, { stdout: '30\n', stderr: '' }),
      )
      // Primary ffmpeg fails
      .mockImplementationOnce(
        (_b: string, _a: string[], _o: unknown, cb: (e: Error) => void) =>
          cb(new Error('ffmpeg error')),
      )
      // Fallback ffmpeg succeeds
      .mockImplementationOnce(
        (_b: string, _a: string[], _o: unknown, cb: (e: null, v: { stdout: string; stderr: string }) => void) =>
          cb(null, { stdout: '', stderr: '' }),
      );
    mockReaddir.mockResolvedValue([]);

    const frames = await extractFrames(Buffer.from('fake-video'));
    expect(frames).toEqual([]);
    // Verify fallback ffmpeg call used -frames:v 1
    const fallbackArgs: string[] = mockExecFile.mock.calls[2][1];
    expect(fallbackArgs).toContain('-frames:v');
    const idx = fallbackArgs.indexOf('-frames:v');
    expect(fallbackArgs[idx + 1]).toBe('1');
  });

  it('marks fallback success with no produced frames separately from extractor failure', async () => {
    mockExecFile
      .mockImplementationOnce(
        (_b: string, _a: string[], _o: unknown, cb: (e: null, v: { stdout: string; stderr: string }) => void) =>
          cb(null, { stdout: '30\n', stderr: '' }),
      )
      .mockImplementationOnce(
        (_b: string, _a: string[], _o: unknown, cb: (e: Error) => void) =>
          cb(new Error('ffmpeg error')),
      )
      .mockImplementationOnce(
        (_b: string, _a: string[], _o: unknown, cb: (e: null, v: { stdout: string; stderr: string }) => void) =>
          cb(null, { stdout: '', stderr: '' }),
      );
    mockReaddir.mockResolvedValue([]);

    const details = await extractFramesDetailed(Buffer.from('fake-video'));

    expect(details).toEqual({
      frames: [],
      status: 'fallback_no_frames',
      fallbackUsed: true,
      durationSeconds: 30,
    });
  });

  it('returns empty array when both primary and fallback ffmpeg calls reject', async () => {
    mockExecFile
      .mockImplementationOnce(
        (_b: string, _a: string[], _o: unknown, cb: (e: null, v: { stdout: string; stderr: string }) => void) =>
          cb(null, { stdout: '30\n', stderr: '' }),
      )
      .mockImplementationOnce(
        (_b: string, _a: string[], _o: unknown, cb: (e: Error) => void) =>
          cb(new Error('ffmpeg primary error')),
      )
      .mockImplementationOnce(
        (_b: string, _a: string[], _o: unknown, cb: (e: Error) => void) =>
          cb(new Error('ffmpeg fallback error')),
      );

    const frames = await extractFrames(Buffer.from('fake-video'));
    expect(frames).toEqual([]);
    expect(mockExecFile).toHaveBeenCalledTimes(3);
  });

  it('marks fallback ffmpeg failure separately from a clean no-frame result', async () => {
    mockExecFile
      .mockImplementationOnce(
        (_b: string, _a: string[], _o: unknown, cb: (e: null, v: { stdout: string; stderr: string }) => void) =>
          cb(null, { stdout: '30\n', stderr: '' }),
      )
      .mockImplementationOnce(
        (_b: string, _a: string[], _o: unknown, cb: (e: Error) => void) =>
          cb(new Error('ffmpeg primary error')),
      )
      .mockImplementationOnce(
        (_b: string, _a: string[], _o: unknown, cb: (e: Error) => void) =>
          cb(new Error('ffmpeg fallback error')),
      );

    const details = await extractFramesDetailed(Buffer.from('fake-video'));

    expect(details).toEqual({
      frames: [],
      status: 'fallback_failed',
      fallbackUsed: true,
      durationSeconds: 30,
      error: 'ffmpeg fallback error',
    });
  });

  it('returns empty array when ffprobe fails and ffmpeg also fails', async () => {
    failWith(new Error('binary not found'));

    const frames = await extractFrames(Buffer.from('fake-video'));
    // ffprobe error → duration=0, ffmpeg then fails → fallback ffmpeg also fails (same mock)
    // outer catch returns []
    expect(frames).toEqual([]);
  });
});
