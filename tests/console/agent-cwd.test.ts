/**
 * Direct unit coverage for console/src/lib/agent-cwd.ts.
 *
 * Three pure helpers used by the wizard + edit-modal to populate the agent
 * `cwd` field when the operator hasn't provided one:
 *
 * - normalizeAgentWorkspaceName: slugify with FALLBACK_AGENT_NAME guard
 * - defaultAgentWorkspacePath: `~/.local/share/whatsoup/instances/<slug>/workspace`
 * - withDefaultAgentWorkspace<T>: returns input when type !== 'agent' OR
 *   agentOptions.cwd is already a non-blank string, otherwise injects the
 *   default cwd computed from `name`.
 *
 * All three are pure (no DOM, no React, no async).
 */
import { describe, expect, it } from 'vitest';
import {
  normalizeAgentWorkspaceName,
  defaultAgentWorkspacePath,
  withDefaultAgentWorkspace,
} from '../../console/src/lib/agent-cwd';

describe('normalizeAgentWorkspaceName', () => {
  it('lowercases + replaces whitespace with single hyphen', () => {
    expect(normalizeAgentWorkspaceName('Hello World')).toBe('hello-world');
  });

  it('strips non-[a-z0-9-] characters after lowercasing', () => {
    expect(normalizeAgentWorkspaceName("Alice's Bot!")).toBe('alices-bot');
  });

  it('collapses repeated hyphens', () => {
    expect(normalizeAgentWorkspaceName('foo---bar')).toBe('foo-bar');
  });

  it('trims leading/trailing hyphens', () => {
    expect(normalizeAgentWorkspaceName('---edge---')).toBe('edge');
  });

  it('returns FALLBACK_AGENT_NAME when slug is empty after normalization', () => {
    expect(normalizeAgentWorkspaceName('')).toBe('new-agent');
    expect(normalizeAgentWorkspaceName('!!!')).toBe('new-agent');
    expect(normalizeAgentWorkspaceName('   ')).toBe('new-agent');
  });

  it('preserves valid lowercase alphanumeric + single hyphens unchanged', () => {
    expect(normalizeAgentWorkspaceName('alpha-bot-1')).toBe('alpha-bot-1');
  });
});

describe('defaultAgentWorkspacePath', () => {
  it('builds the XDG workspace path from a normalized name', () => {
    expect(defaultAgentWorkspacePath('Sales Bot')).toBe(
      '~/.local/share/whatsoup/instances/sales-bot/workspace',
    );
  });

  it('uses FALLBACK_AGENT_NAME when input slugs to empty', () => {
    expect(defaultAgentWorkspacePath('')).toBe(
      '~/.local/share/whatsoup/instances/new-agent/workspace',
    );
  });
});

describe('withDefaultAgentWorkspace', () => {
  it('returns input unchanged when type is not agent', () => {
    const data = { type: 'passive', name: 'alpha', agentOptions: {} };
    expect(withDefaultAgentWorkspace(data)).toBe(data);
  });

  it('returns input unchanged when agentOptions.cwd is already a non-blank string', () => {
    const data = {
      type: 'agent',
      name: 'alpha',
      agentOptions: { cwd: '/explicit/path' },
    };
    expect(withDefaultAgentWorkspace(data)).toBe(data);
  });

  it('returns input unchanged when name slugs to empty (no fallback injection)', () => {
    const data = {
      type: 'agent',
      name: '!!!',
      agentOptions: {},
    };
    expect(withDefaultAgentWorkspace(data)).toBe(data);
  });

  it('injects default cwd when agent has no cwd and name slugs to a valid value', () => {
    const result = withDefaultAgentWorkspace({
      type: 'agent',
      name: 'Sales Bot',
      agentOptions: { sessionScope: 'single' },
    });
    expect(result).toEqual({
      type: 'agent',
      name: 'Sales Bot',
      agentOptions: {
        sessionScope: 'single',
        cwd: '~/.local/share/whatsoup/instances/sales-bot/workspace',
      },
    });
  });

  it('injects default cwd when agentOptions is missing entirely', () => {
    const result = withDefaultAgentWorkspace({
      type: 'agent',
      name: 'alpha',
    });
    expect(result).toMatchObject({
      type: 'agent',
      name: 'alpha',
      agentOptions: { cwd: '~/.local/share/whatsoup/instances/alpha/workspace' },
    });
  });

  it('treats blank-string cwd as missing and injects default', () => {
    const result = withDefaultAgentWorkspace({
      type: 'agent',
      name: 'alpha',
      agentOptions: { cwd: '   ' },
    });
    expect((result.agentOptions as { cwd: string }).cwd).toBe(
      '~/.local/share/whatsoup/instances/alpha/workspace',
    );
  });

  it('treats non-string cwd (e.g. number) as missing and injects default', () => {
    const result = withDefaultAgentWorkspace({
      type: 'agent',
      name: 'alpha',
      agentOptions: { cwd: 42 },
    });
    expect(result).toEqual({
      type: 'agent',
      name: 'alpha',
      agentOptions: { cwd: '~/.local/share/whatsoup/instances/alpha/workspace' },
    });
  });

  it('treats array-valued agentOptions as missing (not an object) and recovers', () => {
    const result = withDefaultAgentWorkspace({
      type: 'agent',
      name: 'alpha',
      agentOptions: ['array', 'is', 'invalid'],
    });
    expect(result).toEqual({
      type: 'agent',
      name: 'alpha',
      agentOptions: { cwd: '~/.local/share/whatsoup/instances/alpha/workspace' },
    });
  });
});
