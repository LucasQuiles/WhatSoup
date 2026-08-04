import { describe, expect, it } from 'vitest';

import { parseProviderCanaryArgs } from '../../scripts/provider-mcp-canary.ts';

describe('provider MCP canary CLI', () => {
  it('requires an eligible provider and explicit state root', () => {
    expect(parseProviderCanaryArgs([
      '--provider', 'codex-cli',
      '--state-root', '/private/state',
    ])).toMatchObject({
      providerId: 'codex-cli',
      stateRoot: '/private/state',
      timeoutMs: 30_000,
    });
    expect(() => parseProviderCanaryArgs(['--provider', 'openai-api', '--state-root', '/x']))
      .toThrow(/eligible/);
    expect(() => parseProviderCanaryArgs(['--provider', 'codex-cli']))
      .toThrow(/state-root/);
  });

  it('bounds the external watchdog timeout and rejects unknown arguments', () => {
    expect(parseProviderCanaryArgs([
      '--provider', 'claude-cli',
      '--state-root', '/private/state',
      '--timeout-seconds', '45',
    ]).timeoutMs).toBe(45_000);
    expect(() => parseProviderCanaryArgs([
      '--provider', 'claude-cli',
      '--state-root', '/private/state',
      '--timeout-seconds', '121',
    ])).toThrow(/timeout/);
    expect(() => parseProviderCanaryArgs([
      '--provider', 'claude-cli',
      '--state-root', '/private/state',
      '--mystery',
    ])).toThrow(/unknown/);
  });
});
