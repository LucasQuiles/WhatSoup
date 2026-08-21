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

export function defaultContractDir(cwd = process.cwd()): string {
  return path.join(cwd, 'deploy', 'observation-plane');
}

/** Mirrors `observation_contract.py:contract_identity` — the five parsed
 * documents keyed by file name. */
export function contractIdentity(docs: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(docs)) {
    throw new ObservationContractPortError('contract docs must be a mapping');
  }
  const missing = CONTRACT_FILE_NAMES.filter((name) => !(name in docs));
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

/** `sha256(json.dumps(contract_identity(docs), sort_keys=True, separators=(",",":")))`,
 * identical call shape to the Python side. */
export function contractDigest(docs: Record<string, unknown>): string {
  const material = pyJsonStringify(contractIdentity(docs));
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
  const surfaces: Record<string, ContractSurface> = {};
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
    const rows: Record<string, ProjectionRow> = {};
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
      if (legacyValue in rows) {
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
      if (!(member in rows)) {
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
  const keyed: Record<string, Record<string, unknown>> = {};
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry[key] !== 'string' || entry[key].length === 0) {
      throw new ObservationContractPortError(`${what} entry missing ${key}`);
    }
    const id = entry[key];
    if (id in keyed) {
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
  const typedDocs = {} as Record<ContractFileName, Record<string, unknown>>;
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
      raw = readFileSync(filePath, 'utf8');
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
  const table = contract.surfaces[surface];
  if (!table) {
    throw new ObservationContractPortError(`unknown legacy surface: ${surface}`);
  }
  const row = table.rows[rawValue];
  if (!row) {
    throw new ObservationContractPortError(
      `legacy value outside the declared domain of ${surface}: ${rawValue}`,
    );
  }
  return row;
}

export function claimRow(contract: ObservationContract, claimId: string): Record<string, unknown> {
  const row = contract.claims[claimId];
  if (!row) {
    throw new ObservationContractPortError(`unknown claim: ${claimId}`);
  }
  return row;
}

export function adapterRow(
  contract: ObservationContract,
  adapterId: string,
): Record<string, unknown> {
  const row = contract.adapters[adapterId];
  if (!row) {
    throw new ObservationContractPortError(`unknown adapter: ${adapterId}`);
  }
  return row;
}
