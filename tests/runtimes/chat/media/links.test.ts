import { describe, it, expect, vi, afterEach } from 'vitest';
import * as nodeDns from 'node:dns';

vi.mock('../../../../src/logger.ts', async () => (await import('../../../helpers/logger-mock.ts')).loggerMock());

import { extractUrls, extractLinkContent, isPrivateHost, isPrivateIP, ssrfSafeLookup, readBodyCapped } from '../../../../src/runtimes/chat/media/links.ts';

// ---------------------------------------------------------------------------
// extractUrls — positive
// ---------------------------------------------------------------------------

describe('extractUrls', () => {
  it('finds a single HTTP URL in plain text', () => {
    const urls = extractUrls('Check this out: http://example.com/page');
    expect(urls).toEqual(['http://example.com/page']);
  });

  it('finds multiple HTTPS URLs in text', () => {
    const text = 'Visit https://foo.com and https://bar.org/path?q=1 for details';
    const urls = extractUrls(text);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe('https://foo.com');
    expect(urls[1]).toBe('https://bar.org/path?q=1');
  });

  it('returns empty array when no URLs present', () => {
    const urls = extractUrls('No links here at all');
    expect(urls).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(extractUrls('')).toEqual([]);
  });

  it('handles URL at start of string', () => {
    const urls = extractUrls('https://start.example.com is first');
    expect(urls).toContain('https://start.example.com');
  });
});

// ---------------------------------------------------------------------------
// extractLinkContent — fetch timeout / error → raw URL fallback
// ---------------------------------------------------------------------------

describe('extractLinkContent — negative (fetch failure)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetch timeout → returns raw fallback with original URL as title', async () => {
    // Simulate fetch throwing an AbortError (timeout)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Timeout', 'AbortError')));

    const url = 'https://timeout-example.com/article';
    const result = await extractLinkContent(url);

    expect(result.fallbackLevel).toBe('raw');
    expect(result.title).toBe(url);
    expect(result.content).toContain("couldn't fetch content");
  });

  it('network error → returns raw fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const url = 'https://offline.example.com';
    const result = await extractLinkContent(url);

    expect(result.fallbackLevel).toBe('raw');
    expect(result.title).toBe(url);
  });

  it('readability content truncated to 2000 chars', async () => {
    const longContent = 'x'.repeat(5000);
    // Serve a simple but valid HTML page with enough content for Readability
    const html = `<!DOCTYPE html><html><head><title>T</title></head><body><p>${longContent}</p></body></html>`;

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      text: () => Promise.resolve(html),
      ok: true,
    }));

    const url = 'https://article.example.com';
    const result = await extractLinkContent(url);

    // Whether extracted via readability, meta, or title — content must not exceed 2000
    expect(result.content.length).toBeLessThanOrEqual(2000);
  });
});

// ---------------------------------------------------------------------------
// isPrivateHost — direct unit tests
// ---------------------------------------------------------------------------

describe('isPrivateHost', () => {
  it('returns true for localhost', () => {
    expect(isPrivateHost('localhost')).toBe(true);
  });

  it('returns true for 0.0.0.0', () => {
    expect(isPrivateHost('0.0.0.0')).toBe(true);
  });

  it('returns true for IPv6 loopback ::1', () => {
    expect(isPrivateHost('::1')).toBe(true);
  });

  it('returns true for IPv6 loopback long form', () => {
    expect(isPrivateHost('0:0:0:0:0:0:0:1')).toBe(true);
  });

  it('returns true for 127.x.x.x loopback', () => {
    expect(isPrivateHost('127.0.0.1')).toBe(true);
    expect(isPrivateHost('127.255.255.1')).toBe(true);
  });

  it('returns true for 10.0.0.0/8 private range', () => {
    expect(isPrivateHost('10.0.0.1')).toBe(true);
    expect(isPrivateHost('10.255.255.255')).toBe(true);
  });

  it('returns true for 172.16.0.0/12 private range', () => {
    expect(isPrivateHost('172.16.0.1')).toBe(true);
    expect(isPrivateHost('172.31.255.255')).toBe(true);
  });

  it('returns false for 172.15.x.x (just outside /12 range)', () => {
    expect(isPrivateHost('172.15.0.1')).toBe(false);
  });

  it('returns false for 172.32.x.x (just outside /12 range)', () => {
    expect(isPrivateHost('172.32.0.1')).toBe(false);
  });

  it('returns true for 192.168.0.0/16 private range', () => {
    expect(isPrivateHost('192.168.0.1')).toBe(true);
    expect(isPrivateHost('192.168.255.255')).toBe(true);
  });

  it('returns true for 169.254.0.0/16 link-local', () => {
    expect(isPrivateHost('169.254.1.1')).toBe(true);
    expect(isPrivateHost('169.254.169.254')).toBe(true);
  });

  it('returns false for 169.255.0.0 (not link-local)', () => {
    expect(isPrivateHost('169.255.0.0')).toBe(false);
  });

  it('returns false for a public IP', () => {
    expect(isPrivateHost('8.8.8.8')).toBe(false);
  });

  it('returns false for a public hostname', () => {
    expect(isPrivateHost('example.com')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPrivateIP — direct unit tests
// ---------------------------------------------------------------------------

describe('isPrivateIP', () => {
  it('returns true for 10.0.0.0/8', () => {
    expect(isPrivateIP('10.0.0.1')).toBe(true);
  });

  it('returns true for 172.16.0.0/12', () => {
    expect(isPrivateIP('172.20.0.5')).toBe(true);
  });

  it('returns true for 172.31.255.255 (top of /12)', () => {
    expect(isPrivateIP('172.31.255.255')).toBe(true);
  });

  it('returns false for 172.15.x.x', () => {
    expect(isPrivateIP('172.15.0.1')).toBe(false);
  });

  it('returns false for 172.32.x.x', () => {
    expect(isPrivateIP('172.32.0.1')).toBe(false);
  });

  it('returns true for 192.168.0.0/16', () => {
    expect(isPrivateIP('192.168.1.100')).toBe(true);
  });

  it('returns true for 127.0.0.0/8 loopback', () => {
    expect(isPrivateIP('127.0.0.1')).toBe(true);
  });

  it('returns true for 169.254.x.x link-local / cloud metadata', () => {
    expect(isPrivateIP('169.254.169.254')).toBe(true);
  });

  it('returns true for 0.0.0.0 special case', () => {
    expect(isPrivateIP('0.0.0.0')).toBe(true);
  });

  it('returns true for ::1 IPv6 loopback', () => {
    expect(isPrivateIP('::1')).toBe(true);
  });

  it('returns true for :: unspecified', () => {
    expect(isPrivateIP('::')).toBe(true);
  });

  it('returns false for a public IP', () => {
    expect(isPrivateIP('8.8.8.8')).toBe(false);
  });

  it('returns false for a non-IPv4 non-special string', () => {
    expect(isPrivateIP('not-an-ip')).toBe(false);
  });

  it('returns false for an IPv4 string with out-of-range octet (>255)', () => {
    expect(isPrivateIP('192.168.1.300')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractUrls — edge cases for regex stop characters
// ---------------------------------------------------------------------------

describe('extractUrls — regex boundary characters', () => {
  it('stops URL at double-quote character', () => {
    const urls = extractUrls('<a href="https://quoted.example.com/path">click</a>');
    expect(urls).toEqual(['https://quoted.example.com/path']);
  });

  it('stops URL at angle bracket', () => {
    const urls = extractUrls('see <https://angle.example.com/path> for details');
    expect(urls).toEqual(['https://angle.example.com/path']);
  });

  it('stops URL at whitespace', () => {
    const urls = extractUrls('link: https://space.example.com/a end');
    expect(urls).toEqual(['https://space.example.com/a']);
  });

  it('handles URL with query string and fragment', () => {
    const urls = extractUrls('go to https://search.example.com/q?term=foo&page=2#results now');
    expect(urls).toEqual(['https://search.example.com/q?term=foo&page=2#results']);
  });
});

// ---------------------------------------------------------------------------
// extractLinkContent — SSRF protection via private hostname
// ---------------------------------------------------------------------------

describe('extractLinkContent — SSRF hostname blocking', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('blocks request to localhost', async () => {
    const result = await extractLinkContent('http://localhost/admin');
    expect(result.fallbackLevel).toBe('raw');
    expect(result.title).toBe('http://localhost/admin');
    expect(result.content).toBe('[blocked: private host]');
  });

  it('blocks request to 192.168.x.x private IP', async () => {
    const result = await extractLinkContent('http://192.168.1.1/api');
    expect(result.fallbackLevel).toBe('raw');
    expect(result.content).toBe('[blocked: private host]');
  });

  it('blocks request to 10.x.x.x private IP', async () => {
    const result = await extractLinkContent('http://10.0.0.5/secret');
    expect(result.fallbackLevel).toBe('raw');
    expect(result.content).toBe('[blocked: private host]');
  });

  it('blocks request to 172.16.x.x private IP', async () => {
    const result = await extractLinkContent('http://172.16.0.1/internal');
    expect(result.fallbackLevel).toBe('raw');
    expect(result.content).toBe('[blocked: private host]');
  });

  it('blocks cloud metadata endpoint 169.254.169.254', async () => {
    const result = await extractLinkContent('http://169.254.169.254/latest/meta-data/');
    expect(result.fallbackLevel).toBe('raw');
    expect(result.content).toBe('[blocked: private host]');
  });
});

// ---------------------------------------------------------------------------
// extractLinkContent — DNS-based SSRF protection
// ---------------------------------------------------------------------------

describe('extractLinkContent — DNS-aware SSRF blocking', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('blocks domain that resolves to a private IP', async () => {
    vi.spyOn(nodeDns.promises, 'lookup').mockResolvedValue({ address: '10.0.0.1', family: 4 });

    const result = await extractLinkContent('https://evil.example.com/payload');
    expect(result.fallbackLevel).toBe('raw');
    expect(result.content).toBe('[blocked: private host]');
  });

  it('returns raw fallback when DNS lookup fails', async () => {
    vi.spyOn(nodeDns.promises, 'lookup').mockRejectedValue(new Error('ENOTFOUND'));

    const result = await extractLinkContent('https://nonexistent-domain-xyz.example.com/');
    expect(result.fallbackLevel).toBe('raw');
    expect(result.title).toBe('https://nonexistent-domain-xyz.example.com/');
    expect(result.content).toBe("[couldn't fetch content]");
  });
});

// ---------------------------------------------------------------------------
// extractLinkContent — HTML extraction fallback levels
// ---------------------------------------------------------------------------

describe('extractLinkContent — HTML extraction fallback levels', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Helper: mock DNS lookup to return a public IP so SSRF guard passes
  function mockPublicDns() {
    vi.spyOn(nodeDns.promises, 'lookup').mockResolvedValue({ address: '93.184.216.34', family: 4 });
  }

  it('returns meta fallback level when og:title and og:description present', async () => {
    mockPublicDns();
    const html = `<!DOCTYPE html><html><head>
      <meta property="og:title" content="My OG Title" />
      <meta property="og:description" content="My OG Description" />
    </head><body></body></html>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ text: () => Promise.resolve(html), ok: true }));

    const result = await extractLinkContent('https://og.example.com/');
    expect(result.fallbackLevel).toBe('meta');
    expect(result.title).toBe('My OG Title');
    expect(result.content).toBe('My OG Description');
  });

  it('returns meta fallback with URL as title when og:title empty but og:description present', async () => {
    mockPublicDns();
    const url = 'https://og-desc-only.example.com/';
    const html = `<!DOCTYPE html><html><head>
      <meta property="og:description" content="Desc only" />
    </head><body></body></html>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ text: () => Promise.resolve(html), ok: true }));

    const result = await extractLinkContent(url);
    expect(result.fallbackLevel).toBe('meta');
    expect(result.title).toBe(url);
    expect(result.content).toBe('Desc only');
  });

  it('returns title fallback when only <title> tag present (no og tags)', async () => {
    mockPublicDns();
    const html = `<!DOCTYPE html><html><head><title>Page Title Here</title></head><body><p>Short.</p></body></html>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ text: () => Promise.resolve(html), ok: true }));

    const result = await extractLinkContent('https://title-only.example.com/');
    // Readability may parse "Short." as content — if so, fallbackLevel is 'readability'.
    // Otherwise it falls back to 'title'. Either way title must match.
    expect(['readability', 'title']).toContain(result.fallbackLevel);
    expect(result.title).toMatch(/Page Title Here|title-only/);
  });

  it('og:description truncated to 2000 chars', async () => {
    mockPublicDns();
    const longDesc = 'y'.repeat(5000);
    const html = `<!DOCTYPE html><html><head>
      <meta property="og:title" content="Long Desc Test" />
      <meta property="og:description" content="${longDesc}" />
    </head><body></body></html>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ text: () => Promise.resolve(html), ok: true }));

    const result = await extractLinkContent('https://longdesc.example.com/');
    expect(result.fallbackLevel).toBe('meta');
    expect(result.content.length).toBeLessThanOrEqual(2000);
  });

  it('returns raw fallback when HTML has no parseable content', async () => {
    mockPublicDns();
    const html = `<!DOCTYPE html><html><head></head><body></body></html>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ text: () => Promise.resolve(html), ok: true }));

    const result = await extractLinkContent('https://empty.example.com/');
    // Readability on empty body typically yields null; no og tags; no title — must be raw
    expect(result.fallbackLevel).toBe('raw');
    expect(result.title).toBe('https://empty.example.com/');
    expect(result.content).toBe("[couldn't fetch content]");
  });
});

// ---------------------------------------------------------------------------
// ssrfSafeLookup — connection-time IP validation (redirect + DNS-rebind guard)
// ---------------------------------------------------------------------------

describe('ssrfSafeLookup', () => {
  // Fake resolver injected as the 4th arg (undici uses the default dns.lookup at runtime).
  const fakeResolver = (result: unknown, family?: number) =>
    ((_host: string, _opts: unknown, cb: (e: unknown, a: unknown, f?: unknown) => void) => {
      cb(null, result, family);
    }) as unknown as typeof nodeDns.lookup;

  it('passes a public IP through to the callback', () => {
    const cb = vi.fn();
    ssrfSafeLookup('example.com', {} as never, cb, fakeResolver('93.184.216.34', 4));
    expect(cb).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  });

  it('rejects when the hostname resolves to a private/metadata IP (rebind/redirect guard)', () => {
    const cb = vi.fn();
    ssrfSafeLookup('rebind.evil.test', {} as never, cb, fakeResolver('169.254.169.254', 4));
    const err = cb.mock.calls[0][0] as Error | null;
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain('169.254.169.254');
  });

  it('rejects when any address in an all:true result is private', () => {
    const cb = vi.fn();
    ssrfSafeLookup(
      'mixed.evil.test',
      { all: true } as never,
      cb,
      fakeResolver([
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ]),
    );
    expect(cb.mock.calls[0][0] as Error | null).toBeInstanceOf(Error);
  });

  it('propagates a DNS resolution error unchanged', () => {
    const dnsErr = Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    const errResolver = ((_host: string, _opts: unknown, cb: (e: unknown, a: unknown, f?: unknown) => void) => {
      cb(dnsErr, undefined, undefined);
    }) as unknown as typeof nodeDns.lookup;
    const cb = vi.fn();
    ssrfSafeLookup('nx.example.com', {} as never, cb, errResolver);
    expect(cb.mock.calls[0][0]).toBe(dnsErr);
  });
});

// ---------------------------------------------------------------------------
// readBodyCapped — bounded body read (memory-DoS guard)
// ---------------------------------------------------------------------------

describe('readBodyCapped', () => {
  it('falls back to text() and truncates when there is no body stream', async () => {
    const big = 'y'.repeat(50);
    const out = await readBodyCapped({ text: () => Promise.resolve(big) }, 10);
    expect(out).toBe('y'.repeat(10));
  });

  it('returns full text() output when under the cap', async () => {
    const out = await readBodyCapped({ text: () => Promise.resolve('short') }, 1000);
    expect(out).toBe('short');
  });

  it('caps an oversized streamed body at maxBytes and cancels the stream', async () => {
    const enc = new TextEncoder();
    let cancelled = false;
    const chunks = [enc.encode('a'.repeat(8)), enc.encode('b'.repeat(8)), enc.encode('c'.repeat(8))];
    let i = 0;
    const body = {
      getReader() {
        return {
          read() {
            if (i < chunks.length) return Promise.resolve({ done: false, value: chunks[i++] });
            return Promise.resolve({ done: true, value: undefined });
          },
          cancel() {
            cancelled = true;
            return Promise.resolve();
          },
          releaseLock() {},
        };
      },
    };
    const out = await readBodyCapped({ body, text: () => Promise.resolve('UNUSED') } as never, 10);
    expect(out.length).toBe(10);
    expect(out).not.toContain('UNUSED');
    expect(cancelled).toBe(true);
  });
});
