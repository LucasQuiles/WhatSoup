import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MAX_RECORD_BYTES = 1024 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_RECORD_MODE = 0o600;
const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const FULL_COMMIT_RE = /^[0-9a-f]{40}$/;
const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TARGET_ID_RE = /^(?!\d{7,}$)[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH_RE = /^(?:sha256:)?[0-9a-f]{64}$/;
const EVIDENCE_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

export const PRIVATE_OPERATION_ACTIONS = [
  'preserve_tailscale_access',
  'migrate_credentials',
  'rotate_health_token',
  'restart_launchd_agent',
  'retire_quarantine_deliveries',
  'resolve_access_request',
  'verify_host_acceptance',
] as const;

export const PRIVATE_OPERATION_STEP_STATUSES = [
  'planned',
  'completed',
  'aborted',
  'skipped',
] as const;

export const PRIVATE_OPERATION_ABORT_REASONS = [
  'precondition_failed',
  'postcondition_failed',
  'timeout',
  'identity_unproven',
  'control_plane_error',
  'validation_failed',
  'operator_cancelled',
] as const;

const EVIDENCE_STATUS_VALUES = [
  'pass',
  'fail',
  'present',
  'absent',
  'healthy',
  'degraded',
  'unhealthy',
  'connected',
  'disconnected',
  'usable',
  'unusable',
  'pending',
  'completed',
  'aborted',
  'skipped',
  'enabled',
  'disabled',
  'match',
  'mismatch',
] as const;
const EVIDENCE_STATUSES = new Set<string>(EVIDENCE_STATUS_VALUES);

const ACTIONS_REQUIRING_TARGET_IDS = new Set([
  'preserve_tailscale_access',
  'retire_quarantine_deliveries',
  'resolve_access_request',
]);

const FORBIDDEN_FIELD_RE =
  /(?:credential|secret|token|message|jid|phone|raw.?error|error.?text|content)/i;

const TOP_LEVEL_KEYS = new Set([
  'schema_version',
  'run_id',
  'created_at',
  'operator_identity',
  'target_commit',
  'steps',
]);

const STEP_KEYS = new Set([
  'sequence',
  'action',
  'status',
  'started_at',
  'completed_at',
  'target_ids',
  'pre_evidence',
  'post_evidence',
  'reason_code',
]);

export interface PrivateOperationRecordError {
  kind:
    | 'schema_invalid'
    | 'sequence_invalid'
    | 'registry_invalid'
    | 'evidence_invalid'
    | 'forbidden_field'
    | 'permissions_invalid'
    | 'ownership_invalid'
    | 'read_failure'
    | 'input_invalid'
    | 'location_invalid';
  path: string;
  message: string;
  retryable: boolean;
  hint: string;
}

export interface PrivateOperationRecordSuccess {
  ok: true;
  schemaVersion: 1;
  stepCount: number;
}

export interface PrivateOperationRecordFailure {
  ok: false;
  classification: 'actionable' | 'infrastructure';
  errors: PrivateOperationRecordError[];
}

export type PrivateOperationRecordValidation =
  | PrivateOperationRecordSuccess
  | PrivateOperationRecordFailure;

function issue(
  kind: PrivateOperationRecordError['kind'],
  jsonPath: string,
): PrivateOperationRecordError {
  const definitions: Record<
    PrivateOperationRecordError['kind'],
    Pick<PrivateOperationRecordError, 'message' | 'retryable' | 'hint'>
  > = {
    schema_invalid: {
      message: 'Record does not match schema version 1.',
      retryable: false,
      hint: 'Correct the record structure using the schema command.',
    },
    sequence_invalid: {
      message: 'Step sequence must be consecutive and one-based.',
      retryable: false,
      hint: 'Renumber steps in execution order.',
    },
    registry_invalid: {
      message: 'Record uses a value outside a closed registry.',
      retryable: false,
      hint: 'Use a value declared by the schema command.',
    },
    evidence_invalid: {
      message: 'Step evidence is missing or is not structured evidence.',
      retryable: false,
      hint: 'Use non-negative counts, hashes, booleans, or closed status values.',
    },
    forbidden_field: {
      message: 'Record contains a forbidden sensitive field.',
      retryable: false,
      hint: 'Remove sensitive or free-form content and retain only opaque identifiers.',
    },
    permissions_invalid: {
      message: 'Private operation record permissions are unsafe.',
      retryable: false,
      hint: 'Set the parent directory to mode 0700 and the record to mode 0600.',
    },
    ownership_invalid: {
      message: 'Private operation record ownership is invalid.',
      retryable: false,
      hint: 'Make the current operator the owner of the directory and record.',
    },
    read_failure: {
      message: 'Private operation record could not be read safely.',
      retryable: true,
      hint: 'Verify the absolute path, path type, and filesystem availability.',
    },
    input_invalid: {
      message: 'Command input is invalid.',
      retryable: false,
      hint: 'Use schema or validate with an absolute record path and JSON format.',
    },
    location_invalid: {
      message: 'Private operation record is outside the canonical state directory.',
      retryable: false,
      hint: 'Move the record under the operator private-ops state directory.',
    },
  };
  return { kind, path: jsonPath, ...definitions[kind] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRfc3339(value: unknown): value is string {
  return typeof value === 'string'
    && RFC3339_RE.test(value)
    && Number.isFinite(Date.parse(value));
}

function hasForbiddenField(value: unknown, jsonPath: string): PrivateOperationRecordError[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => hasForbiddenField(entry, `${jsonPath}[${index}]`));
  }
  if (!isRecord(value)) return [];

  const errors: PrivateOperationRecordError[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_FIELD_RE.test(key)) {
      errors.push(issue('forbidden_field', jsonPath));
      continue;
    }
    errors.push(...hasForbiddenField(entry, `${jsonPath}.${key}`));
  }
  return errors;
}

function rejectUnexpectedKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  jsonPath: string,
  errors: PrivateOperationRecordError[],
): void {
  if (Object.keys(value).some((key) => !allowed.has(key) && !FORBIDDEN_FIELD_RE.test(key))) {
    errors.push(issue('schema_invalid', jsonPath));
  }
}

function validateEvidence(
  value: unknown,
  jsonPath: string,
  requireNonEmpty: boolean,
  errors: PrivateOperationRecordError[],
): void {
  if (!isRecord(value)) {
    errors.push(issue('evidence_invalid', jsonPath));
    return;
  }
  if (requireNonEmpty && Object.keys(value).length === 0) {
    errors.push(issue('evidence_invalid', jsonPath));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (
      !EVIDENCE_KEY_RE.test(key)
      || FORBIDDEN_FIELD_RE.test(key)
      || /\d{7,}/.test(key)
    ) {
      errors.push(issue('evidence_invalid', jsonPath));
      continue;
    }
    const entryPath = `${jsonPath}.${key}`;
    const valid =
      typeof entry === 'boolean'
      || (typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0)
      || (typeof entry === 'string' && (HASH_RE.test(entry) || EVIDENCE_STATUSES.has(entry)));
    if (!valid) errors.push(issue('evidence_invalid', entryPath));
  }
}

function validateStep(
  value: unknown,
  index: number,
  errors: PrivateOperationRecordError[],
): void {
  const stepPath = `$.steps[${index}]`;
  if (!isRecord(value)) {
    errors.push(issue('schema_invalid', stepPath));
    return;
  }
  rejectUnexpectedKeys(value, STEP_KEYS, stepPath, errors);

  if (value.sequence !== index + 1) {
    errors.push(issue('sequence_invalid', `${stepPath}.sequence`));
  }

  const action = value.action;
  if (
    typeof action !== 'string'
    || !(PRIVATE_OPERATION_ACTIONS as readonly string[]).includes(action)
  ) {
    errors.push(issue('registry_invalid', `${stepPath}.action`));
  }

  const status = value.status;
  if (
    typeof status !== 'string'
    || !(PRIVATE_OPERATION_STEP_STATUSES as readonly string[]).includes(status)
  ) {
    errors.push(issue('registry_invalid', `${stepPath}.status`));
  }

  const targetIds = value.target_ids;
  if (
    !Array.isArray(targetIds)
    || targetIds.some((entry) => typeof entry !== 'string' || !TARGET_ID_RE.test(entry))
  ) {
    errors.push(issue('schema_invalid', `${stepPath}.target_ids`));
  } else if (new Set(targetIds).size !== targetIds.length) {
    errors.push(issue('schema_invalid', `${stepPath}.target_ids`));
  } else if (
    typeof action === 'string'
    && ACTIONS_REQUIRING_TARGET_IDS.has(action)
    && targetIds.length === 0
  ) {
    errors.push(issue('schema_invalid', `${stepPath}.target_ids`));
  }

  if (status === 'planned') {
    if (value.started_at !== null || value.completed_at !== null) {
      errors.push(issue('schema_invalid', stepPath));
    }
  } else if (status === 'skipped') {
    if (value.started_at !== null || !isRfc3339(value.completed_at)) {
      errors.push(issue('schema_invalid', stepPath));
    }
  } else if (!isRfc3339(value.started_at) || !isRfc3339(value.completed_at)) {
    errors.push(issue('schema_invalid', stepPath));
  } else if (Date.parse(value.started_at) > Date.parse(value.completed_at)) {
    errors.push(issue('schema_invalid', stepPath));
  }

  const requiresEvidence = status === 'completed' || status === 'aborted';
  validateEvidence(value.pre_evidence, `${stepPath}.pre_evidence`, requiresEvidence, errors);
  validateEvidence(value.post_evidence, `${stepPath}.post_evidence`, requiresEvidence, errors);

  if (status === 'aborted') {
    if (
      typeof value.reason_code !== 'string'
      || !(PRIVATE_OPERATION_ABORT_REASONS as readonly string[]).includes(value.reason_code)
    ) {
      errors.push(issue('registry_invalid', `${stepPath}.reason_code`));
    }
  } else if (value.reason_code !== undefined) {
    errors.push(issue('schema_invalid', stepPath));
  }
}

export function validatePrivateOperationRecordValue(
  value: unknown,
): PrivateOperationRecordValidation {
  if (!isRecord(value)) {
    return {
      ok: false,
      classification: 'actionable',
      errors: [issue('schema_invalid', '$')],
    };
  }

  const errors = hasForbiddenField(value, '$');
  if (errors.length > 0) {
    return { ok: false, classification: 'actionable', errors };
  }
  rejectUnexpectedKeys(value, TOP_LEVEL_KEYS, '$', errors);
  if (value.schema_version !== 1) errors.push(issue('schema_invalid', '$.schema_version'));
  if (typeof value.run_id !== 'string' || !OPAQUE_ID_RE.test(value.run_id)) {
    errors.push(issue('schema_invalid', '$.run_id'));
  }
  if (!isRfc3339(value.created_at)) errors.push(issue('schema_invalid', '$.created_at'));
  if (
    typeof value.operator_identity !== 'string'
    || !OPAQUE_ID_RE.test(value.operator_identity)
  ) {
    errors.push(issue('schema_invalid', '$.operator_identity'));
  }
  if (typeof value.target_commit !== 'string' || !FULL_COMMIT_RE.test(value.target_commit)) {
    errors.push(issue('schema_invalid', '$.target_commit'));
  }
  const steps = value.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    errors.push(issue('schema_invalid', '$.steps'));
  } else {
    steps.forEach((step, index) => validateStep(step, index, errors));
  }

  if (errors.length > 0) {
    return { ok: false, classification: 'actionable', errors };
  }
  return {
    ok: true,
    schemaVersion: 1,
    stepCount: Array.isArray(steps) ? steps.length : 0,
  };
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readBounded(fd: number, size: number): string | null {
  if (size > MAX_RECORD_BYTES) return null;
  const buffer = Buffer.alloc(Math.min(MAX_RECORD_BYTES + 1, Math.max(size + 1, 1)));
  let offset = 0;
  while (offset < buffer.length) {
    const count = readSync(fd, buffer, offset, buffer.length - offset, null);
    if (count === 0) break;
    offset += count;
  }
  if (offset > MAX_RECORD_BYTES) return null;
  return buffer.subarray(0, offset).toString('utf8');
}

function actionable(error: PrivateOperationRecordError): PrivateOperationRecordFailure {
  return { ok: false, classification: 'actionable', errors: [error] };
}

function infrastructure(): PrivateOperationRecordFailure {
  return {
    ok: false,
    classification: 'infrastructure',
    errors: [issue('read_failure', '$')],
  };
}

export function validatePrivateOperationRecordFile(
  recordPath: string,
  options: {
    homeDir?: string;
    afterOpen?: () => void;
  } = {},
): PrivateOperationRecordValidation {
  let fd: number | undefined;
  try {
    if (!path.isAbsolute(recordPath)) return actionable(issue('schema_invalid', '$'));
    const canonicalDirectory = path.join(
      options.homeDir ?? os.homedir(),
      '.local',
      'state',
      'whatsoup',
      'private-ops',
    );
    if (path.resolve(path.dirname(recordPath)) !== path.resolve(canonicalDirectory)) {
      return actionable(issue('location_invalid', '$'));
    }
    const expectedUid = process.getuid?.();
    if (expectedUid === undefined) return infrastructure();

    const directoryBefore = lstatSync(path.dirname(recordPath));
    if (
      directoryBefore.isSymbolicLink()
      || !directoryBefore.isDirectory()
      || (directoryBefore.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE
    ) {
      return actionable(issue('permissions_invalid', '$'));
    }
    if (directoryBefore.uid !== expectedUid) {
      return actionable(issue('ownership_invalid', '$'));
    }

    const fileBefore = lstatSync(recordPath);
    if (
      fileBefore.isSymbolicLink()
      || !fileBefore.isFile()
      || (fileBefore.mode & 0o7777) !== PRIVATE_RECORD_MODE
    ) {
      return actionable(issue('permissions_invalid', '$'));
    }
    if (fileBefore.uid !== expectedUid) {
      return actionable(issue('ownership_invalid', '$'));
    }

    fd = openSync(
      recordPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    options.afterOpen?.();
    const opened = fstatSync(fd);
    if (!sameIdentity(fileBefore, opened)) return infrastructure();
    if (
      !opened.isFile()
      || (opened.mode & 0o7777) !== PRIVATE_RECORD_MODE
    ) {
      return actionable(issue('permissions_invalid', '$'));
    }
    if (opened.uid !== expectedUid) {
      return actionable(issue('ownership_invalid', '$'));
    }

    const directoryAfter = lstatSync(path.dirname(recordPath));
    if (!sameIdentity(directoryBefore, directoryAfter)) return infrastructure();
    if (
      directoryAfter.isSymbolicLink()
      || !directoryAfter.isDirectory()
      || (directoryAfter.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE
    ) {
      return actionable(issue('permissions_invalid', '$'));
    }
    if (directoryAfter.uid !== expectedUid) {
      return actionable(issue('ownership_invalid', '$'));
    }

    const text = readBounded(fd, opened.size);
    if (text === null) return actionable(issue('schema_invalid', '$'));
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return actionable(issue('schema_invalid', '$'));
    }
    return validatePrivateOperationRecordValue(parsed);
  } catch {
    return infrastructure();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const STRUCTURED_EVIDENCE_SCHEMA = {
  type: 'object',
  propertyNames: {
    allOf: [
      { pattern: EVIDENCE_KEY_RE.source },
      { not: { pattern: '\\d{7,}' } },
      {
        not: {
          pattern:
            '(?:credential|secret|token|message|jid|phone|raw.?error|error.?text|content)',
        },
      },
    ],
  },
  additionalProperties: {
    oneOf: [
      { type: 'boolean' },
      { type: 'integer', minimum: 0 },
      {
        type: 'string',
        oneOf: [
          { pattern: HASH_RE.source },
          { enum: EVIDENCE_STATUS_VALUES },
        ],
      },
    ],
  },
} as const;

export const PRIVATE_OPERATION_RECORD_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'run_id',
    'created_at',
    'operator_identity',
    'target_commit',
    'steps',
  ],
  properties: {
    schema_version: { const: 1 },
    run_id: { type: 'string', pattern: OPAQUE_ID_RE.source },
    created_at: { type: 'string', format: 'date-time' },
    operator_identity: { type: 'string', pattern: OPAQUE_ID_RE.source },
    target_commit: { type: 'string', pattern: FULL_COMMIT_RE.source },
    steps: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'sequence',
          'action',
          'status',
          'started_at',
          'completed_at',
          'target_ids',
          'pre_evidence',
          'post_evidence',
        ],
        properties: {
          sequence: { type: 'integer', minimum: 1 },
          action: { enum: PRIVATE_OPERATION_ACTIONS },
          status: { enum: PRIVATE_OPERATION_STEP_STATUSES },
          started_at: { type: ['string', 'null'], format: 'date-time' },
          completed_at: { type: ['string', 'null'], format: 'date-time' },
          target_ids: {
            type: 'array',
            items: { type: 'string', pattern: TARGET_ID_RE.source },
          },
          pre_evidence: STRUCTURED_EVIDENCE_SCHEMA,
          post_evidence: STRUCTURED_EVIDENCE_SCHEMA,
          reason_code: { enum: PRIVATE_OPERATION_ABORT_REASONS },
        },
      },
    },
  },
} as const;
