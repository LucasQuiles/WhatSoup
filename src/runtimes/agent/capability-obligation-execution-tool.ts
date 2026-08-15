/**
 * `execute_capability` — the TRUSTED D6 execution seam (capability-obligation
 * replay). Execution receipts are written ONLY here: the in-process handler
 * spawns the instance-declared resolver argv itself, derives the observed
 * source digest from what IT executed (hashing retained media bytes directly;
 * hashing the exact source string it passed to the child), validates the typed
 * outcome (exit code + minimum output evidence), and persists the
 * attempt-bound receipt through the store.
 *
 * Media obligations are executed against a per-attempt SNAPSHOT: the handler
 * copies the retained bytes into a private temp dir, hashes THAT snapshot, hands
 * the snapshot path to the child, and re-hashes it after the child exits. The
 * receipt binds a snapshot digest verified UNCHANGED before and after the run
 * (isolated from any concurrent writer of the retained path); a net change — a
 * resolver that mutates its input — records an error, never `ok`. This is
 * net-change DETECTION, NOT a cryptographic proof of which bytes the child
 * actually read: a transient mutate-read-restore inside the child would evade
 * the re-hash. Closing that gap needs a stronger resolver contract (a read-only
 * fd / stdin the child cannot reopen).
 *
 * Nothing here parses model-controlled text: a provider turn can neither forge
 * a receipt (only this handler writes them, from its own observations) nor
 * launder a wrong source (a digest mismatch records an error receipt that can
 * never complete the obligation). The substituted source is DATA, never
 * options: a source beginning with '-' is refused before the resolver is
 * spawned, so a model-controlled remainder can never smuggle an argv flag into
 * the resolver child (spawn is shell-less, so the flag is the only argv-level
 * injection vector). No tool call → no receipt → the obligation quarantines
 * instead of completing. Registered only when the obligation feature activates
 * (all-or-inert).
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import type { CapabilityObligationsOptions } from '../../core/capability-contract.ts';
import { stageResolverArtifact, type StagedResolverArtifact } from '../../core/capability-resolver-artifact.ts';
import type {
  CapabilityObligationClaimFence,
  CapabilityObligationDueRow,
  CapabilityObligationStore,
} from '../../core/capability-obligation-store.ts';
import { createChildLogger } from '../../logger.ts';
import { EXTERNAL_EFFECT_CONTRACT_VERSION } from '../../mcp/external-effect.ts';
import { toolError, type ToolDeclaration } from '../../mcp/types.ts';

const log = createChildLogger('agent:capability-execution-tool');

const STDOUT_CAP_BYTES = 262_144;
const STDERR_CAP_BYTES = 65_536;

export interface ActiveObligationExecution {
  obligation: CapabilityObligationDueRow;
  fence: CapabilityObligationClaimFence;
  attemptNumber: number;
  mintedMessageId: string;
}

export interface CapabilityExecutionToolDeps {
  store: CapabilityObligationStore;
  options: CapabilityObligationsOptions;
  /** The active obligation-owned turn for a conversation, or null. */
  findActiveTurn: (conversationKey: string) => ActiveObligationExecution | null;
  /** The live logical turn id owning a conversation (terminal-record identity). */
  turnIdFor: (conversationKey: string) => string | null;
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

interface ResolverRun {
  exitCode: number | null;
  /** The signal that terminated the child, if any — reported as itself, never conflated with a timeout (audit F8). */
  signal: NodeJS.Signals | null;
  /** True ONLY when this handler's own watchdog fired (audit F8). */
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** Raw child-output bytes CAPTURED (capped at the advertised limit) — the truthful evidence measure (audit F8). */
  stdoutBytes: number;
  stderrBytes: number;
}

/**
 * Byte-exact capped accumulator (audit F8): the previous char-count compare +
 * whole-chunk append let multi-byte UTF-8 output exceed the advertised BYTE
 * cap. Chunks are collected as Buffers with byte accounting, the final chunk
 * is sliced at the cap boundary, and decoding goes through StringDecoder
 * WITHOUT end() so a codepoint split at the cap is dropped rather than
 * decoded as a replacement char that would re-encode PAST the cap. `bytes()`
 * reports the raw captured byte count — never more than `capBytes`.
 */
function cappedCollector(capBytes: number): { push: (chunk: Buffer) => void; text: () => string; bytes: () => number } {
  const chunks: Buffer[] = [];
  let bytes = 0;
  return {
    push: (chunk: Buffer): void => {
      if (bytes >= capBytes) return;
      const room = capBytes - bytes;
      const take = chunk.length <= room ? chunk : chunk.subarray(0, room);
      chunks.push(take);
      bytes += take.length;
    },
    text: (): string => {
      const decoder = new StringDecoder('utf8');
      let out = '';
      for (const chunk of chunks) out += decoder.write(chunk);
      return out; // no decoder.end(): a dangling partial codepoint is dropped, keeping byteLength(text) <= capBytes
    },
    bytes: (): number => bytes,
  };
}

function runResolver(argv: readonly string[], timeoutMs: number): Promise<ResolverRun> {
  return new Promise((resolve, reject) => {
    // `detached: true` makes the child its OWN process-group leader, so a timeout
    // can reap the WHOLE descendant tree, not just the immediate child. Node's
    // built-in `timeout` option only signals the direct child (r13 F2): a resolver
    // that forks a grandchild (yt-dlp → ffmpeg, a shell, etc.) would leave it alive
    // to land side effects AFTER the error receipt and before a retry. We own the
    // watchdog instead and SIGKILL the negative pid (the whole group).
    // round-21 finding 5: a NUL byte in any argv element makes spawn() throw SYNCHRONOUSLY
    // (ERR_INVALID_ARG_VALUE). Rejecting cleanly here (the caller's finally still frees the stage
    // dir) gives a precise diagnostic instead of an opaque spawn stack; also wrap spawn so no other
    // synchronous throw escapes unlabeled.
    if (argv.some((a) => a.includes('\0'))) {
      reject(new Error('resolver argv contains a NUL byte — refusing to spawn'));
      return;
    }
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(argv[0]!, argv.slice(1), {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const pid = child.pid; // capture now — undefined if spawn failed
    const stdout = cappedCollector(STDOUT_CAP_BYTES);
    const stderr = cappedCollector(STDERR_CAP_BYTES);
    let timedOut = false;
    let settled = false;
    const killGroup = (): void => {
      if (pid === undefined) return;
      try { process.kill(-pid, 'SIGKILL'); } catch { /* already dead: the process group was reaped by a clean exit or an earlier kill */ }
    };
    const watchdog = setTimeout(() => {
      timedOut = true;
      killGroup(); // reap the leader AND every descendant
    }, timeoutMs);
    watchdog.unref?.();
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      // r14 F2: the leader has already exited (that is why `close` fired), but a
      // grandchild it forked into the SAME process group can OUTLIVE it and land
      // a side effect AFTER we record the receipt below. On a clean exit the
      // watchdog is cleared and would never reap that grandchild, so reap the
      // group HERE before resolving. The leader is gone, so signalling the
      // (now leaderless) negative pid only reaches escaped descendants — a clean
      // run is not "group-killed after success", it just sweeps stragglers. If
      // no grandchild escaped, killGroup is a no-op (ESRCH → swallowed). This
      // narrows but does not eliminate the window: a grandchild that itself
      // called setsid() leaves the group and is unreachable by pgid — that needs
      // the stronger resolver contract noted in the module header.
      killGroup();
      resolve({
        exitCode: code,
        signal,
        timedOut,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutBytes: stdout.bytes(),
        stderrBytes: stderr.bytes(),
      });
    });
  });
}

export function buildCapabilityExecutionTool(deps: CapabilityExecutionToolDeps): ToolDeclaration {
  return {
    name: 'execute_capability',
    description:
      'Execute the declared capability resolver for the ACTIVE capability obligation of this chat. '
      + 'Pass the exact source the obligation owes (its URL, or the retained media path). The runtime '
      + 'runs the resolver itself, verifies the source against the obligation, and records the trusted '
      + 'execution receipt; the resolver output is returned for composing the reply.',
    schema: z.object({
      source: z.string().min(1).describe('The obligation source: its URL, or the retained media path.'),
    }),
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'unsafe',
    core: false,
    externalEffect: { version: EXTERNAL_EFFECT_CONTRACT_VERSION, kind: 'external' },
    handler: async (params, session) => {
      const conversationKey = session.conversationKey;
      if (!conversationKey) return toolError({ error: 'capability_execution', message: 'execute_capability requires a conversation-bound session' });
      const active = deps.findActiveTurn(conversationKey);
      if (active === null) {
        return toolError({ error: 'capability_execution', message: 'No active capability obligation turn for this conversation' });
      }
      const source = String(params['source'] ?? '');
      const { obligation } = active;

      // Derive the observed digest AND the value the child will actually execute
      // against ("executionSource"), from what THIS handler observes:
      //  - media: the agent must name the retained path; the handler copies its
      //    bytes into a private per-attempt snapshot, hashes the SNAPSHOT, and
      //    executes against the snapshot path (isolated from any writer of the
      //    retained path). A post-execution re-hash DETECTS any net change to
      //    the snapshot (not a proof of which bytes the child read);
      //  - URL/token: the source string IS the bytes.
      let observedSourceDigest: string;
      let observedMediaDigest: string | null = null;
      let executionSource: string;
      let snapshotDir: string | null = null;
      let stageDir: string | null = null; // round-20 findings 1+3: content-addressed staging root, rm'd in finally
      try {
        if (obligation.retainedMediaPath !== null) {
          if (source !== obligation.retainedMediaPath) {
            recordOutcome(deps, active, null, 'error', { reason: 'source_is_not_the_retained_media_path' });
            return toolError({ error: 'capability_execution', message: 'Source must be the retained media path for this obligation' });
          }
          try {
            snapshotDir = await mkdtemp(join(tmpdir(), 'capx-media-'));
            const snapshotPath = join(snapshotDir, 'input');
            await copyFile(obligation.retainedMediaPath, snapshotPath);
            observedMediaDigest = await sha256File(snapshotPath);
            executionSource = snapshotPath;
          } catch (err) {
            log.warn({ err, obligationId: obligation.id }, 'retained media unreadable at execution');
            recordOutcome(deps, active, null, 'error', { reason: 'retained_media_unreadable' });
            return toolError({ error: 'capability_execution', message: 'Retained media is unreadable' });
          }
          observedSourceDigest = observedMediaDigest;
        } else {
          observedSourceDigest = createHash('sha256').update(source).digest('hex');
          executionSource = source;
        }
        if (observedSourceDigest !== obligation.sourceDigest) {
          recordOutcome(deps, active, observedSourceDigest, 'error', { reason: 'source_mismatch' });
          return toolError({ error: 'capability_execution', message: 'Source does not match this obligation' });
        }

        // Argument-injection guard (data, never options), on the value the child
        // parses. spawn() below is shell-less, so shell metacharacters are inert;
        // the sole argv-level vector is a source that, as a standalone argv
        // element, the resolver parses as an OPTION FLAG. A leading_token
        // remainder can begin with '-'. Refuse fail-closed BEFORE spawning: a
        // legitimate source (http(s) URL, or a content-addressed media path)
        // never begins with '-'; an operator needing a '-'-leading argument
        // embeds it (--flag={source}).
        if (executionSource.startsWith('-')) {
          recordOutcome(deps, active, observedSourceDigest, 'error', { reason: 'source_would_smuggle_option_flag' });
          return toolError({ error: 'capability_execution', message: 'Source may not begin with "-" (option-flag smuggling refused)' });
        }

        // round-20 findings 1+2+3: CONTENT-ADDRESSED staging — the only sound verify==execute.
        // `stageResolverArtifact` validates the shape (incl. the round-20 interpreter-identity
        // and direct-mode-bare-arg refusals), copies the artifact's whole directory into a fresh
        // PRIVATE staging root, and RE-HASHES the copy. We compare the COPY's composite to the
        // attested value and execute the COPY, so a rename OR an in-place write to the original
        // after this point cannot substitute unverified bytes — the round-19 hardlink shared the
        // inode AND re-resolved the path, and a reviewer defeated both. The composite also binds
        // the INTERPRETER content and the execution envelope (timeoutMs/minOutputBytes), so an
        // interpreter-content swap or an envelope change after attestation is refused too.
        let staged: StagedResolverArtifact;
        try {
          staged = stageResolverArtifact(deps.options.execution);
          stageDir = staged.stageDir; // record for finally cleanup
        } catch (err) {
          log.warn({ err, obligationId: obligation.id }, 'resolver artifact could not be staged/verified at drain');
          recordOutcome(deps, active, observedSourceDigest, 'error', { reason: 'resolver_artifact_unverified' });
          return toolError({ error: 'capability_execution', message: 'Resolver artifact could not be staged for verified execution' });
        }
        const attestedDigest = deps.options.attestation.resolverDigest;
        if (attestedDigest === null || staged.compositeDigest !== attestedDigest) {
          log.warn(
            {
              obligationId: obligation.id,
              hasAttested: attestedDigest !== null,
              // round-20 (advisor): name the staged tree contents so an operator can spot a stray
              // file (a `.DS_Store`, editor swap, `__pycache__`, log) written next to the resolver
              // that silently drifts the whole-directory manifest, instead of only an opaque mismatch.
              stagedManifestFiles: staged.manifestRelpaths,
            },
            'staged resolver composite digest does not match the attested digest — content, sibling, interpreter, shape, or envelope drifted after attestation',
          );
          recordOutcome(deps, active, observedSourceDigest, 'error', { reason: 'resolver_digest_mismatch' });
          return toolError({ error: 'capability_execution', message: 'Resolver artifact does not match the attested digest' });
        }

        // Substitute EVERY '{source}' occurrence — standalone ('{source}') AND embedded
        // ('--url={source}') — so substitution matches the config validation, AND redirect the
        // ARTIFACT token (command[1] interpreted, command[0] direct) to the STAGED COPY and the
        // INTERPRETER token (command[0] interpreted) to its VERIFIED realpath, so the executed
        // bytes AND interpreter are exactly the ones the composite attested.
        const artifactIndex = deps.options.execution.interpreted === true ? 1 : 0;
        const argv = deps.options.execution.command.map((part, i) => {
          if (i === artifactIndex) return staged.stagedArtifactPath;
          if (i === 0 && staged.interpreterRealpath !== null) return staged.interpreterRealpath;
          return part.replaceAll('{source}', executionSource);
        });
        // Audit F1 (Critical): a DURABLE pre-spawn reservation keyed
        // (obligation, claim epoch, attempt). Every validation above is
        // side-effect-free, so a refused call (wrong source, digest mismatch)
        // never consumes the attempt; from here on the external side effect is
        // imminent, so the reservation is taken FIRST, in its own committed
        // write. A duplicate call for the same claim/attempt — concurrent or
        // sequential, same process or a successor — hits the UNIQUE constraint
        // and is refused before any spawn.
        const reservationToolUseId = `capx-${randomUUID()}`;
        let reservation: { reserved: true } | { reserved: false; reason: 'already_reserved' };
        try {
          reservation = deps.store.reserveExecutionAttempt({
            obligationId: obligation.id,
            claimEpoch: active.fence.claimEpoch,
            attemptNumber: active.attemptNumber,
            toolUseId: reservationToolUseId,
          });
        } catch (err) {
          log.error({ err, obligationId: obligation.id }, 'execution reservation write failed — refusing to spawn');
          return toolError({ error: 'capability_execution', message: 'Execution reservation could not be recorded; refusing to run the resolver' });
        }
        if (!reservation.reserved) {
          recordOutcome(deps, active, observedSourceDigest, 'error', { reason: 'execution_already_reserved' });
          return toolError({
            error: 'capability_execution',
            message: 'This obligation attempt already reserved an execution — refusing a duplicate external run',
          });
        }
        let run: ResolverRun;
        try {
          run = await runResolver(argv, deps.options.execution.timeoutMs);
        } catch (err) {
          log.warn({ err, obligationId: obligation.id }, 'capability resolver spawn failed');
          recordOutcome(deps, active, observedSourceDigest, 'error', { reason: 'resolver_spawn_failed' });
          return toolError({ error: 'capability_execution', message: 'Capability resolver could not be started' });
        }

        // Media integrity: DETECT a net change to the snapshot the child was
        // handed. A change means the resolver (or a writer of a path only this
        // handler knows) altered the input, so the recorded digest no longer
        // represents the bytes present during the run → error, never `ok`. This
        // is change-detection, not proof the child read exactly these bytes.
        if (snapshotDir !== null && observedMediaDigest !== null) {
          let postDigest = '';
          try {
            postDigest = await sha256File(join(snapshotDir, 'input'));
          } catch {
            postDigest = '';
          }
          if (postDigest !== observedMediaDigest) {
            recordOutcome(deps, active, observedSourceDigest, 'error', { reason: 'media_mutated_during_execution' }, observedMediaDigest);
            return toolError({ error: 'capability_execution_failed', message: 'Retained media changed during execution' });
          }
        }

        const ok =
          !run.timedOut
          && run.signal === null
          && run.exitCode === 0
          && run.stdoutBytes >= deps.options.execution.minOutputBytes;
        const receiptPersisted = recordOutcome(deps, active, observedSourceDigest, ok ? 'ok' : 'error', {
          exitCode: run.exitCode,
          signal: run.signal,
          timedOut: run.timedOut,
          stdoutBytes: run.stdoutBytes,
          stderrBytes: run.stderrBytes,
        }, observedMediaDigest);

        if (!ok) {
          return toolError({
            error: 'capability_execution_failed',
            message:
              `Capability resolver failed (exit=${run.exitCode ?? 'none'}, signal=${run.signal ?? 'none'}, timedOut=${run.timedOut}). `
              + `stderr tail: ${run.stderr.slice(-1_024)}`,
          });
        }
        // Audit F3: the external work SUCCEEDED but its receipt did not
        // persist — returning the output as clean success would let the agent
        // send a result whose obligation later quarantines receipt-less, and
        // invite a repeat of the external work. Surface the durability loss
        // explicitly instead; the consumed reservation above keeps this
        // attempt from being silently re-executed.
        if (!receiptPersisted) {
          return toolError({
            error: 'capability_execution_durability_loss',
            message:
              'The resolver executed successfully but its execution receipt could NOT be persisted. '
              + 'Do not send or reuse the result; the obligation will quarantine for operator review.',
          });
        }
        return { executed: true, exitCode: 0, output: run.stdout };
      } finally {
        if (snapshotDir !== null) {
          try {
            await rm(snapshotDir, { recursive: true, force: true });
          } catch (err) {
            log.warn({ err, obligationId: obligation.id }, 'capability media snapshot cleanup failed');
          }
        }
        if (stageDir !== null) {
          try {
            await rm(stageDir, { recursive: true, force: true }); // remove the whole content-addressed staging root
          } catch (err) {
            log.warn({ err, obligationId: obligation.id }, 'staged resolver artifact cleanup failed');
          }
        }
      }
    },
  };

  /**
   * Returns whether the receipt PERSISTED (audit F3). A false return on the
   * ok-path becomes a caller-visible durability-loss error — never a clean
   * success — because a missing receipt can never complete the obligation and
   * a caller acting on unrecorded success invites repeated external work.
   */
  function recordOutcome(
    toolDeps: CapabilityExecutionToolDeps,
    active: ActiveObligationExecution,
    observedSourceDigest: string | null,
    resultStatus: 'ok' | 'error',
    evidence: Record<string, unknown>,
    observedMediaDigest: string | null = null,
  ): boolean {
    try {
      toolDeps.store.recordExecutionReceipt({
        obligationId: active.obligation.id,
        logicalTurnId:
          toolDeps.turnIdFor(active.obligation.conversationKey) ?? active.mintedMessageId,
        toolUseId: `capx-${randomUUID()}`,
        skillName: toolDeps.options.attestation.skillName,
        contractVersion: active.obligation.contractVersion,
        inputDigest: active.obligation.inputDigest,
        mediaDigest: observedMediaDigest,
        resultStatus,
        outputEvidence: evidence,
        claimEpoch: active.fence.claimEpoch,
        attemptNumber: active.attemptNumber,
        sourceDigest: observedSourceDigest,
      });
      return true;
    } catch (err) {
      // Fail closed: a missing receipt can never complete the obligation.
      log.error({ err, obligationId: active.obligation.id }, 'execution receipt persistence failed');
      return false;
    }
  }
}
