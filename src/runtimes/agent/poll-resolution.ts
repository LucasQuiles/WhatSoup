/**
 * poll-resolution.ts — AskUserQuestion → WhatsApp-poll formatting, pending-poll
 * (de)serialization, vote resolution, and decision-label / typed-answer helpers.
 *
 * Extracted verbatim from AgentRuntime's module scope as a module-level FILE-reduction
 * slice of the god-class decomposition (behavior unchanged — pure relocation). These are
 * stateless helpers; AgentRuntime imports what it needs and re-exports the public surface
 * (serializePendingPoll / deserializePendingPoll / evaluateResolution /
 * evaluateResolutionOnTimeout / formatPollQuestion + the poll types) so existing consumers
 * and the poll test suites are unchanged.
 */
import { config } from '../../config.ts';
import { redactInternalArtifacts } from '../../core/outbound-message-safety.ts';

// ---------------------------------------------------------------------------
// AskUserQuestion → Poll formatting
// ---------------------------------------------------------------------------

/** Conservative WhatsApp poll limits. */
export const POLL_QUESTION_MAX_CHARS = 900;
export const POLL_OPTION_MAX_CHARS = 95;  // leave margin under WhatsApp's ~100 char limit
export const POLL_DETAIL_DESCRIPTION_MIN_CHARS = 72;
export const DEFAULT_POLL_TIMEOUT_MS = 3_600_000;
export const MIN_POLL_TIMEOUT_MS = 1_000;
export const MAX_POLL_TIMEOUT_MS = 86_400_000;
export const ASKUSER_OTHER_OPTION_LABEL = 'Other — propose a different option';

export type AskUserOption = { label: string; description: string };
export type AskUserQuestion = {
  question: string;
  header: string;
  options: AskUserOption[];
  multiSelect: boolean;
};

export type ResolutionStrategy =
  | 'first-vote-wins'
  | 'admin-only'
  | 'admin-wins'
  | 'majority-after-timeout';

export interface PollVote {
  voterJid: string;
  selectedOptions: string[];
  isAdmin: boolean;
  timestamp: number;
}

export interface ResolutionResult {
  status: 'resolved' | 'pending' | 'ignored';
  answer?: string;
}

/**
 * Serialized form of PendingPollQuestion for SQLite persistence.
 * Drops timers (re-armed on rehydrate) and promise handles (cannot be restored
 * after restart — the original awaiter is gone). All other state is preserved.
 */
export interface SerializedPendingPoll {
  questions: AskUserQuestion[];
  toolId: string;
  chatJid: string;
  chatJidAliases: string[];
  mode: 'poll' | 'textFallback';
  pollMessageIdToQuestionIndex: Array<[string, number]>;
  currentQuestionIndex: number;
  answersCollected: Record<number, string>;
  createdAt: number;
  resolution: ResolutionStrategy;
  timeoutMs: number;
  votesByQuestion: Array<[number, Array<[string, PollVote]>]>;
  adminJids: string[] | null;
  resolvedAt?: number;
  source: 'askuser' | 'send_poll';
  sentPollMessageIds: string[];
}

export function serializePendingPoll(pending: PendingPollQuestion): SerializedPendingPoll {
  return {
    questions: pending.questions,
    toolId: pending.toolId,
    chatJid: pending.chatJid,
    chatJidAliases: Array.from(pending.chatJidAliases),
    mode: pending.mode,
    pollMessageIdToQuestionIndex: Array.from(pending.pollMessageIdToQuestionIndex.entries()),
    currentQuestionIndex: pending.currentQuestionIndex,
    answersCollected: pending.answersCollected,
    createdAt: pending.createdAt,
    resolution: pending.resolution,
    timeoutMs: pending.timeoutMs,
    votesByQuestion: Array.from(pending.votesByQuestion.entries())
      .map(([qIdx, voters]) => [qIdx, Array.from(voters.entries())] as [number, Array<[string, PollVote]>]),
    adminJids: pending.adminJids ? Array.from(pending.adminJids) : null,
    resolvedAt: pending.resolvedAt,
    source: pending.source,
    sentPollMessageIds: pending.sentPollMessageIds,
  };
}

export function deserializePendingPoll(s: SerializedPendingPoll): PendingPollQuestion {
  return {
    questions: s.questions,
    toolId: s.toolId,
    chatJid: s.chatJid,
    chatJidAliases: new Set(s.chatJidAliases),
    mode: s.mode,
    pollMessageIdToQuestionIndex: new Map(s.pollMessageIdToQuestionIndex),
    currentQuestionIndex: s.currentQuestionIndex,
    answersCollected: s.answersCollected,
    createdAt: s.createdAt,
    softExpiryTimer: undefined,
    hardExpiryTimer: undefined,
    resolution: s.resolution,
    timeoutMs: s.timeoutMs,
    votesByQuestion: new Map(
      s.votesByQuestion.map(([qIdx, voters]) => [qIdx, new Map(voters)] as [number, Map<string, PollVote>]),
    ),
    adminJids: s.adminJids ? new Set(s.adminJids) : null,
    awaitResolve: undefined,
    awaitReject: undefined,
    resolvedAt: s.resolvedAt,
    source: s.source,
    sentPollMessageIds: s.sentPollMessageIds,
  };
}

export type PendingPollQuestion = {
  questions: AskUserQuestion[];
  toolId: string;
  chatJid: string;
  chatJidAliases: Set<string>;
  mode: 'poll' | 'textFallback';
  pollMessageIdToQuestionIndex: Map<string, number>;
  currentQuestionIndex: number;
  answersCollected: Record<number, string>;
  createdAt: number;
  softExpiryTimer?: ReturnType<typeof setTimeout>;
  hardExpiryTimer?: ReturnType<typeof setTimeout>;
  // Group poll extensions
  resolution: ResolutionStrategy;
  timeoutMs: number;
  votesByQuestion: Map<number, Map<string, PollVote>>;
  adminJids: Set<string> | null;
  awaitResolve?: (answer: string) => void;
  awaitReject?: (err: Error) => void;
  resolvedAt?: number;
  source: 'askuser' | 'send_poll';
  sentPollMessageIds: string[];
};

// ---------------------------------------------------------------------------
// Group poll resolution engine (module-level exports for testability)
// ---------------------------------------------------------------------------

export function evaluateResolution(
  strategy: ResolutionStrategy,
  votes: Map<string, PollVote>,
  adminJids: Set<string> | null,
): ResolutionResult {
  if (votes.size === 0) return { status: 'pending' };
  switch (strategy) {
    case 'first-vote-wins': {
      const firstVote = votes.values().next().value!;
      return { status: 'resolved', answer: firstVote.selectedOptions.join(', ') };
    }
    case 'admin-only': {
      for (const vote of votes.values()) {
        if (vote.isAdmin) return { status: 'resolved', answer: vote.selectedOptions.join(', ') };
      }
      return { status: 'pending' };
    }
    case 'admin-wins': {
      // On vote arrival: admin vote resolves immediately; no admin vote yet → pending.
      // On timeout: falls back to majority of recorded non-admin votes (see handlePendingPollSoftExpiry).
      for (const vote of votes.values()) {
        if (vote.isAdmin) return { status: 'resolved', answer: vote.selectedOptions.join(', ') };
      }
      return { status: 'pending' };
    }
    case 'majority-after-timeout':
      return { status: 'pending' };
  }
}

export function evaluateResolutionOnTimeout(votes: Map<string, PollVote>): string | null {
  if (votes.size === 0) return null;
  const tally = new Map<string, { count: number; earliestTimestamp: number }>();
  for (const vote of votes.values()) {
    const option = vote.selectedOptions[0];
    if (!option) continue;
    const existing = tally.get(option);
    if (existing) {
      existing.count++;
      existing.earliestTimestamp = Math.min(existing.earliestTimestamp, vote.timestamp);
    } else {
      tally.set(option, { count: 1, earliestTimestamp: vote.timestamp });
    }
  }
  let winner: string | null = null;
  let bestCount = 0;
  let bestTimestamp = Infinity;
  for (const [option, data] of tally) {
    if (data.count > bestCount || (data.count === bestCount && data.earliestTimestamp < bestTimestamp)) {
      winner = option;
      bestCount = data.count;
      bestTimestamp = data.earliestTimestamp;
    }
  }
  return winner;
}

export type EscapeHatchLabelPattern = { phrase: string; allowWhitespaceSuffix: boolean };

export const ESCAPE_HATCH_LABEL_PATTERNS: EscapeHatchLabelPattern[] = [
  { phrase: 'other', allowWhitespaceSuffix: false },
  { phrase: 'none of the above', allowWhitespaceSuffix: true },
  { phrase: 'something else', allowWhitespaceSuffix: true },
  { phrase: 'propose alternative', allowWhitespaceSuffix: true },
  { phrase: 'cancel', allowWhitespaceSuffix: false },
  { phrase: 'abort', allowWhitespaceSuffix: false },
  { phrase: 'defer', allowWhitespaceSuffix: false },
  { phrase: 'need more context', allowWhitespaceSuffix: true },
];

export const OTHER_LABEL_PATTERNS: EscapeHatchLabelPattern[] = [
  { phrase: 'other', allowWhitespaceSuffix: false },
  { phrase: 'none of the above', allowWhitespaceSuffix: true },
  { phrase: 'something else', allowWhitespaceSuffix: true },
  { phrase: 'propose alternative', allowWhitespaceSuffix: true },
];

/**
 * Format an AskUserQuestion question for WhatsApp poll rendering.
 *
 * - Question text: up to 900 chars, truncated with "…" suffix if longer.
 * - Option values: concise labels for paragraph/multiline descriptions;
 *   otherwise `label — description` when it fits within the option budget.
 * - `followUpText`: contextual full details when poll labels omit or truncate descriptions.
 * - `needsFollowUp`: compatibility flag for callers that only need to know whether
 *   `followUpText` should be sent.
 *
 * Exported for unit testing.
 */
export function formatPollQuestion(q: {
  question: string;
  options: AskUserOption[];
}): {
  pollName: string;
  pollValues: string[];
  needsFollowUp: boolean;
  followUpText: string | null;
} {
  // Client-safety: the AskUserQuestion → poll path bypasses the send_poll MCP
  // tool (the agent runtime sends it directly), so redact internal-artifact
  // leaks up front — before truncation — so every derived client surface
  // (pollName, pollValues, followUpText) is clean. No-op on benign content.
  q = {
    question: redactInternalArtifacts(q.question).text,
    options: q.options.map((o) => ({
      label: redactInternalArtifacts(o.label).text,
      description: redactInternalArtifacts(o.description).text,
    })),
  };

  // Question text: truncate to budget
  const pollName = q.question.length > POLL_QUESTION_MAX_CHARS
    ? q.question.slice(0, POLL_QUESTION_MAX_CHARS - 1) + '…'
    : q.question;

  // Option values stay compact when any option carries paragraph-scale detail;
  // otherwise short descriptions are included inline while staying under budget.
  let anyTruncated = false;
  const SEPARATOR = ' — ';
  const ELLIPSIS = '…';

  const hasDetailDescription = q.options.some(o => {
    const description = o.description ?? '';
    return description.trim().length > POLL_DETAIL_DESCRIPTION_MIN_CHARS || /\r|\n/.test(description);
  });

  const optionDetailLines = q.options.map((o, i) => {
    const description = o.description.trim();
    return description.length > 0
      ? `${i + 1}. *${o.label}*\n${description}`
      : `${i + 1}. *${o.label}*`;
  });

  const buildFollowUpText = (): string => [
    `Details for poll: ${q.question}`,
    '',
    'Use the poll below to choose. Full option details:',
    ...optionDetailLines,
  ].join('\n');

  const pollValues = q.options.map(o => {
    if (!o.description || o.description.trim().length === 0) {
      // No description — use label, truncate if needed
      if (o.label.length > POLL_OPTION_MAX_CHARS) {
        anyTruncated = true;
        return o.label.slice(0, POLL_OPTION_MAX_CHARS - 1) + ELLIPSIS;
      }
      return o.label;
    }

    if (hasDetailDescription) {
      anyTruncated = true;
      if (o.label.length > POLL_OPTION_MAX_CHARS) {
        return o.label.slice(0, POLL_OPTION_MAX_CHARS - 1) + ELLIPSIS;
      }
      return o.label;
    }

    const description = o.description.replace(/\s+/g, ' ').trim();
    const rich = `${o.label}${SEPARATOR}${description}`;
    if (rich.length <= POLL_OPTION_MAX_CHARS) {
      // Full rich text fits
      return rich;
    }

    // Rich text doesn't fit — truncate description portion
    const prefixLen = o.label.length + SEPARATOR.length;
    const descBudget = POLL_OPTION_MAX_CHARS - prefixLen - ELLIPSIS.length;

    if (descBudget >= 10) {
      // Enough room for a meaningful description prefix
      anyTruncated = true;
      return `${o.label}${SEPARATOR}${description.slice(0, descBudget)}${ELLIPSIS}`;
    }

    // Label itself nearly fills the budget — bare label only
    anyTruncated = true;
    if (o.label.length > POLL_OPTION_MAX_CHARS) {
      return o.label.slice(0, POLL_OPTION_MAX_CHARS - 1) + ELLIPSIS;
    }
    return o.label;
  });

  return {
    pollName,
    pollValues,
    needsFollowUp: anyTruncated,
    followUpText: anyTruncated ? buildFollowUpText() : null,
  };
}

export function pendingPollMatchesChatJid(pending: PendingPollQuestion, chatJid: string): boolean {
  return pending.chatJid === chatJid || pending.chatJidAliases.has(chatJid);
}

export function normalizeDecisionLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export function labelMatchesIntentPattern(value: string, pattern: EscapeHatchLabelPattern): boolean {
  const normalized = normalizeDecisionLabel(value);
  if (normalized === pattern.phrase) return true;
  if (!normalized.startsWith(pattern.phrase)) return false;

  const suffix = normalized.slice(pattern.phrase.length);
  const suffixTrimmed = suffix.trimStart();
  if (!suffixTrimmed) return true;

  // Accept labels like "Other - propose" or "Need more context: logs" while
  // avoiding false positives such as "Other databases" or "Cancel subscription".
  if ('-:/(['.includes(suffixTrimmed[0])) return true;
  return pattern.allowWhitespaceSuffix && /^\s+/.test(suffix);
}

export function labelMatchesAny(value: string, patterns: EscapeHatchLabelPattern[]): boolean {
  return patterns.some((pattern) => labelMatchesIntentPattern(value, pattern));
}

export function hasEscapeHatchOption(options: AskUserOption[]): boolean {
  return options.some((option) => labelMatchesAny(option.label, ESCAPE_HATCH_LABEL_PATTERNS));
}

export function isOtherOptionLabel(value: string): boolean {
  return labelMatchesAny(value, OTHER_LABEL_PATTERNS);
}

export function normalizeAskUserQuestions(questions: AskUserQuestion[]): AskUserQuestion[] {
  return questions.map((question) => {
    const options = question.options.map((option) => ({
      label: option.label,
      description: option.description ?? '',
    }));

    if (options.length >= 12 || hasEscapeHatchOption(options)) {
      return { ...question, options };
    }

    return {
      ...question,
      options: [
        ...options,
        {
          label: ASKUSER_OTHER_OPTION_LABEL,
          description: '',
        },
      ],
    };
  });
}

export function clampPollTimeoutMs(timeoutMs: number): number {
  return Math.min(Math.max(timeoutMs, MIN_POLL_TIMEOUT_MS), MAX_POLL_TIMEOUT_MS);
}

export function configuredDefaultPollTimeoutMs(): number {
  const raw = Number(config.pollResolution?.defaultTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0
    ? clampPollTimeoutMs(raw)
    : DEFAULT_POLL_TIMEOUT_MS;
}

export function normalizePendingPollTimeoutMs(timeoutMs: unknown): number {
  const raw = Number(timeoutMs);
  return Number.isFinite(raw) && raw > 0
    ? clampPollTimeoutMs(raw)
    : configuredDefaultPollTimeoutMs();
}

export function formatOptionLine(
  option: AskUserOption,
  index: number,
  { includeDescription = true }: { includeDescription?: boolean } = {},
): string {
  const description = includeDescription ? option.description.trim() : '';
  return description.length > 0
    ? `${index + 1}. *${option.label}* — ${description}`
    : `${index + 1}. *${option.label}*`;
}

export function formatTextFallbackQuestion(
  q: AskUserQuestion,
  intro?: string,
  { includeDescriptions = true }: { includeDescriptions?: boolean } = {},
): string {
  // Client-safety: this is the text fallback when the poll cannot be sent —
  // another client-facing surface that bypasses the send_poll guard. Redact
  // internal-artifact leaks in the question and option labels/descriptions.
  q = {
    ...q,
    question: redactInternalArtifacts(q.question).text,
    options: q.options.map((o) => ({
      label: redactInternalArtifacts(o.label).text,
      description: redactInternalArtifacts(o.description).text,
    })),
  };
  const optionLines = q.options.map((option, index) => {
    return formatOptionLine(option, index, { includeDescription: includeDescriptions });
  });
  const lines = [
    ...(intro ? [intro, ''] : []),
    q.question,
    '',
    ...(includeDescriptions ? [] : ['_Full option details were sent above._', '']),
    ...optionLines,
    '',
    '_Reply with option number or text._',
  ];
  return lines.join('\n');
}

export function formatOtherDirective(q: AskUserQuestion, selectedOptions: string[]): string {
  const originalOptions = q.options
    .filter((option) => !isOtherOptionLabel(option.label))
    .map((option, index) => formatOptionLine(option, index));

  return [
    '[User selected Other — none of the proposed options fit]',
    `Question requiring follow-up: ${q.question}`,
    selectedOptions.length > 0 ? `Selected option(s): ${selectedOptions.join(', ')}` : null,
    'Original options:',
    ...(originalOptions.length > 0 ? originalOptions : ['(none recorded)']),
    'Directive:',
    'Ask the user what they have in mind. Explore their reasoning with 1-2 follow-up questions, then either propose a revised option or re-present the decision with the new option added.',
  ].filter((line): line is string => line !== null).join('\n');
}

export function resolveTypedPollAnswer(text: string, q: AskUserQuestion): string {
  const normalized = normalizedPollReplyText(text);
  let selectedOption: AskUserOption | undefined;

  if (/^\d+$/.test(normalized)) {
    const index = Number(normalized) - 1;
    selectedOption = q.options[index];
  } else if (/^[a-z]$/.test(normalized)) {
    const index = normalized.charCodeAt(0) - 'a'.charCodeAt(0);
    selectedOption = q.options[index];
  } else {
    selectedOption = q.options.find((option) => {
      return normalizedPollReplyText(option.label) === normalized
        || normalizedPollReplyText(option.description) === normalized;
    });
  }

  if (!selectedOption) return `${text} (free-text response)`;
  if (isOtherOptionLabel(selectedOption.label)) return formatOtherDirective(q, [selectedOption.label]);
  return selectedOption.label;
}

export function answerForPollSelection(q: AskUserQuestion, selectedOptions: string[]): string {
  if (selectedOptions.some(isOtherOptionLabel)) return formatOtherDirective(q, selectedOptions);
  return selectedOptions.join(', ');
}

export function normalizedPollReplyText(text: string): string {
  return text.trim().toLowerCase().replace(/[.!?]+$/g, '').replace(/\s+/g, ' ');
}

export function textMatchesPollOption(text: string, options: AskUserOption[]): boolean {
  const normalized = normalizedPollReplyText(text);
  if (!normalized) return false;

  if (/^\d+$/.test(normalized)) {
    const index = Number(normalized);
    return Number.isInteger(index) && index >= 1 && index <= options.length;
  }

  if (/^[a-z]$/.test(normalized)) {
    const index = normalized.charCodeAt(0) - 'a'.charCodeAt(0);
    return index >= 0 && index < options.length;
  }

  return options.some((option) => {
    return normalizedPollReplyText(option.label) === normalized
      || normalizedPollReplyText(option.description) === normalized;
  });
}

export const LOW_SIGNAL_POLL_STATUS_REPLIES = new Set([
  'i voted',
  'voted',
  'i vote',
  'vote sent',
  'sent my vote',
  'i sent my vote',
  'i selected one',
  'i selected an option',
  'i picked one',
  'i chose one',
  'submitted',
]);

export function isLowSignalPollStatusReply(
  text: string,
  options: AskUserOption[],
): boolean {
  if (textMatchesPollOption(text, options)) return false;
  return LOW_SIGNAL_POLL_STATUS_REPLIES.has(normalizedPollReplyText(text));
}

// ---------------------------------------------------------------------------
// PendingPollQuestion live-state helpers
// ---------------------------------------------------------------------------
// Pure operations on a single PendingPollQuestion (no AgentRuntime state).
// Extracted from AgentRuntime as a god-class method-count slice — the call sites
// switch from `this.X(pending)` to the imported free function, behavior unchanged.

/** Clear and null both expiry timers on a pending poll (idempotent). */
export function clearPendingPollTimers(pending: PendingPollQuestion): void {
  if (pending.softExpiryTimer) {
    clearTimeout(pending.softExpiryTimer);
    pending.softExpiryTimer = undefined;
  }
  if (pending.hardExpiryTimer) {
    clearTimeout(pending.hardExpiryTimer);
    pending.hardExpiryTimer = undefined;
  }
}

/** Drop every poll-message-id mapping that points at the given question index. */
export function removePollIdsForQuestion(pending: PendingPollQuestion, questionIndex: number): void {
  for (const [pollMessageId, index] of pending.pollMessageIdToQuestionIndex) {
    if (index === questionIndex) pending.pollMessageIdToQuestionIndex.delete(pollMessageId);
  }
}

/** Advance currentQuestionIndex past every already-answered question. */
export function advancePendingPollIndex(pending: PendingPollQuestion): void {
  while (
    pending.currentQuestionIndex < pending.questions.length
    && pending.answersCollected[pending.currentQuestionIndex] !== undefined
  ) {
    pending.currentQuestionIndex++;
  }
}

/** The poll's still-unanswered questions, paired with their original index. */
export function unansweredPollQuestions(
  pending: PendingPollQuestion,
): Array<{ index: number; question: AskUserQuestion }> {
  return pending.questions
    .map((question, index) => ({ index, question }))
    .filter(({ index }) => pending.answersCollected[index] === undefined);
}
