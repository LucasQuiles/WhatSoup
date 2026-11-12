import type { Database } from './database.ts';
import { pinDigest, PROTECTED_DELIVERY_PINS, type ProtectedDeliveryPins } from './protected-delivery-pins.ts';

/** A stable, non-sensitive replacement retained in protected message records. */
export const PROTECTED_MESSAGE_MARKER = '[protected managed link]';

// Match only a reader prefix, then scan the fragment one character at a time.
// The host is a bounded label sequence, so the scan stays linear; a candidate
// counts only when its host digest is pinned, which keeps every unpinned host
// out without naming an approved host in source. The scheme, default port, DNS
// trailing dot and optional path slash cover normal browser spellings and are
// paired in isProtectedLinkStart. Legacy links use ampersand-separated
// fragment fields, so a narrow base64url class would leave their seed visible.
const PROTECTED_LINK_CANDIDATE = /(?<![A-Za-z0-9.-])(?:(https?):\/\/)?((?:[A-Za-z0-9-]{1,63}\.){1,16}[A-Za-z0-9-]{1,63})\.?(?::([0-9]{1,5}))?\/(?:s|setup)\/?#/giu;
const MANAGED_LINK_FRAGMENT = /^#v3\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const MAX_PROTECTED_FRAGMENT_LENGTH = 16_384;
const MAX_PROTECTED_LINKS_PER_TEXT = 128;
const MAX_SANITIZE_DEPTH = 64;
const MAX_SANITIZE_NODES = 10_000;

function isFragmentCharacter(charCode: number): boolean {
  return (charCode >= 0x30 && charCode <= 0x39)
    || (charCode >= 0x41 && charCode <= 0x5a)
    || (charCode >= 0x61 && charCode <= 0x7a)
    || charCode === 0x21 // !
    || charCode === 0x23 // #
    || charCode === 0x24 // $
    || charCode === 0x25 // %
    || charCode === 0x26 // &
    || charCode === 0x27 // '
    || charCode === 0x28 // (
    || charCode === 0x29 // )
    || charCode === 0x2a // *
    || charCode === 0x2b // +
    || charCode === 0x2c // ,
    || charCode === 0x2d // -
    || charCode === 0x2e // .
    || charCode === 0x2f // /
    || charCode === 0x3a // :
    || charCode === 0x3b // ;
    || charCode === 0x3d // =
    || charCode === 0x3f // ?
    || charCode === 0x40 // @
    || charCode === 0x5f // _
    || charCode === 0x7e; // ~
}

function protectedFragmentEnd(value: string, start: number): number {
  const limit = Math.min(value.length, start + MAX_PROTECTED_FRAGMENT_LENGTH);
  let end = start;
  while (end < limit && isFragmentCharacter(value.charCodeAt(end))) end++;

  // A fragment that reaches the bound cannot be safely split. Drop the
  // uninspected suffix rather than risk retaining a protected reference.
  return end === limit && limit < value.length ? value.length : end;
}

// A scheme carries only its own default port; a bare host carries none.
function isProtectedLinkStart(match: RegExpExecArray, pins: ProtectedDeliveryPins): boolean {
  const scheme = match[1]?.toLowerCase();
  const port = match[3];
  if (port !== undefined && !((scheme === 'https' && port === '443') || (scheme === 'http' && port === '80'))) {
    return false;
  }
  // Under the `iu` flags the ASCII host class also admits U+017F (long s) and
  // U+212A (Kelvin sign), which browsers map to `s` and `k`. toLowerCase()
  // already folds the Kelvin sign; fold the long s too, or such a spelling of
  // a pinned host would open the real host yet miss its digest.
  let host = match[2]!.toLowerCase().replace(/ſ/g, 's');
  if (host.startsWith('www.')) host = host.slice('www.'.length);
  return pins.linkHostSha256.has(pinDigest(host));
}

// Returns the next pinned link start at or after `from`, skipping unpinned
// candidates one position at a time so a later pinned start is still found.
function nextProtectedLinkStart(value: string, from: number, pins: ProtectedDeliveryPins): RegExpExecArray | null {
  PROTECTED_LINK_CANDIDATE.lastIndex = from;
  try {
    for (let match = PROTECTED_LINK_CANDIDATE.exec(value); match; match = PROTECTED_LINK_CANDIDATE.exec(value)) {
      if (isProtectedLinkStart(match, pins)) return match;
      PROTECTED_LINK_CANDIDATE.lastIndex = match.index + 1;
    }
    return null;
  } finally {
    PROTECTED_LINK_CANDIDATE.lastIndex = 0;
  }
}

/**
 * True only for the exact canonical managed link the delivery service may send:
 * `https://<pinned host>/s/#v3.<22>.<43>` with no port, credentials or query.
 */
export function isCanonicalManagedLink(value: unknown, pins: ProtectedDeliveryPins = PROTECTED_DELIVERY_PINS): boolean {
  if (typeof value !== 'string') return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.pathname !== '/s/') {
    return false;
  }
  // The parsed parts must rebuild the input byte for byte, so case, port and
  // trailing-dot spellings that the parser normalizes are still refused.
  if (!MANAGED_LINK_FRAGMENT.test(url.hash) || value !== `https://${url.hostname}/s/${url.hash}`) return false;
  return pinDigest(url.hostname) === pins.canonicalLinkHostSha256;
}

export function sanitizeProtectedMessageText(value: string, pins: ProtectedDeliveryPins = PROTECTED_DELIVERY_PINS): string {
  let cursor = 0;
  let redactions = 0;
  let sanitized: string | undefined;

  for (let match = nextProtectedLinkStart(value, 0, pins); match; match = nextProtectedLinkStart(value, cursor, pins)) {
    const end = protectedFragmentEnd(value, match.index + match[0].length);
    sanitized = `${sanitized ?? ''}${value.slice(cursor, match.index)}${PROTECTED_MESSAGE_MARKER}`;
    cursor = end;
    redactions++;

    // Retaining an uninspected tail after an unexpectedly link-dense input
    // would violate the redaction boundary. The payload is model-visible, so
    // fail closed and keep only the stable marker.
    if (redactions >= MAX_PROTECTED_LINKS_PER_TEXT || end === value.length) {
      return sanitized;
    }
  }

  return sanitized === undefined ? value : `${sanitized}${value.slice(cursor)}`;
}

/**
 * Detect protected references through arbitrary stored message shapes without
 * serializing them. Cycles and excessively deep payloads fail closed because a
 * raw message is never a model-visible contract.
 */
export function hasProtectedManagedLink(value: unknown, pins: ProtectedDeliveryPins = PROTECTED_DELIVERY_PINS): boolean {
  const pending: unknown[] = [value];
  const visited = new WeakSet<object>();
  let visitedNodes = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      if (current.includes(PROTECTED_MESSAGE_MARKER)) return true;
      if (nextProtectedLinkStart(current, 0, pins) !== null) return true;
      continue;
    }
    if (current === null || typeof current !== 'object' || current instanceof Uint8Array) continue;
    if (visited.has(current)) continue;
    visited.add(current);
    visitedNodes++;
    if (visitedNodes > MAX_SANITIZE_NODES) return true;

    for (const key of Object.keys(current)) {
      try {
        pending.push((current as Record<string, unknown>)[key]);
      } catch {
        // A throwing accessor cannot safely be inspected or exposed. Treat it
        // as protected so callers retain the conservative boundary.
        return true;
      }
    }
  }

  return false;
}

/**
 * Clone an inbound/raw payload while replacing every protected link in strings.
 * Keep binary fields intact for media handling and fail closed beyond a bounded
 * traversal depth rather than preserving an uninspected tail.
 */
export function sanitizeProtectedMessageValue(value: unknown, pins: ProtectedDeliveryPins = PROTECTED_DELIVERY_PINS): unknown {
  const seen = new WeakMap<object, unknown>();
  let visitedNodes = 0;

  const sanitize = (current: unknown, depth: number): unknown => {
    if (typeof current === 'string') return sanitizeProtectedMessageText(current, pins);
    if (current === null || typeof current !== 'object' || current instanceof Uint8Array) return current;
    if (depth >= MAX_SANITIZE_DEPTH || ++visitedNodes > MAX_SANITIZE_NODES) return PROTECTED_MESSAGE_MARKER;

    const prior = seen.get(current);
    if (prior !== undefined) return prior;

    if (Array.isArray(current)) {
      const clone: unknown[] = [];
      seen.set(current, clone);
      for (const item of current) clone.push(sanitize(item, depth + 1));
      return clone;
    }

    const clone = Object.create(Object.getPrototypeOf(current)) as Record<string, unknown>;
    seen.set(current, clone);
    for (const key of Object.keys(current)) {
      try {
        clone[key] = sanitize((current as Record<string, unknown>)[key], depth + 1);
      } catch {
        clone[key] = PROTECTED_MESSAGE_MARKER;
      }
    }
    return clone;
  };

  return sanitize(value, 0);
}

/**
 * A transport delivery row protects a message even when a legacy stored body
 * predates text redaction. Older databases have no table during rollout; their
 * callers still apply syntactic link detection before any model-visible use.
 */
export function isProtectedDeliveryMessage(db: Pick<Database, 'raw'>, messageId: string): boolean {
  try {
    return Boolean(
      db.raw
        .prepare('SELECT 1 FROM protected_deliveries WHERE whatsapp_message_id = ? LIMIT 1')
        .get(messageId),
    );
  } catch {
    return false;
  }
}
