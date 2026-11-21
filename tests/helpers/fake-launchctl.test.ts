import { spawnSync } from 'node:child_process';
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

  it('refuses a root that holds the PATH delimiter', () => {
    const root = join(tmp.make('delimiter'), `a${delimiter}b`);

    expect(() => installFakeLaunchctl(root)).toThrow(/PATH delimiter/);
  });
});
