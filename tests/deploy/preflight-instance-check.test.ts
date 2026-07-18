// tests/deploy/preflight-instance-check.test.ts
//
// Black-box tests for the restart-safety instance-configuration probe
// (deploy/preflight-instance-check.ts, #1862). The probe loads the NAMED
// instance's real configuration side-effect-free and fails closed on a missing
// instance or a config runtime startup would reject (e.g. an agent cwd that
// resolves to the user home directory) — before a restart mutates the service.
//
// Strategy: point XDG_CONFIG_HOME at a temp config home, write fixture instance
// configs, spawn the probe with the pinned interpreter, assert exit code + marker.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanGitEnv } from '../../src/lib/git-env.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const ENTRYPOINT = join(REPO_ROOT, 'deploy/preflight-instance-check.ts');
const PINNED_NODE = process.execPath;
const SPAWN_TIMEOUT_MS = 15_000;

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

function makeConfigHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-instance-'));
  tmpDirs.push(dir);
  return dir;
}

function writeInstance(configHome: string, name: string, config: unknown): void {
  const dir = join(configHome, 'whatsoup', 'instances', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config), 'utf8');
}

function runInstanceCheck(
  name: string | undefined,
  env: Record<string, string>,
): { status: number; stderr: string } {
  const args = name === undefined ? [] : [name];
  const result = spawnSync(
    PINNED_NODE,
    ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', ENTRYPOINT, ...args],
    { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS, env: { ...cleanGitEnv(), ...env } },
  );
  return { status: result.status ?? -1, stderr: result.stderr ?? '' };
}

const validAgentConfig = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'q-bot',
  type: 'agent',
  accessMode: 'self_only',
  adminPhones: ['15551234567'],
  agentOptions: { sessionScope: 'single' },
  ...over,
});

describe('deploy/preflight-instance-check.ts (#1862)', () => {
  it('exits 3 for a nonexistent instance (the reported repro)', () => {
    const configHome = makeConfigHome(); // empty — no instances configured
    const { status, stderr } = runInstanceCheck('definitely-not-a-configured-instance', {
      XDG_CONFIG_HOME: configHome,
    });
    expect(status).toBe(3);
    expect(stderr).toContain('PREFLIGHT-INSTANCE: INVALID');
    expect(stderr).toContain('not found');
  });

  it('exits 3 when the agent cwd resolves to the user home directory', () => {
    const configHome = makeConfigHome();
    writeInstance(
      configHome,
      'q-bot',
      validAgentConfig({ agentOptions: { sessionScope: 'single', cwd: homedir() } }),
    );
    const { status, stderr } = runInstanceCheck('q-bot', { XDG_CONFIG_HOME: configHome });
    expect(status).toBe(3);
    expect(stderr).toContain('agentOptions.cwd');
  });

  it('exits 3 for malformed config JSON', () => {
    const configHome = makeConfigHome();
    const dir = join(configHome, 'whatsoup', 'instances', 'q-bot');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), '{ this is not json', 'utf8');
    const { status, stderr } = runInstanceCheck('q-bot', { XDG_CONFIG_HOME: configHome });
    expect(status).toBe(3);
    expect(stderr).toContain('not valid JSON');
  });

  it('exits 0 for a valid instance configuration', () => {
    const configHome = makeConfigHome();
    writeInstance(configHome, 'q-bot', validAgentConfig());
    const { status, stderr } = runInstanceCheck('q-bot', { XDG_CONFIG_HOME: configHome });
    expect(status, stderr).toBe(0);
    expect(stderr).toContain('PREFLIGHT-INSTANCE: VALID');
  });

  it('exits 1 with no instance-name argument', () => {
    const configHome = makeConfigHome();
    const { status, stderr } = runInstanceCheck(undefined, { XDG_CONFIG_HOME: configHome });
    expect(status).toBe(1);
    expect(stderr).toContain('no instance-name argument');
  });

  it('is side-effect free: validating a valid instance creates no data/state/db', () => {
    const configHome = makeConfigHome();
    writeInstance(configHome, 'q-bot', validAgentConfig());
    const dataHome = makeConfigHome();
    const stateHome = makeConfigHome();
    const { status } = runInstanceCheck('q-bot', {
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      XDG_STATE_HOME: stateHome,
    });
    expect(status).toBe(0);
    // No transports/ports/providers/db — only config was read. Nothing under the
    // instance's data/state roots should have been created.
    expect(existsSync(join(dataHome, 'whatsoup', 'instances', 'q-bot'))).toBe(false);
    expect(existsSync(join(stateHome, 'whatsoup', 'instances', 'q-bot'))).toBe(false);
  });
});
