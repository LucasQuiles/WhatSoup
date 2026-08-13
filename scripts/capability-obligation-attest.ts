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
 * FAIL-CLOSED OBSERVATION (round 16): before recording under `--run-canary` the
 * command additionally (a) refuses unless the binding's media root is a readable
 * directory; (b) OBSERVES the installed resolver artifact (`execution.command[0]`)
 * and refuses on a digest mismatch with the declared `--resolver-digest` — it never
 * silently trusts the declared digest; (c) PRESERVES the probe stdout/stderr/exit
 * digests + byte counts + observed-source digest to a durable receipt (`--receipt-out`),
 * required so no attestation is minted without preserved evidence (spec §3.3).
 *
 * NARROW CLAIM: a passing canary attests ONLY that the OBSERVED installed resolver,
 * run against the recorded `sha256(probeSource)`, exited 0 within bound and produced
 * >= minOutputBytes — it is NOT proof of semantic processing (a bounded probe cannot
 * establish that). Per spec §3.3 the fulfillment proof is the D6 execution receipt +
 * normal-delivery chain, not the canary. Attestation-row evidence columns are NOT
 * added here: a new column needs migration 58, which bumps CURRENT_SCHEMA_MIGRATION
 * INSIDE the attestation binding and would invalidate every digest + reopen AS-01.
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
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants as fsConstants, readFileSync, statSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  attestationBindingDigest,
  buildCapabilityAttestationBinding,
  type AttestationSkillIdentity,
  type CapabilityAttestationBinding,
} from '../src/core/capability-attestation.ts';
import {
  produceCapabilityAttestation,
  type CapabilityCanaryOutcome,
} from '../src/core/capability-attestation-producer.ts';
import {
  parseCapabilityObligationsOptions,
  type CapabilityObligationsOptions,
} from '../src/core/capability-contract.ts';
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
  command: readonly string[];
  probeSource: string;
  timeoutMs: number;
  minOutputBytes: number;
  nonce: string;
}): Promise<CapabilityCanaryOutcome> {
  const argv = params.command.map((part) => part.replaceAll('{source}', params.probeSource));
  const probeSourceDigest = createHash('sha256').update(params.probeSource).digest('hex');
  return new Promise((resolvePromise) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const pid = child.pid; // capture now — undefined if spawn failed
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const killGroup = (): void => {
      if (pid === undefined) return;
      try { process.kill(-pid, 'SIGKILL'); } catch { /* already reaped by a clean exit or an earlier kill */ }
    };
    const watchdog = setTimeout(() => { timedOut = true; killGroup(); }, params.timeoutMs);
    watchdog.unref?.();
    child.stdout.on('data', (c: Buffer) => { if (stdout.length < CANARY_STREAM_CAP_BYTES) stdout += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { if (stderr.length < CANARY_STREAM_CAP_BYTES) stderr += c.toString('utf8'); });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      killGroup();
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
      const stdoutBytes = Buffer.byteLength(stdout, 'utf8');
      const stderrBytes = Buffer.byteLength(stderr, 'utf8');
      const pass = !timedOut && code === 0 && stdoutBytes >= params.minOutputBytes;
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
 * Blocker-1 (round 16): OBSERVE the installed resolver artifact rather than
 * silently trusting the declared `resolverDigest`. When `execution.command[0]` is a
 * real file (an absolute/relative path to the resolver), sha256 it; if the operator
 * declared a `resolverDigest`, REFUSE fail-closed on mismatch. When command[0] is a
 * bare PATH binary (no separator), it cannot be observed here — record
 * `observed: false` so the attestation stops implying a verification that did not
 * happen. Never fabricates a match.
 */
export interface ResolverArtifactObservation {
  observed: boolean;
  digest: string | null;
  declaredDigest: string | null;
  verified: boolean;
}
export function observeResolverArtifact(commandZero: string, declaredResolverDigest: string | null): ResolverArtifactObservation {
  const looksLikePath = commandZero.includes('/');
  if (!looksLikePath) {
    return { observed: false, digest: null, declaredDigest: declaredResolverDigest, verified: false };
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(commandZero);
  } catch (err) {
    throw new Error(`refusing to record: resolver artifact ${commandZero} is unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (declaredResolverDigest !== null && digest !== declaredResolverDigest) {
    throw new Error(
      `refusing to record: installed resolver artifact digest ${digest} does not match declared --resolver-digest ${declaredResolverDigest} `
      + `(the attestation would bind a resolver that is not the one installed)`,
    );
  }
  return { observed: true, digest, declaredDigest: declaredResolverDigest, verified: declaredResolverDigest !== null };
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

export interface AttestIo { out: (line: string) => void; err: (line: string) => void; }

export type AttestResult =
  | { mode: 'dry-run'; attestationDigest: string; recorded: false }
  | { mode: 'record'; attestationDigest: string; recorded: true; attestationId: number }
  | { mode: 'record'; attestationDigest: string; recorded: false; reason: string };

/**
 * The testable core: derive the binding, and — given a canary outcome (injected;
 * the CLI computes it via runResolverCanary under --run-canary) — record via the
 * fail-closed producer. A null canary is a dry-run: derive + digest, record nothing.
 */
export function attest(
  db: Database,
  args: AttestArgs,
  canary: CapabilityCanaryOutcome | null,
  now: Date,
): AttestResult {
  const binding = bindingForAttestArgs(args);
  const attestationDigest = attestationBindingDigest(binding);
  if (canary === null) return { mode: 'dry-run', attestationDigest, recorded: false };
  const produced = produceCapabilityAttestation(db, {
    binding, canary, validForSeconds: args.validForSeconds, attestedAt: now,
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
          const options = loadObligationOptionsFromConfig(args.configPath);
          assertArgsMatchConfig(args, options); // refuse an un-admittable binding before running anything
          assertMediaRootReadable(options.mediaRoot); // blocker-1: media-root must be a readable directory
          const artifact = observeResolverArtifact(options.execution.command[0]!, args.skill.resolverDigest); // blocker-1: observe installed resolver (throws on digest mismatch)
          const now = new Date();
          const canary = await runResolverCanary({
            command: options.execution.command,
            probeSource: args.probeSource,
            timeoutMs: options.execution.timeoutMs,
            minOutputBytes: options.execution.minOutputBytes,
            nonce: args.runId,
          });
          const result = attest(db, args, canary, now);
          // blocker-1: PRESERVE the probe evidence durably (references, no raw stream content).
          const receipt = {
            schemaVersion: CURRENT_SCHEMA_MIGRATION,
            capability: args.capability,
            attestationBindingDigest: result.attestationDigest,
            recorded: result.recorded,
            attestationId: result.recorded ? result.attestationId : null,
            reason: result.recorded ? null : (result.mode === 'record' ? result.reason : 'dry-run'),
            canary,
            resolverArtifact: artifact,
            mediaRoot: options.mediaRoot,
            probeSourceDigest: (canary.detail as { probeSourceDigest?: string } | undefined)?.probeSourceDigest ?? null,
            claimScope: 'NOT a proof of semantic processing — exit0+bytes+observed-artifact+source-digest only; fulfillment proof = D6 receipt + delivery chain (spec §3.3)',
            attestedAt: now.toISOString(),
          };
          writeFileSync(args.receiptOut, JSON.stringify(receipt, null, 2));
          if (result.recorded) {
            process.stdout.write((args.json ? JSON.stringify(result) : `RECORDED attest ${args.capability}: id=${result.attestationId} digest=${result.attestationDigest} receipt=${args.receiptOut}`) + '\n');
            process.exitCode = 0;
          } else {
            const reason = result.mode === 'record' ? result.reason : 'dry-run';
            process.stdout.write((args.json ? JSON.stringify(result) : `NOT RECORDED attest ${args.capability}: ${reason} digest=${result.attestationDigest} receipt=${args.receiptOut}`) + '\n');
            process.exitCode = 3; // nonzero when the canary/producer refused to record
          }
          return;
        }
        // Dry-run: derive the binding + digest, record nothing. With --config, also
        // prove the binding would be admitted by the live instance before ever recording.
        if (args.configPath !== null) assertArgsMatchConfig(args, loadObligationOptionsFromConfig(args.configPath));
        const result = attest(db, args, null, new Date());
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
