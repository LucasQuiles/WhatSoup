/**
 * Tests for src/lib/ssrf-fetch.ts — the shared SSRF-guarded fetch stack reused
 * by the link-preview path and the substrate poll.url watch executor.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isPrivateHost,
  isPrivateIP,
  ssrfSafeLookup,
  readBodyCapped,
  fetchUrlGuarded,
  SsrfBlockedError,
} from '../../src/lib/ssrf-fetch.ts';

describe('ssrf-fetch — host/IP classification', () => {
  it('isPrivateHost blocks loopback, RFC1918, and link-local literals', () => {
    expect(isPrivateHost('localhost')).toBe(true);
    expect(isPrivateHost('127.0.0.1')).toBe(true);
    expect(isPrivateHost('10.0.0.1')).toBe(true);
    expect(isPrivateHost('172.16.5.5')).toBe(true);
    expect(isPrivateHost('192.168.1.1')).toBe(true);
    expect(isPrivateHost('169.254.169.254')).toBe(true);
    expect(isPrivateHost('::1')).toBe(true);
    expect(isPrivateHost('example.com')).toBe(false);
    expect(isPrivateHost('93.184.216.34')).toBe(false);
  });

  it('isPrivateIP blocks reserved ranges incl. cloud-metadata, allows public', () => {
    expect(isPrivateIP('127.0.0.1')).toBe(true);
    expect(isPrivateIP('169.254.169.254')).toBe(true);
    expect(isPrivateIP('10.255.255.255')).toBe(true);
    expect(isPrivateIP('::1')).toBe(true);
    expect(isPrivateIP('8.8.8.8')).toBe(false);
  });
});

describe('ssrf-fetch — ssrfSafeLookup', () => {
  it('rejects resolution to a private IP via the callback', () => {
    const fakeResolve = ((_host: string, _opts: unknown, cb: (e: unknown, a: string, f: number) => void) => {
      cb(null, '169.254.169.254', 4);
    }) as never;
    let err: Error | null = null;
    ssrfSafeLookup('attacker.example', { family: 4 } as never, (e) => { err = e as Error | null; }, fakeResolve);
    expect(err).toBeInstanceOf(Error);
    expect((err as unknown as Error).message).toMatch(/SSRF blocked/);
  });

  it('passes through a public resolution unchanged', () => {
    const fakeResolve = ((_host: string, _opts: unknown, cb: (e: unknown, a: string, f: number) => void) => {
      cb(null, '93.184.216.34', 4);
    }) as never;
    let resolvedAddr: string | null = null;
    let resolvedErr: unknown = 'untouched';
    ssrfSafeLookup('example.com', { family: 4 } as never, (e, a) => { resolvedErr = e; resolvedAddr = a as string; }, fakeResolve);
    expect(resolvedErr).toBeNull();
    expect(resolvedAddr).toBe('93.184.216.34');
  });
});

describe('ssrf-fetch — readBodyCapped', () => {
  it('truncates a text() fallback body at the cap', async () => {
    const resp = { text: async () => 'abcdefghij' };
    expect(await readBodyCapped(resp, 4)).toBe('abcd');
  });
});

describe('ssrf-fetch — fetchUrlGuarded fail-closed', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('throws SsrfBlockedError(private_host) for a loopback host before any fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(fetchUrlGuarded('https://localhost/x')).rejects.toMatchObject({
      name: 'SsrfBlockedError',
      reason: 'private_host',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws SsrfBlockedError(invalid_url) for an unparseable URL', async () => {
    await expect(fetchUrlGuarded('::::not a url')).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});
