#!/usr/bin/env node
// Observation-plane contract guard: validates the governed data set under
// deploy/observation-plane/ — schema compiles, vocabularies stay closed,
// projection tables stay total over their declared domains, cross-references
// resolve, golden fixtures validate, and counterexample fixtures stay rejected.
// Data-only contract: this guard never reads runtime state.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';

import { isRecord } from '../src/lib/type-guards.ts';
import { contractDigest } from './lib/observation-contract.ts';

export const CONTRACT_DIR = 'deploy/observation-plane';

export type ObservationContractFindingCode =
  | 'contract-unreadable'
  | 'schema-compile-error'
  | 'canonical-vocab-mismatch'
  | 'digest-domain-violation'
  | 'unsupported-schema-version'
  | 'malformed-entry'
  | 'projection-domain-incomplete'
  | 'projection-domain-extra'
  | 'projection-duplicate-row'
  | 'projection-bad-canonical'
  | 'unknown-claim-reference'
  | 'unknown-adapter-reference'
  | 'unknown-tier-reference'
  | 'duplicate-claim'
  | 'duplicate-adapter'
  | 'requires-unknown-claim'
  | 'legacy-surface-unknown'
  | 'valid-fixture-rejected'
  | 'invalid-fixture-accepted'
  | 'fixture-unreadable';

export interface ObservationContractFinding {
  code: ObservationContractFindingCode;
  message: string;
}

export interface ObservationContractResult {
  ok: boolean;
  findings: ObservationContractFinding[];
  counts: {
    claims: number;
    adapters: number;
    surfaces: number;
    validFixtures: number;
    invalidFixtures: number;
  };
}

interface ClaimRow {
  claimId: string;
  minProjection: string;
  authorityTier: string;
  producingAdapters: string[];
  requires: string[];
  cannotEstablish: string[];
}

interface AdapterRow {
  adapterId: string;
  canEstablish: string[];
  cannotEstablish: string[];
}

const VERDICT_OUTCOMES = new Set(['pass', 'fail']);
const UNRESOLVED_ALLOWED_OUTCOMES = new Set(['context_mismatch', 'invalid_evidence']);

function readJson(root: string, rel: string, findings: ObservationContractFinding[]): unknown {
  const abs = path.join(root, CONTRACT_DIR, rel);
  let raw: string;
  try {
    // Strict fatal decode, matching both contract readers: lossy 'utf8' mode
    // would admit bytes the Python reader rejects.
    raw = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(abs));
  } catch (err) {
    findings.push({ code: 'contract-unreadable', message: `${rel}: ${(err as Error).message}` });
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    findings.push({ code: 'contract-unreadable', message: `${rel}: invalid JSON (${(err as Error).message})` });
    return undefined;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Like stringArray, but a malformed member is a FINDING, not a silent skip —
 * filtering would let a tampered registry read as clean. */
function strictStringArray(
  value: unknown,
  what: string,
  findings: ObservationContractFinding[],
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    findings.push({ code: 'malformed-entry', message: `${what}: expected a list` });
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
    else findings.push({ code: 'malformed-entry', message: `${what}: non-string member ${String(item)}` });
  }
  return out;
}

function hasDotDotSegment(ref: string): boolean {
  return ref.split('/').includes('..');
}

function envelopeSemanticFindings(
  envelope: Record<string, unknown>,
  claims: Map<string, ClaimRow>,
  adapters: Map<string, AdapterRow>,
  surfaces: Map<string, Set<string>>,
): string[] {
  const problems: string[] = [];
  const claimId = typeof envelope.claim_id === 'string' ? envelope.claim_id : '';
  const adapterId = typeof envelope.adapter_id === 'string' ? envelope.adapter_id : '';
  const outcome = typeof envelope.outcome === 'string' ? envelope.outcome : '';

  const claim = claims.get(claimId);
  if (!claim) problems.push(`claim_id ${claimId} not in catalog`);
  const adapter = adapters.get(adapterId);
  if (!adapter) problems.push(`adapter_id ${adapterId} not in registry`);
  if (claim && adapter && !adapter.canEstablish.includes(claimId)) {
    problems.push(`adapter ${adapterId} does not declare claim ${claimId} in can_establish`);
  }

  const projection = isRecord(envelope.projection) ? envelope.projection : undefined;
  const scope = projection && typeof projection.scope === 'string' ? projection.scope : '';
  if (claim && VERDICT_OUTCOMES.has(outcome)) {
    if (claim.minProjection === 'diagnostic' && scope !== 'diagnostic') {
      problems.push(`claim ${claimId} requires diagnostic projection for a verdict; scope=${scope} (F01)`);
    }
    if (claim.minProjection === 'public' && scope !== 'public' && scope !== 'diagnostic') {
      problems.push(`claim ${claimId} requires at least public projection for a verdict; scope=${scope}`);
    }
  }

  const subject = isRecord(envelope.subject) ? envelope.subject : undefined;
  const binding = subject && isRecord(subject.binding) ? subject.binding : undefined;
  if (binding && binding.authority === 'unresolved' && !UNRESOLVED_ALLOWED_OUTCOMES.has(outcome)) {
    problems.push(`unresolved subject binding may only carry context_mismatch/invalid_evidence; outcome=${outcome} (amendment 1)`);
  }

  if (Array.isArray(envelope.evidence_refs)) {
    for (const ref of envelope.evidence_refs) {
      if (isRecord(ref) && typeof ref.ref === 'string' && hasDotDotSegment(ref.ref)) {
        problems.push(`evidence ref contains a '..' segment: ${ref.ref}`);
      }
    }
  }

  const legacy = isRecord(envelope.legacy) ? envelope.legacy : undefined;
  if (legacy && typeof legacy.surface === 'string') {
    const domain = surfaces.get(legacy.surface);
    if (!domain) {
      problems.push(`legacy.surface ${legacy.surface} not in outcome-projections`);
    } else if (typeof legacy.raw_value === 'string' && !domain.has(legacy.raw_value)) {
      problems.push(`legacy.raw_value ${legacy.raw_value} outside declared domain of ${legacy.surface}`);
    }
  }
  return problems;
}

export function checkObservationContract(cwd = process.cwd()): ObservationContractResult {
  const findings: ObservationContractFinding[] = [];
  const counts = { claims: 0, adapters: 0, surfaces: 0, validFixtures: 0, invalidFixtures: 0 };

  const schemaDoc = readJson(cwd, 'envelope.schema.json', findings);
  const catalogDoc = readJson(cwd, 'claim-catalog.json', findings);
  const projectionsDoc = readJson(cwd, 'outcome-projections.json', findings);
  const latticeDoc = readJson(cwd, 'authority-lattice.json', findings);
  const registryDoc = readJson(cwd, 'adapter-registry.json', findings);
  if (!isRecord(schemaDoc) || !isRecord(catalogDoc) || !isRecord(projectionsDoc) || !isRecord(latticeDoc) || !isRecord(registryDoc)) {
    return { ok: false, findings, counts };
  }

  // Governed contract data must stay inside the cross-language digest domain
  // (req-obs-02): the reader's contractDigest enforces it and both readers
  // must accept the exact bytes this guard admits.
  try {
    contractDigest({
      'adapter-registry.json': registryDoc,
      'authority-lattice.json': latticeDoc,
      'claim-catalog.json': catalogDoc,
      'envelope.schema.json': schemaDoc,
      'outcome-projections.json': projectionsDoc,
    });
  } catch (err) {
    findings.push({ code: 'digest-domain-violation', message: (err as Error).message });
  }

  // Data documents must carry a supported schema_version — an unknown version
  // means the guard's checks may not describe the document's semantics.
  const SUPPORTED_SCHEMA_VERSION = '0.1';
  const versioned: Array<[string, Record<string, unknown>]> = [
    ['adapter-registry.json', registryDoc],
    ['authority-lattice.json', latticeDoc],
    ['claim-catalog.json', catalogDoc],
    ['outcome-projections.json', projectionsDoc],
  ];
  for (const [rel, doc] of versioned) {
    if (doc.schema_version !== SUPPORTED_SCHEMA_VERSION) {
      findings.push({
        code: 'unsupported-schema-version',
        message: `${rel}: schema_version ${String(doc.schema_version)} != supported ${SUPPORTED_SCHEMA_VERSION}`,
      });
    }
  }

  const ajv = new Ajv2020({ allErrors: true, strict: true });
  let validate: ((data: unknown) => boolean) & { errors?: unknown[] | null };
  try {
    validate = ajv.compile(schemaDoc as object) as typeof validate;
  } catch (err) {
    findings.push({ code: 'schema-compile-error', message: (err as Error).message });
    return { ok: false, findings, counts };
  }

  const props = isRecord(schemaDoc.properties) ? schemaDoc.properties : {};
  const outcomeProp = isRecord(props.outcome) ? props.outcome : {};
  const schemaOutcomes = new Set(stringArray(outcomeProp.enum));
  const canonicalOutcomes = new Set(stringArray(projectionsDoc.canonical_outcomes));
  if (
    schemaOutcomes.size === 0 ||
    schemaOutcomes.size !== canonicalOutcomes.size ||
    [...schemaOutcomes].some((value) => !canonicalOutcomes.has(value))
  ) {
    findings.push({
      code: 'canonical-vocab-mismatch',
      message: `envelope outcome enum [${[...schemaOutcomes].join(',')}] != canonical_outcomes [${[...canonicalOutcomes].join(',')}]`,
    });
  }

  // Authority tiers.
  const latticeTiers = new Set<string>();
  if (Array.isArray(latticeDoc.tiers)) {
    for (const tier of latticeDoc.tiers) {
      if (isRecord(tier) && typeof tier.tier === 'string') latticeTiers.add(tier.tier);
    }
  }

  // Claim catalog.
  const claims = new Map<string, ClaimRow>();
  if (Array.isArray(catalogDoc.claims)) {
    for (const entry of catalogDoc.claims) {
      if (!isRecord(entry) || typeof entry.claim_id !== 'string') {
        findings.push({ code: 'malformed-entry', message: 'claim catalog: entry missing claim_id' });
        continue;
      }
      if (claims.has(entry.claim_id)) {
        findings.push({ code: 'duplicate-claim', message: entry.claim_id });
        continue;
      }
      claims.set(entry.claim_id, {
        claimId: entry.claim_id,
        minProjection: typeof entry.min_projection === 'string' ? entry.min_projection : 'not_applicable',
        authorityTier: typeof entry.authority_tier === 'string' ? entry.authority_tier : '',
        producingAdapters: strictStringArray(entry.producing_adapters, `claim ${entry.claim_id} producing_adapters`, findings),
        requires: strictStringArray(entry.requires, `claim ${entry.claim_id} requires`, findings),
        cannotEstablish: strictStringArray(entry.cannot_establish, `claim ${entry.claim_id} cannot_establish`, findings),
      });
    }
  }
  counts.claims = claims.size;

  // Adapter registry.
  const adapters = new Map<string, AdapterRow>();
  if (Array.isArray(registryDoc.adapters)) {
    for (const entry of registryDoc.adapters) {
      if (!isRecord(entry) || typeof entry.adapter_id !== 'string') {
        findings.push({ code: 'malformed-entry', message: 'adapter registry: entry missing adapter_id' });
        continue;
      }
      if (adapters.has(entry.adapter_id)) {
        findings.push({ code: 'duplicate-adapter', message: entry.adapter_id });
        continue;
      }
      adapters.set(entry.adapter_id, {
        adapterId: entry.adapter_id,
        canEstablish: strictStringArray(entry.can_establish, `adapter ${entry.adapter_id} can_establish`, findings),
        cannotEstablish: strictStringArray(entry.cannot_establish, `adapter ${entry.adapter_id} cannot_establish`, findings),
      });
    }
  }
  counts.adapters = adapters.size;

  // Cross-references.
  for (const claim of claims.values()) {
    if (claim.authorityTier && !latticeTiers.has(claim.authorityTier)) {
      findings.push({ code: 'unknown-tier-reference', message: `${claim.claimId}: ${claim.authorityTier}` });
    }
    for (const adapterId of claim.producingAdapters) {
      if (!adapters.has(adapterId)) {
        findings.push({ code: 'unknown-adapter-reference', message: `${claim.claimId}: ${adapterId}` });
      }
    }
    for (const required of claim.requires) {
      if (!claims.has(required)) {
        findings.push({ code: 'requires-unknown-claim', message: `${claim.claimId}: ${required}` });
      }
    }
    for (const other of claim.cannotEstablish) {
      if (!claims.has(other)) {
        findings.push({ code: 'unknown-claim-reference', message: `${claim.claimId} cannot_establish ${other}` });
      }
    }
  }
  for (const adapter of adapters.values()) {
    for (const claimId of [...adapter.canEstablish, ...adapter.cannotEstablish]) {
      if (!claims.has(claimId)) {
        findings.push({ code: 'unknown-claim-reference', message: `${adapter.adapterId}: ${claimId}` });
      }
    }
  }

  // Projection tables: total over declared domain, closed canonical values.
  const surfaces = new Map<string, Set<string>>();
  const surfacesDoc = isRecord(projectionsDoc.surfaces) ? projectionsDoc.surfaces : {};
  for (const [surfaceName, surface] of Object.entries(surfacesDoc)) {
    if (!isRecord(surface)) {
      findings.push({ code: 'malformed-entry', message: `surface ${surfaceName}: not an object` });
      continue;
    }
    const domain = strictStringArray(surface.domain, `surface ${surfaceName} domain`, findings);
    surfaces.set(surfaceName, new Set(domain));
    const seen = new Set<string>();
    const rows = Array.isArray(surface.rows) ? surface.rows : [];
    for (const row of rows) {
      if (!isRecord(row) || typeof row.legacy_value !== 'string') continue;
      if (seen.has(row.legacy_value)) {
        findings.push({ code: 'projection-duplicate-row', message: `${surfaceName}: ${row.legacy_value}` });
      }
      seen.add(row.legacy_value);
      if (!domain.includes(row.legacy_value)) {
        findings.push({ code: 'projection-domain-extra', message: `${surfaceName}: ${row.legacy_value}` });
      }
      if (typeof row.canonical !== 'string' || !canonicalOutcomes.has(row.canonical)) {
        findings.push({ code: 'projection-bad-canonical', message: `${surfaceName}: ${row.legacy_value} -> ${String(row.canonical)}` });
      }
    }
    for (const member of domain) {
      if (!seen.has(member)) {
        findings.push({ code: 'projection-domain-incomplete', message: `${surfaceName}: missing row for ${member}` });
      }
    }
  }
  counts.surfaces = surfaces.size;

  // Legacy-surface closure: the schema's legacy.surface enum and the projection
  // tables must name exactly the same surfaces. An enum member without a table is
  // admitted evidence no projection can canonicalize; a table without an enum
  // member canonicalizes evidence the schema refuses to admit.
  const legacyProp = isRecord(props.legacy) ? props.legacy : {};
  const legacyProps = isRecord(legacyProp.properties) ? legacyProp.properties : {};
  const surfaceProp = isRecord(legacyProps.surface) ? legacyProps.surface : {};
  const schemaSurfaces = new Set(stringArray(surfaceProp.enum));
  for (const surface of schemaSurfaces) {
    if (!surfaces.has(surface)) {
      findings.push({
        code: 'legacy-surface-unknown',
        message: `schema legacy.surface enum admits '${surface}' but outcome-projections.json has no table for it`,
      });
    }
  }
  for (const surface of surfaces.keys()) {
    if (!schemaSurfaces.has(surface)) {
      findings.push({
        code: 'legacy-surface-unknown',
        message: `outcome-projections.json defines table '${surface}' but the schema legacy.surface enum does not admit it`,
      });
    }
  }

  // Fixtures.
  const fixtureDir = (kind: 'valid' | 'invalid'): string[] => {
    try {
      return readdirSync(path.join(cwd, CONTRACT_DIR, 'fixtures', kind))
        .filter((name) => name.endsWith('.json'))
        .sort();
    } catch (err) {
      findings.push({ code: 'fixture-unreadable', message: `fixtures/${kind}: ${(err as Error).message}` });
      return [];
    }
  };

  for (const name of fixtureDir('valid')) {
    const doc = readJson(cwd, path.join('fixtures/valid', name), findings);
    if (!isRecord(doc)) continue;
    counts.validFixtures += 1;
    const schemaOk = validate(doc);
    const schemaErrors = schemaOk ? [] : (validate.errors ?? []).map((e) => JSON.stringify(e));
    const semantic = envelopeSemanticFindings(doc, claims, adapters, surfaces);
    if (!schemaOk || semantic.length > 0) {
      findings.push({
        code: 'valid-fixture-rejected',
        message: `fixtures/valid/${name}: ${[...schemaErrors.slice(0, 2), ...semantic].join('; ')}`,
      });
    }
  }

  for (const name of fixtureDir('invalid')) {
    const doc = readJson(cwd, path.join('fixtures/invalid', name), findings);
    if (!isRecord(doc)) continue;
    counts.invalidFixtures += 1;
    const schemaOk = validate(doc);
    const semantic = envelopeSemanticFindings(doc, claims, adapters, surfaces);
    if (schemaOk && semantic.length === 0) {
      findings.push({ code: 'invalid-fixture-accepted', message: `fixtures/invalid/${name} passed every check` });
    }
  }

  return { ok: findings.length === 0, findings, counts };
}

export function run(): ObservationContractResult {
  const result = checkObservationContract(process.cwd());
  if (!result.ok) {
    console.error('observation contract guard failed');
    for (const item of result.findings) {
      console.error(`${item.code}: ${item.message}`);
    }
    process.exitCode = 1;
  } else {
    console.log(
      `observation contract guard passed (${result.counts.claims} claim(s), ${result.counts.adapters} adapter(s), ${result.counts.surfaces} surface(s), ${result.counts.validFixtures}+${result.counts.invalidFixtures} fixture(s))`,
    );
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
