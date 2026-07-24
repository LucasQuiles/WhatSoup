/**
 * HandoffDistillCoordinator — owns the per-runtime handoff-distillation sweep:
 * the interval timer, the production runner, and the best-effort tick that asks the
 * runner to maybe-distill each active conversation.
 *
 * Extracted from AgentRuntime as a god-class slice (the first into the handoff-distill
 * subsystem). The coordinator is constructed with the db, the instance name, and two
 * config-reader callbacks (isEnabled / getModel) — those readers stay in AgentRuntime
 * because they are also consumed by the health snapshot and context injection. The
 * timer/runner lifecycle and the runner wiring (token-growth, per-call distill closure,
 * persistence, degradation alerting) live here.
 *
 * Behavior is identical to the previous inline methods — see the handoff-distill
 * characterization coverage (provider-fallback.test.ts arm/inert/idempotent cases,
 * handoff-distiller.test.ts for the runner itself, health-snapshot.test.ts).
 */
import type { Database } from '../../core/database.ts';
import { createChildLogger } from '../../logger.ts';
import { getRecentMessages } from '../../core/messages.ts';
import { emitAlertChecked } from '../../lib/emit-alert.ts';
import { providerPreview } from './provider-preview-sanitizer.ts';
import { redactHandoffPii } from './handoff-pii-redactor.ts';
import { upsertHandoffArtifact } from './handoff-artifact.ts';
import type { HandoffArtifact } from './handoff-prelude.ts';
import { HandoffDistillRunner } from './handoff-distill-runner.ts';
import { buildHandoffDistill } from './handoff-summarizer.ts';
import { resolveDistillModel, type ResolvedDistillModel } from './handoff-distill-model.ts';
import { type DistillBudgetConfig } from './handoff-distill-gate.ts';
import { resolveHandoffDistillConfig } from './handoff-distill-config.ts';
import { getSessionTokenSnapshot, listActiveSessionRows } from './session-db.ts';
import { errorMessage } from '../../lib/error-message.ts';

// Same component name as AgentRuntime: the sweep / arm / degraded log lines keep their
// existing `component: 'agent-runtime'` binding (no observable change).
const log = createChildLogger('agent-runtime');

// Env-resolved distill knobs (sweep cadence, growth threshold, verbatim window, budget).
// Cluster-local — only the sweep coordinator reads these.
const HANDOFF_DISTILL_RESOLVED = resolveHandoffDistillConfig(process.env);
const HANDOFF_DISTILL_SWEEP_MS = HANDOFF_DISTILL_RESOLVED.sweepMs;
const HANDOFF_DISTILL_GROWTH_THRESHOLD = HANDOFF_DISTILL_RESOLVED.growthThreshold;
const HANDOFF_DISTILL_VERBATIM_N = HANDOFF_DISTILL_RESOLVED.verbatimN;
const HANDOFF_DISTILL_BUDGET: DistillBudgetConfig = HANDOFF_DISTILL_RESOLVED.budget;

export interface HandoffDistillCoordinatorDeps {
  db: Database;
  instanceName: string;
  /** Feature flag — whether the distiller is enabled (env-backed in AgentRuntime). */
  isEnabled: () => boolean;
  /** Configured distill model id, or null (env-backed in AgentRuntime). */
  getModel: () => string | null;
}

export class HandoffDistillCoordinator {
  /** The sweep interval, or null when not armed. Public: tests assert/reset it. */
  timer: ReturnType<typeof setInterval> | null = null;
  /** The active runner, or null when not armed. Public: tests assert it. */
  runner: HandoffDistillRunner | null = null;

  private readonly db: Database;
  private readonly instanceName: string;
  private readonly isEnabled: () => boolean;
  private readonly getModel: () => string | null;

  constructor(deps: HandoffDistillCoordinatorDeps) {
    this.db = deps.db;
    this.instanceName = deps.instanceName;
    this.isEnabled = deps.isEnabled;
    this.getModel = deps.getModel;
  }

  /**
   * Arm the sweep timer + runner if the distiller is enabled and a model/key
   * resolves. Idempotent (a second call while armed is a no-op). Enabled-but-inert
   * (no model/key) logs once and does not arm.
   */
  start(): void {
    if (!this.isEnabled()) return; // flag off → no runner, no timer
    if (this.timer) return; // already armed (idempotent)

    const resolved = resolveDistillModel(this.getModel(), process.env);
    if (!resolved) {
      // Enabled-but-inert: unknown model or no key. Don't arm — log once so the
      // misconfiguration is observable, then behave as if disabled.
      log.warn(
        { instance: this.instanceName, model: this.getModel() ?? null },
        'handoff distiller enabled but inert: no model/key resolved — sweep not armed',
      );
      return;
    }

    this.runner = this.buildRunner(resolved);
    this.timer = setInterval(() => void this.sweep(), HANDOFF_DISTILL_SWEEP_MS);
    this.timer.unref?.();
    log.info(
      { instance: this.instanceName, provider: resolved.provider, model: resolved.model, sweepMs: HANDOFF_DISTILL_SWEEP_MS },
      'handoff distiller armed',
    );
  }

  /** Stop the sweep timer and drop the runner. */
  shutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.runner = null;
  }

  /** Construct the production runner. `resolved` is captured for distillFor. */
  private buildRunner(resolved: ResolvedDistillModel): HandoffDistillRunner {
    // Per-conversation token baseline: total input+output since the row's last
    // compact. The runner compares this against the growth threshold; the gate
    // bills spend separately, so this only decides eligibility.
    //
    // #1774: totalInputTokens/lastCompactInputTokens now mean genuinely-new
    // input only (cache_read excluded) — deliberately NOT compensated back
    // to the old combined value here (contrast with maybeStartAutoCompact in
    // runtime.ts, which does compensate). For handoff-distill eligibility,
    // genuinely-new input is the semantically better growth signal than
    // repeated re-reads of the same prior context, so this is an intentional
    // improvement: growth now tracks real new content, not context size.
    const tokenGrowth = (conversationKey: string): number => {
      const rowId = this.rowIdFor(conversationKey);
      if (rowId === null) return 0;
      const snap = getSessionTokenSnapshot(this.db, rowId);
      if (!snap) return 0;
      const sinceCompact =
        (snap.totalInputTokens - snap.lastCompactInputTokens) +
        (snap.totalOutputTokens - snap.lastCompactOutputTokens);
      return Math.max(0, sinceCompact);
    };

    const distillFor = (conversationKey: string): Promise<{ summary: string; seededArtifacts: string | null; tokensUsed: number }> => {
      // Build a fresh distill closure per call so loadMessages reads current
      // history. buildHandoffDistill throws HandoffSummarizerInertError if the
      // key vanished; the runner folds any throw as a failure (fail-safe).
      const run = buildHandoffDistill({
        model: resolved.model,
        apiKey: resolved.apiKey,
        endpoint: resolved.endpoint,
        conversationKey,
        loadMessages: () => getRecentMessages(this.db, conversationKey, HANDOFF_DISTILL_VERBATIM_N),
        redact: (t) => redactHandoffPii(t),
        verbatimN: HANDOFF_DISTILL_VERBATIM_N,
      });
      return run().then((o) => ({ summary: o.summary, seededArtifacts: o.seededArtifacts ?? null, tokensUsed: o.tokensUsed }));
    };

    return new HandoffDistillRunner({
      config: HANDOFF_DISTILL_BUDGET,
      now: () => Date.now(),
      growthThreshold: HANDOFF_DISTILL_GROWTH_THRESHOLD,
      tokenGrowth,
      distillFor,
      persist: (artifact: HandoffArtifact) => upsertHandoffArtifact(this.db, artifact),
      onDegraded: (conversationKey, reason) => this.onDegraded(conversationKey, reason),
      sourceFor: () => ({ provider: resolved.provider, model: resolved.model }),
    });
  }

  /** Resolve the active session rowId for a conversation key (or null). */
  private rowIdFor(conversationKey: string): number | null {
    for (const row of listActiveSessionRows(this.db)) {
      if (row.conversationKey === conversationKey) return row.rowId;
    }
    return null;
  }

  /**
   * One sweep tick: enumerate active conversations and ask the runner to maybe
   * distill each. Fully best-effort — any throw is caught and swallowed so a
   * distiller error can never crash a turn or the process.
   */
  private async sweep(): Promise<void> {
    const runner = this.runner;
    if (!runner) return;
    try {
      const rows = listActiveSessionRows(this.db);
      const seen = new Set<string>();
      for (const { conversationKey } of rows) {
        if (seen.has(conversationKey)) continue; // dedup multiple rows per chat
        seen.add(conversationKey);
        try {
          await runner.tickConversation(conversationKey);
        } catch (err) {
          log.warn(
            { instance: this.instanceName, conversationKey, err: errorMessage(err) },
            'handoff distill tick failed (folded, continuing)',
          );
        }
      }
      // Bound memory: forget gate state for conversations no longer active.
      runner.prune(seen);
      log.info(
        { instance: this.instanceName, ticked: seen.size },
        'handoff distill sweep complete',
      );
    } catch (err) {
      // Enumeration itself failed — swallow; next tick retries.
      log.warn(
        { instance: this.instanceName, err: errorMessage(err) },
        'handoff distill sweep failed (folded)',
      );
    }
  }

  /** Degradation signal from the runner — emit a redacted operational alert. */
  private onDegraded(conversationKey: string, reason: string): void {
    const source = `handoff-distill:${this.instanceName}`;
    // Reason may echo upstream error text; redact before it leaves the process.
    const safeReason = providerPreview(reason, 200);
    try {
      emitAlertChecked(
        this.instanceName,
        source,
        'Handoff distiller degraded',
        [`conversation: ${conversationKey}`, `reason: ${safeReason}`].join('\n'),
        'warning',
      );
    } catch (err) {
      log.warn(
        { instance: this.instanceName, conversationKey, err: errorMessage(err) },
        'failed to emit handoff distiller degraded alert',
      );
    }
  }
}
