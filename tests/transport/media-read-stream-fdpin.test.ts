/**
 * QR-090 — createMediaReadStream re-opens a caller-validated path BY NAME
 * (plain createReadStream, symlink-following, no fd-pin). A confined agent that
 * swaps the validated path for a symlink to an out-of-root secret between the
 * caller's realpath check and this re-open exfiltrates the secret to the chat
 * (lethal-trifecta read-then-send).
 *
 * The fix adds an fd-pin guard: once the stream's fd is open, the actually-opened
 * inode must match the canonical path AND the canonical path must be within
 * allowedRoot — else the stream is destroyed fail-closed BEFORE any bytes flow.
 * Lazy open is preserved (a deleted file still surfaces ENOENT via the stream's
 * 'error' event, unchanged).
 *
 * No real secrets — synthetic temp files only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { createMediaReadStream } from '../../src/transport/baileys-media-errors.ts';

const noopLog = { error() {}, warn() {}, info() {}, debug() {} } as unknown as import('pino').Logger;

function drain(stream: Readable): Promise<{ data: Buffer; error: Error | null }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let error: Error | null = null;
    stream.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    stream.on('error', (e: Error) => { error = e; });
    stream.on('close', () => resolve({ data: Buffer.concat(chunks), error }));
  });
}

describe('createMediaReadStream fd-pin TOCTOU guard (QR-090)', () => {
  let root: string;
  let outside: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'qr090-root-')));
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'qr090-secret-')));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('reads a legitimate file within allowedRoot', async () => {
    const f = join(root, 'ok.txt');
    writeFileSync(f, 'hello-media');
    const { data, error } = await drain(createMediaReadStream(f, root, noopLog));
    expect(error).toBeNull();
    expect(data.toString()).toBe('hello-media');
  });

  it('reads a legitimate file in a nested subdir within allowedRoot', async () => {
    const { mkdirSync } = await import('node:fs');
    const sub = join(root, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    const f = join(sub, 'nested.bin');
    writeFileSync(f, 'nested-ok');
    const { data, error } = await drain(createMediaReadStream(f, root, noopLog));
    expect(error).toBeNull();
    expect(data.toString()).toBe('nested-ok');
  });

  it('fails closed on a symlink pointing OUTSIDE allowedRoot — no secret bytes leak', async () => {
    const secret = join(outside, 'secret.txt');
    writeFileSync(secret, 'TOP-SECRET-CREDENTIAL');
    const link = join(root, 'evil'); // lives inside root, resolves outside
    symlinkSync(secret, link);
    const { data, error } = await drain(createMediaReadStream(link, root, noopLog));
    expect(error).not.toBeNull();
    expect(data.length).toBe(0);
    expect(data.toString()).not.toContain('TOP-SECRET');
  });

  it('fails closed when allowedRoot is undefined', async () => {
    const f = join(root, 'ok2.txt');
    writeFileSync(f, 'data');
    const { data, error } = await drain(createMediaReadStream(f, undefined as unknown as string, noopLog));
    expect(error).not.toBeNull();
    expect(data.length).toBe(0);
  });
});
