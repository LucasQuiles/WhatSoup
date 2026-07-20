import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { provisionWorkspace } from '../../src/core/workspace.ts';
import type { ProvisionOptions } from '../../src/core/workspace.ts';

describe('provisionWorkspace sandbox-policy.json allowedEgress', () => {
  let tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) {
      rmSync(d, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  function makeTmp(): string {
    const d = mkdtempSync(join(tmpdir(), 'ws-egress-test-'));
    tmpDirs.push(d);
    return d;
  }

  function makeOpts(workspacePath: string, instanceCwd: string, allowedEgress?: string[]): ProvisionOptions {
    return {
      workspacePath,
      instanceCwd,
      sandbox: {
        allowedPaths: ['/some/other/path'],
        allowedTools: ['Read', 'Write'],
        allowedMcpTools: ['whatsoup'],
        bash: { enabled: true, pathRestricted: true },
        ...(allowedEgress !== undefined ? { allowedEgress } : {}),
      },
      hookPath: '/abs/path/to/agent-sandbox.sh',
      mcpServerPath: '/abs/path/to/whatsoup-proxy.ts',
    };
  }

  function readPolicy(workspacePath: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(workspacePath, '.claude', 'sandbox-policy.json'), 'utf8'));
  }

  it('writes allowedEgress verbatim when sandbox.allowedEgress is a populated array', () => {
    const workspacePath = makeTmp();
    const instanceCwd = makeTmp();
    provisionWorkspace(makeOpts(workspacePath, instanceCwd, ['api.anthropic.com']));

    const policy = readPolicy(workspacePath);
    expect(policy.allowedEgress).toEqual(['api.anthropic.com']);
  });

  it('omits the allowedEgress key entirely when sandbox.allowedEgress is not supplied (opt-out)', () => {
    const workspacePath = makeTmp();
    const instanceCwd = makeTmp();
    provisionWorkspace(makeOpts(workspacePath, instanceCwd));

    const policy = readPolicy(workspacePath);
    expect(policy).not.toHaveProperty('allowedEgress');
  });

  it('writes allowedEgress as an empty array (deny-all) when sandbox.allowedEgress is []', () => {
    const workspacePath = makeTmp();
    const instanceCwd = makeTmp();
    provisionWorkspace(makeOpts(workspacePath, instanceCwd, []));

    const policy = readPolicy(workspacePath);
    expect(policy).toHaveProperty('allowedEgress');
    expect(policy.allowedEgress).toEqual([]);
  });
});
