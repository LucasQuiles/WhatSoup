export type ClientOutputBlockedTerm = Readonly<{
  value: string;
  match: 'whole_word' | 'substring';
  caseSensitive: boolean;
}>;

export type ClientOutputPolicy = Readonly<{
  maxCodePoints: number;
  maxQuestionMarks: number;
  blockedTerms: readonly ClientOutputBlockedTerm[];
  rejectInternalArtifacts: boolean;
  rejectWhatsAppJids: boolean;
}>;

export type ClientOutputPolicyInput = Readonly<{
  sourceText: string;
  finalText: string;
}>;

export type ClientOutputViolationCode =
  | 'max_code_points'
  | 'max_question_marks'
  | 'blocked_term'
  | 'internal_artifact'
  | 'whatsapp_jid';

export type ClientOutputDecision =
  | Readonly<{ action: 'allow' }>
  | Readonly<{
      action: 'reject';
      reason: 'client_output_policy';
      violationCodes: readonly ClientOutputViolationCode[];
      satisfiesReplyGuarantee: false;
    }>;

export const CLIENT_OUTPUT_POLICY_ACTIONS = Object.freeze([
  'assistant_text',
  'send_message',
  'reply_message',
  'edit_message',
  'send_poll',
  'send_media',
] as const);

export type ClientOutputPolicyAction = (typeof CLIENT_OUTPUT_POLICY_ACTIONS)[number];

export type ClientOutputPolicyAuthorization = Readonly<{
  keyId: string;
  publicKey: string;
  requiredActions: readonly ClientOutputPolicyAction[];
}>;

export type ConfiguredClientOutputPolicy = ClientOutputPolicy & Readonly<{
  conversationKey: string;
  authorization?: ClientOutputPolicyAuthorization;
}>;

const CHEROKEE_CODE_POINT = /^\p{Script=Cherokee}$/u;

/**
 * Builds a deterministic, locale-independent Unicode default caseless key.
 * Mapping one code point at a time avoids context-sensitive final-sigma
 * lowercasing. Default folding preserves dotless i and uses uppercase Cherokee.
 */
function clientOutputCaselessKey(value: string): string {
  return Array.from(value, (codePoint) => {
    if (codePoint === 'ı') return codePoint;
    if (CHEROKEE_CODE_POINT.test(codePoint)) return codePoint.toUpperCase();
    return codePoint.toUpperCase().toLowerCase();
  })
    .join('')
    .replace(/ß/gu, 'ss')
    .normalize('NFC');
}

export function normalizeClientOutputTermForComparison(
  value: string,
  caseSensitive: boolean,
): string {
  const normalized = value.normalize('NFC');
  return caseSensitive ? normalized : clientOutputCaselessKey(normalized);
}

export function countUnicodeCodePoints(value: string): number {
  let count = 0;
  for (const _codePoint of value) count += 1;
  return count;
}
