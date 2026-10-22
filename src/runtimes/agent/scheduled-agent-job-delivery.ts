// #3497: who delivers a scheduled agent-job update.
//
// Claude-family providers deliver it with send_message and keep plain text
// silent. OpenCode cannot: its opencode.json denies whatsoup_send_message to
// every session in the working directory, scheduled or live, so its update is
// the turn's final plain text instead. The runtime holds that text until the
// terminal result and delivers it once; text before or between tool calls is
// progress and is never delivered.
import { createChildLogger } from '../../logger.ts';
import { isolateScheduledAgentJobPrompt } from './scheduled-agent-job-isolation.ts';

const log = createChildLogger('agent-runtime');

export const SCHEDULED_AGENT_JOB_NO_REPLY = 'NO_REPLY';

const SEND_TOOL_DELIVERY_PREFIX = isolateScheduledAgentJobPrompt('');

const FINAL_TEXT_DELIVERY_PREFIX = [
  '[isolated scheduled background turn]',
  'This is not a live user message. Do the scheduled work silently.',
  'Never expose reasoning, tool progress, commands, paths, provider/protocol details, receipts, exit codes, or session logs.',
  'Do not call send_message. If and only if there is one useful, verified user-facing update, write it as your final answer after your last tool call; that answer is delivered to this turn\'s originating chat.',
  `Text written before or between tool calls is never delivered. If there is no update, your final answer must be exactly ${SCHEDULED_AGENT_JOB_NO_REPLY}.`,
  '',
  '',
].join('\n');

export function scheduledAgentJobDeliversFinalText(providerId: string | null | undefined): boolean {
  return providerId === 'opencode-cli';
}

// Sessions whose latest dispatched user turn is a scheduled job. Membership
// lasts until that session's next user dispatch, so a crash between a
// scheduled turn's result and the next dispatch is also treated as scheduled.
const scheduledTurnSessions = new WeakSet<object>();

export function noteScheduledTurnSession(session: object, scheduled: boolean): void {
  if (scheduled) scheduledTurnSessions.add(session);
  else scheduledTurnSessions.delete(session);
}

export function isScheduledTurnSession(session: object | null | undefined): boolean {
  return session !== null && session !== undefined && scheduledTurnSessions.has(session);
}

/**
 * H2 for a notifyUser site: drop the crash notice while the session's latest
 * user turn is scheduled; otherwise call `notify`, which keeps the site's own
 * handleCrashNotify arguments. The session is read at call time because the
 * site assigns it after building its options.
 */
export function crashNoticeUnlessScheduled(
  session: () => object | null | undefined,
  chatJid: string | undefined,
  notify: (msg: string) => void,
): (msg: string) => void {
  return (msg) => {
    if (!isScheduledTurnSession(session())) {
      notify(msg);
      return;
    }
    log.warn({ chatJid }, 'scheduled job crash notification suppressed');
  };
}

/**
 * A scheduled turn posts no user notice, so its operator alerts dedupe under
 * their own key; a chat's user-facing notice dedupe is never touched by one.
 */
export function scheduledDedupeKey(key: string, scheduled: boolean): string {
  return scheduled ? `${key}:scheduled` : key;
}

/** The provider actually running a session; null when unknown. */
export function sessionProviderId(
  session: { getProviderId?: () => string } | null | undefined,
): string | null {
  return typeof session?.getProviderId === 'function' ? session.getProviderId() : null;
}

/**
 * Rewrite the delivery instructions of an isolated scheduled turn for the
 * provider that will actually run it. Only the dispatched copy changes, so a
 * later dispatch on another provider starts from the original text.
 */
export function scheduledAgentJobTurnForProvider(
  turnText: string,
  providerId: string | null | undefined,
): string {
  if (!scheduledAgentJobDeliversFinalText(providerId)) return turnText;
  const at = turnText.indexOf(SEND_TOOL_DELIVERY_PREFIX);
  if (at === -1) return turnText;
  return turnText.slice(0, at)
    + FINAL_TEXT_DELIVERY_PREFIX
    + turnText.slice(at + SEND_TOOL_DELIVERY_PREFIX.length);
}

export type ScheduledFinalAnswer =
  | { readonly kind: 'answer'; readonly text: string }
  | { readonly kind: 'no_reply' }
  | { readonly kind: 'missing' };

/** Classify the text a final-text scheduled turn held after its last tool boundary. */
export function resolveScheduledFinalAnswer(heldText: string | undefined): ScheduledFinalAnswer {
  const text = (heldText ?? '').trim();
  if (text === SCHEDULED_AGENT_JOB_NO_REPLY) return { kind: 'no_reply' };
  const answer = text.endsWith(`\n${SCHEDULED_AGENT_JOB_NO_REPLY}`)
    ? text.slice(0, -SCHEDULED_AGENT_JOB_NO_REPLY.length).trim()
    : text;
  return answer === '' ? { kind: 'missing' } : { kind: 'answer', text: answer };
}
