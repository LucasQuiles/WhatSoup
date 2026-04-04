import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Database } from '../../../../src/core/database.ts';
import type { Messenger } from '../../../../src/core/types.ts';
import { Database as SqliteDatabase } from '../../../../src/core/database.ts';
import { ToolRegistry } from '../../../../src/mcp/registry.ts';
import { registerAllTools } from '../../../../src/mcp/register-all.ts';
import { PresenceCache } from '../../../../src/transport/presence-cache.ts';
import {
  generateMcpConfigFile,
  getMcpStrategy,
} from '../../../../src/runtimes/agent/providers/mcp-bridge.ts';

vi.mock('../../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/tmp/whatsoup-test-home'),
  userInfo: vi.fn(() => ({ username: 'testuser' })),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
  };
});

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../../../src/runtimes/agent/session-db.ts', () => ({
  createSession: vi.fn(() => 42),
  incrementMessageCount: vi.fn(),
  updateSessionId: vi.fn(),
  updateSessionStatus: vi.fn(),
  updateTranscriptPath: vi.fn(),
}));

import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { SessionManager } from '../../../../src/runtimes/agent/session.ts';

type ProviderId = 'claude-cli' | 'codex-cli' | 'gemini-cli';
type ScenarioKind = 'memory' | 'system-prompt';

interface ProviderConfig {
  id: ProviderId;
  binary: string;
  resumeArgs: string[];
  sessionId: string;
}

const PROVIDERS: ProviderConfig[] = [
  {
    id: 'claude-cli',
    binary: 'claude',
    resumeArgs: [],
    sessionId: 'claude-session-1',
  },
  {
    id: 'codex-cli',
    binary: 'codex',
    resumeArgs: [],
    sessionId: 'codex-session-1',
  },
  {
    id: 'gemini-cli',
    binary: 'gemini',
    resumeArgs: ['--resume', 'gemini-session-1'],
    sessionId: 'gemini-session-1',
  },
];

interface MockChild extends EventEmitter {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  kill: ReturnType<typeof vi.fn>;
  binary: string;
  args: string[];
  options: Record<string, unknown>;
}

interface SessionState {
  name: string | null;
}

function makeDb(): Database {
  return {
    raw: {
      prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn() })),
      exec: vi.fn(),
    },
  } as unknown as Database;
}

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
  };
}

function makeConnection() {
  return {
    contactsDir: { contacts: new Map() },
    presenceCache: new PresenceCache(),
    getSocket: () => null,
    sendRaw: async () => ({ waMessageId: null }),
    sendMedia: async () => ({ waMessageId: null }),
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class ProviderHarness {
  readonly spawnCalls: Array<{ binary: string; args: string[] }> = [];

  private readonly sessions = new Map<string, SessionState>();
  private nextPid = 1000;
  /** Codex app-server baseInstructions, captured from thread/start params. */
  private _baseInstructions: string | null = null;

  constructor(
    private readonly provider: ProviderConfig,
    private readonly scenario: ScenarioKind,
  ) {}

  spawn(binary: string, args: string[], options: Record<string, unknown>): MockChild {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const stdin = new EventEmitter() as MockChild['stdin'];
    const child = new EventEmitter() as MockChild;
    child.pid = this.nextPid++;
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = stdin;
    child.kill = vi.fn();
    child.binary = binary;
    child.args = args;
    child.options = options;

    this.spawnCalls.push({ binary, args });

    stdin.write = vi.fn((data: unknown, _enc: unknown, cb?: (err?: Error | null) => void) => {
      const raw = String(data).trim();
      const payload = JSON.parse(raw) as Record<string, unknown>;

      if (this.provider.id === 'codex-cli') {
        // Handle JSON-RPC requests from the Codex persistent adapter
        const method = payload['method'] as string | undefined;
        if (method === 'initialize') {
          // Respond with initialize result
          queueMicrotask(() => {
            this.emitLine(child, JSON.stringify({
              jsonrpc: '2.0',
              id: payload['id'],
              result: { userAgent: 'codex/0.118.0', codexHome: '/tmp/.codex', platformFamily: 'unix', platformOs: 'linux' },
            }));
          });
          cb?.(null);
          return true;
        }
        if (method === 'thread/start') {
          // Respond with thread and emit thread/started notification
          queueMicrotask(() => {
            const thread = {
              id: this.provider.sessionId,
              preview: '', ephemeral: false, modelProvider: 'openai',
              createdAt: 0, updatedAt: 0, status: 'idle', path: null,
              cwd: '/tmp', cliVersion: '0.118.0', source: 'app-server',
              agentNickname: null, agentRole: null, gitInfo: null, name: null, turns: [],
            };
            this.emitLine(child, JSON.stringify({
              jsonrpc: '2.0',
              method: 'thread/started',
              params: { thread },
            }));
            this.emitLine(child, JSON.stringify({
              jsonrpc: '2.0',
              id: payload['id'],
              result: thread,
            }));
          });
          // Capture baseInstructions as the system prompt for this session
          const params = payload['params'] as Record<string, unknown> | undefined;
          if (params?.['baseInstructions']) {
            this._baseInstructions = String(params['baseInstructions']);
          }
          cb?.(null);
          return true;
        }
        if (method === 'turn/start') {
          // Extract text from the turn/start input array
          const params = payload['params'] as Record<string, unknown>;
          const input = params['input'] as Array<{ type: string; text?: string }>;
          const text = input?.find((i) => i.type === 'text')?.text ?? '';
          const systemPrompt = this._baseInstructions ?? '';
          queueMicrotask(() => this.runTurn(child, text, undefined, systemPrompt));
          cb?.(null);
          return true;
        }
        // Unknown Codex request — ignore
        cb?.(null);
        return true;
      }

      // Claude-cli: stream-json user message
      const text = ((payload as { message?: { content?: Array<{ text?: string }> } }).message?.content?.[0]?.text) ?? '';
      queueMicrotask(() => this.runTurn(child, text, undefined, this.extractSystemPrompt(args)));
      cb?.(null);
      return true;
    });

    stdin.end = vi.fn(() => {
      queueMicrotask(() => {
        const resumeSessionId = this.extractResumeSessionId(args);
        const text = this.extractPromptText(args);
        this.runTurn(child, text, resumeSessionId, this.extractSystemPrompt(args));
      });
    });

    // Persistent providers: emit init event immediately after spawn
    if (this.provider.id === 'claude-cli') {
      queueMicrotask(() => {
        this.emitLine(child, this.buildInitEvent(this.provider.sessionId));
      });
    }
    // Codex init is handled via stdin.write (initialize + thread/start requests)

    return child;
  }

  private runTurn(
    child: MockChild,
    text: string,
    resumeSessionId: string | undefined,
    systemPrompt: string,
  ): void {
    const sessionId = resumeSessionId ?? this.provider.sessionId;
    const state = this.sessions.get(sessionId) ?? { name: null };
    this.sessions.set(sessionId, state);

    // Spawn-per-turn providers emit init events per turn
    const isPersistent = this.provider.id === 'claude-cli' || this.provider.id === 'codex-cli';
    if (!isPersistent) {
      this.emitLine(child, this.buildInitEvent(sessionId));
    }

    if (this.scenario === 'memory') {
      this.handleMemoryScenario(child, text, state);
    } else {
      this.handleSystemPromptScenario(child, systemPrompt);
    }

    this.emitLine(child, this.buildResultEvent());

    // Spawn-per-turn providers exit after each turn
    if (!isPersistent) {
      child.emit('exit', 0, null);
    }
  }

  private handleMemoryScenario(child: MockChild, rawText: string, state: SessionState): void {
    const text = this.extractUserText(rawText);
    const nameMatch = text.match(/my name is ([a-z]+)\.?/i);
    if (nameMatch) {
      state.name = nameMatch[1]!;
      this.emitLine(child, this.buildAssistantTextEvent(`I will remember that your name is ${state.name}.`));
      return;
    }

    if (/what is my name\??/i.test(text)) {
      const response = state.name
        ? `Your name is ${state.name}.`
        : 'I do not know your name.';
      this.emitLine(child, this.buildAssistantTextEvent(response));
      return;
    }

    this.emitLine(child, this.buildAssistantTextEvent('Unhandled turn.'));
  }

  private handleSystemPromptScenario(child: MockChild, systemPrompt: string): void {
    const adhered = systemPrompt.includes('Always answer with the exact word BLUE.');
    this.emitLine(child, this.buildAssistantTextEvent(adhered ? 'BLUE' : 'RED'));
  }

  private extractResumeSessionId(args: string[]): string | undefined {
    if (this.provider.id === 'codex-cli') {
      const resumeIndex = args.indexOf('resume');
      return resumeIndex >= 0 ? args[resumeIndex + 1] : undefined;
    }
    if (this.provider.id === 'gemini-cli') {
      const resumeIndex = args.indexOf('--resume');
      return resumeIndex >= 0 ? args[resumeIndex + 1] : undefined;
    }
    return undefined;
  }

  private extractPromptText(args: string[]): string {
    if (this.provider.id === 'codex-cli') {
      return args[args.length - 1] ?? '';
    }
    if (this.provider.id === 'gemini-cli') {
      const promptIndex = args.indexOf('-p');
      return promptIndex >= 0 ? (args[promptIndex + 1] ?? '') : '';
    }
    return '';
  }

  private extractSystemPrompt(args: string[]): string {
    if (this.provider.id === 'claude-cli') {
      const promptIndex = args.indexOf('--system-prompt');
      return promptIndex >= 0 ? (args[promptIndex + 1] ?? '') : '';
    }

    if (this.provider.id === 'codex-cli') {
      // Codex app-server: system prompt is sent via baseInstructions
      // in thread/start, not as CLI args. Return empty; the harness
      // captures it separately in _baseInstructions.
      return '';
    }

    const prompt = this.extractPromptText(args);
    const systemMatch = prompt.match(/System instructions:\n([\s\S]*?)\n\nUser message:/);
    return systemMatch?.[1] ?? '';
  }

  private extractUserText(prompt: string): string {
    const wrapped = prompt.match(/User message:\n([\s\S]*)$/);
    return wrapped?.[1] ?? prompt;
  }

  private emitLine(child: MockChild, line: string): void {
    child.stdout.emit('data', Buffer.from(`${line}\n`, 'utf8'));
  }

  private buildInitEvent(sessionId: string): string {
    switch (this.provider.id) {
      case 'claude-cli':
        return JSON.stringify({
          type: 'system',
          subtype: 'init',
          session_id: sessionId,
        });
      case 'codex-cli':
        return JSON.stringify({
          type: 'thread.started',
          thread_id: sessionId,
        });
      case 'gemini-cli':
        return JSON.stringify({
          type: 'init',
          session_id: sessionId,
        });
    }
  }

  private buildAssistantTextEvent(text: string): string {
    switch (this.provider.id) {
      case 'claude-cli':
        return JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text }] },
        });
      case 'codex-cli':
        return JSON.stringify({
          jsonrpc: '2.0',
          method: 'item/completed',
          params: {
            threadId: this.provider.sessionId,
            turnId: 'turn-1',
            item: { type: 'agentMessage', id: 'msg-1', text, phase: null, memoryCitation: null },
          },
        });
      case 'gemini-cli':
        return JSON.stringify({
          type: 'message',
          role: 'assistant',
          delta: true,
          text,
        });
    }
  }

  private buildResultEvent(): string {
    switch (this.provider.id) {
      case 'claude-cli':
        return JSON.stringify({
          type: 'result',
          is_error: false,
          usage: { input_tokens: 12, output_tokens: 6 },
        });
      case 'codex-cli':
        return JSON.stringify({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: {
            threadId: this.provider.sessionId,
            turn: { id: 'turn-1', items: [], status: 'completed', error: null },
          },
        });
      case 'gemini-cli':
        return JSON.stringify({
          type: 'result',
          status: 'success',
          stats: { input_tokens: 12, output_tokens: 6 },
        });
    }
  }
}

function createSession(provider: ProviderId, overrides: Partial<ConstructorParameters<typeof SessionManager>[0]> = {}) {
  const events: string[] = [];
  const eventLog: Array<Record<string, unknown>> = [];
  const session = new SessionManager({
    db: makeDb(),
    messenger: makeMessenger(),
    chatJid: 'agent@s.whatsapp.net',
    onEvent: (event) => {
      eventLog.push(event as unknown as Record<string, unknown>);
      if (event.type === 'assistant_text') {
        events.push(event.text);
      }
    },
    provider,
    instanceName: 'conformance',
    notifyUser: vi.fn(),
    ...overrides,
  });

  return { session, assistantTexts: events, eventLog };
}

describe('agent provider conformance', () => {
  let activeHarness: ProviderHarness | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readFileSync).mockReturnValue('Always answer with the exact word BLUE.');
    vi.mocked(spawn).mockImplementation((binary, args, options) => {
      if (!activeHarness) {
        throw new Error('ProviderHarness was not configured for this test.');
      }
      return activeHarness.spawn(
        binary as string,
        (args as string[] | undefined) ?? [],
        (options as Record<string, unknown> | undefined) ?? {},
      ) as never;
    });
  });

  afterEach(() => {
    activeHarness = null;
  });

  describe.each(PROVIDERS)('$id', (provider) => {
    it('supports multi-turn memory recall', async () => {
      activeHarness = new ProviderHarness(provider, 'memory');
      const { session, assistantTexts } = createSession(provider.id);

      await session.spawnSession();
      await flushMicrotasks();
      await session.sendTurn('My name is Taylor.');
      await flushMicrotasks();
      await session.sendTurn('What is my name?');
      await flushMicrotasks();

      expect(assistantTexts).toContain('I will remember that your name is Taylor.');
      expect(assistantTexts).toContain('Your name is Taylor.');
    });

    it('preserves the same logical session across turns', async () => {
      activeHarness = new ProviderHarness(provider, 'memory');
      const { session } = createSession(provider.id);

      await session.spawnSession();
      await flushMicrotasks();
      await session.sendTurn('My name is Taylor.');
      await flushMicrotasks();

      const statusAfterFirstTurn = session.getStatus();
      await session.sendTurn('What is my name?');
      await flushMicrotasks();

      const statusAfterSecondTurn = session.getStatus();

      const isPersistent = provider.id === 'claude-cli' || provider.id === 'codex-cli';
      if (isPersistent) {
        // Persistent providers use a single subprocess for all turns
        expect(activeHarness.spawnCalls).toHaveLength(1);
        expect(statusAfterFirstTurn.sessionId).toBe(provider.sessionId);
        expect(statusAfterSecondTurn.sessionId).toBe(provider.sessionId);
      } else {
        // Spawn-per-turn providers create a new process for each turn
        expect(activeHarness.spawnCalls).toHaveLength(2);
        expect(activeHarness.spawnCalls[1]?.args).toEqual(expect.arrayContaining(provider.resumeArgs));
        expect(statusAfterFirstTurn.sessionId).toBe(provider.sessionId);
        expect(statusAfterSecondTurn.sessionId).toBe(provider.sessionId);
      }
    });

    it('honors the system prompt contract', async () => {
      activeHarness = new ProviderHarness(provider, 'system-prompt');
      const { session, assistantTexts } = createSession(provider.id, {
        instructionsPath: 'instructions.md',
      });

      await session.spawnSession();
      await flushMicrotasks();
      await session.sendTurn('Respond with the compliance color.');
      await flushMicrotasks();

      expect(assistantTexts.at(-1)).toBe('BLUE');

      const lastSpawn = activeHarness.spawnCalls.at(-1);
      if (provider.id === 'claude-cli') {
        expect(lastSpawn?.args).toEqual(
          expect.arrayContaining([
            '--system-prompt',
            expect.stringContaining('Always answer with the exact word BLUE.'),
          ]),
        );
      } else if (provider.id === 'codex-cli') {
        // Codex app-server: system prompt is sent as baseInstructions
        // in the thread/start JSON-RPC request, not as a CLI arg.
        // The harness captures it and the test verifies the response.
        // If BLUE was returned, the system prompt was correctly forwarded.
        expect(assistantTexts.at(-1)).toBe('BLUE');
      } else {
        const serializedArgs = (lastSpawn?.args ?? []).join('\n');
        expect(serializedArgs).toContain('Always answer with the exact word BLUE.');
      }
    });

    it('exposes the registered MCP tool catalog to the provider bridge', () => {
      const db = new SqliteDatabase(':memory:');
      db.open();

      try {
        const registry = new ToolRegistry();
        registerAllTools(registry, makeConnection() as never, db);

        const tools = registry.listTools({ tier: 'global' });
        const config = generateMcpConfigFile(provider.id, '/tmp/whatsoup.sock', '/tmp/proxy.ts');

        expect(getMcpStrategy(provider.id)).toBe('config_file');
        expect(config).not.toBeNull();
        expect((config as { mcpServers: Record<string, unknown> }).mcpServers.whatsoup).toBeDefined();
        expect(tools.length).toBeGreaterThanOrEqual(100);
        expect(tools.map((tool) => tool.name)).toEqual(
          expect.arrayContaining(['send_message', 'list_chats']),
        );
      } finally {
        db.raw.close();
      }
    });
  });
});
