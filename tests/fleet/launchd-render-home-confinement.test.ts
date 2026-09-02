/**
 * F6 — home confinement at RENDER admission, physically resolved.
 *
 * The route-layer guard (src/fleet/routes/ops.ts) closes the write ingress, but
 * it cannot close this one. At admission a DANGLING symlink reads as absent:
 * `realpathExistingPrefix` walks up to the nearest existing ancestor, lands back
 * inside home, and accepts the value. Whoever can later create the link target
 * then decides where the path points by the time the plist is rendered — for a
 * link into a world-writable directory, that is any unprivileged user. No
 * traversal syntax is involved, so the raw spelling equals the resolved
 * spelling and neither `path.resolve` nor a raw-vs-resolved comparison fires.
 *
 * These tests run against the REAL filesystem with real symlinks. They do not
 * mock `fs`, because the property under test IS filesystem behaviour: a test
 * that mocked the resolver would only prove the mock agrees with itself.
 *
 *   npx vitest run tests/fleet/launchd-render-home-confinement.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { assertHomeConfinedRenderOptions } from '../../src/fleet/platform.ts';
import { isPhysicallyInsideHome } from '../../src/lib/home-confinement.ts';
import { LaunchdRenderConfigError } from '../../src/lib/launchd-service-config.ts';

describe('assertHomeConfinedRenderOptions — physical render admission', () => {
  let tmpDir: string;
  let home: string;
  let outside: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-render-confine-'));
    home = path.join(tmpDir, 'home');
    outside = path.join(tmpDir, 'outside');
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(outside, 'bin'), { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -- positive control -----------------------------------------------------

  it('admits a fully existing directory inside home', () => {
    const good = path.join(home, 'pin', 'bin');
    fs.mkdirSync(good, { recursive: true, mode: 0o700 });
    const cfg = path.join(home, '.config', 'claude-instance');
    fs.mkdirSync(cfg, { recursive: true, mode: 0o700 });

    expect(() => assertHomeConfinedRenderOptions(
      { claudeConfigDir: cfg, pathPrepend: [good] }, home,
    )).not.toThrow();
  });

  it('is a no-op when the block carries neither field', () => {
    expect(() => assertHomeConfinedRenderOptions({}, home)).not.toThrow();
    expect(() => assertHomeConfinedRenderOptions({ pathPrepend: [] }, home)).not.toThrow();
  });

  // -- (a) `..` after a symlinked directory ---------------------------------

  it('refuses `..` traversal through a symlinked directory', () => {
    fs.mkdirSync(path.join(tmpDir, 'escape'), { recursive: true, mode: 0o700 });
    fs.symlinkSync(outside, path.join(home, 'jump'));
    // String concatenation, not path.join: path.join would normalize the `..`
    // away and the fixture would stop exercising the defect.
    const raw = `${home}/jump/../escape`;

    // The fixture is only meaningful if it looks in-home lexically.
    expect(path.resolve(raw)).toBe(path.join(home, 'escape'));
    expect(fs.realpathSync.native(raw).startsWith(home + path.sep)).toBe(false);

    // The render guard refuses this on SPELLING now, because the canonical rule
    // runs first and no `..` component survives it. The physical defence still
    // has to hold underneath, or removing the spelling gate would silently
    // reopen the traversal: assert the predicate directly so the gate cannot
    // mask its rot.
    expect(isPhysicallyInsideHome(raw, home)).toBe(false);
    expect(() => assertHomeConfinedRenderOptions({ pathPrepend: [raw] }, home))
      .toThrow(LaunchdRenderConfigError);
    expect(() => assertHomeConfinedRenderOptions({ pathPrepend: [raw] }, home))
      .toThrow(/service\.pathPrepend\[0\] must be a normalized absolute path within the home directory/);
  });

  // -- (b) plain in-home path through a DANGLING symlink --------------------

  it('refuses a plain in-home path whose intermediate segment is a dangling symlink', () => {
    const target = path.join(tmpDir, 'later-created');
    fs.symlinkSync(target, path.join(home, 'dangle')); // target does NOT exist yet
    const raw = path.join(home, 'dangle', 'bin');

    // This is the case that defeats admission-time confinement: no traversal
    // syntax, so raw and resolved are identical and the spelling is canonical.
    expect(raw).toBe(path.resolve(raw));
    expect(() => fs.realpathSync.native(raw)).toThrow();

    expect(() => assertHomeConfinedRenderOptions({ pathPrepend: [raw] }, home))
      .toThrow(LaunchdRenderConfigError);
  });

  it('still refuses that path once the link target is created outside home', () => {
    // Proves the refusal is not incidental to the target being absent: the
    // same spelling resolves OUTSIDE home the moment an unprivileged writer
    // creates the target, which is the whole point of refusing it earlier.
    const target = path.join(tmpDir, 'later-created');
    fs.symlinkSync(target, path.join(home, 'dangle'));
    const raw = path.join(home, 'dangle', 'bin');
    fs.mkdirSync(path.join(target, 'bin'), { recursive: true, mode: 0o700 });

    expect(fs.realpathSync.native(raw).startsWith(home + path.sep)).toBe(false);
    expect(() => assertHomeConfinedRenderOptions({ pathPrepend: [raw] }, home))
      .toThrow(LaunchdRenderConfigError);
  });

  // -- (c) non-existent intermediate segment --------------------------------

  it('admits an absent LEAF inside an existing in-home parent', () => {
    // One level of tolerance, matching API admission: a directory the caller is
    // about to create inside an already-confined parent must still render.
    const parent = path.join(home, 'pin');
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    expect(() => assertHomeConfinedRenderOptions(
      { pathPrepend: [path.join(parent, 'not-yet')] }, home,
    )).not.toThrow();
  });

  it('admits a wholly absent in-home path, and refuses it once a dangling link appears in it', () => {
    // Absent is not an escape vector; PRESENT-BUT-UNRESOLVABLE is. Both halves
    // are asserted here so the tolerance cannot silently widen to cover the
    // dangling case.
    const raw = path.join(home, 'not-created-yet', 'bin');
    expect(fs.existsSync(raw)).toBe(false);
    expect(() => assertHomeConfinedRenderOptions({ pathPrepend: [raw] }, home)).not.toThrow();

    fs.symlinkSync(path.join(tmpDir, 'nowhere'), path.join(home, 'not-created-yet'));
    expect(() => assertHomeConfinedRenderOptions({ pathPrepend: [raw] }, home))
      .toThrow(LaunchdRenderConfigError);
  });

  it('refuses a dangling claudeConfigDir on the same rule', () => {
    fs.symlinkSync(path.join(tmpDir, 'nowhere'), path.join(home, 'cfg-dangle'));
    expect(() => assertHomeConfinedRenderOptions(
      { claudeConfigDir: path.join(home, 'cfg-dangle') }, home,
    )).toThrow(/service\.claudeConfigDir must resolve to a path inside the home directory/);
  });

  // -- absoluteness, and independence from the working directory ------------

  it('refuses non-absolute values from a working directory INSIDE home', () => {
    // The physical check makes a non-absolute input absolute against
    // process.cwd(). On a real host the repository root sits under the instance
    // user's home, which is exactly the shape reproduced here, and all three
    // spellings then resolve to an existing in-home directory and are admitted.
    // The shape rule refuses them at both production call sites, so this was
    // never live; the predicate simply must not depend on a check it does not
    // perform.
    const repoRoot = path.join(home, 'repo', 'checkout');
    fs.mkdirSync(repoRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(home, 'pin', 'bin'), { recursive: true, mode: 0o700 });

    const originalCwd = process.cwd();
    try {
      process.chdir(repoRoot);
      for (const value of ['~/.local/bin', '~', 'pin/bin']) {
        expect(
          () => assertHomeConfinedRenderOptions({ pathPrepend: [value] }, home),
          `expected a refusal for pathPrepend spelling ${value}`,
        ).toThrow(/service\.pathPrepend\[0\] must be a normalized absolute path within the home directory/);
        expect(
          () => assertHomeConfinedRenderOptions({ claudeConfigDir: value }, home),
          `expected a refusal for claudeConfigDir spelling ${value}`,
        ).toThrow(/service\.claudeConfigDir must be a normalized absolute path within the home directory/);
      }
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('refuses the same spellings from a working directory OUTSIDE home', () => {
    // Control: the refusal is a property of the value, not of where the
    // rendering process happens to be standing. Without the absoluteness rule
    // this test passes and the one above fails, which is precisely the
    // cwd-dependence being removed.
    fs.mkdirSync(path.join(home, 'pin', 'bin'), { recursive: true, mode: 0o700 });

    const originalCwd = process.cwd();
    try {
      process.chdir(outside);
      for (const value of ['~/.local/bin', '~', 'pin/bin']) {
        expect(
          () => assertHomeConfinedRenderOptions({ pathPrepend: [value] }, home),
          `expected a refusal for pathPrepend spelling ${value}`,
        ).toThrow(LaunchdRenderConfigError);
      }
    } finally {
      process.chdir(originalCwd);
    }
  });

  // -- canonical spelling, judged before physical resolution ----------------

  it('refuses a noncanonical spelling whose components ALL exist inside home', () => {
    const anchor = path.join(home, 'anchor');
    const destination = path.join(home, 'destination');
    fs.mkdirSync(anchor, { recursive: true, mode: 0o700 });
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    // String concatenation, not path.join: path.join normalizes the `..` away
    // and the fixture would stop exercising the defect.
    const raw = `${home}/anchor/../destination`;

    // The fixture is only meaningful if PHYSICAL resolution admits it. Both
    // components exist and the value resolves inside home right now, so the
    // physical check cannot be what refuses it, and before the spelling rule
    // this value was rendered verbatim into PATH.
    expect(fs.realpathSync.native(raw)).toBe(fs.realpathSync.native(destination));
    expect(isPhysicallyInsideHome(raw, home)).toBe(true);

    // Why it still has to be refused: the kernel re-resolves that `..` at every
    // exec against whatever the filesystem looks like then, so replacing
    // `anchor` with a symlink later moves where the same STORED string points.
    expect(() => assertHomeConfinedRenderOptions({ pathPrepend: [raw] }, home))
      .toThrow(/service\.pathPrepend\[0\] must be a normalized absolute path within the home directory/);
    expect(() => assertHomeConfinedRenderOptions({ claudeConfigDir: raw }, home))
      .toThrow(/service\.claudeConfigDir must be a normalized absolute path within the home directory/);
  });

  it('refuses a single-dot component and a doubled separator, and admits the canonical spelling', () => {
    const destination = path.join(home, 'destination');
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });

    for (const raw of [`${home}/./destination`, `${home}//destination`]) {
      expect(
        () => assertHomeConfinedRenderOptions({ pathPrepend: [raw] }, home),
        `expected a spelling refusal for ${raw}`,
      ).toThrow(/service\.pathPrepend\[0\] must be a normalized absolute path within the home directory/);
    }

    // Positive control, and the reason this rule costs operators nothing: the
    // canonical spelling of the SAME directory is admitted, so the rule refuses
    // spellings rather than paths.
    expect(() => assertHomeConfinedRenderOptions({ pathPrepend: [destination] }, home)).not.toThrow();
  });

  // -- boundary --------------------------------------------------------------

  it('refuses the home directory itself and a plain symlink out of home', () => {
    expect(() => assertHomeConfinedRenderOptions({ pathPrepend: [home] }, home))
      .toThrow(LaunchdRenderConfigError);

    fs.symlinkSync(path.join(outside, 'bin'), path.join(home, 'plain-link'));
    expect(() => assertHomeConfinedRenderOptions(
      { pathPrepend: [path.join(home, 'plain-link')] }, home,
    )).toThrow(LaunchdRenderConfigError);
  });

  it('reports the offending index for a later pathPrepend entry', () => {
    const good = path.join(home, 'pin', 'bin');
    fs.mkdirSync(good, { recursive: true, mode: 0o700 });
    fs.symlinkSync(path.join(tmpDir, 'nowhere'), path.join(home, 'dangle'));
    expect(() => assertHomeConfinedRenderOptions(
      { pathPrepend: [good, path.join(home, 'dangle', 'bin')] }, home,
    )).toThrow(/service\.pathPrepend\[1\]/);
  });

  it('never echoes the offending path in the message', () => {
    // LaunchdRenderConfigError messages are printed verbatim to operators, so
    // they must carry the rule and the field, never config content.
    fs.symlinkSync(path.join(tmpDir, 'nowhere'), path.join(home, 'secret-instance-name'));
    const secret = path.join(home, 'secret-instance-name', 'bin');
    try {
      assertHomeConfinedRenderOptions({ pathPrepend: [secret] }, home);
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(LaunchdRenderConfigError);
      expect((err as Error).message).not.toContain('secret-instance-name');
      expect((err as Error).message).not.toContain(home);
    }
  });

  // -------------------------------------------------------------------------
  // BINDING SCOPE CONDITION from the fleet service-path survey, an external
  // campaign record that is not part of this repository: the predicate applies
  // to each pathPrepend ENTRY and to claudeConfigDir, NEVER to the joined
  // rendered PATH. buildPlist composes the entries ahead of the generating shell's
  // ambient tail, and that tail carries out-of-home system directories on every
  // real host, so a predicate over the joined value refuses every live row while
  // the same predicate over the entries refuses none.
  // -------------------------------------------------------------------------

  it('applies the predicate to the entries and NOT to the joined rendered PATH', async () => {
    const good = path.join(home, 'pin', 'bin');
    fs.mkdirSync(good, { recursive: true, mode: 0o700 });

    // Admission passes on the ENTRY.
    expect(() => assertHomeConfinedRenderOptions({ pathPrepend: [good] }, home)).not.toThrow();

    // The value that actually reaches the plist is the entry joined with the
    // ambient tail, and that joined string is NOT home-confined. If the
    // predicate were ever applied to it, this render would be refused.
    const { buildPlist } = await import('../../src/fleet/platform.ts');
    const rendered = buildPlist('agent', { pathPrepend: [good] });
    // Locate the value by its KEY, not by searching for a line that happens to
    // contain the entry. A `find` over every `<string>` line would also match
    // CLAUDE_CONFIG_DIR, or any future key carrying the same directory, so it
    // could assert about the wrong value while looking green.
    const lines = rendered.split('\n');
    const pathKeyIndex = lines.findIndex((line) => line.includes('<key>PATH</key>'));
    expect(pathKeyIndex, 'the rendered plist must carry a PATH key').toBeGreaterThanOrEqual(0);
    const pathValue = lines[pathKeyIndex + 1];
    expect(pathValue, 'the PATH key must be followed by its string value')
      .toMatch(/^\s*<string>.*<\/string>\s*$/);

    // Prove the joined value genuinely leaves home, so this test cannot pass
    // vacuously on a machine whose ambient PATH happened to be home-confined.
    const joined = pathValue!.replace(/^\s*<string>/, '').replace(/<\/string>\s*$/, '');
    const segments = joined.split(':');
    expect(segments[0]).toBe(good);
    expect(
      segments.slice(1).some((segment) => segment !== '' && !segment.startsWith(home + path.sep)),
      'the ambient tail must carry at least one out-of-home directory',
    ).toBe(true);
  });
});
