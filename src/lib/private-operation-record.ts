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
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const FULL_COMMIT_RE = /^[0-9a-f]{40}$/;
const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TARGET_ID_RE =
  /^(?!.*(?:\d[._:-]*){7})[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
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
  'loaded',
  'match',
  'mismatch',
  'allowed',
  'blocked',
] as const;
const EVIDENCE_STATUSES = new Set<string>(EVIDENCE_STATUS_VALUES);

const ACTIONS_REQUIRING_TARGET_IDS = new Set([
  'preserve_tailscale_access',
  'retire_quarantine_deliveries',
  'resolve_access_request',
]);

type PrivateOperationAction = typeof PRIVATE_OPERATION_ACTIONS[number];
type EvidenceValue = boolean | number | string;
// null means the typed field is required but has no fixed successful value.
type EvidenceFields = Readonly<Record<string, EvidenceValue | null>>;
type EvidenceRequirement = {
  readonly pre: EvidenceFields;
  readonly post: EvidenceFields;
};

export const PRIVATE_OPERATION_EVIDENCE_REQUIREMENTS: Readonly<
  Record<PrivateOperationAction, EvidenceRequirement>
> = {
  preserve_tailscale_access: {
    pre: {
      node_id_hash: null,
      hostname_hash: null,
      tags_hash: null,
      node_online: true,
      expiry_disabled: null,
    },
    post: {
      node_id_hash: null,
      hostname_hash: null,
      tags_hash: null,
      node_online: true,
      expiry_disabled: true,
    },
  },
  migrate_credentials: {
    pre: { source_present: true },
    post: {
      private_store_loadable: true,
      plist_sensitive_values_absent: true,
    },
  },
  rotate_health_token: {
    pre: { private_store_loadable: true },
    post: { value_changed: true, health_authentication: 'pass' },
  },
  restart_launchd_agent: {
    pre: { candidate_plist_valid: true },
    post: {
      launchd_processes: 1,
      port_owners: 1,
      socket_owners: 1,
      health_status: 'healthy',
      provider_usability: 'usable',
    },
  },
  retire_quarantine_deliveries: {
    pre: {
      backup_present: true,
      backup_quick_check: 'pass',
      schema_hash: null,
      actionable_rows: null,
    },
    post: {
      actionable_rows: 0,
      changed_rows: null,
      outbound_submissions: 0,
      echoes_created: 0,
    },
  },
  resolve_access_request: {
    pre: {
      normalized_identity_hash: null,
      admin_identity_hash: null,
      identity_comparison: null,
    },
    post: { access_status: 'allowed' },
  },
  verify_host_acceptance: {
    pre: { checks_planned: null },
    post: {
      launchd_processes: 1,
      health_status: 'healthy',
      whatsapp_status: 'connected',
      recent_disconnects: null,
      provider_usability: 'usable',
      sqlite_quick_check: 'pass',
      arc_status: 'loaded',
      plaintext_plist_absent: true,
      private_modes_valid: true,
      turn_queue_halted: false,
      turn_queue_halted_scopes: 0,
      retired_rows: null,
      access_status: null,
      tailscale_expiry_disabled: true,
    },
  },
};

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

export const PRIVATE_OPERATION_ERROR_KINDS = [
  'schema_invalid',
  'sequence_invalid',
  'dependency_invalid',
  'state_invalid',
  'chronology_invalid',
  'registry_invalid',
  'evidence_invalid',
  'forbidden_field',
  'permissions_invalid',
  'ownership_invalid',
  'read_failure',
  'input_invalid',
  'location_invalid',
] as const;

export type PrivateOperationErrorKind =
  typeof PRIVATE_OPERATION_ERROR_KINDS[number];

export interface PrivateOperationRecordError {
  kind: PrivateOperationErrorKind;
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
    dependency_invalid: {
      message: 'Host operation actions are missing, duplicated, or out of dependency order.',
      retryable: false,
      hint: 'Use each schema action once in the published dependency order.',
    },
    state_invalid: {
      message: 'Step state violates fail-closed execution order.',
      retryable: false,
      hint: 'Keep completed or skipped steps first and leave all steps after a gate planned.',
    },
    chronology_invalid: {
      message: 'Record timestamps are invalid or out of execution order.',
      retryable: false,
      hint: 'Use valid RFC 3339 timestamps in nondecreasing execution order.',
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

function rfc3339Epoch(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = RFC3339_RE.exec(value);
  if (match === null) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  if (
    year < 1
    || month < 1
    || month > 12
    || day < 1
    || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
  ) {
    return null;
  }
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? epoch : null;
}

function isRfc3339(value: unknown): value is string {
  return rfc3339Epoch(value) !== null;
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

function validateRequiredEvidence(
  evidence: unknown,
  requirement: EvidenceFields,
  enforceExpected: boolean,
  jsonPath: string,
  errors: PrivateOperationRecordError[],
): void {
  if (!isRecord(evidence)) return;
  if (
    Object.entries(requirement).some(
      ([key, expected]) =>
        !(key in evidence)
        || (enforceExpected && expected !== null && evidence[key] !== expected),
    )
  ) {
    errors.push(issue('evidence_invalid', jsonPath));
  }
}

function validateActionEvidence(
  action: PrivateOperationAction,
  status: string,
  targetIds: readonly string[],
  preEvidence: unknown,
  postEvidence: unknown,
  stepPath: string,
  errors: PrivateOperationRecordError[],
): void {
  if (status !== 'completed' && status !== 'aborted') return;
  const requirement = PRIVATE_OPERATION_EVIDENCE_REQUIREMENTS[action];
  validateRequiredEvidence(
    preEvidence,
    requirement.pre,
    status === 'completed',
    `${stepPath}.pre_evidence`,
    errors,
  );
  if (status === 'completed') {
    validateRequiredEvidence(
      postEvidence,
      requirement.post,
      true,
      `${stepPath}.post_evidence`,
      errors,
    );
  } else {
    validateRequiredEvidence(
      postEvidence,
      { gate_status: 'fail' },
      true,
      `${stepPath}.post_evidence`,
      errors,
    );
  }

  if (status !== 'completed' || !isRecord(preEvidence) || !isRecord(postEvidence)) {
    return;
  }
  if (action === 'preserve_tailscale_access') {
    const identityKeys = ['node_id_hash', 'hostname_hash', 'tags_hash'] as const;
    if (
      identityKeys.some((key) => preEvidence[key] !== postEvidence[key])
      || preEvidence.node_online !== true
    ) {
      errors.push(issue('evidence_invalid', `${stepPath}.post_evidence`));
    }
  }
  if (
    action === 'retire_quarantine_deliveries'
    && (
      preEvidence.actionable_rows !== targetIds.length
      || postEvidence.changed_rows !== targetIds.length
    )
  ) {
    errors.push(issue('evidence_invalid', `${stepPath}.post_evidence`));
  }
  if (
    action === 'resolve_access_request'
    && (
      preEvidence.normalized_identity_hash !== preEvidence.admin_identity_hash
      || preEvidence.identity_comparison !== 'match'
    )
  ) {
    errors.push(issue('evidence_invalid', `${stepPath}.pre_evidence`));
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
  } else if (action !== PRIVATE_OPERATION_ACTIONS[index]) {
    errors.push(issue('dependency_invalid', `${stepPath}.action`));
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
    if (value.started_at !== null) errors.push(issue('schema_invalid', stepPath));
    if (!isRfc3339(value.completed_at)) {
      errors.push(issue('chronology_invalid', `${stepPath}.completed_at`));
    }
  } else if (!isRfc3339(value.started_at) || !isRfc3339(value.completed_at)) {
    errors.push(issue('chronology_invalid', stepPath));
  } else if (Date.parse(value.started_at) > Date.parse(value.completed_at)) {
    errors.push(issue('chronology_invalid', stepPath));
  }

  const requiresEvidence = status === 'completed' || status === 'aborted';
  validateEvidence(value.pre_evidence, `${stepPath}.pre_evidence`, requiresEvidence, errors);
  validateEvidence(value.post_evidence, `${stepPath}.post_evidence`, requiresEvidence, errors);
  if (
    typeof action === 'string'
    && (PRIVATE_OPERATION_ACTIONS as readonly string[]).includes(action)
    && Array.isArray(targetIds)
  ) {
    validateActionEvidence(
      action as PrivateOperationAction,
      typeof status === 'string' ? status : '',
      targetIds.filter((entry): entry is string => typeof entry === 'string'),
      value.pre_evidence,
      value.post_evidence,
      stepPath,
      errors,
    );
  }

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

function validateStepOrder(
  steps: readonly unknown[],
  createdAt: unknown,
  errors: PrivateOperationRecordError[],
): void {
  let lastTimestamp = rfc3339Epoch(createdAt);
  let gateReached = false;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (!isRecord(step)) continue;
    const stepPath = `$.steps[${index}]`;
    const status = step.status;
    if (
      gateReached
      && status !== 'planned'
      && (PRIVATE_OPERATION_STEP_STATUSES as readonly unknown[]).includes(status)
    ) {
      errors.push(issue('state_invalid', `${stepPath}.status`));
    }
    if (status === 'planned' || status === 'aborted') gateReached = true;

    const startedAt = status === 'skipped' ? step.completed_at : step.started_at;
    const startedEpoch = rfc3339Epoch(startedAt);
    const completedEpoch = rfc3339Epoch(step.completed_at);
    if (
      lastTimestamp !== null
      && startedEpoch !== null
      && startedEpoch < lastTimestamp
    ) {
      errors.push(issue(
        'chronology_invalid',
        status === 'skipped' ? `${stepPath}.completed_at` : `${stepPath}.started_at`,
      ));
    }
    if (completedEpoch !== null) lastTimestamp = completedEpoch;
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
  if (!isRfc3339(value.created_at)) {
    errors.push(issue('chronology_invalid', '$.created_at'));
  }
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
    if (steps.length !== PRIVATE_OPERATION_ACTIONS.length) {
      errors.push(issue('schema_invalid', '$.steps'));
    }
    steps.forEach((step, index) => validateStep(step, index, errors));
    validateStepOrder(steps, value.created_at, errors);
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

const RFC3339_SCHEMA = {
  type: 'string',
  pattern: RFC3339_RE.source,
  format: 'date-time',
} as const;

function requiredEvidenceSchema(
  fields: EvidenceFields,
  enforceExpected = true,
): Record<string, unknown> {
  const expected = enforceExpected
    ? Object.entries(fields).filter((entry): entry is [string, EvidenceValue] =>
        entry[1] !== null)
    : [];
  return {
    required: Object.keys(fields),
    ...(expected.length === 0
      ? {}
      : { properties: Object.fromEntries(
          expected.map(([key, value]) => [key, { const: value }]),
        ) }),
  };
}

function actionEvidenceSchemaRule(
  action: PrivateOperationAction,
  status: 'completed' | 'aborted',
): Record<string, unknown> {
  const requirement = PRIVATE_OPERATION_EVIDENCE_REQUIREMENTS[action];
  return {
    if: {
      properties: { action: { const: action }, status: { const: status } },
      required: ['action', 'status'],
    },
    then: {
      properties: {
        pre_evidence: requiredEvidenceSchema(requirement.pre, status === 'completed'),
        post_evidence: requiredEvidenceSchema(
          status === 'completed' ? requirement.post : { gate_status: 'fail' },
        ),
        ...(ACTIONS_REQUIRING_TARGET_IDS.has(action)
          ? { target_ids: { minItems: 1 } }
          : {}),
      },
    },
  };
}

const ACTION_EVIDENCE_SCHEMA_RULES = PRIVATE_OPERATION_ACTIONS.flatMap((action) => [
  actionEvidenceSchemaRule(action, 'completed'),
  actionEvidenceSchemaRule(action, 'aborted'),
]);

function stepStatusSchemaRule(
  status: typeof PRIVATE_OPERATION_STEP_STATUSES[number],
): Record<string, unknown> {
  const planned = status === 'planned';
  const skipped = status === 'skipped';
  const aborted = status === 'aborted';
  return {
    if: {
      properties: { status: { const: status } },
      required: ['status'],
    },
    then: {
      ...(aborted ? { required: ['reason_code'] } : { not: { required: ['reason_code'] } }),
      properties: {
        started_at: planned || skipped ? { const: null } : RFC3339_SCHEMA,
        completed_at: planned ? { const: null } : RFC3339_SCHEMA,
      },
    },
  };
}

export const PRIVATE_OPERATION_RECORD_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $comment:
    'Runtime semantic constraints additionally enforce calendar-valid RFC3339 values, consecutive sequence values, nondecreasing timestamps, completed/skipped prefix state, post-gate planned state, Tailscale identity continuity, retirement cardinality, and access identity equality. The schema requires each host action once in dependency order.',
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
    created_at: RFC3339_SCHEMA,
    operator_identity: { type: 'string', pattern: OPAQUE_ID_RE.source },
    target_commit: { type: 'string', pattern: FULL_COMMIT_RE.source },
    steps: {
      type: 'array',
      minItems: PRIVATE_OPERATION_ACTIONS.length,
      maxItems: PRIVATE_OPERATION_ACTIONS.length,
      prefixItems: PRIVATE_OPERATION_ACTIONS.map((action) => ({
        properties: { action: { const: action } },
        required: ['action'],
      })),
      items: {
        type: 'object',
        additionalProperties: false,
        allOf: [
          ...PRIVATE_OPERATION_STEP_STATUSES.map(stepStatusSchemaRule),
          ...ACTION_EVIDENCE_SCHEMA_RULES,
        ],
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
          started_at: {
            anyOf: [RFC3339_SCHEMA, { type: 'null' }],
          },
          completed_at: {
            anyOf: [RFC3339_SCHEMA, { type: 'null' }],
          },
          target_ids: {
            type: 'array',
            uniqueItems: true,
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
