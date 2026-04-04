import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ensurePermissionsSettings } from '../../src/core/workspace.ts';

describe('ensurePermissionsSettings', () => {
  let tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) {
      rmSync(d, { recursive: true });
    }
    tmpDirs = [];
  });

  function makeTmp(): string {
    const d = mkdtempSync(join(tmpdir(), 'ensure-settings-'));
    tmpDirs.push(d);
    return d;
  }

  it('writes default agent settings when no settings.json exists', () => {
    const cwd = makeTmp();
    const claudeDir = join(cwd, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    ensurePermissionsSettings(claudeDir, 'agent');

    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    expect(settings.permissions.defaultMode).toBe('bypassPermissions');
    expect(settings.permissions.allow.length).toBeGreaterThan(5);
  });

  it('does not overwrite existing settings.json with permissions block', () => {
    const cwd = makeTmp();
    const claudeDir = join(cwd, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    // Pre-existing settings with custom permissions
    const existing = {
      permissions: {
        allow: ['CustomTool'],
        deny: ['BlockedTool'],
        defaultMode: 'bypassPermissions',
      },
    };
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(existing));

    ensurePermissionsSettings(claudeDir, 'agent');

    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    // Should NOT overwrite — custom settings preserved
    expect(settings.permissions.allow).toEqual(['CustomTool']);
  });

  it('adds permissions to existing settings.json that only has hooks', () => {
    const cwd = makeTmp();
    const claudeDir = join(cwd, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    // Settings from sandbox provisioning — has hooks but no permissions
    const existing = {
      hooks: {
        PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: '/path/to/hook.sh' }] }],
      },
    };
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(existing));

    ensurePermissionsSettings(claudeDir, 'agent');

    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    // Should add permissions while preserving hooks
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe('/path/to/hook.sh');
    expect(settings.permissions.defaultMode).toBe('bypassPermissions');
  });

  it('does nothing for non-agent types', () => {
    const cwd = makeTmp();
    const claudeDir = join(cwd, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    ensurePermissionsSettings(claudeDir, 'chat');

    expect(existsSync(join(claudeDir, 'settings.json'))).toBe(false);
  });

  it('creates .claude directory if it does not exist', () => {
    const cwd = makeTmp();
    const claudeDir = join(cwd, '.claude');
    // Don't create it — ensurePermissionsSettings should

    ensurePermissionsSettings(claudeDir, 'agent');

    expect(existsSync(join(claudeDir, 'settings.json'))).toBe(true);
  });

  it('always overwrites enabledPlugins from config even if already set', () => {
    const cwd = makeTmp();
    const claudeDir = join(cwd, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    // Pre-existing settings with stale enabledPlugins
    const existing = {
      permissions: { allow: ['Bash'], deny: [], defaultMode: 'bypassPermissions' },
      enabledPlugins: { 'old-plugin@old': true },
    };
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(existing));

    const updated = { 'new-plugin@new': true, 'old-plugin@old': false };
    ensurePermissionsSettings(claudeDir, 'agent', updated);

    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    expect(settings.enabledPlugins).toEqual(updated);
    // Permissions should NOT be overwritten
    expect(settings.permissions.allow).toEqual(['Bash']);
  });

  it('writes enabledPlugins alongside defaults when no settings.json exists', () => {
    const cwd = makeTmp();
    const claudeDir = join(cwd, '.claude');

    const plugins = { 'test-plugin@test': true };
    ensurePermissionsSettings(claudeDir, 'agent', plugins);

    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    expect(settings.enabledPlugins).toEqual(plugins);
    expect(settings.permissions.defaultMode).toBe('bypassPermissions');
  });
});
