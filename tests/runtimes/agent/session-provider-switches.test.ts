/**
 * Session-manager internal switches — fail-fast behavior for #447.
 *
 * Before this change, the three switches in session.ts (`getProviderBinary`,
 * `getProviderArgs`, `getParser`) used a `default:` branch that silently
 * aliased any unknown provider ID to Claude semantics. Combined with a
 * validator that accepted any non-empty string, a typo'd `provider: "claud"`
 * config would launch the `claude` binary, parse output with `parseEvents`,
 * and the operator would never see an error.
 *
 * The fix tightens validation upstream (now an enum check) AND tightens the
 * switches to throw on an unknown ID — defense in depth against bypass paths
 * (e.g. tests that construct SessionManager directly, runtime mutation).
 *
 * These tests reach into the private switches via a tiny test-only helper
 * exported from session.ts (`__provider_switch_for_test`) so we don't have
 * to spin up a real subprocess.
 */
import { describe, it, expect } from 'vitest';
import {
  __provider_switch_for_test,
  buildChildEnv,
  PROVIDER_DISPLAY_NAMES,
} from '../../../src/runtimes/agent/session.ts';
import { PROVIDER_IDS } from '../../../src/runtimes/agent/providers/index.ts';

describe('SessionManager provider switches — fail-fast (#447)', () => {
  it('getProviderBinary returns the correct binary for every canonical ID', () => {
    const expected: Record<string, string> = {
      'claude-cli': 'claude',
      'codex-cli': 'codex',
      'gemini-cli': 'gemini',
      'opencode-cli': 'opencode',
      // managed-loop providers don't spawn a binary but the function must
      // still be exhaustive — it should throw rather than silently fall
      // through to "claude".
      'openai-api': '__throws__',
      'anthropic-api': '__throws__',
    };

    for (const id of PROVIDER_IDS) {
      if (expected[id] === '__throws__') {
        expect(
          () => __provider_switch_for_test.getProviderBinary(id),
          `expected getProviderBinary("${id}") to throw — managed-loop providers do not spawn`,
        ).toThrow();
      } else {
        expect(__provider_switch_for_test.getProviderBinary(id)).toBe(expected[id]);
      }
    }
  });

  it('getProviderBinary throws on an unknown provider ID (no silent Claude alias)', () => {
    expect(() => __provider_switch_for_test.getProviderBinary('claud-cli')).toThrow(
      /unknown provider/i,
    );
    expect(() => __provider_switch_for_test.getProviderBinary('totally-fake')).toThrow(
      /unknown provider/i,
    );
  });

  it('getProviderArgs throws on an unknown provider ID', () => {
    expect(() =>
      __provider_switch_for_test.getProviderArgs('claud-cli', 'sys', '/cwd', undefined, undefined, []),
    ).toThrow(/unknown provider/i);
  });

  it('getParser throws on an unknown provider ID', () => {
    expect(() => __provider_switch_for_test.getParser('claud-cli')).toThrow(/unknown provider/i);
  });

  it('normalizes every CLI provider parser result into an event envelope', () => {
    const cases = [
      {
        provider: 'claude-cli',
        line: JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'hello' }] },
        }),
        expectedType: 'assistant_text',
      },
      {
        provider: 'codex-cli',
        line: JSON.stringify({
          jsonrpc: '2.0',
          method: 'thread/started',
          params: { thread: { id: 'codex-session' } },
        }),
        expectedType: 'init',
      },
      {
        provider: 'gemini-cli',
        line: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { protocolVersion: '0.1', agentCapabilities: {} },
        }),
        expectedType: 'init',
      },
      {
        provider: 'opencode-cli',
        line: JSON.stringify({ type: 'step_start', sessionID: 'opencode-session' }),
        expectedType: 'init',
      },
    ] as const;

    for (const { provider, line, expectedType } of cases) {
      expect(__provider_switch_for_test.getParser(provider)(line)).toEqual([
        expect.objectContaining({ type: expectedType }),
      ]);
      expect(__provider_switch_for_test.getParser(provider)('')).toEqual([]);
    }
  });

  it('exposes completed OpenCode tools as bounded activity before their result', () => {
    const parser = __provider_switch_for_test.getParser('opencode-cli');
    const events = parser(JSON.stringify({
      type: 'tool_use',
      part: {
        tool: 'bash',
        callID: 'call-live-progress',
        state: {
          status: 'completed',
          input: { command: 'sensitive command text' },
          output: 'sensitive command output',
        },
      },
    }));

    expect(events).toEqual([
      {
        type: 'tool_use',
        toolName: 'bash',
        toolId: 'call-live-progress',
        toolInput: {},
      },
      {
        type: 'tool_result',
        isError: false,
        toolId: 'call-live-progress',
        toolName: 'bash',
        content: 'sensitive command output',
      },
    ]);
    expect(JSON.stringify(events[0])).not.toContain('sensitive command');
  });

  it('does not synthesize OpenCode activity for failed tools', () => {
    const parser = __provider_switch_for_test.getParser('opencode-cli');
    const events = parser(JSON.stringify({
      type: 'tool_use',
      part: {
        tool: 'bash',
        callID: 'call-failed-tool',
        state: {
          status: 'error',
          input: { command: 'failing command' },
          error: 'command failed',
        },
      },
    }));

    expect(events).toEqual([
      {
        type: 'tool_result',
        isError: true,
        toolId: 'call-failed-tool',
        toolName: 'bash',
        content: 'command failed',
      },
    ]);
  });

  it('buildChildEnv throws on an unknown provider ID', () => {
    expect(() => buildChildEnv('claud-cli')).toThrow(/unknown provider/i);
  });

  it('buildChildEnv throws for managed-loop providers that do not spawn children', () => {
    expect(() => buildChildEnv('openai-api')).toThrow(/managed-loop provider/i);
    expect(() => buildChildEnv('anthropic-api')).toThrow(/managed-loop provider/i);
  });

  it('PROVIDER_DISPLAY_NAMES covers every registry entry', () => {
    for (const id of PROVIDER_IDS) {
      expect(PROVIDER_DISPLAY_NAMES[id]).toBeTruthy();
      expect(typeof PROVIDER_DISPLAY_NAMES[id]).toBe('string');
      expect(PROVIDER_DISPLAY_NAMES[id].length).toBeGreaterThan(0);
    }
  });
});
