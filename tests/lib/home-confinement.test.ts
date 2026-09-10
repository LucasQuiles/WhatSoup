/**
 * Binding pin for the physical home-confinement primitive.
 *
 * `fs.realpathSync.native` is libc `realpath(3)` and resolves physically.
 * `fs.realpathSync` calls `path.resolve()` first, collapsing `..` textually
 * before any symlink is walked. Swapping the binding back therefore reintroduces
 * the traversal escape while every behavioural test still passes, because the
 * two agree on every input that has no `..` next to a symlink.
 *
 * These tests fail if the binding is swapped, by asserting the divergence
 * directly rather than trusting a comment.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  nothingExistsAt,
  realpathLongestAbsentTolerantPrefix,
  pathIsInsideRoot,
} from '../../src/lib/home-confinement.ts';

describe('home-confinement primitive', () => {
  let tmpDir: string;
  let home: string;
  let outside: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-hc-')));
    home = path.join(tmpDir, 'home');
    outside = path.join(tmpDir, 'outside');
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.mkdirSync(outside, { recursive: true, mode: 0o700 });
    fs.symlinkSync(outside, path.join(home, 'jump'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('the two realpath bindings genuinely disagree on `..` after a symlink', () => {
    // The premise of the pin. Both targets are made to exist so BOTH bindings
    // succeed and return different answers; if either threw, "they differ"
    // would be satisfied trivially by an error and would prove nothing.
    //
    // `<home>/jump/../target` with `jump -> <tmp>/outside`:
    //   JS     collapses `..` textually  -> <home>/target   (INSIDE home)
    //   native follows the symlink first -> <tmp>/target    (OUTSIDE home)
    fs.mkdirSync(path.join(home, 'target'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(tmpDir, 'target'), { recursive: true, mode: 0o700 });
    const raw = `${home}/jump/../target`;

    const jsAnswer = fs.realpathSync(raw);
    const nativeAnswer = fs.realpathSync.native(raw);
    expect(jsAnswer, 'the JS binding reports an IN-home answer').toBe(path.join(home, 'target'));
    expect(nativeAnswer, 'the native binding reports the OUT-of-home answer').toBe(path.join(tmpDir, 'target'));
    expect(jsAnswer).not.toBe(nativeAnswer);

    // And the primitive must side with the kernel, refusing the path.
    expect(() => realpathLongestAbsentTolerantPrefix(raw)).not.toThrow();
    expect(pathIsInsideRoot(home, realpathLongestAbsentTolerantPrefix(raw)))
      .toBe(false);
  });

  it('refuses `..` after a symlink out of home', () => {
    expect(() => realpathLongestAbsentTolerantPrefix(`${home}/jump/../absent-leaf`)).toThrow();
  });

  it('refuses an absent segment followed by `..` onto a pre-existing out-of-home symlink', () => {
    // The climb discards components right to left, so it would drop `jump`,
    // then `..`, then the absent segment, and land on home.
    expect(fs.existsSync(path.join(home, 'nope'))).toBe(false);
    expect(() => realpathLongestAbsentTolerantPrefix(`${home}/nope/../jump`)).toThrow();
    expect(() => realpathLongestAbsentTolerantPrefix(`${home}/nope/../jump/deeper`)).toThrow();
  });

  it('still tolerates a wholly absent in-home chain with no traversal', () => {
    // The tolerance that makes the default agent workspace work: several
    // not-yet-created segments below home, created after validation.
    expect(realpathLongestAbsentTolerantPrefix(path.join(home, 'a', 'b', 'c'))).toBe(home);
  });

  it('refuses a dangling symlink rather than climbing past it', () => {
    fs.symlinkSync(path.join(tmpDir, 'never-created'), path.join(home, 'dangle'));
    expect(() => realpathLongestAbsentTolerantPrefix(path.join(home, 'dangle', 'bin'))).toThrow();
  });

  it('sees a dangling symlink named with a trailing separator', () => {
    // POSIX reads a trailing separator as a following `.`, so `lstat(2)` on
    // `<link>/` reports on the link's TARGET, not on the link. An existence
    // probe that does not bare the path therefore calls a dangling link absent,
    // and the ancestor climb walks straight past it to an in-home ancestor —
    // the exact branch the refusal at the climb exists to take.
    fs.symlinkSync(path.join(tmpDir, 'never-created'), path.join(home, 'dangle'));
    const link = path.join(home, 'dangle');

    expect(nothingExistsAt(link), 'the link exists; only its target does not').toBe(false);
    expect(nothingExistsAt(`${link}/`), 'the same link, one character apart').toBe(false);
    expect(() => realpathLongestAbsentTolerantPrefix(link)).toThrow();
    expect(() => realpathLongestAbsentTolerantPrefix(`${link}/`)).toThrow();
  });

  it('keeps the root and the absent spellings unchanged while baring separators', () => {
    // Baring must never empty the string: `lstat('')` is ENOENT, which would
    // report the filesystem root as absent. `//` is the input that separates an
    // anchored strip from a length-guarded one.
    expect(nothingExistsAt('/'), 'the root exists').toBe(false);
    expect(nothingExistsAt('//'), 'still the root').toBe(false);

    const absent = path.join(home, 'no-such-entry');
    expect(nothingExistsAt(absent), 'nothing is there').toBe(true);
    expect(nothingExistsAt(`${absent}/`), 'still nothing is there').toBe(true);
  });

  it('still resolves a REAL directory named with a trailing separator', () => {
    // The compatibility control. Refusing the spelling outright would also
    // refuse an operator's already-persisted `<home>/bin/`, so the benign case
    // must survive unchanged.
    const real = path.join(home, 'realdir');
    fs.mkdirSync(real, { recursive: true, mode: 0o700 });

    expect(nothingExistsAt(`${real}/`), 'a real directory is not absent').toBe(false);
    expect(realpathLongestAbsentTolerantPrefix(`${real}/`)).toBe(real);
    expect(pathIsInsideRoot(home, realpathLongestAbsentTolerantPrefix(`${real}/`))).toBe(true);
  });

  it('pathIsInsideRoot accepts an in-root name that merely begins with dots', () => {
    // The over-rejection the duplicated copy in src/transport/auth-bond.ts had.
    expect(pathIsInsideRoot(home, path.join(home, '..config'))).toBe(true);
    expect(pathIsInsideRoot(home, path.join(tmpDir, 'elsewhere'))).toBe(false);
    expect(pathIsInsideRoot(home, home)).toBe(false);
  });
});
