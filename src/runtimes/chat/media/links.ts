import { promises as dns, lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { Agent } from 'undici';
import { createChildLogger } from '../../../logger.ts';

const log = createChildLogger('media:links');

const FETCH_TIMEOUT_MS = 10_000;
const MAX_CONTENT_LENGTH = 2000;
// Hard cap on bytes read from a fetched URL. Prevents a malicious/large response from
// exhausting memory (the preview only needs the first ~2000 chars of extracted content).
const MAX_FETCH_BYTES = 5_000_000;

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

/**
 * Check if a resolved IP address falls within private/reserved ranges.
 * Used as a DNS-aware SSRF guard: even if the hostname looks public,
 * reject it when it resolves to a private IP.
 */
export function isPrivateIP(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length === 4 && parts.every((n) => n >= 0 && n <= 255)) {
    if (parts[0] === 10) return true;                                // 10.0.0.0/8
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
    if (parts[0] === 192 && parts[1] === 168) return true;          // 192.168.0.0/16
    if (parts[0] === 127) return true;                               // 127.0.0.0/8 loopback
    if (parts[0] === 169 && parts[1] === 254) return true;          // 169.254.0.0/16 link-local / cloud metadata
  }
  if (ip === '0.0.0.0' || ip === '::1' || ip === '::') return true;
  return false;
}

/**
 * A `dns.lookup`-compatible callback that rejects resolution to a private/reserved IP.
 * Used as the undici connect-time lookup, which undici invokes for the initial connection
 * AND for every redirect hop, so the *actual* connected IP is validated. This closes two
 * SSRF gaps a one-shot pre-fetch `dns.lookup` cannot:
 *  - redirect-follow SSRF: a public URL that 3xx-redirects to http://169.254.169.254/ etc.
 *  - DNS-rebinding TOCTOU: a hostname that resolves public at check time, private at connect.
 * Exported for direct testing.
 */
export function ssrfSafeLookup(
  hostname: string,
  options: Parameters<typeof dnsLookup>[1],
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
  // Injectable resolver (defaults to node's dns.lookup). undici always calls with 3 args,
  // so it uses the default; tests pass a fake to exercise this validator without ESM mocking.
  resolve: typeof dnsLookup = dnsLookup,
): void {
  resolve(hostname, options as never, (err, address, family) => {
    if (err) {
      callback(err, address as string | LookupAddress[], family);
      return;
    }
    const resolved: LookupAddress[] = Array.isArray(address)
      ? (address as LookupAddress[])
      : [{ address: address as string, family: family as number }];
    const blocked = resolved.find((entry) => isPrivateIP(entry.address));
    if (blocked) {
      callback(
        new Error(`SSRF blocked: ${hostname} resolves to private IP ${blocked.address}`),
        '',
        0,
      );
      return;
    }
    callback(null, address as string | LookupAddress[], family);
  });
}

const ssrfSafeAgent = new Agent({
  connect: { lookup: ssrfSafeLookup as never },
});

/**
 * Read a fetch Response body with a hard byte cap so an oversized response cannot
 * exhaust memory. Streams when possible (real fetch) and truncates at the cap; falls
 * back to `.text()` (e.g. in tests that stub fetch without a body stream).
 */
export async function readBodyCapped(
  response: { body?: unknown; text: () => Promise<string> },
  maxBytes: number,
): Promise<string> {
  const body = response.body as ReadableStream<Uint8Array> | null | undefined;
  if (!body || typeof body.getReader !== 'function') {
    const text = await response.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total >= maxBytes) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  const merged = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= merged.length) break;
    const slice = chunk.subarray(0, merged.length - offset);
    merged.set(slice, offset);
    offset += slice.byteLength;
  }
  return new TextDecoder().decode(merged);
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
