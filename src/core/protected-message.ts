import type { Database } from './database.ts';
import {
  isExactPinnedHost,
  PROTECTED_DELIVERY_PINS,
  type ProtectedDeliveryPins,
} from './protected-delivery-pins.ts';
import {
  containsProtectedLink,
  PROTECTED_MESSAGE_MARKER,
  sanitizeProtectedLinkText,
} from '../lib/protected-link-text.ts';

export { PROTECTED_MESSAGE_MARKER };

// The scanner itself lives in src/lib/protected-link-text.ts so the log
// sanitizer can use it. The wrappers here take their default pins from this
// ring's pins module, which is the module domain tests replace.
const MANAGED_LINK_FRAGMENT = /^#v3\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const MAX_SANITIZE_DEPTH = 64;
const MAX_SANITIZE_NODES = 10_000;

/**
 * True only for the exact canonical managed link the delivery service may send:
 * `https://<pinned host>/s/#v3.<22>.<43>` with no port, credentials or query.
 */
export function isCanonicalManagedLink(
  value: unknown,
  pins: ProtectedDeliveryPins = PROTECTED_DELIVERY_PINS,
  linkHosts?: readonly string[],
): boolean {
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
  // Configured link hosts can only narrow the pinned set, never widen it.
  if (linkHosts !== undefined && !linkHosts.includes(url.hostname)) return false;
  return isExactPinnedHost(url.hostname, pins.canonicalLinkHostSha256);
}

export function sanitizeProtectedMessageText(value: string, pins: ProtectedDeliveryPins = PROTECTED_DELIVERY_PINS): string {
  return sanitizeProtectedLinkText(value, pins);
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
      if (containsProtectedLink(current, pins)) return true;
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
    if (typeof current === 'string') return sanitizeProtectedLinkText(current, pins);
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
 * The dotted path of a string in `value` that holds the redaction marker, or
 * null. A client that saves a redacted projection back would otherwise replace
 * the stored link with the marker. Only the literal marker counts: a real link
 * an operator types is not a marker.
 */
export function findProtectedMarkerPath(value: unknown): string | null {
  const pending: Array<{ current: unknown; path: string }> = [{ current: value, path: '' }];
  const visited = new WeakSet<object>();

  while (pending.length > 0) {
    const { current, path } = pending.pop()!;
    if (typeof current === 'string') {
      if (current.includes(PROTECTED_MESSAGE_MARKER)) return path;
      continue;
    }
    if (current === null || typeof current !== 'object' || visited.has(current)) continue;
    visited.add(current);
    for (const key of Object.keys(current)) {
      pending.push({ current: (current as Record<string, unknown>)[key], path: path === '' ? key : `${path}.${key}` });
    }
  }

  return null;
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
