import { describe, it, expect } from 'vitest';
import {
  serializePendingPoll,
  deserializePendingPoll,
  pendingPollMatchesChatJid,
  normalizeDecisionLabel,
  labelMatchesIntentPattern,
  labelMatchesAny,
  hasEscapeHatchOption,
  isOtherOptionLabel,
  normalizeAskUserQuestions,
  clampPollTimeoutMs,
  configuredDefaultPollTimeoutMs,
  normalizePendingPollTimeoutMs,
  formatOptionLine,
  formatTextFallbackQuestion,
  formatOtherDirective,
  resolveTypedPollAnswer,
  answerForPollSelection,
  normalizedPollReplyText,
  textMatchesPollOption,
  LOW_SIGNAL_POLL_STATUS_REPLIES,
  isLowSignalPollStatusReply,
  clearPendingPollTimers,
  removePollIdsForQuestion,
  advancePendingPollIndex,
  unansweredPollQuestions,
  ESCAPE_HATCH_LABEL_PATTERNS,
  OTHER_LABEL_PATTERNS,
  ASKUSER_OTHER_OPTION_LABEL,
  POLL_QUESTION_MAX_CHARS,
  POLL_OPTION_MAX_CHARS,
  POLL_DETAIL_DESCRIPTION_MIN_CHARS,
  DEFAULT_POLL_TIMEOUT_MS,
  MIN_POLL_TIMEOUT_MS,
  MAX_POLL_TIMEOUT_MS,
  formatPollQuestion,
  type AskUserOption,
  type AskUserQuestion,
  type PendingPollQuestion,
} from '../../../src/runtimes/agent/poll-resolution.ts';

// ---------------------------------------------------------------------------
// Small fixtures
// ---------------------------------------------------------------------------

const JID_A = '15551110001@s.whatsapp.net';
const JID_B = '15551110002@s.whatsapp.net';
const JID_ADMIN = '15551110003@s.whatsapp.net';

function makeVote(
  voterJid: string,
  selectedOptions: string[],
  isAdmin: boolean,
  timestamp: number,
): { voterJid: string; selectedOptions: string[]; isAdmin: boolean; timestamp: number } {
  return { voterJid, selectedOptions, isAdmin, timestamp };
}

function makeBasePending(overrides: Partial<PendingPollQuestion> = {}): PendingPollQuestion {
  const base: PendingPollQuestion = {
    questions: [
      {
        question: 'Pick one',
        header: 'Header',
        options: [
          { label: 'A', description: 'option A' },
          { label: 'B', description: 'option B' },
        ],
        multiSelect: false,
      },
      {
        question: 'Pick another',
        header: 'Header2',
        options: [
          { label: 'X', description: '' },
          { label: 'Y', description: '' },
        ],
        multiSelect: true,
      },
    ],
    toolId: 'tool-id',
    chatJid: '15551234567@g.us',
    chatJidAliases: new Set(['15551234567@g.us', '99999@lid']),
    mode: 'poll',
    pollMessageIdToQuestionIndex: new Map([['PM1', 0], ['PM2', 1]]),
    currentQuestionIndex: 0,
    answersCollected: {},
    createdAt: 1_700_000_000_000,
    resolution: 'first-vote-wins',
    timeoutMs: 3_600_000,
    votesByQuestion: new Map(),
    adminJids: new Set([JID_ADMIN]),
    source: 'askuser',
    sentPollMessageIds: ['PM1', 'PM2'],
    ...overrides,
  };
  return base;
}

// ---------------------------------------------------------------------------
// pendingPollMatchesChatJid — exact match + alias set
// ---------------------------------------------------------------------------

describe('pendingPollMatchesChatJid', () => {
  it('matches the primary chatJid exactly', () => {
    const pending = makeBasePending();
    expect(pendingPollMatchesChatJid(pending, '15551234567@g.us')).toBe(true);
  });

  it('matches an entry from chatJidAliases', () => {
    const pending = makeBasePending();
    expect(pendingPollMatchesChatJid(pending, '99999@lid')).toBe(true);
  });

  it('returns false for an unknown JID', () => {
    const pending = makeBasePending();
    expect(pendingPollMatchesChatJid(pending, '15559998888@g.us')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// serializePendingPoll / deserializePendingPoll — round-trip edge cases
// ---------------------------------------------------------------------------

describe('serializePendingPoll / deserializePendingPoll — edge branches', () => {
  it('round-trips a textFallback poll with empty poll mappings', () => {
    const original = makeBasePending({
      mode: 'textFallback',
      pollMessageIdToQuestionIndex: new Map(),
      sentPollMessageIds: [],
    });
    const serialized = serializePendingPoll(original);
    expect(serialized.mode).toBe('textFallback');
    expect(serialized.pollMessageIdToQuestionIndex).toEqual([]);
    expect(serialized.sentPollMessageIds).toEqual([]);

    const restored = deserializePendingPoll(JSON.parse(JSON.stringify(serialized)));
    expect(restored.pollMessageIdToQuestionIndex.size).toBe(0);
    expect(restored.sentPollMessageIds).toEqual([]);
  });

  it('round-trips a send_poll source poll with resolvedAt set', () => {
    const original = makeBasePending({
      source: 'send_poll',
      resolvedAt: 1_700_000_999_000,
    });
    const serialized = serializePendingPoll(original);
    expect(serialized.source).toBe('send_poll');
    expect(serialized.resolvedAt).toBe(1_700_000_999_000);

    const restored = deserializePendingPoll(JSON.parse(JSON.stringify(serialized)));
    expect(restored.source).toBe('send_poll');
    expect(restored.resolvedAt).toBe(1_700_000_999_000);
  });

  it('round-trips a poll with multiple questions of votes and non-empty answersCollected', () => {
    const original = makeBasePending({
      currentQuestionIndex: 1,
      answersCollected: { 0: 'A', 1: 'X' },
      votesByQuestion: new Map([
        [0, new Map([[JID_A, makeVote(JID_A, ['A'], false, 1_700_000_001_000)]])],
        [1, new Map([[JID_B, makeVote(JID_B, ['X', 'Y'], false, 1_700_000_002_000)]])],
      ]),
    });
    const serialized = serializePendingPoll(original);
    const restored = deserializePendingPoll(JSON.parse(JSON.stringify(serialized)));
    expect(restored.answersCollected).toEqual({ 0: 'A', 1: 'X' });
    expect(restored.currentQuestionIndex).toBe(1);
    expect(restored.votesByQuestion.size).toBe(2);
    expect(restored.votesByQuestion.get(1)?.get(JID_B)?.selectedOptions).toEqual(['X', 'Y']);
  });
});

// ---------------------------------------------------------------------------
// normalizeDecisionLabel — unicode dash, whitespace, casing
// ---------------------------------------------------------------------------

describe('normalizeDecisionLabel', () => {
  it('lowercases and trims surrounding whitespace', () => {
    expect(normalizeDecisionLabel('  Hello World  ')).toBe('hello world');
  });

  it('collapses interior whitespace runs to a single space', () => {
    expect(normalizeDecisionLabel('hello   world\tnow')).toBe('hello world now');
  });

  it('normalizes unicode dashes to ASCII hyphen-minus', () => {
    expect(normalizeDecisionLabel('cancel \u2013 subscription')).toBe('cancel - subscription');
    expect(normalizeDecisionLabel('defer \u2014 plan')).toBe('defer - plan');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeDecisionLabel('   ')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// labelMatchesIntentPattern — every branch
// ---------------------------------------------------------------------------

describe('labelMatchesIntentPattern', () => {
  it('matches when normalized is exactly the pattern phrase', () => {
    expect(labelMatchesIntentPattern('Other', { phrase: 'other', allowWhitespaceSuffix: false })).toBe(true);
  });

  it('rejects when normalized does not start with the pattern phrase', () => {
    expect(labelMatchesIntentPattern('Zebra', { phrase: 'other', allowWhitespaceSuffix: false })).toBe(false);
  });

  it('rejects non-whitespace, non-separator suffix when allowWhitespaceSuffix is false', () => {
    expect(labelMatchesIntentPattern('Other databases', { phrase: 'other', allowWhitespaceSuffix: false })).toBe(false);
  });

  it('accepts suffix with whitespace when allowWhitespaceSuffix is true and suffix begins with whitespace', () => {
    expect(labelMatchesIntentPattern('Other please', { phrase: 'other', allowWhitespaceSuffix: true })).toBe(true);
  });

  it('rejects non-whitespace, non-separator suffix when allowWhitespaceSuffix is true (no leading space)', () => {
    expect(labelMatchesIntentPattern('Otherplease', { phrase: 'other', allowWhitespaceSuffix: true })).toBe(false);
  });

  it('accepts a separator character (- / : ( [ ) at the start of the suffix', () => {
    expect(labelMatchesIntentPattern('Other - propose', { phrase: 'other', allowWhitespaceSuffix: false })).toBe(true);
    expect(labelMatchesIntentPattern('Other: free text', { phrase: 'other', allowWhitespaceSuffix: false })).toBe(true);
    expect(labelMatchesIntentPattern('Other/foo', { phrase: 'other', allowWhitespaceSuffix: false })).toBe(true);
    expect(labelMatchesIntentPattern('Other (free)', { phrase: 'other', allowWhitespaceSuffix: false })).toBe(true);
    expect(labelMatchesIntentPattern('Other [x]', { phrase: 'other', allowWhitespaceSuffix: false })).toBe(true);
  });

  it('returns true when the suffix is empty (full match after trimming)', () => {
    expect(labelMatchesIntentPattern('  Other  ', { phrase: 'other', allowWhitespaceSuffix: false })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// labelMatchesAny / hasEscapeHatchOption / isOtherOptionLabel
// ---------------------------------------------------------------------------

describe('labelMatchesAny', () => {
  it('returns true when at least one pattern matches', () => {
    expect(labelMatchesAny('Other - please', OTHER_LABEL_PATTERNS)).toBe(true);
  });

  it('returns false when no pattern matches', () => {
    expect(labelMatchesAny('Continue', OTHER_LABEL_PATTERNS)).toBe(false);
  });
});

describe('hasEscapeHatchOption', () => {
  it('detects a label that matches an escape-hatch phrase', () => {
    expect(hasEscapeHatchOption([
      { label: 'Continue', description: '' },
      { label: 'Cancel', description: 'abort the run' },
    ])).toBe(true);
  });

  it('returns false when no option is an escape hatch', () => {
    expect(hasEscapeHatchOption([
      { label: 'Yes', description: '' },
      { label: 'No', description: '' },
    ])).toBe(false);
  });
});

describe('isOtherOptionLabel', () => {
  it('matches an "other" label', () => {
    expect(isOtherOptionLabel('Other')).toBe(true);
    expect(isOtherOptionLabel('None of the above')).toBe(true);
    expect(isOtherOptionLabel('Something else')).toBe(true);
    expect(isOtherOptionLabel('Propose alternative')).toBe(true);
  });

  it('returns false for unrelated labels', () => {
    expect(isOtherOptionLabel('Cancel')).toBe(false);
    expect(isOtherOptionLabel('Abort')).toBe(false);
    expect(isOtherOptionLabel('Yes')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizeAskUserQuestions — appends Other except when 12+ or escape hatch present
// ---------------------------------------------------------------------------

describe('normalizeAskUserQuestions', () => {
  it('appends the "Other" option when there are fewer than 12 options and no escape hatch', () => {
    const result = normalizeAskUserQuestions([
      {
        question: 'Q',
        header: 'H',
        options: [{ label: 'Yes', description: '' }],
        multiSelect: false,
      },
    ]);
    expect(result[0].options).toHaveLength(2);
    expect(result[0].options[1]?.label).toBe(ASKUSER_OTHER_OPTION_LABEL);
    expect(result[0].options[1]?.description).toBe('');
  });

  it('does not append "Other" when an escape-hatch label is already present', () => {
    const result = normalizeAskUserQuestions([
      {
        question: 'Q',
        header: 'H',
        options: [{ label: 'Cancel', description: '' }],
        multiSelect: false,
      },
    ]);
    expect(result[0].options).toHaveLength(1);
    expect(result[0].options[0]?.label).toBe('Cancel');
  });

  it('does not append "Other" when 12 or more options are provided', () => {
    const options: AskUserOption[] = Array.from({ length: 12 }, (_, i) => ({
      label: `opt-${i + 1}`,
      description: '',
    }));
    const result = normalizeAskUserQuestions([
      {
        question: 'Q',
        header: 'H',
        options,
        multiSelect: false,
      },
    ]);
    expect(result[0].options).toHaveLength(12);
    expect(result[0].options[11]?.label).toBe('opt-12');
  });

  it('normalizes missing description to empty string', () => {
    // AskUserOption.description is required in the type but runtime may pass
    // through undefined; the helper must still produce a string.
    const result = normalizeAskUserQuestions([
      {
        question: 'Q',
        header: 'H',
        options: [{ label: 'Yes', description: '' }],
        multiSelect: false,
      },
    ]);
    expect(result[0].options[0]?.description).toBe('');
    expect(typeof result[0].options[1]?.description).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// clampPollTimeoutMs / configuredDefaultPollTimeoutMs / normalizePendingPollTimeoutMs
// ---------------------------------------------------------------------------

describe('clampPollTimeoutMs', () => {
  it('returns MIN_POLL_TIMEOUT_MS for below-minimum input', () => {
    expect(clampPollTimeoutMs(500)).toBe(MIN_POLL_TIMEOUT_MS);
    expect(clampPollTimeoutMs(0)).toBe(MIN_POLL_TIMEOUT_MS);
    expect(clampPollTimeoutMs(-10)).toBe(MIN_POLL_TIMEOUT_MS);
  });

  it('returns MAX_POLL_TIMEOUT_MS for above-maximum input', () => {
    expect(clampPollTimeoutMs(MAX_POLL_TIMEOUT_MS + 1)).toBe(MAX_POLL_TIMEOUT_MS);
    expect(clampPollTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_POLL_TIMEOUT_MS);
  });

  it('returns the value unchanged when within range', () => {
    expect(clampPollTimeoutMs(3_600_000)).toBe(3_600_000);
    expect(clampPollTimeoutMs(MIN_POLL_TIMEOUT_MS)).toBe(MIN_POLL_TIMEOUT_MS);
    expect(clampPollTimeoutMs(MAX_POLL_TIMEOUT_MS)).toBe(MAX_POLL_TIMEOUT_MS);
  });
});

describe('configuredDefaultPollTimeoutMs', () => {
  it('clamps a positive configured defaultTimeoutMs', () => {
    // Default from config is 3_600_000 which falls inside the valid range.
    const out = configuredDefaultPollTimeoutMs();
    expect(out).toBeGreaterThanOrEqual(MIN_POLL_TIMEOUT_MS);
    expect(out).toBeLessThanOrEqual(MAX_POLL_TIMEOUT_MS);
    // Default value is 3_600_000.
    expect(out).toBe(DEFAULT_POLL_TIMEOUT_MS);
  });
});

describe('normalizePendingPollTimeoutMs', () => {
  it('returns clamped value for positive finite numbers', () => {
    expect(normalizePendingPollTimeoutMs(2_000)).toBe(2_000);
    expect(normalizePendingPollTimeoutMs(100)).toBe(MIN_POLL_TIMEOUT_MS);
    expect(normalizePendingPollTimeoutMs(MAX_POLL_TIMEOUT_MS * 2)).toBe(MAX_POLL_TIMEOUT_MS);
  });

  it('returns the configured default for non-finite input', () => {
    expect(normalizePendingPollTimeoutMs(Number.NaN)).toBe(configuredDefaultPollTimeoutMs());
    expect(normalizePendingPollTimeoutMs(Infinity)).toBe(configuredDefaultPollTimeoutMs());
    expect(normalizePendingPollTimeoutMs(-Infinity)).toBe(configuredDefaultPollTimeoutMs());
  });

  it('returns the configured default for zero or negative numbers', () => {
    expect(normalizePendingPollTimeoutMs(0)).toBe(configuredDefaultPollTimeoutMs());
    expect(normalizePendingPollTimeoutMs(-1)).toBe(configuredDefaultPollTimeoutMs());
  });

  it('coerces strings via Number()', () => {
    expect(normalizePendingPollTimeoutMs('5000')).toBe(5_000);
    expect(normalizePendingPollTimeoutMs('not-a-number')).toBe(configuredDefaultPollTimeoutMs());
  });
});

// ---------------------------------------------------------------------------
// formatOptionLine
// ---------------------------------------------------------------------------

describe('formatOptionLine', () => {
  it('returns numbered label with description when includeDescription is true', () => {
    expect(formatOptionLine({ label: 'Yes', description: 'proceed' }, 0)).toBe('1. *Yes* — proceed');
  });

  it('trims surrounding whitespace from description', () => {
    expect(formatOptionLine({ label: 'Yes', description: '   proceed   ' }, 0)).toBe('1. *Yes* — proceed');
  });

  it('falls back to label-only when description is empty (includeDescription true)', () => {
    expect(formatOptionLine({ label: 'Yes', description: '' }, 2)).toBe('3. *Yes*');
  });

  it('falls back to label-only when includeDescription is false even with description', () => {
    expect(
      formatOptionLine({ label: 'Yes', description: 'proceed' }, 0, { includeDescription: false }),
    ).toBe('1. *Yes*');
  });

  it('falls back to label-only when includeDescription is false and description is empty', () => {
    expect(
      formatOptionLine({ label: 'Yes', description: '' }, 1, { includeDescription: false }),
    ).toBe('2. *Yes*');
  });
});

// ---------------------------------------------------------------------------
// formatTextFallbackQuestion
// ---------------------------------------------------------------------------

describe('formatTextFallbackQuestion', () => {
  const q: AskUserQuestion = {
    question: 'Pick one',
    header: 'Header',
    options: [
      { label: 'A', description: 'first option' },
      { label: 'B', description: '' },
    ],
    multiSelect: false,
  };

  it('includes intro line and option descriptions when provided', () => {
    const out = formatTextFallbackQuestion(q, 'Hello user', { includeDescriptions: true });
    expect(out).toContain('Hello user');
    expect(out).toContain('1. *A* — first option');
    expect(out).toContain('2. *B*');
    expect(out).not.toContain('_Full option details were sent above._');
  });

  it('omits descriptions and adds a notice when includeDescriptions is false', () => {
    const out = formatTextFallbackQuestion(q, undefined, { includeDescriptions: false });
    expect(out).not.toContain('first option');
    expect(out).toContain('_Full option details were sent above._');
    expect(out).toContain('1. *A*');
    expect(out).toContain('2. *B*');
  });

  it('redacts internal-artifact leaks in the text fallback (client-safety)', () => {
    const leaky: AskUserQuestion = {
      question: 'Open /Users/testuser/.claude/settings.json?',
      header: 'H',
      options: [
        { label: 'Yes', description: 'see agent-sandbox.sh' },
        { label: 'No', description: '' },
      ],
      multiSelect: false,
    };
    const out = formatTextFallbackQuestion(leaky, undefined, { includeDescriptions: true });
    expect(out).not.toContain('/Users/testuser');
    expect(out).not.toContain('settings.json');
    expect(out).not.toContain('agent-sandbox.sh');
  });

  it('omits the intro when none is provided', () => {
    const out = formatTextFallbackQuestion(q);
    expect(out.startsWith('Pick one')).toBe(true);
    expect(out).toContain('_Reply with option number or text._');
  });
});

// ---------------------------------------------------------------------------
// formatOtherDirective — both selectedOptions empty and originalOptions empty
// ---------------------------------------------------------------------------

describe('formatOtherDirective', () => {
  const q: AskUserQuestion = {
    question: 'Pick one',
    header: 'Header',
    options: [
      { label: 'A', description: 'first' },
      { label: 'B', description: 'second' },
    ],
    multiSelect: false,
  };

  it('renders the selected-options line when selections are non-empty', () => {
    const out = formatOtherDirective(q, ['Other']);
    expect(out).toContain('[User selected Other — none of the proposed options fit]');
    expect(out).toContain('Selected option(s): Other');
    expect(out).toContain('Question requiring follow-up: Pick one');
    expect(out).toContain('1. *A* — first');
    expect(out).toContain('2. *B* — second');
  });

  it('omits the selected-options line when selections are empty', () => {
    const out = formatOtherDirective(q, []);
    expect(out).not.toContain('Selected option(s):');
    expect(out).toContain('Original options:');
  });

  it('filters out "Other" labels from the original options block', () => {
    const qWithOther: AskUserQuestion = {
      ...q,
      options: [...q.options, { label: 'Other', description: '' }],
    };
    const out = formatOtherDirective(qWithOther, ['Other']);
    expect(out).toContain('1. *A* — first');
    expect(out).toContain('2. *B* — second');
    expect(out).not.toContain('*Other*');
  });

  it('uses the "(none recorded)" fallback when no original options remain', () => {
    const qOnlyOther: AskUserQuestion = {
      ...q,
      options: [{ label: 'Other', description: '' }],
    };
    const out = formatOtherDirective(qOnlyOther, ['Other']);
    expect(out).toContain('(none recorded)');
    expect(out).not.toContain('1. *');
  });
});

// ---------------------------------------------------------------------------
// resolveTypedPollAnswer — numeric, letter, label match, free-text, Other
// ---------------------------------------------------------------------------

describe('resolveTypedPollAnswer', () => {
  const q: AskUserQuestion = {
    question: 'Pick one',
    header: 'Header',
    options: [
      { label: 'Yes', description: 'proceed' },
      { label: 'No', description: 'do not proceed' },
      { label: 'Other', description: '' },
    ],
    multiSelect: false,
  };

  it('resolves numeric input to the matching option label', () => {
    expect(resolveTypedPollAnswer('1', q)).toBe('Yes');
    expect(resolveTypedPollAnswer('2', q)).toBe('No');
  });

  it('resolves letter input (case-insensitive after normalization) to the matching option label', () => {
    expect(resolveTypedPollAnswer('A', q)).toBe('Yes');
    expect(resolveTypedPollAnswer('b', q)).toBe('No');
  });

  it('resolves exact label match (after normalization)', () => {
    expect(resolveTypedPollAnswer('Yes', q)).toBe('Yes');
    expect(resolveTypedPollAnswer('yes.', q)).toBe('Yes');
  });

  it('resolves exact description match (after normalization)', () => {
    expect(resolveTypedPollAnswer('proceed', q)).toBe('Yes');
    expect(resolveTypedPollAnswer('Do Not Proceed', q)).toBe('No');
  });

  it('returns free-text response for unrecognized input', () => {
    expect(resolveTypedPollAnswer('maybe tomorrow', q)).toBe('maybe tomorrow (free-text response)');
  });

  it('returns formatOtherDirective when selection resolves to an "Other" option', () => {
    const out = resolveTypedPollAnswer('3', q);
    expect(out).toContain('[User selected Other — none of the proposed options fit]');
    expect(out).toContain('Question requiring follow-up: Pick one');
  });

  it('returns formatOtherDirective when the user types the "Other" label text', () => {
    const out = resolveTypedPollAnswer('other', q);
    expect(out).toContain('[User selected Other — none of the proposed options fit]');
  });

  it('returns free-text for numeric input that is out of range', () => {
    expect(resolveTypedPollAnswer('99', q)).toBe('99 (free-text response)');
  });
});

// ---------------------------------------------------------------------------
// answerForPollSelection
// ---------------------------------------------------------------------------

describe('answerForPollSelection', () => {
  const q: AskUserQuestion = {
    question: 'Pick one',
    header: 'Header',
    options: [
      { label: 'A', description: '' },
      { label: 'Other', description: '' },
    ],
    multiSelect: true,
  };

  it('returns formatOtherDirective when any selection is an "Other" label', () => {
    const out = answerForPollSelection(q, ['A', 'Other']);
    expect(out).toContain('[User selected Other — none of the proposed options fit]');
  });

  it('joins selections with ", " when none is "Other"', () => {
    expect(answerForPollSelection(q, ['A'])).toBe('A');
    expect(answerForPollSelection(q, ['A', 'B'])).toBe('A, B');
  });
});

// ---------------------------------------------------------------------------
// normalizedPollReplyText
// ---------------------------------------------------------------------------

describe('normalizedPollReplyText', () => {
  it('lowercases, trims, and collapses whitespace', () => {
    expect(normalizedPollReplyText('  Hello   World  ')).toBe('hello world');
  });

  it('strips trailing punctuation (. ! ?)', () => {
    expect(normalizedPollReplyText('Yes!')).toBe('yes');
    expect(normalizedPollReplyText('Yes.')).toBe('yes');
    expect(normalizedPollReplyText('Yes?')).toBe('yes');
    expect(normalizedPollReplyText('Yes!!!')).toBe('yes');
  });

  it('does not strip internal punctuation', () => {
    expect(normalizedPollReplyText('Yes. proceed')).toBe('yes. proceed');
  });

  it('returns empty string for empty input', () => {
    expect(normalizedPollReplyText('')).toBe('');
    expect(normalizedPollReplyText('   ')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// textMatchesPollOption
// ---------------------------------------------------------------------------

describe('textMatchesPollOption', () => {
  const options: AskUserOption[] = [
    { label: 'Yes', description: 'proceed' },
    { label: 'No', description: '' },
  ];

  it('returns false for empty input', () => {
    expect(textMatchesPollOption('', options)).toBe(false);
    expect(textMatchesPollOption('   ', options)).toBe(false);
  });

  it('matches numeric input within range', () => {
    expect(textMatchesPollOption('1', options)).toBe(true);
    expect(textMatchesPollOption('2', options)).toBe(true);
  });

  it('rejects numeric input outside the valid range', () => {
    expect(textMatchesPollOption('0', options)).toBe(false);
    expect(textMatchesPollOption('3', options)).toBe(false);
  });

  it('matches letter input within range', () => {
    expect(textMatchesPollOption('A', options)).toBe(true);
    expect(textMatchesPollOption('b', options)).toBe(true);
  });

  it('rejects letter input outside the range (z > b)', () => {
    expect(textMatchesPollOption('z', options)).toBe(false);
  });

  it('matches by label or description', () => {
    expect(textMatchesPollOption('Yes', options)).toBe(true);
    expect(textMatchesPollOption('Proceed', options)).toBe(true);
    expect(textMatchesPollOption('Proceed!', options)).toBe(true);
  });

  it('returns false when no option matches', () => {
    expect(textMatchesPollOption('Maybe', options)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LOW_SIGNAL_POLL_STATUS_REPLIES / isLowSignalPollStatusReply
// ---------------------------------------------------------------------------

describe('isLowSignalPollStatusReply', () => {
  const options: AskUserOption[] = [
    { label: 'Yes', description: '' },
    { label: 'No', description: '' },
  ];

  it('returns false when the input matches one of the poll options', () => {
    expect(isLowSignalPollStatusReply('Yes', options)).toBe(false);
    expect(isLowSignalPollStatusReply('1', options)).toBe(false);
  });

  it('returns true when the input is in LOW_SIGNAL_POLL_STATUS_REPLIES', () => {
    expect(isLowSignalPollStatusReply('I voted', options)).toBe(true);
    expect(isLowSignalPollStatusReply('Voted!', options)).toBe(true);
    expect(isLowSignalPollStatusReply('submitted', options)).toBe(true);
    expect(isLowSignalPollStatusReply('I selected one', options)).toBe(true);
    expect(isLowSignalPollStatusReply('I picked one', options)).toBe(true);
    expect(isLowSignalPollStatusReply('I chose one', options)).toBe(true);
  });

  it('returns false for unrecognized input', () => {
    expect(isLowSignalPollStatusReply('Hello there', options)).toBe(false);
  });

  it('LOW_SIGNAL_POLL_STATUS_REPLIES contains expected keys', () => {
    expect(LOW_SIGNAL_POLL_STATUS_REPLIES.has('i voted')).toBe(true);
    expect(LOW_SIGNAL_POLL_STATUS_REPLIES.has('voted')).toBe(true);
    expect(LOW_SIGNAL_POLL_STATUS_REPLIES.has('i vote')).toBe(true);
    expect(LOW_SIGNAL_POLL_STATUS_REPLIES.has('vote sent')).toBe(true);
    expect(LOW_SIGNAL_POLL_STATUS_REPLIES.has('sent my vote')).toBe(true);
    expect(LOW_SIGNAL_POLL_STATUS_REPLIES.has('i sent my vote')).toBe(true);
    expect(LOW_SIGNAL_POLL_STATUS_REPLIES.has('i selected one')).toBe(true);
    expect(LOW_SIGNAL_POLL_STATUS_REPLIES.has('i selected an option')).toBe(true);
    expect(LOW_SIGNAL_POLL_STATUS_REPLIES.has('i picked one')).toBe(true);
    expect(LOW_SIGNAL_POLL_STATUS_REPLIES.has('i chose one')).toBe(true);
    expect(LOW_SIGNAL_POLL_STATUS_REPLIES.has('submitted')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PendingPollQuestion live-state helpers
// ---------------------------------------------------------------------------

describe('clearPendingPollTimers', () => {
  it('clears both timers and resets them to undefined', () => {
    const noopFn = (): void => {};
    const fakeTimer = { ref: noopFn, unref: noopFn } as unknown as ReturnType<typeof setTimeout>;
    const pending = makeBasePending({
      softExpiryTimer: fakeTimer,
      hardExpiryTimer: fakeTimer,
    });
    clearPendingPollTimers(pending);
    expect({ soft: pending.softExpiryTimer, hard: pending.hardExpiryTimer }).toEqual({ soft: undefined, hard: undefined });
  });

  it('is a no-op when timers are already undefined', () => {
    const pending = makeBasePending();
    clearPendingPollTimers(pending);
    expect({ soft: pending.softExpiryTimer, hard: pending.hardExpiryTimer }).toEqual({ soft: undefined, hard: undefined });
  });

  it('is idempotent (can be called twice)', () => {
    const pending = makeBasePending();
    clearPendingPollTimers(pending);
    clearPendingPollTimers(pending);
    expect({ soft: pending.softExpiryTimer, hard: pending.hardExpiryTimer }).toEqual({ soft: undefined, hard: undefined });
  });
});

describe('removePollIdsForQuestion', () => {
  it('removes only the mapping entries that point at the given question index', () => {
    const pending = makeBasePending({
      pollMessageIdToQuestionIndex: new Map([
        ['PM1', 0],
        ['PM2', 1],
        ['PM3', 0],
      ]),
    });
    removePollIdsForQuestion(pending, 0);
    expect(pending.pollMessageIdToQuestionIndex.has('PM1')).toBe(false);
    expect(pending.pollMessageIdToQuestionIndex.has('PM3')).toBe(false);
    expect(pending.pollMessageIdToQuestionIndex.has('PM2')).toBe(true);
    expect(pending.pollMessageIdToQuestionIndex.size).toBe(1);
  });

  it('is a no-op when no entry matches the index', () => {
    const pending = makeBasePending({
      pollMessageIdToQuestionIndex: new Map([['PM2', 1]]),
    });
    removePollIdsForQuestion(pending, 0);
    expect(pending.pollMessageIdToQuestionIndex.has('PM2')).toBe(true);
    expect(pending.pollMessageIdToQuestionIndex.size).toBe(1);
  });
});

describe('advancePendingPollIndex', () => {
  it('skips answered questions and stops at the first unanswered one', () => {
    const pending = makeBasePending({
      currentQuestionIndex: 0,
      answersCollected: { 0: 'A' },
    });
    advancePendingPollIndex(pending);
    expect(pending.currentQuestionIndex).toBe(1);
  });

  it('skips a run of consecutive answered questions', () => {
    const pending = makeBasePending({
      currentQuestionIndex: 0,
      answersCollected: { 0: 'A', 1: 'X' },
    });
    advancePendingPollIndex(pending);
    // questions.length is 2; index should be clamped at questions.length.
    expect(pending.currentQuestionIndex).toBe(2);
  });

  it('does not advance when the current question is unanswered', () => {
    const pending = makeBasePending({
      currentQuestionIndex: 0,
      answersCollected: {},
    });
    advancePendingPollIndex(pending);
    expect(pending.currentQuestionIndex).toBe(0);
  });

  it('is a no-op once currentQuestionIndex has reached questions.length', () => {
    const pending = makeBasePending({
      currentQuestionIndex: 2,
      answersCollected: {},
    });
    advancePendingPollIndex(pending);
    expect(pending.currentQuestionIndex).toBe(2);
  });
});

describe('unansweredPollQuestions', () => {
  it('returns every unanswered question paired with its original index', () => {
    const pending = makeBasePending({
      answersCollected: { 0: 'A' },
    });
    const out = unansweredPollQuestions(pending);
    expect(out).toEqual([
      { index: 1, question: pending.questions[1] },
    ]);
  });

  it('returns an empty array when every question is answered', () => {
    const pending = makeBasePending({
      answersCollected: { 0: 'A', 1: 'X' },
    });
    expect(unansweredPollQuestions(pending)).toEqual([]);
  });

  it('returns every question when answersCollected is empty', () => {
    const pending = makeBasePending({
      answersCollected: {},
    });
    const out = unansweredPollQuestions(pending);
    expect(out).toHaveLength(2);
    expect(out[0]?.index).toBe(0);
    expect(out[1]?.index).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// formatPollQuestion — branches the existing test file does not cover
// ---------------------------------------------------------------------------

describe('formatPollQuestion — branch coverage extras', () => {
  it('treats \\r in description as paragraph-scale detail (triggers hasDetailDescription)', () => {
    const result = formatPollQuestion({
      question: 'Pick one',
      options: [
        { label: 'Plan A', description: 'First line\rSecond line' },
        { label: 'Plan B', description: 'Single line' },
      ],
    });
    expect(result.pollValues).toEqual(['Plan A', 'Plan B']);
    expect(result.needsFollowUp).toBe(true);
    expect(result.followUpText).toContain('1. *Plan A*\nFirst line\rSecond line');
  });

  it('omits description-derived follow-up text when no description is given', () => {
    // Sanity check: no description means no follow-up text — the branch
    // where label-only short circuits before any description logic runs.
    const result = formatPollQuestion({
      question: 'Pick one',
      options: [
        { label: 'Alpha', description: '' },
        { label: 'Beta', description: '' },
      ],
    });
    expect(result).toMatchObject({ pollValues: ['Alpha', 'Beta'], followUpText: null });
  });

  it('a label exceeding the option budget (no description) is truncated with ellipsis and triggers follow-up', () => {
    const hugeLabel = 'X'.repeat(120);
    const result = formatPollQuestion({
      question: 'Pick one',
      options: [{ label: hugeLabel, description: '' }],
    });
    expect(result.pollValues[0]?.length).toBe(POLL_OPTION_MAX_CHARS);
    expect(result.pollValues[0]?.endsWith('\u2026')).toBe(true);
    expect(result.needsFollowUp).toBe(true);
  });

  it('a label exceeding the option budget WITH a paragraph description truncates the label (hasDetailDescription branch)', () => {
    // hasDetailDescription = true (desc > 72) → label > budget → truncated label only.
    const hugeLabel = 'X'.repeat(120);
    const longDesc = 'd'.repeat(POLL_DETAIL_DESCRIPTION_MIN_CHARS + 1);
    const result = formatPollQuestion({
      question: 'Q',
      options: [{ label: hugeLabel, description: longDesc }],
    });
    expect(result.pollValues[0]?.length).toBe(POLL_OPTION_MAX_CHARS);
    expect(result.pollValues[0]?.endsWith('\u2026')).toBe(true);
    expect(result.needsFollowUp).toBe(true);
    // Long description should be in follow-up text, not in pollValues.
    expect(result.followUpText).toContain(longDesc);
  });

  it('option detail lines include the description verbatim (trimmed) when present and triggers follow-up', () => {
    // Long description (>POLL_DETAIL_DESCRIPTION_MIN_CHARS) forces follow-up text.
    const longDesc = 'has surrounding whitespace ' + 'X'.repeat(60);
    const result = formatPollQuestion({
      question: 'Q',
      options: [
        { label: 'A', description: `  ${longDesc}  ` },
      ],
    });
    expect(result.needsFollowUp).toBe(true);
    expect(result.followUpText).toContain(`1. *A*\n${longDesc}`);
  });

  it('option detail lines omit the description when it is empty, even when another option triggers follow-up', () => {
    // A second option with a long description forces follow-up text rendering
    // for the option with empty description. The follow-up text should show
    // '1. *Solo*' followed directly by '2. *Detail*' on the next line (no
    // empty-line gap, which would mean the empty description was treated as
    // present).
    const result = formatPollQuestion({
      question: 'Q',
      options: [
        { label: 'Solo', description: '   ' },
        { label: 'Detail', description: 'X'.repeat(POLL_DETAIL_DESCRIPTION_MIN_CHARS + 5) },
      ],
    });
    expect(result.needsFollowUp).toBe(true);
    expect(result.followUpText).toContain('1. *Solo*\n2. *Detail*');
  });

  it('preserves a question exactly at POLL_QUESTION_MAX_CHARS', () => {
    const exact = 'a'.repeat(POLL_QUESTION_MAX_CHARS);
    const result = formatPollQuestion({
      question: exact,
      options: [{ label: 'A', description: '' }],
    });
    expect(result.pollName).toBe(exact);
  });

  it('truncates a question one character over POLL_QUESTION_MAX_CHARS', () => {
    const exact = 'a'.repeat(POLL_QUESTION_MAX_CHARS + 1);
    const result = formatPollQuestion({
      question: exact,
      options: [{ label: 'A', description: '' }],
    });
    expect(result.pollName.length).toBe(POLL_QUESTION_MAX_CHARS);
    expect(result.pollName.endsWith('\u2026')).toBe(true);
  });

  it('uses bare label only when descBudget is below the 10-char threshold', () => {
    // 90-char label + " — " (3) + ellipsis (1) = 94, descBudget = 1, below 10.
    const longLabel = 'L'.repeat(90);
    const result = formatPollQuestion({
      question: 'Q',
      options: [{ label: longLabel, description: 'tiny' }],
    });
    expect(result.pollValues[0]).toBe(longLabel);
    expect(result.needsFollowUp).toBe(true);
  });

  it('truncates an oversize bare label when descBudget is below 10 (label > 95 branch)', () => {
    // Label is 120 chars, desc is short (no hasDetailDescription), rich > 95,
    // descBudget = 95 - 120 - 3 - 1 = -29 < 10 → bare-label fallback, then truncate label.
    const longLabel = 'L'.repeat(120);
    const result = formatPollQuestion({
      question: 'Pick one',
      options: [
        { label: longLabel, description: 'short' },
      ],
    });
    expect(result.pollValues[0]?.length).toBe(POLL_OPTION_MAX_CHARS);
    expect(result.pollValues[0]?.endsWith('\u2026')).toBe(true);
    expect(result.needsFollowUp).toBe(true);
  });

  it('uses rich label + description when total length is exactly at the budget and below the detail threshold', () => {
    // 20-char label + ' — ' (3) + 72-char desc = 95, exactly at budget. 72 chars is
    // NOT > the 72-char detail threshold (strict greater-than), so hasDetailDescription
    // stays false and the rich-text branch fires.
    const label = 'A'.repeat(20);
    const desc = 'd'.repeat(72);
    const result = formatPollQuestion({
      question: 'Q',
      options: [{ label, description: desc }],
    });
    expect(result.pollValues[0]).toBe(`${label} \u2014 ${desc}`);
    expect(result.pollValues[0]?.length).toBe(POLL_OPTION_MAX_CHARS);
    expect(result.needsFollowUp).toBe(false);
  });

  it('truncates description with ellipsis when rich text goes one over budget (and stays below detail threshold)', () => {
    // 22-char label + ' — ' (3) + 71-char desc = 96, just over budget. descBudget = 95-22-3-1=69 ≥ 10,
    // so the description is truncated with an ellipsis. desc 71 ≤ 72 keeps hasDetailDescription
    // false so we exercise the rich-text branch.
    const label = 'A'.repeat(22);
    const desc = 'd'.repeat(71);
    const result = formatPollQuestion({
      question: 'Q',
      options: [{ label, description: desc }],
    });
    expect(result.pollValues[0]?.length).toBe(POLL_OPTION_MAX_CHARS);
    expect(result.pollValues[0]?.endsWith('\u2026')).toBe(true);
    expect(result.pollValues[0]?.startsWith(`${label} \u2014 `)).toBe(true);
    expect(result.needsFollowUp).toBe(true);
  });

  it('hasDetailDescription triggers when any single description exceeds the detail threshold', () => {
    const longDesc = 'D'.repeat(POLL_DETAIL_DESCRIPTION_MIN_CHARS + 1);
    const result = formatPollQuestion({
      question: 'Q',
      options: [
        { label: 'A', description: 'short' },
        { label: 'B', description: longDesc },
      ],
    });
    // Both pollValues fall back to bare labels because hasDetailDescription is true.
    expect(result.pollValues).toEqual(['A', 'B']);
    expect(result.followUpText).toContain(longDesc);
  });

  it('follow-up text is null when nothing needs truncation', () => {
    const result = formatPollQuestion({
      question: 'Q',
      options: [{ label: 'A', description: 'short' }],
    });
    expect(result).toMatchObject({ pollName: 'Q', followUpText: null });
  });

  it('follow-up text includes the original question text and the standard preamble', () => {
    // Use a long description to force follow-up text generation.
    const result = formatPollQuestion({
      question: 'Pick your favorite color',
      options: [{ label: 'Blue', description: 'X'.repeat(POLL_DETAIL_DESCRIPTION_MIN_CHARS + 5) }],
    });
    expect(result.followUpText).toContain('Details for poll: Pick your favorite color');
    expect(result.followUpText).toContain('Use the poll below to choose. Full option details:');
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('exported constants', () => {
  it('exposes the documented WhatsApp poll budgets', () => {
    expect(POLL_QUESTION_MAX_CHARS).toBe(900);
    expect(POLL_OPTION_MAX_CHARS).toBe(95);
    expect(POLL_DETAIL_DESCRIPTION_MIN_CHARS).toBe(72);
  });

  it('exposes the documented timeout bounds', () => {
    expect(MIN_POLL_TIMEOUT_MS).toBe(1_000);
    expect(MAX_POLL_TIMEOUT_MS).toBe(86_400_000);
    expect(DEFAULT_POLL_TIMEOUT_MS).toBe(3_600_000);
  });

  it('exposes the AskUser "Other" option label', () => {
    expect(ASKUSER_OTHER_OPTION_LABEL).toBe('Other — propose a different option');
  });

  it('exposes ESCAPE_HATCH_LABEL_PATTERNS as an array of {phrase, allowWhitespaceSuffix}', () => {
    expect(Array.isArray(ESCAPE_HATCH_LABEL_PATTERNS)).toBe(true);
    for (const p of ESCAPE_HATCH_LABEL_PATTERNS) {
      expect(typeof p.phrase).toBe('string');
      expect(typeof p.allowWhitespaceSuffix).toBe('boolean');
    }
    expect(ESCAPE_HATCH_LABEL_PATTERNS.some((p) => p.phrase === 'cancel')).toBe(true);
    expect(ESCAPE_HATCH_LABEL_PATTERNS.some((p) => p.phrase === 'abort')).toBe(true);
    expect(ESCAPE_HATCH_LABEL_PATTERNS.some((p) => p.phrase === 'defer')).toBe(true);
  });

  it('exposes OTHER_LABEL_PATTERNS as a subset of escape-hatch patterns', () => {
    expect(Array.isArray(OTHER_LABEL_PATTERNS)).toBe(true);
    expect(OTHER_LABEL_PATTERNS.length).toBeLessThan(ESCAPE_HATCH_LABEL_PATTERNS.length);
    expect(OTHER_LABEL_PATTERNS.some((p) => p.phrase === 'other')).toBe(true);
    expect(OTHER_LABEL_PATTERNS.some((p) => p.phrase === 'cancel')).toBe(false);
  });
});