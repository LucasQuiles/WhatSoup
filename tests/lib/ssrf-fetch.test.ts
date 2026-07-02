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

// Mock node:dns promises.lookup so the DNS-aware pre-check (resolve-to-private,
// dns_failed) can be exercised deterministically. The callback `lookup` used by
// ssrfSafeAgent is left intact.
const { dnsLookupMock } = vi.hoisted(() => ({ dnsLookupMock: vi.fn() }));
vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return { ...actual, promises: { ...actual.promises, lookup: dnsLookupMock } };
});

describe('ssrf-fetch — host/IP classification', () => {
  it('QR-032: isPrivateHost blocks NAT64-wrapped private/metadata addresses (hex form)', () => {
    // 64:ff9b::/96 (RFC 6052) embeds an IPv4 in the last 32 bits. The dotted form
    // is already caught; the HEX form previously PASSED the guard (SSRF).
    expect(isPrivateHost('64:ff9b::a9fe:a9fe')).toBe(true);   // == 169.254.169.254 (cloud metadata)
    expect(isPrivateHost('64:ff9b::7f00:1')).toBe(true);      // == 127.0.0.1 (loopback)
    expect(isPrivateHost('64:ff9b:0:0:0:0:a9fe:a9fe')).toBe(true); // uncompressed form
    expect(isPrivateHost('[64:ff9b::a9fe:a9fe]')).toBe(true); // bracketed URL-host form
    expect(isPrivateHost('64:ff9b::169.254.169.254')).toBe(true); // dotted (already blocked, regression-lock)
    // Precision: a normal GLOBAL IPv6 whose last 32 bits look like a private IPv4
    // must NOT be misclassified as that IPv4.
    expect(isPrivateHost('2001:db8::a9fe:a9fe')).toBe(false);
    expect(isPrivateHost('64:ff9c::a9fe:a9fe')).toBe(false);  // adjacent prefix, NOT NAT64
  });

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

  it('isPrivateIP handles adversarial/malformed IPv6 inputs as not-private', () => {
    // UNHAPPY: a ::-prefixed address that is neither unspecified, loopback, nor an
    // embedded private IPv4 must NOT be misclassified as private (e.g. ::2 is public).
    expect(isPrivateIP('::2')).toBe(false);
    // Invalid IPv6 (non-hex first group) and non-IP garbage classify as not-private.
    expect(isPrivateIP('xyz::1')).toBe(false);
    expect(isPrivateIP('not-an-ip')).toBe(false);
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

describe('ssrf-fetch — fetchUrlGuarded DNS + connect-time SSRF defenses', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    dnsLookupMock.mockReset();
  });

  it('blocks a public hostname that DNS-resolves to a private IP (rebinding/SSRF)', async () => {
    // UNHAPPY/adversarial: hostname looks public but resolves into RFC1918 — must block
    // BEFORE any fetch is issued.
    dnsLookupMock.mockResolvedValue({ address: '10.0.0.1', family: 4 });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(fetchUrlGuarded('https://evil.example.com/x')).rejects.toMatchObject({
      name: 'SsrfBlockedError',
      reason: 'private_ip',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws dns_failed when resolution errors', async () => {
    dnsLookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(fetchUrlGuarded('https://nope.example.com/x')).rejects.toMatchObject({
      name: 'SsrfBlockedError',
      reason: 'dns_failed',
    });
  });

  it('treats a connect/redirect-time SSRF block (fetch throw) as private_ip', async () => {
    // UNHAPPY: pre-check passes (public IP) but the redirect hop resolves to a private IP;
    // undici surfaces it as a fetch throw whose message mentions "SSRF blocked".
    dnsLookupMock.mockResolvedValue({ address: '8.8.8.8', family: 4 });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('SSRF blocked: redirect to 169.254.169.254')));
    await expect(fetchUrlGuarded('https://redirector.example.com/x')).rejects.toMatchObject({
      name: 'SsrfBlockedError',
      reason: 'private_ip',
    });
  });

  it('re-throws a non-SSRF fetch error unchanged', async () => {
    dnsLookupMock.mockResolvedValue({ address: '8.8.8.8', family: 4 });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hang up')));
    await expect(fetchUrlGuarded('https://flaky.example.com/x')).rejects.toThrow(/socket hang up/);
  });

  it('returns status/headers/body on a successful guarded fetch', async () => {
    dnsLookupMock.mockResolvedValue({ address: '8.8.8.8', family: 4 });
    const response = {
      status: 200,
      headers: { forEach: (cb: (v: string, k: string) => void) => cb('text/plain', 'Content-Type') },
      body: null,
      text: async () => 'hello world',
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const result = await fetchUrlGuarded('https://ok.example.com/x');
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toBe('text/plain');
    expect(result.body).toBe('hello world');
  });
});
