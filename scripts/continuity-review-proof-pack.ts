import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { assertNoSecretLike } from './artifact-redaction.ts';
import { buildContinuityReviewProof } from './continuity-review-proof.ts';

const PROOF_FILE = 'continuity-review-proof.json';
const MANIFEST_FILE = 'manifest.json';

interface CliArgs {
  db: string;
  outDir: string;
  help: boolean;
}

interface ProofPackArtifact {
  path: string;
  payloadType: string;
  sha256: string;
  sizeBytes: number;
  secretScan: 'pass';
}

interface ProofPackManifest {
  schemaVersion: 1;
  id: 'whatsoup-continuity-review-proof-pack';
  payloadType: 'continuity-review-proof-pack';
  proofClass: 'artifact-pack';
  sourceLayer: 'durability';
  createdAt: string;
  commandSurface: 'npm run continuity:review-proof-pack';
  artifacts: ProofPackArtifact[];
  limitations: string[];
}

function usage(): string {
  return [
    'Usage: continuity-review-proof-pack.ts --db path/to/bot.db --out-dir proof-pack-dir',
    '',
    'Emits a redaction-safe continuity review proof artifact plus a manifest with',
    'only artifact hash/size metadata. The input DB path is never written.',
  ].join('\n');
}

export function parseArgs(argv: string[], cwd = process.cwd()): CliArgs {
  const args: Partial<CliArgs> = { help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--db') {
      const value = argv[index + 1];
      if (!value) throw new Error('--db requires a path');
      args.db = path.resolve(cwd, value);
      index += 1;
    } else if (arg === '--out-dir') {
      const value = argv[index + 1];
      if (!value) throw new Error('--out-dir requires a path');
      args.outDir = path.resolve(cwd, value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${String(arg)}`);
    }
  }

  if (!args.help && !args.db) throw new Error('--db is required');
  if (!args.help && !args.outDir) throw new Error('--out-dir is required');
  return args as CliArgs;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function writeJsonAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

export function buildContinuityReviewProofPack(args: { db: string }): {
  proofText: string;
  manifest: ProofPackManifest;
} {
  const proof = buildContinuityReviewProof({ db: args.db });
  const proofText = `${JSON.stringify(proof, null, 2)}\n`;
  assertNoSecretLike(proofText, 'continuity review proof pack artifact');

  const artifact: ProofPackArtifact = {
    path: PROOF_FILE,
    payloadType: 'continuity-review-intent-proof',
    sha256: sha256(proofText),
    sizeBytes: Buffer.byteLength(proofText),
    secretScan: 'pass',
  };
  const manifest: ProofPackManifest = {
    schemaVersion: 1,
    id: 'whatsoup-continuity-review-proof-pack',
    payloadType: 'continuity-review-proof-pack',
    proofClass: 'artifact-pack',
    sourceLayer: 'durability',
    createdAt: new Date().toISOString(),
    commandSurface: 'npm run continuity:review-proof-pack',
    artifacts: [artifact],
    limitations: [
      'read-only proof pack for an already-migrated DB copy',
      'does not claim operator review, reply send, live migration, or deployment',
    ],
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  assertNoSecretLike(manifestText, 'continuity review proof pack manifest');
  return { proofText, manifest };
}

export function run(
  argv: string[] = process.argv.slice(2),
  cwd = process.cwd(),
): ProofPackManifest | null {
  try {
    const args = parseArgs(argv, cwd);
    if (args.help) {
      console.log(usage());
      return null;
    }
    const pack = buildContinuityReviewProofPack({ db: args.db });
    const proofPath = path.join(args.outDir, PROOF_FILE);
    const manifestPath = path.join(args.outDir, MANIFEST_FILE);
    const manifestText = `${JSON.stringify(pack.manifest, null, 2)}\n`;
    const diagnostic = `CONTINUITY_REVIEW_PROOF_PACK status=pass artifacts=${pack.manifest.artifacts.length} out=${path.basename(args.outDir)}`;
    assertNoSecretLike(diagnostic, 'continuity review proof pack diagnostics');
    writeJsonAtomic(proofPath, pack.proofText);
    writeJsonAtomic(manifestPath, manifestText);
    console.log(diagnostic);
    return pack.manifest;
  } catch (err) {
    console.error(`continuity review proof pack failed: ${(err as Error).message}`);
    process.exitCode = 1;
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
