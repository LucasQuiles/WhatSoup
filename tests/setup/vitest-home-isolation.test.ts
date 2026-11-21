import { describe, expect, it } from 'vitest';
import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative } from 'node:path';

describe('Vitest filesystem isolation', () => {
  it('routes HOME and XDG roots into a worker-owned temporary directory', () => {
    const isolatedHome = process.env['WHATSOUP_VITEST_HOME'];
    const isolatedTempRoot = process.env['WHATSOUP_VITEST_TEMP_ROOT'];
    const isolatedTmpdir = process.env['TMPDIR'];

    expect(isolatedHome).toBeTruthy();
    expect(isolatedTempRoot).toBeTruthy();
    expect(isolatedTmpdir).toBeTruthy();
    expect(isAbsolute(isolatedHome!)).toBe(true);
    expect(relative(realpathSync(isolatedTempRoot!), realpathSync(isolatedHome!))).not.toMatch(/^\.\.(?:\/|$)/);
    expect(realpathSync(isolatedTmpdir!)).toBe(isolatedTmpdir);
    expect(relative(realpathSync(isolatedHome!), isolatedTmpdir!)).not.toMatch(/^\.\.(?:\/|$)/);
    expect(process.env['HOME']).toBe(isolatedHome);
    expect(homedir()).toBe(isolatedHome);
    expect(process.env['XDG_CONFIG_HOME']).toBe(join(isolatedHome!, '.config'));
    expect(process.env['XDG_DATA_HOME']).toBe(join(isolatedHome!, '.local', 'share'));
    expect(process.env['XDG_STATE_HOME']).toBe(join(isolatedHome!, '.local', 'state'));
    expect(process.env['XDG_CACHE_HOME']).toBe(join(isolatedHome!, '.cache'));
    expect(process.env['CLAUDE_CONFIG_DIR']).toBeUndefined();
    expect(existsSync(join(isolatedHome!, '.whatsoup-vitest-home'))).toBe(true);
  });

  // The real config's globalSetup exports the run root before the workers fork;
  // the worker HOME and its containment root both sit in it, so the run's
  // teardown removes the HOME even when this worker dies by signal.
  it('nests the worker HOME under the run root that the globalSetup exported', () => {
    const runRoot = process.env['WHATSOUP_VITEST_RUN_ROOT'];
    const isolatedHome = process.env['WHATSOUP_VITEST_HOME']!;

    expect(runRoot).toBeTruthy();
    expect(basename(runRoot!)).toMatch(/^ws-vr-/);
    expect(existsSync(join(runRoot!, '.whatsoup-vitest-run-root'))).toBe(true);
    expect(process.env['WHATSOUP_VITEST_TEMP_ROOT']).toBe(runRoot);
    expect(dirname(isolatedHome)).toBe(runRoot);
    expect(basename(isolatedHome)).toMatch(/^ws-vh-/);
  });

  // The credential-isolation regression loads the setup file through its own
  // config. This pins the same contract under the real one, where a later setup
  // file could undo it.
  it('keeps REQUIRE_OS_KEYRING unset and the synthetic credential commands first on PATH', () => {
    const credentialBin = join(process.env['WHATSOUP_VITEST_HOME']!, 'credential-bin');

    expect(process.env['REQUIRE_OS_KEYRING']).toBeUndefined();
    expect((process.env['PATH'] ?? '').split(delimiter)[0]).toBe(credentialBin);
    for (const command of ['security', 'secret-tool']) {
      expect(() => accessSync(join(credentialBin, command), constants.X_OK)).not.toThrow();
    }
  });
});
