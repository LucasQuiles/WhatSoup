import { expect, it } from 'vitest';

import { admitsProfileOwnedCommandWork } from '../../../scripts/lib/verification/boundary-run-cli/shared.ts';

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
  validDocument,
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

export function registerSchemaCases(): void {
  it('owns receipt staging with the same internal scope contract as documentation commits', () => {
    expect(boundaryRun.RUN_ATTEMPT_CONTRACTS['receipt-staged-scope']).toMatchObject({
      operation: 'internal-check',
      argv: [],
      internalCheck: 'staged-scope',
      stdoutPredicate: null,
    });
    expect(boundaryRun.RUN_ATTEMPT_CONTRACTS['receipt-staged-scope'])
      .toEqual(boundaryRun.RUN_ATTEMPT_CONTRACTS['docs-staged-scope']);
  });

  it('keeps the executable BCF-00 marker roster equal to the frozen contract', () => {
    const listed = JSON.parse(execFileSync(process.execPath, [
      'node_modules/vitest/vitest.mjs', 'list',
      'tests/scripts/verify-boundary-run.test.ts', '--json',
      '--pool=forks', '--fileParallelism=false',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    })) as Array<{ name: string }>;
    const observed = listed.flatMap((entry) => (
      entry.name.match(/\[BCF00-[BUSN]\d{2}\]/g) ?? []
    )).sort();

    expect(observed).toEqual([...expectedBcf00Markers].sort());
  });

  it('parses expected exits in linear bounded form', () => {
    const api = boundaryRun as unknown as {
      parseBoundaryExpectedExit?: (value: string) => Set<number> | 'nonzero' | null;
    };
    expect(typeof api.parseBoundaryExpectedExit).toBe('function');
    if (!api.parseBoundaryExpectedExit) return;

    expect(api.parseBoundaryExpectedExit('nonzero')).toBe('nonzero');
    expect(api.parseBoundaryExpectedExit('0')).toEqual(new Set([0]));
    expect(api.parseBoundaryExpectedExit('0,1,255')).toEqual(new Set([0, 1, 255]));

    for (const value of [
      '', '00', '01', '256', '1,1', '2,1', '0,', '1,,2',
      ' 1', '1 ', '+1', '1.0', '1\n2',
    ]) {
      expect(api.parseBoundaryExpectedExit(value), value).toBeNull();
    }

    const adversarial = `${Array.from({ length: 10_000 }, () => '0,1').join(',')},x`;
    expect(api.parseBoundaryExpectedExit(adversarial)).toBeNull();
  });

  it('[BCF00-B01] accepts the complete active manifest wire contract', () => {
    const result = validateBoundaryRun(validManifest());

    expect(result, result.issues.map((issue) => issue.message).join('\n')).toMatchObject({
      ok: true,
      exitCode: 0,
      verdict: 'Pass',
    });
  });

  it('[BCF00-U01] rejects blind or drifted worktree snapshots', () => {
    const api = boundaryRun as unknown as {
      captureBoundaryWorktreeSnapshot?: (
        repo: string,
        declarations: typeof SNAPSHOT_DECLARATIONS,
      ) => { ok: boolean; snapshot: unknown; issues: Array<{ code: string }> };
      verifyBoundaryWorktreeSnapshot?: (
        repo: string,
        snapshot: unknown,
        declarations: typeof SNAPSHOT_DECLARATIONS,
      ) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(typeof api.captureBoundaryWorktreeSnapshot).toBe('function');
    expect(typeof api.verifyBoundaryWorktreeSnapshot).toBe('function');
    if (!api.captureBoundaryWorktreeSnapshot || !api.verifyBoundaryWorktreeSnapshot) return;

    const mutations: Array<{ code: string; apply: (repo: string) => void }> = [
      {
        code: 'snapshot-index-drift',
        apply: (repo) => {
          writeFileSync(path.join(repo, 'tracked.txt'), 'staged\n');
          git(repo, ['add', 'tracked.txt']);
        },
      },
      {
        code: 'snapshot-unstaged-drift',
        apply: (repo) => writeFileSync(path.join(repo, 'tracked.txt'), 'unstaged\n'),
      },
      {
        code: 'snapshot-unstaged-drift',
        apply: (repo) => chmodSync(path.join(repo, 'tracked.txt'), 0o755),
      },
      {
        code: 'snapshot-allowed-untracked-drift',
        apply: (repo) => writeFileSync(path.join(repo, 'scratch/result.json'), '{"changed":true}\n'),
      },
      {
        code: 'snapshot-unexpected-untracked',
        apply: (repo) => writeFileSync(path.join(repo, 'unexpected.txt'), 'unexpected\n'),
      },
      {
        code: 'snapshot-owner-drift',
        apply: (repo) => writeFileSync(path.join(repo, 'owner.tsv'), 'changed owner\n'),
      },
    ];

    for (const { code, apply } of mutations) {
      const repo = makeSnapshotRepo();
      const captured = api.captureBoundaryWorktreeSnapshot(repo, SNAPSHOT_DECLARATIONS);
      expect(captured.ok, captured.issues.map((entry) => entry.code).join(', ')).toBe(true);
      apply(repo);
      const result = api.verifyBoundaryWorktreeSnapshot(repo, captured.snapshot, SNAPSHOT_DECLARATIONS);
      expect(result, code).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
      expect(result.issues.map((entry) => entry.code), code).toContain(code);
    }

    const blindRepo = makeSnapshotRepo();
    const blind = api.captureBoundaryWorktreeSnapshot(blindRepo, {
      allowedUntrackedPaths: ['scratch/result.json'],
      preservedOwnerPaths: [],
    });
    expect(blind.ok).toBe(false);
    expect(blind.issues.map((entry) => entry.code)).toContain('snapshot-unexpected-untracked');
  });

  it('[BCF00-N01] accepts a complete canonical worktree snapshot with an unchanged owner', () => {
    const api = boundaryRun as unknown as {
      captureBoundaryWorktreeSnapshot?: (
        repo: string,
        declarations: typeof SNAPSHOT_DECLARATIONS,
      ) => { ok: boolean; snapshot: unknown; issues: Array<{ code: string }> };
      verifyBoundaryWorktreeSnapshot?: (
        repo: string,
        snapshot: unknown,
        declarations: typeof SNAPSHOT_DECLARATIONS,
      ) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(typeof api.captureBoundaryWorktreeSnapshot).toBe('function');
    expect(typeof api.verifyBoundaryWorktreeSnapshot).toBe('function');
    if (!api.captureBoundaryWorktreeSnapshot || !api.verifyBoundaryWorktreeSnapshot) return;

    const repo = makeSnapshotRepo();
    const captured = api.captureBoundaryWorktreeSnapshot(repo, SNAPSHOT_DECLARATIONS);
    expect(captured.ok, captured.issues.map((entry) => entry.code).join(', ')).toBe(true);
    expect(captured.snapshot).toMatchObject({
      head: expect.stringMatching(/^[0-9a-f]{40}$/),
      indexTreeOid: expect.stringMatching(/^[0-9a-f]{40}$/),
      allowedUntracked: [expect.objectContaining({ path: 'scratch/result.json', type: 'regular' })],
      preservedOwner: [expect.objectContaining({ path: 'owner.tsv', type: 'regular' })],
      digestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(api.verifyBoundaryWorktreeSnapshot(repo, captured.snapshot, SNAPSHOT_DECLARATIONS)).toMatchObject({
      ok: true,
      exitCode: 0,
      verdict: 'Pass',
    });
  });

  it('admits a declared create path only after bounded materialization', () => {
    const repo = makeSnapshotRepo();
    const createPath = path.join(repo, 'scratch/result.json');
    rmSync(createPath);
    const declarations = {
      allowedUntrackedPaths: ['scratch/result.json'],
      preservedOwnerPaths: ['owner.tsv'],
    };

    const absent = boundaryRun.captureBoundaryWorktreeSnapshot(repo, declarations);
    expect(absent.ok, absent.issues.map((entry) => entry.code).join(', ')).toBe(true);
    expect(absent.snapshot?.allowedUntracked).toEqual([]);

    writeFileSync(createPath, '{"created":true}\n');
    const materialized = boundaryRun.captureBoundaryWorktreeSnapshot(repo, declarations);
    expect(materialized.ok, materialized.issues.map((entry) => entry.code).join(', ')).toBe(true);
    expect(materialized.snapshot?.allowedUntracked).toEqual([
      expect.objectContaining({ path: 'scratch/result.json', type: 'regular' }),
    ]);
    expect(absent.snapshot).not.toBeNull();
    expect(materialized.snapshot).not.toBeNull();
    if (absent.snapshot === null || materialized.snapshot === null) return;
    expect(admitsProfileOwnedCommandWork(
      repo,
      absent.snapshot,
      materialized.snapshot,
      ['scratch/result.json'],
    )).toBe(true);

    writeFileSync(path.join(repo, 'foreign.txt'), 'foreign\n');
    const foreign = boundaryRun.captureBoundaryWorktreeSnapshot(repo, declarations);
    expect(foreign.ok).toBe(false);
    expect(foreign.issues.map((entry) => entry.code)).toContain('snapshot-unexpected-untracked');
  });

  it('[BCF00-U13] rejects non-closed manifest wire shapes', () => {
    const extra = structuredClone(validManifest()) as unknown as Record<string, unknown>;
    extra['unexpected'] = true;
    const missing = structuredClone(validManifest()) as unknown as Record<string, unknown>;
    delete missing['upstream'];
    const nestedCandidates = ['run', 'entrySnapshot', 'currentSnapshot', 'entryTestRoster', 'lifecycle', 'documentHashes', 'upstream']
      .map((key) => {
        const candidate = structuredClone(validManifest()) as unknown as Record<string, Record<string, unknown>>;
        candidate[key]['unexpected'] = true;
        return candidate;
      });
    const invalidValues = [
      withValue(['schemaVersion'], 2),
      withValue(['manifestState'], 'complete'),
      withValue(['run', 'createdAtUtc'], '2026-07-16T16:30:00Z'),
      withValue(['run', 'terminalHead'], ''),
      withValue(['run', 'transitionCount'], 2),
      withValue(['run', 'reservedDerivedRoots', '0', 'parentDevice'], 1.5),
      withValue(['entrySnapshot', 'digestSha256'], SHA.toUpperCase()),
      withValue(['entrySnapshot', 'allowedUntracked', '0', 'path'], `scratch/${'x'.repeat(1_025)}`),
      withValue(['lifecycle', 'branchDeletionAuthorized'], true),
      withValue(['upstream', 'observedOid'], null),
    ];

    const rowCandidates: Array<{ candidate: Record<string, unknown>; code: string }> = [];
    const withUnexpected = (value: Record<string, unknown>): Record<string, unknown> => ({
      ...value,
      unexpected: true,
    });
    for (const [path, row, code] of [
      [['run', 'observedTools'], { name: 'git', realPath: '/usr/bin/git', version: '2.50.1', sha256: SHA }, 'invalid-tool-keys'],
      [['run', 'reservedDerivedRoots'], { kind: 'run', path: '/tmp/bcf/run/valid-run', parentDevice: 1, parentInode: 2, state: 'created' }, 'invalid-reserved-derived-root-keys'],
      [['entrySnapshot', 'allowedUntracked'], validSnapshot().allowedUntracked[0], 'invalid-snapshot-path-keys'],
      [['attempts'], validAttempt(), 'invalid-attempt-keys'],
      [['artifacts'], { path: 'outputs/root.txt', role: 'output', producerAttemptId: 'upstream-root', sha256: SHA, bytes: 1 }, 'invalid-artifact-keys'],
      [['children'], validChild(), 'invalid-child-keys'],
      [['entryTestRoster', 'files'], { path: 'tests/example.test.ts', state: 'present', testNames: ['example'] }, 'invalid-test-roster-file-keys'],
      [['reviews'], validReview(), 'invalid-review-keys'],
    ] as const) {
      const candidate = structuredClone(validManifest()) as unknown as Record<string, unknown>;
      let parent = candidate;
      for (const segment of path.slice(0, -1)) parent = parent[segment] as Record<string, unknown>;
      parent[path.at(-1)!] = [withUnexpected(structuredClone(row) as unknown as Record<string, unknown>)];
      rowCandidates.push({ candidate, code });
    }
    for (const [path, value, code] of [
      [['predecessor'], validPredecessor(), 'invalid-predecessor-keys'],
      [['documentHashes', 'spec'], validDocument('docs/spec.md', 1), 'invalid-document-hash-keys'],
    ] as const) {
      const candidate = structuredClone(validManifest()) as unknown as Record<string, unknown>;
      let parent = candidate;
      for (const segment of path.slice(0, -1)) parent = parent[segment] as Record<string, unknown>;
      parent[path.at(-1)!] = withUnexpected(structuredClone(value) as unknown as Record<string, unknown>);
      rowCandidates.push({ candidate, code });
    }
    const attemptNestedCandidates = [
      ['preSnapshot', validSnapshot(), 'invalid-snapshot-keys'],
      ['stdout', validStream('attempts/upstream-root/stdout.log'), 'invalid-stream-keys'],
      ['outputAdmissions', validAttempt().outputAdmissions[0], 'invalid-output-admission-keys'],
    ] as const;
    for (const [field, row, code] of attemptNestedCandidates) {
      const candidate = structuredClone(validManifest()) as unknown as Record<string, unknown>;
      const attempt = validAttempt() as unknown as Record<string, unknown>;
      attempt[field] = field === 'outputAdmissions'
        ? [withUnexpected(structuredClone(row) as unknown as Record<string, unknown>)]
        : withUnexpected(structuredClone(row) as unknown as Record<string, unknown>);
      candidate['attempts'] = [attempt];
      rowCandidates.push({ candidate, code });
    }
    const childCandidate = structuredClone(validManifest()) as unknown as Record<string, unknown>;
    const child = validChild();
    child.importedFiles = [withUnexpected(child.importedFiles[0]! as unknown as Record<string, unknown>) as unknown as typeof child.importedFiles[number]];
    childCandidate['children'] = [child];
    rowCandidates.push({ candidate: childCandidate, code: 'invalid-imported-file-keys' });
    const predecessorCandidate = structuredClone(validManifest()) as unknown as Record<string, unknown>;
    const predecessor = validPredecessor();
    predecessor.pin = withUnexpected(predecessor.pin as unknown as Record<string, unknown>) as unknown as typeof predecessor.pin;
    predecessorCandidate['predecessor'] = predecessor;
    rowCandidates.push({ candidate: predecessorCandidate, code: 'invalid-predecessor-pin-keys' });
    const reviewCandidate = structuredClone(validManifest()) as unknown as Record<string, unknown>;
    const review = validReview();
    review.findings = [withUnexpected(review.findings[0]! as unknown as Record<string, unknown>) as unknown as typeof review.findings[number]];
    reviewCandidate['reviews'] = [review];
    rowCandidates.push({ candidate: reviewCandidate, code: 'invalid-finding-keys' });

    for (const candidate of [extra, missing, ...nestedCandidates, ...invalidValues]) {
      expect(validateBoundaryRun(candidate)).toMatchObject({
        ok: false,
        exitCode: 1,
        verdict: 'Inconclusive',
      });
    }
    for (const { candidate, code } of rowCandidates) {
      const result = validateBoundaryRun(candidate);
      expect(result, `nested row ${code}`).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
      expect(result.issues.map((entry) => entry.code), `nested row ${code}`).toContain(code);
    }

    const canonical = canonicalJson(validManifest());
    const canonicalWithCrLf = canonical.replaceAll('\n', '\r\n');
    const rawCases = [
      {
        bytes: Buffer.from(canonical.replace('"artifacts":[]', '"artifacts":[],"artifacts":[]')),
        code: 'duplicate-json-key',
      },
      {
        bytes: Buffer.from(canonical.replace('"runId":"valid-run"', '"runId":"valid-run","runId":"other"')),
        code: 'duplicate-json-key',
      },
      { bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(canonical)]), code: 'invalid-json-byte' },
      { bytes: Buffer.from(canonicalWithCrLf), code: 'invalid-json-byte' },
      { bytes: Uint8Array.from([0xff, ...Buffer.from(canonical)]), code: 'invalid-json' },
      { bytes: Buffer.from(canonical.replace('"parentDevice":1', '"parentDevice":-0')), code: 'invalid-json-number' },
      { bytes: Buffer.from(` ${canonical}`), code: 'noncanonical-json' },
      { bytes: Buffer.from(`${canonical}x`), code: 'invalid-json' },
    ];
    const api = boundaryRun as unknown as {
      validateBoundaryRunJson: (bytes: Uint8Array) => ReturnType<typeof validateBoundaryRun>;
    };
    for (const { bytes, code } of rawCases) {
      const result = api.validateBoundaryRunJson(bytes);
      expect(result, `raw case ${code}`).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
      expect(result.issues.map((entry) => entry.code)).toContain(code);
    }
  });

  it('[BCF00-N13] accepts and reproduces canonical manifest bytes', () => {
    const api = boundaryRun as unknown as {
      canonicalizeBoundaryRun?: (value: unknown) => string;
      validateBoundaryRunJson?: (bytes: Uint8Array) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(typeof api.canonicalizeBoundaryRun).toBe('function');
    expect(typeof api.validateBoundaryRunJson).toBe('function');
    expect((boundaryRun as unknown as { RUN_WIRE_SCHEMAS?: unknown }).RUN_WIRE_SCHEMAS).toEqual(EXPECTED_WIRE_SCHEMAS);
    if (!api.canonicalizeBoundaryRun || !api.validateBoundaryRunJson) return;

    const expected = canonicalJson(validManifest());
    expect(api.canonicalizeBoundaryRun(validManifest())).toBe(expected);
    expect(api.validateBoundaryRunJson(Buffer.from(expected))).toMatchObject({
      ok: true,
      exitCode: 0,
      verdict: 'Pass',
    });
  });

  it('validates helper-derived completion records and the pinned conflict exception as closed wire objects', () => {
    const api = boundaryRun as unknown as {
      validateBoundaryStructuredRecord?: (
        schema: 'ReadinessRecord' | 'ConsumerVersionDecision' | 'FeedbackMeasurements' | 'DocsLineageReport' | 'MergeConflictResolutionReport',
        value: Record<string, unknown>,
      ) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(typeof api.validateBoundaryStructuredRecord).toBe('function');
    if (!api.validateBoundaryStructuredRecord) return;
    const readiness = {
      schemaVersion: 1,
      runId: 'reconciliation-run',
      taskId: 'BCF-00',
      profileId: 'bcf00-reconciliation',
      head: OID,
      snapshotDigestSha256: SHA,
      readinessState: 'Ready with Constraints',
      evaluatedAtUtc: TIME,
      evidence: [{
        evidenceId: 'predecessor-branch-gate',
        artifactPath: 'attempts/predecessor-branch-gate/stdout.log',
        producerAttemptId: 'predecessor-branch-gate',
        sha256: SHA,
        verdict: 'Pass',
      }],
      assumptions: [
        { assumptionId: 'A-08', disposition: 'validated', evidenceRefs: ['predecessor-branch-gate'] },
        { assumptionId: 'A-09', disposition: 'validated', evidenceRefs: ['predecessor-branch-gate'] },
        { assumptionId: 'A-10', disposition: 'validated', evidenceRefs: ['predecessor-branch-gate'] },
      ],
      risks: [{
        riskId: 'later-checkpoints', owner: 'implementation-lead', checkpoint: 'before-dependent-task',
        artifactPath: 'attempts/predecessor-branch-gate/stdout.log', artifactSha256: SHA,
        stopCondition: 'stop when the bound evidence changes',
      }],
      blockers: [],
      decisionRationale: 'All due assumptions passed; later checkpoints remain constrained.',
      decisionAuthority: 'implementation-lead',
      nextAllowedAction: 'BCF-01',
      overallVerdict: 'Pass',
    };
    expect(api.validateBoundaryStructuredRecord('ReadinessRecord', readiness)).toMatchObject({
      ok: true, exitCode: 0, verdict: 'Pass',
    });
    expect(api.validateBoundaryStructuredRecord('ReadinessRecord', { ...readiness, callerSelected: true }).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'structured-record-shape' })]));

    const conflictReport = {
      schemaVersion: 1,
      policy: 'regenerate-generated-work-index',
      beforeHead: OID,
      expectedSecondParent: BOUNDARY_PINNED_GENERATED_INDEX_PARENT,
      conflictPaths: ['docs/work-index.json', 'docs/work-index.md'],
      indexStages: [
        { path: 'docs/work-index.json', stage: 1, mode: '100644', oid: OID },
        { path: 'docs/work-index.json', stage: 2, mode: '100644', oid: OID_C },
        { path: 'docs/work-index.json', stage: 3, mode: '100644', oid: OID_D },
        { path: 'docs/work-index.md', stage: 1, mode: '100644', oid: OID },
        { path: 'docs/work-index.md', stage: 2, mode: '100644', oid: OID_C },
        { path: 'docs/work-index.md', stage: 3, mode: '100644', oid: OID_D },
      ],
      generatorArgv: ['bash', 'scripts/run-with-pinned-npm.sh', 'run', 'work-index:regen'],
      generatorRawExit: 0,
      generatorRawSignal: null,
      resolvedPaths: ['docs/work-index.json', 'docs/work-index.md'],
      unmergedPaths: [],
      conflictMarkerPaths: [],
      diffCheckRawExit: 0,
      diffCheckRawSignal: null,
      workIndexGuardRawExit: 0,
      workIndexGuardRawSignal: null,
      preStateDigestSha256: SHA,
      resolvedStateDigestSha256: SHA_B,
      verdict: 'Pass',
    };
    expect(api.validateBoundaryStructuredRecord('MergeConflictResolutionReport', conflictReport)).toMatchObject({
      ok: true, exitCode: 0, verdict: 'Pass',
    });
    expect(api.validateBoundaryStructuredRecord('MergeConflictResolutionReport', {
      ...conflictReport,
      expectedSecondParent: OID_D,
    }).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'merge-conflict-policy-mismatch' })]));

    const inventoryQuery = [
      'rg', '-n', 'buildBoundaryReceipt\\(|buildSemanticReceipt\\(|schemaVersion',
      'scripts', 'tests', 'docs', '--glob', '*.ts', '--glob', '*.md',
    ];
    const matchRef = 'scripts/receipt.ts:1:1:producer-call:buildBoundaryReceipt(';
    const consumerDecision = {
      schemaVersion: 1,
      runId: 'receipt-run', taskId: 'BCF-04', profileId: 'bcf04-receipt', head: OID,
      snapshotDigestSha256: SHA, packageVersion: '0.1.0', currentProducerSchema: 1,
      proposedProducerSchema: 2, supportStage: 'beta-shadow-only',
      inventoryQuerySha256: canonicalSha(inventoryQuery),
      inventoryMatches: [{
        path: 'scripts/receipt.ts', line: 1, column: 1, matchKind: 'producer-call',
        matchedToken: 'buildBoundaryReceipt(', lineSha256: SHA,
      }],
      localConsumers: [{
        consumerId: 'consumer-0001', kind: 'producer', path: 'scripts/receipt.ts',
        symbol: 'buildBoundaryReceipt', schemaSupport: 'schema-1', matchRefs: [matchRef],
      }],
      externalConsumers: 'unknown', compatibilityReader: 'schema-1-read-render', rollbackCommit: OID_C,
      decision: 'pre-1.0-shadow-compatible', releaseNoteRequired: false,
      limitations: ['external-consumers-unknown'], overallVerdict: 'Pass',
    };
    expect(api.validateBoundaryStructuredRecord('ConsumerVersionDecision', consumerDecision)).toMatchObject({
      ok: true, verdict: 'Pass',
    });

    const budgets = {
      maxFindings: 128, maxObservedPerFinding: 64, maxArtifactsPerFinding: 16,
      maxLimitationsPerFinding: 8, maxTopLevelLimitations: 16, maxFingerprints: 64,
      maxCanonicalRecords: 2_048, maxCorrectionsPerFinding: 4, maxVerificationPerFinding: 8,
      maxSourcesPerFinding: 16, maxPublicTextBytes: 512, maxJsonBytes: 1024 * 1024,
      maxHumanBytes: 64 * 1024, maxHumanReservedSummaryBytes: 16 * 1024,
      maxHumanDetailedFindings: 12,
    };
    const scenario = (
      ordinal: number,
      name: string,
      subject: string,
      inputBytes: number,
      limitBytes: number,
      disposition: string,
    ) => ({
      ordinal, scenario: name, subject, inputBytes, limitBytes,
      humanBytes: Math.min(inputBytes, budgets.maxHumanBytes),
      jsonBytes: Math.min(inputBytes, budgets.maxJsonBytes), detailedFindings: 1,
      omittedFindings: 0, renderedObservations: 1, omittedObservations: 0,
      evidenceDigestSha256: SHA, descriptorDigestSha256: SHA_B,
      expectedDisposition: disposition, observedDisposition: disposition,
    });
    const measurements = {
      schemaVersion: 1, runId: 'feedback-run', taskId: 'BCF-05', profileId: 'bcf05-feedback',
      producerAttemptId: 'feedback-green', head: OID, snapshotDigestSha256: SHA,
      tokenSha256: SHA_B, budgets,
      scenarios: [
        scenario(1, 'ordinary', 'aggregate', 1, budgets.maxHumanBytes, 'accepted'),
        scenario(2, 'human-at-limit', 'public-text', budgets.maxHumanBytes, budgets.maxHumanBytes, 'accepted'),
        scenario(3, 'human-one-over', 'public-text', budgets.maxHumanBytes + 1, budgets.maxHumanBytes, 'diagnostic-inconclusive'),
        scenario(4, 'json-at-limit', 'canonical-json', budgets.maxJsonBytes, budgets.maxJsonBytes, 'accepted'),
        scenario(5, 'json-one-over', 'canonical-json', budgets.maxJsonBytes + 1, budgets.maxJsonBytes, 'diagnostic-inconclusive'),
        scenario(6, 'multibyte', 'utf8-text', 2, budgets.maxPublicTextBytes, 'accepted'),
      ],
      overallVerdict: 'Pass',
    };
    expect(api.validateBoundaryStructuredRecord('FeedbackMeasurements', measurements)).toMatchObject({
      ok: true, verdict: 'Pass',
    });
    const oneByteWrong = structuredClone(measurements);
    oneByteWrong.scenarios[2]!.inputBytes -= 1;
    expect(api.validateBoundaryStructuredRecord('FeedbackMeasurements', oneByteWrong).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'feedback-budget-invalid' })]));
  });

  it('[BCF00-U02] rejects non-closed commands and operational IDs before mutation', () => {
    const api = boundaryCli as unknown as {
      parseBoundaryRunInvocation?: (argv: readonly string[]) => unknown;
    };
    expect(typeof api.parseBoundaryRunInvocation).toBe('function');
    if (!api.parseBoundaryRunInvocation) return;

    const invalidInvocations = [
      ['unknown-command'],
      ['init', '--run-dir', '/tmp/run', '--task', 'BCF-00'],
      ['init', '--run-dir', '/tmp/run', '--task', 'BCF-00', '--profile', 'bcf00-observation', '--task', 'BCF-01'],
      ['record-command', '--run-dir', '/tmp/run', '--attempt', 'upstream-root'],
      ['record-command', '--run-dir', '/tmp/run', '--attempt', 'upstream-root', '--unknown-helper-option', 'value', '--', 'git', 'status'],
      ['record-git-transition', '--run-dir', '/tmp/run', '--attempt', 'merge-transition', '--kind', 'merge', '--expect-before', OID],
      ['verify-closeout', '--run-dir', '/tmp/run', '--failure-receipt-dir', '/tmp/failure'],
      ['record-internal-check', '--run-dir', '/tmp/run', '--attempt', 'valid-id', '--unknown', 'value'],
      ['record-internal-check', '--run-dir', '/tmp/run', '--run-dir', '/tmp/other', '--attempt', 'valid-id'],
      ['record-internal-check', '--run-dir', '/tmp/run', '--attempt', 'bad/id'],
      ['record-internal-check', '--run-dir', '/tmp/run', '--attempt', 'bad\nid'],
      ['record-internal-check', '--run-dir', '/tmp/run', '--attempt', 'Bad'],
      ['record-internal-check', '--run-dir', '/tmp/run', '--attempt', `a${'b'.repeat(64)}`],
      ['record-internal-check', '--run-dir', '/tmp/run', '--attempt', 'duplicate', '--attempt', 'duplicate'],
    ];

    for (const argv of invalidInvocations) {
      expect(() => api.parseBoundaryRunInvocation!(argv), argv.join(' ')).toThrow(/semantic\.invocation-invalid/);
    }
  });

  it('[BCF00-N02] accepts one exact command with canonical unique IDs', () => {
    const api = boundaryCli as unknown as {
      parseBoundaryRunInvocation?: (argv: readonly string[]) => unknown;
    };
    expect(typeof api.parseBoundaryRunInvocation).toBe('function');
    if (!api.parseBoundaryRunInvocation) return;

    expect(api.parseBoundaryRunInvocation([
      'record-internal-check',
      '--run-dir',
      '/tmp/bcf/observation/valid-run',
      '--attempt',
      'readiness-check',
    ])).toEqual({
      command: 'record-internal-check',
      options: {
        attempt: 'readiness-check',
        runDir: '/tmp/bcf/observation/valid-run',
      },
    });
    expect(api.parseBoundaryRunInvocation([
      'init', '--run-dir', '/tmp/bcf/observation/valid-run', '--task', 'BCF-00',
      '--profile', 'bcf00-observation', '--preserve-owner-path', 'owner.tsv',
      '--allow-untracked', 'scratch/result.json', '--allow-untracked', 'scratch/second.json',
    ])).toEqual({
      command: 'init',
      options: {
        allowUntracked: ['scratch/result.json', 'scratch/second.json'],
        preserveOwnerPath: ['owner.tsv'],
        profile: 'bcf00-observation',
        runDir: '/tmp/bcf/observation/valid-run',
        task: 'BCF-00',
      },
    });
    expect(api.parseBoundaryRunInvocation([
      'record-command', '--run-dir', '/tmp/bcf/observation/valid-run', '--attempt', 'upstream-root',
      '--expect-exit', '0', '--', 'git', 'rev-parse', '--show-toplevel',
    ])).toEqual({
      command: 'record-command',
      commandArgv: ['git', 'rev-parse', '--show-toplevel'],
      options: {
        attempt: 'upstream-root',
        expectExit: '0',
        runDir: '/tmp/bcf/observation/valid-run',
      },
    });
  });


  it('[BCF00-U06] rejects profile-set and reserved-attempt contract substitutions', () => {
    const api = boundaryRun as unknown as {
      BOUNDARY_VERSIONLESS_TOOLS?: readonly string[];
      RUN_CONTRACT_PROFILES?: Record<string, Record<string, unknown>>;
      RUN_ATTEMPT_CONTRACTS?: Record<string, Record<string, unknown>>;
      RUN_CHILD_CONTRACTS?: Record<string, Record<string, unknown>>;
      resolveBoundaryToolCapability?: (name: string) => Record<string, unknown>;
      validateBoundaryProfileSelection?: (input: Record<string, unknown>) => ReturnType<typeof validateBoundaryRun>;
      validateBoundaryAttemptInvocation?: (id: string, input: Record<string, unknown>) => ReturnType<typeof validateBoundaryRun>;
      parseBoundaryChildPins?: (profileId: string, entryHead: string, values: readonly string[]) => {
        result: ReturnType<typeof validateBoundaryRun>;
        pins: unknown[] | null;
      };
    };
    expect(api.RUN_CONTRACT_PROFILES).toBeDefined();
    expect(api.BOUNDARY_VERSIONLESS_TOOLS).toEqual(['kill', 'test', 'tr', 'wc']);
    expect(api.RUN_ATTEMPT_CONTRACTS).toBeDefined();
    expect(api.RUN_CHILD_CONTRACTS).toBeDefined();
    expect(typeof api.resolveBoundaryToolCapability).toBe('function');
    expect(typeof api.validateBoundaryProfileSelection).toBe('function');
    expect(typeof api.validateBoundaryAttemptInvocation).toBe('function');
    expect(typeof api.parseBoundaryChildPins).toBe('function');
    if (!api.RUN_CONTRACT_PROFILES || !api.RUN_ATTEMPT_CONTRACTS || !api.RUN_CHILD_CONTRACTS || !api.resolveBoundaryToolCapability || !api.validateBoundaryProfileSelection || !api.validateBoundaryAttemptInvocation || !api.parseBoundaryChildPins) return;

    expect(Object.keys(api.RUN_CONTRACT_PROFILES)).toEqual(Object.keys(EXPECTED_PROFILE_ROWS));
    for (const [profileId, expected] of Object.entries(EXPECTED_PROFILE_ROWS)) {
      const row = api.RUN_CONTRACT_PROFILES[profileId]!;
      expect([
        row['taskId'],
        row['phase'],
        row['terminalLifecycle'],
        row['mayComplete'],
        row['chainAppend'],
        row['transition'],
        row['predecessorProfileId'],
        (row['requiredChildren'] as string[]).join(','),
        (row['requiredAttemptIds'] as string[]).join(','),
      ], profileId).toEqual(expected);
      expect(row['allowedPaths'], `${profileId} paths`).toEqual(EXPECTED_PROFILE_PATHS[profileId as keyof typeof EXPECTED_PROFILE_PATHS]);
      expect(row['profileId'], `${profileId} identity`).toBe(profileId);
    }
    const requiredAttemptIds = [...new Set(Object.values(api.RUN_CONTRACT_PROFILES)
      .flatMap((row) => row['requiredAttemptIds'] as string[]))].sort();
    expect(Object.keys(api.RUN_ATTEMPT_CONTRACTS).sort()).toEqual(requiredAttemptIds);
    expect(Object.keys(api.RUN_CHILD_CONTRACTS)).toEqual(Object.keys(EXPECTED_CHILD_CONTRACT_ROWS));
    for (const [id, expected] of Object.entries(EXPECTED_CHILD_CONTRACT_ROWS)) {
      const row = api.RUN_CHILD_CONTRACTS[id]!;
      expect([
        row['kind'], row['taskId'], row['profileId'], row['dedupeKey'], row['headRelation'], row['maxDepth'],
      ], id).toEqual(expected);
    }

    const profile = structuredClone(api.RUN_CONTRACT_PROFILES['bcf00-observation']!);
    for (const candidate of [
      { ...profile, taskId: 'BCF-01' },
      { ...profile, profileId: 'bcf00-reconciliation' },
      { ...profile, requiredAttemptIds: (profile['requiredAttemptIds'] as string[]).slice(1) },
      { ...profile, requiredAttemptIds: [...profile['requiredAttemptIds'] as string[], 'extra-attempt'] },
    ]) {
      expect(api.validateBoundaryProfileSelection(candidate)).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
    }

    const capability = api.resolveBoundaryToolCapability('git');
    const invocation = {
      operation: 'command',
      argv: ['git', 'rev-parse', '--show-toplevel'],
      environment: { HOME: '/tmp/home', LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin', TMPDIR: '/tmp', TZ: 'UTC' },
      capability,
      expectedExit: '0',
      watchdogOwner: 'helper-watchdog',
      innerTimeoutOwner: null,
      deadlineMs: 120_000,
      killGraceMs: 30_000,
      outputPaths: [],
      headAnchor: 'entry',
    };
    const attempts = [
      { ...invocation, argv: ['git', 'status'] },
      { ...invocation, environment: { ...invocation.environment, SKIP_TESTS: '1' } },
      { ...invocation, capability: { ...capability, sha256: '0'.repeat(64) } },
      { ...invocation, operation: 'internal-check' },
    ];
    for (const candidate of attempts) {
      expect(api.validateBoundaryAttemptInvocation('upstream-root', candidate)).toMatchObject({
        ok: false,
        exitCode: 1,
        verdict: 'Inconclusive',
      });
    }
    for (const values of [
      [],
      [`upstream-observation,${OID},observation-run,${SHA}`, `other,${OID},other-run,${SHA_B}`],
      [`upstream-observation,${OID_C},observation-run,${SHA}`],
      [`upstream-observation,${OID},BAD_RUN,${SHA}`],
      [`upstream-observation,${OID},observation-run,${SHA.toUpperCase()}`],
    ]) {
      expect(api.parseBoundaryChildPins('bcf00-reconciliation', OID, values).result).toMatchObject({
        ok: false,
        exitCode: 1,
        verdict: 'Inconclusive',
      });
    }
    expect(api.parseBoundaryChildPins('bcf00-observation', OID, [
      `upstream-observation,${OID},observation-run,${SHA}`,
    ]).result).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
  });

  it('[BCF00-N06] accepts the exact generated profile and reserved attempt contract', () => {
    const api = boundaryRun as unknown as {
      BOUNDARY_VERSIONLESS_TOOLS?: readonly string[];
      RUN_CONTRACT_PROFILES?: Record<string, Record<string, unknown>>;
      RUN_ATTEMPT_CONTRACTS?: Record<string, Record<string, unknown>>;
      resolveBoundaryToolCapability?: (name: string) => Record<string, unknown>;
      validateBoundaryProfileSelection?: (input: Record<string, unknown>) => ReturnType<typeof validateBoundaryRun>;
      validateBoundaryAttemptInvocation?: (id: string, input: Record<string, unknown>) => ReturnType<typeof validateBoundaryRun>;
      parseBoundaryChildPins?: (profileId: string, entryHead: string, values: readonly string[]) => {
        result: ReturnType<typeof validateBoundaryRun>;
        pins: unknown[] | null;
      };
    };
    expect(api.RUN_CONTRACT_PROFILES).toBeDefined();
    expect(api.RUN_ATTEMPT_CONTRACTS).toBeDefined();
    expect(api.BOUNDARY_VERSIONLESS_TOOLS).toEqual(['kill', 'test', 'tr', 'wc']);
    expect(typeof api.resolveBoundaryToolCapability).toBe('function');
    expect(typeof api.validateBoundaryProfileSelection).toBe('function');
    expect(typeof api.validateBoundaryAttemptInvocation).toBe('function');
    expect(typeof api.parseBoundaryChildPins).toBe('function');
    if (!api.RUN_CONTRACT_PROFILES || !api.RUN_ATTEMPT_CONTRACTS || !api.resolveBoundaryToolCapability || !api.validateBoundaryProfileSelection || !api.validateBoundaryAttemptInvocation || !api.parseBoundaryChildPins) return;

    const profile = structuredClone(api.RUN_CONTRACT_PROFILES['bcf00-observation']!);
    expect(api.validateBoundaryProfileSelection(profile)).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    expect(api.validateBoundaryAttemptInvocation('upstream-root', {
      operation: 'command',
      argv: ['git', 'rev-parse', '--show-toplevel'],
      environment: { HOME: '/tmp/home', LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin', TMPDIR: '/tmp', TZ: 'UTC' },
      capability: api.resolveBoundaryToolCapability('git'),
      expectedExit: '0',
      watchdogOwner: 'helper-watchdog',
      innerTimeoutOwner: null,
      deadlineMs: 120_000,
      killGraceMs: 30_000,
      outputPaths: [],
      headAnchor: 'entry',
    })).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });

    expect(api.RUN_ATTEMPT_CONTRACTS['catalog-inventory-sort']?.['outputPaths']).toEqual([
      'attempts/catalog-inventory-sort/stdout.log',
    ]);

    for (const name of ['rg', 'tr', 'sort', 'wc']) {
      const capability = api.resolveBoundaryToolCapability(name);
      expect(capability, name).toMatchObject({
        name,
        realPath: expect.any(String),
        version: expect.stringMatching(/^.{1,256}$/),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(path.isAbsolute(String(capability['realPath'])), name).toBe(true);
    }
    expect(api.parseBoundaryChildPins('bcf00-reconciliation', OID, [
      `upstream-observation,${OID},observation-run,${SHA}`,
    ])).toMatchObject({
      result: { ok: true, exitCode: 0, verdict: 'Pass' },
      pins: [{ alias: 'upstream-observation', head: OID, runId: 'observation-run', manifestSha256: SHA }],
    });
    expect(api.parseBoundaryChildPins('bcf00-observation', OID, [])).toMatchObject({
      result: { ok: true, exitCode: 0, verdict: 'Pass' },
      pins: [],
    });
  });

  it('binds versionless capability fallback to the exact executable hash', () => {
    const api = boundaryRun as unknown as {
      BOUNDARY_VERSIONLESS_TOOLS?: readonly string[];
      resolveBoundaryToolCapability?: (name: string) => Record<string, unknown>;
    };
    expect(api.BOUNDARY_VERSIONLESS_TOOLS).toEqual(['kill', 'test', 'tr', 'wc']);
    expect(typeof api.resolveBoundaryToolCapability).toBe('function');
    if (!api.resolveBoundaryToolCapability) return;

    const fakeToolRoot = mkdtempSync(path.join(tmpdir(), 'boundary-capability-probes-'));
    fixtureRoots.push(fakeToolRoot);
    for (const name of ['rg', 'tr']) {
      const executable = path.join(fakeToolRoot, name);
      writeFileSync(executable, '#!/bin/sh\nexit 64\n', 'utf8');
      chmodSync(executable, 0o755);
    }
    const originalPath = process.env['PATH'];
    process.env['PATH'] = fakeToolRoot;
    try {
      const capability = api.resolveBoundaryToolCapability('tr');
      expect(capability).toMatchObject({
        name: 'tr',
        realPath: realpathSync(path.join(fakeToolRoot, 'tr')),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(capability['version']).toBe(`content-sha256:${capability['sha256']}`);
      expect(() => api.resolveBoundaryToolCapability!('rg')).toThrow();
    } finally {
      if (originalPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = originalPath;
    }
  });

  it('covers every profile-owned internal-check name with one implemented helper contract', () => {
    const implemented = (boundaryCli as unknown as { BOUNDARY_IMPLEMENTED_INTERNAL_CHECKS?: readonly string[] })
      .BOUNDARY_IMPLEMENTED_INTERNAL_CHECKS;
    expect(implemented).toBeDefined();
    const required = [...new Set(Object.values(boundaryRun.RUN_ATTEMPT_CONTRACTS)
      .filter((contract) => contract.operation === 'internal-check')
      .map((contract) => contract.internalCheck!))].sort();
    expect(implemented).toEqual(required);
  });

  it('covers every profile-owned structured-result predicate with a closed executable contract', () => {
    const required = [...new Set(Object.values(boundaryRun.RUN_ATTEMPT_CONTRACTS)
      .map((contract) => contract.resultPredicate)
      .filter((predicate): predicate is string => predicate !== null))].sort();
    expect(boundaryRun.BOUNDARY_SUPPORTED_RESULT_PREDICATES).toEqual(required);
    expect(boundaryRun.RUN_TEST_CONTRACTS.bcf01.markerIds).toEqual([
      '[BCF01-U01]', '[BCF01-U02]', '[BCF01-U03]', '[BCF01-U04]', '[BCF01-U05]', '[BCF01-U06]',
      '[BCF01-S01]',
      '[BCF01-N01]', '[BCF01-N02]', '[BCF01-N03]', '[BCF01-N04]', '[BCF01-N05]', '[BCF01-N06]',
    ]);
    expect(boundaryRun.RUN_TEST_CONTRACTS.bcf06.markerIds).toEqual([
      '[BCF06-U01]', '[BCF06-S01]', '[BCF06-S02]', '[BCF06-S03]',
    ]);
    expect(boundaryRun.RUN_TEST_CONTRACTS.bcf07.markerIds).toEqual([
      '[BCF07-U01]', '[BCF07-U02]', '[BCF07-U03]', '[BCF07-U04]',
      '[BCF07-S01]', '[BCF07-S02]',
      '[BCF07-N01]', '[BCF07-N02]', '[BCF07-N03]', '[BCF07-N04]',
    ]);
    expect(boundaryRun.RUN_ATTEMPT_CONTRACTS['merge-preview']?.argv).toEqual([
      'git', 'merge-tree', '--write-tree', '--messages', 'HEAD', 'origin/main',
    ]);
    expect(boundaryRun.RUN_ATTEMPT_CONTRACTS['merge-preview']?.expectedExit).toBe('0,1');
  });

  it('accepts only the exact RED unsafe sentinels paired with passing safe controls', () => {
    const contract = boundaryRun.RUN_TEST_CONTRACTS.bcf01;
    const rows = [...contract.unsafeMarkerIds, ...contract.safeMarkerIds].map((markerId) => {
      const unsafe = markerId.includes('-U');
      return {
        ancestorTitles: ['parser contract'],
        fullName: `parser contract ${markerId}`,
        title: `${markerId} exact contract case`,
        status: unsafe ? 'failed' : 'passed',
        failureMessages: unsafe
          ? [`Error: BCF_EXPECTATION_UNMET:BCF01-${markerId.slice(-3, -1)}\n at contract.test.ts:1:1`]
          : [],
      };
    });
    const report = {
      numFailedTestSuites: 1,
      numFailedTests: contract.unsafeMarkerIds.length,
      numPassedTestSuites: 0,
      numPassedTests: contract.safeMarkerIds.length,
      numPendingTestSuites: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      numTotalTestSuites: 1,
      numTotalTests: rows.length,
      snapshot: {},
      startTime: 1,
      success: false,
      testResults: [{
        name: '/repo/tests/scripts/semantic-quality-check.test.ts',
        status: 'failed',
        assertionResults: rows,
      }],
    };
    const input = {
      predicate: 'bcf01-red', cwd: '/repo',
      entryTestRoster: {
        files: [{ path: contract.testFiles[0], state: 'present', testNames: [] }], digestSha256: SHA,
      },
      report,
    };
    expect(boundaryRun.validateBoundaryVitestJsonReport(input)).toMatchObject({ ok: true, verdict: 'Pass' });
    const wrong = structuredClone(input);
    wrong.report.testResults[0]!.assertionResults[0]!.failureMessages = ['Error: unrelated failure'];
    expect(boundaryRun.validateBoundaryVitestJsonReport(wrong).issues.map((entry) => entry.code))
      .toContain('test-red-sentinel-mismatch');
  });

  it('derives the baseline evaluator oracle from every locked corpus case', () => {
    const corpus = loadCorpus(path.join(process.cwd(), 'tests/fixtures/semantic-boundary-eval/cases.json'));
    const report = evaluateBaseline(corpus) as unknown as Record<string, unknown>;
    const input = { predicate: 'baseline-13-of-40', cwd: process.cwd(), entryTestRoster: { files: [] }, report };
    expect(boundaryRun.validateBoundaryVitestJsonReport(input)).toMatchObject({ ok: true, verdict: 'Pass' });
    const changed = structuredClone(input);
    (changed.report['mismatches'] as Array<Record<string, unknown>>)[0]!['predicted'] = 'block';
    expect(boundaryRun.validateBoundaryVitestJsonReport(changed).issues.map((entry) => entry.code))
      .toContain('evaluator-result-mismatch');
  });

  it('binds every candidate receipt to the exact holdout oracle and frozen score', () => {
    const corpus = loadCorpus(path.join(process.cwd(), 'tests/fixtures/semantic-boundary-eval/holdout.json'));
    const report = evaluateCandidate(corpus, { verifyGit: true, cwd: process.cwd() }) as unknown as Record<string, unknown>;
    const input = { predicate: 'holdout-18-of-18', cwd: process.cwd(), entryTestRoster: { files: [] }, report };
    expect(boundaryRun.validateBoundaryVitestJsonReport(input)).toMatchObject({ ok: true, verdict: 'Pass' });
    const changed = structuredClone(input);
    (changed.report['receipts'] as Array<Record<string, unknown>>)[0]!['caseId'] = 'substituted-case';
    expect(boundaryRun.validateBoundaryVitestJsonReport(changed).issues.map((entry) => entry.code))
      .toContain('evaluator-case-roster-mismatch');
  }, 30_000);

  it('runs closeout negative controls through the same closure verifier as the unchanged neighbor', () => {
    const base: boundaryCli.BoundaryCloseoutControlClosure = {
      manifest: validManifest(),
      closeoutCore: {
        internalStatus: [
          { stage: 'finalize', rawExit: 0, rawSignal: null, expectationMet: true, verdict: 'Pass' },
          { stage: 'verify', rawExit: 0, rawSignal: null, expectationMet: true, verdict: 'Pass' },
        ],
      },
      completionReceipt: { oracleDigest: SHA },
      ledger: { oracleDigest: SHA },
    };
    expect(boundaryCli.validateBoundaryCloseoutControlClosure(structuredClone(base), base))
      .toMatchObject({ ok: true, verdict: 'Pass' });
    const controls: Array<[string, (value: boundaryCli.BoundaryCloseoutControlClosure) => void]> = [
      ['head-mismatch', (value) => { value.manifest.run.terminalHead = OID_C; }],
      ['diff-mismatch', (value) => { value.manifest.currentSnapshot.digestSha256 = SHA_B; }],
      ['changed-manifest', (value) => { value.manifest.run.createdAtUtc = '2026-07-16T16:30:00.001Z'; }],
      ['substituted-core', (value) => { value.closeoutCore['helperSha256'] = SHA_B; }],
      ['missing-completion-receipt', (value) => { value.completionReceipt = null; }],
      ['changed-completion-receipt', (value) => { value.completionReceipt!['oracleDigest'] = SHA_B; }],
      ['changed-chain-ledger', (value) => { value.ledger!['oracleDigest'] = SHA_B; }],
      ['forged-internal-status', (value) => {
        (value.closeoutCore['internalStatus'] as Array<Record<string, unknown>>)[0]!['rawExit'] = 1;
      }],
    ];
    for (const [reason, mutate] of controls) {
      const candidate = structuredClone(base);
      mutate(candidate);
      const result = boundaryCli.validateBoundaryCloseoutControlClosure(candidate, base);
      expect(result.ok, reason).toBe(false);
      expect(result.issues[0]?.code, reason).toBe(reason);
    }
  });

  it('[BCF00-U07] rejects incomplete, weakened, or misclassified structured test results', () => {
    type TestRow = { marker: string; status: 'passed' | 'failed' | 'skipped' | 'todo'; failureReason: string | null };
    type TestResult = {
      testFile: string;
      registeredMarkerIds: string[];
      tests: TestRow[];
      collectionErrors: string[];
      unhandledErrors: string[];
    };
    const api = boundaryRun as unknown as {
      RUN_TEST_CONTRACTS?: { bcf00: { markerIds: string[]; testFile: string } };
      validateBoundaryStructuredTestResult?: (mode: 'red' | 'green', result: TestResult) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(api.RUN_TEST_CONTRACTS?.bcf00.markerIds).toEqual(expectedBcf00Markers);
    expect(typeof api.validateBoundaryStructuredTestResult).toBe('function');
    if (!api.RUN_TEST_CONTRACTS || !api.validateBoundaryStructuredTestResult) return;

    const green = (): TestResult => ({
      testFile: api.RUN_TEST_CONTRACTS!.bcf00.testFile,
      registeredMarkerIds: [...expectedBcf00Markers],
      tests: expectedBcf00Markers.map((id) => ({ marker: id, status: 'passed', failureReason: null })),
      collectionErrors: [],
      unhandledErrors: [],
    });
    const cases: Array<{ code: string; result: TestResult }> = [];
    const missing = green();
    missing.tests.pop();
    cases.push({ code: 'test-marker-roster-mismatch', result: missing });
    const zero = green();
    zero.tests = [];
    cases.push({ code: 'test-zero-collected', result: zero });
    const skipped = green();
    skipped.tests[0]!.status = 'skipped';
    cases.push({ code: 'test-nonterminal-status', result: skipped });
    const todo = green();
    todo.tests[0]!.status = 'todo';
    cases.push({ code: 'test-nonterminal-status', result: todo });
    const renamed = green();
    renamed.tests[0]!.marker = marker('RENAMED');
    cases.push({ code: 'test-marker-roster-mismatch', result: renamed });
    const collection = green();
    collection.collectionErrors = ['import failed'];
    cases.push({ code: 'test-collection-error', result: collection });
    const unhandled = green();
    unhandled.unhandledErrors = ['unhandled rejection'];
    cases.push({ code: 'test-unhandled-error', result: unhandled });
    const weakened = green();
    weakened.registeredMarkerIds.pop();
    cases.push({ code: 'test-registration-mismatch', result: weakened });
    for (const candidate of cases) {
      const result = api.validateBoundaryStructuredTestResult('green', candidate.result);
      expect(result, candidate.code).toMatchObject({ ok: false, exitCode: 1, verdict: 'Inconclusive' });
      expect(result.issues.map((entry) => entry.code), candidate.code).toContain(candidate.code);
    }

    const redSelection = expectedBcf00Markers.filter((id) => id.includes('-B') || id.includes('-U'));
    const wrongSentinel: TestResult = {
      testFile: api.RUN_TEST_CONTRACTS.bcf00.testFile,
      registeredMarkerIds: [...expectedBcf00Markers],
      tests: redSelection.map((id) => ({
        marker: id,
        status: id.includes('-B') ? 'passed' : 'failed',
        failureReason: id === marker('U07') ? 'unrelated assertion' : `unsafe:${id}`,
      })),
      collectionErrors: [],
      unhandledErrors: [],
    };
    const wrong = api.validateBoundaryStructuredTestResult('red', wrongSentinel);
    expect(wrong.ok).toBe(false);
    expect(wrong.issues.map((entry) => entry.code)).toContain('test-red-sentinel-mismatch');
  });

  it('[BCF00-N07] accepts the exact nonzero registered marker roster and result predicate', () => {
    const api = boundaryRun as unknown as {
      RUN_TEST_CONTRACTS?: { bcf00: { markerIds: string[]; testFile: string } };
      validateBoundaryStructuredTestResult?: (mode: 'green', result: Record<string, unknown>) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(api.RUN_TEST_CONTRACTS?.bcf00.markerIds).toEqual(expectedBcf00Markers);
    expect(typeof api.validateBoundaryStructuredTestResult).toBe('function');
    if (!api.RUN_TEST_CONTRACTS || !api.validateBoundaryStructuredTestResult) return;
    expect(api.validateBoundaryStructuredTestResult('green', {
      testFile: api.RUN_TEST_CONTRACTS.bcf00.testFile,
      registeredMarkerIds: [...expectedBcf00Markers],
      tests: expectedBcf00Markers.map((id) => ({ marker: id, status: 'passed', failureReason: null })),
      collectionErrors: [],
      unhandledErrors: [],
    })).toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
  });

  it('binds a Vitest JSON report to the exact entry roster and BCF-00 marker registry', () => {
    const api = boundaryRun as unknown as {
      validateBoundaryVitestJsonReport?: (input: Record<string, unknown>) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(typeof api.validateBoundaryVitestJsonReport).toBe('function');
    if (!api.validateBoundaryVitestJsonReport) return;
    const sourceOrderedMarkers = [
      marker('B01'),
      ...Array.from({ length: 16 }, (_, index) => [
        marker(`U${String(index + 1).padStart(2, '0')}`),
        marker(`N${String(index + 1).padStart(2, '0')}`),
      ]).flat(),
    ];
    const testNames = [...sourceOrderedMarkers, 'retains one pre-existing unmarked test'];
    const assertions = testNames.map((title) => ({
      ancestorTitles: ['boundary run validator'],
      fullName: `boundary run validator ${title}`,
      status: 'passed',
      title,
      failureMessages: [],
    }));
    const report = {
      numFailedTestSuites: 0,
      numFailedTests: 0,
      numPassedTestSuites: 1,
      numPassedTests: assertions.length,
      numPendingTestSuites: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      numTotalTestSuites: 1,
      numTotalTests: assertions.length,
      snapshot: {},
      startTime: 1,
      success: true,
      testResults: [{
        name: '/repo/tests/scripts/verify-boundary-run.test.ts',
        status: 'passed',
        assertionResults: assertions,
      }],
    };
    const input = {
      predicate: 'bcf00-green',
      cwd: '/repo',
      entryTestRoster: {
        files: [{
          path: 'tests/scripts/verify-boundary-run.test.ts',
          state: 'present',
          testNames: assertions.map((entry) => entry.fullName).sort(),
        }],
        digestSha256: SHA,
      },
      report,
    };
    expect(api.validateBoundaryVitestJsonReport(input)).toMatchObject({ ok: true, verdict: 'Pass' });
    const missing = structuredClone(input);
    missing.report.testResults[0]!.assertionResults.pop();
    missing.report.numPassedTests -= 1;
    missing.report.numTotalTests -= 1;
    expect(api.validateBoundaryVitestJsonReport(missing).issues.map((entry) => entry.code))
      .toContain('test-entry-roster-mismatch');
  });

  it('binds RED predicates to selected rows while reconciling reporter-generated skips', () => {
    const api = boundaryRun as unknown as {
      RUN_TEST_CONTRACTS?: {
        bcf01: {
          unsafeMarkerIds: readonly string[];
          safeMarkerIds: readonly string[];
          neighborMarkerIds: readonly string[];
        };
      };
      validateBoundaryVitestJsonReport?: (
        input: Record<string, unknown>,
      ) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(typeof api.validateBoundaryVitestJsonReport).toBe('function');
    expect(api.RUN_TEST_CONTRACTS?.bcf01).toBeDefined();
    if (!api.validateBoundaryVitestJsonReport || !api.RUN_TEST_CONTRACTS) return;

    const contract = api.RUN_TEST_CONTRACTS.bcf01;
    const assertions = [
      ...contract.unsafeMarkerIds.map((markerId) => ({
        ancestorTitles: ['semantic quality CLI'],
        fullName: `semantic quality CLI ${markerId} unsafe case`,
        status: 'failed',
        title: `${markerId} unsafe case`,
        failureMessages: [
          `AssertionError: BCF_EXPECTATION_UNMET:${markerId.slice(1, 6)}-${markerId.slice(-3, -1)}`,
        ],
      })),
      ...contract.safeMarkerIds.map((markerId) => ({
        ancestorTitles: ['semantic quality CLI'],
        fullName: `semantic quality CLI ${markerId} safe control`,
        status: 'passed',
        title: `${markerId} safe control`,
        failureMessages: [],
      })),
      {
        ancestorTitles: ['semantic quality CLI'],
        fullName: `semantic quality CLI ${contract.neighborMarkerIds[0]} valid neighbor`,
        status: 'skipped',
        title: `${contract.neighborMarkerIds[0]} valid neighbor`,
        failureMessages: [],
      },
      {
        ancestorTitles: ['semantic quality receipt'],
        fullName: 'semantic quality receipt preserves a legacy behavior',
        status: 'skipped',
        title: 'preserves a legacy behavior',
        failureMessages: [],
      },
    ];
    const input = {
      predicate: 'bcf01-red',
      cwd: '/repo',
      entryTestRoster: {
        files: [{
          path: 'tests/scripts/semantic-quality-check.test.ts',
          state: 'present',
          testNames: assertions.map((entry) => entry.fullName).sort(),
        }],
        digestSha256: SHA,
      },
      report: {
        numFailedTestSuites: 1,
        numFailedTests: contract.unsafeMarkerIds.length,
        numPassedTestSuites: 1,
        numPassedTests: contract.safeMarkerIds.length,
        numPendingTestSuites: 0,
        numPendingTests: 2,
        numTodoTests: 0,
        numTotalTestSuites: 2,
        numTotalTests: assertions.length,
        snapshot: {},
        startTime: 1,
        success: false,
        testResults: [{
          name: '/repo/tests/scripts/semantic-quality-check.test.ts',
          status: 'failed',
          assertionResults: assertions,
        }],
      },
    };

    expect(api.validateBoundaryVitestJsonReport(input)).toMatchObject({ ok: true, verdict: 'Pass' });

    for (const status of ['skipped', 'todo'] as const) {
      const selectedNonterminal = structuredClone(input);
      const assertion = selectedNonterminal.report.testResults[0]!.assertionResults[0]!;
      assertion.status = status;
      assertion.failureMessages = [];
      selectedNonterminal.report.numFailedTests -= 1;
      if (status === 'skipped') selectedNonterminal.report.numPendingTests += 1;
      else selectedNonterminal.report.numTodoTests += 1;
      expect(
        api.validateBoundaryVitestJsonReport(selectedNonterminal).issues.map((entry) => entry.code),
        status,
      ).toContain('test-red-sentinel-mismatch');
    }

    const unknownMarker = structuredClone(input);
    const unmarked = unknownMarker.report.testResults[0]!.assertionResults.at(-1)!;
    unmarked.fullName = 'semantic quality receipt [BCF01-U99] unknown marker';
    unmarked.title = '[BCF01-U99] unknown marker';
    expect(api.validateBoundaryVitestJsonReport(unknownMarker).issues.map((entry) => entry.code))
      .toContain('test-marker-roster-mismatch');

    const countDrift = structuredClone(input);
    countDrift.report.numPendingTests -= 1;
    expect(api.validateBoundaryVitestJsonReport(countDrift).issues.map((entry) => entry.code))
      .toContain('test-report-count-invalid');
  });

  it('keeps cumulative predecessor markers without admitting them to the current predicate', () => {
    const api = boundaryRun as unknown as {
      RUN_TEST_CONTRACTS?: {
        bcf04: {
          unsafeMarkerIds: readonly string[];
          safeMarkerIds: readonly string[];
          neighborMarkerIds: readonly string[];
        };
      };
      validateBoundaryVitestJsonReport?: (
        input: Record<string, unknown>,
      ) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(typeof api.validateBoundaryVitestJsonReport).toBe('function');
    expect(api.RUN_TEST_CONTRACTS?.bcf04).toBeDefined();
    if (!api.validateBoundaryVitestJsonReport || !api.RUN_TEST_CONTRACTS) return;

    const contract = api.RUN_TEST_CONTRACTS.bcf04;
    const retainedContract = {
      ancestorTitles: ['boundary contract'],
      fullName: 'boundary contract [BCF03-U01] retained predecessor marker',
      status: 'passed',
      title: '[BCF03-U01] retained predecessor marker',
      failureMessages: [] as string[],
    };
    const retainedCli = {
      ancestorTitles: ['semantic quality CLI'],
      fullName: 'semantic quality CLI [BCF01-U01] retained predecessor marker',
      status: 'passed',
      title: '[BCF01-U01] retained predecessor marker',
      failureMessages: [] as string[],
    };
    const currentAssertions = [
      ...contract.unsafeMarkerIds,
      ...contract.safeMarkerIds,
      ...contract.neighborMarkerIds,
    ].map((markerId) => ({
      ancestorTitles: ['boundary receipt'],
      fullName: `boundary receipt ${markerId} current case`,
      status: 'passed',
      title: `${markerId} current case`,
      failureMessages: [] as string[],
    }));
    const greenAssertions = [retainedContract, ...currentAssertions];
    const greenInput = {
      predicate: 'bcf04-green',
      cwd: '/repo',
      entryTestRoster: {
        files: [
          {
            path: 'tests/scripts/semantic-boundary-contract.test.ts',
            state: 'present',
            testNames: [retainedContract.fullName],
          },
          {
            path: 'tests/scripts/semantic-quality-check.test.ts',
            state: 'present',
            testNames: [retainedCli.fullName],
          },
        ],
        digestSha256: SHA,
      },
      report: {
        numFailedTestSuites: 0,
        numFailedTests: 0,
        numPassedTestSuites: 2,
        numPassedTests: greenAssertions.length + 1,
        numPendingTestSuites: 0,
        numPendingTests: 0,
        numTodoTests: 0,
        numTotalTestSuites: 2,
        numTotalTests: greenAssertions.length + 1,
        snapshot: {},
        startTime: 1,
        success: true,
        testResults: [
          {
            name: '/repo/tests/scripts/semantic-boundary-contract.test.ts',
            status: 'passed',
            assertionResults: greenAssertions,
          },
          {
            name: '/repo/tests/scripts/semantic-quality-check.test.ts',
            status: 'passed',
            assertionResults: [retainedCli],
          },
        ],
      },
    };
    expect(api.validateBoundaryVitestJsonReport(greenInput))
      .toMatchObject({ ok: true, verdict: 'Pass' });

    const redInput = structuredClone(greenInput);
    redInput.predicate = 'bcf04-red';
    const redRows = redInput.report.testResults[0]!.assertionResults;
    for (const assertion of redRows) {
      const markerId = assertion.title.match(/\[BCF04-[USN]\d{2}\]/)?.[0];
      if (markerId === undefined || markerId.includes('-N')) {
        assertion.status = 'skipped';
      } else if (markerId.includes('-U')) {
        assertion.status = 'failed';
        assertion.failureMessages = [
          `AssertionError: BCF_EXPECTATION_UNMET:${markerId.slice(1, 6)}-${markerId.slice(-3, -1)}`,
        ];
      }
    }
    redInput.report.testResults[1]!.assertionResults[0]!.status = 'skipped';
    redInput.report.testResults[0]!.status = 'failed';
    redInput.report.testResults[1]!.status = 'skipped';
    redInput.report.numFailedTestSuites = 1;
    redInput.report.numFailedTests = contract.unsafeMarkerIds.length;
    redInput.report.numPassedTestSuites = 1;
    redInput.report.numPassedTests = contract.safeMarkerIds.length;
    redInput.report.numPendingTests = contract.neighborMarkerIds.length + 2;
    redInput.report.success = false;
    expect(api.validateBoundaryVitestJsonReport(redInput))
      .toMatchObject({ ok: true, verdict: 'Pass' });
  });

  it('enforces each closed command stdout predicate without caller-selected parsing', () => {
    const api = boundaryRun as unknown as {
      validateBoundaryStdoutPredicate?: (
        predicate: string | null,
        stdout: string,
        allowedPaths: readonly string[],
      ) => ReturnType<typeof validateBoundaryRun>;
    };
    expect(typeof api.validateBoundaryStdoutPredicate).toBe('function');
    if (!api.validateBoundaryStdoutPredicate) return;
    const valid: Array<[string | null, string, readonly string[]]> = [
      [null, 'anything\n', []],
      ['oid', `${OID}\n`, []],
      ['ssh-origin', `${SSH_REMOTE}\n`, []],
      ['ahead-behind', '3\t7\n', []],
      ['decimal-equals-29', '29\n', []],
      ['merge-preview', `${OID}\n`, []],
      ['exact-profile-allowlist', 'a.txt\nb.txt\n', ['a.txt', 'b.txt']],
    ];
    for (const [predicate, stdout, allowedPaths] of valid) {
      expect(api.validateBoundaryStdoutPredicate(predicate, stdout, allowedPaths), String(predicate))
        .toMatchObject({ ok: true, verdict: 'Pass' });
    }
    const conflictPreview = [
      OID,
      `100644 ${'1'.repeat(40)} 1\tdocs/work-index.json`,
      `100644 ${'2'.repeat(40)} 2\tdocs/work-index.json`,
      `100644 ${'3'.repeat(40)} 3\tdocs/work-index.json`,
      `100644 ${'4'.repeat(40)} 1\tdocs/work-index.md`,
      `100644 ${'5'.repeat(40)} 2\tdocs/work-index.md`,
      `100644 ${'6'.repeat(40)} 3\tdocs/work-index.md`,
      '',
      'Auto-merging docs/public-surface.md',
      'Auto-merging docs/work-index.json',
      'CONFLICT (content): Merge conflict in docs/work-index.json',
      'Auto-merging docs/work-index.md',
      'CONFLICT (content): Merge conflict in docs/work-index.md',
      '',
    ].join('\n');
    expect(api.validateBoundaryStdoutPredicate('merge-preview', conflictPreview, []))
      .toMatchObject({ ok: true, exitCode: 0, verdict: 'Pass' });
    for (const invalid of [
      conflictPreview.replace(`100644 ${'3'.repeat(40)} 3\tdocs/work-index.json\n`, ''),
      conflictPreview.replace(
        'CONFLICT (content): Merge conflict in docs/work-index.md',
        'CONFLICT (content): Merge conflict in docs/foreign.md',
      ),
      `${conflictPreview}unparsed diagnostic\n`,
    ]) {
      expect(api.validateBoundaryStdoutPredicate('merge-preview', invalid, []).issues.map((entry) => entry.code))
        .toContain('attempt-stdout-predicate-mismatch');
    }
    for (const [predicate, stdout, allowedPaths] of [
      ['oid', `${OID}\nextra\n`, []],
      ['ssh-origin', 'https://github.com/LucasQuiles/WhatSoup.git\n', []],
      ['ahead-behind', '3 7 extra\n', []],
      ['decimal-equals-29', '28\n', []],
      ['merge-preview', 'conflict\n', []],
      ['exact-profile-allowlist', 'a.txt\nc.txt\n', ['a.txt', 'b.txt']],
      ['unknown', 'anything\n', []],
    ] as const) {
      expect(api.validateBoundaryStdoutPredicate(predicate, stdout, allowedPaths), predicate)
        .toMatchObject({ ok: false, verdict: 'Inconclusive' });
    }
  });


}
