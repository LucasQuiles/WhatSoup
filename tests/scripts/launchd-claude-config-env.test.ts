// Host-level launchd jobs (harness-maintenance, reply-guarantee,
// release-drift-check) run the provider CLI but were rendered without
// CLAUDE_CONFIG_DIR, so on a bot host they read a different credential store
// than the bot (a stale CLI refreshed the shared login into the other store
// and the bot lost its credential). These tests pin the injector that carries
// the instance's `service.claudeConfigDir` into those renders, and the three
// shell call sites that must all apply it identically.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  injectClaudeConfigDir,
  resolveHostClaudeConfigDir,
  run,
} from '../../scripts/launchd-claude-config-env.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const harnessTemplate = fs.readFileSync(path.join(repoRoot, 'deploy', 'com.whatsoup.harness-maintenance.plist'), 'utf8');

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'launchd-claude-env-'));
}

function writeInstance(home: string, name: string, config: Record<string, unknown>): void {
  const dir = path.join(home, '.config', 'whatsoup', 'instances', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
}

function plistEnv(xml: string): Record<string, string> {
  const r = spawnSync('python3', ['-c', [
    'import json, plistlib, sys',
    'p = plistlib.loads(sys.stdin.buffer.read())',
    'print(json.dumps(p.get("EnvironmentVariables", {})))',
  ].join('\n')], { input: xml, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`plist parse failed: ${r.stderr}`);
  return JSON.parse(r.stdout) as Record<string, string>;
}

describe('injectClaudeConfigDir', () => {
  it('leaves the render byte-identical when no dir is configured', () => {
    expect(injectClaudeConfigDir(harnessTemplate, null)).toBe(harnessTemplate);
  });

  it('adds CLAUDE_CONFIG_DIR to EnvironmentVariables as valid plist XML', () => {
    const out = injectClaudeConfigDir(harnessTemplate, '/srv/bot/.claude');
    const env = plistEnv(out);
    expect(env['CLAUDE_CONFIG_DIR']).toBe('/srv/bot/.claude');
    expect(env['PATH']).toContain('/usr/bin');
  });

  it('XML-escapes the value', () => {
    const env = plistEnv(injectClaudeConfigDir(harnessTemplate, '/srv/a&b/<c>'));
    expect(env['CLAUDE_CONFIG_DIR']).toBe('/srv/a&b/<c>');
  });

  it('refuses a plist without an EnvironmentVariables dict', () => {
    expect(() => injectClaudeConfigDir('<plist><dict></dict></plist>', '/x')).toThrow(/EnvironmentVariables/);
  });

  it('refuses an empty <dict/> environment and a render that already carries the key', () => {
    const empty = harnessTemplate.replace(/<key>EnvironmentVariables<\/key>\s*<dict>[\s\S]*?<\/dict>/, '<key>EnvironmentVariables</key>\n  <dict/>');
    expect(empty).toContain('<dict/>');
    expect(() => injectClaudeConfigDir(empty, '/x')).toThrow(/EnvironmentVariables/);
    const once = injectClaudeConfigDir(harnessTemplate, '/srv/bot/.claude');
    expect(() => injectClaudeConfigDir(once, '/srv/other/.claude')).toThrow(/already/);
  });

  it('inserts inside a compact EnvironmentVariables dict, never after the next newline', () => {
    // The whole plist on one line: the first newline is past </dict>, so the
    // old "after the next newline" insertion put the key outside the dict.
    const compact = '<plist version="1.0"><dict><key>Label</key><string>x</string>'
      + '<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin</string></dict>'
      + '<key>RunAtLoad</key><false/></dict></plist>\n';
    const env = plistEnv(injectClaudeConfigDir(compact, '/srv/bot/.claude'));
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: '/srv/bot/.claude', PATH: '/usr/bin' });
  });

  it('keeps the plist valid when an existing value contains a newline', () => {
    const multiline = '<plist version="1.0"><dict><key>EnvironmentVariables</key><dict>'
      + '<key>NOTE</key><string>line one\nline two</string></dict></dict></plist>\n';
    const env = plistEnv(injectClaudeConfigDir(multiline, '/srv/bot/.claude'));
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: '/srv/bot/.claude', NOTE: 'line one\nline two' });
  });

  it('reuses the shared escaper and the hardened plist reader instead of local copies', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'scripts', 'launchd-claude-config-env.ts'), 'utf8');
    expect(src).not.toMatch(/function escapeXml/);
    expect(src).not.toMatch(/EnvironmentVariables<\\\/key>/);
    expect(src).toMatch(/import \{[^}]*escapeXml[^}]*\} from '\.\.\/src\/fleet\/platform\.ts'/);
    expect(src).toMatch(/from '\.\.\/src\/fleet\/launchd-env-drift\.ts'/);
  });
});

describe('--preserve-from carries a hand-added CLAUDE_CONFIG_DIR forward', () => {
  function installed(home: string, dir: string | null): string {
    const file = path.join(home, 'installed.plist');
    fs.writeFileSync(file, injectClaudeConfigDir(harnessTemplate, dir));
    return file;
  }

  function render(home: string, preserveFrom: string): { output: string; warning: string | null } {
    return run(['--home', home, '--preserve-from', preserveFrom], harnessTemplate, {});
  }

  it('keeps the installed value when no instance configures one', () => {
    const home = tmpHome();
    writeInstance(home, 'alpha-bot', {});
    const out = render(home, installed(home, '/srv/hand/.claude'));
    expect(plistEnv(out.output)['CLAUDE_CONFIG_DIR']).toBe('/srv/hand/.claude');
  });

  it('keeps the installed value when instances disagree', () => {
    const home = tmpHome();
    writeInstance(home, 'alpha-bot', { service: { claudeConfigDir: '/srv/a/.claude' } });
    writeInstance(home, 'beta-bot', { service: { claudeConfigDir: '/srv/b/.claude' } });
    const out = render(home, installed(home, '/srv/hand/.claude'));
    expect(plistEnv(out.output)['CLAUDE_CONFIG_DIR']).toBe('/srv/hand/.claude');
    expect(out.warning).toMatch(/2 different/);
  });

  it('lets a configured value win over the installed one', () => {
    const home = tmpHome();
    writeInstance(home, 'alpha-bot', { service: { claudeConfigDir: '/srv/bot/.claude' } });
    const out = render(home, installed(home, '/srv/hand/.claude'));
    expect(plistEnv(out.output)['CLAUDE_CONFIG_DIR']).toBe('/srv/bot/.claude');
  });

  it('is byte-identical when neither config nor the installed plist has a value', () => {
    const home = tmpHome();
    writeInstance(home, 'alpha-bot', {});
    expect(render(home, installed(home, null)).output).toBe(harnessTemplate);
    expect(render(home, path.join(home, 'not-installed.plist')).output).toBe(harnessTemplate);
  });

  it('fails closed when the installed plist mentions the key but the hardened reader refuses it', () => {
    const home = tmpHome();
    writeInstance(home, 'alpha-bot', {});
    const file = path.join(home, 'installed.plist');
    // Two EnvironmentVariables declarations: ambiguous, so the reader refuses.
    const ambiguous = injectClaudeConfigDir(harnessTemplate, '/srv/hand/.claude')
      .replace('<key>RunAtLoad</key>', '<key>EnvironmentVariables</key><dict/>\n  <key>RunAtLoad</key>');
    fs.writeFileSync(file, ambiguous);
    expect(() => render(home, file)).toThrow(/preserve-from/);
  });

  it('refuses numeric character references instead of changing or dropping the installed value', () => {
    const home = tmpHome();
    writeInstance(home, 'alpha-bot', {});
    const file = path.join(home, 'installed.plist');
    const base = injectClaudeConfigDir(harnessTemplate, '/srv/claude-bot');
    // &#45; is "-": carried forward literally it would name a different path.
    fs.writeFileSync(file, base.replace('/srv/claude-bot', '/srv/claude&#45;bot'));
    expect(plistEnv(fs.readFileSync(file, 'utf8'))['CLAUDE_CONFIG_DIR']).toBe('/srv/claude-bot');
    expect(() => render(home, file)).toThrow(/numeric character reference/);
    // An encoded key would otherwise hide the value and silently drop it.
    fs.writeFileSync(file, base.replace('<key>CLAUDE_CONFIG_DIR</key>', '<key>CLAUDE_CONFIG_DI&#82;</key>'));
    expect(plistEnv(fs.readFileSync(file, 'utf8'))['CLAUDE_CONFIG_DIR']).toBe('/srv/claude-bot');
    expect(() => render(home, file)).toThrow(/numeric character reference/);
    // An encoded key beside a comment in the dict body makes the reader give up;
    // the refusal must still come first, not "nothing to preserve".
    const commented = base
      .replace('<key>CLAUDE_CONFIG_DIR</key>', '<!-- hand edit --><key>CLAUDE_CONFIG_DI&#82;</key>');
    fs.writeFileSync(file, commented);
    expect(plistEnv(fs.readFileSync(file, 'utf8'))['CLAUDE_CONFIG_DIR']).toBe('/srv/claude-bot');
    expect(() => render(home, file)).toThrow(/numeric character reference/);
  });

  it('keeps an escaped literal that only looks like a reference', () => {
    const home = tmpHome();
    writeInstance(home, 'alpha-bot', {});
    const file = path.join(home, 'installed.plist');
    // &amp;#45; is the literal text "&#45;", not a reference.
    fs.writeFileSync(file, injectClaudeConfigDir(harnessTemplate, '/srv/literal&#45;bot'));
    expect(fs.readFileSync(file, 'utf8')).toContain('/srv/literal&amp;#45;bot');
    expect(plistEnv(render(home, file).output)['CLAUDE_CONFIG_DIR']).toBe('/srv/literal&#45;bot');
  });

  it('preserves nothing from an installed plist with no environment at all', () => {
    const home = tmpHome();
    writeInstance(home, 'alpha-bot', {});
    const file = path.join(home, 'installed.plist');
    fs.writeFileSync(file, '<plist><dict><key>Label</key><string>x</string></dict></plist>');
    expect(render(home, file).output).toBe(harnessTemplate);
  });
});

describe('resolveHostClaudeConfigDir', () => {
  it('returns null when no instance configures a dir', () => {
    const home = tmpHome();
    writeInstance(home, 'alpha-bot', {});
    expect(resolveHostClaudeConfigDir({ home, env: {} })).toEqual({ dir: null, warning: null });
  });

  it('returns the one configured dir, or the named instance dir', () => {
    const home = tmpHome();
    writeInstance(home, 'alpha-bot', { service: { claudeConfigDir: '/srv/bot/.claude' } });
    writeInstance(home, 'beta-bot', {});
    expect(resolveHostClaudeConfigDir({ home, env: {} }).dir).toBe('/srv/bot/.claude');
    expect(resolveHostClaudeConfigDir({ home, env: {}, instance: 'alpha-bot' }).dir).toBe('/srv/bot/.claude');
    expect(resolveHostClaudeConfigDir({ home, env: {}, instance: 'beta-bot' }).dir).toBeNull();
  });

  it('refuses to guess between two different dirs on one host', () => {
    const home = tmpHome();
    writeInstance(home, 'alpha-bot', { service: { claudeConfigDir: '/srv/a/.claude' } });
    writeInstance(home, 'beta-bot', { service: { claudeConfigDir: '/srv/b/.claude' } });
    const r = resolveHostClaudeConfigDir({ home, env: {} });
    expect(r.dir).toBeNull();
    expect(r.warning).toMatch(/2 different/);
  });

  it('fails closed on an invalid service block', () => {
    const home = tmpHome();
    writeInstance(home, 'alpha-bot', { service: { claudeConfigDir: 'relative/path' } });
    expect(() => resolveHostClaudeConfigDir({ home, env: {} })).toThrow();
  });
});

describe('shell render call sites apply the injector', () => {
  function releaseDriftRender(home: string, preserveFrom?: string): { status: number | null; out: string; stderr: string } {
    const out = path.join(home, 'render.plist');
    const r = spawnSync('bash', [
      path.join(repoRoot, 'deploy', 'scripts', 'render-release-drift-launchd.sh'),
      '--instance', 'alpha-bot', '--repo-root', repoRoot, '--home', home, '--output', out,
      ...(preserveFrom ? ['--preserve-from', preserveFrom] : []),
    ], { encoding: 'utf8', env: { ...process.env, HOME: home, XDG_CONFIG_HOME: '' } });
    return { status: r.status, out: r.status === 0 ? fs.readFileSync(out, 'utf8') : '', stderr: r.stderr };
  }

  it('release-drift render carries the instance dir, and is unchanged without one', () => {
    const home = tmpHome();
    writeInstance(home, 'alpha-bot', {});
    const plain = releaseDriftRender(home);
    expect(plain.status, plain.stderr).toBe(0);
    expect(plistEnv(plain.out)).not.toHaveProperty('CLAUDE_CONFIG_DIR');

    writeInstance(home, 'alpha-bot', { service: { claudeConfigDir: '/srv/bot/.claude' } });
    const withDir = releaseDriftRender(home);
    expect(withDir.status, withDir.stderr).toBe(0);
    expect(plistEnv(withDir.out)['CLAUDE_CONFIG_DIR']).toBe('/srv/bot/.claude');
  });

  function driftCheck(home: string, inject: string | null): string {
    const launchd = path.join(home, 'Library', 'LaunchAgents');
    fs.mkdirSync(launchd, { recursive: true });
    for (const label of ['com.whatsoup.harness-maintenance', 'com.whatsoup.reply-guarantee']) {
      const rendered = fs.readFileSync(path.join(repoRoot, 'deploy', `${label}.plist`), 'utf8')
        .replaceAll('__WHATSOUP_REPO_ROOT__', repoRoot)
        .replaceAll('__HOME__', home);
      fs.writeFileSync(path.join(launchd, `${label}.plist`), injectClaudeConfigDir(rendered, inject));
    }
    const r = spawnSync('bash', [
      path.join(repoRoot, 'scripts', 'check-launchd-drift.sh'),
      '--repo-root', repoRoot, '--launchd-dir', launchd, '--bin-dir', path.join(home, 'bin'),
    ], { encoding: 'utf8', env: { ...process.env, HOME: home, XDG_CONFIG_HOME: '' } });
    return `${r.stdout}\n${r.stderr}`;
  }

  it('the drift checker accepts an injected install and flags one that lost the key', () => {
    const home = tmpHome();
    writeInstance(home, 'alpha-bot', { service: { claudeConfigDir: '/srv/bot/.claude' } });
    const injected = driftCheck(home, '/srv/bot/.claude');
    expect(injected).toContain('ok: harness-maintenance');
    expect(injected).toContain('ok: reply-guarantee');

    const home2 = tmpHome();
    writeInstance(home2, 'alpha-bot', { service: { claudeConfigDir: '/srv/bot/.claude' } });
    const stripped = driftCheck(home2, null);
    expect(stripped).toContain('drift: harness-maintenance');
    expect(stripped).toContain('drift: reply-guarantee');
  });

  it('the drift checker keeps a hand-added dir the host config does not own', () => {
    const home = tmpHome();
    writeInstance(home, 'alpha-bot', {});
    const out = driftCheck(home, '/srv/hand/.claude');
    expect(out).toContain('ok: harness-maintenance');
    expect(out).toContain('ok: reply-guarantee');
  });

  it('release-drift render keeps the installed dir when the instance has none', () => {
    const home = tmpHome();
    writeInstance(home, 'alpha-bot', {});
    const first = releaseDriftRender(home);
    expect(first.status, first.stderr).toBe(0);
    const installedPath = path.join(home, 'installed-release-drift.plist');
    fs.writeFileSync(installedPath, injectClaudeConfigDir(first.out, '/srv/hand/.claude'));
    const again = releaseDriftRender(home, installedPath);
    expect(again.status, again.stderr).toBe(0);
    expect(plistEnv(again.out)['CLAUDE_CONFIG_DIR']).toBe('/srv/hand/.claude');
  });

  it('the drift checker is unchanged on a host without a configured dir', () => {
    const home = tmpHome();
    writeInstance(home, 'alpha-bot', {});
    const out = driftCheck(home, null);
    expect(out).toContain('ok: harness-maintenance');
    expect(out).toContain('ok: reply-guarantee');
  });

  // Runs setup.sh's own install_launchd_timer (extracted verbatim) under the
  // same `set -euo pipefail`, with crontab/launchctl stubbed, so the install
  // path is exercised rather than grepped.
  function setupInstall(home: string): { status: number | null; stdout: string; stderr: string; dest: string } {
    const src = fs.readFileSync(path.join(repoRoot, 'deploy', 'setup.sh'), 'utf8');
    const start = src.indexOf('  install_launchd_timer() {');
    const end = src.indexOf('\n  }\n', start) + '\n  }\n'.length;
    expect(start).toBeGreaterThan(0);
    const bin = path.join(home, 'stub-bin');
    fs.mkdirSync(bin, { recursive: true });
    for (const name of ['crontab', 'launchctl']) {
      fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    const launchAgents = path.join(home, 'Library', 'LaunchAgents');
    fs.mkdirSync(launchAgents, { recursive: true });
    const harness = path.join(home, 'harness.sh');
    fs.writeFileSync(harness, [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `REPO_ROOT=${JSON.stringify(repoRoot)}`,
      `LAUNCH_AGENTS_DIR=${JSON.stringify(launchAgents)}`,
      src.slice(start, end),
      'install_launchd_timer "com.whatsoup.harness-maintenance" "harness-maintenance"',
      'echo "setup-continued"',
      '',
    ].join('\n'));
    const r = spawnSync('bash', [harness], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: '', PATH: `${bin}:${process.env['PATH'] ?? ''}` },
    });
    return {
      status: r.status,
      stdout: r.stdout,
      stderr: r.stderr,
      dest: path.join(launchAgents, 'com.whatsoup.harness-maintenance.plist'),
    };
  }

  function installedHarness(home: string, dir: string | null): string {
    const rendered = harnessTemplate.replaceAll('__WHATSOUP_REPO_ROOT__', repoRoot).replaceAll('__HOME__', home);
    return injectClaudeConfigDir(rendered, dir);
  }

  it('setup keeps a hand-added dir the host config does not own', () => {
    const home = tmpHome();
    writeInstance(home, 'alpha-bot', {});
    const launchAgents = path.join(home, 'Library', 'LaunchAgents');
    fs.mkdirSync(launchAgents, { recursive: true });
    const dest = path.join(launchAgents, 'com.whatsoup.harness-maintenance.plist');
    fs.writeFileSync(dest, installedHarness(home, '/srv/hand/.claude'));
    const r = setupInstall(home);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('already installed (unchanged)');
    expect(plistEnv(fs.readFileSync(r.dest, 'utf8'))['CLAUDE_CONFIG_DIR']).toBe('/srv/hand/.claude');
  });

  it('setup installs the configured dir over a different hand-added one', () => {
    const home = tmpHome();
    writeInstance(home, 'alpha-bot', { service: { claudeConfigDir: '/srv/bot/.claude' } });
    const launchAgents = path.join(home, 'Library', 'LaunchAgents');
    fs.mkdirSync(launchAgents, { recursive: true });
    fs.writeFileSync(path.join(launchAgents, 'com.whatsoup.harness-maintenance.plist'),
      installedHarness(home, '/srv/hand/.claude'));
    const r = setupInstall(home);
    expect(r.status, r.stderr).toBe(0);
    expect(plistEnv(fs.readFileSync(r.dest, 'utf8'))['CLAUDE_CONFIG_DIR']).toBe('/srv/bot/.claude');
  });

  it('setup aborts under set -e when the installed plist mentions the key but cannot be read', () => {
    const home = tmpHome();
    writeInstance(home, 'alpha-bot', {});
    const launchAgents = path.join(home, 'Library', 'LaunchAgents');
    fs.mkdirSync(launchAgents, { recursive: true });
    const dest = path.join(launchAgents, 'com.whatsoup.harness-maintenance.plist');
    const ambiguous = installedHarness(home, '/srv/hand/.claude')
      .replace('<key>RunAtLoad</key>', '<key>EnvironmentVariables</key><dict/>\n  <key>RunAtLoad</key>');
    fs.writeFileSync(dest, ambiguous);
    const r = setupInstall(home);
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('setup-continued');
    expect(r.stderr).toContain('not installing');
    expect(fs.readFileSync(dest, 'utf8')).toBe(ambiguous);
  });

  it('setup installs harness/reply timers through the same injection (source pin)', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'deploy', 'setup.sh'), 'utf8');
    const install = src.slice(src.indexOf('install_launchd_timer() {'), src.indexOf('install_launchd_timer "com.whatsoup.harness-maintenance"'));
    expect(install).toContain('launchd-claude-config-env.ts');
    expect(install).toContain('--preserve-from "$dest"');
  });
});
