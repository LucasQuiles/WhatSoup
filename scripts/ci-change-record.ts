/**
 * Change-record control (leaf, report-only) — Enforcement-ext bead P0.1.
 *
 * Validates a commit's change-record trailers + the referenced changes/CR-<id>.yaml record
 * against controls/schema/change-record.schema.json. This is the standalone validator whose
 * logic the shared commit-msg hook will later call (wiring is a separate, LEAD-owned step).
 *
 * Reuse (HARD rule §0 — no forked result type / reason taxonomy / precondition contract):
 *   - result.ts       : the five-outcome vocabulary (ControlOutcome / ControlExitCode) and the
 *                       canonical outcome -> exit-code mapping (exitCodeForOutcome). This control
 *                       returns a light control-specific observation whose `outcome` is one of the
 *                       five ControlOutcome values (matching the sibling leaf controls
 *                       pre-push-canary.ts / execution-kernel-preflight.ts / classification-admission.ts),
 *                       NOT a second outcome enum.
 *   - reasons.ts      : the reason taxonomy. Codes emitted here are registered there
 *                       (evidence.change-record.missing / evidence.trailer.invalid /
 *                       evidence.trailer.record-mismatch, plus the reused ci.check.passed and
 *                       ci.input.precondition-unproven). Outcome is DERIVED from the taxonomy, so an
 *                       author-declared trailer value can never lower it.
 *   - preconditions.ts: assertBoundedEvidenceGraph bounds parsed evidence.
 *   - git-input.ts    : readExactTreeEntries + readExactBlobs back the git-tree record resolver
 *                       (tree access via the proven helper rather than ad hoc git shelling).
 *
 * Fail-closed: missing / malformed / unreadable evidence is NEVER `pass`. A provable defect BLOCKS;
 * undeterminable evidence or a scanner crash is INCONCLUSIVE (exit 2), never a clean pass.
 */
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse as parseYaml } from 'yaml';

import { exitCodeForOutcome, type ControlExitCode, type ControlOutcome } from './lib/ci-control/result.ts';
import { isEmittableReason, reasonDefinition } from './lib/ci-control/reasons.ts';
import { assertBoundedEvidenceGraph } from './lib/ci-control/preconditions.ts';
import { readExactBlobs, readExactTreeEntries } from './lib/ci-control/git-input.ts';

// ---------------------------------------------------------------------------
// Bounded syntactic contracts (no free-form injection).
// ---------------------------------------------------------------------------
export const RECORD_ID = /^CR-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RECORD_ID_MAX = 128;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_TRAILER_VALUE = 200;
const MAX_DETAIL = 200;
const TRAILER_LINE = /^([A-Za-z][A-Za-z0-9-]*):[ \t]?(.*)$/;
const CONTROL_TRAILER_KEY = /^(?:change|regression)-/i;
const BOUNDED_VALUE = /^[\x20-\x7e]{1,200}$/;
const CHANGE_RECORD_KEY = 'Change-Record';
const REGRESSION_FOR_KEY = 'Regression-For';
const CHANGE_INTENT_KEY = 'Change-Intent';
const RECOGNIZED_KEYS = new Set([CHANGE_RECORD_KEY, REGRESSION_FOR_KEY, CHANGE_INTENT_KEY]);

export const CHANGE_INTENTS = ['bugfix', 'feature', 'chore', 'docs', 'refactor'] as const;
export type ChangeIntent = (typeof CHANGE_INTENTS)[number];
const INTENT_SET = new Set<string>(CHANGE_INTENTS);

// Reason codes (all registered in reasons.ts; this control never invents a parallel taxonomy).
export const CODE_MISSING = 'evidence.change-record.missing';
export const CODE_INVALID = 'evidence.trailer.invalid';
export const CODE_MISMATCH = 'evidence.trailer.record-mismatch';
export const CODE_PASS = 'ci.check.passed';
export const CODE_INCONCLUSIVE = 'ci.input.precondition-unproven';

// ---------------------------------------------------------------------------
// The light control observation. `outcome` is a reused ControlOutcome; this is NOT a second
// result type — it mirrors the sibling leaf-control observation shapes.
// ---------------------------------------------------------------------------
export interface ChangeRecordControlObservationV1 {
  readonly schemaVersion: 1;
  readonly authorization: 'report-only';
  readonly control: 'change-record';
  readonly outcome: ControlOutcome;
  readonly exitCode: ControlExitCode;
  readonly code: string;
  readonly detail: string;
}

export type RecordPresence = 'present' | 'absent' | 'undeterminable';
export interface ResolvedRecord {
  readonly presence: RecordPresence;
  /** utf8 record text when present and readable; null when absent or unreadable. */
  readonly bytes: string | null;
}
/** Read-only record resolver (mirrors pre-push-canary's ReadOnlyLocalRefResolver injection). */
export type ChangeRecordResolver = (id: string) => ResolvedRecord;

function boundedDetail(detail: string): string {
  const oneLine = detail.replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7e]+/g, '');
  return oneLine.length > MAX_DETAIL ? `${oneLine.slice(0, MAX_DETAIL - 1)}…` : oneLine;
}

/**
 * Build the observation. The outcome is derived from the reason taxonomy — never from any
 * author-declared trailer value — so a `Risk: low` (or any) trailer can never lower it. An
 * unemittable/unknown code fails closed to INCONCLUSIVE, never to a clean pass.
 */
function observation(code: string, detail: string): ChangeRecordControlObservationV1 {
  let finalCode = code;
  let def = reasonDefinition(finalCode);
  if (def === null || !isEmittableReason(finalCode)) {
    finalCode = CODE_INCONCLUSIVE;
    def = reasonDefinition(finalCode);
  }
  const outcome = def!.defaultOutcome as ControlOutcome;
  return Object.freeze({
    schemaVersion: 1,
    authorization: 'report-only',
    control: 'change-record',
    outcome,
    exitCode: exitCodeForOutcome(outcome),
    code: finalCode,
    detail: boundedDetail(detail),
  });
}

// ---------------------------------------------------------------------------
// Trailer parsing (pure).
// ---------------------------------------------------------------------------
export interface ParsedChangeRecordTrailers {
  readonly changeRecord: readonly string[];
  readonly regressionFor: readonly string[];
  readonly changeIntent: readonly string[];
  /** control-namespace keys that are not exactly one of the recognized canonical names. */
  readonly unknownControlTrailers: readonly string[];
  /** recognized keys whose value is out of bounds / injection-bearing. */
  readonly malformedValues: readonly string[];
}

export function parseChangeRecordTrailers(message: string): ParsedChangeRecordTrailers {
  const changeRecord: string[] = [];
  const regressionFor: string[] = [];
  const changeIntent: string[] = [];
  const unknownControlTrailers: string[] = [];
  const malformedValues: string[] = [];
  const lines = String(message).split(/\r?\n/);
  for (const line of lines) {
    const match = TRAILER_LINE.exec(line);
    if (match === null) continue;
    const key = match[1]!;
    const value = match[2]!.replace(/[ \t]+$/, '');
    const isControlNamespace = CONTROL_TRAILER_KEY.test(key);
    const isRecognized = RECOGNIZED_KEYS.has(key);
    if (!isControlNamespace && !isRecognized) continue; // foreign trailers (Signed-off-by, Risk, ...) are ignored
    if (!isRecognized) {
      unknownControlTrailers.push(key);
      continue;
    }
    if (!BOUNDED_VALUE.test(value) || value.length > MAX_TRAILER_VALUE) {
      malformedValues.push(key);
      continue;
    }
    if (key === CHANGE_RECORD_KEY) changeRecord.push(value);
    else if (key === REGRESSION_FOR_KEY) regressionFor.push(value);
    else changeIntent.push(value);
  }
  const parsed: ParsedChangeRecordTrailers = {
    changeRecord, regressionFor, changeIntent, unknownControlTrailers, malformedValues,
  };
  assertBoundedEvidenceGraph(parsed, { maxDepth: 4, maxItems: 256, maxNodes: 1024, maxStringBytes: 2_048 });
  return parsed;
}

export type TrailerClassification =
  | { readonly ok: true; readonly recordId: string; readonly intent: ChangeIntent | null }
  | { readonly ok: false; readonly code: string; readonly detail: string };

export function classifyTrailers(parsed: ParsedChangeRecordTrailers): TrailerClassification {
  if (parsed.unknownControlTrailers.length > 0) {
    return { ok: false, code: CODE_INVALID, detail: `unrecognized change-control trailer: ${parsed.unknownControlTrailers[0]}` };
  }
  if (parsed.malformedValues.length > 0) {
    return { ok: false, code: CODE_INVALID, detail: `malformed value for trailer: ${parsed.malformedValues[0]}` };
  }
  if (parsed.changeIntent.length > 1) {
    return { ok: false, code: CODE_INVALID, detail: 'more than one Change-Intent trailer' };
  }
  if (parsed.regressionFor.length > 1) {
    return { ok: false, code: CODE_INVALID, detail: 'more than one Regression-For trailer' };
  }
  const intentRaw = parsed.changeIntent[0] ?? null;
  if (intentRaw !== null && !INTENT_SET.has(intentRaw)) {
    return { ok: false, code: CODE_INVALID, detail: `Change-Intent is not in the closed set: ${intentRaw}` };
  }
  const intent = intentRaw as ChangeIntent | null;
  if (parsed.changeRecord.length === 0) {
    return { ok: false, code: CODE_MISSING, detail: 'no Change-Record trailer' };
  }
  if (parsed.changeRecord.length > 1) {
    return { ok: false, code: CODE_INVALID, detail: 'exactly one Change-Record trailer is required' };
  }
  const recordId = parsed.changeRecord[0]!;
  if (recordId.length > RECORD_ID_MAX || !RECORD_ID.test(recordId)) {
    return { ok: false, code: CODE_INVALID, detail: `Change-Record is not a bounded CR-<slug> id: ${recordId}` };
  }
  if (intent === 'bugfix' && parsed.regressionFor.length === 0) {
    return { ok: false, code: CODE_INVALID, detail: 'Change-Intent: bugfix requires a Regression-For trailer' };
  }
  return { ok: true, recordId, intent };
}

/** The single record id a commit references when its trailers are structurally valid, else null. */
export function referencedRecordId(message: string): string | null {
  const t = classifyTrailers(parseChangeRecordTrailers(message));
  return t.ok ? t.recordId : null;
}

// ---------------------------------------------------------------------------
// Schema-subset validation (the schema JSON is the single source of truth for the closed sets).
// ---------------------------------------------------------------------------
type JsonRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateItem(value: unknown, itemSchema: JsonRecord, label: string): string | null {
  if (Array.isArray(itemSchema.enum)) {
    return itemSchema.enum.includes(value) ? null : `${label} is not in the allowed set`;
  }
  const type = itemSchema.type;
  if (type === 'string') {
    if (typeof value !== 'string') return `${label} must be a string`;
    if (typeof itemSchema.maxLength === 'number' && value.length > itemSchema.maxLength) return `${label} exceeds maxLength`;
    if (typeof itemSchema.pattern === 'string' && !new RegExp(itemSchema.pattern, 'u').test(value)) return `${label} does not match pattern`;
    return null;
  }
  if (type === 'boolean') return typeof value === 'boolean' ? null : `${label} must be a boolean`;
  if (type === 'array') {
    if (!Array.isArray(value)) return `${label} must be an array`;
    if (typeof itemSchema.minItems === 'number' && value.length < itemSchema.minItems) return `${label} has too few items`;
    if (typeof itemSchema.maxItems === 'number' && value.length > itemSchema.maxItems) return `${label} has too many items`;
    const items = isPlainObject(itemSchema.items) ? itemSchema.items : null;
    if (items !== null) {
      for (let i = 0; i < value.length; i += 1) {
        const err = validateItem(value[i], items, `${label}[${i}]`);
        if (err !== null) return err;
      }
    }
    return null;
  }
  return null;
}

/** Validate a parsed record document against the JSON-Schema subset used by change-record.schema.json. */
export function validateAgainstSchema(doc: unknown, schema: unknown): string | null {
  if (!isPlainObject(schema) || !isPlainObject(schema.properties)) return 'schema is not an object schema';
  if (!isPlainObject(doc)) return 'record is not a mapping';
  const properties = schema.properties;
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(doc)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) return `unknown property: ${key}`;
    }
  }
  if (Array.isArray(schema.required)) {
    for (const req of schema.required) {
      if (typeof req === 'string' && !Object.prototype.hasOwnProperty.call(doc, req)) return `missing required property: ${req}`;
    }
  }
  for (const [key, value] of Object.entries(doc)) {
    const propSchema = properties[key];
    if (!isPlainObject(propSchema)) continue;
    const err = validateItem(value, propSchema, key);
    if (err !== null) return err;
  }
  return null;
}

export type RecordValidation = { readonly ok: true } | { readonly ok: false; readonly code: string; readonly detail: string };

export function validateRecordDocument(
  bytes: string,
  expectedId: string,
  expectedIntent: ChangeIntent | null,
  schema: unknown,
): RecordValidation {
  if (Buffer.byteLength(bytes, 'utf8') > MAX_RECORD_BYTES) {
    return { ok: false, code: CODE_MISMATCH, detail: 'record exceeds byte budget' };
  }
  let doc: unknown;
  try {
    doc = parseYaml(bytes, { maxAliasCount: 0, prettyErrors: false });
  } catch {
    return { ok: false, code: CODE_MISMATCH, detail: 'record is not parseable YAML' };
  }
  if (!isPlainObject(doc)) {
    return { ok: false, code: CODE_MISMATCH, detail: 'record is not a YAML mapping' };
  }
  const schemaErr = validateAgainstSchema(doc, schema);
  if (schemaErr !== null) {
    return { ok: false, code: CODE_MISMATCH, detail: `record fails schema: ${schemaErr}` };
  }
  if (doc.id !== expectedId) {
    return { ok: false, code: CODE_MISMATCH, detail: `record id ${String(doc.id)} does not match trailer ${expectedId}` };
  }
  if (expectedIntent !== null && doc.intent !== expectedIntent) {
    return { ok: false, code: CODE_MISMATCH, detail: `record intent ${String(doc.intent)} does not match Change-Intent ${expectedIntent}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Schema loading (relative to this module, not cwd — the hook runs from arbitrary directories).
// ---------------------------------------------------------------------------
let cachedSchema: unknown;
export function loadChangeRecordSchema(): unknown {
  if (cachedSchema !== undefined) return cachedSchema;
  const here = dirname(fileURLToPath(import.meta.url));
  const schemaPath = join(here, '..', 'controls', 'schema', 'change-record.schema.json');
  const raw = readFileSync(schemaPath, 'utf8');
  const schema: unknown = JSON.parse(raw);
  if (!isPlainObject(schema)) throw new Error('change-record schema is not an object');
  cachedSchema = schema;
  return schema;
}

// ---------------------------------------------------------------------------
// Record resolvers.
// ---------------------------------------------------------------------------
/** Resolve records from a working-tree changes/ directory (used by main() and tests). */
export function filesystemRecordResolver(changesDir: string): ChangeRecordResolver {
  const root = resolvePath(changesDir);
  return (id: string): ResolvedRecord => {
    if (id.length > RECORD_ID_MAX || !RECORD_ID.test(id)) return { presence: 'absent', bytes: null };
    const full = normalize(join(root, `${id}.yaml`));
    if (full !== join(root, `${id}.yaml`) || !full.startsWith(root + sep)) return { presence: 'absent', bytes: null };
    try {
      return { presence: 'present', bytes: readFileSync(full, 'utf8') };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { presence: 'absent', bytes: null };
      return { presence: 'undeterminable', bytes: null };
    }
  };
}

/** Resolve records from a git tree via the proven git-input helpers (no ad hoc git shelling). */
export function gitTreeRecordResolver(cwd: string, candidateOid: string): ChangeRecordResolver {
  return (id: string): ResolvedRecord => {
    if (id.length > RECORD_ID_MAX || !RECORD_ID.test(id)) return { presence: 'absent', bytes: null };
    const path = `changes/${id}.yaml`;
    try {
      const set = readExactTreeEntries(cwd, { candidateOid, paths: [path] });
      const entry = set.entries.find((e) => e.path === path);
      if (entry === undefined || entry.presence === 'absent') return { presence: 'absent', bytes: null };
      if (entry.objectType !== 'blob' || entry.objectOid === null) return { presence: 'absent', bytes: null };
      const blob = readExactBlobs(cwd, [entry.objectOid])[0]!;
      return { presence: 'present', bytes: Buffer.from(blob.bytes).toString('utf8') };
    } catch {
      return { presence: 'undeterminable', bytes: null };
    }
  };
}

// ---------------------------------------------------------------------------
// Orchestrators.
// ---------------------------------------------------------------------------
/**
 * Classify a single commit's change-record evidence. Order enforces fail-closed precedence:
 * structural trailer defects BLOCK first; a resolvable-but-absent record is missing (BLOCK);
 * a present record that is provably wrong is a mismatch (BLOCK); undeterminable/unreadable
 * evidence or any crash is INCONCLUSIVE (never a clean pass).
 */
export function classifyChangeRecord(
  message: string,
  resolver: ChangeRecordResolver,
  schema?: unknown,
): ChangeRecordControlObservationV1 {
  try {
    const trailers = classifyTrailers(parseChangeRecordTrailers(message));
    if (!trailers.ok) return observation(trailers.code, trailers.detail);

    const activeSchema = schema ?? loadChangeRecordSchema(); // unreadable schema throws -> INCONCLUSIVE
    const resolved = resolver(trailers.recordId);
    if (resolved.presence === 'undeterminable') {
      return observation(CODE_INCONCLUSIVE, `record presence undeterminable for ${trailers.recordId}`);
    }
    if (resolved.presence === 'absent') {
      return observation(CODE_MISSING, `referenced record changes/${trailers.recordId}.yaml is absent`);
    }
    if (resolved.bytes === null) {
      return observation(CODE_INCONCLUSIVE, `record ${trailers.recordId} present but unreadable`);
    }
    const document = validateRecordDocument(resolved.bytes, trailers.recordId, trailers.intent, activeSchema);
    if (!document.ok) return observation(document.code, document.detail);
    return observation(CODE_PASS, `change record ${trailers.recordId} validated`);
  } catch {
    return observation(CODE_INCONCLUSIVE, 'change-record control failed to run');
  }
}

/**
 * PR-level: every commit must reference a record in the allowed set, and every per-commit
 * observation must pass. BLOCK dominates INCONCLUSIVE dominates a set-membership mismatch. An
 * empty commit set is INCONCLUSIVE, not a vacuous pass.
 */
export function classifyChangeRecordSet(
  messages: readonly string[],
  resolver: ChangeRecordResolver,
  options: { readonly allowedRecordIds: readonly string[]; readonly schema?: unknown },
): ChangeRecordControlObservationV1 {
  try {
    if (!Array.isArray(messages) || messages.length === 0) {
      return observation(CODE_INCONCLUSIVE, 'no commits to evaluate for the change-record set');
    }
    const allowed = new Set(options.allowedRecordIds);
    const perCommit = messages.map((message) => classifyChangeRecord(message, resolver, options.schema));
    const firstBlock = perCommit.find((observationValue) => observationValue.outcome === 'block');
    if (firstBlock !== undefined) return firstBlock;
    const firstInconclusive = perCommit.find((observationValue) => observationValue.outcome === 'inconclusive');
    if (firstInconclusive !== undefined) return firstInconclusive;
    // Every commit passed individually, so each references exactly one valid record id.
    for (const message of messages) {
      const recordId = referencedRecordId(message);
      if (recordId === null || !allowed.has(recordId)) {
        return observation(CODE_MISMATCH, `commit references ${String(recordId)} outside the allowed record set`);
      }
    }
    return observation(CODE_PASS, `all ${messages.length} commits reference the allowed record set`);
  } catch {
    return observation(CODE_INCONCLUSIVE, 'change-record set control failed to run');
  }
}

// ---------------------------------------------------------------------------
// main() — fail-closed: BLOCK -> exit 1, INCONCLUSIVE -> exit 2, crash -> INCONCLUSIVE (never a clean 0).
// ---------------------------------------------------------------------------
export function main(argv: readonly string[]): number {
  let obs: ChangeRecordControlObservationV1;
  try {
    const messagePath = argv[2];
    const message = messagePath !== undefined && messagePath !== ''
      ? readFileSync(messagePath, 'utf8')
      : readFileSync(0, 'utf8');
    const resolver = filesystemRecordResolver(join(process.cwd(), 'changes'));
    obs = classifyChangeRecord(message, resolver);
  } catch {
    obs = observation(CODE_INCONCLUSIVE, 'change-record control failed to run');
  }
  process.stdout.write(`${JSON.stringify(obs)}\n`);
  return obs.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv);
}
