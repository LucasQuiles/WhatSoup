/**
 * Diagnostic-bundle orchestrator.
 *
 * On an arming provider failure the dispatcher runs the diagnostics named by the
 * failure's {@link ResponseWorkflow}, in parallel and best-effort, producing a
 * structured {@link DiagnosticBundle} that feeds the consolidated user message
 * and the alert outbox.
 *
 * Design constraints (the loop's resilience / safety asks made concrete):
 *  - **Never wedge the turn.** Each probe runs under a per-probe deadline backed
 *    by an unref'd timer (mirrors the pattern in
 *    `providers/primary-model-usability.ts`); a slow probe is abandoned, not
 *    awaited. The orphaned promise cannot keep the process alive.
 *  - **Never throw.** A probe that rejects, throws synchronously, times out, or
 *    is simply not registered degrades to a low-confidence `ok: false` finding.
 *    A fully-failed bundle is still a valid bundle.
 *  - **Decoupled.** Probes are injected (no dependency on AgentRuntime), so this
 *    module is pure and unit-testable. The runtime supplies the real probe
 *    implementations.
 *  - **Redaction is the probe's responsibility.** Probe `summary` strings must
 *    already be redacted — only the probe knows which of its data is sensitive.
 *    The orchestrator's own generated summaries contain just the probe id and a
 *    capped error message.
 */

import {
  type DiagnosticBundle,
  type DiagnosticConfidence,
  type DiagnosticFinding,
  type DiagnosticId,
  type ResponseWorkflow,
} from './response-registry.ts';

const DEFAULT_PROBE_TIMEOUT_MS = 2500;
const MAX_ERROR_SUMMARY_LEN = 160;

/** What a single diagnostic probe returns. `summary` must be pre-redacted. */
export interface DiagnosticProbeResult {
  ok: boolean;
  confidence: DiagnosticConfidence;
  summary: string;
  data?: Record<string, unknown>;
  /** Only the usage-limit-reset-parse probe sets this; lifted onto the bundle. */
  resetAt?: number | null;
}

/** A probe receives an AbortSignal (fired on timeout) and resolves a result. */
export type DiagnosticProbe = (signal: AbortSignal) => Promise<DiagnosticProbeResult>;

/** Probe implementations keyed by diagnostic id. Missing ids degrade gracefully. */
export type DiagnosticProbeMap = Partial<Record<DiagnosticId, DiagnosticProbe>>;

export interface RunDiagnosticBundleArgs {
  workflow: ResponseWorkflow;
  probes: DiagnosticProbeMap;
  /** Injected clock — `Date.now()` is avoided so the module stays pure/testable. */
  now: number;
  /** Per-probe deadline; bundle wall-clock ≈ this since probes run in parallel. */
  perProbeTimeoutMs?: number;
}

function errorSummary(id: DiagnosticId, err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return `probe ${id} failed: ${raw.slice(0, MAX_ERROR_SUMMARY_LEN)}`;
}

/**
 * Run one probe under a deadline. Resolves a result for every outcome —
 * success, rejection, synchronous throw, timeout, or unregistered probe.
 */
async function runProbeGuarded(
  id: DiagnosticId,
  probe: DiagnosticProbe | undefined,
  timeoutMs: number,
): Promise<{ id: DiagnosticId; result: DiagnosticProbeResult }> {
  if (!probe) {
    return { id, result: { ok: false, confidence: 'suspected', summary: `probe ${id} not registered` } };
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DiagnosticProbeResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, confidence: 'suspected', summary: `probe ${id} timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    // Defer the call so a synchronous throw becomes a rejection the race can catch.
    const result = await Promise.race([
      Promise.resolve().then(() => probe(controller.signal)),
      timeout,
    ]);
    return { id, result };
  } catch (err) {
    return { id, result: { ok: false, confidence: 'suspected', summary: errorSummary(id, err) } };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run the workflow's named diagnostics in parallel, best-effort, and assemble a
 * {@link DiagnosticBundle}. Findings preserve the workflow's diagnostic order.
 */
export async function runDiagnosticBundle(args: RunDiagnosticBundleArgs): Promise<DiagnosticBundle> {
  const { workflow, probes, now } = args;
  const timeoutMs = args.perProbeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const settled = await Promise.all(
    workflow.diagnostics.map((id) => runProbeGuarded(id, probes[id], timeoutMs)),
  );

  const findings: DiagnosticFinding[] = settled.map(({ id, result }) => ({
    id,
    ok: result.ok,
    confidence: result.confidence,
    summary: result.summary,
    ...(result.data ? { data: result.data } : {}),
  }));

  const resetFinding = settled.find((s) => s.id === 'usage-limit-reset-parse');
  const resetAt = resetFinding?.result.resetAt ?? null;

  return {
    errorClass: workflow.errorClass,
    providerKind: workflow.providerKind,
    findings,
    resetAt,
    collectedAt: now,
  };
}
