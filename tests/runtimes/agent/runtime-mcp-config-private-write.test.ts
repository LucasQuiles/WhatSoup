// Regression coverage for issue #391.
//
// AgentRuntime.start() writes `.mcp.json` into `agentCwd` (typically homedir)
// at src/runtimes/agent/runtime.ts. Previously the call used raw
// fs.writeFileSync, which followed symlinks and produced world-readable files
// (mode 0644 on most systems). The fix routes the write through
// writePrivateFileSync from src/core/workspace.ts, which enforces O_NOFOLLOW
// and mode 0600.
//
// runtime.test.ts mocks node:fs wholesale, so a real-fs symlink test cannot
// live there. This file exercises the helper directly against a homedir-mode
// parent (0o755) and an attacker symlink to prove the contract holds for the
// L1334 call site.

import { describe, it, expect } from 'vitest';
import { existsSync, statSync, symlinkSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivateFileSync } from '../../../src/core/workspace.ts';
import { trackTmpDirs } from '../../helpers/tmp-dir.ts';

describe('runtime .mcp.json write (issue #391)', () => {
  const tmp = trackTmpDirs('rt-mcp');

  function makeTmp(mode = 0o755): string {
    const d = tmp.make('');
    chmodSync(d, mode);
    return d;
  }

  it('writes .mcp.json with mode 0600 even when parent dir is 0o755 (homedir-like)', () => {
    const agentCwd = makeTmp(0o755);
    const mcpPath = join(agentCwd, '.mcp.json');

    writePrivateFileSync(mcpPath, JSON.stringify({ mcpServers: {} }, null, 2));

    const stat = statSync(mcpPath);
    expect(stat.mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(readFileSync(mcpPath, 'utf8'));
    expect(parsed.mcpServers).toEqual({});
  });

  it('refuses to write .mcp.json through a pre-existing symlink', () => {
    const agentCwd = makeTmp(0o755);
    const decoy = makeTmp(0o755);
    const decoyTarget = join(decoy, 'attacker-target');
    symlinkSync(decoyTarget, join(agentCwd, '.mcp.json'));

    expect(() =>
      writePrivateFileSync(join(agentCwd, '.mcp.json'), JSON.stringify({ mcpServers: {} })),
    ).toThrow();
    // The symlink target was never created
    expect(existsSync(decoyTarget)).toBe(false);
  });

  it('idempotent rewrite preserves mode 0600 and replaces content', () => {
    const agentCwd = makeTmp(0o755);
    const mcpPath = join(agentCwd, '.mcp.json');

    writePrivateFileSync(mcpPath, JSON.stringify({ mcpServers: { v1: true } }));
    writePrivateFileSync(mcpPath, JSON.stringify({ mcpServers: { v2: true } }));

    const stat = statSync(mcpPath);
    expect(stat.mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(readFileSync(mcpPath, 'utf8'));
    expect(parsed.mcpServers).toEqual({ v2: true });
  });
});
