import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFleetTokenForDevProxy } from '../../console/vite.fleet-token.ts';
import { attachFleetTokenAuth } from '../../console/vite.proxy-auth.ts';

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

  it('reflects token rotation on subsequent reads (live rotation)', () => {
    // Initial token written before "Vite startup"
    writeConfigFile('fleet-tokens.json', JSON.stringify({
      active: 'a'.repeat(64),
      accept: [],
      rotatedAt: '2026-05-12T00:00:00.000Z',
    }));
    expect(readFleetTokenForDevProxy(tmpRoot)).toBe('a'.repeat(64));

    // Token rotated mid-session — next read must see the new value
    writeConfigFile('fleet-tokens.json', JSON.stringify({
      active: 'b'.repeat(64),
      accept: ['a'.repeat(64)],
      rotatedAt: '2026-05-12T01:00:00.000Z',
    }));
    expect(readFleetTokenForDevProxy(tmpRoot)).toBe('b'.repeat(64));
  });
});

describe('attachFleetTokenAuth', () => {
  it('reads the token on each proxied request and overwrites Authorization', () => {
    const proxy = new EventEmitter();
    let token = 'a'.repeat(64);
    attachFleetTokenAuth(proxy as Parameters<typeof attachFleetTokenAuth>[0], () => token);

    const firstHeaders = new Map<string, string>([['Authorization', 'Bearer stale']]);
    proxy.emit('proxyReq', {
      setHeader(name: string, value: string) {
        firstHeaders.set(name, value);
      },
    });

    token = 'b'.repeat(64);
    const secondHeaders = new Map<string, string>();
    proxy.emit('proxyReq', {
      setHeader(name: string, value: string) {
        secondHeaders.set(name, value);
      },
    });

    expect(firstHeaders.get('Authorization')).toBe(`Bearer ${'a'.repeat(64)}`);
    expect(secondHeaders.get('Authorization')).toBe(`Bearer ${'b'.repeat(64)}`);
  });

  it('does not set Authorization when no usable token exists', () => {
    const proxy = new EventEmitter();
    attachFleetTokenAuth(proxy as Parameters<typeof attachFleetTokenAuth>[0], () => '');

    const headers = new Map<string, string>();
    proxy.emit('proxyReq', {
      setHeader(name: string, value: string) {
        headers.set(name, value);
      },
    });

    expect(headers.has('Authorization')).toBe(false);
  });
});
