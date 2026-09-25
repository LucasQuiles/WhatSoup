import { jidPattern } from '../lib/redaction-patterns.ts';
import { redactInternalArtifacts } from './outbound-message-safety.ts';
import {
  countUnicodeCodePoints,
  normalizeClientOutputTermForComparison,
  type ClientOutputBlockedTerm,
  type ClientOutputDecision,
  type ClientOutputPolicy,
  type ClientOutputPolicyInput,
  type ClientOutputViolationCode,
} from './client-output-policy-contract.ts';

export type {
  ClientOutputBlockedTerm,
  ClientOutputDecision,
  ClientOutputPolicy,
  ClientOutputPolicyInput,
  ClientOutputViolationCode,
} from './client-output-policy-contract.ts';

const ALLOW_DECISION: ClientOutputDecision = Object.freeze({ action: 'allow' });
const WORD_CODE_POINT = /^[\p{L}\p{N}\p{M}\p{Pc}]$/u;

function isWordCodePoint(value: string | undefined): boolean {
  return value !== undefined && WORD_CODE_POINT.test(value);
}

function wholeWordIncludes(haystack: string, needle: string): boolean {
  if (needle.length === 0) return false;

  let fromIndex = 0;
  while (fromIndex <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, fromIndex);
    if (index === -1) return false;

    const before = Array.from(haystack.slice(0, index)).at(-1);
    const after = Array.from(haystack.slice(index + needle.length))[0];
    if (!isWordCodePoint(before) && !isWordCodePoint(after)) return true;

    const firstCodePoint = haystack.codePointAt(index);
    fromIndex = index + (firstCodePoint !== undefined && firstCodePoint > 0xffff ? 2 : 1);
  }

  return false;
}

function blockedTermMatches(finalText: string, term: ClientOutputBlockedTerm): boolean {
  const haystack = normalizeClientOutputTermForComparison(finalText, term.caseSensitive);
  const needle = normalizeClientOutputTermForComparison(term.value, term.caseSensitive);
  if (needle.length === 0) return false;
  return term.match === 'substring'
    ? haystack.includes(needle)
    : wholeWordIncludes(haystack, needle);
}

function countQuestionMarks(value: string): number {
  let count = 0;
  for (const codePoint of value) {
    if (codePoint === '?' || codePoint === '？' || codePoint === '؟') count += 1;
  }
  return count;
}

export function evaluateClientOutputPolicy(
  policy: ClientOutputPolicy,
  input: ClientOutputPolicyInput,
): ClientOutputDecision {
  const violationCodes: ClientOutputViolationCode[] = [];

  if (countUnicodeCodePoints(input.finalText) > policy.maxCodePoints) {
    violationCodes.push('max_code_points');
  }
  if (countQuestionMarks(input.finalText) > policy.maxQuestionMarks) {
    violationCodes.push('max_question_marks');
  }
  if (policy.blockedTerms.some((term) => blockedTermMatches(input.finalText, term))) {
    violationCodes.push('blocked_term');
  }
  if (
    policy.rejectInternalArtifacts
    && redactInternalArtifacts(input.sourceText, 'client').redactions.length > 0
  ) {
    violationCodes.push('internal_artifact');
  }
  if (policy.rejectWhatsAppJids && jidPattern().test(input.finalText)) {
    violationCodes.push('whatsapp_jid');
  }

  if (violationCodes.length === 0) return ALLOW_DECISION;

  return Object.freeze({
    action: 'reject',
    reason: 'client_output_policy',
    violationCodes: Object.freeze(violationCodes),
    satisfiesReplyGuarantee: false,
  });
}
