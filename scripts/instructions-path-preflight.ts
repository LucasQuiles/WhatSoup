import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  sandboxInstructionsPathKind,
  validateAgentInstructionsPath,
  type AgentInstructionsPathFailureReason,
} from './lib/agent-instructions-path.ts';
import { isRecord } from '../src/lib/type-guards.ts';
import { takeValue } from './lib/cli-args.ts';

export interface InstructionsPathPreflightResult {
  schemaVersion: 1;
  ok: boolean;
  decision: 'allow' | 'block';
  reason:
    | 'not_configured'
    | 'configured_file_ready'
    | 'read_from_chat_workspace'
    | 'outside_chat_workspace'
    | 'unsafe_config_file'
    | 'invalid_config'
    | AgentInstructionsPathFailureReason;
}

type AllowReason = 'not_configured' | 'configured_file_ready' | 'read_from_chat_workspace';

function allow(reason: AllowReason): InstructionsPathPreflightResult {
  return { schemaVersion: 1, ok: true, decision: 'allow', reason };
}

function block(
  reason: Exclude<InstructionsPathPreflightResult['reason'], AllowReason>,
): InstructionsPathPreflightResult {
  return { schemaVersion: 1, ok: false, decision: 'block', reason };
}

export function inspectInstructionsPathConfig(
  configPath: string,
  homeDirectory: string,
): InstructionsPathPreflightResult {
  try {
    const stat = lstatSync(configPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return block('unsafe_config_file');
  } catch {
    return block('unsafe_config_file');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
  } catch {
    return block('invalid_config');
  }
  if (!isRecord(raw)) return block('invalid_config');

  const agentOptions = raw['agentOptions'];
  if (agentOptions === undefined || agentOptions === null) return allow('not_configured');
  if (!isRecord(agentOptions)) return block('invalid_config');

  const instructionsPath = agentOptions['instructionsPath'];
  if (instructionsPath === undefined) return allow('not_configured');
  if (typeof instructionsPath !== 'string') return block('invalid_config');

  const cwd = agentOptions['cwd'];
  if (cwd !== undefined && typeof cwd !== 'string') return block('invalid_config');

  // As config load does (src/core/agent-config-validator.ts): a sandboxPerChat
  // path that is not lexically inside the chat workspace blocks, and a confined
  // relative path is left to the session's own read in its workspace.
  if (agentOptions['sandboxPerChat'] === true) {
    const sandboxPath = sandboxInstructionsPathKind(instructionsPath);
    if (sandboxPath === 'outside_chat_workspace') return block('outside_chat_workspace');
    if (sandboxPath === 'chat_workspace') return allow('read_from_chat_workspace');
  }

  const result = validateAgentInstructionsPath({
    instructionsPath,
    cwd,
    homeDirectory,
  });
  return result.ok ? allow('configured_file_ready') : block(result.reason);
}

interface CliArgs {
  configPath: string;
  homeDirectory: string;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let configPath = '';
  let homeDirectory = '';
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config') ({ value: configPath, index } = takeValue(argv, index));
    else if (arg === '--home') ({ value: homeDirectory, index } = takeValue(argv, index));
    else if (arg === '--json') json = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!path.isAbsolute(configPath) || !path.isAbsolute(homeDirectory)) {
    throw new Error('--config and --home must be absolute paths');
  }
  return { configPath, homeDirectory, json };
}

function main(): void {
  let result: InstructionsPathPreflightResult;
  let json = process.argv.includes('--json');
  try {
    const args = parseArgs(process.argv.slice(2));
    json = args.json;
    result = inspectInstructionsPathConfig(args.configPath, args.homeDirectory);
  } catch {
    result = block('invalid_config');
  }
  process.stdout.write(`${json ? JSON.stringify(result) : `${result.decision}: ${result.reason}`}\n`);
  process.exitCode = result.ok ? 0 : 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
