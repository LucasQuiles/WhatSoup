/**
 * #2359 finding 2 — `writeTempFile` must not leak a raw filesystem errno.
 *
 * Before this, neither `mkdirSync` nor `writeFileSync` was guarded, so a full
 * or read-only media volume surfaced at the MCP tool boundary as a bare ENOSPC
 * / EACCES with nothing naming media storage as the cause. The operator saw a
 * stack trace where they needed "media storage unavailable, here is the path".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, mkdirSync: fsMock.mkdirSync, writeFileSync: fsMock.writeFileSync };
});

const logMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../src/logger.ts', () => ({ createChildLogger: () => logMock }));

import { writeTempFile } from '../../src/core/media-download.ts';

/** Build an errno the way Node does, so `.code` is a real property not a literal shape. */
function errno(code: string): NodeJS.ErrnoException {
  const err = new Error(`simulated ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe('writeTempFile filesystem error handling (#2359)', () => {
  beforeEach(() => {
    fsMock.mkdirSync.mockReset();
    fsMock.writeFileSync.mockReset();
    logMock.error.mockReset();
  });

  it('still returns the written path when the filesystem is healthy', () => {
    const out = writeTempFile(Buffer.from('ok'), 'jpg');
    expect(out).toMatch(/\.jpg$/);
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
    expect(logMock.error).not.toHaveBeenCalled();
  });

  it('converts an ENOSPC write into a structured error that names media storage', () => {
    fsMock.writeFileSync.mockImplementation(() => { throw errno('ENOSPC'); });

    let caught: NodeJS.ErrnoException | undefined;
    try { writeTempFile(Buffer.from('x'), 'jpg'); } catch (err) { caught = err as NodeJS.ErrnoException; }

    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/media storage unavailable/i);
    // The original errno is PRESERVED, not flattened to a generic failure —
    // a caller that wants to distinguish "disk full" from "denied" still can.
    expect(caught?.code).toBe('ENOSPC');
    expect(caught?.path).toMatch(/\.jpg$/);
  });

  it('guards mkdirSync too, not only the write', () => {
    // The issue calls this out explicitly: a read-only or unwritable media dir
    // fails at mkdirSync, before writeFileSync is ever reached.
    fsMock.mkdirSync.mockImplementation(() => { throw errno('EACCES'); });

    let caught: NodeJS.ErrnoException | undefined;
    try { writeTempFile(Buffer.from('x'), 'png'); } catch (err) { caught = err as NodeJS.ErrnoException; }

    expect(caught?.code).toBe('EACCES');
    expect(caught?.message).toMatch(/media storage unavailable/i);
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  it('logs the failure with code and path rather than swallowing it', () => {
    fsMock.writeFileSync.mockImplementation(() => { throw errno('EROFS'); });

    expect(() => writeTempFile(Buffer.from('x'), 'ogg')).toThrow();

    expect(logMock.error).toHaveBeenCalledTimes(1);
    const [fields, msg] = logMock.error.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toMatch(/media temp-file write failed/i);
    expect(fields.code).toBe('EROFS');
    expect(fields.path).toMatch(/\.ogg$/);
  });

  it('falls back to EIO when the thrown value carries no errno code', () => {
    // Not every failure from the fs layer is a well-formed ErrnoException.
    fsMock.writeFileSync.mockImplementation(() => { throw new Error('no code on me'); });

    let caught: NodeJS.ErrnoException | undefined;
    try { writeTempFile(Buffer.from('x'), 'jpg'); } catch (err) { caught = err as NodeJS.ErrnoException; }

    expect(caught?.code).toBe('EIO');
  });
});
