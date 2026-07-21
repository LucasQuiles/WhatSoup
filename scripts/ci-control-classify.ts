#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import {
  classifyExactRevision,
  type ExactRevisionInput,
} from './lib/ci-control/classifier.ts';

export interface ClassifierCliOutput {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const EVENTS = new Set<ExactRevisionInput['eventName']>([
  'pull_request',
  'merge_group',
  'push',
  'tag',
  'local',
]);
const OID = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const USAGE = 'Usage: npm run ci:classify -- --event <pull_request|merge_group|push|tag|local> --candidate <40-hex> --base <40-hex> [--merge <40-hex>] --manifest-digest <sha256:hex> [--json]\n';

function failure(code: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    outcome: 'inconclusive',
    exitCode: 2,
    code,
    controlId: 'ci.exact-revision-classifier',
    owner: 'ci-classifier-owner',
    location: { kind: 'cli-invocation', name: 'ci:classify' },
    why: 'The exact-revision classifier invocation could not produce trusted evidence.',
    guidance: [
      'Provide only the closed event and full Git object identities.',
      'Re-run the canonical classifier command without caller-selected risk or checks.',
    ],
    reproduce: {
      command: 'npm run ci:classify -- --help',
      preconditions: ['Use the repository pinned runtime.'],
    },
    retryable: false,
  };
}

function parseArguments(args: readonly string[]):
  | { help: true }
  | { help: false; json: boolean; input: ExactRevisionInput }
  | { error: string; json: boolean } {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const json = args.includes('--json');
  const values = new Map<string, string>();
  const allowed = new Set(['--event', '--candidate', '--base', '--merge', '--manifest-digest']);
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    if (option === '--json') {
      if (values.has('--json')) return { error: 'ci.input.duplicate-option', json };
      values.set('--json', 'true');
      continue;
    }
    if (!allowed.has(option)) return { error: 'ci.input.option-unknown', json };
    if (values.has(option)) return { error: 'ci.input.duplicate-option', json };
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) return { error: 'ci.input.option-value-missing', json };
    values.set(option, value);
    index += 1;
  }

  const event = values.get('--event');
  const candidateOid = values.get('--candidate');
  const baseOid = values.get('--base');
  const mergeOid = values.get('--merge') ?? null;
  const manifestDigest = values.get('--manifest-digest');
  if (!EVENTS.has(event as ExactRevisionInput['eventName'])) return { error: 'ci.input.event-invalid', json };
  if (!OID.test(candidateOid ?? '') || !OID.test(baseOid ?? '') || (mergeOid !== null && !OID.test(mergeOid))) {
    return { error: 'ci.input.revision-invalid', json };
  }
  if (!DIGEST.test(manifestDigest ?? '')) return { error: 'ci.input.manifest-digest-invalid', json };
  if ((event === 'pull_request' || event === 'merge_group') && mergeOid === null) {
    return { error: 'ci.input.merge-revision-missing', json };
  }
  if (event !== 'pull_request' && event !== 'merge_group' && mergeOid !== null) {
    return { error: 'ci.input.merge-revision-unexpected', json };
  }
  return {
    help: false,
    json,
    input: {
      eventName: event as ExactRevisionInput['eventName'],
      baseOid: baseOid!,
      candidateOid: candidateOid!,
      mergeOid,
      manifestDigest: manifestDigest!,
    },
  };
}

export function runClassifierCli(
  args: readonly string[],
  cwd: string,
  output: ClassifierCliOutput,
): 0 | 1 | 2 {
  const parsed = parseArguments(args);
  if ('error' in parsed) {
    if (parsed.json) output.stdout(`${JSON.stringify(failure(parsed.error))}\n`);
    else output.stderr(`INCONCLUSIVE ${parsed.error}\nFix: npm run ci:classify -- --help\n`);
    return 2;
  }
  if (parsed.help) {
    output.stdout(USAGE);
    return 0;
  }
  const result = classifyExactRevision(cwd, parsed.input);
  if (parsed.json) output.stdout(`${JSON.stringify(result)}\n`);
  else {
    output.stdout(`${result.outcome.toUpperCase()} ${result.reasons[0] ?? 'ci.classification.complete'}\nRisk: ${result.riskTier}\nCandidate: ${result.candidateOid}\n`);
  }
  return result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runClassifierCli(process.argv.slice(2), process.cwd(), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
