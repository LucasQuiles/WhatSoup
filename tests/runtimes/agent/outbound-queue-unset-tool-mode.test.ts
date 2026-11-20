/**
 * An instance with no configured toolUpdateMode keeps tool progress out of the
 * user chat (#3830) and handles assistant text as main does for such an
 * instance, which is the full-mode path: text written before a tool call is
 * delivered, not held back and then dropped.
 *
 * Each case uses a real config, a real OutboundQueue and fake timers, and drives
 * the queue in the runtime's own call order:
 * - setup: runtime.ts:3303-3313 (createOutboundQueue);
 * - assistant_text: runtime.ts:7383 and :12268, where only minimal mode passes a
 *   commit callback;
 * - tool_use: discardPreToolAssistantText, then enqueueToolUpdate (runtime.ts:7444
 *   and :7452, :12308 and :12326);
 * - result: commitStreamingText, endTurn and enqueueResultText as the answer
 *   (runtime-turn-result-handler.ts:356, :381 and :630), then the flush;
 * - coordinator turns: beginTurnEvidence before the first event
 *   (runtime-turn-coordinator.ts:891).
 * Each expected sequence is the one main delivers for an unset instance, without
 * the tool status message that main also sent to the user chat.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import type { Messenger, TypingState } from '../../../src/core/types.ts';
import { toConversationKey } from '../../../src/core/conversation-key.ts';
import type { ProgressEvent } from '../../../src/runtimes/agent/operation-tracker.ts';
import { trackTmpDirs } from '../../helpers/tmp-dir.ts';

vi.mock('../../../src/logger.ts', async () => {
  const { loggerModuleMock } = await import('../../helpers/logger-mock.ts');
  return loggerModuleMock();
});

const tmp = trackTmpDirs('unset-tool-mode-');
const chatJid = '15550000002@s.whatsapp.net';
const FIRST = 'The deadline is Friday.';
const SECOND = 'Saved it to your notes.';
const NOTICE = 'Switching to a backup model.';
const TOOL_PATH = 'notes/todo.md';
let instance: Record<string, unknown>;

beforeEach(() => {
  const root = tmp.make('instance');
  vi.stubEnv('TMPDIR', process.env.TMPDIR);
  vi.stubEnv('WHATSOUP_CONFIG_DIR', join(root, 'config'));
  vi.stubEnv('WHATSOUP_DATA_DIR', join(root, 'data'));
  vi.stubEnv('WHATSOUP_STATE_DIR', join(root, 'state'));
  instance = {
    name: 'unset-mode-test',
    type: 'agent',
    adminPhones: ['15550000001'],
    accessMode: 'allowlist',
    paths: {
      configRoot: join(root, 'config'),
      dataRoot: join(root, 'data'),
      stateRoot: join(root, 'state'),
      authDir: join(root, 'config', 'auth_info'),
      dbPath: join(root, 'data', 'bot.db'),
      logDir: join(root, 'data', 'logs'),
      lockPath: join(root, 'state', 'bot.lock'),
      mediaDir: join(root, 'data', 'media'),
    },
  };
  vi.resetModules();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** A queue built from a real config with no toolUpdateMode, as the runtime builds it. */
async function makeUnsetQueue() {
  vi.stubEnv('INSTANCE_CONFIG', JSON.stringify(instance));
  const { config } = await import('../../../src/config.ts');
  const { OutboundQueue } = await import('../../../src/runtimes/agent/outbound-queue.ts');
  const { buildToolUpdate } = await import('../../../src/runtimes/agent/tool-update.ts');
  const sent: Array<{ jid: string; text: string }> = [];
  const typing: TypingState[] = [];
  const messenger: Messenger = {
    sendMessage: async (jid, text) => {
      sent.push({ jid, text });
      return { waMessageId: null };
    },
    sendMedia: async () => ({ waMessageId: null }),
    setTyping: async (_jid, state) => {
      typing.push(state);
    },
  };
  const queue = new OutboundQueue(messenger, chatJid, {
    conversationKey: toConversationKey(chatJid),
    peerIsAdmin: () => false,
    peerIsTrustedInternal: () => false,
    fallbackActive: () => false,
  });
  queue.setToolUpdateMode(config.toolUpdateMode);
  queue.setToolUpdateRedirectJid(config.toolUpdateRedirectJid);
  queue.setTextAggregateDelayMs(config.textAggregateDelayMs);
  return { queue, sent, typing, buildToolUpdate, minimal: config.toolUpdateMode === 'minimal' };
}

type Harness = Awaited<ReturnType<typeof makeUnsetQueue>>;

function assistantText({ queue, minimal }: Harness, text: string): void {
  if (minimal) queue.enqueueStreamingText(text, 'answer', () => {});
  else queue.enqueueStreamingText(text, 'answer');
}

interface Turn {
  readonly name: string;
  /** Coordinator turn: queue turn evidence begins before the first event. */
  readonly coordinatorTurn: boolean;
  /** A lifecycle notice reaches the queue after the tool call. */
  readonly midTurnNotice: boolean;
  /** The assistant writes a second text after the tool call. */
  readonly secondText: boolean;
  /** The result event's text; null is a result with no text. */
  readonly result: string | null;
  /** The texts the user chat receives, in order. */
  readonly expected: readonly string[];
}

/** Text, a three-second Write tool call, then the result: everything the queue sent. */
async function runTurn(turn: Turn): Promise<Array<{ jid: string; text: string }>> {
  const harness = await makeUnsetQueue();
  const { queue } = harness;
  if (turn.coordinatorTurn) {
    queue.beginTurnEvidence('turn-1', { conversationKey: toConversationKey(chatJid), chatJid });
  }
  assistantText(harness, FIRST);
  await vi.advanceTimersByTimeAsync(100);
  queue.discardPreToolAssistantText();
  queue.enqueueToolUpdate(harness.buildToolUpdate('Write', { file_path: TOOL_PATH }));
  await vi.advanceTimersByTimeAsync(3_000);
  if (turn.midTurnNotice) queue.enqueueText(NOTICE, 'lifecycle');
  if (turn.secondText) assistantText(harness, SECOND);
  await vi.advanceTimersByTimeAsync(100);
  queue.commitStreamingText();
  queue.endTurn({ resultTextPending: turn.result !== null, recoverDeferredText: true });
  if (turn.result !== null) queue.enqueueResultText(turn.result, 'answer');
  const drained = queue.flush();
  await vi.advanceTimersByTimeAsync(10_000);
  await drained;
  return harness.sent;
}

const TEXT_BEFORE_TOOL_TURNS: readonly Turn[] = [
  {
    name: 'a turn without turn evidence whose result has no text',
    coordinatorTurn: false, midTurnNotice: false, secondText: true, result: null,
    expected: [FIRST, SECOND],
  },
  {
    name: 'a coordinator turn whose result has no text',
    coordinatorTurn: true, midTurnNotice: false, secondText: true, result: null,
    expected: [`${FIRST}${SECOND}`],
  },
  {
    name: 'a coordinator turn with a lifecycle notice after the tool call and a result with no text',
    coordinatorTurn: true, midTurnNotice: true, secondText: false, result: null,
    expected: [NOTICE, FIRST],
  },
];

describe('unset tool update mode', () => {
  it.each(TEXT_BEFORE_TOOL_TURNS)('delivers text written before a tool call in $name', async (turn) => {
    const sent = await runTurn(turn);

    expect(sent).toEqual(turn.expected.map((text) => ({ jid: chatJid, text })));
    expect(sent.map((message) => message.text).join('\n')).not.toContain(TOOL_PATH);
  });

  it('delivers a result that holds both texts as the only answer', async () => {
    const sent = await runTurn({
      name: 'a coordinator turn whose result holds both texts',
      coordinatorTurn: true, midTurnNotice: false, secondText: true, result: `${FIRST} ${SECOND}`,
      expected: [`${FIRST} ${SECOND}`],
    });

    expect(sent).toEqual([{ jid: chatJid, text: `${FIRST} ${SECOND}` }]);
    expect(sent.map((message) => message.text).join('\n')).not.toContain(TOOL_PATH);
  });
});

/** One event for each mode branch of OutboundQueue.enqueueProgressUpdate. */
const PROGRESS_EVENTS: ReadonlyArray<{ readonly name: string; readonly event: ProgressEvent }> = [
  { name: 'thinking_long', event: { type: 'thinking_long', gapMs: 10_000 } },
  { name: 'thinking_stalled', event: { type: 'thinking_stalled', gapMs: 60_000 } },
  {
    name: 'operation_progress',
    event: { type: 'operation_progress', toolId: 'tool-1', toolName: 'Bash', category: 'running', elapsedMs: 45_000, state: 'running' },
  },
  {
    name: 'operation_slow',
    event: { type: 'operation_slow', toolId: 'tool-1', toolName: 'Bash', category: 'running', elapsedMs: 45_000, expectedMs: 15_000 },
  },
  {
    name: 'operation_stalled',
    event: { type: 'operation_stalled', toolId: 'tool-1', toolName: 'Bash', category: 'running', elapsedMs: 75_000 },
  },
];

/** A fresh queue per call, so the per-queue progress rate floor never suppresses the event. */
async function sendProgress(event: ProgressEvent, mode: 'unset' | 'full'): Promise<Harness> {
  const harness = await makeUnsetQueue();
  if (mode === 'full') harness.queue.setToolUpdateMode('full');
  harness.queue.enqueueProgressUpdate(event, 'bot-a');
  await vi.advanceTimersByTimeAsync(10_000);
  harness.queue.abortTurn();
  return harness;
}

describe('unset tool update mode, progress events', () => {
  // If a branch loses its unset case, or its condition is inverted, the unset
  // queue renders a progress placeholder into the user chat. The full-mode
  // control shows that the same event does render one.
  it.each(PROGRESS_EVENTS)('shows only the typing indicator for $name', async ({ event }) => {
    const unset = await sendProgress(event, 'unset');
    expect(unset.sent).toEqual([]);
    expect(unset.typing).toContain(true);

    const full = await sendProgress(event, 'full');
    expect(full.sent).toHaveLength(1);
    expect(full.sent[0]?.jid).toBe(chatJid);
  });
});
