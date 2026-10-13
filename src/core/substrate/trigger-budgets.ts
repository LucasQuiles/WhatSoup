/**
 * The single resource contract for durable substrate triggers.
 *
 * String limits are UTF-8 bytes. The limits protect admission, persisted-row
 * revalidation, child-process IPC, and the isolated `poll.sqlite` executor.
 * `poll.pinecone` is the only current provider-backed trigger; `top_k` bounds
 * its remote work. The other current kinds have no provider-spend dimension.
 */
export const TRIGGER_BUDGETS = {
  maxTextBytes: 4_096,
  maxTitleBytes: 256,
  maxPromptBytes: 4_096,
  maxReportTargetBytes: 512,
  maxDedupeKeyBytes: 256,
  maxMetadataBytes: 4_096,
  maxSpecBytes: 8_192,
  maxSpecDepth: 8,
  maxCollectionItems: 64,
  maxSqlBytes: 4_096,
  maxSqliteBinds: 32,
  maxSqliteBindBytes: 1_024,
  maxSqliteBindPayloadBytes: 4_096,
  maxSqliteRows: 10_000,
  maxSqliteOutputBytes: 2_048,
  maxSqliteWallTimeMs: 30_000,
  maxWorkerStdinBytes: 12_288,
  maxWorkerStdoutBytes: 2_048,
  maxWorkerStderrBytes: 2_048,
  maxRegexBytes: 512,
  maxSelectorBytes: 512,
  maxSelectorCombinators: 32,
  maxUrlBytes: 2_048,
  maxFilePathBytes: 1_024,
  maxCronBytes: 256,
  maxTimezoneBytes: 64,
  maxPineconeIndexBytes: 128,
  maxPineconeNamespaceBytes: 256,
  maxPineconeQueryBytes: 4_096,
  maxPineconeTopK: 100,
  maxConcurrentPerTick: 4,
  maxConsecutiveFailures: 5,
  maxConsecutiveForbiddenRejects: 3,
} as const;

export type SqliteJsonBind = null | number | string;
