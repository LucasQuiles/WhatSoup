import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('');

function runWriterInWatchedChild(agentCwd: string): SpawnSyncReturns<string> {
  const source = `
    import { writeProviderMcpConfig } from './src/core/provider-mcp-config.ts';
    try {
      writeProviderMcpConfig('opencode-cli', ${JSON.stringify(agentCwd)}, '/tmp/socket', '/tmp/proxy');
      process.stdout.write(JSON.stringify({ wrote: true }));
      process.exitCode = 2;
    } catch (error) {
      process.stdout.write(JSON.stringify({
        wrote: false,
        code: error?.code,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  `;
  return spawnSync(process.execPath, [
    '--disable-warning=ExperimentalWarning',
    '--experimental-strip-types',
    '--input-type=module',
    '--eval',
    source,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 2_000,
  });
}

describe.skipIf(process.platform === 'win32')('OpenCode config descriptor boundary', () => {
  it('rejects a FIFO without blocking on a path-based read', () => {
    const agentCwd = tmp.make('whatsoup-opencode-fifo');
    execFileSync('mkfifo', [path.join(agentCwd, 'opencode.json')]);

    const result = runWriterInWatchedChild(agentCwd);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      wrote: false,
      code: 'EINVAL',
      message: 'OpenCode configuration must be a regular non-symlink file',
    });
  });

  it('rejects a symlink without exposing either path', () => {
    const agentCwd = tmp.make('whatsoup-opencode-link');
    const target = path.join(agentCwd, 'target.json');
    fs.writeFileSync(target, '{}', { mode: 0o600 });
    fs.symlinkSync(target, path.join(agentCwd, 'opencode.json'));

    const result = runWriterInWatchedChild(agentCwd);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toEqual({
      wrote: false,
      code: 'ELOOP',
      message: 'OpenCode configuration must be a regular non-symlink file',
    });
    expect(result.stdout).not.toContain(agentCwd);
    expect(result.stdout).not.toContain(target);
  });
});
