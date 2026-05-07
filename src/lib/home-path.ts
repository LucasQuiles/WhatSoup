import * as os from 'node:os';
import * as path from 'node:path';

export function hasUnsupportedTildePrefix(inputPath: string): boolean {
  const trimmed = inputPath.trim();
  return trimmed.startsWith('~') && trimmed !== '~' && !trimmed.startsWith('~/');
}

export function expandHomePath(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}
