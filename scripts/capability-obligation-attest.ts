/**
 * capability-obligation-attest — the operator front-door that PRODUCES a D5
 * capability attestation (round-15 finding 1). Without a recorded attestation the
 * supervisor admits nothing and every obligation parks; the recording core
 * (`produceCapabilityAttestation`) had no caller. This command derives the live
 * binding, obtains a bounded NON-SENDING canary outcome, and records an
 * attestation ONLY if the canary passed.
 *
 * The canary is a real execution (it runs the declared resolver against a bounded
 * probe input). That execution is gated behind an explicit `--run-canary`; the
 * DEFAULT is a dry-run that derives the binding + digest and records NOTHING. The
 * recording core still refuses to record on a failed canary, so neither path can
 * mint an attestation for a capability that did not actually probe green.
 *
 * `--run-canary` reads the resolver argv + timeout + minimum-output bytes from the
 * SAME `agentOptions.capabilityObligations` config the live instance runs, via
 * `--config PATH`, and probes it against `--probe-source SOURCE` (a bounded, safe
 * URL/token). Before recording, the operator-supplied binding is compared to the
 * binding that config implies (mediaRoot + contract version + full skill identity);
 * a mismatch is refused, because an attestation whose binding differs from the live
 * supervisor's would be recorded yet never admit a real obligation (still inert).
 *
 * FAIL-CLOSED OBSERVATION (round 16, hardened round 17): before recording under
 * `--run-canary` the command additionally (a) refuses unless the binding's media root
 * is a readable directory; (b) requires `--resolver-digest` and VERIFIES the resolver
 * SCRIPT artifact — it locates the script within the execution argv (skipping a leading
 * interpreter such as `node`/`python`, refusing code-loading flags like `-e`/`--require`
 * and bare names), sha256s it, and refuses on any mismatch; it never hashes the
 * interpreter and never soft-passes an unverified resolver; (c) PRESERVES the probe
 * stdout/stderr/exit digests + byte counts + observed-source digest to a DURABLE receipt
 * (`--receipt-out`) that is fsynced+read-back BEFORE the attestation row is admitted, so
 * no admissible row can exist without its receipt already durable (round-17 finding 1).
 * The receipt records probe evidence only; it does NOT assert admission (admission = the
 * `capability_attestations` row carrying this run's nonce).
 *
 * NARROW CLAIM: a passing canary attests ONLY that the VERIFIED installed resolver,
 * run against the recorded `sha256(probeSource)`, exited 0 within bound and produced
 * >= minOutputBytes — it is NOT proof of semantic processing (a bounded probe cannot
 * establish that). Per spec §3.3 the fulfillment proof is the D6 execution receipt +
 * normal-delivery chain, not the canary. Migration 63 (#3221 Debt 2 graduation)
 * added the attestation-row evidence columns (probe stdout/stderr refs, exit,
 * canary-input ref, media-root readability): the recorded row now carries the
 * evidence itself and the `--receipt-out` file is CORROBORATING, no longer the
 * sole preservation. The schema bump is inside the attestation binding by design
 * (AS-01 must be re-run 44→63 at rollout; old digests stop admitting).
 *
 *   dry-run (default): capability-obligation-attest --db PATH --provider P \
 *     --contract-version V --capability C --skill-name N --skill-digest D \
 *     --probe-version PV --canary-id CID --media-root PATH --release-sha SHA \
 *     --valid-seconds N --run-id ID [--skill-version V] [--resolver-digest D] [--dep k=v ...]
 *     [--config PATH]   (with --config, also proves the binding matches config)
 *   record:  ... --run-canary --confirm --config PATH --probe-source SOURCE --receipt-out PATH
 *            (observes the installed resolver + media root, runs the config's canary,
 *             records on pass, preserves probe evidence to the receipt)
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, closeSync, constants as fsConstants, fsyncSync, linkSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hostname, userInfo } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import {
  attestationBindingDigest,
  buildCapabilityAttestationBinding,
  type AttestationSkillIdentity,
  type CapabilityAttestationBinding,
} from '../src/core/capability-attestation.ts';
import {
  attestationEvidenceFromCanary,
  produceCapabilityAttestation,
  type CapabilityCanaryOutcome,
} from '../src/core/capability-attestation-producer.ts';
import {
  parseCapabilityObligationsOptions,
  type CapabilityObligationsOptions,
} from '../src/core/capability-contract.ts';
import {
  stageResolverArtifact,
  verifyResolverArtifact,
  type ResolverArtifactDeclaration,
  type StagedResolverArtifact,
} from '../src/core/capability-resolver-artifact.ts';
import { CURRENT_SCHEMA_MIGRATION } from '../src/core/database-schema-version.ts';
import { Database } from '../src/core/database.ts';
import { resolveHarnessType } from '../src/runtimes/agent/capability-obligation-runtime.ts';

export interface AttestArgs {
  dbPath: string;
  providerId: string;
  contractVersion: string;
  capability: string;
  skill: AttestationSkillIdentity;
  mediaRoot: string;
  releaseSha: string;
  validForSeconds: number;
  runId: string;
  hostId: string;
  runtimeUser: string;
  /** Path to the instance config whose `agentOptions.capabilityObligations` drives the canary; required with --run-canary. */
  configPath: string | null;
  /** Bounded, non-sending probe source the resolver canary runs against; required with --run-canary. */
  probeSource: string | null;
  /** Path to write the durable probe-evidence receipt (stdout/stderr/exit digests, artifact obs); required with --run-canary. */
  receiptOut: string | null;
  runCanary: boolean;
  confirm: boolean;
  json: boolean;
}

const VALUE_FLAGS = new Set([
  '--db', '--provider', '--contract-version', '--capability', '--skill-name', '--skill-version',
  '--skill-digest', '--resolver-digest', '--probe-version', '--canary-id', '--media-root',
  '--release-sha', '--valid-seconds', '--run-id', '--host', '--runtime-user',
  '--config', '--probe-source', '--receipt-out',
]);

function positiveInt(value: string, label: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${label} must be a positive integer`);
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`${label} must be a safe integer`);
  return n;
}

export function parseAttestArgs(argv: readonly string[]): AttestArgs {
  const flags = new Map<string, string>();
  const deps: Record<string, string> = {};
  let runCanary = false;
  let confirm = false;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === '--run-canary') { runCanary = true; continue; }
    if (token === '--confirm') { confirm = true; continue; }
    if (token === '--json') { json = true; continue; }
    if (token === '--dep') {
      const kv = argv[i + 1];
      if (kv === undefined) throw new Error('--dep requires name=version');
      const eq = kv.indexOf('=');
      if (eq <= 0) throw new Error(`--dep must be name=version, got: ${kv}`);
      deps[kv.slice(0, eq)] = kv.slice(eq + 1);
      i += 1;
      continue;
    }
    if (!VALUE_FLAGS.has(token)) throw new Error(`unknown flag: ${token}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${token} requires a value`);
    flags.set(token, value);
    i += 1;
  }
  const need = (flag: string): string => {
    const v = flags.get(flag);
    if (v === undefined || v.length === 0) throw new Error(`${flag} is required`);
    return v;
  };
  return {
    dbPath: need('--db'),
    providerId: need('--provider'),
    contractVersion: need('--contract-version'),
    capability: need('--capability'),
    skill: {
      skillName: need('--skill-name'),
      skillVersion: flags.get('--skill-version') ?? null,
      skillDigest: need('--skill-digest'),
      resolverDigest: flags.get('--resolver-digest') ?? null,
      dependencyVersions: deps,
      probeVersion: need('--probe-version'),
      canaryId: need('--canary-id'),
    },
    mediaRoot: need('--media-root'),
    releaseSha: need('--release-sha'),
    validForSeconds: positiveInt(need('--valid-seconds'), '--valid-seconds'),
    runId: need('--run-id'),
    hostId: flags.get('--host') ?? hostname(),
    runtimeUser: flags.get('--runtime-user') ?? userInfo().username,
    configPath: flags.get('--config') ?? null,
    probeSource: flags.get('--probe-source') ?? null,
    receiptOut: flags.get('--receipt-out') ?? null,
    runCanary,
    confirm,
    json,
  };
}

export function bindingForAttestArgs(args: AttestArgs): CapabilityAttestationBinding {
  return buildCapabilityAttestationBinding({
    liveFacts: {
      hostId: args.hostId,
      runtimeUser: args.runtimeUser,
      releaseSha: args.releaseSha,
      schemaVersion: CURRENT_SCHEMA_MIGRATION,
      providerId: args.providerId,
      harnessType: resolveHarnessType(args.providerId),
    },
    contractVersion: args.contractVersion,
    capability: args.capability,
    skill: args.skill,
    mediaRoot: args.mediaRoot,
  });
}

/**
 * Load the SAME `agentOptions.capabilityObligations` block the live instance runs.
 * Accepts a full instance config (`{agentOptions:{capabilityObligations:…}}`), an
 * `{agentOptions:{…}}`/`{capabilityObligations:…}` wrapper, or the block itself.
 * Throws (fail-closed) when the file is missing/malformed or the block is absent /
 * not enabled — never guesses a resolver command.
 */
export function loadObligationOptionsFromConfig(configPath: string): CapabilityObligationsOptions {
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (err) {
    throw new Error(`--config ${configPath} could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`--config ${configPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const holder = parsed as { agentOptions?: { capabilityObligations?: unknown }; capabilityObligations?: unknown };
  const raw = holder?.agentOptions?.capabilityObligations ?? holder?.capabilityObligations ?? parsed;
  const options = parseCapabilityObligationsOptions(raw);
  if (options === null) {
    throw new Error(
      `--config ${configPath} has no enabled agentOptions.capabilityObligations block `
      + '(the resolver command + attestation expectation must come from the instance config, not flags)',
    );
  }
  return options;
}

/**
 * Refuse to record an attestation whose binding differs from the one the live
 * supervisor builds from `config` — that attestation would admit NO real obligation
 * (still operationally inert). The whole binding identity is compared via its digest
 * (mediaRoot + contract version + every skill-identity field), and `--capability`
 * must name a capability the config's contract actually declares.
 */
export function assertArgsMatchConfig(args: AttestArgs, options: CapabilityObligationsOptions): void {
  const argsDigest = attestationBindingDigest(bindingForAttestArgs(args));
  const configBinding = buildCapabilityAttestationBinding({
    liveFacts: {
      hostId: args.hostId,
      runtimeUser: args.runtimeUser,
      releaseSha: args.releaseSha,
      schemaVersion: CURRENT_SCHEMA_MIGRATION,
      providerId: args.providerId,
      harnessType: resolveHarnessType(args.providerId),
    },
    contractVersion: options.contract.version,
    capability: args.capability,
    skill: options.attestation,
    mediaRoot: options.mediaRoot,
  });
  const configDigest = attestationBindingDigest(configBinding);
  if (argsDigest !== configDigest) {
    throw new Error(
      'refusing to record: the supplied binding does not match --config '
      + '(mediaRoot / contract-version / skill identity differ; the attestation would never admit a live obligation). '
      + `args-binding=${argsDigest} config-binding=${configDigest}`,
    );
  }
  const declared = options.contract.rules.map((rule) => rule.capability);
  if (!declared.includes(args.capability)) {
    throw new Error(
      `refusing to record: --capability ${args.capability} is not declared by the config contract `
      + `(declared: ${declared.length > 0 ? [...new Set(declared)].join(', ') : 'none'})`,
    );
  }
}

const CANARY_STREAM_CAP_BYTES = 262_144;

/**
 * The bounded, NON-SENDING resolver canary — the gated real execution.
 *
 * NARROW CLAIM (spec §3.3): a `pass` means ONLY that the declared resolver, run
 * against the recorded `sha256(probeSource)`, exited 0 within the timeout and
 * produced >= minOutputBytes on stdout (this repo's resolvers write their result
 * to stdout; `execution-tool.ts` gates the same way). It is NOT proof the resolver
 * semantically processed that source — a bounded probe cannot establish that, and
 * per §3.3 the fulfillment proof lives in the D6 execution receipt + delivery
 * chain, not the canary. The `detail` preserves stdout/stderr digests + byte counts
 * + exit/signal (references without raw content = no secret leak) so the recorded
 * attestation is auditable.
 *
 * Process-group ownership (mirrors execution-tool.ts:88, r13/r14 F2): the child is
 * its OWN group leader (`detached`), and the group is SIGKILLed on timeout AND in
 * the close handler — a resolver that forks a grandchild (yt-dlp → ffmpeg, a shell)
 * cannot leave it alive to land a side effect after the outcome is reported. Node's
 * built-in `timeout` only signals the direct child, so we own the watchdog.
 */
export function runResolverCanary(params: {
  execution: ResolverArtifactDeclaration & { command: readonly string[]; timeoutMs: number; minOutputBytes: number };
  declaredResolverDigest: string;
  probeSource: string;
  nonce: string;
}): Promise<CapabilityCanaryOutcome> {
  const probeSourceDigest = createHash('sha256').update(params.probeSource).digest('hex');
  // round-20 finding 3: the canary must execute EXACTLY the bytes it verifies — the SAME
  // content-addressed staging the runtime uses (previously it spawned the ORIGINAL path while
  // the runtime executed a `.pinned-*` copy, so canary and runtime could diverge). Stage,
  // refuse unless the staged composite equals the declared/attested digest, then spawn the
  // STAGED copy (never the original path); the staging root is removed in every terminal path.
  let staged: StagedResolverArtifact;
  try {
    staged = stageResolverArtifact(params.execution);
  } catch (err) {
    return Promise.resolve({ result: 'fail', nonce: params.nonce, detail: { reason: 'resolver_artifact_unverified', message: err instanceof Error ? err.message : String(err), probeSourceDigest } });
  }
  if (staged.compositeDigest !== params.declaredResolverDigest) {
    rmSync(staged.stageDir, { recursive: true, force: true });
    // round-20 (advisor): name the staged tree so a stray file next to the resolver (which drifts the
    // whole-directory manifest) is diagnosable from the receipt rather than an opaque mismatch.
    return Promise.resolve({ result: 'fail', nonce: params.nonce, detail: { reason: 'resolver_digest_mismatch', probeSourceDigest, stagedManifestFiles: staged.manifestRelpaths } });
  }
  const artifactIndex = params.execution.interpreted === true ? 1 : 0;
  const argv = params.execution.command.map((part, i) => {
    if (i === artifactIndex) return staged.stagedArtifactPath;
    if (i === 0 && staged.interpreterRealpath !== null) return staged.interpreterRealpath;
    return part.replaceAll('{source}', params.probeSource);
  });
  return new Promise((resolvePromise) => {
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      try { rmSync(staged.stageDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    };
    // round-21 finding 5: an argv element containing a NUL byte makes spawn() throw SYNCHRONOUSLY
    // (ERR_INVALID_ARG_VALUE) — before any 'error' listener is attached — which would reject this
    // Promise and LEAK the staging root (cleanup runs only from the child event handlers). Guard the
    // substituted argv for NUL up front, AND wrap spawn in try/catch, so EVERY failure path cleans
    // the stage dir and resolves a fail rather than throwing/leaking.
    if (argv.some((a) => a.includes('\0'))) {
      cleanup();
      resolvePromise({ result: 'fail', nonce: params.nonce, detail: { reason: 'resolver_arg_contains_nul', probeSourceDigest } });
      return;
    }
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (err) {
      cleanup();
      resolvePromise({ result: 'fail', nonce: params.nonce, detail: { reason: 'resolver_spawn_failed', message: err instanceof Error ? err.message : String(err), probeSourceDigest } });
      return;
    }
    const pid = child.pid; // capture now — undefined if spawn failed
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const killGroup = (): void => {
      if (pid === undefined) return;
      try { process.kill(-pid, 'SIGKILL'); } catch { /* already reaped by a clean exit or an earlier kill */ }
    };
    const watchdog = setTimeout(() => { timedOut = true; killGroup(); }, params.execution.timeoutMs);
    watchdog.unref?.();
    child.stdout.on('data', (c: Buffer) => { if (stdout.length < CANARY_STREAM_CAP_BYTES) stdout += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { if (stderr.length < CANARY_STREAM_CAP_BYTES) stderr += c.toString('utf8'); });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      killGroup();
      cleanup();
      resolvePromise({ result: 'fail', nonce: params.nonce, detail: { reason: 'resolver_spawn_failed', probeSourceDigest } });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      if (signal !== null) timedOut = true; // a SIGKILLed resolver is a timeout, not a plain non-zero exit
      // Reap the (now-leaderless) group before reporting: the leader has exited, so
      // signalling the negative pid only sweeps a grandchild that outlived it.
      killGroup();
      cleanup();
      const stdoutBytes = Buffer.byteLength(stdout, 'utf8');
      const stderrBytes = Buffer.byteLength(stderr, 'utf8');
      const pass = !timedOut && code === 0 && stdoutBytes >= params.execution.minOutputBytes;
      resolvePromise({
        result: pass ? 'pass' : 'fail',
        nonce: params.nonce,
        detail: {
          exitCode: code,
          signal,
          timedOut,
          stdoutBytes,
          stderrBytes,
          stdoutSha256: createHash('sha256').update(stdout).digest('hex'),
          stderrSha256: createHash('sha256').update(stderr).digest('hex'),
          probeSourceDigest,
        },
      });
    });
  });
}

/**
 * Round-18 finding 1: VERIFY the EXPLICITLY-DECLARED resolver artifact and refuse on
 * any mismatch. Round 17 INFERRED the artifact from argv (skip a leading interpreter,
 * hash the first path token); a reviewer proved that unsound (`perl -eCODE <decoy>`
 * verified the decoy while perl ran inline code; a symlink named `watch-resolver` → node
 * was hashed as node while a script argument ran). The sound rule lives in
 * `verifyResolverArtifact`: the operator declares `execution.resolverArtifactPath` +
 * `execution.interpreted`, and the command SHAPE is validated (deny-by-default) against
 * that declaration by realpath. Here we additionally require the declared
 * `--resolver-digest` and refuse unless the verified artifact's COMPOSITE digest matches
 * it. The composite (round-19 findings 1+2) folds the artifact CONTENT hash with the
 * canonical execution SHAPE, so `--resolver-digest` binds BOTH — and the executor
 * re-derives and re-compares the SAME composite at the drain seam.
 */
export interface ResolverArtifactObservation {
  observed: true;
  /** The COMPOSITE digest (content + shape) — the value bound as `resolver_digest`. */
  digest: string;
  /** The artifact CONTENT digest alone (recorded in the receipt for corroboration). */
  contentDigest: string;
  declaredDigest: string;
  verified: true;
  artifactPath: string;
  interpreted: boolean;
}

export function observeResolverArtifact(
  execution: ResolverArtifactDeclaration,
  declaredResolverDigest: string | null,
): ResolverArtifactObservation {
  if (declaredResolverDigest === null || declaredResolverDigest.length === 0) {
    throw new Error('refusing to record: --resolver-digest is required — the attestation MUST verify the exact resolver artifact (content AND shape) that runs; a missing declared digest cannot be checked');
  }
  const verified = verifyResolverArtifact(execution);
  if (verified.compositeDigest !== declaredResolverDigest) {
    throw new Error(
      `refusing to record: declared resolver artifact ${verified.realpath} composite digest ${verified.compositeDigest} does not match declared --resolver-digest ${declaredResolverDigest} `
      + `(the attestation would bind a resolver whose content or execution shape is not the one installed)`,
    );
  }
  return {
    observed: true,
    digest: verified.compositeDigest,
    contentDigest: verified.contentDigest,
    declaredDigest: declaredResolverDigest,
    verified: true,
    artifactPath: verified.realpath,
    interpreted: verified.interpreted,
  };
}

/**
 * Blocker-1 (round 16): refuse to record unless the binding's media root exists and
 * is readable — a D3/D5 binding field that must name a real, reachable retained-media
 * directory, not an unverified string.
 */
export function assertMediaRootReadable(mediaRoot: string): void {
  let stat;
  try {
    accessSync(mediaRoot, fsConstants.R_OK);
    stat = statSync(mediaRoot);
  } catch (err) {
    throw new Error(`refusing to record: media root ${mediaRoot} is not readable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`refusing to record: media root ${mediaRoot} is not a directory`);
  }
}

/**
 * Round-17 finding 1 (+ advisor gap-1): persist the probe-evidence receipt DURABLY
 * so that it can be written BEFORE the attestation row is admitted. Write → fsync
 * file → atomic rename → fsync directory → READ-BACK verify. Any filesystem failure
 * (unwritable destination, disk-full, partial write) THROWS here — the caller runs
 * this strictly before `attest()`, so a receipt that cannot be made durable means NO
 * attestation row is ever committed.
 *
 * Invariant (one direction, stated deliberately): an admissible attestation row
 * IMPLIES its receipt was durably fsynced first. The reverse is NOT asserted — a
 * receipt may exist with no row if the INSERT later fails — which is safe because
 * the receipt does NOT claim admission (admission = the `capability_attestations`
 * row carrying this `nonce`; a reader confirms the row, never the receipt alone).
 */
export function writeReceiptDurably(receiptPath: string, receipt: unknown): void {
  const json = JSON.stringify(receipt, null, 2);
  const abs = resolve(receiptPath);
  const tmp = `${abs}.tmp-${process.pid}-${randomUUID()}`;
  const fd = openSync(tmp, 'wx'); // exclusive temp (unique name; never reuses a sibling)
  try {
    writeFileSync(fd, json);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // finding-2 (r18): PUBLISH atomically and NO-CLOBBER. `link()` fails EEXIST if the
  // receipt already exists, so a second attestation can never overwrite / destroy the
  // first's preserved evidence (the round-17 form `rename()`d OVER any existing receipt;
  // reusing a nonce then destroyed the prior row's evidence and failed the unique-nonce
  // insert). Evidence is write-once; a re-run must use a fresh --receipt-out.
  try {
    linkSync(tmp, abs);
  } catch (err) {
    unlinkSync(tmp);
    throw new Error(`refusing to record: receipt ${abs} already exists — probe evidence is write-once and must not be overwritten (use a fresh --receipt-out per run): ${err instanceof Error ? err.message : String(err)}`);
  }
  unlinkSync(tmp);
  const dirFd = openSync(dirname(abs), 'r');
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
  const readBack = readFileSync(abs, 'utf8');
  if (readBack !== json) {
    throw new Error(`refusing to record: receipt at ${abs} did not persist verifiably (read-back mismatch) — attestation not admitted`);
  }
}

export interface AttestIo { out: (line: string) => void; err: (line: string) => void; }

export type AttestResult =
  | { mode: 'dry-run'; attestationDigest: string; recorded: false }
  | { mode: 'record'; attestationDigest: string; recorded: true; attestationId: number }
  | { mode: 'record'; attestationDigest: string; recorded: false; reason: string };

/**
 * The testable core: derive the binding, and — given a canary outcome (injected;
 * the CLI computes it via runResolverCanary under --run-canary) — record via the
 * fail-closed producer. A null canary is a dry-run: derive + digest, record nothing.
 * `mediaRootReadable` is the front-door's observation (the CLI asserts the media
 * root readable BEFORE running the canary, so its record path passes true); it
 * lands on the row with the rest of the migration-63 evidence.
 */
export function attest(
  db: Database,
  args: AttestArgs,
  canary: CapabilityCanaryOutcome | null,
  now: Date,
  mediaRootReadable: boolean | null,
): AttestResult {
  const binding = bindingForAttestArgs(args);
  const attestationDigest = attestationBindingDigest(binding);
  if (canary === null) return { mode: 'dry-run', attestationDigest, recorded: false };
  const produced = produceCapabilityAttestation(db, {
    binding, canary, validForSeconds: args.validForSeconds, attestedAt: now,
    evidence: attestationEvidenceFromCanary(canary, mediaRootReadable),
  });
  if (produced.recorded) {
    return { mode: 'record', attestationDigest, recorded: true, attestationId: produced.attestationId };
  }
  return { mode: 'record', attestationDigest, recorded: false, reason: produced.reason };
}

function assertSchemaCurrent(dbPath: string): void {
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  try {
    let version = 0;
    try {
      version = Number((raw.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number }).v);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/no such table/i.test(message)) throw new Error(`could not read schema version from ${dbPath}: ${message}`);
      version = 0;
    }
    if (version !== CURRENT_SCHEMA_MIGRATION) {
      throw new Error(
        `refusing to operate: database is at schema ${version}, expected ${CURRENT_SCHEMA_MIGRATION}. `
        + 'Run this tool from the release whose schema matches the instance; it never migrates a live database.',
      );
    }
  } finally {
    raw.close();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  void (async () => {
    try {
      const args = parseAttestArgs(process.argv.slice(2));
      assertSchemaCurrent(args.dbPath);
      const db = new Database(args.dbPath);
      db.open();
      try {
        if (args.runCanary) {
          // Gated real execution. Require the explicit confirmation, the instance
          // config (source of the resolver command), and a bounded probe source.
          if (!args.confirm) throw new Error('--run-canary requires --confirm (it executes the resolver and records an attestation)');
          if (args.configPath === null) throw new Error('--run-canary requires --config PATH (the resolver command comes from the instance config, never a guess)');
          if (args.probeSource === null || args.probeSource.length === 0) throw new Error('--run-canary requires --probe-source SOURCE (a bounded, non-sending URL/token to probe)');
          if (args.receiptOut === null) throw new Error('--run-canary requires --receipt-out PATH (the probe stdout/stderr/exit evidence is preserved there per spec §3.3)');
          if (args.skill.resolverDigest === null || args.skill.resolverDigest.length === 0) throw new Error('--run-canary requires --resolver-digest DIGEST (the attestation must verify the exact resolver artifact that runs)');
          const options = loadObligationOptionsFromConfig(args.configPath);
          assertArgsMatchConfig(args, options); // refuse an un-admittable binding before running anything
          assertMediaRootReadable(options.mediaRoot); // finding-1: media-root must be a readable directory
          // finding-1 (r18): VERIFY the EXPLICITLY-DECLARED resolver artifact by realpath
          // shape-validation (never argv inference). Throws unless the declared artifact
          // IS the token that executes and its content matches --resolver-digest.
          const artifact = observeResolverArtifact(options.execution, args.skill.resolverDigest);
          const now = new Date();
          const canary = await runResolverCanary({
            execution: options.execution,
            declaredResolverDigest: args.skill.resolverDigest,
            probeSource: args.probeSource,
            nonce: args.runId,
          });
          if (canary.result !== 'pass') {
            // Failed/insufficient canary: record NOTHING and do NOT write the admission
            // receipt (a receipt at --receipt-out means an admission was attempted).
            process.stdout.write((args.json ? JSON.stringify({ mode: 'record', recorded: false, reason: 'canary_failed' }) : `NOT RECORDED attest ${args.capability}: canary_failed (no attestation, no receipt)`) + '\n');
            process.exitCode = 3;
            return;
          }
          // finding-1 (+ advisor gap-1): PERSIST the probe-evidence receipt DURABLY
          // BEFORE admission. The receipt is keyed by nonce + binding digest (not the
          // post-insert row id) and does NOT assert admission. If it cannot be made
          // durable, this throws and NO attestation row is committed.
          const attestationDigest = attestationBindingDigest(bindingForAttestArgs(args));
          const receipt = {
            schemaVersion: CURRENT_SCHEMA_MIGRATION,
            capability: args.capability,
            attestationBindingDigest: attestationDigest,
            nonce: args.runId,
            canaryResult: canary.result,
            canary,
            resolverArtifact: artifact,
            mediaRoot: options.mediaRoot,
            probeSourceDigest: (canary.detail as { probeSourceDigest?: string } | undefined)?.probeSourceDigest ?? null,
            admission: `evidence only — admission is the capability_attestations row with nonce=${args.runId}; verify the row exists, this receipt does not assert it. Since migration 63 the row itself carries the evidence columns; this receipt corroborates them`,
            claimScope: 'NOT a proof of semantic processing — exit0+bytes+verified-artifact+source-digest only; fulfillment proof = D6 receipt + delivery chain (spec §3.3)',
            attestedAt: now.toISOString(),
          };
          writeReceiptDurably(args.receiptOut, receipt); // durable + read-back verified, strictly before the INSERT below
          // media_root_readable = true: assertMediaRootReadable above threw otherwise.
          const result = attest(db, args, canary, now, true);
          if (result.recorded) {
            process.stdout.write((args.json ? JSON.stringify(result) : `RECORDED attest ${args.capability}: id=${result.attestationId} digest=${result.attestationDigest} receipt=${args.receiptOut}`) + '\n');
            process.exitCode = 0;
          } else {
            const reason = result.mode === 'record' ? result.reason : 'dry-run';
            process.stdout.write((args.json ? JSON.stringify(result) : `NOT RECORDED attest ${args.capability}: ${reason} digest=${result.attestationDigest} receipt=${args.receiptOut}`) + '\n');
            process.exitCode = 3; // nonzero when the producer refused to record
          }
          return;
        }
        // Dry-run: derive the binding + digest, record nothing. With --config, also
        // prove the binding would be admitted by the live instance before ever recording.
        if (args.configPath !== null) assertArgsMatchConfig(args, loadObligationOptionsFromConfig(args.configPath));
        const result = attest(db, args, null, new Date(), null);
        const configNote = args.configPath !== null ? ' (binding matches --config)' : '';
        process.stdout.write((args.json ? JSON.stringify(result) : `DRY-RUN attest ${args.capability}: digest=${result.attestationDigest}${configNote} (no attestation recorded — pass --run-canary --confirm --config PATH --probe-source SOURCE on the target host)`) + '\n');
        process.exitCode = 0;
      } finally {
        db.close();
      }
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    }
  })();
}
