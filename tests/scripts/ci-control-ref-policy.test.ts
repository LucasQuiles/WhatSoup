import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveNativeRefGraphFacts, runRefPolicyCli } from '../../scripts/ci-control-ref-policy.ts';
import {
  MAX_PRE_PUSH_INPUT_BYTES,
  MAX_REF_POLICY_RECEIPT_BYTES,
  MAX_REF_UPDATES,
  ZERO_OID,
  buildInconclusiveRefPolicyReceipt,
  evaluateOutgoingRefPolicy,
  matchesSameProcessExactRefSetBinding,
  normalizeRemoteIdentity,
  parsePrePushInput,
  parseRefPolicyReceiptBytes,
  serializeRefPolicyReceipt,
  validateRefPolicyReceipt,
  type OutgoingRefPolicyV1,
  type RefGraphFactV1,
} from '../../scripts/lib/ci-control/ref-policy.ts';
import { reasonDefinition } from '../../scripts/lib/ci-control/reasons.ts';
import { canonicalizeBoundaryRun } from '../../scripts/lib/verification/boundary-run/shared.ts';

const A = 'a111111111111111111111111111111111111111';
const B = 'b222222222222222222222222222222222222222';
const C = 'c333333333333333333333333333333333333333';
const MANIFEST_DIGEST = `sha256:${'a'.repeat(64)}`;
const SCP_REMOTE = ['git', 'github.com:LucasQuiles/WhatSoup.git'].join('@');
const hash = (value: unknown): string => `sha256:${createHash('sha256')
  .update(canonicalizeBoundaryRun(value))
  .digest('hex')}`;

const policy = (overrides: Partial<OutgoingRefPolicyV1> = {}): OutgoingRefPolicyV1 => ({
  schemaVersion: 1,
  controlId: 'ci.outgoing-ref-policy',
  remotes: [{ name: 'origin', repositoryId: 'github.com/LucasQuiles/WhatSoup' }],
  branchNamespace: 'refs/heads/',
  releaseBranches: ['refs/heads/main'],
  releaseTagPrefixes: ['refs/tags/v'],
  allowedDeleteRefs: [],
  branchObjectType: 'commit',
  releaseTagObjectType: 'annotated-tag',
  nonFastForward: 'block',
  unknownRef: 'inconclusive',
  ...overrides,
});

const remote = normalizeRemoteIdentity(
  'origin',
  SCP_REMOTE,
);

const graph = (overrides: Partial<RefGraphFactV1> = {}): RefGraphFactV1 => ({
  objectFormat: 'sha1',
  toolDigest: `sha256:${'d'.repeat(64)}`,
  localObjectType: 'commit',
  relation: 'fast-forward',
  peeledCommitOid: null,
  trustedBaseAncestor: true,
  localRefOid: B,
  remoteObjectAvailable: true,
  ...overrides,
});

describe('bounded pre-push ref parser', () => {
  it('preserves exact create, update, and actual Git deletion rows', () => {
    const updates = parsePrePushInput(Buffer.from([
      `refs/heads/new ${A} refs/heads/new ${ZERO_OID}`,
      `refs/heads/topic ${B} refs/heads/topic ${A}`,
      `(delete) ${ZERO_OID} refs/heads/old ${C}`,
      '',
    ].join('\n')));

    expect(updates).toEqual([
      { operation: 'create', localRef: 'refs/heads/new', localOid: A, remoteRef: 'refs/heads/new', remoteOid: null },
      { operation: 'update', localRef: 'refs/heads/topic', localOid: B, remoteRef: 'refs/heads/topic', remoteOid: A },
      { operation: 'delete', localRef: null, localOid: null, remoteRef: 'refs/heads/old', remoteOid: C },
    ]);
  });

  it.each([
    [`refs/heads/topic ${A} refs/heads/topic ${B} extra\n`, 'ci.refs.input-malformed'],
    [`refs/heads/topic\t${A} refs/heads/topic ${B}\n`, 'ci.refs.input-malformed'],
    [`refs/heads/topic ${A} refs/heads/topic ${B}`, 'ci.refs.input-malformed'],
    [`refs/heads/topic ${A.toUpperCase()} refs/heads/topic ${B}\n`, 'ci.refs.input-malformed'],
    [`refs/heads/topic ${A.slice(1)} refs/heads/topic ${B}\n`, 'ci.refs.input-malformed'],
    [`refs/heads/topic ${A}a refs/heads/topic ${B}\n`, 'ci.refs.input-malformed'],
    [`refs/heads/topic ${'g'.repeat(40)} refs/heads/topic ${B}\n`, 'ci.refs.input-malformed'],
    [`(delete) ${A} refs/heads/topic ${B}\n`, 'ci.refs.input-malformed'],
    [`refs/heads/topic ${ZERO_OID} refs/heads/topic ${B}\n`, 'ci.refs.input-malformed'],
    [`(delete) ${ZERO_OID} refs/heads/topic ${ZERO_OID}\n`, 'ci.refs.input-malformed'],
    [`refs/heads/topic ${A} refs/heads/topic ${B}\nrefs/heads/other ${C} refs/heads/topic ${A}\n`, 'ci.refs.input-duplicate'],
    [`refs/heads/private\u0007 ${A} refs/heads/private ${B}\n`, 'ci.refs.input-malformed'],
    [`refs/heads/é ${A} refs/heads/é ${B}\n`, 'ci.refs.input-malformed'],
    [`refs/heads/.hidden ${A} refs/heads/.hidden ${B}\n`, 'ci.refs.input-malformed'],
    [`refs/heads/topic./child ${A} refs/heads/topic./child ${B}\n`, 'ci.refs.input-malformed'],
  ])('rejects malformed input without echoing it', (input, code) => {
    let thrown: unknown;
    try {
      parsePrePushInput(Buffer.from(input));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code, exitCode: 2 });
    expect(String(thrown)).not.toContain(input.trim());
  });

  it('checks byte and update-count budgets before parsing rows', () => {
    const rowsForExactLimit = Array.from({ length: 64 }, (_, index) => ({
      local: `refs/heads/l${index}-`,
      remote: `refs/heads/r${index}-`,
    }));
    let remaining = MAX_PRE_PUSH_INPUT_BYTES - Buffer.byteLength(rowsForExactLimit
      .map(({ local, remote }) => `${local} ${A} ${remote} ${ZERO_OID}\n`).join(''));
    for (const row of rowsForExactLimit) {
      const localRoom = 254 - row.local.length;
      const localAdd = Math.min(localRoom, remaining);
      row.local += 'x'.repeat(localAdd);
      remaining -= localAdd;
      const remoteRoom = 254 - row.remote.length;
      const remoteAdd = Math.min(remoteRoom, remaining);
      row.remote += 'y'.repeat(remoteAdd);
      remaining -= remoteAdd;
    }
    expect(remaining).toBe(0);
    const exactBytes = Buffer.from(rowsForExactLimit
      .map(({ local, remote }) => `${local} ${A} ${remote} ${ZERO_OID}\n`).join(''));
    expect(exactBytes.byteLength).toBe(MAX_PRE_PUSH_INPUT_BYTES);
    expect(parsePrePushInput(exactBytes)).toHaveLength(64);
    expect(() => parsePrePushInput(Buffer.alloc(MAX_PRE_PUSH_INPUT_BYTES + 1, 0x78)))
      .toThrowError(/ci\.refs\.input-budget/);

    const rows = Array.from({ length: MAX_REF_UPDATES }, (_, index) =>
      `refs/heads/r${index} ${A} refs/heads/r${index} ${ZERO_OID}`);
    expect(parsePrePushInput(Buffer.from(`${rows.join('\n')}\n`))).toHaveLength(MAX_REF_UPDATES);
    rows.push(`refs/heads/overflow ${A} refs/heads/overflow ${ZERO_OID}`);
    expect(() => parsePrePushInput(Buffer.from(`${rows.join('\n')}\n`)))
      .toThrowError(/ci\.refs\.input-budget/);
  });

  it('rejects truncated UTF-8 before interpreting ref text', () => {
    expect(() => parsePrePushInput(Uint8Array.from([0xc3])))
      .toThrowError(/ci\.refs\.input-malformed/);
  });

  it('classifies an unbound source expression separately from malformed destination data', () => {
    expect(() => parsePrePushInput(Buffer.from(`HEAD~1 ${A} refs/heads/topic ${ZERO_OID}\n`)))
      .toThrowError(/ci\.refs\.local-source-unbound/);
  });
});

describe('private same-process exact-ref binding', () => {
  it('binds the native receipt object to exact refs without serializing ref names', () => {
    const updates = parsePrePushInput(Buffer.from(`refs/heads/private-topic ${B} refs/heads/private-topic ${A}\n`));
    const receipt = evaluateOutgoingRefPolicy(policy(), remote, updates, [graph()], MANIFEST_DIGEST, new Date('2026-07-21T12:00:00.000Z'));
    const substituted = [{ ...updates[0]!, localRef: 'refs/heads/other', remoteRef: 'refs/heads/other' }];

    expect(matchesSameProcessExactRefSetBinding(receipt, updates, receipt.evidenceDigest)).toBe(true);
    expect(matchesSameProcessExactRefSetBinding(receipt, substituted, receipt.evidenceDigest)).toBe(false);
    expect(matchesSameProcessExactRefSetBinding(structuredClone(receipt), updates, receipt.evidenceDigest)).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain('private-topic');
  });

  it('invalidates the same object when its owner-produced receipt bytes are replaced', () => {
    const updates = parsePrePushInput(Buffer.from(`refs/heads/topic ${B} refs/heads/topic ${A}\n`));
    const passReceipt = evaluateOutgoingRefPolicy(policy(), remote, updates, [graph()], MANIFEST_DIGEST, new Date('2026-07-21T12:00:00.000Z'));
    const blockReceipt = evaluateOutgoingRefPolicy(
      policy(), remote, updates, [graph({ relation: 'non-fast-forward' })], MANIFEST_DIGEST, new Date('2026-07-21T12:00:00.000Z'),
    );
    Object.assign(passReceipt, structuredClone(blockReceipt));

    expect(matchesSameProcessExactRefSetBinding(passReceipt, updates, passReceipt.evidenceDigest)).toBe(false);
  });
});

describe('manifest-owned outgoing ref policy', () => {
  it('normalizes an approved remote without retaining credentials or raw location', () => {
    expect(remote).toEqual({ name: 'origin', repositoryId: 'github.com/LucasQuiles/WhatSoup' });
    expect(() => normalizeRemoteIdentity('origin', 'https://token@example.test/owner/repo.git'))
      .toThrowError(/ci\.refs\.remote-identity-unavailable/);
    for (const location of [
      ['ssh://git', 'github.com:2222/LucasQuiles/WhatSoup.git'].join('@'),
      'https://github.com/LucasQuiles/WhatSoup.git?credential=private',
      'https://github.com/LucasQuiles/WhatSoup.git#alternate',
    ]) {
      expect(() => normalizeRemoteIdentity('origin', location))
        .toThrowError(/ci\.refs\.remote-identity-unavailable/);
    }
  });

  it('passes a new branch with complete commit and trusted-base evidence', () => {
    const updates = parsePrePushInput(Buffer.from(`refs/heads/topic ${B} refs/heads/topic ${ZERO_OID}\n`));
    const result = evaluateOutgoingRefPolicy(policy(), remote, updates, [
      graph({ relation: 'new' }),
    ], MANIFEST_DIGEST);

    expect(result).toMatchObject({ outcome: 'pass', exitCode: 0, code: 'ci.refs.pass' });
  });

  it('distinguishes deterministic policy blocks from unavailable evidence', () => {
    const nonFastForward = parsePrePushInput(Buffer.from(`refs/heads/topic ${B} refs/heads/topic ${A}\n`));
    expect(evaluateOutgoingRefPolicy(policy(), remote, nonFastForward, [
      graph({ relation: 'non-fast-forward' }),
    ], MANIFEST_DIGEST)).toMatchObject({ outcome: 'block', exitCode: 1, code: 'ci.refs.force-update-prohibited' });

    expect(evaluateOutgoingRefPolicy(policy(), remote, nonFastForward, [
      graph({ relation: 'unavailable' }),
    ], MANIFEST_DIGEST)).toMatchObject({ outcome: 'inconclusive', exitCode: 2, code: 'ci.refs.graph-unavailable' });
  });

  it('requires annotated release tags that peel to commits', () => {
    const tag = parsePrePushInput(Buffer.from(`refs/tags/v1.2.3 ${B} refs/tags/v1.2.3 ${ZERO_OID}\n`));
    expect(evaluateOutgoingRefPolicy(policy(), remote, tag, [
      graph({ localObjectType: 'annotated-tag', relation: 'new', peeledCommitOid: C }),
    ], MANIFEST_DIGEST)).toMatchObject({ outcome: 'pass', exitCode: 0 });
    expect(evaluateOutgoingRefPolicy(policy(), remote, tag, [
      graph({ localObjectType: 'commit', relation: 'new', peeledCommitOid: null }),
    ], MANIFEST_DIGEST)).toMatchObject({ outcome: 'block', exitCode: 1, code: 'ci.refs.object-type-prohibited' });
    expect(evaluateOutgoingRefPolicy(policy(), remote, tag, [
      graph({ localObjectType: 'annotated-tag', relation: 'new', peeledCommitOid: C, trustedBaseAncestor: null }),
    ], MANIFEST_DIGEST)).toMatchObject({ outcome: 'inconclusive', exitCode: 2, code: 'ci.refs.graph-unavailable' });
  });

  it('blocks protected deletion and keeps a manifest-named scratch neighbor inconclusive', () => {
    const mainDelete = parsePrePushInput(Buffer.from(`(delete) ${ZERO_OID} refs/heads/main ${A}\n`));
    expect(evaluateOutgoingRefPolicy(policy(), remote, mainDelete, [graph({ localRefOid: null })], MANIFEST_DIGEST))
      .toMatchObject({ outcome: 'block', exitCode: 1, code: 'ci.refs.delete-prohibited' });

    const scratchDelete = parsePrePushInput(Buffer.from(`(delete) ${ZERO_OID} refs/heads/scratch/ci-canary ${A}\n`));
    expect(evaluateOutgoingRefPolicy(
      policy({ allowedDeleteRefs: ['refs/heads/scratch/ci-canary'] }),
      remote,
      scratchDelete,
      [graph({ localRefOid: null })],
      MANIFEST_DIGEST,
    )).toMatchObject({
      outcome: 'inconclusive',
      exitCode: 2,
      code: 'ci.refs.private-binding-unavailable',
    });

    expect(evaluateOutgoingRefPolicy(
      policy({ allowedDeleteRefs: ['refs/heads/main'] }),
      remote,
      mainDelete,
      [graph({ localRefOid: null })],
      MANIFEST_DIGEST,
    )).toMatchObject({ outcome: 'block', exitCode: 1, code: 'ci.refs.delete-prohibited' });

    const releaseDelete = parsePrePushInput(Buffer.from(`(delete) ${ZERO_OID} refs/tags/v1.2.3 ${A}\n`));
    expect(evaluateOutgoingRefPolicy(
      policy({ allowedDeleteRefs: ['refs/tags/v1.2.3'] }),
      remote,
      releaseDelete,
      [graph({ localRefOid: null })],
      MANIFEST_DIGEST,
    )).toMatchObject({ outcome: 'block', exitCode: 1, code: 'ci.refs.delete-prohibited' });
  });

  it('makes unknown policy, wrong remote, and moved local refs inconclusive or blocking by cause', () => {
    const unknown = parsePrePushInput(Buffer.from(`refs/notes/topic ${B} refs/notes/topic ${ZERO_OID}\n`));
    expect(evaluateOutgoingRefPolicy(policy(), remote, unknown, [graph({ relation: 'new' })], MANIFEST_DIGEST))
      .toMatchObject({ outcome: 'inconclusive', exitCode: 2, code: 'ci.refs.policy-unknown' });

    const branch = parsePrePushInput(Buffer.from(`refs/heads/topic ${B} refs/heads/topic ${ZERO_OID}\n`));
    expect(evaluateOutgoingRefPolicy(policy(), { name: 'mirror', repositoryId: 'example.test/repo' }, branch, [graph({ relation: 'new' })], MANIFEST_DIGEST))
      .toMatchObject({ outcome: 'block', exitCode: 1, code: 'ci.refs.remote-policy-prohibited' });
    expect(evaluateOutgoingRefPolicy(policy(), remote, branch, [graph({ relation: 'new', localRefOid: A })], MANIFEST_DIGEST))
      .toMatchObject({ outcome: 'inconclusive', exitCode: 2, code: 'ci.refs.graph-unavailable' });
  });

  it('aggregates every row exactly once and emits a sanitized canonical receipt', () => {
    const rawPrivateRef = 'refs/heads/customer-secret';
    const input = Buffer.from([
      `${rawPrivateRef} ${B} ${rawPrivateRef} ${ZERO_OID}`,
      `refs/heads/topic ${C} refs/heads/topic ${A}`,
      '',
    ].join('\n'));
    const updates = parsePrePushInput(input);
    const receipt = evaluateOutgoingRefPolicy(policy(), remote, updates, [
      graph({ relation: 'new' }),
      graph({ localRefOid: C, relation: 'unavailable' }),
    ], MANIFEST_DIGEST);
    const serialized = serializeRefPolicyReceipt(receipt);
    const parsed = JSON.parse(Buffer.from(serialized).toString('utf8'));

    expect(receipt).toMatchObject({ outcome: 'inconclusive', exitCode: 2, code: 'ci.refs.graph-unavailable' });
    expect(receipt.observations.map(({ updateIndex }) => updateIndex)).toEqual([0, 1]);
    expect(validateRefPolicyReceipt(parsed)).toEqual(receipt);
    expect(Buffer.from(serialized).toString('utf8')).not.toContain(rawPrivateRef);
    expect(Buffer.from(serialized).toString('utf8')).not.toContain(SCP_REMOTE);
    expect(receipt.inputBindingDigest).not.toBe(hash(updates));
    expect(receipt.observations[0]?.updateBindingDigest).not.toBe(hash(updates[0]));

    parsed.evidenceDigest = `sha256:${'0'.repeat(64)}`;
    expect(() => validateRefPolicyReceipt(parsed)).toThrowError(/ci\.refs\.input-malformed/);
  });

  it('binds graph facts and rejects digest-valid semantic receipt forgery', () => {
    const updates = parsePrePushInput(Buffer.from(`refs/heads/topic ${B} refs/heads/topic ${A}\n`));
    const pass = evaluateOutgoingRefPolicy(policy(), remote, updates, [graph()], MANIFEST_DIGEST);
    const changedFact = evaluateOutgoingRefPolicy(policy(), remote, updates, [
      graph({ trustedBaseAncestor: false }),
    ], MANIFEST_DIGEST);
    expect(pass.observations[0]?.graphEvidenceDigest).toMatch(/^sha256:/);
    expect(pass.observations[0]?.graphEvidence).toEqual(graph());
    expect(pass.evidenceDigest).not.toBe(changedFact.evidenceDigest);

    const forged = structuredClone(pass) as unknown as Record<string, unknown>;
    const forgedObservations = forged.observations as Array<Record<string, unknown>>;
    forgedObservations[0]!.outcome = 'block';
    forgedObservations[0]!.code = 'ci.refs.delete-prohibited';
    forged.evidenceDigest = `sha256:${createHash('sha256')
      .update(canonicalizeBoundaryRun(Object.fromEntries(Object.entries(forged).filter(([key]) => key !== 'evidenceDigest'))))
      .digest('hex')}`;
    expect(() => validateRefPolicyReceipt(forged)).toThrowError(/ci\.refs\.input-malformed/);

    const graphForged = structuredClone(pass) as unknown as Record<string, unknown>;
    const graphForgedObservations = graphForged.observations as Array<Record<string, unknown>>;
    const first = graphForgedObservations[0]!;
    const forgedGraph = first.graphEvidence as Record<string, unknown>;
    forgedGraph.relation = 'non-fast-forward';
    first.graphEvidenceDigest = hash(forgedGraph);
    graphForged.evidenceDigest = hash(Object.fromEntries(
      Object.entries(graphForged).filter(([key]) => key !== 'evidenceDigest'),
    ));
    expect(() => validateRefPolicyReceipt(graphForged)).toThrowError(/ci\.refs\.input-malformed/);

    const wrongNamespace = structuredClone(changedFact) as unknown as Record<string, unknown>;
    wrongNamespace.code = 'ci.hooks.path-missing';
    wrongNamespace.evidenceDigest = hash(Object.fromEntries(
      Object.entries(wrongNamespace).filter(([key]) => key !== 'evidenceDigest'),
    ));
    expect(() => validateRefPolicyReceipt(wrongNamespace)).toThrowError(/ci\.refs\.input-malformed/);
    expect(() => buildInconclusiveRefPolicyReceipt('ci.hooks.path-missing'))
      .toThrowError(/ci\.refs\.input-malformed/);

    const deletion = parsePrePushInput(Buffer.from(`(delete) ${ZERO_OID} refs/heads/private-topic ${A}\n`));
    const deletionBlock = evaluateOutgoingRefPolicy(
      policy(),
      remote,
      deletion,
      [graph({ localRefOid: null })],
      MANIFEST_DIGEST,
    );
    const deletionForged = structuredClone(deletionBlock) as unknown as Record<string, unknown>;
    const deletionObservations = deletionForged.observations as Array<Record<string, unknown>>;
    deletionForged.outcome = 'pass';
    deletionForged.exitCode = 0;
    deletionForged.code = 'ci.refs.pass';
    deletionObservations[0]!.outcome = 'pass';
    deletionObservations[0]!.code = 'ci.refs.pass';
    deletionForged.evidenceDigest = hash(Object.fromEntries(
      Object.entries(deletionForged).filter(([key]) => key !== 'evidenceDigest'),
    ));
    expect(() => validateRefPolicyReceipt(deletionForged)).toThrowError(/ci\.refs\.input-malformed/);
  });

  it('parses bounded strict receipt bytes before semantic validation', () => {
    const updates = parsePrePushInput(Buffer.from(`refs/heads/topic ${B} refs/heads/topic ${A}\n`));
    const receipt = evaluateOutgoingRefPolicy(policy(), remote, updates, [graph()], MANIFEST_DIGEST);
    expect(parseRefPolicyReceiptBytes(serializeRefPolicyReceipt(receipt))).toEqual(receipt);
    expect(() => parseRefPolicyReceiptBytes(Buffer.alloc(MAX_REF_POLICY_RECEIPT_BYTES + 1, 0x7b)))
      .toThrowError(/ci\.refs\.input-budget/);
    const raw = Buffer.from(serializeRefPolicyReceipt(receipt)).toString('utf8');
    expect(() => parseRefPolicyReceiptBytes(Buffer.from(raw.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'))))
      .toThrowError(/ci\.refs\.input-malformed/);
  });

  it('round-trips the maximum valid update set through the producer and consumer budget', () => {
    const input = Buffer.from(`${Array.from({ length: MAX_REF_UPDATES }, (_, index) =>
      `refs/heads/r${index} ${B} refs/heads/r${index} ${A}`).join('\n')}\n`);
    const updates = parsePrePushInput(input);
    const receipt = evaluateOutgoingRefPolicy(
      policy(),
      remote,
      updates,
      updates.map(() => graph()),
      MANIFEST_DIGEST,
    );
    const bytes = serializeRefPolicyReceipt(receipt);
    expect(bytes.byteLength).toBeLessThanOrEqual(MAX_REF_POLICY_RECEIPT_BYTES);
    expect(parseRefPolicyReceiptBytes(bytes)).toEqual(receipt);
  });
});

describe('report-only outgoing ref policy CLI', () => {
  const root = resolve(import.meta.dirname, '../..');
  const invoke = (
    args: string[],
    input: Uint8Array,
    facts: RefGraphFactV1[],
  ) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = runRefPolicyCli(args, root, {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      readInput: () => input,
      resolveGraphFacts: () => facts,
      now: () => new Date('2026-07-20T00:00:00.000Z'),
    });
    return { exitCode, stdout: stdout.join(''), stderr: stderr.join('') };
  };

  it('returns one receipt on stdout with deterministic exit codes and no raw ref or remote location', () => {
    const privateRef = 'refs/heads/customer-private';
    const result = invoke(
      ['--remote-name', 'origin', '--remote-location', SCP_REMOTE, '--json'],
      Buffer.from(`${privateRef} ${B} ${privateRef} ${ZERO_OID}\n`),
      [graph({ relation: 'new' })],
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'pass', exitCode: 0, controlId: 'ci.outgoing-ref-policy' });
    expect(result.stdout).not.toContain(privateRef);
    expect(result.stdout).not.toContain(SCP_REMOTE);
  });

  it('rejects unknown, duplicate, and caller-selected policy options as inconclusive', () => {
    for (const args of [
      ['--unknown'],
      ['--json', '--json'],
      ['--policy', 'candidate.json'],
      ['--allow-delete', 'refs/heads/main'],
    ]) {
      const result = invoke(args, Buffer.from('private-value-that-must-not-render'), []);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe('');
      expect(validateRefPolicyReceipt(JSON.parse(result.stdout))).toMatchObject({ outcome: 'inconclusive', exitCode: 2, code: 'ci.refs.input-malformed' });
      expect(result.stdout).not.toContain('private-value-that-must-not-render');
    }
  });

  it('renders help without reading stdin and keeps the active hook byte path separate', () => {
    const result = invoke(['--help'], Buffer.from('must-not-be-read'), []);
    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.stdout).toContain('ci:ref-policy');
    expect(readFileSync(resolve(root, '.husky/pre-push'), 'utf8')).not.toContain('ci:ref-policy');
    expect(invoke(['--help', '--json'], Buffer.from('must-not-be-read'), [])).toMatchObject({ exitCode: 2 });
  });

  it('exposes a working process help boundary without injecting conflicting package arguments', () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(packageJson.scripts['ci:ref-policy']).toBe(
      'bash scripts/run-with-pinned-node.sh scripts/ci-control-ref-policy.ts',
    );
    const result = spawnSync('bash', [
      resolve(root, 'scripts/run-with-pinned-node.sh'),
      resolve(root, 'scripts/ci-control-ref-policy.ts'),
      '--help',
    ], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: npm --silent run ci:ref-policy');

    const remoteLocation = SCP_REMOTE;
    const processResult = spawnSync('bash', [
      resolve(root, 'scripts/run-with-pinned-node.sh'),
      resolve(root, 'scripts/ci-control-ref-policy.ts'),
      '--remote-name', 'origin',
      '--remote-location', remoteLocation,
      '--json',
    ], { cwd: root, encoding: 'utf8', input: 'private malformed input' });
    expect(processResult.status).toBe(2);
    expect(JSON.parse(processResult.stdout)).toMatchObject({ code: 'ci.refs.input-malformed' });
    expect(processResult.stdout).not.toContain(remoteLocation);
    expect(processResult.stdout).not.toContain('private malformed input');
  });

  it('preserves block versus inconclusive outcomes from policy and graph evidence', () => {
    const input = Buffer.from(`refs/heads/topic ${B} refs/heads/topic ${A}\n`);
    const blocked = invoke(
      ['--remote-name', 'origin', '--remote-location', SCP_REMOTE, '--json'],
      input,
      [graph({ relation: 'non-fast-forward' })],
    );
    expect(blocked.exitCode).toBe(1);
    expect(JSON.parse(blocked.stdout)).toMatchObject({ outcome: 'block', code: 'ci.refs.force-update-prohibited' });

    const inconclusive = invoke(
      ['--remote-name', 'origin', '--remote-location', SCP_REMOTE, '--json'],
      input,
      [graph({ relation: 'unavailable' })],
    );
    expect(inconclusive.exitCode).toBe(2);
    expect(JSON.parse(inconclusive.stdout)).toMatchObject({ outcome: 'inconclusive', code: 'ci.refs.graph-unavailable' });
  });

  it('disables Git replacement objects when deriving ancestry facts', () => {
    const repository = mkdtempSync(resolve(tmpdir(), 'ci-ref-policy-replace-'));
    const git = (args: string[], input?: string) => execFileSync('/usr/bin/git', args, {
      cwd: repository,
      encoding: 'utf8',
      input,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'CI fixture',
        GIT_AUTHOR_EMAIL: 'ci-fixture@example.invalid',
        GIT_COMMITTER_NAME: 'CI fixture',
        GIT_COMMITTER_EMAIL: 'ci-fixture@example.invalid',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    }).trim();
    try {
      git(['init', '--quiet', '--object-format=sha1']);
      const tree = git(['mktree'], '');
      const remoteOid = git(['commit-tree', tree, '-m', 'remote']);
      const replacement = git(['commit-tree', tree, '-p', remoteOid, '-m', 'replacement']);
      const localOid = git(['commit-tree', tree, '-m', 'unrelated-local']);
      git(['update-ref', 'refs/heads/topic', localOid]);
      git(['replace', localOid, replacement]);
      const updates = parsePrePushInput(Buffer.from(
        `refs/heads/topic ${localOid} refs/heads/topic ${remoteOid}\n`,
      ));

      const facts = resolveNativeRefGraphFacts(repository, policy(), updates);
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({ relation: 'non-fast-forward', localRefOid: localOid });
      expect(evaluateOutgoingRefPolicy(policy(), remote, updates, facts, MANIFEST_DIGEST))
        .toMatchObject({ outcome: 'block', exitCode: 1, code: 'ci.refs.force-update-prohibited' });
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('rejects unsupported repository object formats as inconclusive evidence', () => {
    const repository = mkdtempSync(resolve(tmpdir(), 'ci-ref-policy-sha256-'));
    const result = execFileSync('/usr/bin/git', ['init', '--quiet', '--object-format=sha256'], {
      cwd: repository,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    expect(result).toBe('');
    try {
      const updates = parsePrePushInput(Buffer.from(
        `refs/heads/topic ${B} refs/heads/topic ${ZERO_OID}\n`,
      ));
      expect(() => resolveNativeRefGraphFacts(repository, policy(), updates))
        .toThrowError(/ci\.refs\.object-format-unsupported/);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('classifies a native SHA-256 pre-push row before fixed-width SHA-1 parsing', () => {
    const repository = mkdtempSync(resolve(tmpdir(), 'ci-ref-policy-sha256-cli-'));
    try {
      execFileSync('/usr/bin/git', ['init', '--quiet', '--object-format=sha256'], {
        cwd: repository,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      });
      mkdirSync(resolve(repository, 'controls'));
      copyFileSync(resolve(root, 'controls/ci-control-manifest.json'), resolve(repository, 'controls/ci-control-manifest.json'));
      const oid = 'a'.repeat(64);
      const result = spawnSync('bash', [
        resolve(root, 'scripts/run-with-pinned-node.sh'),
        resolve(root, 'scripts/ci-control-ref-policy.ts'),
        '--remote-name', 'origin',
        '--remote-location', SCP_REMOTE,
        '--json',
      ], {
        cwd: repository,
        encoding: 'utf8',
        input: `refs/heads/topic ${oid} refs/heads/topic ${'0'.repeat(64)}\n`,
      });
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        outcome: 'inconclusive',
        code: 'ci.refs.object-format-unsupported',
      });
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('is wired into the branch verification test set while remaining absent from the active hook', () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(packageJson.scripts['verify:push:branch']).toContain('tests/scripts/ci-control-ref-policy.test.ts');
    expect(readFileSync(resolve(root, '.husky/pre-push'), 'utf8')).not.toContain('ci:ref-policy');
  });
});

describe('outgoing ref reason catalog', () => {
  it('registers every native code with the correct default outcome', () => {
    expect(reasonDefinition('ci.refs.pass')).toMatchObject({ defaultOutcome: 'pass' });
    for (const code of [
      'ci.refs.input-malformed',
      'ci.refs.input-budget',
      'ci.refs.input-duplicate',
      'ci.refs.remote-identity-unavailable',
      'ci.refs.policy-unknown',
      'ci.refs.graph-unavailable',
      'ci.refs.local-source-unbound',
      'ci.refs.object-format-unsupported',
      'ci.refs.private-binding-unavailable',
    ]) {
      expect(reasonDefinition(code), code).toMatchObject({ defaultOutcome: 'inconclusive' });
    }
    for (const code of [
      'ci.refs.remote-policy-prohibited',
      'ci.refs.delete-prohibited',
      'ci.refs.force-update-prohibited',
      'ci.refs.object-type-prohibited',
    ]) {
      expect(reasonDefinition(code), code).toMatchObject({ defaultOutcome: 'block' });
    }
  });
});
