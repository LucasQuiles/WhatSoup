/**
 * Resolver-artifact verification (round-18 finding 1; round-19 findings 1+2).
 *
 * Round 17 INFERRED the resolver artifact from the execution argv (skip a leading
 * interpreter, hash the first path token). A reviewer proved that unsound with two
 * bypasses: `perl -eCODE <decoy>` verified the decoy while perl ran inline code, and a
 * symlink named `watch-resolver` → node was hashed as node while a script argument
 * actually executed. Argv cannot be classified without executing it, so the executing
 * artifact must be declared EXPLICITLY and the command shape VALIDATED against that
 * declaration — never inferred.
 *
 * Round 18 declared the artifact explicitly but attested only the artifact's CONTENT
 * digest and did not RE-COMPARE it (or the command shape) at the drain seam. A reviewer
 * proved two fail-opens: (a) replacing the artifact's bytes at the same path after
 * attestation executed the replacement (content swap); (b) the D5 binding excluded the
 * command/interpreter/mode, so a post-attest shape change (extra arg, swapped
 * interpreter) still admitted.
 *
 * Round 19 closes both by making the attested `resolverDigest` a COMPOSITE over the
 * artifact CONTENT digest AND the canonical execution SHAPE, and by RE-COMPARING that
 * composite at the drain seam against the attested value (`options.attestation
 * .resolverDigest`). A content swap OR a shape change both change the live composite and
 * are refused before any spawn. The interpreter-mislabel bypass is refused STRUCTURALLY.
 *
 * The operator declares, on `execution`:
 *   - `resolverArtifactPath`: the file whose CONTENT is the resolver code.
 *   - `interpreted`: true  → `command = [interpreter, <artifact>, ...dataArgs]`
 *                     false → `command = [<artifact>, ...dataArgs]` (directly executable)
 *
 * RESIDUALS (named, not silently closed):
 *  - A wrapper SCRIPT declared as the direct artifact that itself execs an interpreter on
 *    an uncovered code file: its own bytes are attested, but the code it shells out to is
 *    not. That is a config-integrity limit, not a decoy bypass — the declared artifact
 *    still IS command[0]. Full closure is the typed-enum contract (Option C).
 *  - TOCTOU: the artifact is hashed by realpath, then executed; a same-path in-place write
 *    between hash and spawn is narrowed (not eliminated) by the executor's hardlink pin
 *    (round-19 finding 3). Full closure is content-addressed execution (Option C).
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename } from 'node:path';

export interface ResolverArtifactDeclaration {
  command: readonly string[];
  /** Explicit path to the resolver's code artifact; null/absent ⇒ unverifiable ⇒ refuse. */
  resolverArtifactPath?: string | null;
  /** true ⇒ command[0] is an interpreter and the artifact is command[1]; false ⇒ command[0] is the artifact. */
  interpreted?: boolean | null;
}

export interface VerifiedResolverArtifact {
  declaredPath: string;
  realpath: string;
  /** sha256 of the artifact's CONTENT (the bytes of the executing code file). */
  contentDigest: string;
  /** sha256 over [contentDigest, canonicalExecutionIdentity] — the value the attestation binds. */
  compositeDigest: string;
  interpreted: boolean;
}

/**
 * Basenames that identify a language interpreter. Used to REFUSE an `interpreted:false`
 * declaration whose "direct artifact" actually resolves to an interpreter (round-19
 * finding 2: a `watch-resolver`→node symlink declared direct would otherwise attest
 * node's bytes while a script argument executed). Versioned names (python3.12, node24)
 * are caught by the regex fallback in `isInterpreterName`.
 */
const INTERPRETER_BASENAMES = new Set([
  'node', 'nodejs', 'deno', 'bun',
  'python', 'python2', 'python3',
  'perl', 'ruby', 'php', 'lua',
  'sh', 'bash', 'zsh', 'dash', 'ksh',
  'rscript', 'osascript', 'tclsh', 'awk', 'gawk', 'mawk',
]);

function isInterpreterName(name: string): boolean {
  const lower = name.toLowerCase();
  if (INTERPRETER_BASENAMES.has(lower)) return true;
  // Versioned interpreter binaries: python3.12, node24, ruby3.3, perl5, php8.2, deno1, bun1.
  return /^(python|node|nodejs|ruby|perl|php|deno|bun)[0-9][0-9.]*$/.test(lower);
}

/**
 * Validate the deny-by-default declaration shape common to `canonicalExecutionIdentity`
 * and `verifyResolverArtifact`. Both require an explicit artifact path and an explicit
 * interpreted flag; neither is ever inferred.
 */
function requireDeclaration(
  execution: ResolverArtifactDeclaration,
): { command: readonly string[]; interpreted: boolean; declaredPath: string } {
  const { command } = execution;
  if (command.length === 0) throw new Error('refusing: resolver command is empty — nothing to verify');
  const declaredPath = execution.resolverArtifactPath;
  if (declaredPath === undefined || declaredPath === null || declaredPath.length === 0) {
    throw new Error('refusing: execution.resolverArtifactPath is required — the resolver artifact must be declared explicitly, never inferred from argv');
  }
  if (execution.interpreted === undefined || execution.interpreted === null) {
    throw new Error('refusing: execution.interpreted is required — declare whether command[0] is an interpreter (artifact = command[1]) or the artifact itself');
  }
  return { command, interpreted: execution.interpreted, declaredPath };
}

/**
 * The ONE canonical serialization of the execution SHAPE (round-19 findings 1+2,
 * advisor-mandated single canonicalizer). EVERY site that folds execution identity into
 * the attested `resolverDigest` composite MUST derive it from THIS function; a per-byte
 * divergence between sites would break the `drain_attestation_digest == admitting binding
 * digest` invariant (r14-F1) and make every group approval PERMANENTLY unclaimable — a
 * silent fail-closed break, not a test failure.
 *
 * Positional array (never an object) so key order can never defeat or forge a match. The
 * `command` array already contains the artifact path (command[1] when interpreted,
 * command[0] when direct) and the `{source}` argument template, so binding
 * `[command, interpreted]` binds shape + mode + artifact path + argument template with no
 * redundant, separately-canonicalized field. Requires the deny-by-default declaration.
 */
export function canonicalExecutionIdentity(execution: ResolverArtifactDeclaration): string {
  const { command, interpreted } = requireDeclaration(execution);
  return JSON.stringify([[...command], interpreted]);
}

/**
 * The composite the attestation binds: artifact CONTENT digest folded with the canonical
 * execution SHAPE identity. A content swap changes `contentDigest`; a shape change (extra
 * arg, swapped interpreter, changed template) changes the identity — either changes this
 * value, so the drain-seam equality check refuses both.
 */
export function resolverCompositeDigest(contentDigest: string, execution: ResolverArtifactDeclaration): string {
  return createHash('sha256')
    .update(JSON.stringify([contentDigest, canonicalExecutionIdentity(execution)]))
    .digest('hex');
}

/**
 * Deny-by-default verification of the declared resolver artifact. Resolves the declared
 * artifact's realpath (must be a regular readable file), requires that realpath to BE the
 * token that executes (command[0] when direct; EXACTLY command[1] — no tokens between the
 * interpreter and the script, and command[1] may not be a flag — when interpreted),
 * refuses an `interpreted:false` artifact that is itself an interpreter (mislabel), and
 * returns the artifact CONTENT digest plus the COMPOSITE the attestation binds. Any
 * mismatch, missing declaration, flag-at-script-position, extra pre-script token, or
 * interpreter mislabel throws.
 */
export function verifyResolverArtifact(execution: ResolverArtifactDeclaration): VerifiedResolverArtifact {
  const { command, interpreted, declaredPath } = requireDeclaration(execution);

  // The declared artifact must resolve to a real, regular, readable file.
  let artifactReal: string;
  try {
    artifactReal = realpathSync(declaredPath);
  } catch (err) {
    throw new Error(`refusing: resolver artifact ${declaredPath} is not resolvable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!statSync(artifactReal).isFile()) {
    throw new Error(`refusing: resolver artifact ${declaredPath} (realpath ${artifactReal}) is not a regular file`);
  }

  // The declared artifact must BE the token the command executes.
  const realpathOf = (token: string, label: string): string => {
    try {
      return realpathSync(token);
    } catch (err) {
      throw new Error(`refusing: ${label} ${token} is not resolvable: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  if (interpreted) {
    if (command.length < 2) throw new Error('refusing: interpreted resolver command needs an interpreter AND a script argument');
    const scriptToken = command[1]!;
    if (scriptToken.startsWith('-')) {
      throw new Error(`refusing: interpreted resolver command[1] "${scriptToken}" is a flag, not the declared script — inline-code / flag injection (e.g. \`-e\`, \`-eCODE\`) is refused`);
    }
    if (realpathOf(scriptToken, 'interpreted resolver command[1]') !== artifactReal) {
      throw new Error(`refusing: interpreted resolver command[1] realpath does not equal declared resolverArtifactPath realpath ${artifactReal} — the verified file is not the one that executes`);
    }
    // command[0] is the interpreter; its binary identity is not the resolver CODE and is
    // covered by dependency_versions, so it is intentionally not hashed here.
  } else {
    if (realpathOf(command[0]!, 'direct resolver command[0]') !== artifactReal) {
      throw new Error(`refusing: direct resolver command[0] realpath does not equal declared resolverArtifactPath realpath ${artifactReal} — the verified file is not the one that executes`);
    }
    // round-19 finding 2: a "direct" artifact that IS an interpreter is a MISLABEL — its
    // bytes would be attested while a following script argument actually runs. Refuse.
    if (isInterpreterName(basename(artifactReal))) {
      throw new Error(`refusing: resolver declared interpreted:false but the artifact realpath basename "${basename(artifactReal)}" is a known interpreter — declare interpreted:true with the script as command[1] (mislabel refused)`);
    }
  }

  const contentDigest = createHash('sha256').update(readFileSync(artifactReal)).digest('hex');
  const compositeDigest = resolverCompositeDigest(contentDigest, execution);
  return { declaredPath, realpath: artifactReal, contentDigest, compositeDigest, interpreted };
}
