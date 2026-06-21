import { execFile as _execFile, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createChildLogger } from '../../../logger.ts';
import { writeTempFile, cleanupTempFile } from '../../../core/media-download.ts';
import { errorMessage } from '../../../lib/error-message.ts';

const execFile = promisify(_execFile);
const log = createChildLogger('media:video');

const FFPROBE_TIMEOUT_MS = 10_000;
const FFMPEG_TIMEOUT_MS = 60_000;
const MAX_FRAMES = 20;
const FRAME_INTERVAL_S = 10;
const LONG_VIDEO_THRESHOLD_S = 200;

export interface VideoFrame {
  timestamp: string;
  buffer: Buffer;
}

export type VideoFrameExtractionStatus =
  | 'ok'
  | 'no_frames'
  | 'fallback_ok'
  | 'fallback_no_frames'
  | 'fallback_failed'
  | 'dependency_missing'
  | 'failed';

export interface VideoFrameExtractionDetails {
  frames: VideoFrame[];
  status: VideoFrameExtractionStatus;
  fallbackUsed: boolean;
  durationSeconds?: number;
  error?: string;
}

async function getVideoDuration(inputPath: string): Promise<number> {
  try {
    const opts: ExecFileOptions = { timeout: FFPROBE_TIMEOUT_MS };
    const { stdout } = await execFile('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inputPath,
    ], { ...opts, encoding: 'utf8' });
    const duration = parseFloat((stdout as string).trim());
    return isNaN(duration) ? 0 : duration;
  } catch (err) {
    log.warn({ err }, 'ffprobe failed — defaulting duration to 0');
    return 0;
  }
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function framePrefixFromPattern(pattern: string): string {
  const tsMatch = pattern.match(/frames_(\d+)/);
  return `frames_${tsMatch?.[1] ?? ''}`;
}

export async function extractFrames(videoBuffer: Buffer): Promise<VideoFrame[]> {
  const details = await extractFramesDetailed(videoBuffer);
  return details.frames;
}

export async function extractFramesDetailed(videoBuffer: Buffer): Promise<VideoFrameExtractionDetails> {
  const inputPath = writeTempFile(videoBuffer, 'mp4');
  const outputDir = dirname(inputPath);
  const outputPattern = join(outputDir, `frames_${Date.now()}_%03d.jpg`);

  try {
    const duration = await getVideoDuration(inputPath);

    let fps: number;
    let frameCount: number;

    if (duration > LONG_VIDEO_THRESHOLD_S) {
      frameCount = MAX_FRAMES;
      fps = MAX_FRAMES / duration;
    } else {
      frameCount = Math.min(Math.ceil(duration / FRAME_INTERVAL_S) || 1, MAX_FRAMES);
      fps = 1 / FRAME_INTERVAL_S;
    }

    try {
      const opts: ExecFileOptions = { timeout: FFMPEG_TIMEOUT_MS };
      await execFile('ffmpeg', [
        '-i', inputPath,
        '-vf', `fps=${fps}`,
        '-frames:v', String(MAX_FRAMES),
        '-q:v', '2',
        outputPattern,
      ], opts);
    } catch (ffmpegErr) {
      // Fallback: extract a single first frame
      log.warn({ err: ffmpegErr }, 'ffmpeg frame extraction failed — attempting single frame fallback');
      const fallbackPattern = join(outputDir, `frames_${Date.now()}_%03d.jpg`);
      try {
        const opts: ExecFileOptions = { timeout: FFMPEG_TIMEOUT_MS };
        await execFile('ffmpeg', [
          '-i', inputPath,
          '-frames:v', '1',
          '-q:v', '2',
          fallbackPattern,
        ], opts);
      } catch (fallbackErr) {
        const message = errorMessage(fallbackErr);
        // ENOENT means the ffmpeg binary itself is absent — a missing system
        // dependency, not a bad video. Surface it distinctly so a host without
        // ffmpeg is alertable instead of looking like generic frame failure (#1075).
        // ENOENT means the ffmpeg binary itself is absent — a missing system
        // dependency, not a bad video. Surface it distinctly so a host without
        // ffmpeg is alertable instead of looking like generic frame failure (#1075).
        if ((fallbackErr as NodeJS.ErrnoException)?.code === 'ENOENT') {
          log.warn(
            { dependency: 'ffmpeg', status: 'missing' },
            'ffmpeg not found — video frame extraction unavailable on this host',
          );
          return {
            frames: [],
            status: 'dependency_missing',
            fallbackUsed: true,
            durationSeconds: duration,
            error: 'ffmpeg not found (ENOENT)',
          };
        }
        log.error({ err: message }, 'ffmpeg single frame fallback also failed');
        return {
          frames: [],
          status: 'fallback_failed',
          fallbackUsed: true,
          durationSeconds: duration,
          error: message,
        };
      }

      // Read the fallback frame
      const fallbackPrefix = framePrefixFromPattern(fallbackPattern);
      const allFiles = await readdir(outputDir);
      const files = allFiles
        .filter(f => f.endsWith('.jpg') && f.startsWith(fallbackPrefix))
        .sort();

      if (files.length === 0) {
        return {
          frames: [],
          status: 'fallback_no_frames',
          fallbackUsed: true,
          durationSeconds: duration,
        };
      }

      const framePaths = files.slice(0, 1);
      const frames: VideoFrame[] = [];
      for (const file of framePaths) {
        const framePath = join(outputDir, file);
        try {
          const { readFile } = await import('node:fs/promises');
          frames.push({ timestamp: '0:00', buffer: await readFile(framePath) });
        } catch (err) {
          log.debug({ err }, 'failed to read/process frame — skipping');
        } finally {
          cleanupTempFile(join(outputDir, file));
        }
      }
      return {
        frames,
        status: frames.length > 0 ? 'fallback_ok' : 'fallback_no_frames',
        fallbackUsed: true,
        durationSeconds: duration,
      };
    }

    // Collect output frames
    const outputPrefix = framePrefixFromPattern(outputPattern);
    const allFiles = await readdir(outputDir);
    const files = allFiles
      .filter(f => f.endsWith('.jpg') && f.startsWith(outputPrefix))
      .sort();

    const { readFile } = await import('node:fs/promises');
    const frames: VideoFrame[] = [];

    for (let i = 0; i < Math.min(files.length, frameCount); i++) {
      const file = files[i];
      const framePath = join(outputDir, file);
      try {
        const intervalS = duration > LONG_VIDEO_THRESHOLD_S
          ? (duration / MAX_FRAMES) * i
          : FRAME_INTERVAL_S * i;
        frames.push({
          timestamp: formatTimestamp(intervalS),
          buffer: await readFile(framePath),
        });
      } catch (err) {
        log.debug({ err }, 'failed to read/process frame — skipping');
      } finally {
        cleanupTempFile(framePath);
      }
    }

    return {
      frames,
      status: frames.length > 0 ? 'ok' : 'no_frames',
      fallbackUsed: false,
      durationSeconds: duration,
    };
  } catch (err) {
    const message = errorMessage(err);
    log.error({ err: message }, 'extractFrames failed entirely');
    return { frames: [], status: 'failed', fallbackUsed: false, error: message };
  } finally {
    cleanupTempFile(inputPath);
  }
}
