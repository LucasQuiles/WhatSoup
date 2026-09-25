import { spawnSync } from 'node:child_process';
import { execSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const scriptPath = path.join(repoRoot, 'deploy/scripts/render-release-drift-launchd.sh');
const rotateScript = path.join(repoRoot, 'deploy/scripts/rotate-release-drift-logs.sh');
const scheduleScript = path.join(repoRoot, 'deploy/scripts/run-release-drift-schedule.sh');
const tmp = trackTmpDirs('release-drift-launchd-');

function makeTmpRoot(): string {
  return tmp.make('render');
}

function runRenderer(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync('bash', [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('render-release-drift-launchd.sh', () => {
  it('renders the release observers with separate drift and currency inputs', () => {
    const home = makeTmpRoot();

    const result = runRenderer([
      '--instance',
      'sample-bot',
      '--repo-root',
      repoRoot,
      '--home',
      home,
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('<string>com.whatsoup.release-drift-check</string>');
    expect(result.stdout).toContain(`${repoRoot}/deploy/scripts/run-release-drift-schedule.sh`);
    expect(result.stdout).toContain(`${home}/Library/LaunchAgents/com.whatsoup.sample-bot.plist`);
    expect(result.stdout).toContain('<string>--instance</string>\n    <string>sample-bot</string>');
    expect(result.stdout).toContain('<string>--target-url</string>');
    expect(result.stdout).toContain('<string>https://github.com/LucasQuiles/WhatSoup.git</string>');
    expect(result.stdout).toContain('<string>--target-ref</string>');
    expect(result.stdout).toContain('<string>refs/heads/main</string>');
    expect(result.stdout).toContain('<string>--clear-on-ok</string>');
    expect(result.stdout).not.toContain('__WHATSOUP_REPO_ROOT__');
    expect(result.stdout).not.toContain('__HOME__');
    expect(result.stdout).not.toContain('__INSTANCE__');
    expect(result.stdout).not.toContain('__TARGET_URL__');
    expect(result.stdout).not.toContain('__TARGET_REF__');
  });

  it('renders an explicit reviewed remote and ref without shell interpolation', () => {
    const home = makeTmpRoot();
    const result = runRenderer([
      '--instance', 'sample-bot',
      '--repo-root', repoRoot,
      '--home', home,
      '--target-url', 'ssh://git@example.test/team/WhatSoup.git',
      '--target-ref', 'refs/heads/release/stable',
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('<string>ssh://git@example.test/team/WhatSoup.git</string>');
    expect(result.stdout).toContain('<string>refs/heads/release/stable</string>');
  });

  it('rejects unsafe target transports', () => {
    const home = makeTmpRoot();
    const result = runRenderer([
      '--instance', 'sample-bot',
      '--repo-root', repoRoot,
      '--home', home,
      '--target-url', 'ext::touch /tmp/unsafe',
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('unsafe --target-url');
  });

  it('writes to an explicit non-live output path', () => {
    const root = makeTmpRoot();
    const output = path.join(root, 'rendered.plist');

    const result = runRenderer([
      '--instance',
      'release-bot',
      '--repo-root',
      repoRoot,
      '--home',
      root,
      '--output',
      output,
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    const rendered = readFileSync(output, 'utf8');
    expect(rendered).toContain(`${root}/Library/LaunchAgents/com.whatsoup.release-bot.plist`);
  });

  it('rejects unsafe instance names that can alter the launchd path', () => {
    const root = makeTmpRoot();

    const result = runRenderer([
      '--instance',
      '../release-bot',
      '--repo-root',
      repoRoot,
      '--home',
      root,
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('unsafe --instance');
  });

  it('refuses direct writes into the live LaunchAgents directory', () => {
    const root = makeTmpRoot();
    const liveOutput = path.join(root, 'Library/LaunchAgents/com.whatsoup.release-drift-check.plist');

    const result = runRenderer([
      '--instance',
      'release-bot',
      '--repo-root',
      repoRoot,
      '--home',
      root,
      '--output',
      liveOutput,
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('refusing to write directly to LaunchAgents');
  });

  it('does not embed launchctl mutations', () => {
    const source = readFileSync(scriptPath, 'utf8');
    expect(source).not.toMatch(/\blaunchctl\b/);
  });
});

describe('render-release-drift-launchd.sh #2458: bounded rotation for the launchd sink', () => {
  it('renders the schedule wrapper with default rotation bounds and observer passthrough', () => {
    const home = makeTmpRoot();

    const result = runRenderer(['--instance', 'sample-bot', '--repo-root', repoRoot, '--home', home]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('<string>com.whatsoup.release-drift-check</string>');
    expect(result.stdout).toContain(`${repoRoot}/deploy/scripts/run-release-drift-schedule.sh`);
    expect(result.stdout).toContain('<string>--max-log-bytes</string>');
    expect(result.stdout).toContain('<string>5242880</string>');
    expect(result.stdout).toContain('<string>--keep-rotated-logs</string>');
    expect(result.stdout).toContain('<string>5</string>');
    expect(result.stdout).toContain(`${home}/Library/LaunchAgents/com.whatsoup.sample-bot.plist`);
    expect(result.stdout).toContain('<string>--instance</string>\n    <string>sample-bot</string>');
    expect(result.stdout).toContain('<string>--target-url</string>');
    expect(result.stdout).toContain('<string>--target-ref</string>');
    expect(result.stdout).toContain('<string>--clear-on-ok</string>');
    expect(result.stdout).not.toContain('__MAX_LOG_BYTES__');
    expect(result.stdout).not.toContain('__KEEP_ROTATED_LOGS__');
  });

  it('renders explicit rotation bounds and rejects non-numeric values', () => {
    const home = makeTmpRoot();

    const explicit = runRenderer([
      '--instance', 'sample-bot',
      '--repo-root', repoRoot,
      '--home', home,
      '--max-log-bytes', '1048576',
      '--keep-rotated-logs', '3',
    ]);
    expect(explicit.exitCode, explicit.stderr).toBe(0);
    expect(explicit.stdout).toContain('<string>1048576</string>');
    expect(explicit.stdout).toContain('<string>3</string>');

    const bad = runRenderer([
      '--instance', 'sample-bot',
      '--repo-root', repoRoot,
      '--home', home,
      '--max-log-bytes', 'not-a-number',
    ]);
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toContain('unsafe --max-log-bytes');

    const zero = runRenderer([
      '--instance', 'sample-bot',
      '--repo-root', repoRoot,
      '--home', home,
      '--keep-rotated-logs', '0',
    ]);
    expect(zero.exitCode).not.toBe(0);
    expect(zero.stderr).toContain('unsafe --keep-rotated-logs');
  });

  it('rotate-release-drift-logs.sh archives oversized logs and keeps at most keep+1 files', () => {
    const root = makeTmpRoot();
    const log = path.join(root, 'release-drift-check.log');

    for (let round = 1; round <= 4; round += 1) {
      writeFileSync(log, `round-${round}-content\n`.repeat(20), 'utf8');
      const rotated = spawnSync('bash', [rotateScript, '--log', log, '--max-bytes', '40', '--keep', '2'], { encoding: 'utf8' });
      expect(rotated.status, String(rotated.stderr)).toBe(0);
    }

    const names = readdirSync(root).sort();
    expect(names).toEqual(['release-drift-check.log', 'release-drift-check.log.1.gz', 'release-drift-check.log.2.gz']);
    const archived = execSync(`gunzip -c ${JSON.stringify(path.join(root, 'release-drift-check.log.1.gz'))}`, { encoding: 'utf8' });
    expect(archived).toContain('round-4-content');
    expect(readFileSync(log, 'utf8')).toBe('');
  });

  it('rotation failure is fail-visible and preserves the unrotated evidence', () => {
    const root = makeTmpRoot();
    const log = path.join(root, 'nested', 'release-drift-check.log');
    mkdirSync(path.dirname(log));
    writeFileSync(log, 'precious-evidence\n'.repeat(10), 'utf8');
    chmodSync(path.dirname(log), 0o500);

    try {
      const failed = spawnSync('bash', [rotateScript, '--log', log, '--max-bytes', '10', '--keep', '2'], { encoding: 'utf8' });
      expect(failed.status).not.toBe(0);
      expect(String(failed.stderr)).toContain('release-drift-log-rotation-failed');
    } finally {
      chmodSync(path.dirname(log), 0o700);
    }

    expect(readFileSync(log, 'utf8')).toContain('precious-evidence');
    expect(readdirSync(path.dirname(log))).toEqual(['release-drift-check.log']);
  });

  it('schedule wrapper rotates before exec and continues the observer on rotation failure', () => {
    const source = readFileSync(scheduleScript, 'utf8');
    const rotateIndex = source.indexOf('rotate-release-drift-logs.sh');
    // lastIndexOf: the usage text names the observer; the exec line is the semantic anchor.
    const execIndex = source.lastIndexOf('live-release-observers.ts');
    expect(rotateIndex, 'wrapper must invoke the rotation script').toBeGreaterThan(-1);
    expect(execIndex, 'wrapper must exec the observer').toBeGreaterThan(-1);
    expect(rotateIndex).toBeLessThan(execIndex);
    expect(source).toContain('release-drift-log-rotation-failed');
    expect(source).toMatch(/\|\|/);
    expect(source).not.toMatch(/\blaunchctl\b/);
    expect(readFileSync(rotateScript, 'utf8')).not.toMatch(/\blaunchctl\b/);
  });
});
