import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createReleaseSnapshotPlan } from '../../scripts/release-snapshot-plan.ts';
import { checkLiveReleaseDrift, resolveReleasePathFromLaunchdPlist } from '../../scripts/live-release-drift-alert.ts';

let tmpRoot = '';
const oldBotErrorsStateDir = process.env.BOT_ERRORS_STATE_DIR;

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
  if (oldBotErrorsStateDir === undefined) delete process.env.BOT_ERRORS_STATE_DIR;
  else process.env.BOT_ERRORS_STATE_DIR = oldBotErrorsStateDir;
  process.exitCode = undefined;
});

function writeFixtureRelease(options: { drift?: boolean } = {}) {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'whatsoup-live-release-drift-alert-'));
  const sourceRoot = path.join(tmpRoot, 'source');
  const releaseRoot = path.join(tmpRoot, 'releases');
  mkdirSync(path.join(sourceRoot, 'src'), { recursive: true });
  writeFileSync(path.join(sourceRoot, 'package.json'), '{"name":"fixture"}\n', 'utf8');
  writeFileSync(path.join(sourceRoot, 'src/main.ts'), 'export const value = true;\n', 'utf8');
  const plan = createReleaseSnapshotPlan({
    sourceRoot,
    sourceRef: 'HEAD',
    sourceCommit: 'abc123def4567890',
    releaseRoot,
    buildTime: '2026-06-14T06:00:00.000Z',
    trackedFiles: ['package.json', 'src/main.ts'],
  });
  const releasePath = plan.manifest.release.path;
  mkdirSync(path.join(releasePath, 'src'), { recursive: true });
  writeFileSync(path.join(releasePath, 'package.json'), readFileSync(path.join(sourceRoot, 'package.json')));
  writeFileSync(
    path.join(releasePath, 'src/main.ts'),
    options.drift ? 'export const value = false;\n' : readFileSync(path.join(sourceRoot, 'src/main.ts')),
    'utf8',
  );
  writeFileSync(
    path.join(releasePath, '.whatsoup-release-manifest.json'),
    `${JSON.stringify(plan.manifest, null, 2)}\n`,
    'utf8',
  );
  return { releasePath, sourceRoot };
}

function outboxEvents(stateDir: string): Array<Record<string, unknown>> {
  const outbox = path.join(stateDir, 'outbox');
  return readdirSync(outbox)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(path.join(outbox, name), 'utf8')) as Record<string, unknown>);
}

function writeLaunchdPlist(releasePath: string): string {
  const plistPath = path.join(tmpRoot, 'com.whatsoup.release-bot.plist');
  writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.whatsoup.release-bot</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${releasePath}/src/bootstrap.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${releasePath}</string>
</dict>
</plist>
`, 'utf8');
  return plistPath;
}

describe('live release drift alert', () => {
  it('passes a clean release without emitting by default', () => {
    const { releasePath } = writeFixtureRelease();

    const result = checkLiveReleaseDrift({
      repoRoot: process.cwd(),
      releasePath,
      instance: 'release-bot',
      source: 'release-drift',
      emit: true,
      emitHelper: path.join(process.cwd(), 'deploy/scripts/bot-errors-emit.py'),
      python: 'python3',
      clearOnOk: false,
    });

    expect(result).toMatchObject({
      check: 'live-release-drift-alert',
      ok: true,
      releasePath,
      issues: [],
      alert: {
        required: false,
        attempted: false,
        kind: null,
      },
    });
  });

  it('queues a sanitized BOT ERRORS alert when release files drift', () => {
    const { releasePath } = writeFixtureRelease({ drift: true });
    const stateDir = path.join(tmpRoot, 'bot-errors-state');
    process.env.BOT_ERRORS_STATE_DIR = stateDir;

    const result = checkLiveReleaseDrift({
      repoRoot: process.cwd(),
      releasePath,
      instance: 'release-bot',
      source: 'release-drift',
      emit: true,
      emitHelper: path.join(process.cwd(), 'deploy/scripts/bot-errors-emit.py'),
      python: 'python3',
      clearOnOk: false,
    });

    expect(result.ok).toBe(false);
    expect(result.alert).toMatchObject({
      required: true,
      attempted: true,
      kind: 'alert',
      status: 0,
    });
    expect(result.issues).toEqual([
      expect.objectContaining({ kind: 'file-sha256-drift', path: 'src/main.ts' }),
    ]);
    const [event] = outboxEvents(stateDir);
    expect(event).toMatchObject({
      eventType: 'alert',
      severity: 'critical',
      instance: 'release-bot',
      source: 'release-drift',
    });
    expect(String(event.summary)).toContain('release drift detected');
    expect(String(event.evidence)).toContain('file-sha256-drift');
    expect(String(event.evidence)).toContain('src/main.ts');
  });

  it('CLI no-emit mode still exits nonzero on drift without writing an alert', () => {
    const { releasePath } = writeFixtureRelease({ drift: true });
    const scriptPath = path.join(process.cwd(), 'scripts/live-release-drift-alert.ts');
    const stateDir = path.join(tmpRoot, 'bot-errors-state');

    const proc = spawnSync(process.execPath, [
      '--disable-warning=ExperimentalWarning',
      '--experimental-strip-types',
      scriptPath,
      '--release',
      releasePath,
      '--no-emit',
      '--json',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: stateDir,
      },
    });

    expect(proc.status).toBe(1);
    expect(proc.stderr).toBe('');
    const result = JSON.parse(proc.stdout) as ReturnType<typeof checkLiveReleaseDrift>;
    expect(result).toMatchObject({
      ok: false,
      alert: {
        required: true,
        attempted: false,
        kind: 'alert',
      },
    });
    expect(() => readdirSync(path.join(stateDir, 'outbox'))).toThrow(/ENOENT/);
  });

  it('resolves the release path from a launchd plist WorkingDirectory', () => {
    const { releasePath } = writeFixtureRelease();
    const plistPath = writeLaunchdPlist(releasePath);

    expect(resolveReleasePathFromLaunchdPlist(plistPath)).toBe(releasePath);
  });

  it('CLI accepts launchd plist mode for the currently configured release path', () => {
    const { releasePath } = writeFixtureRelease();
    const plistPath = writeLaunchdPlist(releasePath);
    const scriptPath = path.join(process.cwd(), 'scripts/live-release-drift-alert.ts');

    const proc = spawnSync(process.execPath, [
      '--disable-warning=ExperimentalWarning',
      '--experimental-strip-types',
      scriptPath,
      '--launchd-plist',
      plistPath,
      '--no-emit',
      '--json',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(proc.status, proc.stderr || proc.stdout).toBe(0);
    const result = JSON.parse(proc.stdout) as ReturnType<typeof checkLiveReleaseDrift>;
    expect(result).toMatchObject({
      ok: true,
      releasePath,
      alert: {
        required: false,
        attempted: false,
      },
    });
  });

  it('rejects ambiguous release and launchd plist input', () => {
    const { releasePath } = writeFixtureRelease();
    const plistPath = writeLaunchdPlist(releasePath);
    const scriptPath = path.join(process.cwd(), 'scripts/live-release-drift-alert.ts');

    const proc = spawnSync(process.execPath, [
      '--disable-warning=ExperimentalWarning',
      '--experimental-strip-types',
      scriptPath,
      '--release',
      releasePath,
      '--launchd-plist',
      plistPath,
      '--no-emit',
      '--json',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(proc.status).toBe(2);
    expect(proc.stderr).toContain('--release and --launchd-plist are mutually exclusive');
  });
});
