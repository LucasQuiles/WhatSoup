import type { Database } from './database.ts';
import {
  isExactPinnedHost,
  isPinnedHost,
  PROTECTED_DELIVERY_PINS,
  type ProtectedDeliveryPins,
} from './protected-delivery-pins.ts';

/** A stable, non-sensitive replacement retained in protected message records. */
export const PROTECTED_MESSAGE_MARKER = '[protected managed link]';

// A protected link is `[scheme://][www.]host[.][:port]/(s|setup)[/]#fragment`,
// matched case-insensitively. The scan anchors on each `#` and walks back a
// bounded distance, so it is linear in the text and uses no backtracking
// regex. A candidate counts only when its host digest is pinned, which keeps
// every unpinned host out without naming an approved host in source. The
// fragment is then scanned one character at a time: legacy links use
// ampersand-separated fields, so a narrow base64url class would leave their
// seed visible.
const MAX_HOST_CANDIDATE_LENGTH = 253 + 'www.'.length + '.'.length;
const MAX_PORT_DIGITS = 5;
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

// The host and boundary class of the literal-host pattern this scanner
// replaced: ASCII letters, digits, `.` and `-`, plus the two non-ASCII
// characters its case-insensitive Unicode flags also matched, U+017F (long s)
// and U+212A (Kelvin sign). Browsers map both to ASCII.
function isHostCharacter(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
    || code === 0x2d || code === 0x2e || code === 0x017f || code === 0x212a;
}

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

// Case-insensitive comparison of text at `at` with a lowercase ASCII literal,
// folding the same two non-ASCII characters as the host class.
function matchesFolded(text: string, at: number, literal: string): boolean {
  if (at < 0 || at + literal.length > text.length) return false;
  for (let index = 0; index < literal.length; index++) {
    let code = text.charCodeAt(at + index);
    if (code >= 0x41 && code <= 0x5a) code += 0x20;
    else if (code === 0x017f) code = 0x73;
    else if (code === 0x212a) code = 0x6b;
    if (code !== literal.charCodeAt(index)) return false;
  }
  return true;
}

interface ProtectedLinkMatch {
  start: number;
  fragmentStart: number;
}

// Parses the candidate whose path ends at the `#` at `hash`. Returns null
// unless it is a pinned protected link that starts at or after `from`.
function protectedLinkEndingAt(text: string, hash: number, from: number, pins: ProtectedDeliveryPins): ProtectedLinkMatch | null {
  const pathEnd = text.charCodeAt(hash - 1) === 0x2f ? hash - 1 : hash;
  let pathStart: number;
  if (matchesFolded(text, pathEnd - 2, '/s')) pathStart = pathEnd - 2;
  else if (matchesFolded(text, pathEnd - 6, '/setup')) pathStart = pathEnd - 6;
  else return null;

  let hostEnd = pathStart;
  let port: string | null = null;
  let digits = pathStart;
  while (digits > 0 && pathStart - digits <= MAX_PORT_DIGITS && isAsciiDigit(text.charCodeAt(digits - 1))) digits--;
  if (digits < pathStart && text.charCodeAt(digits - 1) === 0x3a) {
    port = text.slice(digits, pathStart);
    hostEnd = digits - 1;
  }

  // The host is the whole run of host characters, so nothing host-like
  // precedes it; a run longer than any DNS name cannot be pinned.
  let start = hostEnd;
  while (start > 0 && isHostCharacter(text.charCodeAt(start - 1))) {
    if (hostEnd - start >= MAX_HOST_CANDIDATE_LENGTH) return null;
    start--;
  }
  if (start === hostEnd || start < from || !isPinnedHost(text.slice(start, hostEnd), pins.linkHostSha256)) return null;

  // A scheme belongs to the link when nothing host-like precedes it, and it
  // carries only its own default port. A bare host carries no port.
  let schemeStart = -1;
  let schemePort: string | null = null;
  if (matchesFolded(text, start - 8, 'https://')) {
    schemeStart = start - 8;
    schemePort = '443';
  } else if (matchesFolded(text, start - 7, 'http://')) {
    schemeStart = start - 7;
    schemePort = '80';
  }
  const schemeBelongs = schemeStart >= from
    && (schemeStart === 0 || !isHostCharacter(text.charCodeAt(schemeStart - 1)))
    && (port === null || port === schemePort);
  if (schemeBelongs) return { start: schemeStart, fragmentStart: hash + 1 };
  return port === null ? { start, fragmentStart: hash + 1 } : null;
}

function nextProtectedLink(text: string, from: number, pins: ProtectedDeliveryPins): ProtectedLinkMatch | null {
  for (let hash = text.indexOf('#', from); hash !== -1; hash = text.indexOf('#', hash + 1)) {
    const match = protectedLinkEndingAt(text, hash, from, pins);
    if (match) return match;
  }
  return null;
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
  // The parsed parts must rebuild the input byte for byte, so case and port
  // spellings that the parser normalizes are still refused; the exact pin
  // check also refuses `www.` and trailing-dot spellings.
  if (!MANAGED_LINK_FRAGMENT.test(url.hash) || value !== `https://${url.hostname}/s/${url.hash}`) return false;
  return isExactPinnedHost(url.hostname, pins.canonicalLinkHostSha256);
}

export function sanitizeProtectedMessageText(value: string, pins: ProtectedDeliveryPins = PROTECTED_DELIVERY_PINS): string {
  let cursor = 0;
  let redactions = 0;
  let sanitized: string | undefined;

  for (let match = nextProtectedLink(value, 0, pins); match; match = nextProtectedLink(value, cursor, pins)) {
    const end = protectedFragmentEnd(value, match.fragmentStart);
    sanitized = `${sanitized ?? ''}${value.slice(cursor, match.start)}${PROTECTED_MESSAGE_MARKER}`;
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
      if (nextProtectedLink(current, 0, pins) !== null) return true;
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
