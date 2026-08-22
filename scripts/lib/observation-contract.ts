/**
 * TS port of `deploy/scripts/lib/observation_contract.py` (task-obs-04): load
 * the governed contract data set under `deploy/observation-plane/` fail-closed
 * and derive the SAME canonical contract digest byte-for-byte, so TS-side
 * consumers (guards, future report tooling) and the Python shadow components
 * bind evidence to one digest (req-obs-02/req-obs-09).
 *
 * This is a deliberate second implementation, not a shared library, because
 * guard-side consumers must stay pure-Node. It is kept honest by a lockstep
 * test (`tests/scripts/lib/observation-contract-lockstep.test.ts`) that shells
 * out to the real Python module and asserts byte-identical digest and
 * projection output over the same document sets — this port can never silently
 * drift from the Python source of truth.
 *
 * Digest bytes go through `pyJsonStringify` from `fleet-roster-inventory.ts` —
 * the repo's single blessed Python-`json.dumps`-compatible encoder. Do not
 * hand-roll another.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isRecord } from '../../src/lib/type-guards.ts';
import { pyJsonStringify } from './fleet-roster-inventory.ts';

export const CONTRACT_FILE_NAMES = Object.freeze([
  'adapter-registry.json',
  'authority-lattice.json',
  'claim-catalog.json',
  'envelope.schema.json',
  'outcome-projections.json',
] as const);

export type ContractFileName = (typeof CONTRACT_FILE_NAMES)[number];

/** The only contract version these readers understand — enforced at build
 * time (not only by the guard). Mirrors `SUPPORTED_SCHEMA_VERSION` in
 * `deploy/scripts/lib/observation_contract.py`. */
export const SUPPORTED_CONTRACT_SCHEMA_VERSION = '0.1';

/** Data documents that carry schema_version (the envelope schema file is a
 * JSON Schema; its version field describes the ENVELOPE). */
const VERSIONED_DOCS = [
  'adapter-registry.json',
  'authority-lattice.json',
  'claim-catalog.json',
  'outcome-projections.json',
] as const;

/** Closed minimum-projection vocabulary; a typo must never weaken projection
 * authority. Mirrors `MIN_PROJECTIONS` on the Python side. Exported as a
 * FROZEN tuple — a mutable exported Set would let any importer widen the
 * accepted vocabulary; the lookup set below stays private. */
export const MIN_PROJECTION_VALUES = Object.freeze([
  'diagnostic',
  'public',
  'not_applicable',
] as const);
const minProjectionLookup = new Set<string>(MIN_PROJECTION_VALUES);

// Closed-world authority model (deploy/observation-plane/README.md): every
// governed field below is MANDATORY and every vocabulary is closed. Mirrors
// REQUIRED_CLAIM_FIELDS / REQUIRED_ADAPTER_FIELDS / GENERATION_BINDINGS /
// PROJECTION_SCOPES / ADAPTER_STATUSES on the Python side.
const REQUIRED_CLAIM_FIELDS = Object.freeze([
  'claim_id',
  'family',
  'subject_kind',
  'min_projection',
  'authority_tier',
  'generation_binding',
  'staleness_rule',
  'producing_adapters',
  'cannot_establish',
] as const);
const REQUIRED_ADAPTER_FIELDS = Object.freeze([
  'adapter_id',
  'wraps',
  'platforms',
  'privilege',
  'prerequisites',
  'projection_scope',
  'can_establish',
  'cannot_establish',
  'status',
] as const);
const generationBindings = new Set(['none', 'config', 'process', 'credential', 'process+credential']);
const projectionScopes = new Set(['diagnostic', 'public', 'not_applicable']);
const adapterStatuses = new Set(['available', 'gated', 'producer_pending']);

function stringListField(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new ObservationContractPortError(`${what} must be a list of strings`);
  }
  return value;
}

function validateAuthorityMetadata(
  claims: Record<string, Record<string, unknown>>,
  adapters: Record<string, Record<string, unknown>>,
  tiers: string[],
): void {
  const tierSet = new Set(tiers);
  for (const [claimId, claim] of Object.entries(claims)) {
    for (const field of REQUIRED_CLAIM_FIELDS) {
      if (!Object.hasOwn(claim, field)) {
        throw new ObservationContractPortError(`claim ${claimId}: missing required field ${field}`);
      }
    }
    if (typeof claim['authority_tier'] !== 'string' || !tierSet.has(claim['authority_tier'])) {
      throw new ObservationContractPortError(
        `claim ${claimId}: authority_tier ${String(claim['authority_tier'])} is not a declared lattice tier`,
      );
    }
    if (
      typeof claim['generation_binding'] !== 'string' ||
      !generationBindings.has(claim['generation_binding'])
    ) {
      throw new ObservationContractPortError(
        `claim ${claimId}: generation_binding ${String(claim['generation_binding'])} outside the closed vocabulary`,
      );
    }
    const rule = claim['staleness_rule'];
    if (!isRecord(rule) || typeof rule['kind'] !== 'string' || rule['kind'].length === 0) {
      throw new ObservationContractPortError(
        `claim ${claimId}: staleness_rule must be an object with a non-empty string kind`,
      );
    }
    const window = rule['window_seconds'];
    if (window !== undefined && (typeof window !== 'number' || !Number.isInteger(window))) {
      throw new ObservationContractPortError(
        `claim ${claimId}: staleness_rule.window_seconds must be an integer when present`,
      );
    }
    stringListField(claim['producing_adapters'], `claim ${claimId} producing_adapters`);
    stringListField(claim['cannot_establish'], `claim ${claimId} cannot_establish`);
  }

  for (const [adapterId, adapter] of Object.entries(adapters)) {
    for (const field of REQUIRED_ADAPTER_FIELDS) {
      if (!Object.hasOwn(adapter, field)) {
        throw new ObservationContractPortError(
          `adapter ${adapterId}: missing required field ${field}`,
        );
      }
    }
    if (
      typeof adapter['projection_scope'] !== 'string' ||
      !projectionScopes.has(adapter['projection_scope'])
    ) {
      throw new ObservationContractPortError(
        `adapter ${adapterId}: projection_scope ${String(adapter['projection_scope'])} outside the closed vocabulary`,
      );
    }
    if (typeof adapter['status'] !== 'string' || !adapterStatuses.has(adapter['status'])) {
      throw new ObservationContractPortError(
        `adapter ${adapterId}: status ${String(adapter['status'])} outside the closed vocabulary`,
      );
    }
    for (const field of ['wraps', 'platforms', 'prerequisites', 'can_establish', 'cannot_establish']) {
      stringListField(adapter[field], `adapter ${adapterId} ${field}`);
    }
    if (typeof adapter['privilege'] !== 'string' || adapter['privilege'].length === 0) {
      throw new ObservationContractPortError(
        `adapter ${adapterId}: privilege must be a non-empty string`,
      );
    }
    const cannot = new Set(stringListField(adapter['cannot_establish'], `adapter ${adapterId}`));
    for (const claimId of stringListField(adapter['can_establish'], `adapter ${adapterId}`)) {
      if (cannot.has(claimId)) {
        throw new ObservationContractPortError(
          `adapter ${adapterId}: ${claimId} appears in both can_establish and cannot_establish`,
        );
      }
    }
  }

  // Cross-references resolve, and producer relationships are symmetric in BOTH
  // directions.
  for (const [claimId, claim] of Object.entries(claims)) {
    for (const other of stringListField(claim['cannot_establish'], `claim ${claimId}`)) {
      if (!Object.hasOwn(claims, other)) {
        throw new ObservationContractPortError(
          `claim ${claimId}: cannot_establish references unknown claim ${other}`,
        );
      }
    }
    for (const adapterId of stringListField(claim['producing_adapters'], `claim ${claimId}`)) {
      if (!Object.hasOwn(adapters, adapterId)) {
        throw new ObservationContractPortError(
          `claim ${claimId}: producing_adapters references unknown adapter ${adapterId}`,
        );
      }
      const canEstablish = stringListField(
        adapters[adapterId]!['can_establish'],
        `adapter ${adapterId}`,
      );
      if (!canEstablish.includes(claimId)) {
        throw new ObservationContractPortError(
          `claim ${claimId}: producer ${adapterId} does not declare it in can_establish`,
        );
      }
    }
  }
  for (const [adapterId, adapter] of Object.entries(adapters)) {
    for (const claimId of stringListField(adapter['can_establish'], `adapter ${adapterId}`)) {
      if (!Object.hasOwn(claims, claimId)) {
        throw new ObservationContractPortError(
          `adapter ${adapterId}: can_establish references unknown claim ${claimId}`,
        );
      }
      const producers = stringListField(
        claims[claimId]!['producing_adapters'],
        `claim ${claimId}`,
      );
      if (!producers.includes(adapterId)) {
        throw new ObservationContractPortError(
          `adapter ${adapterId}: claim ${claimId} does not name it in producing_adapters`,
        );
      }
    }
    for (const claimId of stringListField(adapter['cannot_establish'], `adapter ${adapterId}`)) {
      if (!Object.hasOwn(claims, claimId)) {
        throw new ObservationContractPortError(
          `adapter ${adapterId}: cannot_establish references unknown claim ${claimId}`,
        );
      }
    }
  }
}

/** Raised when the contract set cannot be read or is structurally invalid.
 * Callers treat this as fail-closed (mirrors Python's
 * `ObservationContractError`). */
export class ObservationContractPortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObservationContractPortError';
  }
}

export interface ProjectionRow {
  legacy_value: string;
  canonical: string;
  lossy: boolean;
  [extra: string]: unknown;
}

export interface ContractSurface {
  domain: string[];
  rows: Record<string, ProjectionRow>;
}

export interface ObservationContract {
  digest: string;
  docs: Record<ContractFileName, Record<string, unknown>>;
  canonicalOutcomes: string[];
  surfaces: Record<string, ContractSurface>;
  claims: Record<string, Record<string, unknown>>;
  adapters: Record<string, Record<string, unknown>>;
  authorityTiers: string[];
}

/** Recursive readonly JSON value. Contract payloads are typed as this rather
 * than `unknown` so that DIRECT payload mutation is a compile error —
 * assignment (TS2542) and `payload.push(...)` (TS2339) both fail. Mutation
 * behind `Array.isArray` narrowing still compiles (TypeScript widens even
 * readonly arrays there); the runtime `deepFreeze` is the authority on that
 * path, as documented on `ObservationContractView` below. */
export type ReadonlyJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly ReadonlyJsonValue[]
  | { readonly [key: string]: ReadonlyJsonValue };

export type ReadonlyJsonObject = { readonly [key: string]: ReadonlyJsonValue };

export interface ProjectionRowView {
  readonly legacy_value: string;
  readonly canonical: string;
  readonly lossy: boolean;
  readonly [extra: string]: ReadonlyJsonValue;
}

export interface ContractSurfaceView {
  readonly domain: readonly string[];
  readonly rows: { readonly [legacyValue: string]: ProjectionRowView };
}

/** What the builders return: digest-bound state, immutable at runtime via
 * `deepFreeze` and — for direct declared-property and payload-property
 * writes — at the type level too. Known type-level limit: `Array.isArray`
 * is unsound for readonly arrays, so a `.push` behind that guard still
 * compiles; the runtime freeze rejects it (pinned by the lockstep suite).
 * Use `contractSnapshot` or the lookup accessors for mutable copies. */
export interface ObservationContractView {
  readonly digest: string;
  readonly docs: { readonly [K in ContractFileName]: ReadonlyJsonObject };
  readonly canonicalOutcomes: readonly string[];
  readonly surfaces: { readonly [surfaceName: string]: ContractSurfaceView };
  readonly claims: { readonly [claimId: string]: ReadonlyJsonObject };
  readonly adapters: { readonly [adapterId: string]: ReadonlyJsonObject };
  readonly authorityTiers: readonly string[];
}

export function defaultContractDir(): string {
  // Module-anchored (lib/ -> scripts/ -> <repo root>), mirroring Python's
  // `default_contract_dir` — the default must never depend on process.cwd().
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, '..', '..', 'deploy', 'observation-plane');
}

/** Mirrors `observation_contract.py:contract_identity` — the five parsed
 * documents keyed by file name. */
export function contractIdentity(docs: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(docs)) {
    throw new ObservationContractPortError('contract docs must be a mapping');
  }
  const missing = CONTRACT_FILE_NAMES.filter((name) => !Object.hasOwn(docs, name));
  if (missing.length > 0) {
    throw new ObservationContractPortError(`missing contract document(s): ${missing.join(', ')}`);
  }
  const files: Record<string, unknown> = {};
  for (const name of CONTRACT_FILE_NAMES) {
    if (!isRecord(docs[name])) {
      throw new ObservationContractPortError(`contract document must be a JSON object: ${name}`);
    }
    files[name] = docs[name];
  }
  return { files };
}

// Digest domain (req-obs-02): the digest is defined only over values both
// encoders accept AND serialize byte-identically. Numbers must be integral
// with |n| <= 2**53-1 — JSON.parse normalizes integral literals (1.0, 1e0,
// -0) to integers before any reader code runs, and the Python side
// canonicalizes integral floats to the same integers, so every raw numeric
// form lands on one digest or fails closed on BOTH sides (JS String(1e-7)
// vs Python repr(1e-07) would otherwise diverge). Object KEYS must stay
// inside the BMP (JS sorts keys by UTF-16 code unit, Python by code point —
// the orders disagree beyond it, at any nesting depth). String VALUES are
// unrestricted: surrogate escaping is parity-proven by the lockstep suite.
const MAX_DIGEST_INT = 2 ** 53 - 1;

/** Returns `value` rebuilt inside the digest domain: -0 canonicalized to 0
 * and every object rebuilt with a null prototype (so identifiers like
 * `__proto__` are ordinary own keys, exactly as in a Python dict). Throws
 * for anything outside the domain. */
function normalizeForDigest(value: unknown, at: string): unknown {
  if (value === undefined) {
    // undefined cannot come from JSON.parse; encoding it as null would give
    // two different programmatic values one digest.
    throw new ObservationContractPortError(
      `digest domain violation at ${at}: undefined is outside the parsed-JSON domain`,
    );
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || Math.abs(value) > MAX_DIGEST_INT) {
      throw new ObservationContractPortError(
        `digest domain violation at ${at}: numbers must be integers with |n| <= 2**53-1 ` +
          '(other numbers do not serialize identically across the Python/TS encoders)',
      );
    }
    return value === 0 ? 0 : value;
  }
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const normalized: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        throw new ObservationContractPortError(
          `digest domain violation at ${at}[${index}]: sparse arrays are outside the parsed-JSON domain`,
        );
      }
      normalized.push(normalizeForDigest(value[index], `${at}[${index}]`));
    }
    return normalized;
  }
  if (isRecord(value)) {
    const normalized = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(value)) {
      for (const ch of key) {
        if ((ch.codePointAt(0) ?? 0) > 0xffff) {
          throw new ObservationContractPortError(
            `digest domain violation at ${at}: object keys must be BMP-only strings ` +
              '(key sort order diverges across encoders beyond the BMP)',
          );
        }
      }
      normalized[key] = normalizeForDigest(item, `${at}.${key}`);
    }
    return normalized;
  }
  throw new ObservationContractPortError(
    `digest domain violation at ${at}: unsupported value type ${typeof value}`,
  );
}

/** `sha256(json.dumps(contract_identity(docs), sort_keys=True, separators=(",",":")))`,
 * identical call shape to the Python side. */
export function contractDigest(docs: Record<string, unknown>): string {
  const identity = normalizeForDigest(contractIdentity(docs), 'contract');
  const material = pyJsonStringify(identity);
  return createHash('sha256').update(Buffer.from(material, 'utf8')).digest('hex');
}

function stringArray(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new ObservationContractPortError(`${what} must be a list of strings`);
  }
  return [...value];
}

function buildSurfaces(
  projections: Record<string, unknown>,
  canonical: Set<string>,
): Record<string, ContractSurface> {
  const rawSurfaces = projections['surfaces'];
  if (!isRecord(rawSurfaces) || Object.keys(rawSurfaces).length === 0) {
    throw new ObservationContractPortError('outcome-projections surfaces must be a non-empty object');
  }
  // Null-prototype accumulators: untrusted identifiers (surface names, legacy
  // values, claim/adapter ids) must become ordinary own keys — a plain {}
  // would let '__proto__' silently rewire the table instead.
  const surfaces = Object.create(null) as Record<string, ContractSurface>;
  for (const [surfaceName, surface] of Object.entries(rawSurfaces)) {
    if (!isRecord(surface)) {
      throw new ObservationContractPortError(`surface must be an object: ${surfaceName}`);
    }
    const domain = stringArray(surface['domain'], `surface ${surfaceName} domain`);
    if (domain.length === 0 || new Set(domain).size !== domain.length) {
      throw new ObservationContractPortError(`surface ${surfaceName} domain must be non-empty and unique`);
    }
    const rawRows = surface['rows'];
    if (!Array.isArray(rawRows)) {
      throw new ObservationContractPortError(`surface ${surfaceName} rows must be a list`);
    }
    const rows = Object.create(null) as Record<string, ProjectionRow>;
    for (const row of rawRows) {
      if (
        !isRecord(row) ||
        typeof row['legacy_value'] !== 'string' ||
        typeof row['canonical'] !== 'string' ||
        typeof row['lossy'] !== 'boolean'
      ) {
        throw new ObservationContractPortError(`malformed projection row in ${surfaceName}`);
      }
      const legacyValue = row['legacy_value'];
      if (Object.hasOwn(rows, legacyValue)) {
        throw new ObservationContractPortError(`duplicate projection row ${surfaceName}: ${legacyValue}`);
      }
      if (!domain.includes(legacyValue)) {
        throw new ObservationContractPortError(
          `projection row outside declared domain ${surfaceName}: ${legacyValue}`,
        );
      }
      if (!canonical.has(row['canonical'])) {
        throw new ObservationContractPortError(
          `canonical outcome outside the closed vocabulary ${surfaceName}: ${row['canonical']}`,
        );
      }
      rows[legacyValue] = { ...row } as ProjectionRow;
    }
    for (const member of domain) {
      if (!Object.hasOwn(rows, member)) {
        throw new ObservationContractPortError(`surface ${surfaceName} is not total: missing row for ${member}`);
      }
    }
    surfaces[surfaceName] = { domain, rows };
  }
  return surfaces;
}

function buildKeyed(
  entries: unknown,
  key: string,
  what: string,
): Record<string, Record<string, unknown>> {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new ObservationContractPortError(`${what} must be a non-empty list`);
  }
  const keyed = Object.create(null) as Record<string, Record<string, unknown>>;
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry[key] !== 'string' || entry[key].length === 0) {
      throw new ObservationContractPortError(`${what} entry missing ${key}`);
    }
    const id = entry[key];
    if (Object.hasOwn(keyed, id)) {
      throw new ObservationContractPortError(`duplicate ${key} in ${what}: ${id}`);
    }
    keyed[id] = { ...entry };
  }
  return keyed;
}

/** Ported from `observation_contract.py:build_contract` — pure over parsed
 * docs so the lockstep test can exercise mutated document sets. */
export function buildObservationContract(docs: Record<string, unknown>): ObservationContractView {
  const digest = contractDigest(docs); // also validates presence/shape of every doc
  // Build the returned structure from the NORMALIZED documents (mirrors the
  // Python side): req-obs-02 covers returned data, so consumers on both sides
  // must see identical values (-0 -> 0) inside prototype-safe records.
  docs = (
    normalizeForDigest(contractIdentity(docs), 'contract') as {
      files: Record<string, Record<string, unknown>>;
    }
  ).files;
  for (const name of VERSIONED_DOCS) {
    const version = (docs[name] as Record<string, unknown>)['schema_version'];
    if (version !== SUPPORTED_CONTRACT_SCHEMA_VERSION) {
      throw new ObservationContractPortError(
        `unsupported schema_version in ${name}: ${String(version)} ` +
          `(supported: ${SUPPORTED_CONTRACT_SCHEMA_VERSION})`,
      );
    }
  }
  const projections = docs['outcome-projections.json'] as Record<string, unknown>;
  const canonicalList = stringArray(projections['canonical_outcomes'], 'canonical_outcomes');
  if (canonicalList.length === 0 || new Set(canonicalList).size !== canonicalList.length) {
    throw new ObservationContractPortError('canonical_outcomes must be non-empty and unique');
  }
  const canonical = new Set(canonicalList);
  const surfaces = buildSurfaces(projections, canonical);
  const catalog = docs['claim-catalog.json'] as Record<string, unknown>;
  const registry = docs['adapter-registry.json'] as Record<string, unknown>;
  const claims = buildKeyed(catalog['claims'], 'claim_id', 'claim catalog');
  for (const [claimId, claim] of Object.entries(claims)) {
    const minProjection = claim['min_projection'];
    if (typeof minProjection !== 'string' || !minProjectionLookup.has(minProjection)) {
      throw new ObservationContractPortError(
        `claim ${claimId}: min_projection ${String(minProjection)} outside the closed ` +
          `vocabulary [${[...MIN_PROJECTION_VALUES].sort().join(', ')}]`,
      );
    }
  }
  const adapters = buildKeyed(registry['adapters'], 'adapter_id', 'adapter registry');
  const lattice = docs['authority-lattice.json'] as Record<string, unknown>;
  const rawTiers = lattice['tiers'];
  if (!Array.isArray(rawTiers) || rawTiers.length === 0) {
    throw new ObservationContractPortError('authority-lattice tiers must be a non-empty list');
  }
  const tiers: string[] = [];
  for (const tier of rawTiers) {
    if (!isRecord(tier) || typeof tier['tier'] !== 'string') {
      throw new ObservationContractPortError('malformed authority-lattice tier entry');
    }
    if (tiers.includes(tier['tier'])) {
      throw new ObservationContractPortError(`duplicate authority tier: ${tier['tier']}`);
    }
    tiers.push(tier['tier']);
  }
  validateAuthorityMetadata(claims, adapters, tiers);
  const typedDocs = Object.create(null) as Record<ContractFileName, Record<string, unknown>>;
  for (const name of CONTRACT_FILE_NAMES) {
    typedDocs[name] = docs[name] as Record<string, unknown>;
  }
  return deepFreeze({
    digest,
    docs: typedDocs,
    canonicalOutcomes: canonicalList,
    surfaces,
    claims,
    adapters,
    authorityTiers: tiers,
  }) as ObservationContractView;
}

/** Canonical cross-language interchange shape of a contract snapshot: one
 * snake_case key set, byte-identical between `contractSnapshot` here and
 * Python's `contract_snapshot` under canonical JSON encoding. */
export interface ObservationContractSnapshot {
  digest: string;
  docs: Record<ContractFileName, Record<string, unknown>>;
  canonical_outcomes: string[];
  surfaces: Record<string, ContractSurface>;
  claims: Record<string, Record<string, unknown>>;
  adapters: Record<string, Record<string, unknown>>;
  authority_tiers: string[];
}

/** Plain JSON-compatible, mutable, detached deep copy of the whole contract
 * in the canonical interchange shape — the official cross-language snapshot
 * operation (Python: `contract_snapshot`). The frozen view itself stays the
 * digest authority; in-language field idioms stop at this boundary. */
export function contractSnapshot(contract: ObservationContractView): ObservationContractSnapshot {
  const plain = structuredClone(contract) as ObservationContract;
  return {
    digest: plain.digest,
    docs: plain.docs,
    canonical_outcomes: plain.canonicalOutcomes,
    surfaces: plain.surfaces,
    claims: plain.claims,
    adapters: plain.adapters,
    authority_tiers: plain.authorityTiers,
  };
}

/** Digest-bound state is immutable: a consumer must never be able to change
 * evaluated policy out from under the digest that names it. Lookups hand out
 * defensive copies instead. */
function deepFreeze<T>(value: T): T {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** Read the five contract files and build the contract, fail-closed. */
export function loadObservationContract(contractDir?: string): ObservationContractView {
  const resolved = contractDir ?? defaultContractDir();
  const docs: Record<string, unknown> = {};
  for (const name of CONTRACT_FILE_NAMES) {
    const filePath = path.join(resolved, name);
    let raw: string;
    try {
      // Strict fatal decode: Node's lossy 'utf8' mode would silently replace
      // malformed sequences with U+FFFD while Python rejects the same bytes.
      // ignoreBOM keeps a leading BOM in the output so JSON.parse rejects it,
      // exactly like Python's json (TextDecoder strips it by default).
      raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        readFileSync(filePath),
      );
    } catch (err) {
      throw new ObservationContractPortError(
        `cannot read contract document ${filePath}: ${(err as Error).message}`,
      );
    }
    try {
      docs[name] = JSON.parse(raw);
    } catch (err) {
      throw new ObservationContractPortError(
        `invalid contract JSON ${filePath}: ${(err as Error).message}`,
      );
    }
  }
  return buildObservationContract(docs);
}

/** Project one legacy verdict to its canonical row, or throw — nothing here
 * defaults (mirrors `observation_contract.py:project_outcome`). */
export function projectOutcome(
  contract: ObservationContractView,
  surface: string,
  rawValue: string,
): ProjectionRow {
  // Object.hasOwn everywhere: inherited names (toString/constructor/...) must
  // behave as ordinary unknown keys, exactly like Python's dict lookups.
  if (!Object.hasOwn(contract.surfaces, surface)) {
    throw new ObservationContractPortError(`unknown legacy surface: ${surface}`);
  }
  const table = contract.surfaces[surface]!;
  if (!Object.hasOwn(table.rows, rawValue)) {
    throw new ObservationContractPortError(
      `legacy value outside the declared domain of ${surface}: ${rawValue}`,
    );
  }
  // Defensive copy: digest-bound state must not be mutable through lookups.
  return structuredClone(table.rows[rawValue]!) as ProjectionRow;
}

export function claimRow(
  contract: ObservationContractView,
  claimId: string,
): Record<string, unknown> {
  if (!Object.hasOwn(contract.claims, claimId)) {
    throw new ObservationContractPortError(`unknown claim: ${claimId}`);
  }
  return structuredClone(contract.claims[claimId]!) as Record<string, unknown>;
}

export function adapterRow(
  contract: ObservationContractView,
  adapterId: string,
): Record<string, unknown> {
  if (!Object.hasOwn(contract.adapters, adapterId)) {
    throw new ObservationContractPortError(`unknown adapter: ${adapterId}`);
  }
  return structuredClone(contract.adapters[adapterId]!) as Record<string, unknown>;
}
