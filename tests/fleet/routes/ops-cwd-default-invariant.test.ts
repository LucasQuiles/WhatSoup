/**
 * Pins the cwd-DEFAULTING invariant in handleConfigUpdate's PATCH cwd-guard
 * cluster (src/fleet/routes/ops.ts: claudeMd :502-514, settingsJson
 * :517-532, enabledPlugins :535-567).
 *
 * Each of the three sites is preceded by `if (ao && typeof ao.cwd ===
 * 'string' && ao.cwd.trim())` around the actual filesystem write. It looks
 * like a skip-branch guard, but it cannot fail for `merged.type === 'agent'`:
 * `resolveAndValidateAgentCwd` (ops.ts:756-773), gated by the identical
 * `merged.type === 'agent'` condition, runs first in the same handler and
 * unconditionally defaults `agentOptions.cwd` to `defaultAgentCwd(name)`
 * whenever it is absent/empty/whitespace-only, or halts the request via an
 * unconditional throw on any other failure. So by the time these three
 * blocks run, `ao.cwd` is always a valid non-empty string — the guard's
 * false branch is unreachable dead code (tracked as #2876, which also
 * covers three pre-existing tests in ops.test.ts that were mislabeled as
 * exercising that false branch).
 *
 * What IS reachable, live, and worth pinning is the defaulting itself: a
 * PATCH with an absent/empty/whitespace-only agentOptions.cwd on an agent
 * instance does not silently drop claudeMd/settingsJson/enabledPlugins —
 * it writes them to the per-instance default workspace
 * (~/.local/share/whatsoup/instances/<name>/workspace). This test is the
 * sentinel for that: removing or narrowing resolveAndValidateAgentCwd's
 * defaulting is exactly the change that would revive the dead branches in
 * #2876, and this file goes red first. It complements #2876; it does not
 * cover the branches #2876 is about to delete.
 *
 * Spreads the three falsy cwd shapes (absent, empty string, whitespace-only)
 * one per write-target, since all three route through the same
 * resolveAndValidateAgentCwd defaulting regardless of which field consumes
 * the resulting cwd.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { handleConfigUpdate } from '../../../src/fleet/routes/ops.ts';
import type { OpsDeps } from '../../../src/fleet/routes/ops.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';
import { makeDeps, mockReq, mockRes } from '../../helpers/http-mocks.ts';

vi.mock('../../../src/fleet/mcp-client.ts', () => ({ mcpCall: vi.fn() }));
vi.mock('../../../src/fleet/http-proxy.ts', () => ({ proxyToInstance: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));

/** Mirrors ops.ts's private defaultAgentCwd(name) — not exported. */
function expectedDefaultCwd(name: string): string {
  return path.join(os.homedir(), '.local', 'share', 'whatsoup', 'instances', name, 'workspace');
}

let cleanupDirs: string[] = [];

afterEach(() => {
  for (const d of cleanupDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  cleanupDirs = [];
});

function writeAgentConfig(name: string, agentOptions: Record<string, unknown>): string {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cwd-default-'));
  cleanupDirs.push(configDir);
  const configPath = path.join(configDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    name, type: 'agent', healthPort: 3010, accessMode: 'self_only',
    adminPhones: ['18001234567'], agentOptions,
  }));
  return configPath;
}

function depsFor(configPath: string, name: string): OpsDeps {
  const instance: DiscoveredInstance = {
    name, type: 'agent', accessMode: 'self_only', healthPort: 9099,
    dbPath: '/tmp/bot.db', stateRoot: '/tmp/state', logDir: '/tmp/logs',
    healthToken: 'tok', configPath, socketPath: null,
  };
  return makeDeps({ discovery: { getInstance: vi.fn(() => instance) } });
}

describe('handleConfigUpdate — cwd-defaulting invariant (agentOptions.cwd absent/empty/whitespace)', () => {
  it('claudeMd: absent cwd defaults to the per-instance workspace and still writes CLAUDE.md', async () => {
    const name = 'cwd-default-claudemd';
    const configPath = writeAgentConfig(name, {}); // no cwd key at all
    const defaultCwd = expectedDefaultCwd(name);
    cleanupDirs.push(path.dirname(path.dirname(defaultCwd))); // .../instances/<name>

    const res = mockRes();
    await handleConfigUpdate(
      mockReq({ method: 'PATCH', body: JSON.stringify({ claudeMd: '# defaulted cwd\n' }) }),
      res, depsFor(configPath, name), { name },
    );

    expect(res._status, res._body).toBe(200);
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(persisted.agentOptions.cwd).toBe(defaultCwd);

    const claudeMdPath = path.join(defaultCwd, '.claude', 'CLAUDE.md');
    expect(fs.existsSync(claudeMdPath), 'CLAUDE.md must be written at the defaulted cwd').toBe(true);
    expect(fs.readFileSync(claudeMdPath, 'utf-8')).toBe('# defaulted cwd\n');
  });

  it('settingsJson: empty-string cwd defaults to the per-instance workspace and still writes settings.json', async () => {
    const name = 'cwd-default-settingsjson';
    const configPath = writeAgentConfig(name, { cwd: '' });
    const defaultCwd = expectedDefaultCwd(name);
    cleanupDirs.push(path.dirname(path.dirname(defaultCwd)));

    const customSettings = {
      permissions: { allow: ['Bash', 'Read'], deny: [], defaultMode: 'bypassPermissions' },
    };
    const res = mockRes();
    await handleConfigUpdate(
      mockReq({ method: 'PATCH', body: JSON.stringify({ settingsJson: customSettings }) }),
      res, depsFor(configPath, name), { name },
    );

    expect(res._status, res._body).toBe(200);
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(persisted.agentOptions.cwd).toBe(defaultCwd);

    const settingsPath = path.join(defaultCwd, '.claude', 'settings.json');
    expect(fs.existsSync(settingsPath), 'settings.json must be written at the defaulted cwd').toBe(true);
    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(written.permissions.allow).toEqual(['Bash', 'Read']);
  });

  it('enabledPlugins: whitespace-only cwd defaults to the per-instance workspace and still writes settings.json', async () => {
    const name = 'cwd-default-enabledplugins';
    const configPath = writeAgentConfig(name, { cwd: '   ' });
    const defaultCwd = expectedDefaultCwd(name);
    cleanupDirs.push(path.dirname(path.dirname(defaultCwd)));

    const plugins = { 'sdlc-os@sdlc-os-dev': false, 'tmup@tmup-dev': true };
    const res = mockRes();
    await handleConfigUpdate(
      mockReq({ method: 'PATCH', body: JSON.stringify({ agentOptions: { enabledPlugins: plugins } }) }),
      res, depsFor(configPath, name), { name },
    );

    expect(res._status, res._body).toBe(200);
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(persisted.agentOptions.cwd).toBe(defaultCwd);

    const settingsPath = path.join(defaultCwd, '.claude', 'settings.json');
    expect(fs.existsSync(settingsPath), 'settings.json must be written at the defaulted cwd').toBe(true);
    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(written.enabledPlugins).toEqual(plugins);
  });
});
