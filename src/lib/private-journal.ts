import { join } from 'node:path';
import { readPrivateFileSync, writePrivateJsonMarkerSync } from './private-fs.ts';

/** Shared, bounded availability result for persisted v1 journals. */
export type PrivateJournalStatus = 'available' | 'journal_unreadable';

export type PrivateJournalReadResult =
  | { status: 'available'; version: 'missing' }
  | { status: 'available'; version: 1; value: Record<string, unknown> }
  | { status: 'journal_unreadable'; version: 'unknown' };

const MAX_PRIVATE_JOURNAL_BYTES = 64 * 1024;

export function privateJournalPath(stateRoot: string, filename: string): string {
  return join(stateRoot, filename);
}

/**
 * Read the deployed v1 envelope without assigning any owner-specific schema.
 * Existing malformed, future-version, or unreadable sources stay untouched so
 * their owner can fail open without rewriting untrusted bytes.
 */
export function readPrivateV1JournalSync(statePath: string, label: string): PrivateJournalReadResult {
  try {
    const raw = readPrivateFileSync(statePath, { maxBytes: MAX_PRIVATE_JOURNAL_BYTES, label });
    if (raw === null) return { status: 'available', version: 'missing' };
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { status: 'journal_unreadable', version: 'unknown' };
    }
    const record = value as Record<string, unknown>;
    if (record.v !== 1) return { status: 'journal_unreadable', version: 'unknown' };
    return { status: 'available', version: 1, value: record };
  } catch {
    return { status: 'journal_unreadable', version: 'unknown' };
  }
}

/** Write an owner-validated journal through the same private JSON boundary. */
export function writePrivateJournalSync(statePath: string, value: unknown, label: string): void {
  writePrivateJsonMarkerSync(statePath, value, { label });
}
