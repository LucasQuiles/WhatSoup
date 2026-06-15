import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const serviceTemplates = [
  'deploy/bot-errors-collector.service',
  'deploy/bot-errors-dispatcher.service',
  'deploy/bot-errors-health-check.service',
  'deploy/bot-errors-heartbeat-watchdog.service',
  'deploy/bot-errors-deadman.service',
  'deploy/bot-errors-q-loop.service',
];
const timerTemplates = [
  'deploy/bot-errors-deadman.timer',
  'deploy/bot-errors-health-check.timer',
  'deploy/bot-errors-heartbeat-watchdog.timer',
];
const launchdInstallers = [
  'deploy/scripts/install-bot-errors-health-launchd.sh',
  'deploy/scripts/install-bot-errors-launchd.sh',
];
const unitTemplates = [...serviceTemplates, ...timerTemplates];
const PRIVATE_SOCKET_SEGMENT = ['instances', 'personal', 'whatsoup.sock'].join('/');
const routingEnvKeys = [
  'BOT_ERRORS_JID',
  'BOT_ERRORS_EXPECTED_JID',
  'BOT_ERRORS_SOCKET_PATH',
  'BOT_ERRORS_SOCKET',
  'BOT_ERRORS_DB',
  'BOT_ERRORS_HEALTH_PROFILE',
];
const tempRoots: string[] = [];

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function writeShim(dir: string, name: string, body: string): void {
  const file = path.join(dir, name);
  writeFileSync(file, body, 'utf8');
  chmodSync(file, 0o755);
}

function launchAgentPath(home: string, label: string): string {
  return path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
}

function writeFakeBotErrorsRepo(repoRoot: string): void {
  mkdirSync(path.join(repoRoot, 'deploy', 'scripts'), { recursive: true });
  for (const script of [
    'bot-errors-dispatcher.py',
    'bot-errors-health-check.py',
    'bot-errors-runner.py',
  ]) {
    writeFileSync(path.join(repoRoot, 'deploy', 'scripts', script), '#!/usr/bin/env python3\n', 'utf8');
  }
}

function writeLaunchdShims(shimDir: string): void {
  writeShim(shimDir, 'plutil', '#!/usr/bin/env bash\nexit 0\n');
  writeShim(shimDir, 'launchctl', [
    '#!/usr/bin/env bash',
    'echo "$@" >> "$HOME/launchctl.log"',
    'if [[ "${1:-}" == "bootstrap" ]]; then exit "${LAUNCHCTL_BOOTSTRAP_EXIT:-0}"; fi',
    'exit 0',
    '',
  ].join('\n'));
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('BOT ERRORS service templates', () => {
  it('load live routing from the private host env file', () => {
    for (const file of serviceTemplates) {
      const text = readFileSync(file, 'utf8');
      expect(text).toContain('EnvironmentFile=%h/.config/whatsoup/bot-errors.env');
    }
  });

  it('keep deploy-specific identifiers out of tracked unit files', () => {
    for (const file of unitTemplates) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toContain('120363');
      expect(text).not.toMatch(/\/home\/[A-Za-z0-9._-]+\//);
      expect(text).not.toContain(PRIVATE_SOCKET_SEGMENT);
    }
  });

  it('fails loud before installing launchd plists when referenced scripts are missing', () => {
    for (const file of launchdInstallers) {
      const text = readFileSync(file, 'utf8');
      expect(text).toContain('missing required BOT ERRORS script');
      expect(text).toContain('bot-errors-health-check.py');
      expect(text).toContain('bot-errors-runner.py');
    }
    expect(readFileSync('deploy/scripts/install-bot-errors-launchd.sh', 'utf8')).toContain('bot-errors-dispatcher.py');
  });

  it('launchd installers hydrate routing env from the private host env file into rendered plists', () => {
    for (const file of launchdInstallers) {
      const text = readFileSync(file, 'utf8');
      expect(text, `${file} must locate the private BOT ERRORS env file`).toContain('BOT_ERRORS_ENV_FILE');
      expect(text, `${file} must parse env values without sourcing arbitrary shell`).toContain('read_env_value');
      expect(text, `${file} must prefer explicit env before file/default values`).toContain('env_or_default');
      expect(text, `${file} must XML-escape generated plist values`).toContain('xml_escape');
      expect(text, `${file} must not source the host env as executable shell`).not.toMatch(/\bsource\s+"\$ENV_FILE"|\.\s+"\$ENV_FILE"/);
      for (const key of routingEnvKeys) {
        expect(text, `${file} rendered plist missing ${key}`).toContain(`<key>${key}</key>`);
      }
    }
  });

  it('renders launchd plists with routing env from file without executing env-file shell', () => {
    const home = makeTempRoot('whatsoup-launchd-home-');
    const shimDir = makeTempRoot('whatsoup-launchd-shims-');
    const profile = path.join(home, 'health & profile.json');
    const envFile = path.join(home, 'bot-errors.env');
    const maliciousTouch = path.join(home, 'sourced-env-file');
    const jid = '120363555555550001@g.us';
    const socket = path.join(home, 'whatsoup & socket.sock');
    const db = path.join(home, 'bot<db>.sqlite');
    const stateDir = path.join(home, 'state "quoted"');
    const repoRoot = path.join(home, "repo 'single'");
    const escapedSocket = xmlEscape(socket);
    const escapedDb = xmlEscape(db);
    const escapedStateDir = xmlEscape(stateDir);
    const escapedRepoRoot = xmlEscape(repoRoot);
    const escapedProfile = xmlEscape(profile);

    writeFileSync(profile, '{}\n', 'utf8');
    writeFakeBotErrorsRepo(repoRoot);
    writeFileSync(envFile, [
      `BOT_ERRORS_JID=${jid}`,
      `BOT_ERRORS_EXPECTED_JID=${jid}`,
      `BOT_ERRORS_SOCKET_PATH=${socket}`,
      `BOT_ERRORS_SOCKET=${socket}`,
      `BOT_ERRORS_DB=${db}`,
      `BOT_ERRORS_HEALTH_PROFILE=${profile}`,
      `MALICIOUS_TOUCH=$(touch ${maliciousTouch})`,
      '',
    ].join('\n'), 'utf8');
    writeLaunchdShims(shimDir);

    execFileSync('bash', ['deploy/scripts/install-bot-errors-launchd.sh'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        PATH: `${shimDir}:${process.env.PATH ?? ''}`,
        BOT_ERRORS_REPO_ROOT: repoRoot,
        BOT_ERRORS_ENV_FILE: envFile,
        BOT_ERRORS_STATE_DIR: stateDir,
      },
    });
    execFileSync('bash', ['deploy/scripts/install-bot-errors-health-launchd.sh'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        PATH: `${shimDir}:${process.env.PATH ?? ''}`,
        BOT_ERRORS_REPO_ROOT: repoRoot,
        BOT_ERRORS_ENV_FILE: envFile,
        BOT_ERRORS_STATE_DIR: stateDir,
        BOT_ERRORS_HEALTH_LABEL: 'com.bot-errors.health-only',
      },
    });

    expect(existsSync(maliciousTouch)).toBe(false);
    for (const label of [
      'com.bot-errors.dispatcher',
      'com.bot-errors.deadman',
      'com.bot-errors.health',
      'com.bot-errors.health-only',
    ]) {
      const plist = readFileSync(launchAgentPath(home, label), 'utf8');
      expect(plist, `${label} missing JID`).toContain(`<key>BOT_ERRORS_JID</key><string>${jid}</string>`);
      expect(plist, `${label} missing expected JID`).toContain(`<key>BOT_ERRORS_EXPECTED_JID</key><string>${jid}</string>`);
      expect(plist, `${label} missing escaped socket path`).toContain(`<key>BOT_ERRORS_SOCKET_PATH</key><string>${escapedSocket}</string>`);
      expect(plist, `${label} missing escaped socket alias`).toContain(`<key>BOT_ERRORS_SOCKET</key><string>${escapedSocket}</string>`);
      expect(plist, `${label} missing escaped DB`).toContain(`<key>BOT_ERRORS_DB</key><string>${escapedDb}</string>`);
      expect(plist, `${label} missing escaped health profile`).toContain(`<key>BOT_ERRORS_HEALTH_PROFILE</key><string>${escapedProfile}</string>`);
      expect(plist, `${label} missing escaped state dir`).toContain(`<key>BOT_ERRORS_STATE_DIR</key><string>${escapedStateDir}</string>`);
      expect(plist, `${label} missing escaped repo root`).toContain(`<key>WorkingDirectory</key><string>${escapedRepoRoot}</string>`);
    }
  });

  it('prefers explicit launchd installer env over stale private env-file values', () => {
    const home = makeTempRoot('whatsoup-launchd-home-');
    const shimDir = makeTempRoot('whatsoup-launchd-shims-');
    const profile = path.join(home, 'health-profile.json');
    const envFile = path.join(home, 'bot-errors.env');
    const repoRoot = path.join(home, 'repo');
    const fileJid = '120363555555550002@g.us';
    const envJid = '120363555555550003@g.us';
    const fileSocket = path.join(home, 'file.sock');
    const envSocket = path.join(home, 'env.sock');
    const fileDb = path.join(home, 'file.sqlite');
    const envDb = path.join(home, 'env.sqlite');

    writeFileSync(profile, '{}\n', 'utf8');
    writeFakeBotErrorsRepo(repoRoot);
    writeFileSync(envFile, [
      `BOT_ERRORS_JID=${fileJid}`,
      `BOT_ERRORS_EXPECTED_JID=${fileJid}`,
      `BOT_ERRORS_SOCKET_PATH=${fileSocket}`,
      `BOT_ERRORS_SOCKET=${fileSocket}`,
      `BOT_ERRORS_DB=${fileDb}`,
      `BOT_ERRORS_HEALTH_PROFILE=${profile}`,
      '',
    ].join('\n'), 'utf8');
    writeLaunchdShims(shimDir);

    const env = {
      ...process.env,
      HOME: home,
      PATH: `${shimDir}:${process.env.PATH ?? ''}`,
      BOT_ERRORS_REPO_ROOT: repoRoot,
      BOT_ERRORS_ENV_FILE: envFile,
      BOT_ERRORS_JID: envJid,
      BOT_ERRORS_EXPECTED_JID: envJid,
      BOT_ERRORS_SOCKET_PATH: envSocket,
      BOT_ERRORS_SOCKET: envSocket,
      BOT_ERRORS_DB: envDb,
      BOT_ERRORS_HEALTH_LABEL: 'com.bot-errors.health-only',
    };
    execFileSync('bash', ['deploy/scripts/install-bot-errors-launchd.sh'], {
      cwd: process.cwd(),
      env,
    });
    execFileSync('bash', ['deploy/scripts/install-bot-errors-health-launchd.sh'], {
      cwd: process.cwd(),
      env,
    });

    for (const label of [
      'com.bot-errors.dispatcher',
      'com.bot-errors.deadman',
      'com.bot-errors.health',
      'com.bot-errors.health-only',
    ]) {
      const plist = readFileSync(launchAgentPath(home, label), 'utf8');
      expect(plist, `${label} should use explicit env JID`).toContain(`<key>BOT_ERRORS_JID</key><string>${envJid}</string>`);
      expect(plist, `${label} should use explicit expected JID`).toContain(`<key>BOT_ERRORS_EXPECTED_JID</key><string>${envJid}</string>`);
      expect(plist, `${label} should use explicit socket path`).toContain(`<key>BOT_ERRORS_SOCKET_PATH</key><string>${envSocket}</string>`);
      expect(plist, `${label} should use explicit socket alias`).toContain(`<key>BOT_ERRORS_SOCKET</key><string>${envSocket}</string>`);
      expect(plist, `${label} should use explicit DB`).toContain(`<key>BOT_ERRORS_DB</key><string>${envDb}</string>`);
      expect(plist).not.toContain(fileJid);
      expect(plist).not.toContain(fileSocket);
      expect(plist).not.toContain(fileDb);
    }
  });

  it('mirrors BOT_ERRORS_SOCKET into BOT_ERRORS_SOCKET_PATH when the path key is absent', () => {
    const home = makeTempRoot('whatsoup-launchd-home-');
    const shimDir = makeTempRoot('whatsoup-launchd-shims-');
    const profile = path.join(home, 'health-profile.json');
    const envFile = path.join(home, 'bot-errors.env');
    const repoRoot = path.join(home, 'repo');
    const jid = '120363555555550004@g.us';
    const socket = path.join(home, 'alias-only.sock');
    const db = path.join(home, 'bot.sqlite');

    writeFileSync(profile, '{}\n', 'utf8');
    writeFakeBotErrorsRepo(repoRoot);
    writeFileSync(envFile, [
      `BOT_ERRORS_JID=${jid}`,
      `BOT_ERRORS_EXPECTED_JID=${jid}`,
      `BOT_ERRORS_SOCKET=${socket}`,
      `BOT_ERRORS_DB=${db}`,
      `BOT_ERRORS_HEALTH_PROFILE=${profile}`,
      '',
    ].join('\n'), 'utf8');
    writeLaunchdShims(shimDir);

    const env = {
      ...process.env,
      HOME: home,
      PATH: `${shimDir}:${process.env.PATH ?? ''}`,
      BOT_ERRORS_REPO_ROOT: repoRoot,
      BOT_ERRORS_ENV_FILE: envFile,
      BOT_ERRORS_SOCKET_PATH: '',
      BOT_ERRORS_HEALTH_LABEL: 'com.bot-errors.health-only',
    };
    execFileSync('bash', ['deploy/scripts/install-bot-errors-launchd.sh'], {
      cwd: process.cwd(),
      env,
    });
    execFileSync('bash', ['deploy/scripts/install-bot-errors-health-launchd.sh'], {
      cwd: process.cwd(),
      env,
    });

    for (const label of [
      'com.bot-errors.dispatcher',
      'com.bot-errors.deadman',
      'com.bot-errors.health',
      'com.bot-errors.health-only',
    ]) {
      const plist = readFileSync(launchAgentPath(home, label), 'utf8');
      expect(plist, `${label} should mirror socket alias into socket path`).toContain(`<key>BOT_ERRORS_SOCKET_PATH</key><string>${socket}</string>`);
      expect(plist, `${label} should keep socket alias`).toContain(`<key>BOT_ERRORS_SOCKET</key><string>${socket}</string>`);
    }
  });

  it('fails closed when launchctl bootstrap rejects a rendered plist', () => {
    for (const [script, successPrefix] of [
      ['deploy/scripts/install-bot-errors-launchd.sh', 'installed com.bot-errors'],
      ['deploy/scripts/install-bot-errors-health-launchd.sh', 'installed com.bot-errors.health-only'],
    ] as const) {
      const home = makeTempRoot('whatsoup-launchd-home-');
      const shimDir = makeTempRoot('whatsoup-launchd-shims-');
      const profile = path.join(home, 'health-profile.json');
      const envFile = path.join(home, 'bot-errors.env');
      const repoRoot = path.join(home, 'repo');
      const jid = '120363555555550005@g.us';
      const socket = path.join(home, 'whatsoup.sock');
      const db = path.join(home, 'bot.sqlite');

      writeFileSync(profile, '{}\n', 'utf8');
      writeFakeBotErrorsRepo(repoRoot);
      writeFileSync(envFile, [
        `BOT_ERRORS_JID=${jid}`,
        `BOT_ERRORS_EXPECTED_JID=${jid}`,
        `BOT_ERRORS_SOCKET_PATH=${socket}`,
        `BOT_ERRORS_SOCKET=${socket}`,
        `BOT_ERRORS_DB=${db}`,
        `BOT_ERRORS_HEALTH_PROFILE=${profile}`,
        '',
      ].join('\n'), 'utf8');
      writeLaunchdShims(shimDir);

      const result = spawnSync('bash', [script], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          PATH: `${shimDir}:${process.env.PATH ?? ''}`,
          BOT_ERRORS_REPO_ROOT: repoRoot,
          BOT_ERRORS_ENV_FILE: envFile,
          BOT_ERRORS_HEALTH_LABEL: 'com.bot-errors.health-only',
          LAUNCHCTL_BOOTSTRAP_EXIT: '37',
        },
        encoding: 'utf8',
      });

      expect(result.status, `${script} unexpectedly succeeded\n${result.stdout}\n${result.stderr}`).toBe(37);
      expect(result.stdout).not.toContain(successPrefix);
      expect(readFileSync(path.join(home, 'launchctl.log'), 'utf8')).toContain('bootstrap');
    }
  });

  it('fails closed before writing launchd plists when the health profile is missing', () => {
    for (const [script, labels] of [
      ['deploy/scripts/install-bot-errors-launchd.sh', [
        'com.bot-errors.dispatcher',
        'com.bot-errors.deadman',
        'com.bot-errors.health',
      ]],
      ['deploy/scripts/install-bot-errors-health-launchd.sh', ['com.bot-errors.health-only']],
    ] as const) {
      const home = makeTempRoot('whatsoup-launchd-home-');
      const shimDir = makeTempRoot('whatsoup-launchd-shims-');
      const envFile = path.join(home, 'bot-errors.env');
      const repoRoot = path.join(home, 'repo');
      const missingProfile = path.join(home, 'missing-health-profile.json');
      const jid = '120363555555550006@g.us';
      const socket = path.join(home, 'whatsoup.sock');
      const db = path.join(home, 'bot.sqlite');

      writeFakeBotErrorsRepo(repoRoot);
      writeFileSync(envFile, [
        `BOT_ERRORS_JID=${jid}`,
        `BOT_ERRORS_EXPECTED_JID=${jid}`,
        `BOT_ERRORS_SOCKET_PATH=${socket}`,
        `BOT_ERRORS_SOCKET=${socket}`,
        `BOT_ERRORS_DB=${db}`,
        `BOT_ERRORS_HEALTH_PROFILE=${missingProfile}`,
        '',
      ].join('\n'), 'utf8');
      writeLaunchdShims(shimDir);

      const result = spawnSync('bash', [script], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          PATH: `${shimDir}:${process.env.PATH ?? ''}`,
          BOT_ERRORS_REPO_ROOT: repoRoot,
          BOT_ERRORS_ENV_FILE: envFile,
          BOT_ERRORS_HEALTH_LABEL: 'com.bot-errors.health-only',
        },
        encoding: 'utf8',
      });

      expect(result.status, `${script} unexpectedly succeeded\n${result.stdout}\n${result.stderr}`).toBe(2);
      expect(result.stderr).toContain('missing BOT_ERRORS_HEALTH_PROFILE; expected readable profile path');
      expect(existsSync(path.join(home, 'launchctl.log'))).toBe(false);
      for (const label of labels) {
        expect(existsSync(launchAgentPath(home, label)), `${script} wrote ${label} before validating profile`).toBe(false);
      }
    }
  });
});
