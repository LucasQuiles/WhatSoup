import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { writePermissionsSettings } from '../../src/core/workspace.ts';

describe('writePermissionsSettings', () => {
  let tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) {
      rmSync(d, { recursive: true });
    }
    tmpDirs = [];
  });

  function makeTmp(): string {
    const d = mkdtempSync(join(tmpdir(), 'ws-settings-'));
    tmpDirs.push(d);
    return d;
  }

  it('writes settings.json with permissions block to .claude/ directory', () => {
    const cwd = makeTmp();
    const claudeDir = join(cwd, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    const settings = {
      permissions: {
        allow: ['Bash', 'Read'],
        deny: [],
        defaultMode: 'bypassPermissions' as const,
      },
    };
    writePermissionsSettings(claudeDir, settings);

    const written = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    expect(written.permissions.allow).toEqual(['Bash', 'Read']);
    expect(written.permissions.defaultMode).toBe('bypassPermissions');
  });

  it('preserves existing hooks when writing permissions', () => {
    const cwd = makeTmp();
    const claudeDir = join(cwd, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    // Pre-existing settings.json with hooks (from sandbox provisioning)
    const existing = {
      hooks: {
        PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: '/path/to/hook.sh' }] }],
      },
    };
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(existing));

    const settings = {
      permissions: {
        allow: ['Bash'],
        deny: [],
        defaultMode: 'bypassPermissions' as const,
      },
    };
    writePermissionsSettings(claudeDir, settings);

    const written = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    // Both hooks and permissions should be present
    expect(written.hooks.PreToolUse[0].hooks[0].command).toBe('/path/to/hook.sh');
    expect(written.permissions.allow).toEqual(['Bash']);
  });

  it('creates .claude/ directory if it does not exist', () => {
    const cwd = makeTmp();
    const claudeDir = join(cwd, '.claude');

    const settings = {
      permissions: {
        allow: ['Bash'],
        deny: [],
        defaultMode: 'bypassPermissions' as const,
      },
    };
    writePermissionsSettings(claudeDir, settings);

    expect(existsSync(join(claudeDir, 'settings.json'))).toBe(true);
  });

  it('overwrites existing permissions but keeps other keys', () => {
    const cwd = makeTmp();
    const claudeDir = join(cwd, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    const existing = {
      hooks: { PreToolUse: [] },
      permissions: {
        allow: ['OldTool'],
        deny: ['OldDeny'],
        defaultMode: 'bypassPermissions',
      },
      env: { SOME_VAR: 'value' },
    };
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(existing));

    const settings = {
      permissions: {
        allow: ['NewTool'],
        deny: [],
        defaultMode: 'bypassPermissions' as const,
      },
    };
    writePermissionsSettings(claudeDir, settings);

    const written = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    expect(written.permissions.allow).toEqual(['NewTool']);
    expect(written.hooks).toEqual({ PreToolUse: [] });
    expect(written.env).toEqual({ SOME_VAR: 'value' });
  });

  it('writes enabledPlugins to settings.json when provided', () => {
    const cwd = makeTmp();
    const claudeDir = join(cwd, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    const settings = {
      permissions: {
        allow: ['Bash'],
        deny: [],
        defaultMode: 'bypassPermissions' as const,
      },
      enabledPlugins: { 'sdlc-os@sdlc-os-dev': false, 'tmup@tmup-dev': true },
    };
    writePermissionsSettings(claudeDir, settings);

    const written = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    expect(written.enabledPlugins).toEqual({ 'sdlc-os@sdlc-os-dev': false, 'tmup@tmup-dev': true });
    expect(written.permissions.allow).toEqual(['Bash']);
  });

  it('does not write enabledPlugins key when not provided', () => {
    const cwd = makeTmp();
    const claudeDir = join(cwd, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    const settings = {
      permissions: { allow: ['Bash'], deny: [], defaultMode: 'bypassPermissions' as const },
    };
    writePermissionsSettings(claudeDir, settings);

    const written = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    expect(written.enabledPlugins).toBeUndefined();
  });

  it('recovers from corrupt settings.json', () => {
    const cwd = makeTmp();
    const claudeDir = join(cwd, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'settings.json'), 'not valid json{{');

    const settings = {
      permissions: { allow: ['Bash'], deny: [], defaultMode: 'bypassPermissions' as const },
    };
    writePermissionsSettings(claudeDir, settings);

    const written = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    expect(written.permissions.allow).toEqual(['Bash']);
  });
});
