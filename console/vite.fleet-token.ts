import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TOKEN_RE = /^[0-9a-f]{64}$/;

function validToken(value: unknown): string {
  return typeof value === 'string' && TOKEN_RE.test(value) ? value : '';
}

export function readFleetTokenForDevProxy(configRoot = join(homedir(), '.config')): string {
  const dir = join(configRoot, 'whatsoup');
  const currentPath = join(dir, 'fleet-tokens.json');
  if (existsSync(currentPath)) {
    try {
      const parsed = JSON.parse(readFileSync(currentPath, 'utf-8')) as Record<string, unknown>;
      return validToken(parsed.active);
    } catch {
      return '';
    }
  }

  try {
    return validToken(readFileSync(join(dir, 'fleet-token'), 'utf-8').trim());
  } catch {
    return '';
  }
}
