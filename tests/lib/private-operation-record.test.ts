import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  validatePrivateOperationRecordFile,
  validatePrivateOperationRecordValue,
} from '../../src/lib/private-operation-record.ts';

const tempRoots: string[] = [];

function validRecord(): Record<string, unknown> {
  return {
    schema_version: 1,
    run_id: 'run-opaque-abc',
    created_at: '2026-07-23T17:00:00Z',
    operator_identity: 'local-operator',
    target_commit: 'a'.repeat(40),
    steps: [
      {
        sequence: 1,
        action: 'preserve_tailscale_access',
        status: 'completed',
        started_at: '2026-07-23T17:01:00Z',
        completed_at: '2026-07-23T17:02:00Z',
        target_ids: ['node-opaque-abc'],
        pre_evidence: { expiry_disabled: false, node_status: 'connected' },
        post_evidence: { expiry_disabled: true, node_status: 'connected' },
      },
      {
        sequence: 2,
        action: 'migrate_credentials',
        status: 'planned',
        started_at: null,
        completed_at: null,
        target_ids: [],
        pre_evidence: {},
        post_evidence: {},
      },
    ],
  };
}

function writePrivateRecord(value: unknown): { home: string; record: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'whatsoup-private-operation-'));
  const directory = path.join(root, '.local', 'state', 'whatsoup', 'private-ops');
  mkdirSync(directory, { mode: 0o700, recursive: true });
  chmodSync(directory, 0o700);
  const record = path.join(directory, 'record.json');
  writeFileSync(record, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(record, 0o600);
  tempRoots.push(root);
  return { home: root, record };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('private operation record validation', () => {
  it('accepts a strict schema-v1 record with ordered closed-registry steps', () => {
    expect(validatePrivateOperationRecordValue(validRecord())).toEqual({
      ok: true,
      schemaVersion: 1,
      stepCount: 2,
    });
  });

  it('rejects sequence gaps, unknown actions, and free-form abort reasons with stable paths', () => {
    const record = validRecord();
    record.steps = [
      {
        ...(record.steps as Record<string, unknown>[])[0],
        sequence: 2,
        action: 'run_arbitrary_command',
        status: 'aborted',
        reason_code: 'raw provider error',
      },
    ];

    const result = validatePrivateOperationRecordValue(record);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'sequence_invalid', path: '$.steps[0].sequence' }),
      expect.objectContaining({ kind: 'registry_invalid', path: '$.steps[0].action' }),
      expect.objectContaining({ kind: 'registry_invalid', path: '$.steps[0].reason_code' }),
    ]));
  });

  it('rejects forbidden sensitive fields without echoing their key or value', () => {
    const record = validRecord();
    const first = (record.steps as Record<string, unknown>[])[0];
    first.message_content = 'PRIVATE BODY 8675309';
    (first.pre_evidence as Record<string, unknown>).provider_token =
      'SECOND_PRIVATE_VALUE';

    const result = validatePrivateOperationRecordValue(record);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('PRIVATE BODY');
    expect(JSON.stringify(result)).not.toContain('message_content');
    expect(JSON.stringify(result)).not.toContain('SECOND_PRIVATE_VALUE');
    expect(JSON.stringify(result)).not.toContain('provider_token');
    if (result.ok) return;
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'forbidden_field',
        path: '$.steps[0]',
        message: 'Record contains a forbidden sensitive field.',
      }),
    ]));
  });

  it('rejects evidence keys that could encode sensitive identifiers without echoing them', () => {
    const record = validRecord();
    const first = (record.steps as Record<string, unknown>[])[0];
    (first.pre_evidence as Record<string, unknown>)['15551234567'] = true;

    const result = validatePrivateOperationRecordValue(record);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('15551234567');
    if (result.ok) return;
    expect(result.errors).toContainEqual(expect.objectContaining({
      kind: 'evidence_invalid',
      path: '$.steps[0].pre_evidence',
    }));
  });

  it('requires completed and aborted steps to have structured pre/post evidence', () => {
    const record = validRecord();
    (record.steps as Record<string, unknown>[])[0].post_evidence = {
      unsafe_nested: { raw: 'not allowed' },
    };

    const result = validatePrivateOperationRecordValue(record);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'evidence_invalid',
        path: '$.steps[0].post_evidence.unsafe_nested',
      }),
    ]));
  });

  it('rejects reversed step timestamps and duplicate opaque target IDs', () => {
    const record = validRecord();
    const first = (record.steps as Record<string, unknown>[])[0];
    first.started_at = '2026-07-23T17:03:00Z';
    first.completed_at = '2026-07-23T17:02:00Z';
    first.target_ids = ['node-opaque-abc', 'node-opaque-abc'];

    const result = validatePrivateOperationRecordValue(record);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'schema_invalid', path: '$.steps[0]' }),
      expect.objectContaining({ kind: 'schema_invalid', path: '$.steps[0].target_ids' }),
    ]));
  });

  it('rejects phone-like target IDs without echoing them while allowing short numeric row IDs', () => {
    const record = validRecord();
    const first = (record.steps as Record<string, unknown>[])[0];
    first.target_ids = ['15551234567'];

    const rejected = validatePrivateOperationRecordValue(record);
    expect(rejected.ok).toBe(false);
    expect(JSON.stringify(rejected)).not.toContain('15551234567');
    if (!rejected.ok) {
      expect(rejected.errors).toContainEqual(expect.objectContaining({
        kind: 'schema_invalid',
        path: '$.steps[0].target_ids',
      }));
    }

    first.target_ids = ['123'];
    expect(validatePrivateOperationRecordValue(record).ok).toBe(true);
  });

  it('validates a mode-0600 current-owner file inside a mode-0700 current-owner directory', () => {
    const { home, record } = writePrivateRecord(validRecord());
    expect(validatePrivateOperationRecordFile(record, { homeDir: home })).toEqual({
      ok: true,
      schemaVersion: 1,
      stepCount: 2,
    });
  });

  it('classifies unsafe file mode as actionable without reading values into errors', () => {
    const { home, record } = writePrivateRecord(validRecord());
    chmodSync(record, 0o644);

    const result = validatePrivateOperationRecordFile(record, { homeDir: home });
    expect(result.ok).toBe(false);
    if (result.ok || result.classification !== 'actionable') return;
    expect(result.errors).toEqual([
      expect.objectContaining({
        kind: 'permissions_invalid',
        path: '$',
        retryable: false,
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain(record);
  });

  it('rejects a private-mode record outside the canonical private-ops directory', () => {
    const { record } = writePrivateRecord(validRecord());
    const otherHome = mkdtempSync(path.join(tmpdir(), 'whatsoup-other-home-'));
    tempRoots.push(otherHome);

    const result = validatePrivateOperationRecordFile(record, { homeDir: otherHome });
    expect(result).toEqual({
      ok: false,
      classification: 'actionable',
      errors: [expect.objectContaining({
        kind: 'location_invalid',
        path: '$',
      })],
    });
  });

  it('re-attests descriptor and directory security after open', () => {
    for (const target of ['file', 'directory'] as const) {
      const { home, record } = writePrivateRecord(validRecord());
      const result = validatePrivateOperationRecordFile(record, {
        homeDir: home,
        afterOpen: () => {
          chmodSync(target === 'file' ? record : path.dirname(record), 0o755);
        },
      });
      expect(result).toEqual({
        ok: false,
        classification: 'actionable',
        errors: [expect.objectContaining({
          kind: 'permissions_invalid',
          path: '$',
        })],
      });
    }
  });
});
