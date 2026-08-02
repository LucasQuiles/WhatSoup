import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { run } from '../../scripts/validate-private-operation-record.ts';
import {
  PRIVATE_OPERATION_ACTIONS,
  PRIVATE_OPERATION_RECORD_SCHEMA,
} from '../../scripts/lib/private-operation-record.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('');

function recordPath(value: unknown): { home: string; record: string } {
  const root = tmp.make('whatsoup-private-operation-cli');
  const directory = path.join(root, '.local', 'state', 'whatsoup', 'private-ops');
  mkdirSync(directory, { mode: 0o700, recursive: true });
  chmodSync(directory, 0o700);
  const record = path.join(directory, 'record.json');
  writeFileSync(record, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(record, 0o600);
  return { home: root, record };
}

function validRecord(): Record<string, unknown> {
  return {
    schema_version: 1,
    run_id: 'run-opaque-abc',
    created_at: '2026-07-23T17:00:00Z',
    operator_identity: 'local-operator',
    target_commit: 'a'.repeat(40),
    steps: PRIVATE_OPERATION_ACTIONS.map((action, index) => index === 0
      ? {
          sequence: 1,
          action,
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
        }
      : {
          sequence: index + 1,
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
        }),
  };
}

function invoke(
  argv: string[],
  homeDir?: string,
): { code: number; output: Record<string, unknown>; raw: string } {
  let raw = '';
  const code = run(argv, (text) => {
    raw += text;
  }, { homeDir });
  return {
    code,
    output: JSON.parse(raw) as Record<string, unknown>,
    raw,
  };
}

describe('validate-private-operation-record CLI', () => {
  it('returns command schemas and read-only effect metadata', () => {
    const result = invoke(['schema']);
    expect(result.code).toBe(0);
    expect(result.output).toMatchObject({
      ok: true,
      command: 'schema',
      effect: {
        read_only: true,
        network: false,
        credentials: false,
      },
      schemas: {
        validate_input: { type: 'object' },
        validate_output: {
          oneOf: expect.arrayContaining([
            expect.objectContaining({
              properties: expect.objectContaining({
                errors: expect.objectContaining({
                  items: expect.objectContaining({
                    properties: expect.objectContaining({
                      kind: { enum: expect.any(Array) },
                    }),
                  }),
                }),
              }),
            }),
          ]),
        },
        record: {
          $comment: expect.stringContaining('Runtime semantic constraints'),
          properties: {
            steps: {
              minItems: PRIVATE_OPERATION_ACTIONS.length,
              maxItems: PRIVATE_OPERATION_ACTIONS.length,
              prefixItems: expect.any(Array),
              items: false,
            },
          },
        },
      },
    });
    const schemas = result.output.schemas as Record<string, unknown>;
    const recordSchema = schemas.record as typeof PRIVATE_OPERATION_RECORD_SCHEMA;
    const commonStep = recordSchema.properties.steps.prefixItems[0].allOf[0] as {
      allOf: readonly unknown[];
      properties: {
        pre_evidence: Record<string, unknown>;
        target_ids: { items: { pattern: string } };
      };
    };
    expect(commonStep.allOf).toEqual(expect.any(Array));
    expect(commonStep.properties.pre_evidence).toMatchObject({
      additionalProperties: { oneOf: expect.any(Array) },
      propertyNames: { allOf: expect.any(Array) },
    });
    expect(commonStep.properties.target_ids.items.pattern)
      .toContain('(?:\\d[._:-]*){7}');
    expect(result.raw.trim().split('\n')).toHaveLength(1);
  });

  it('emits exactly one JSON object through the documented silent npm invocation', () => {
    const result = spawnSync(
      'npm',
      ['--silent', 'run', 'validate-private-operation-record', '--', 'schema'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, command: 'schema' });
    for (const file of ['docs/runbook.md', 'docs/public-surface.md']) {
      expect(readFileSync(file, 'utf8')).toContain(
        'npm --silent run validate-private-operation-record',
      );
    }
  });

  it('validates an absolute private record and emits exactly one JSON object', () => {
    const { home, record } = recordPath(validRecord());
    const result = invoke(['validate', '--record', record, '--format', 'json'], home);
    expect(result.code).toBe(0);
    expect(result.output).toEqual({
      ok: true,
      command: 'validate',
      schema_version: 1,
      step_count: 7,
    });
    expect(result.raw.trim().split('\n')).toHaveLength(1);
  });

  it('uses exit 1 for actionable validation failures with content-free errors', () => {
    const value = validRecord();
    value.provider_token = 'SUPERSECRET_PRIVATE_VALUE';
    const { home, record } = recordPath(value);
    const result = invoke(['validate', '--record', record, '--format', 'json'], home);

    expect(result.code).toBe(1);
    expect(result.output).toMatchObject({
      ok: false,
      command: 'validate',
      errors: [expect.objectContaining({
        kind: 'forbidden_field',
        path: '$',
        retryable: false,
      })],
    });
    expect(result.raw).not.toContain('SUPERSECRET');
    expect(result.raw).not.toContain('provider_token');
  });

  it('uses exit 2 for read failures without disclosing the requested path', () => {
    const home = tmp.make('whatsoup-private-operation-missing');
    const missing = path.join(
      home,
      '.local',
      'state',
      'whatsoup',
      'private-ops',
      'does-not-exist.json',
    );
    const result = invoke(
      ['validate', '--record', missing, '--format', 'json'],
      home,
    );

    expect(result.code).toBe(2);
    expect(result.output).toMatchObject({
      ok: false,
      command: 'validate',
      errors: [expect.objectContaining({
        kind: 'read_failure',
        path: '$',
        retryable: true,
      })],
    });
    expect(result.raw).not.toContain(missing);
  });

  it('rejects relative paths and non-json formats as actionable input failures', () => {
    for (const argv of [
      ['validate', '--record', 'relative.json', '--format', 'json'],
      ['validate', '--record', '/absolute/record.json', '--format', 'text'],
    ]) {
      const result = invoke(argv);
      expect(result.code).toBe(1);
      expect(result.output).toMatchObject({
        ok: false,
        command: 'validate',
        errors: [expect.objectContaining({
          kind: 'input_invalid',
          retryable: false,
        })],
      });
    }
  });
});
