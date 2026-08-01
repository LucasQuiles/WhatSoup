import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { provisionWorkspace } from '../../src/core/workspace.ts';
import type { ProvisionOptions } from '../../src/core/workspace.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

describe('provisionWorkspace sandbox-policy.json allowedEgress', () => {
  const tmp = trackTmpDirs('');

  function makeTmp(): string {
    return tmp.make('ws-egress-test');
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
