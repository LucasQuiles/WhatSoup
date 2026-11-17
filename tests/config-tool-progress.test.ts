import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import type { Messenger, TypingState } from '../src/core/types.ts';
import { toConversationKey } from '../src/core/conversation-key.ts';
import { trackTmpDirs } from './helpers/tmp-dir.ts';

vi.mock('../src/logger.ts', async () => {
  const { loggerModuleMock } = await import('./helpers/logger-mock.ts');
  return loggerModuleMock();
});

const tmp = trackTmpDirs('tool-progress-config-');
const chatJid = '15550000002@s.whatsapp.net';
let instance: Record<string, unknown>;

beforeEach(() => {
  const root = tmp.make('instance');
  vi.stubEnv('TMPDIR', process.env.TMPDIR);
  vi.stubEnv('WHATSOUP_CONFIG_DIR', join(root, 'config'));
  vi.stubEnv('WHATSOUP_DATA_DIR', join(root, 'data'));
  vi.stubEnv('WHATSOUP_STATE_DIR', join(root, 'state'));
  instance = {
    name: 'progress-test',
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
  const timers = vi.getTimerCount();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  expect(timers).toBe(0);
});

async function makeQueue(overrides: Record<string, unknown> = {}) {
  vi.stubEnv('INSTANCE_CONFIG', JSON.stringify({ ...instance, ...overrides }));
  const { config } = await import('../src/config.ts');
  const { OutboundQueue, TOOL_BATCH_DELAY_MS } = await import('../src/runtimes/agent/outbound-queue.ts');
  const { buildToolUpdate } = await import('../src/runtimes/agent/tool-update.ts');
  const sent: Array<{ jid: string; text: string }> = [];
  const typing: TypingState[] = [];
  const messenger: Messenger = {
    sendMessage: async (jid, text) => {
      sent.push({ jid, text });
      return { waMessageId: null };
    },
    sendMedia: async () => ({ waMessageId: null }),
    setTyping: async (_jid, active) => { typing.push(active); },
  };
  const queue = new OutboundQueue(messenger, chatJid, {
    conversationKey: toConversationKey(chatJid),
    peerIsAdmin: () => false,
    peerIsTrustedInternal: () => false,
    fallbackActive: () => false,
  });
  queue.setToolUpdateMode(config.toolUpdateMode);
  queue.setToolUpdateRedirectJid(config.toolUpdateRedirectJid);
  return { queue, sent, typing, buildToolUpdate, delay: TOOL_BATCH_DELAY_MS };
}

describe('configured tool progress delivery', () => {
  it.each([{}, { toolUpdateMode: null }])('keeps an unset mode private while delivering the final answer: %j', async (overrides) => {
    const { queue, sent, typing, buildToolUpdate, delay } = await makeQueue(overrides);
    try {
      queue.enqueueToolUpdate(buildToolUpdate('Read', { file_path: 'workspace/report.txt' }));
      queue.enqueueToolUpdate(buildToolUpdate('Bash', { command: 'printf health' }));
      await vi.advanceTimersByTimeAsync(delay);
      expect(sent).toEqual([]);
      expect(typing).toContain(true);
      queue.enqueueResultText('The report is ready.', 'answer');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sent).toEqual([{ jid: chatJid, text: 'The report is ready.' }]);
    } finally {
      queue.abortTurn();
    }
  });

  it.each(['full', 'friendly'] as const)('keeps explicit %s progress enabled', async (toolUpdateMode) => {
    const { queue, sent, buildToolUpdate, delay } = await makeQueue({ toolUpdateMode });
    try {
      queue.enqueueToolUpdate(buildToolUpdate('Read', { file_path: 'workspace/report.txt' }));
      queue.enqueueToolUpdate(buildToolUpdate('Bash', { command: 'printf health' }));
      await vi.advanceTimersByTimeAsync(delay);
      expect(sent).toHaveLength(1);
      expect(sent[0].jid).toBe(chatJid);
      expect(sent[0].text).toContain('workspace/report.txt');
      expect(sent[0].text).toContain('printf health');
    } finally {
      queue.abortTurn();
    }
  });

  it('preserves explicit full progress directed to the operator', async () => {
    const redirectJid = '15550000001@s.whatsapp.net';
    const { queue, sent, buildToolUpdate, delay } = await makeQueue({
      toolUpdateMode: 'full', toolUpdateRedirectJid: redirectJid,
    });
    try {
      queue.enqueueToolUpdate(buildToolUpdate('Bash', { command: 'printf health' }));
      await vi.advanceTimersByTimeAsync(delay);
      expect(sent).toHaveLength(1);
      expect(sent[0].jid).toBe(redirectJid);
      expect(sent[0].text).toContain('printf health');
    } finally {
      queue.abortTurn();
    }
  });
});
