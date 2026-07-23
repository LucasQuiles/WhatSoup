// Shared provider preview redaction for structured logs and any other surface
// that previews provider/agent text. Lives in `lib` (the lowest ring) so both
// runtime providers and core guardrails can reuse one sanitizer — SSOT, no
// duplicated token/secret regex islands.

import { jidPattern } from './redaction-patterns.ts';

const ASSIGNMENT_DELIMITER = /[:=]/g;
const EMAIL_TOKEN_CHAR = /[A-Za-z0-9._%+@-]/;
const TRAILING_EMAIL_PUNCTUATION = new Set(['.', ':']);

// E9 (packet D5), narrowed by B25: an email-SHAPED core needs a NON-EMPTY
// local part AND a non-empty domain part around an '@'. A bare
// whitespace-flanked '@' used as the word "at" ("meet @ 5pm", "3 @ $5 each")
// carries no address and must pass through. Mention-shaped tokens ('@name',
// '@15551234567') are not email-shaped either, but they stay governed by
// preserveWhatsAppMentions below — phone mentions are PII on surfaces that
// did not opt in, so requiring a non-empty local part for the EMAIL match
// must not turn that flag into dead code.
//
// B25 REVERSAL of the original "x@" edge decision: a DANGLING-LOCAL token
// (non-empty local + trailing '@' + empty domain, e.g. '15551234567@',
// 'user@', the local half of a space-split address) is an ADDRESS FRAGMENT
// and now REDACTS. The original ruling said "redacting it protects nothing";
// the B25 review proved the opposite — on CLIENT egress there is no
// downstream phone masking (unlike the handoff/ops surfaces), so the
// fragment alone carries the whole PII payload. The E9 exemption therefore
// narrows to truly-bare '@' runs.
// B25 simplification (review's "/@[^@]/" note, adjusted): with dangling
// locals redacting, the three redactability predicates — email-shaped
// /[^@]@+[^@]/, mention-shaped ('@' + content), dangling-local /[^@]@+$/ —
// collapse to "the core is NOT a bare '@' run". Proof (a core always
// contains at least one '@'): if it also has any non-'@' char, then either
// it starts with '@' (mention-shaped) or its first '@' run is preceded by a
// non-'@' char and is either followed by one (email-shaped) or terminal
// (dangling local). The literal /@[^@]/ form would NOT be equivalent
// ('user@' must redact yet has no char after its '@'), hence the
// ALL_AT_SIGNS complement.
const ALL_AT_SIGNS = /^@+$/;
// B25 (1b) direction ruling: WhatsApp WIRE mentions are '@' + the numeric
// user part of a JID (phone or lid digits); typed courtesy mentions are
// username-ish. Dotted bodies ('@team.leads', '@foo.bar') can never be a
// deliverable email address — the local part is EMPTY — so accepting dots in
// the PRESERVE regex cannot leak a real email (an email-shaped core has a
// non-empty local and can never match this ^@-anchored regex). The regex
// stays fail-closed two ways: without the preserveWhatsAppMentions flag the
// token still redacts, and digit-led dotted bodies ('@1234.5678' — phone
// fragments) never match even WITH the flag.
const PRESERVABLE_MENTION = /^@(?:\+?\d{5,}|[A-Za-z][A-Za-z0-9._-]*)$/;

// T8-F3 (E4 fix): shared token-prefix alternation. Defined ONCE so the known-token
// mask (sanitizeProviderSecrets, below) and the truncation carve-out (in
// redactKeyedSecretValues) can never drift apart — a prefix recognized by one MUST
// be recognized by the other (packet: "SHARE that regex ... so they cannot drift").
const KNOWN_TOKEN_PREFIX = '(?:sk|pk|rk|ghp|github_pat|xox[baprs]|ya29|AIza)';
const KNOWN_TOKEN_VALUE = `${KNOWN_TOKEN_PREFIX}[-_A-Za-z0-9]{12,}\\b`;
const KNOWN_TOKEN_RE = new RegExp(`\\b${KNOWN_TOKEN_VALUE}`, 'g');
const KNOWN_TOKEN_PREFIX_AT_START_RE = new RegExp(KNOWN_TOKEN_PREFIX, 'y');
const KNOWN_TOKEN_PREFIX_RE = new RegExp(`^${KNOWN_TOKEN_PREFIX}`);
const KNOWN_TOKEN_CHAR_RE = /[-_A-Za-z0-9]/u;
const WORD_CHAR_RE = /[A-Za-z0-9_]/u;
const BEARER_TOKEN_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_KEY_TERMINAL_RE = /(?:token|secret|password|passphrase|api_?key)$/;
const SECRET_KEY_BOUNDARY_SUFFIX =
  '(?:private_?key|signing_?key|secret_?access_?key|cookie|credential|session|pat)';
const SECRET_KEY_BOUNDARY_RE = new RegExp(`(?:^|_)${SECRET_KEY_BOUNDARY_SUFFIX}$`);
const SECRET_KEY_SUFFIX_RE = new RegExp(`${SECRET_KEY_BOUNDARY_SUFFIX}$`);

// T8-F3 (E4 fix): a value truncated for DISPLAY (backtick-wrapped, ending in an
// ellipsis) has already destroyed whatever it previews — masking it protects
// nothing and destroys operator usability (e.g. `` Session: `4947004d...` ``).
// The carve-out is TIGHT (packet: "the WIDTH is the security decision"): the base
// (chars before the trailing ellipsis, inside the backticks) must be SHORT
// (<= MAX_TRUNCATED_DISPLAY_BASE) AND must NOT match a known token prefix — a
// long truncated secret prefix (20+ chars, e.g. `sk-...` plus a long run) still
// masks, and a short-but-token-prefixed base (e.g. `sk-...` plus a short run)
// still masks. Anything else keeps today's behavior.
const MAX_TRUNCATED_DISPLAY_BASE = 12;
const TRUNCATED_DISPLAY_VALUE_RE = /^`([^`]*?)(?:\.\.\.|…)`$/;
const PROVIDER_ALIAS_PREVIEW_RE = /(?:⟦WSA1:[^\s⟧]{0,256}⟧?|[［\[]WSA1[^\s\]\uff3d]{0,256}[\]\uff3d]?|WSA1[:：][^\s]{0,256})/gu;

function isDisplayTruncatedNonSecret(value: string): boolean {
  const match = TRUNCATED_DISPLAY_VALUE_RE.exec(value);
  if (!match) return false;
  const base = match[1]!;
  return base.length <= MAX_TRUNCATED_DISPLAY_BASE && !KNOWN_TOKEN_PREFIX_RE.test(base);
}

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[.-]+/g, '_');
  const apiKeyMarker = /api_?key/g;
  for (const match of normalized.matchAll(apiKeyMarker)) {
    const prefixLength = match.index;
    const suffixLength = normalized.length - match.index - match[0].length;
    if (prefixLength <= 20 && suffixLength <= 20) return true;
  }
  return SECRET_KEY_TERMINAL_RE.test(normalized) || SECRET_KEY_BOUNDARY_RE.test(normalized);
}

function secretKeySuffixStart(key: string): number | null {
  const normalized = key.toLowerCase().replace(/[.-]+/g, '_');
  const candidates: number[] = [];
  const apiKeyMarker = /api_?key/g;
  for (const match of normalized.matchAll(apiKeyMarker)) {
    const suffixLength = normalized.length - match.index - match[0].length;
    if (suffixLength <= 20) candidates.push(match.index);
  }
  for (const pattern of [SECRET_KEY_TERMINAL_RE, SECRET_KEY_SUFFIX_RE]) {
    const match = pattern.exec(normalized);
    if (match?.index !== undefined) candidates.push(match.index);
  }
  return candidates.length === 0 ? null : Math.min(...candidates);
}

interface KeyedValueStart {
  readonly secretStart: number;
  readonly valueStart: number;
}

export interface ProviderSecretBoundaryWorkCounter {
  /** Aggregate deterministic scanner work only; never content, positions, or values. */
  units: number;
}

function addBoundaryWork(
  counter: ProviderSecretBoundaryWorkCounter | undefined,
  units: number,
): void {
  if (counter) counter.units += units;
}

function keyedValueStart(
  text: string,
  delimiterIndex: number,
  allowSecretKeySuffix: boolean,
  fieldBoundaryStarts: ReadonlySet<number>,
  workCounter?: ProviderSecretBoundaryWorkCounter,
): KeyedValueStart | null {
  let keyEnd = delimiterIndex;
  while (keyEnd > 0 && /\s/.test(text[keyEnd - 1]!)) {
    addBoundaryWork(workCounter, 1);
    keyEnd -= 1;
  }
  let keyStart = keyEnd;
  let usedSecretKeySuffix = false;
  const closingQuote = text[keyEnd - 1];
  if (closingQuote === '"' || closingQuote === "'") {
    let contentStart = keyEnd - 1;
    while (contentStart > 0 && /[A-Za-z0-9_.-]/.test(text[contentStart - 1]!)) {
      addBoundaryWork(workCounter, 1);
      contentStart -= 1;
    }
    if (text[contentStart - 1] !== closingQuote) return null;
    keyStart = contentStart - 1;
    const key = text.slice(contentStart, keyEnd - 1);
    addBoundaryWork(workCounter, key.length);
    if (!isSecretKey(key)) {
      const suffixStart = allowSecretKeySuffix ? secretKeySuffixStart(key) : null;
      if (suffixStart === null) return null;
      keyStart = contentStart + suffixStart;
      usedSecretKeySuffix = true;
    }
  } else {
    while (keyStart > 0 && /[A-Za-z0-9_.-]/.test(text[keyStart - 1]!)) {
      addBoundaryWork(workCounter, 1);
      keyStart -= 1;
    }
    if (keyStart === keyEnd) return null;
    const key = text.slice(keyStart, keyEnd);
    addBoundaryWork(workCounter, key.length);
    if (!isSecretKey(key)) {
      const suffixStart = allowSecretKeySuffix ? secretKeySuffixStart(key) : null;
      if (suffixStart === null) return null;
      keyStart += suffixStart;
      usedSecretKeySuffix = true;
    }
  }
  if (
    !usedSecretKeySuffix
    && keyStart > 0
    && /[A-Za-z0-9_]/.test(text[keyStart - 1]!)
    && !fieldBoundaryStarts.has(keyStart)
  ) return null;
  let valueStart = delimiterIndex + 1;
  while (valueStart < text.length && /\s/.test(text[valueStart]!)) {
    addBoundaryWork(workCounter, 1);
    valueStart += 1;
  }
  return { secretStart: keyStart, valueStart };
}

interface KeyedSecretValue {
  readonly secretStart: number;
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly quote: '"' | "'" | null;
  readonly closed: boolean;
  readonly redact: boolean;
}

interface BoundaryCandidateIndex {
  readonly unquotedEnds: Uint32Array;
  // Quote closures remain delimiter-specific: a shared table could close a
  // single-quoted value with a double quote (or vice versa).
  readonly singleQuoteEnds: Uint32Array;
  readonly doubleQuoteEnds: Uint32Array;
  readonly tokenMatchEnds: Int32Array;
}

function createBoundaryCandidateIndex(
  text: string,
  workCounter?: ProviderSecretBoundaryWorkCounter,
): BoundaryCandidateIndex {
  const length = text.length;
  // Four typed arrays are zero-initialized and filled, then two linear scans
  // populate them. Charge all ten source-length passes.
  addBoundaryWork(workCounter, length * 10);
  const unquotedEnds = new Uint32Array(length).fill(length);
  const singleQuoteEnds = new Uint32Array(length).fill(length);
  const doubleQuoteEnds = new Uint32Array(length).fill(length);
  const tokenMatchEnds = new Int32Array(length).fill(-1);
  let previousSingleQuote = -1;
  let previousDoubleQuote = -1;
  let backslashRun = 0;
  for (let index = 0; index < length; index += 1) {
    const char = text[index]!;
    const escaped = backslashRun % 2 === 1;
    if (char === "'" && !escaped) {
      if (previousSingleQuote !== -1) singleQuoteEnds[previousSingleQuote] = index;
      previousSingleQuote = index;
    }
    if (char === '"' && !escaped) {
      if (previousDoubleQuote !== -1) doubleQuoteEnds[previousDoubleQuote] = index;
      previousDoubleQuote = index;
    }
    backslashRun = char === '\\' ? backslashRun + 1 : 0;
  }
  let nextWhitespace = length;
  let greatestTokenBoundary = -1;
  for (let index = length - 1; index >= 0; index -= 1) {
    const char = text[index]!;
    if (/\s/u.test(char)) nextWhitespace = index;
    else unquotedEnds[index] = nextWhitespace;
    if (!KNOWN_TOKEN_CHAR_RE.test(char)) {
      greatestTokenBoundary = -1;
      continue;
    }
    const nextIsWord = index + 1 < length && WORD_CHAR_RE.test(text[index + 1]!);
    if (greatestTokenBoundary === -1 && WORD_CHAR_RE.test(char) !== nextIsWord) {
      greatestTokenBoundary = index + 1;
    }
    tokenMatchEnds[index] = greatestTokenBoundary;
  }
  return {
    unquotedEnds,
    singleQuoteEnds,
    doubleQuoteEnds,
    tokenMatchEnds,
  };
}

function keyedSecretValues(
  text: string,
  allowSecretKeySuffix = false,
  boundaryIndex?: BoundaryCandidateIndex,
  workCounter?: ProviderSecretBoundaryWorkCounter,
  fieldBoundaryStarts: ReadonlySet<number> = new Set(),
): KeyedSecretValue[] {
  const values: KeyedSecretValue[] = [];
  let candidateIndex = boundaryIndex;
  let consumedThrough = 0;
  addBoundaryWork(workCounter, text.length);
  for (const match of text.matchAll(ASSIGNMENT_DELIMITER)) {
    addBoundaryWork(workCounter, 1);
    if (!allowSecretKeySuffix && match.index < consumedThrough) continue;
    const start = keyedValueStart(
      text,
      match.index,
      allowSecretKeySuffix,
      fieldBoundaryStarts,
      workCounter,
    );
    if (start === null) continue;
    if (allowSecretKeySuffix && !candidateIndex) {
      candidateIndex = createBoundaryCandidateIndex(text, workCounter);
    }
    const { secretStart, valueStart } = start;
    const opening = text[valueStart];
    if (opening === '"' || opening === "'") {
      let valueEnd = candidateIndex
        ? (opening === '"' ? candidateIndex.doubleQuoteEnds : candidateIndex.singleQuoteEnds)[valueStart]!
        : valueStart + 1;
      let escaped = false;
      while (!candidateIndex && valueEnd < text.length) {
        addBoundaryWork(workCounter, 1);
        const char = text[valueEnd]!;
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === opening) break;
        valueEnd += 1;
      }
      const closed = text[valueEnd] === opening;
      values.push({
        secretStart,
        valueStart,
        valueEnd,
        quote: opening,
        closed,
        redact: true,
      });
      if (!allowSecretKeySuffix) consumedThrough = closed ? valueEnd + 1 : valueEnd;
      continue;
    }
    let valueEnd = candidateIndex?.unquotedEnds[valueStart] ?? valueStart;
    while (!candidateIndex && valueEnd < text.length && !/\s/.test(text[valueEnd]!)) {
      addBoundaryWork(workCounter, 1);
      valueEnd += 1;
    }
    const value = text.slice(valueStart, valueEnd);
    values.push({
      secretStart,
      valueStart,
      valueEnd,
      quote: null,
      closed: false,
      redact: value.length > 0 && !isDisplayTruncatedNonSecret(value),
    });
    if (!allowSecretKeySuffix) consumedThrough = valueEnd;
  }
  return values;
}

function redactKeyedSecretValues(text: string): string {
  let cursor = 0;
  let out = '';
  for (const value of keyedSecretValues(text)) {
    out += text.slice(cursor, value.valueStart);
    if (value.quote !== null) {
      out += `${value.quote}[REDACTED]${value.closed ? value.quote : ''}`;
      cursor = value.closed ? value.valueEnd + 1 : value.valueEnd;
      continue;
    }
    const rawValue = text.slice(value.valueStart, value.valueEnd);
    out += value.redact ? '[REDACTED]' : rawValue;
    cursor = value.valueEnd;
  }
  return out + text.slice(cursor);
}

export function sanitizeProviderSecrets(text: string): string {
  BEARER_TOKEN_RE.lastIndex = 0;
  KNOWN_TOKEN_RE.lastIndex = 0;
  return redactKeyedSecretValues(text)
    .replace(BEARER_TOKEN_RE, 'Bearer [REDACTED]')
    .replace(KNOWN_TOKEN_RE, '[REDACTED_TOKEN]');
}

interface ProviderSecretValueSpan {
  readonly start: number;
  readonly end: number;
  /** Stable start of the semantic value, used across overlapping scan windows. */
  readonly identityStart: number;
  readonly keyedContentStarts: readonly number[];
  readonly nestedGrammarStarts: readonly number[];
}

const EMPTY_FIELD_BOUNDARY_STARTS: ReadonlySet<number> = new Set();

function mergeProviderSecretSpanGroups(
  groups: readonly ProviderSecretValueSpan[][],
  workCounter?: ProviderSecretBoundaryWorkCounter,
): ProviderSecretValueSpan[] {
  const cursors = groups.map(() => 0);
  const merged: ProviderSecretValueSpan[] = [];
  while (true) {
    let selectedGroup = -1;
    let selected: ProviderSecretValueSpan | undefined;
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const candidate = groups[groupIndex]![cursors[groupIndex]!];
      if (
        candidate
        && (
          !selected
          || candidate.start < selected.start
          || (candidate.start === selected.start && candidate.end < selected.end)
        )
      ) {
        selectedGroup = groupIndex;
        selected = candidate;
      }
    }
    if (!selected || selectedGroup === -1) break;
    addBoundaryWork(workCounter, groups.length + 1);
    cursors[selectedGroup] = cursors[selectedGroup]! + 1;
    const previous = merged.at(-1);
    if (previous && selected.start < previous.end) {
      addBoundaryWork(
        workCounter,
        previous.keyedContentStarts.length
          + selected.keyedContentStarts.length
          + previous.nestedGrammarStarts.length
          + selected.nestedGrammarStarts.length,
      );
      merged[merged.length - 1] = {
        start: Math.min(previous.start, selected.start),
        end: Math.max(previous.end, selected.end),
        identityStart: Math.min(previous.identityStart, selected.identityStart),
        keyedContentStarts: [
          ...previous.keyedContentStarts,
          ...selected.keyedContentStarts,
        ],
        nestedGrammarStarts: [
          ...previous.nestedGrammarStarts,
          ...selected.nestedGrammarStarts,
        ],
      };
    } else {
      merged.push(selected);
    }
  }
  return merged;
}

function uniqueProviderSecretSpans(
  groups: readonly ProviderSecretValueSpan[][],
  workCounter?: ProviderSecretBoundaryWorkCounter,
): ProviderSecretValueSpan[] {
  const spans: ProviderSecretValueSpan[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const span of group) {
      addBoundaryWork(workCounter, 1);
      const key = `${span.start}:${span.end}:${span.identityStart}`;
      if (!seen.has(key)) {
        seen.add(key);
        spans.push(span);
      }
    }
  }
  return spans;
}

function providerSecretValueSpans(
  text: string,
  allowSecretKeySuffix = false,
  fieldBoundaryStarts: ReadonlySet<number> = EMPTY_FIELD_BOUNDARY_STARTS,
  workCounter?: ProviderSecretBoundaryWorkCounter,
): ProviderSecretValueSpan[] {
  const bearerSpans: ProviderSecretValueSpan[] = [];
  const knownTokenSpans: ProviderSecretValueSpan[] = [];
  const fieldStartTokenSpans: ProviderSecretValueSpan[] = [];
  const keyedSpans: ProviderSecretValueSpan[] = [];
  let boundaryIndex: BoundaryCandidateIndex | undefined;
  addBoundaryWork(workCounter, text.length);
  BEARER_TOKEN_RE.lastIndex = 0;
  for (const match of text.matchAll(BEARER_TOKEN_RE)) {
    if (match.index !== undefined) {
      const valueOffset = match[0].search(/\s/u) + 1;
      bearerSpans.push({
        start: match.index,
        end: match.index + match[0].length,
        identityStart: match.index + valueOffset,
        keyedContentStarts: [],
        nestedGrammarStarts: [match.index],
      });
    }
  }
  addBoundaryWork(workCounter, text.length);
  KNOWN_TOKEN_RE.lastIndex = 0;
  for (const match of text.matchAll(KNOWN_TOKEN_RE)) {
    if (match.index !== undefined) {
      knownTokenSpans.push({
        start: match.index,
        end: match.index + match[0].length,
        identityStart: match.index,
        keyedContentStarts: [],
        nestedGrammarStarts: [match.index],
      });
    }
  }
  if (allowSecretKeySuffix) {
    for (const start of fieldBoundaryStarts) {
      addBoundaryWork(workCounter, 1);
      KNOWN_TOKEN_PREFIX_AT_START_RE.lastIndex = start;
      const prefixMatch = KNOWN_TOKEN_PREFIX_AT_START_RE.exec(text);
      if (prefixMatch?.index === start && !boundaryIndex) {
        boundaryIndex = createBoundaryCandidateIndex(text, workCounter);
      }
      const end = boundaryIndex?.tokenMatchEnds[start] ?? -1;
      if (
        prefixMatch?.index === start
        && end - start - prefixMatch[0].length >= 12
      ) {
        fieldStartTokenSpans.push({
          start,
          end,
          identityStart: start,
          keyedContentStarts: [],
          nestedGrammarStarts: [start],
        });
      }
    }
  }
  for (const value of keyedSecretValues(
    text,
    allowSecretKeySuffix,
    boundaryIndex,
    workCounter,
    fieldBoundaryStarts,
  )) {
    if (!value.redact) continue;
    keyedSpans.push({
      start: value.secretStart,
      end: value.closed ? value.valueEnd + 1 : value.valueEnd,
      identityStart: value.valueStart,
      keyedContentStarts: [value.valueStart + (value.quote === null ? 0 : 1)],
      nestedGrammarStarts: [],
    });
  }
  const groups = [bearerSpans, knownTokenSpans, fieldStartTokenSpans, keyedSpans];
  // Canonical per-field spans may merge overlapping grammars for one value.
  // Relaxed boundary candidates must retain distinct starts: an earlier greedy
  // candidate can overlap a later real field-start secret.
  return allowSecretKeySuffix
    ? uniqueProviderSecretSpans(groups, workCounter)
    : mergeProviderSecretSpanGroups(groups, workCounter);
}

export interface ProviderSecretTextSequenceScan {
  readonly directSecretCount: number;
  readonly fragmentedSecretCount: number;
  readonly detectorInvocationCount: number;
  readonly workUnitCount: number;
}

const MAX_SECRET_SEQUENCE_SEGMENT_LENGTH = 64 * 1024;
const SECRET_SEQUENCE_OVERLAP = 512;

function boundaryPrefixCounts(
  length: number,
  boundaries: readonly number[],
  workCounter: ProviderSecretBoundaryWorkCounter,
): Uint32Array {
  // Two typed-array initializations, one prefix fill, and one marker write per
  // real boundary are included in the deterministic receipt.
  addBoundaryWork(workCounter, length * 3 + boundaries.length);
  const markers = new Uint8Array(length + 1);
  for (const boundary of boundaries) {
    if (boundary > 0 && boundary < length) markers[boundary] = 1;
  }
  const counts = new Uint32Array(length + 1);
  for (let index = 1; index <= length; index += 1) {
    counts[index] = counts[index - 1]! + markers[index]!;
  }
  return counts;
}

function uniqueOrderedBoundaries(
  boundaries: readonly number[],
  workCounter: ProviderSecretBoundaryWorkCounter,
): number[] {
  addBoundaryWork(workCounter, boundaries.length);
  const unique: number[] = [];
  let previous = -1;
  for (const boundary of boundaries) {
    if (boundary !== previous) unique.push(boundary);
    previous = boundary;
  }
  return unique;
}

function spanCrossesFieldBoundary(
  span: ProviderSecretValueSpan,
  boundaryCounts: Uint32Array,
): boolean {
  if (span.end <= span.start + 1) return false;
  return boundaryCounts[span.end - 1]! > boundaryCounts[span.start]!;
}

/**
 * Count canonical direct and cross-field secret values with bounded segment overlap.
 * Segment overlap is fixed at the historical 512-character carry and is de-duplicated
 * by absolute secret-value identity.
 */
export function scanProviderSecretTextSequence(
  texts: readonly string[],
): ProviderSecretTextSequenceScan {
  const workCounter: ProviderSecretBoundaryWorkCounter = { units: 0 };
  const directIdentities = new Set<number>();
  const directSpans: Array<Pick<
    ProviderSecretValueSpan,
    'identityStart' | 'keyedContentStarts' | 'nestedGrammarStarts'
  >> = [];
  // Collapse only grammar matches that begin at the exact keyed-value content
  // position; ordinary overlap must remain separately countable.
  const directKeyedContentStarts = new Set<number>();
  const directNestedGrammarStarts = new Set<number>();
  const completeFieldCandidateIdentities = new Set<number>();
  const fragmentedIdentities = new Set<number>();
  let globalOffset = 0;
  let detectorInvocationCount = 0;
  let segmentChunks: string[] = [];
  let segmentLength = 0;
  let segmentStart = 0;
  let segmentBoundaries: number[] = [];

  for (const text of texts) {
    addBoundaryWork(workCounter, 1);
    detectorInvocationCount += 1;
    for (const span of providerSecretValueSpans(
      text,
      false,
      EMPTY_FIELD_BOUNDARY_STARTS,
      workCounter,
    )) {
      addBoundaryWork(workCounter, 1);
      directSpans.push({
        identityStart: globalOffset + span.identityStart,
        keyedContentStarts: span.keyedContentStarts.map((start) => globalOffset + start),
        nestedGrammarStarts: span.nestedGrammarStarts.map((start) => globalOffset + start),
      });
      for (const start of span.keyedContentStarts) {
        addBoundaryWork(workCounter, 1);
        directKeyedContentStarts.add(globalOffset + start);
      }
      for (const start of span.nestedGrammarStarts) {
        addBoundaryWork(workCounter, 1);
        directNestedGrammarStarts.add(globalOffset + start);
      }
    }
    for (const span of providerSecretValueSpans(
      text,
      true,
      EMPTY_FIELD_BOUNDARY_STARTS,
      workCounter,
    )) {
      addBoundaryWork(workCounter, 1);
      completeFieldCandidateIdentities.add(globalOffset + span.identityStart);
    }
    globalOffset += text.length;
  }

  for (const span of directSpans) {
    const nestedMatchesKeyed = span.nestedGrammarStarts.some((start) => (
      directKeyedContentStarts.has(start)
    ));
    addBoundaryWork(workCounter, span.nestedGrammarStarts.length);
    if (span.keyedContentStarts.length > 0 || !nestedMatchesKeyed) {
      directIdentities.add(span.identityStart);
    }
  }

  globalOffset = 0;
  const materializeSegment = (): string => {
    if (segmentChunks.length === 1) return segmentChunks[0]!;
    addBoundaryWork(workCounter, segmentLength);
    const segmentText = segmentChunks.join('');
    segmentChunks = [segmentText];
    return segmentText;
  };
  const analyzeSegment = (): void => {
    if (segmentLength === 0 || segmentBoundaries.length === 0) return;
    detectorInvocationCount += 1;
    const segmentText = materializeSegment();
    const uniqueBoundaries = uniqueOrderedBoundaries(segmentBoundaries, workCounter);
    addBoundaryWork(workCounter, uniqueBoundaries.length);
    const boundarySet = new Set(uniqueBoundaries);
    const boundaryCounts = boundaryPrefixCounts(
      segmentLength,
      uniqueBoundaries,
      workCounter,
    );
    const crossingSpans: ProviderSecretValueSpan[] = [];
    for (const span of providerSecretValueSpans(
      segmentText,
      true,
      boundarySet,
      workCounter,
    )) {
      addBoundaryWork(workCounter, 1);
      if (
        spanCrossesFieldBoundary(span, boundaryCounts)
        && !completeFieldCandidateIdentities.has(segmentStart + span.identityStart)
      ) {
        crossingSpans.push(span);
      }
    }
    const fragmentedKeyedContentStarts = new Set<number>();
    for (const span of crossingSpans) {
      for (const start of span.keyedContentStarts) {
        addBoundaryWork(workCounter, 1);
        fragmentedKeyedContentStarts.add(segmentStart + start);
      }
    }
    for (const span of crossingSpans) {
      const keyedMatchesDirectNested = span.keyedContentStarts.some((start) => (
        directNestedGrammarStarts.has(segmentStart + start)
      ));
      const nestedMatchesKeyed = span.nestedGrammarStarts.some((start) => {
        const absoluteStart = segmentStart + start;
        return directKeyedContentStarts.has(absoluteStart)
          || fragmentedKeyedContentStarts.has(absoluteStart);
      });
      addBoundaryWork(
        workCounter,
        span.keyedContentStarts.length * 2 + span.nestedGrammarStarts.length * 2,
      );
      if (!keyedMatchesDirectNested && !nestedMatchesKeyed) {
        addBoundaryWork(workCounter, 1);
        fragmentedIdentities.add(segmentStart + span.identityStart);
      }
    }
  };
  const retainSegmentOverlap = (): void => {
    const segmentText = materializeSegment();
    const retainedLength = Math.min(SECRET_SEQUENCE_OVERLAP, segmentLength);
    const retainedStart = segmentLength - retainedLength;
    addBoundaryWork(workCounter, retainedLength);
    segmentStart += retainedStart;
    segmentChunks = [segmentText.slice(retainedStart)];
    segmentLength = retainedLength;
    segmentBoundaries = segmentBoundaries
      .filter((boundary) => boundary >= retainedStart)
      .map((boundary) => boundary - retainedStart);
  };
  const flushForCapacity = (nextLength: number): void => {
    if (
      segmentLength > 0
      && segmentLength + nextLength > MAX_SECRET_SEQUENCE_SEGMENT_LENGTH
    ) {
      analyzeSegment();
      retainSegmentOverlap();
    }
  };
  const appendContiguous = (value: string, valueStart: number): void => {
    flushForCapacity(value.length);
    if (segmentLength === 0) segmentStart = valueStart;
    else segmentBoundaries.push(segmentLength);
    segmentChunks.push(value);
    segmentLength += value.length;
  };

  for (const text of texts) {
    addBoundaryWork(workCounter, 1);
    if (text.length <= SECRET_SEQUENCE_OVERLAP) {
      appendContiguous(text, globalOffset);
      globalOffset += text.length;
      continue;
    }
    appendContiguous(text.slice(0, SECRET_SEQUENCE_OVERLAP), globalOffset);
    analyzeSegment();
    addBoundaryWork(workCounter, SECRET_SEQUENCE_OVERLAP * 2);
    segmentChunks = [text.slice(-SECRET_SEQUENCE_OVERLAP)];
    segmentLength = SECRET_SEQUENCE_OVERLAP;
    segmentStart = globalOffset + text.length - SECRET_SEQUENCE_OVERLAP;
    segmentBoundaries = [];
    globalOffset += text.length;
  }
  analyzeSegment();

  return {
    directSecretCount: directIdentities.size,
    fragmentedSecretCount: fragmentedIdentities.size,
    detectorInvocationCount,
    workUnitCount: workCounter.units,
  };
}

/** Secret-only predicate for fail-closed provider boundaries. */
export function containsProviderSecretValue(text: string): boolean {
  BEARER_TOKEN_RE.lastIndex = 0;
  if (BEARER_TOKEN_RE.test(text)) return true;
  KNOWN_TOKEN_RE.lastIndex = 0;
  if (KNOWN_TOKEN_RE.test(text)) return true;
  return keyedSecretValues(text).some((value) => value.redact);
}

/** Detect a canonical secret match whose span crosses one deterministic field boundary. */
export function containsProviderSecretValueAcrossBoundary(
  left: string,
  right: string,
  leftFieldStarts: readonly number[] = [],
  workCounter?: ProviderSecretBoundaryWorkCounter,
): boolean {
  const boundary = left.length;
  const tokenBoundaryStarts = new Set(leftFieldStarts);
  const directLeftStarts = new Set(
    providerSecretValueSpans(left, true, tokenBoundaryStarts, workCounter)
      .map((span) => span.start),
  );
  return providerSecretValueSpans(left + right, true, tokenBoundaryStarts, workCounter)
    .some((span) => (
      span.start < boundary
      && span.end > boundary
      && !directLeftStarts.has(span.start)
    ));
}

function redactEmailLikeTokens(
  text: string,
  preserveWhatsAppJids: boolean,
  preserveWhatsAppMentions: boolean,
): string {
  let cursor = 0;
  let out = '';
  let index = 0;
  while (index < text.length) {
    const openingQuote = text[index];
    if (openingQuote === '"' || openingQuote === "'") {
      let quoteEnd = index + 1;
      let escaped = false;
      while (quoteEnd < text.length) {
        const char = text[quoteEnd]!;
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === openingQuote) break;
        quoteEnd += 1;
      }
      if (text[quoteEnd] === openingQuote && text[quoteEnd + 1] === '@') {
        let emailEnd = quoteEnd + 2;
        if (text[emailEnd] === '[') {
          const bracketEnd = text.indexOf(']', emailEnd + 1);
          emailEnd = bracketEnd === -1 ? text.length : bracketEnd + 1;
        } else {
          while (emailEnd < text.length && /[A-Za-z0-9.-]/.test(text[emailEnd]!)) emailEnd += 1;
        }
        // B25 (1a): the same email-shaped requirement that gates the token
        // scanner below gates this branch — a NON-EMPTY domain must follow
        // the '@'. The old code redacted after scanning ZERO domain chars,
        // so quoted speech followed by the word "at" ('she said "hi"@ 5pm')
        // became [REDACTED_EMAIL]. With an empty domain we fall through to
        // the ordinary scanner, which tokenizes the quoted text and the bare
        // '@' separately (the quote breaks the token), so nothing redacts.
        if (emailEnd > quoteEnd + 2) {
          out += text.slice(cursor, index);
          out += '[REDACTED_EMAIL]';
          cursor = emailEnd;
          index = emailEnd;
          continue;
        }
      }
    }
    if (!EMAIL_TOKEN_CHAR.test(text[index]!)) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < text.length) {
      const char = text[index]!;
      if (EMAIL_TOKEN_CHAR.test(char)) {
        index += 1;
        continue;
      }
      if (char === ':' && /^\d{5,}(?:-\d+)?$/.test(text.slice(start, index))) {
        let deviceEnd = index + 1;
        while (deviceEnd < text.length && /[0-9]/.test(text[deviceEnd]!)) deviceEnd += 1;
        if (deviceEnd > index + 1 && text[deviceEnd] === '@') {
          index = deviceEnd;
          continue;
        }
      }
      break;
    }
    const token = text.slice(start, index);
    if (!token.includes('@')) continue;

    let coreEnd = token.length;
    while (coreEnd > 0 && TRAILING_EMAIL_PUNCTUATION.has(token[coreEnd - 1]!)) coreEnd -= 1;
    const core = token.slice(0, coreEnd);
    const suffix = token.slice(coreEnd);
    // E9 (packet D5) + B25: only a truly-bare '@' run is exempt — every
    // other '@'-bearing core is email-shaped, mention-shaped, or a
    // dangling-local address fragment (equivalence proven at ALL_AT_SIGNS
    // above) and redacts unless a preserve rule below claims it. A bare run
    // is left in place via the pending-slice cursor, like the no-'@' case.
    if (ALL_AT_SIGNS.test(core)) continue;
    const jidMatch = preserveWhatsAppJids ? jidPattern().exec(core) : null;
    const preserve = (jidMatch?.index === 0 && jidMatch[0].length === core.length)
      || (preserveWhatsAppMentions && PRESERVABLE_MENTION.test(core));

    out += text.slice(cursor, start);
    out += preserve ? `${core}${suffix}` : `[REDACTED_EMAIL]${suffix}`;
    cursor = index;
  }
  return out + text.slice(cursor);
}

export interface ProviderPreviewSanitizerOptions {
  preserveWhatsAppJids?: boolean;
  preserveWhatsAppMentions?: boolean;
  /**
   * B25 chat-scope (owner ruling 2026-07-19): email redaction is a
   * BACKGROUND-ONLY function — for text handed to third-party providers
   * (previews, structured logs, handoff summarizers). Default TRUE, so every
   * background caller keeps full behavior with zero changes. Chat egress
   * (redactInternalArtifacts) passes FALSE, which skips the email-class pass
   * ENTIRELY — token path, quoted-local path, and dangling-local alike —
   * while secret/token/credential masking stays fully active. When false,
   * the two preserve* flags are inert (they only parameterize the email pass).
   */
  redactEmailLike?: boolean;
}

export function sanitizeProviderPreviewText(
  text: string,
  options: ProviderPreviewSanitizerOptions = {},
): string {
  const sanitized = sanitizeProviderSecrets(text).replace(
    PROVIDER_ALIAS_PREVIEW_RE,
    '[REDACTED_PROVIDER_ALIAS]',
  );
  if (options.redactEmailLike === false) return sanitized;
  return redactEmailLikeTokens(
    sanitized,
    options.preserveWhatsAppJids === true,
    options.preserveWhatsAppMentions === true,
  );
}

export function providerPreview(text: string, maxLength: number): string {
  return sanitizeProviderPreviewText(text).slice(0, maxLength);
}
