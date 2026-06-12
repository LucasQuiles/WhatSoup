import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

let tmpRoot = '';

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

describe('bot-errors-health-check', () => {
  it('keeps all checked-in health profiles parseable', () => {
    const profilesDir = join(process.cwd(), 'deploy', 'health-profiles');
    for (const file of readdirSync(profilesDir).filter((name) => name.endsWith('.json'))) {
      const profile = JSON.parse(readFileSync(join(profilesDir, file), 'utf8')) as {
        role?: unknown;
        instances?: unknown;
      };
      expect(profile.role).toEqual(expect.any(String));
      if ('instances' in profile) {
        expect(Array.isArray(profile.instances)).toBe(true);
      }
    }
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

  it('fails daily health when a profile-declared credential is missing', () => {
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
          role: 'bot-host',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          requiredCredentialFiles: ['tokens.env'],
        }),
      },
    });

    const files = readdirSync(join(tmpRoot, 'outbox'));
    const event = JSON.parse(readFileSync(join(tmpRoot, 'outbox', files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('FAIL credential tokens.env: missing required tokens.env');
    expect(event.evidence).not.toContain('TOKEN=');
  });

  it('fails daily health when a profile-declared credential is unreadable without leaking contents', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const whatsoupDir = join(tmpRoot, '.config', 'whatsoup');
    mkdirSync(whatsoupDir, { recursive: true });
    const tokenPath = join(whatsoupDir, 'tokens.env');
    writeFileSync(tokenPath, 'TOKEN=super-secret-value\n', { mode: 0o600 });
    chmodSync(tokenPath, 0o000);

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
          expectConfigInventory: false,
          expectPluginInventory: false,
          requiredCredentialFiles: ['tokens.env'],
        }),
      },
    });
    chmodSync(tokenPath, 0o600);

    const files = readdirSync(join(tmpRoot, 'outbox'));
    const event = JSON.parse(readFileSync(join(tmpRoot, 'outbox', files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('FAIL credential tokens.env: unreadable');
    expect(event.evidence).toContain('mode=0');
    expect(event.evidence).not.toContain('super-secret-value');
  });

  it('warns on over-readable credentials and fails world-writable credentials', () => {
    for (const [mode, expectedSeverity, expectedLine] of [
      [0o644, 'warning', 'WARN credential tokens.env: mode>600'],
      [0o666, 'critical', 'FAIL credential tokens.env: world_writable'],
    ] as const) {
      tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
      const whatsoupDir = join(tmpRoot, '.config', 'whatsoup');
      mkdirSync(whatsoupDir, { recursive: true });
      const tokenPath = join(whatsoupDir, 'tokens.env');
      writeFileSync(tokenPath, 'TOKEN=do-not-print\n', { mode });
      chmodSync(tokenPath, mode);

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
            expectConfigInventory: false,
            expectPluginInventory: false,
            requiredCredentialFiles: ['tokens.env'],
          }),
        },
      });

      const files = readdirSync(join(tmpRoot, 'outbox'));
      const event = JSON.parse(readFileSync(join(tmpRoot, 'outbox', files[0]!), 'utf8')) as {
        severity: string;
        evidence: string;
      };
      expect(event.severity).toBe(expectedSeverity);
      expect(event.evidence).toContain(expectedLine);
      expect(event.evidence).toContain(`mode=${mode.toString(8)}`);
      expect(event.evidence).not.toContain('credential_meta');
      expect(event.evidence).not.toContain('do-not-print');
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = '';
    }
  });

  it('root-anchors fleet credential requirements so nested copies cannot mask a missing root token', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const nestedDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'ana-bot');
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(nestedDir, 'fleet-token'), 'TOKEN=nested-copy-should-not-pass\n', { mode: 0o600 });

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
          expectConfigInventory: false,
          expectPluginInventory: false,
          requiredCredentialFiles: ['fleet-token'],
        }),
      },
    });

    const files = readdirSync(join(tmpRoot, 'outbox'));
    const event = JSON.parse(readFileSync(join(tmpRoot, 'outbox', files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('FAIL credential fleet-token: missing required fleet-token');
    expect(event.evidence).toContain(join(tmpRoot, '.config', 'whatsoup', 'fleet-token'));
    expect(event.evidence).not.toContain('nested-copy-should-not-pass');
  });

  it('fails daily health when a profile-declared config is missing', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    mkdirSync(join(tmpRoot, '.config', 'whatsoup', 'instances', 'ana-bot'), { recursive: true });

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
          requiredCredentialFiles: [],
          requiredConfigFiles: ['config.json'],
          instances: [{ name: 'ana-bot', expected: 'always_on', service: 'com.whatsoup.ana-bot' }],
        }),
      },
    });

    const files = readdirSync(join(tmpRoot, 'outbox'));
    const event = JSON.parse(readFileSync(join(tmpRoot, 'outbox', files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('critical');
    expect(event.evidence.match(/FAIL config ana-bot: missing required config.json/g)).toHaveLength(1);
  });

  it('warns on world-readable configs by default and fails them under a strict profile', () => {
    for (const [profile, expectedSeverity, expectedLine] of [
      [{ role: 'bot-host' }, 'warning', 'WARN config ana-bot: world_readable required config.json'],
      [{ role: 'bot-host', requiredConfigMaxMode: '0600' }, 'critical', 'FAIL config ana-bot: mode>600 required config.json'],
    ] as const) {
      tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
      const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'ana-bot');
      mkdirSync(configDir, { recursive: true });
      const configPath = join(configDir, 'config.json');
      writeFileSync(configPath, JSON.stringify({ type: 'agent', enabled: true }), { mode: 0o644 });
      chmodSync(configPath, 0o644);

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
            ...profile,
            expectDispatcher: false,
            expectQLoop: false,
            expectPersonalSocket: false,
            expectPersonalTools: false,
            expectPluginInventory: false,
            requiredCredentialFiles: [],
            requiredConfigFiles: ['config.json'],
            instances: [{ name: 'ana-bot', expected: 'always_on', service: 'com.whatsoup.ana-bot' }],
          }),
        },
      });

      const files = readdirSync(join(tmpRoot, 'outbox'));
      const event = JSON.parse(readFileSync(join(tmpRoot, 'outbox', files[0]!), 'utf8')) as {
        severity: string;
        evidence: string;
      };
      expect(event.severity).toBe(expectedSeverity);
      expect(event.evidence).toContain(expectedLine);
      expect(event.evidence).not.toContain('"type"');
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = '';
    }
  });

  it('does not warn or fail a no-bot host for absent required files', () => {
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
          role: 'no-bot',
          expectDispatcher: false,
          expectQLoop: false,
          expectPersonalSocket: false,
          expectPersonalTools: false,
          expectConfigInventory: false,
          expectPluginInventory: false,
          requiredCredentialFiles: [],
          instances: [],
        }),
      },
    });

    const files = readdirSync(join(tmpRoot, 'outbox'));
    const event = JSON.parse(readFileSync(join(tmpRoot, 'outbox', files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('info');
    expect(event.evidence).not.toContain('FAIL credential');
    expect(event.evidence).not.toContain('WARN credential');
    expect(event.evidence).not.toContain('FAIL config');
    expect(event.evidence).not.toContain('WARN config');
  });

  it('raises critical daily health severity when inherited agent plugins are not explicitly covered', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'agent');
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
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('FAIL plugin_coverage agent');
    expect(event.evidence).toContain('inherited_disabled=sdlc-os@sdlc-os-dev');
  });

  it('treats omitted enabledPlugins as intentional global inheritance', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const configDir = join(tmpRoot, '.config', 'whatsoup', 'instances', 'agent');
    const claudeDir = join(tmpRoot, '.claude');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
      enabledPlugins: {
        'superpowers@superpowers-marketplace': true,
        'sdlc-os@sdlc-os-dev': true,
      },
    }));
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      type: 'agent',
      agentOptions: { sessionScope: 'per_chat' },
    }));
    chmodSync(join(configDir, 'config.json'), 0o600);

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

  it('records a recoverable writefail breadcrumb when daily health outbox is unwritable', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const blocked = join(tmpRoot, 'blocked-outbox-parent');
    const writefail = join(tmpRoot, 'writefail');
    writeFileSync(blocked, 'not a directory');

    const result = spawnSync('python3', ['deploy/scripts/bot-errors-health-check.py', '--daily'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
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

  it('treats intentional blocked instances as info when the service is not active', () => {
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
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(outbox, files[0]!), 'utf8')) as {
      severity: string;
      evidence: string;
    };
    expect(event.severity).toBe('info');
    expect(event.evidence).toContain('config ar-bot: expected=blocked exists=True service_status=inactive');
    expect(event.evidence).toContain('plugins ar-bot: skipped expected=blocked');
    expect(event.evidence).not.toContain('WARN config ar-bot');
  });

  it('warns when an intentional blocked instance is unexpectedly active', () => {
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
    expect(event.severity).toBe('critical');
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
    expect(event.severity).toBe('critical');
    expect(event.evidence).toContain('FAIL clock: status=synced offset_ms=600000.0');
  });

  it('graces a stale dispatcher heartbeat when service uptime is inside restart grace', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-health-'));
    const state = join(tmpRoot, 'dispatcher-state.json');
    const socket = join(tmpRoot, 'whatsoup.sock');
    writeFileSync(state, JSON.stringify({ time: new Date().toISOString() }));
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
    writeFileSync(state, JSON.stringify({ time: new Date().toISOString() }));
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
});
