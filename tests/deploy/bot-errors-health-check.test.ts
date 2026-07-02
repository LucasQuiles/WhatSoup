import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

let tmpRoot = '';

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

function writeInstance(name: string, healthPort: number): void {
  const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', name);
  const authDir = join(configDir, 'auth');
  mkdirSync(authDir, { recursive: true });
  chmodSync(authDir, 0o700);
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    type: 'agent',
    enabled: true,
    healthPort,
  }));
  chmodSync(join(configDir, 'config.json'), 0o600);
  writeFileSync(join(authDir, 'creds.json'), JSON.stringify({
    me: { id: 'bot@s.whatsapp.net', lid: 'bot@lid' },
    registrationId: 1,
  }));
  chmodSync(join(authDir, 'creds.json'), 0o600);
}

function readOutboxBySource(): {
  summary: Record<string, unknown>;
  fails: Array<Record<string, unknown>>;
} {
  const outbox = join(tmpRoot, 'outbox');
  const events = readdirSync(outbox).map(
    (name) => JSON.parse(readFileSync(join(outbox, name), 'utf8')) as Record<string, unknown>,
  );
  const summaries = events.filter((event) => event.source === 'daily-health');
  const fails = events.filter((event) => event.source === 'daily-health-fail');
  expect(summaries).toHaveLength(1);
  expect(fails.length + summaries.length).toBe(events.length);
  return { summary: summaries[0]!, fails };
}

describe('bot-errors-health-check daily event classification', () => {
  it('emits linked-device bond loss as a source-specific critical incident even when HTTP status is 200', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    writeInstance('line-alpha', 9090);

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
        BOT_ERRORS_DRY_ACTIVE_WHATSOUP_SERVICES: '',
        BOT_ERRORS_DRY_HEALTH_STATUS: '200',
        BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON: JSON.stringify({
          status: 'unhealthy',
          whatsapp: {
            connected: false,
            connection: {
              state: 'disconnected',
              last_disconnect_reason: 'loggedOut',
              last_status_code: 401,
              auth_failure_class: 'serverside_logout_irreversible',
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
          expectConfigInventory: true,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
          instances: [{ name: 'line-alpha', expected: 'always_on', healthPort: 9090 }],
        }),
      },
    });

    const { summary: event, fails } = readOutboxBySource();
    expect(fails.length).toBeGreaterThanOrEqual(1);
    for (const fail of fails) {
      expect(fail.severity).toBe('critical');
      expect(fail.alertSource).toBe('line-alpha');
      expect((fail.diagnostics as Record<string, unknown>).forceNotify).toBe(true);
    }
    expect(event.severity).toBe('critical');
    expect(event.eventType).toBe('alert');
    expect(event.instance).toBe('line-alpha');
    expect(event.alertSource).toBe('whatsapp_device_bond_lost');
    expect(event.summary).toBe('BOT ERRORS linked-device bond lost: line-alpha requires verified relink');
    expect(event.evidence).toContain('health line-alpha: FAIL 200');
    expect(event.evidence).toContain('health_unhealthy');
    expect(event.evidence).toContain('physical_intervention_required');
    expect(event.criticalAsset).toMatchObject({
      asset: { kind: 'whatsapp_linked_device', instance: 'line-alpha' },
      failure: {
        code: 'WA_AUTH_BOND_SERVER_REVOKED',
        recoverability: 'manual_relink_required',
        confidence: 'confirmed',
      },
    });
  });

  it('treats pairing-required auth failure class as linked-device bond loss without 401/loggedOut evidence', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    writeInstance('line-beta', 9091);

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
        BOT_ERRORS_DRY_ACTIVE_WHATSOUP_SERVICES: '',
        BOT_ERRORS_DRY_HEALTH_STATUS: '200',
        BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON: JSON.stringify({
          status: 'unhealthy',
          whatsapp: {
            connected: false,
            connection: {
              state: 'disconnected',
              last_disconnect_reason: 'connectionReplaced',
              last_status_code: 440,
              auth_failure_class: 'pairing_required',
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
          expectConfigInventory: true,
          expectPluginInventory: false,
          expectRuntimeManifest: false,
          instances: [{ name: 'line-beta', expected: 'always_on', healthPort: 9091 }],
        }),
      },
    });

    const { summary: event, fails } = readOutboxBySource();
    expect(fails.length).toBeGreaterThanOrEqual(1);
    for (const fail of fails) {
      expect(fail.severity).toBe('critical');
      expect(fail.alertSource).toBe('line-beta');
      expect((fail.diagnostics as Record<string, unknown>).forceNotify).toBe(true);
    }
    expect(event.instance).toBe('line-beta');
    expect(event.alertSource).toBe('whatsapp_device_bond_lost');
    expect(event.evidence).toContain('auth_failure_class=pairing_required');
    expect(event.evidence).toContain('physical_intervention_required');
    expect(event.criticalAsset).toMatchObject({
      asset: { kind: 'whatsapp_linked_device', instance: 'line-beta' },
      failure: {
        code: 'WA_AUTH_BOND_SERVER_REVOKED',
        recoverability: 'manual_relink_required',
      },
    });
  });

  it('allows daily-health clears to recover source-qualified linked-device incidents', () => {
    const output = execFileSync('python3', ['-c', `
import importlib.util
import json
spec = importlib.util.spec_from_file_location("dispatcher", "deploy/scripts/bot-errors-dispatcher.py")
dispatcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dispatcher)
key = "test-host|line-alpha|daily-health:whatsapp_device_bond_lost"
state = {"openIncidents": {key: {"eventCreatedAtEpoch": 100, "openedAt": 100, "status": "awaiting_physical"}}}
event = {
    "source": "daily-health",
    "machine": "test-host",
    "instance": "bot-errors-health",
    "eventType": "clear",
    "createdAt": "2026-06-12T17:30:00Z",
    "evidence": (
        "health line-alpha: 200 http://127.0.0.1:9090/health "
        "status=healthy wa_connected=true state=connected auth_failure_class=none "
        "auth_bond_status=present auth_bond_creds_exists=true auth_bond_creds_size=32 "
        "outbound_success_transport_present=true outbound_success_at=2026-06-12T17:20:00Z"
    ),
}
print(json.dumps(dispatcher.daily_health_recovered_incident_keys(event, state)))
`], { cwd: process.cwd(), encoding: 'utf8' }).trim();

    expect(JSON.parse(output)).toEqual(['test-host|line-alpha|daily-health:whatsapp_device_bond_lost']);
  });
});
