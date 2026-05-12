import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFleetTokenForDevProxy } from '../../console/vite.fleet-token.ts';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vite-fleet-token-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeConfigFile(name: string, contents: string): void {
  const dir = path.join(tmpRoot, 'whatsoup');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), contents);
}

describe('readFleetTokenForDevProxy', () => {
  it('reads the active token from the rotatable token file', () => {
    writeConfigFile('fleet-tokens.json', JSON.stringify({
      active: 'a'.repeat(64),
      accept: ['b'.repeat(64)],
      rotatedAt: '2026-05-12T00:00:00.000Z',
    }));
    writeConfigFile('fleet-token', `${'c'.repeat(64)}\n`);

    expect(readFleetTokenForDevProxy(tmpRoot)).toBe('a'.repeat(64));
  });

  it('falls back to the legacy single-token file', () => {
    writeConfigFile('fleet-token', `${'d'.repeat(64)}\n`);

    expect(readFleetTokenForDevProxy(tmpRoot)).toBe('d'.repeat(64));
  });

  it('returns an empty string when no usable token exists', () => {
    writeConfigFile('fleet-tokens.json', '{bad-json');

    expect(readFleetTokenForDevProxy(tmpRoot)).toBe('');
  });
});
