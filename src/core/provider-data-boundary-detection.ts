import { isIP } from 'node:net';

import {
  containsProviderSecretValue,
  containsProviderSecretValueAcrossBoundary,
} from '../lib/provider-preview-sanitizer.ts';
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

const ALIAS_SUSPECT_PATTERN = '(?:[⟦［\\[]\\s*WSA1|WSA1\\s*[:：])';
const ALIAS_SUSPECT_RE = new RegExp(ALIAS_SUSPECT_PATTERN, 'u');
const ALIAS_SUSPECT_GLOBAL_RE = new RegExp(ALIAS_SUSPECT_PATTERN, 'gu');
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
  readonly validate?: (value: string) => boolean;
}> = [
  { type: 'whatsapp_id', pattern: /\b\d{5,}(?:-\d+)?(?::\d+)?@(s\.whatsapp\.net|g\.us|lid|newsletter|broadcast)\b/giu, priority: 100 },
  { type: 'email', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, priority: 90 },
  {
    type: 'path',
    pattern: /(?<![A-Za-z0-9:/])\/(?!\/)[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~#?=&%+-]+)*/gu,
    priority: 85,
  },
  {
    type: 'path',
    pattern: /(?<![A-Za-z0-9])(?:[A-Za-z]:\\(?:[^\\\r\n:*?"<>|]+\\)*[^\\\r\n:*?"<>|]*|\\\\[A-Za-z0-9._-]+\\[A-Za-z0-9.$_-]+(?:\\[^\\\r\n:*?"<>|]+)*)/gu,
    priority: 85,
  },
  {
    type: 'network_identity',
    pattern: /(?<![A-Za-z0-9:])(?:[0-9A-F]{0,4}:){2,7}[0-9A-F]{0,4}(?![A-Za-z0-9:])/giu,
    priority: 75,
    validate: (value) => isIP(value) === 6,
  },
  {
    type: 'network_identity',
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu,
    priority: 70,
    validate: (value) => isIP(value) === 4,
  },
  {
    type: 'repository_ref',
    pattern: /\b(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#\d+|@[A-Za-z0-9._/-]+|\/(?:pull|issues)\/\d+)|(?:[A-Za-z0-9_.-]*[A-Z][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]*[._-][A-Za-z0-9_.-]+))\b/gu,
    priority: 60,
  },
  { type: 'network_identity', pattern: /\b(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+[A-Z]{2,63}\b/giu, priority: 50 },
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
      if (detector.validate && !detector.validate(match[0])) continue;
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

function aliasSyntaxViews(text: string): readonly string[] {
  const comparison = text.normalize('NFKC').replace(ALIAS_FORMAT_CHAR_RE, '');
  const skeleton = Array.from(comparison, (character) => ALIAS_CONFUSABLES[character] ?? character).join('');
  return [text, comparison, skeleton];
}

function containsProviderAliasSyntaxAcrossBoundary(left: string, right: string): boolean {
  const leftViews = aliasSyntaxViews(left);
  const rightViews = aliasSyntaxViews(right);
  for (let viewIndex = 0; viewIndex < leftViews.length; viewIndex += 1) {
    const leftView = leftViews[viewIndex]!;
    const combined = leftView + rightViews[viewIndex]!;
    ALIAS_SUSPECT_GLOBAL_RE.lastIndex = 0;
    for (const match of combined.matchAll(ALIAS_SUSPECT_GLOBAL_RE)) {
      if (
        match.index !== undefined
        && match.index < leftView.length
        && match.index + match[0].length > leftView.length
      ) return true;
    }
  }
  return false;
}

/** Detect reserved syntax fragmented across adjacent fields without rewriting trusted bytes. */
export function containsProviderAliasSyntaxAcross(texts: readonly string[]): boolean {
  return scanProviderTextSequence(texts).fragmentedAlias;
}

export interface ProviderTextSequenceScan {
  readonly directSecretCount: number;
  readonly fragmentedSecret: boolean;
  readonly directAlias: boolean;
  readonly fragmentedAlias: boolean;
  readonly detectorInvocationCount: number;
}

/** Scan one deterministic sequence while distinguishing complete values from cross-field fragments. */
export function scanProviderTextSequence(texts: readonly string[]): ProviderTextSequenceScan {
  let carry = '';
  let directSecretCount = 0;
  let fragmentedSecret = false;
  let directAlias = false;
  let fragmentedAlias = false;
  let detectorInvocationCount = 0;
  const hasSecret = (text: string): boolean => {
    detectorInvocationCount += 1;
    return containsProviderSecretValue(text);
  };
  const hasAlias = (text: string): boolean => {
    detectorInvocationCount += 1;
    return containsProviderAliasSyntax(text);
  };
  const hasAliasAcrossBoundary = (left: string, right: string): boolean => {
    detectorInvocationCount += 1;
    return containsProviderAliasSyntaxAcrossBoundary(left, right);
  };
  const hasSecretAcrossBoundary = (left: string, right: string): boolean => {
    detectorInvocationCount += 1;
    return containsProviderSecretValueAcrossBoundary(left, right);
  };
  for (const text of texts) {
    const prefix = text.slice(0, 512);
    const textHasSecret = hasSecret(text);
    const textHasAlias = hasAlias(text);
    if (textHasSecret) directSecretCount += 1;
    if (textHasAlias) directAlias = true;
    if (carry.length > 0) {
      if (!fragmentedSecret && hasSecretAcrossBoundary(carry, prefix)) fragmentedSecret = true;
      if (!fragmentedAlias && hasAliasAcrossBoundary(carry, prefix)) {
        fragmentedAlias = true;
      }
    }
    carry = (carry + text).slice(-512);
  }
  return {
    directSecretCount,
    fragmentedSecret,
    directAlias,
    fragmentedAlias,
    detectorInvocationCount,
  };
}
