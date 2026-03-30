import { execFile as _execFile, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createChildLogger } from '../../../logger.ts';
import { writeTempFile, cleanupTempFile } from '../../../core/media-download.ts';

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

export async function extractFrames(videoBuffer: Buffer): Promise<VideoFrame[]> {
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
        log.error({ err: fallbackErr }, 'ffmpeg single frame fallback also failed');
        return [];
      }

      // Read the fallback frame
      const allFiles = await readdir(outputDir);
      const files = allFiles
        .filter(f => f.endsWith('.jpg') && f.includes('frames_'))
        .sort();

      if (files.length === 0) return [];

      const framePaths = files.slice(0, 1);
      const frames: VideoFrame[] = [];
      for (const file of framePaths) {
        const framePath = join(outputDir, file);
        try {
          const { readFile } = await import('node:fs/promises');
          frames.push({ timestamp: '0:00', buffer: await readFile(framePath) });
        } catch {
          // skip unreadable frame
        } finally {
          cleanupTempFile(join(outputDir, file));
        }
      }
      return frames;
    }

    // Collect output frames
    const tsMatch = outputPattern.match(/frames_(\d+)/);
    const allFiles = await readdir(outputDir);
    const files = allFiles
      .filter(f => f.endsWith('.jpg') && f.startsWith(`frames_${tsMatch?.[1] ?? ''}`))
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
      } catch {
        // skip unreadable frame
      } finally {
        cleanupTempFile(framePath);
      }
    }

    return frames;
  } catch (err) {
    log.error({ err }, 'extractFrames failed entirely');
    return [];
  } finally {
    cleanupTempFile(inputPath);
  }
}
