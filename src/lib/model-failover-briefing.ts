/**
 * Model-failover briefing builder.
 *
 * When a model fails over to a backup, the new model has no context for why
 * it is suddenly active or what the prior model was doing. Injecting a
 * structured briefing as the first user-side turn closes that gap:
 *
 *  - The `user` role is used (not `assistant`) so the new model treats the
 *    content as input it must read, not as its own prior output to ignore.
 *  - The briefing states what happened, summarizes the current state, and
 *    instructs the new model not to repeat already-completed work.
 *
 * This is the model-failover analogue of WhatSoup's session handoff
 * (`src/runtimes/agent/handoff-summarizer.ts`), which handles agent-session
 * context distillation. That module does NOT brief a model on a failover;
 * this one does.
 *
 * Scope note: the original pattern (OpenClaw `buildHierarchyReinforcementMessage`)
 * carried a multi-agent LEADER/SUBORDINATES hierarchy. WhatSoup has no
 * subagent tree, so that hierarchy is dropped. The portable core — structured
 * briefing + `user` role + "don't repeat work" instruction — is kept.
 */

/** Reason a model failed over. Drives the briefing's framing. */
export type FailoverReason =
  | 'rate_limit'
  | 'overloaded'
  | 'timeout'
  | 'auth_error'
  | 'permanent_error'
  | 'unknown';

/** Input to {@link buildModelFailoverBriefing}. */
export interface FailoverBriefingInput {
  /** The model that was active before the failover. */
  previousModel: string;
  /** The backup model now active. */
  newModel: string;
  /** Why the failover happened. */
  reason: FailoverReason;
  /** Summary of the conversation/task state the new model inherits. */
  summary: string;
  /** Optional list of in-flight or pending work items the new model should know about. */
  pendingWork?: readonly string[];
}

/** A chat message in the shape the agent runtime consumes. */
export interface AgentMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

const REASON_FRAMING: Record<FailoverReason, string> = {
  rate_limit: 'the previous model hit a rate limit',
  overloaded: 'the previous model was overloaded',
  timeout: 'the previous model timed out',
  auth_error: 'the previous model had an authentication error',
  permanent_error: 'the previous model failed with a permanent error',
  unknown: 'the previous model became unavailable',
};

/**
 * Build a structured failover briefing message in the `user` role.
 *
 * The new model sees this as input on its first turn, so it knows:
 *  1. A failover occurred and it is now the active model.
 *  2. What the prior state was (summary).
 *  3. What work is still pending (if any).
 *  4. That it should not repeat already-completed work.
 */
export function buildModelFailoverBriefing(input: FailoverBriefingInput): AgentMessage {
  const { previousModel, newModel, reason, summary, pendingWork } = input;
  const framing = REASON_FRAMING[reason] ?? REASON_FRAMING.unknown;

  const lines: string[] = [
    `[SYSTEM HANDOFF] A model failover has occurred because ${framing}.`,
    `Previous model: ${previousModel}.`,
    `You (${newModel}) are now the active model.`,
    '',
    'CURRENT STATE SUMMARY:',
    summary.trim() || '(no summary provided)',
  ];

  if (pendingWork && pendingWork.length > 0) {
    lines.push('', 'PENDING WORK:');
    for (const item of pendingWork) {
      const trimmed = item.trim();
      if (trimmed) {
        lines.push(`- ${trimmed}`);
      }
    }
  }

  lines.push(
    '',
    'INSTRUCTIONS:',
    '1. Review the state summary above.',
    '2. Continue the conversation from where the previous model left off.',
    '3. Do not repeat work that was already completed.',
  );

  return {
    role: 'user',
    content: lines.join('\n'),
    timestamp: Date.now(),
  };
}

/**
 * Build a short user-visible notice for the failover (distinct from the
 * model-facing briefing). This is what gets sent to the chat user.
 *
 * Only transient reasons expose detail to the user; permanent errors are
 * summarized to avoid leaking noisy provider text.
 */
export function buildFailoverUserNotice(input: FailoverBriefingInput): string {
  const { previousModel, newModel, reason } = input;
  const transient = reason === 'rate_limit' || reason === 'overloaded' || reason === 'timeout';
  const detail = transient
    ? `(${reason.replace('_', ' ')})`
    : '(service issue)';
  return `↪️ Model fallback: ${newModel} (selected ${previousModel} ${detail})`;
}

/**
 * Build a user-visible notice for when the primary model recovers and the
 * fallback is cleared. Closes the UX loop: the user learns they're back on
 * the primary model without checking status.
 */
export function buildFailoverClearedNotice(params: {
  primaryModel: string;
  wasFallback: string;
}): string {
  return `↪️ Model fallback cleared: ${params.primaryModel} (was ${params.wasFallback})`;
}
