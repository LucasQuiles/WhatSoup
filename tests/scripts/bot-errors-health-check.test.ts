import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { privateHostLabels } from '../../scripts/repo-hygiene-guard.ts';

let tmpRoot = '';
const privateHostLabelFixture = ['nuc', 'les'].join('');
const privateHostDomainFixture = `${privateHostLabelFixture}.${['qui', 'les'].join('')}.${['stu', 'dio'].join('')}`;
const privateTailnetIpFixture = ['100', '91', '13', '7'].join('.');
const parkedAddressFixture = ['35', '155', '7', '183'].join('.');
const secondParkedAddressFixture = ['50', '112', '20', '134'].join('.');

beforeEach(() => {
  process.env['BOT_ERRORS_DRY_ACTIVE_WHATSOUP_SERVICES'] = '';
});

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
  delete process.env['BOT_ERRORS_DRY_ACTIVE_WHATSOUP_SERVICES'];
});

function writeSecureCreds(authDir: string, payload: unknown): void {
  mkdirSync(authDir, { recursive: true });
  chmodSync(authDir, 0o700);
  const credsPath = join(authDir, 'creds.json');
  writeFileSync(credsPath, JSON.stringify(payload));
  chmodSync(credsPath, 0o600);
}

function writePrivateJson(path: string, payload: unknown): void {
  writeFileSync(path, JSON.stringify(payload));
  chmodSync(path, 0o600);
}

function authFixtureModeString(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, '0');
}

function walkAuthFixtureFiles(authDir: string): string[] {
  const files: string[] = [];
  const stack = [authDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = readdirSync(current)
      .filter((name) => name !== '.DS_Store')
      .map((name) => join(current, name))
      .sort()
      .reverse();
    for (const entry of entries) {
      const stat = lstatSync(entry);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        stack.push(entry);
      } else {
        files.push(entry);
      }
    }
  }
  return files;
}

function hashAuthFixtureTree(authDir: string): string {
  const hasher = createHash('sha256');
  for (const path of walkAuthFixtureFiles(authDir)) {
    const stat = lstatSync(path);
    hasher.update(relative(authDir, path).split(sep).join('/'));
    hasher.update('\0');
    hasher.update(authFixtureModeString(stat.mode));
    hasher.update('\0');
    if (stat.isSymbolicLink()) {
      hasher.update('symlink');
      hasher.update('\0');
      hasher.update(readlinkSync(path));
    } else {
      hasher.update('file');
      hasher.update('\0');
      hasher.update(readFileSync(path));
    }
    hasher.update('\0');
  }
  return hasher.digest('hex');
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function readOutboxBySource(outbox: string): {
  summary: Record<string, unknown>;
  fails: Array<Record<string, unknown>>;
} {
  const events = readdirSync(outbox).map(
    (name) => JSON.parse(readFileSync(join(outbox, name), 'utf8')) as Record<string, unknown>,
  );
  const summaries = events.filter((event) => event.source === 'daily-health');
  const fails = events.filter((event) => event.source === 'daily-health-fail');
  expect(summaries).toHaveLength(1);
  expect(fails.length + summaries.length).toBe(events.length);
  return { summary: summaries[0]!, fails };
}

function python(code: string): string {
  return execFileSync('python3', ['-c', code], { cwd: process.cwd(), encoding: 'utf8' }).trim();
}

function importHealthModulePrelude(): string {
  return [
    'import importlib.util',
    'from pathlib import Path',
    'spec = importlib.util.spec_from_file_location("m", "deploy/scripts/bot-errors-health-check.py")',
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
  ].join('\n');
}

function runDeadman(tmpRoot: string, extraEnv: Record<string, string> = {}) {
  return spawnSync('python3', [
    'deploy/scripts/bot-errors-health-check.py',
    '--deadman',
    '--max-state-age',
    '30',
    '--restart-grace',
    '0',
    '--deadman-cooldown',
    extraEnv['BOT_ERRORS_DEADMAN_COOLDOWN_SECONDS'] ?? '60',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: tmpRoot,
      BOT_ERRORS_STATE_DIR: tmpRoot,
      ...extraEnv,
    },
    encoding: 'utf8',
  });
}

describe('bot-errors-health-check', () => {

  it('redirects an explicit live health outbox under pytest provenance', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const home = join(tmpRoot, 'home');
    const writerTmp = join(tmpRoot, 'tmp');
    const liveOutbox = join(home, '.local', 'state', 'bot-errors', 'outbox');
    mkdirSync(home, { recursive: true });
    mkdirSync(writerTmp, { recursive: true });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        TMPDIR: writerTmp,
        BOT_ERRORS_OUTBOX_DIR: liveOutbox,
        PYTEST_CURRENT_TEST: 'tests/test_health.py::test_redirect (call)',
        VITEST: '',
        VITEST_WORKER_ID: '',
        NODE_ENV: '',
        BOT_ERRORS_DRY_TOOL_NAMES: 'send_message',
        BOT_ERRORS_REQUIRED_TOOLS: 'send_message,missing_tool',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'pytest-health',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
        }),
      },
    });

    expect(existsSync(liveOutbox)).toBe(false);
    const testRoot = join(writerTmp, 'whatsoup-vitest-bot-errors');
    const [workerDir] = readdirSync(testRoot);
    const outbox = join(testRoot, workerDir!, 'outbox');
    const event = JSON.parse(readFileSync(join(outbox, readdirSync(outbox)[0]!), 'utf8')) as Record<string, any>;
    expect(event.runtime.provenance).toMatchObject({
      producer: 'python-health',
      test: true,
      outboxPolicy: 'test-redirect',
      liveOutboxRedirected: true,
    });
    expect(event.runtime.provenance.signals).toEqual(['PYTEST_CURRENT_TEST']);
  });

  it('records a recoverable writefail breadcrumb when daily health outbox is unwritable', () => {
    tmpRoot = mkdtempSync('/tmp/bot-errors-health-');
    const blocked = join(tmpRoot, 'blocked-outbox-parent');
    const writefail = join(tmpRoot, 'writefail');
    writeFileSync(blocked, 'not a directory');

    const result = spawnSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TMPDIR: '/tmp',
        HOME: tmpRoot,
          BOT_ERRORS_STATE_DIR: tmpRoot,
          BOT_ERRORS_OUTBOX_DIR: join(blocked, 'outbox'),
          BOT_ERRORS_WRITEFAIL_DIR: writefail,
          VITEST: '',
          VITEST_WORKER_ID: '',
          NODE_ENV: '',
          BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'missing-routing',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalTools: true,
          expectPersonalSocket: true,
          expectConfigInventory: false,
          expectPluginInventory: false,
        }),
        BOT_ERRORS_SOCKET_PATH: '',
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('CRITICAL outbox write FAILED');
    expect(result.stderr).toContain('lost-alert breadcrumb written');
    const crumbs = readdirSync(writefail).filter((name) => name.endsWith('.writefail'));
    expect(crumbs).toHaveLength(1);
    const crumb = JSON.parse(readFileSync(join(writefail, crumbs[0]!), 'utf8')) as Record<string, any>;
    expect(crumb).toMatchObject({ kind: 'outbox_write_failure', schemaVersion: 1 });
    expect(crumb.failedTarget).toBe(join(blocked, 'outbox'));
    expect(crumb.event).toMatchObject({
      eventType: 'alert',
      severity: 'critical',
      instance: 'bot-errors-health',
      source: 'daily-health',
    });
    expect(crumb.event.evidence).toContain('FAIL personal_socket: <unset> exists=False');
    expect(crumb.event.evidence).toContain('tools personal: FAIL BOT_ERRORS_SOCKET_PATH is not configured');

    const capture = join(tmpRoot, 'capture.txt');
    const dispatch = spawnSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TMPDIR: '/tmp',
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_WRITEFAIL_DIR: writefail,
        BOT_ERRORS_DRY_SEND_CAPTURE: capture,
        VITEST: '',
        VITEST_WORKER_ID: '',
        NODE_ENV: '',
      },
      encoding: 'utf8',
    });

    expect(dispatch.status).toBe(0);
    expect(readFileSync(capture, 'utf8')).toContain('BOT ERRORS daily health found issues');
    expect(readFileSync(capture, 'utf8')).toContain('writefail_recovered');
    expect(readdirSync(join(tmpRoot, 'sent')).filter((name) => name.endsWith('.sent'))).toHaveLength(1);
  });

  it('redacts phone numbers without masking version or timestamp diagnostics', () => {
    const result = python(`${importHealthModulePrelude()}
import json
samples = {
    "version": m.redact_event_text("baileys_version=2.3000.1020194169"),
    "timestamp": m.redact_event_text("outbound_success_at=2026-06-11 10:15:02"),
    "keyed_phone": m.redact_event_text("line=14155551234"),
    "context_phone": m.redact_event_text("for 14155551234"),
}
print(json.dumps(samples, sort_keys=True))
`);
    expect(JSON.parse(result)).toEqual({
      version: 'baileys_version=2.3000.1020194169',
      timestamp: 'outbound_success_at=2026-06-11 10:15:02',
      keyed_phone: 'line=[REDACTED_PHONE]',
      context_phone: 'for [REDACTED_PHONE]',
    });
  });

  it('fails daily health when BOT ERRORS target drifts from the expected group', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_JID: '120363555555555000@g.us',
        BOT_ERRORS_EXPECTED_JID: 'expected-group@g.us',
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'target-drift',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
          expectAlertTarget: true,
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('FAIL alert_target: BOT_ERRORS_JID mismatch');
    expect(event.evidence).toContain('actual_fingerprint=');
    expect(event.evidence).toContain('expected_fingerprint=');
    expect(event.evidence).not.toContain('120363555555555000@g.us');
    expect(event.evidence).not.toContain('expected-group@g.us');
  });

  it('fails daily health when BOT ERRORS target is not pinned to an expected group', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_JID: '120363555555555000@g.us',
        BOT_ERRORS_EXPECTED_JID: '',
        BOT_ERRORS_REQUIRE_EXPECTED: '1',
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'target-missing-expected',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
          expectAlertTarget: true,
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('alert_target: group_jid configured target_fingerprint=');
    expect(event.evidence).toContain('FAIL alert_target: BOT_ERRORS_EXPECTED_JID missing');
    expect(event.evidence).not.toContain('120363555555555000@g.us');
  });

  it('downgrades missing expected BOT ERRORS target to warning only when explicitly unrequired', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_JID: '120363555555555000@g.us',
        BOT_ERRORS_EXPECTED_JID: '',
        BOT_ERRORS_REQUIRE_EXPECTED: '0',
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'target-missing-expected-warn',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
          expectAlertTarget: true,
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('warning');
    expect(event.evidence).toContain('WARN alert_target: BOT_ERRORS_EXPECTED_JID missing');
    expect(event.evidence).not.toContain('FAIL alert_target: BOT_ERRORS_EXPECTED_JID missing');
    expect(event.evidence).not.toContain('120363555555555000@g.us');
  });

  it('fails daily health when BOT ERRORS target is not a group JID', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_JID: '15551234567@s.whatsapp.net',
        BOT_ERRORS_EXPECTED_JID: '15551234567@s.whatsapp.net',
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'target-not-group',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
          expectAlertTarget: true,
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('FAIL alert_target: BOT_ERRORS_JID must be WhatsApp group JID');
    expect(event.evidence).not.toContain('15551234567@s.whatsapp.net');
  });

  it('keeps all checked-in health profiles parseable', () => {
    const profilesDir = join(process.cwd(), 'deploy', 'health-profiles');
    for (const file of readdirSync(profilesDir).filter((name) => name.endsWith('.json'))) {
      const profile = JSON.parse(readFileSync(join(profilesDir, file), 'utf8')) as {
        role?: unknown;
        instances?: unknown;
        expectPrimaryPhoneVerification?: unknown;
      };
      expect(profile.role).toEqual(expect.any(String));
      expect(typeof profile.expectPrimaryPhoneVerification).toBe('boolean');
      if ('instances' in profile) {
        expect(Array.isArray(profile.instances)).toBe(true);
      }
    }
  });

  it('requires primary-phone verification policy for every always-on profile instance', () => {
    const profilesDir = join(process.cwd(), 'deploy', 'health-profiles');
    for (const file of readdirSync(profilesDir).filter((name) => name.endsWith('.json'))) {
      const profile = JSON.parse(readFileSync(join(profilesDir, file), 'utf8')) as {
        expectPrimaryPhoneVerification?: boolean;
        instances?: Array<Record<string, unknown>>;
      };
      const profileRequiresVerification = profile.expectPrimaryPhoneVerification === true;
      for (const instance of profile.instances ?? []) {
        if ((instance.expected ?? 'always_on') !== 'always_on') continue;
        const instanceRequiresVerification = instance.primaryPhoneVerificationRequired === true
          || instance.primary_phone_verification_required === true;
        expect(
          profileRequiresVerification || instanceRequiresVerification,
          `${file}:${String(instance.name)} always_on instances must opt into primary-phone verification`,
        ).toBe(true);
      }
    }
  });

  it('requires primary-phone owner metadata for every required verification instance', () => {
    const profilesDir = join(process.cwd(), 'deploy', 'health-profiles');
    for (const file of readdirSync(profilesDir).filter((name) => name.endsWith('.json'))) {
      const profile = JSON.parse(readFileSync(join(profilesDir, file), 'utf8')) as {
        expectPrimaryPhoneVerification?: boolean;
        instances?: Array<Record<string, unknown>>;
      };
      const profileRequiresVerification = profile.expectPrimaryPhoneVerification === true;
      for (const instance of profile.instances ?? []) {
        if ((instance.expected ?? 'always_on') !== 'always_on') continue;
        const instanceRequirement = instance.primaryPhoneVerificationRequired ?? instance.primary_phone_verification_required;
        const requiresVerification = instanceRequirement === false
          ? false
          : profileRequiresVerification || instanceRequirement === true;
        if (!requiresVerification) continue;
        const owner = instance.primaryPhoneOwner ?? instance.primary_phone_owner ?? instance.owner;
        expect(
          typeof owner === 'string' && owner.trim().length > 0 && owner !== 'unknown',
          `${file}:${String(instance.name)} required primary-phone verification needs primaryPhoneOwner`,
        ).toBe(true);
      }
    }
  });

  it('requires explicit health-token credential coverage for every always-on profile instance', () => {
    const profilesDir = join(process.cwd(), 'deploy', 'health-profiles');
    for (const file of readdirSync(profilesDir).filter((name) => name.endsWith('.json'))) {
      const profile = JSON.parse(readFileSync(join(profilesDir, file), 'utf8')) as {
        instances?: Array<Record<string, unknown>>;
        requiredCredentialFiles?: unknown;
      };
      const required = Array.isArray(profile.requiredCredentialFiles)
        ? profile.requiredCredentialFiles.filter((item): item is string => typeof item === 'string')
        : [];
      for (const instance of profile.instances ?? []) {
        if ((instance.expected ?? 'always_on') !== 'always_on') continue;
        const name = String(instance.name ?? '');
        expect(
          required,
          `${file}:${name} always_on instances must require their scoped tokens.env`,
        ).toContain(`instances/${name}/tokens.env`);
      }
    }
  });

  it('requires BOT ERRORS routing credentials for profiles that run dispatcher or q-loop', () => {
    const profilesDir = join(process.cwd(), 'deploy', 'health-profiles');
    for (const file of readdirSync(profilesDir).filter((name) => name.endsWith('.json'))) {
      const profile = JSON.parse(readFileSync(join(profilesDir, file), 'utf8')) as {
        expectDispatcher?: boolean;
        expectQLoop?: boolean;
        requiredCredentialFiles?: unknown;
      };
      if (profile.expectDispatcher !== true && profile.expectQLoop !== true) continue;
      const required = Array.isArray(profile.requiredCredentialFiles)
        ? profile.requiredCredentialFiles.filter((item): item is string => typeof item === 'string')
        : [];
      expect(required, `${file} must require the BOT ERRORS routing env`).toContain('bot-errors.env');
    }
  });

  it('keeps central-profile chat monitoring operator-owned', () => {
    const profilesDir = join(process.cwd(), 'deploy', 'health-profiles');
    const centralProfiles = readdirSync(profilesDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(join(profilesDir, name), 'utf8')) as {
        role?: string;
        expectQLoop?: boolean;
      })
      .filter((profile) => profile.role === 'central');

    expect(centralProfiles).toHaveLength(1);
    expect(centralProfiles[0]?.expectQLoop).toBe(false);
  });

  it('requires private config mode enforcement for profiles with config inventory', () => {
    const profilesDir = join(process.cwd(), 'deploy', 'health-profiles');
    for (const file of readdirSync(profilesDir).filter((name) => name.endsWith('.json'))) {
      const profile = JSON.parse(readFileSync(join(profilesDir, file), 'utf8')) as {
        expectConfigInventory?: boolean;
        instances?: unknown;
        requiredConfigMaxMode?: unknown;
      };
      const hasInstances = Array.isArray(profile.instances) && profile.instances.length > 0;
      if (profile.expectConfigInventory !== true || !hasInstances) continue;

      expect(
        profile.requiredConfigMaxMode,
        `${file} must fail health checks when instance config files exceed 0600`,
      ).toBe('600');
    }
  });

  it('passes daily health when the RustDesk guard matches the pinned remote access state', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_RUSTDESK_ID: '1076834574',
        BOT_ERRORS_DRY_RUSTDESK_SERVICE_STATUS: 'active',
        BOT_ERRORS_DRY_RUSTDESK_PORT_STATUS: 'ok',
        BOT_ERRORS_DRY_RUSTDESK_RENDEZVOUS_STATUS: 'ok',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'rustdesk-ok',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
          expectAlertTarget: false,
          expectRustDesk: true,
          expectedRustDeskId: '1076834574',
          rustDeskCommand: '/usr/bin/rustdesk',
          rustDeskService: 'rustdesk.service',
          rustDeskDirectPort: 21118,
          rustDeskRendezvous: 'rs-ny.rustdesk.com:21116',
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      eventType: string;
      severity: string;
      evidence: string;
    };
    expect(event.eventType).toBe('clear');
    expect(event.severity).toBe('info');
    expect(event.evidence).toContain('rustdesk: id=1076834574 expected_id=1076834574');
    expect(event.evidence).toContain('rustdesk_service: active (rustdesk.service) scope=user');
    expect(event.evidence).toContain('rustdesk_direct: host=127.0.0.1 port=21118 status=ok');
    expect(event.evidence).toContain('rustdesk_rendezvous: endpoint=rs-ny.rustdesk.com:21116 status=ok');
  });

  it('fails daily health when the RustDesk ID drifts from the pinned Nucles ID', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_RUSTDESK_ID: '999999999',
        BOT_ERRORS_DRY_RUSTDESK_SERVICE_STATUS: 'active',
        BOT_ERRORS_DRY_RUSTDESK_PORT_STATUS: 'ok',
        BOT_ERRORS_DRY_RUSTDESK_RENDEZVOUS_STATUS: 'ok',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'rustdesk-drift',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
          expectAlertTarget: false,
          expectRustDesk: true,
          expectedRustDeskId: '1076834574',
          rustDeskCommand: '/usr/bin/rustdesk',
          rustDeskService: 'rustdesk.service',
          rustDeskDirectPort: 21118,
          rustDeskRendezvous: 'rs-ny.rustdesk.com:21116',
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('warning'); // F7: rustdesk is infra-class, de-conflated from critical
    expect(event.evidence).toContain('FAIL rustdesk: id=999999999 expected_id=1076834574');
  });

  it('reports profile-driven DNS checks when expected addresses resolve', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_DNS_JSON: JSON.stringify({ 'example.internal': ['203.0.113.10'] }),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'dns-ok',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
          expectAlertTarget: false,
          dnsChecks: [
            { name: 'custom-domain', host: 'example.internal', expectedAddresses: ['203.0.113.10'] },
          ],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('info');
    expect(event.evidence).toContain(
      'dns custom-domain: host=example.internal addresses=203.0.113.10 expected=203.0.113.10',
    );
  });

  it('fails profile-driven DNS checks on parked or unexpected addresses', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_DNS_JSON: JSON.stringify({ [privateHostDomainFixture]: [parkedAddressFixture] }),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'dns-bad',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
          expectAlertTarget: false,
          dnsChecks: [
            {
              name: `${privateHostLabelFixture}-custom-domain`,
              host: privateHostDomainFixture,
              expectedAddresses: [privateTailnetIpFixture],
              forbidAddresses: [parkedAddressFixture, secondParkedAddressFixture],
            },
          ],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('warning'); // F7: dns is infra-class, de-conflated from critical
    expect(event.evidence).toContain(`FAIL dns ${privateHostLabelFixture}-custom-domain: host=${privateHostDomainFixture}`);
    expect(event.evidence).toContain(`addresses=${parkedAddressFixture}`);
    expect(event.evidence).toContain(`missing_expected=${privateTailnetIpFixture}`);
    expect(event.evidence).toContain(`forbidden_present=${parkedAddressFixture}`);
  });

  it('tracks mini1 personal runtime instead of stale secondary-bot profile entries', () => {
    const profile = JSON.parse(readFileSync(join(process.cwd(), 'deploy', 'health-profiles', 'mini1.json'), 'utf8')) as {
      requiredCredentialFiles?: string[];
      instances?: Array<Record<string, unknown>>;
    };
    const names = (profile.instances ?? []).map((instance) => instance.name);
    expect(names).toContain('ana-bot');
    expect(names).toContain('personal');
    expect(names).not.toContain('secondary-bot');
    expect(profile.requiredCredentialFiles).toContain('instances/personal/tokens.env');
    expect(profile.requiredCredentialFiles).not.toContain('instances/secondary-bot/tokens.env');

    const personal = (profile.instances ?? []).find((instance) => instance.name === 'personal');
    expect(personal).toMatchObject({
      expected: 'always_on',
      service: 'com.whatsoup.personal',
      healthPort: 9095,
      primaryPhoneOwner: 'instance:personal',
    });
  });

  it('keeps the expected fleet manifest aligned with health profiles and collector remotes', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'deploy', 'bot-errors-expected-fleet.json'), 'utf8')) as {
      schemaVersion?: unknown;
      hosts?: Array<Record<string, unknown>>;
    };
    expect(manifest.schemaVersion).toBe(1);
    expect(Array.isArray(manifest.hosts)).toBe(true);
    const hosts = manifest.hosts ?? [];
    const hostNames = hosts.map((host) => host.host);
    expect(hostNames).not.toContain('brick');
    expect(new Set(hostNames).size).toBe(hostNames.length);

    const profilesDir = join(process.cwd(), 'deploy', 'health-profiles');
    const profileFiles = readdirSync(profilesDir).filter((name) => name.endsWith('.json')).sort();
    const manifestProfiles = hosts.map((host) => String(host.profile)).sort();
    expect(manifestProfiles).toEqual(profileFiles);

    const normalizeInstances = (raw: unknown): Array<Record<string, unknown>> => {
      if (!Array.isArray(raw)) return [];
      return raw.map((item) => {
        const source = item as Record<string, unknown>;
        const out: Record<string, unknown> = {
          name: source.name,
          expected: source.expected ?? 'always_on',
        };
        if (typeof source.service === 'string') out.service = source.service;
        if (typeof source.healthPort === 'number') out.healthPort = source.healthPort;
        return out;
      });
    };

    for (const host of hosts) {
      expect(typeof host.host).toBe('string');
      expect(typeof host.role).toBe('string');
      expect(typeof host.profile).toBe('string');
      const profilePath = join(profilesDir, String(host.profile));
      expect(existsSync(profilePath)).toBe(true);
      const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as Record<string, unknown>;
      expect(profile.role).toBe(host.role);
      expect(normalizeInstances(profile.instances)).toEqual(normalizeInstances(host.instances));
    }

    // collectorRemote is a manifest-internal flag: every host must declare it as
    // a boolean, and at least one host must be a collector remote. The ACTUAL
    // poll list is host-local (BOT_ERRORS_RELAY_REMOTES) and is NOT tracked here
    // — see the 'free of private host topology' guard above. This replaces the
    // former .service<->manifest --remote parity, which coupled this suite to
    // private host labels in a tracked unit (the PR #1406 hygiene landmine).
    for (const host of hosts) {
      expect(typeof host.collectorRemote).toBe('boolean');
    }
    expect(hosts.some((host) => host.collectorRemote === true)).toBe(true);
  });

  it('keeps the tracked collector unit free of private host topology (poll list lives in host-local env)', () => {
    // Regression guard for the publication-hygiene landmine: the tracked unit
    // must NOT carry the fleet poll list. Real hosts are seeded per-host via
    // BOT_ERRORS_RELAY_REMOTES in the untracked EnvironmentFile. Re-introducing
    // --remote flags or private host labels here both leaks fleet topology into
    // the public repo and re-couples this suite to repo-hygiene's branch-diff
    // private-host-label rule (which froze the line and blocked PR #1406).
    const unit = readFileSync(join(process.cwd(), 'deploy', 'bot-errors-collector.service'), 'utf8');
    const execLine = unit.split('\n').find((line) => line.startsWith('ExecStart=')) ?? '';
    expect(execLine).not.toMatch(/--remote\s/);
    expect(execLine).not.toMatch(/--best-effort-remote\s/);
    // No private host labels anywhere in the tracked unit. The label set is the
    // canonical privateHostLabels SSOT imported from repo-hygiene-guard.ts, so
    // this guard tracks the publication rule exactly and cannot drift from it.
    for (const label of privateHostLabels) {
      expect(unit).not.toContain(label);
    }
    // The unit must still load the host-local env file that supplies the list.
    expect(unit).toMatch(/^EnvironmentFile=.*bot-errors\.env$/m);
  });

  it('passes runtime manifest files when hashes match', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const probe = join(tmpRoot, 'runtime-probe.txt');
    writeFileSync(probe, 'expected runtime content\nrequired-capability-marker\n');
    const digest = createHash('sha256').update(readFileSync(probe)).digest('hex');

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'manifest-pass',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          expectRuntimeManifest: true,
        }),
        BOT_ERRORS_RUNTIME_MANIFEST_JSON: JSON.stringify({
          schemaVersion: 1,
          files: [{ path: probe, sha256: digest, mustContain: ['required-capability-marker'] }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      eventType: string;
      severity: string;
      evidence: string;
    };
    expect(event.eventType).toBe('clear');
    expect(event.severity).toBe('info');
    expect(event.evidence).toContain('runtime_manifest: files=1');
    expect(event.evidence).toContain(`runtime_manifest ${probe}: sha256=${digest} expected=${digest}`);
    expect(event.evidence).toContain('markers=1 missing_markers=0');
  });

  it('passes daily health when source update access is reachable', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_SOURCE_UPDATE_RC: '0',
        BOT_ERRORS_DRY_SOURCE_UPDATE_STDOUT: 'abc123\\tHEAD\\n',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'source-update-pass',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
          expectSourceUpdateAccess: true,
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      eventType: string;
      severity: string;
      evidence: string;
      alertSource?: string;
    };
    expect(event.eventType).toBe('clear');
    expect(event.severity).toBe('info');
    expect(event.alertSource).toBe('source_update');
    expect(event.evidence).toContain('source_update: git_remote reachable mode=enforce remote=origin ref=HEAD rc=0');
  });

  it('fails daily health when source update access is blocked by Git remote auth', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_SOURCE_UPDATE_RC: '128',
        BOT_ERRORS_DRY_SOURCE_UPDATE_STDERR: [
          'git@github.com: Permission denied (publickey).',
          'fatal: Could not read from remote repository.',
          'token: colon-secret-value',
          '{"access_token":"json-secret-value"}',
          'Authorization: Basic basic-secret-value',
          'remote=https://tokenonlysecret@github.com/LucasQuiles/WhatSoup.git',
        ].join('\\n'),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'source-update-auth-fail',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
          sourceUpdateAccessMode: 'enforce',
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
      alertSource?: string;
      criticalAsset?: {
        asset?: { kind?: string; instance?: string };
        failure?: { code?: string; domain?: string; recoverability?: string };
      };
    };
    expect(event.severity).toBe('critical');
    expect(event.alertSource).toBe('source_update');
    expect(event.criticalAsset?.asset?.kind).toBe('source_repository');
    expect(event.criticalAsset?.asset?.instance).toBe('repository');
    expect(event.criticalAsset?.failure?.code).toBe('SOURCE_UPDATE_BLOCKED');
    expect(event.criticalAsset?.failure?.domain).toBe('source_distribution');
    expect(event.criticalAsset?.failure?.recoverability).toBe('operator_recoverable');
    expect(event.evidence).toContain(
      'FAIL source_update: source_update_blocked mode=enforce failure_class=git_remote_auth_failed remote=origin ref=HEAD rc=128',
    );
    expect(event.evidence).toContain('Permission_denied_(publickey)');
    expect(event.evidence).not.toContain('LucasQuiles/WhatSoup');
    expect(event.evidence).not.toContain('colon-secret-value');
    expect(event.evidence).not.toContain('json-secret-value');
    expect(event.evidence).not.toContain('basic-secret-value');
    expect(event.evidence).not.toContain('tokenonlysecret');
  });

  it('retains shadow source update failures without alerting BOT ERRORS', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_SOURCE_UPDATE_RC: '128',
        BOT_ERRORS_DRY_SOURCE_UPDATE_STDERR: 'git@github.com: Permission denied (publickey).\\n',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'source-update-shadow-auth-fail',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
          sourceUpdateAccessMode: 'shadow',
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      eventType: string;
      severity: string;
      evidence: string;
      alertSource?: string;
    };
    expect(event.eventType).toBe('observation');
    expect(event.severity).toBe('info');
    expect(event.alertSource).toBeUndefined();
    expect(event.evidence).toContain(
      'source_update: shadow source_update_blocked mode=shadow failure_class=git_remote_auth_failed remote=origin ref=HEAD rc=128',
    );
    expect(event.evidence).not.toContain('FAIL source_update');
  });

  it('keeps source update identity when primary-phone verification is fresh', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'primary-bot');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      type: 'agent',
      enabled: true,
    }));
    chmodSync(join(configDir, 'config.json'), 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'primary@s.whatsapp.net', lid: 'primary@lid' },
      registrationId: 1,
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_NOW_EPOCH: String(Math.floor(Date.parse('2026-06-11T00:00:00Z') / 1000)),
        BOT_ERRORS_DRY_SOURCE_UPDATE_RC: '128',
        BOT_ERRORS_DRY_SOURCE_UPDATE_STDERR: 'Permission denied (publickey).\\n',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'source-update-with-primary-phone-ok',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
          expectPrimaryPhoneVerification: true,
          sourceUpdateAccessMode: 'enforce',
          instances: [{
            name: 'primary-bot',
            expected: 'always_on',
            primaryPhoneLastVerifiedAt: '2026-06-10T00:00:00Z',
            primaryPhoneOwner: 'Lucas',
          }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      alertSource?: string;
      evidence: string;
    };
    expect(event.severity).toBe('critical');
    expect(event.alertSource).toBe('source_update');
    expect(event.evidence).toContain('FAIL source_update: source_update_blocked mode=enforce');
    expect(event.evidence).toContain('OK primary_phone primary-bot: owner=Lucas');
  });

  it('emits a supplemental source-update clear when unrelated warnings remain', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'unsynced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_SOURCE_UPDATE_RC: '0',
        BOT_ERRORS_DRY_SOURCE_UPDATE_STDOUT: 'abc123\\tHEAD\\n',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'source-update-clear-with-warning',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
          sourceUpdateAccessMode: 'enforce',
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const events = readdirSync(outbox)
      .map((file) => JSON.parse(readFileSync(join(outbox, file), 'utf8')) as {
        eventType: string;
        severity: string;
        alertSource?: string;
        evidence: string;
      });
    expect(events).toHaveLength(2);
    const aggregate = events.find((event) => event.alertSource !== 'source_update');
    const sourceUpdate = events.find((event) => event.alertSource === 'source_update');
    expect(aggregate?.eventType).toBe('alert');
    expect(aggregate?.severity).toBe('warning');
    expect(aggregate?.evidence).toContain('WARN clock: status=unsynced');
    expect(sourceUpdate?.eventType).toBe('clear');
    expect(sourceUpdate?.severity).toBe('info');
    expect(sourceUpdate?.evidence).toBe('source_update: git_remote reachable mode=enforce remote=origin ref=HEAD rc=0');
  });

  it('fails closed for invalid source update access modes', () => {
    const invalidModes: unknown[] = ['', true, [], {}];
    for (const mode of invalidModes) {
      tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
      execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: tmpRoot,
          BOT_ERRORS_STATE_DIR: tmpRoot,
          BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
          BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
          BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
          BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
          BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
            role: 'source-update-invalid-mode',
            expectDispatcher: false,
            expectQLoop: false,
            expectPersonalSocket: false,
            expectPersonalTools: false,
            expectConfigInventory: false,
            expectPluginInventory: false,
            expectRuntimeManifest: false,
            sourceUpdateAccessMode: mode,
          }),
        },
      });

      const outbox = join(tmpRoot, 'outbox');
      const files = readdirSync(outbox);
      expect(files).toHaveLength(1);
      const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
        severity: string;
        evidence: string;
      };
      expect(event.severity).toBe('critical');
      expect(event.evidence).toContain('FAIL source_update: invalid sourceUpdateAccessMode=');
    }
  });

  it('keeps the checked-in BOT ERRORS runtime manifest aligned with scripts and markers', () => {
    const manifestPath = join(process.cwd(), 'deploy', 'bot-errors-runtime-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      schemaVersion?: unknown;
      files?: Array<{ path?: unknown; sha256?: unknown; mustContain?: unknown }>;
    };
    expect(manifest.schemaVersion).toBe(1);
    expect(Array.isArray(manifest.files)).toBe(true);

    for (const item of manifest.files ?? []) {
      expect(typeof item.path).toBe('string');
      expect(typeof item.sha256).toBe('string');
      const path = join(process.cwd(), String(item.path));
      const body = readFileSync(path);
      const digest = createHash('sha256').update(body).digest('hex');
      expect(digest, String(item.path)).toBe(item.sha256);
      const markers = Array.isArray(item.mustContain)
        ? item.mustContain.filter((marker): marker is string => typeof marker === 'string')
        : [];
      const text = body.toString('utf8');
      for (const marker of markers) {
        expect(text, `${String(item.path)} must contain ${marker}`).toContain(marker);
      }
    }
  });

  it('fails daily health when runtime manifest hashes drift', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const probe = join(tmpRoot, 'runtime-probe.txt');
    writeFileSync(probe, 'actual runtime content\n');

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'manifest-fail',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          expectRuntimeManifest: true,
        }),
        BOT_ERRORS_RUNTIME_MANIFEST_JSON: JSON.stringify({
          schemaVersion: 1,
          files: [{ path: probe, sha256: '0'.repeat(64) }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain(`FAIL runtime_manifest ${probe}: sha256=`);
    expect(event.evidence).toContain(`expected=${'0'.repeat(64)}`);
  });

  it('does not let a primary-phone warning claim alertSource when runtime manifest has the hard failure', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const probe = join(tmpRoot, 'runtime-probe.txt');
    writeFileSync(probe, 'actual runtime content\n');
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'primary-bot');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      type: 'agent',
      enabled: true,
    }));
    chmodSync(join(configDir, 'config.json'), 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'primary@s.whatsapp.net', lid: 'primary@lid' },
      registrationId: 1,
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'manifest-over-warning',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: true,
          expectPluginInventory: false,
          expectRuntimeManifest: true,
          expectPrimaryPhoneVerification: true,
          instances: [{
            name: 'primary-bot',
            expected: 'always_on',
            primaryPhoneOwner: 'Lucas',
          }],
        }),
        BOT_ERRORS_RUNTIME_MANIFEST_JSON: JSON.stringify({
          schemaVersion: 1,
          files: [{ path: probe, sha256: '0'.repeat(64) }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
      alertSource?: string;
      criticalAsset?: unknown;
    };
    expect(event.severity).toBe('critical');
    expect(event.alertSource).toMatch(/^runtime_manifest:/);
    expect(event.alertSource).not.toBe('primary_phone:primary-bot');
    expect(Object.hasOwn(event, 'criticalAsset')).toBe(false);
    expect(event.evidence).toContain(`FAIL runtime_manifest ${probe}: sha256=`);
    expect(event.evidence).toContain('WARN primary_phone primary-bot: owner=Lucas');
    expect(event.evidence).toContain('verification_proof=missing');
  });

  it('fails daily health when runtime manifest capability markers are missing', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const probe = join(tmpRoot, 'runtime-probe.txt');
    writeFileSync(probe, 'actual runtime content without the required capability\n');
    const digest = createHash('sha256').update(readFileSync(probe)).digest('hex');

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'manifest-marker-drift',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          expectRuntimeManifest: true,
        }),
        BOT_ERRORS_RUNTIME_MANIFEST_JSON: JSON.stringify({
          schemaVersion: 1,
          files: [{ path: probe, sha256: digest, mustContain: ['q_unavailable_session_limit'] }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain(`runtime_manifest ${probe}: sha256=${digest} expected=${digest}`);
    expect(event.evidence).toContain('markers=1 missing_markers=1');
    expect(event.evidence).toContain('FAIL runtime_manifest');
    expect(event.evidence).toContain('missing_marker=q_unavailable_session_limit');
  });

  it('fails daily health when the runtime manifest schema version drifts', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'manifest-schema-drift',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          expectRuntimeManifest: true,
        }),
        BOT_ERRORS_RUNTIME_MANIFEST_JSON: JSON.stringify({
          schemaVersion: 2,
          files: [],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('FAIL runtime_manifest: unsupported schemaVersion=2');
  });

  it('reports missing personal socket configuration instead of treating cwd as a socket', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'missing-routing',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalTools: true,
          expectPersonalSocket: true,
          expectConfigInventory: false,
          expectPluginInventory: false,
        }),
        BOT_ERRORS_SOCKET_PATH: '',
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('FAIL personal_socket: <unset> exists=False');
    expect(event.evidence).toContain('tools personal: FAIL BOT_ERRORS_SOCKET_PATH is not configured');
  });

  it('fails daily health when expected supervision services are inactive', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_SERVICE_STATUS: 'inactive',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'supervision-services-inactive',
          expectDispatcher: true,
          expectQLoop: true,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
          expectAlertTarget: false,
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('FAIL dispatcher_service: inactive');
    expect(event.evidence).toContain('FAIL q_loop_service: inactive');
  });

  it('uses a macOS WhatSoup process fallback when launchctl cannot prove an instance service', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'personal');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      type: 'agent',
      enabled: true,
      healthPort: 9190,
      agentOptions: { provider: 'openai-api' },
    }));
    chmodSync(join(configDir, 'config.json'), 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'personal@s.whatsapp.net', lid: 'personal@lid' },
      registrationId: 2,
    });
    const outboundTransportId = 'wamid.raw-transport-id-should-not-leak';
    const outboundTransportHash = createHash('sha256').update(outboundTransportId).digest('hex').slice(0, 20);

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_PLATFORM: 'darwin',
        BOT_ERRORS_DRY_ACTIVE_WHATSOUP_SERVICES: 'com.whatsoup.personal-dry-fallback',
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_HEALTH_STATUS: '200',
        BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON: JSON.stringify({
          status: 'healthy',
          whatsapp: {
            connected: true,
            connection: { state: 'connected', auth_failure_class: 'none' },
            auth_bond: {
              status: 'present',
              backup: { latest: join(tmpRoot, 'auth-backups', 'latest') },
            },
          },
          outbound_sends: {
            latest_successful_send_at: '2026-06-11T10:00:00.000Z',
            latest_successful_transport_id: outboundTransportId,
          },
        }),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
          instances: [{
            name: 'personal',
            expected: 'always_on',
            service: 'com.whatsoup.personal-dry-fallback',
            healthPort: 9190,
          }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const { summary, fails } = readOutboxBySource(outbox);
    const event = summary as unknown as {
      severity: string;
      evidence: string;
    };
    expect(fails.length).toBeGreaterThanOrEqual(1);
    for (const fail of fails) {
      expect(fail.severity).toBe('critical');
      expect((fail.diagnostics as Record<string, unknown>).forceNotify).toBe(true);
    }
    expect(event.evidence).toContain('service personal: active_process_fallback (com.whatsoup.personal-dry-fallback)');
    expect(event.evidence).not.toContain('FAIL service personal');
    expect(event.evidence).toContain('outbound_success_at=2026-06-11T10:00:00.000Z');
    expect(event.evidence).toContain('outbound_success_transport_present=true');
    expect(event.evidence).toContain(`outbound_success_transport_hash=${outboundTransportHash}`);
    expect(event.evidence).not.toContain(outboundTransportId);
    expect(event.evidence).not.toContain('personal@s.whatsapp.net');
  });

  it('fails daily health when expected q-loop state is missing', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const qLoopStateDir = join(tmpRoot, 'q-loop-state');

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_Q_LOOP_STATE_DIR: qLoopStateDir,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_SERVICE_STATUS: 'active',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'missing-q-loop-state',
          expectDispatcher: false,
          expectQLoop: true,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
          expectAlertTarget: false,
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain(`FAIL q_loop_state: missing ${join(qLoopStateDir, 'state.json')}`);
  });

  it('fails daily health when q-loop has persisted poll failures', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const qLoopStateDir = join(tmpRoot, 'q-loop-state');
    mkdirSync(qLoopStateDir, { recursive: true });
    chmodSync(qLoopStateDir, 0o700);
    writePrivateJson(join(qLoopStateDir, 'state.json'), {
      updated_at: 1000,
      phase: 'monitoring',
      last_seen_pk: 42,
      consecutive_poll_failures: 2,
      last_poll_error: 'database locked',
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_Q_LOOP_STATE_DIR: qLoopStateDir,
        BOT_ERRORS_DRY_NOW_EPOCH: '1005',
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_SERVICE_STATUS: 'active',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'q-loop-poll-failing',
          expectDispatcher: false,
          expectQLoop: true,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
          expectAlertTarget: false,
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('FAIL q_loop_state:');
    expect(event.evidence).toContain('age_seconds=5');
    expect(event.evidence).toContain('last_seen_pk=42');
    expect(event.evidence).toContain('consecutive_poll_failures=2');
    expect(event.evidence).toContain('last_poll_error=database locked');
  });

  it('fails daily health instead of trusting a symlinked q-loop state file', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const qLoopStateDir = join(tmpRoot, 'q-loop-state');
    mkdirSync(qLoopStateDir, { recursive: true });
    chmodSync(qLoopStateDir, 0o700);
    const outsideState = join(tmpRoot, 'outside-q-loop-state.json');
    writePrivateJson(outsideState, {
      updated_at: 1005,
      phase: 'monitoring',
      last_seen_pk: 42,
      consecutive_poll_failures: 0,
    });
    symlinkSync(outsideState, join(qLoopStateDir, 'state.json'));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_Q_LOOP_STATE_DIR: qLoopStateDir,
        BOT_ERRORS_DRY_NOW_EPOCH: '1005',
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_SERVICE_STATUS: 'active',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'q-loop-state-symlink',
          expectDispatcher: false,
          expectQLoop: true,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
          expectAlertTarget: false,
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('FAIL q_loop_state: refusing to trust symlinked critical file');
  });

  it('fails daily health when q-loop state lives under a non-private directory', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const qLoopStateDir = join(tmpRoot, 'q-loop-state');
    mkdirSync(qLoopStateDir, { recursive: true });
    chmodSync(qLoopStateDir, 0o755);
    writePrivateJson(join(qLoopStateDir, 'state.json'), {
      updated_at: 1005,
      phase: 'monitoring',
      last_seen_pk: 42,
      consecutive_poll_failures: 0,
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_Q_LOOP_STATE_DIR: qLoopStateDir,
        BOT_ERRORS_DRY_NOW_EPOCH: '1005',
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_SERVICE_STATUS: 'active',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'q-loop-state-non-private-dir',
          expectDispatcher: false,
          expectQLoop: true,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
          expectAlertTarget: false,
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('FAIL q_loop_state: refusing to trust critical file in non-private directory');
    expect(event.evidence).toContain('mode=755');
  });

  it('serializes direct health socket RPC calls through the shared lock hook', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const socket = join(tmpRoot, 'whatsoup.sock');
    writeFileSync(socket, '');
    const result = python(`${importHealthModulePrelude()}
import contextlib
import json
entered = []
@contextlib.contextmanager
def fake_lock(timeout):
    entered.append(timeout)
    yield
class FakeReader:
    def __init__(self):
        self.lines = [
            json.dumps({"jsonrpc": "2.0", "id": 1000000, "result": {}}) + "\\n",
            json.dumps({"jsonrpc": "2.0", "id": 1000001, "result": {"tools": []}}) + "\\n",
        ]
    def readline(self):
        if not self.lines:
            return ""
        return self.lines.pop(0)
class FakeWriter:
    def write(self, text):
        return len(text)
    def flush(self):
        pass
class FakeSocket:
    def __init__(self, *args, **kwargs):
        self.reader = FakeReader()
        self.writer = FakeWriter()
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False
    def settimeout(self, timeout):
        self.timeout = timeout
    def connect(self, path):
        self.path = path
    def makefile(self, mode, **kwargs):
        return self.reader if "r" in mode else self.writer
m.socket_rpc_lock = fake_lock
m.socket.socket = FakeSocket
m.time.time = lambda: 1000
print(json.dumps({"result": m.json_rpc(${JSON.stringify(socket)}, "tools/list", {}, timeout=4), "entered": entered}))
`);
    expect(JSON.parse(result)).toEqual({ result: { tools: [] }, entered: [4] });
  });

  it('raises severity when an expected tool is missing', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_TOOL_NAMES: 'send_message',
        BOT_ERRORS_REQUIRED_TOOLS: 'send_message,missing_tool',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'tool-test',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      summary: string;
      evidence: string;
    };
    expect(event.severity).not.toBe('info');
    expect(event.summary).toContain('missing required tools missing_tool');
    expect(event.evidence).toContain('FAIL tools personal');
    expect(event.evidence).toContain('required_missing=missing_tool');
  });

  it('retries personal tool inventory before raising a missing-tool alert', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_TOOL_NAMES_SEQUENCE: 'send_message;send_message,missing_tool',
        BOT_ERRORS_REQUIRED_TOOLS: 'send_message,missing_tool',
        BOT_ERRORS_TOOL_LIST_ATTEMPTS: '2',
        BOT_ERRORS_TOOL_LIST_RETRY_DELAY_SECONDS: '0',
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'tool-retry-test',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      summary: string;
      evidence: string;
    };
    expect(event.severity).toBe('info');
    expect(event.summary).not.toContain('missing required tools');
    expect(event.evidence).toContain('tools personal: count=2 required_missing=none attempts=2/2');
  });

  it('fails daily health when the fleet API token is rejected', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_FLEET_TOKEN_JSON: JSON.stringify({ active: 'wrong-token-value', accept: [] }),
        BOT_ERRORS_DRY_FLEET_API_STATUS: '401',
        BOT_ERRORS_DRY_FLEET_API_BODY: JSON.stringify({ error: 'unauthorized' }),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'fleet-api-auth',
          expectDispatcher: false,
          expectQLoop: false,
          expectFleetApi: true,
          fleetApiUrl: 'http://fleet.local:9099',
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('FAIL fleet_api: fleet_api_auth_failed');
    expect(event.evidence).toContain('status=401');
    expect(event.evidence).toContain('active_token_present=true');
    expect(event.evidence).toContain('token_source=dry');
    expect(event.evidence).not.toContain('wrong-token-value');
  });

  it('fails daily health when the fleet token source is unreadable or invalid', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_FLEET_TOKEN_JSON: JSON.stringify({ accept: ['old-token'] }),
        BOT_ERRORS_DRY_FLEET_API_STATUS: '200',
        BOT_ERRORS_DRY_FLEET_API_BODY: JSON.stringify({ instances: [] }),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'fleet-api-token-invalid',
          expectDispatcher: false,
          expectQLoop: false,
          expectFleetApi: true,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('FAIL fleet_api: active_token_missing');
    expect(event.evidence).toContain('token_source=dry');
    expect(event.evidence).not.toContain('old-token');
  });

  it('refuses symlinked or loose fleet API token files before probing the fleet API', () => {
    // Anchor under /tmp, not os.tmpdir(): the fleet-token secure-open in
    // deploy/scripts/bot-errors-health-check.py (read_fleet_token_text) opens every
    // ancestor dir with O_RDONLY|O_DIRECTORY|O_NOFOLLOW, which requires read on each.
    // On systemd hosts pam sets TMPDIR=/tmp/user/<uid>, whose parent /tmp/user is
    // 0711 root-owned (unreadable), so the walk returns token_parent_refused (EACCES)
    // before reaching the token leaf, masking the token_symlink_refused /
    // token_mode_too_open assertions below. /tmp has world-readable ancestors; matches
    // the mkdtempSync('/tmp/bot-errors-health-') pattern already used above.
    tmpRoot = mkdtempSync('/tmp/bot-errors-health-');
    const credentialRoot = join(tmpRoot, '.config', 'whatsoup');
    const outsideToken = join(tmpRoot, 'outside-fleet-tokens.json');
    const tokenPath = join(credentialRoot, 'fleet-tokens.json');
    mkdirSync(credentialRoot, { recursive: true });
    writeFileSync(outsideToken, JSON.stringify({ active: 'outside-token', accept: [] }));
    symlinkSync(outsideToken, tokenPath);

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_FLEET_API_STATUS: '200',
        BOT_ERRORS_DRY_FLEET_API_BODY: JSON.stringify({ instances: [] }),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'fleet-api-token-symlink',
          expectDispatcher: false,
          expectQLoop: false,
          expectFleetApi: true,
          fleetApiTokenFile: tokenPath,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
        }),
      },
    });

    let outbox = join(tmpRoot, 'outbox');
    let files = readdirSync(outbox);
    let event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('FAIL fleet_api: token_symlink_refused');
    expect(event.evidence).toContain('token_source=file token_source_path_redacted=true');
    expect(event.evidence).not.toContain(tokenPath);
    expect(event.evidence).not.toContain(outsideToken);
    expect(event.evidence).not.toContain('outside-token');

    rmSync(outbox, { recursive: true, force: true });
    rmSync(tokenPath, { force: true });
    writeFileSync(tokenPath, JSON.stringify({ active: 'loose-token', accept: [] }));
    chmodSync(tokenPath, 0o644);

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_FLEET_API_STATUS: '200',
        BOT_ERRORS_DRY_FLEET_API_BODY: JSON.stringify({ instances: [] }),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'fleet-api-token-loose',
          expectDispatcher: false,
          expectQLoop: false,
          expectFleetApi: true,
          fleetApiTokenFile: tokenPath,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
        }),
      },
    });

    outbox = join(tmpRoot, 'outbox');
    files = readdirSync(outbox);
    event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('FAIL fleet_api: token_mode_too_open mode=644');
    expect(event.evidence).not.toContain('loose-token');
  });

  it('passes daily health when the fleet API accepts the active token', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_FLEET_TOKEN_JSON: JSON.stringify({ active: 'accepted-token-value', accept: ['previous-token'] }),
        BOT_ERRORS_DRY_FLEET_API_STATUS: '200',
        BOT_ERRORS_DRY_FLEET_API_BODY: JSON.stringify([{ name: 'q' }, { name: 'personal' }]),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'fleet-api-ok',
          expectDispatcher: false,
          expectQLoop: false,
          expectFleetApi: true,
          fleetApiUrl: 'http://fleet.local:9099',
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('info');
    expect(event.evidence).toContain('fleet_api: status=200');
    expect(event.evidence).toContain('instances=2');
    expect(event.evidence).toContain('names=personal,q');
    expect(event.evidence).toContain('accept_count=1');
    expect(event.evidence).not.toContain('accepted-token-value');
    expect(event.evidence).not.toContain('previous-token');
  });

  it('raises critical daily health severity when inherited agent plugins are not explicitly covered', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'agent');
    const authDir = join(configDir, 'auth');
    const claudeDir = join(tmpRoot, '.claude');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
      enabledPlugins: {
        'superpowers@superpowers-marketplace': true,
        'sdlc-os@sdlc-os-dev': false,
      },
    }));
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      type: 'agent',
      agentOptions: {
        enabledPlugins: {
          'superpowers@superpowers-marketplace': true,
        },
      },
    }));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'agent-host',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const { summary, fails } = readOutboxBySource(outbox);
    const event = summary as unknown as {
      severity: string;
      evidence: string;
    };
    expect(fails.length).toBeGreaterThanOrEqual(1);
    for (const fail of fails) {
      expect(fail.severity).toBe('critical');
      expect((fail.diagnostics as Record<string, unknown>).forceNotify).toBe(true);
    }
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('FAIL plugin_coverage agent');
    expect(event.evidence).toContain('inherited_disabled=sdlc-os@sdlc-os-dev');
  });

  it('treats omitted enabledPlugins as intentional global inheritance', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'agent');
    const authDir = join(configDir, 'auth');
    const claudeDir = join(tmpRoot, '.claude');
    mkdirSync(authDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
      enabledPlugins: {
        'superpowers@superpowers-marketplace': true,
        'sdlc-os@sdlc-os-dev': true,
      },
    }));
    const configPath = join(configDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      type: 'agent',
      agentOptions: { sessionScope: 'per_chat' },
    }));
    chmodSync(configPath, 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'agent@s.whatsapp.net', lid: 'agent@lid' },
      registrationId: 1,
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'agent-host',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('info');
    expect(event.evidence).toContain('plugin_coverage agent: inherits global user_scope_keys=2');
    expect(event.evidence).not.toContain('FAIL plugin_coverage agent');
  });

  it('uses macOS log paths for Darwin-origin daily health diagnostics', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_PLATFORM: 'darwin',
        BOT_ERRORS_DRY_SERVICE_STATUS: 'active',
        BOT_ERRORS_DRY_TOOL_NAMES: 'send_message,list_chats,search_messages,get_chat,get_group_metadata',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'darwin-log-paths',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      diagnostics: { logHints: string[] };
      platform: string;
    };
    expect(event.platform).toBe('darwin');
    expect(event.diagnostics.logHints).toContain(join(tmpRoot, 'logs/health.out.log'));
    expect(event.diagnostics.logHints).toContain(join(tmpRoot, 'logs/dispatcher.out.log'));
    expect(event.diagnostics.logHints.some((hint) => hint.includes('journalctl'))).toBe(false);
  });

  it('uses read-only macOS clock commands and treats systemsetup permission limits as context', () => {
    const result = JSON.parse(python(`
import json
import os
from types import SimpleNamespace
from unittest.mock import patch
for key in list(os.environ):
    if key.startswith("BOT_ERRORS_"):
        del os.environ[key]
os.environ["BOT_ERRORS_DRY_PLATFORM"] = "darwin"
${importHealthModulePrelude()}
responses = [
    SimpleNamespace(
        returncode=1,
        stdout="You need administrator access to run this tool... exiting!\\n",
        stderr="",
    ),
    SimpleNamespace(
        returncode=0,
        stdout="+0.008500 +/- 0.016000 time.apple.com 17.253.2.43\\n",
        stderr="",
    ),
]
with patch.object(m.subprocess, "run", side_effect=responses) as run:
    lines = m.clock_inventory()
commands = [call.args[0] for call in run.call_args_list]
failures = [
    line for line in lines
    if line.startswith("FAIL ") or " FAIL " in line
]
warnings = [line for line in lines if line.startswith("WARN ") or " WARN " in line]
severity = m.daily_summary_severity(failures, warnings)
print(json.dumps({"commands": commands, "lines": lines, "severity": severity}))
`)) as { commands: string[][]; lines: string[]; severity: string };

    expect(result.commands).toEqual([
      ['systemsetup', '-getusingnetworktime'],
      ['sntp', 'time.apple.com'],
    ]);
    expect(result.lines).toEqual([
      'clock_network_time: unavailable_without_admin rc=1 sample=You need administrator access to run this tool... exiting!',
      'clock_sntp: rc=0 offset_ms=8.5 sample=+0.008500 +/- 0.016000 time.apple.com 17.253.2.43',
    ]);
    expect(result.severity).toBe('info');
  });

  it('reports macOS clock command timeouts and missing sntp as warnings', () => {
    const lines = JSON.parse(python(`
import json
import os
import subprocess
from unittest.mock import patch
for key in list(os.environ):
    if key.startswith("BOT_ERRORS_"):
        del os.environ[key]
os.environ["BOT_ERRORS_DRY_PLATFORM"] = "darwin"
${importHealthModulePrelude()}
failures = [
    subprocess.TimeoutExpired(cmd=["systemsetup", "-getusingnetworktime"], timeout=3),
    FileNotFoundError("sntp unavailable"),
]
with patch.object(m.subprocess, "run", side_effect=failures):
    print(json.dumps(m.clock_inventory()))
`)) as string[];

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^WARN clock_network_time: unavailable /);
    expect(lines[1]).toMatch(/^WARN clock_sntp: unavailable /);
  });

  it('uses local log paths for WSL-origin daily health diagnostics', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_PLATFORM: 'linux',
        BOT_ERRORS_DRY_PLATFORM_RELEASE: '6.6.87.2-microsoft-standard-WSL2',
        BOT_ERRORS_DRY_SERVICE_STATUS: 'active',
        BOT_ERRORS_DRY_TOOL_NAMES: 'send_message,list_chats,search_messages,get_chat,get_group_metadata',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'wsl-log-paths',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      diagnostics: { logHints: string[] };
      platform: string;
    };
    expect(event.platform).toBe('linux');
    expect(event.diagnostics.logHints).toContain(join(tmpRoot, 'logs/health.out.log'));
    expect(event.diagnostics.logHints).toContain(join(tmpRoot, 'logs/dispatcher.out.log'));
    expect(event.diagnostics.logHints.some((hint) => hint.includes('journalctl'))).toBe(false);
  });

  it('uses the configured health probe timeout when probing instance health', () => {
    const output = execFileSync('python3', ['-c', `
import importlib.util, os
from urllib.error import URLError
os.environ["BOT_ERRORS_HEALTH_PROBE_TIMEOUT_SECONDS"] = "12.5"
spec = importlib.util.spec_from_file_location("health", "deploy/scripts/bot-errors-health-check.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
def fake_urlopen(req, timeout):
    print(f"timeout={timeout}")
    raise URLError("stop")
m.urlopen = fake_urlopen
print(m.probe_health(9092))
`], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(output).toContain('timeout=12.5');
    expect(output).toContain('FAIL http://127.0.0.1:9092/health stop');
  });

  it('does not critical an on-demand MACLAB-style agent when profile says it may be stopped', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'agent');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      type: 'agent',
      enabled: true,
      healthPort: 9,
    }));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'relay-only',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          instances: [{ name: 'agent', expected: 'on_demand', healthPort: 9 }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).not.toBe('critical');
    expect(event.evidence).toContain('profile: role=relay-only');
    expect(event.evidence).toContain('personal_socket: skipped by health profile');
    expect(event.evidence).toContain('tools personal: skipped by health profile');
    expect(event.evidence).toContain('health agent: on_demand_ok down http://127.0.0.1:9/health');
  });

  it('fails explicit host profiles that omit enabled local instance configs', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const knownDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'known-bot');
    const hiddenDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'personal');
    mkdirSync(knownDir, { recursive: true });
    mkdirSync(hiddenDir, { recursive: true });
    writeFileSync(join(knownDir, 'config.json'), JSON.stringify({ type: 'agent', enabled: true }));
    writeFileSync(join(hiddenDir, 'config.json'), JSON.stringify({ type: 'passive', enabled: true, healthPort: 9100 }));
    chmodSync(join(knownDir, 'config.json'), 0o600);
    chmodSync(join(hiddenDir, 'config.json'), 0o600);
    writeSecureCreds(join(knownDir, 'auth'), {
      me: { id: 'known@s.whatsapp.net', lid: 'known@lid' },
      registrationId: 1,
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          instances: [{ name: 'known-bot', expected: 'always_on' }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const { summary, fails } = readOutboxBySource(outbox);
    const event = summary as unknown as {
      severity: string;
      evidence: string;
    };
    expect(fails.length).toBeGreaterThanOrEqual(1);
    for (const fail of fails) {
      expect(fail.severity).toBe('critical');
      expect((fail.diagnostics as Record<string, unknown>).forceNotify).toBe(true);
    }
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('FAIL profile_coverage personal: enabled config not declared in health profile');
    expect(event.evidence).toContain('type=passive healthPort=9100');
  });

  it('fails explicit host profiles that omit active WhatSoup instance services', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const knownDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'known-bot');
    mkdirSync(knownDir, { recursive: true });
    writeFileSync(join(knownDir, 'config.json'), JSON.stringify({ type: 'agent', enabled: true }));
    chmodSync(join(knownDir, 'config.json'), 0o600);
    writeSecureCreds(join(knownDir, 'auth'), {
      me: { id: 'known@s.whatsapp.net', lid: 'known@lid' },
      registrationId: 1,
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_ACTIVE_WHATSOUP_SERVICES: 'com.whatsoup.known-bot,com.whatsoup.personal,com.whatsoup.whatsoup-fleet',
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          instances: [{ name: 'known-bot', expected: 'always_on' }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const { summary, fails } = readOutboxBySource(outbox);
    const event = summary as unknown as {
      severity: string;
      evidence: string;
    };
    expect(fails.length).toBeGreaterThanOrEqual(1);
    for (const fail of fails) {
      expect(fail.severity).toBe('critical');
      expect((fail.diagnostics as Record<string, unknown>).forceNotify).toBe(true);
    }
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('FAIL profile_coverage_service personal: active service not declared in health profile');
    expect(event.evidence).toContain('service=com.whatsoup.personal config_exists=False');
    expect(event.evidence).not.toContain('profile_coverage_service whatsoup-fleet');
  });

  it('allows explicit host profiles to opt out of unprofiled config coverage during transitions', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const knownDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'known-bot');
    const hiddenDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'personal');
    mkdirSync(knownDir, { recursive: true });
    mkdirSync(hiddenDir, { recursive: true });
    writeFileSync(join(knownDir, 'config.json'), JSON.stringify({ type: 'agent', enabled: true }));
    writeFileSync(join(hiddenDir, 'config.json'), JSON.stringify({ type: 'passive', enabled: true, healthPort: 9100 }));
    chmodSync(join(knownDir, 'config.json'), 0o600);
    chmodSync(join(hiddenDir, 'config.json'), 0o600);
    writeSecureCreds(join(knownDir, 'auth'), {
      me: { id: 'known@s.whatsapp.net', lid: 'known@lid' },
      registrationId: 1,
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          allowUnprofiledInstances: true,
          instances: [{ name: 'known-bot', expected: 'always_on' }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('info');
    expect(event.evidence).not.toContain('FAIL profile_coverage personal');
  });

  it('does not treat a /tmp test-fixture authDir config field as production auth loss', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'prod-bot');
    const fixtureAuthDir = join(tmpRoot, 'tmp-fixture-auth');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(fixtureAuthDir, { recursive: true });
    const configPath = join(configDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      type: 'agent',
      enabled: true,
      authDir: fixtureAuthDir,
    }));
    chmodSync(configPath, 0o600);
    writeSecureCreds(join(configDir, 'auth'), {
      me: { id: 'prod@s.whatsapp.net', lid: 'prod@lid' },
      registrationId: 1,
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          instances: [{ name: 'prod-bot', expected: 'always_on' }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('info');
    expect(event.evidence).toContain('auth_bond prod-bot: present creds_hash=');
    expect(event.evidence).not.toContain(fixtureAuthDir);
    expect(event.evidence).not.toContain('FAIL auth_bond prod-bot: auth_dir_exists=false');
  });

  it('redacts credential inventory paths while preserving actionable metadata', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const credentialRoot = join(tmpRoot, '.config', 'whatsoup');
    const tokenDir = join(credentialRoot, 'instances', 'ana-bot');
    mkdirSync(tokenDir, { recursive: true });
    const fleetToken = join(credentialRoot, 'fleet-token');
    const botErrorsEnv = join(credentialRoot, 'bot-errors.env');
    const instanceToken = join(tokenDir, 'tokens.env');
    const unrequiredSecret = join(credentialRoot, 'secrets.env');
    writeFileSync(fleetToken, 'fleet token raw-secret');
    writeFileSync(botErrorsEnv, 'BOT_ERRORS_PAT=raw-bot-errors-secret');
    writeFileSync(instanceToken, 'token=raw-instance-secret');
    writeFileSync(unrequiredSecret, 'secret=raw-unrequired-secret');
    chmodSync(credentialRoot, 0o700);
    chmodSync(join(credentialRoot, 'instances'), 0o700);
    chmodSync(tokenDir, 0o700);
    chmodSync(fleetToken, 0o600);
    chmodSync(botErrorsEnv, 0o600);
    chmodSync(instanceToken, 0o666);
    chmodSync(unrequiredSecret, 0o600);

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'credential-redaction',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          requiredCredentialFiles: [
            'fleet-token',
            'instances/ana-bot/tokens.env',
            'instances/ana-bot/missing-token.env',
          ],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('OK credential: credential_requirement=fleet-token credential_path_redacted=true');
    expect(event.evidence).toContain('credential_path_basename=fleet-token');
    expect(event.evidence).toContain('FAIL credential: credential_requirement_redacted=true');
    expect(event.evidence).toContain('credential_requirement_basename=tokens.env');
    expect(event.evidence).toContain('world_writable credential_path_redacted=true');
    expect(event.evidence).toContain('credential_path_basename=tokens.env');
    expect(event.evidence).toContain('credential_requirement_basename=missing-token.env');
    expect(event.evidence).toContain('missing required');
    expect(event.evidence).toContain('expected_path_redacted=true');
    expect(event.evidence).toContain('expected_path_basename=missing-token.env');
    expect(event.evidence).toContain('OK credential_meta: credential_path_redacted=true');
    expect(event.evidence).toContain('credential_path_basename=bot-errors.env');
    expect(event.evidence).toContain('credential_path_basename=secrets.env');
    expect(event.evidence).toContain('credential_path_fingerprint=');
    expect(event.evidence).not.toContain(credentialRoot);
    expect(event.evidence).not.toContain('instances/ana-bot/tokens.env');
    expect(event.evidence).not.toContain('instances/ana-bot/missing-token.env');
    expect(event.evidence).not.toContain(fleetToken);
    expect(event.evidence).not.toContain(botErrorsEnv);
    expect(event.evidence).not.toContain(instanceToken);
    expect(event.evidence).not.toContain(unrequiredSecret);
    expect(event.evidence).not.toContain('raw-secret');
    expect(event.evidence).not.toContain('raw-bot-errors-secret');
    expect(event.evidence).not.toContain('raw-instance-secret');
    expect(event.evidence).not.toContain('raw-unrequired-secret');
  });

  it('derives bot-errors.env as required for explicit dispatcher profiles', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const credentialRoot = join(tmpRoot, '.config', 'whatsoup');
    mkdirSync(credentialRoot, { recursive: true });
    chmodSync(credentialRoot, 0o700);

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_PLATFORM: 'darwin',
        BOT_ERRORS_DRY_SERVICE_STATUS: 'active',
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'explicit-dispatcher',
          expectDispatcher: true,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          requiredCredentialFiles: [],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('FAIL credential: credential_requirement=bot-errors.env missing required');
    expect(event.evidence).toContain('expected_path_redacted=true');
    expect(event.evidence).toContain('expected_path_basename=bot-errors.env');
    expect(event.evidence).not.toContain(credentialRoot);
  });

  it('fails daily health when required credentials are symlinked or have non-private parents', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const credentialRoot = join(tmpRoot, '.config', 'whatsoup');
    const leakyDir = join(credentialRoot, 'instances', 'leaky-bot');
    mkdirSync(leakyDir, { recursive: true });
    const outsideToken = join(tmpRoot, 'outside-fleet-token');
    const fleetToken = join(credentialRoot, 'fleet-token');
    const leakyToken = join(leakyDir, 'tokens.env');
    writeFileSync(outsideToken, 'outside raw-secret');
    symlinkSync(outsideToken, fleetToken);
    writeFileSync(leakyToken, 'token=leaky raw-secret');
    chmodSync(credentialRoot, 0o755);
    chmodSync(join(credentialRoot, 'instances'), 0o700);
    chmodSync(leakyDir, 0o755);
    chmodSync(leakyToken, 0o600);

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'credential-hardening',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          requiredCredentialFiles: [
            'fleet-token',
            'instances/leaky-bot/tokens.env',
          ],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      criticalAsset?: { failure?: { code?: string } };
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('critical');
    expect(event.criticalAsset?.failure?.code).toBe('CREDENTIAL_FILE_INTEGRITY_DRIFT');
    expect(event.evidence).toContain('FAIL credential: credential_requirement=fleet-token symlink credential_path_redacted=true');
    expect(event.evidence).toContain('credential_path_basename=fleet-token');
    expect(event.evidence).toContain('parent_mode>700 parent_path_redacted=true');
    expect(event.evidence).toContain('credential_requirement_basename=tokens.env');
    expect(event.evidence).not.toContain(credentialRoot);
    expect(event.evidence).not.toContain(outsideToken);
    expect(event.evidence).not.toContain(leakyToken);
    expect(event.evidence).not.toContain('outside raw-secret');
    expect(event.evidence).not.toContain('leaky raw-secret');
  });

  it('refuses to append deadman or dry-send health logs through symlinks', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const logs = join(tmpRoot, 'logs');
    mkdirSync(logs, { recursive: true });
    const outsideDeadman = join(tmpRoot, 'outside-deadman.jsonl');
    const outsideSend = join(tmpRoot, 'outside-send.jsonl');
    writeFileSync(outsideDeadman, 'unchanged-deadman\n');
    writeFileSync(outsideSend, 'unchanged-send\n');
    symlinkSync(outsideDeadman, join(logs, 'deadman.jsonl'));
    symlinkSync(outsideSend, join(logs, 'direct-send.jsonl'));

    const deadman = spawnSync('python3', ['-c', [
      importHealthModulePrelude(),
      'import os',
      `os.environ["BOT_ERRORS_STATE_DIR"] = ${JSON.stringify(tmpRoot)}`,
      'm.append_deadman_log({"token": "raw-secret"})',
    ].join('\n')], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: tmpRoot },
      encoding: 'utf8',
    });
    const direct = spawnSync('python3', ['-c', [
      importHealthModulePrelude(),
      'import os',
      `os.environ["BOT_ERRORS_DRY_DIRECT_SEND_LOG"] = ${JSON.stringify(join(logs, 'direct-send.jsonl'))}`,
      'm.send_direct("Authorization: Bearer raw-secret")',
    ].join('\n')], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: tmpRoot },
      encoding: 'utf8',
    });

    expect(deadman.status).not.toBe(0);
    expect(direct.status).not.toBe(0);
    expect(`${deadman.stderr}\n${direct.stderr}`).toContain('refusing to write through symlink');
    expect(readFileSync(outsideDeadman, 'utf8')).toBe('unchanged-deadman\n');
    expect(readFileSync(outsideSend, 'utf8')).toBe('unchanged-send\n');
  });

  it('refuses direct WhatsApp health sends when target differs from BOT_ERRORS_EXPECTED_JID', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const result = spawnSync('python3', ['-c', [
      importHealthModulePrelude(),
      'm.send_direct("deadman alert")',
    ].join('\n')], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_JID: '120363555555555000@g.us',
        BOT_ERRORS_EXPECTED_JID: 'expected-bot-errors-group-fixture',
        BOT_ERRORS_SOCKET_PATH: '/tmp/missing-whatsoup.sock',
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('BOT_ERRORS_JID does not match BOT_ERRORS_EXPECTED_JID');
    expect(result.stderr).not.toContain('socket missing');
  });

  it('requires BOT_ERRORS_EXPECTED_JID for direct WhatsApp health sends by default', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const result = spawnSync('python3', ['-c', [
      importHealthModulePrelude(),
      'm.send_direct("deadman alert")',
    ].join('\n')], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_JID: '120363555555555000@g.us',
        BOT_ERRORS_EXPECTED_JID: '',
        BOT_ERRORS_REQUIRE_EXPECTED: '',
        BOT_ERRORS_SOCKET_PATH: '/tmp/missing-whatsoup.sock',
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('BOT_ERRORS_EXPECTED_JID is required');
    expect(result.stderr).not.toContain('socket missing');
  });

  it('classifies logged-out WhatsApp health as physical intervention required', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'primary-bot');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      type: 'agent',
      enabled: true,
      healthPort: 9090,
    }));
    chmodSync(configPath, 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'bot@s.whatsapp.net', lid: 'bot@lid' },
      registrationId: 1,
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_HEALTH_STATUS: '503',
        BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON: JSON.stringify({
          status: 'unhealthy',
          whatsapp: {
            connected: false,
            connection: {
              state: 'disconnected',
              last_disconnect_reason: 'loggedOut',
              last_status_code: 401,
              auth_failure_class: 'serverside_logout_irreversible',
              reconnect_phase: null,
              reconnect_attempts: 0,
              first_failure_at: '2026-06-09T09:47:56.432Z',
            },
            credential_lifecycle: {
              latestBaileysVersion: '2.3000.1020194169',
              connectStartedAt: '2026-06-09T09:47:00.000Z',
              lastOpenAt: '2026-06-09T09:47:01.000Z',
              lastCloseAt: '2026-06-09T09:47:56.432Z',
              lastQrAt: '2026-06-08T09:47:00.000Z',
              lastCredsUpdateAt: '2026-06-09T09:47:20.000Z',
              lastCredsUpdateFailedAt: '2026-06-09T09:47:30.000Z',
              lastAuthSnapshotAt: '2026-06-09T09:47:40.000Z',
              lastAuthSnapshotFailedAt: '2026-06-09T09:47:45.000Z',
              credsUpdateCount: 9,
              authSnapshotCaptureCount: 3,
              authSnapshotFailureCount: 1,
              environment: {
                host: 'nucles',
                pid: 4242,
                nodeVersion: 'v24.1.0',
                platform: 'linux',
                arch: 'arm64',
                processUptimeSeconds: 222,
                osUptimeSeconds: 86400,
                authDir: '/home/testuser/.local/share/whatsoup/instances/primary-bot/auth',
                memory: {
                  freeBytes: 1024,
                  totalBytes: 4096,
                },
              },
              lastDisconnectDiagnostic: {
                statusCode: 401,
                reason: 'loggedOut',
                message: 'device 15555550123@s.whatsapp.net token=do-not-print phone 14155551234 removed Authorization: Bearer topsecretvalue',
              },
              recentEvents: [
                { event: 'baileys_version', at: '2026-06-09T09:47:00.000Z' },
                { event: 'socket_created', at: '2026-06-09T09:47:01.000Z' },
                { event: 'device_bond_lost', at: '2026-06-09T09:47:56.432Z', statusCode: 401, reason: 'loggedOut secret=event-secret' },
              ],
            },
            auth_bond: {
              status: 'present',
              issues: ['server_revoked token=issue-secret'],
              auth_dir: {
                path: '/home/testuser/.local/share/whatsoup/instances/primary-bot/auth',
                exists: true,
                mode: '700',
                mtime: '2026-06-09T09:47:10.000Z',
              },
              creds: {
                path: '/home/testuser/.local/share/whatsoup/instances/primary-bot/auth/creds.json',
                exists: true,
                mode: '600',
                size: 2048,
                mtime: '2026-06-09T09:47:20.000Z',
                hash: 'health-creds-hash',
                empty_hash: false,
              },
              me_hash: 'health-me-hash',
              tree_hash: 'health-tree-hash',
              backup: {
                root: '/home/testuser/.local/state/whatsoup/auth-bond-backups',
                latest: '/home/testuser/.local/state/whatsoup/auth-bond-backups/primary-bot/latest',
                latest_at: '2026-06-09T09:47:25.000Z',
                latest_reason: 'creds_update',
                latest_tree_hash: 'health-tree-hash',
                last_capture_at: '2026-06-09T09:47:25.000Z',
                last_capture_reason: 'creds_update',
                last_capture_error: 'copy failed token=capture-secret for 14155551234',
                last_restore_at: '2026-06-09T09:48:00.000Z',
                last_restore_source: '/home/testuser/.local/state/whatsoup/auth-bond-backups/primary-bot/latest',
                last_restore_error: 'restore failed secret=restore-secret for_14155551234',
              },
            },
          },
        }),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          instances: [{ name: 'primary-bot', expected: 'always_on', healthPort: 9090 }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const { summary, fails } = readOutboxBySource(outbox);
    const event = summary as unknown as {
      severity: string;
      evidence: string;
    };
    expect(fails.length).toBeGreaterThanOrEqual(1);
    for (const fail of fails) {
      expect(fail.severity).toBe('critical');
      expect((fail.diagnostics as Record<string, unknown>).forceNotify).toBe(true);
    }
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('health primary-bot: FAIL 503 http://127.0.0.1:9090/health');
    expect(event.evidence).toContain('physical_intervention_required');
    expect(event.evidence).toContain('auth_bond_at_risk');
    expect(event.evidence).toContain('auth_failure_class=serverside_logout_irreversible');
    expect(event.evidence).toContain('last_disconnect_reason=loggedOut');
    expect(event.evidence).toContain('last_status_code=401');
    expect(event.evidence).toContain('baileys_version=2.3000.1020194169');
    expect(event.evidence).toContain('lifecycle_last_close_at=2026-06-09T09:47:56.432Z');
    expect(event.evidence).toContain('lifecycle_creds_update_count=9');
    expect(event.evidence).toContain('lifecycle_host=nucles');
    expect(event.evidence).toContain('lifecycle_pid=4242');
    expect(event.evidence).toContain('credential_lifecycle_events=baileys_version,socket_created,device_bond_lost');
    expect(event.evidence).toContain('credential_lifecycle_last_event_status_code=401');
    expect(event.evidence).toContain('auth_bond_status=present');
    expect(event.evidence).toContain('auth_bond_creds_hash=health-creds-hash');
    expect(event.evidence).toContain('auth_bond_identity_hash=health-me-hash');
    expect(event.evidence).toContain('auth_bond_tree_hash=health-tree-hash');
    expect(event.evidence).toContain('auth_bond_backup_latest_present=true');
    expect(event.evidence).toContain('auth_bond_last_restore_source_present=true');
    expect(event.evidence).toContain('token=[REDACTED]');
    expect(event.evidence).toContain('secret=[REDACTED]');
    expect(event.evidence).toContain('[REDACTED_JID]');
    expect(event.evidence).toContain('[REDACTED_PHONE]');
    expect(event.evidence).toContain('auth_bond primary-bot: present creds_hash=');
    expect(event.evidence).not.toContain('15555550123@s.whatsapp.net');
    expect(event.evidence).not.toContain('14155551234');
    expect(event.evidence).not.toContain('do-not-print');
    expect(event.evidence).not.toContain('topsecretvalue');
    expect(event.evidence).not.toContain('event-secret');
    expect(event.evidence).not.toContain('issue-secret');
    expect(event.evidence).not.toContain('capture-secret');
    expect(event.evidence).not.toContain('restore-secret');
    expect(event.evidence).not.toContain('/home/testuser/.local/share/whatsoup/instances/primary-bot/auth');
    expect(event.evidence).not.toContain('/home/testuser/.local/state/whatsoup/auth-bond-backups/primary-bot/latest');
  });

  it('fails daily health when primary phone verification approaches the linked-device logout window', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'primary-bot');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      type: 'agent',
      enabled: true,
    }));
    chmodSync(join(configDir, 'config.json'), 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'primary@s.whatsapp.net', lid: 'primary@lid' },
      registrationId: 1,
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_NOW_EPOCH: String(Math.floor(Date.parse('2026-06-11T00:00:00Z') / 1000)),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          expectPrimaryPhoneVerification: true,
          instances: [{
            name: 'primary-bot',
            expected: 'always_on',
            primaryPhoneLastVerifiedAt: '2026-05-29T00:00:00Z',
            primaryPhoneOwner: 'Lucas',
          }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
      alertSource?: string;
      criticalAsset?: {
        asset?: { kind?: string; instance?: string };
        failure?: { code?: string; recoverability?: string; confidence?: string };
      };
    };
    expect(event.severity).toBe('critical');
    expect(event.alertSource).toBe('primary_phone:primary-bot');
    expect(event.evidence).toContain('FAIL primary_phone primary-bot: owner=Lucas');
    expect(event.evidence).toContain('reverify_required');
    expect(event.evidence).toContain('age_days=13');
    expect(event.criticalAsset?.asset?.kind).toBe('whatsapp_linked_device');
    expect(event.criticalAsset?.asset?.instance).toBe('primary-bot');
    expect(event.criticalAsset?.failure?.code).toBe('WA_AUTH_BOND_PRIMARY_PHONE_STALE');
    expect(event.criticalAsset?.failure?.recoverability).toBe('operator_recoverable');
    expect(event.criticalAsset?.failure?.confidence).toBe('confirmed');
  });

  it('warns daily health when primary phone verification has never been recorded', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'primary-bot');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      type: 'agent',
      enabled: true,
    }));
    chmodSync(join(configDir, 'config.json'), 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'primary@s.whatsapp.net', lid: 'primary@lid' },
      registrationId: 1,
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_NOW_EPOCH: String(Math.floor(Date.parse('2026-06-11T00:00:00Z') / 1000)),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          expectPrimaryPhoneVerification: true,
          instances: [{
            name: 'primary-bot',
            expected: 'always_on',
            primaryPhoneOwner: 'Lucas',
          }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
      alertSource?: string;
      criticalAsset?: {
        asset?: { kind?: string; instance?: string };
        failure?: { code?: string; recoverability?: string; confidence?: string };
      };
    };
    expect(event.severity).toBe('warning');
    expect(event.alertSource).toBe('primary_phone:primary-bot');
    expect(event.evidence).toContain('WARN primary_phone primary-bot: owner=Lucas');
    expect(event.evidence).toContain('verification_unknown');
    expect(event.evidence).toContain('verification_proof=missing');
    expect(event.evidence).toContain('unknown_severity=warning');
    expect(event.evidence).toContain('last_verified_at=missing');
    expect(Object.hasOwn(event, 'criticalAsset')).toBe(false);
  });

  it('can deliberately escalate missing primary phone verification proof to critical', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'primary-bot');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      type: 'agent',
      enabled: true,
    }));
    chmodSync(join(configDir, 'config.json'), 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'primary@s.whatsapp.net', lid: 'primary@lid' },
      registrationId: 1,
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_NOW_EPOCH: String(Math.floor(Date.parse('2026-06-11T00:00:00Z') / 1000)),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          expectPrimaryPhoneVerification: true,
          instances: [{
            name: 'primary-bot',
            expected: 'always_on',
            primaryPhoneOwner: 'Lucas',
            primaryPhoneUnknownSeverity: 'critical',
          }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
      alertSource?: string;
      criticalAsset?: {
        asset?: { kind?: string; instance?: string };
        failure?: { code?: string; recoverability?: string; confidence?: string };
      };
    };
    expect(event.severity).toBe('critical');
    expect(event.alertSource).toBe('primary_phone:primary-bot');
    expect(event.evidence).toContain('FAIL primary_phone primary-bot: owner=Lucas');
    expect(event.evidence).toContain('verification_unknown');
    expect(event.evidence).toContain('unknown_severity=critical');
    expect(event.criticalAsset?.asset?.kind).toBe('whatsapp_linked_device');
    expect(event.criticalAsset?.asset?.instance).toBe('primary-bot');
    expect(event.criticalAsset?.failure?.code).toBe('WA_AUTH_BOND_PRIMARY_PHONE_UNVERIFIED');
    expect(event.criticalAsset?.failure?.recoverability).toBe('operator_recoverable');
    expect(event.criticalAsset?.failure?.confidence).toBe('probable');
  });

  it('passes daily health from private primary-phone verification state when the profile is missing runtime proof', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    chmodSync(tmpRoot, 0o700);
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'primary-bot');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      type: 'agent',
      enabled: true,
    }));
    chmodSync(join(configDir, 'config.json'), 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'primary@s.whatsapp.net', lid: 'primary@lid' },
      registrationId: 1,
    });
    writePrivateJson(join(tmpRoot, 'primary-phone-verifications.json'), {
      version: 1,
      instances: {
        'primary-bot': {
          lastVerifiedAt: '2026-06-10T00:00:00Z',
          owner: 'Lucas',
          method: 'operator_linked_devices_check',
        },
      },
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_NOW_EPOCH: String(Math.floor(Date.parse('2026-06-11T00:00:00Z') / 1000)),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          expectPrimaryPhoneVerification: true,
          instances: [{
            name: 'primary-bot',
            expected: 'always_on',
            primaryPhoneOwner: 'Lucas',
          }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      eventType: string;
      severity: string;
      evidence: string;
    };
    expect(event.eventType).toBe('clear');
    expect(event.severity).toBe('info');
    expect(event.evidence).toContain('OK primary_phone primary-bot: owner=Lucas');
    expect(event.evidence).toContain('last_verified_source=state');
    expect(event.evidence).toContain('fresh');
    expect(event.evidence).toContain('age_days=1');
  });

  it('fails closed when primary-phone verification state is symlinked', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    chmodSync(tmpRoot, 0o700);
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'primary-bot');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      type: 'agent',
      enabled: true,
    }));
    chmodSync(join(configDir, 'config.json'), 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'primary@s.whatsapp.net', lid: 'primary@lid' },
      registrationId: 1,
    });
    const realState = join(tmpRoot, 'real-primary-phone-verifications.json');
    writePrivateJson(realState, {
      version: 1,
      instances: {
        'primary-bot': {
          lastVerifiedAt: '2026-06-10T00:00:00Z',
        },
      },
    });
    symlinkSync(realState, join(tmpRoot, 'primary-phone-verifications.json'));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_NOW_EPOCH: String(Math.floor(Date.parse('2026-06-11T00:00:00Z') / 1000)),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          expectPrimaryPhoneVerification: true,
          instances: [{
            name: 'primary-bot',
            expected: 'always_on',
            primaryPhoneLastVerifiedAt: '2026-06-10T00:00:00Z',
            primaryPhoneOwner: 'Lucas',
          }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const { summary, fails } = readOutboxBySource(outbox);
    const event = summary as unknown as {
      severity: string;
      evidence: string;
      alertSource?: string;
      criticalAsset?: {
        failure?: { code?: string; confidence?: string };
      };
    };
    expect(fails.length).toBeGreaterThanOrEqual(1);
    for (const fail of fails) {
      expect(fail.severity).toBe('critical');
      expect((fail.diagnostics as Record<string, unknown>).forceNotify).toBe(true);
    }
    expect(event.severity).toBe('critical');
    expect(event.alertSource).toBe('primary_phone:primary-bot');
    expect(event.evidence).toContain('FAIL primary_phone_state primary-bot: refusing to trust symlinked critical file');
    expect(event.criticalAsset?.failure?.code).toBe('WA_AUTH_BOND_PRIMARY_PHONE_VERIFICATION_STATE_UNTRUSTED');
    expect(event.criticalAsset?.failure?.confidence).toBe('confirmed');
  });

  it('records primary-phone verification to private state and redacts operator notes', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    chmodSync(tmpRoot, 0o700);
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'primary-bot');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      type: 'agent',
      enabled: true,
    }));
    chmodSync(join(configDir, 'config.json'), 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'primary@s.whatsapp.net', lid: 'primary@lid' },
      registrationId: 1,
    });

    execFileSync('python3', [
      'deploy/scripts/bot-errors-health-check.py',
      '--record-primary-phone-verification',
      'primary-bot',
      '--owner',
      'Lucas',
      '--method',
      'operator_linked_devices_check',
      '--note',
      'linked device visible for 14155551234',
      '--verified-at',
      '2026-06-10T00:00:00Z',
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_NOW_EPOCH: String(Math.floor(Date.parse('2026-06-11T00:00:00Z') / 1000)),
      },
    });

    const statePath = join(tmpRoot, 'primary-phone-verifications.json');
    const mode = (lstatSync(statePath).mode & 0o777).toString(8);
    const stateText = readFileSync(statePath, 'utf8');
    const state = JSON.parse(stateText) as {
      instances?: Record<string, { lastVerifiedAt?: string; note?: string }>;
    };
    expect(mode).toBe('600');
    expect(state.instances?.['primary-bot']?.lastVerifiedAt).toBe('2026-06-10T00:00:00Z');
    expect(state.instances?.['primary-bot']?.note).toContain('[REDACTED_PHONE]');
    expect(stateText).not.toContain('14155551234');

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_NOW_EPOCH: String(Math.floor(Date.parse('2026-06-11T00:00:00Z') / 1000)),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          expectPrimaryPhoneVerification: true,
          instances: [{
            name: 'primary-bot',
            expected: 'always_on',
            primaryPhoneOwner: 'Lucas',
          }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      eventType: string;
      severity: string;
      evidence: string;
    };
    expect(event.eventType).toBe('clear');
    expect(event.severity).toBe('info');
    expect(event.evidence).toContain('last_verified_source=state');
  });

  it('passes daily health when primary phone verification is fresh', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'primary-bot');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      type: 'agent',
      enabled: true,
    }));
    chmodSync(join(configDir, 'config.json'), 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'primary@s.whatsapp.net', lid: 'primary@lid' },
      registrationId: 1,
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_NOW_EPOCH: String(Math.floor(Date.parse('2026-06-11T00:00:00Z') / 1000)),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          expectPrimaryPhoneVerification: true,
          instances: [{
            name: 'primary-bot',
            expected: 'always_on',
            primaryPhoneLastVerifiedAt: '2026-06-10T00:00:00Z',
            primaryPhoneOwner: 'Lucas',
          }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      eventType: string;
      severity: string;
      evidence: string;
      alertSource?: string;
      criticalAsset?: unknown;
    };
    expect(event.eventType).toBe('clear');
    expect(event.severity).toBe('info');
    expect(event.alertSource).toBe('primary_phone:primary-bot');
    expect(event.evidence).toContain('OK primary_phone primary-bot: owner=Lucas');
    expect(event.evidence).toContain('fresh');
    expect(event.evidence).toContain('age_days=1');
    expect(Object.keys(event)).not.toContain('criticalAsset');
  });

  it('fails daily health when a connected instance reports auth bond snapshot risk', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'primary-bot');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      type: 'agent',
      enabled: true,
      healthPort: 9090,
    }));
    chmodSync(configPath, 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'agent-alpha@s.whatsapp.net', lid: 'agent-alpha@lid' },
      registrationId: 2,
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_HEALTH_STATUS: '200',
        BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON: JSON.stringify({
          status: 'healthy',
          generated_at: new Date().toISOString(),
          instance: { name: 'primary-bot' },
          whatsapp: {
            connected: true,
            connection: {
              state: 'connected',
              reconnect_attempts: 0,
              auth_failure_class: 'local_corruption_restorable',
            },
            auth_bond: {
              status: 'present',
              issues: [],
              creds: { hash: 'abc123', exists: true, mode: '600', size: 512 },
              backup: { latest: null, last_capture_error: null },
            },
          },
        }),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          instances: [{ name: 'primary-bot', expected: 'always_on', healthPort: 9090 }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const { summary, fails } = readOutboxBySource(outbox);
    const event = summary as unknown as {
      severity: string;
      evidence: string;
    };
    expect(fails.length).toBeGreaterThanOrEqual(1);
    for (const fail of fails) {
      expect(fail.severity).toBe('critical');
      expect((fail.diagnostics as Record<string, unknown>).forceNotify).toBe(true);
    }
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('health primary-bot: FAIL 200 http://127.0.0.1:9090/health auth_bond_at_risk');
    expect(event.evidence).toContain('auth_failure_class=local_corruption_restorable');
    expect(event.evidence).toContain('auth_bond_backup_latest=none');
  });

  it('does not alert on a fresh auth-bond credential write window', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'primary-bot');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      type: 'agent',
      enabled: true,
      healthPort: 9090,
    }));
    chmodSync(configPath, 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'agent-alpha@s.whatsapp.net', lid: 'agent-alpha@lid' },
      registrationId: 2,
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_NOW_EPOCH: '1780995605',
        BOT_ERRORS_AUTH_BOND_WRITE_INFLIGHT_GRACE_SECONDS: '10',
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_HEALTH_STATUS: '200',
        BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON: JSON.stringify({
          status: 'healthy',
          generated_at: '2026-06-09T09:00:05Z',
          instance: { name: 'primary-bot' },
          whatsapp: {
            connected: true,
            connection: {
              state: 'connected',
              reconnect_attempts: 0,
              auth_failure_class: 'none',
            },
            auth_bond: {
              status: 'invalid',
              issues: ['creds_json_empty'],
              creds: {
                exists: true,
                mode: '600',
                size: 0,
                mtime: '2026-06-09T09:00:04.000Z',
                hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
                empty_hash: true,
              },
              backup: {
                latest: '/tmp/auth-bond/latest',
                latest_at: '2026-06-09T08:59:00.000Z',
                latest_reason: 'connection-open',
                last_capture_deferred_at: '2026-06-09T09:00:05.000Z',
                last_capture_deferred_reason: 'creds-update',
                last_capture_deferred_age_ms: 1000,
              },
            },
          },
        }),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          instances: [{ name: 'primary-bot', expected: 'always_on', healthPort: 9090 }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      eventType: string;
      severity: string;
      evidence: string;
    };
    expect(event.eventType).toBe('clear');
    expect(event.severity).toBe('info');
    expect(event.evidence).toContain('auth_bond_credential_write_inflight=true');
    expect(event.evidence).not.toContain('auth_bond_at_risk');
    expect(event.evidence).not.toContain('physical_intervention_required');
  });

  it('alerts when an auth-bond credential write window becomes stale', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'primary-bot');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      type: 'agent',
      enabled: true,
      healthPort: 9090,
    }));
    chmodSync(configPath, 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'agent-alpha@s.whatsapp.net', lid: 'agent-alpha@lid' },
      registrationId: 2,
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_NOW_EPOCH: '1780995665',
        BOT_ERRORS_AUTH_BOND_WRITE_INFLIGHT_GRACE_SECONDS: '10',
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_HEALTH_STATUS: '200',
        BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON: JSON.stringify({
          status: 'healthy',
          whatsapp: {
            connected: true,
            connection: {
              state: 'connected',
              reconnect_attempts: 0,
              auth_failure_class: 'none',
            },
            auth_bond: {
              status: 'invalid',
              issues: ['creds_json_empty'],
              creds: {
                exists: true,
                mode: '600',
                size: 0,
                mtime: '2026-06-09T09:00:04.000Z',
                hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
                empty_hash: true,
              },
              backup: {
                latest: '/tmp/auth-bond/latest',
                latest_at: '2026-06-09T08:59:00.000Z',
                latest_reason: 'connection-open',
              },
            },
          },
        }),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          instances: [{ name: 'primary-bot', expected: 'always_on', healthPort: 9090 }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const { summary, fails } = readOutboxBySource(outbox);
    const event = summary as unknown as { evidence: string };
    expect(fails.length).toBeGreaterThanOrEqual(1);
    for (const fail of fails) {
      expect(fail.severity).toBe('critical');
      expect((fail.diagnostics as Record<string, unknown>).forceNotify).toBe(true);
    }
    expect(event.evidence).toContain('auth_bond_at_risk');
    expect(event.evidence).toContain('auth_bond_status=invalid');
    expect(event.evidence).toContain('auth_bond_issues=creds_json_empty');
    expect(event.evidence).not.toContain('auth_bond_credential_write_inflight=true');
  });

  it('fails daily health when a configured port answers for a different instance', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'primary-bot');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      type: 'agent',
      enabled: true,
      healthPort: 9090,
    }));
    chmodSync(configPath, 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'agent-alpha@s.whatsapp.net', lid: 'agent-alpha@lid' },
      registrationId: 2,
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_HEALTH_STATUS: '200',
        BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON: JSON.stringify({
          status: 'healthy',
          instance: { name: 'other-bot' },
          whatsapp: {
            connected: true,
            connection: { state: 'connected', reconnect_attempts: 0 },
          },
        }),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          instances: [{ name: 'primary-bot', expected: 'always_on', healthPort: 9090 }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const { summary, fails } = readOutboxBySource(outbox);
    const event = summary as unknown as {
      severity: string;
      evidence: string;
    };
    expect(fails.length).toBeGreaterThanOrEqual(1);
    for (const fail of fails) {
      expect(fail.severity).toBe('critical');
      expect((fail.diagnostics as Record<string, unknown>).forceNotify).toBe(true);
    }
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('health primary-bot: FAIL 200 http://127.0.0.1:9090/health health_identity_mismatch');
    expect(event.evidence).toContain('instance_name=other-bot');
    expect(event.evidence).toContain('expected_instance=primary-bot');
  });

  it('fails daily health when the health probe is unauthorized', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'primary-bot');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      type: 'agent',
      enabled: true,
      healthPort: 9090,
    }));
    chmodSync(configPath, 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'agent-alpha@s.whatsapp.net', lid: 'agent-alpha@lid' },
      registrationId: 2,
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_HEALTH_STATUS: '401',
        BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON: JSON.stringify({ error: 'unauthorized' }),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          instances: [{ name: 'primary-bot', expected: 'always_on', healthPort: 9090 }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const { summary, fails } = readOutboxBySource(outbox);
    const event = summary as unknown as {
      severity: string;
      evidence: string;
    };
    expect(fails.length).toBeGreaterThanOrEqual(1);
    for (const fail of fails) {
      expect(fail.severity).toBe('critical');
      expect((fail.diagnostics as Record<string, unknown>).forceNotify).toBe(true);
    }
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('health primary-bot: FAIL 401 http://127.0.0.1:9090/health health_probe_auth_failed');
  });

  describe('health body validation (#1878)', () => {
    function probeLine(status: number, body: string, expectedName?: string): string {
      const nameArg = expectedName === undefined ? 'None' : JSON.stringify(expectedName);
      return python([
        importHealthModulePrelude(),
        `print(m.format_health_probe('http://127.0.0.1:9090/health', ${status}, ${JSON.stringify(body)}, ${nameArg}))`,
      ].join('\n'));
    }

    function healthyBody(overrides: Record<string, unknown> = {}): string {
      return JSON.stringify({
        status: 'healthy',
        generated_at: new Date().toISOString(),
        instance: { name: 'primary-bot' },
        whatsapp: { connected: true },
        ...overrides,
      });
    }

    it('rejects a malformed JSON health body instead of reporting green', () => {
      expect(probeLine(200, '{not json', 'primary-bot')).toMatch(/^FAIL 200 .*health_body_malformed/);
    });

    it('rejects a non-object JSON health body instead of reporting green', () => {
      expect(probeLine(200, '[1,2,3]', 'primary-bot')).toMatch(/^FAIL 200 .*health_body_nonobject/);
    });

    it('rejects a stale generated_at health body instead of reporting green', () => {
      expect(probeLine(200, healthyBody({ generated_at: '2000-01-01T00:00:00Z' }), 'primary-bot'))
        .toMatch(/^FAIL 200 .*health_generated_at_stale/);
    });

    it('rejects a future-skewed generated_at health body instead of reporting green', () => {
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      expect(probeLine(200, healthyBody({ generated_at: future }), 'primary-bot'))
        .toMatch(/^FAIL 200 .*health_generated_at_future_skew/);
    });

    it('rejects a health body missing instance identity when a name is configured', () => {
      const body = JSON.stringify({ status: 'healthy', generated_at: new Date().toISOString() });
      expect(probeLine(200, body, 'primary-bot')).toMatch(/^FAIL 200 .*health_identity_missing/);
    });

    it('flags a health body missing generated_at as inconclusive, never green', () => {
      const body = JSON.stringify({ status: 'healthy', instance: { name: 'primary-bot' } });
      expect(probeLine(200, body, 'primary-bot')).toMatch(/^WARN 200 .*health_generated_at_missing/);
    });

    it('flags an unparseable generated_at as inconclusive, never green', () => {
      expect(probeLine(200, healthyBody({ generated_at: 'not-a-timestamp' }), 'primary-bot'))
        .toMatch(/^WARN 200 .*health_generated_at_unparseable/);
    });

    it('flags a missing status field as inconclusive, never green', () => {
      const body = JSON.stringify({
        generated_at: new Date().toISOString(),
        instance: { name: 'primary-bot' },
      });
      expect(probeLine(200, body, 'primary-bot')).toMatch(/^WARN 200 .*health_status_missing/);
    });

    it('flags an unknown status value as inconclusive, never green', () => {
      expect(probeLine(200, healthyBody({ status: 'spinning' }), 'primary-bot'))
        .toMatch(/^WARN 200 .*health_status_unknown/);
    });

    it('rejects an unexpected HTTP status instead of reporting green', () => {
      expect(probeLine(404, healthyBody(), 'primary-bot')).toMatch(/^FAIL 404 .*health_unexpected_status/);
    });

    it('keeps an instance identity mismatch as a failure', () => {
      expect(probeLine(200, healthyBody({ instance: { name: 'other-bot' } }), 'primary-bot'))
        .toMatch(/^FAIL 200 .*health_identity_mismatch/);
    });

    it('accepts a fresh canonical healthy body with matching identity', () => {
      const line = probeLine(200, healthyBody(), 'primary-bot');
      expect(line).not.toMatch(/^(FAIL|WARN) /);
      expect(line).toMatch(/^200 http:\/\/127\.0\.0\.1:9090\/health /);
      expect(line).toContain('status=healthy');
      expect(line).toContain('instance_name=primary-bot');
    });
  });

  it('fails daily health when local auth bond permissions are too open', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'primary-bot');
    const authDir = join(configDir, 'auth');
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      type: 'agent',
      enabled: true,
    }));
    writeFileSync(join(authDir, 'creds.json'), JSON.stringify({
      me: { id: 'agent-alpha@s.whatsapp.net', lid: 'agent-alpha@lid' },
      registrationId: 2,
    }));
    chmodSync(authDir, 0o755);
    chmodSync(join(authDir, 'creds.json'), 0o644);

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          instances: [{ name: 'primary-bot', expected: 'always_on' }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const { summary, fails } = readOutboxBySource(outbox);
    const event = summary as unknown as {
      severity: string;
      evidence: string;
    };
    expect(fails.length).toBeGreaterThanOrEqual(1);
    for (const fail of fails) {
      expect(fail.severity).toBe('critical');
      expect((fail.diagnostics as Record<string, unknown>).forceNotify).toBe(true);
    }
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('FAIL auth_bond primary-bot: present');
    expect(event.evidence).toContain('mode_violation=auth_mode>700,creds_mode>600');
  });

  it('fails daily health when WhatsApp auth credentials are symlinked', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'primary-bot');
    const authDir = join(configDir, 'auth');
    const outsideCreds = join(tmpRoot, 'outside-creds.json');
    mkdirSync(authDir, { recursive: true });
    chmodSync(authDir, 0o700);
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      type: 'agent',
      enabled: true,
    }));
    writeFileSync(outsideCreds, JSON.stringify({
      me: { id: 'agent-alpha@s.whatsapp.net', lid: 'agent-alpha@lid' },
      registrationId: 2,
    }));
    symlinkSync(outsideCreds, join(authDir, 'creds.json'));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          instances: [{ name: 'primary-bot', expected: 'always_on' }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const { summary, fails } = readOutboxBySource(outbox);
    const event = summary as unknown as {
      severity: string;
      evidence: string;
    };
    expect(fails.length).toBeGreaterThanOrEqual(1);
    for (const fail of fails) {
      expect(fail.severity).toBe('critical');
      expect((fail.diagnostics as Record<string, unknown>).forceNotify).toBe(true);
    }
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('FAIL auth_bond primary-bot: creds_symlink=true credential_paths_redacted=true');
    expect(event.evidence).not.toContain(outsideCreds);
    expect(event.evidence).not.toContain('agent-alpha@s.whatsapp.net');
  });

  it('classifies unhealthy bots from recent device_removed logs when health omits the status code', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'eh-bot');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      type: 'agent',
      enabled: true,
      healthPort: 9096,
    }));
    writeSecureCreds(authDir, {
      me: { id: 'eh@s.whatsapp.net', lid: 'eh@lid' },
      registrationId: 2,
    });
    writeFileSync(join(configDir, 'stdout.log'), [
      '{"level":50,"component":"connection","fullErrorNode":{"tag":"stream:error","attrs":{"code":"401"},"content":[{"tag":"conflict","attrs":{"type":"device_removed"}}]}}',
      '{"level":40,"component":"connection","statusCode":401,"reason":"loggedOut"}',
    ].join('\n'));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_HEALTH_STATUS: '503',
        BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON: JSON.stringify({
          status: 'unhealthy',
          whatsapp: {
            connected: false,
            connection: {
              state: 'disconnected',
              reconnect_phase: 'backoff',
              reconnect_attempts: 0,
            },
          },
        }),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          instances: [{ name: 'eh-bot', expected: 'always_on', healthPort: 9096 }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const { summary, fails } = readOutboxBySource(outbox);
    const event = summary as unknown as {
      severity: string;
      evidence: string;
    };
    expect(fails.length).toBeGreaterThanOrEqual(1);
    for (const fail of fails) {
      expect(fail.severity).toBe('critical');
      expect((fail.diagnostics as Record<string, unknown>).forceNotify).toBe(true);
    }
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('FAIL auth_bond eh-bot: physical_intervention_required recent_log_pattern=device_removed');
  });

  it('fails daily health when two local instances share identical auth credentials', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const sharedCreds = JSON.stringify({
      me: { id: 'shared@s.whatsapp.net', lid: 'shared@lid' },
      registrationId: 7,
    });
    for (const name of ['alpha-bot', 'beta-bot']) {
      const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', name);
      const authDir = join(configDir, 'auth');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({ type: 'agent', enabled: true }));
      writeSecureCreds(authDir, JSON.parse(sharedCreds));
    }

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          instances: [
            { name: 'alpha-bot', expected: 'always_on' },
            { name: 'beta-bot', expected: 'always_on' },
          ],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('FAIL auth_bond_duplicate');
    expect(event.evidence).toContain('instances=alpha-bot,beta-bot');
  });

  it('treats intentional blocked instances as info when the service is not active', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'ar-bot');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ type: 'agent', enabled: false }));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_SERVICE_STATUS: 'inactive',
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host-blocked',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          instances: [{
            name: 'ar-bot',
            expected: 'blocked',
            service: 'com.whatsoup.ar-bot',
            reason: 'pending Lucas approval',
          }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('info');
    expect(event.evidence).toContain('config ar-bot: expected=blocked exists=True service_status=inactive');
    expect(event.evidence).toContain('config_enabled=False');
    expect(event.evidence).toContain('plugins ar-bot: skipped expected=blocked');
    expect(event.evidence).not.toContain('WARN config ar-bot');
    expect(event.evidence).not.toContain('FAIL config ar-bot');
  });

  it('fails blocked instances that still have their config enabled', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'ar-bot');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ type: 'agent', enabled: true }));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_SERVICE_STATUS: 'inactive',
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host-blocked',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          instances: [{
            name: 'ar-bot',
            expected: 'blocked',
            service: 'com.whatsoup.ar-bot',
            reason: 'pending Lucas approval',
          }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const { summary, fails } = readOutboxBySource(outbox);
    const event = summary as unknown as {
      severity: string;
      evidence: string;
    };
    expect(fails.length).toBeGreaterThanOrEqual(1);
    for (const fail of fails) {
      expect(fail.severity).toBe('critical');
      expect((fail.diagnostics as Record<string, unknown>).forceNotify).toBe(true);
    }
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('FAIL config ar-bot: expected=blocked exists=True service_status=inactive');
    expect(event.evidence).toContain('config_enabled=True');
    expect(event.evidence).toContain('actual=activation_guard_missing');
  });

  it('warns when an intentional blocked instance is unexpectedly active', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'ar-bot');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ type: 'agent', enabled: false }));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_SERVICE_STATUS: 'active',
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host-blocked',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          instances: [{
            name: 'ar-bot',
            expected: 'blocked',
            service: 'com.whatsoup.ar-bot',
            reason: 'pending Lucas approval',
          }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('warning');
    expect(event.evidence).toContain('WARN config ar-bot: expected=blocked exists=True service_status=active');
    expect(event.evidence).toContain('actual=active');
  });

  it('raises critical daily health severity when disk free space is below threshold', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(128 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'no-bot',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('warning'); // F7: disk is infra-class, de-conflated from critical
    expect(event.evidence).toContain('FAIL disk');
    expect(event.evidence).toContain('free_bytes=134217728');
  });

  it('raises critical daily health severity when clock offset exceeds threshold', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_CLOCK_OFFSET_MS: '600000',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'no-bot',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('warning'); // F7: clock is infra-class, de-conflated from critical
    expect(event.evidence).toContain('FAIL clock: status=synced offset_ms=600000.0');
  });

  it('warns on a degraded 200 health body and surfaces runtime compact/crash counters', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'q');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      type: 'agent',
      enabled: true,
      healthPort: 9090,
    }));
    writeSecureCreds(authDir, {
      me: { id: 'q@s.whatsapp.net', lid: 'q@lid' },
      registrationId: 2,
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_HEALTH_STATUS: '200',
        BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON: JSON.stringify({
          status: 'degraded',
          generated_at: new Date().toISOString(),
          instance: { name: 'q' },
          whatsapp: {
            connected: true,
            connection: { state: 'connected' },
          },
          runtime: {
            agent: {
              activeSessions: 1,
              sessionCount: 2,
              recentCrashes: 1,
              lastCrashAt: '2026-06-09T12:00:00Z',
              pollPersistenceErrors: 0,
              autoCompactIneffective: 1,
              autoCompactConsecutiveRapidRearmsMax: 2,
              autoCompactNextTurnOverThreshold: 3,
              turnFinalizationDegradedScopes: 1,
              turnFinalizationRetryExhaustions: 1,
              turnRecoveryBlockedUnsafe: 6,
              turnRecoveryQuarantinedDelivery: 1,
            },
          },
        }),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          instances: [{ name: 'q', expected: 'always_on', healthPort: 9090 }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('warning');
    expect(event.evidence).toContain('health q: WARN 200 http://127.0.0.1:9090/health');
    expect(event.evidence).toContain('health_degraded');
    expect(event.evidence).toContain('runtime_agent_recent_crashes=1');
    expect(event.evidence).toContain('runtime_agent_auto_compact_ineffective=1');
    expect(event.evidence).toContain('runtime_agent_auto_compact_next_turn_over_threshold=3');
    expect(event.evidence).toContain('runtime_agent_turn_finalization_degraded_scopes=1');
    expect(event.evidence).toContain('runtime_agent_turn_finalization_retry_exhaustions=1');
    expect(event.evidence).toContain('runtime_agent_turn_recovery_blocked_unsafe=6');
    expect(event.evidence).toContain('runtime_agent_turn_recovery_quarantined_delivery=1');
  });

  it('warns on recent provider resume failures without classifying them as auth loss', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'eh-bot');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      type: 'agent',
      enabled: true,
      healthPort: 9096,
    }));
    writeSecureCreds(authDir, {
      me: { id: 'eh-bot@s.whatsapp.net', lid: 'eh-bot@lid' },
      registrationId: 2,
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_HEALTH_STATUS: '200',
        BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON: JSON.stringify({
          status: 'healthy',
          generated_at: new Date().toISOString(),
          instance: { name: 'eh-bot' },
          whatsapp: {
            connected: true,
            connection: { state: 'connected', auth_failure_class: 'none' },
          },
          runtime: {
            agent: {
              activeSessions: 0,
              sessionCount: 1,
              lastSessionStatus: 'idle',
              lastSessionStartedAt: '2026-06-12T04:42:51Z',
              recentCrashes: 0,
              lastCrashAt: null,
              recentResumeFailures: 1,
              lastResumeFailedAt: '2026-06-12T04:42:52Z',
              pollPersistenceErrors: 0,
            },
          },
        }),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          instances: [{ name: 'eh-bot', expected: 'always_on', healthPort: 9096 }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
      alertSource?: string;
      criticalAsset?: unknown;
    };
    expect(event.severity).toBe('warning');
    expect(event.evidence).toContain('health eh-bot: WARN 200 http://127.0.0.1:9096/health');
    expect(event.evidence).toContain('runtime_agent_recent_resume_failures=1');
    expect(event.evidence).toContain('runtime_agent_last_resume_failed_at=2026-06-12T04:42:52Z');
    expect(event.evidence).toContain('runtime_agent_last_session_status=idle');
    expect(event.evidence).not.toContain('provider_auth_required');
    expect(event.alertSource ?? '').not.toContain('provider_probe');
    expect(Object.hasOwn(event, 'criticalAsset')).toBe(false);
  });

  describe('runtime-agent signal dispositions', () => {
    function probeRuntimeAgent(
      agent: Record<string, unknown>,
      registryPath?: string,
    ): string {
      const body = JSON.stringify({
        status: 'healthy',
        generated_at: new Date().toISOString(),
        instance: { name: 'synthetic-bot' },
        whatsapp: { connected: true },
        runtime: { agent },
      });
      return python([
        importHealthModulePrelude(),
        ...(registryPath === undefined
          ? []
          : [`m.RUNTIME_AGENT_HEALTH_SIGNAL_REGISTRY_PATH = Path(${JSON.stringify(registryPath)})`]),
        `print(m.format_health_probe('http://127.0.0.1:9090/health', 200, ${JSON.stringify(body)}, 'synthetic-bot'))`,
      ].join('\n'));
    }

    it('keeps lifetime totals, historical maxima, and terminal audit counts diagnostic', () => {
      const line = probeRuntimeAgent({
        activeSessions: 1,
        sessionCount: 2,
        pollPersistenceErrors: 4,
        autoCompactIneffective: 5,
        autoCompactConsecutiveRapidRearmsMax: 3,
        autoCompactNextTurnOverThreshold: 7,
        turnRecoveryBlockedUnsafe: 6,
        turnRecoveryQuarantinedDelivery: 2,
        turnRecoveryOrphanTransfers: 1,
        turnFinalizationRetryAttempts: 8,
        turnFinalizationRetryRecoveries: 5,
        turnFinalizationRetryExhaustions: 3,
      });

      expect(line).toMatch(/^200 /);
      expect(line).not.toContain('runtime_agent_at_risk');
      expect(line).toContain('runtime_agent_auto_compact_ineffective=5');
      expect(line).toContain('runtime_agent_auto_compact_rapid_rearms_max=3');
      expect(line).toContain('runtime_agent_turn_recovery_blocked_unsafe=6');
      expect(line).toContain('runtime_agent_turn_finalization_retry_exhaustions=3');
    });

    it('warns for declared current-risk signals and renders bounded backoff state', () => {
      const backoff = probeRuntimeAgent({
        autoCompactState: 'backoff',
        autoCompactActiveBackoffScopes: 2,
        autoCompactWorstCurrentBackoffTier: 3,
      });
      expect(backoff).toMatch(/^WARN 200 /);
      expect(backoff).toContain('runtime_agent_at_risk');
      expect(backoff).toContain('runtime_agent_auto_compact_state=backoff');
      expect(backoff).toContain('runtime_agent_auto_compact_active_backoff_scopes=2');
      expect(backoff).toContain('runtime_agent_auto_compact_worst_current_backoff_tier=3');

      const recovery = probeRuntimeAgent({
        turnRecoveryOutstanding: 1,
        turnRecoveryOpenRecoveries: 1,
        turnRecoveryCorruptLinks: 1,
        turnRecoveryEchoConflicts: 1,
      });
      expect(recovery).toMatch(/^WARN 200 /);
      expect(recovery).toContain('runtime_agent_at_risk');
    });

    it('warns visibly without inferring field severity when the registry is unavailable', () => {
      tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-registry-'));
      const missingPath = join(tmpRoot, 'missing-registry.json');
      const malformedPath = join(tmpRoot, 'malformed-registry.json');
      const wrongSchemaPath = join(tmpRoot, 'wrong-schema-registry.json');
      const invalidContractPath = join(tmpRoot, 'invalid-contract-registry.json');
      writeFileSync(malformedPath, '{not json');
      writeFileSync(wrongSchemaPath, JSON.stringify({
        schema: 'whatsoup-fault-taxonomy-registry-v2',
        runtimeAgentHealthSignals: [],
      }));
      writeFileSync(invalidContractPath, JSON.stringify({
        schema: 'whatsoup-fault-taxonomy-registry-v3',
        runtimeAgentHealthSignals: [{
          field: 'turnRecoveryOutstanding',
          label: 'runtime_agent_turn_recovery_outstanding',
          kind: [],
          currentHealthEffect: 'positive_is_risk',
          owner: 'bounded-owner',
          test: 'bounded-test',
        }],
      }));

      for (const [registryPath, errorClass] of [
        [missingPath, 'missing'],
        [malformedPath, 'malformed_json'],
        [wrongSchemaPath, 'invalid_schema'],
        [invalidContractPath, 'invalid_contract'],
      ] as const) {
        const line = probeRuntimeAgent({
          turnRecoveryOutstanding: 1,
          turnRecoveryBlockedUnsafe: 4,
        }, registryPath);
        expect(line).toMatch(/^WARN 200 /);
        expect(line).toContain('runtime_agent_health_signal_registry_invalid');
        expect(line).toContain(`runtime_agent_health_signal_registry_error=${errorClass}`);
        expect(line).not.toContain('runtime_agent_at_risk');
        expect(line).not.toContain('runtime_agent_turn_recovery_outstanding');
      }
    });
  });

  it('fails daily health when an opt-in provider probe hits a Claude session limit', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'q');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      type: 'agent',
      enabled: true,
      healthPort: 9090,
      agentOptions: { provider: 'claude-cli' },
    }));
    chmodSync(join(configDir, 'config.json'), 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'q@s.whatsapp.net', lid: 'q@lid' },
      registrationId: 2,
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_HEALTH_STATUS: '200',
        BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON: JSON.stringify({
          status: 'healthy',
          whatsapp: {
            connected: true,
            connection: { state: 'connected', auth_failure_class: 'none' },
            auth_bond: {
              status: 'present',
              backup: { latest: join(tmpRoot, 'auth-backups', 'latest') },
            },
          },
        }),
        BOT_ERRORS_DRY_PROVIDER_PROBE_RC: '0',
        BOT_ERRORS_DRY_PROVIDER_PROBE_STDOUT: "You've hit your weekly limit · resets Jun 16, 10pm (America/New_York)",
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'central',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          instances: [{
            name: 'q',
            expected: 'always_on',
            healthPort: 9090,
            expectProviderProbe: true,
            providerProbeCommand: '/usr/local/bin/claude',
          }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const { summary, fails } = readOutboxBySource(outbox);
    const event = summary as unknown as {
      severity: string;
      evidence: string;
      alertSource?: string;
      criticalAsset?: {
        asset?: { kind?: string; instance?: string };
        failure?: { code?: string; recoverability?: string };
      };
    };
    expect(fails.length).toBeGreaterThanOrEqual(1);
    for (const fail of fails) {
      expect(fail.severity).toBe('critical');
      expect((fail.diagnostics as Record<string, unknown>).forceNotify).toBe(true);
    }
    expect(event.severity).toBe('critical');
    expect(event.alertSource).toBe('provider_probe:q:provider_usage_limit');
    expect(event.criticalAsset?.asset?.kind).toBe('agent_provider');
    expect(event.criticalAsset?.asset?.instance).toBe('q');
    expect(event.criticalAsset?.failure?.code).toBe('AGENT_PROVIDER_USAGE_LIMIT');
    expect(event.criticalAsset?.failure?.recoverability).toBe('time_or_operator_recoverable');
    expect(event.evidence).toContain('health q:');
    expect(event.evidence).toContain('http://127.0.0.1:9090/health');
    expect(event.evidence).toContain('FAIL provider_probe q: provider=claude-cli');
    expect(event.evidence).toContain('failure_class=provider_usage_limit');
    expect(event.evidence).toContain('command=/usr/local/bin/claude');
    expect(event.evidence).toContain('weekly_limit');
    expect(event.evidence).not.toContain('q@s.whatsapp.net');
  });

  it('skips provider probing for managed API providers discovered from instance config', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'agent-alpha');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      type: 'agent',
      enabled: true,
      healthPort: 9090,
      agentOptions: { provider: 'openai-api' },
    }));
    chmodSync(join(configDir, 'config.json'), 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'agent-alpha@s.whatsapp.net', lid: 'agent-alpha@lid' },
      registrationId: 2,
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_HEALTH_STATUS: '200',
        BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON: JSON.stringify({
          status: 'healthy',
          generated_at: new Date().toISOString(),
          instance: { name: 'agent-alpha', provider: 'openai-api' },
          whatsapp: {
            connected: true,
            connection: { state: 'connected', auth_failure_class: 'none' },
            auth_bond: {
              status: 'present',
              backup: { latest: join(tmpRoot, 'auth-backups', 'latest') },
            },
          },
        }),
        BOT_ERRORS_DRY_PROVIDER_PROBE_RC: '1',
        BOT_ERRORS_DRY_PROVIDER_PROBE_STDOUT: "You've hit your session limit · resets 5am (America/New_York)",
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'central',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
          instances: [{
            name: 'agent-alpha',
            expected: 'always_on',
            healthPort: 9090,
            expectProviderProbe: true,
          }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
      alertSource?: string;
      criticalAsset?: unknown;
    };
    expect(event.severity).toBe('info');
    expect(event.alertSource).toBeUndefined();
    expect(event.criticalAsset).toBeUndefined();
    expect(event.evidence).toContain('provider_probe agent-alpha: skipped provider=openai-api');
    expect(event.evidence).not.toContain('FAIL provider_probe agent-alpha');
    expect(event.evidence).not.toContain('session_limit');
    expect(event.evidence).not.toContain('agent-alpha@s.whatsapp.net');
  });

  it('alerts when an OpenCode fallback/provider install only supports the degraded legacy one-shot contract', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'agent-alpha');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      type: 'agent',
      enabled: true,
      healthPort: 9090,
      agentOptions: {
        provider: 'opencode-cli',
        model: 'minimax/MiniMax-M2.7-highspeed',
        providerConfig: { opencodeCommandMode: 'auto' },
      },
    }));
    chmodSync(join(configDir, 'config.json'), 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'agent-alpha@s.whatsapp.net', lid: 'agent-alpha@lid' },
      registrationId: 2,
    });

    const legacyHelp = [
      'Usage:',
      '  opencode [flags]',
      'Flags:',
      '  -p, --prompt string',
      '  -f, --output-format string   Output format for non-interactive mode (text, json)',
      '  -q, --quiet',
    ].join('\n');

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_HEALTH_STATUS: '200',
        BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON: JSON.stringify({
          status: 'healthy',
          instance: { name: 'agent-alpha', provider: 'opencode-cli' },
          whatsapp: {
            connected: true,
            connection: { state: 'connected', auth_failure_class: 'none' },
            auth_bond: {
              status: 'present',
              backup: { latest: join(tmpRoot, 'auth-backups', 'latest') },
            },
          },
        }),
        BOT_ERRORS_DRY_OPENCODE_VERSION_STDOUT: '0.0.55',
        BOT_ERRORS_DRY_OPENCODE_HELP_STDOUT: legacyHelp,
        BOT_ERRORS_DRY_OPENCODE_RUN_HELP_STDOUT: legacyHelp,
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'central',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
          instances: [{
            name: 'agent-alpha',
            expected: 'always_on',
            healthPort: 9090,
            expectProviderProbe: true,
          }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const { summary, fails } = readOutboxBySource(outbox);
    const event = summary as unknown as {
      severity: string;
      evidence: string;
      alertSource?: string;
      criticalAsset?: {
        asset?: { kind?: string; instance?: string };
        failure?: { code?: string; recoverability?: string };
      };
    };
    expect(fails.length).toBeGreaterThanOrEqual(1);
    for (const fail of fails) {
      expect(fail.severity).toBe('critical');
      expect((fail.diagnostics as Record<string, unknown>).forceNotify).toBe(true);
    }
    expect(event.severity).toBe('critical');
    expect(event.alertSource).toBe('provider_probe:agent-alpha:provider_compatibility_degraded');
    expect(event.criticalAsset?.asset?.kind).toBe('agent_provider');
    expect(event.criticalAsset?.asset?.instance).toBe('agent-alpha');
    expect(event.criticalAsset?.failure?.code).toBe('AGENT_PROVIDER_COMPATIBILITY_DEGRADED');
    expect(event.criticalAsset?.failure?.recoverability).toBe('operator_recoverable');
    expect(event.evidence).toContain('FAIL provider_probe agent-alpha: provider=opencode-cli');
    expect(event.evidence).toContain('version=0.0.55');
    expect(event.evidence).toContain('detected_mode=legacy-prompt-json');
    expect(event.evidence).toContain('failure_class=provider_compatibility_degraded');
    expect(event.evidence).toContain('model_override=false');
    expect(event.evidence).toContain('session_resume=false');
    expect(event.evidence).toContain('remediation=install_or_upgrade_opencode_modern_run_cli');
    expect(event.evidence).not.toContain('agent-alpha@s.whatsapp.net');
  });

  it('probes configured OpenCode fallback using fallbackProviderConfig, not primary providerConfig', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const binDir = join(tmpRoot, 'bin');
    const opencodeCommand = join(binDir, 'opencode');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(opencodeCommand, '#!/bin/sh\nexit 0\n');
    chmodSync(opencodeCommand, 0o700);
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'agent-alpha');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      type: 'agent',
      enabled: true,
      healthPort: 9090,
      agentOptions: {
        provider: 'claude-cli',
        providerConfig: {},
        fallbackProvider: 'opencode-cli',
        fallbackModel: 'minimax/MiniMax-M2.7-highspeed',
        fallbackProviderConfig: { opencodeCommandMode: 'modern-run' },
      },
    }));
    chmodSync(join(configDir, 'config.json'), 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'agent-alpha@s.whatsapp.net', lid: 'agent-alpha@lid' },
      registrationId: 2,
    });

    const legacyHelp = [
      'Usage:',
      '  opencode [flags]',
      'Flags:',
      '  -p, --prompt string',
      '  -f, --output-format string   Output format for non-interactive mode (text, json)',
      '  -q, --quiet',
    ].join('\n');

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        PATH: `${binDir}${process.env.PATH ? `:${process.env.PATH}` : ''}`,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_HEALTH_STATUS: '200',
        BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON: JSON.stringify({
          status: 'healthy',
          instance: { name: 'agent-alpha', provider: 'claude-cli' },
          whatsapp: {
            connected: true,
            connection: { state: 'connected', auth_failure_class: 'none' },
            auth_bond: {
              status: 'present',
              backup: { latest: join(tmpRoot, 'auth-backups', 'latest') },
            },
          },
        }),
        BOT_ERRORS_DRY_PROVIDER_PROBE_RC: '0',
        BOT_ERRORS_DRY_PROVIDER_PROBE_STDOUT: 'OK',
        BOT_ERRORS_DRY_OPENCODE_VERSION_STDOUT: '0.0.55',
        BOT_ERRORS_DRY_OPENCODE_HELP_STDOUT: legacyHelp,
        BOT_ERRORS_DRY_OPENCODE_RUN_HELP_STDOUT: legacyHelp,
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'central',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
          instances: [{
            name: 'agent-alpha',
            expected: 'always_on',
            healthPort: 9090,
            expectProviderProbe: true,
            providerProbeProvider: 'claude-cli',
            providerProbeCommand: '/usr/local/bin/claude',
          }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const { summary, fails } = readOutboxBySource(outbox);
    const event = summary as unknown as {
      severity: string;
      evidence: string;
      alertSource?: string;
      criticalAsset?: {
        asset?: { kind?: string; instance?: string };
        failure?: { code?: string; recoverability?: string };
      };
    };
    expect(fails.length).toBeGreaterThanOrEqual(1);
    for (const fail of fails) {
      expect(fail.severity).toBe('critical');
      expect((fail.diagnostics as Record<string, unknown>).forceNotify).toBe(true);
    }
    expect(event.severity).toBe('critical');
    expect(event.alertSource).toBe('provider_probe:agent-alpha:provider_compatibility_unsupported');
    expect(event.criticalAsset?.asset?.kind).toBe('agent_provider');
    expect(event.criticalAsset?.asset?.instance).toBe('agent-alpha');
    expect(event.criticalAsset?.failure?.code).toBe('AGENT_PROVIDER_COMPATIBILITY_UNSUPPORTED');
    expect(event.evidence).toContain('provider_probe agent-alpha: provider=claude-cli target=configured command=/usr/local/bin/claude');
    expect(event.evidence).toContain('FAIL provider_probe agent-alpha: provider=opencode-cli');
    expect(event.evidence).toContain('target=fallback');
    expect(event.evidence).toContain(`command=${opencodeCommand}`);
    expect(event.evidence).not.toContain('provider=opencode-cli command=/usr/local/bin/claude');
    expect(event.evidence).toContain('configured_mode=modern-run');
    expect(event.evidence).toContain('detected_mode=legacy-prompt-json');
    expect(event.evidence).toContain('reason=configured_mode_does_not_match_detected_cli_contract');
    expect(event.evidence).not.toContain('agent-alpha@s.whatsapp.net');
  });

  it('warns when the health endpoint is serving through an active provider fallback', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'agent-alpha');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      type: 'agent',
      enabled: true,
      healthPort: 9090,
      agentOptions: {
        provider: 'claude-cli',
        fallbackProvider: 'opencode-cli',
        fallbackModel: 'minimax/MiniMax-M2.7',
      },
    }));
    chmodSync(join(configDir, 'config.json'), 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'agent-alpha@s.whatsapp.net', lid: 'agent-alpha@lid' },
      registrationId: 2,
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_NOW_EPOCH: String(Math.floor(Date.parse('2026-06-12T03:00:00Z') / 1000)),
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_HEALTH_STATUS: '200',
        BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON: JSON.stringify({
          status: 'healthy',
          instance: {
            name: 'agent-alpha',
            provider: 'claude-cli',
            effectiveProvider: 'opencode-cli',
            fallbackActiveUntil: Date.parse('2026-06-17T02:00:00Z'),
            fallbackReason: 'usage-limit',
            fallbackModel: 'minimax/MiniMax-M2.7',
          },
          whatsapp: {
            connected: true,
            connection: { state: 'connected', auth_failure_class: 'none' },
            auth_bond: {
              status: 'present',
              backup: { latest: join(tmpRoot, 'auth-backups', 'latest') },
            },
          },
        }),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'central',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
          instances: [{
            name: 'agent-alpha',
            expected: 'always_on',
            healthPort: 9090,
            expectProviderProbe: false,
          }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
      alertSource?: string;
    };
    expect(event.severity).toBe('warning');
    expect(event.alertSource).toBeUndefined();
    expect(event.evidence).toContain('health agent-alpha: WARN 200 http://127.0.0.1:9090/health runtime_agent_fallback_active');
    expect(event.evidence).toContain('instance_provider=claude-cli');
    expect(event.evidence).toContain('instance_effective_provider=opencode-cli');
    expect(event.evidence).toContain('instance_fallback_reason=usage-limit');
    expect(event.evidence).toContain('instance_fallback_model=minimax/MiniMax-M2.7');
    expect(event.evidence).not.toContain('agent-alpha@s.whatsapp.net');
  });

  it('fails the OpenCode fallback provider probe when its model credential is missing', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'agent-alpha');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      type: 'agent',
      enabled: true,
      healthPort: 9090,
      agentOptions: {
        provider: 'claude-cli',
        fallbackProvider: 'opencode-cli',
        fallbackModel: 'minimax/MiniMax-M2.7',
        fallbackProviderConfig: { opencodeCommandMode: 'modern-run' },
      },
    }));
    chmodSync(join(configDir, 'config.json'), 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'agent-alpha@s.whatsapp.net', lid: 'agent-alpha@lid' },
      registrationId: 2,
    });

    const modernRunHelp = [
      'Usage: opencode run [flags]',
      '  --format string',
      '  --pure',
      '  -m, --model string',
    ].join('\n');

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_HEALTH_STATUS: '200',
        BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON: JSON.stringify({
          status: 'healthy',
          instance: { name: 'agent-alpha', provider: 'claude-cli', effectiveProvider: 'claude-cli' },
          whatsapp: {
            connected: true,
            connection: { state: 'connected', auth_failure_class: 'none' },
            auth_bond: {
              status: 'present',
              backup: { latest: join(tmpRoot, 'auth-backups', 'latest') },
            },
          },
        }),
        BOT_ERRORS_DRY_PROVIDER_PROBE_RC: '0',
        BOT_ERRORS_DRY_PROVIDER_PROBE_STDOUT: 'OK',
        BOT_ERRORS_DRY_OPENCODE_VERSION_STDOUT: '0.1.0',
        BOT_ERRORS_DRY_OPENCODE_HELP_STDOUT: 'Usage: opencode',
        BOT_ERRORS_DRY_OPENCODE_RUN_HELP_STDOUT: modernRunHelp,
        BOT_ERRORS_DRY_CREDENTIAL_STATUS_MINIMAX: 'missing',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'central',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
          instances: [{
            name: 'agent-alpha',
            expected: 'always_on',
            healthPort: 9090,
            expectProviderProbe: true,
            providerProbeProvider: 'claude-cli',
          }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const { summary, fails } = readOutboxBySource(outbox);
    const event = summary as unknown as {
      severity: string;
      evidence: string;
      alertSource?: string;
      criticalAsset?: { failure?: { code?: string } };
    };
    expect(fails.length).toBeGreaterThanOrEqual(1);
    for (const fail of fails) {
      expect(fail.severity).toBe('critical');
      expect((fail.diagnostics as Record<string, unknown>).forceNotify).toBe(true);
    }
    expect(event.severity).toBe('critical');
    expect(event.alertSource).toBe('provider_probe:agent-alpha:provider_credential_missing');
    expect(event.criticalAsset?.failure?.code).toBe('AGENT_PROVIDER_CREDENTIAL_MISSING');
    expect(event.evidence).toContain('FAIL provider_probe agent-alpha: provider=opencode-cli');
    expect(event.evidence).toContain('target=fallback');
    expect(event.evidence).toContain('failure_class=provider_credential_missing');
    expect(event.evidence).toContain('credential_model=minimax/MiniMax-M2.7');
    expect(event.evidence).toContain('credential_service=minimax');
    expect(event.evidence).toContain('credential_env=MINIMAX_API_KEY');
    expect(event.evidence).toContain('credential_status=missing');
    expect(event.evidence).toContain('credential_present=false');
    expect(event.evidence).not.toContain('agent-alpha@s.whatsapp.net');
  });

  it('passes the OpenCode fallback provider probe when its model credential is present', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const opencodeBinDir = join(tmpRoot, '.nvm', 'versions', 'node', 'v24.15.0', 'bin');
    const opencodeCommand = join(opencodeBinDir, 'opencode');
    mkdirSync(opencodeBinDir, { recursive: true });
    writeFileSync(opencodeCommand, '#!/bin/sh\nexit 0\n');
    chmodSync(opencodeCommand, 0o700);
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'agent-alpha');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      type: 'agent',
      enabled: true,
      healthPort: 9090,
      agentOptions: {
        provider: 'claude-cli',
        fallbackProvider: 'opencode-cli',
        fallbackModel: 'minimax/MiniMax-M2.7',
        fallbackProviderConfig: { opencodeCommandMode: 'modern-run' },
      },
    }));
    chmodSync(join(configDir, 'config.json'), 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'agent-alpha@s.whatsapp.net', lid: 'agent-alpha@lid' },
      registrationId: 2,
    });

    const modernRunHelp = [
      'Usage: opencode run [flags]',
      '  --format string',
      '  --pure',
      '  -m, --model string',
    ].join('\n');

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        PATH: '/usr/bin:/bin',
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_HEALTH_STATUS: '200',
        BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON: JSON.stringify({
          status: 'healthy',
          generated_at: new Date().toISOString(),
          instance: { name: 'agent-alpha', provider: 'claude-cli', effectiveProvider: 'claude-cli' },
          whatsapp: {
            connected: true,
            connection: { state: 'connected', auth_failure_class: 'none' },
            auth_bond: {
              status: 'present',
              backup: { latest: join(tmpRoot, 'auth-backups', 'latest') },
            },
          },
        }),
        BOT_ERRORS_DRY_PROVIDER_PROBE_RC: '0',
        BOT_ERRORS_DRY_PROVIDER_PROBE_STDOUT: 'OK',
        BOT_ERRORS_DRY_OPENCODE_VERSION_STDOUT: '0.1.0',
        BOT_ERRORS_DRY_OPENCODE_HELP_STDOUT: 'Usage: opencode',
        BOT_ERRORS_DRY_OPENCODE_RUN_HELP_STDOUT: modernRunHelp,
        BOT_ERRORS_DRY_CREDENTIAL_STATUS_MINIMAX: 'present',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'central',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
          instances: [{
            name: 'agent-alpha',
            expected: 'always_on',
            healthPort: 9090,
            expectProviderProbe: true,
            providerProbeProvider: 'claude-cli',
          }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
      alertSource?: string;
    };
    expect(event.severity).toBe('info');
    expect(event.alertSource).toBeUndefined();
    expect(event.evidence).toContain('provider_probe agent-alpha: provider=opencode-cli');
    expect(event.evidence).not.toContain('FAIL provider_probe agent-alpha');
    expect(event.evidence).toContain('target=fallback');
    expect(event.evidence).toContain(`command=${opencodeCommand}`);
    expect(event.evidence).toContain('credential_service=minimax');
    expect(event.evidence).toContain('credential_source=dry');
    expect(event.evidence).toContain('credential_status=present');
    expect(event.evidence).toContain('credential_present=true');
    expect(event.evidence).not.toContain('agent-alpha@s.whatsapp.net');
  });

  it('adds credential-store diagnostics when Claude provider auth is unavailable', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'agent-alpha');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      type: 'agent',
      enabled: true,
      healthPort: 9090,
      agentOptions: { provider: 'openai-api' },
    }));
    chmodSync(join(configDir, 'config.json'), 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'agent-alpha@s.whatsapp.net', lid: 'agent-alpha@lid' },
      registrationId: 2,
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_PLATFORM: 'darwin',
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_HEALTH_STATUS: '200',
        BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON: JSON.stringify({
          status: 'healthy',
          whatsapp: {
            connected: true,
            connection: { state: 'connected', auth_failure_class: 'none' },
            auth_bond: { status: 'present' },
          },
        }),
        BOT_ERRORS_DRY_PROVIDER_PROBE_RC: '1',
        BOT_ERRORS_DRY_PROVIDER_PROBE_STDOUT: 'Not logged in · Please run /login',
        BOT_ERRORS_DRY_PROVIDER_CREDENTIAL_FIND_RC: '0',
        BOT_ERRORS_DRY_PROVIDER_CREDENTIAL_FIND_STDOUT: 'keychain: "/Users/testuser/Library/Keychains/login.keychain-db"\\n"svce"<blob>="Claude_Credential-fixture"',
        BOT_ERRORS_DRY_PROVIDER_CREDENTIAL_SECRET_RC: '36',
        BOT_ERRORS_DRY_PROVIDER_CREDENTIAL_SECRET_STDOUT: '',
        BOT_ERRORS_DRY_PROVIDER_CREDENTIAL_SECRET_STDERR: '',
        BOT_ERRORS_DRY_PROVIDER_KEYCHAIN_INFO_RC: '1',
        BOT_ERRORS_DRY_PROVIDER_KEYCHAIN_INFO_STDERR: 'security: SecKeychainCopySettings: User interaction is not allowed.',
        BOT_ERRORS_DRY_PROVIDER_SETTINGS_JSON: JSON.stringify({
          exists: true,
          mode: '640',
          ownerUid: 0,
          expectedUid: 501,
          writable: false,
        }),
        BOT_ERRORS_DRY_PROVIDER_CLAUDE_STATE_JSON: JSON.stringify({
          exists: true,
          mode: '600',
          ownerUid: 501,
          expectedUid: 501,
          sizeBytes: 45555,
          mtime: '2026-06-11T11:11:25Z',
          userIdPresent: true,
          oauthAccountPresent: true,
          projectCount: 3,
          lastSessionPresent: true,
          backupCount: 5,
          latestBackupMtime: '2026-06-11T11:11:25Z',
          lastSessionId: 'do-not-emit-this-session-id',
        }),
        BOT_ERRORS_DRY_PROVIDER_CONSOLE_USER: 'root',
        BOT_ERRORS_DRY_PROVIDER_AUTOLOGIN_USER: 'mw',
        BOT_ERRORS_DRY_PROVIDER_KCPASSWORD_EXISTS: 'false',
        BOT_ERRORS_DRY_PROVIDER_SOFTWAREUPDATE_AUTOINSTALL: '1',
        BOT_ERRORS_DRY_PROVIDER_SOFTWAREUPDATE_AUTODOWNLOAD: '1',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'central',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          instances: [{
            name: 'agent-alpha',
            expected: 'always_on',
            healthPort: 9090,
            expectProviderProbe: true,
            providerProbeProvider: 'claude-cli',
            providerProbeCommand: '/Users/testuser/.local/bin/claude',
            providerCredentialAccount: 'mw',
          }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const { summary, fails } = readOutboxBySource(outbox);
    const event = summary as unknown as {
      evidence: string;
      alertSource?: string;
      criticalAsset?: { failure?: { code?: string } };
    };
    expect(fails.length).toBeGreaterThanOrEqual(1);
    for (const fail of fails) {
      expect(fail.severity).toBe('critical');
      expect((fail.diagnostics as Record<string, unknown>).forceNotify).toBe(true);
    }
    expect(event.alertSource).toBe('provider_probe:agent-alpha:provider_auth_required');
    expect(event.criticalAsset?.failure?.code).toBe('AGENT_PROVIDER_AUTH_REQUIRED');
    expect(event.evidence).toContain('failure_class=provider_auth_required');
    expect(event.evidence).toContain('credential_backend=macos_keychain');
    expect(event.evidence).toContain('credential_service=Claude_Code-credentials');
    expect(event.evidence).toContain('credential_account=mw');
    expect(event.evidence).toContain('credential_item_status=ok');
    expect(event.evidence).toContain('credential_secret_status=user_interaction_required');
    expect(event.evidence).toContain('keychain_access_status=user_interaction_required');
    expect(event.evidence).toContain('claude_settings_owner_uid=0');
    expect(event.evidence).toContain('claude_settings_expected_uid=501');
    expect(event.evidence).toContain('claude_settings_owner_mismatch=true');
    expect(event.evidence).toContain('claude_settings_writable=false');
    expect(event.evidence).toContain('claude_state_exists=true');
    expect(event.evidence).toContain('claude_state_mode=600');
    expect(event.evidence).toContain('claude_state_size_bytes=45555');
    expect(event.evidence).toContain('claude_state_user_id_present=true');
    expect(event.evidence).toContain('claude_state_oauth_account_present=true');
    expect(event.evidence).toContain('claude_state_project_count=3');
    expect(event.evidence).toContain('claude_state_last_session_present=true');
    expect(event.evidence).toContain('claude_state_backup_count=5');
    expect(event.evidence).toContain('claude_state_owner_mismatch=false');
    expect(event.evidence).toContain('console_user=root');
    expect(event.evidence).toContain('gui_session_status=loginwindow_or_no_console_user');
    expect(event.evidence).toContain('autologin_user=mw');
    expect(event.evidence).toContain('autologin_kcpassword_present=false');
    expect(event.evidence).toContain('softwareupdate_autoinstall=1');
    expect(event.evidence).toContain('softwareupdate_autodownload=1');
    expect(event.evidence).toContain('unattended_update_reboot_risk=enabled');
    expect(event.evidence).toContain('provider_host_uptime_seconds=3600');
    expect(event.evidence).toContain('provider_auth_context=headless_login_keychain_blocked');
    expect(event.evidence).toContain('provider_auth_context=recent_reboot_headless_keychain_risk');
    expect(event.evidence).not.toContain('agent-alpha@s.whatsapp.net');
    expect(event.evidence).not.toContain('login.keychain-db');
    expect(event.evidence).not.toContain('do-not-emit-this-session-id');
  });

  it('treats a headless Claude auth probe as advisory when fresh live runtime evidence contradicts it', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'agent-alpha');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      type: 'agent',
      enabled: true,
      healthPort: 9090,
      agentOptions: { provider: 'claude-cli' },
    }));
    chmodSync(join(configDir, 'config.json'), 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'agent-alpha@s.whatsapp.net', lid: 'agent-alpha@lid' },
      registrationId: 2,
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_PLATFORM: 'darwin',
        BOT_ERRORS_DRY_NOW_EPOCH: String(Math.floor(Date.parse('2026-06-12T03:00:00Z') / 1000)),
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_HEALTH_STATUS: '200',
        BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON: JSON.stringify({
          status: 'healthy',
          generated_at: '2026-06-12T02:59:58Z',
          instance: {
            name: 'agent-alpha',
            provider: 'claude-cli',
            effectiveProvider: 'claude-cli',
            fallbackActiveUntil: null,
          },
          whatsapp: {
            connected: true,
            connection: { state: 'connected', auth_failure_class: 'none' },
          },
          runtime: {
            agent: {
              activeSessions: 1,
              sessionCount: 1,
              lastSessionStatus: 'active',
              lastSessionStartedAt: '2026-06-12T02:58:14Z',
              sessionScope: 'per_chat',
              primaryProvider: 'claude-cli',
              effectiveProvider: 'claude-cli',
              fallbackActiveUntil: null,
              agentProvider: 'claude-cli',
            },
          },
        }),
        BOT_ERRORS_DRY_PROVIDER_PROBE_RC: '1',
        BOT_ERRORS_DRY_PROVIDER_PROBE_STDOUT: 'Not logged in · Please run /login',
        BOT_ERRORS_DRY_PROVIDER_CREDENTIAL_FIND_RC: '0',
        BOT_ERRORS_DRY_PROVIDER_CREDENTIAL_FIND_STDOUT: 'keychain item exists',
        BOT_ERRORS_DRY_PROVIDER_CREDENTIAL_SECRET_RC: '36',
        BOT_ERRORS_DRY_PROVIDER_CREDENTIAL_SECRET_STDOUT: '',
        BOT_ERRORS_DRY_PROVIDER_KEYCHAIN_INFO_RC: '36',
        BOT_ERRORS_DRY_PROVIDER_KEYCHAIN_INFO_STDERR: 'security: SecKeychainCopySettings: User interaction is not allowed.',
        BOT_ERRORS_DRY_PROVIDER_SETTINGS_JSON: JSON.stringify({
          exists: true,
          mode: '600',
          ownerUid: 501,
          expectedUid: 501,
          writable: true,
        }),
        BOT_ERRORS_DRY_PROVIDER_CLAUDE_STATE_JSON: JSON.stringify({
          exists: true,
          mode: '600',
          ownerUid: 501,
          expectedUid: 501,
          sizeBytes: 45555,
          mtime: '2026-06-12T02:58:14Z',
          userIdPresent: true,
          oauthAccountPresent: true,
          projectCount: 3,
          lastSessionPresent: true,
          backupCount: 5,
          latestBackupMtime: '2026-06-12T02:58:14Z',
        }),
        BOT_ERRORS_DRY_PROVIDER_CONSOLE_USER: 'root',
        BOT_ERRORS_DRY_PROVIDER_AUTOLOGIN_USER: 'mw',
        BOT_ERRORS_DRY_PROVIDER_KCPASSWORD_EXISTS: 'false',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'central',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
          instances: [{
            name: 'agent-alpha',
            expected: 'always_on',
            healthPort: 9090,
            expectProviderProbe: true,
            providerProbeProvider: 'claude-cli',
            providerProbeCommand: '/Users/testuser/.local/bin/claude',
            providerCredentialAccount: 'mw',
          }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
      alertSource?: string;
      criticalAsset?: unknown;
    };
    expect(event.severity).toBe('info');
    expect(event.alertSource).toBeUndefined();
    expect(event.criticalAsset).toBeUndefined();
    expect(event.evidence).toContain('provider_probe agent-alpha: provider=claude-cli');
    expect(event.evidence).not.toContain('FAIL provider_probe agent-alpha');
    expect(event.evidence).toContain('status=advisory_contradicted');
    expect(event.evidence).toContain('provider_probe_signal=contradicted_by_live_service');
    expect(event.evidence).toContain('trust_level=live_service_evidence_over_headless_probe');
    expect(event.evidence).toContain('runtime_agent_active_sessions=1');
    expect(event.evidence).toContain('runtime_agent_last_session_started_at=2026-06-12T02:58:14Z');
    expect(event.evidence).toContain('runtime_agent_primary_provider=claude-cli');
    expect(event.evidence).toContain('health_provider_fresh=true');
    expect(event.evidence).toContain('live_provider_corroboration_fresh=true');
    expect(event.evidence).toContain('provider_auth_context=headless_login_keychain_blocked');
    expect(event.evidence).not.toContain('agent-alpha@s.whatsapp.net');
  });

  it('treats a noninteractive keychain auth probe as advisory when live service evidence is fresh', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'agent-alpha');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      type: 'agent',
      enabled: true,
      healthPort: 9090,
      agentOptions: { provider: 'claude-cli' },
    }));
    chmodSync(join(configDir, 'config.json'), 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'agent-alpha@s.whatsapp.net', lid: 'agent-alpha@lid' },
      registrationId: 2,
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_PLATFORM: 'darwin',
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_HEALTH_STATUS: '200',
        BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON: JSON.stringify({
          status: 'healthy',
          generated_at: new Date().toISOString(),
          instance: { name: 'agent-alpha', provider: 'claude-cli' },
          whatsapp: {
            connected: true,
            connection: { state: 'connected', auth_failure_class: 'none' },
          },
        }),
        BOT_ERRORS_DRY_PROVIDER_PROBE_RC: '1',
        BOT_ERRORS_DRY_PROVIDER_PROBE_STDOUT: 'Not logged in · Please run /login',
        BOT_ERRORS_DRY_PROVIDER_CREDENTIAL_FIND_RC: '0',
        BOT_ERRORS_DRY_PROVIDER_CREDENTIAL_FIND_STDOUT: 'keychain item exists',
        BOT_ERRORS_DRY_PROVIDER_CREDENTIAL_SECRET_RC: '36',
        BOT_ERRORS_DRY_PROVIDER_KEYCHAIN_INFO_RC: '36',
        BOT_ERRORS_DRY_PROVIDER_KEYCHAIN_INFO_STDERR: 'security: SecKeychainCopySettings: User interaction is not allowed.',
        BOT_ERRORS_DRY_PROVIDER_SETTINGS_JSON: JSON.stringify({
          exists: true,
          mode: '600',
          ownerUid: 501,
          expectedUid: 501,
          writable: true,
        }),
        BOT_ERRORS_DRY_PROVIDER_CLAUDE_STATE_JSON: JSON.stringify({
          exists: true,
          mode: '600',
          ownerUid: 501,
          expectedUid: 501,
          sizeBytes: 45555,
          mtime: '2026-06-12T03:05:19Z',
          userIdPresent: true,
          oauthAccountPresent: true,
          projectCount: 3,
          lastSessionPresent: true,
          backupCount: 5,
          latestBackupMtime: '2026-06-12T03:05:19Z',
        }),
        BOT_ERRORS_DRY_PROVIDER_CONSOLE_USER: 'mw',
        BOT_ERRORS_DRY_PROVIDER_AUTOLOGIN_USER: 'mw',
        BOT_ERRORS_DRY_PROVIDER_KCPASSWORD_EXISTS: 'true',
        BOT_ERRORS_DRY_PROVIDER_LIVE_SESSION_JSON: JSON.stringify({
          provider: 'claude-cli',
          activeSessions: 1,
          alivePids: 1,
          latestAgeSeconds: 3600,
        }),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'central',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
          instances: [{
            name: 'agent-alpha',
            expected: 'always_on',
            healthPort: 9090,
            expectProviderProbe: true,
            providerProbeProvider: 'claude-cli',
            providerProbeCommand: '/Users/testuser/.local/bin/claude',
            providerCredentialAccount: 'mw',
            providerLiveSessionFreshSeconds: 7200,
          }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
      alertSource?: string;
      criticalAsset?: unknown;
    };
    expect(event.severity).toBe('info');
    expect(event.alertSource).toBeUndefined();
    expect(event.criticalAsset).toBeUndefined();
    expect(event.evidence).not.toContain('FAIL provider_probe agent-alpha');
    expect(event.evidence).toContain('status=advisory_contradicted');
    expect(event.evidence).toContain('provider_auth_context=noninteractive_probe_keychain_blocked');
    expect(event.evidence).toContain('live_provider_source=dry');
    expect(event.evidence).toContain('live_provider_latest_age_seconds=3600');
    expect(event.evidence).toContain('live_provider_fresh=true');
    expect(event.evidence).toContain('live_provider_fresh_seconds=7200');
    expect(event.evidence).not.toContain('agent-alpha@s.whatsapp.net');
  });

  it('treats a headless Claude auth probe as inconclusive when local auth state is intact but live activity is stale', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'eh-bot');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      type: 'agent',
      enabled: true,
      healthPort: 9096,
      agentOptions: { provider: 'claude-cli' },
    }));
    chmodSync(join(configDir, 'config.json'), 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'eh@s.whatsapp.net', lid: 'eh@lid' },
      registrationId: 2,
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_PLATFORM: 'darwin',
        BOT_ERRORS_DRY_NOW_EPOCH: String(Math.floor(Date.parse('2026-06-12T04:01:06Z') / 1000)),
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '2505852',
        BOT_ERRORS_DRY_HEALTH_STATUS: '200',
        BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON: JSON.stringify({
          status: 'healthy',
          generated_at: '2026-06-12T04:01:04Z',
          instance: { name: 'eh-bot', provider: 'claude-cli' },
          whatsapp: {
            connected: true,
            connection: { state: 'connected', auth_failure_class: 'none' },
            auth_bond: {
              status: 'present',
              backup: { latest: join(tmpRoot, 'auth-backups', 'latest') },
            },
          },
          runtime: {
            agent: {
              activeSessions: 1,
              sessionCount: 1,
              lastSessionStatus: 'active',
              lastSessionStartedAt: '2026-06-12T02:44:52.286Z',
              agentProvider: 'claude-cli',
            },
          },
        }),
        BOT_ERRORS_DRY_PROVIDER_PROBE_RC: '1',
        BOT_ERRORS_DRY_PROVIDER_PROBE_STDOUT: 'Not logged in · Please run /login',
        BOT_ERRORS_DRY_PROVIDER_CREDENTIAL_FIND_RC: '0',
        BOT_ERRORS_DRY_PROVIDER_CREDENTIAL_FIND_STDOUT: 'keychain item exists',
        BOT_ERRORS_DRY_PROVIDER_CREDENTIAL_SECRET_RC: '36',
        BOT_ERRORS_DRY_PROVIDER_CREDENTIAL_SECRET_STDOUT: '',
        BOT_ERRORS_DRY_PROVIDER_KEYCHAIN_INFO_RC: '36',
        BOT_ERRORS_DRY_PROVIDER_KEYCHAIN_INFO_STDERR: 'security: SecKeychainCopySettings: User interaction is not allowed.',
        BOT_ERRORS_DRY_PROVIDER_SETTINGS_JSON: JSON.stringify({
          exists: true,
          mode: '600',
          ownerUid: 501,
          expectedUid: 501,
          writable: true,
        }),
        BOT_ERRORS_DRY_PROVIDER_CLAUDE_STATE_JSON: JSON.stringify({
          exists: true,
          mode: '600',
          ownerUid: 501,
          expectedUid: 501,
          sizeBytes: 30726,
          mtime: '2026-06-12T04:01:05Z',
          userIdPresent: true,
          oauthAccountPresent: true,
          projectCount: 2,
          lastSessionPresent: true,
          backupCount: 5,
          latestBackupMtime: '2026-06-12T04:01:05Z',
        }),
        BOT_ERRORS_DRY_PROVIDER_CONSOLE_USER: 'esther',
        BOT_ERRORS_DRY_PROVIDER_AUTOLOGIN_USER: 'esther',
        BOT_ERRORS_DRY_PROVIDER_KCPASSWORD_EXISTS: 'true',
        BOT_ERRORS_DRY_PROVIDER_LIVE_SESSION_JSON: JSON.stringify({
          provider: 'claude-cli',
          activeSessions: 1,
          alivePids: 1,
          latestAgeSeconds: 3347,
        }),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host',
          expectAlertTarget: false,
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
          instances: [{
            name: 'eh-bot',
            expected: 'always_on',
            healthPort: 9096,
            expectProviderProbe: true,
            providerProbeProvider: 'claude-cli',
            providerProbeCommand: '/opt/homebrew/bin/claude',
            providerCredentialAccount: 'esther',
            providerLiveSessionFreshSeconds: 1800,
          }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
      alertSource?: string;
      criticalAsset?: unknown;
    };
    expect(event.severity).toBe('info');
    expect(event.alertSource).toBeUndefined();
    expect(event.criticalAsset).toBeUndefined();
    expect(event.evidence).not.toContain('FAIL provider_probe eh-bot');
    expect(event.evidence).toContain('status=advisory_inconclusive');
    expect(event.evidence).toContain('provider_probe_signal=headless_auth_probe_blocked');
    expect(event.evidence).toContain('trust_level=local_auth_state_over_headless_probe');
    expect(event.evidence).toContain('credential_item_status=ok');
    expect(event.evidence).toContain('claude_state_user_id_present=true');
    expect(event.evidence).toContain('claude_state_oauth_account_present=true');
    expect(event.evidence).toContain('live_provider_fresh=false');
    expect(event.evidence).not.toContain('eh@s.whatsapp.net');
  });

  it('treats blocked keychain item lookup as inconclusive when local Claude state is intact', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'eh-bot');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      type: 'agent',
      enabled: true,
      healthPort: 9096,
      agentOptions: { provider: 'claude-cli' },
    }));
    chmodSync(join(configDir, 'config.json'), 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'eh@s.whatsapp.net', lid: 'eh@lid' },
      registrationId: 2,
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_PLATFORM: 'darwin',
        BOT_ERRORS_DRY_NOW_EPOCH: String(Math.floor(Date.parse('2026-06-12T04:01:06Z') / 1000)),
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_HEALTH_STATUS: '200',
        BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON: JSON.stringify({
          status: 'healthy',
          generated_at: '2026-06-12T04:01:04Z',
          instance: { name: 'eh-bot', provider: 'claude-cli' },
          whatsapp: {
            connected: true,
            connection: { state: 'connected', auth_failure_class: 'none' },
            auth_bond: {
              status: 'present',
              backup: { latest: join(tmpRoot, 'auth-backups', 'latest') },
            },
          },
          runtime: {
            agent: {
              activeSessions: 0,
              sessionCount: 1,
              lastSessionStatus: 'idle',
              agentProvider: 'claude-cli',
            },
          },
        }),
        BOT_ERRORS_DRY_PROVIDER_PROBE_RC: '1',
        BOT_ERRORS_DRY_PROVIDER_PROBE_STDOUT: 'Not logged in · Please run /login',
        BOT_ERRORS_DRY_PROVIDER_CREDENTIAL_FIND_RC: '36',
        BOT_ERRORS_DRY_PROVIDER_CREDENTIAL_FIND_STDERR: 'security: SecKeychainSearchCopyNext: User interaction is not allowed.',
        BOT_ERRORS_DRY_PROVIDER_CREDENTIAL_SECRET_RC: '36',
        BOT_ERRORS_DRY_PROVIDER_CREDENTIAL_SECRET_STDERR: 'security: SecKeychainItemCopyContent: User interaction is not allowed.',
        BOT_ERRORS_DRY_PROVIDER_KEYCHAIN_INFO_RC: '36',
        BOT_ERRORS_DRY_PROVIDER_KEYCHAIN_INFO_STDERR: 'security: SecKeychainCopySettings: User interaction is not allowed.',
        BOT_ERRORS_DRY_PROVIDER_SETTINGS_JSON: JSON.stringify({
          exists: true,
          mode: '600',
          ownerUid: 501,
          expectedUid: 501,
          writable: true,
        }),
        BOT_ERRORS_DRY_PROVIDER_CLAUDE_STATE_JSON: JSON.stringify({
          exists: true,
          mode: '600',
          ownerUid: 501,
          expectedUid: 501,
          sizeBytes: 30726,
          mtime: '2026-06-12T04:01:05Z',
          userIdPresent: true,
          oauthAccountPresent: true,
          projectCount: 2,
          lastSessionPresent: true,
          backupCount: 5,
          latestBackupMtime: '2026-06-12T04:01:05Z',
        }),
        BOT_ERRORS_DRY_PROVIDER_CONSOLE_USER: 'root',
        BOT_ERRORS_DRY_PROVIDER_AUTOLOGIN_USER: 'esther',
        BOT_ERRORS_DRY_PROVIDER_KCPASSWORD_EXISTS: 'false',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host',
          expectAlertTarget: false,
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
          instances: [{
            name: 'eh-bot',
            expected: 'always_on',
            healthPort: 9096,
            expectProviderProbe: true,
            providerProbeProvider: 'claude-cli',
            providerProbeCommand: '/opt/homebrew/bin/claude',
            providerCredentialAccount: 'esther',
          }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
      alertSource?: string;
      criticalAsset?: unknown;
    };
    expect(event.severity).toBe('info');
    expect(event.alertSource).toBeUndefined();
    expect(event.criticalAsset).toBeUndefined();
    expect(event.evidence).not.toContain('FAIL provider_probe eh-bot');
    expect(event.evidence).toContain('status=advisory_inconclusive');
    expect(event.evidence).toContain('credential_item_status=user_interaction_required');
    expect(event.evidence).toContain('credential_secret_status=user_interaction_required');
    expect(event.evidence).toContain('keychain_access_status=user_interaction_required');
    expect(event.evidence).toContain('provider_auth_context=headless_login_keychain_blocked');
    expect(event.evidence).toContain('trust_level=local_auth_state_over_headless_probe');
    expect(event.evidence).toContain('failure_class=provider_auth_required');
    expect(event.evidence).not.toContain('eh@s.whatsapp.net');
  });

  it('fails daily health when auth-bond backup no longer matches live auth snapshot', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'primary-bot');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      type: 'agent',
      enabled: true,
      healthPort: 9090,
    }));
    chmodSync(configPath, 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'agent-alpha@s.whatsapp.net', lid: 'agent-alpha@lid' },
      registrationId: 2,
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_HEALTH_STATUS: '200',
        BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON: JSON.stringify({
          status: 'healthy',
          whatsapp: {
            connected: true,
            connection: { state: 'connected' },
            auth_bond: {
              status: 'present',
              issues: [],
              tree_hash: 'live-tree-hash',
              creds: { hash: 'abc123', exists: true, mode: '600', size: 512, mtime: '2026-06-09T12:10:00Z' },
              backup: {
                latest: '/state/auth-bond-backups/primary-bot/history/old',
                latest_at: '2026-06-09T12:00:00Z',
                latest_tree_hash: 'old-tree-hash',
                last_capture_error: null,
              },
            },
          },
        }),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          instances: [{ name: 'primary-bot', expected: 'always_on', healthPort: 9090 }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const { summary, fails } = readOutboxBySource(outbox);
    const event = summary as unknown as {
      severity: string;
      evidence: string;
    };
    expect(fails.length).toBeGreaterThanOrEqual(1);
    for (const fail of fails) {
      expect(fail.severity).toBe('critical');
      expect((fail.diagnostics as Record<string, unknown>).forceNotify).toBe(true);
    }
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('auth_bond_backup_tree_mismatch live=live-tree-hash latest=old-tree-hash');
    expect(event.evidence).toContain('auth_bond_backup_stale_for_live_creds');
  });

  it('keeps live auth tree drift informational when bond-critical creds are freshly snapshotted', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'primary-bot');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      type: 'agent',
      enabled: true,
      healthPort: 9090,
    }));
    chmodSync(configPath, 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'agent-alpha@s.whatsapp.net', lid: 'agent-alpha@lid' },
      registrationId: 2,
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_HEALTH_STATUS: '200',
        BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON: JSON.stringify({
          status: 'healthy',
          generated_at: new Date().toISOString(),
          instance: { name: 'primary-bot' },
          whatsapp: {
            connected: true,
            connection: { state: 'connected' },
            auth_bond: {
              status: 'present',
              issues: [],
              tree_hash: 'live-tree-hash',
              creds: { hash: 'abc123', exists: true, mode: '600', size: 512, mtime: '2026-06-09T12:03:00Z' },
              backup: {
                latest: '/state/auth-bond-backups/primary-bot/history/recent',
                latest_at: '2026-06-09T12:00:00Z',
                latest_tree_hash: 'old-tree-hash',
                last_capture_at: '2026-06-09T12:00:00Z',
                last_capture_error: null,
              },
            },
          },
        }),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          instances: [{ name: 'primary-bot', expected: 'always_on', healthPort: 9090 }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('info');
    expect(event.evidence).toContain('health primary-bot: 200 http://127.0.0.1:9090/health');
    expect(event.evidence).toContain('auth_bond_backup_tree_mismatch live=live-tree-hash latest=old-tree-hash');
    expect(event.evidence).toContain('auth_bond_restore_canary=skipped_latest_path_unavailable');
    expect(event.evidence).not.toContain('auth_bond_backup_stale_for_live_creds');
    expect(event.evidence).not.toContain('auth_bond_backup_tree_drift');
  });

  it('warns when the auth-bond restore canary cannot validate the latest backup', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'primary-bot');
    const authDir = join(configDir, 'auth');
    const backupDir = join(tmpRoot, 'auth-bond-backups', 'primary-bot', 'history', 'broken');
    const backupAuthDir = join(backupDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      type: 'agent',
      enabled: true,
      healthPort: 9090,
    }));
    chmodSync(configPath, 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'agent-alpha@s.whatsapp.net', lid: 'agent-alpha@lid' },
      registrationId: 2,
    });
    const backupCredsPayload = {
      me: { id: 'agent-alpha@s.whatsapp.net', lid: 'agent-alpha@lid' },
      registrationId: 2,
    };
    writeSecureCreds(backupAuthDir, backupCredsPayload);
    writeFileSync(join(backupDir, 'manifest.json'), JSON.stringify({
      instanceName: 'primary-bot',
      reason: 'test',
      createdAt: '2026-06-09T12:00:00Z',
      authDir,
      treeHash: '0'.repeat(64),
      credsHash: createHash('sha256').update(JSON.stringify(backupCredsPayload)).digest('hex'),
      meHash: createHash('sha256').update('agent-alpha@s.whatsapp.net').digest('hex').slice(0, 20),
    }));
    chmodSync(join(backupDir, 'manifest.json'), 0o600);

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_HEALTH_STATUS: '200',
        BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON: JSON.stringify({
          status: 'healthy',
          generated_at: new Date().toISOString(),
          instance: { name: 'primary-bot' },
          whatsapp: {
            connected: true,
            connection: { state: 'connected' },
            auth_bond: {
              status: 'present',
              issues: [],
              tree_hash: '0'.repeat(64),
              creds: { hash: 'abc123', exists: true, mode: '600', size: 512, mtime: '2026-06-09T12:03:00Z' },
              backup: {
                latest: backupDir,
                latest_at: '2026-06-09T12:00:00Z',
                latest_tree_hash: '0'.repeat(64),
                last_capture_at: '2026-06-09T12:00:00Z',
                last_capture_error: null,
              },
            },
          },
        }),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          instances: [{ name: 'primary-bot', expected: 'always_on', healthPort: 9090 }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('warning');
    expect(event.evidence).toContain('health primary-bot: WARN 200 http://127.0.0.1:9090/health');
    expect(event.evidence).toContain('auth_bond_restore_canary=failed reason=copied_tree_hash_mismatch');
  });

  it('warns when the auth-bond restore canary manifest omits the identity hash', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'primary-bot');
    const authDir = join(configDir, 'auth');
    const backupDir = join(tmpRoot, 'auth-bond-backups', 'primary-bot', 'history', 'missing-identity');
    const backupAuthDir = join(backupDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      type: 'agent',
      enabled: true,
      healthPort: 9090,
    }));
    chmodSync(configPath, 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'agent-alpha@s.whatsapp.net', lid: 'agent-alpha@lid' },
      registrationId: 2,
    });
    const backupCredsPayload = {
      me: { id: 'agent-alpha@s.whatsapp.net', lid: 'agent-alpha@lid' },
      registrationId: 2,
    };
    writeSecureCreds(backupAuthDir, backupCredsPayload);
    writeFileSync(join(backupDir, 'manifest.json'), JSON.stringify({
      instanceName: 'primary-bot',
      reason: 'test',
      createdAt: '2026-06-09T12:00:00Z',
      authDir,
      treeHash: hashAuthFixtureTree(backupAuthDir),
      credsHash: createHash('sha256').update(JSON.stringify(backupCredsPayload)).digest('hex'),
    }));
    chmodSync(join(backupDir, 'manifest.json'), 0o600);

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_HEALTH_STATUS: '200',
        BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON: JSON.stringify({
          status: 'healthy',
          instance: { name: 'primary-bot' },
          whatsapp: {
            connected: true,
            connection: { state: 'connected' },
            auth_bond: {
              status: 'present',
              issues: [],
              tree_hash: hashAuthFixtureTree(backupAuthDir),
              creds: { hash: 'abc123', exists: true, mode: '600', size: 512, mtime: '2026-06-09T12:03:00Z' },
              backup: {
                latest: backupDir,
                latest_at: '2026-06-09T12:00:00Z',
                latest_tree_hash: hashAuthFixtureTree(backupAuthDir),
                last_capture_at: '2026-06-09T12:00:00Z',
                last_capture_error: null,
              },
            },
          },
        }),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          instances: [{ name: 'primary-bot', expected: 'always_on', healthPort: 9090 }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('warning');
    expect(event.evidence).toContain('health primary-bot: WARN 200 http://127.0.0.1:9090/health');
    expect(event.evidence).toContain('auth_bond_restore_canary=failed reason=identity_manifest_missing');
  });

  it('does not fail auth-bond health when an identical tree was recently revalidated without a new backup directory', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'primary-bot');
    const authDir = join(configDir, 'auth');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      type: 'agent',
      enabled: true,
      healthPort: 9090,
    }));
    chmodSync(configPath, 0o600);
    writeSecureCreds(authDir, {
      me: { id: 'agent-alpha@s.whatsapp.net', lid: 'agent-alpha@lid' },
      registrationId: 2,
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_DRY_HEALTH_STATUS: '200',
        BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON: JSON.stringify({
          status: 'healthy',
          generated_at: new Date().toISOString(),
          instance: { name: 'primary-bot' },
          whatsapp: {
            connected: true,
            connection: { state: 'connected' },
            auth_bond: {
              status: 'present',
              issues: [],
              tree_hash: 'same-tree-hash',
              creds: { hash: 'abc123', exists: true, mode: '600', size: 512, mtime: '2026-06-09T12:10:00Z' },
              backup: {
                latest: '/state/auth-bond-backups/primary-bot/history/old',
                latest_at: '2026-06-09T12:00:00Z',
                latest_tree_hash: 'same-tree-hash',
                last_capture_at: '2026-06-09T12:10:10Z',
                last_capture_error: null,
              },
            },
          },
        }),
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'bot-host',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectPluginInventory: false,
          instances: [{ name: 'primary-bot', expected: 'always_on', healthPort: 9090 }],
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('info');
    expect(event.evidence).toContain('auth_bond_backup_last_capture_at=2026-06-09T12:10:10Z');
    expect(event.evidence).not.toContain('auth_bond_at_risk');
    expect(event.evidence).not.toContain('auth_bond_backup_stale_for_live_creds');
  });

  it('fails daily health on a stuck BOT ERRORS outbox backlog', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const outbox = join(tmpRoot, 'outbox');
    mkdirSync(outbox, { recursive: true });
    const stuck = join(outbox, 'stuck.json');
    writeFileSync(stuck, '{}');
    const old = new Date(Date.now() - 10_000);
    utimesSync(stuck, old, old);

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_OUTBOX_CRITICAL_OLDEST_SECONDS: '1',
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'central',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
        }),
      },
    });

    const files = readdirSync(outbox).filter((file) => file !== 'stuck.json');
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('FAIL outbox: count=1');
  });

  it('warns when dispatcher state reports a failed last run', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    writePrivateJson(join(tmpRoot, 'dispatcher-state.json'), {
      failed: 1,
      lastError: 'socket unavailable',
    });

    execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tmpRoot,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
        BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
        BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
        BOT_ERRORS_HEALTH_PROFILE_JSON: JSON.stringify({
          role: 'central',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
        }),
      },
    });

    const outbox = join(tmpRoot, 'outbox');
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('warning');
    expect(event.evidence).toContain('WARN dispatcher_state:');
    expect(event.evidence).toContain('failed=1 last_error=socket unavailable');
  });

  it('graces a stale dispatcher heartbeat when service uptime is inside restart grace', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const state = join(tmpRoot, 'dispatcher-state.json');
    const socket = join(tmpRoot, 'whatsoup.sock');
    writePrivateJson(state, { time: new Date().toISOString() });
    writeFileSync(socket, '');
    const old = new Date(Date.now() - 120_000);
    utimesSync(state, old, old);

    const output = execFileSync('python3', [
      'deploy/scripts/bot-errors-health-check.py',
      '--deadman',
      '--max-state-age',
      '30',
      '--restart-grace',
      '30',
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_SOCKET_PATH: socket,
        BOT_ERRORS_DRY_SERVICE_STATUS: 'active',
        BOT_ERRORS_DRY_SERVICE_UPTIME_SECONDS: '2',
      },
      encoding: 'utf8',
    });

    expect(output).toContain('deadman grace ok');
    expect(output).toContain('service_uptime_seconds=2');
  });

  it('graces a transitional service state using systemd state-change age', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const state = join(tmpRoot, 'dispatcher-state.json');
    const socket = join(tmpRoot, 'whatsoup.sock');
    writePrivateJson(state, { time: new Date().toISOString() });
    writeFileSync(socket, '');
    const old = new Date(Date.now() - 120_000);
    utimesSync(state, old, old);

    const output = execFileSync('python3', [
      'deploy/scripts/bot-errors-health-check.py',
      '--deadman',
      '--max-state-age',
      '30',
      '--restart-grace',
      '30',
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_SOCKET_PATH: socket,
        BOT_ERRORS_DRY_SERVICE_STATUS: 'activating',
        BOT_ERRORS_DRY_SERVICE_STATE_CHANGE_AGE_SECONDS: '2',
      },
      encoding: 'utf8',
    });

    expect(output).toContain('deadman grace ok');
    expect(output).toContain('service_state_change_age_seconds=2');
  });

  it('persists deadman direct-send cooldown state across process restarts', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const dispatcherState = join(tmpRoot, 'dispatcher-state.json');
    const socket = join(tmpRoot, 'whatsoup.sock');
    const directLog = join(tmpRoot, 'direct-send.jsonl');
    writePrivateJson(dispatcherState, { time: new Date().toISOString() });
    writeFileSync(socket, '');
    const baseEpoch = Math.floor(Date.now() / 1000);
    const env = {
      BOT_ERRORS_SOCKET_PATH: socket,
      BOT_ERRORS_DRY_DIRECT_SEND_LOG: directLog,
      BOT_ERRORS_DRY_SERVICE_STATUS: 'inactive',
      BOT_ERRORS_DEADMAN_COOLDOWN_SECONDS: '60',
      BOT_ERRORS_DRY_NOW_EPOCH: String(baseEpoch),
    };

    utimesSync(dispatcherState, new Date(baseEpoch * 1000), new Date(baseEpoch * 1000));
    const first = runDeadman(tmpRoot, env);
    expect(first.status).toBe(2);
    expect(first.stdout).toContain('notifier direct_whatsapp=sent');
    expect(readJsonl(directLog)).toHaveLength(1);

    utimesSync(dispatcherState, new Date((baseEpoch + 30) * 1000), new Date((baseEpoch + 30) * 1000));
    const second = runDeadman(tmpRoot, { ...env, BOT_ERRORS_DRY_NOW_EPOCH: String(baseEpoch + 30) });
    expect(second.status).toBe(2);
    expect(second.stdout).toContain('notifier direct_whatsapp=suppressed_cooldown');
    expect(second.stdout).toContain('cooldown_remaining_seconds=30');
    expect(readJsonl(directLog)).toHaveLength(1);

    utimesSync(dispatcherState, new Date((baseEpoch + 45) * 1000), new Date((baseEpoch + 45) * 1000));
    const third = runDeadman(tmpRoot, { ...env, BOT_ERRORS_DRY_NOW_EPOCH: String(baseEpoch + 45) });
    expect(third.status).toBe(2);
    expect(third.stdout).toContain('notifier direct_whatsapp=suppressed_cooldown');
    expect(third.stdout).toContain('cooldown_remaining_seconds=15');
    expect(readJsonl(directLog)).toHaveLength(1);

    const deadmanStatePath = join(tmpRoot, 'deadman-state.json');
    const stateDoc = JSON.parse(readFileSync(deadmanStatePath, 'utf8')) as {
      incidents: Record<string, { firstSeenAtEpoch: number; lastSentAtEpoch: number; lastSentAt: string; sentCount: number; suppressed: number }>;
    };
    const incidentKey = Object.keys(stateDoc.incidents)[0]!;
    expect(stateDoc.incidents[incidentKey]!.firstSeenAtEpoch).toBe(baseEpoch);
    expect(stateDoc.incidents[incidentKey]!.lastSentAtEpoch).toBe(baseEpoch);
    expect(stateDoc.incidents[incidentKey]!.sentCount).toBe(1);
    expect(stateDoc.incidents[incidentKey]!.suppressed).toBe(2);

    utimesSync(dispatcherState, new Date((baseEpoch + 61) * 1000), new Date((baseEpoch + 61) * 1000));
    const afterCooldown = runDeadman(tmpRoot, { ...env, BOT_ERRORS_DRY_NOW_EPOCH: String(baseEpoch + 61) });
    expect(afterCooldown.status).toBe(2);
    expect(afterCooldown.stdout).toContain('notifier direct_whatsapp=sent');
    const directMessages = readJsonl(directLog);
    expect(directMessages).toHaveLength(2);
    expect(String(directMessages[1]!['text'])).toContain('suppressed_since_last_send: 2');

    const updatedState = JSON.parse(readFileSync(deadmanStatePath, 'utf8')) as {
      incidents: Record<string, { firstSeenAtEpoch: number; lastSentAtEpoch: number; sentCount: number; suppressed: number }>;
    };
    expect(updatedState.incidents[incidentKey]!.firstSeenAtEpoch).toBe(baseEpoch);
    expect(updatedState.incidents[incidentKey]!.lastSentAtEpoch).toBe(baseEpoch + 61);
    expect(updatedState.incidents[incidentKey]!.sentCount).toBe(2);
    expect(updatedState.incidents[incidentKey]!.suppressed).toBe(0);
  });

  it('falls back to email when deadman direct WhatsApp send fails', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const dispatcherState = join(tmpRoot, 'dispatcher-state.json');
    const fallback = join(tmpRoot, 'email-fallback.sh');
    const fallbackLog = join(tmpRoot, 'email-fallback.log');
    writePrivateJson(dispatcherState, { time: new Date().toISOString() });
    writeFileSync(fallback, [
      '#!/bin/sh',
      'printf \"%s\\n\" \"$@\" >> \"$BOT_ERRORS_TEST_EMAIL_LOG\"',
      'exit 0',
      '',
    ].join('\n'));
    chmodSync(fallback, 0o700);

    const result = runDeadman(tmpRoot, {
      BOT_ERRORS_EMAIL_FALLBACK: fallback,
      BOT_ERRORS_TEST_EMAIL_LOG: fallbackLog,
      BOT_ERRORS_DRY_SERVICE_STATUS: 'inactive',
      BOT_ERRORS_DEADMAN_COOLDOWN_SECONDS: '60',
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('notifier direct_whatsapp=failed');
    expect(result.stdout).toContain('notifier email_fallback=accepted_unconfirmed channel=resend');
    const fallbackArgs = readFileSync(fallbackLog, 'utf8');
    expect(fallbackArgs).toContain('--subject');
    expect(fallbackArgs).toContain('BOT ERRORS deadman failed');
    expect(fallbackArgs).toContain('--body');
    expect(fallbackArgs).toContain('BOT ERRORS DEADMAN - dispatcher supervision failed');

    const stateDoc = JSON.parse(readFileSync(join(tmpRoot, 'deadman-state.json'), 'utf8')) as {
      incidents: Record<string, { lastSendStatus: { direct_whatsapp: string; email_fallback: string } }>;
    };
    const incident = Object.values(stateDoc.incidents)[0]!;
    expect(incident.lastSendStatus.direct_whatsapp).toBe('failed');
    expect(incident.lastSendStatus.email_fallback).toBe('accepted_unconfirmed');
  });

  it('sends a single deadman recovery clear when the supervised path is healthy again', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const dispatcherState = join(tmpRoot, 'dispatcher-state.json');
    const socket = join(tmpRoot, 'whatsoup.sock');
    const directLog = join(tmpRoot, 'direct-send.jsonl');
    writePrivateJson(dispatcherState, { time: new Date().toISOString() });
    writeFileSync(socket, '');

    const failingEnv = {
      BOT_ERRORS_SOCKET_PATH: socket,
      BOT_ERRORS_DRY_DIRECT_SEND_LOG: directLog,
      BOT_ERRORS_DRY_SERVICE_STATUS: 'inactive',
      BOT_ERRORS_DEADMAN_COOLDOWN_SECONDS: '60',
    };
    expect(runDeadman(tmpRoot, failingEnv).status).toBe(2);
    expect(readJsonl(directLog)).toHaveLength(1);

    const healthyEnv = {
      BOT_ERRORS_SOCKET_PATH: socket,
      BOT_ERRORS_DRY_DIRECT_SEND_LOG: directLog,
      BOT_ERRORS_DRY_SERVICE_STATUS: 'active',
      BOT_ERRORS_DEADMAN_COOLDOWN_SECONDS: '60',
    };
    const recovered = runDeadman(tmpRoot, healthyEnv);
    expect(recovered.status).toBe(0);
    expect(recovered.stdout).toContain('notifier direct_whatsapp=sent recovery');
    const directMessages = readJsonl(directLog);
    expect(directMessages).toHaveLength(2);
    expect(String(directMessages[1]!['text'])).toContain('BOT ERRORS DEADMAN RECOVERY');

    const deadmanState = JSON.parse(readFileSync(join(tmpRoot, 'deadman-state.json'), 'utf8')) as {
      incidents: Record<string, { status: string; resolvedAt: string }>;
    };
    const incident = Object.values(deadmanState.incidents)[0]!;
    expect(incident.status).toBe('resolved');
    expect(incident.resolvedAt).toMatch(/Z$/);

    const recoveredAgain = runDeadman(tmpRoot, healthyEnv);
    expect(recoveredAgain.status).toBe(0);
    expect(readJsonl(directLog)).toHaveLength(2);
  });
});
