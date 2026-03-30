import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { extractUrls, extractLinkContent } from '../../../../src/runtimes/chat/media/links.ts';

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
