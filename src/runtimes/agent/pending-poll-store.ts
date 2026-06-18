/**
 * PendingPollStore — the per-chat AskUserQuestion pending-poll map + the two
 * map-reading queries that guard against acting on a poll that was replaced.
 *
 * Second slice of the pending-poll subsystem decomposition. Owns the
 * mapKey → PendingPollQuestion map (exposed as a public readonly `questions` Map so
 * AgentRuntime's orchestration — settle / expiry / persist / restore / rekey /
 * cleanup — drives it directly, mirroring the ImageCoalescer.buffers /
 * PendingSystemResultTracker.counts pattern) plus:
 *   - isActive(pending): is this exact pending object still the live entry for its
 *     chat (object-identity check across the map)?
 *   - shouldContinueSend(mapKey, pending): true if the poll is still active; else
 *     clear its timers and log the abandonment (used by the async poll-send path to
 *     bail when a newer poll replaced this one mid-send).
 *
 * The lifecycle methods that mutate the map alongside other AgentRuntime state
 * (deletePendingPollQuestions, settlePoll, the expiry handlers, persistence) stay in
 * AgentRuntime and read/write this.questions. Behavior is identical to the previous
 * inline field + methods — see the pending-poll characterization coverage
 * (runtime.test.ts poll bridge, runtime-secondhalf-branches.test.ts, poll-persistence,
 * group-poll-resolution, runtime-structural-policy).
 */
import { createChildLogger } from '../../logger.ts';
import { clearPendingPollTimers, type PendingPollQuestion } from './poll-resolution.ts';

// Same component name as AgentRuntime: the abandonment debug line keeps its existing
// `component: 'agent-runtime'` log binding (no observable change).
const log = createChildLogger('agent-runtime');

export class PendingPollStore {
  /** mapKey → the live pending poll for that chat. Public: AgentRuntime drives it. */
  readonly questions = new Map<string, PendingPollQuestion>();

  /** True when `pending` is still the live entry for some chat (object identity). */
  isActive(pending: PendingPollQuestion): boolean {
    for (const active of this.questions.values()) {
      if (active === pending) return true;
    }
    return false;
  }

  /**
   * Whether an in-flight poll-send should continue. If the poll is still active,
   * continue; otherwise it was replaced mid-send — clear its (now-orphaned) timers
   * and log the abandonment, then signal the caller to bail.
   */
  shouldContinueSend(mapKey: string, pending: PendingPollQuestion): boolean {
    if (this.isActive(pending)) return true;
    clearPendingPollTimers(pending);
    log.debug(
      { mapKey, chatJid: pending.chatJid, toolId: pending.toolId },
      'AskUserQuestion poll send abandoned after pending poll was replaced',
    );
    return false;
  }
}
