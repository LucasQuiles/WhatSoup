import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, linkSync, lstatSync, readFileSync, realpathSync, symlinkSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { writeSandboxArtifacts } from '../../src/core/workspace.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('workspace-sandbox-preservation-');
const originalSettings = JSON.stringify({
  permissions: { deny: ['Bash(operator-restricted:*)'] },
  env: { OPERATOR_SETTING: 'preserved' },
});
const originalPolicy = JSON.stringify({ allowedTools: ['Read'] });
const replacementPolicy = { allowedTools: ['Read', 'Write'] };

function fixture() {
  const dir = realpathSync(tmp.make('private'));
  const settings = join(dir, 'settings.json');
  const policy = join(dir, 'sandbox-policy.json');
  writeFileSync(settings, originalSettings, { mode: 0o600 });
  writeFileSync(policy, originalPolicy, { mode: 0o600 });
  return { dir, settings, policy };
}

describe('sandbox refresh preserves artifacts on unsafe input', () => {
  it.each(['symlink', 'dangling-symlink', 'hard-link', 'oversized', 'public-mode'] as const)(
    'refuses %s settings before changing either artifact', (kind) => {
      const { dir, settings, policy } = fixture();
      const victim = join(realpathSync(tmp.make('victim')), 'settings.json');
      writeFileSync(victim, originalSettings, { mode: 0o600 });
      if (kind === 'symlink' || kind === 'dangling-symlink' || kind === 'hard-link') {
        unlinkSync(settings);
        if (kind === 'hard-link') linkSync(victim, settings);
        else symlinkSync(kind === 'symlink' ? victim : join(dir, 'missing'), settings);
      } else if (kind === 'oversized') {
        writeFileSync(settings, JSON.stringify({ padding: 'x'.repeat(1024 * 1024) }));
      } else {
        chmodSync(settings, 0o644);
      }
      const before = lstatSync(settings);
      expect(() => writeSandboxArtifacts(dir, replacementPolicy, '/hooks/sandbox.sh')).toThrow();
      expect(readFileSync(policy, 'utf8')).toBe(originalPolicy);
      expect(readFileSync(victim, 'utf8')).toBe(originalSettings);
      const after = lstatSync(settings);
      expect({ ino: after.ino, size: after.size, mode: after.mode, mtime: after.mtimeMs })
        .toEqual({ ino: before.ino, size: before.size, mode: before.mode, mtime: before.mtimeMs });
    },
  );

  it('refuses a FIFO without waiting for a writer or changing the policy', () => {
    const { dir, settings, policy } = fixture();
    unlinkSync(settings);
    const fifo = spawnSync('mkfifo', [settings], { encoding: 'utf8' });
    expect(fifo.status, fifo.stderr).toBe(0);
    chmodSync(settings, 0o600);
    const code = [
      'const [moduleUrl, dir] = process.argv.slice(1);',
      'const { writeSandboxArtifacts } = await import(moduleUrl);',
      "console.log('REFRESH_READY');",
      'try {',
      "  writeSandboxArtifacts(dir, { allowedTools: ['Write'] }, '/hooks/sandbox.sh');",
      '  console.log(JSON.stringify({ refused: false }));',
      '} catch { console.log(JSON.stringify({ refused: true })); }',
    ].join('\n');
    const result = spawnSync(process.execPath, [
      '--experimental-strip-types', '--input-type=module', '-e', code,
      new URL('../../src/core/workspace.ts', import.meta.url).href, dir,
    ], { env: { ...process.env, VITEST: '1' }, encoding: 'utf8', timeout: 5000 });
    expect(result.stdout, result.stderr).toContain('REFRESH_READY');
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"refused":true');
    expect(lstatSync(settings).isFIFO()).toBe(true);
    expect(readFileSync(policy, 'utf8')).toBe(originalPolicy);
  });

  it('refuses a symlinked policy without rewriting valid settings', () => {
    const { dir, settings, policy } = fixture();
    const victim = join(realpathSync(tmp.make('policy-victim')), 'policy.json');
    writeFileSync(victim, originalPolicy, { mode: 0o600 });
    unlinkSync(policy);
    symlinkSync(victim, policy);
    expect(() => writeSandboxArtifacts(dir, replacementPolicy, '/hooks/sandbox.sh')).toThrow();
    expect(readFileSync(settings, 'utf8')).toBe(originalSettings);
    expect(readFileSync(victim, 'utf8')).toBe(originalPolicy);
    expect(lstatSync(policy).isSymbolicLink()).toBe(true);
  });

  it('refreshes valid private artifacts while retaining operator restrictions', () => {
    const { dir, settings, policy } = fixture();
    writeSandboxArtifacts(dir, replacementPolicy, '/hooks/sandbox.sh');
    const updated = JSON.parse(readFileSync(settings, 'utf8'));
    expect(updated.permissions.deny).toEqual(['Bash(operator-restricted:*)']);
    expect(updated.env.OPERATOR_SETTING).toBe('preserved');
    expect(updated.hooks.PreToolUse[0].hooks[0].command).toContain('/hooks/sandbox.sh');
    expect(JSON.parse(readFileSync(policy, 'utf8'))).toEqual(replacementPolicy);
  });
});
