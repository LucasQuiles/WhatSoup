import { expect, it } from 'vitest';

import { childClosurePaths } from '../../../scripts/lib/verification/boundary-run-cli/shared.ts';

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

export function registerJoinCases(): void {
  it('counts exact structured-result aliases once and rejects neighboring collisions', () => {
    const manifest = validManifest();
    const readinessAttempt = {
      ...validAttempt(),
      id: 'readiness-check',
      stdout: validStream('attempts/readiness-check/stdout.log'),
      stderr: validStream('attempts/readiness-check/stderr.log'),
      structuredResult: validStream('readiness.json'),
    };
    const evaluatorStdout = validStream('attempts/predecessor-baseline-eval/stdout.log');
    const evaluatorAttempt = {
      ...validAttempt(),
      id: 'predecessor-baseline-eval',
      stdout: evaluatorStdout,
      stderr: validStream('attempts/predecessor-baseline-eval/stderr.log'),
      structuredResult: structuredClone(evaluatorStdout),
    };
    manifest.attempts = [readinessAttempt, evaluatorAttempt];
    manifest.artifacts = [{
      path: 'readiness.json',
      role: 'receipt',
      producerAttemptId: 'readiness-check',
      sha256: SHA,
      bytes: 1,
    }];

    expect(childClosurePaths(manifest).filter((entry) => entry === 'readiness.json')).toEqual([
      'readiness.json',
    ]);
    expect(childClosurePaths(manifest).filter((entry) => entry === evaluatorStdout.path)).toEqual([
      evaluatorStdout.path,
    ]);

    for (const artifact of [
      { ...manifest.artifacts[0]!, producerAttemptId: 'other-attempt' },
      { ...manifest.artifacts[0]!, sha256: SHA_B },
      { ...manifest.artifacts[0]!, bytes: 2 },
    ]) {
      const invalid = structuredClone(manifest);
      invalid.artifacts = [artifact];
      expect(() => childClosurePaths(invalid)).toThrow('child closure contains duplicate logical paths');
    }

    for (const structuredResult of [
      { ...evaluatorStdout, sha256: SHA_B },
      { ...evaluatorStdout, bytes: 2 },
      structuredClone(readinessAttempt.stdout),
    ]) {
      const invalid = structuredClone(manifest);
      invalid.attempts[1]!.structuredResult = structuredResult;
      expect(() => childClosurePaths(invalid)).toThrow('child closure contains duplicate logical paths');
    }
  });

  it('initializes a non-observation run only from one verified pinned predecessor closure', async () => {
    const api = boundaryCli as unknown as {
      runBoundaryRunCli?: (argv: readonly string[], cwd?: string) => Promise<ReturnType<typeof validateBoundaryRun>>;
    };
    expect(typeof api.runBoundaryRunCli).toBe('function');
    if (!api.runBoundaryRunCli) return;
    const fixture = makeCliRepo();
    const predecessorRunDir = path.join(fixture.repo, 'evidence/observation/predecessor-run');
    const predecessor = await finalizeSyntheticObservation(fixture.repo, predecessorRunDir, api.runBoundaryRunCli);
    const pin = [
      'BCF-00', 'bcf00-observation', 'predecessor-run', predecessor.terminalHead,
      predecessor.manifestSha256, predecessor.completionReceiptSha256, predecessor.ledgerSha256,
    ].join(',');
    const childPin = `upstream-observation,${predecessor.terminalHead},predecessor-run,${predecessor.manifestSha256}`;

    const badRunDir = path.join(fixture.repo, 'evidence/reconciliation/bad-parent');
    const badPin = pin.replace(predecessor.manifestSha256, SHA);
    expect(await api.runBoundaryRunCli([
      'init', '--run-dir', badRunDir, '--task', 'BCF-00', '--profile', 'bcf00-reconciliation',
      '--predecessor-run-dir', predecessorRunDir, '--predecessor-pin', badPin,
      '--child-pin', childPin, '--preserve-owner-path', 'owner.tsv',
    ], fixture.repo)).toMatchObject({ ok: false, exitCode: 2, verdict: 'Inconclusive' });
    expect(existsSync(badRunDir)).toBe(false);

    const parentRunDir = path.join(fixture.repo, 'evidence/reconciliation/parent-run');
    const initialized = await api.runBoundaryRunCli([
      'init', '--run-dir', parentRunDir, '--task', 'BCF-00', '--profile', 'bcf00-reconciliation',
      '--predecessor-run-dir', predecessorRunDir, '--predecessor-pin', pin,
      '--child-pin', childPin, '--preserve-owner-path', 'owner.tsv',
    ], fixture.repo);
    expect(initialized, JSON.stringify(initialized)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    const manifest = JSON.parse(readFileSync(path.join(parentRunDir, 'run_manifest.json'), 'utf8')) as {
      predecessor: { pin: { runId: string }; importedFiles: Array<{ path: string }>; treeDigestSha256: string };
    };
    expect(manifest.predecessor.pin.runId).toBe('predecessor-run');
    expect(manifest.predecessor.importedFiles.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      'run_init.json', 'run_init.sha256', 'run_manifest.json', 'run_manifest.sha256',
      'completion/chain_ledger.json', 'completion/chain_ledger.sha256',
      'completion/completion_receipt.json', 'completion/completion_receipt.sha256',
    ]));
    expect(manifest.predecessor.treeDigestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await api.runBoundaryRunCli(['verify', '--run-dir', parentRunDir], fixture.repo)).toMatchObject({
      ok: true,
      exitCode: 0,
      verdict: 'Inconclusive',
    });
    writeFileSync(path.join(parentRunDir, 'predecessor/completion/chain_ledger.json'), '{"mutated":true}\n');
    const mutated = await api.runBoundaryRunCli(['verify', '--run-dir', parentRunDir], fixture.repo);
    expect(mutated).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
    expect(mutated.issues.map((entry) => entry.code)).toContain('predecessor-import-mutation');
  });

  it('imports one finalized child only through its frozen profile pin and detects copied-byte drift', async () => {
    const api = boundaryCli as unknown as {
      runBoundaryRunCli?: (argv: readonly string[], cwd?: string) => Promise<ReturnType<typeof validateBoundaryRun>>;
    };
    expect(typeof api.runBoundaryRunCli).toBe('function');
    if (!api.runBoundaryRunCli) return;
    const fixture = makeCliRepo();
    const childRunDir = path.join(fixture.repo, 'evidence/observation/child-run');
    const childIdentity = await finalizeSyntheticObservation(fixture.repo, childRunDir, api.runBoundaryRunCli);

    const parentRunDir = path.join(fixture.repo, 'evidence/observation/parent-run');
    expect(await api.runBoundaryRunCli([
      'init', '--run-dir', parentRunDir, '--task', 'BCF-00', '--profile', 'bcf00-observation',
      '--preserve-owner-path', 'owner.tsv',
    ], fixture.repo)).toMatchObject({ ok: true, exitCode: 0 });
    const parentManifestPath = path.join(parentRunDir, 'run_manifest.json');
    const parent = JSON.parse(readFileSync(parentManifestPath, 'utf8')) as Record<string, unknown>;
    const parentRun = parent['run'] as Record<string, unknown>;
    parentRun['profileId'] = 'bcf00-reconciliation';
    parentRun['phase'] = 'reconciliation';
    parentRun['requiredAttemptIds'] = [...boundaryRun.RUN_CONTRACT_PROFILES['bcf00-reconciliation'].requiredAttemptIds];
    parentRun['requiredChildAliases'] = ['upstream-observation'];
    parentRun['requiredChildPins'] = [{
      alias: 'upstream-observation',
      head: childIdentity.terminalHead,
      runId: 'child-run',
      manifestSha256: childIdentity.manifestSha256,
    }];
    parentRun['mayComplete'] = true;
    parentRun['chainAppend'] = true;
    const predecessorFiles = [{
      path: 'run_manifest.json',
      sha256: childIdentity.manifestSha256,
      bytes: readFileSync(path.join(childRunDir, 'run_manifest.json')).byteLength,
    }];
    parent['predecessor'] = {
      pin: {
        taskId: 'BCF-00',
        profileId: 'bcf00-observation',
        runId: 'child-run',
        terminalHead: childIdentity.terminalHead,
        manifestSha256: childIdentity.manifestSha256,
        completionReceiptSha256: childIdentity.completionReceiptSha256,
        ledgerSha256: childIdentity.ledgerSha256,
      },
      sourceManifestSha256: childIdentity.manifestSha256,
      importedFiles: predecessorFiles,
      treeDigestSha256: canonicalSha(predecessorFiles),
      overallVerdict: 'Pass',
    };
    writeFileSync(parentManifestPath, boundaryRun.canonicalizeBoundaryRun(parent));
    writeSyntheticRunInitAnchor(parentRunDir, parent);
    expect(boundaryRun.validateBoundaryRunJson(readFileSync(parentManifestPath))).toMatchObject({ ok: true, exitCode: 0 });

    const originalParentBytes = readFileSync(parentManifestPath);
    const alternateRunDir = path.join(fixture.repo, 'evidence/observation/alternate-run');
    const alternate = await finalizeSyntheticObservation(fixture.repo, alternateRunDir, api.runBoundaryRunCli);
    const substituted = structuredClone(parent) as Record<string, unknown>;
    const substitutedRun = substituted['run'] as Record<string, unknown>;
    substitutedRun['requiredChildPins'] = [{
      alias: 'upstream-observation',
      head: alternate.terminalHead,
      runId: 'alternate-run',
      manifestSha256: alternate.manifestSha256,
    }];
    const substitutedPredecessor = substituted['predecessor'] as Record<string, unknown>;
    const substitutedPredecessorFiles = [{
      path: 'run_manifest.json',
      sha256: alternate.manifestSha256,
      bytes: readFileSync(path.join(alternateRunDir, 'run_manifest.json')).byteLength,
    }];
    substitutedPredecessor['pin'] = {
      taskId: 'BCF-00',
      profileId: 'bcf00-observation',
      runId: 'alternate-run',
      terminalHead: alternate.terminalHead,
      manifestSha256: alternate.manifestSha256,
      completionReceiptSha256: alternate.completionReceiptSha256,
      ledgerSha256: alternate.ledgerSha256,
    };
    substitutedPredecessor['sourceManifestSha256'] = alternate.manifestSha256;
    substitutedPredecessor['importedFiles'] = substitutedPredecessorFiles;
    substitutedPredecessor['treeDigestSha256'] = canonicalSha(substitutedPredecessorFiles);
    writeFileSync(parentManifestPath, boundaryRun.canonicalizeBoundaryRun(substituted));
    const consistentSubstitution = await api.runBoundaryRunCli([
      'record-child-run', '--run-dir', parentRunDir, '--alias', 'upstream-observation',
      '--kind', 'observation', '--child-run-dir', alternateRunDir, '--expect-task', 'BCF-00',
      '--expect-head', alternate.terminalHead, '--expect-run-id', 'alternate-run',
      '--expect-manifest-sha256', alternate.manifestSha256,
    ], fixture.repo);
    expect(consistentSubstitution).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
    expect(consistentSubstitution.issues.map((entry) => entry.code)).toContain('init-anchor-mismatch');
    expect(existsSync(path.join(parentRunDir, 'children/upstream-observation'))).toBe(false);
    writeFileSync(parentManifestPath, originalParentBytes);

    const wrongDigest = await api.runBoundaryRunCli([
      'record-child-run', '--run-dir', parentRunDir, '--alias', 'upstream-observation',
      '--kind', 'observation', '--child-run-dir', childRunDir, '--expect-task', 'BCF-00',
      '--expect-head', childIdentity.terminalHead, '--expect-run-id', 'child-run',
      '--expect-manifest-sha256', SHA,
    ], fixture.repo);
    expect(wrongDigest).toMatchObject({ ok: false, exitCode: 2, verdict: 'Inconclusive' });
    expect(existsSync(path.join(parentRunDir, 'children/upstream-observation'))).toBe(false);

    const imported = await api.runBoundaryRunCli([
      'record-child-run', '--run-dir', parentRunDir, '--alias', 'upstream-observation',
      '--kind', 'observation', '--child-run-dir', childRunDir, '--expect-task', 'BCF-00',
      '--expect-head', childIdentity.terminalHead, '--expect-run-id', 'child-run',
      '--expect-manifest-sha256', childIdentity.manifestSha256,
    ], fixture.repo);
    expect(imported, JSON.stringify(imported)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    const advanced = JSON.parse(readFileSync(parentManifestPath, 'utf8')) as {
      children: Array<{ alias: string; importedFiles: Array<{ path: string }> }>;
    };
    expect(advanced.children).toHaveLength(1);
    expect(advanced.children[0]).toMatchObject({ alias: 'upstream-observation' });
    expect(advanced.children[0]!.importedFiles.map((entry) => entry.path)).toContain('run_manifest.sha256');
    expect(await api.runBoundaryRunCli([
      'record-child-run', '--run-dir', parentRunDir, '--alias', 'upstream-observation',
      '--kind', 'observation', '--child-run-dir', childRunDir, '--expect-task', 'BCF-00',
      '--expect-head', childIdentity.terminalHead, '--expect-run-id', 'child-run',
      '--expect-manifest-sha256', childIdentity.manifestSha256,
    ], fixture.repo)).toMatchObject({ ok: false, exitCode: 2, verdict: 'Inconclusive' });

    writeFileSync(path.join(parentRunDir, 'children/upstream-observation/run_manifest.json'), '{"mutated":true}\n');
    const drifted = await api.runBoundaryRunCli(['verify', '--run-dir', parentRunDir], fixture.repo);
    expect(drifted).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
    expect(drifted.issues.map((entry) => entry.code)).toContain('child-import-mutation');
  });

  it('records one canonical source review under the profile-owned alias and evidence closure', async () => {
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

    const manifestPath = path.join(fixture.runDir, 'run_manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ReturnType<typeof validManifest>;
    const profile = boundaryRun.RUN_CONTRACT_PROFILES['bcf-review-contract'];
    manifest.run.taskId = profile.taskId;
    manifest.run.profileId = profile.profileId;
    manifest.run.phase = profile.phase;
    manifest.run.requiredAttemptIds = [...profile.requiredAttemptIds];
    manifest.run.requiredChildAliases = [];
    manifest.run.requiredChildPins = [];
    manifest.run.mayComplete = profile.mayComplete;
    manifest.run.chainAppend = profile.chainAppend;
    manifest.run.requestedTools = [];
    manifest.run.observedTools = [];
    writeFileSync(manifestPath, boundaryRun.canonicalizeBoundaryRun(manifest));
    const initBytes = boundaryRun.canonicalizeBoundaryRun(boundaryRun.createBoundaryRunInitAnchor(manifest));
    writeFileSync(path.join(fixture.runDir, 'run_init.json'), initBytes);
    writeFileSync(
      path.join(fixture.runDir, 'run_init.sha256'),
      `${createHash('sha256').update(initBytes).digest('hex')}  run_init.json\n`,
    );

    const reviewRoot = path.join(fixture.runDir, 'reviews/review-one');
    mkdirSync(reviewRoot, { recursive: true });
    const evidence = [
      ['report.json', '{"summary":"bounded"}\n'],
      ['meta.json', '{"head":"review"}\n'],
      ['stderr.log', ''],
      ['finding-note.json', '{"safe":true}\n'],
    ] as const;
    for (const [name, content] of evidence) writeFileSync(path.join(reviewRoot, name), content);
    const reviewInput = {
      schemaVersion: 1,
      reviewId: 'review-one',
      dedupeKey: 'contract-cli-review',
      head: manifest.run.entryHead,
      snapshotDigestSha256: manifest.entrySnapshot.digestSha256,
      reportPath: 'reviews/review-one/report.json',
      reportSha256: fileSha(path.join(reviewRoot, 'report.json')),
      metaPath: 'reviews/review-one/meta.json',
      metaSha256: fileSha(path.join(reviewRoot, 'meta.json')),
      stderrPath: 'reviews/review-one/stderr.log',
      stderrSha256: fileSha(path.join(reviewRoot, 'stderr.log')),
      findings: [{
        ...validFinding(),
        evidencePath: 'reviews/review-one/finding-note.json',
        evidenceSha256: fileSha(path.join(reviewRoot, 'finding-note.json')),
      }],
      reproductionContracts: [],
    };
    const reviewPath = 'reviews/review-one/input.json';
    writeFileSync(path.join(fixture.runDir, reviewPath), boundaryRun.canonicalizeBoundaryRun(reviewInput));

    const wrongAlias = await api.runBoundaryRunCli([
      'record-review', '--run-dir', fixture.runDir, '--alias', 'review-redaction', '--review-path', reviewPath,
    ], fixture.repo);
    expect(wrongAlias).toMatchObject({ ok: false, exitCode: 2, verdict: 'Inconclusive' });
    expect((JSON.parse(readFileSync(manifestPath, 'utf8')) as { reviews: unknown[] }).reviews).toEqual([]);

    const recorded = await api.runBoundaryRunCli([
      'record-review', '--run-dir', fixture.runDir, '--alias', 'review-contract', '--review-path', reviewPath,
    ], fixture.repo);
    expect(recorded, JSON.stringify(recorded)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    const after = JSON.parse(readFileSync(manifestPath, 'utf8')) as { reviews: Array<Record<string, unknown>> };
    const { schemaVersion: _schemaVersion, ...reviewRecord } = reviewInput;
    expect(after.reviews).toEqual([{ alias: 'review-contract', ...reviewRecord }]);
    expect(await api.runBoundaryRunCli([
      'record-internal-check', '--run-dir', fixture.runDir, '--attempt', 'review-schema-check',
    ], fixture.repo)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    expect(await api.runBoundaryRunCli([
      'record-internal-check', '--run-dir', fixture.runDir, '--attempt', 'review-scope-check',
    ], fixture.repo)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
  });

  it('records one bounded generic reproduction command only in the reproduction profile', async () => {
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
    const manifestPath = path.join(fixture.runDir, 'run_manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ReturnType<typeof validManifest>;
    const profile = boundaryRun.RUN_CONTRACT_PROFILES['bcf-reproduction'];
    const bashTool = manifest.run.observedTools.find((entry) => entry.name === 'bash');
    expect(bashTool).toBeDefined();
    manifest.run.taskId = profile.taskId;
    manifest.run.profileId = profile.profileId;
    manifest.run.phase = profile.phase;
    manifest.run.requiredAttemptIds = [...profile.requiredAttemptIds];
    manifest.run.requiredChildAliases = [];
    manifest.run.requiredChildPins = [];
    manifest.run.mayComplete = profile.mayComplete;
    manifest.run.chainAppend = profile.chainAppend;
    manifest.run.requestedTools = ['bash'];
    manifest.run.observedTools = [bashTool!];
    writeFileSync(manifestPath, boundaryRun.canonicalizeBoundaryRun(manifest));
    const initBytes = boundaryRun.canonicalizeBoundaryRun(boundaryRun.createBoundaryRunInitAnchor(manifest));
    writeFileSync(path.join(fixture.runDir, 'run_init.json'), initBytes);
    writeFileSync(
      path.join(fixture.runDir, 'run_init.sha256'),
      `${createHash('sha256').update(initBytes).digest('hex')}  run_init.json\n`,
    );

    const wrongOutput = await api.runBoundaryRunCli([
      'record-command', '--run-dir', fixture.runDir, '--attempt', 'finding-repro',
      '--expect-exit', 'nonzero', '--output-path', 'outputs/forbidden.json', '--',
      'bash', '-c', 'exit 7',
    ], fixture.repo);
    expect(wrongOutput).toMatchObject({ ok: false, exitCode: 2, verdict: 'Inconclusive' });
    expect(existsSync(path.join(fixture.runDir, 'attempts/finding-repro'))).toBe(false);

    const recorded = await api.runBoundaryRunCli([
      'record-command', '--run-dir', fixture.runDir, '--attempt', 'finding-repro',
      '--expect-exit', 'nonzero', '--', 'bash', '-c', 'exit 7',
    ], fixture.repo);
    expect(recorded, JSON.stringify(recorded)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    const after = JSON.parse(readFileSync(manifestPath, 'utf8')) as { attempts: Array<Record<string, unknown>> };
    expect(after.attempts).toContainEqual(expect.objectContaining({
      id: 'finding-repro', operation: 'command', argv: ['bash', '-c', 'exit 7'],
      expectedExit: 'nonzero', rawExit: 7, rawSignal: null, expectationMet: true,
      watchdogOwner: 'helper-watchdog', innerTimeoutOwner: null,
      deadlineMs: 900_000, killGraceMs: 30_000, declaredOutputs: [], verdict: 'Pass',
    }));
  });

  it('binds one imported source review to its exact lead reproduction proof in parent mode', async () => {
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
    const manifestPath = path.join(fixture.runDir, 'run_manifest.json');
    const parent = JSON.parse(readFileSync(manifestPath, 'utf8')) as ReturnType<typeof validManifest>;
    const emptySha = createHash('sha256').update('').digest('hex');
    const contentSha = (content: string): string => createHash('sha256').update(content).digest('hex');

    const report = '{"summary":"unsafe case reproduced"}\n';
    const meta = '{"review":"contract"}\n';
    const evidence = '{"finding":"major"}\n';
    const review: boundaryRun.BoundaryReviewRecord = {
      reviewId: 'review-parent-one',
      alias: 'review-contract',
      dedupeKey: 'contract-cli-review',
      head: parent.run.entryHead,
      snapshotDigestSha256: parent.entrySnapshot.digestSha256,
      reportPath: 'reviews/review-parent-one/report.json',
      reportSha256: contentSha(report),
      metaPath: 'reviews/review-parent-one/meta.json',
      metaSha256: contentSha(meta),
      stderrPath: 'reviews/review-parent-one/stderr.log',
      stderrSha256: emptySha,
      findings: [{
        findingId: 'finding-parent-one',
        severity: 'major',
        requiresFix: true,
        requiresReproduction: true,
        evidencePath: 'reviews/review-parent-one/finding.json',
        evidenceSha256: contentSha(evidence),
        disposition: 'accepted',
        resolution: 'open',
        reason: null,
        counterevidenceRefs: [],
        reproductionAttemptIds: ['finding-repro'],
        counterReproductionAttemptIds: [],
        fixedAtHead: null,
        fixReproductionAttemptIds: [],
        fixReviewId: null,
      }],
      reproductionContracts: [{
        attemptId: 'finding-repro',
        argv: ['bash', '-c', 'exit 7'],
        expectedExit: 'nonzero',
        toolName: 'bash',
        deadlineMs: 900_000,
        killGraceMs: 30_000,
      }],
    };
    const reviewChild = structuredClone(parent);
    const reviewProfile = boundaryRun.RUN_CONTRACT_PROFILES['bcf-review-contract'];
    Object.assign(reviewChild.run, {
      runId: 'review-child', taskId: reviewProfile.taskId, profileId: reviewProfile.profileId,
      phase: reviewProfile.phase, finalizedAtUtc: TIME, terminalHead: parent.run.entryHead,
      allowedPaths: [], requiredAttemptIds: [...reviewProfile.requiredAttemptIds],
      requiredChildAliases: [], requiredChildPins: [], transitionCount: 0,
      mayComplete: reviewProfile.mayComplete, chainAppend: reviewProfile.chainAppend,
      requestedTools: [], observedTools: [],
    });
    reviewChild.manifestState = 'finalized';
    reviewChild.attempts = [];
    reviewChild.artifacts = [];
    reviewChild.children = [];
    reviewChild.predecessor = null;
    reviewChild.reviews = [review];
    reviewChild.lifecycle = {
      status: 'completed', completionCommit: parent.run.entryHead, finalGate: 'pass', artifactSha256: null,
      successor: null, supersededBy: null, oracle: 'current', branchDeletionAuthorized: false,
    };
    reviewChild.overallVerdict = 'Pass';
    const reviewRoot = path.join(fixture.runDir, 'children/review-contract');
    const reviewInstalled = installImportedRun(reviewRoot, reviewChild, {
      [review.reportPath]: report,
      [review.metaPath]: meta,
      [review.stderrPath]: '',
      [review.findings[0]!.evidencePath]: evidence,
    });

    const reproductionChild = structuredClone(parent);
    const reproductionProfile = boundaryRun.RUN_CONTRACT_PROFILES['bcf-reproduction'];
    const bashTool = reproductionChild.run.observedTools.find((entry) => entry.name === 'bash');
    expect(bashTool).toBeDefined();
    Object.assign(reproductionChild.run, {
      runId: 'reproduction-child', taskId: reproductionProfile.taskId, profileId: reproductionProfile.profileId,
      phase: reproductionProfile.phase, finalizedAtUtc: TIME, terminalHead: parent.run.entryHead,
      allowedPaths: [], requiredAttemptIds: [...reproductionProfile.requiredAttemptIds],
      requiredChildAliases: [], requiredChildPins: [], transitionCount: 0,
      mayComplete: reproductionProfile.mayComplete, chainAppend: reproductionProfile.chainAppend,
      requestedTools: ['bash'], observedTools: [bashTool!],
    });
    reproductionChild.manifestState = 'finalized';
    reproductionChild.artifacts = [];
    reproductionChild.children = [];
    reproductionChild.predecessor = null;
    reproductionChild.reviews = [];
    reproductionChild.attempts = [{
      ...validAttempt(),
      id: 'finding-repro',
      operation: 'command',
      headAnchor: 'entry',
      argv: ['bash', '-c', 'true'],
      cwd: fixture.repo,
      expectedExit: 'nonzero',
      rawExit: 7,
      rawSignal: null,
      expectationMet: true,
      watchdogOwner: 'helper-watchdog',
      innerTimeoutOwner: null,
      deadlineMs: 900_000,
      killGraceMs: 30_000,
      preSnapshot: structuredClone(parent.entrySnapshot),
      postSnapshot: structuredClone(parent.entrySnapshot),
      stdout: { path: 'attempts/finding-repro/stdout.log', sha256: emptySha, bytes: 0 },
      stderr: { path: 'attempts/finding-repro/stderr.log', sha256: emptySha, bytes: 0 },
      declaredOutputs: [],
      outputAdmissions: [],
      structuredResult: null,
      verdict: 'Pass',
    }];
    reproductionChild.lifecycle = {
      status: 'completed', completionCommit: parent.run.entryHead, finalGate: 'pass', artifactSha256: null,
      successor: null, supersededBy: null, oracle: 'current', branchDeletionAuthorized: false,
    };
    reproductionChild.overallVerdict = 'Pass';
    const reproductionRoot = path.join(fixture.runDir, 'children/lead-reproduction');
    let reproductionInstalled = installImportedRun(reproductionRoot, reproductionChild, {
      'attempts/finding-repro/stdout.log': '',
      'attempts/finding-repro/stderr.log': '',
    });

    const parentProfile = boundaryRun.RUN_CONTRACT_PROFILES['bcf08a-docs'];
    Object.assign(parent.run, {
      taskId: parentProfile.taskId, profileId: parentProfile.profileId, phase: parentProfile.phase,
      allowedPaths: [...parentProfile.allowedPaths], requiredAttemptIds: [...parentProfile.requiredAttemptIds],
      requiredChildAliases: parentProfile.requiredChildren.map((entry) => entry.split(':', 1)[0]!),
      transitionCount: 0, mayComplete: parentProfile.mayComplete, chainAppend: parentProfile.chainAppend,
    });
    const reviewChildRow = {
      alias: 'review-contract', kind: 'review' as const, taskId: 'BCF-REVIEW', profileId: 'bcf-review-contract',
      runId: 'review-child', entryHead: parent.run.entryHead, terminalHead: parent.run.entryHead,
      snapshotDigestSha256: parent.entrySnapshot.digestSha256,
      sourceManifestSha256: reviewInstalled.manifestSha256,
      importedFiles: reviewInstalled.importedFiles,
      treeDigestSha256: canonicalSha(reviewInstalled.importedFiles),
      overallVerdict: 'Pass' as const, dedupeKey: 'contract-cli-review',
    };
    const reproductionChildRow = {
      alias: 'lead-reproduction', kind: 'reproduction' as const, taskId: 'BCF-REPRODUCTION', profileId: 'bcf-reproduction',
      runId: 'reproduction-child', entryHead: parent.run.entryHead, terminalHead: parent.run.entryHead,
      snapshotDigestSha256: parent.entrySnapshot.digestSha256,
      sourceManifestSha256: reproductionInstalled.manifestSha256,
      importedFiles: reproductionInstalled.importedFiles,
      treeDigestSha256: canonicalSha(reproductionInstalled.importedFiles),
      overallVerdict: 'Pass' as const, dedupeKey: 'lead-reproduction',
    };
    parent.children = [reviewChildRow, reproductionChildRow];
    const pinFor = (alias: string): { alias: string; head: string; runId: string; manifestSha256: string } => {
      if (alias === 'review-contract') return {
        alias, head: parent.run.entryHead, runId: 'review-child', manifestSha256: reviewInstalled.manifestSha256,
      };
      if (alias === 'lead-reproduction') return {
        alias, head: parent.run.entryHead, runId: 'reproduction-child', manifestSha256: reproductionInstalled.manifestSha256,
      };
      return { alias, head: parent.run.entryHead, runId: `${alias}-child`, manifestSha256: SHA };
    };
    parent.run.requiredChildPins = parent.run.requiredChildAliases.map(pinFor);
    parent.reviews = [];
    writeFileSync(manifestPath, boundaryRun.canonicalizeBoundaryRun(parent));
    const parentInitBytes = boundaryRun.canonicalizeBoundaryRun(boundaryRun.createBoundaryRunInitAnchor(parent));
    writeFileSync(path.join(fixture.runDir, 'run_init.json'), parentInitBytes);
    writeFileSync(
      path.join(fixture.runDir, 'run_init.sha256'),
      `${createHash('sha256').update(parentInitBytes).digest('hex')}  run_init.json\n`,
    );

    const wrongPath = await api.runBoundaryRunCli([
      'record-review', '--run-dir', fixture.runDir, '--alias', 'review-contract',
      '--review-path', 'children/review-contract/run_init.json',
    ], fixture.repo);
    expect(wrongPath).toMatchObject({ ok: false, exitCode: 2, verdict: 'Inconclusive' });
    const substitutedProof = await api.runBoundaryRunCli([
      'record-review', '--run-dir', fixture.runDir, '--alias', 'review-contract',
      '--review-path', 'children/review-contract/run_manifest.json',
    ], fixture.repo);
    expect(substitutedProof).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
    expect(substitutedProof.issues.map((entry) => entry.code)).toContain('review-proof-contract-mismatch');

    reproductionChild.attempts[0]!.argv = ['bash', '-c', 'exit 7'];
    reproductionInstalled = installImportedRun(reproductionRoot, reproductionChild, {
      'attempts/finding-repro/stdout.log': '',
      'attempts/finding-repro/stderr.log': '',
    });
    reproductionChildRow.sourceManifestSha256 = reproductionInstalled.manifestSha256;
    reproductionChildRow.importedFiles = reproductionInstalled.importedFiles;
    reproductionChildRow.treeDigestSha256 = canonicalSha(reproductionInstalled.importedFiles);
    parent.run.requiredChildPins = parent.run.requiredChildAliases.map(pinFor);
    writeFileSync(manifestPath, boundaryRun.canonicalizeBoundaryRun(parent));
    const correctedParentInitBytes = boundaryRun.canonicalizeBoundaryRun(boundaryRun.createBoundaryRunInitAnchor(parent));
    writeFileSync(path.join(fixture.runDir, 'run_init.json'), correctedParentInitBytes);
    writeFileSync(
      path.join(fixture.runDir, 'run_init.sha256'),
      `${createHash('sha256').update(correctedParentInitBytes).digest('hex')}  run_init.json\n`,
    );
    const recorded = await api.runBoundaryRunCli([
      'record-review', '--run-dir', fixture.runDir, '--alias', 'review-contract',
      '--review-path', 'children/review-contract/run_manifest.json',
    ], fixture.repo);
    expect(recorded, JSON.stringify(recorded)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    const after = JSON.parse(readFileSync(manifestPath, 'utf8')) as { reviews: Array<Record<string, unknown>> };
    expect(after.reviews).toHaveLength(1);
    expect(after.reviews[0]).toMatchObject({
      reviewId: review.reviewId,
      alias: 'review-contract',
      dedupeKey: 'contract-cli-review',
      reportPath: `children/review-contract/${review.reportPath}`,
      findings: [{ evidencePath: `children/review-contract/${review.findings[0]!.evidencePath}` }],
      reproductionContracts: review.reproductionContracts,
    });
  });


  it('[BCF00-U08] rejects missing, spliced, drifting, or non-linear predecessor chains', () => {
    const api = boundaryRun as unknown as {
      validateAndAppendBoundaryPredecessor?: (input: Record<string, unknown>) => {
        result: ReturnType<typeof validateBoundaryRun>;
        ledger: unknown;
      };
    };
    expect(typeof api.validateAndAppendBoundaryPredecessor).toBe('function');
    if (!api.validateAndAppendBoundaryPredecessor) return;

    const cases: Array<{ code: string; input: Record<string, unknown> }> = [];
    const missing = validPredecessorChainInput() as unknown as Record<string, unknown>;
    missing['pin'] = null;
    cases.push({ code: 'predecessor-missing', input: missing });
    const foreign = validPredecessorChainInput();
    foreign.pin.profileId = 'bcf00-observation';
    cases.push({ code: 'predecessor-profile-mismatch', input: foreign as unknown as Record<string, unknown> });
    const spliced = validPredecessorChainInput();
    spliced.pin.manifestSha256 = SHA_C;
    cases.push({ code: 'predecessor-pin-mismatch', input: spliced as unknown as Record<string, unknown> });
    const digestMismatch = validPredecessorChainInput();
    digestMismatch.ledgerSha256 = SHA_C;
    cases.push({ code: 'predecessor-ledger-digest-mismatch', input: digestMismatch as unknown as Record<string, unknown> });
    const oracleDrift = validPredecessorChainInput();
    oracleDrift.inherited.oracleDigest = SHA_C;
    cases.push({ code: 'predecessor-inherited-drift', input: oracleDrift as unknown as Record<string, unknown> });
    const duplicate = validPredecessorChainInput();
    duplicate.ledger.rows.push(structuredClone(duplicate.ledger.rows[0]!));
    cases.push({ code: 'predecessor-ledger-nonlinear', input: duplicate as unknown as Record<string, unknown> });
    const reordered = validPredecessorChainInput();
    reordered.ledger.rows = [
      { ...structuredClone(reordered.ledger.rows[0]!), ordinal: 2, runId: 'other-run' },
      structuredClone(reordered.ledger.rows[0]!),
    ];
    cases.push({ code: 'predecessor-ledger-nonlinear', input: reordered as unknown as Record<string, unknown> });
    const forked = validPredecessorChainInput();
    forked.currentRow.entryHead = OID_D;
    cases.push({ code: 'predecessor-head-fork', input: forked as unknown as Record<string, unknown> });

    for (const candidate of cases) {
      const result = api.validateAndAppendBoundaryPredecessor(candidate.input).result;
      expect(result, candidate.code).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
      expect(result.issues.map((entry) => entry.code), candidate.code).toContain(candidate.code);
    }
  });

  it('[BCF00-N08] accepts one immutable predecessor pin and authorized ledger append', () => {
    const api = boundaryRun as unknown as {
      RUN_PREDECESSOR_CONTRACTS?: Record<string, Record<string, unknown>>;
      validateAndAppendBoundaryPredecessor?: (input: Record<string, unknown>) => {
        result: ReturnType<typeof validateBoundaryRun>;
        ledger: Record<string, unknown> | null;
      };
    };
    expect(Object.keys(api.RUN_PREDECESSOR_CONTRACTS ?? {})).toEqual(Object.keys(EXPECTED_PREDECESSOR_ROWS));
    for (const [profileId, expected] of Object.entries(EXPECTED_PREDECESSOR_ROWS)) {
      const row = api.RUN_PREDECESSOR_CONTRACTS?.[profileId];
      expect(row, profileId).toEqual({
        taskId: expected[0],
        predecessorTaskId: expected[1],
        predecessorProfileId: expected[2],
      });
    }
    expect(typeof api.validateAndAppendBoundaryPredecessor).toBe('function');
    if (!api.validateAndAppendBoundaryPredecessor) return;
    const input = validPredecessorChainInput();
    const outcome = api.validateAndAppendBoundaryPredecessor(input as unknown as Record<string, unknown>);
    expect(outcome.result).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    expect(outcome.ledger).toMatchObject({
      rows: [
        expect.objectContaining({ ordinal: 1, previousLedgerSha256: null, runId: 'reconciliation-run' }),
        expect.objectContaining({ ordinal: 2, previousLedgerSha256: input.ledgerSha256, runId: 'parser-run' }),
      ],
      oracleDigest: SHA_B,
    });
  });

  it('[BCF00-U09] rejects misidentified, cyclic, colliding, or mutated child imports', () => {
    const api = boundaryRun as unknown as {
      validateBoundaryChildImport?: (input: Record<string, unknown>) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(typeof api.validateBoundaryChildImport).toBe('function');
    if (!api.validateBoundaryChildImport) return;

    const identityMutations = [
      ['alias', 'other-alias'],
      ['kind', 'review'],
      ['taskId', 'BCF-01'],
      ['profileId', 'bcf00-reconciliation'],
      ['entryHead', OID_C],
      ['terminalHead', OID_C],
      ['runId', 'other-run'],
      ['sourceManifestSha256', SHA_C],
    ] as const;
    for (const [field, value] of identityMutations) {
      const input = validChildImportInput();
      (input.child as unknown as Record<string, unknown>)[field] = value;
      const result = api.validateBoundaryChildImport(input as unknown as Record<string, unknown>);
      expect(result, field).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
      expect(result.issues.map((entry) => entry.code), field).toContain('child-identity-mismatch');
    }

    const cycle = validChildImportInput();
    cycle.child.runId = cycle.parentRunId;
    cycle.pin.runId = cycle.parentRunId;
    const cycleResult = api.validateBoundaryChildImport(cycle as unknown as Record<string, unknown>);
    expect(cycleResult.issues.map((entry) => entry.code)).toContain('child-cycle');

    const depth = validChildImportInput();
    depth.parentDepth = 2;
    const depthResult = api.validateBoundaryChildImport(depth as unknown as Record<string, unknown>);
    expect(depthResult.issues.map((entry) => entry.code)).toContain('child-depth-exceeded');

    const collision = validChildImportInput();
    collision.existingPaths = ['run_manifest.json'];
    const collisionResult = api.validateBoundaryChildImport(collision as unknown as Record<string, unknown>);
    expect(collisionResult.issues.map((entry) => entry.code)).toContain('child-path-collision');

    const mutated = validChildImportInput();
    writeFileSync(path.join(mutated.importRoot, 'artifacts/output.json'), '{"ok":false}\n');
    const mutationResult = api.validateBoundaryChildImport(mutated as unknown as Record<string, unknown>);
    expect(mutationResult.issues.map((entry) => entry.code)).toContain('child-import-mutation');
  });

  it('[BCF00-N09] accepts one profile-pinned recursively verified child import', () => {
    const api = boundaryRun as unknown as {
      validateBoundaryChildImport?: (input: Record<string, unknown>) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(typeof api.validateBoundaryChildImport).toBe('function');
    if (!api.validateBoundaryChildImport) return;
    expect(api.validateBoundaryChildImport(validChildImportInput() as unknown as Record<string, unknown>)).toMatchObject({
      ok: true,
      exitCode: 0,
      verdict: 'Pass',
    });
  });

  it('[BCF00-U10] rejects duplicate or disposition-invalid review findings', () => {
    const api = boundaryRun as unknown as {
      validateBoundaryReviewJoins?: (input: Record<string, unknown>) => ReturnType<typeof validateBoundaryRun>;
      aggregateBoundaryReviewFindingVerdict?: (reviews: ReturnType<typeof validReview>[]) => string;
    };
    expect(typeof api.validateBoundaryReviewJoins).toBe('function');
    expect(typeof api.aggregateBoundaryReviewFindingVerdict).toBe('function');
    if (!api.validateBoundaryReviewJoins || !api.aggregateBoundaryReviewFindingVerdict) return;

    const cases: Array<{ code: string; input: ReturnType<typeof validReviewJoinInput> }> = [];
    const duplicateReview = validReviewJoinInput();
    duplicateReview.reviews.push(structuredClone(duplicateReview.reviews[0]!));
    cases.push({ code: 'review-duplicate', input: duplicateReview });
    const duplicateFinding = validReviewJoinInput();
    duplicateFinding.reviews[0]!.findings.push(structuredClone(duplicateFinding.reviews[0]!.findings[0]!));
    cases.push({ code: 'finding-duplicate', input: duplicateFinding });
    for (const [field, value] of [
      ['severity', 'urgent'],
      ['disposition', 'ignored'],
      ['resolution', 'resolved'],
    ] as const) {
      const invalid = validReviewJoinInput();
      (invalid.reviews[0]!.findings[0] as unknown as Record<string, unknown>)[field] = value;
      cases.push({ code: 'finding-enum-invalid', input: invalid });
    }
    const missingReproduction = validReviewJoinInput();
    missingReproduction.reviews[0]!.findings[0]!.reproductionAttemptIds = [];
    cases.push({ code: 'finding-reproduction-missing', input: missingReproduction });
    const unsupportedRejection = validReviewJoinInput();
    unsupportedRejection.reviews[0]!.findings[0]!.counterevidenceRefs = [];
    unsupportedRejection.reviews[0]!.findings[0]!.counterReproductionAttemptIds = [];
    cases.push({ code: 'finding-rejection-unsupported', input: unsupportedRejection });
    const wrongHeadFix = validReviewJoinInput();
    const finding = wrongHeadFix.reviews[0]!.findings[0]!;
    finding.disposition = 'accepted';
    finding.resolution = 'fixed';
    finding.reason = null as unknown as string;
    finding.counterevidenceRefs = [];
    finding.counterReproductionAttemptIds = [];
    finding.fixedAtHead = OID_D;
    finding.fixReproductionAttemptIds = ['fix-repro'];
    finding.fixReviewId = 'review-2';
    wrongHeadFix.reviews.push({ ...structuredClone(wrongHeadFix.reviews[0]!), reviewId: 'review-2', dedupeKey: 'review-two', head: OID_D, findings: [] });
    wrongHeadFix.attempts.push({ id: 'fix-repro', head: OID_C, snapshotDigestSha256: SHA, rawExit: 0, rawSignal: null, expectationMet: true, verdict: 'Pass' });
    wrongHeadFix.currentHead = OID_D;
    cases.push({ code: 'finding-fix-head-mismatch', input: wrongHeadFix });

    for (const candidate of cases) {
      const result = api.validateBoundaryReviewJoins(candidate.input as unknown as Record<string, unknown>);
      expect(result, candidate.code).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
      expect(result.issues.map((entry) => entry.code), candidate.code).toContain(candidate.code);
    }
    const critical = validReview();
    Object.assign(critical.findings[0]!, {
      severity: 'critical', requiresFix: true, requiresReproduction: true,
      disposition: 'accepted', resolution: 'open', reason: null,
    });
    expect(api.aggregateBoundaryReviewFindingVerdict([critical])).toBe('Blocked');
    const major = structuredClone(critical);
    major.findings[0]!.severity = 'major';
    expect(api.aggregateBoundaryReviewFindingVerdict([major])).toBe('Fail');
    const deferred = structuredClone(major);
    deferred.findings[0]!.disposition = 'deferred';
    expect(api.aggregateBoundaryReviewFindingVerdict([deferred])).toBe('Inconclusive');
  });

  it('[BCF00-N10] accepts one unique finding with disposition-valid exact-head proof', () => {
    const api = boundaryRun as unknown as {
      validateBoundaryReviewJoins?: (input: Record<string, unknown>) => ReturnType<typeof validateBoundaryRun>;
      aggregateBoundaryReviewFindingVerdict?: (reviews: ReturnType<typeof validReview>[]) => string;
    };
    expect(typeof api.validateBoundaryReviewJoins).toBe('function');
    expect(typeof api.aggregateBoundaryReviewFindingVerdict).toBe('function');
    if (!api.validateBoundaryReviewJoins || !api.aggregateBoundaryReviewFindingVerdict) return;
    expect(api.validateBoundaryReviewJoins(validReviewJoinInput() as unknown as Record<string, unknown>)).toMatchObject({
      ok: true,
      exitCode: 0,
      verdict: 'Pass',
    });
    expect(api.aggregateBoundaryReviewFindingVerdict(validReviewJoinInput().reviews)).toBe('Pass');
  });

}
