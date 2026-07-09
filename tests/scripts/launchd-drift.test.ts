import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(process.cwd(), 'scripts/check-launchd-drift.sh');
const tmpDirs: string[] = [];

const FAKE_SECRET = 'sekrit-value-9f2c41';

function plistXml(label: string, prog0: string, withSecret = false): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `  <key>Label</key><string>${label}</string>`,
    '  <key>ProgramArguments</key><array>',
    `    <string>${prog0}</string>`,
    '    <string>bot.mjs</string>',
    '  </array>',
    ...(withSecret
      ? ['  <key>EnvironmentVariables</key><dict>',
         `    <key>FAKE_API_KEY</key><string>${FAKE_SECRET}</string>`,
         '  </dict>']
      : []),
    '</dict></plist>',
    '',
  ].join('\n');
}

// Template fixtures carry the real repo placeholder tokens.
const HARNESS_TEMPLATE = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<plist version="1.0"><dict>',
  '  <key>Label</key><string>com.whatsoup.harness-maintenance</string>',
  '  <key>ProgramArguments</key><array>',
  '    <string>/bin/bash</string>',
  '    <string>__WHATSOUP_REPO_ROOT__/deploy/scripts/harness.sh</string>',
  '  </array>',
  '  <key>StandardOutPath</key><string>__HOME__/logs/harness.log</string>',
  '</dict></plist>',
  '',
].join('\n');

const REPLY_TEMPLATE = HARNESS_TEMPLATE
  .replace('harness-maintenance', 'reply-guarantee')
  .replace('harness.sh', 'reply-guarantee-drain.sh');

const MS365_TEMPLATE = HARNESS_TEMPLATE
  .replace('harness-maintenance', 'ms365-token-backup')
  .replace('__WHATSOUP_REPO_ROOT__/deploy/scripts/harness.sh', '__HOME__/.local/bin/ms365-token-backup');

const WATCHDOG_TEMPLATE = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<plist version="1.0"><dict>',
  '  <key>Label</key><string>com.whatsoup.__BOT_NAME__-watchdog</string>',
  '  <key>ProgramArguments</key><array>',
  '    <string>__HOME__/.local/bin/__BOT_NAME__-watchdog</string>',
  '  </array>',
  '</dict></plist>',
  '',
].join('\n');

function subst(template: string, repo: string, home: string, bot = ''): string {
  return template
    .replaceAll('__WHATSOUP_REPO_ROOT__', repo)
    .replaceAll('__HOME__', home)
    .replaceAll('__BOT_NAME__', bot);
}

function makeFixture(): { repo: string; launchd: string; bin: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'whatsoup-launchd-drift-'));
  tmpDirs.push(root);
  const repo = join(root, 'repo');
  const launchd = join(root, 'LaunchAgents');
  const bin = join(root, 'bin');
  const home = root; // stable HOME for render determinism
  mkdirSync(join(repo, 'deploy/templates'), { recursive: true });
  mkdirSync(join(repo, 'deploy/scripts'), { recursive: true });
  mkdirSync(launchd, { recursive: true });
  mkdirSync(bin, { recursive: true });
  // repo templates
  writeFileSync(join(repo, 'deploy/com.whatsoup.harness-maintenance.plist'), HARNESS_TEMPLATE);
  writeFileSync(join(repo, 'deploy/com.whatsoup.reply-guarantee.plist'), REPLY_TEMPLATE);
  writeFileSync(join(repo, 'deploy/templates/com.whatsoup.ms365-token-backup.plist'), MS365_TEMPLATE);
  writeFileSync(join(repo, 'deploy/templates/com.whatsoup.__BOT_NAME__-watchdog.plist'), WATCHDOG_TEMPLATE);
  // fake render-release-drift (deterministic)
  const renderRd = join(repo, 'deploy/scripts/render-release-drift-launchd.sh');
  writeFileSync(renderRd, [
    '#!/usr/bin/env bash',
    'inst=""; out=""',
    'while [ "$#" -gt 0 ]; do case "$1" in',
    '  --instance) inst="$2"; shift 2 ;;',
    '  --output) out="$2"; shift 2 ;;',
    '  *) shift ;;',
    'esac; done',
    'printf "RENDERED release-drift for %s\\n" "$inst" > "$out"',
    '',
  ].join('\n'));
  chmodSync(renderRd, 0o755);
  // fake render-watchdog.py: verify => exit 2 when placeholders survive
  const renderWd = join(repo, 'deploy/scripts/render-watchdog.py');
  writeFileSync(renderWd, [
    '#!/usr/bin/env python3',
    'import sys',
    'args = sys.argv[1:]',
    'path = args[args.index("--script") + 1]',
    'body = open(path).read()',
    'sys.exit(2 if "__" in body else 0)',
    '',
  ].join('\n'));
  chmodSync(renderWd, 0o755);
  chmodSync(SCRIPT, 0o755);
  return { repo, launchd, bin, home };
}

// Install every managed surface correctly for one bot ("tbot").
function installAllOk(f: { repo: string; launchd: string; bin: string; home: string }): void {
  writeFileSync(join(f.launchd, 'com.whatsoup.harness-maintenance.plist'), subst(HARNESS_TEMPLATE, f.repo, f.home));
  writeFileSync(join(f.launchd, 'com.whatsoup.reply-guarantee.plist'), subst(REPLY_TEMPLATE, f.repo, f.home));
  writeFileSync(join(f.launchd, 'com.whatsoup.tbot.plist'), plistXml('com.whatsoup.tbot', '/usr/local/bin/node', true));
  writeFileSync(join(f.launchd, 'com.whatsoup.tbot-watchdog.plist'), subst(WATCHDOG_TEMPLATE, f.repo, f.home, 'tbot'));
  writeFileSync(join(f.bin, 'tbot-watchdog'), '#!/usr/bin/env bash\necho ok\n');
  chmodSync(join(f.bin, 'tbot-watchdog'), 0o755);
  writeFileSync(join(f.launchd, 'com.whatsoup.release-drift-check.plist'), 'RENDERED release-drift for tbot\n');
}

function run(f: { repo: string; launchd: string; bin: string; home: string }, extra: string[] = []) {
  return spawnSync('bash', [SCRIPT,
    '--repo-root', f.repo,
    '--launchd-dir', f.launchd,
    '--bin-dir', f.bin,
    ...extra,
  ], { encoding: 'utf8', env: { ...process.env, HOME: f.home } });
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

describe('check-launchd-drift.sh CLI + dir gate', () => {
  it('exits 2 on an unexpected argument', () => {
    const f = makeFixture();
    const result = run(f, ['--bogus']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unexpected argument');
  });

  it('exits 3 with SKIP: when the LaunchAgents directory is absent', () => {
    const f = makeFixture();
    rmSync(f.launchd, { recursive: true, force: true });
    const result = run(f);
    expect(result.status).toBe(3);
    expect(result.stdout).toContain('SKIP:');
    expect(result.stdout).toContain('LaunchAgents directory not found');
  });

  it('exits 2 when a flag is missing its value', () => {
    const f = makeFixture();
    const result = run(f, ['--launchd-dir']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('missing --launchd-dir value');
  });

  it('exits 0 with SKIP: when dir absent and --allow-missing-launchd-dir passed', () => {
    const f = makeFixture();
    rmSync(f.launchd, { recursive: true, force: true });
    const result = run(f, ['--allow-missing-launchd-dir']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('SKIP:');
  });
});

describe('static template surfaces (substitute-then-compare)', () => {
  it('passes and reports ok for matching substituted surfaces', () => {
    const f = makeFixture();
    installAllOk(f);
    const result = run(f);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ok: harness-maintenance');
    expect(result.stdout).toContain('ok: reply-guarantee');
    expect(result.stdout).toContain('all managed launchd surfaces match');
  });

  it('reports drift WITHOUT a diff body by default', () => {
    const f = makeFixture();
    installAllOk(f);
    writeFileSync(join(f.launchd, 'com.whatsoup.harness-maintenance.plist'),
      subst(HARNESS_TEMPLATE, f.repo, f.home).replace('harness.sh', 'TAMPERED.sh'));
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('drift: harness-maintenance');
    expect(result.stderr).not.toContain('TAMPERED');
  });

  it('prints the diff body only with --show-diff', () => {
    const f = makeFixture();
    installAllOk(f);
    writeFileSync(join(f.launchd, 'com.whatsoup.harness-maintenance.plist'),
      subst(HARNESS_TEMPLATE, f.repo, f.home).replace('harness.sh', 'TAMPERED.sh'));
    const result = run(f, ['--show-diff']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('TAMPERED');
  });

  it('fails on a missing installed required surface', () => {
    const f = makeFixture();
    installAllOk(f);
    rmSync(join(f.launchd, 'com.whatsoup.reply-guarantee.plist'));
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing installed: reply-guarantee');
  });

  it('skips ms365-token-backup when not installed', () => {
    const f = makeFixture();
    installAllOk(f);
    const result = run(f);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('skip: ms365-token-backup');
  });

  it('exits 2 fail-closed when a placeholder survives substitution', () => {
    const f = makeFixture();
    installAllOk(f);
    writeFileSync(join(f.repo, 'deploy/com.whatsoup.harness-maintenance.plist'),
      HARNESS_TEMPLATE.replace('harness.sh', '__NEW_UNKNOWN_TOKEN__/harness.sh'));
    const result = run(f);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unsubstituted placeholder');
  });

  it('refuses to render (exit 2) when a substitution value contains sed metacharacters', () => {
    const f = makeFixture();
    installAllOk(f);
    const evil = join(f.home, 'evil & repo');
    cpSync(f.repo, evil, { recursive: true });
    const result = spawnSync('bash', [SCRIPT,
      '--repo-root', evil,
      '--launchd-dir', f.launchd,
      '--bin-dir', f.bin,
    ], { encoding: 'utf8', env: { ...process.env, HOME: f.home } });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unsafe character in substitution value');
  });
});

describe('per-instance surfaces', () => {
  it('discovers instances and validates the watchdog plist render', () => {
    const f = makeFixture();
    installAllOk(f);
    const result = run(f);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ok: tbot-watchdog plist');
    expect(result.stdout).toContain('ok: release-drift-check');
  });

  it('fails when the installed watchdog plist drifted from its template render', () => {
    const f = makeFixture();
    installAllOk(f);
    writeFileSync(join(f.launchd, 'com.whatsoup.tbot-watchdog.plist'),
      subst(WATCHDOG_TEMPLATE, f.repo, f.home, 'tbot').replace('-watchdog</string>', '-TAMPERED</string>'));
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('drift: tbot-watchdog plist');
  });

  it('fails when release-drift-check matches no instance render', () => {
    const f = makeFixture();
    installAllOk(f);
    writeFileSync(join(f.launchd, 'com.whatsoup.release-drift-check.plist'), 'RENDERED release-drift for someone-else\n');
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('release-drift-check matches no discovered instance render');
  });

  it('skips release-drift-check when not installed', () => {
    const f = makeFixture();
    installAllOk(f);
    rmSync(join(f.launchd, 'com.whatsoup.release-drift-check.plist'));
    const result = run(f);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('skip: release-drift-check');
  });
});

describe('verified installed scripts', () => {
  it('fails when the installed watchdog script has surviving placeholders', () => {
    const f = makeFixture();
    installAllOk(f);
    writeFileSync(join(f.bin, 'tbot-watchdog'), '#!/usr/bin/env bash\ncurl __BOT_PORT__\n');
    chmodSync(join(f.bin, 'tbot-watchdog'), 0o755);
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('drift: tbot-watchdog script');
  });

  it('fails when the watchdog script is missing while its plist is installed', () => {
    const f = makeFixture();
    installAllOk(f);
    rmSync(join(f.bin, 'tbot-watchdog'));
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing installed watchdog script');
  });

  it('fails when the installed ms365 script has surviving placeholders', () => {
    const f = makeFixture();
    installAllOk(f);
    writeFileSync(join(f.launchd, 'com.whatsoup.ms365-token-backup.plist'), subst(MS365_TEMPLATE, f.repo, f.home));
    writeFileSync(join(f.bin, 'ms365-token-backup'), '#!/usr/bin/env bash\ncp __HOME__/x y\n');
    chmodSync(join(f.bin, 'ms365-token-backup'), 0o755);
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('drift: ms365-token-backup script');
  });
});

describe('structural checks and secret safety', () => {
  it('passes structural checks and NEVER prints the planted secret (default and --show-diff)', () => {
    const f = makeFixture();
    installAllOk(f);
    for (const extra of [[], ['--show-diff']] as string[][]) {
      const result = run(f, extra);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('ok: tbot plist structural');
      expect(result.stdout + result.stderr).not.toContain(FAKE_SECRET);
    }
  });

  it('flags an unpinned /usr/bin/env interpreter without printing plist content', () => {
    const f = makeFixture();
    installAllOk(f);
    writeFileSync(join(f.launchd, 'com.whatsoup.tbot.plist'), plistXml('com.whatsoup.tbot', '/usr/bin/env', true));
    const result = run(f, ['--show-diff']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('mini7 incident class');
    expect(result.stdout + result.stderr).not.toContain(FAKE_SECRET);
  });

  it('flags a Label mismatch on the bot plist', () => {
    const f = makeFixture();
    installAllOk(f);
    writeFileSync(join(f.launchd, 'com.whatsoup.tbot.plist'), plistXml('com.whatsoup.WRONG', '/usr/local/bin/node', true));
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Label mismatch');
    expect(result.stdout + result.stderr).not.toContain(FAKE_SECRET);
  });

  it('checks whatsoup-fleet structurally when installed', () => {
    const f = makeFixture();
    installAllOk(f);
    writeFileSync(join(f.launchd, 'com.whatsoup.whatsoup-fleet.plist'), plistXml('com.whatsoup.whatsoup-fleet', '/usr/local/bin/node'));
    const result = run(f);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ok: whatsoup-fleet plist structural');
  });

  it('warns on unmanaged surfaces without counting them as drift', () => {
    const f = makeFixture();
    installAllOk(f);
    writeFileSync(join(f.launchd, 'com.whatsoup.mystery.plist'), plistXml('com.whatsoup.mystery', '/usr/local/bin/node'));
    const result = run(f, ['--instance', 'tbot']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('warn: unmanaged launchd surface: com.whatsoup.mystery.plist');
  });
});
