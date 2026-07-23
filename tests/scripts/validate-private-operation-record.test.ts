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

import { run } from '../../scripts/validate-private-operation-record.ts';

const tempRoots: string[] = [];

function recordPath(value: unknown): { home: string; record: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'whatsoup-private-operation-cli-'));
  const directory = path.join(root, '.local', 'state', 'whatsoup', 'private-ops');
  mkdirSync(directory, { mode: 0o700, recursive: true });
  chmodSync(directory, 0o700);
  const record = path.join(directory, 'record.json');
  writeFileSync(record, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(record, 0o600);
  tempRoots.push(root);
  return { home: root, record };
}

function validRecord(): Record<string, unknown> {
  return {
    schema_version: 1,
    run_id: 'run-opaque-abc',
    created_at: '2026-07-23T17:00:00Z',
    operator_identity: 'local-operator',
    target_commit: 'a'.repeat(40),
    steps: [{
      sequence: 1,
      action: 'preserve_tailscale_access',
      status: 'completed',
      started_at: '2026-07-23T17:01:00Z',
      completed_at: '2026-07-23T17:02:00Z',
      target_ids: ['node-opaque-abc'],
      pre_evidence: { expiry_disabled: false },
      post_evidence: { expiry_disabled: true },
    }],
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

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

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
        validate_output: { oneOf: expect.any(Array) },
        record: {
          properties: {
            steps: {
              items: {
                properties: {
                  pre_evidence: {
                    additionalProperties: { oneOf: expect.any(Array) },
                    propertyNames: { allOf: expect.any(Array) },
                  },
                  target_ids: {
                    items: {
                      pattern: expect.stringContaining('?!'),
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(result.raw.trim().split('\n')).toHaveLength(1);
  });

  it('validates an absolute private record and emits exactly one JSON object', () => {
    const { home, record } = recordPath(validRecord());
    const result = invoke(['validate', '--record', record, '--format', 'json'], home);
    expect(result.code).toBe(0);
    expect(result.output).toEqual({
      ok: true,
      command: 'validate',
      schema_version: 1,
      step_count: 1,
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
    const home = mkdtempSync(path.join(tmpdir(), 'whatsoup-private-operation-missing-'));
    tempRoots.push(home);
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
