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
 * Two layers, with different reachability requirements:
 *
 *  1. Vendored-sha pin (ALWAYS runs, no sibling repo needed). The canonical
 *     payload sha is committed at `.arc/.canonical-sha`. The pin check asserts
 *     that the pin, the `payload_sha` line in `.arc/arc.toml`, and the `Payload
 *     SHA` line in `.arc/ARC_BINDING.md` all agree. A stale `.arc/` (the #1274
 *     regression class) disagrees with the pin and is HARD-BLOCKED — this is what
 *     enforces in CI, where only this repo is checked out.
 *
 *  2. Full byte-for-byte content comparison against the live `adopt.py` generator
 *     (runs ONLY when the sibling repo is reachable). This additionally proves the
 *     non-sha bytes match, AND cross-checks the vendored pin against the freshly
 *     generated sha so the pin itself cannot silently go stale.
 *
 * Resolution order for the ARC repo: `ARC_REPO_DIR` env var, then the sibling
 * `../agent-runtime-protocol`, else the full content comparison is skipped (but
 * the vendored-pin check still runs and can still report drift). Net: in CI the
 * status is `ok`/`drift`, never a blanket `skip`.
 */

export const CONSUMER = 'whatsoup';
export const ARC_FILES = ['arc.toml', 'ARC_BINDING.md'] as const;
export const CANONICAL_SHA_FILE = '.arc/.canonical-sha';

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
  /** Human-readable lines describing vendored-pin drift, if any. */
  pinDrift?: string[];
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

/**
 * Extract the bare `sha256:...` token from any of: a raw pin line, an
 * `arc.toml` `payload_sha = "..."` line, or an `ARC_BINDING.md`
 * `- Payload SHA: \`...\`` line. Returns undefined if no sha token is present.
 */
export function extractSha(text: string): string | undefined {
  const m = text.match(/sha256:[0-9a-f]+/i);
  return m ? m[0].toLowerCase() : undefined;
}

/**
 * Vendored-sha pin check. Runs with NO sibling repo: reads the committed pin,
 * the `arc.toml` payload_sha, and the `ARC_BINDING.md` Payload SHA, and asserts
 * all three agree. This hard-blocks a stale `.arc/` in CI. Pure/testable.
 */
export function checkVendoredSha(opts: { repoRoot: string }): ArcDriftResult {
  const { repoRoot } = opts;

  const pinPath = path.join(repoRoot, CANONICAL_SHA_FILE);
  if (!existsSync(pinPath)) {
    return {
      status: 'drift',
      pinDrift: [
        `missing vendored pin ${CANONICAL_SHA_FILE} — cannot verify .arc/ without it`,
      ],
    };
  }
  const pinSha = extractSha(readFileSync(pinPath, 'utf8'));
  if (!pinSha) {
    return {
      status: 'drift',
      pinDrift: [`vendored pin ${CANONICAL_SHA_FILE} has no sha256: token`],
    };
  }

  const drift: string[] = [];
  for (const f of ARC_FILES) {
    const trackedPath = path.join(repoRoot, '.arc', f);
    if (!existsSync(trackedPath)) {
      drift.push(`.arc/${f} missing`);
      continue;
    }
    const content = readFileSync(trackedPath, 'utf8');
    const fileSha = extractSha(shaLine(content));
    if (!fileSha) {
      drift.push(`.arc/${f} has no payload sha line`);
    } else if (fileSha !== pinSha) {
      drift.push(
        `.arc/${f} sha ${fileSha} != vendored pin ${pinSha} (${CANONICAL_SHA_FILE})`,
      );
    }
  }

  if (drift.length > 0) {
    return { status: 'drift', pinDrift: drift };
  }
  return { status: 'ok' };
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

  // Layer 1 — ALWAYS runs, no sibling repo required. This is the CI hard-block.
  const pin = checkVendoredSha({ repoRoot });

  // Layer 2 — full byte-for-byte content comparison against the live generator.
  // Only available when the sibling ARC repo is reachable. When unreachable we
  // do NOT skip the whole guard; we return the pin result (ok or drift) so CI
  // still enforces.
  if (!arcRepoDir) {
    if (pin.status === 'drift') {
      return pin;
    }
    return { status: 'ok' };
  }
  const adopt = path.join(arcRepoDir, 'tools', 'adopt.py');
  if (!existsSync(adopt)) {
    if (pin.status === 'drift') {
      return { ...pin, arcRepoDir };
    }
    return { status: 'ok', arcRepoDir };
  }
  let printed: string;
  try {
    printed = execFileSync('python3', [adopt, CONSUMER, '--print'], {
      encoding: 'utf8',
    });
  } catch (err) {
    if (pin.status === 'drift') {
      return { ...pin, arcRepoDir };
    }
    return {
      status: 'skip',
      reason: `adopt.py invocation failed: ${(err as Error).message}`,
      arcRepoDir,
    };
  }
  const canonical = parseAdoptPrint(printed);

  // Cross-check the vendored pin against the freshly generated sha so the pin
  // cannot silently go stale.
  const pinDrift: string[] = [...(pin.pinDrift ?? [])];
  const pinPath = path.join(repoRoot, CANONICAL_SHA_FILE);
  const pinSha = existsSync(pinPath)
    ? extractSha(readFileSync(pinPath, 'utf8'))
    : undefined;
  const genSha = extractSha(shaLine(canonical['arc.toml'] ?? ''));
  if (genSha && pinSha && genSha !== pinSha) {
    pinDrift.push(
      `vendored pin ${CANONICAL_SHA_FILE} (${pinSha}) != adopt.py generated sha (${genSha}) — update .arc/.canonical-sha`,
    );
  }

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
  if (driftedFiles.length > 0 || pinDrift.length > 0) {
    return {
      status: 'drift',
      arcRepoDir,
      ...(driftedFiles.length > 0 ? { driftedFiles } : {}),
      ...(pinDrift.length > 0 ? { pinDrift } : {}),
    };
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
      'ARC binding drift detected — tracked .arc/ does not match canonical ARC binding:',
    );
    for (const line of result.pinDrift ?? []) {
      console.error(`  vendored-pin: ${line}`);
    }
    for (const d of result.driftedFiles ?? []) {
      console.error(`  ${d.file}`);
      console.error(`    tracked:   ${d.trackedShaLine}`);
      console.error(`    canonical: ${d.canonicalShaLine}`);
    }
    if (result.arcRepoDir) {
      console.error(
        `Regenerate: python3 ${result.arcRepoDir}/tools/adopt.py ${CONSUMER} --output-dir .arc --force` +
          ` (then update ${CANONICAL_SHA_FILE} to the new payload sha)`,
      );
    } else {
      console.error(
        `The tracked .arc/ payload sha disagrees with the vendored pin ${CANONICAL_SHA_FILE}.` +
          ` Regenerate .arc/ from the canonical ARC adopt tool and align the pin.`,
      );
    }
    process.exitCode = 1;
  } else if (result.arcRepoDir) {
    console.log(
      `arc-binding-drift check passed (.arc/ matches canonical ARC generator at ${result.arcRepoDir})`,
    );
  } else {
    console.log(
      `arc-binding-drift check passed (vendored sha pin ${CANONICAL_SHA_FILE} matches tracked .arc/; full content check skipped — sibling agent-runtime-protocol not reachable)`,
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
