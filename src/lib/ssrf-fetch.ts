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
 * Classify a dotted-quad IPv4 string against private/reserved ranges. Returns
 * true (block) for any non-globally-routable range. Comprehensive: RFC1918,
 * loopback, link-local (incl. cloud metadata 169.254.169.254), "this network"
 * 0.0.0.0/8, CGNAT 100.64.0.0/10, the three TEST-NET docs ranges, multicast
 * 224.0.0.0/4, and reserved/future 240.0.0.0/4 (which covers 255.255.255.255).
 * Returns null when `ip` is not a valid dotted-quad (caller falls through).
 */
function classifyIPv4(ip: string): boolean | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const [a, b] = [Number(m[1]), Number(m[2])];
  const octets = [a, b, Number(m[3]), Number(m[4])];
  if (octets.some((n) => n > 255)) return null;                   // not a valid IPv4
  if (a === 0) return true;                                       // 0.0.0.0/8 "this network"
  if (a === 10) return true;                                      // 10.0.0.0/8
  if (a === 127) return true;                                     // 127.0.0.0/8 loopback
  if (a === 100 && b >= 64 && b <= 127) return true;             // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) return true;                        // 169.254.0.0/16 link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;             // 172.16.0.0/12
  if (a === 192 && b === 0 && octets[2] === 2) return true;     // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 168) return true;                       // 192.168.0.0/16
  if (a === 198 && b === 51 && octets[2] === 100) return true;  // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && octets[2] === 113) return true;   // 203.0.113.0/24 TEST-NET-3
  if (a >= 224 && a <= 239) return true;                         // 224.0.0.0/4 multicast
  if (a >= 240) return true;                                     // 240.0.0.0/4 reserved + 255.255.255.255 broadcast
  return false;
}

/**
 * Classify an IPv6 string against private/reserved ranges. Returns true (block)
 * for: unspecified `::`, loopback `::1`, ULA `fc00::/7` (fc/fd), link-local
 * `fe80::/10`, and multicast `ff00::/8`. IPv4-mapped (`::ffff:a.b.c.d` or the
 * hex `::ffff:wwww:xxxx` form) is decomposed and the embedded IPv4 is run
 * through `classifyIPv4` so a mapped private/loopback address is also blocked.
 * Returns null when `ip` is not parseable as IPv6 (caller falls through).
 */
/**
 * Expand an IPv6 string (no embedded dotted IPv4, no zone id) into exactly 8
 * numeric hextets, resolving a single `::` compression. Returns null for any
 * form that is not a clean 8-hextet IPv6 (dotted forms, >1 `::`, bad groups) so
 * callers fall through to the other classifiers. Used for exact-prefix checks
 * (e.g. NAT64 64:ff9b::/96) where the embedded IPv4 sits in fixed hextets.
 */
function expandIPv6Hextets(bare: string): number[] | null {
  if (bare.includes('.')) return null;
  const parts = bare.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  let groups: string[];
  if (parts.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null; // '::' must stand for at least one zero group
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  }
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

function classifyIPv6(ip: string): boolean | null {
  if (!ip.includes(':')) return null;
  const lower = ip.toLowerCase();
  // Strip a zone id (fe80::1%eth0) before classification.
  const bare = lower.split('%')[0];
  if (bare === '::' || bare === '0:0:0:0:0:0:0:0') return true;   // unspecified
  if (bare === '::1' || bare === '0:0:0:0:0:0:0:1') return true;  // loopback

  // IPv4-mapped / IPv4-compatible: extract trailing embedded IPv4 and classify it.
  // Dotted form: ::ffff:127.0.0.1  → classify 127.0.0.1
  const dotted = /(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(bare);
  if (dotted) {
    const embedded = classifyIPv4(dotted[1]);
    if (embedded !== null) return embedded;
  }
  // Hex mapped form: ::ffff:7f00:0001 → 127.0.0.1
  const hexMapped = /^(?:0*:)*0*ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    const embedded = classifyIPv4(v4);
    if (embedded !== null) return embedded;
  }
  // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052): the trailing 32 bits embed an
  // IPv4. The dotted NAT64 form (64:ff9b::169.254.169.254) is already caught by the
  // dotted regex above; this covers the HEX form (64:ff9b::a9fe:a9fe == 169.254.169.254
  // / 64:ff9b::7f00:1 == 127.0.0.1) which otherwise PASSED because first-group 0x64 is
  // not a blocked prefix (QR-032 SSRF gap, reachable via link-preview). Only the exact
  // /96 prefix is decomposed, so a normal global IPv6 whose tail looks like a private
  // IPv4 (2001:db8::a9fe:a9fe) is NOT misclassified.
  const hextets = expandIPv6Hextets(bare);
  if (
    hextets &&
    hextets[0] === 0x0064 && hextets[1] === 0xff9b &&
    hextets[2] === 0 && hextets[3] === 0 && hextets[4] === 0 && hextets[5] === 0
  ) {
    const hi = hextets[6];
    const lo = hextets[7];
    const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    const embedded = classifyIPv4(v4);
    if (embedded !== null) return embedded;
  }

  // Normalize the first hextet to compare prefixes (handles compressed forms
  // like fc00::1 / fd12:... / fe80::1 / ff02::1). A leading '::' means the
  // first group is 0, which is none of the blocked prefixes.
  if (bare.startsWith('::')) return false;
  const firstGroup = bare.split(':')[0];
  if (!/^[0-9a-f]{1,4}$/.test(firstGroup)) return null;          // not valid IPv6
  const first16 = parseInt(firstGroup, 16);
  if ((first16 & 0xfe00) === 0xfc00) return true;                // fc00::/7 ULA (fc.. and fd..)
  if ((first16 & 0xffc0) === 0xfe80) return true;                // fe80::/10 link-local
  if ((first16 & 0xff00) === 0xff00) return true;                // ff00::/8 multicast
  return false;
}

/**
 * Returns true if the hostname (a literal IP or `localhost`) is a
 * private/loopback/reserved address. Literal IPs are classified comprehensively
 * via the shared `isPrivateIP`; this is the static pre-DNS check.
 */
export function isPrivateHost(hostname: string): boolean {
  if (hostname === 'localhost') return true;
  // Bracketed IPv6 literal from a URL host (e.g. [fe80::1]) → strip brackets.
  const host = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  return isPrivateIP(host);
}

/**
 * Check if a resolved IP address falls within private/reserved ranges.
 * Used as a DNS-aware SSRF guard: even if the hostname looks public,
 * reject it when it resolves to a private/reserved IP. Comprehensively covers
 * IPv4 (RFC1918, loopback, link-local, 0.0.0.0/8, CGNAT, TEST-NETs, multicast,
 * reserved) AND IPv6 (unspecified, loopback, ULA fc00::/7, link-local fe80::/10,
 * multicast ff00::/8, and IPv4-mapped addresses by classifying the embedded
 * IPv4). Fail-closed: anything not provably a public unicast address blocked
 * when it matches a reserved pattern; unparseable input returns false (the
 * undici connect-time lookup is the backstop for those).
 */
export function isPrivateIP(ip: string): boolean {
  const v4 = classifyIPv4(ip);
  if (v4 !== null) return v4;
  const v6 = classifyIPv6(ip);
  if (v6 !== null) return v6;
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
