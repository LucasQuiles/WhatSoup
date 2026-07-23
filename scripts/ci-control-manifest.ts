#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { isHelpFlag, parseClosedOptions } from './lib/cli-args.ts';
import {
  ControlManifestError,
  buildControlInventory,
  digestControlManifest,
  loadControlManifest,
} from './lib/ci-control/manifest.ts';

type ManifestCommand = 'validate' | 'inventory';

export interface ManifestCliOutput {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const USAGE = 'Usage: npm run ci:manifest -- <validate|inventory> [--json]\n';

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function failure(code: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    outcome: 'inconclusive',
    exitCode: 2,
    code,
    why: 'The control manifest could not produce trusted inventory evidence.',
    guidance: ['Repair the named manifest or invocation contract.', 'Re-run the canonical validation command.'],
    reproduce: 'npm run ci:manifest -- validate --json',
    retryable: false,
  };
}

function emitFailure(code: string, json: boolean, output: ManifestCliOutput): 2 {
  if (json) output.stdout(jsonLine(failure(code)));
  else output.stderr(`INCONCLUSIVE ${code}\nFix: npm run ci:manifest -- validate --json\n`);
  return 2;
}

export function runManifestCli(args: readonly string[], cwd: string, output: ManifestCliOutput): 0 | 2 {
  if (args.length === 1 && isHelpFlag(args[0]!)) {
    output.stdout(USAGE);
    return 0;
  }
  const json = args.includes('--json');
  const command = args[0];
  if (command !== 'validate' && command !== 'inventory') {
    return emitFailure('ci.input.command-invalid', json, output);
  }
  const parsed = parseClosedOptions(args.slice(1), {
    booleanOptions: ['--json'],
    valueOptions: [],
  });
  if (parsed.error !== null) return emitFailure(parsed.error, json, output);
  try {
    const manifest = loadControlManifest(cwd);
    if (command === 'inventory') {
      const inventory = buildControlInventory(manifest);
      if (json) output.stdout(jsonLine(inventory));
      else output.stdout(`PASS ci.manifest.inventory\nControls: ${inventory.controls.length}\nDigest: ${inventory.manifestDigest}\n`);
      return 0;
    }
    const result = {
      schemaVersion: 1,
      outcome: 'pass',
      exitCode: 0,
      code: 'ci.manifest.valid',
      manifestDigest: digestControlManifest(manifest),
    };
    if (json) output.stdout(jsonLine(result));
    else output.stdout(`PASS ${result.code}\nDigest: ${result.manifestDigest}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof ControlManifestError ? error.issue.code : 'ci.manifest.unavailable';
    return emitFailure(code, json, output);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runManifestCli(process.argv.slice(2), process.cwd(), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
