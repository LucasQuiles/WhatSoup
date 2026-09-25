import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Primary-phone verification policy: a missing record alerts as critical only
// where an operator's private profile escalates that instance, and a
// verification timestamp in the future must never read as fresh.

const NOW = '2026-06-11T00:00:00Z';
const NOW_EPOCH = Math.floor(Date.parse(NOW) / 1000);

let tmpRoot = '';

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

function writePrivate(path: string, payload: unknown): void {
  writeFileSync(path, JSON.stringify(payload));
  chmodSync(path, 0o600);
}

type OutboxEvent = {
  severity: string;
  evidence: string;
  alertSource?: string;
  criticalAsset?: { failure?: { code?: string } };
};

function runDaily(
  instance: Record<string, unknown>,
  stateLastVerifiedAt?: string,
  { profileFile = false }: { profileFile?: boolean } = {},
): OutboxEvent {
  tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-primary-phone-'));
  chmodSync(tmpRoot, 0o700);
  const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'bot-a');
  const authDir = join(configDir, 'auth');
  mkdirSync(authDir, { recursive: true });
  chmodSync(authDir, 0o700);
  writePrivate(join(configDir, 'config.json'), { type: 'agent', enabled: true });
  writePrivate(join(authDir, 'creds.json'), {
    me: { id: 'fixture-self', lid: 'fixture-self-lid' },
    registrationId: 1,
  });
  if (stateLastVerifiedAt) {
    writePrivate(join(tmpRoot, 'primary-phone-verifications.json'), {
      version: 1,
      instances: { 'bot-a': { lastVerifiedAt: stateLastVerifiedAt, owner: 'operator-a' } },
    });
  }
  const profile = {
    role: 'bot-host',
    expectDispatcher: false,
    expectQLoop: false,
    expectPersonalSocket: false,
    expectPersonalTools: false,
    expectPluginInventory: false,
    expectPrimaryPhoneVerification: true,
    instances: [{ name: 'bot-a', expected: 'always_on', primaryPhoneOwner: 'operator-a', ...instance }],
  };
  // profileFile exercises the operator path: a private profile file named by
  // BOT_ERRORS_HEALTH_PROFILE, as the installers bake it into the daily job.
  const profileEnv: Record<string, string> = {};
  if (profileFile) {
    const profilePath = join(tmpRoot, 'health-profile.json');
    writePrivate(profilePath, profile);
    profileEnv.BOT_ERRORS_HEALTH_PROFILE = profilePath;
  } else {
    profileEnv.BOT_ERRORS_HEALTH_PROFILE_JSON = JSON.stringify(profile);
  }
  const inherited = { ...process.env };
  delete inherited.BOT_ERRORS_HEALTH_PROFILE;
  delete inherited.BOT_ERRORS_HEALTH_PROFILE_JSON;
  execFileSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
    cwd: process.cwd(),
    env: {
      ...inherited,
      HOME: tmpRoot,
      BOT_ERRORS_STATE_DIR: tmpRoot,
      BOT_ERRORS_DRY_CLOCK_STATUS: 'synced',
      BOT_ERRORS_DRY_DISK_FREE_BYTES: String(10 * 1024 * 1024 * 1024),
      BOT_ERRORS_DRY_DISK_TOTAL_BYTES: String(100 * 1024 * 1024 * 1024),
      BOT_ERRORS_DRY_UPTIME_SECONDS: '3600',
      BOT_ERRORS_DRY_NOW_EPOCH: String(NOW_EPOCH),
      // Declared service inventory: without it the check asks the host's
      // service manager, and a host with no user systemd session adds an
      // unrelated critical profile-coverage failure to the event.
      BOT_ERRORS_DRY_ACTIVE_WHATSOUP_SERVICES: '',
      ...profileEnv,
    },
  });
  const outbox = join(tmpRoot, 'outbox');
  const files = readdirSync(outbox).filter((name) => name !== '.durable-json.lock');
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as OutboxEvent;
}

function primaryPhoneLine(event: OutboxEvent): string {
  const lines = event.evidence.split('\n').filter((line) => line.includes('primary_phone bot-a:'));
  expect(lines).toHaveLength(1);
  return lines[0]!;
}

function isoAt(offsetSeconds: number): string {
  return new Date((NOW_EPOCH + offsetSeconds) * 1000).toISOString().replace('.000Z', 'Z');
}

describe('primary-phone verification policy', () => {
  it('keeps a missing verification at warning by default', () => {
    const event = runDaily({}, undefined, { profileFile: true });
    const line = primaryPhoneLine(event);
    expect(line).toMatch(/^WARN primary_phone bot-a: owner=operator-a .*verification_unknown/);
    expect(event.criticalAsset?.failure?.code).toBeUndefined();
    expect(event.severity).toBe('warning');
  });

  it('escalates a missing verification to critical when a private profile sets it for the instance', () => {
    const event = runDaily({ primaryPhoneUnknownSeverity: 'critical' }, undefined, { profileFile: true });
    const line = primaryPhoneLine(event);
    expect(line).toMatch(/^FAIL primary_phone bot-a: owner=operator-a .*verification_unknown/);
    expect(event.alertSource).toBe('primary_phone:bot-a');
    expect(event.criticalAsset?.failure?.code).toBe('WA_AUTH_BOND_PRIMARY_PHONE_UNVERIFIED');
    expect(event.severity).toBe('critical');
  });

  it('rejects a state verification more than 300 s in the future instead of reading it as fresh', () => {
    const event = runDaily({}, isoAt(2 * 3600));
    expect(event.severity).toBe('critical');
    expect(event.alertSource).toBe('primary_phone:bot-a');
    expect(event.evidence).toContain('FAIL primary_phone bot-a: owner=operator-a');
    expect(event.evidence).toContain('verification_invalid reason=future_dated');
    expect(event.evidence).toContain('last_verified_source=state');
    expect(event.evidence).not.toContain(' fresh ');
  });

  it('rejects a future-dated profile verification the same way', () => {
    const event = runDaily({ primaryPhoneLastVerifiedAt: isoAt(301) });
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('verification_invalid reason=future_dated');
    expect(event.evidence).toContain('last_verified_source=profile');
  });

  it('still accepts a verification within the 300 s clock-skew allowance', () => {
    const event = runDaily({}, isoAt(300));
    expect(event.evidence).toContain('OK primary_phone bot-a: owner=operator-a');
    expect(event.evidence).toContain('fresh');
    expect(event.evidence).not.toContain('future_dated');
  });
});
