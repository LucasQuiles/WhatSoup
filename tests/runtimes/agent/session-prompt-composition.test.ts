import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionManager, __provider_switch_for_test } from '../../../src/runtimes/agent/session.ts';
import { AnthropicApiProvider } from '../../../src/runtimes/agent/providers/anthropic-api.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import { trackTmpDirs } from '../../helpers/tmp-dir.ts';

const CHAT_JID = 'test@s.whatsapp.net';
const BASE_TRANSPORT_PROMPT_BYTES = 1870;

const tmp = trackTmpDirs('');

function makeTempRoot(): string {
  return tmp.make('whatsoup-session-prompt');
}

function makeDb(): Database {
  return {
    assertWritableCompatibility: () => undefined,
    raw: {
      prepare: () => ({ run: () => undefined, get: () => undefined }),
      exec: () => undefined,
    },
  } as unknown as Database;
}

function makeMessenger(): Messenger {
  return {
    sendMessage: async () => ({ waMessageId: null }),
    sendMedia: async () => ({ waMessageId: null }),
  };
}

describe('SessionManager system prompt composition', () => {
  it('composes transport prelude, configured prompt, and instructionsPath with identity dedup', () => {
    const cwd = makeTempRoot();
    const instructionsPath = 'agent-instructions.md';
    writeFileSync(join(cwd, instructionsPath), 'File instruction.\n', 'utf8');

    const identityLine = 'You are "mybot", a personal OpenCode agent running over WhatsApp.';
    const sm = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      onEvent: () => undefined,
      instanceName: 'mybot',
      cwd,
      configSystemPrompt: `${identityLine}\nConfigured instruction.`,
      instructionsPath,
      provider: 'opencode-cli',
    });

    const prompt = sm.buildSystemPrompt();

    expect(prompt).toContain('Configured instruction.');
    expect(prompt).toContain('File instruction.');
    expect(prompt.indexOf('Configured instruction.')).toBeLessThan(prompt.indexOf('File instruction.'));
    expect(prompt.match(new RegExp(identityLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1);
  });

  it('#3149: includes the degraded-capabilities block only when the runtime supplies one', () => {
    const cwd = makeTempRoot();
    const block = 'DEGRADED CAPABILITIES — no child process this conversation.';
    const base = {
      db: makeDb(),
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      onEvent: () => undefined,
      instanceName: 'mybot',
      cwd,
      configSystemPrompt: 'Configured instruction.',
      provider: 'openai-api',
    } as const;

    const degraded = new SessionManager({ ...base, degradedCapabilitiesBlock: () => block });
    const normal = new SessionManager({ ...base });
    const nullBlock = new SessionManager({ ...base, degradedCapabilitiesBlock: () => null });

    const degradedPrompt = degraded.buildSystemPrompt();
    expect(degradedPrompt).toContain(block);
    // The degradation fact precedes the configured persona so it cannot be
    // buried under instance instructions.
    expect(degradedPrompt.indexOf(block)).toBeLessThan(degradedPrompt.indexOf('Configured instruction.'));
    // Non-degraded prompts stay byte-identical whether the option is absent or
    // returns null.
    expect(normal.buildSystemPrompt()).toBe(nullBlock.buildSystemPrompt());
    expect(normal.buildSystemPrompt()).not.toContain('DEGRADED CAPABILITIES');
  });

  it('fails closed when a configured instructionsPath is missing', () => {
    const cwd = makeTempRoot();
    const instructionsPath = `no-such-instructions-${randomUUID()}.md`;
    const expectedPath = join(cwd, instructionsPath);
    const sm = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      onEvent: () => undefined,
      cwd,
      instructionsPath,
    });

    let thrown: unknown;
    try {
      sm.buildSystemPrompt();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toContain(expectedPath);
    expect(String(thrown)).toContain('ENOENT');
  });

  it('boots without instructionsPath and leaves native CLAUDE.md discovery to the agent runtime', () => {
    const cwd = makeTempRoot();
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, 'CLAUDE.md'), 'CLAUDE discovery should stay native.', 'utf8');

    const sm = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      onEvent: () => undefined,
      cwd,
    });

    const prompt = sm.buildSystemPrompt();

    expect(prompt).toContain('Working directory:');
    expect(prompt).not.toContain('CLAUDE discovery should stay native.');
  });

  it('adds WhatsApp poll decision guidance to the transport prelude', () => {
    const sm = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      onEvent: () => undefined,
      cwd: '/mock/home',
    });

    const prompt = sm.buildSystemPrompt();

    expect(prompt).toContain('For bounded user decisions that block progress, use AskUserQuestion when available');
    expect(prompt).toContain('Use multiSelect: true when the user may choose more than one option');
    expect(prompt).toContain('For non-blocking surveys or lightweight coordination, use send_poll');
    expect(prompt).toContain('Do not ask the user to type "I voted"');
    expect(prompt).toContain('AskUserQuestion works in both DMs and groups. In groups, first vote resolves by default.');
    expect(prompt).toContain('send_poll supports resolution strategies: first-vote-wins (default), admin-only, admin-wins, majority-after-timeout.');
    expect(prompt).toContain('send_poll supports awaitResult: true to block and wait for the poll result.');
  });

  it('adds the background-task delivery protocol to the transport prelude', () => {
    const sm = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      onEvent: () => undefined,
      cwd: '/mock/home',
    });

    const prompt = sm.buildSystemPrompt();

    expect(prompt).toContain('reply text emitted after your turn ends is dropped by the transport');
    expect(prompt).toContain('deliver its result with the MCP send_message tool');
    expect(prompt).toContain('do not also restate a result you already delivered via send_message');
    expect(prompt).toContain('Never say work is dispatched or running unless the dispatching tool call happened in the same turn');
  });

  it('keeps the no-extra-instructions prompt within the recorded byte budget', () => {
    const sm = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      onEvent: () => undefined,
      cwd: '/mock/home',
    });

    const prompt = sm.buildSystemPrompt();

    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(BASE_TRANSPORT_PROMPT_BYTES + 50);
  });

  it('injects handoffSystemBlock content after the transport prelude when callback returns a string', () => {
    const UNIQUE_MARKER = 'HANDOFF-SUMMARY-MARKER-7f3a2b9c';
    const sm = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      onEvent: () => undefined,
      cwd: '/mock/home',
      handoffSystemBlock: () => `Context from previous session: ${UNIQUE_MARKER}`,
    });

    const prompt = sm.buildSystemPrompt();

    expect(prompt).toContain(UNIQUE_MARKER);
    // The marker must appear AFTER the transport prelude opener line.
    const transportPreludeEnd = prompt.indexOf('agent running over WhatsApp');
    expect(transportPreludeEnd).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf(UNIQUE_MARKER)).toBeGreaterThan(transportPreludeEnd);
  });

  it('produces byte-identical output whether handoffSystemBlock is absent or returns null', () => {
    const smNoCallback = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      onEvent: () => undefined,
      cwd: '/mock/home',
    });
    const smNullCallback = new SessionManager({
      db: makeDb(),
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      onEvent: () => undefined,
      cwd: '/mock/home',
      handoffSystemBlock: () => null,
    });

    expect(smNoCallback.buildSystemPrompt()).toBe(smNullCallback.buildSystemPrompt());
  });
});

// The runtime decides whether a session gets memory guidance (see
// memory-guidance-runtime.test.ts); these cases pin that a supplied block
// reaches the model on both prompt paths: the claude-cli argument and the
// anthropic-api request body.
describe('SessionManager memory guidance block', () => {
  const MEMORY_MARKER = 'MEMORY-GUIDANCE-MARKER-4c1e';
  const originalApiKey = process.env['ANTHROPIC_API_KEY'];

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalApiKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = originalApiKey;
  });

  function sessionFor(provider: 'claude-cli' | 'anthropic-api', block?: () => string | null): SessionManager {
    return new SessionManager({
      db: makeDb(),
      messenger: makeMessenger(),
      chatJid: CHAT_JID,
      onEvent: () => undefined,
      instanceName: 'mybot',
      cwd: '/mock/home',
      configSystemPrompt: 'Configured instruction.',
      provider,
      ...(block ? { memoryGuidanceBlock: block } : {}),
    });
  }

  it('claude-cli: the block reaches --append-system-prompt ahead of the configured prompt', () => {
    const prompt = sessionFor('claude-cli', () => MEMORY_MARKER).buildSystemPrompt();
    const args = __provider_switch_for_test.getProviderArgs('claude-cli', prompt, '/mock/home', undefined, 'model', []);
    const appended = args[args.indexOf('--append-system-prompt') + 1] ?? '';

    expect(appended).toContain(MEMORY_MARKER);
    expect(appended.indexOf(MEMORY_MARKER)).toBeLessThan(appended.indexOf('Configured instruction.'));
  });

  it('anthropic-api: the block reaches the request system field', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('socket hang up'));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new AnthropicApiProvider();
    await provider.initialize({
      cwd: '/tmp',
      systemPrompt: sessionFor('anthropic-api', () => MEMORY_MARKER).buildSystemPrompt(),
      instanceName: 'mybot',
      onEvent: () => undefined,
      onCrash: () => undefined,
    });

    await provider.sendTurn({ role: 'user', conversationKey: 'memory-guidance', parts: [{ kind: 'text', text: 'hello' }] });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as { system: string };
    expect(body.system).toContain(MEMORY_MARKER);
  });

  it('keeps the prompt byte-identical when the block is absent or null', () => {
    for (const provider of ['claude-cli', 'anthropic-api'] as const) {
      const absent = sessionFor(provider).buildSystemPrompt();
      expect(sessionFor(provider, () => null).buildSystemPrompt()).toBe(absent);
      expect(absent).not.toContain('memory_write');
    }
  });
});
