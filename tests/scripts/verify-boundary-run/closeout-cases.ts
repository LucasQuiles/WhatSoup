import { expect, it } from 'vitest';

import {
  BOUNDARY_PINNED_GENERATED_INDEX_PARENT,
  EXPECTED_CHILD_CONTRACT_ROWS,
  EXPECTED_PREDECESSOR_ROWS,
  EXPECTED_PROFILE_PATHS,
  EXPECTED_PROFILE_ROWS,
  EXPECTED_WIRE_SCHEMAS,
  FIXTURE_EMAIL,
  OID,
  OID_C,
  OID_D,
  SHA,
  SHA_B,
  SHA_C,
  SNAPSHOT_DECLARATIONS,
  SSH_REMOTE,
  TIME,
  boundaryCli,
  boundaryRun,
  canonicalJson,
  canonicalSha,
  chmodSync,
  copyFileSync,
  createFinalizedSyntheticReconciliation,
  createHash,
  evaluateBaseline,
  evaluateCandidate,
  execFileSync,
  existsSync,
  expectedBcf00Markers,
  fileSha,
  fillSyntheticRequiredAttempts,
  finalizeSyntheticObservation,
  fixtureRoots,
  git,
  initializeSyntheticReconciliation,
  installImportedRun,
  loadCorpus,
  lstatSync,
  makeCliRepo,
  makeEvidenceRoot,
  makeOutputRun,
  makeSnapshotRepo,
  marker,
  mkdirSync,
  mkdtempSync,
  path,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  tmpdir,
  validAttempt,
  validBundleInput,
  validChild,
  validChildImportInput,
  validFinding,
  validImmutableClosureInput,
  validLifecycleStateInput,
  validManifest,
  validPredecessor,
  validPredecessorChainInput,
  validReview,
  validReviewJoinInput,
  validSnapshot,
  validStream,
  validTransitionInput,
  validateBoundaryRun,
  withValue,
  writeFileSync,
  writeSyntheticRunInitAnchor,
} from './support.ts';

export function registerCloseoutCases(): void {
  it('routes closeout operations to fail-closed profile and receipt verification contracts', async () => {
    const api = boundaryCli as unknown as {
      runBoundaryRunCli?: (argv: readonly string[], cwd?: string) => Promise<ReturnType<typeof validateBoundaryRun>>;
    };
    expect(typeof api.runBoundaryRunCli).toBe('function');
    if (!api.runBoundaryRunCli) return;
    const fixture = makeCliRepo();
    expect(await api.runBoundaryRunCli([
      'init', '--run-dir', fixture.runDir, '--task', 'BCF-00', '--profile', 'bcf00-observation',
      '--preserve-owner-path', 'owner.tsv',
    ], fixture.repo)).toMatchObject({ ok: true, exitCode: 0 });
    const forbidden = await api.runBoundaryRunCli([
      'closeout', '--run-dir', fixture.runDir, '--attempt-id', 'closeout-one',
    ], fixture.repo);
    expect(forbidden).toMatchObject({ ok: false, exitCode: 2, verdict: 'Inconclusive' });
    expect(forbidden.issues.map((entry) => entry.code)).toContain('closeout-profile-forbidden');
    const missing = await api.runBoundaryRunCli([
      'verify-closeout', '--run-dir', fixture.runDir,
    ], fixture.repo);
    expect(missing).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
    expect(missing.issues.map((entry) => entry.code)).toContain('verify-closeout-failed');
  });


  it('[BCF00-U12] rejects incoherent lifecycle, verification state, snapshot, or aggregation', () => {
    const api = boundaryRun as unknown as {
      verifyBoundaryLifecycleState?: (input: Record<string, unknown>) => {
        result: ReturnType<typeof validateBoundaryRun>;
        verificationScope: string | null;
      };
    };
    expect(typeof api.verifyBoundaryLifecycleState).toBe('function');
    if (!api.verifyBoundaryLifecycleState) return;
    const cases: Array<{ code: string; input: ReturnType<typeof validLifecycleStateInput> }> = [];
    const invalidLifecycle = validLifecycleStateInput();
    invalidLifecycle.lifecycle.status = 'finished';
    cases.push({ code: 'lifecycle-invalid', input: invalidLifecycle });
    const wrongTerminal = validLifecycleStateInput();
    wrongTerminal.lifecycle.status = 'active';
    cases.push({ code: 'lifecycle-terminal-mismatch', input: wrongTerminal });
    const activeMix = validLifecycleStateInput();
    activeMix.manifestState = 'active';
    activeMix.presentFiles.manifestLock = true;
    cases.push({ code: 'verification-state-mixed', input: activeMix });
    const finalizedMissing = validLifecycleStateInput();
    finalizedMissing.presentFiles.ledgerLock = false;
    cases.push({ code: 'verification-state-mixed', input: finalizedMissing });
    const snapshotDrift = validLifecycleStateInput();
    snapshotDrift.liveSnapshotDigestSha256 = SHA_C;
    cases.push({ code: 'verification-snapshot-drift', input: snapshotDrift });
    const missingRequired = validLifecycleStateInput();
    missingRequired.attempts = [];
    cases.push({ code: 'lifecycle-required-incomplete', input: missingRequired });
    for (const candidate of cases) {
      const result = api.verifyBoundaryLifecycleState(candidate.input as unknown as Record<string, unknown>).result;
      expect(result, candidate.code).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
      expect(result.issues.map((entry) => entry.code), candidate.code).toContain(candidate.code);
    }
  });

  it('[BCF00-N12] accepts coherent terminal lifecycle with auto-detected finalized verification', () => {
    const api = boundaryRun as unknown as {
      verifyBoundaryLifecycleState?: (input: Record<string, unknown>) => {
        result: ReturnType<typeof validateBoundaryRun>;
        verificationScope: string | null;
      };
    };
    expect(typeof api.verifyBoundaryLifecycleState).toBe('function');
    if (!api.verifyBoundaryLifecycleState) return;
    expect(api.verifyBoundaryLifecycleState(validLifecycleStateInput() as unknown as Record<string, unknown>)).toMatchObject({
      result: { ok: true, exitCode: 0, verdict: 'Pass' },
      verificationScope: 'finalized',
    });
  });

  it('[BCF00-U14] rejects substituted, colliding, reused, or partially published bundles', () => {
    const api = boundaryRun as unknown as {
      publishBoundaryCloseoutBundle?: (input: Record<string, unknown>) => {
        result: ReturnType<typeof validateBoundaryRun>;
        bundlePath: string | null;
      };
    };
    expect(typeof api.publishBoundaryCloseoutBundle).toBe('function');
    if (!api.publishBoundaryCloseoutBundle) return;
    for (const objectName of ['runManifest', 'completionReceipt', 'ledger', 'closeoutCore', 'negativeReport', 'closeoutReceipt'] as const) {
      const input = validBundleInput();
      const target = input.objects[objectName] as Record<string, unknown>;
      target['substituted'] = true;
      const result = api.publishBoundaryCloseoutBundle(input as unknown as Record<string, unknown>).result;
      expect(result, objectName).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
      expect(result.issues.map((entry) => entry.code), objectName).toContain('bundle-hash-mismatch');
    }
    const collision = validBundleInput();
    collision.rejectedParent = collision.acceptedParent;
    const collisionResult = api.publishBoundaryCloseoutBundle(collision as unknown as Record<string, unknown>).result;
    expect(collisionResult.issues.map((entry) => entry.code)).toContain('bundle-path-collision');

    const reused = validBundleInput();
    mkdirSync(path.join(reused.acceptedParent, reused.runId));
    const reusedResult = api.publishBoundaryCloseoutBundle(reused as unknown as Record<string, unknown>).result;
    expect(reusedResult.issues.map((entry) => entry.code)).toContain('bundle-root-reused');

    const partial = validBundleInput();
    mkdirSync(path.join(partial.acceptedParent, `.${partial.runId}.publishing`));
    const partialResult = api.publishBoundaryCloseoutBundle(partial as unknown as Record<string, unknown>).result;
    expect(partialResult.issues.map((entry) => entry.code)).toContain('bundle-partial-publication');
  });

  it('[BCF00-N14] exclusively publishes one hash-joined bundle at its derived path', () => {
    const api = boundaryRun as unknown as {
      publishBoundaryCloseoutBundle?: (input: Record<string, unknown>) => {
        result: ReturnType<typeof validateBoundaryRun>;
        bundlePath: string | null;
      };
    };
    expect(typeof api.publishBoundaryCloseoutBundle).toBe('function');
    if (!api.publishBoundaryCloseoutBundle) return;
    const input = validBundleInput();
    const outcome = api.publishBoundaryCloseoutBundle(input as unknown as Record<string, unknown>);
    const expected = path.join(input.acceptedParent, input.runId);
    expect(outcome).toMatchObject({
      result: { ok: true, exitCode: 0, verdict: 'Pass' },
      bundlePath: expected,
    });
    for (const basename of [
      'run_manifest.json',
      'run_manifest.sha256',
      'completion_receipt.json',
      'completion_receipt.sha256',
      'chain_ledger.json',
      'chain_ledger.sha256',
      'closeout_core.json',
      'negative_control_report.json',
      'closeout_receipt.json',
      'closeout_receipt.sha256',
    ]) expect(existsSync(path.join(expected, basename)), basename).toBe(true);
    expect(readFileSync(path.join(expected, 'closeout_receipt.sha256'), 'utf8')).toMatch(
      /^[0-9a-f]{64}  closeout_receipt\.json\n$/,
    );
  });


  it('[BCF00-U16] rejects immutable-byte, identity, ancestor, owner, or retry overwrite drift', () => {
    const api = boundaryRun as unknown as {
      validateBoundaryImmutableClosure?: (input: Record<string, unknown>) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(typeof api.validateBoundaryImmutableClosure).toBe('function');
    if (!api.validateBoundaryImmutableClosure) return;

    const finalized = validImmutableClosureInput();
    writeFileSync(path.join(finalized.closureRoot, 'run_manifest.json'), '{"finalized":false}\n');
    expect(api.validateBoundaryImmutableClosure(finalized as unknown as Record<string, unknown>).issues.map((entry) => entry.code))
      .toContain('immutable-file-drift');

    const helper = validImmutableClosureInput();
    writeFileSync(path.join(helper.closureRoot, 'helper.ts'), 'export const helper = false;\n');
    expect(api.validateBoundaryImmutableClosure(helper as unknown as Record<string, unknown>).issues.map((entry) => entry.code))
      .toContain('helper-hash-drift');

    const document = validImmutableClosureInput();
    writeFileSync(path.join(document.closureRoot, 'plan.md'), '# Changed\n');
    expect(api.validateBoundaryImmutableClosure(document as unknown as Record<string, unknown>).issues.map((entry) => entry.code))
      .toContain('document-hash-drift');

    const raced = validImmutableClosureInput();
    const parent = raced.reservedRoots[0]!.parentPath;
    renameSync(parent, `${parent}-old`);
    mkdirSync(parent);
    expect(api.validateBoundaryImmutableClosure(raced as unknown as Record<string, unknown>).issues.map((entry) => entry.code))
      .toContain('reserved-root-raced');

    const owner = validImmutableClosureInput();
    writeFileSync(path.join(owner.repo, 'owner.tsv'), 'changed owner\n');
    expect(api.validateBoundaryImmutableClosure(owner as unknown as Record<string, unknown>).issues.map((entry) => entry.code))
      .toContain('closure-owner-drift');

    const overwrite = validImmutableClosureInput();
    mkdirSync(overwrite.retryDestination);
    expect(api.validateBoundaryImmutableClosure(overwrite as unknown as Record<string, unknown>).issues.map((entry) => entry.code))
      .toContain('retry-overwrite');
  });

  it('[BCF00-N16] accepts stable immutable closure and a fresh new-run retry target', () => {
    const api = boundaryRun as unknown as {
      validateBoundaryImmutableClosure?: (input: Record<string, unknown>) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(typeof api.validateBoundaryImmutableClosure).toBe('function');
    if (!api.validateBoundaryImmutableClosure) return;
    const input = validImmutableClosureInput();
    expect(lstatSync(input.reservedRoots[0]!.parentPath).ino).toBe(Number(input.reservedRoots[0]!.parentInode));
    expect(api.validateBoundaryImmutableClosure(input as unknown as Record<string, unknown>)).toMatchObject({
      ok: true,
      exitCode: 0,
      verdict: 'Pass',
    });
    expect(existsSync(input.retryDestination)).toBe(false);
  });
}
