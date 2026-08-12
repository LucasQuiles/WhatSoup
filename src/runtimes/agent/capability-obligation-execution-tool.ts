/**
 * `execute_capability` — the TRUSTED D6 execution seam (capability-obligation
 * replay). Execution receipts are written ONLY here: the in-process handler
 * spawns the instance-declared resolver argv itself, derives the observed
 * source digest from what IT executed (hashing retained media bytes directly;
 * hashing the exact source string it passed to the child), validates the typed
 * outcome (exit code + minimum output evidence), and persists the
 * attempt-bound receipt through the store.
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
    const child = spawn(argv[0]!, argv.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < STDOUT_CAP_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_CAP_BYTES) stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
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
      const { obligation, fence, attemptNumber } = active;

      // TRUSTED derivation — from what THIS handler observes, never from text:
      // media obligations must name the retained path, whose BYTES are hashed
      // here; everything else hashes the exact source string handed to the
      // resolver child below.
      let observedSourceDigest: string;
      let observedMediaDigest: string | null = null;
      if (obligation.retainedMediaPath !== null) {
        if (source !== obligation.retainedMediaPath) {
          recordOutcome(deps, active, null, 'error', {
            reason: 'source_is_not_the_retained_media_path',
          });
          return toolError({ error: 'capability_execution', message: 'Source must be the retained media path for this obligation' });
        }
        try {
          observedMediaDigest = await sha256File(source);
        } catch (err) {
          log.warn({ err, obligationId: obligation.id }, 'retained media unreadable at execution');
          recordOutcome(deps, active, null, 'error', { reason: 'retained_media_unreadable' });
          return toolError({ error: 'capability_execution', message: 'Retained media is unreadable' });
        }
        observedSourceDigest = observedMediaDigest;
      } else {
        observedSourceDigest = createHash('sha256').update(source).digest('hex');
      }
      if (observedSourceDigest !== obligation.sourceDigest) {
        recordOutcome(deps, active, observedSourceDigest, 'error', { reason: 'source_mismatch' });
        return toolError({ error: 'capability_execution', message: 'Source does not match this obligation' });
      }

      // Argument-injection guard (data, never options). spawn() below is
      // shell-less, so shell metacharacters are inert bytes; the sole argv-level
      // vector is a source that, placed as a standalone argv element, the
      // resolver child parses as an OPTION FLAG. A leading_token rule derives its
      // source from the arbitrary post-command remainder, which can begin with
      // '-'. Refuse fail-closed BEFORE spawning: a legitimate source (an http(s)
      // URL, or a content-addressed retained-media path) never begins with '-';
      // an operator needing a '-'-leading argument embeds it (--flag={source}).
      if (source.startsWith('-')) {
        recordOutcome(deps, active, observedSourceDigest, 'error', {
          reason: 'source_would_smuggle_option_flag',
        });
        return toolError({ error: 'capability_execution', message: 'Source may not begin with "-" (option-flag smuggling refused)' });
      }

      const argv = deps.options.execution.command.map((part) =>
        part === '{source}' ? source : part,
      );
      let run: ResolverRun;
      try {
        run = await runResolver(argv, deps.options.execution.timeoutMs);
      } catch (err) {
        log.warn({ err, obligationId: obligation.id }, 'capability resolver spawn failed');
        recordOutcome(deps, active, observedSourceDigest, 'error', { reason: 'resolver_spawn_failed' });
        return toolError({ error: 'capability_execution', message: 'Capability resolver could not be started' });
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
