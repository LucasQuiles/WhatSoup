// Absorbed fleet functionality: providerConfig-driven claude-cli CLI flags.
// Several fleet hosts had patched resolveProviderArgs locally to thread
// permissionMode / tools / mcpConfig / settingSources / effort / agents /
// fallbackModel / append-vs-raw system prompt through agentOptions.providerConfig.
// This consolidates that capability into the platform (PR: per-host reconciliation).
import { describe, expect, it } from 'vitest';

import { __provider_switch_for_test } from '../../../src/runtimes/agent/session.ts';

function args(providerConfig?: Record<string, unknown>): string[] {
  return __provider_switch_for_test.getProviderArgs(
    'claude-cli', 'SYS', '/cwd', undefined, 'claude-opus-4-8', [], providerConfig,
  );
}

describe('claude-cli resolveProviderArgs providerConfig flags', () => {
  it('defaults to --append-system-prompt (additive) and bypassPermissions', () => {
    const a = args();
    expect(a).toContain('--append-system-prompt');
    expect(a).not.toContain('--system-prompt');
    expect(a.slice(a.indexOf('--permission-mode'), a.indexOf('--permission-mode') + 2)).toEqual(['--permission-mode', 'bypassPermissions']);
  });

  it('uses --system-prompt (replace) when rawSystemPrompt=true', () => {
    const a = args({ rawSystemPrompt: true });
    expect(a).toContain('--system-prompt');
    expect(a).not.toContain('--append-system-prompt');
  });

  it('honors an explicit permissionMode', () => {
    const a = args({ permissionMode: 'plan' });
    expect(a.slice(a.indexOf('--permission-mode'), a.indexOf('--permission-mode') + 2)).toEqual(['--permission-mode', 'plan']);
  });

  it('threads --fallback-model (joins arrays) — provider CLI native model fallback', () => {
    expect(args({ fallbackModel: 'claude-sonnet-4-6' })).toEqual(expect.arrayContaining(['--fallback-model', 'claude-sonnet-4-6']));
    const a = args({ fallbackModel: ['claude-sonnet-4-6', 'claude-haiku-4-5'] });
    expect(a).toEqual(expect.arrayContaining(['--fallback-model', 'claude-sonnet-4-6,claude-haiku-4-5']));
  });

  it('threads --tools / --mcp-config / --setting-sources / --effort / --agents', () => {
    const a = args({
      tools: ['Read', 'Bash'],
      mcpConfig: ['/a.json', '/b.json'],
      settingSources: 'project',
      effort: 'high',
      agents: { reviewer: {} },
    });
    expect(a).toEqual(expect.arrayContaining(['--tools', 'Read', 'Bash']));
    expect(a).toEqual(expect.arrayContaining([
      '--mcp-config=/a.json',
      '--mcp-config=/b.json',
    ]));
    expect(a).toEqual(expect.arrayContaining(['--setting-sources', 'project']));
    expect(a).toEqual(expect.arrayContaining(['--effort', 'high']));
    expect(a).toEqual(expect.arrayContaining(['--agents', JSON.stringify({ reviewer: {} })]));
  });

  it('passes an empty-string tool sentinel when tools=[] (disable all tools)', () => {
    const a = args({ tools: [] });
    const i = a.indexOf('--tools');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(a[i + 1]).toBe('');
  });

  it('emits boolean flag args only when explicitly true', () => {
    expect(args({ disableSlashCommands: true })).toContain('--disable-slash-commands');
    expect(args({ strictMcpConfig: true })).toContain('--strict-mcp-config');
    expect(args({ noSessionPersistence: true })).toContain('--no-session-persistence');
    expect(args({})).not.toContain('--disable-slash-commands');
  });

  it('omits all optional flags when no providerConfig is given (back-compat shape)', () => {
    const a = args();
    for (const f of ['--tools', '--mcp-config', '--setting-sources', '--effort', '--agents', '--fallback-model', '--disable-slash-commands', '--strict-mcp-config', '--no-session-persistence']) {
      expect(a, f).not.toContain(f);
    }
  });
});
