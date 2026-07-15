import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPrimaryModelProbeAdapters } from '../../../src/runtimes/agent/providers/primary-model-usability-adapters.ts';

describe('createPrimaryModelProbeAdapters', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['binary resolver throws', () => { throw new Error('resolver failed'); }],
    ['binary resolver returns null', () => null],
  ])('maps %s to provider_unavailable', async (_label, getProviderBinary) => {
    const probeBinaryCommand = vi.fn();
    const adapters = createPrimaryModelProbeAdapters(undefined, {
      getProviderBinary,
      probeBinaryCommand,
    });

    await expect(
      adapters.probeBinaryModel?.({ provider: 'claude-cli', model: 'configured-primary' }),
    ).resolves.toEqual({ status: 'provider_unavailable' });
    expect(probeBinaryCommand).not.toHaveBeenCalled();
  });

  it('uses the default binary resolver when no resolver dependency is injected', async () => {
    const probeBinaryCommand = vi.fn();
    const adapters = createPrimaryModelProbeAdapters(undefined, {
      probeBinaryCommand,
    });

    await expect(
      adapters.probeBinaryModel?.({ provider: 'openai-api', model: 'configured-primary' }),
    ).resolves.toEqual({ status: 'provider_unavailable' });
    expect(probeBinaryCommand).not.toHaveBeenCalled();
  });

  it('forwards CLAUDE_CONFIG_DIR into the Claude CLI probe env when the parent sets it', async () => {
    const probeBinaryCommand = vi.fn(async () => ({ status: 'ok' as const, output: 'OK' }));
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = '/tmp/rachel/.claude';
    try {
      const adapters = createPrimaryModelProbeAdapters(undefined, {
        getProviderBinary: vi.fn(() => 'claude'),
        probeBinaryCommand,
      });
      await adapters.probeBinaryModel?.({ provider: 'claude-cli', model: 'claude-opus-4-8' });
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }

    expect(probeBinaryCommand).toHaveBeenCalledWith(
      'claude',
      expect.any(Array),
      expect.objectContaining({ CLAUDE_CONFIG_DIR: '/tmp/rachel/.claude' }),
      expect.objectContaining({ timeoutMs: 15_000 }),
    );
  });

  it('omits CLAUDE_CONFIG_DIR from the Claude CLI probe env when the parent does not set it', async () => {
    const probeBinaryCommand = vi.fn(async () => ({ status: 'ok' as const, output: 'OK' }));
    const prev = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      const adapters = createPrimaryModelProbeAdapters(undefined, {
        getProviderBinary: vi.fn(() => 'claude'),
        probeBinaryCommand,
      });
      await adapters.probeBinaryModel?.({ provider: 'claude-cli', model: 'claude-opus-4-8' });
    } finally {
      if (prev !== undefined) process.env.CLAUDE_CONFIG_DIR = prev;
    }

    expect(probeBinaryCommand).toHaveBeenCalledWith(
      'claude',
      expect.any(Array),
      expect.not.objectContaining({ CLAUDE_CONFIG_DIR: expect.anything() }),
      expect.objectContaining({ timeoutMs: 15_000 }),
    );
  });

  it('runs the file-store credential heal before a claude-cli probe, but not for opencode-cli', async () => {
    const probeBinaryCommand = vi.fn(async () => ({ status: 'ok' as const, output: 'OK' }));
    const ensureClaudeFileStoreCredential = vi.fn(() => ({ outcome: 'skipped-file-store-current' as const }));
    const adapters = createPrimaryModelProbeAdapters(undefined, {
      getProviderBinary: vi.fn(() => 'claude'),
      probeBinaryCommand,
      ensureClaudeFileStoreCredential,
    });

    await adapters.probeBinaryModel?.({ provider: 'claude-cli', model: 'claude-opus-4-8' });
    expect(ensureClaudeFileStoreCredential).toHaveBeenCalledTimes(1);

    await adapters.probeBinaryModel?.({ provider: 'opencode-cli', model: 'minimax/MiniMax-M3' });
    expect(ensureClaudeFileStoreCredential).toHaveBeenCalledTimes(1); // unchanged — not called for opencode
  });

  it('restoration cycle: probe recovers to ok after the heal populates the file store', async () => {
    // Model the fleet failure→recovery: probe #1 sees an unauthenticated CLI
    // (fallback would arm), then the heal populates the file store and probe #2
    // succeeds (the recovery probe returns ok → the runtime revert timer fires).
    const outputs = ['Error: invalid API key provided', 'OK'];
    const statuses = ['failed', 'ok'] as const;
    let call = 0;
    const probeBinaryCommand = vi.fn(async () => {
      const i = call++;
      return { status: statuses[i], output: outputs[i] };
    });
    const ensureClaudeFileStoreCredential = vi.fn(() => ({ outcome: 'healed' as const }));
    const adapters = createPrimaryModelProbeAdapters(undefined, {
      getProviderBinary: vi.fn(() => 'claude'),
      probeBinaryCommand,
      ensureClaudeFileStoreCredential,
    });

    await expect(
      adapters.probeBinaryModel?.({ provider: 'claude-cli', model: 'configured-primary' }),
    ).resolves.toEqual({ status: 'credential_unavailable' });
    await expect(
      adapters.probeBinaryModel?.({ provider: 'claude-cli', model: 'configured-primary' }),
    ).resolves.toEqual({ status: 'ok' });
    expect(ensureClaudeFileStoreCredential).toHaveBeenCalledTimes(2); // heal attempted before each probe
  });

  it('false-negative safety: a skipped heal does NOT mask a genuinely dead credential', async () => {
    // If the credential is truly unavailable (nothing valid to heal from), the
    // probe must still report credential_unavailable — the heal must never
    // fabricate a pass and suppress a real fallback.
    const ensureClaudeFileStoreCredential = vi.fn(() => ({ outcome: 'skipped-no-keychain-token' as const }));
    const adapters = createPrimaryModelProbeAdapters(undefined, {
      getProviderBinary: vi.fn(() => 'claude'),
      probeBinaryCommand: vi.fn(async () => ({ status: 'failed' as const, output: 'Error: invalid API key provided' })),
      ensureClaudeFileStoreCredential,
    });

    await expect(
      adapters.probeBinaryModel?.({ provider: 'claude-cli', model: 'configured-primary' }),
    ).resolves.toEqual({ status: 'credential_unavailable' });
    expect(ensureClaudeFileStoreCredential).toHaveBeenCalledTimes(1);
  });

  it('a throwing heal never breaks the probe (fail-open at the call site)', async () => {
    const probeBinaryCommand = vi.fn(async () => ({ status: 'ok' as const, output: 'OK' }));
    const ensureClaudeFileStoreCredential = vi.fn(() => { throw new Error('heal blew up'); });
    const adapters = createPrimaryModelProbeAdapters(undefined, {
      getProviderBinary: vi.fn(() => 'claude'),
      probeBinaryCommand,
      ensureClaudeFileStoreCredential,
    });

    await expect(
      adapters.probeBinaryModel?.({ provider: 'claude-cli', model: 'configured-primary' }),
    ).resolves.toEqual({ status: 'ok' });
    expect(probeBinaryCommand).toHaveBeenCalledTimes(1);
  });

  it('maps the real Claude CLI selected-model rejection through the shared binary status contract', async () => {
    const adapters = createPrimaryModelProbeAdapters(undefined, {
      getProviderBinary: vi.fn(() => 'claude'),
      probeBinaryAuthStatus: vi.fn(async () => ({
        status: 'failed' as const,
        output: "There's an issue with the selected model (configured-primary). It may not exist or you may not have access to it.",
      })),
    });

    await expect(
      adapters.probeBinaryModel?.({ provider: 'claude-cli', model: 'configured-primary' }),
    ).resolves.toEqual({ status: 'model_unavailable' });
  });

  it('probes OpenCode with a model-addressed run instead of catalog membership only', async () => {
    const probeBinaryCommand = vi.fn(async () => ({
      status: 'failed' as const,
      output: 'The model configured-primary does not exist or you do not have access to it.',
    }));
    const adapters = createPrimaryModelProbeAdapters(
      { executionProfile: 'whatsoup-headless' },
      {
        cwd: '/agent-cwd',
        buildChildEnv: vi.fn(() => ({ PATH: '/usr/bin' })),
        getProviderBinary: vi.fn(() => 'opencode'),
        probeBinaryCommand,
      },
    );

    await expect(
      adapters.probeBinaryModel?.({ provider: 'opencode-cli', model: 'configured-primary' }),
    ).resolves.toEqual({ status: 'model_unavailable' });

    expect(probeBinaryCommand).toHaveBeenCalledWith(
      'opencode',
      [
        'run', '--format', 'json', '--pure',
        '--agent', 'whatsoup-headless',
        '-m', 'configured-primary',
        'Reply with OK only.',
      ],
      expect.any(Object),
      { cwd: '/agent-cwd', timeoutMs: 15_000 },
    );
  });

  it('probes OpenCode default model (null) with -m omitted, mirroring turn argv', async () => {
    const probeBinaryCommand = vi.fn(async () => ({ status: 'ok' as const, output: 'OK' }));
    const adapters = createPrimaryModelProbeAdapters(undefined, {
      cwd: '/agent-cwd',
      buildChildEnv: vi.fn(() => ({ PATH: '/usr/bin' })),
      getProviderBinary: vi.fn(() => 'opencode'),
      probeBinaryCommand,
    });

    await expect(
      adapters.probeBinaryModel?.({ provider: 'opencode-cli', model: null }),
    ).resolves.toEqual({ status: 'ok' });

    expect(probeBinaryCommand).toHaveBeenCalledWith(
      'opencode',
      ['run', '--format', 'json', '--pure', 'Reply with OK only.'],
      expect.any(Object),
      { cwd: '/agent-cwd', timeoutMs: 15_000 },
    );
  });

  it.each([
    ['auth-required', 'Error: invalid API key provided', { status: 'credential_unavailable' }],
    ['usage-limit', 'Claude usage limit reached. Your limit will reset at 9pm.', { status: 'provider_unavailable' }],
    ['rate-limit', 'Provider rate limited request with HTTP 429.', { status: 'provider_unavailable' }],
    ['context-overflow', 'maximum context length exceeded', { status: 'unknown', reason: 'context-overflow' }],
    ['policy-block', 'Request blocked by policy.', { status: 'unknown', reason: 'policy-block' }],
    ['unclassified failure output', 'child process exited before model probe completed', { status: 'unknown', reason: 'binary-model-probe-failed' }],
    ['silent failure output', '', { status: 'provider_unavailable' }],
  ] as const)('maps CLI probe %s output through the provider taxonomy', async (_label, output, expected) => {
    const adapters = createPrimaryModelProbeAdapters(undefined, {
      getProviderBinary: vi.fn(() => 'claude'),
      probeBinaryCommand: vi.fn(async () => ({
        status: 'failed' as const,
        output,
      })),
    });

    await expect(
      adapters.probeBinaryModel?.({ provider: 'claude-cli', model: 'configured-primary' }),
    ).resolves.toEqual(expected);
  });

  it('falls back to the shared binary command probe when no probe dependency is injected', async () => {
    const adapters = createPrimaryModelProbeAdapters(undefined, {
      getProviderBinary: vi.fn(() => process.execPath),
    });

    await expect(
      adapters.probeBinaryModel?.({ provider: 'claude-cli', model: 'configured-primary' }),
    ).resolves.toEqual({ status: 'unknown', reason: 'binary-model-probe-failed' });
  });

  it('uses the default OpenCode child environment builder when no env builder is injected', async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-secret';
    const probeBinaryCommand = vi.fn(async () => ({
      status: 'ok' as const,
      output: '{"type":"message","role":"assistant","content":"OK"}',
    }));
    const adapters = createPrimaryModelProbeAdapters(undefined, {
      getProviderBinary: vi.fn(() => 'opencode'),
      probeBinaryCommand,
    });

    try {
      await expect(
        adapters.probeBinaryModel?.({ provider: 'opencode-cli', model: 'openai/configured-primary' }),
      ).resolves.toEqual({ status: 'ok' });
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }

    expect(probeBinaryCommand).toHaveBeenCalledWith(
      'opencode',
      ['run', '--format', 'json', '--pure', '-m', 'openai/configured-primary', 'Reply with OK only.'],
      expect.objectContaining({ OPENAI_API_KEY: 'sk-test-secret' }),
      { timeoutMs: 15_000 },
    );
  });

  it('probes OpenCode custom-endpoint models from cwd config without overriding -m', async () => {
    const probeBinaryCommand = vi.fn(async () => ({
      status: 'ok' as const,
      output: '{"type":"message","role":"assistant","content":"OK"}',
    }));
    const adapters = createPrimaryModelProbeAdapters(
      { baseUrl: 'https://openai-compatible.example/v1', apiKeyService: 'tenant-openai' },
      {
        cwd: '/agent-cwd',
        buildChildEnv: vi.fn(() => ({ PATH: '/usr/bin', OPENAI_API_KEY: 'sk-test-secret' })),
        getProviderBinary: vi.fn(() => 'opencode'),
        probeBinaryCommand,
      },
    );

    await expect(
      adapters.probeBinaryModel?.({ provider: 'opencode-cli', model: 'configured-primary' }),
    ).resolves.toEqual({ status: 'ok' });

    expect(probeBinaryCommand).toHaveBeenCalledWith(
      'opencode',
      ['run', '--format', 'json', '--pure', 'Reply with OK only.'],
      expect.objectContaining({ OPENAI_API_KEY: 'sk-test-secret' }),
      { cwd: '/agent-cwd', timeoutMs: 15_000 },
    );
  });

  it('maps an unavailable fetch implementation without resolving model access', async () => {
    vi.stubGlobal('fetch', undefined);
    const adapters = createPrimaryModelProbeAdapters(undefined, {
      resolveApiKey: vi.fn(() => 'sk-test-secret'),
    });

    await expect(
      adapters.probeApiModelAccess?.({ provider: 'openai-api', model: 'api-live-model' }),
    ).resolves.toEqual({ status: 'provider_unavailable' });
  });

  it('uses the default API-key resolver and OpenAI generation endpoint when no resolver is injected', async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-secret';
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'OK' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const adapters = createPrimaryModelProbeAdapters(undefined, {
      fetch: fetchImpl as unknown as typeof fetch,
    });

    try {
      await expect(
        adapters.probeApiModelAccess?.({ provider: 'openai-api', model: 'api-live-model' }),
      ).resolves.toEqual({ status: 'found' });
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer sk-test-secret',
        },
        body: JSON.stringify({
          model: 'api-live-model',
          messages: [{ role: 'user', content: 'Reply with OK only.' }],
          max_tokens: 1,
          stream: false,
        }),
      }),
    );
  });

  it('uses account-authenticated OpenAI generation without leaking the key into the result', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'OK' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const adapters = createPrimaryModelProbeAdapters(
      { apiKeyService: 'tenant-openai', baseUrl: 'https://openai.example/v1' },
      {
        fetch: fetchImpl as unknown as typeof fetch,
        resolveApiKey: vi.fn(() => 'sk-test-secret'),
      },
    );

    await expect(
      adapters.probeApiModelAccess?.({ provider: 'openai-api', model: 'api-live-model' }),
    ).resolves.toEqual({ status: 'found' });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://openai.example/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer sk-test-secret' }),
        body: expect.stringContaining('"model":"api-live-model"'),
      }),
    );
  });

  it('uses a generation request for OpenAI recovery so listed-but-quota-limited models are not usable', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith('/models')) {
        return new Response(
          JSON.stringify({ data: [{ id: 'api-live-model' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({ error: { message: 'insufficient_quota: account quota exceeded' } }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      );
    });
    const adapters = createPrimaryModelProbeAdapters(undefined, {
      fetch: fetchImpl as unknown as typeof fetch,
      resolveApiKey: vi.fn(() => 'sk-test-secret'),
    });

    await expect(
      adapters.probeApiModelAccess?.({ provider: 'openai-api', model: 'api-live-model' }),
    ).resolves.toEqual({ status: 'provider_unavailable' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        'Content-Type': 'application/json',
        Authorization: 'Bearer sk-test-secret',
      }),
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'api-live-model',
      messages: [{ role: 'user', content: 'Reply with OK only.' }],
      max_tokens: 1,
      stream: false,
    });
  });

  it('uses Anthropic generation with default endpoint and provider headers', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ content: [{ type: 'text', text: 'OK' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const resolveApiKey = vi.fn(() => 'anthropic-test-secret');
    const adapters = createPrimaryModelProbeAdapters(undefined, {
      fetch: fetchImpl as unknown as typeof fetch,
      resolveApiKey,
    });

    await expect(
      adapters.probeApiModelAccess?.({ provider: 'anthropic-api', model: 'claude-live-model' }),
    ).resolves.toEqual({ status: 'found' });

    expect(resolveApiKey).toHaveBeenCalledWith({
      service: undefined,
      envVar: 'ANTHROPIC_API_KEY',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'anthropic-test-secret',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-live-model',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'Reply with OK only.' }],
          stream: false,
        }),
      }),
    );
  });

  it('maps missing API credentials without making a network call', async () => {
    const fetchImpl = vi.fn();
    const adapters = createPrimaryModelProbeAdapters(undefined, {
      fetch: fetchImpl as unknown as typeof fetch,
      resolveApiKey: vi.fn(() => ''),
    });

    await expect(
      adapters.probeApiModelAccess?.({ provider: 'anthropic-api', model: 'api-live-model' }),
    ).resolves.toEqual({ status: 'credential_failed' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [401, { status: 'credential_failed' }],
    [403, { status: 'credential_failed' }],
    [404, { status: 'not_found' }],
    [408, { status: 'timeout' }],
    [500, { status: 'provider_unavailable' }],
    [504, { status: 'timeout' }],
    [429, { status: 'provider_unavailable' }],
  ] as const)('maps API generation HTTP %s to provider status', async (status, expected) => {
    const fetchImpl = vi.fn(async () => new Response('', { status }));
    const adapters = createPrimaryModelProbeAdapters(undefined, {
      fetch: fetchImpl as unknown as typeof fetch,
      resolveApiKey: vi.fn(() => 'sk-test-secret'),
    });

    await expect(
      adapters.probeApiModelAccess?.({ provider: 'openai-api', model: 'api-live-model' }),
    ).resolves.toEqual(expected);
  });

  it('maps authenticated model errors to not_found', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'model_not_found: missing model' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ));
    const adapters = createPrimaryModelProbeAdapters(undefined, {
      fetch: fetchImpl as unknown as typeof fetch,
      resolveApiKey: vi.fn(() => 'sk-test-secret'),
    });

    await expect(
      adapters.probeApiModelAccess?.({ provider: 'openai-api', model: 'api-missing-model' }),
    ).resolves.toEqual({ status: 'not_found' });
  });

  it('does not parse successful generation bodies while checking usability', async () => {
    const fetchImpl = vi.fn(async () => new Response('{not-json', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const adapters = createPrimaryModelProbeAdapters(undefined, {
      fetch: fetchImpl as unknown as typeof fetch,
      resolveApiKey: vi.fn(() => 'sk-test-secret'),
    });

    await expect(
      adapters.probeApiModelAccess?.({ provider: 'openai-api', model: 'api-live-model' }),
    ).resolves.toEqual({ status: 'found' });
  });

  it('maps non-Error fetch throws to provider_unavailable', async () => {
    const adapters = createPrimaryModelProbeAdapters(undefined, {
      fetch: vi.fn(async () => { throw 'network down'; }) as unknown as typeof fetch,
      resolveApiKey: vi.fn(() => 'sk-test-secret'),
    });

    await expect(
      adapters.probeApiModelAccess?.({ provider: 'openai-api', model: 'api-live-model' }),
    ).resolves.toEqual({ status: 'provider_unavailable' });
  });

  it.each([
    ['AbortError', { status: 'timeout' }],
    ['TimeoutError', { status: 'timeout' }],
    ['TypeError', { status: 'provider_unavailable' }],
  ] as const)('maps fetch %s exceptions without leaking details', async (name, expected) => {
    const err = new Error(`${name} from fetch`);
    err.name = name;
    const adapters = createPrimaryModelProbeAdapters(undefined, {
      fetch: vi.fn(async () => { throw err; }) as unknown as typeof fetch,
      resolveApiKey: vi.fn(() => 'sk-test-secret'),
    });

    await expect(
      adapters.probeApiModelAccess?.({ provider: 'openai-api', model: 'api-live-model' }),
    ).resolves.toEqual(expected);
  });
});

describe('claude-cli default-model probe command (fleet recovery-stall fix)', () => {
  it('omits --model when the instance has no configured model', async () => {
    const probeBinaryCommand = vi.fn(
      async (_cmd: string, _args: string[], _env: NodeJS.ProcessEnv) => ({ status: 'ok' as const, output: 'OK' }));
    const adapters = createPrimaryModelProbeAdapters(undefined, {
      getProviderBinary: () => 'claude',
      probeBinaryCommand,
    });
    await expect(
      adapters.probeBinaryModel?.({ provider: 'claude-cli', model: null }),
    ).resolves.toEqual({ status: 'ok' });
    const args = probeBinaryCommand.mock.calls[0]?.[1] ?? [];
    expect(args).not.toContain('--model');
    expect(args[0]).toBe('-p');
  });

  it('keeps --model when a model is configured', async () => {
    const probeBinaryCommand = vi.fn(
      async (_cmd: string, _args: string[], _env: NodeJS.ProcessEnv) => ({ status: 'ok' as const, output: 'OK' }));
    const adapters = createPrimaryModelProbeAdapters(undefined, {
      getProviderBinary: () => 'claude',
      probeBinaryCommand,
    });
    await adapters.probeBinaryModel?.({ provider: 'claude-cli', model: 'configured-primary' });
    const args = probeBinaryCommand.mock.calls[0]?.[1] ?? [];
    expect(args).toContain('--model');
    expect(args).toContain('configured-primary');
  });
});
