import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  runProviderCanary,
  type RunProviderCanaryOptions,
} from './lib/provider-canary-runner.ts';
import {
  isProviderId,
  mcpModeForProvider,
} from '../src/runtimes/agent/providers/index.ts';

const DEFAULT_PROXY = resolve(
  new URL('.', import.meta.url).pathname,
  '../deploy/mcp/whatsoup-proxy.ts',
);

export interface ProviderCanaryCliArgs extends RunProviderCanaryOptions {
  help: boolean;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseProviderCanaryArgs(argv: string[]): ProviderCanaryCliArgs {
  let providerId = '';
  let stateRoot = '';
  let proxyScriptPath = DEFAULT_PROXY;
  let timeoutMs = 30_000;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--provider') {
      providerId = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === '--state-root') {
      stateRoot = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === '--proxy-script') {
      proxyScriptPath = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === '--timeout-seconds') {
      const seconds = Number(requireValue(argv, index, arg));
      if (!Number.isInteger(seconds) || seconds < 5 || seconds > 120) {
        throw new Error('timeout-seconds must be an integer from 5 through 120');
      }
      timeoutMs = seconds * 1_000;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${String(arg)}`);
    }
  }
  if (!help) {
    if (!isProviderId(providerId) || mcpModeForProvider(providerId) !== 'stdio_proxy') {
      throw new Error('provider must be an eligible CLI provider');
    }
    if (!stateRoot || !isAbsolute(stateRoot)) {
      throw new Error('state-root must be an absolute path');
    }
    if (!isAbsolute(proxyScriptPath)) {
      throw new Error('proxy-script must be an absolute path');
    }
  }
  return { providerId, stateRoot, proxyScriptPath, timeoutMs, help };
}

function usage(): string {
  return [
    'Usage: provider-mcp-canary.ts --provider <cli-provider> --state-root <absolute-path>',
    '       [--proxy-script <absolute-path>] [--timeout-seconds 5..120]',
    '',
    'Runs a no-model, no-WhatsApp MCP transport proof and writes one private receipt.',
  ].join('\n');
}

export async function run(argv = process.argv.slice(2)): Promise<void> {
  try {
    const options = parseProviderCanaryArgs(argv);
    if (options.help) {
      console.log(usage());
      return;
    }
    const receipt = await runProviderCanary(options);
    console.log(
      `PROVIDER_MCP_CANARY status=pass provider=${receipt.providerId} contract=${receipt.contractVersion}`,
    );
  } catch {
    process.exitCode = 1;
    console.error('PROVIDER_MCP_CANARY status=unproven');
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  await run();
}
