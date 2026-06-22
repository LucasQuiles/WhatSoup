import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
import { cleanupTempFile, writeTempFile } from '../../../../src/core/media-download.ts';

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
  vi.spyOn(Date, 'now').mockReturnValue(1_000_000_000_000);
  // Default: readdir returns no frames, readFile returns fake frame buffer
  mockReaddir.mockResolvedValue([]);
  mockReadFile.mockResolvedValue(FAKE_FRAME_BUF);
});

afterEach(() => {
  vi.restoreAllMocks();
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

  it('extractFrames returns timestamped long-video frames', async () => {
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

    mockReaddir.mockResolvedValue([
      'frames_test-video_001.jpg',
      'frames_test-video_002.jpg',
    ]);
    mockReadFile
      .mockResolvedValueOnce(Buffer.from('frame-one'))
      .mockResolvedValueOnce(Buffer.from('frame-two'));

    const frames = await extractFrames(Buffer.from('fake-video'));
    expect(frames).toEqual([
      { timestamp: '0:00', buffer: Buffer.from('frame-one') },
      { timestamp: '0:20', buffer: Buffer.from('frame-two') },
    ]);
  });

  it('reads normal ffmpeg frames, formats long-video timestamps, and cleans frame files', async () => {
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
    mockReaddir.mockResolvedValue([
      'frames_test-video_001.jpg',
      'frames_test-video_002.jpg',
      'unrelated.jpg',
    ]);
    mockReadFile
      .mockResolvedValueOnce(Buffer.from('frame-one'))
      .mockResolvedValueOnce(Buffer.from('frame-two'));

    const details = await extractFramesDetailed(Buffer.from('fake-video'));

    expect(details).toEqual({
      frames: [
        { timestamp: '0:00', buffer: Buffer.from('frame-one') },
        { timestamp: '0:20', buffer: Buffer.from('frame-two') },
      ],
      status: 'ok',
      fallbackUsed: false,
      durationSeconds: duration,
    });
    expect(mockReadFile).toHaveBeenNthCalledWith(1, '/tmp/frames_test-video_001.jpg');
    expect(mockReadFile).toHaveBeenNthCalledWith(2, '/tmp/frames_test-video_002.jpg');
    expect(cleanupTempFile).toHaveBeenCalledWith('/tmp/frames_test-video_001.jpg');
    expect(cleanupTempFile).toHaveBeenCalledWith('/tmp/frames_test-video_002.jpg');
    expect(cleanupTempFile).toHaveBeenCalledWith('/tmp/test-video.mp4');
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

  it('reads short-video frames with 10-second timestamps and skips read failures', async () => {
    mockExecFile
      .mockImplementationOnce(
        (_b: string, _a: string[], _o: unknown, cb: (e: null, v: { stdout: string; stderr: string }) => void) =>
          cb(null, { stdout: '25\n', stderr: '' }),
      )
      .mockImplementationOnce(
        (_b: string, _a: string[], _o: unknown, cb: (e: null, v: { stdout: string; stderr: string }) => void) =>
          cb(null, { stdout: '', stderr: '' }),
      );
    mockReaddir.mockResolvedValue([
      'frames_test-video_001.jpg',
      'frames_test-video_002.jpg',
      'frames_9999999999999_001.jpg',
    ]);
    mockReadFile
      .mockResolvedValueOnce(Buffer.from('frame-one'))
      .mockRejectedValueOnce(new Error('frame unreadable'));

    const details = await extractFramesDetailed(Buffer.from('fake-video'));

    expect(details).toEqual({
      frames: [
        { timestamp: '0:00', buffer: Buffer.from('frame-one') },
      ],
      status: 'ok',
      fallbackUsed: false,
      durationSeconds: 25,
    });
    expect(cleanupTempFile).toHaveBeenCalledWith('/tmp/frames_test-video_001.jpg');
    expect(cleanupTempFile).toHaveBeenCalledWith('/tmp/frames_test-video_002.jpg');
  });

  it('collects only frames under its own input-stem prefix, ignoring a concurrent task and non-jpg files (#1073)', async () => {
    // The output dir is shared across concurrent extractions. Frames are keyed
    // off this task's unique input stem (writeTempFile mock → /tmp/test-video.mp4
    // → prefix `frames_test-video`), so a concurrent task's frames (a different
    // stem) and non-jpg files must be ignored even when Date.now collides.
    mockExecFile
      .mockImplementationOnce(
        (_b: string, _a: string[], _o: unknown, cb: (e: null, v: { stdout: string; stderr: string }) => void) =>
          cb(null, { stdout: '12\n', stderr: '' }),
      )
      .mockImplementationOnce(
        (_b: string, _a: string[], _o: unknown, cb: (e: null, v: { stdout: string; stderr: string }) => void) =>
          cb(null, { stdout: '', stderr: '' }),
      );
    mockReaddir.mockResolvedValue([
      'frames_test-video_001.jpg',
      'frames_test-video_002.jpg',
      'frames_other-task_001.jpg', // a concurrent extraction's frame — must be ignored
      'frames_test-video_ignored.txt', // right prefix, wrong extension
      'unrelated.jpg',
    ]);
    mockReadFile
      .mockResolvedValueOnce(Buffer.from('first'))
      .mockResolvedValueOnce(Buffer.from('second'));

    const details = await extractFramesDetailed(Buffer.from('fake-video'));

    expect(details).toEqual({
      frames: [
        { timestamp: '0:00', buffer: Buffer.from('first') },
        { timestamp: '0:10', buffer: Buffer.from('second') },
      ],
      status: 'ok',
      fallbackUsed: false,
      durationSeconds: 12,
    });
    expect(mockReadFile).toHaveBeenCalledTimes(2);
    expect(mockReadFile).toHaveBeenNthCalledWith(1, '/tmp/frames_test-video_001.jpg');
    expect(mockReadFile).toHaveBeenNthCalledWith(2, '/tmp/frames_test-video_002.jpg');
    // The concurrent task's frame is never read or cleaned up by this task.
    expect(mockReadFile).not.toHaveBeenCalledWith('/tmp/frames_other-task_001.jpg');
    expect(cleanupTempFile).not.toHaveBeenCalledWith('/tmp/frames_other-task_001.jpg');
  });

  it('keys the ffmpeg frame prefix off the unique input stem, not Date.now — same-ms tasks never collide (#1073)', async () => {
    // Date.now is pinned to a single constant in beforeEach (two tasks in the
    // same millisecond). The fix derives the frame prefix from writeTempFile's
    // unique random stem, so the two extractions MUST produce different prefixes.
    vi.mocked(writeTempFile)
      .mockReturnValueOnce('/tmp/aaaaaaaa.mp4')
      .mockReturnValueOnce('/tmp/bbbbbbbb.mp4');

    const framePatterns: string[] = [];
    mockExecFile.mockImplementation(
      (_b: string, args: string[], _o: unknown, cb: (e: null, v: { stdout: string; stderr: string }) => void) => {
        const last = args[args.length - 1];
        if (typeof last === 'string' && last.includes('frames_')) framePatterns.push(last);
        cb(null, { stdout: '5\n', stderr: '' }); // duration probe + extraction both resolve
      },
    );
    mockReaddir.mockResolvedValue([]);

    await extractFramesDetailed(Buffer.from('video-a'));
    await extractFramesDetailed(Buffer.from('video-b'));

    const prefixes = framePatterns.map((p) => p.replace(/_%03d\.jpg$/, ''));
    expect(prefixes).toEqual(['/tmp/frames_aaaaaaaa', '/tmp/frames_bbbbbbbb']);
    expect(prefixes[0]).not.toBe(prefixes[1]); // same ms → still distinct → no frame theft
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

  it('reads one fallback frame and cleans it after primary ffmpeg failure', async () => {
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
        (_b: string, _a: string[], _o: unknown, cb: (e: null, v: { stdout: string; stderr: string }) => void) =>
          cb(null, { stdout: '', stderr: '' }),
      );
    mockReaddir.mockResolvedValue([
      'frames_test-video-fb_001.jpg',
      'frames_test-video-fb_002.jpg',
    ]);
    mockReadFile.mockResolvedValue(Buffer.from('fallback-frame'));

    const details = await extractFramesDetailed(Buffer.from('fake-video'));

    expect(details).toEqual({
      frames: [
        { timestamp: '0:00', buffer: Buffer.from('fallback-frame') },
      ],
      status: 'fallback_ok',
      fallbackUsed: true,
      durationSeconds: 30,
    });
    expect(mockReadFile).toHaveBeenCalledTimes(1);
    expect(mockReadFile).toHaveBeenCalledWith('/tmp/frames_test-video-fb_001.jpg');
    expect(cleanupTempFile).toHaveBeenCalledWith('/tmp/frames_test-video-fb_001.jpg');
  });

  it('filters fallback frames to the fallback (-fb) prefix and leaves main-pass partials alone', async () => {
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
        (_b: string, _a: string[], _o: unknown, cb: (e: null, v: { stdout: string; stderr: string }) => void) =>
          cb(null, { stdout: '', stderr: '' }),
      );
    // The failed main pass may have left a partial frame under the main prefix;
    // the fallback must read/clean only its own `-fb` frame, not the partial.
    mockReaddir.mockResolvedValue([
      'frames_test-video_001.jpg', // main-pass partial — must be left alone
      'frames_test-video-fb_001.jpg', // the fallback's frame
    ]);
    mockReadFile.mockResolvedValue(Buffer.from('fallback-frame'));

    const details = await extractFramesDetailed(Buffer.from('fake-video'));

    expect(details).toEqual({
      frames: [
        { timestamp: '0:00', buffer: Buffer.from('fallback-frame') },
      ],
      status: 'fallback_ok',
      fallbackUsed: true,
      durationSeconds: 30,
    });
    expect(mockReadFile).toHaveBeenCalledTimes(1);
    expect(mockReadFile).toHaveBeenCalledWith('/tmp/frames_test-video-fb_001.jpg');
    expect(cleanupTempFile).toHaveBeenCalledWith('/tmp/frames_test-video-fb_001.jpg');
    expect(cleanupTempFile).not.toHaveBeenCalledWith('/tmp/frames_test-video_001.jpg');
  });

  it('marks fallback no-frame when the fallback frame cannot be read', async () => {
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
        (_b: string, _a: string[], _o: unknown, cb: (e: null, v: { stdout: string; stderr: string }) => void) =>
          cb(null, { stdout: '', stderr: '' }),
      );
    mockReaddir.mockResolvedValue(['frames_test-video-fb_001.jpg']);
    mockReadFile.mockRejectedValue(new Error('fallback frame unreadable'));

    const details = await extractFramesDetailed(Buffer.from('fake-video'));

    expect(details).toEqual({
      frames: [],
      status: 'fallback_no_frames',
      fallbackUsed: true,
      durationSeconds: 30,
    });
    expect(cleanupTempFile).toHaveBeenCalledWith('/tmp/frames_test-video-fb_001.jpg');
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

  it('serializes non-Error fallback ffmpeg failures', async () => {
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
          cb('fallback process exited 2' as unknown as Error),
      );

    const details = await extractFramesDetailed(Buffer.from('fake-video'));

    expect(details).toEqual({
      frames: [],
      status: 'fallback_failed',
      fallbackUsed: true,
      durationSeconds: 30,
      error: 'fallback process exited 2',
    });
  });

  it('returns empty array when ffprobe fails and ffmpeg also fails', async () => {
    failWith(new Error('binary not found'));

    const frames = await extractFrames(Buffer.from('fake-video'));
    // ffprobe error → duration=0, ffmpeg then fails → fallback ffmpeg also fails (same mock)
    // outer catch returns []
    expect(frames).toEqual([]);
  });

  it('returns failed details when frame directory listing throws after primary ffmpeg succeeds', async () => {
    mockExecFile
      .mockImplementationOnce(
        (_b: string, _a: string[], _o: unknown, cb: (e: null, v: { stdout: string; stderr: string }) => void) =>
          cb(null, { stdout: '30\n', stderr: '' }),
      )
      .mockImplementationOnce(
        (_b: string, _a: string[], _o: unknown, cb: (e: null, v: { stdout: string; stderr: string }) => void) =>
          cb(null, { stdout: '', stderr: '' }),
      );
    mockReaddir.mockRejectedValue(new Error('cannot list frames'));

    const details = await extractFramesDetailed(Buffer.from('fake-video'));

    expect(details).toEqual({
      frames: [],
      status: 'failed',
      fallbackUsed: false,
      error: 'cannot list frames',
    });
    expect(cleanupTempFile).toHaveBeenCalledWith('/tmp/test-video.mp4');
  });

  it('serializes non-Error failures from the outer extraction path', async () => {
    mockExecFile
      .mockImplementationOnce(
        (_b: string, _a: string[], _o: unknown, cb: (e: null, v: { stdout: string; stderr: string }) => void) =>
          cb(null, { stdout: '30\n', stderr: '' }),
      )
      .mockImplementationOnce(
        (_b: string, _a: string[], _o: unknown, cb: (e: null, v: { stdout: string; stderr: string }) => void) =>
          cb(null, { stdout: '', stderr: '' }),
      );
    mockReaddir.mockRejectedValue('directory unavailable');

    const details = await extractFramesDetailed(Buffer.from('fake-video'));

    expect(details).toEqual({
      frames: [],
      status: 'failed',
      fallbackUsed: false,
      error: 'directory unavailable',
    });
  });
});

describe('extractFramesDetailed — ffmpeg dependency missing (#1075)', () => {
  it('reports dependency_missing (not fallback_failed) when ffmpeg is absent (ENOENT)', async () => {
    const enoent = Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
    failWith(enoent);

    const details = await extractFramesDetailed(Buffer.from('fake-video'));

    expect(details.status).toBe('dependency_missing');
    expect(details.frames).toEqual([]);
  });
});
