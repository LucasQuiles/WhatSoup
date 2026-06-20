import { promises as dns } from 'node:dns';
import type { Agent } from 'undici';
import { createChildLogger } from '../../../logger.ts';
import {
  isPrivateHost,
  isPrivateIP,
  ssrfSafeAgent,
  readBodyCapped,
  MAX_FETCH_BYTES,
} from '../../../lib/ssrf-fetch.ts';

// Re-export the shared SSRF primitives so existing importers/tests of this
// module keep working. The canonical implementation now lives in
// `src/lib/ssrf-fetch.ts` (the only layer both `runtimes` and `core` may
// import) — there is exactly ONE outbound fetcher in the codebase.
export {
  isPrivateHost,
  isPrivateIP,
  ssrfSafeLookup,
  readBodyCapped,
  fetchUrlGuarded,
  SsrfBlockedError,
  MAX_FETCH_BYTES,
  type GuardedFetchResult,
} from '../../../lib/ssrf-fetch.ts';

const log = createChildLogger('media:links');

const FETCH_TIMEOUT_MS = 10_000;
const MAX_CONTENT_LENGTH = 2000;

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
  let hostname: string | undefined;
  try {
    const parsed = new URL(url);
    hostname = parsed.hostname;
    if (isPrivateHost(hostname)) {
      log.warn({ url, hostname }, 'Blocked SSRF attempt to private host');
      return {
        title: url,
        content: `[blocked: private host]`,
        fallbackLevel: 'raw',
      };
    }
  } catch {
    // Invalid URL — proceed and let fetch handle it
  }

  // DNS-aware SSRF protection: resolve hostname and verify the IP is not private.
  // Catches attacker-controlled domains that resolve to 127.0.0.1, 169.254.169.254, etc.
  if (hostname) {
    try {
      const { address } = await dns.lookup(hostname);
      if (isPrivateIP(address)) {
        log.warn({ url, resolvedIP: address }, 'SSRF: domain resolves to private IP');
        return {
          title: url,
          content: `[blocked: private host]`,
          fallbackLevel: 'raw',
        };
      }
    } catch {
      // DNS resolution failed — skip the fetch
      return {
        title: url,
        content: `[couldn't fetch content]`,
        fallbackLevel: 'raw',
      };
    }
  }

  let html = '';

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; bot/1.0)' },
      // Validate the connected IP at connect time and on every redirect hop (SSRF guard).
      dispatcher: ssrfSafeAgent,
    } as RequestInit & { dispatcher: Agent });
    const declaredLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_FETCH_BYTES) {
      log.warn({ url, declaredLength }, 'Response exceeds size cap — using raw fallback');
      return {
        title: url,
        content: `[couldn't fetch content]`,
        fallbackLevel: 'raw',
      };
    }
    html = await readBodyCapped(response, MAX_FETCH_BYTES);
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
