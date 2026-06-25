import * as fs from 'node:fs';
import * as path from 'node:path';
import { errorMessage } from '../lib/error-message.ts';

export interface LatestLogFileOk {
  ok: true;
  file: { path: string; mtimeMs: number } | null;
}

export interface LogReadFailure {
  ok: false;
  path: string;
  code?: string;
  error: string;
}

export type LatestLogFileResult = LatestLogFileOk | LogReadFailure;

export interface TailLinesOk {
  ok: true;
  lines: string[];
}

export type TailLinesResult = TailLinesOk | LogReadFailure;

function logReadFailure(pathValue: string, err: unknown): LogReadFailure {
  const nodeErr = err as NodeJS.ErrnoException;
  return {
    ok: false,
    path: pathValue,
    ...(typeof nodeErr.code === 'string' ? { code: nodeErr.code } : {}),
    error: errorMessage(err),
  };
}

export function inspectLatestLogFile(logDir: string): LatestLogFileResult {
  let entries: string[];
  try {
    entries = fs.readdirSync(logDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, file: null };
    return logReadFailure(logDir, err);
  }

  const files: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.endsWith('.log')) continue;
    const full = path.join(logDir, entry);
    try {
      files.push({ path: full, mtimeMs: fs.statSync(full).mtimeMs });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return logReadFailure(full, err);
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { ok: true, file: files.length > 0 ? files[0] : null };
}

/** Find the most recent .log file in a directory (pino-roll uses numbered names). */
export function findLatestLogFile(logDir: string): { path: string; mtimeMs: number } | null {
  const result = inspectLatestLogFile(logDir);
  return result.ok ? result.file : null;
}

export function readTailLinesDetailed(filePath: string, maxLines: number): TailLinesResult {
  try {
    const stat = fs.statSync(filePath);
    const readSize = Math.min(stat.size, 65_536);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
      const lines = buf.toString('utf-8').split('\n').filter(Boolean);
      return { ok: true, lines: lines.slice(-maxLines) };
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, lines: [] };
    return logReadFailure(filePath, err);
  }
}

