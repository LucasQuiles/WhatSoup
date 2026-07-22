import { describe, expect, it } from 'vitest';
import {
  buildOpenCodeRunArgs,
  openCodeAgentArgs,
  resolveOpenCodeExecutionProfile,
} from '../../../src/runtimes/agent/providers/opencode-execution-profile.ts';

const PROFILE_CONFIG = { executionProfile: 'whatsoup-headless' };

function occurrences(args: string[], value: string): number {
  return args.filter((arg) => arg === value).length;
}

describe('OpenCode execution profile', () => {
  it('resolves only the reserved configured profile and emits one explicit selector', () => {
    expect(resolveOpenCodeExecutionProfile(PROFILE_CONFIG)).toBe('whatsoup-headless');
    expect(openCodeAgentArgs(PROFILE_CONFIG)).toEqual(['--agent', 'whatsoup-headless']);
  });

  it.each([
    undefined,
    null,
    '',
    '   ',
    '--auto',
    'nested/profile',
    'name with spaces',
    'auto',
    'fullstack-lead',
    'other-safe-agent-name',
  ])(
    'rejects non-reserved executionProfile %j',
    (executionProfile) => {
      expect(() => resolveOpenCodeExecutionProfile({ executionProfile }))
        .toThrow(/exactly "whatsoup-headless"/);
    },
  );

  it('keeps an absent profile report-only during the first source rollout', () => {
    expect(openCodeAgentArgs(undefined)).toEqual([]);
    expect(openCodeAgentArgs({})).toEqual([]);
  });

  it('selects the configured profile exactly once on fresh and resumed turns', () => {
    const fresh = buildOpenCodeRunArgs({
      providerConfig: PROFILE_CONFIG,
      model: 'glm/glm-5.2',
      prompt: 'fresh turn',
    });
    const resumed = buildOpenCodeRunArgs({
      providerConfig: PROFILE_CONFIG,
      sessionId: 'session-123',
      model: 'glm/glm-5.2',
      prompt: 'resumed turn',
    });

    expect(fresh).toEqual([
      'run', '--format', 'json', '--pure', '--print-logs', '--log-level', 'ERROR',
      '--agent', 'whatsoup-headless',
      '-m', 'glm/glm-5.2',
      'fresh turn',
    ]);
    expect(resumed).toEqual([
      'run', '--format', 'json', '--pure', '--print-logs', '--log-level', 'ERROR',
      '--agent', 'whatsoup-headless',
      '--session', 'session-123',
      '-m', 'glm/glm-5.2',
      'resumed turn',
    ]);
    for (const args of [fresh, resumed]) {
      expect(occurrences(args, '--agent')).toBe(1);
      expect(args).not.toContain('--auto');
    }
  });

  it('keeps the explicit profile while custom-endpoint routing omits -m', () => {
    const args = buildOpenCodeRunArgs({
      providerConfig: {
        ...PROFILE_CONFIG,
        baseUrl: 'https://endpoint.example/v1',
      },
      model: 'endpoint-model',
      prompt: 'probe',
    });

    expect(occurrences(args, '--agent')).toBe(1);
    expect(occurrences(args, '--print-logs')).toBe(1);
    expect(occurrences(args, '--log-level')).toBe(1);
    expect(args).toContain('ERROR');
    expect(args).toContain('whatsoup-headless');
    expect(args).not.toContain('-m');
  });
});
