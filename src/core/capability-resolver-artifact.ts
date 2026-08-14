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
import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';

export interface ResolverArtifactDeclaration {
  command: readonly string[];
  /** Explicit path to the resolver's code artifact; null/absent ⇒ unverifiable ⇒ refuse. */
  resolverArtifactPath?: string | null;
  /** true ⇒ command[0] is an interpreter and the artifact is command[1]; false ⇒ command[0] is the artifact. */
  interpreted?: boolean | null;
  /** round-20: the execution ENVELOPE — bound into the canonical identity (both affect acceptance). */
  timeoutMs?: number | null;
  minOutputBytes?: number | null;
}

export interface VerifiedResolverArtifact {
  declaredPath: string;
  realpath: string;
  /** sha256 of the artifact's CONTENT (the bytes of the executing code file). Informational. */
  contentDigest: string;
  /** round-20: canonical content manifest of the artifact's whole DIRECTORY (artifact + siblings). */
  manifestDigest: string;
  /**
   * round-20: sha256 of the INTERPRETER binary (command[0]) when interpreted; null in direct
   * mode. Folded into the composite so a same-path interpreter-content swap is refused.
   */
  interpreterDigest: string | null;
  /** Realpath of the interpreter binary when interpreted (the token that actually executes); null in direct mode. */
  interpreterRealpath: string | null;
  /** sha256 over [contentDigest, manifestDigest, interpreterDigest, canonicalExecutionIdentity] — the value the attestation binds. */
  compositeDigest: string;
  interpreted: boolean;
}

/**
 * round-20 findings 1+3: a CONTENT-ADDRESSED, immutable staging of the resolver for
 * verify==execute BY CONSTRUCTION. The artifact's whole directory is copied into a fresh
 * private staging root (0700, unpredictable, single-use), the COPY is re-hashed, and only the
 * COPY is executed — so a rename or in-place write to the original AFTER verification cannot
 * substitute unverified bytes (the round-19 hardlink shared the inode and re-resolved the path,
 * which the reviewer defeated with both vectors). The directory (not just the file) is staged so
 * sibling-module resolution (`import './lib'`, a Python sibling import) still works.
 */
export interface StagedResolverArtifact {
  /** Private staging root the caller MUST `rmSync(recursive)` when execution completes. */
  stageDir: string;
  /** The executable COPY (basename + extension preserved so module-loading behaviour is identical). */
  stagedArtifactPath: string;
  /** Realpath of the verified interpreter (executed as command[0] in interpreted mode); null in direct mode. */
  interpreterRealpath: string | null;
  /** sha256 of the artifact bytes RE-HASHED from the copy (what actually executes). */
  contentDigest: string;
  /** round-20 (advisor): canonical content manifest of the whole COPIED tree (artifact + every
   * sibling), so a post-attest sibling swap changes this value and the drain refuses it. */
  manifestDigest: string;
  /** Sorted relpaths of the staged tree (the files the manifest hashed) — logged on a drain-seam
   * mismatch so an operator sees a stray file rather than only an opaque digest mismatch. */
  manifestRelpaths: string[];
  interpreterDigest: string | null;
  /** Composite recomputed from the copied bytes + manifest + interpreter + shape; compared to the attested value. */
  compositeDigest: string;
  interpreted: boolean;
}

/** Upper bound on the resolver DIRECTORY staged per drain (round-20). A resolver + its immediate
 * siblings is small; a directory beyond this is a misconfiguration (e.g. a bundled node_modules or
 * venv) and is refused fail-closed rather than copied — bounding both cost and a copy-amplification DoS. */
const MAX_STAGED_DIR_BYTES = 64 * 1024 * 1024;

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

const MODE_IWGRP = 0o020;
const MODE_IWOTH = 0o002;
const MODE_ISVTX = 0o1000; // sticky bit

/**
 * round-21 finding 1 (interpreter verify ≠ execute): the interpreter (`command[0]` in interpreted
 * mode) is hashed here but EXECUTED from this same realpath — a system binary is 119 MB and is not
 * staged/copied. So a swap between the hash and the spawn executes unverified bytes with the
 * composite unchanged. Refuse an interpreter (or ANY ancestor directory — a writable ancestor lets
 * an actor `rename` the target) that a DIFFERENT, untrusted actor could write: world-writable, or
 * group-writable when THIS process is a member of the file's group. These are genuine cross-actor
 * holes and are closed here.
 *
 * STICKY DIRECTORY EXEMPTION: a directory that is world/group-writable but carries the STICKY bit
 * (e.g. `/tmp`, mode 1777) is NOT refused — the sticky bit restricts rename/delete of an entry to
 * the entry's OWNER (or root) regardless of directory write permission, so a different actor cannot
 * swap OUR file inside it. (This is exactly what makes `/tmp` safe for owner-created files, and is
 * why a fake interpreter placed under `/private/tmp` in a test is not a real swap vector.) The
 * exemption applies only to DIRECTORIES; a world/group-writable regular FILE is always refused.
 *
 * The remaining case — an interpreter owned by and writable by our OWN effective UID (e.g. an
 * nvm/homebrew node in a user-owned dir, mode 755) — is NOT refused: it is the SAME same-UID
 * boundary as the staged resolver copy (finding 4). A same-UID actor that can rewrite the
 * interpreter can also rewrite the staged copy and ptrace the child, so this layer cannot defend
 * against it; that boundary is documented and owner-gated (see docs/durability.md + the debt
 * draft), not silently accepted here. Enforcing "refuse euid-writable" would also refuse the
 * legitimate user-owned interpreter that every real deployment and this test suite use.
 */
function assertInterpreterNotUntrustedWritable(target: string, label: string): void {
  const myGids = typeof process.getgroups === 'function' ? new Set<number>(process.getgroups()) : null;
  let cur = target;
  for (;;) {
    const st = statSync(cur);
    const worldWritable = (st.mode & MODE_IWOTH) !== 0;
    const groupWritable = (st.mode & MODE_IWGRP) !== 0 && myGids !== null && myGids.has(st.gid);
    if (worldWritable || groupWritable) {
      // A sticky DIRECTORY confines rename/delete to each entry's owner, so it is not a swap vector.
      const stickyDir = st.isDirectory() && (st.mode & MODE_ISVTX) !== 0;
      if (!stickyDir) {
        throw new Error(`refusing: ${label} path ${cur} is ${worldWritable ? 'world' : 'group'}-writable without the sticky bit — a different actor could swap the interpreter between verification (hash) and execution (spawn), executing unverified bytes while the composite is unchanged (verify≠execute); the interpreter and every ancestor directory must be writable only by a trusted UID (a sticky dir such as /tmp is exempt)`);
      }
    }
    const parent = dirname(cur);
    if (parent === cur) break; // filesystem root
    cur = parent;
  }
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
  // round-20: the execution ENVELOPE (timeoutMs, minOutputBytes) also governs canary AND
  // runtime acceptance, so it must be attested — otherwise a post-attest change to either
  // (a longer timeout, a lower output floor) alters what is accepted without changing the
  // digest. Absent → explicit null (never omitted, so the positional shape is stable).
  const timeoutMs = execution.timeoutMs ?? null;
  const minOutputBytes = execution.minOutputBytes ?? null;
  return JSON.stringify([[...command], interpreted, timeoutMs, minOutputBytes]);
}

/**
 * The composite the attestation binds: artifact CONTENT digest, the whole-directory MANIFEST
 * digest (round-20 advisor blocking finding — artifact + every sibling), the INTERPRETER content
 * digest (round-20 — null in direct mode), and the canonical execution SHAPE identity. An artifact
 * swap changes `contentDigest`; a SIBLING swap (overwrite `helper.cjs` after attestation) changes
 * `manifestDigest`; an interpreter-content swap changes `interpreterDigest`; a shape/envelope change
 * changes the identity — any of the four changes this value, so the drain-seam equality check
 * refuses all of them. `contentDigest` is retained even though `manifestDigest` subsumes it
 * (the artifact is a regular file in the walked dir): it is a defense-in-depth backstop that still
 * pins the artifact bytes even if the manifest walk ever regressed for the artifact file itself.
 */
export function resolverCompositeDigest(
  contentDigest: string,
  manifestDigest: string,
  execution: ResolverArtifactDeclaration,
  interpreterDigest: string | null,
): string {
  return createHash('sha256')
    .update(JSON.stringify([contentDigest, manifestDigest, interpreterDigest, canonicalExecutionIdentity(execution)]))
    .digest('hex');
}

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

interface ResolvedExecutionShape {
  command: readonly string[];
  interpreted: boolean;
  declaredPath: string;
  /** Realpath of the resolver artifact (a regular file). */
  artifactReal: string;
  /** Realpath of the interpreter binary (interpreted mode; a regular file), else null. */
  interpreterReal: string | null;
}

/**
 * Deny-by-default validation of the execution SHAPE (shared by `verifyResolverArtifact` and
 * `stageResolverArtifact`). Resolves the declared artifact's realpath (a regular file) and
 * requires it to BE the executing token (command[0] direct; EXACTLY command[1], no flag,
 * interpreted). Round-20 additions: (a) in interpreted mode the INTERPRETER (command[0]) must
 * resolve to a regular file whose identity is then hashed and bound; (b) in direct mode NO
 * token after the artifact may be a bare (non-flag, non-`{source}`) path — a renamed
 * interpreter (basename evades `isInterpreterName`) declared direct would otherwise execute
 * such a token as an unattested script while only the artifact's bytes are attested.
 */
function resolveExecutionShape(execution: ResolverArtifactDeclaration): ResolvedExecutionShape {
  const { command, interpreted, declaredPath } = requireDeclaration(execution);

  let artifactReal: string;
  try {
    artifactReal = realpathSync(declaredPath);
  } catch (err) {
    throw new Error(`refusing: resolver artifact ${declaredPath} is not resolvable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!statSync(artifactReal).isFile()) {
    throw new Error(`refusing: resolver artifact ${declaredPath} (realpath ${artifactReal}) is not a regular file`);
  }

  const realpathOf = (token: string, label: string): string => {
    try {
      return realpathSync(token);
    } catch (err) {
      throw new Error(`refusing: ${label} ${token} is not resolvable: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  let interpreterReal: string | null = null;
  if (interpreted) {
    if (command.length < 2) throw new Error('refusing: interpreted resolver command needs an interpreter AND a script argument');
    const scriptToken = command[1]!;
    if (scriptToken.startsWith('-')) {
      throw new Error(`refusing: interpreted resolver command[1] "${scriptToken}" is a flag, not the declared script — inline-code / flag injection (e.g. \`-e\`, \`-eCODE\`) is refused`);
    }
    if (realpathOf(scriptToken, 'interpreted resolver command[1]') !== artifactReal) {
      throw new Error(`refusing: interpreted resolver command[1] realpath does not equal declared resolverArtifactPath realpath ${artifactReal} — the verified file is not the one that executes`);
    }
    // round-20 finding 2a: the INTERPRETER (command[0]) identity is now verified and bound.
    // It must resolve to a regular file so its content can be hashed and the exact verified
    // interpreter executed — a bare `node` on PATH (unresolvable) or a flag is refused.
    const interpreterToken = command[0]!;
    if (interpreterToken.startsWith('-')) {
      throw new Error('refusing: interpreted resolver command[0] may not be a flag — command[0] must be the interpreter binary path');
    }
    interpreterReal = realpathOf(interpreterToken, 'interpreted resolver interpreter command[0]');
    if (!statSync(interpreterReal).isFile()) {
      throw new Error(`refusing: interpreter command[0] realpath ${interpreterReal} is not a regular file`);
    }
    // round-21 finding 1: the interpreter is executed from this realpath (not staged), so refuse it
    // if a DIFFERENT untrusted actor (world / a group we're in) could swap it between hash and spawn.
    assertInterpreterNotUntrustedWritable(interpreterReal, 'interpreted resolver interpreter command[0]');
  } else {
    if (realpathOf(command[0]!, 'direct resolver command[0]') !== artifactReal) {
      throw new Error(`refusing: direct resolver command[0] realpath does not equal declared resolverArtifactPath realpath ${artifactReal} — the verified file is not the one that executes`);
    }
    // round-19 finding 2: a "direct" artifact that IS an interpreter (by basename) is a MISLABEL.
    if (isInterpreterName(basename(artifactReal))) {
      throw new Error(`refusing: resolver declared interpreted:false but the artifact realpath basename "${basename(artifactReal)}" is a known interpreter — declare interpreted:true with the script as command[1] (mislabel refused)`);
    }
    // round-21 finding 2: round-20's finding-2b allowed FLAGS after a direct artifact — but a
    // renamed interpreter (basename evades isInterpreterName) reads `-c`/`-e`/`--eval` as "run the
    // NEXT token as code", so `[watch-resolver(→bash), "-c", "{source}"]` verified bash's bytes and
    // then executed the inbound `{source}` as SHELL CODE. In direct mode we cannot know whether the
    // (possibly renamed) artifact treats a token as data or code, so the shape is constrained
    // STRUCTURALLY: every token after the artifact MUST embed the bound `{source}` template AND MUST
    // NOT be a flag (start with `-`). This refuses a bare `-c`/`-e` (no `{source}`) AND a
    // `--eval={source}` (a `-`-prefixed code flag that embeds `{source}`).
    for (let i = 1; i < command.length; i++) {
      const tok = command[i]!;
      if (tok.startsWith('-')) {
        throw new Error(`refusing: direct-mode resolver command[${i}] "${tok}" is a flag — a renamed interpreter reads a flag such as -c/-e/--eval as "execute the following as code", which would run the inbound {source} as code; a direct artifact may take only {source}-bearing DATA tokens, never flags`);
      }
      if (!tok.includes('{source}')) {
        throw new Error(`refusing: direct-mode resolver command[${i}] "${tok}" is a bare positional argument (no {source}) — a direct artifact that is or wraps an interpreter could execute it as an unattested script; only {source}-bearing data tokens may follow a direct artifact`);
      }
    }
    // RESIDUAL (named; structural closure is owner-gated). A renamed interpreter that treats a
    // POSITIONAL data token as code with no flag — e.g. `awk '{source}'` runs {source} as an awk
    // PROGRAM — still executes {source} as code in direct mode. Closing this needs the source OFF
    // argv entirely (stdin/temp file) or the typed `{interpreter, resolverArtifactPath, args}`
    // contract; both touch every deployment config and are owner-gated (Debt 4). Interpreted mode is
    // not exposed to this (command[1] must realpath-equal the declared artifact, never a flag).
  }
  return { command, interpreted, declaredPath, artifactReal, interpreterReal };
}

/**
 * Deny-by-default verification: validate the shape, then hash the artifact CONTENT and the
 * INTERPRETER (interpreted mode) and fold both into the COMPOSITE the attestation binds. Used
 * to DERIVE the attested digest (attest CLI) and as the pre-stage integrity gate. Any shape
 * violation, missing declaration, or unresolvable token throws.
 */
export function verifyResolverArtifact(execution: ResolverArtifactDeclaration): VerifiedResolverArtifact {
  const shape = resolveExecutionShape(execution);
  const contentDigest = sha256Of(shape.artifactReal);
  // round-20 (advisor): bind the WHOLE directory, computed over the REAL source dir at attest time.
  // stageResolverArtifact recomputes the identical manifest over the byte-for-byte copy at drain
  // time; the two agree iff no sibling was added/removed/changed in between.
  const manifestDigest = directoryManifestDigest(dirname(shape.artifactReal));
  const interpreterDigest = shape.interpreterReal === null ? null : sha256Of(shape.interpreterReal);
  const compositeDigest = resolverCompositeDigest(contentDigest, manifestDigest, execution, interpreterDigest);
  return {
    declaredPath: shape.declaredPath,
    realpath: shape.artifactReal,
    contentDigest,
    manifestDigest,
    interpreterDigest,
    interpreterRealpath: shape.interpreterReal,
    compositeDigest,
    interpreted: shape.interpreted,
  };
}

/**
 * round-20 (advisor blocking finding): a canonical CONTENT MANIFEST of a directory tree, folded
 * into the composite so the attestation binds the WHOLE staged tree (artifact + every sibling),
 * not just the single artifact file. Without this a sibling swap — overwrite `helper.cjs` after
 * attestation — leaves the artifact's own `contentDigest` unchanged and the evil sibling executes
 * (an `import './helper'` loads it). The manifest is `sha256(JSON.stringify(entries))` where
 * `entries` is the array of `[relpath, sha256(bytes)]` pairs for EVERY regular file PLUS a
 * `[relpath + '/', '']` marker for EVERY directory (round-21 finding 3 — so an added or empty
 * directory changes the manifest), sorted by relpath in codepoint order (NOT `localeCompare` — that is locale-dependent and could diverge
 * between attest and drain). JSON is the join so a filename containing a separator or newline can
 * never forge a different tree's manifest. It runs at BOTH attest (over the real source dir) and
 * stage (over the private copy) time; because `cpSync` preserves content byte-for-byte, the two
 * manifests are identical iff no file was added, removed, or changed between attest and drain.
 *
 * Fail-closed rules — refuse rather than silently skip:
 *  - a SYMLINK is refused: `cpSync` copies it verbatim (no dereference), so a symlink pointing at a
 *    mutable target OUTSIDE the copy would let an `import` load unverified, post-attest-mutable
 *    bytes — the exact hole staging exists to close;
 *  - any non-regular, non-directory entry (fifo, socket, device) is refused — a fifo would also
 *    block the walk on read;
 *  - the cumulative regular-file byte size is bounded, checked from `stat` BEFORE reading, so a
 *    pathological huge file is refused rather than loaded into memory.
 *
 * MODE IS DELIBERATELY EXCLUDED. `cpSync`'s permission-bit preservation is not verified
 * bit-identical across every fs/umask; mode is excluded to REMOVE that risk, because a divergence
 * would make the stage-time manifest differ from the attest-time manifest for EVERY legitimate
 * resolver — a total, silent availability break (fail-closed on everything). A mode-only change
 * cannot make unverified BYTES execute: interpreted mode loads the artifact by content; direct mode
 * refuses bare positional args (finding 2b) and a lost `+x` only fails the spawn (EACCES), it never
 * executes an unattested sibling. So excluding mode is security-safe and removes the availability
 * footgun.
 *
 * NOTE (operator constraint, documented in configuration.md/runbook): because the WHOLE directory is
 * bound, the resolver artifact MUST live in an ISOLATED directory that contains ONLY the resolver and
 * its intentional siblings — nothing else may be written next to it (no `.DS_Store`, editor swap file,
 * `__pycache__`, log, db, or media), or every subsequent drain fails closed as `resolver_digest_mismatch`.
 */
export interface DirectoryManifest {
  digest: string;
  /**
   * Sorted relative paths of every regular file that was hashed — the exact tree contents bound by
   * `digest`. On a drain-seam mismatch this list is logged so an operator sees WHAT was actually
   * present (e.g. a stray `.DS_Store`/`__pycache__`/log next to the resolver) instead of only an
   * opaque digest mismatch. It lists the STAGED contents, not a diff against the attested manifest —
   * the attested per-file manifest is not persisted (that would be an owner-gated schema change).
   */
  relpaths: string[];
}

export function directoryManifest(dir: string, cap: number = MAX_STAGED_DIR_BYTES): DirectoryManifest {
  const entries: Array<[string, string]> = [];
  let total = 0;
  const walk = (d: string): void => {
    // readdirSync withFileTypes uses lstat semantics: a symlink reports isSymbolicLink(), never isFile().
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`refusing: resolver directory contains a symlink (${full}) — a symlink survives the copy and can point at post-attest-mutable bytes; resolver trees must be symlink-free`);
      }
      const rel = relative(dir, full).split(sep).join('/');
      if (entry.isDirectory()) {
        // round-21 finding 3: record the DIRECTORY itself, not only its files. Round-20 entered
        // only regular files, so an added or EMPTY directory (which carries no files) left the
        // manifest — and the composite — unchanged, yet directory structure can change execution
        // (an implicit namespace package, a `__pycache__`, a dir that shadows a module). A trailing
        // "/" distinguishes the dir marker from a same-named file; its digest slot is empty.
        entries.push([`${rel}/`, '']);
        walk(full);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`refusing: resolver directory entry ${full} is neither a regular file nor a directory (fifo/socket/device) — refused fail-closed`);
      }
      total += statSync(full).size;
      if (total > cap) {
        throw new Error(`refusing: resolver directory ${dir} exceeds the ${cap}-byte staging bound — a resolver plus its immediate siblings must be small; a bundled node_modules/venv is a misconfiguration, not a resolver`);
      }
      entries.push([rel, createHash('sha256').update(readFileSync(full)).digest('hex')]);
    }
  };
  walk(dir);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    digest: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
    relpaths: entries.map((e) => e[0]),
  };
}

/** The manifest digest alone (see {@link directoryManifest}). */
export function directoryManifestDigest(dir: string, cap: number = MAX_STAGED_DIR_BYTES): string {
  return directoryManifest(dir, cap).digest;
}

/**
 * round-20 findings 1+3: CONTENT-ADDRESSED, immutable staging. Copies the artifact's whole
 * directory into a fresh private staging root, RE-HASHES the copy, and returns the copy's paths
 * — so the caller compares the copy's composite to the attested value and executes the COPY.
 * Because we hash exactly the bytes that will execute, a rename or in-place write to the ORIGINAL
 * after this point can never substitute unverified bytes: either the copied bytes match the
 * attestation (execute them) or they do not (refuse). The interpreter is verified and hashed but
 * executed from its realpath (a system binary is not copied); its swap is bound by the composite.
 * The caller MUST `rmSync(stageDir, { recursive: true, force: true })` when execution completes.
 */
export function stageResolverArtifact(execution: ResolverArtifactDeclaration): StagedResolverArtifact {
  const shape = resolveExecutionShape(execution);
  const sourceDir = dirname(shape.artifactReal);
  // Pre-copy guard: refuse a symlink / non-regular entry / oversized tree BEFORE copying, so a
  // pathological source is never amplified into a copy. (Its return value is discarded here; the
  // authoritative digest is recomputed over the COPY below — the bytes that actually execute.)
  directoryManifestDigest(sourceDir, MAX_STAGED_DIR_BYTES);
  const stageDir = mkdtempSync(join(tmpdir(), 'ws-resolver-stage-'));
  try {
    const copiedDir = join(stageDir, 'd');
    // Copy the artifact's whole directory so sibling-module resolution is preserved.
    cpSync(sourceDir, copiedDir, { recursive: true });
    const stagedArtifactPath = join(copiedDir, basename(shape.artifactReal));
    if (!statSync(stagedArtifactPath).isFile()) {
      throw new Error('refusing: staged resolver artifact is not a regular file after copy');
    }
    // Re-hash the COPY — the exact bytes that will execute (verify == execute by construction).
    const contentDigest = sha256Of(stagedArtifactPath);
    // round-20 (advisor): the manifest is recomputed over the COPY, not the source, so a TOCTOU
    // sibling-add between the pre-copy guard and cpSync is still caught (and refuses a symlink that
    // slipped in after the guard). The composite then binds the whole tree that will execute.
    const manifest = directoryManifest(copiedDir, MAX_STAGED_DIR_BYTES);
    const interpreterDigest = shape.interpreterReal === null ? null : sha256Of(shape.interpreterReal);
    const compositeDigest = resolverCompositeDigest(contentDigest, manifest.digest, execution, interpreterDigest);
    return {
      stageDir,
      stagedArtifactPath,
      interpreterRealpath: shape.interpreterReal,
      contentDigest,
      manifestDigest: manifest.digest,
      manifestRelpaths: manifest.relpaths,
      interpreterDigest,
      compositeDigest,
      interpreted: shape.interpreted,
    };
  } catch (err) {
    rmSync(stageDir, { recursive: true, force: true }); // never leak a staging root on failure
    throw err;
  }
}
