import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { readFileSync, readSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { cleanGitEnv } from '../src/lib/git-env.ts';
import { digestControlManifest, loadControlManifest } from './lib/ci-control/manifest.ts';
import {
  MAX_PRE_PUSH_INPUT_BYTES,
  RefPolicyError,
  buildInconclusiveRefPolicyReceipt,
  evaluateOutgoingRefPolicy,
  normalizeRemoteIdentity,
  parsePrePushInput,
  serializeRefPolicyReceipt,
  type OutgoingRefPolicyV1,
  type RefGraphFactV1,
  type RefUpdateV1,
} from './lib/ci-control/ref-policy.ts';
import { sha256Bytes } from './lib/verification/boundary-run/shared.ts';

const TRUSTED_GIT = '/usr/bin/git';
const GIT_TIMEOUT_MS = 10_000;
const MAX_GIT_OUTPUT_BYTES = 1_000_000;

interface RefPolicyCliRuntime {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readInput: () => Uint8Array;
  resolveGraphFacts: (
    cwd: string,
    policy: OutgoingRefPolicyV1,
    updates: readonly RefUpdateV1[],
  ) => RefGraphFactV1[];
  now: () => Date;
}

interface ParsedArgs {
  help: boolean;
  json: boolean;
  remoteName: string | null;
  remoteLocation: string | null;
}

function boundedStdin(): Uint8Array {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const chunk = Buffer.allocUnsafe(Math.min(8_192, MAX_PRE_PUSH_INPUT_BYTES + 1 - total));
    const count = readSync(0, chunk, 0, chunk.length, null);
    if (count === 0) break;
    total += count;
    if (total > MAX_PRE_PUSH_INPUT_BYTES) throw new RefPolicyError('ci.refs.input-budget');
    chunks.push(chunk.subarray(0, count));
  }
  return Buffer.concat(chunks, total);
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { help: false, json: false, remoteName: null, remoteLocation: null };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    if (!['--help', '--json', '--remote-name', '--remote-location'].includes(option) || seen.has(option)) {
      throw new RefPolicyError('ci.refs.input-malformed');
    }
    seen.add(option);
    if (option === '--help') parsed.help = true;
    else if (option === '--json') parsed.json = true;
    else {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) throw new RefPolicyError('ci.refs.input-malformed');
      index += 1;
      if (option === '--remote-name') parsed.remoteName = value;
      else parsed.remoteLocation = value;
    }
  }
  if (!parsed.help && (parsed.json !== true || parsed.remoteName === null || parsed.remoteLocation === null)) {
    throw new RefPolicyError('ci.refs.input-malformed');
  }
  if (parsed.help && args.length !== 1) throw new RefPolicyError('ci.refs.input-malformed');
  return parsed;
}

function git(cwd: string, args: readonly string[]): { status: number | null; stdout: string } {
  const result = spawnSync(TRUSTED_GIT, args, {
    cwd,
    env: { ...cleanGitEnv(), GIT_NO_REPLACE_OBJECTS: '1' },
    encoding: 'utf8',
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: result.status, stdout: result.status === 0 ? result.stdout.trim() : '' };
}

export function assertSupportedObjectFormat(cwd: string): void {
  const objectFormat = git(cwd, ['rev-parse', '--show-object-format']);
  if (objectFormat.status !== 0 || objectFormat.stdout !== 'sha1') {
    throw new RefPolicyError('ci.refs.object-format-unsupported');
  }
}

function resolveOid(cwd: string, expression: string): string | null {
  const result = git(cwd, ['rev-parse', '--verify', '--end-of-options', expression]);
  return result.status === 0 && /^[0-9a-f]{40}$/.test(result.stdout) ? result.stdout : null;
}

function objectType(cwd: string, oid: string): RefGraphFactV1['localObjectType'] {
  const result = git(cwd, ['cat-file', '-t', oid]);
  if (result.status !== 0) return 'unavailable';
  if (result.stdout === 'commit') return 'commit';
  if (result.stdout === 'tag') return 'annotated-tag';
  return 'other';
}

function objectExists(cwd: string, oid: string | null): boolean {
  return oid === null || git(cwd, ['cat-file', '-e', `${oid}^{object}`]).status === 0;
}

function ancestor(cwd: string, base: string, candidate: string): boolean | null {
  const result = git(cwd, ['merge-base', '--is-ancestor', base, candidate]);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return null;
}

export function resolveNativeRefGraphFacts(
  cwd: string,
  policy: OutgoingRefPolicyV1,
  updates: readonly RefUpdateV1[],
): RefGraphFactV1[] {
  assertSupportedObjectFormat(cwd);
  const toolDigest = `sha256:${sha256Bytes(readFileSync(TRUSTED_GIT))}`;
  return updates.map((update) => {
    if (update.operation === 'delete') {
      return {
        objectFormat: 'sha1',
        toolDigest,
        localObjectType: 'unavailable',
        relation: 'unavailable',
        peeledCommitOid: null,
        trustedBaseAncestor: null,
        localRefOid: null,
        remoteObjectAvailable: objectExists(cwd, update.remoteOid),
      };
    }
    const localOid = update.localOid!;
    const type = objectType(cwd, localOid);
    const localRefOid = update.localRef === null ? null : resolveOid(cwd, update.localRef);
    const peeledCommitOid = type === 'annotated-tag' ? resolveOid(cwd, `${localOid}^{commit}`) : null;
    if (update.operation === 'create') {
      return {
        objectFormat: 'sha1',
        toolDigest,
        localObjectType: type,
        relation: 'new',
        peeledCommitOid,
        trustedBaseAncestor: null,
        localRefOid,
        remoteObjectAvailable: true,
      };
    }
    const remoteAvailable = objectExists(cwd, update.remoteOid);
    const relation = remoteAvailable && update.remoteOid !== null
      ? ancestor(cwd, update.remoteOid, localOid)
      : null;
    return {
      objectFormat: 'sha1',
      toolDigest,
      localObjectType: type,
      relation: relation === true ? 'fast-forward' : relation === false ? 'non-fast-forward' : 'unavailable',
      peeledCommitOid,
      trustedBaseAncestor: null,
      localRefOid,
      remoteObjectAvailable: remoteAvailable,
    };
  });
}

const defaultRuntime: RefPolicyCliRuntime = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  readInput: boundedStdin,
  resolveGraphFacts: resolveNativeRefGraphFacts,
  now: () => new Date(),
};

export function runRefPolicyCli(
  args: readonly string[],
  cwd = process.cwd(),
  runtime: RefPolicyCliRuntime = defaultRuntime,
): 0 | 1 | 2 {
  try {
    const options = parseArgs(args);
    if (options.help) {
      runtime.stdout('Usage: npm --silent run ci:ref-policy -- --remote-name <name> --remote-location <location> --json\n');
      return 0;
    }
    const manifest = loadControlManifest(cwd);
    if (manifest.outgoingRefPolicy === null) throw new RefPolicyError('ci.refs.policy-unknown');
    const remote = normalizeRemoteIdentity(options.remoteName!, options.remoteLocation!);
    assertSupportedObjectFormat(cwd);
    const updates = parsePrePushInput(runtime.readInput());
    const facts = runtime.resolveGraphFacts(cwd, manifest.outgoingRefPolicy, updates);
    const receipt = evaluateOutgoingRefPolicy(
      manifest.outgoingRefPolicy,
      remote,
      updates,
      facts,
      digestControlManifest(manifest),
      runtime.now(),
    );
    runtime.stdout(Buffer.from(serializeRefPolicyReceipt(receipt)).toString('utf8'));
    return receipt.exitCode;
  } catch (error) {
    const code = error instanceof RefPolicyError ? error.code : 'ci.refs.graph-unavailable';
    runtime.stdout(Buffer.from(serializeRefPolicyReceipt(buildInconclusiveRefPolicyReceipt(code, runtime.now()))).toString('utf8'));
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runRefPolicyCli(process.argv.slice(2));
}
