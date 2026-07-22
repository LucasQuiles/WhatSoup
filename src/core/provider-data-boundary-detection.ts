import type { ProviderAliasType } from './provider-data-boundary-contract.ts';

export const MAX_BOUNDARY_TEXT_LENGTH = 1024 * 1024;
export const MAX_ALIASES_PER_TRANSFORM = 1024;
export const MAX_TRANSFORM_FIELDS = 10_000;
export const MAX_TOOL_NODES = 10_000;
export const MAX_TOOL_DEPTH = 32;

export interface ProviderAliasCandidate {
  readonly start: number;
  readonly end: number;
  readonly value: string;
  readonly type: ProviderAliasType;
  readonly priority: number;
}

const ALIAS_SUSPECT_RE = /(?:[⟦［\[]\s*WSA1|WSA1\s*[:：])/u;
const ALIAS_FORMAT_CHAR_RE = /[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu;
const ALIAS_CONFUSABLES: Readonly<Record<string, string>> = Object.freeze({
  'Ԝ': 'W',
  'ԝ': 'w',
  'Ѕ': 'S',
  'ѕ': 's',
  'Α': 'A',
  'А': 'A',
  'α': 'a',
  'а': 'a',
});

const DETECTORS: ReadonlyArray<{
  readonly type: ProviderAliasType;
  readonly pattern: RegExp;
  readonly priority: number;
}> = [
  { type: 'whatsapp_id', pattern: /\b\d{5,}(?:-\d+)?(?::\d+)?@(s\.whatsapp\.net|g\.us|lid|newsletter|broadcast)\b/giu, priority: 100 },
  { type: 'email', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, priority: 90 },
  { type: 'path', pattern: /(?:\/[A-Z0-9._~-]+){2,}(?:\/[A-Z0-9._~#?=&%+-]+)*/giu, priority: 80 },
  { type: 'network_identity', pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, priority: 70 },
  { type: 'repository_ref', pattern: /\b[A-Z0-9_.-]+\/[A-Z0-9_.-]+(?:#\d+|@[A-Z0-9._/-]+|\/(?:pull|issues)\/\d+)?\b/giu, priority: 60 },
  { type: 'network_identity', pattern: /\b(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+(?:local|internal|lan|com|net|org|io|ai|dev|cloud)\b/giu, priority: 50 },
  { type: 'phone', pattern: /(?:\+?\d[\d ()-]{8,}\d)/gu, priority: 40 },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function collectProviderAliasCandidates(
  text: string,
  technicalIdentifiers: readonly string[],
): ProviderAliasCandidate[] {
  const candidates: ProviderAliasCandidate[] = [];
  for (const detector of DETECTORS) {
    detector.pattern.lastIndex = 0;
    for (const match of text.matchAll(detector.pattern)) {
      if (match.index === undefined || match[0].length === 0) continue;
      candidates.push({
        start: match.index,
        end: match.index + match[0].length,
        value: match[0],
        type: detector.type,
        priority: detector.priority,
      });
    }
  }
  for (const identifier of technicalIdentifiers) {
    if (identifier.length === 0) continue;
    const pattern = new RegExp(`(?<![A-Za-z0-9_.-])${escapeRegExp(identifier)}(?![A-Za-z0-9_.-])`, 'gu');
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined) continue;
      candidates.push({
        start: match.index,
        end: match.index + match[0].length,
        value: match[0],
        type: 'technical_identifier',
        priority: 30,
      });
    }
  }
  candidates.sort((left, right) => (
    left.start - right.start
    || right.priority - left.priority
    || (right.end - right.start) - (left.end - left.start)
  ));
  const selected: ProviderAliasCandidate[] = [];
  let cursor = -1;
  for (const candidate of candidates) {
    if (candidate.start < cursor) continue;
    selected.push(candidate);
    cursor = candidate.end;
  }
  return selected;
}

export function containsProviderAliasSyntax(text: string): boolean {
  if (ALIAS_SUSPECT_RE.test(text)) return true;
  const comparison = text.normalize('NFKC').replace(ALIAS_FORMAT_CHAR_RE, '');
  if (comparison !== text && ALIAS_SUSPECT_RE.test(comparison)) return true;
  const skeleton = Array.from(comparison, (character) => ALIAS_CONFUSABLES[character] ?? character).join('');
  return skeleton !== comparison && ALIAS_SUSPECT_RE.test(skeleton);
}

/** Detect reserved syntax fragmented across adjacent fields without rewriting trusted bytes. */
export function containsProviderAliasSyntaxAcross(texts: readonly string[]): boolean {
  let carry = '';
  for (const text of texts) {
    const boundaryWindow = carry + text.slice(0, 512);
    if (carry.length > 0 && containsProviderAliasSyntax(boundaryWindow)) return true;
    carry = (carry + text).slice(-512);
  }
  return false;
}
