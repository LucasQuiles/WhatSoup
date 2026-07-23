#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { parseClosedOptions } from './lib/cli-args.ts';
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
const CLASSIFIER_OPTION_SCHEMA = {
  booleanOptions: ['--json'],
  valueOptions: ['--event', '--candidate', '--base', '--merge', '--manifest-digest'],
} as const;
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

export function runClassifierCli(
  args: readonly string[],
  cwd: string,
  output: ClassifierCliOutput,
): 0 | 1 | 2 {
  if (args.length === 1 && args[0] === '--help') {
    output.stdout(USAGE);
    return 0;
  }
  const json = args.includes('--json');
  const parsed = parseClosedOptions(args, CLASSIFIER_OPTION_SCHEMA);
  const event = parsed.values.get('--event');
  const candidateOid = parsed.values.get('--candidate');
  const baseOid = parsed.values.get('--base');
  const mergeOid = parsed.values.get('--merge') ?? null;
  const manifestDigest = parsed.values.get('--manifest-digest');
  const inputError = parsed.error
    ?? (!EVENTS.has(event as ExactRevisionInput['eventName']) ? 'ci.input.event-invalid' : null)
    ?? (!OID.test(candidateOid ?? '') || !OID.test(baseOid ?? '') || (mergeOid !== null && !OID.test(mergeOid))
      ? 'ci.input.revision-invalid'
      : null)
    ?? (!DIGEST.test(manifestDigest ?? '') ? 'ci.input.manifest-digest-invalid' : null)
    ?? ((event === 'pull_request' || event === 'merge_group') && mergeOid === null
      ? 'ci.input.merge-revision-missing'
      : null)
    ?? (event !== 'pull_request' && event !== 'merge_group' && mergeOid !== null
      ? 'ci.input.merge-revision-unexpected'
      : null);
  if (inputError !== null) {
    if (json) output.stdout(`${JSON.stringify(failure(inputError))}\n`);
    else output.stderr(`INCONCLUSIVE ${inputError}\nFix: npm run ci:classify -- --help\n`);
    return 2;
  }
  const input: ExactRevisionInput = {
    eventName: event as ExactRevisionInput['eventName'],
    baseOid: baseOid!,
    candidateOid: candidateOid!,
    mergeOid,
    manifestDigest: manifestDigest!,
  };
  const result = classifyExactRevision(cwd, input);
  if (json) output.stdout(`${JSON.stringify(result)}\n`);
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
