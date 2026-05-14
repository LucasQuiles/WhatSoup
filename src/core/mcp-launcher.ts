import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(CORE_DIR, '../..');
const TSX_BIN = process.platform === 'win32' ? 'tsx.cmd' : 'tsx';
const TSX_RUNNER = join(REPO_ROOT, 'node_modules', '.bin', TSX_BIN);
const DEFAULT_STDIO: SpawnOptions['stdio'] = ['pipe', 'pipe', 'inherit'];
const BASE_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'TERM',
  'NODE_PATH',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'TMPDIR',
] as const;

export function buildMcpLaunchCommand(scriptPath: string): { command: string; args: readonly string[] } {
  return {
    command: TSX_RUNNER,
    args: [scriptPath],
  };
}

function assertMcpRunnerAvailable(): void {
  if (!existsSync(TSX_RUNNER)) {
    throw new Error(
      `Missing MCP TypeScript runner at ${TSX_RUNNER}. Run npm install before launching MCP scripts.`,
    );
  }
}

export function spawnMcpProcess(
  scriptPath: string,
  env: NodeJS.ProcessEnv,
  opts: SpawnOptions = {},
): ChildProcess {
  assertMcpRunnerAvailable();
  const { command, args } = buildMcpLaunchCommand(scriptPath);
  const baseEnv = Object.fromEntries(
    BASE_ENV_KEYS
      .map((key) => [key, process.env[key]] as const)
      .filter(([, value]) => value !== undefined),
  ) as NodeJS.ProcessEnv;

  return spawn(command, args, {
    ...opts,
    env: { ...baseEnv, ...env },
    stdio: opts.stdio ?? DEFAULT_STDIO,
  });
}
