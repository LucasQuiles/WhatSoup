import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const scriptPath = path.join(repoRoot, 'deploy/scripts/render-release-drift-launchd.sh');
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
  it('renders the release drift LaunchAgent with absolute paths and instance plist target', () => {
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
    expect(result.stdout).toContain(`${repoRoot}/scripts/run-with-pinned-node.sh`);
    expect(result.stdout).toContain(`${repoRoot}/scripts/live-release-drift-alert.ts`);
    expect(result.stdout).toContain(`${home}/Library/LaunchAgents/com.whatsoup.sample-bot.plist`);
    expect(result.stdout).toContain('<string>--instance</string>\n    <string>sample-bot</string>');
    expect(result.stdout).not.toContain('__WHATSOUP_REPO_ROOT__');
    expect(result.stdout).not.toContain('__HOME__');
    expect(result.stdout).not.toContain('__INSTANCE__');
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
