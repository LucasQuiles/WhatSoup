import { createChildLogger } from '../../../logger.ts';

const log = createChildLogger('media:links');

const FETCH_TIMEOUT_MS = 10_000;
const MAX_CONTENT_LENGTH = 2000;

/**
 * Returns true if the hostname resolves to a private/loopback address range.
 * Used to prevent SSRF attacks on internal services.
 */
export function isPrivateHost(hostname: string): boolean {
  // IPv4 loopback and unspecified
  if (hostname === 'localhost' || hostname === '0.0.0.0') return true;
  // IPv6 loopback
  if (hostname === '::1' || hostname === '0:0:0:0:0:0:0:1') return true;
  // IPv4 private ranges
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (ipv4) {
    const [, a, b] = ipv4.map(Number);
    if (a === 127) return true;                               // 127.x.x.x loopback
    if (a === 10) return true;                                // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;        // 172.16.0.0/12
    if (a === 192 && b === 168) return true;                  // 192.168.0.0/16
    if (a === 169 && b === 254) return true;                  // 169.254.0.0/16 link-local
  }
  return false;
}

export interface LinkContent {
  title: string;
  content: string;
  fallbackLevel: 'readability' | 'meta' | 'title' | 'raw';
}

export function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
  const matches = text.match(urlRegex);
  return matches ?? [];
}

export async function extractLinkContent(url: string): Promise<LinkContent> {
  // SSRF protection: reject private/internal hostnames before fetching
  try {
    const parsed = new URL(url);
    if (isPrivateHost(parsed.hostname)) {
      log.warn({ url, hostname: parsed.hostname }, 'Blocked SSRF attempt to private host');
      return {
        title: url,
        content: `[blocked: private host]`,
        fallbackLevel: 'raw',
      };
    }
  } catch {
    // Invalid URL — proceed and let fetch handle it
  }

  let html = '';

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; bot/1.0)' },
    });
    html = await response.text();
  } catch (err) {
    log.warn({ err, url }, 'Failed to fetch URL — using raw fallback');
    return {
      title: url,
      content: `[couldn't fetch content]`,
      fallbackLevel: 'raw',
    };
  }

  // Attempt 1: Readability
  try {
    const { Readability } = await import('@mozilla/readability');
    const { parseHTML } = await import('linkedom');
    const { document } = parseHTML(html);
    const reader = new Readability(document as unknown as Document);
    const article = reader.parse();
    if (article && (article.title || article.textContent)) {
      const content = (article.textContent ?? '').trim().slice(0, MAX_CONTENT_LENGTH);
      log.info({ url, fallbackLevel: 'readability' }, 'Link content extracted via readability');
      return {
        title: article.title ?? url,
        content,
        fallbackLevel: 'readability',
      };
    }
  } catch (err) {
    log.warn({ err, url }, 'Readability extraction failed');
  }

  // Attempt 2: cheerio og:title + og:description
  try {
    const { load } = await import('cheerio');
    const $ = load(html);
    const ogTitle = $('meta[property="og:title"]').attr('content') ?? '';
    const ogDesc = $('meta[property="og:description"]').attr('content') ?? '';
    if (ogTitle || ogDesc) {
      const content = ogDesc.slice(0, MAX_CONTENT_LENGTH);
      log.info({ url, fallbackLevel: 'meta' }, 'Link content extracted via og meta tags');
      return {
        title: ogTitle || url,
        content,
        fallbackLevel: 'meta',
      };
    }
  } catch (err) {
    log.warn({ err, url }, 'cheerio og meta extraction failed');
  }

  // Attempt 3: cheerio title tag
  try {
    const { load } = await import('cheerio');
    const $ = load(html);
    const titleText = $('title').text().trim();
    if (titleText) {
      log.info({ url, fallbackLevel: 'title' }, 'Link content extracted via title tag');
      return {
        title: titleText,
        content: titleText.slice(0, MAX_CONTENT_LENGTH),
        fallbackLevel: 'title',
      };
    }
  } catch (err) {
    log.warn({ err, url }, 'cheerio title extraction failed');
  }

  // Fallback 4: raw URL
  log.info({ url, fallbackLevel: 'raw' }, 'Link content using raw fallback');
  return {
    title: url,
    content: `[couldn't fetch content]`,
    fallbackLevel: 'raw',
  };
}
