/**
 * #3829: the decoder behind the launchd plist removal checks. The service manager
 * tests replace readFileFlags with values written as sys/stat.h bits, so this file
 * ties the text stat(1) prints to those same bits.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseFileFlags, readFileFlags } from '../../src/fleet/launchd-plist-flags.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('launchd-plist-flags-');

describe('parseFileFlags', () => {
  // stat -f %f prints the flags word in decimal; each expected value is the bit
  // as src/fleet/platform.ts writes it in its masks.
  it.each([
    ['UF_IMMUTABLE (uchg)', '2', 0x2],
    ['UF_APPEND (uappnd)', '4', 0x4],
    ['SF_IMMUTABLE (schg)', '131072', 0x20000],
    ['SF_APPEND (sappnd)', '262144', 0x40000],
    ['SF_NOUNLINK (sunlnk)', '1048576', 0x100000],
    ['UF_HIDDEN, which no mask holds', '32768', 0x8000],
    ['uchg, schg and sunlnk together', '1179650', 0x2 | 0x20000 | 0x100000],
    ['no flag', '0', 0],
    ['the largest 32-bit flags word', '4294967295', 0xffff_ffff],
  ])('decodes %s from %j', (_name, output, expected) => {
    expect(parseFileFlags(output)).toBe(expected);
  });

  it.each([
    ['a trailing newline', '131072\n', 0x20000],
    ['surrounding spaces and a tab', ' \t262144 \n', 0x40000],
  ])('ignores %s around the number', (_name, output, expected) => {
    expect(parseFileFlags(output)).toBe(expected);
  });

  it.each([
    ['empty output', ''],
    ['whitespace only', ' \n'],
    ['a word', 'uchg'],
    ['a negative number', '-2'],
    ['a hex-looking value', '0x20000'],
    ['a signed value', '+2'],
    ['a fraction', '2.0'],
    ['an exponent', '1e5'],
    ['two numbers', '2 4'],
    ['one more than the 32-bit range', '4294967296'],
    ['a number beyond a safe integer', '99999999999999999999'],
  ])('refuses %s', (_name, output) => {
    expect(parseFileFlags(output)).toBeNull();
  });
});

describe('readFileFlags', () => {
  // @skip-env stat -f %f and chflags are the BSD tools of macOS; GNU stat reads -f as --file-system.
  it.skipIf(process.platform !== 'darwin')('decodes what the real stat prints for a file with the user immutable flag (uchg, 2)', () => {
    const file = path.join(tmp.make('uchg'), 'flagged');
    writeFileSync(file, '');
    // A fresh file carries no flag, so the value after chflags is uchg alone.
    expect(readFileFlags(file)).toBe(0);
    try {
      expect(spawnSync('/usr/bin/chflags', ['uchg', file]).status).toBe(0);
      expect(readFileFlags(file)).toBe(0x2);
    } finally {
      // The folder cleanup runs after this and cannot remove a uchg file.
      spawnSync('/usr/bin/chflags', ['nouchg', file]);
    }
  });
});
