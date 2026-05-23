import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { SessionManager } from '../../../src/runtimes/agent/session.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';

const CHAT_JID = 'test@s.whatsapp.net';
const BASE_TRANSPORT_PROMPT_BYTES = 800;

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'whatsoup-session-prompt-'));
  tempRoots.push(root);
  return root;
}

function makeDb(): Database {
  return {
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

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

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
});
