import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ArtifactTransactionError,
  ARTIFACT_TRANSACTION_CONCURRENCY_BOUNDARY,
  applyArtifactTransaction,
  recoverArtifactTransaction,
  type ArtifactTransactionHookEvent,
  type ArtifactTransactionInput,
  type ArtifactTransactionOperation,
} from "../../scripts/lib/open-issue-triage/artifact-transaction.ts";
import {
  acquireProcessLock,
  releaseProcessLock,
} from "../../src/lib/process-lock.ts";
import { createHash } from "node:crypto";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface MutableJournalFixture {
  root: { devIno: string };
  operations: Array<{ afterSha256: string | null }>;
}

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ArtifactTransactionError);
    expect((error as ArtifactTransactionError).code).toBe(code);
  }
}

function expectWrappedInterruption(
  operation: () => unknown,
  cause?: unknown,
): void {
  try {
    operation();
    throw new Error("expected wrapped interruption");
  } catch (error) {
    expect(error).toBeInstanceOf(ArtifactTransactionError);
    const transactionError = error as ArtifactTransactionError;
    expect(transactionError.code).toBe("mutation-outcome-unknown");
    expect(transactionError.recoveryPacket).toEqual({
      transactionId: expect.stringMatching(/^[0-9a-f]{64}$/),
      journalPath,
      paths: expect.any(Array),
    });
    if (cause !== undefined) expect(transactionError.cause).toBe(cause);
  }
}

let sandbox: string;
let root: string;
let commonDir: string;
let lockPath: string;
let journalPath: string;

beforeEach(() => {
  sandbox = realpathSync(
    mkdtempSync(join(tmpdir(), "whatsoup-artifact-transaction-")),
  );
  root = join(sandbox, "repository");
  commonDir = join(sandbox, "git-common");
  mkdirSync(root);
  mkdirSync(commonDir);
  lockPath = join(commonDir, "artifact.lock");
  journalPath = join(commonDir, "artifact.journal.json");
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function input(
  operations: readonly ArtifactTransactionOperation[],
  overrides: Partial<ArtifactTransactionInput> = {},
): ArtifactTransactionInput {
  return {
    root,
    lockPath,
    journalPath,
    authorizationDigest: "b".repeat(64),
    operations,
    ...overrides,
  };
}

function candidateNames(directory: string): string[] {
  return readdirSync(directory).filter((name) =>
    name.includes(".artifact-transaction-"),
  );
}

describe("recoverable open-issue artifact transaction", () => {
  it("publishes the cooperative-writer boundary explicitly", () => {
    expect(ARTIFACT_TRANSACTION_CONCURRENCY_BOUNDARY).toBe(
      "cooperative-path-writers-only",
    );
  });

  it("commits multiple replacements and returns a bounded body-free receipt", () => {
    writeFileSync(join(root, "first.txt"), "first-before\n");
    writeFileSync(join(root, "second.txt"), "second-before\n");
    const operations = [
      {
        path: "first.txt",
        expectedBeforeSha256: sha256("first-before\n"),
        desiredText: "first-after\n",
      },
      {
        path: "second.txt",
        expectedBeforeSha256: sha256("second-before\n"),
        desiredText: "second-after\n",
      },
    ];

    const receipt = applyArtifactTransaction(input(operations));

    expect(readFileSync(join(root, "first.txt"), "utf8")).toBe("first-after\n");
    expect(readFileSync(join(root, "second.txt"), "utf8")).toBe(
      "second-after\n",
    );
    expect(receipt).toEqual({
      schemaVersion: 1,
      transactionId: expect.stringMatching(/^[0-9a-f]{64}$/),
      recovered: false,
      operationCount: 2,
      replacementCount: 2,
      createCount: 0,
      deleteCount: 0,
    });
    expect(JSON.stringify(receipt)).not.toContain("first-after");
    expect(existsSync(journalPath)).toBe(false);
    expect(candidateNames(root)).toEqual([]);
  });

  it("rolls forward after interruption following the first rename", () => {
    writeFileSync(join(root, "first.txt"), "first-before\n");
    writeFileSync(join(root, "second.txt"), "second-before\n");
    const operations = [
      {
        path: "first.txt",
        expectedBeforeSha256: sha256("first-before\n"),
        desiredText: "first-after\n",
      },
      {
        path: "second.txt",
        expectedBeforeSha256: sha256("second-before\n"),
        desiredText: "second-after\n",
      },
    ];
    const interruption = new Error("simulated interruption");

    expectWrappedInterruption(
      () =>
        applyArtifactTransaction(
          input(operations, {
            interruptionHook: (event) => {
              if (
                event.phase === "after-operation-mutation" &&
                event.operationIndex === 0
              ) {
                throw interruption;
              }
            },
          }),
        ),
      interruption,
    );
    expect(readFileSync(join(root, "first.txt"), "utf8")).toBe("first-after\n");
    expect(readFileSync(join(root, "second.txt"), "utf8")).toBe(
      "second-before\n",
    );
    expect(existsSync(journalPath)).toBe(true);

    const receipt = applyArtifactTransaction(input(operations));

    expect(receipt.recovered).toBe(true);
    expect(readFileSync(join(root, "first.txt"), "utf8")).toBe("first-after\n");
    expect(readFileSync(join(root, "second.txt"), "utf8")).toBe(
      "second-after\n",
    );
    expect(existsSync(journalPath)).toBe(false);
    expect(candidateNames(root)).toEqual([]);
  });

  it("refuses concurrent drift at the immediate pre-replace CAS", () => {
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested/target.txt"), "before\n");
    const operations = [
      {
        path: "nested/target.txt",
        expectedBeforeSha256: sha256("before\n"),
        desiredText: "after\n",
      },
    ];

    expectCode(
      () =>
        applyArtifactTransaction(
          input(operations, {
            interruptionHook: (event) => {
              if (event.phase === "before-operation-cas") {
                writeFileSync(join(root, "nested/target.txt"), "concurrent\n");
              }
            },
          }),
        ),
      "concurrent-drift",
    );

    expect(readFileSync(join(root, "nested/target.txt"), "utf8")).toBe(
      "concurrent\n",
    );
    expect(existsSync(journalPath)).toBe(true);
    expect(candidateNames(root)).toEqual([]);
    expect(candidateNames(join(root, "nested"))).toHaveLength(2);
  });

  it.each(["replace", "delete"] as const)(
    "never clobbers a noncooperating writer after the final %s CAS proof",
    (kind) => {
      writeFileSync(join(root, "target.txt"), "before\n");
      const operation = {
        path: "target.txt",
        expectedBeforeSha256: sha256("before\n"),
        desiredText: kind === "replace" ? "after\n" : null,
      };

      expectCode(
        () =>
          applyArtifactTransaction(
            input([operation], {
              interruptionHook: (event) => {
                if ((event.phase as string) !== "after-final-cas") return;
                unlinkSync(join(root, "target.txt"));
                writeFileSync(join(root, "target.txt"), "concurrent\n", {
                  flag: "wx",
                });
              },
            }),
          ),
        "concurrent-drift",
      );

      expect(readFileSync(join(root, "target.txt"), "utf8")).toBe(
        "concurrent\n",
      );
      expect(existsSync(journalPath)).toBe(true);
    },
  );

  it("fails closed when an operation parent changes after final CAS proof", () => {
    mkdirSync(join(root, "nested"));
    mkdirSync(join(sandbox, "outside"));
    writeFileSync(join(root, "nested/target.txt"), "before\n");
    writeFileSync(join(sandbox, "outside/target.txt"), "outside\n");

    expectCode(
      () =>
        applyArtifactTransaction(
          input(
            [
              {
                path: "nested/target.txt",
                expectedBeforeSha256: sha256("before\n"),
                desiredText: "after\n",
              },
            ],
            {
              interruptionHook: (event) => {
                if ((event.phase as string) !== "after-final-cas") return;
                renameSync(join(root, "nested"), join(root, "parked"));
                symlinkSync(
                  join(sandbox, "outside"),
                  join(root, "nested"),
                  "dir",
                );
              },
            },
          ),
        ),
      "unsafe-path",
    );

    expect(readFileSync(join(sandbox, "outside/target.txt"), "utf8")).toBe(
      "outside\n",
    );
    expect(readFileSync(join(root, "parked/target.txt"), "utf8")).toBe(
      "before\n",
    );
  });

  it.each([
    {
      name: "symlink target",
      prepare: () => {
        writeFileSync(join(sandbox, "outside.txt"), "outside\n");
        symlinkSync(join(sandbox, "outside.txt"), join(root, "target.txt"));
      },
      operation: () => ({
        path: "target.txt",
        expectedBeforeSha256: sha256("outside\n"),
        desiredText: "after\n",
      }),
    },
    {
      name: "hard-linked target",
      prepare: () => {
        writeFileSync(join(root, "target.txt"), "before\n");
        linkSync(join(root, "target.txt"), join(root, "alias.txt"));
      },
      operation: () => ({
        path: "target.txt",
        expectedBeforeSha256: sha256("before\n"),
        desiredText: "after\n",
      }),
    },
    {
      name: "repository path escape",
      prepare: () => undefined,
      operation: () => ({
        path: "../outside.txt",
        expectedBeforeSha256: null,
        desiredText: "after\n",
      }),
    },
  ])("rejects $name before journaling", ({ prepare, operation }) => {
    prepare();

    expectCode(
      () => applyArtifactTransaction(input([operation()])),
      "unsafe-path",
    );

    expect(existsSync(journalPath)).toBe(false);
  });

  it("commits an exclusive create and a delete in one transaction", () => {
    writeFileSync(join(root, "delete.txt"), "delete-before\n");
    const operations = [
      {
        path: "create.txt",
        expectedBeforeSha256: null,
        desiredText: "created\n",
      },
      {
        path: "delete.txt",
        expectedBeforeSha256: sha256("delete-before\n"),
        desiredText: null,
      },
    ];

    const receipt = applyArtifactTransaction(input(operations));

    expect(readFileSync(join(root, "create.txt"), "utf8")).toBe("created\n");
    expect(existsSync(join(root, "delete.txt"))).toBe(false);
    expect(receipt.createCount).toBe(1);
    expect(receipt.deleteCount).toBe(1);
    expect(receipt.replacementCount).toBe(0);
  });

  it("recovers the owner-proven linked state of an interrupted exclusive create", () => {
    const operations = [
      {
        path: "created.txt",
        expectedBeforeSha256: null,
        desiredText: "created\n",
      },
    ];
    const interruption = new Error("stop after exclusive create link");

    expectWrappedInterruption(() =>
      applyArtifactTransaction(
        input(operations, {
          interruptionHook: (event) => {
            if ((event.phase as string) === "after-exclusive-create-link") {
              throw interruption;
            }
          },
        }),
      ),
    );

    const candidates = candidateNames(root);
    expect(candidates).toHaveLength(1);
    expect(lstatSync(join(root, "created.txt")).nlink).toBe(2);
    expect(lstatSync(join(root, candidates[0]!)).nlink).toBe(2);
    expect(existsSync(journalPath)).toBe(true);

    const receipt = applyArtifactTransaction(input(operations));

    expect(receipt.recovered).toBe(true);
    expect(readFileSync(join(root, "created.txt"), "utf8")).toBe("created\n");
    expect(lstatSync(join(root, "created.txt")).nlink).toBe(1);
    expect(candidateNames(root)).toEqual([]);
    expect(existsSync(journalPath)).toBe(false);
  });

  it("fails closed on a malformed journal without touching targets", () => {
    writeFileSync(join(root, "target.txt"), "before\n");
    writeFileSync(journalPath, '{"schemaVersion":');

    expectCode(
      () =>
        applyArtifactTransaction(
          input([
            {
              path: "target.txt",
              expectedBeforeSha256: sha256("before\n"),
              desiredText: "after\n",
            },
          ]),
        ),
      "journal-malformed",
    );

    expect(readFileSync(join(root, "target.txt"), "utf8")).toBe("before\n");
    expect(readFileSync(journalPath, "utf8")).toBe('{"schemaVersion":');
  });

  it.each([
    {
      name: "root identity drift",
      expectedCode: "pending-journal-mismatch",
      mutate: (journal: MutableJournalFixture) => {
        journal.root.devIno = "different-root-identity";
      },
    },
    {
      name: "valid but unexpected after hash",
      expectedCode: "pending-journal-mismatch",
      mutate: (journal: MutableJournalFixture) => {
        journal.operations[0].afterSha256 = "a".repeat(64);
      },
    },
    {
      name: "malformed after hash",
      expectedCode: "journal-malformed",
      mutate: (journal: MutableJournalFixture) => {
        journal.operations[0].afterSha256 = "not-a-sha256";
      },
    },
  ])(
    "fails closed on $name in a pending journal",
    ({ expectedCode, mutate }) => {
      const operations = [
        {
          path: "created.txt",
          expectedBeforeSha256: null,
          desiredText: "created\n",
        },
      ];
      const interruption = new Error("stop after journal");
      expectWrappedInterruption(() =>
        applyArtifactTransaction(
          input(operations, {
            interruptionHook: (event) => {
              if (event.phase === "journal-durable") throw interruption;
            },
          }),
        ),
      );
      const journal = JSON.parse(
        readFileSync(journalPath, "utf8"),
      ) as MutableJournalFixture;
      mutate(journal);
      writeFileSync(journalPath, `${JSON.stringify(journal)}\n`);

      expectCode(
        () => applyArtifactTransaction(input(operations)),
        expectedCode,
      );

      expect(existsSync(join(root, "created.txt"))).toBe(false);
      expect(existsSync(journalPath)).toBe(true);
    },
  );

  it("preserves the journal when post-write hash verification fails", () => {
    writeFileSync(join(root, "target.txt"), "before\n");
    const operations = [
      {
        path: "target.txt",
        expectedBeforeSha256: sha256("before\n"),
        desiredText: "after\n",
      },
    ];

    expectCode(
      () =>
        applyArtifactTransaction(
          input(operations, {
            interruptionHook: (event) => {
              if (event.phase === "after-operation-mutation") {
                writeFileSync(
                  join(root, "target.txt"),
                  "corrupt-after-rename\n",
                );
              }
            },
          }),
        ),
      "post-write-verification-failed",
    );

    expect(readFileSync(join(root, "target.txt"), "utf8")).toBe(
      "corrupt-after-rename\n",
    );
    expect(existsSync(journalPath)).toBe(true);
  });

  it("rechecks every final state immediately before journal removal", () => {
    writeFileSync(join(root, "target.txt"), "before\n");

    expectCode(
      () =>
        applyArtifactTransaction(
          input(
            [
              {
                path: "target.txt",
                expectedBeforeSha256: sha256("before\n"),
                desiredText: "after\n",
              },
            ],
            {
              interruptionHook: (event) => {
                if (event.phase === "before-journal-remove") {
                  writeFileSync(
                    join(root, "target.txt"),
                    "late-concurrent-drift\n",
                  );
                }
              },
            },
          ),
        ),
      "post-write-verification-failed",
    );

    expect(readFileSync(join(root, "target.txt"), "utf8")).toBe(
      "late-concurrent-drift\n",
    );
    expect(existsSync(journalPath)).toBe(true);
  });

  it("recovers a committed receipt after interruption following journal fsync", () => {
    writeFileSync(join(root, "target.txt"), "before\n");
    const operations = [
      {
        path: "target.txt",
        expectedBeforeSha256: sha256("before\n"),
        desiredText: "after\n",
      },
    ];
    const interruption = new Error("stop after committed journal fsync");

    expectWrappedInterruption(() =>
      applyArtifactTransaction(
        input(operations, {
          interruptionHook: (event) => {
            if ((event.phase as string) === "committed-journal-durable") {
              throw interruption;
            }
          },
        }),
      ),
    );
    expect(readFileSync(join(root, "target.txt"), "utf8")).toBe("after\n");
    expect(existsSync(journalPath)).toBe(true);

    const receipt = applyArtifactTransaction(input(operations));

    expect(receipt.recovered).toBe(true);
    expect(readFileSync(join(root, "target.txt"), "utf8")).toBe("after\n");
    expect(existsSync(journalPath)).toBe(false);
  });

  it("recovers after interruption following finalizing journal fsync", () => {
    writeFileSync(join(root, "target.txt"), "before\n");
    const operations = [
      {
        path: "target.txt",
        expectedBeforeSha256: sha256("before\n"),
        desiredText: "after\n",
      },
    ];
    const interruption = new Error("stop after finalizing journal fsync");

    expectWrappedInterruption(() =>
      applyArtifactTransaction(
        input(operations, {
          interruptionHook: (event) => {
            if (event.phase === "finalizing-journal-durable")
              throw interruption;
          },
        }),
      ),
    );
    expect(existsSync(journalPath)).toBe(true);
    expect(lstatSync(join(root, "target.txt")).nlink).toBe(2);

    const receipt = applyArtifactTransaction(input(operations));

    expect(receipt.recovered).toBe(true);
    expect(readFileSync(join(root, "target.txt"), "utf8")).toBe("after\n");
    expect(lstatSync(join(root, "target.txt")).nlink).toBe(1);
    expect(existsSync(journalPath)).toBe(false);
  });

  it.each(["candidate", "backup"] as const)(
    "does not delete a same-hash noncooperating %s replacement during cleanup",
    (artifact) => {
      writeFileSync(join(root, "target.txt"), "before\n");
      let replacementPath = "";
      let ownedIdentity = "";
      let replacementIdentity = "";

      expectCode(
        () =>
          applyArtifactTransaction(
            input(
              [
                {
                  path: "target.txt",
                  expectedBeforeSha256: sha256("before\n"),
                  desiredText: "after\n",
                },
              ],
              {
                interruptionHook: (event) => {
                  if (event.phase !== "finalizing-journal-durable") return;
                  replacementPath = join(
                    root,
                    candidateNames(root).find((name) =>
                      name.endsWith(`.${artifact}`),
                    )!,
                  );
                  const ownedStat = lstatSync(replacementPath);
                  ownedIdentity = `${ownedStat.dev}:${ownedStat.ino}`;
                  const stagedReplacementPath = `${replacementPath}.replacement`;
                  writeFileSync(
                    stagedReplacementPath,
                    artifact === "candidate" ? "after\n" : "before\n",
                    { flag: "wx" },
                  );
                  const replacementStat = lstatSync(stagedReplacementPath);
                  replacementIdentity = `${replacementStat.dev}:${replacementStat.ino}`;
                  renameSync(stagedReplacementPath, replacementPath);
                },
              },
            ),
          ),
        "candidate-invalid",
      );

      expect(replacementIdentity).not.toBe(ownedIdentity);
      expect(existsSync(replacementPath)).toBe(true);
      expect(readFileSync(replacementPath, "utf8")).toBe(
        artifact === "candidate" ? "after\n" : "before\n",
      );
      expect(existsSync(journalPath)).toBe(true);
    },
  );

  it("recovers an owner-proven applying journal without reconstructing desired bytes", () => {
    writeFileSync(join(root, "target.txt"), "before\n");
    const operations = [
      {
        path: "target.txt",
        expectedBeforeSha256: sha256("before\n"),
        desiredText: "after\n",
      },
    ];
    const interruption = new Error("stop after owner proof");
    expectWrappedInterruption(() =>
      applyArtifactTransaction(
        input(operations, {
          interruptionHook: (event) => {
            if (event.phase === "after-operation-verified") throw interruption;
          },
        }),
      ),
    );
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      transactionId: string;
    };

    const receipt = recoverArtifactTransaction({
      root,
      lockPath,
      journalPath,
      authorizationDigest: "b".repeat(64),
      expectedOperationPaths: ["target.txt"],
    });

    expect(receipt.recovered).toBe(true);
    expect(receipt.transactionId).toBe(journal.transactionId);
    expect(readFileSync(join(root, "target.txt"), "utf8")).toBe("after\n");
    expect(existsSync(journalPath)).toBe(false);
    expect(candidateNames(root)).toEqual([]);
  });

  it("recovers a prepared pre-mutation journal without desired bytes", () => {
    writeFileSync(join(root, "target.txt"), "before\n");
    const interruption = new Error("stop after prepared journal");
    expectWrappedInterruption(() =>
      applyArtifactTransaction(
        input(
          [
            {
              path: "target.txt",
              expectedBeforeSha256: sha256("before\n"),
              desiredText: "after\n",
            },
          ],
          {
            interruptionHook: (event) => {
              if (event.phase === "prepared-journal-durable")
                throw interruption;
            },
          },
        ),
      ),
    );
    expect(readFileSync(join(root, "target.txt"), "utf8")).toBe("before\n");

    const receipt = recoverArtifactTransaction({
      root,
      lockPath,
      journalPath,
      authorizationDigest: "b".repeat(64),
      expectedOperationPaths: ["target.txt"],
    });

    expect(receipt.recovered).toBe(true);
    expect(readFileSync(join(root, "target.txt"), "utf8")).toBe("after\n");
    expect(existsSync(journalPath)).toBe(false);
  });

  it("returns a bounded packet when body-free recovery finds an unprepared journal", () => {
    const interruption = new Error("stop after applying journal");
    expectWrappedInterruption(() =>
      applyArtifactTransaction(
        input(
          [
            {
              path: "created.txt",
              expectedBeforeSha256: null,
              desiredText: "created\n",
            },
          ],
          {
            interruptionHook: (event) => {
              if (event.phase === "journal-durable") throw interruption;
            },
          },
        ),
      ),
    );

    try {
      recoverArtifactTransaction({
        root,
        lockPath,
        journalPath,
        authorizationDigest: "b".repeat(64),
        expectedOperationPaths: ["created.txt"],
      });
      throw new Error("expected bounded recovery failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ArtifactTransactionError);
      const transactionError = error as ArtifactTransactionError;
      expect(transactionError.code).toBe("concurrent-drift");
      expect(transactionError.recoveryPacket?.paths).toEqual(["created.txt"]);
    }
    expect(existsSync(join(root, "created.txt"))).toBe(false);
    expect(existsSync(journalPath)).toBe(true);
  });

  it("rejects a recovery binding mismatch without touching owner-proven artifacts", () => {
    const operations = [
      {
        path: "created.txt",
        expectedBeforeSha256: null,
        desiredText: "created\n",
      },
    ];
    const interruption = new Error("stop after owner proof");
    expectWrappedInterruption(() =>
      applyArtifactTransaction(
        input(operations, {
          interruptionHook: (event) => {
            if (event.phase === "after-operation-verified") throw interruption;
          },
        }),
      ),
    );
    const beforeJournal = readFileSync(journalPath, "utf8");

    expectCode(
      () =>
        recoverArtifactTransaction({
          root,
          lockPath,
          journalPath,
          authorizationDigest: "a".repeat(64),
          expectedOperationPaths: ["created.txt"],
        }),
      "pending-journal-mismatch",
    );

    expect(readFileSync(journalPath, "utf8")).toBe(beforeJournal);
    expect(readFileSync(join(root, "created.txt"), "utf8")).toBe("created\n");
    expect(lstatSync(join(root, "created.txt")).nlink).toBe(2);
  });

  it("returns a recovered receipt for an exact all-after retry without a journal", () => {
    writeFileSync(join(root, "target.txt"), "after\n");

    const receipt = applyArtifactTransaction(
      input([
        {
          path: "target.txt",
          expectedBeforeSha256: sha256("before\n"),
          desiredText: "after\n",
        },
      ]),
    );

    expect(receipt.recovered).toBe(true);
    expect(readFileSync(join(root, "target.txt"), "utf8")).toBe("after\n");
    expect(existsSync(journalPath)).toBe(false);
  });

  it("keeps desired bodies out of the durable journal", () => {
    const desiredText =
      "reserved-secret-looking-body-that-must-not-enter-journal\n";
    const interruption = new Error("stop after journal");

    expectWrappedInterruption(() =>
      applyArtifactTransaction(
        input(
          [
            {
              path: "created.txt",
              expectedBeforeSha256: null,
              desiredText,
            },
          ],
          {
            interruptionHook: (event) => {
              if (event.phase === "journal-durable") throw interruption;
            },
          },
        ),
      ),
    );

    const journal = readFileSync(journalPath, "utf8");
    expect(journal).not.toContain(desiredText.trim());
    expect(journal).not.toContain("desiredText");
    expect(journal).toContain(sha256(desiredText));
  });

  it("binds the transaction ID to the caller authorization digest", () => {
    const operations = [
      {
        path: "created.txt",
        expectedBeforeSha256: null,
        desiredText: "created\n",
      },
    ];
    const captureTransactionId = (authorizationDigest: string): string => {
      expectWrappedInterruption(() =>
        applyArtifactTransaction(
          input(operations, {
            authorizationDigest,
            interruptionHook: (event) => {
              if (event.phase === "journal-durable") {
                throw new Error("capture journal");
              }
            },
          }),
        ),
      );
      const transactionId = (
        JSON.parse(readFileSync(journalPath, "utf8")) as {
          transactionId: string;
        }
      ).transactionId;
      unlinkSync(journalPath);
      return transactionId;
    };

    expect(captureTransactionId("a".repeat(64))).not.toBe(
      captureTransactionId("b".repeat(64)),
    );
  });

  it("rejects a journal whose authorization digest changed without its transaction ID", () => {
    const operations = [
      {
        path: "created.txt",
        expectedBeforeSha256: null,
        desiredText: "created\n",
      },
    ];
    expectWrappedInterruption(() =>
      applyArtifactTransaction(
        input(operations, {
          interruptionHook: (event) => {
            if (event.phase === "journal-durable") throw new Error("stop");
          },
        }),
      ),
    );
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      authorizationDigest: string;
      transactionId: string;
    };
    journal.authorizationDigest = "a".repeat(64);
    writeFileSync(journalPath, `${JSON.stringify(journal)}\n`);

    expectCode(
      () =>
        recoverArtifactTransaction({
          root,
          lockPath,
          journalPath,
          authorizationDigest: "a".repeat(64),
          expectedOperationPaths: ["created.txt"],
        }),
      "journal-malformed",
    );

    expect(existsSync(join(root, "created.txt"))).toBe(false);
    expect(existsSync(journalPath)).toBe(true);
  });

  it("blocks unrelated writes while an exact-input recovery journal is pending", () => {
    const interrupted = [
      {
        path: "first.txt",
        expectedBeforeSha256: null,
        desiredText: "first\n",
      },
    ];
    const interruption = new Error("stop after journal");
    expectWrappedInterruption(() =>
      applyArtifactTransaction(
        input(interrupted, {
          interruptionHook: (event) => {
            if (event.phase === "journal-durable") throw interruption;
          },
        }),
      ),
    );

    expectCode(
      () =>
        applyArtifactTransaction(
          input([
            {
              path: "unrelated.txt",
              expectedBeforeSha256: null,
              desiredText: "unrelated\n",
            },
          ]),
        ),
      "pending-journal-mismatch",
    );

    expect(existsSync(join(root, "unrelated.txt"))).toBe(false);
    expect(existsSync(journalPath)).toBe(true);
  });

  it("returns a bounded recovery packet when exact recovery cannot prove ownership", () => {
    writeFileSync(join(root, "target.txt"), "before\n");
    const operations = [
      {
        path: "target.txt",
        expectedBeforeSha256: sha256("before\n"),
        desiredText: "after\n",
      },
    ];
    expectCode(
      () =>
        applyArtifactTransaction(
          input(operations, {
            interruptionHook: (event) => {
              if (event.phase === "before-operation-cas") {
                writeFileSync(join(root, "target.txt"), "concurrent\n");
              }
            },
          }),
        ),
      "concurrent-drift",
    );

    try {
      applyArtifactTransaction(input(operations));
      throw new Error("expected recovery failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ArtifactTransactionError);
      const transactionError = error as ArtifactTransactionError & {
        recoveryPacket?: {
          transactionId: string;
          journalPath: string;
          paths: string[];
        };
      };
      expect(transactionError.code).toBe("concurrent-drift");
      expect(transactionError.recoveryPacket).toEqual({
        transactionId: expect.stringMatching(/^[0-9a-f]{64}$/),
        journalPath,
        paths: ["target.txt"],
      });
      expect(JSON.stringify(transactionError.recoveryPacket)).not.toContain(
        "concurrent\n",
      );
    }
  });

  it.each([
    {
      name: "lock aliases journal stage",
      overrides: () => ({ lockPath: `${journalPath}.candidate` }),
      operationPath: "target.txt",
    },
    {
      name: "journal aliases the process-lock temporary namespace",
      overrides: () => ({ journalPath: `${lockPath}.123.token.tmp` }),
      operationPath: "target.txt",
    },
    {
      name: "control files live inside the repository",
      overrides: () => {
        mkdirSync(join(root, "control"));
        return {
          lockPath: join(root, "control/lock"),
          journalPath: join(root, "control/journal"),
        };
      },
      operationPath: "target.txt",
    },
    {
      name: "operation uses the reserved transaction namespace",
      overrides: () => ({}),
      operationPath: ".artifact-transaction-user-controlled",
    },
    {
      name: "operation case-folds to the reserved transaction namespace",
      overrides: () => ({}),
      operationPath: ".Artifact-Transaction-user-controlled",
    },
  ])(
    "rejects $name before acquiring a lock",
    ({ overrides, operationPath }) => {
      expectCode(
        () =>
          applyArtifactTransaction(
            input(
              [
                {
                  path: operationPath,
                  expectedBeforeSha256: null,
                  desiredText: "after\n",
                },
              ],
              overrides(),
            ),
          ),
        "unsafe-path",
      );
    },
  );

  it("refuses an active owner-bearing repository lock", () => {
    const handle = acquireProcessLock(lockPath);
    try {
      expectCode(
        () =>
          applyArtifactTransaction(
            input([
              {
                path: "created.txt",
                expectedBeforeSha256: null,
                desiredText: "created\n",
              },
            ]),
          ),
        "lock-unavailable",
      );
    } finally {
      expect(releaseProcessLock(handle)).toBe(true);
    }
  });

  it("recovers a dead same-boot owner-bearing repository lock", () => {
    acquireProcessLock(lockPath, {
      pid: 424_242,
      token: "dead-same-boot-owner",
      bootId: "test-boot",
    });

    const receipt = applyArtifactTransaction(
      input(
        [
          {
            path: "created.txt",
            expectedBeforeSha256: null,
            desiredText: "created\n",
          },
        ],
        {
          processLockOptions: {
            bootId: "test-boot",
            isProcessAlive: () => false,
          },
        },
      ),
    );

    expect(receipt.operationCount).toBe(1);
    expect(readFileSync(join(root, "created.txt"), "utf8")).toBe("created\n");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("revalidates lock identity and ownership throughout the transaction", () => {
    const replacement = JSON.stringify({
      pid: 99_999,
      token: "replacement-owner",
      startedAt: "2026-07-26T20:00:00.000Z",
      bootId: "test-boot",
    });

    expectCode(
      () =>
        applyArtifactTransaction(
          input(
            [
              {
                path: "created.txt",
                expectedBeforeSha256: null,
                desiredText: "created\n",
              },
            ],
            {
              interruptionHook: (event: ArtifactTransactionHookEvent) => {
                if (event.phase !== "journal-durable") return;
                unlinkSync(lockPath);
                writeFileSync(lockPath, replacement, {
                  flag: "wx",
                  mode: 0o600,
                });
              },
            },
          ),
        ),
      "lock-identity-changed",
    );

    expect(readFileSync(lockPath, "utf8")).toBe(replacement);
    expect(existsSync(journalPath)).toBe(true);
    expect(existsSync(join(root, "created.txt"))).toBe(false);
  });
});
