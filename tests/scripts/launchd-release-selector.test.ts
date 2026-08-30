/**
 * The launchd release selector: which release does a job ACTUALLY execute?
 *
 * These cases encode the mini11 incident. The observer used to read the plist's
 * `WorkingDirectory`, which selects nothing — it only sets cwd. The release a
 * job runs is selected by `ProgramArguments`: the wrapper symlink for the bot
 * and fleet jobs, the absolute script path for the auxiliary jobs. Every case
 * below therefore points `WorkingDirectory` somewhere the answer must NOT come
 * from.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createReleaseSnapshotPlan } from '../../scripts/release-snapshot-plan.ts';
import {
  LaunchdReleaseSelectorError,
  resolveLaunchdReleaseSelection,
} from '../../scripts/lib/launchd-release-selector.ts';

let tmpRoot = '';

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

/**
 * Build a release export whose tracked files include the wrapper the bot job
 * runs, so a wrapper-symlink fixture does not read as an untracked extra file.
 */
function writeRelease(commit: string): string {
  const sourceRoot = path.join(tmpRoot, `source-${commit}`);
  const releaseRoot = path.join(tmpRoot, 'releases');
  mkdirSync(path.join(sourceRoot, 'src'), { recursive: true });
  mkdirSync(path.join(sourceRoot, 'deploy/scripts'), { recursive: true });
  writeFileSync(path.join(sourceRoot, 'package.json'), '{"name":"fixture"}\n', 'utf8');
  writeFileSync(path.join(sourceRoot, 'src/bootstrap.ts'), 'export const boot = true;\n', 'utf8');
  writeFileSync(path.join(sourceRoot, 'deploy/whatsoup'), '#!/usr/bin/env bash\n', 'utf8');
  writeFileSync(path.join(sourceRoot, 'deploy/scripts/harness-maintenance.sh'), '#!/usr/bin/env bash\n', 'utf8');
  const trackedFiles = ['package.json', 'src/bootstrap.ts', 'deploy/whatsoup', 'deploy/scripts/harness-maintenance.sh'];
  const plan = createReleaseSnapshotPlan({
    sourceRoot,
    sourceRef: 'HEAD',
    sourceCommit: commit,
    releaseRoot,
    buildTime: '2026-06-14T06:00:00.000Z',
    trackedFiles,
  });
  const releasePath = plan.manifest.release.path;
  for (const relativePath of trackedFiles) {
    mkdirSync(path.join(releasePath, path.dirname(relativePath)), { recursive: true });
    writeFileSync(path.join(releasePath, relativePath), readFileSync(path.join(sourceRoot, relativePath)));
  }
  writeFileSync(
    path.join(releasePath, '.whatsoup-release-manifest.json'),
    `${JSON.stringify(plan.manifest, null, 2)}\n`,
    'utf8',
  );
  return releasePath;
}

function writePlist(name: string, programArguments: string[], workingDirectory: string | null): string {
  const plistPath = path.join(tmpRoot, `${name}.plist`);
  const args = programArguments.map((arg) => `    <string>${arg}</string>`).join('\n');
  const workingDirectoryBlock = workingDirectory === null
    ? ''
    : `  <key>WorkingDirectory</key>\n  <string>${workingDirectory}</string>\n`;
  writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${name}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
${workingDirectoryBlock}</dict>
</plist>
`, 'utf8');
  return plistPath;
}

function newTmpRoot(): void {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'whatsoup-launchd-release-selector-'));
}

/** `~/.local/bin/<name>` → `<release>/deploy/<name>`, as `deploy/setup.sh` installs it. */
function linkWrapper(name: string, releasePath: string): string {
  const binDir = path.join(tmpRoot, 'bin');
  mkdirSync(binDir, { recursive: true });
  const wrapperLink = path.join(binDir, name);
  symlinkSync(path.join(releasePath, 'deploy/whatsoup'), wrapperLink);
  return wrapperLink;
}

describe('launchd release selector', () => {
  it('selects the wrapper symlink target for a bot job, not WorkingDirectory', () => {
    newTmpRoot();
    const running = writeRelease('aaaaaaaaaaaa1111');
    const stale = writeRelease('bbbbbbbbbbbb2222');
    const plistPath = writePlist('com.whatsoup.personal', [linkWrapper('whatsoup', running), 'personal'], stale);

    const selection = resolveLaunchdReleaseSelection(plistPath);

    expect(selection.releasePath).toBe(running);
    expect(selection.selector).toBe('wrapper-symlink');
    expect(selection.selectorPath).toBe(path.join(running, 'deploy/whatsoup'));
    expect(selection.label).toBe('com.whatsoup.personal');
    expect(selection.workingDirectory).toBe(stale);
    expect(selection.workingDirectoryReleasePath).toBe(stale);
  });

  it('follows a multi-hop wrapper symlink chain to the release that actually runs', () => {
    newTmpRoot();
    const running = writeRelease('aaaaaaaaaaaa1111');
    const stale = writeRelease('bbbbbbbbbbbb2222');
    const direct = linkWrapper('whatsoup', running);
    const indirect = path.join(tmpRoot, 'bin', 'whatsoup-current');
    symlinkSync(direct, indirect);

    const selection = resolveLaunchdReleaseSelection(writePlist('com.whatsoup.personal', [indirect, 'personal'], stale));

    expect(selection.releasePath).toBe(running);
    expect(selection.selector).toBe('wrapper-symlink');
  });

  it('selects the absolute script path for an auxiliary job, not WorkingDirectory', () => {
    newTmpRoot();
    const running = writeRelease('aaaaaaaaaaaa1111');
    const stale = writeRelease('bbbbbbbbbbbb2222');
    const plistPath = writePlist(
      'com.whatsoup.harness-maintenance',
      ['/bin/bash', path.join(running, 'deploy/scripts/harness-maintenance.sh')],
      stale,
    );

    const selection = resolveLaunchdReleaseSelection(plistPath);

    expect(selection.releasePath).toBe(running);
    expect(selection.selector).toBe('program-argument');
    expect(selection.selectorPath).toBe(path.join(running, 'deploy/scripts/harness-maintenance.sh'));
    expect(selection.workingDirectoryReleasePath).toBe(stale);
  });

  it('takes the first release-bearing argument, so a later absolute flag value cannot win', () => {
    newTmpRoot();
    const running = writeRelease('aaaaaaaaaaaa1111');
    const other = writeRelease('bbbbbbbbbbbb2222');
    // Shape of com.whatsoup.release-drift-check: the observed instance plist is
    // passed as a flag VALUE after the script path and must not be mistaken for
    // the release selector.
    const plistPath = writePlist('com.whatsoup.release-drift-check', [
      '/bin/bash',
      path.join(running, 'deploy/scripts/harness-maintenance.sh'),
      '--launchd-plist',
      path.join(other, 'deploy/whatsoup'),
    ], running);

    expect(resolveLaunchdReleaseSelection(plistPath).releasePath).toBe(running);
  });

  it('falls through a pinned-node interpreter argv0 instead of deriving a release from it', () => {
    newTmpRoot();
    const running = writeRelease('aaaaaaaaaaaa1111');
    // A pinned Node binary lives deep under $HOME; walking up from it must find
    // no release marker rather than resolving to some ancestor directory.
    const nodeBin = path.join(tmpRoot, 'node-runtime/versions/v24.15.0/bin/node');
    mkdirSync(path.dirname(nodeBin), { recursive: true });
    writeFileSync(nodeBin, '', 'utf8');
    const plistPath = writePlist('com.whatsoup.personal', [nodeBin, path.join(running, 'src/bootstrap.ts')], running);

    const selection = resolveLaunchdReleaseSelection(plistPath);

    expect(selection.releasePath).toBe(running);
    expect(selection.selector).toBe('program-argument');
    expect(selection.selectorPath).toBe(path.join(running, 'src/bootstrap.ts'));
  });

  it('fails closed when no argument resolves to a release, even though WorkingDirectory would', () => {
    newTmpRoot();
    const stale = writeRelease('bbbbbbbbbbbb2222');
    const plistPath = writePlist(
      'com.whatsoup.harness-maintenance',
      ['/bin/bash', path.join(tmpRoot, 'not-a-release/harness-maintenance.sh')],
      stale,
    );

    expect(() => resolveLaunchdReleaseSelection(plistPath)).toThrow(LaunchdReleaseSelectorError);
  });

  it('fails closed when the plist has no ProgramArguments at all', () => {
    newTmpRoot();
    const stale = writeRelease('bbbbbbbbbbbb2222');
    const plistPath = path.join(tmpRoot, 'com.whatsoup.empty.plist');
    writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.whatsoup.empty</string>
  <key>WorkingDirectory</key>
  <string>${stale}</string>
</dict>
</plist>
`, 'utf8');

    expect(() => resolveLaunchdReleaseSelection(plistPath)).toThrow(LaunchdReleaseSelectorError);
  });

  it('reports no WorkingDirectory cross-check when the plist sets none', () => {
    newTmpRoot();
    const running = writeRelease('aaaaaaaaaaaa1111');
    const plistPath = writePlist('com.whatsoup.personal', [linkWrapper('whatsoup', running), 'personal'], null);

    const selection = resolveLaunchdReleaseSelection(plistPath);

    expect(selection.releasePath).toBe(running);
    expect(selection.workingDirectory).toBeNull();
    expect(selection.workingDirectoryReleasePath).toBeNull();
  });

  it('agrees with the selector when WorkingDirectory names the running release', () => {
    newTmpRoot();
    const running = writeRelease('aaaaaaaaaaaa1111');
    const plistPath = writePlist('com.whatsoup.personal', [linkWrapper('whatsoup', running), 'personal'], running);

    const selection = resolveLaunchdReleaseSelection(plistPath);

    expect(selection.workingDirectoryReleasePath).toBe(selection.releasePath);
  });
});
