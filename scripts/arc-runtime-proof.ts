import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  checkArcBindingDrift,
  type ArcDriftResult,
} from './arc-binding-drift-check.ts';
import { assertNoSecretLike } from './artifact-redaction.ts';
import {
  readArcBindingHealth,
  type ArcBindingHealthLoaded,
} from '../src/core/arc-binding-health.ts';
import { requireRecord, requireString, requireStringArray } from '../src/lib/type-guards.ts';

const CONSUMER = 'whatsoup';
const RUNTIME_PROOF_FILE = '.arc/runtime-enforcement.verification-record.json';
const VERIFICATION_RECORD = 'verification-record';

export interface ArcRuntimeProofArgs {
  healthJson: string;
  out: string;
  repoRoot: string;
  arcRepoDir?: string;
}

interface ParsedArgs extends ArcRuntimeProofArgs {
  help: boolean;
}

function usage(): string {
  return [
    'Usage: arc-runtime-proof.ts --health-json health.json [--out .arc/runtime-enforcement.verification-record.json] [--repo-root DIR] [--arc-repo-dir DIR]',
    '',
    'Emits a schema-valid ARC verification-record only when WhatSoup runtime health',
    'matches the installed ARC binding and the installed binding declares verification-record.',
  ].join('\n');
}

export function parseArgs(argv: string[], cwd = process.cwd()): ParsedArgs {
  let healthJson = '';
  let out = path.join(cwd, RUNTIME_PROOF_FILE);
  let repoRoot = cwd;
  let arcRepoDir: string | undefined;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--health-json') {
      const value = argv[index + 1];
      if (!value) throw new Error('--health-json requires a path');
      healthJson = path.resolve(cwd, value);
      index += 1;
    } else if (arg === '--out') {
      const value = argv[index + 1];
      if (!value) throw new Error('--out requires a path');
      out = path.resolve(cwd, value);
      index += 1;
    } else if (arg === '--repo-root') {
      const value = argv[index + 1];
      if (!value) throw new Error('--repo-root requires a path');
      repoRoot = path.resolve(cwd, value);
      index += 1;
    } else if (arg === '--arc-repo-dir') {
      const value = argv[index + 1];
      if (!value) throw new Error('--arc-repo-dir requires a path');
      arcRepoDir = path.resolve(cwd, value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${String(arg)}`);
    }
  }

  if (!help && !healthJson) throw new Error('--health-json is required');
  return { healthJson, out, repoRoot, arcRepoDir, help };
}

function parseRuntimeArcHealth(value: unknown): ArcBindingHealthLoaded {
  const arc = requireRecord(value, 'health.arc');
  if (arc.loaded !== true) throw new Error('health.arc.loaded must be true');
  return {
    loaded: true,
    consumer: requireString(arc.consumer, 'health.arc.consumer'),
    arcVersion: requireString(arc.arcVersion, 'health.arc.arcVersion'),
    modules: requireStringArray(arc.modules, 'health.arc.modules'),
    emits: requireStringArray(arc.emits, 'health.arc.emits'),
    binding: requireString(arc.binding, 'health.arc.binding'),
    payloadSha: requireString(arc.payloadSha, 'health.arc.payloadSha'),
  };
}

function assertSameString(observed: string, expected: string, label: string): void {
  if (observed !== expected) {
    throw new Error(`${label} mismatch: health=${observed} installed=${expected}`);
  }
}

function assertSameStringArray(observed: string[], expected: string[], label: string): void {
  const observedKey = observed.join('\n');
  const expectedKey = expected.join('\n');
  if (observedKey !== expectedKey) {
    throw new Error(`${label} mismatch: health=[${observed.join(', ')}] installed=[${expected.join(', ')}]`);
  }
}

function assertDriftFree(result: ArcDriftResult): void {
  if (result.status !== 'ok') {
    const detail = [
      result.reason,
      ...(result.pinDrift ?? []),
      ...(result.driftedFiles ?? []).map((entry) => `${entry.file} drift`),
    ].filter(Boolean).join('; ');
    throw new Error(`ARC binding drift check ${result.status}${detail ? `: ${detail}` : ''}`);
  }
}

function loadHealth(pathname: string): ArcBindingHealthLoaded {
  const text = readFileSync(pathname, 'utf8');
  assertNoSecretLike(text, 'runtime health JSON');
  const parsed = requireRecord(JSON.parse(text), 'health');
  return parseRuntimeArcHealth(parsed.arc);
}

export function buildRuntimeProof(args: ArcRuntimeProofArgs): Record<string, unknown> {
  const healthArc = loadHealth(args.healthJson);
  const installed = readArcBindingHealth(args.repoRoot);
  if (!installed.loaded) {
    throw new Error(`installed ARC binding not loaded: ${installed.reason}`);
  }
  assertSameString(healthArc.consumer, CONSUMER, 'consumer');
  assertSameString(installed.consumer, CONSUMER, 'installed consumer');
  assertSameString(healthArc.arcVersion, installed.arcVersion, 'arcVersion');
  assertSameString(healthArc.payloadSha, installed.payloadSha, 'payloadSha');
  assertSameString(healthArc.binding, installed.binding, 'binding');
  assertSameStringArray(healthArc.modules, installed.modules, 'modules');
  assertSameStringArray(healthArc.emits, installed.emits, 'emits');

  if (!installed.emits.includes(VERIFICATION_RECORD)) {
    throw new Error('installed ARC binding does not declare verification-record emission');
  }
  assertDriftFree(checkArcBindingDrift({
    repoRoot: args.repoRoot,
    arcRepoDir: args.arcRepoDir,
  }));

  return {
    id: `${CONSUMER}-runtime-enforcement`,
    arc_version: installed.arcVersion,
    proof_class: 'probe',
    source_layer: 'judgment',
    ts: new Date().toISOString(),
    sha: installed.payloadSha,
    payload_type: VERIFICATION_RECORD,
    payload: {
      claim: `${CONSUMER} runtime loaded and enforced ARC binding`,
      verification_action: 'compare runtime health ARC metadata against installed ARC binding and drift guard',
      verdict: 'pass',
      evidence_refs: [
        `arc-binding:${CONSUMER}`,
        `install-target:${CONSUMER}`,
        `runtime-health:${CONSUMER}`,
      ],
      limitations: [
        'proves runtime binding load and launch-enforcement metadata, not full WhatSoup task success',
      ],
    },
  };
}

function writeJsonAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

export function run(
  argv: string[] = process.argv.slice(2),
  cwd = process.cwd(),
  _env: NodeJS.ProcessEnv = process.env,
): 0 | 1 {
  try {
    const args = parseArgs(argv, cwd);
    if (args.help) {
      console.log(usage());
      return 0;
    }
    const proof = buildRuntimeProof(args);
    const text = `${JSON.stringify(proof, null, 2)}\n`;
    assertNoSecretLike(text, 'runtime proof artifact');
    const diagnostic = `ARC_RUNTIME_PROOF status=pass consumer=${CONSUMER} out=${args.out}`;
    assertNoSecretLike(diagnostic, 'runtime proof diagnostics');
    writeJsonAtomic(args.out, text);
    console.log(diagnostic);
    return 0;
  } catch (err) {
    console.error(`arc runtime proof failed: ${(err as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run();
}
