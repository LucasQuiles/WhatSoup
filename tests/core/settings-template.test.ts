import { describe, it, expect } from 'vitest';
import {
  defaultSettingsJson,
  mergeSettingsJson,
  isValidPermissionsSettings,
  AGENT_DEFAULT_ALLOW,
} from '../../src/core/settings-template.ts';

describe('defaultSettingsJson', () => {
  it('returns bypassPermissions settings for agent type', () => {
    const settings = defaultSettingsJson('agent');
    expect(settings).not.toBeNull();
    expect(settings!.permissions.defaultMode).toBe('bypassPermissions');
    expect(settings!.permissions.deny).toEqual([]);
  });

  it('agent default includes standard tool allowlist', () => {
    const settings = defaultSettingsJson('agent')!;
    expect(settings.permissions.allow).toContain('Bash');
    expect(settings.permissions.allow).toContain('Read');
    expect(settings.permissions.allow).toContain('Write');
    expect(settings.permissions.allow).toContain('Edit');
    expect(settings.permissions.allow).toContain('Glob');
    expect(settings.permissions.allow).toContain('Grep');
    expect(settings.permissions.allow).toContain('WebFetch');
    expect(settings.permissions.allow).toContain('WebSearch');
    expect(settings.permissions.allow).toContain('NotebookEdit');
    expect(settings.permissions.allow).toContain('Task');
  });

  it('agent default includes wildcard MCP tool patterns', () => {
    const settings = defaultSettingsJson('agent')!;
    expect(settings.permissions.allow).toContain('mcp__whatsoup__*');
    expect(settings.permissions.allow).toContain('mcp__plugin_*');
    expect(settings.permissions.allow).toContain('mcp__pinecone__*');
    expect(settings.permissions.allow).toContain('mcp__google-workspace__*');
  });

  it('returns null for chat type (no Claude Code subprocess)', () => {
    expect(defaultSettingsJson('chat')).toBeNull();
  });

  it('returns null for passive type (no Claude Code subprocess)', () => {
    expect(defaultSettingsJson('passive')).toBeNull();
  });

  it('AGENT_DEFAULT_ALLOW is a frozen array', () => {
    expect(Object.isFrozen(AGENT_DEFAULT_ALLOW)).toBe(true);
  });
});

describe('mergeSettingsJson', () => {
  it('returns defaults when no custom settings provided', () => {
    const result = mergeSettingsJson('agent', undefined);
    expect(result).toEqual(defaultSettingsJson('agent'));
  });

  it('custom permissions.allow replaces default allow list', () => {
    const custom = {
      permissions: {
        allow: ['Bash', 'Read'],
        deny: [],
        defaultMode: 'bypassPermissions' as const,
      },
    };
    const result = mergeSettingsJson('agent', custom);
    expect(result!.permissions.allow).toEqual(['Bash', 'Read']);
  });

  it('custom deny list is preserved', () => {
    const custom = {
      permissions: {
        allow: ['Bash'],
        deny: ['mcp__dangerous__*'],
        defaultMode: 'bypassPermissions' as const,
      },
    };
    const result = mergeSettingsJson('agent', custom);
    expect(result!.permissions.deny).toEqual(['mcp__dangerous__*']);
  });

  it('returns null for non-agent types even with custom settings', () => {
    const custom = {
      permissions: {
        allow: ['Bash'],
        deny: [],
        defaultMode: 'bypassPermissions' as const,
      },
    };
    expect(mergeSettingsJson('chat', custom)).toBeNull();
    expect(mergeSettingsJson('passive', custom)).toBeNull();
  });

  it('falls back to defaults for invalid custom settings', () => {
    const invalid = { permissions: 'not-an-object' } as any;
    const result = mergeSettingsJson('agent', invalid);
    expect(result).toEqual(defaultSettingsJson('agent'));
  });
});

describe('isValidPermissionsSettings', () => {
  it('accepts valid settings', () => {
    expect(isValidPermissionsSettings({
      permissions: { allow: ['Bash'], deny: [], defaultMode: 'bypassPermissions' },
    })).toBe(true);
  });

  it('rejects null', () => {
    expect(isValidPermissionsSettings(null)).toBe(false);
  });

  it('rejects missing permissions', () => {
    expect(isValidPermissionsSettings({})).toBe(false);
  });

  it('rejects non-array allow', () => {
    expect(isValidPermissionsSettings({
      permissions: { allow: 'Bash', deny: [], defaultMode: 'bypassPermissions' },
    })).toBe(false);
  });

  it('rejects wrong defaultMode', () => {
    expect(isValidPermissionsSettings({
      permissions: { allow: [], deny: [], defaultMode: 'askForPermission' },
    })).toBe(false);
  });

  it('rejects non-string elements in allow array', () => {
    expect(isValidPermissionsSettings({
      permissions: { allow: [42, null, {}], deny: [], defaultMode: 'bypassPermissions' },
    })).toBe(false);
  });

  it('rejects non-string elements in deny array', () => {
    expect(isValidPermissionsSettings({
      permissions: { allow: ['Bash'], deny: [123], defaultMode: 'bypassPermissions' },
    })).toBe(false);
  });
});
