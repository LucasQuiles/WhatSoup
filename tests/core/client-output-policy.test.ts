import { describe, expect, it } from 'vitest';
import {
  evaluateClientOutputPolicy,
  type ClientOutputDecision,
  type ClientOutputPolicy,
  type ClientOutputPolicyInput,
  type ClientOutputViolationCode,
} from '../../src/core/client-output-policy.ts';

const SYNTHETIC_JID = [`${'15551234567'}`, 's.whatsapp.net'].join('@');
const SYNTHETIC_GROUP_JID = ['12345', 'g.us'].join('@');
const SYNTHETIC_LID_JID = ['12345', 'lid'].join('@');
const SAFE_INPUT: ClientOutputPolicyInput = {
  sourceText: 'A warm, ordinary draft.',
  finalText: 'A warm, ordinary reply.',
};

function policy(overrides: Partial<ClientOutputPolicy> = {}): ClientOutputPolicy {
  return {
    maxCodePoints: 500,
    maxQuestionMarks: 10,
    blockedTerms: [],
    rejectInternalArtifacts: false,
    rejectWhatsAppJids: false,
    ...overrides,
  };
}

function violationCodes(
  activePolicy: ClientOutputPolicy,
  input: ClientOutputPolicyInput,
): readonly ClientOutputViolationCode[] {
  const decision: ClientOutputDecision = evaluateClientOutputPolicy(activePolicy, input);
  expect(decision.action).toBe('reject');
  if (decision.action !== 'reject') throw new Error('expected client-output rejection');
  return decision.violationCodes;
}

describe('evaluateClientOutputPolicy', () => {
  it('counts Unicode code points rather than UTF-16 code units and allows the exact bound', () => {
    const input = { ...SAFE_INPUT, finalText: '😀a' };

    expect(evaluateClientOutputPolicy(policy({ maxCodePoints: 2 }), input)).toEqual({
      action: 'allow',
    });
    expect(violationCodes(policy({ maxCodePoints: 1 }), input)).toEqual([
      'max_code_points',
    ]);
  });

  it('counts ASCII, fullwidth, and Arabic question marks and allows the exact bound', () => {
    const input = { ...SAFE_INPUT, finalText: 'Ready? 準備？ جاهز؟' };

    expect(evaluateClientOutputPolicy(policy({ maxQuestionMarks: 3 }), input)).toEqual({
      action: 'allow',
    });
    expect(violationCodes(policy({ maxQuestionMarks: 2 }), input)).toEqual([
      'max_question_marks',
    ]);
  });

  it('uses literal NFC substring matching with explicit case sensitivity', () => {
    const decomposedLowercase = `Please send the résumé.`;
    const insensitive = policy({
      blockedTerms: [{ value: 'Résumé', match: 'substring', caseSensitive: false }],
    });
    const sensitive = policy({
      blockedTerms: [{ value: 'Résumé', match: 'substring', caseSensitive: true }],
    });

    expect(violationCodes(insensitive, { ...SAFE_INPUT, finalText: decomposedLowercase }))
      .toEqual(['blocked_term']);
    expect(evaluateClientOutputPolicy(sensitive, {
      ...SAFE_INPUT,
      finalText: decomposedLowercase,
    })).toEqual({ action: 'allow' });
    expect(violationCodes(sensitive, {
      ...SAFE_INPUT,
      finalText: 'Please send the Résumé.',
    })).toEqual(['blocked_term']);
  });

  it.each([
    ['Greek sigma and a word-final final sigma', 'οσ', 'Token: ος.'],
    ['Latin long-s', 'safe', 'ſafe'],
    ['sharp-s expansion', 'STRASSE', 'Straße'],
    ['capital sharp-s expansion', 'STRASSE', 'STRAẞE'],
    ['Latin presentation ligature expansion', 'office', 'oﬃce'],
    ['micro-sign compatibility mapping', 'μ', 'µ'],
    ['Greek iota-subscript expansion', 'ἀι', 'ᾀ'],
    ['Cherokee caseless stability', 'Ꭰ', 'ꭰ'],
  ])(
    'uses the locale-independent Unicode default caseless key for %s',
    (_case, blockedValue, finalText) => {
      const insensitive = policy({
        blockedTerms: [{ value: blockedValue, match: 'substring', caseSensitive: false }],
      });
      const sensitive = policy({
        blockedTerms: [{ value: blockedValue, match: 'substring', caseSensitive: true }],
      });

      expect(violationCodes(insensitive, { ...SAFE_INPUT, finalText }))
        .toEqual(['blocked_term']);
      expect(evaluateClientOutputPolicy(sensitive, { ...SAFE_INPUT, finalText }))
        .toEqual({ action: 'allow' });
    },
  );

  it('does not apply Turkic folding to locale-independent matching', () => {
    const insensitive = policy({
      blockedTerms: [{ value: 'i', match: 'substring', caseSensitive: false }],
    });

    expect(evaluateClientOutputPolicy(insensitive, { ...SAFE_INPUT, finalText: 'ı' }))
      .toEqual({ action: 'allow' });
  });

  it('uses Unicode letters, numbers, marks, and connector punctuation as whole-word characters', () => {
    const wholeWord = policy({
      blockedTerms: [{ value: 'hold', match: 'whole_word', caseSensitive: false }],
    });
    const safeAdjacentForms = [
      'éhold',
      'hold9',
      `hold⃝`,
      '_hold',
      'household',
      'holdover',
    ];

    for (const finalText of safeAdjacentForms) {
      expect(evaluateClientOutputPolicy(wholeWord, { ...SAFE_INPUT, finalText }))
        .toEqual({ action: 'allow' });
    }
    expect(violationCodes(wholeWord, { ...SAFE_INPUT, finalText: '「hold」!' }))
      .toEqual(['blocked_term']);
  });

  it('applies the same Unicode whole-word boundary to non-Latin letters', () => {
    const wholeWord = policy({
      blockedTerms: [{ value: '猫', match: 'whole_word', caseSensitive: true }],
    });

    expect(evaluateClientOutputPolicy(wholeWord, { ...SAFE_INPUT, finalText: '黒猫' }))
      .toEqual({ action: 'allow' });
    expect(violationCodes(wholeWord, { ...SAFE_INPUT, finalText: '「猫」' }))
      .toEqual(['blocked_term']);
  });

  it('rejects an internal source artifact even when final text has already been redacted', () => {
    const input = {
      sourceText: 'The draft referenced agent-sandbox.sh.',
      finalText: 'I hit a temporary issue and will follow up.',
    };

    expect(violationCodes(policy({ rejectInternalArtifacts: true }), input))
      .toEqual(['internal_artifact']);
  });

  it('detects a WhatsApp JID in final text independently of source text', () => {
    const activePolicy = policy({ rejectWhatsAppJids: true });

    expect(violationCodes(activePolicy, {
      sourceText: 'The source is ordinary.',
      finalText: `Internal address: ${SYNTHETIC_JID}`,
    })).toEqual(['whatsapp_jid']);
    expect(evaluateClientOutputPolicy(activePolicy, {
      sourceText: `A source-only reference to ${SYNTHETIC_JID}`,
      finalText: 'The final reply contains no address.',
    })).toEqual({ action: 'allow' });
  });

  it.each([
    ['LID JID in parentheses', `(${SYNTHETIC_LID_JID})`],
  ])('rejects a visible %s', (_case, finalText) => {
    expect(violationCodes(
      policy({ rejectWhatsAppJids: true }),
      { ...SAFE_INPUT, finalText },
    )).toEqual(['whatsapp_jid']);
  });

  it.each([
    ['LID-like prefix of a benign domain', `${SYNTHETIC_LID_JID}l.com`],
    ['group-like prefix of a benign domain', `${SYNTHETIC_GROUP_JID}age.example`],
    ['personal-like prefix of a benign domain', `${SYNTHETIC_JID}work`],
  ])('allows a %s', (_case, finalText) => {
    expect(evaluateClientOutputPolicy(
      policy({ rejectWhatsAppJids: true }),
      { ...SAFE_INPUT, finalText },
    )).toEqual({ action: 'allow' });
  });

  it('returns every violation once in stable contract order', () => {
    const activePolicy = policy({
      maxCodePoints: 1,
      maxQuestionMarks: 0,
      blockedTerms: [
        { value: 'blocked', match: 'substring', caseSensitive: false },
        { value: 'BLOCKED', match: 'substring', caseSensitive: true },
      ],
      rejectInternalArtifacts: true,
      rejectWhatsAppJids: true,
    });

    expect(violationCodes(activePolicy, {
      sourceText: 'The source referenced agent-sandbox.sh.',
      finalText: `BLOCKED? ？ ؟ ${SYNTHETIC_JID}`,
    })).toEqual([
      'max_code_points',
      'max_question_marks',
      'blocked_term',
      'internal_artifact',
      'whatsapp_jid',
    ]);
  });

  it('returns closed, frozen decisions without echoing source or final content', () => {
    const sourceText = 'private-source agent-sandbox.sh';
    const finalText = `private-final ${SYNTHETIC_JID}`;
    const allowed = evaluateClientOutputPolicy(policy(), SAFE_INPUT);
    const rejected = evaluateClientOutputPolicy(policy({
      rejectInternalArtifacts: true,
      rejectWhatsAppJids: true,
    }), { sourceText, finalText });

    expect(Object.keys(allowed)).toEqual(['action']);
    expect(Object.isFrozen(allowed)).toBe(true);
    expect(Object.keys(rejected).sort()).toEqual([
      'action',
      'reason',
      'satisfiesReplyGuarantee',
      'violationCodes',
    ]);
    expect(Object.isFrozen(rejected)).toBe(true);
    if (rejected.action !== 'reject') throw new Error('expected client-output rejection');
    expect(Object.isFrozen(rejected.violationCodes)).toBe(true);
    expect(JSON.stringify(rejected)).not.toContain(sourceText);
    expect(JSON.stringify(rejected)).not.toContain(finalText);
    expect(rejected).toMatchObject({
      action: 'reject',
      reason: 'client_output_policy',
      satisfiesReplyGuarantee: false,
    });
  });

  const ruleMutationControls: readonly {
    name: string;
    positivePolicy: ClientOutputPolicy;
    positiveInput: ClientOutputPolicyInput;
    expectedCode: ClientOutputViolationCode;
    negativePolicy: ClientOutputPolicy;
    negativeInput: ClientOutputPolicyInput;
  }[] = [
    {
      name: 'max code points',
      positivePolicy: policy({ maxCodePoints: 1 }),
      positiveInput: { ...SAFE_INPUT, finalText: 'ab' },
      expectedCode: 'max_code_points',
      negativePolicy: policy({ maxCodePoints: 2 }),
      negativeInput: { ...SAFE_INPUT, finalText: 'ab' },
    },
    {
      name: 'max question marks',
      positivePolicy: policy({ maxQuestionMarks: 0 }),
      positiveInput: { ...SAFE_INPUT, finalText: '?' },
      expectedCode: 'max_question_marks',
      negativePolicy: policy({ maxQuestionMarks: 1 }),
      negativeInput: { ...SAFE_INPUT, finalText: '?' },
    },
    {
      name: 'blocked term',
      positivePolicy: policy({
        blockedTerms: [{ value: 'hold', match: 'substring', caseSensitive: true }],
      }),
      positiveInput: { ...SAFE_INPUT, finalText: 'hold' },
      expectedCode: 'blocked_term',
      negativePolicy: policy({
        blockedTerms: [{ value: 'hold', match: 'substring', caseSensitive: true }],
      }),
      negativeInput: { ...SAFE_INPUT, finalText: 'held' },
    },
    {
      name: 'internal artifact',
      positivePolicy: policy({ rejectInternalArtifacts: true }),
      positiveInput: { ...SAFE_INPUT, sourceText: 'agent-sandbox.sh' },
      expectedCode: 'internal_artifact',
      negativePolicy: policy({ rejectInternalArtifacts: true }),
      negativeInput: { ...SAFE_INPUT, sourceText: 'agent-sandboz.sh' },
    },
    {
      name: 'WhatsApp JID',
      positivePolicy: policy({ rejectWhatsAppJids: true }),
      positiveInput: { ...SAFE_INPUT, finalText: SYNTHETIC_JID },
      expectedCode: 'whatsapp_jid',
      negativePolicy: policy({ rejectWhatsAppJids: true }),
      negativeInput: {
        ...SAFE_INPUT,
        finalText: `${SYNTHETIC_JID}work`,
      },
    },
  ];

  it.each(ruleMutationControls)(
    '$name has a positive case and a minimally changed negative control',
    ({ positivePolicy, positiveInput, expectedCode, negativePolicy, negativeInput }) => {
      expect(violationCodes(positivePolicy, positiveInput)).toEqual([expectedCode]);
      expect(evaluateClientOutputPolicy(negativePolicy, negativeInput)).toEqual({
        action: 'allow',
      });
    },
  );
});
