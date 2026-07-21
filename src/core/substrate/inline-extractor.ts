// src/core/substrate/inline-extractor.ts
export type ImperativeVerb =
  | 'remind' | 'schedule' | 'watch' | 'follow-up' | 'task' | 'track' | 'bead';

export type InlineImperativeRejectionReason =
  | 'not_anchored'
  | 'unsupported_message_type'
  | 'quoted_or_fenced'
  | 'empty_target'
  | 'oversize'
  | 'invalid_unicode';

export type InlineImperativeResult =
  | {
      admitted: true;
      verb: ImperativeVerb;
      normalizedTarget: string;
      matchedText: string;
    }
  | { admitted: false; reason: InlineImperativeRejectionReason };

export interface ImperativeMatch {
  verb: ImperativeVerb;
  offset: number;
  matchedText: string;
}

const MAX_CLASSIFICATION_BYTES = 8 * 1024;
const IMPERATIVE_GRAMMAR = /^(?:please(?:\s+|,\s+))?(?<imperative>remind\s+me|schedule|watch\s+for|follow\s+up|make\s+a\s+task|track\s+this|add\s+a\s+bead)(?=$|[^\p{L}\p{M}\p{N}_])/iu;
const QUOTED_OR_FENCED = /^(?:>|`{3}|~{3}|\[?forwarded(?:\s+many\s+times)?\]?(?=$|[\s:]))/iu;
const TARGET_SEPARATOR = /^(?:(?:(?:to|for|that|about)\b|:)\s*)+/iu;

function containsUnpairedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = text.charCodeAt(index + 1);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function imperativeVerb(matchedText: string): ImperativeVerb {
  const phrase = matchedText.toLowerCase().replace(/\s+/g, ' ');
  switch (phrase) {
    case 'remind me': return 'remind';
    case 'schedule': return 'schedule';
    case 'watch for': return 'watch';
    case 'follow up': return 'follow-up';
    case 'make a task': return 'task';
    case 'track this': return 'track';
    case 'add a bead': return 'bead';
    default: throw new Error('unreachable inline imperative phrase');
  }
}

export function classifyInlineImperative(text: string): InlineImperativeResult {
  if (typeof text !== 'string') {
    return { admitted: false, reason: 'unsupported_message_type' };
  }
  if (containsUnpairedSurrogate(text)) {
    return { admitted: false, reason: 'invalid_unicode' };
  }

  const normalized = text
    .replace(/^\uFEFF/u, '')
    .normalize('NFKC')
    .replace(/\r\n?|\u2028|\u2029/gu, '\n')
    .replace(/^[\p{Zs}\t\v\f]+/u, '');

  if (Buffer.byteLength(normalized, 'utf8') > MAX_CLASSIFICATION_BYTES) {
    return { admitted: false, reason: 'oversize' };
  }
  if (normalized.trim().length === 0) {
    return { admitted: false, reason: 'empty_target' };
  }
  if (QUOTED_OR_FENCED.test(normalized)) {
    return { admitted: false, reason: 'quoted_or_fenced' };
  }

  const match = IMPERATIVE_GRAMMAR.exec(normalized);
  const matchedText = match?.groups?.imperative;
  if (!match || !matchedText) {
    return { admitted: false, reason: 'not_anchored' };
  }

  const normalizedTarget = normalized
    .slice(match[0].length)
    .trim()
    .replace(TARGET_SEPARATOR, '')
    .trim();
  if (normalizedTarget.length === 0) {
    return { admitted: false, reason: 'empty_target' };
  }

  return {
    admitted: true,
    verb: imperativeVerb(matchedText),
    normalizedTarget,
    matchedText,
  };
}

export function matchImperative(text: string): ImperativeMatch | null {
  const result = classifyInlineImperative(text);
  if (!result.admitted) return null;
  return { verb: result.verb, offset: 0, matchedText: result.matchedText };
}

export function extractImperativeTarget(text: string): string {
  const result = classifyInlineImperative(text);
  return result.admitted ? result.normalizedTarget : text.trim();
}
