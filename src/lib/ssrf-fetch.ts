// src/lib/ssrf-fetch.ts
//
// Shared SSRF-guarded fetch stack. Lives in `src/lib` (the only layer both
// `src/runtimes` and `src/core` may import) so there is exactly ONE outbound
// fetcher in the codebase — the link-preview path (`runtimes/chat/media/links`)
// and the substrate `poll.url` watch executor (`core/substrate/poller`) both
// reuse it instead of writing a second fetcher.
//
// The agent revalidates the connected IP at connect time AND on every redirect
// hop via `ssrfSafeLookup`, closing redirect-follow SSRF and DNS-rebinding
// TOCTOU. Two surfaces consume it:
//   - extractLinkContent (preview): SOFT-degrades on a block.
//   - poll.url watch: FAIL-CLOSED — `fetchUrlGuarded` throws `SsrfBlockedError`.

import { promises as dns, lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { Agent } from 'undici';
import { createChildLogger } from '../logger.ts';

const log = createChildLogger('lib:ssrf-fetch');

const FETCH_TIMEOUT_MS = 10_000;
// Hard cap on bytes read from a fetched URL. Prevents a malicious/large response
// from exhausting memory.
export const MAX_FETCH_BYTES = 5_000_000;

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

export const ssrfSafeAgent = new Agent({
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

/**
 * Thrown by `fetchUrlGuarded` when the SSRF guard blocks a request. Carries a
 * machine-readable `reason` so callers (the substrate `poll.url` executor) can
 * map it to a fail-CLOSED outcome (`errorKind:'ssrf_blocked'`) instead of the
 * soft-degrade path the link-preview flow uses. Distinct class so a blocked
 * fetch is never confused with a generic network failure.
 */
export class SsrfBlockedError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
    this.reason = reason;
  }
}

export interface GuardedFetchResult {
  status: number;
  /** Lower-cased header name → value, for stable hashing of a header subset. */
  headers: Record<string, string>;
  body: string;
}

/**
 * Fetch a URL through the SSRF stack (`ssrfSafeAgent` with per-hop resolved-IP
 * revalidation, `readBodyCapped`, timeout) but FAIL-CLOSED: a
 * private/loopback/metadata host, a DNS resolution to a private IP, or a
 * redirect into a denied host THROWS `SsrfBlockedError` rather than returning a
 * soft fallback.
 *
 * The caller is responsible for protocol/port policy (the substrate executor
 * enforces https-only + default-port-only before calling this); this helper
 * enforces the host/IP SSRF policy.
 */
export async function fetchUrlGuarded(
  url: string,
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<GuardedFetchResult> {
  const maxBytes = opts.maxBytes ?? MAX_FETCH_BYTES;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new SsrfBlockedError('invalid_url', `not a valid URL: ${url}`);
  }

  // Static host check (literal IPs / localhost) before any DNS work.
  if (isPrivateHost(hostname)) {
    throw new SsrfBlockedError('private_host', `blocked private/internal host: ${hostname}`);
  }

  // DNS-aware pre-check: reject a hostname that resolves to a private IP. The
  // ssrfSafeAgent below ALSO revalidates at connect time and on every redirect
  // hop (TOCTOU/redirect SSRF), but this pre-check produces a clean blocked
  // reason for the common case.
  try {
    const { address } = await dns.lookup(hostname);
    if (isPrivateIP(address)) {
      throw new SsrfBlockedError('private_ip', `host ${hostname} resolves to private IP ${address}`);
    }
  } catch (err) {
    if (err instanceof SsrfBlockedError) throw err;
    throw new SsrfBlockedError('dns_failed', `DNS resolution failed for ${hostname}`);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; bot/1.0)' },
      // Revalidates the connected IP at connect time and on every redirect hop.
      dispatcher: ssrfSafeAgent,
    } as RequestInit & { dispatcher: Agent });
  } catch (err) {
    // undici surfaces a connect-time SSRF block (ssrfSafeLookup callback error,
    // incl. a redirect hop into a private IP) as a fetch failure. Treat any
    // fetch throw whose cause mentions the SSRF block as a fail-closed block.
    const msg = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : '';
    if (/SSRF blocked/i.test(msg) || /SSRF blocked/i.test(cause)) {
      log.warn({ url, hostname }, 'SSRF blocked at connect/redirect time');
      throw new SsrfBlockedError('private_ip', `connect/redirect resolved to a private IP for ${hostname}`);
    }
    throw err;
  }

  const headers: Record<string, string> = {};
  response.headers?.forEach?.((value, key) => { headers[key.toLowerCase()] = value; });

  const body = await readBodyCapped(response, maxBytes);
  return { status: response.status, headers, body };
}
