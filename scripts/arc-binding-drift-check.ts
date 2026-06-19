import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * ARC binding drift guard.
 *
 * The tracked `.arc/` shim (`arc.toml`, `ARC_BINDING.md`) is generated output of
 * the canonical ARC adopt tool, which lives in the SIBLING agent-runtime-protocol
 * repository (`tools/adopt.py` + `bindings/whatsoup.arc.json`) — NOT in this repo.
 * PR #1274 shipped a stale shim (committed from an old extracted copy instead of
 * regenerated); #1275 fixed it. This guard catches that class.
 *
 * Because the canonical source is a separate repo, this check can only run where
 * that repo is reachable — i.e. at authorship/pre-push time on a machine that has
 * it. In CI (only this repo is checked out) it SKIPs. Resolution order for the
 * ARC repo: `ARC_REPO_DIR` env var, then the sibling `../agent-runtime-protocol`,
 * else skip.
 */

export const CONSUMER = 'whatsoup';
export const ARC_FILES = ['arc.toml', 'ARC_BINDING.md'] as const;

export interface ArcDriftFile {
  file: string;
  trackedShaLine: string;
  canonicalShaLine: string;
}

export interface ArcDriftResult {
  status: 'ok' | 'drift' | 'skip';
  reason?: string;
  arcRepoDir?: string;
  driftedFiles?: ArcDriftFile[];
}

/**
 * Parse `adopt.py <consumer> --print` stdout, which emits each generated file
 * under a `----- <name> -----` banner line:
 *
 *   ----- arc.toml -----
 *   <arc.toml content>
 *   ----- ARC_BINDING.md -----
 *   <ARC_BINDING.md content>
 */
export function parseAdoptPrint(output: string): Record<string, string> {
  const sections: Record<string, string> = {};
  // Capturing split: ['<preamble>', 'arc.toml', '<content>', 'ARC_BINDING.md', '<content>', ...]
  const parts = output.split(/^----- (\S+) -----$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i].trim();
    const content = (parts[i + 1] ?? '').replace(/^\n/, '');
    sections[name] = content;
  }
  return sections;
}

function shaLine(content: string): string {
  const line = content
    .split('\n')
    .find((l) => /payload_sha|Payload SHA/i.test(l));
  return line ? line.trim() : '(no payload_sha line)';
}

/** Resolve the canonical ARC repo dir, or undefined if not locatable. */
export function resolveArcRepoDir(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const candidates = [
    env.ARC_REPO_DIR,
    path.resolve(repoRoot, '..', 'agent-runtime-protocol'),
  ].filter((c): c is string => Boolean(c));
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'tools', 'adopt.py'))) {
      return dir;
    }
  }
  return undefined;
}

export function checkArcBindingDrift(opts: {
  repoRoot: string;
  arcRepoDir?: string;
}): ArcDriftResult {
  const { repoRoot, arcRepoDir } = opts;
  if (!arcRepoDir) {
    return {
      status: 'skip',
      reason:
        'canonical ARC repo not found (set ARC_REPO_DIR or place agent-runtime-protocol as a sibling); cannot verify generated .arc/ — expected in CI',
    };
  }
  const adopt = path.join(arcRepoDir, 'tools', 'adopt.py');
  if (!existsSync(adopt)) {
    return { status: 'skip', reason: `adopt.py not found at ${adopt}`, arcRepoDir };
  }
  let printed: string;
  try {
    printed = execFileSync('python3', [adopt, CONSUMER, '--print'], {
      encoding: 'utf8',
    });
  } catch (err) {
    return {
      status: 'skip',
      reason: `adopt.py invocation failed: ${(err as Error).message}`,
      arcRepoDir,
    };
  }
  const canonical = parseAdoptPrint(printed);
  const driftedFiles: ArcDriftFile[] = [];
  for (const f of ARC_FILES) {
    const trackedPath = path.join(repoRoot, '.arc', f);
    const tracked = existsSync(trackedPath)
      ? readFileSync(trackedPath, 'utf8')
      : '';
    const canon = canonical[f] ?? '';
    if (tracked.trimEnd() !== canon.trimEnd()) {
      driftedFiles.push({
        file: `.arc/${f}`,
        trackedShaLine: shaLine(tracked),
        canonicalShaLine: shaLine(canon),
      });
    }
  }
  if (driftedFiles.length > 0) {
    return { status: 'drift', arcRepoDir, driftedFiles };
  }
  return { status: 'ok', arcRepoDir };
}

export function run(
  _argv: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): ArcDriftResult {
  const arcRepoDir = resolveArcRepoDir(cwd, env);
  const result = checkArcBindingDrift({ repoRoot: cwd, arcRepoDir });
  if (result.status === 'skip') {
    console.warn(`arc-binding-drift check skipped: ${result.reason}`);
  } else if (result.status === 'drift') {
    console.error(
      'ARC binding drift detected — tracked .arc/ does not match canonical adopt.py output:',
    );
    for (const d of result.driftedFiles ?? []) {
      console.error(`  ${d.file}`);
      console.error(`    tracked:   ${d.trackedShaLine}`);
      console.error(`    canonical: ${d.canonicalShaLine}`);
    }
    console.error(
      `Regenerate: python3 ${result.arcRepoDir}/tools/adopt.py ${CONSUMER} --output-dir .arc --force`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `arc-binding-drift check passed (.arc/ matches canonical ARC generator at ${result.arcRepoDir})`,
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
