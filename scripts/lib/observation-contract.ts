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

export const CONTRACT_FILE_NAMES = [
  'adapter-registry.json',
  'authority-lattice.json',
  'claim-catalog.json',
  'envelope.schema.json',
  'outcome-projections.json',
] as const;

export type ContractFileName = (typeof CONTRACT_FILE_NAMES)[number];

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
  if (value === null || value === undefined || typeof value === 'boolean') return value;
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
    return value.map((item, index) => normalizeForDigest(item, `${at}[${index}]`));
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
export function buildObservationContract(docs: Record<string, unknown>): ObservationContract {
  const digest = contractDigest(docs); // also validates presence/shape of every doc
  // Build the returned structure from the NORMALIZED documents (mirrors the
  // Python side): req-obs-02 covers returned data, so consumers on both sides
  // must see identical values (-0 -> 0) inside prototype-safe records.
  docs = (
    normalizeForDigest(contractIdentity(docs), 'contract') as {
      files: Record<string, Record<string, unknown>>;
    }
  ).files;
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
  const typedDocs = Object.create(null) as Record<ContractFileName, Record<string, unknown>>;
  for (const name of CONTRACT_FILE_NAMES) {
    typedDocs[name] = docs[name] as Record<string, unknown>;
  }
  return {
    digest,
    docs: typedDocs,
    canonicalOutcomes: canonicalList,
    surfaces,
    claims,
    adapters,
    authorityTiers: tiers,
  };
}

/** Read the five contract files and build the contract, fail-closed. */
export function loadObservationContract(contractDir?: string): ObservationContract {
  const resolved = contractDir ?? defaultContractDir();
  const docs: Record<string, unknown> = {};
  for (const name of CONTRACT_FILE_NAMES) {
    const filePath = path.join(resolved, name);
    let raw: string;
    try {
      // Strict fatal decode: Node's lossy 'utf8' mode would silently replace
      // malformed sequences with U+FFFD while Python rejects the same bytes.
      raw = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(filePath));
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
  contract: ObservationContract,
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
  return table.rows[rawValue]!;
}

export function claimRow(contract: ObservationContract, claimId: string): Record<string, unknown> {
  if (!Object.hasOwn(contract.claims, claimId)) {
    throw new ObservationContractPortError(`unknown claim: ${claimId}`);
  }
  return contract.claims[claimId]!;
}

export function adapterRow(
  contract: ObservationContract,
  adapterId: string,
): Record<string, unknown> {
  if (!Object.hasOwn(contract.adapters, adapterId)) {
    throw new ObservationContractPortError(`unknown adapter: ${adapterId}`);
  }
  return contract.adapters[adapterId]!;
}
