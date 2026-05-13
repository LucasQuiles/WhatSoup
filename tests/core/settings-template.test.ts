import { describe, it, expect } from 'vitest';
import {
  defaultSettingsJson,
  mergeSettingsJson,
  isValidPermissionsSettings,
  AGENT_DEFAULT_ALLOW,
  REQUIRED_DENY,
  applyRequiredDeny,
} from '../../src/core/settings-template.ts';

describe('defaultSettingsJson', () => {
  it('returns bypassPermissions settings for agent type', () => {
    const settings = defaultSettingsJson('agent');
    expect(settings).not.toBeNull();
    expect(settings!.permissions.defaultMode).toBe('bypassPermissions');
    // Default deny is the (currently empty) REQUIRED_DENY floor.
    expect(settings!.permissions.deny).toEqual([...REQUIRED_DENY]);
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

  it('custom deny list is preserved (and floor unioned in)', () => {
    const custom = {
      permissions: {
        allow: ['Bash'],
        deny: ['mcp__dangerous__*'],
        defaultMode: 'bypassPermissions' as const,
      },
    };
    const result = mergeSettingsJson('agent', custom);
    // Caller's deny entries always survive; floor entries are appended.
    expect(result!.permissions.deny).toEqual(
      expect.arrayContaining(['mcp__dangerous__*', ...REQUIRED_DENY]),
    );
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
    const invalid = { permissions: 'not-an-object' } as never;
    const result = mergeSettingsJson('agent', invalid);
    expect(result).toEqual(defaultSettingsJson('agent'));
  });
});

describe('isValidPermissionsSettings', () => {
  it('accepts valid settings', () => {
    expect(isValidPermissionsSettings({
      permissions: { allow: ['Bash'], deny: [...REQUIRED_DENY], defaultMode: 'bypassPermissions' },
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

// ─── #411 deny-floor mechanism ────────────────────────────────────────────────
// REQUIRED_DENY ships empty so existing fleets are observably unchanged. These
// tests exercise the mechanism by feeding arbitrary inputs to applyRequiredDeny
// and by asserting that the current REQUIRED_DENY value is empty (so the union
// is a no-op).

describe('REQUIRED_DENY (deny-floor scaffold, #411)', () => {
  it('ships empty so existing fleets see no behavior change', () => {
    // This is a hard invariant: flipping the floor to non-empty is a
    // separate maintainer-direction PR. Until that lands the floor MUST
    // be `[]` so `mw-bot` and any other ALLOW_M365_MUTATIONS=1 fleet
    // remains operational without code changes.
    expect(REQUIRED_DENY).toEqual([]);
  });

  it('REQUIRED_DENY is a frozen array', () => {
    expect(Object.isFrozen(REQUIRED_DENY)).toBe(true);
  });
});

describe('applyRequiredDeny (mechanism)', () => {
  it('is a no-op when REQUIRED_DENY is empty (current shipping default)', () => {
    expect(applyRequiredDeny([])).toEqual([]);
    expect(applyRequiredDeny(['mcp__custom__*'])).toEqual(['mcp__custom__*']);
  });

  it('preserves caller order and is idempotent across calls', () => {
    const input = ['A', 'B', 'C'];
    const once = applyRequiredDeny(input);
    const twice = applyRequiredDeny(once);
    expect(twice).toEqual(once);
    // First three positions are the caller's entries in order.
    expect(once.slice(0, 3)).toEqual(['A', 'B', 'C']);
  });

  it('returns a fresh array (does not mutate the caller list)', () => {
    const input = ['A', 'B'];
    const result = applyRequiredDeny(input);
    result.push('mutated');
    expect(input).toEqual(['A', 'B']);
  });
});

// Backward-compat proof: with REQUIRED_DENY = [], the merge result for any
// previously-valid caller payload is observably equivalent to the pre-#411
// implementation (caller's permissions block unchanged).
describe('backward compatibility with REQUIRED_DENY=[] (current default)', () => {
  it('mergeSettingsJson returns the caller deny verbatim when floor is empty', () => {
    const custom = {
      permissions: {
        allow: ['Bash'],
        deny: ['mcp__one__*', 'mcp__two__*'],
        defaultMode: 'bypassPermissions' as const,
      },
    };
    const result = mergeSettingsJson('agent', custom);
    expect(result!.permissions.deny).toEqual(['mcp__one__*', 'mcp__two__*']);
  });

  it('defaultSettingsJson.deny is empty when floor is empty', () => {
    const settings = defaultSettingsJson('agent')!;
    expect(settings.permissions.deny).toEqual([]);
  });

  it('isValidPermissionsSettings accepts deny:[] when floor is empty', () => {
    expect(isValidPermissionsSettings({
      permissions: { allow: ['Bash'], deny: [], defaultMode: 'bypassPermissions' },
    })).toBe(true);
  });
});
