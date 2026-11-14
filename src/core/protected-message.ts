import type { Database } from './database.ts';
import {
  isExactPinnedHost,
  PROTECTED_DELIVERY_PINS,
  type ProtectedDeliveryPins,
} from './protected-delivery-pins.ts';
import {
  containsProtectedLink,
  containsProtectedLinkInBinaryText,
  PROTECTED_MESSAGE_MARKER,
  PROTECTED_TEXT_WITHHELD_MARKER,
  redactProtectedLinksAcrossEscapesWithinBound,
  sanitizeProtectedLinkText,
} from '../lib/protected-link-text.ts';

export { PROTECTED_MESSAGE_MARKER, PROTECTED_TEXT_WITHHELD_MARKER };

// The scanner itself lives in src/lib/protected-link-text.ts so the log
// sanitizer can use it. The wrappers here take their default pins from this
// ring's pins module, which is the module domain tests replace.
const MANAGED_LINK_FRAGMENT = /^#v3\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const MAX_SANITIZE_DEPTH = 64;
/**
 * Objects and arrays visited per value; strings are scanned and not counted.
 * Sized from the largest realistic tool result, list_groups: each group costs
 * its metadata object, its participants array and one object per participant.
 * 256 groups at WhatsApp's 1,024-member cap is 262,658 nodes; this bound is
 * four times that. The previous bound of 10,000 was reached by about ten full
 * groups.
 */
export const MAX_SANITIZE_NODES = 1_048_576;

/** A tool result too large, too deep or too link-dense to scan for protected links. */
export class ProtectedValueScanLimitError extends Error {
  constructor() {
    super(
      `result is too large to check for protected links (more than ${MAX_SANITIZE_NODES} objects, `
      + `deeper than ${MAX_SANITIZE_DEPTH} levels, or a text with more than 128 protected links); narrow the request`,
    );
    this.name = 'ProtectedValueScanLimitError';
  }
}

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
 * sanitizeProtectedMessageText for a tool result's text, which can carry JSON
 * escapes: a bare host right after an escape such as `\n` is redacted too.
 */
export function sanitizeProtectedToolText(value: string, pins: ProtectedDeliveryPins = PROTECTED_DELIVERY_PINS): string {
  return redactProtectedLinksAcrossEscapesWithinBound(value, pins) ?? PROTECTED_TEXT_WITHHELD_MARKER;
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
 * traversal depth rather than preserving an uninspected tail. Past either bound
 * each further object becomes the marker: an inbound message is still stored,
 * and no unscanned text is kept. A tool result uses sanitizeProtectedToolResult.
 */
export function sanitizeProtectedMessageValue(value: unknown, pins: ProtectedDeliveryPins = PROTECTED_DELIVERY_PINS): unknown {
  return sanitizeBoundedValue(value, pins, 'marker');
}

/**
 * Clone a value returned to an MCP caller while replacing every protected link
 * in strings. A binary leaf whose bytes, decoded as UTF-8, carry a link becomes
 * the marker. Past any bound it throws ProtectedValueScanLimitError, which the
 * caller sees as a tool error, rather than return a cut or unscanned result.
 */
export function sanitizeProtectedToolResult(value: unknown, pins: ProtectedDeliveryPins = PROTECTED_DELIVERY_PINS): unknown {
  return sanitizeBoundedValue(value, pins, 'throw');
}

/**
 * sanitizeProtectedToolResult for the result of a handler that has completed.
 * Its effect has already happened, so past any bound the whole result becomes
 * PROTECTED_TEXT_WITHHELD_MARKER instead of an error: a reported failure would
 * invite a duplicate send.
 */
export function sanitizeCompletedToolResult(value: unknown, pins: ProtectedDeliveryPins = PROTECTED_DELIVERY_PINS): unknown {
  return sanitizeBoundedValue(value, pins, 'withhold');
}

const binaryTextDecoder = new TextDecoder();

function binaryBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

/**
 * Names the keys of one cloned object or Map. A key that had no link keeps its
 * name. A redacted key that equals a kept key or an earlier redacted key takes
 * the first free ` [n]` suffix from 2, so no entry is overwritten or dropped;
 * the suffix holds only digits, brackets and a space, so it cannot form a link.
 */
function createRedactedKeyNamer(keptKeys: Iterable<string>): (key: string, safeKey: string) => string {
  const used = new Set(keptKeys);
  // Per base, the next suffix to try, so repeated collisions stay linear.
  const nextSuffix = new Map<string, number>();
  return (key, safeKey) => {
    if (safeKey === key) return key;
    let suffix = nextSuffix.get(safeKey) ?? 2;
    let name = safeKey;
    while (used.has(name)) name = `${safeKey} [${suffix++}]`;
    nextSuffix.set(safeKey, suffix);
    used.add(name);
    return name;
  };
}

function sanitizeBoundedValue(
  value: unknown,
  pins: ProtectedDeliveryPins,
  overLimit: 'marker' | 'throw' | 'withhold',
): unknown {
  // A tool result is serialized whole into model-visible text, so its binary
  // leaves are scanned and other values take their JSON form. An inbound
  // payload keeps binary fields and object shapes intact for media handling.
  const toolResult = overLimit !== 'marker';
  const seen = new WeakMap<object, unknown>();
  let visitedNodes = 0;
  // Set at the first bound in withhold mode; the rest of the walk then stops.
  let withheld = false;

  const pastBound = (marker: string): string => {
    if (overLimit === 'throw') throw new ProtectedValueScanLimitError();
    if (overLimit === 'withhold') withheld = true;
    return marker;
  };

  // A string can hold JSON text, such as a stored metadata column, so the scan
  // also reads past its escapes.
  const sanitizeText = (current: string): string =>
    redactProtectedLinksAcrossEscapesWithinBound(current, pins) ?? pastBound(PROTECTED_TEXT_WITHHELD_MARKER);

  const sanitize = (current: unknown, depth: number): unknown => {
    if (withheld) return undefined;
    if (typeof current === 'string') return sanitizeText(current);
    if (current === null || typeof current !== 'object') return current;
    if (current instanceof ArrayBuffer || ArrayBuffer.isView(current)) {
      if (!toolResult) return current;
      const decoded = binaryTextDecoder.decode(binaryBytes(current));
      return containsProtectedLinkInBinaryText(decoded, pins) ? PROTECTED_MESSAGE_MARKER : current;
    }
    if (depth >= MAX_SANITIZE_DEPTH || ++visitedNodes > MAX_SANITIZE_NODES) return pastBound(PROTECTED_MESSAGE_MARKER);

    const prior = seen.get(current);
    if (prior !== undefined) return prior;

    if (Array.isArray(current)) {
      const clone: unknown[] = [];
      seen.set(current, clone);
      for (const item of current) clone.push(sanitize(item, depth + 1));
      return clone;
    }

    // Built-ins keep their value in internal slots that a prototype-and-keys
    // clone would lose (a cloned Date throws in JSON.stringify).
    if (current instanceof Date) return new Date(current.getTime());
    // JSON writes a RegExp as `{}`, so its source never leaves through a result.
    if (current instanceof RegExp) return current;
    // JSON writes a URL as its href.
    if (current instanceof URL) return sanitizeText(current.href);
    if (current instanceof Map) {
      const clone = new Map<unknown, unknown>();
      seen.set(current, clone);
      // String keys are scanned first, which counts no node, so every kept key
      // is known before a redacted key is named.
      const entries = [...current];
      const textKeys = entries.map(([key]) => (typeof key === 'string' ? sanitizeText(key) : undefined));
      // Only a string key has a scanned text; one equal to its key had no link.
      const nameKey = createRedactedKeyNamer(entries.flatMap(([key], index) => {
        const text = textKeys[index];
        return text !== undefined && text === key ? [text] : [];
      }));
      entries.forEach(([key, item], index) => {
        const safeKey = typeof key === 'string' ? nameKey(key, textKeys[index]!) : sanitize(key, depth + 1);
        clone.set(safeKey, sanitize(item, depth + 1));
      });
      return clone;
    }
    if (current instanceof Set) {
      const clone = new Set<unknown>();
      seen.set(current, clone);
      for (const item of current) clone.add(sanitize(item, depth + 1));
      return clone;
    }

    const prototype = Object.getPrototypeOf(current) as object | null;
    const toJSON = (current as { toJSON?: unknown }).toJSON;
    if (toolResult && prototype !== Object.prototype && prototype !== null
      && !(current instanceof Error) && typeof toJSON === 'function') {
      // The result is serialized next; a class may keep its value in private
      // fields, so take the JSON form JSON.stringify would write.
      return sanitize(toJSON.call(current, ''), depth + 1);
    }

    const clone = Object.create(prototype) as Record<string, unknown>;
    seen.set(current, clone);
    if (current instanceof Error) {
      // message and stack are copied as own data properties that keep their
      // enumerability, normally none. Node exposes stack through an accessor,
      // so each is read as a property, not from its descriptor's value.
      for (const key of ['message', 'stack'] as const) {
        const text: unknown = current[key];
        if (typeof text !== 'string') continue;
        Object.defineProperty(clone, key, {
          value: sanitizeText(text),
          writable: true,
          enumerable: Object.getOwnPropertyDescriptor(current, key)?.enumerable ?? false,
          configurable: true,
        });
      }
    }
    // JSON writes a key as text too, so keys are redacted as Map keys are.
    const keys = Object.keys(current);
    const textKeys = keys.map(sanitizeText);
    const nameKey = createRedactedKeyNamer(keys.filter((key, index) => textKeys[index] === key));
    for (const [index, key] of keys.entries()) {
      const safeKey = nameKey(key, textKeys[index]!);
      try {
        clone[safeKey] = sanitize((current as Record<string, unknown>)[key], depth + 1);
      } catch (error) {
        // A throwing accessor reads as the marker; the bound must still escape.
        if (error instanceof ProtectedValueScanLimitError) throw error;
        clone[safeKey] = PROTECTED_MESSAGE_MARKER;
      }
    }
    return clone;
  };

  const sanitized = sanitize(value, 0);
  return withheld ? PROTECTED_TEXT_WITHHELD_MARKER : sanitized;
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
