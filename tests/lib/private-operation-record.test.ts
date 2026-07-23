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
  PRIVATE_OPERATION_ACTIONS,
  PRIVATE_OPERATION_ERROR_KINDS,
  PRIVATE_OPERATION_EVIDENCE_REQUIREMENTS,
  PRIVATE_OPERATION_RECORD_SCHEMA,
  validatePrivateOperationRecordFile,
  validatePrivateOperationRecordValue,
} from '../../src/lib/private-operation-record.ts';

const tempRoots: string[] = [];

function plannedSteps(): Record<string, unknown>[] {
  return PRIVATE_OPERATION_ACTIONS.slice(1).map((action, index) => ({
    sequence: index + 2,
    action,
    status: 'planned',
    started_at: null,
    completed_at: null,
    target_ids: action === 'retire_quarantine_deliveries'
      ? ['101', '102', '103']
      : action === 'resolve_access_request'
        ? ['201']
        : [],
    pre_evidence: {},
    post_evidence: {},
  }));
}

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
        pre_evidence: {
          node_id_hash: `sha256:${'1'.repeat(64)}`,
          hostname_hash: `sha256:${'2'.repeat(64)}`,
          tags_hash: `sha256:${'3'.repeat(64)}`,
          node_online: true,
          expiry_disabled: false,
        },
        post_evidence: {
          node_id_hash: `sha256:${'1'.repeat(64)}`,
          hostname_hash: `sha256:${'2'.repeat(64)}`,
          tags_hash: `sha256:${'3'.repeat(64)}`,
          node_online: true,
          expiry_disabled: true,
        },
      },
      ...plannedSteps(),
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
  it('publishes the same closed action and evidence registries enforced at runtime', () => {
    expect(Object.keys(PRIVATE_OPERATION_EVIDENCE_REQUIREMENTS)).toEqual([
      ...PRIVATE_OPERATION_ACTIONS,
    ]);
    expect(PRIVATE_OPERATION_ERROR_KINDS).toContain('chronology_invalid');
    const stepSchema = PRIVATE_OPERATION_RECORD_SCHEMA.properties.steps.items;
    expect(stepSchema.properties.action.enum).toBe(PRIVATE_OPERATION_ACTIONS);
    expect(stepSchema.allOf).toHaveLength(PRIVATE_OPERATION_ACTIONS.length * 2 + 4);
    expect(PRIVATE_OPERATION_RECORD_SCHEMA.$comment).toContain(
      'semantic constraints',
    );
  });

  it('accepts a strict schema-v1 record with ordered closed-registry steps', () => {
    expect(validatePrivateOperationRecordValue(validRecord())).toEqual({
      ok: true,
      schemaVersion: 1,
      stepCount: 7,
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
      expect.objectContaining({ kind: 'chronology_invalid', path: '$.steps[0]' }),
      expect.objectContaining({ kind: 'schema_invalid', path: '$.steps[0].target_ids' }),
    ]));
  });

  it('rejects phone-like target IDs without echoing them while allowing short numeric row IDs', () => {
    const record = validRecord();
    const first = (record.steps as Record<string, unknown>[])[0];
    for (const phoneLike of [
      '15551234567',
      '1555-123-4567',
      'node:1555-123-4567',
      'request_1555.123.4567',
    ]) {
      first.target_ids = [phoneLike];
      const rejected = validatePrivateOperationRecordValue(record);
      expect(rejected.ok).toBe(false);
      expect(JSON.stringify(rejected)).not.toContain(phoneLike);
      if (!rejected.ok) {
        expect(rejected.errors).toContainEqual(expect.objectContaining({
          kind: 'schema_invalid',
          path: '$.steps[0].target_ids',
        }));
      }
    }

    first.target_ids = ['123'];
    expect(validatePrivateOperationRecordValue(record).ok).toBe(true);
  });

  it('rejects impossible RFC3339 calendar dates and cross-step time reversal', () => {
    const record = validRecord();
    record.created_at = '2026-02-30T17:00:00Z';
    let result = validatePrivateOperationRecordValue(record);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(expect.objectContaining({
        kind: 'chronology_invalid',
        path: '$.created_at',
      }));
    }

    record.created_at = '2026-07-23T17:00:00Z';
    const steps = record.steps as Record<string, unknown>[];
    steps[1] = {
      sequence: 2,
      action: 'migrate_credentials',
      status: 'completed',
      started_at: '2026-07-23T17:01:30Z',
      completed_at: '2026-07-23T17:03:00Z',
      target_ids: [],
      pre_evidence: { source_present: true },
      post_evidence: {
        private_store_loadable: true,
        plist_sensitive_values_absent: true,
      },
    };
    result = validatePrivateOperationRecordValue(record);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(expect.objectContaining({
        kind: 'chronology_invalid',
        path: '$.steps[1].started_at',
      }));
    }
  });

  it('enforces a completed/skipped prefix and stops all later terminal work at a gate', () => {
    const completedAfterPlanned = validRecord();
    (completedAfterPlanned.steps as Record<string, unknown>[])[2] = {
      sequence: 3,
      action: 'rotate_health_token',
      status: 'completed',
      started_at: '2026-07-23T17:03:00Z',
      completed_at: '2026-07-23T17:04:00Z',
      target_ids: [],
      pre_evidence: { private_store_loadable: true },
      post_evidence: { value_changed: true, health_authentication: 'pass' },
    };
    let result = validatePrivateOperationRecordValue(completedAfterPlanned);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(expect.objectContaining({
        kind: 'state_invalid',
        path: '$.steps[2].status',
      }));
    }

    const completedAfterAbort = validRecord();
    const steps = completedAfterAbort.steps as Record<string, unknown>[];
    steps[1] = {
      sequence: 2,
      action: 'migrate_credentials',
      status: 'aborted',
      started_at: '2026-07-23T17:03:00Z',
      completed_at: '2026-07-23T17:04:00Z',
      target_ids: [],
      pre_evidence: { source_present: true },
      post_evidence: { gate_status: 'fail' },
      reason_code: 'validation_failed',
    };
    steps[2] = {
      sequence: 3,
      action: 'rotate_health_token',
      status: 'completed',
      started_at: '2026-07-23T17:05:00Z',
      completed_at: '2026-07-23T17:06:00Z',
      target_ids: [],
      pre_evidence: { private_store_loadable: true },
      post_evidence: { value_changed: true, health_authentication: 'pass' },
    };
    result = validatePrivateOperationRecordValue(completedAfterAbort);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(expect.objectContaining({
        kind: 'state_invalid',
        path: '$.steps[2].status',
      }));
    }
  });

  it('requires action-specific evidence and Tailscale identity continuity', () => {
    const record = validRecord();
    const first = (record.steps as Record<string, unknown>[])[0];
    first.pre_evidence = { proof: true };
    first.post_evidence = { proof: true };

    let result = validatePrivateOperationRecordValue(record);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(expect.objectContaining({
        kind: 'evidence_invalid',
        path: '$.steps[0].pre_evidence',
      }));
    }

    const valid = validRecord();
    const validFirst = (valid.steps as Record<string, unknown>[])[0];
    (validFirst.post_evidence as Record<string, unknown>).tags_hash =
      `sha256:${'4'.repeat(64)}`;
    result = validatePrivateOperationRecordValue(valid);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(expect.objectContaining({
        kind: 'evidence_invalid',
        path: '$.steps[0].post_evidence',
      }));
    }

    const aborted = validRecord();
    (aborted.steps as Record<string, unknown>[])[1] = {
      sequence: 2,
      action: 'migrate_credentials',
      status: 'aborted',
      started_at: '2026-07-23T17:03:00Z',
      completed_at: '2026-07-23T17:04:00Z',
      target_ids: [],
      pre_evidence: { source_present: false },
      post_evidence: { gate_status: 'fail' },
      reason_code: 'precondition_failed',
    };
    expect(validatePrivateOperationRecordValue(aborted).ok).toBe(true);
  });

  it('requires the complete host action dependency order exactly once', () => {
    const missing = validRecord();
    (missing.steps as unknown[]).splice(2, 1);
    let result = validatePrivateOperationRecordValue(missing);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(expect.objectContaining({
        kind: 'schema_invalid',
        path: '$.steps',
      }));
    }

    const reordered = validRecord();
    const steps = reordered.steps as Record<string, unknown>[];
    [steps[1], steps[2]] = [steps[2], steps[1]];
    steps.forEach((step, index) => {
      step.sequence = index + 1;
    });
    result = validatePrivateOperationRecordValue(reordered);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(expect.objectContaining({
        kind: 'dependency_invalid',
        path: '$.steps[1].action',
      }));
    }
  });

  it('validates a mode-0600 current-owner file inside a mode-0700 current-owner directory', () => {
    const { home, record } = writePrivateRecord(validRecord());
    expect(validatePrivateOperationRecordFile(record, { homeDir: home })).toEqual({
      ok: true,
      schemaVersion: 1,
      stepCount: 7,
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
