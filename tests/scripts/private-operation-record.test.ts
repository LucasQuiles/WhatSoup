import {
  chmodSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  PRIVATE_OPERATION_ACTIONS,
  PRIVATE_OPERATION_ERROR_KINDS,
  PRIVATE_OPERATION_EVIDENCE_REQUIREMENTS,
  PRIVATE_OPERATION_RECORD_SCHEMA,
  validatePrivateOperationRecordFile,
  validatePrivateOperationRecordValue,
} from '../../scripts/lib/private-operation-record.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('');

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

function completedRecord(): Record<string, unknown> {
  const record = validRecord();
  const steps = record.steps as Record<string, unknown>[];
  const times = [
    ['2026-07-23T17:03:00Z', '2026-07-23T17:04:00Z'],
    ['2026-07-23T17:05:00Z', '2026-07-23T17:06:00Z'],
    ['2026-07-23T17:07:00Z', '2026-07-23T17:08:00Z'],
    ['2026-07-23T17:09:00Z', '2026-07-23T17:10:00Z'],
    ['2026-07-23T17:11:00Z', '2026-07-23T17:12:00Z'],
    ['2026-07-23T17:13:00Z', '2026-07-23T17:14:00Z'],
  ] as const;
  const complete = (
    index: number,
    pre_evidence: Record<string, unknown>,
    post_evidence: Record<string, unknown>,
  ): void => {
    Object.assign(steps[index], {
      status: 'completed',
      started_at: times[index - 1][0],
      completed_at: times[index - 1][1],
      pre_evidence,
      post_evidence,
    });
  };
  complete(1, { source_present: true }, {
    private_store_loadable: true,
    plist_sensitive_values_absent: true,
  });
  complete(2, { private_store_loadable: true }, {
    value_changed: true,
    health_authentication: 'pass',
  });
  complete(3, { candidate_plist_valid: true }, {
    launchd_processes: 1,
    expected_port_owners: 1,
    global_socket_owners: 1,
    health_status: 'healthy',
    provider_usability: 'usable',
    model_probe_in_flight: false,
  });
  complete(4, {
    backup_present: true,
    backup_mode: 384,
    backup_quick_check: 'pass',
    schema_hash: `sha256:${'4'.repeat(64)}`,
    actionable_rows: 3,
    expected_pre_rows: 30,
    observed_pre_rows: 30,
  }, {
    actionable_rows: 0,
    changed_rows: 3,
    outbound_submissions: 0,
    echoes_created: 0,
  });
  complete(5, {
    normalized_identity_hash: `sha256:${'5'.repeat(64)}`,
    admin_identity_hash: `sha256:${'5'.repeat(64)}`,
    identity_comparison: 'match',
  }, { access_status: 'allowed' });
  complete(6, { checks_planned: 14 }, {
    launchd_processes: 1,
    expected_port_owners: 1,
    global_socket_owners: 1,
    health_status: 'healthy',
    whatsapp_status: 'connected',
    recent_disconnects: 0,
    recent_disconnect_threshold: 3,
    provider_usability: 'usable',
    model_probe_in_flight: false,
    sqlite_quick_check: 'pass',
    sqlite_schema_version: 44,
    sqlite_schema_required: 44,
    arc_status: 'loaded',
    arc_consumer_match: true,
    arc_payload_sha: `sha256:${'6'.repeat(64)}`,
    arc_canonical_sha: `sha256:${'6'.repeat(64)}`,
    plaintext_plist_absent: true,
    private_modes_valid: true,
    turn_queue_halted: false,
    turn_queue_halted_scopes: 0,
    retired_rows: 3,
    access_status: 'allowed',
    tailscale_node_id_hash: `sha256:${'1'.repeat(64)}`,
    tailscale_hostname_hash: `sha256:${'2'.repeat(64)}`,
    tailscale_tags_hash: `sha256:${'3'.repeat(64)}`,
    tailscale_node_online: true,
    tailscale_expiry_disabled: true,
  });
  return record;
}

function writePrivateRecord(value: unknown): { home: string; record: string } {
  const root = tmp.make('whatsoup-private-operation');
  const directory = path.join(root, '.local', 'state', 'whatsoup', 'private-ops');
  mkdirSync(directory, { mode: 0o700, recursive: true });
  chmodSync(directory, 0o700);
  const record = path.join(directory, 'record.json');
  writeFileSync(record, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(record, 0o600);
  return { home: root, record };
}

describe('private operation record validation', () => {
  it('publishes the same closed action and evidence registries enforced at runtime', () => {
    expect(Object.keys(PRIVATE_OPERATION_EVIDENCE_REQUIREMENTS)).toEqual([
      ...PRIVATE_OPERATION_ACTIONS,
    ]);
    expect(PRIVATE_OPERATION_ERROR_KINDS).toContain('chronology_invalid');
    const stepsSchema = PRIVATE_OPERATION_RECORD_SCHEMA.properties.steps;
    const stepSchema = stepsSchema.prefixItems[0].allOf[0];
    expect(stepSchema).toMatchObject({
      properties: { action: { enum: PRIVATE_OPERATION_ACTIONS } },
      allOf: expect.any(Array),
    });
    const commonRules = (stepSchema as { allOf: readonly unknown[] }).allOf;
    expect(commonRules).toHaveLength(PRIVATE_OPERATION_ACTIONS.length * 3 + 5);
    expect(stepsSchema.items).toBe(false);
    expect(PRIVATE_OPERATION_RECORD_SCHEMA.$comment).toContain(
      'semantic constraints',
    );
  });

  it('compiles under a draft-2020-12 Ajv consumer and applies common validation to prefixes', async () => {
    const { default: Ajv2020 } = await import('ajv/dist/2020.js');
    const { default: addFormats } = await import('ajv-formats');
    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);
    const validate = ajv.compile(
      PRIVATE_OPERATION_RECORD_SCHEMA,
    );
    expect(validate(validRecord())).toBe(true);

    const missingCommonField = validRecord();
    delete (missingCommonField.steps as Record<string, unknown>[])[0].started_at;
    expect(validate(missingCommonField)).toBe(false);

    const impossibleDate = validRecord();
    impossibleDate.created_at = '2026-02-30T17:00:00Z';
    expect(validate(impossibleDate)).toBe(false);

    const skipped = validRecord();
    Object.assign((skipped.steps as Record<string, unknown>[])[1], {
      status: 'skipped',
      completed_at: '2026-07-23T17:03:00Z',
      pre_evidence: { source_present: false },
      post_evidence: { gate_status: 'fail' },
      reason_code: 'precondition_failed',
    });
    expect(validate(skipped)).toBe(false);

    const phoneIdentity = validRecord();
    phoneIdentity.operator_identity = 'operator:1555-123-4567';
    expect(validate(phoneIdentity)).toBe(false);
    expect(validate(completedRecord())).toBe(true);
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

  it('rejects phone-like operator identity without echoing it', () => {
    const record = validRecord();
    record.operator_identity = 'operator:1555-123-4567';
    const result = validatePrivateOperationRecordValue(record);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('1555-123-4567');
    if (!result.ok) {
      expect(result.errors).toContainEqual(expect.objectContaining({
        kind: 'schema_invalid',
        path: '$.operator_identity',
      }));
    }
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

  it('enforces a completed prefix and stops all later terminal work at a gate', () => {
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

  it('treats skipped actions as a fail-closed gate and rejects later terminal work', () => {
    const record = validRecord();
    const steps = record.steps as Record<string, unknown>[];
    Object.assign(steps[1], {
      status: 'skipped',
      completed_at: '2026-07-23T17:03:00Z',
      pre_evidence: { source_present: false },
      post_evidence: { gate_status: 'fail' },
      reason_code: 'precondition_failed',
    });
    Object.assign(steps[2], {
      status: 'completed',
      started_at: '2026-07-23T17:04:00Z',
      completed_at: '2026-07-23T17:05:00Z',
      pre_evidence: { private_store_loadable: true },
      post_evidence: { value_changed: true, health_authentication: 'pass' },
    });

    const result = validatePrivateOperationRecordValue(record);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'state_invalid', path: '$.steps[1].status' }),
        expect.objectContaining({ kind: 'state_invalid', path: '$.steps[2].status' }),
      ]));
    }
  });

  it('requires exact final acceptance evidence and cross-step identity/cardinality joins', () => {
    expect(validatePrivateOperationRecordValue(completedRecord()).ok).toBe(true);
    const mutations: Array<[number, 'pre_evidence' | 'post_evidence', string, unknown]> = [
      [3, 'post_evidence', 'expected_port_owners', 0],
      [3, 'post_evidence', 'global_socket_owners', 0],
      [3, 'post_evidence', 'model_probe_in_flight', true],
      [4, 'pre_evidence', 'backup_mode', 420],
      [4, 'pre_evidence', 'observed_pre_rows', 29],
      [4, 'post_evidence', 'changed_rows', 2],
      [6, 'post_evidence', 'sqlite_schema_required', 45],
      [6, 'post_evidence', 'arc_canonical_sha', `sha256:${'7'.repeat(64)}`],
      [6, 'post_evidence', 'tailscale_node_id_hash', `sha256:${'7'.repeat(64)}`],
      [6, 'post_evidence', 'tailscale_hostname_hash', `sha256:${'7'.repeat(64)}`],
      [6, 'post_evidence', 'tailscale_tags_hash', `sha256:${'7'.repeat(64)}`],
      [6, 'post_evidence', 'tailscale_node_online', false],
      [6, 'post_evidence', 'retired_rows', 2],
      [6, 'post_evidence', 'recent_disconnects', 3],
      [6, 'post_evidence', 'model_probe_in_flight', true],
      [6, 'post_evidence', 'expected_port_owners', 0],
      [6, 'post_evidence', 'global_socket_owners', 0],
    ];
    for (const [stepIndex, phase, key, value] of mutations) {
      const record = completedRecord();
      const evidence = (record.steps as Record<string, unknown>[])[stepIndex]
        [phase] as Record<string, unknown>;
      evidence[key] = value;
      const result = validatePrivateOperationRecordValue(record);
      expect(result.ok, `${stepIndex}.${phase}.${key}`).toBe(false);
      if (!result.ok) {
        expect(result.errors).toContainEqual(expect.objectContaining({
          kind: 'evidence_invalid',
        }));
      }
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
    const otherHome = tmp.make('whatsoup-other-home');

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
