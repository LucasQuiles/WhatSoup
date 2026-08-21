import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  CONTRACT_FILE_NAMES,
  ObservationContractPortError,
  adapterRow,
  buildObservationContract,
  claimRow,
  contractDigest,
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
    for (const raw of ['1e-7', '0.5', '9007199254740992', '1e100']) {
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
