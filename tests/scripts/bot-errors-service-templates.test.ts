import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  globSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { trackTmpDirs } from '../helpers/tmp-dir.ts';

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
const guiMonitorInstaller = 'deploy/scripts/install-bot-errors-gui-monitor-launchd.sh';
const unitTemplates = [...serviceTemplates, ...timerTemplates];
const releaseProofServices = [
  'deploy/bot-errors-tree-provenance.service',
  'deploy/bot-errors-runtime-staleness.service',
];
const releaseProofTimers = [
  'deploy/bot-errors-tree-provenance.timer',
  'deploy/bot-errors-runtime-staleness.timer',
];
const releaseProofUnits = [...releaseProofServices, ...releaseProofTimers];
const PRIVATE_SOCKET_SEGMENT = ['instances', 'personal', 'whatsoup.sock'].join('/');
const PRIVATE_DB_SEGMENT = ['instances', 'personal', 'bot.db'].join('/');
const routingEnvKeys = [
  'BOT_ERRORS_JID',
  'BOT_ERRORS_EXPECTED_JID',
  'BOT_ERRORS_SOCKET_PATH',
  'BOT_ERRORS_SOCKET',
  'BOT_ERRORS_DB',
  'BOT_ERRORS_HEALTH_PROFILE',
];
const tmp = trackTmpDirs('');

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

// Invariant made explicit (previously implicit/unenforced): every call site below
// passes a literal ending in exactly one '-', which trackTmpDirs()'s make() relies
// on to reproduce the original prefix string exactly (see notes-qf-t2-tmpdir4.md).
// A caller that ever violates this fails loudly here instead of silently producing
// a wrong-but-plausible tmp prefix with no test failure.
function makeTempRoot(prefix: string): string {
  if (!prefix.endsWith('-')) {
    throw new Error(`makeTempRoot: prefix must end with '-' (got ${JSON.stringify(prefix)})`);
  }
  return tmp.make(prefix.slice(0, -1));
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

function writeFakeGuiMonitorRepo(repoRoot: string): void {
  mkdirSync(path.join(repoRoot, 'deploy', 'scripts'), { recursive: true });
  writeFileSync(
    path.join(repoRoot, 'deploy', 'scripts', 'bot-errors-gui-session-monitor.py'),
    '#!/usr/bin/env python3\n',
    'utf8',
  );
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

describe('BOT ERRORS service templates', () => {
  it('load live routing from the private host env file', () => {
    for (const file of serviceTemplates) {
      const text = readFileSync(file, 'utf8');
      expect(text).toContain('EnvironmentFile=%h/.config/whatsoup/bot-errors.env');
    }
  });

  it('keep deploy-specific identifiers out of tracked unit files', () => {
    for (const file of [...unitTemplates, ...releaseProofUnits]) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toContain('120363');
      expect(text).not.toMatch(/\/home\/[A-Za-z0-9._-]+\//);
      expect(text).not.toContain(PRIVATE_SOCKET_SEGMENT);
      expect(text).not.toContain(PRIVATE_DB_SEGMENT);
    }
    for (const file of launchdInstallers) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toContain(PRIVATE_SOCKET_SEGMENT);
      expect(text).not.toContain(PRIVATE_DB_SEGMENT);
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

  it('fails closed before writing launchd plists when the health profile is unreadable', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return;
    }
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
      const unreadableProfile = path.join(home, 'health-profile.json');
      const jid = 'fixture-unreadable-profile@g.us';
      const socket = path.join(home, 'whatsoup.sock');
      const db = path.join(home, 'bot.sqlite');

      writeFakeBotErrorsRepo(repoRoot);
      writeFileSync(unreadableProfile, '{}\n', 'utf8');
      chmodSync(unreadableProfile, 0o000);
      writeFileSync(envFile, [
        `BOT_ERRORS_JID=${jid}`,
        `BOT_ERRORS_EXPECTED_JID=${jid}`,
        `BOT_ERRORS_SOCKET_PATH=${socket}`,
        `BOT_ERRORS_SOCKET=${socket}`,
        `BOT_ERRORS_DB=${db}`,
        `BOT_ERRORS_HEALTH_PROFILE=${unreadableProfile}`,
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

  it('rejects non-integer health schedule values before writing the health plist', () => {
    for (const [envKey, value] of [
      ['BOT_ERRORS_HEALTH_HOUR', '7</integer><key>Injected</key><integer>1'],
      ['BOT_ERRORS_HEALTH_MINUTE', '20</integer><key>Injected</key><integer>1'],
    ] as const) {
      const home = makeTempRoot('whatsoup-launchd-home-');
      const shimDir = makeTempRoot('whatsoup-launchd-shims-');
      const profile = path.join(home, 'health-profile.json');
      const envFile = path.join(home, 'bot-errors.env');
      const repoRoot = path.join(home, 'repo');
      const jid = 'fixture-schedule@g.us';
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

      const result = spawnSync('bash', ['deploy/scripts/install-bot-errors-health-launchd.sh'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          PATH: `${shimDir}:${process.env.PATH ?? ''}`,
          BOT_ERRORS_REPO_ROOT: repoRoot,
          BOT_ERRORS_ENV_FILE: envFile,
          BOT_ERRORS_HEALTH_LABEL: 'com.bot-errors.health-only',
          [envKey]: value,
        },
        encoding: 'utf8',
      });

      expect(result.status, `${envKey} unexpectedly succeeded\n${result.stdout}\n${result.stderr}`).toBe(2);
      expect(result.stderr).toContain(`invalid ${envKey}; expected integer`);
      expect(existsSync(launchAgentPath(home, 'com.bot-errors.health-only'))).toBe(false);
      expect(existsSync(path.join(home, 'launchctl.log'))).toBe(false);
    }
  });

  it('GUI monitor installer preflights config without sourcing the private env file', () => {
    const text = readFileSync(guiMonitorInstaller, 'utf8');
    expect(text).toContain('BOT_ERRORS_ENV_FILE');
    expect(text).toContain('read_env_value');
    expect(text).toContain('env_or_default');
    expect(text).toContain('xml_escape');
    expect(text).toContain('--config-check');
    expect(text).toContain('systemd_env_line BOT_ERRORS_EXPECTED_FLEET');
    expect(text).toContain('launchd_env_entry BOT_ERRORS_EXPECTED_FLEET');
    expect(text).not.toMatch(/\bsource\s+"\$ENV_FILE"|\.\s+"\$ENV_FILE"/);
  });

  it('GUI monitor installer writes no scheduler artifacts when config preflight fails', () => {
    const home = makeTempRoot('whatsoup-gui-monitor-home-');
    const shimDir = makeTempRoot('whatsoup-gui-monitor-shims-');
    const envFile = path.join(home, 'bot-errors.env');
    const repoRoot = path.join(home, 'repo');

    writeFakeGuiMonitorRepo(repoRoot);
    writeFileSync(envFile, 'BOT_ERRORS_EXPECTED_FLEET=/private/fleet.json\n', 'utf8');
    writeShim(shimDir, 'fake-python', [
      '#!/usr/bin/env bash',
      'echo "$@" >> "$HOME/python.log"',
      'echo "config failed" >&2',
      'exit 2',
      '',
    ].join('\n'));
    writeShim(shimDir, 'systemctl', [
      '#!/usr/bin/env bash',
      'echo "$@" >> "$HOME/systemctl.log"',
      'exit 0',
      '',
    ].join('\n'));

    const result = spawnSync('bash', [guiMonitorInstaller], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        PATH: `${shimDir}:${process.env.PATH ?? ''}`,
        BOT_ERRORS_REPO_ROOT: repoRoot,
        BOT_ERRORS_ENV_FILE: envFile,
        BOT_ERRORS_PYTHON: path.join(shimDir, 'fake-python'),
      },
      encoding: 'utf8',
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(2);
    expect(result.stderr).toContain('config failed');
    expect(readFileSync(path.join(home, 'python.log'), 'utf8')).toContain('--config-check');
    expect(existsSync(path.join(home, 'systemctl.log'))).toBe(false);
    expect(existsSync(path.join(home, '.config', 'systemd', 'user', 'com.bot-errors.gui-session-monitor.service'))).toBe(false);
  });

  it('GUI monitor installer persists private expected-fleet env values without executing env-file shell', () => {
    const home = makeTempRoot('whatsoup-gui-monitor-home-');
    const shimDir = makeTempRoot('whatsoup-gui-monitor-shims-');
    const envFile = path.join(home, 'bot-errors.env');
    const maliciousTouch = path.join(home, 'sourced-env-file');
    const repoRoot = path.join(home, 'repo');
    const expectedFleet = path.join(home, 'expected fleet.private.json');
    const users = 'host-a=user-a,host-b=user-b';

    writeFakeGuiMonitorRepo(repoRoot);
    writeFileSync(expectedFleet, '{"hosts":[]}\n', 'utf8');
    writeFileSync(envFile, [
      `BOT_ERRORS_EXPECTED_FLEET=${expectedFleet}`,
      `BOT_ERRORS_GUI_MONITOR_USERS=${users}`,
      'BOT_ERRORS_GUI_MONITOR_SSH_TIMEOUT_SECONDS=4',
      `MALICIOUS_TOUCH=$(touch ${maliciousTouch})`,
      '',
    ].join('\n'), 'utf8');
    writeShim(shimDir, 'fake-python', [
      '#!/usr/bin/env bash',
      'echo "$@" >> "$HOME/python.log"',
      'printf "expected=%s\\n" "${BOT_ERRORS_EXPECTED_FLEET:-}" >> "$HOME/python.env"',
      'printf "users=%s\\n" "${BOT_ERRORS_GUI_MONITOR_USERS:-}" >> "$HOME/python.env"',
      'printf "timeout=%s\\n" "${BOT_ERRORS_GUI_MONITOR_SSH_TIMEOUT_SECONDS:-}" >> "$HOME/python.env"',
      'exit 0',
      '',
    ].join('\n'));
    writeShim(shimDir, 'systemctl', [
      '#!/usr/bin/env bash',
      'echo "$@" >> "$HOME/systemctl.log"',
      'exit 0',
      '',
    ].join('\n'));

    execFileSync('bash', [guiMonitorInstaller], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        PATH: `${shimDir}:${process.env.PATH ?? ''}`,
        BOT_ERRORS_REPO_ROOT: repoRoot,
        BOT_ERRORS_ENV_FILE: envFile,
        BOT_ERRORS_PYTHON: path.join(shimDir, 'fake-python'),
      },
    });

    const service = readFileSync(
      path.join(home, '.config', 'systemd', 'user', 'com.bot-errors.gui-session-monitor.service'),
      'utf8',
    );
    expect(existsSync(maliciousTouch)).toBe(false);
    expect(readFileSync(path.join(home, 'python.log'), 'utf8')).toContain('--config-check');
    expect(readFileSync(path.join(home, 'python.env'), 'utf8')).toContain(`expected=${expectedFleet}`);
    expect(readFileSync(path.join(home, 'python.env'), 'utf8')).toContain(`users=${users}`);
    expect(service).toContain(`EnvironmentFile=-${envFile}`);
    expect(service).toContain(`Environment="BOT_ERRORS_EXPECTED_FLEET=${expectedFleet}"`);
    expect(service).toContain(`Environment="BOT_ERRORS_GUI_MONITOR_USERS=${users}"`);
    expect(service).toContain('Environment="BOT_ERRORS_GUI_MONITOR_SSH_TIMEOUT_SECONDS=4"');
    expect(readFileSync(path.join(home, 'systemctl.log'), 'utf8')).toContain('enable --now com.bot-errors.gui-session-monitor.timer');
  });

  // A1: label path-traversal regression tests
  it('rejects path-traversal label in install-bot-errors-launchd.sh before writing any plist', () => {
    const home = makeTempRoot('whatsoup-label-traversal-main-');
    const shimDir = makeTempRoot('whatsoup-label-traversal-main-shims-');
    const profile = path.join(home, 'health-profile.json');
    const envFile = path.join(home, 'bot-errors.env');
    const repoRoot = path.join(home, 'repo');
    const jid = 'fixture-label-traversal@g.us';
    const socket = path.join(home, 'whatsoup.sock');
    const db = path.join(home, 'bot.sqlite');
    const traversalLabel = '../../../../tmp/whatsoup-traversal-poc';

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

    const result = spawnSync('bash', ['deploy/scripts/install-bot-errors-launchd.sh'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        PATH: `${shimDir}:${process.env.PATH ?? ''}`,
        BOT_ERRORS_REPO_ROOT: repoRoot,
        BOT_ERRORS_ENV_FILE: envFile,
        BOT_ERRORS_LABEL_PREFIX: traversalLabel,
      },
      encoding: 'utf8',
    });

    expect(result.status, `install-bot-errors-launchd.sh accepted traversal label\n${result.stdout}\n${result.stderr}`).toBe(2);
    expect(result.stderr).toMatch(/invalid.*label/i);
    expect(existsSync('/tmp/whatsoup-traversal-poc.plist')).toBe(false);
    expect(existsSync(path.join(home, 'launchctl.log'))).toBe(false);
  });

  it('rejects path-traversal label in install-bot-errors-health-launchd.sh before writing any plist', () => {
    const home = makeTempRoot('whatsoup-label-traversal-health-');
    const shimDir = makeTempRoot('whatsoup-label-traversal-health-shims-');
    const profile = path.join(home, 'health-profile.json');
    const envFile = path.join(home, 'bot-errors.env');
    const repoRoot = path.join(home, 'repo');
    const jid = 'fixture-label-traversal-health@g.us';
    const socket = path.join(home, 'whatsoup.sock');
    const db = path.join(home, 'bot.sqlite');
    const traversalLabel = '../../../../tmp/whatsoup-traversal-poc';

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

    const result = spawnSync('bash', ['deploy/scripts/install-bot-errors-health-launchd.sh'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        PATH: `${shimDir}:${process.env.PATH ?? ''}`,
        BOT_ERRORS_REPO_ROOT: repoRoot,
        BOT_ERRORS_ENV_FILE: envFile,
        BOT_ERRORS_HEALTH_LABEL: traversalLabel,
      },
      encoding: 'utf8',
    });

    expect(result.status, `install-bot-errors-health-launchd.sh accepted traversal label\n${result.stdout}\n${result.stderr}`).toBe(2);
    expect(result.stderr).toMatch(/invalid.*label/i);
    expect(existsSync('/tmp/whatsoup-traversal-poc.plist')).toBe(false);
    expect(existsSync(path.join(home, 'launchctl.log'))).toBe(false);
  });

  it('rejects path-traversal label in install-bot-errors-gui-monitor-launchd.sh before writing any plist', () => {
    const home = makeTempRoot('whatsoup-label-traversal-gui-');
    const shimDir = makeTempRoot('whatsoup-label-traversal-gui-shims-');
    const envFile = path.join(home, 'bot-errors.env');
    const repoRoot = path.join(home, 'repo');
    const traversalLabel = '../../../../tmp/whatsoup-traversal-poc';

    writeFakeGuiMonitorRepo(repoRoot);
    writeFileSync(envFile, 'BOT_ERRORS_EXPECTED_FLEET=/private/fleet.json\n', 'utf8');
    writeShim(shimDir, 'fake-python', [
      '#!/usr/bin/env bash',
      'echo "$@" >> "$HOME/python.log"',
      'exit 0',
      '',
    ].join('\n'));
    writeShim(shimDir, 'systemctl', [
      '#!/usr/bin/env bash',
      'echo "$@" >> "$HOME/systemctl.log"',
      'exit 0',
      '',
    ].join('\n'));

    const result = spawnSync('bash', [guiMonitorInstaller], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        PATH: `${shimDir}:${process.env.PATH ?? ''}`,
        BOT_ERRORS_REPO_ROOT: repoRoot,
        BOT_ERRORS_ENV_FILE: envFile,
        BOT_ERRORS_PYTHON: path.join(shimDir, 'fake-python'),
        BOT_ERRORS_GUI_MONITOR_LABEL: traversalLabel,
      },
      encoding: 'utf8',
    });

    expect(result.status, `install-bot-errors-gui-monitor-launchd.sh accepted traversal label\n${result.stdout}\n${result.stderr}`).toBe(2);
    expect(result.stderr).toMatch(/invalid.*label/i);
    expect(existsSync('/tmp/whatsoup-traversal-poc.plist')).toBe(false);
    expect(existsSync(path.join(home, 'launchctl.log'))).toBe(false);
    expect(existsSync(path.join(home, 'systemctl.log'))).toBe(false);
  });
});

describe('release-proof monitor units', () => {
  it('services carry the full safety and resource contract', () => {
    for (const file of releaseProofServices) {
      const text = readFileSync(file, 'utf8');
      for (const directive of [
        'Type=oneshot',
        'EnvironmentFile=%h/.config/whatsoup/bot-errors.env',
        'ExecStart=%h/.local/lib/whatsoup/release-proof/current/deploy/scripts/bot-errors-release-proof-run.sh',
        'UMask=0077',
        'TimeoutStartSec=45s',
        'TimeoutStopSec=15s',
        'KillMode=control-group',
        'SuccessExitStatus=75',
        'NoNewPrivileges=yes',
        'PrivateTmp=yes',
        'ProtectSystem=strict',
        'ProtectHome=read-only',
        'ReadWritePaths=%h/.local/state/bot-errors',
        'MemoryMax=128M',
        'TasksMax=32',
        'Nice=10',
        'IOSchedulingClass=idle',
      ]) {
        expect(text, `${file} missing ${directive}`).toContain(directive);
      }
    }
  });

  it('units never bind to, restart, or command application services', () => {
    for (const file of releaseProofUnits) {
      const text = readFileSync(file, 'utf8');
      for (const forbidden of [
        'Requires=',
        'PartOf=',
        'BindsTo=',
        'Restart=',
        'whatsoup@',
        'whatsoup-fleet',
        'bot-errors-dispatcher',
        'bot-errors-collector',
        'bot-errors-q-loop',
      ]) {
        expect(text, `${file} contains forbidden ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('timers bootstrap with distinct offsets and repeat via OnUnitInactiveSec', () => {
    const tree = readFileSync('deploy/bot-errors-tree-provenance.timer', 'utf8');
    const stale = readFileSync('deploy/bot-errors-runtime-staleness.timer', 'utf8');
    for (const text of [tree, stale]) {
      expect(text).toContain('OnUnitInactiveSec=30m');
      expect(text).toContain('RandomizedDelaySec=');
      expect(text).not.toContain('OnUnitActiveSec=');
      expect(text).not.toContain('Persistent=true');
    }
    const offset = (t: string) => t.match(/OnActiveSec=(\S+)/)?.[1];
    expect(offset(tree)).toBeDefined();
    expect(offset(stale)).toBeDefined();
    expect(offset(tree)).not.toBe(offset(stale));
  });

  it('exactly one tracked unit schedules tree provenance (single producer, B3)', () => {
    const unitFiles = globSync('deploy/*.service');
    const producers = unitFiles.filter((f) =>
      readFileSync(f, 'utf8').includes('bot-errors-release-proof-run.sh tree'),
    );
    expect(producers).toEqual(['deploy/bot-errors-tree-provenance.service']);
  });
});
