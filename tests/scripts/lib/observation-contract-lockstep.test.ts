import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { trackTmpDirs } from '../../helpers/tmp-dir.ts';

import {
  CONTRACT_FILE_NAMES,
  MIN_PROJECTION_VALUES,
  ObservationContractPortError,
  adapterRow,
  buildObservationContract,
  claimRow,
  contractDigest,
  contractSnapshot,
  defaultContractDir,
  loadObservationContract,
  projectOutcome,
} from '../../../scripts/lib/observation-contract.ts';

/**
 * Cross-language lockstep proof for task-obs-05 (req-obs-02): the Python
 * contract reader (`deploy/scripts/lib/observation_contract.py`) and the TS
 * port (`scripts/lib/observation-contract.ts`) must derive byte-identical
 * contract digests and identical projection output over the SAME document
 * sets — canonical and adversarial. Follows the lockstep pattern established
 * by `tests/scripts/lib/fleet-roster-inventory.test.ts` and
 * `tests/scripts/lib/capture-runtime-receipt-lockstep.test.ts` (shell out to
 * python3, compare byte-for-byte).
 *
 * Both sides read the SAME committed contract set under
 * `deploy/observation-plane/` so there is one source of truth for the
 * documents under test; adversarial cases mutate the parsed docs in memory
 * and pipe them to Python via stdin, never touching the committed files.
 */

// lib/ -> scripts/ -> tests/ -> repo root
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const libDir = path.join(repoRoot, 'deploy/scripts/lib');
const contractDir = path.join(repoRoot, 'deploy/observation-plane');
const tmp = trackTmpDirs('whatsoup-obs-lockstep-');

function loadCommittedDocs(): Record<string, unknown> {
  const docs: Record<string, unknown> = {};
  for (const name of CONTRACT_FILE_NAMES) {
    docs[name] = JSON.parse(readFileSync(path.join(contractDir, name), 'utf8'));
  }
  return docs;
}

// Runs a small Python program with the parsed docs on stdin and returns its
// stdout. `expr` receives `docs` (parsed) and the imported module as `oc`.
function python(expr: string, docs: Record<string, unknown>): string {
  return execFileSync('python3', ['-c', `
import sys, json
sys.path.insert(0, ${JSON.stringify(libDir)})
import observation_contract as oc
docs = json.loads(sys.stdin.read())
${expr}
`], { input: JSON.stringify(docs), encoding: 'utf8' }).trim();
}

describe('observation_contract.py <-> observation-contract.ts (task-obs-05 cross-language lockstep)', () => {
  it('derives the same contract digest as Python for the committed contract set', () => {
    const docs = loadCommittedDocs();
    const tsDigest = contractDigest(docs);
    const pyDigest = python('sys.stdout.write(oc.contract_digest(docs))', docs);

    expect(tsDigest).toBe(pyDigest);
    expect(tsDigest).toMatch(/^[0-9a-f]{64}$/);
    // The file loaders bind to the same bytes.
    expect(loadObservationContract(contractDir).digest).toBe(tsDigest);
  });

  it('projects every declared legacy value identically to Python', () => {
    const docs = loadCommittedDocs();
    const contract = buildObservationContract(docs);
    const tsMatrix: Record<string, Record<string, { canonical: string; lossy: boolean }>> = {};
    for (const [surfaceName, surface] of Object.entries(contract.surfaces)) {
      tsMatrix[surfaceName] = {};
      for (const member of surface.domain) {
        const row = projectOutcome(contract, surfaceName, member);
        tsMatrix[surfaceName][member] = { canonical: row.canonical, lossy: row.lossy };
      }
    }
    const pyMatrix = python(
      `
contract = oc.build_contract(docs)
matrix = {}
for surface_name, surface in contract["surfaces"].items():
    matrix[surface_name] = {}
    for member in surface["domain"]:
        row = oc.project_outcome(contract, surface_name, member)
        matrix[surface_name][member] = {"canonical": row["canonical"], "lossy": row["lossy"]}
sys.stdout.write(json.dumps(matrix, sort_keys=True, separators=(",", ":")))
`,
      docs,
    );

    // Structure-equal across languages, over at least the 8 closed surfaces.
    expect(JSON.parse(pyMatrix)).toEqual(tsMatrix);
    expect(Object.keys(tsMatrix).length).toBeGreaterThanOrEqual(8);
  });

  it('stays in lockstep on content mutation (digest moves identically on both sides)', () => {
    const docs = loadCommittedDocs();
    const baselineTs = contractDigest(docs);
    const mutated = JSON.parse(JSON.stringify(docs)) as Record<string, unknown>;
    const projections = mutated['outcome-projections.json'] as {
      surfaces: Record<string, { rows: Array<Record<string, unknown>> }>;
    };
    const firstSurface = Object.values(projections.surfaces)[0]!;
    firstSurface.rows[0]!['lossy'] = !firstSurface.rows[0]!['lossy'];

    const tsDigest = contractDigest(mutated);
    const pyDigest = python('sys.stdout.write(oc.contract_digest(docs))', mutated);

    expect(tsDigest).toBe(pyDigest);
    expect(tsDigest).not.toBe(baselineTs);
  });

  it('stays in lockstep on non-ASCII content (python ensure_ascii escaping)', () => {
    const docs = loadCommittedDocs();
    const mutated = JSON.parse(JSON.stringify(docs)) as Record<string, unknown>;
    (mutated['authority-lattice.json'] as Record<string, unknown>)['description'] =
      'unicode lockstep: état sévère — 健康 \u{1f9ea}';

    const tsDigest = contractDigest(mutated);
    const pyDigest = python('sys.stdout.write(oc.contract_digest(docs))', mutated);

    expect(tsDigest).toBe(pyDigest);
  });

  it('fails closed identically on an out-of-domain legacy value', () => {
    const docs = loadCommittedDocs();
    const contract = buildObservationContract(docs);
    expect(() => projectOutcome(contract, 'probe_report_verdict', 'outside-the-domain')).toThrow(
      ObservationContractPortError,
    );
    const pyResult = python(
      `
contract = oc.build_contract(docs)
try:
    oc.project_outcome(contract, "probe_report_verdict", "outside-the-domain")
    sys.stdout.write("no-error")
except oc.ObservationContractError:
    sys.stdout.write("failed-closed")
`,
      docs,
    );
    expect(pyResult).toBe('failed-closed');
  });

  it('fails closed identically on prototype-chain lookup keys', () => {
    // JS inherits toString/constructor/__proto__ on every plain object; the
    // reader's lookups must treat them as ordinary unknown keys, exactly like
    // Python — never return an inherited function, never throw a raw TypeError.
    const docs = loadCommittedDocs();
    const contract = buildObservationContract(docs);
    for (const key of ['toString', 'constructor', '__proto__']) {
      expect(() => claimRow(contract, key)).toThrow(ObservationContractPortError);
      expect(() => adapterRow(contract, key)).toThrow(ObservationContractPortError);
      expect(() => projectOutcome(contract, key, 'x')).toThrow(ObservationContractPortError);
      expect(() => projectOutcome(contract, 'probe_report_verdict', key)).toThrow(
        ObservationContractPortError,
      );
    }
    const pyResult = python(
      `
contract = oc.build_contract(docs)
failed = 0
for key in ("toString", "constructor", "__proto__"):
    for probe in (
        lambda: oc.claim_row(contract, key),
        lambda: oc.adapter_row(contract, key),
        lambda: oc.project_outcome(contract, key, "x"),
        lambda: oc.project_outcome(contract, "probe_report_verdict", key),
    ):
        try:
            probe()
        except oc.ObservationContractError:
            failed += 1
sys.stdout.write(str(failed))
`,
      docs,
    );
    expect(pyResult).toBe('12');
  });

  it('rejects a domain member named after a prototype key when its row is missing', () => {
    // Build-side hole: `member in rows` is true for 'toString' via the
    // prototype chain, so a non-total table could slip through on the TS side.
    const docs = loadCommittedDocs();
    const mutated = JSON.parse(JSON.stringify(docs)) as Record<string, unknown>;
    const projections = mutated['outcome-projections.json'] as {
      surfaces: Record<string, { domain: string[] }>;
    };
    projections.surfaces['probe_report_verdict']!.domain.push('toString');

    expect(() => buildObservationContract(mutated)).toThrow(ObservationContractPortError);
    const pyResult = python(
      `
try:
    oc.build_contract(docs)
    sys.stdout.write("no-error")
except oc.ObservationContractError:
    sys.stdout.write("failed-closed")
`,
      mutated,
    );
    expect(pyResult).toBe('failed-closed');
  });

  it('rejects non-integer numbers from the digest domain identically', () => {
    // Python repr(1e-07) and JS String(1e-7) disagree, so floats are outside
    // the digest domain: both sides must fail closed instead of diverging.
    const docs = loadCommittedDocs();
    const mutated = JSON.parse(JSON.stringify(docs)) as Record<string, unknown>;
    (mutated['authority-lattice.json'] as Record<string, unknown>)['drift_epsilon'] = 1e-7;

    expect(() => contractDigest(mutated)).toThrow(ObservationContractPortError);
    const pyResult = python(
      `
try:
    oc.contract_digest(docs)
    sys.stdout.write("no-error")
except oc.ObservationContractError:
    sys.stdout.write("failed-closed")
`,
      mutated,
    );
    expect(pyResult).toBe('failed-closed');
  });

  it('rejects unsafe-range integers from the digest domain identically', () => {
    const docs = loadCommittedDocs();
    const mutated = JSON.parse(JSON.stringify(docs)) as Record<string, unknown>;
    (mutated['authority-lattice.json'] as Record<string, unknown>)['counter'] = 2 ** 53;

    expect(() => contractDigest(mutated)).toThrow(ObservationContractPortError);
    const pyResult = python(
      `
try:
    oc.contract_digest(docs)
    sys.stdout.write("no-error")
except oc.ObservationContractError:
    sys.stdout.write("failed-closed")
`,
      mutated,
    );
    expect(pyResult).toBe('failed-closed');

    const boundary = JSON.parse(JSON.stringify(docs)) as Record<string, unknown>;
    (boundary['authority-lattice.json'] as Record<string, unknown>)['counter'] = 2 ** 53 - 1;
    const tsDigest = contractDigest(boundary);
    const pyDigest = python('sys.stdout.write(oc.contract_digest(docs))', boundary);
    expect(tsDigest).toBe(pyDigest);
  });

  it('rejects non-BMP object keys from the digest domain identically', () => {
    // Key ordering is code-point-sorted in Python and code-unit-sorted in JS;
    // the orders disagree beyond the BMP, so such keys must fail closed.
    const docs = loadCommittedDocs();
    const mutated = JSON.parse(JSON.stringify(docs)) as Record<string, unknown>;
    (mutated['authority-lattice.json'] as Record<string, unknown>)['\u{10000}'] = true;

    expect(() => contractDigest(mutated)).toThrow(ObservationContractPortError);
    const pyResult = python(
      `
try:
    oc.contract_digest(docs)
    sys.stdout.write("no-error")
except oc.ObservationContractError:
    sys.stdout.write("failed-closed")
`,
      mutated,
    );
    expect(pyResult).toBe('failed-closed');
  });

  it('accepts and rejects the same raw numeric literals on both sides (acceptance parity)', () => {
    // req-obs-02 demands identical ACCEPTANCE, not merely divergence-freedom.
    // JS JSON.parse normalizes integral literals (1.0, 1e0, -0) to integers
    // before any reader code runs; Python canonicalizes integral floats to the
    // same integers, so every raw form lands on one digest — or both sides
    // fail closed.
    const docs = loadCommittedDocs();
    const digestFor = (raw: string): string => {
      const mutated = JSON.parse(JSON.stringify(docs)) as Record<string, unknown>;
      (mutated['authority-lattice.json'] as Record<string, unknown>)['ratio'] = JSON.parse(raw);
      return contractDigest(mutated);
    };
    const pyDigestFor = (raw: string): string =>
      python(
        `
docs["authority-lattice.json"]["ratio"] = json.loads(${JSON.stringify(raw)})
try:
    sys.stdout.write(oc.contract_digest(docs))
except oc.ObservationContractError:
    sys.stdout.write("failed-closed")
`,
        docs,
      );

    const canonical = digestFor('1');
    for (const raw of ['1', '1.0', '1e0']) {
      expect(digestFor(raw)).toBe(canonical);
      expect(pyDigestFor(raw)).toBe(canonical);
    }
    const zero = digestFor('0');
    for (const raw of ['0', '-0', '-0.0']) {
      expect(digestFor(raw)).toBe(zero);
      expect(pyDigestFor(raw)).toBe(zero);
    }
    for (const raw of ['1e-7', '0.5', '9007199254740992', '1e100', '1e400']) {
      expect(() => digestFor(raw)).toThrow(ObservationContractPortError);
      expect(pyDigestFor(raw)).toBe('failed-closed');
    }
  });

  it('rejects nested non-BMP object keys identically', () => {
    const docs = loadCommittedDocs();
    const mutated = JSON.parse(JSON.stringify(docs)) as Record<string, unknown>;
    (mutated['authority-lattice.json'] as Record<string, unknown>)['nested'] = [
      { '\u{10000}': true },
    ];
    expect(() => contractDigest(mutated)).toThrow(ObservationContractPortError);
    const pyResult = python(
      `
try:
    oc.contract_digest(docs)
    sys.stdout.write("no-error")
except oc.ObservationContractError:
    sys.stdout.write("failed-closed")
`,
      mutated,
    );
    expect(pyResult).toBe('failed-closed');
  });

  it('rejects invalid UTF-8 contract bytes identically at load time', () => {
    // Node's lossy 'utf8' decode replaces malformed sequences with U+FFFD;
    // Python raises. Both loaders must fail closed on the SAME bytes with
    // their contract error — never a raw decode exception, never acceptance.
    const dir = tmp.make('utf8');
    for (const name of CONTRACT_FILE_NAMES) {
      writeFileSync(path.join(dir, name), readFileSync(path.join(contractDir, name)));
    }
    const target = path.join(dir, 'authority-lattice.json');
    const raw = readFileSync(target);
    const brace = raw.indexOf(0x7b);
    writeFileSync(
      target,
      Buffer.concat([
        raw.subarray(0, brace + 1),
        Buffer.from('"probe": "', 'utf8'),
        Buffer.from([0xc3, 0x28]),
        Buffer.from('", ', 'utf8'),
        raw.subarray(brace + 1),
      ]),
    );

    expect(() => loadObservationContract(dir)).toThrow(ObservationContractPortError);
    const pyResult = execFileSync('python3', ['-c', `
import sys
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(libDir)})
import observation_contract as oc
try:
    oc.load_contract(Path(${JSON.stringify(dir)}))
    sys.stdout.write("no-error")
except oc.ObservationContractError:
    sys.stdout.write("failed-closed")
`], { encoding: 'utf8' }).trim();
    expect(pyResult).toBe('failed-closed');
  });

  it('builds __proto__ identifiers as ordinary own keys identically', () => {
    // Python dicts give __proto__ no special meaning; the TS accumulators
    // must not let it pollute a prototype or vanish from the table.
    const docs = loadCommittedDocs();
    const mutated = JSON.parse(JSON.stringify(docs)) as Record<string, unknown>;
    (mutated['adapter-registry.json'] as { adapters: unknown[] }).adapters.push(
      JSON.parse(
        '{"adapter_id": "__proto__", "wraps": ["probe fixture"], "platforms": ["darwin"],' +
          ' "privilege": "none", "prerequisites": [], "projection_scope": "not_applicable",' +
          ' "can_establish": [], "cannot_establish": [], "status": "producer_pending"}',
      ),
    );
    const contract = buildObservationContract(mutated);
    expect(Object.hasOwn(contract.adapters, '__proto__')).toBe(true);
    expect(adapterRow(contract, '__proto__')['adapter_id']).toBe('__proto__');

    const pyResult = python(
      `
contract = oc.build_contract(docs)
row = oc.adapter_row(contract, "__proto__")
sys.stdout.write(row["adapter_id"])
`,
      mutated,
    );
    expect(pyResult).toBe('__proto__');
  });

  it('returns canonically normalized documents on both sides (raw -0)', () => {
    // Digest parity alone is not enough: returned data must match too.
    // Python normalizes -0.0 to int 0; TS must return 0, not negative zero.
    const docs = loadCommittedDocs();
    const mutated = JSON.parse(JSON.stringify(docs)) as Record<string, unknown>;
    (mutated['authority-lattice.json'] as Record<string, unknown>)['ratio'] = JSON.parse('-0');
    const contract = buildObservationContract(mutated);
    const ratio = (contract.docs['authority-lattice.json'] as Record<string, unknown>)['ratio'];
    expect(Object.is(ratio, -0)).toBe(false);
    expect(ratio).toBe(0);

    const pyResult = python(
      `
docs["authority-lattice.json"]["ratio"] = json.loads("-0.0")
contract = oc.build_contract(docs)
value = contract["docs"]["authority-lattice.json"]["ratio"]
sys.stdout.write(f"{type(value).__name__}:{value}")
`,
      mutated,
    );
    expect(pyResult).toBe('int:0');
  });

  it('rejects an unsupported schema_version identically at build time', () => {
    const docs = loadCommittedDocs();
    const mutated = JSON.parse(JSON.stringify(docs)) as Record<string, unknown>;
    (mutated['claim-catalog.json'] as Record<string, unknown>)['schema_version'] = '999';

    expect(() => buildObservationContract(mutated)).toThrow(ObservationContractPortError);
    const pyResult = python(
      `
try:
    oc.build_contract(docs)
    sys.stdout.write("no-error")
except oc.ObservationContractError:
    sys.stdout.write("failed-closed")
`,
      mutated,
    );
    expect(pyResult).toBe('failed-closed');
  });

  it('rejects an unknown min_projection identically at build time', () => {
    // "diagnotic" must never silently weaken projection authority.
    const docs = loadCommittedDocs();
    const mutated = JSON.parse(JSON.stringify(docs)) as Record<string, unknown>;
    const claims = (mutated['claim-catalog.json'] as { claims: Array<Record<string, unknown>> })
      .claims;
    claims[0]!['min_projection'] = 'diagnotic';

    expect(() => buildObservationContract(mutated)).toThrow(ObservationContractPortError);
    const pyResult = python(
      `
try:
    oc.build_contract(docs)
    sys.stdout.write("no-error")
except oc.ObservationContractError:
    sys.stdout.write("failed-closed")
`,
      mutated,
    );
    expect(pyResult).toBe('failed-closed');
  });

  it('rejects a BOM-prefixed contract document identically at load time', () => {
    // TextDecoder strips a leading BOM by default; Python's json rejects the
    // same bytes. The BOM is outside the accepted byte domain on BOTH sides.
    const dir = tmp.make('bom');
    for (const name of CONTRACT_FILE_NAMES) {
      writeFileSync(path.join(dir, name), readFileSync(path.join(contractDir, name)));
    }
    const target = path.join(dir, 'authority-lattice.json');
    writeFileSync(target, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(target)]));

    expect(() => loadObservationContract(dir)).toThrow(ObservationContractPortError);
    const pyResult = execFileSync('python3', ['-c', `
import sys
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(libDir)})
import observation_contract as oc
try:
    oc.load_contract(Path(${JSON.stringify(dir)}))
    sys.stdout.write("no-error")
except oc.ObservationContractError:
    sys.stdout.write("failed-closed")
`], { encoding: 'utf8' }).trim();
    expect(pyResult).toBe('failed-closed');
  });

  it('returns defensive copies from lookups on both sides', () => {
    // Digest-bound state must not be mutable through the lookup API.
    const docs = loadCommittedDocs();
    const contract = buildObservationContract(docs);
    const row = claimRow(contract, 'identity.instance_name');
    const original = row['min_projection'];
    row['min_projection'] = 'public';
    expect(claimRow(contract, 'identity.instance_name')['min_projection']).toBe(original);

    const pyResult = python(
      `
contract = oc.build_contract(docs)
row = oc.claim_row(contract, "identity.instance_name")
original = row["min_projection"]
row["min_projection"] = "public"
sys.stdout.write(str(oc.claim_row(contract, "identity.instance_name")["min_projection"] == original))
`,
      docs,
    );
    expect(pyResult).toBe('True');
  });

  it('freezes the TS contract and rejects non-JSON programmatic values', () => {
    // TS-only guarantees aligning the programmatic surface to the parsed-JSON
    // domain: undefined and sparse arrays cannot come from JSON.parse and
    // must not enter the digest; returned structure is deep-frozen.
    const docs = loadCommittedDocs();

    const withUndefined = JSON.parse(JSON.stringify(docs)) as Record<string, unknown>;
    (withUndefined['authority-lattice.json'] as Record<string, unknown>)['x'] = undefined;
    expect(() => contractDigest(withUndefined)).toThrow(ObservationContractPortError);

    const withSparse = JSON.parse(JSON.stringify(docs)) as Record<string, unknown>;
    const sparse = [1, 2, 3];
    delete sparse[1];
    (withSparse['authority-lattice.json'] as Record<string, unknown>)['xs'] = sparse;
    expect(() => contractDigest(withSparse)).toThrow(ObservationContractPortError);

    const contract = buildObservationContract(docs);
    expect(Object.isFrozen(contract)).toBe(true);
    expect(() => {
      (contract.canonicalOutcomes as string[]).push('tampered');
    }).toThrow();
    expect(() => {
      (contract.claims['identity.instance_name'] as Record<string, unknown>)['min_projection'] =
        'public';
    }).toThrow();
  });

  it('denies direct mutation of digest-bound state on both sides', () => {
    const docs = loadCommittedDocs();
    const contract = buildObservationContract(docs);
    expect(() => {
      (contract.claims['auth_bond.status'] as Record<string, unknown>)['min_projection'] =
        'public';
    }).toThrow();

    const pyResult = python(
      `
contract = oc.build_contract(docs)
try:
    contract["claims"]["auth_bond.status"]["min_projection"] = "public"
    sys.stdout.write("mutated")
except TypeError:
    sys.stdout.write("denied")
`,
      docs,
    );
    expect(pyResult).toBe('denied');
  });

  it('exports only immutable authority vocabulary objects', () => {
    // A mutable exported Set would let any importer widen the accepted
    // vocabulary (MIN_PROJECTIONS.add('diagnotic')) and poison validation.
    expect(Object.isFrozen(MIN_PROJECTION_VALUES)).toBe(true);
    expect(() => {
      (MIN_PROJECTION_VALUES as unknown as string[]).push('diagnotic');
    }).toThrow();
    expect(Object.isFrozen(CONTRACT_FILE_NAMES)).toBe(true);

    const docs = loadCommittedDocs();
    const mutated = JSON.parse(JSON.stringify(docs)) as Record<string, unknown>;
    (mutated['claim-catalog.json'] as { claims: Array<Record<string, unknown>> }).claims[0]![
      'min_projection'
    ] = 'diagnotic';
    expect(() => buildObservationContract(mutated)).toThrow(ObservationContractPortError);
  });

  it('produces byte-identical whole-contract snapshots on both sides', () => {
    // The frozen/proxied contract representations differ across languages;
    // the official snapshot operation must return plain JSON-compatible
    // copies with identical canonical bytes.
    const docs = loadCommittedDocs();
    const contract = buildObservationContract(docs);
    const snapshot = contractSnapshot(contract);
    // Plain JSON-compatible: serializes without error, mutable, detached.
    const serialized = JSON.stringify(snapshot);
    expect(serialized.length).toBeGreaterThan(0);
    (snapshot as { digest: string }).digest = 'tampered';
    expect(contract.digest).not.toBe('tampered');

    const tsCanonical = execFileSync('python3', ['-c', `
import sys, json
data = json.loads(sys.stdin.read())
sys.stdout.write(json.dumps(data, sort_keys=True, separators=(",", ":")))
`], { input: JSON.stringify(contractSnapshot(contract)), encoding: 'utf8' }).trim();
    const pyCanonical = python(
      `
contract = oc.build_contract(docs)
snapshot = oc.contract_snapshot(contract)
json.dumps(snapshot)  # plain JSON-compatible on this side too
sys.stdout.write(json.dumps(snapshot, sort_keys=True, separators=(",", ":")))
`,
      docs,
    );
    expect(tsCanonical).toBe(pyCanonical);
  });

  it('rejects direct contract mutation at the type level', () => {
    const docs = loadCommittedDocs();
    const contract = buildObservationContract(docs);
    expect(() => {
      // @ts-expect-error -- deliberate negative assertion: digest-bound state is deep-readonly at compile time; expires 2099-12-31
      contract.digest = 'tampered';
    }).toThrow();
    expect(() => {
      // @ts-expect-error -- deliberate negative assertion: frozen array cannot be pushed to; expires 2099-12-31
      contract.canonicalOutcomes.push('tampered');
    }).toThrow();
    expect(() => {
      // @ts-expect-error -- deliberate negative assertion: nested claim rows are readonly; expires 2099-12-31
      contract.claims['identity.instance_name']['min_projection'] = 'public';
    }).toThrow();
  });

  it('holds the Array.isArray narrowing escape at runtime (documented type-level limit)', () => {
    // Boundary of the compile-time guarantee, pinned deliberately:
    // `Array.isArray` is unsound for readonly arrays — it narrows even a
    // `readonly T[]` to a mutable array, so a `.push` behind that guard
    // type-checks no matter how the payload is typed. deepFreeze is the
    // authority on this path: the write throws at runtime.
    const contract = buildObservationContract(loadCommittedDocs());
    const producers = contract.claims['identity.instance_name']!['producing_adapters'];
    expect(Array.isArray(producers)).toBe(true);
    if (Array.isArray(producers)) {
      expect(() => producers.push('tampered')).toThrow();
    }
    const docClaims = contract.docs['claim-catalog.json']['claims'];
    if (Array.isArray(docClaims)) {
      expect(() => docClaims.push({ claim_id: 'tampered' })).toThrow();
    }
    // Lookups and the snapshot are the sanctioned mutable paths.
    expect(Array.isArray(contractSnapshot(contract).docs['claim-catalog.json']['claims'])).toBe(
      true,
    );
    expect(claimRow(contract, 'identity.instance_name')['producing_adapters']).toEqual(producers);
  });

  it('rejects missing or invalid authority metadata identically', () => {
    // Closed-world authority model: both readers must refuse a contract whose
    // governed authority fields are absent, misspelled, or asymmetric.
    const docs = loadCommittedDocs();
    const mutations: Array<[string, (d: Record<string, unknown>) => void]> = [
      ['missing claim.authority_tier', (d) => {
        delete (d['claim-catalog.json'] as { claims: Array<Record<string, unknown>> }).claims[0]!['authority_tier'];
      }],
      ['missing claim.staleness_rule', (d) => {
        delete (d['claim-catalog.json'] as { claims: Array<Record<string, unknown>> }).claims[0]!['staleness_rule'];
      }],
      ['bad claim.generation_binding', (d) => {
        (d['claim-catalog.json'] as { claims: Array<Record<string, unknown>> }).claims[0]!['generation_binding'] = 'proccess';
      }],
      ['bad adapter.projection_scope', (d) => {
        (d['adapter-registry.json'] as { adapters: Array<Record<string, unknown>> }).adapters[0]!['projection_scope'] = 'diagnotic';
      }],
      ['missing adapter.status', (d) => {
        delete (d['adapter-registry.json'] as { adapters: Array<Record<string, unknown>> }).adapters[0]!['status'];
      }],
      ['producer asymmetry', (d) => {
        const claims = (d['claim-catalog.json'] as { claims: Array<Record<string, unknown>> }).claims;
        const claim = claims[0]!;
        const producer = (claim['producing_adapters'] as string[])[0]!;
        for (const adapter of (d['adapter-registry.json'] as { adapters: Array<Record<string, unknown>> }).adapters) {
          if (adapter['adapter_id'] === producer) {
            adapter['can_establish'] = (adapter['can_establish'] as string[]).filter(
              (c) => c !== claim['claim_id'],
            );
          }
        }
      }],
    ];

    for (const [label, mutate] of mutations) {
      const mutated = JSON.parse(JSON.stringify(docs)) as Record<string, unknown>;
      mutate(mutated);
      expect(() => buildObservationContract(mutated), label).toThrow(ObservationContractPortError);
      const pyResult = python(
        `
try:
    oc.build_contract(docs)
    sys.stdout.write("no-error")
except oc.ObservationContractError:
    sys.stdout.write("failed-closed")
`,
        mutated,
      );
      expect(pyResult, label).toBe('failed-closed');
    }
  });

  it('closes the staleness-rule vocabulary and window policy identically', () => {
    // `window_seconds` is CONDITIONAL on `kind`: required-and-positive for
    // fixed_window, prohibited for every other declared kind. Each case is
    // asserted immediately below, at, and above the boundary, and BOTH readers
    // must land on the same verdict — an accept/reject split here is a
    // divergent contract, not a cosmetic difference.
    //
    // The integral-float case (`86400.0`) cannot ride this channel:
    // JSON.stringify collapses it to `86400` before Python ever sees it, so
    // its parity is asserted in deploy/scripts/tests/test_observation_contract.py.
    const docs = loadCommittedDocs();
    const cases: Array<[string, unknown, 'accept' | 'reject']> = [
      ['null window on event_bound', { kind: 'event_bound', window_seconds: null }, 'reject'],
      ['window prohibited on event_bound', { kind: 'event_bound', window_seconds: 3600 }, 'reject'],
      ['window prohibited on scheduler_deadline', { kind: 'scheduler_deadline', window_seconds: 3600 }, 'reject'],
      ['fixed_window missing window', { kind: 'fixed_window' }, 'reject'],
      ['fixed_window zero', { kind: 'fixed_window', window_seconds: 0 }, 'reject'],
      ['fixed_window negative', { kind: 'fixed_window', window_seconds: -1 }, 'reject'],
      ['fixed_window one (lower bound)', { kind: 'fixed_window', window_seconds: 1 }, 'accept'],
      ['fixed_window max safe integer', { kind: 'fixed_window', window_seconds: Number.MAX_SAFE_INTEGER }, 'accept'],
      ['fixed_window above safe integer', { kind: 'fixed_window', window_seconds: Number.MAX_SAFE_INTEGER + 1 }, 'reject'],
      ['fixed_window fractional', { kind: 'fixed_window', window_seconds: 86400.5 }, 'reject'],
      ['fixed_window boolean', { kind: 'fixed_window', window_seconds: true }, 'reject'],
      ['fixed_window string', { kind: 'fixed_window', window_seconds: '86400' }, 'reject'],
      ['hyphenated kind', { kind: 'fixed-window', window_seconds: 86400 }, 'reject'],
      ['uppercased kind', { kind: 'FIXED_WINDOW', window_seconds: 86400 }, 'reject'],
      ['kind outside the closed vocabulary', { kind: 'bounded' }, 'reject'],
      ['undeclared property', { kind: 'event_bound', surprise: 1 }, 'reject'],
      ['non-string note', { kind: 'event_bound', note: 7 }, 'reject'],
      ['string note', { kind: 'event_bound', note: 'ok' }, 'accept'],
      ['bare event_bound', { kind: 'event_bound' }, 'accept'],
      ['bare scheduler_deadline', { kind: 'scheduler_deadline' }, 'accept'],
      ['fixed_window with note', { kind: 'fixed_window', window_seconds: 86400, note: 'n' }, 'accept'],
    ];

    for (const [label, rule, want] of cases) {
      const mutated = JSON.parse(JSON.stringify(docs)) as Record<string, unknown>;
      (mutated['claim-catalog.json'] as { claims: Array<Record<string, unknown>> }).claims[0]![
        'staleness_rule'
      ] = rule;

      if (want === 'reject') {
        expect(() => buildObservationContract(mutated), label).toThrow(ObservationContractPortError);
      } else {
        expect(() => buildObservationContract(mutated), label).not.toThrow();
      }

      const pyResult = python(
        `
try:
    oc.build_contract(docs)
    sys.stdout.write("no-error")
except oc.ObservationContractError:
    sys.stdout.write("failed-closed")
`,
        mutated,
      );
      expect(pyResult, label).toBe(want === 'reject' ? 'failed-closed' : 'no-error');
    }
  });

  it('keeps malformed governed scalars inside the documented error class in both readers', () => {
    // Round 7. Both readers already REJECTED these inputs, but the rejection
    // escaped the documented taxonomy as a raw TypeError:
    //   Python — `x in frozenset` raises on an unhashable dict/list, before any
    //            type check ran.
    //   TS     — `String(value)` on a NULL-PROTOTYPE object (exactly what
    //            normalizeForDigest builds) throws "Cannot convert object to
    //            primitive value"; arrays survived because they keep
    //            Array.prototype. That asymmetry made the two readers disagree
    //            on WHICH inputs escaped.
    // A caller cannot classify evidence as invalid_evidence if the reader can
    // raise an uncategorized crash, so the exact class is the assertion.
    const docs = loadCommittedDocs();
    const fields: Array<[string, string, string]> = [
      ['claim-catalog.json', 'claims', 'min_projection'],
      ['claim-catalog.json', 'claims', 'authority_tier'],
      ['claim-catalog.json', 'claims', 'generation_binding'],
      ['adapter-registry.json', 'adapters', 'projection_scope'],
      ['adapter-registry.json', 'adapters', 'status'],
    ];
    const wrongTypes: Array<[string, unknown]> = [
      ['null', null],
      ['object', { a: 1 }],
      ['array', [1]],
      ['bool', true],
      ['number', 5],
      ['invalid_string', 'definitely-not-a-declared-value'],
    ];

    for (const [doc, coll, field] of fields) {
      for (const [label, value] of wrongTypes) {
        const mutated = JSON.parse(JSON.stringify(docs)) as Record<string, unknown>;
        (mutated[doc] as Record<string, Array<Record<string, unknown>>>)[coll]![0]![field] = value;
        const where = `${doc}:${field}=${label}`;

        // Exact class — `toThrow()` alone would pass on the TypeError this fixes.
        expect(() => buildObservationContract(mutated), where).toThrow(ObservationContractPortError);

        // Python must reach the same verdict through its own documented class.
        // `except oc.ObservationContractError` deliberately does NOT catch
        // TypeError, so an escape surfaces as a non-zero exit, not "failed-closed".
        const pyResult = python(
          `
try:
    oc.build_contract(docs)
    sys.stdout.write("no-error")
except oc.ObservationContractError:
    sys.stdout.write("failed-closed")
`,
          mutated,
        );
        expect(pyResult, where).toBe('failed-closed');
      }
    }
  });

  it('anchors the TS default contract dir to the module, not the cwd', () => {
    // Python's default_contract_dir is module-anchored; the TS default must
    // resolve the same directory from ANY working directory.
    const expected = path.join(repoRoot, 'deploy', 'observation-plane');
    const before = process.cwd();
    try {
      process.chdir(path.parse(before).root);
      expect(path.resolve(defaultContractDir())).toBe(path.resolve(expected));
    } finally {
      process.chdir(before);
    }
  });

  it('rejects a non-total projection table identically at build time', () => {
    const docs = loadCommittedDocs();
    const mutated = JSON.parse(JSON.stringify(docs)) as Record<string, unknown>;
    const projections = mutated['outcome-projections.json'] as {
      surfaces: Record<string, { rows: Array<Record<string, unknown>> }>;
    };
    projections.surfaces['probe_report_verdict']!.rows.shift();

    expect(() => buildObservationContract(mutated)).toThrow(ObservationContractPortError);
    const pyResult = python(
      `
try:
    oc.build_contract(docs)
    sys.stdout.write("no-error")
except oc.ObservationContractError:
    sys.stdout.write("failed-closed")
`,
      mutated,
    );
    expect(pyResult).toBe('failed-closed');
  });
});
