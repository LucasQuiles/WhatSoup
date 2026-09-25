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
