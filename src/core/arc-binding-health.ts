import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_REPO_ROOT = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));

export interface ArcBindingHealthLoaded {
  loaded: true;
  consumer: string;
  arcVersion: string;
  modules: string[];
  emits: string[];
  binding: string;
  payloadSha: string;
}

export interface ArcBindingHealthMissing {
  loaded: false;
  reason: string;
}

export type ArcBindingHealth = ArcBindingHealthLoaded | ArcBindingHealthMissing;

export function resolveArcRepoRoot(
  env: { WHATSOUP_REPO_ROOT?: string } = process.env,
  reviewedRoot = SOURCE_REPO_ROOT,
): string | null {
  try {
    const canonicalReviewedRoot = realpathSync(reviewedRoot);
    const explicitRoot = env.WHATSOUP_REPO_ROOT?.trim();
    if (!explicitRoot) return canonicalReviewedRoot;
    return realpathSync(explicitRoot) === canonicalReviewedRoot
      ? canonicalReviewedRoot
      : null;
  } catch {
    return null;
  }
}

function parseStringLine(text: string, key: string): string {
  const prefix = `${key} = "`;
  const line = text.split('\n').find((entry) => entry.startsWith(prefix));
  if (!line || !line.endsWith('"')) throw new Error(`${key} missing`);
  return line.slice(prefix.length, -1);
}

function parseStringArrayLine(text: string, key: string): string[] {
  const prefix = `${key} = [`;
  const line = text.split('\n').find((entry) => entry.startsWith(prefix));
  if (!line || !line.endsWith(']')) throw new Error(`${key} missing`);
  const raw = line.slice(prefix.length, -1).trim();
  if (!raw) return [];
  return raw.split(',').map((part) => {
    const trimmed = part.trim();
    if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) {
      throw new Error(`${key} has invalid item`);
    }
    return trimmed.slice(1, -1);
  });
}

function safeReason(err: unknown): string {
  const reason = err instanceof Error ? err.message : 'unknown error';
  return reason.replace(/[^A-Za-z0-9_.: -]/g, '_');
}

export function readArcBindingHealth(repoRoot: string | null = SOURCE_REPO_ROOT): ArcBindingHealth {
  try {
    if (repoRoot === null) return { loaded: false, reason: 'repository root invalid' };
    const arcToml = path.join(repoRoot, '.arc', 'arc.toml');
    if (!existsSync(arcToml)) return { loaded: false, reason: '.arc/arc.toml missing' };
    const text = readFileSync(arcToml, 'utf8');
    return {
      loaded: true,
      arcVersion: parseStringLine(text, 'arc_version'),
      consumer: parseStringLine(text, 'consumer'),
      modules: parseStringArrayLine(text, 'modules'),
      emits: parseStringArrayLine(text, 'emits'),
      binding: parseStringLine(text, 'binding'),
      payloadSha: parseStringLine(text, 'payload_sha'),
    };
  } catch (err) {
    return { loaded: false, reason: safeReason(err) };
  }
}
