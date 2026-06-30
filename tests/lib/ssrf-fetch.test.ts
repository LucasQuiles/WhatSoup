/**
 * Tests for src/lib/ssrf-fetch.ts — the shared SSRF-guarded fetch stack reused
 * by the link-preview path and the substrate poll.url watch executor.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as dns, type LookupAddress } from 'node:dns';
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

  it('isPrivateIP blocks additional reserved IPv4 ranges', () => {
    expect(isPrivateIP('0.0.0.0')).toBe(true);          // 0.0.0.0/8 "this network"
    expect(isPrivateIP('0.1.2.3')).toBe(true);          // 0.0.0.0/8
    expect(isPrivateIP('100.64.0.1')).toBe(true);       // 100.64.0.0/10 CGNAT
    expect(isPrivateIP('100.127.255.255')).toBe(true);  // CGNAT upper edge
    expect(isPrivateIP('192.0.2.5')).toBe(true);        // 192.0.2.0/24 TEST-NET-1
    expect(isPrivateIP('198.51.100.5')).toBe(true);     // 198.51.100.0/24 TEST-NET-2
    expect(isPrivateIP('203.0.113.5')).toBe(true);      // 203.0.113.0/24 TEST-NET-3
    expect(isPrivateIP('224.0.0.1')).toBe(true);        // 224.0.0.0/4 multicast
    expect(isPrivateIP('239.255.255.255')).toBe(true);  // multicast upper edge
    expect(isPrivateIP('240.0.0.1')).toBe(true);        // 240.0.0.0/4 reserved
    expect(isPrivateIP('255.255.255.255')).toBe(true);  // limited broadcast
    // CGNAT boundaries: 100.63.x is public, 100.128.x is public
    expect(isPrivateIP('100.63.255.255')).toBe(false);
    expect(isPrivateIP('100.128.0.0')).toBe(false);
    // Still allow public
    expect(isPrivateIP('1.1.1.1')).toBe(false);
    expect(isPrivateIP('93.184.216.34')).toBe(false);
  });

  it('isPrivateIP blocks IPv6 ULA, link-local, multicast, unspecified', () => {
    expect(isPrivateIP('::')).toBe(true);               // unspecified
    expect(isPrivateIP('::1')).toBe(true);              // loopback
    expect(isPrivateIP('fc00::1')).toBe(true);          // ULA fc00::/7 (fc..)
    expect(isPrivateIP('fd12:3456:789a::1')).toBe(true);// ULA fc00::/7 (fd..)
    expect(isPrivateIP('fe80::1')).toBe(true);          // link-local fe80::/10
    expect(isPrivateIP('febf:ffff::1')).toBe(true);     // link-local upper edge
    expect(isPrivateIP('ff02::1')).toBe(true);          // multicast ff00::/8
    expect(isPrivateIP('FE80::1')).toBe(true);          // case-insensitive
    // Public IPv6 still allowed
    expect(isPrivateIP('2606:4700:4700::1111')).toBe(false); // cloudflare dns
    expect(isPrivateIP('2001:4860:4860::8888')).toBe(false); // google dns
    // fec0::/10 site-local is deprecated-but-reserved; fe-c0 is NOT link-local
    expect(isPrivateIP('fec0::1')).toBe(false);
  });

  it('isPrivateIP blocks IPv4-mapped IPv6 by classifying the embedded IPv4', () => {
    expect(isPrivateIP('::ffff:127.0.0.1')).toBe(true);   // mapped loopback
    expect(isPrivateIP('::ffff:10.0.0.1')).toBe(true);    // mapped RFC1918
    expect(isPrivateIP('::ffff:169.254.169.254')).toBe(true); // mapped metadata
    expect(isPrivateIP('::ffff:192.168.1.1')).toBe(true); // mapped RFC1918
    // hex-form IPv4-mapped (::ffff:7f00:1 == 127.0.0.1)
    expect(isPrivateIP('::ffff:7f00:0001')).toBe(true);
    // mapped public address stays allowed
    expect(isPrivateIP('::ffff:8.8.8.8')).toBe(false);
  });

  it('isPrivateHost blocks IPv6 literal private ranges and mapped IPv4', () => {
    expect(isPrivateHost('fc00::1')).toBe(true);
    expect(isPrivateHost('fe80::1')).toBe(true);
    expect(isPrivateHost('ff02::1')).toBe(true);
    expect(isPrivateHost('::')).toBe(true);
    expect(isPrivateHost('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateHost('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateHost('0.0.0.0')).toBe(true);
    expect(isPrivateHost('100.64.0.1')).toBe(true);
    expect(isPrivateHost('192.0.2.1')).toBe(true);
    expect(isPrivateHost('224.0.0.1')).toBe(true);
    expect(isPrivateHost('2606:4700:4700::1111')).toBe(false);
  });

  it('isPrivateHost handles bracketed IPv6 literals from URL hosts', () => {
    expect(isPrivateHost('[::1]')).toBe(true);
    expect(isPrivateHost('[2606:4700:4700::1111]')).toBe(false);
  });

  it('isPrivateIP treats malformed IPv4/IPv6 text as unclassified, not private', () => {
    expect(isPrivateIP('999.1.2.3')).toBe(false);
    expect(isPrivateIP('zzzz::1')).toBe(false);
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

  it('passes resolver errors through unchanged', () => {
    const resolverError = Object.assign(new Error('temporary DNS failure'), { code: 'EAI_AGAIN' });
    const fakeResolve = ((_host: string, _opts: unknown, cb: (e: Error, a: string, f: number) => void) => {
      cb(resolverError, '', 0);
    }) as never;
    let resolvedAddr: string | LookupAddress[] | null = null;
    let resolvedFamily: number | undefined;
    let resolvedErr: unknown = null;

    ssrfSafeLookup('flaky.example', { family: 4 } as never, (e, a, f) => {
      resolvedErr = e;
      resolvedAddr = a;
      resolvedFamily = f;
    }, fakeResolve);

    expect(resolvedErr).toBe(resolverError);
    expect(resolvedAddr).toBe('');
    expect(resolvedFamily).toBe(0);
  });
});

describe('ssrf-fetch — readBodyCapped', () => {
  it('truncates a text() fallback body at the cap', async () => {
    const resp = { text: async () => 'abcdefghij' };
    expect(await readBodyCapped(resp, 4)).toBe('abcd');
  });

  it('reads a stream body until done and releases the reader', async () => {
    const encoder = new TextEncoder();
    const reads = [
      { done: false, value: encoder.encode('hello') },
      { done: true, value: undefined },
    ];
    const reader = {
      read: vi.fn(async () => reads.shift() ?? { done: true, value: undefined }),
      cancel: vi.fn(async () => undefined),
      releaseLock: vi.fn(),
    };
    const resp = {
      body: { getReader: () => reader },
      text: async () => {
        throw new Error('streaming response should not use text fallback');
      },
    };

    await expect(readBodyCapped(resp, 100)).resolves.toBe('hello');
    expect(reader.cancel).not.toHaveBeenCalled();
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('skips empty stream reads, truncates at the cap, and cancels the reader', async () => {
    const encoder = new TextEncoder();
    const reads = [
      { done: false, value: undefined },
      { done: false, value: encoder.encode('abc') },
      { done: false, value: encoder.encode('def') },
      { done: true, value: undefined },
    ];
    const reader = {
      read: vi.fn(async () => reads.shift() ?? { done: true, value: undefined }),
      cancel: vi.fn(async () => undefined),
      releaseLock: vi.fn(),
    };
    const resp = {
      body: { getReader: () => reader },
      text: async () => {
        throw new Error('streaming response should not use text fallback');
      },
    };

    await expect(readBodyCapped(resp, 4)).resolves.toBe('abcd');
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('cancels immediately and returns empty text when the cap is zero', async () => {
    const encoder = new TextEncoder();
    const reads = [
      { done: false, value: encoder.encode('discarded') },
      { done: true, value: undefined },
    ];
    const reader = {
      read: vi.fn(async () => reads.shift() ?? { done: true, value: undefined }),
      cancel: vi.fn(async () => undefined),
      releaseLock: vi.fn(),
    };
    const resp = {
      body: { getReader: () => reader },
      text: async () => {
        throw new Error('streaming response should not use text fallback');
      },
    };

    await expect(readBodyCapped(resp, 0)).resolves.toBe('');
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
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

  it('throws SsrfBlockedError(private_ip) when DNS resolves a public host to a private address', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue({ address: '169.254.169.254', family: 4 });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(fetchUrlGuarded('https://attacker.example/path')).rejects.toMatchObject({
      name: 'SsrfBlockedError',
      reason: 'private_ip',
      message: expect.stringContaining('169.254.169.254'),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws SsrfBlockedError(dns_failed) when DNS lookup fails before fetch', async () => {
    vi.spyOn(dns, 'lookup').mockRejectedValue(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(fetchUrlGuarded('https://missing.example/path')).rejects.toMatchObject({
      name: 'SsrfBlockedError',
      reason: 'dns_failed',
      message: 'DNS resolution failed for missing.example',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps connect-time SSRF lookup failures into a blocked result', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue({ address: '93.184.216.34', family: 4 });
    const connectError = new Error('fetch failed', {
      cause: new Error('SSRF blocked: redirect.example resolves to private IP 127.0.0.1'),
    });
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw connectError;
    }));

    await expect(fetchUrlGuarded('https://redirect.example/path')).rejects.toMatchObject({
      name: 'SsrfBlockedError',
      reason: 'private_ip',
      message: 'connect/redirect resolved to a private IP for redirect.example',
    });
  });

  it('preserves generic fetch failures after DNS passes', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue({ address: '93.184.216.34', family: 4 });
    const networkError = new Error('socket hang up');
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw networkError;
    }));

    await expect(fetchUrlGuarded('https://example.com/path')).rejects.toBe(networkError);
  });

  it('returns normalized headers and capped body for a public URL', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue({ address: '93.184.216.34', family: 4 });
    const fetchSpy = vi.fn<(input: string, init?: RequestInit & { dispatcher?: unknown }) => Promise<Response>>(async () => new Response('abcdefghij', {
      status: 203,
      headers: { 'X-Trace-Id': 'abc123' },
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await fetchUrlGuarded('https://example.com/path', { maxBytes: 4, timeoutMs: 250 });

    expect(result.status).toBe(203);
    expect(result.headers['x-trace-id']).toBe('abc123');
    expect(result.body).toBe('abcd');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://example.com/path');
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; bot/1.0)' },
    });
    expect(fetchSpy.mock.calls[0]?.[1]).toHaveProperty('dispatcher');
    expect(fetchSpy.mock.calls[0]?.[1]).toHaveProperty('signal');
  });
});
