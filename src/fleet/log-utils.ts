import * as fs from 'node:fs';
import * as path from 'node:path';

/** Find the most recent .log file in a directory (pino-roll uses numbered names). */
export function findLatestLogFile(logDir: string): string | null {
  try {
    const files = fs.readdirSync(logDir)
      .filter(f => f.endsWith('.log'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(logDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files.length > 0 ? path.join(logDir, files[0].name) : null;
  } catch {
    return null;
  }
}

/** Read the last N lines from a file (best-effort, reads last 64KB). */
export function readTailLines(filePath: string, maxLines: number): string[] {
  try {
    const stat = fs.statSync(filePath);
    const readSize = Math.min(stat.size, 65_536);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
      const lines = buf.toString('utf-8').split('\n').filter(Boolean);
      return lines.slice(-maxLines);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}
