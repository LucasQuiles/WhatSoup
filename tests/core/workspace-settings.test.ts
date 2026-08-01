import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { chmodSync, readFileSync, existsSync, writeFileSync, mkdirSync, statSync, symlinkSync } from 'node:fs';
import { writePermissionsSettings } from '../../src/core/workspace.ts';
import { REQUIRED_DENY } from '../../src/core/settings-template.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

describe('writePermissionsSettings', () => {
  const tmp = trackTmpDirs('');

  function makeTmp(): string {
    return tmp.make('ws-settings');
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
    expect(written.permissions.deny).toEqual(REQUIRED_DENY);
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
    expect(written.permissions.deny).toEqual(REQUIRED_DENY);
  });

  it('tightens an existing settings.json file to private mode', () => {
    const cwd = makeTmp();
    const claudeDir = join(cwd, '.claude');
    const settingsPath = join(claudeDir, 'settings.json');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: [] } }));
    chmodSync(settingsPath, 0o644);
    expect(statSync(settingsPath).mode & 0o777).toBe(0o644);

    const settings = {
      permissions: {
        allow: ['Bash'],
        deny: [],
        defaultMode: 'bypassPermissions' as const,
      },
    };
    writePermissionsSettings(claudeDir, settings);

    expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
  });

  it('refuses to write settings.json through a final symlink', () => {
    const cwd = makeTmp();
    const claudeDir = join(cwd, '.claude');
    const settingsPath = join(claudeDir, 'settings.json');
    const targetPath = join(cwd, 'settings-target.json');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(targetPath, JSON.stringify({ keep: true }));
    symlinkSync(targetPath, settingsPath);

    const settings = {
      permissions: {
        allow: ['Bash'],
        deny: [],
        defaultMode: 'bypassPermissions' as const,
      },
    };
    expect(() => writePermissionsSettings(claudeDir, settings)).toThrow(/symlink/);
    expect(JSON.parse(readFileSync(targetPath, 'utf8'))).toEqual({ keep: true });
  });

  it('refuses to write settings.json through a .claude directory symlink', () => {
    const cwd = makeTmp();
    const targetDir = makeTmp();
    const claudeDir = join(cwd, '.claude');
    symlinkSync(targetDir, claudeDir, 'dir');

    const settings = {
      permissions: {
        allow: ['Bash'],
        deny: [],
        defaultMode: 'bypassPermissions' as const,
      },
    };
    expect(() => writePermissionsSettings(claudeDir, settings)).toThrow(/directory.*symlink/);
    expect(existsSync(join(targetDir, 'settings.json'))).toBe(false);
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
    expect(written.permissions.deny).toEqual(REQUIRED_DENY);
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
    expect(written.permissions.deny).toEqual(REQUIRED_DENY);
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
    expect(written).toEqual({
      permissions: {
        allow: ['Bash'],
        deny: REQUIRED_DENY,
        defaultMode: 'bypassPermissions',
      },
    });
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
    expect(written.permissions.deny).toEqual(REQUIRED_DENY);
  });
});
