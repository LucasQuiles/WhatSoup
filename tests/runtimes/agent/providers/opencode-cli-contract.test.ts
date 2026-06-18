import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildOpenCodeCliContract,
  buildOpenCodeSpawnPerTurnArgs,
  detectOpenCodeMode,
  openCodeCommandModeValidationError,
  openCodeContractEvidence,
  probeOpenCodeCliContract,
} from '../../../../src/runtimes/agent/providers/opencode-cli-contract.ts';

const modernRunHelp = `
Usage:
  opencode run [flags]

Flags:
  --format string
  --pure
  -m, --model string
  --session string
`;

const legacyHelp = `
Usage:
  opencode [flags]

Flags:
  -p, --prompt string
  -f, --output-format string   Output format for non-interactive mode (text, json)
  -q, --quiet
`;

function spawnFor(outputs: Record<string, { stdout?: string; stderr?: string; status?: number; error?: NodeJS.ErrnoException }>) {
  return vi.fn((command: string, args: string[]) => {
    const key = `${command} ${args.join(' ')}`;
    const value = outputs[key] ?? { stdout: '', stderr: '', status: 0 };
    return {
      stdout: value.stdout ?? '',
      stderr: value.stderr ?? '',
      status: value.status ?? 0,
      signal: null,
      error: value.error,
    };
  }) as never;
}

function withEnv(vars: Partial<NodeJS.ProcessEnv>, fn: () => void) {
  const previous = Object.fromEntries(
    Object.keys(vars).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe('OpenCode CLI contract detection', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('detects modern run, legacy prompt-json, and unsupported help shapes', () => {
    expect(detectOpenCodeMode(legacyHelp, modernRunHelp)).toBe('modern-run');
    expect(detectOpenCodeMode(legacyHelp, legacyHelp)).toBe('legacy-prompt-json');
    expect(detectOpenCodeMode('Usage: something else', 'Flags: --verbose')).toBe('unsupported');
  });

  it('validates explicit command modes', () => {
    expect(openCodeCommandModeValidationError(undefined)).toBeNull();
    expect(openCodeCommandModeValidationError('auto')).toBeNull();
    expect(openCodeCommandModeValidationError('modern-run')).toBeNull();
    expect(openCodeCommandModeValidationError('legacy-prompt-json')).toBeNull();
    expect(openCodeCommandModeValidationError('old')).toMatch(/opencodeCommandMode/);
  });

  it('probes a modern CLI and records model/resume support', () => {
    const spawnSyncImpl = spawnFor({
      'opencode --version': { stdout: '1.17.4\n' },
      'opencode --help': { stdout: legacyHelp },
      'opencode run --help': { stdout: modernRunHelp },
    });

    const contract = probeOpenCodeCliContract({ useCache: false, spawnSyncImpl });

    expect(contract).toMatchObject({
      detectedMode: 'modern-run',
      configuredMode: 'auto',
      supported: true,
      degraded: false,
      modelOverrideSupported: true,
      sessionResumeSupported: true,
      version: '1.17.4',
    });
  });

  it('passes an owned temp directory to every probe when only TMPDIR is set', () => {
    const seenEnv: NodeJS.ProcessEnv[] = [];
    const spawnSyncImpl = vi.fn((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      seenEnv.push(options.env);
      const key = `${command} ${args.join(' ')}`;
      if (key === 'opencode --version') return { stdout: '1.17.4\n', stderr: '', status: 0, signal: null };
      if (key === 'opencode --help') return { stdout: legacyHelp, stderr: '', status: 0, signal: null };
      if (key === 'opencode run --help') return { stdout: modernRunHelp, stderr: '', status: 0, signal: null };
      return { stdout: '', stderr: '', status: 0, signal: null };
    }) as never;

    withEnv({ TMPDIR: '/tmp/whatsoup-owned', TMP: undefined, TEMP: undefined }, () => {
      const contract = probeOpenCodeCliContract({ useCache: false, spawnSyncImpl });
      expect(contract.supported).toBe(true);
    });

    expect(seenEnv).toHaveLength(3);
    for (const env of seenEnv) {
      expect(env).toMatchObject({
        TMPDIR: '/tmp/whatsoup-owned',
        TMP: '/tmp/whatsoup-owned',
        TEMP: '/tmp/whatsoup-owned',
      });
    }
  });

  it('probes the legacy Homebrew-style CLI as degraded but supported', () => {
    const spawnSyncImpl = spawnFor({
      'opencode --version': { stdout: '0.0.55\n' },
      'opencode --help': { stdout: legacyHelp },
      'opencode run --help': { stdout: legacyHelp },
    });

    const contract = probeOpenCodeCliContract({ useCache: false, spawnSyncImpl });

    expect(contract).toMatchObject({
      detectedMode: 'legacy-prompt-json',
      supported: true,
      degraded: true,
      modelOverrideSupported: false,
      sessionResumeSupported: false,
      version: '0.0.55',
    });
  });

  it('does not let explicit legacy mode bless an unsupported binary', () => {
    const contract = buildOpenCodeCliContract({
      configuredMode: 'legacy-prompt-json',
      detectedMode: 'unsupported',
      reason: 'help was not recognized',
    });

    expect(contract.supported).toBe(false);
    expect(openCodeContractEvidence(contract)).toContain('supported=false');
  });

  it('builds modern and legacy argv without silently claiming unsupported model controls', () => {
    expect(buildOpenCodeSpawnPerTurnArgs({
      prompt: 'hello',
      model: 'minimax/MiniMax-M2.7-highspeed',
      sessionId: 'real-session',
      contract: buildOpenCodeCliContract({ detectedMode: 'modern-run' }),
    })).toEqual([
      'run',
      '--format',
      'json',
      '--pure',
      '--session',
      'real-session',
      '-m',
      'minimax/MiniMax-M2.7-highspeed',
      'hello',
    ]);

    expect(buildOpenCodeSpawnPerTurnArgs({
      prompt: 'hello',
      model: 'minimax/MiniMax-M2.7-highspeed',
      contract: buildOpenCodeCliContract({ detectedMode: 'legacy-prompt-json' }),
    })).toEqual(['-p', 'hello', '-f', 'json', '-q']);
  });

  it('throws an actionable error for unsupported OpenCode CLIs', () => {
    expect(() => buildOpenCodeSpawnPerTurnArgs({
      prompt: 'hello',
      contract: buildOpenCodeCliContract({ detectedMode: 'unsupported', reason: 'binary missing' }),
    })).toThrow(/OPENCODE_CLI_UNSUPPORTED/);
  });
});
