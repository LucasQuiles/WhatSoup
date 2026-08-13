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
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import type { CapabilityObligationsOptions } from '../../core/capability-contract.ts';
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
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

function runResolver(argv: readonly string[], timeoutMs: number): Promise<ResolverRun> {
  return new Promise((resolve, reject) => {
    // `detached: true` makes the child its OWN process-group leader, so a timeout
    // can reap the WHOLE descendant tree, not just the immediate child. Node's
    // built-in `timeout` option only signals the direct child (r13 F2): a resolver
    // that forks a grandchild (yt-dlp → ffmpeg, a shell, etc.) would leave it alive
    // to land side effects AFTER the error receipt and before a retry. We own the
    // watchdog instead and SIGKILL the negative pid (the whole group).
    const child = spawn(argv[0]!, argv.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const pid = child.pid; // capture now — undefined if spawn failed
    let stdout = '';
    let stderr = '';
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
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < STDOUT_CAP_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_CAP_BYTES) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      // Clear the watchdog BEFORE resolving so a child that exits cleanly just
      // before the deadline is never group-killed after a successful run.
      clearTimeout(watchdog);
      if (signal !== null) timedOut = true;
      resolve({ exitCode: code, timedOut, stdout, stderr });
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

        // Substitute EVERY '{source}' occurrence — standalone ('{source}') AND
        // embedded ('--url={source}') — so substitution matches the config
        // validation (executionRuleSchema accepts any part CONTAINING the
        // placeholder). A part that merely embedded it previously reached the
        // child with the literal '{source}' unresolved.
        const argv = deps.options.execution.command.map((part) => part.replaceAll('{source}', executionSource));
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
          && run.exitCode === 0
          && Buffer.byteLength(run.stdout, 'utf8') >= deps.options.execution.minOutputBytes;
        recordOutcome(deps, active, observedSourceDigest, ok ? 'ok' : 'error', {
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          stdoutBytes: Buffer.byteLength(run.stdout, 'utf8'),
          stderrBytes: Buffer.byteLength(run.stderr, 'utf8'),
        }, observedMediaDigest);

        if (!ok) {
          return toolError({
            error: 'capability_execution_failed',
            message:
              `Capability resolver failed (exit=${run.exitCode ?? 'signal'}, timedOut=${run.timedOut}). `
              + `stderr tail: ${run.stderr.slice(-1_024)}`,
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
      }
    },
  };

  function recordOutcome(
    toolDeps: CapabilityExecutionToolDeps,
    active: ActiveObligationExecution,
    observedSourceDigest: string | null,
    resultStatus: 'ok' | 'error',
    evidence: Record<string, unknown>,
    observedMediaDigest: string | null = null,
  ): void {
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
    } catch (err) {
      // Fail closed: a missing receipt can never complete the obligation.
      log.error({ err, obligationId: active.obligation.id }, 'execution receipt persistence failed');
    }
  }
}
