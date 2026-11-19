import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { inspectInstructionsPathConfig } from '../../scripts/instructions-path-preflight.ts';

const roots: string[] = [];

function fixture(config: Record<string, unknown>): { root: string; home: string; configPath: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'whatsoup-instructions-preflight-'));
  roots.push(root);
  const home = path.join(root, 'home');
  mkdirSync(home);
  const configPath = path.join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  return { root, home, configPath };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('inspectInstructionsPathConfig', () => {
  it('allows a config with no instructionsPath', () => {
    const { home, configPath } = fixture({ name: 'agent', agentOptions: {} });
    expect(inspectInstructionsPathConfig(configPath, home)).toMatchObject({
      ok: true,
      decision: 'allow',
      reason: 'not_configured',
    });
  });

  it('blocks a configured missing instructions file', () => {
    const { home, configPath } = fixture({ name: 'agent', agentOptions: {} });
    writeFileSync(
      configPath,
      JSON.stringify({ name: 'agent', agentOptions: { cwd: home, instructionsPath: 'missing.md' } }),
      { mode: 0o600 },
    );
    expect(inspectInstructionsPathConfig(configPath, home)).toMatchObject({
      ok: false,
      decision: 'block',
      reason: 'missing',
    });
  });

  it('allows a readable configured instructions file', () => {
    const { home, configPath } = fixture({
      name: 'agent',
      agentOptions: { cwd: '.', instructionsPath: 'runtime.md' },
    });
    const cwd = path.join(home, 'workspace');
    mkdirSync(cwd);
    writeFileSync(path.join(cwd, 'runtime.md'), 'instructions', { mode: 0o600 });
    writeFileSync(
      configPath,
      JSON.stringify({ name: 'agent', agentOptions: { cwd, instructionsPath: 'runtime.md' } }),
      { mode: 0o600 },
    );

    expect(inspectInstructionsPathConfig(configPath, home)).toMatchObject({
      ok: true,
      decision: 'allow',
      reason: 'configured_file_ready',
    });
  });

  it('leaves a path a sandboxPerChat session reads only from its chat workspace to that session, as config load does', () => {
    const { home, configPath } = fixture({
      name: 'agent',
      agentOptions: { cwd: 'workspace', instructionsPath: 'runtime.md', sandboxPerChat: true },
    });
    expect(inspectInstructionsPathConfig(configPath, home)).toMatchObject({
      ok: true,
      decision: 'allow',
      reason: 'read_from_chat_workspace',
    });

    // Config load still checks these forms, so the preflight blocks them too.
    for (const agentOptions of [
      { cwd: 'workspace', instructionsPath: 'runtime.md', sandboxPerChat: false },
      { cwd: home, instructionsPath: 'CLAUDE.md', sandboxPerChat: true },
      { cwd: home, instructionsPath: path.join(home, 'runtime.md'), sandboxPerChat: true },
    ]) {
      writeFileSync(configPath, JSON.stringify({ name: 'agent', agentOptions }), { mode: 0o600 });
      expect(inspectInstructionsPathConfig(configPath, home)).toMatchObject({ ok: false, decision: 'block' });
    }
  });

  it('blocks a sandboxPerChat relative path that is not lexically inside the chat workspace, as config load refuses it', () => {
    const { home, configPath } = fixture({ name: 'agent', agentOptions: {} });
    const cwd = path.join(home, 'workspace');
    mkdirSync(path.join(cwd, 'notes'), { recursive: true });
    // Readable files inside home, so only the chat-workspace rule blocks a path that reaches them.
    for (const file of [path.join(home, 'x.md'), path.join(cwd, 'x.md'), path.join(cwd, 'notes', 'agent.md')]) {
      writeFileSync(file, 'instructions', { mode: 0o600 });
    }
    const inspect = (agentOptions: Record<string, unknown>) => {
      writeFileSync(configPath, JSON.stringify({ name: 'agent', agentOptions }), { mode: 0o600 });
      return inspectInstructionsPathConfig(configPath, home);
    };

    for (const instructionsPath of ['../x.md', 'notes/../../x.md', './../x.md', 'notes/..', './x.md', 'notes//agent.md', 'notes/./agent.md']) {
      expect(inspect({ cwd, instructionsPath, sandboxPerChat: true }), instructionsPath).toEqual({
        schemaVersion: 1, ok: false, decision: 'block', reason: 'outside_chat_workspace',
      });
    }
    // Unchanged: a confined path, CLAUDE.md, and every path without sandboxPerChat.
    expect(inspect({ cwd, instructionsPath: 'notes/agent.md', sandboxPerChat: true })).toMatchObject({ ok: true, reason: 'read_from_chat_workspace' });
    expect(inspect({ cwd, instructionsPath: 'CLAUDE.md', sandboxPerChat: true })).toMatchObject({ ok: false, reason: 'missing' });
    expect(inspect({ cwd, instructionsPath: '../x.md', sandboxPerChat: false })).toMatchObject({ ok: true, reason: 'configured_file_ready' });
  });

  it('fails closed for a symlinked config file', () => {
    const { root, home, configPath } = fixture({ name: 'agent', agentOptions: {} });
    const linkPath = path.join(root, 'config-link.json');
    symlinkSync(configPath, linkPath);
    expect(inspectInstructionsPathConfig(linkPath, home)).toMatchObject({
      ok: false,
      decision: 'block',
      reason: 'unsafe_config_file',
    });
  });
});
