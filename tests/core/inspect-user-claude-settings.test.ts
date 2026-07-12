import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectUserClaudeSettings } from '../../src/core/user-claude-settings.ts';

const MANAGED_HOOK = '/opt/whatsoup/deploy/hooks/agent-sandbox.sh';

describe('inspectUserClaudeSettings', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'user-claude-settings-'));
    tmpDirs.push(root);
    return root;
  }

  it('does not create a missing user-level .claude directory or settings file', () => {
    const claudeDir = join(makeRoot(), '.claude');

    expect(inspectUserClaudeSettings(claudeDir, MANAGED_HOOK)).toBe('absent');
    expect(existsSync(claudeDir)).toBe(false);
  });

  it('reports clean and preserves unrelated user settings byte-for-byte', () => {
    const claudeDir = join(makeRoot(), '.claude');
    mkdirSync(claudeDir);
    const settingsPath = join(claudeDir, 'settings.json');
    const original = '{\n  "permissions": { "allow": ["CustomTool"], "deny": [] },\n  "custom": true\n}\n';
    writeFileSync(settingsPath, original);

    expect(inspectUserClaudeSettings(claudeDir, MANAGED_HOOK)).toBe('clean');
    expect(readFileSync(settingsPath, 'utf8')).toBe(original);
  });

  it('detects the exact managed hook without changing it, its siblings, or permissions', () => {
    const claudeDir = join(makeRoot(), '.claude');
    mkdirSync(claudeDir);
    const settingsPath = join(claudeDir, 'settings.json');
    const original = JSON.stringify({
      permissions: {
        allow: ['CustomTool'],
        deny: ['OwnerDeniedTool'],
        defaultMode: 'bypassPermissions',
      },
      hooks: {
        PreToolUse: [
          {
            matcher: '',
            hooks: [
              { type: 'command', command: MANAGED_HOOK },
              { type: 'command', command: '/opt/owner/keep-this-hook.sh' },
            ],
          },
        ],
      },
    });
    writeFileSync(settingsPath, original);

    expect(inspectUserClaudeSettings(claudeDir, MANAGED_HOOK)).toBe('managed-hook-present');
    expect(readFileSync(settingsPath, 'utf8')).toBe(original);
    expect(inspectUserClaudeSettings(claudeDir, MANAGED_HOOK)).toBe('managed-hook-present');
    expect(readFileSync(settingsPath, 'utf8')).toBe(original);
  });

  it.each([
    { type: 'command', command: `${MANAGED_HOOK} --owner-wrapper` },
    { type: 'command', command: '/other/deploy/hooks/agent-sandbox.sh' },
    { type: 'prompt', command: MANAGED_HOOK },
  ])('preserves foreign or non-command hook $command', (candidate) => {
    const claudeDir = join(makeRoot(), '.claude');
    mkdirSync(claudeDir);
    const settingsPath = join(claudeDir, 'settings.json');
    const original = JSON.stringify({
      hooks: { PreToolUse: [{ matcher: '', hooks: [candidate] }] },
    });
    writeFileSync(settingsPath, original);

    expect(inspectUserClaudeSettings(claudeDir, MANAGED_HOOK)).toBe('clean');
    expect(readFileSync(settingsPath, 'utf8')).toBe(original);
  });

  it('leaves malformed JSON bytes untouched without exposing them in an exception', () => {
    const claudeDir = join(makeRoot(), '.claude');
    mkdirSync(claudeDir);
    const settingsPath = join(claudeDir, 'settings.json');
    const original = Buffer.from('{"permissions": [BROKEN]\xff', 'latin1');
    writeFileSync(settingsPath, original);

    expect(inspectUserClaudeSettings(claudeDir, MANAGED_HOOK)).toBe('unreadable');
    expect(readFileSync(settingsPath)).toEqual(original);
  });

  it.each(['null', '[]', '"string"', '42'])(
    'leaves non-object user settings root %s untouched',
    (original) => {
      const claudeDir = join(makeRoot(), '.claude');
      mkdirSync(claudeDir);
      const settingsPath = join(claudeDir, 'settings.json');
      writeFileSync(settingsPath, original);

      expect(inspectUserClaudeSettings(claudeDir, MANAGED_HOOK)).toBe('invalid-root');
      expect(readFileSync(settingsPath, 'utf8')).toBe(original);
    },
  );

  it('tolerates malformed hook entries without throwing or writing', () => {
    const claudeDir = join(makeRoot(), '.claude');
    mkdirSync(claudeDir);
    const settingsPath = join(claudeDir, 'settings.json');
    const original = JSON.stringify({
      hooks: { PreToolUse: [null, 'foreign', 42, { hooks: [null, 'foreign'] }] },
    });
    writeFileSync(settingsPath, original);

    expect(inspectUserClaudeSettings(claudeDir, MANAGED_HOOK)).toBe('clean');
    expect(readFileSync(settingsPath, 'utf8')).toBe(original);
  });

  it('refuses to follow a symlinked user settings file', () => {
    const claudeDir = join(makeRoot(), '.claude');
    const decoyDir = makeRoot();
    mkdirSync(claudeDir);
    const decoyPath = join(decoyDir, 'decoy.json');
    const original = JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: MANAGED_HOOK }] }] },
    });
    writeFileSync(decoyPath, original);
    symlinkSync(decoyPath, join(claudeDir, 'settings.json'));

    expect(inspectUserClaudeSettings(claudeDir, MANAGED_HOOK)).toBe('unreadable');
    expect(readFileSync(decoyPath, 'utf8')).toBe(original);
  });
});
