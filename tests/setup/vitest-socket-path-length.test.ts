import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { makeSocketPath } from '../helpers/socket-rpc.ts';
import { RUN_ROOT_ENV, defaultTempParent } from './vitest-run-root.ts';

// macOS keeps a Unix socket path in a 104-byte sun_path that includes the
// terminating NUL; Linux allows 108. The suite runs on both, so the macOS limit
// applies everywhere.
const SOCKET_PATH_MAX = 103;

// The run root's parent is realpath('/tmp'): /private/tmp on macOS, /tmp on
// Linux. Measuring with the longer one keeps a Linux run as strict as a macOS run.
const MACOS_TEMP_PARENT = '/private/tmp';

describe('test socket paths under the run root', () => {
  // Every socket a test makes in its TMPDIR carries the run root and the worker
  // HOME in its path. The socket helper's name is longest with a 7-digit pid
  // (the Linux maximum) and a 13-digit millisecond stamp.
  it('keeps the longest socket helper path within the macOS limit', () => {
    const runRoot = process.env[RUN_ROOT_ENV] ?? '';
    const home = process.env['WHATSOUP_VITEST_HOME'] ?? '';
    expect(runRoot, 'the globalSetup exported no run root').not.toBe('');
    expect(dirname(runRoot)).toBe(defaultTempParent());
    expect(dirname(home)).toBe(runRoot);

    // The name format the longest path below assumes.
    const sample = makeSocketPath();
    expect(dirname(sample)).toBe(tmpdir());
    expect(basename(sample)).toMatch(/^whatsoup-test-\d{1,7}-\d{13}-[0-9a-f]{8}\.sock$/);

    // A test that loads src/config.ts gets that module's TMPDIR, <data root>/tmp
    // with the data root at <XDG_DATA_HOME>/whatsoup (src/config.ts:502, :551);
    // before that it has the setup file's TMPDIR. Take the longer one.
    const configTmpdir = join(process.env['XDG_DATA_HOME'] ?? '', 'whatsoup', 'tmp');
    const socketDir = configTmpdir.length >= tmpdir().length ? configTmpdir : tmpdir();
    const belowParent = relative(dirname(runRoot), socketDir);
    expect(belowParent.split(sep).slice(0, 2)).toEqual([basename(runRoot), basename(home)]);

    const parent = defaultTempParent().length >= MACOS_TEMP_PARENT.length ? defaultTempParent() : MACOS_TEMP_PARENT;
    const longest = join(parent, belowParent, `whatsoup-test-${'9'.repeat(7)}-${'9'.repeat(13)}-${'f'.repeat(8)}.sock`);
    expect(Buffer.byteLength(longest), longest).toBeLessThanOrEqual(SOCKET_PATH_MAX);
  });
});
