import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, warnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('../../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: warnMock,
  }),
}));

import { ClaudeProvider } from '../../../../src/runtimes/agent/providers/claude.ts';
import type { ProviderSessionOptions } from '../../../../src/runtimes/agent/providers/types.ts';

type MockChild = EventEmitter & {
  pid: number;
  stdin: EventEmitter & {
    write: ReturnType<typeof vi.fn>;
  };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function makeChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.pid = 4242;
  child.stdin = new EventEmitter() as MockChild['stdin'];
  child.stdin.write = vi.fn((_payload: string, _encoding: string, callback: (err?: Error | null) => void) => {
    callback(null);
  });
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

function makeOptions(overrides: Partial<ProviderSessionOptions> = {}): ProviderSessionOptions {
  return {
    cwd: '/tmp/whatsoup-provider',
    systemPrompt: 'system prompt',
    instanceName: 'test',
    onEvent: vi.fn(),
    onCrash: vi.fn(),
    ...overrides,
  };
}

describe('ClaudeProvider lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnMock.mockReturnValue(makeChild());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('spawns Claude with model, plugin dirs, resume checkpoint, and stream-json flags', async () => {
    const provider = new ClaudeProvider();
    await provider.initialize(
      makeOptions({
        model: 'claude-test-model',
        pluginDirs: ['/tmp/plugin-a', '/tmp/plugin-b'],
      }),
      {
        providerKind: 'claude-cli',
        executionMode: 'persistent_session',
        conversationRef: 'resume-session',
        runtimeHandle: { kind: 'none' },
        transcriptLocator: { kind: 'none' },
        providerState: {},
      },
    );

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining([
        '-p',
        '--verbose',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--permission-mode',
        'bypassPermissions',
        '--system-prompt',
        'system prompt',
        '--model',
        'claude-test-model',
        '--plugin-dir',
        '/tmp/plugin-a',
        '--plugin-dir',
        '/tmp/plugin-b',
        '--resume',
        'resume-session',
      ]),
      expect.objectContaining({ cwd: '/tmp/whatsoup-provider' }),
    );
  });

  it('does not spawn a second child when initialized while active', async () => {
    const provider = new ClaudeProvider();

    await provider.initialize(makeOptions());
    await provider.initialize(makeOptions({ systemPrompt: 'ignored second prompt' }));

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('parses stdout lines, buffers partial lines, and records the session checkpoint', async () => {
    const provider = new ClaudeProvider();
    const child = makeChild();
    const onEvent = vi.fn();
    spawnMock.mockReturnValueOnce(child);

    await provider.initialize(makeOptions({ onEvent }));

    child.stdout.emit('data', Buffer.from('\n{"type":"system","subtype":"init","session_id":"session-1"}\n{"type":"assistant","message":{"content":[{"type":"text","text":"hel'));
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({ type: 'init', sessionId: 'session-1' });

    child.stdout.emit('data', Buffer.from('lo"}]}}\n'));

    expect(onEvent).toHaveBeenCalledWith({ type: 'assistant_text', text: 'hello' });
    expect(provider.getCheckpoint()).toEqual(expect.objectContaining({
      providerKind: 'claude-cli',
      executionMode: 'persistent_session',
      conversationRef: 'session-1',
      runtimeHandle: { kind: 'pid', pid: 4242 },
      transcriptLocator: expect.objectContaining({
        kind: 'file',
        path: expect.stringContaining('session-1.jsonl'),
      }),
      providerState: {},
    }));
  });

  it('reports spawn errors through crash metadata and clears active state', async () => {
    const provider = new ClaudeProvider();
    const child = makeChild();
    const onCrash = vi.fn();
    spawnMock.mockReturnValueOnce(child);

    await provider.initialize(makeOptions({ onCrash }));
    child.emit('error', new Error('claude ENOENT'));

    expect(onCrash).toHaveBeenCalledWith(expect.objectContaining({
      exitCode: null,
      signal: null,
      provider: 'claude-cli',
      crashClass: 'provider_binary_missing',
      stderrPreview: 'claude ENOENT',
    }));
    expect(provider.isActive()).toBe(false);
    expect(provider.getCheckpoint().runtimeHandle).toEqual({ kind: 'none' });
  });

  it('records stderr previews, redacts sensitive text, and ignores empty chunks', async () => {
    const provider = new ClaudeProvider();
    const child = makeChild();
    const onCrash = vi.fn();
    spawnMock.mockReturnValueOnce(child);

    await provider.initialize(makeOptions({ onCrash }));
    child.stderr.emit('data', Buffer.from('auth_token=super-secret-token auth required'));

    expect(warnMock).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'claude-cli',
      pid: 4242,
      stderrPreview: expect.stringContaining('auth_token=[REDACTED]'),
    }), 'claude stderr');
    expect(String(warnMock.mock.calls.at(-1)?.[0]?.stderrPreview)).not.toContain('super-secret-token');

    const warningCount = warnMock.mock.calls.length;
    child.stderr.emit('data', Buffer.from('   \n'));
    expect(warnMock).toHaveBeenCalledTimes(warningCount);

    (child as unknown as { pid?: number }).pid = undefined;
    child.stderr.emit('data', Buffer.from('second stderr line'));
    expect(warnMock).toHaveBeenLastCalledWith(expect.objectContaining({
      provider: 'claude-cli',
      pid: null,
      stderrPreview: expect.stringContaining('second stderr line'),
    }), 'claude stderr');

    child.emit('exit', 1, null);
    expect(onCrash).toHaveBeenCalledWith(expect.objectContaining({
      exitCode: 1,
      signal: null,
      provider: 'claude-cli',
      crashClass: 'provider_auth_required',
      stderrPreview: expect.stringContaining('auth required'),
    }));
  });

  it('writes only text parts to Claude stdin as stream-json user messages', async () => {
    const provider = new ClaudeProvider();
    const child = makeChild();
    spawnMock.mockReturnValueOnce(child);
    await provider.initialize(makeOptions());

    await provider.sendTurn({
      role: 'user',
      conversationKey: 'chat',
      parts: [
        { kind: 'text', text: 'line one' },
        { kind: 'image', mimeType: 'image/png', filePath: '/tmp/image.png' },
        { kind: 'text', text: 'line two' },
      ],
    });

    expect(child.stdin.write).toHaveBeenCalledTimes(1);
    const payload = String(child.stdin.write.mock.calls[0]?.[0]).trim();
    expect(JSON.parse(payload)).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'line one\nline two' }],
      },
    });
  });

  it('rejects sendTurn when there is no active child or stdin is unavailable', async () => {
    const provider = new ClaudeProvider();
    await expect(provider.sendTurn({
      role: 'user',
      conversationKey: 'chat',
      parts: [{ kind: 'text', text: 'hello' }],
    })).rejects.toThrow('No active session');

    const child = makeChild();
    (child as unknown as { stdin: null }).stdin = null;
    spawnMock.mockReturnValueOnce(child);
    await provider.initialize(makeOptions());

    await expect(provider.sendTurn({
      role: 'user',
      conversationKey: 'chat',
      parts: [{ kind: 'text', text: 'hello' }],
    })).rejects.toThrow('Child process stdin is not available');
  });

  it('rejects sendTurn write errors and timeouts', async () => {
    const writeErrorProvider = new ClaudeProvider();
    const writeErrorChild = makeChild();
    writeErrorChild.stdin.write = vi.fn((_payload: string, _encoding: string, callback: (err?: Error | null) => void) => {
      callback(new Error('pipe closed'));
    });
    spawnMock.mockReturnValueOnce(writeErrorChild);
    await writeErrorProvider.initialize(makeOptions());

    await expect(writeErrorProvider.sendTurn({
      role: 'user',
      conversationKey: 'chat',
      parts: [{ kind: 'text', text: 'hello' }],
    })).rejects.toThrow('pipe closed');

    vi.useFakeTimers();
    const timeoutProvider = new ClaudeProvider();
    const timeoutChild = makeChild();
    timeoutChild.stdin.write = vi.fn();
    spawnMock.mockReturnValueOnce(timeoutChild);
    await timeoutProvider.initialize(makeOptions());

    const pending = timeoutProvider.sendTurn({
      role: 'user',
      conversationKey: 'chat',
      parts: [{ kind: 'text', text: 'hello' }],
    });
    const assertion = expect(pending).rejects.toThrow('STDIN_WRITE_TIMEOUT');
    await vi.advanceTimersByTimeAsync(30_000);

    await assertion;
  });

  it('drains buffered stdout on unexpected exit and reports crash metadata', async () => {
    const provider = new ClaudeProvider();
    const child = makeChild();
    const onEvent = vi.fn();
    const onCrash = vi.fn();
    spawnMock.mockReturnValueOnce(child);
    await provider.initialize(makeOptions({ onEvent, onCrash }));

    (provider as unknown as { stdoutBuffer: string }).stdoutBuffer =
      '   \n{"type":"assistant","message":{"content":[{"type":"text","text":"final"}]}}';
    child.emit('exit', 2, 'SIGTERM');

    expect(onEvent).toHaveBeenCalledWith({ type: 'assistant_text', text: 'final' });
    expect(onCrash).toHaveBeenCalledWith(expect.objectContaining({
      exitCode: 2,
      signal: 'SIGTERM',
      provider: 'claude-cli',
    }));
    expect(provider.isActive()).toBe(false);
    expect(provider.getCheckpoint().runtimeHandle).toEqual({ kind: 'none' });
  });

  it('ignores superseded and inactive child exits', async () => {
    const provider = new ClaudeProvider();
    const child = makeChild();
    const onCrash = vi.fn();
    spawnMock.mockReturnValueOnce(child);

    await provider.initialize(makeOptions({ onCrash }));

    (provider as unknown as { child: MockChild }).child = makeChild();
    child.emit('exit', 1, null);
    expect(onCrash).not.toHaveBeenCalled();

    (provider as unknown as { child: MockChild; active: boolean }).child = child;
    (provider as unknown as { active: boolean }).active = false;
    child.emit('exit', 0, null);
    expect(onCrash).not.toHaveBeenCalled();
  });

  it('suppresses crash callbacks for clean shutdown and kill paths', async () => {
    const shutdownProvider = new ClaudeProvider();
    const shutdownChild = makeChild();
    const shutdownCrash = vi.fn();
    spawnMock.mockReturnValueOnce(shutdownChild);
    await shutdownProvider.initialize(makeOptions({ onCrash: shutdownCrash }));

    await shutdownProvider.shutdown('end');
    shutdownChild.emit('exit', 0, null);

    expect(shutdownChild.kill).toHaveBeenCalledWith('SIGTERM');
    expect(shutdownCrash).not.toHaveBeenCalled();
    expect(shutdownProvider.isActive()).toBe(false);

    const killProvider = new ClaudeProvider();
    const killChild = makeChild();
    const killCrash = vi.fn();
    spawnMock.mockReturnValueOnce(killChild);
    await killProvider.initialize(makeOptions({ onCrash: killCrash }));

    killProvider.kill();
    killChild.emit('exit', null, 'SIGKILL');

    expect(killChild.kill).toHaveBeenCalledWith('SIGKILL');
    expect(killCrash).not.toHaveBeenCalled();
    expect(killProvider.isActive()).toBe(false);

    const idleProvider = new ClaudeProvider();
    await idleProvider.shutdown('suspend');
    idleProvider.kill();
    expect(idleProvider.getCheckpoint()).toEqual(expect.objectContaining({
      runtimeHandle: { kind: 'none' },
      transcriptLocator: { kind: 'none' },
    }));
  });

  it('generates MCP config for the WhatSoup proxy socket', () => {
    const config = new ClaudeProvider().generateMcpConfig('/tmp/whatsoup.sock');

    expect(config).toEqual({
      mcpServers: {
        whatsoup: expect.objectContaining({
          env: { WHATSOUP_SOCKET: '/tmp/whatsoup.sock' },
        }),
      },
    });
  });

  it('builds the Claude child environment without forwarding unrelated provider keys', () => {
    vi.stubEnv('OPENAI_API_KEY', 'openai-test-key');
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-test-key');

    const env = new ClaudeProvider().buildEnv();

    expect(env.OPENAI_API_KEY).toBe('openai-test-key');
    expect(Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_API_KEY')).toBe(false);
  });
});
