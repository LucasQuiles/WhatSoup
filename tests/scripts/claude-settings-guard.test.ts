import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkClaudeSettings,
  renderExpectedClaudeSettings,
  run,
  writeClaudeSettings,
} from '../../scripts/claude-settings-guard.ts';
import {
  defaultSettingsJson,
  REQUIRED_DENY,
} from '../../src/core/settings-template.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const tmp = trackTmpDirs('whatsoup-claude-');

function makeFixture(settingsText?: string): string {
  const dir = tmp.make('settings');
  mkdirSync(path.join(dir, '.claude'), { recursive: true });
  if (settingsText !== undefined) {
    writeFileSync(path.join(dir, '.claude/settings.json'), settingsText, 'utf8');
  }
  return dir;
}

function readSettings(cwd: string): string {
  return readFileSync(path.join(cwd, '.claude/settings.json'), 'utf8');
}

describe('claude-settings guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('passes when .claude/settings.json matches the generated agent default', () => {
    const dir = makeFixture(renderExpectedClaudeSettings());

    const result = run(['--check'], dir);

    expect(process.exitCode).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.written).toBe(false);
  });

  it('fails with an actionable drift message when deny is missing the floor', () => {
    const expected = defaultSettingsJson('agent')!;
    const drifted = {
      ...expected,
      permissions: {
        ...expected.permissions,
        deny: [],
      },
    };
    const dir = makeFixture(`${JSON.stringify(drifted, null, 2)}\n`);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = run(['--check'], dir);

    expect(process.exitCode).toBe(1);
    expect(result.ok).toBe(false);
    expect(error.mock.calls.flat().join('\n')).toContain(
      'npm run guard:claude-settings -- --write',
    );
  });

  it('--write regenerates the expected file and is idempotent', () => {
    const dir = makeFixture('{"permissions":{"allow":[],"deny":[],"defaultMode":"bypassPermissions"}}\n');

    const first = writeClaudeSettings(dir);
    const firstText = readSettings(dir);
    const second = writeClaudeSettings(dir);
    const secondText = readSettings(dir);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(firstText).toBe(renderExpectedClaudeSettings());
    expect(secondText).toBe(firstText);
  });

  it('tracked .claude/settings.json contains the full REQUIRED_DENY floor', () => {
    const result = checkClaudeSettings(repoRoot);
    const tracked = JSON.parse(result.actual ?? 'null') as ReturnType<typeof defaultSettingsJson>;

    expect(result.ok).toBe(true);
    expect(tracked).toEqual(defaultSettingsJson('agent'));
    expect(tracked!.permissions.deny).toHaveLength(REQUIRED_DENY.length);
    expect(tracked!.permissions.deny).toEqual([...REQUIRED_DENY]);
  });

  it('verify chains invoke guard:claude-settings before expensive test phases', () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };

    for (const scriptName of ['verify:push:branch', 'verify:release', 'verify:publish']) {
      const chain = packageJson.scripts[scriptName];
      expect(chain, `${scriptName} script must exist`).toBeDefined();
      expect(chain).toMatch(/\bnpm run guard:claude-settings\b/);

      const guardIndex = chain.indexOf('npm run guard:claude-settings');
      const testIndex = chain.indexOf('npm test');
      if (testIndex >= 0) expect(guardIndex).toBeLessThan(testIndex);
    }
  });
});
