import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  defaultSettingsJson,
  mergeSettingsJson,
  isValidPermissionsSettings,
  AGENT_DEFAULT_ALLOW,
  REQUIRED_DENY,
  applyRequiredDeny,
} from '../../src/core/settings-template.ts';
import {
  CONNECTOR_MUTATION_DENY_FIXTURE,
} from './fixtures/connector-mutation-deny-fixture.ts';

const APPROVED_CONNECTOR_MUTATION_INVENTORY_SHA256 = readFileSync(
  new URL('./fixtures/connector-mutation-deny-fixture.sha256', import.meta.url),
  'utf8',
).trim().split(/\s+/)[0];

describe('defaultSettingsJson', () => {
  it('returns bypassPermissions settings for agent type', () => {
    const settings = defaultSettingsJson('agent');
    expect(settings).not.toBeNull();
    expect(settings!.permissions.defaultMode).toBe('bypassPermissions');
    // Default deny is the REQUIRED_DENY floor.
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

  it('falls back to defaults for non-object custom settings', () => {
    const result = mergeSettingsJson('agent', 'not-an-object' as never);
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

const MUTATION_PREFIXES = [
  'send-',
  'create-',
  'update-',
  'delete-',
  'move-',
  'forward-',
  'reply-',
  'add-',
  'remove-',
  'mark-',
  'upload-',
  'copy-',
  'cancel-',
  'restore-',
  'undo-',
] as const;

const MUTATION_EXACT = new Set([
  'rename-drive-item',
  'respond-to-event',
  'upsert-dataverse-record',
  'associate-dataverse-records',
  'execute-dataverse-action',
  'execute-dataverse-function',
  'execute-tool',
  'batch-dataverse',
  'graph-batch',
  'close-workbook-session',
  'hub-manage-subscription',
  'hub-recover-delta',
  'hub-refresh-account',
]);

function m365ToolName(permission: string): string | null {
  const prefix = 'mcp__plugin_microsoft_365_microsoft_365__';
  return permission.startsWith(prefix) ? permission.slice(prefix.length) : null;
}

// ─── #411 deny-floor mechanism ────────────────────────────────────────────────
// REQUIRED_DENY is populated from the approved connector mutation inventory.

describe('REQUIRED_DENY (deny-floor scaffold, #411)', () => {
  it('matches the approved G-D0 connector mutation fixture', () => {
    const fixtureHash = createHash('sha256')
      .update(`${CONNECTOR_MUTATION_DENY_FIXTURE.join('\n')}\n`)
      .digest('hex');
    expect(fixtureHash).toBe(APPROVED_CONNECTOR_MUTATION_INVENTORY_SHA256);
    expect(REQUIRED_DENY).toEqual(CONNECTOR_MUTATION_DENY_FIXTURE);
  });

  it('REQUIRED_DENY is a frozen array', () => {
    expect(Object.isFrozen(REQUIRED_DENY)).toBe(true);
  });

  it('contains full permission strings without duplicates', () => {
    expect(REQUIRED_DENY.length).toBe(124);
    expect(new Set(REQUIRED_DENY).size).toBe(REQUIRED_DENY.length);
    for (const permission of REQUIRED_DENY) {
      expect(permission).toMatch(/^mcp__[^_]+.*__/);
      expect(permission).not.toMatch(/^(send|create|update|delete|move|reply|forward)-/);
    }
  });

  it('covers the approved Google mutation categories', () => {
    expect(REQUIRED_DENY).toEqual(expect.arrayContaining([
      'mcp__claude_ai_Gmail__create_draft',
      'mcp__claude_ai_Gmail__label_message',
      'mcp__claude_ai_Gmail__unlabel_thread',
      'mcp__claude_ai_Google_Calendar__create_event',
      'mcp__claude_ai_Google_Calendar__respond_to_event',
    ]));
  });

  it('QR-029: denies claude_ai Google Drive writes + Gmail sensitivity-label writes (Workspace read-only)', () => {
    // The connector is allowed via mcp__claude_ai_* — every WRITE tool must be in the
    // deny floor or it is reachable. These were omitted (Drive entirely; Gmail's
    // apply_sensitive_* labels), so the agent could create/copy Drive files and apply
    // sensitivity labels despite the "Google Workspace read-only" policy.
    expect(REQUIRED_DENY).toEqual(expect.arrayContaining([
      'mcp__claude_ai_Google_Drive__create_file',
      'mcp__claude_ai_Google_Drive__copy_file',
      'mcp__claude_ai_Gmail__apply_sensitive_message_label',
      'mcp__claude_ai_Gmail__apply_sensitive_thread_label',
    ]));
    // Read-only Drive tools stay ALLOWED (must NOT be in the deny floor).
    for (const readTool of [
      'mcp__claude_ai_Google_Drive__read_file_content',
      'mcp__claude_ai_Google_Drive__list_recent_files',
      'mcp__claude_ai_Google_Drive__search_files',
    ]) {
      expect(REQUIRED_DENY).not.toContain(readTool);
    }
  });

  it('covers the approved M365 mutation categories', () => {
    expect(REQUIRED_DENY).toEqual(expect.arrayContaining([
      'mcp__plugin_microsoft_365_microsoft_365__send-mail',
      'mcp__plugin_microsoft_365_microsoft_365__create-event',
      'mcp__plugin_microsoft_365_microsoft_365__delete-drive-item',
      'mcp__plugin_microsoft_365_microsoft_365__create-list-item',
      'mcp__plugin_microsoft_365_microsoft_365__add-group-member',
      'mcp__plugin_microsoft_365_microsoft_365__create-task',
      'mcp__plugin_microsoft_365_microsoft_365__delete-channel-message',
      'mcp__plugin_microsoft_365_microsoft_365__update-mail-rule',
      'mcp__plugin_microsoft_365_microsoft_365__upsert-dataverse-record',
      'mcp__plugin_microsoft_365_microsoft_365__cancel-booking-appointment',
      'mcp__plugin_microsoft_365_microsoft_365__create-page',
      'mcp__plugin_microsoft_365_microsoft_365__delete-online-meeting',
      'mcp__plugin_microsoft_365_microsoft_365__add-worksheet',
      'mcp__plugin_microsoft_365_microsoft_365__add-attachment',
      'mcp__plugin_microsoft_365_microsoft_365__execute-tool',
      'mcp__plugin_microsoft_365_microsoft_365__graph-batch',
      'mcp__plugin_microsoft_365_microsoft_365__hub-manage-subscription',
    ]));
  });

  it('omits the read-only google-workspace namespace', () => {
    expect(REQUIRED_DENY.some((permission) => permission.startsWith('mcp__google-workspace__')))
      .toBe(false);
  });

  it('fixture M365 mutation-like tools are represented in REQUIRED_DENY', () => {
    const denySet = new Set(REQUIRED_DENY);
    for (const permission of CONNECTOR_MUTATION_DENY_FIXTURE) {
      const toolName = m365ToolName(permission);
      if (!toolName) continue;
      const isMutation = MUTATION_EXACT.has(toolName)
        || MUTATION_PREFIXES.some((prefix) => toolName.startsWith(prefix));
      expect(isMutation).toBe(true);
      expect(denySet.has(permission)).toBe(true);
    }
  });
});

describe('applyRequiredDeny (mechanism)', () => {
  it('appends the floor when the caller deny list is empty', () => {
    expect(applyRequiredDeny([])).toEqual([...REQUIRED_DENY]);
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

describe('populated REQUIRED_DENY enforcement', () => {
  it('defaultSettingsJson seeds the full deny floor', () => {
    const settings = defaultSettingsJson('agent')!;
    expect(settings.permissions.deny).toEqual([...REQUIRED_DENY]);
  });

  it('isValidPermissionsSettings accepts settings with the full floor', () => {
    expect(isValidPermissionsSettings({
      permissions: { allow: ['Bash'], deny: [...REQUIRED_DENY], defaultMode: 'bypassPermissions' },
    })).toBe(true);
  });

  it('isValidPermissionsSettings rejects settings missing any floor entry', () => {
    expect(isValidPermissionsSettings({
      permissions: { allow: ['Bash'], deny: [], defaultMode: 'bypassPermissions' },
    })).toBe(false);

    expect(isValidPermissionsSettings({
      permissions: {
        allow: ['Bash'],
        deny: REQUIRED_DENY.slice(1),
        defaultMode: 'bypassPermissions',
      },
    })).toBe(false);
  });

  it('mergeSettingsJson unions the floor into otherwise-valid custom settings', () => {
    const custom = {
      permissions: {
        allow: ['Bash'],
        deny: ['mcp__one__*', 'mcp__two__*'],
        defaultMode: 'bypassPermissions' as const,
      },
    };
    const result = mergeSettingsJson('agent', custom);
    expect(result!.permissions.allow).toEqual(['Bash']);
    expect(result!.permissions.deny).toEqual([
      'mcp__one__*',
      'mcp__two__*',
      ...REQUIRED_DENY,
    ]);
  });

  it('broad connector allows remain unchanged', () => {
    expect(AGENT_DEFAULT_ALLOW).toEqual(expect.arrayContaining([
      'mcp__plugin_*',
      'mcp__claude_ai_*',
      'mcp__google-workspace__*',
    ]));
  });
});
