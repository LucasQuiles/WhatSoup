import { isPinnedHost, PROTECTED_DELIVERY_PINS, type ProtectedDeliveryPins } from './protected-delivery-pins.ts';

/**
 * The protected-link text scanner. It has no domain imports, so the log
 * sanitizer in this ring redacts protected links from its first log line with
 * nothing to wire; src/core/protected-message.ts wraps it for domain callers.
 */

/** A stable, non-sensitive replacement retained in protected message records. */
export const PROTECTED_MESSAGE_MARKER = '[protected managed link]';

/**
 * Replaces a whole value that exceeds a scan bound: more than 128 links, or a
 * fragment that reaches its bound before the text ends. It contains the
 * marker, so marker checks still treat the value as protected, and it has no
 * quote or backslash, so it is safe inside JSON.
 */
export const PROTECTED_TEXT_WITHHELD_MARKER = '[protected managed link] text withheld';

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
const MAX_PROTECTED_FRAGMENT_LENGTH = 16_384;
const MAX_PROTECTED_LINKS_PER_TEXT = 128;

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

// The fragment end, or -1 when the fragment reaches its bound before the text
// ends. Such a fragment cannot be split safely, and dropping the suffix would
// silently lose text, so the caller withholds or refuses the whole value.
function protectedFragmentEnd(value: string, start: number): number {
  const limit = Math.min(value.length, start + MAX_PROTECTED_FRAGMENT_LENGTH);
  let end = start;
  while (end < limit && isFragmentCharacter(value.charCodeAt(end))) end++;
  return end === limit && limit < value.length ? -1 : end;
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

// The host end and optional port of the candidate whose `/s` or `/setup` path
// ends at the `#` at `hash`, or null when no such path precedes it.
function hostBeforeAnchor(text: string, hash: number): { hostEnd: number; port: string | null } | null {
  const pathEnd = text.charCodeAt(hash - 1) === 0x2f ? hash - 1 : hash;
  let pathStart: number;
  if (matchesFolded(text, pathEnd - 2, '/s')) pathStart = pathEnd - 2;
  else if (matchesFolded(text, pathEnd - 6, '/setup')) pathStart = pathEnd - 6;
  else return null;

  let digits = pathStart;
  while (digits > 0 && pathStart - digits <= MAX_PORT_DIGITS && isAsciiDigit(text.charCodeAt(digits - 1))) digits--;
  if (digits < pathStart && text.charCodeAt(digits - 1) === 0x3a) {
    return { hostEnd: digits - 1, port: text.slice(digits, pathStart) };
  }
  return { hostEnd: pathStart, port: null };
}

// Parses the candidate whose path ends at the `#` at `hash`. Returns null
// unless it is a pinned protected link that starts at or after `from`.
function protectedLinkEndingAt(text: string, hash: number, from: number, pins: ProtectedDeliveryPins): ProtectedLinkMatch | null {
  const anchor = hostBeforeAnchor(text, hash);
  if (anchor === null) return null;
  const { hostEnd, port } = anchor;

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

/** True when the text holds at least one pinned protected link. */
export function containsProtectedLink(value: string, pins: ProtectedDeliveryPins = PROTECTED_DELIVERY_PINS): boolean {
  return nextProtectedLink(value, 0, pins) !== null;
}

/** The `[start, end)` span of one protected link in the scanned text. */
export interface ProtectedLinkRange {
  start: number;
  end: number;
}

/**
 * The span of every pinned protected link, in order, or null when the text
 * exceeds a scan bound (more than 128 links, or a fragment that reaches its
 * bound before the text ends). On null the caller withholds or refuses the
 * whole value: it never truncates and never keeps unscanned text.
 */
export function protectedLinkRanges(
  value: string,
  pins: ProtectedDeliveryPins = PROTECTED_DELIVERY_PINS,
): ProtectedLinkRange[] | null {
  const ranges: ProtectedLinkRange[] = [];
  let cursor = 0;
  for (let match = nextProtectedLink(value, 0, pins); match; match = nextProtectedLink(value, cursor, pins)) {
    if (ranges.length === MAX_PROTECTED_LINKS_PER_TEXT) return null;
    const end = protectedFragmentEnd(value, match.fragmentStart);
    if (end === -1) return null;
    ranges.push({ start: match.start, end });
    cursor = end;
  }
  return ranges;
}

/** The text with each range replaced by the stable marker. */
export function replaceProtectedLinkRanges(value: string, ranges: readonly ProtectedLinkRange[]): string {
  if (ranges.length === 0) return value;
  let sanitized = '';
  let cursor = 0;
  for (const { start, end } of ranges) {
    sanitized += `${value.slice(cursor, start)}${PROTECTED_MESSAGE_MARKER}`;
    cursor = end;
  }
  return `${sanitized}${value.slice(cursor)}`;
}

/** The text with every pinned protected link replaced, or null past a scan bound. */
export function redactProtectedLinksWithinBound(
  value: string,
  pins: ProtectedDeliveryPins = PROTECTED_DELIVERY_PINS,
): string | null {
  const ranges = protectedLinkRanges(value, pins);
  return ranges === null ? null : replaceProtectedLinkRanges(value, ranges);
}

const BACKSLASH = 0x5c;

function isHexDigit(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
}

/**
 * JSON escapes `"`, `\` and control characters, so a link's boundary in JSON
 * text can arrive as `\n` or `\u0001`, whose letters and hex digits read as
 * host characters and would glue onto a bare host. Each backslash run and the
 * escape letter (or `u` and four hex digits) after it becomes a space in a
 * same-length view. JSON never escapes a host or fragment character, so a link
 * never spans a replaced position and the view's ranges splice the original
 * text without breaking an escape. Treating the letter after any backslash run
 * as an escape also covers text encoded twice, such as a `%j` log value.
 */
export function escapeNeutralView(text: string): string {
  let view = '';
  let cursor = 0;
  for (let index = text.indexOf('\\'); index !== -1; index = text.indexOf('\\', cursor)) {
    let end = index;
    while (text.charCodeAt(end) === BACKSLASH) end++;
    const letter = text[end];
    if (letter !== undefined && 'bfnrt"/'.includes(letter)) end++;
    else if (letter === 'u' && [1, 2, 3, 4].every((offset) => isHexDigit(text.charCodeAt(end + offset)))) end += 5;
    view += `${text.slice(cursor, index)}${' '.repeat(end - index)}`;
    cursor = end;
  }
  return cursor === 0 ? text : `${view}${text.slice(cursor)}`;
}

// Both inputs are sorted; overlapping ranges, one link found by both scans,
// become one range so the link gets one marker.
function mergeProtectedLinkRanges(
  left: readonly ProtectedLinkRange[],
  right: readonly ProtectedLinkRange[],
): ProtectedLinkRange[] {
  const merged: ProtectedLinkRange[] = [];
  for (const range of [...left, ...right].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last !== undefined && range.start < last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/**
 * protectedLinkRanges for text that can carry JSON escapes: a stored JSON
 * column inside a tool result, or a tool result's serialized text. The
 * escape-neutral view finds a bare host right after an escape such as `\n`.
 * The plain scan still runs, so a host written right after a literal backslash
 * in raw text, whose first letter the view blanks, is found as before. The
 * view has the text's length, so both scans' ranges apply to the text.
 */
function protectedLinkRangesAcrossEscapes(
  value: string,
  pins: ProtectedDeliveryPins = PROTECTED_DELIVERY_PINS,
): ProtectedLinkRange[] | null {
  const plain = protectedLinkRanges(value, pins);
  if (plain === null || !value.includes('\\')) return plain;
  const neutral = protectedLinkRanges(escapeNeutralView(value), pins);
  return neutral === null ? null : mergeProtectedLinkRanges(plain, neutral);
}

/** redactProtectedLinksWithinBound for text that can carry JSON escapes. */
export function redactProtectedLinksAcrossEscapesWithinBound(
  value: string,
  pins: ProtectedDeliveryPins = PROTECTED_DELIVERY_PINS,
): string | null {
  const ranges = protectedLinkRangesAcrossEscapes(value, pins);
  return ranges === null ? null : replaceProtectedLinkRanges(value, ranges);
}

/**
 * Replace every pinned protected link in the text with the stable marker.
 * Past a scan bound the whole value becomes PROTECTED_TEXT_WITHHELD_MARKER.
 */
export function sanitizeProtectedLinkText(value: string, pins: ProtectedDeliveryPins = PROTECTED_DELIVERY_PINS): string {
  return redactProtectedLinksWithinBound(value, pins) ?? PROTECTED_TEXT_WITHHELD_MARKER;
}

/**
 * Detection for binary bytes decoded as text. Binary framing can glue a link
 * to a byte that reads as a host character (a protobuf length of 0x61 reads
 * as `a`), so every suffix of the host run before each anchor is checked.
 * Detection only: the caller replaces the whole binary value.
 */
export function containsProtectedLinkInBinaryText(
  text: string,
  pins: ProtectedDeliveryPins = PROTECTED_DELIVERY_PINS,
): boolean {
  for (let hash = text.indexOf('#'); hash !== -1; hash = text.indexOf('#', hash + 1)) {
    const anchor = hostBeforeAnchor(text, hash);
    if (anchor === null) continue;
    for (
      let start = anchor.hostEnd - 1;
      start >= 0 && anchor.hostEnd - start <= MAX_HOST_CANDIDATE_LENGTH && isHostCharacter(text.charCodeAt(start));
      start--
    ) {
      if (isPinnedHost(text.slice(start, anchor.hostEnd), pins.linkHostSha256)) return true;
    }
  }
  return false;
}
