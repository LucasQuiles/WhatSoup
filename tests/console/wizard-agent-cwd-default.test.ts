import { describe, expect, it } from 'vitest';
import {
  defaultAgentWorkspacePath,
  normalizeAgentWorkspaceName,
  withDefaultAgentWorkspace,
} from '../../console/src/lib/agent-cwd.ts';

describe('agent workspace defaults', () => {
  it('derives a selectable per-instance workspace path from the line name', () => {
    expect(defaultAgentWorkspacePath('lab-test')).toBe('~/.local/share/whatsoup/instances/lab-test/workspace');
  });

  it('normalizes display names before deriving the workspace path', () => {
    expect(defaultAgentWorkspacePath('Lab Test')).toBe('~/.local/share/whatsoup/instances/lab-test/workspace');
  });

  it('fills a missing agent cwd before the wizard creates the line', () => {
    expect(withDefaultAgentWorkspace({
      name: 'lab-test',
      type: 'agent',
      agentOptions: { cwd: '', sessionScope: 'per_chat' },
    })).toMatchObject({
      agentOptions: {
        cwd: '~/.local/share/whatsoup/instances/lab-test/workspace',
        sessionScope: 'per_chat',
      },
    });
  });

  it('preserves explicit agent cwd overrides', () => {
    expect(withDefaultAgentWorkspace({
      name: 'lab-test',
      type: 'agent',
      agentOptions: { cwd: '~/work/custom', sessionScope: 'per_chat' },
    })).toMatchObject({
      agentOptions: {
        cwd: '~/work/custom',
      },
    });
  });

  it('does not fill the wizard state before a line name exists', () => {
    expect(withDefaultAgentWorkspace({
      type: 'agent',
      agentOptions: { cwd: '', sessionScope: 'per_chat' },
    })).toEqual({
      type: 'agent',
      agentOptions: { cwd: '', sessionScope: 'per_chat' },
    });
  });

  it('does not add an agent cwd to passive or chat lines', () => {
    expect(withDefaultAgentWorkspace({ name: 'chat-line', type: 'chat' })).toEqual({ name: 'chat-line', type: 'chat' });
    expect(withDefaultAgentWorkspace({ name: 'passive-line', type: 'passive' })).toEqual({ name: 'passive-line', type: 'passive' });
  });

  it('treats whitespace-only cwd as missing and applies the default', () => {
    expect(withDefaultAgentWorkspace({
      name: 'lab-test',
      type: 'agent',
      agentOptions: { cwd: '   ', sessionScope: 'per_chat' },
    })).toMatchObject({
      agentOptions: {
        cwd: '~/.local/share/whatsoup/instances/lab-test/workspace',
        sessionScope: 'per_chat',
      },
    });
  });

  it('treats a non-string cwd as missing and applies the default', () => {
    const result = withDefaultAgentWorkspace({
      name: 'lab-test',
      type: 'agent',
      agentOptions: { cwd: null, sessionScope: 'per_chat' },
    });
    expect((result.agentOptions as { cwd: string }).cwd).toBe('~/.local/share/whatsoup/instances/lab-test/workspace');
  });

  it('creates agentOptions when an agent line has none and a name is set', () => {
    expect(withDefaultAgentWorkspace({ name: 'lab-test', type: 'agent' })).toMatchObject({
      agentOptions: { cwd: '~/.local/share/whatsoup/instances/lab-test/workspace' },
    });
  });

  it('does not crash when agentOptions is an array and leaves it untouched', () => {
    const input = { name: 'lab-test', type: 'agent', agentOptions: ['unexpected'] };
    const result = withDefaultAgentWorkspace(input);
    // Array agentOptions is non-conforming input; helper falls back to a fresh object containing the default.
    expect((result.agentOptions as Record<string, unknown>).cwd)
      .toBe('~/.local/share/whatsoup/instances/lab-test/workspace');
    expect(Array.isArray(result.agentOptions)).toBe(false);
  });

  it('falls back to "new-agent" when the name produces no slug characters', () => {
    expect(normalizeAgentWorkspaceName('')).toBe('new-agent');
    expect(normalizeAgentWorkspaceName('!!!@@@')).toBe('new-agent');
    expect(defaultAgentWorkspacePath('')).toBe('~/.local/share/whatsoup/instances/new-agent/workspace');
  });
});
