import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installFakeLaunchctl } from './fake-launchctl.ts';
import { trackTmpDirs } from './tmp-dir.ts';

const tmp = trackTmpDirs('fake-launchctl-');

describe('installFakeLaunchctl', () => {
  it('records a call looked up by name when the root holds a space and an apostrophe', () => {
    const fake = installFakeLaunchctl(join(tmp.make('quoting'), "it's a folder"), '/usr/bin:/bin');
    expect(fake.calls()).toEqual([]);

    const result = spawnSync('launchctl', ['print', 'gui/1/label-a'], { env: { PATH: fake.path }, encoding: 'utf8' });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(113);
    expect(fake.calls()).toEqual(['print gui/1/label-a']);
  });

  it('answers `list` with the header line only and exit 0, as a host with no job loaded', () => {
    const fake = installFakeLaunchctl(tmp.make('list'), '/usr/bin:/bin');

    const result = spawnSync('launchctl', ['list'], { env: { PATH: fake.path }, encoding: 'utf8' });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('PID\tStatus\tLabel\n');
    expect(result.stderr).toBe('');
    expect(fake.calls()).toEqual(['list']);
  });

  it('refuses the installation when the recorder cannot write its call log', () => {
    const root = tmp.make('unwritable-log');
    // A folder where the recorder appends its log: the append fails for every user, root included, which a read-only
    // file would not guarantee.
    mkdirSync(join(root, 'fake-launchctl-bin', 'calls.log'), { recursive: true });

    expect(() => installFakeLaunchctl(root, '/usr/bin:/bin')).toThrow(/did not log its self-check/);
  });

  it('throws instead of answering no calls when the log is gone after the installation', () => {
    const root = tmp.make('log-removed');
    const fake = installFakeLaunchctl(root, '/usr/bin:/bin');
    expect(fake.calls()).toEqual([]);

    rmSync(root, { recursive: true, force: true });

    expect(() => fake.calls()).toThrow(/call log is missing/);
  });

  it('refuses a root that holds the PATH delimiter', () => {
    const root = join(tmp.make('delimiter'), `a${delimiter}b`);

    expect(() => installFakeLaunchctl(root)).toThrow(/PATH delimiter/);
  });
});
