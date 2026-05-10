import { statSync } from 'node:fs';

const DAY_MS = 86_400_000;

export interface TokenAgeResult {
  aging: boolean;
  ageDays: number;
  reason?: string;
}

export function checkTokenAge(path: string, maxAgeDays: number, now = Date.now()): TokenAgeResult {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return { aging: true, ageDays: Infinity, reason: 'token file missing or unreadable' };
  }

  const ageDays = roundAgeDays((now - mtimeMs) / DAY_MS);
  if (ageDays < 0) {
    return { aging: false, ageDays, reason: 'token mtime is in the future' };
  }

  return { aging: ageDays > maxAgeDays, ageDays };
}

function roundAgeDays(ageDays: number): number {
  return Number(ageDays.toFixed(6));
}
