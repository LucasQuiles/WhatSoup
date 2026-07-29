import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  unlinkSync,
  type Stats,
} from "node:fs";

import {
  ARTIFACT_TRANSACTION_CONCURRENCY_BOUNDARY,
  ArtifactTransactionError,
  MAX_OPERATIONS,
  SHA256_PATTERN,
  acquireCoordinatorLock,
  buildJournal,
  canonicalJson,
  compareUtf8,
  createExclusiveSyncedFile,
  fail,
  fsyncDirectory,
  identity,
  isOwnedAfterLink,
  isOwnedBeforeLink,
  isRecord,
  loadOrCreateJournal,
  normalizeOperations,
  optionalFileIdentity,
  readJournalFile,
  readSafeFile,
  readTarget,
  receipt,
  receiptBody,
  releaseCoordinatorLock,
  resolveOperations,
  resolveRoot,
  revalidateAncestors,
  revalidateCoordinatorLock,
  safeRelativePath,
  sameJournal,
  targetState,
  transitionJournal,
  validateControlPaths,
  validatePhaseJournal,
  withRecoveryPacket,
  type ArtifactTransactionHookEvent,
  type ArtifactTransactionHookPhase,
  type ArtifactTransactionInput,
  type ArtifactTransactionOperation,
  type ArtifactTransactionProcessLockOptions,
  type ArtifactTransactionReceipt,
  type ArtifactTransactionRecoveryPacket,
  type ArtifactTransactionErrorCode,
  type JournalState,
  type Identity,
  type NormalizedOperation,
  type RecoverArtifactTransactionInput,
  type ResolvedOperation,
  type TargetState,
  type TransactionJournal,
} from "./artifact-transaction-internal.ts";

export {
  ARTIFACT_TRANSACTION_CONCURRENCY_BOUNDARY,
  ArtifactTransactionError,
  type ArtifactTransactionErrorCode,
  type ArtifactTransactionHookEvent,
  type ArtifactTransactionHookPhase,
  type ArtifactTransactionInput,
  type ArtifactTransactionOperation,
  type ArtifactTransactionProcessLockOptions,
  type ArtifactTransactionReceipt,
  type ArtifactTransactionRecoveryPacket,
  type RecoverArtifactTransactionInput,
};

function ensureCandidate(
  root: string,
  operation: ResolvedOperation,
  operationIndex: number,
  assertLock: () => void,
  hook: ArtifactTransactionInput["interruptionHook"],
): void {
  if (
    operation.desiredText === null ||
    operation.desiredSha256 === null ||
    operation.candidateAbsolute === null
  )
    return;
  if (isOwnedAfterLink(root, operation)) return;
  revalidateAncestors(root, operation.ancestors);
  const existing = optionalFileIdentity(
    operation.candidateAbsolute,
    "transaction candidate",
  );
  if (existing === null) {
    const before = readTarget(root, operation);
    const mode = before?.mode ?? 0o644;
    assertLock();
    try {
      createExclusiveSyncedFile(
        operation.candidateAbsolute,
        operation.desiredText,
        mode,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw fail(
          "candidate-invalid",
          `candidate for ${operation.path} appeared concurrently`,
          error,
        );
      }
      throw fail(
        "durability-failed",
        `candidate creation for ${operation.path} failed`,
        error,
      );
    }
    try {
      fsyncDirectory(operation.parent);
    } catch (error) {
      throw fail(
        "durability-failed",
        `candidate durability for ${operation.path} is unknown`,
        error,
      );
    }
  }
  const candidate = readSafeFile(
    root,
    operation.candidateAbsolute,
    `candidate for ${operation.path}`,
  );
  if (candidate.hash !== operation.desiredSha256) {
    throw fail(
      "candidate-invalid",
      `candidate for ${operation.path} has the wrong hash`,
    );
  }
  hook?.({
    phase: "candidate-durable",
    operationIndex,
    path: operation.path,
  });
}

function fsyncFinalFile(
  root: string,
  operation: ResolvedOperation,
  expectedLinks = 1,
): void {
  let descriptor: number;
  try {
    descriptor = openSync(
      operation.absolute,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    throw fail(
      "post-write-verification-failed",
      `final ${operation.path} cannot be opened`,
      error,
    );
  }
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== expectedLinks) {
      throw fail(
        "post-write-verification-failed",
        `final ${operation.path} has an unexpected link count`,
      );
    }
    try {
      fsyncSync(descriptor);
    } catch (error) {
      throw fail(
        "durability-failed",
        `final ${operation.path} durability is unknown`,
        error,
      );
    }
  } finally {
    closeSync(descriptor);
  }
  const valid =
    expectedLinks === 2
      ? isOwnedAfterLink(root, operation)
      : (() => {
          const final = readTarget(root, operation);
          return final !== null && final.hash === operation.desiredSha256;
        })();
  if (!valid) {
    throw fail(
      "post-write-verification-failed",
      `final ${operation.path} has the wrong hash`,
    );
  }
}

function readOwnedArtifact(
  root: string,
  path: string,
  expectedSha256: string,
  label: string,
): void {
  const artifact = readSafeFile(root, path, label);
  if (artifact.hash !== expectedSha256) {
    throw fail("candidate-invalid", `${label} has the wrong hash`);
  }
}

function ensureBackup(
  root: string,
  operation: ResolvedOperation,
  assertLock: () => void,
): void {
  if (
    operation.expectedBeforeSha256 === null ||
    operation.backupAbsolute === null
  ) {
    return;
  }
  if (isOwnedBeforeLink(root, operation)) return;
  const existing = optionalFileIdentity(
    operation.backupAbsolute,
    `backup for ${operation.path}`,
  );
  if (existing !== null) {
    readOwnedArtifact(
      root,
      operation.backupAbsolute,
      operation.expectedBeforeSha256,
      `backup for ${operation.path}`,
    );
    return;
  }
  const target = readTarget(root, operation);
  if (target === null || target.hash !== operation.expectedBeforeSha256) {
    throw fail(
      "concurrent-drift",
      `target ${operation.path} changed before backup`,
    );
  }
  assertLock();
  revalidateAncestors(root, operation.ancestors);
  const immediate = readTarget(root, operation);
  if (
    immediate === null ||
    immediate.hash !== operation.expectedBeforeSha256 ||
    immediate.identity.devIno !== target.identity.devIno
  ) {
    throw fail(
      "concurrent-drift",
      `target ${operation.path} changed immediately before backup`,
    );
  }
  try {
    linkSync(operation.absolute, operation.backupAbsolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw fail(
        "concurrent-drift",
        `backup for ${operation.path} appeared concurrently`,
        error,
      );
    }
    throw fail(
      "mutation-outcome-unknown",
      `backup creation outcome for ${operation.path} is unknown`,
      error,
    );
  }
  try {
    fsyncDirectory(operation.parent);
  } catch (error) {
    throw fail(
      "durability-failed",
      `backup durability for ${operation.path} is unknown`,
      error,
    );
  }
  if (!isOwnedBeforeLink(root, operation)) {
    throw fail(
      "mutation-outcome-unknown",
      `backup ownership for ${operation.path} cannot be proven`,
    );
  }
}

function vacateOwnedTarget(
  root: string,
  operation: ResolvedOperation,
  operationIndex: number,
  assertLock: () => void,
  hook: ArtifactTransactionInput["interruptionHook"],
): void {
  if (
    operation.expectedBeforeSha256 === null ||
    operation.backupAbsolute === null
  ) {
    return;
  }
  if (!isOwnedBeforeLink(root, operation)) {
    let targetAbsent = false;
    try {
      lstatSync(operation.absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      targetAbsent = true;
    }
    if (targetAbsent) {
      readOwnedArtifact(
        root,
        operation.backupAbsolute,
        operation.expectedBeforeSha256,
        `backup for ${operation.path}`,
      );
      return;
    }
    throw fail(
      "concurrent-drift",
      `target ${operation.path} is not the transaction-owned preimage`,
    );
  }
  hook?.({
    phase: "after-final-cas",
    operationIndex,
    path: operation.path,
  });
  revalidateAncestors(root, operation.ancestors);
  if (!isOwnedBeforeLink(root, operation)) {
    throw fail(
      "concurrent-drift",
      `target ${operation.path} changed after final CAS proof`,
    );
  }
  assertLock();
  revalidateAncestors(root, operation.ancestors);
  if (!isOwnedBeforeLink(root, operation)) {
    throw fail(
      "concurrent-drift",
      `target ${operation.path} changed immediately before move-aside`,
    );
  }
  try {
    unlinkSync(operation.absolute);
  } catch (error) {
    throw fail(
      "mutation-outcome-unknown",
      `move-aside outcome for ${operation.path} is unknown`,
      error,
    );
  }
  try {
    fsyncDirectory(operation.parent);
  } catch (error) {
    throw fail(
      "durability-failed",
      `move-aside durability for ${operation.path} is unknown`,
      error,
    );
  }
  readOwnedArtifact(
    root,
    operation.backupAbsolute,
    operation.expectedBeforeSha256,
    `backup for ${operation.path}`,
  );
}

function installCandidate(
  root: string,
  operation: ResolvedOperation,
  operationIndex: number,
  assertLock: () => void,
  hook: ArtifactTransactionInput["interruptionHook"],
): void {
  if (
    operation.desiredSha256 === null ||
    operation.candidateAbsolute === null
  ) {
    return;
  }
  if (isOwnedAfterLink(root, operation)) return;
  const observed = readTarget(root, operation);
  if (observed !== null) {
    throw fail(
      "concurrent-drift",
      `target ${operation.path} appeared before exclusive install`,
    );
  }
  readOwnedArtifact(
    root,
    operation.candidateAbsolute,
    operation.desiredSha256,
    `candidate for ${operation.path}`,
  );
  assertLock();
  revalidateAncestors(root, operation.ancestors);
  if (readTarget(root, operation) !== null) {
    throw fail(
      "concurrent-drift",
      `target ${operation.path} appeared immediately before exclusive install`,
    );
  }
  try {
    linkSync(operation.candidateAbsolute, operation.absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw fail(
        "concurrent-drift",
        `target ${operation.path} appeared during exclusive install`,
        error,
      );
    }
    throw fail(
      "mutation-outcome-unknown",
      `exclusive install outcome for ${operation.path} is unknown`,
      error,
    );
  }
  hook?.({
    phase: "after-exclusive-create-link",
    operationIndex,
    path: operation.path,
  });
  if (!isOwnedAfterLink(root, operation)) {
    throw fail(
      "mutation-outcome-unknown",
      `exclusive install ownership for ${operation.path} cannot be proven`,
    );
  }
  fsyncFinalFile(root, operation, 2);
  try {
    fsyncDirectory(operation.parent);
  } catch (error) {
    throw fail(
      "durability-failed",
      `exclusive install durability for ${operation.path} is unknown`,
      error,
    );
  }
}

function applyOperation(
  root: string,
  operation: ResolvedOperation,
  operationIndex: number,
  assertLock: () => void,
  hook: ArtifactTransactionInput["interruptionHook"],
): void {
  hook?.({
    phase: "before-operation-cas",
    operationIndex,
    path: operation.path,
  });
  assertLock();
  revalidateAncestors(root, operation.ancestors);
  if (operation.desiredSha256 !== null && isOwnedAfterLink(root, operation)) {
    hook?.({
      phase: "after-operation-mutation",
      operationIndex,
      path: operation.path,
    });
    hook?.({
      phase: "after-operation-verified",
      operationIndex,
      path: operation.path,
    });
    return;
  }
  vacateOwnedTarget(root, operation, operationIndex, assertLock, hook);
  installCandidate(root, operation, operationIndex, assertLock, hook);
  hook?.({
    phase: "after-operation-mutation",
    operationIndex,
    path: operation.path,
  });
  const ownerProven =
    operation.desiredSha256 === null
      ? operation.backupAbsolute !== null &&
        optionalFileIdentity(operation.absolute, `target ${operation.path}`) ===
          null
      : isOwnedAfterLink(root, operation);
  if (!ownerProven) {
    throw fail(
      "post-write-verification-failed",
      `final ${operation.path} is not in the desired state`,
    );
  }
  hook?.({
    phase: "after-operation-verified",
    operationIndex,
    path: operation.path,
  });
}

function exactSingleLinkIdentity(
  root: string,
  path: string,
  expectedSha256: string,
  label: string,
): Identity {
  const artifact = readSafeFile(root, path, label);
  if (artifact.hash !== expectedSha256) {
    throw fail("candidate-invalid", `${label} has the wrong hash`);
  }
  return artifact.identity;
}

function buildPreparedJournal(
  root: string,
  journal: TransactionJournal,
  operations: readonly ResolvedOperation[],
): TransactionJournal {
  return {
    ...journal,
    operations: operations.map((operation, index) => {
      let candidateDevIno: string | null = null;
      let backupDevIno: string | null = null;
      if (
        operation.desiredSha256 !== null &&
        operation.candidateAbsolute !== null
      ) {
        candidateDevIno = exactSingleLinkIdentity(
          root,
          operation.candidateAbsolute,
          operation.desiredSha256,
          `candidate for ${operation.path}`,
        ).devIno;
      }
      if (operation.expectedBeforeSha256 !== null) {
        if (
          operation.backupAbsolute === null ||
          !isOwnedBeforeLink(root, operation)
        ) {
          throw fail(
            "candidate-invalid",
            `backup for ${operation.path} is not linked to its preimage`,
          );
        }
        backupDevIno = identity(lstatSync(operation.backupAbsolute));
      }
      return {
        ...journal.operations[index]!,
        backupDevIno,
        candidateDevIno,
      };
    }),
    phase: "prepared",
    receipt: null,
  };
}

function validatePreparedArtifacts(
  root: string,
  journal: TransactionJournal,
  operations: readonly ResolvedOperation[],
): void {
  for (const [index, operation] of operations.entries()) {
    const journalOperation = journal.operations[index]!;
    if (
      operation.desiredSha256 !== null &&
      operation.candidateAbsolute !== null
    ) {
      const candidateDevIno = journalOperation.candidateDevIno;
      if (candidateDevIno === null) {
        throw fail(
          "journal-malformed",
          `candidate identity for ${operation.path} is missing`,
        );
      }
      if (isOwnedAfterLink(root, operation)) {
        if (
          identity(lstatSync(operation.candidateAbsolute)) !== candidateDevIno
        ) {
          throw fail(
            "candidate-invalid",
            `linked candidate for ${operation.path} changed identity`,
          );
        }
      } else if (
        exactSingleLinkIdentity(
          root,
          operation.candidateAbsolute,
          operation.desiredSha256,
          `candidate for ${operation.path}`,
        ).devIno !== candidateDevIno
      ) {
        throw fail(
          "candidate-invalid",
          `candidate for ${operation.path} changed identity`,
        );
      }
    }
    if (
      operation.expectedBeforeSha256 !== null &&
      operation.backupAbsolute !== null
    ) {
      const backupDevIno = journalOperation.backupDevIno;
      if (backupDevIno === null) {
        throw fail(
          "journal-malformed",
          `backup identity for ${operation.path} is missing`,
        );
      }
      if (isOwnedBeforeLink(root, operation)) {
        if (identity(lstatSync(operation.backupAbsolute)) !== backupDevIno) {
          throw fail(
            "candidate-invalid",
            `linked backup for ${operation.path} changed identity`,
          );
        }
      } else {
        let targetAbsent = false;
        try {
          lstatSync(operation.absolute);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          targetAbsent = true;
        }
        if (!targetAbsent && !isOwnedAfterLink(root, operation)) {
          throw fail(
            "concurrent-drift",
            `target ${operation.path} no longer matches its prepared ownership`,
          );
        }
        if (
          exactSingleLinkIdentity(
            root,
            operation.backupAbsolute,
            operation.expectedBeforeSha256,
            `backup for ${operation.path}`,
          ).devIno !== backupDevIno
        ) {
          throw fail(
            "candidate-invalid",
            `backup for ${operation.path} changed identity`,
          );
        }
      }
    }
  }
}

function buildFinalizingJournal(
  root: string,
  journal: TransactionJournal,
  operations: readonly ResolvedOperation[],
): TransactionJournal {
  const journalOperations = operations.map((operation, index) => {
    let candidateDevIno: string | null = null;
    let backupDevIno: string | null = null;
    if (operation.desiredSha256 !== null) {
      if (
        operation.candidateAbsolute === null ||
        !isOwnedAfterLink(root, operation)
      ) {
        throw fail(
          "post-write-verification-failed",
          `final ${operation.path} is not an owned candidate link`,
        );
      }
      candidateDevIno = identity(lstatSync(operation.candidateAbsolute));
    } else if (readTarget(root, operation) !== null) {
      throw fail(
        "post-write-verification-failed",
        `deleted target ${operation.path} is still present`,
      );
    }
    if (operation.expectedBeforeSha256 !== null) {
      if (operation.backupAbsolute === null) {
        throw fail(
          "journal-malformed",
          `backup path for ${operation.path} is missing`,
        );
      }
      backupDevIno = exactSingleLinkIdentity(
        root,
        operation.backupAbsolute,
        operation.expectedBeforeSha256,
        `backup for ${operation.path}`,
      ).devIno;
    }
    const previous = journal.operations[index]!;
    if (
      journal.phase === "prepared" &&
      (previous.candidateDevIno !== candidateDevIno ||
        previous.backupDevIno !== backupDevIno)
    ) {
      throw fail(
        "candidate-invalid",
        `ownership identity for ${operation.path} changed during mutation`,
      );
    }
    return {
      ...previous,
      backupDevIno,
      candidateDevIno,
    };
  });
  return {
    ...journal,
    operations: journalOperations,
    phase: "finalizing",
    receipt: null,
  };
}

function unlinkProvenArtifact(
  root: string,
  operation: ResolvedOperation,
  path: string,
  expectedSha256: string,
  expectedDevIno: string,
  label: string,
  assertLock: () => void,
): void {
  const observed = exactSingleLinkIdentity(root, path, expectedSha256, label);
  if (observed.devIno !== expectedDevIno) {
    throw fail(
      "candidate-invalid",
      `${label} no longer has its journaled identity`,
    );
  }
  assertLock();
  revalidateAncestors(root, operation.ancestors);
  const immediate = exactSingleLinkIdentity(root, path, expectedSha256, label);
  if (immediate.devIno !== expectedDevIno) {
    throw fail(
      "candidate-invalid",
      `${label} changed immediately before cleanup`,
    );
  }
  try {
    unlinkSync(path);
  } catch (error) {
    throw fail(
      "mutation-outcome-unknown",
      `${label} cleanup outcome is unknown`,
      error,
    );
  }
  try {
    fsyncDirectory(operation.parent);
  } catch (error) {
    throw fail(
      "durability-failed",
      `${label} cleanup durability is unknown`,
      error,
    );
  }
}

function cleanupOwnedArtifacts(
  root: string,
  operations: readonly ResolvedOperation[],
  journal: TransactionJournal,
  assertLock: () => void,
): void {
  for (const [index, operation] of operations.entries()) {
    const journalOperation = journal.operations[index]!;
    if (
      operation.desiredSha256 !== null &&
      operation.candidateAbsolute !== null
    ) {
      let candidateStat: Stats | null;
      try {
        candidateStat = lstatSync(operation.candidateAbsolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        candidateStat = null;
      }
      if (candidateStat !== null) {
        if (
          journalOperation.candidateDevIno === null ||
          !isOwnedAfterLink(root, operation) ||
          identity(candidateStat) !== journalOperation.candidateDevIno
        ) {
          throw fail(
            "candidate-invalid",
            `candidate for ${operation.path} cannot be proven owned`,
          );
        }
        assertLock();
        revalidateAncestors(root, operation.ancestors);
        if (
          !isOwnedAfterLink(root, operation) ||
          identity(lstatSync(operation.candidateAbsolute)) !==
            journalOperation.candidateDevIno
        ) {
          throw fail(
            "candidate-invalid",
            `candidate for ${operation.path} changed immediately before cleanup`,
          );
        }
        try {
          unlinkSync(operation.candidateAbsolute);
        } catch (error) {
          throw fail(
            "mutation-outcome-unknown",
            `candidate cleanup outcome for ${operation.path} is unknown`,
            error,
          );
        }
        try {
          fsyncDirectory(operation.parent);
        } catch (error) {
          throw fail(
            "durability-failed",
            `candidate cleanup durability for ${operation.path} is unknown`,
            error,
          );
        }
      }
      const final = exactSingleLinkIdentity(
        root,
        operation.absolute,
        operation.desiredSha256,
        `final ${operation.path}`,
      );
      if (final.devIno !== journalOperation.candidateDevIno) {
        throw fail(
          "post-write-verification-failed",
          `final ${operation.path} lost its journaled identity`,
        );
      }
    }
    if (
      operation.expectedBeforeSha256 !== null &&
      operation.backupAbsolute !== null
    ) {
      const backupIdentity = optionalFileIdentity(
        operation.backupAbsolute,
        `backup for ${operation.path}`,
      );
      if (backupIdentity !== null) {
        if (journalOperation.backupDevIno === null) {
          throw fail(
            "candidate-invalid",
            `backup for ${operation.path} lacks a journaled identity`,
          );
        }
        unlinkProvenArtifact(
          root,
          operation,
          operation.backupAbsolute,
          operation.expectedBeforeSha256,
          journalOperation.backupDevIno,
          `backup for ${operation.path}`,
          assertLock,
        );
      }
    }
  }
}

function verifyFinalStates(
  root: string,
  operations: readonly ResolvedOperation[],
): void {
  for (const operation of operations) {
    let state: TargetState;
    try {
      state = targetState(root, operation);
    } catch (error) {
      throw fail(
        "post-write-verification-failed",
        `final ${operation.path} failed transaction verification`,
        error,
      );
    }
    if (state !== "after") {
      throw fail(
        "post-write-verification-failed",
        `final ${operation.path} is not in the desired state`,
      );
    }
  }
}

function removeJournal(
  journalPath: string,
  parent: string,
  expected: TransactionJournal,
  state: JournalState,
  assertLock: () => void,
): void {
  const immediate = readJournalFile(journalPath);
  if (
    immediate.identity.devIno !== state.identity.devIno ||
    immediate.identity.realpath !== state.identity.realpath ||
    !sameJournal(immediate.journal, expected)
  ) {
    throw fail(
      "journal-removal-failed",
      "transaction journal changed before cleanup",
    );
  }
  assertLock();
  const final = readJournalFile(journalPath);
  if (
    final.identity.devIno !== state.identity.devIno ||
    final.identity.realpath !== state.identity.realpath ||
    !sameJournal(final.journal, expected)
  ) {
    throw fail(
      "journal-removal-failed",
      "transaction journal changed immediately before cleanup",
    );
  }
  try {
    unlinkSync(journalPath);
  } catch (error) {
    throw fail(
      "journal-removal-failed",
      "transaction journal removal outcome is unknown",
      error,
    );
  }
  try {
    fsyncDirectory(parent);
  } catch (error) {
    throw fail(
      "durability-failed",
      "transaction journal removal durability is unknown",
      error,
    );
  }
}

export function applyArtifactTransaction(
  input: ArtifactTransactionInput,
): ArtifactTransactionReceipt {
  if (!isRecord(input)) {
    throw fail("invalid-input", "transaction input must be an object");
  }
  if (
    typeof input.authorizationDigest !== "string" ||
    !SHA256_PATTERN.test(input.authorizationDigest)
  ) {
    throw fail("invalid-input", "authorizationDigest must be a SHA-256 digest");
  }
  const root = resolveRoot(input.root);
  const controlParent = validateControlPaths(
    root.path,
    input.lockPath,
    input.journalPath,
  );
  const normalized = normalizeOperations(input.operations);
  const expectedJournal = buildJournal(
    root.identity,
    normalized,
    input.authorizationDigest,
  );
  const lock = acquireCoordinatorLock(
    input.lockPath,
    controlParent,
    input.processLockOptions,
  );
  const assertLock = (): void => revalidateCoordinatorLock(lock);

  let result: ArtifactTransactionReceipt | undefined;
  let operationError: unknown;
  try {
    assertLock();
    const journalCandidatePath = `${input.journalPath}.candidate`;
    const pendingJournal =
      optionalFileIdentity(input.journalPath, "transaction journal") !== null;
    const pendingJournalCandidate =
      optionalFileIdentity(
        journalCandidatePath,
        "transaction journal candidate",
      ) !== null;
    let operations: ResolvedOperation[] | undefined;
    if (!pendingJournal && !pendingJournalCandidate) {
      operations = resolveOperations(root.path, normalized, expectedJournal);
      const initialStates = operations.map((operation) =>
        targetState(root.path, operation),
      );
      if (initialStates.every((state) => state === "after")) {
        result = receipt(expectedJournal, true);
      } else {
        for (const [index, operation] of operations.entries()) {
          if (initialStates[index] !== "before") {
            throw fail(
              "concurrent-drift",
              `target ${operation.path} does not match the initial precondition`,
            );
          }
        }
      }
    }
    if (result === undefined) {
      const loaded = loadOrCreateJournal(
        input.journalPath,
        controlParent,
        expectedJournal,
        assertLock,
      );
      validatePhaseJournal(loaded.state.journal);
      input.interruptionHook?.({
        phase: "journal-durable",
        operationIndex: null,
        path: null,
      });
      assertLock();
      operations ??= resolveOperations(
        root.path,
        normalized,
        loaded.state.journal,
      );
      let journalState = loaded.state;

      if (journalState.journal.phase === "applying") {
        for (const [index, operation] of operations.entries()) {
          ensureCandidate(
            root.path,
            operation,
            index,
            assertLock,
            input.interruptionHook,
          );
          ensureBackup(root.path, operation, assertLock);
        }
        const prepared = buildPreparedJournal(
          root.path,
          journalState.journal,
          operations,
        );
        journalState = transitionJournal(
          input.journalPath,
          controlParent,
          journalState,
          prepared,
          assertLock,
        );
        input.interruptionHook?.({
          phase: "prepared-journal-durable",
          operationIndex: null,
          path: null,
        });
      }

      if (journalState.journal.phase === "prepared") {
        validatePreparedArtifacts(root.path, journalState.journal, operations);
        for (const [index, operation] of operations.entries()) {
          assertLock();
          applyOperation(
            root.path,
            operation,
            index,
            assertLock,
            input.interruptionHook,
          );
        }
        assertLock();
        const finalizing = buildFinalizingJournal(
          root.path,
          journalState.journal,
          operations,
        );
        journalState = transitionJournal(
          input.journalPath,
          controlParent,
          journalState,
          finalizing,
          assertLock,
        );
        input.interruptionHook?.({
          phase: "finalizing-journal-durable",
          operationIndex: null,
          path: null,
        });
      }

      if (journalState.journal.phase === "finalizing") {
        cleanupOwnedArtifacts(
          root.path,
          operations,
          journalState.journal,
          assertLock,
        );
        assertLock();
        verifyFinalStates(root.path, operations);
        const committed: TransactionJournal = {
          ...journalState.journal,
          phase: "committed",
          receipt: receiptBody(journalState.journal),
        };
        journalState = transitionJournal(
          input.journalPath,
          controlParent,
          journalState,
          committed,
          assertLock,
        );
        input.interruptionHook?.({
          phase: "committed-journal-durable",
          operationIndex: null,
          path: null,
        });
      }

      validatePhaseJournal(journalState.journal);
      verifyFinalStates(root.path, operations);
      input.interruptionHook?.({
        phase: "before-journal-remove",
        operationIndex: null,
        path: null,
      });
      assertLock();
      verifyFinalStates(root.path, operations);
      removeJournal(
        input.journalPath,
        controlParent,
        journalState.journal,
        journalState,
        assertLock,
      );
      result = receipt(journalState.journal, loaded.recovered);
    }
  } catch (error) {
    const journalExists =
      optionalFileIdentity(input.journalPath, "transaction journal") !== null;
    operationError = journalExists
      ? withRecoveryPacket(error, expectedJournal, input.journalPath)
      : error;
  }

  let releaseError: unknown;
  try {
    releaseCoordinatorLock(lock);
  } catch (error) {
    releaseError = error;
  }
  if (operationError !== undefined) {
    if (
      releaseError instanceof ArtifactTransactionError &&
      releaseError.code === "lock-identity-changed"
    ) {
      throw releaseError;
    }
    throw operationError;
  }
  if (releaseError !== undefined) throw releaseError;
  return result!;
}

export function recoverArtifactTransaction(
  input: RecoverArtifactTransactionInput,
): ArtifactTransactionReceipt {
  if (
    !isRecord(input) ||
    typeof input.authorizationDigest !== "string" ||
    !SHA256_PATTERN.test(input.authorizationDigest) ||
    !Array.isArray(input.expectedOperationPaths) ||
    input.expectedOperationPaths.length === 0 ||
    input.expectedOperationPaths.length > MAX_OPERATIONS
  ) {
    throw fail(
      "invalid-input",
      "recovery input or transaction binding is invalid",
    );
  }
  const expectedPaths = input.expectedOperationPaths.map((path, index) => {
    safeRelativePath(path, `expectedOperationPaths[${index}]`);
    return path;
  });
  if (new Set(expectedPaths).size !== expectedPaths.length) {
    throw fail("invalid-input", "recovery operation paths must be unique");
  }
  expectedPaths.sort(compareUtf8);

  const root = resolveRoot(input.root);
  const controlParent = validateControlPaths(
    root.path,
    input.lockPath,
    input.journalPath,
  );
  const lock = acquireCoordinatorLock(
    input.lockPath,
    controlParent,
    input.processLockOptions,
  );
  const assertLock = (): void => revalidateCoordinatorLock(lock);

  let result: ArtifactTransactionReceipt | undefined;
  let operationError: unknown;
  let boundJournal: TransactionJournal | undefined;
  try {
    assertLock();
    const journalIdentity = optionalFileIdentity(
      input.journalPath,
      "transaction journal",
    );
    const stagePath = `${input.journalPath}.candidate`;
    const stageIdentity = optionalFileIdentity(
      stagePath,
      "transaction journal candidate",
    );
    if (journalIdentity === null && stageIdentity === null) {
      throw fail(
        "journal-state-conflict",
        "no transaction journal is available",
      );
    }
    const initial = readJournalFile(
      journalIdentity === null ? stagePath : input.journalPath,
    );
    boundJournal = initial.journal;
    const journalPaths = boundJournal.operations
      .map((operation) => operation.path)
      .sort(compareUtf8);
    if (
      boundJournal.authorizationDigest !== input.authorizationDigest ||
      canonicalJson(journalPaths) !== canonicalJson(expectedPaths) ||
      boundJournal.root.devIno !== root.identity.devIno ||
      boundJournal.root.realpath !== root.identity.realpath
    ) {
      throw fail(
        "pending-journal-mismatch",
        "pending journal does not match the explicit recovery binding",
      );
    }

    const loaded = loadOrCreateJournal(
      input.journalPath,
      controlParent,
      boundJournal,
      assertLock,
    );
    boundJournal = loaded.state.journal;
    validatePhaseJournal(boundJournal);
    const normalized: NormalizedOperation[] = boundJournal.operations.map(
      (operation) => ({
        path: operation.path,
        expectedBeforeSha256: operation.beforeSha256,
        desiredText: operation.afterSha256 === null ? null : "",
        desiredSha256: operation.afterSha256,
      }),
    );
    const operations = resolveOperations(root.path, normalized, boundJournal);
    let journalState = loaded.state;

    if (journalState.journal.phase === "applying") {
      throw fail(
        "concurrent-drift",
        "applying journal has no durable ownership proof; exact-input retry is required",
      );
    }
    if (journalState.journal.phase === "prepared") {
      validatePreparedArtifacts(root.path, journalState.journal, operations);
      for (const [index, operation] of operations.entries()) {
        applyOperation(
          root.path,
          operation,
          index,
          assertLock,
          input.interruptionHook,
        );
      }
      const finalizing = buildFinalizingJournal(
        root.path,
        journalState.journal,
        operations,
      );
      journalState = transitionJournal(
        input.journalPath,
        controlParent,
        journalState,
        finalizing,
        assertLock,
      );
      boundJournal = journalState.journal;
      input.interruptionHook?.({
        phase: "finalizing-journal-durable",
        operationIndex: null,
        path: null,
      });
    }
    if (journalState.journal.phase === "finalizing") {
      cleanupOwnedArtifacts(
        root.path,
        operations,
        journalState.journal,
        assertLock,
      );
      verifyFinalStates(root.path, operations);
      const committed: TransactionJournal = {
        ...journalState.journal,
        phase: "committed",
        receipt: receiptBody(journalState.journal),
      };
      journalState = transitionJournal(
        input.journalPath,
        controlParent,
        journalState,
        committed,
        assertLock,
      );
      boundJournal = journalState.journal;
      input.interruptionHook?.({
        phase: "committed-journal-durable",
        operationIndex: null,
        path: null,
      });
    }
    validatePhaseJournal(journalState.journal);
    verifyFinalStates(root.path, operations);
    input.interruptionHook?.({
      phase: "before-journal-remove",
      operationIndex: null,
      path: null,
    });
    assertLock();
    verifyFinalStates(root.path, operations);
    removeJournal(
      input.journalPath,
      controlParent,
      journalState.journal,
      journalState,
      assertLock,
    );
    result = receipt(journalState.journal, true);
  } catch (error) {
    operationError =
      boundJournal === undefined
        ? error
        : withRecoveryPacket(error, boundJournal, input.journalPath);
  }

  let releaseError: unknown;
  try {
    releaseCoordinatorLock(lock);
  } catch (error) {
    releaseError = error;
  }
  if (operationError !== undefined) {
    if (
      releaseError instanceof ArtifactTransactionError &&
      releaseError.code === "lock-identity-changed"
    ) {
      throw releaseError;
    }
    throw operationError;
  }
  if (releaseError !== undefined) throw releaseError;
  return result!;
}
