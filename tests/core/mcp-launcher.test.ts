import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';

const MODULE_PATH = '../../src/core/mcp-launcher.ts';
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '../..');
const TSX_BIN = process.platform === 'win32' ? 'tsx.cmd' : 'tsx';
const TSX_RUNNER = join(REPO_ROOT, 'node_modules', '.bin', TSX_BIN);

async function importLauncher() {
  vi.resetModules();
  vi.doUnmock('node:fs');
  return import(MODULE_PATH);
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      resolvePromise({ code, signal, stderr });
    });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('node:fs');
});

describe('buildMcpLaunchCommand', () => {
  it('uses the repo-local tsx runner with the script path as the only arg', async () => {
    const { buildMcpLaunchCommand } = await importLauncher();

    const result = buildMcpLaunchCommand('src/mcp/socket-server.ts');

    expect(result.command).toBe(TSX_RUNNER);
    expect(result.args).toEqual(['src/mcp/socket-server.ts']);
    expect(resolve(result.command)).toBe(result.command);
  });

  it('does not include the native strip-types flag', async () => {
    const { buildMcpLaunchCommand } = await importLauncher();

    const result = buildMcpLaunchCommand('src/mcp/socket-server.ts');

    expect([result.command, ...result.args].join(' ')).not.toContain('--experimental-strip-types');
  });

  it('resolves the runner from the module location instead of process cwd', async () => {
    const originalCwd = process.cwd();
    const tempDir = mkdtempSync(join(tmpdir(), 'mcp-launcher-cwd-'));

    try {
      process.chdir(tempDir);
      const { buildMcpLaunchCommand } = await importLauncher();

      expect(buildMcpLaunchCommand('server.ts').command).toBe(TSX_RUNNER);
    } finally {
      process.chdir(originalCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves absolute script paths exactly', async () => {
    const { buildMcpLaunchCommand } = await importLauncher();
    const scriptPath = join(tmpdir(), 'external-mcp-server.ts');

    expect(buildMcpLaunchCommand(scriptPath).args).toEqual([scriptPath]);
  });

});

describe('spawnMcpProcess', () => {
  it('throws an actionable error when the repo-local tsx runner is missing', async () => {
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        existsSync: vi.fn(() => false),
      };
    });
    const { spawnMcpProcess } = await import(MODULE_PATH);

    expect(() => spawnMcpProcess('server.ts', {})).toThrow(/tsx/);
    expect(() => spawnMcpProcess('server.ts', {})).toThrow(/npm install/);
  });

  it('uses an allowlisted base env while applying caller overrides', async () => {
    const { spawnMcpProcess } = await importLauncher();
    const tempDir = mkdtempSync(join(tmpdir(), 'mcp-launcher-env-'));
    const scriptPath = join(tempDir, 'env.ts');
    writeFileSync(
      scriptPath,
      [
        'process.stderr.write(JSON.stringify({',
        '  inherited: process.env.MCP_LAUNCHER_INHERITED ?? null,',
        '  override: process.env.MCP_LAUNCHER_OVERRIDE,',
        '  tmpdir: process.env.TMPDIR,',
        '}));',
      ].join('\n'),
    );

    const originalInherited = process.env.MCP_LAUNCHER_INHERITED;
    const originalOverride = process.env.MCP_LAUNCHER_OVERRIDE;
    const originalTmpdir = process.env.TMPDIR;
    process.env.MCP_LAUNCHER_INHERITED = 'from-process';
    process.env.MCP_LAUNCHER_OVERRIDE = 'from-process';
    process.env.TMPDIR = join(tempDir, 'owned-tmp');

    try {
      const child = spawnMcpProcess(
        scriptPath,
        { MCP_LAUNCHER_OVERRIDE: 'from-caller' },
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );

      const result = await waitForExit(child);

      expect(result.code).toBe(0);
      // The child writes one compact JSON object to stderr, but newer Node
      // runtimes append deprecation warnings (e.g. DEP0205 from tsx) to the
      // same stream — extract the JSON payload instead of parsing the raw
      // stream so the assertion is runtime-version independent.
      const payload = result.stderr.slice(
        result.stderr.indexOf('{'),
        result.stderr.indexOf('}') + 1,
      );
      expect(JSON.parse(payload)).toEqual({
        inherited: null,
        override: 'from-caller',
        tmpdir: join(tempDir, 'owned-tmp'),
      });
    } finally {
      if (originalInherited === undefined) {
        delete process.env.MCP_LAUNCHER_INHERITED;
      } else {
        process.env.MCP_LAUNCHER_INHERITED = originalInherited;
      }
      if (originalOverride === undefined) {
        delete process.env.MCP_LAUNCHER_OVERRIDE;
      } else {
        process.env.MCP_LAUNCHER_OVERRIDE = originalOverride;
      }
      if (originalTmpdir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = originalTmpdir;
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('passes opts through so callers can pipe stderr and observe child exit', async () => {
    const { spawnMcpProcess } = await importLauncher();
    const tempDir = mkdtempSync(join(tmpdir(), 'mcp-launcher-spawn-'));
    const scriptPath = join(tempDir, 'exit.ts');
    writeFileSync(scriptPath, 'process.stderr.write("mcp stderr\\n"); process.exit(7);');

    try {
      const child = spawnMcpProcess(scriptPath, {}, { stdio: ['ignore', 'ignore', 'pipe'] });

      const result = await waitForExit(child);

      expect(result).toEqual({ code: 7, signal: null, stderr: 'mcp stderr\n' });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
