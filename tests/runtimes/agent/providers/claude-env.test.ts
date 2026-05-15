import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { FAILCLOSED_FLAG } from '../../../../src/runtimes/agent/providers/child-env.ts';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('../../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

import { ClaudeProvider } from '../../../../src/runtimes/agent/providers/claude.ts';

function makeChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdin: EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = 123;
  child.stdin = new EventEmitter() as typeof child.stdin;
  child.stdin.write = vi.fn();
  child.stdin.end = vi.fn();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

async function initializeProvider(allowM365Mutations?: boolean): Promise<NodeJS.ProcessEnv> {
  const provider = new ClaudeProvider();
  await provider.initialize({
    cwd: '/tmp/whatsoup-provider',
    systemPrompt: 'system prompt',
    instanceName: 'test',
    onEvent: vi.fn(),
    onCrash: vi.fn(),
    allowM365Mutations,
  });
  return (spawnMock.mock.calls.at(-1)?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env ?? {};
}

describe('ClaudeProvider child env', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    spawnMock.mockReturnValue(makeChild());
    for (const key of ['ALLOW_M365_MUTATIONS', FAILCLOSED_FLAG]) {
      savedEnv[key] = process.env[key];
    }
    process.env.ALLOW_M365_MUTATIONS = '1';
    process.env[FAILCLOSED_FLAG] = '1';
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('passes allowM365Mutations into the Claude child env allowlist', async () => {
    const env = await initializeProvider(true);

    expect(env).toHaveProperty('ALLOW_M365_MUTATIONS', '1');
  });

  it('drops ALLOW_M365_MUTATIONS from Claude child env when the provider option is omitted', async () => {
    const env = await initializeProvider();

    expect(env).not.toHaveProperty('ALLOW_M365_MUTATIONS');
  });
});
