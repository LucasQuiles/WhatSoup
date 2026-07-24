// src/runtimes/agent/tool-failure-alert.ts
// Operator-actionable tool-failure alerting for the agent runtime.
//
// When the agent reports a tool_result error, this decides whether it is an
// operator-actionable failure (vs a benign non-zero Bash exit) and, if so, emits
// a deduplicated BOT ERRORS alert. Extracted from AgentRuntime as a pure function
// that receives its dedup state and collaborators via a narrow deps object rather
// than closing over `this`: the per-instance dedup map is owned by the runtime and
// passed in, the provider label is resolved live at call time, and the alert sink
// is injectable so the emission contract is unit-testable.

import { emitAlertChecked } from '../../lib/emit-alert.ts';
import { errorMessage } from '../../lib/error-message.ts';
import { createChildLogger } from '../../logger.ts';

import type { ToolUpdate } from './outbound-queue.ts';
import {
  alertEvidenceValue,
  alertExcerpt,
  safeAlertSegment,
  shouldEmitToolFailureAlert,
} from './tool-update.ts';

// This logic is a pure extraction from AgentRuntime, so retain the existing
// component binding for operator filters and alert diagnostics.
const log = createChildLogger('agent-runtime');

/** Dedup window: a fingerprint seen within this window is suppressed as a repeat. */
export const TOOL_FAILURE_ALERT_DEDUP_MS = 60 * 1000;

/** Per-tool-result inputs describing the failure being considered for an alert. */
export interface ToolFailureAlertArgs {
  chatJid: string | null | undefined;
  toolId: string;
  toolName: string;
  content: string;
  classification: ToolUpdate;
  toolScopeKey: string;
  mapKey?: string;
}

/** Runtime-supplied state + collaborators (narrow; no `this`). */
export interface ToolFailureAlertDeps {
  instanceName: string;
  sessionScope: string;
  cwd: string | undefined;
  /** Effective provider label, resolved live exactly as the runtime computes it. */
  resolveProvider: () => string;
  /** Per-instance dedup map, owned by the caller and mutated in place. */
  recentToolFailureAlerts: Map<string, number>;
  /** Evict-oldest cap for the dedup map (the runtime's shared capDedupeMap). */
  capDedupeMap: (map: Map<string, unknown>) => void;
  /** Alert sink; defaults to emitAlertChecked. Injected in tests to observe emission. */
  emitAlert?: typeof emitAlertChecked;
  /** Injectable clock; defaults to Date.now. */
  now?: () => number;
}

/**
 * Consider a tool_result error for an operator alert. No-op when alerting is
 * disabled, the error is benign (non-actionable), or an identical failure was
 * alerted within {@link TOOL_FAILURE_ALERT_DEDUP_MS}. Otherwise emits one
 * deduplicated BOT ERRORS alert. Never throws into the caller.
 */
export function maybeEmitToolFailureAlert(args: ToolFailureAlertArgs, deps: ToolFailureAlertDeps): void {
  if (process.env['BOT_ERRORS_RUNTIME_TOOL_FAILURE_ALERTS'] === '0') return;

  // Root-cause noise gate: a non-zero Bash exit (glob/grep no-match, failed
  // conditional, missing path) is reported by claude-cli as `is_error` but is
  // a normal agent-loop result, not an operator-actionable failure. Only page
  // when the error carries an infra/provider-health signature.
  if (!shouldEmitToolFailureAlert(args.classification.category, args.content)) {
    log.debug(
      {
        instance: deps.instanceName,
        toolName: args.toolName,
        category: args.classification.category,
      },
      'suppressing benign tool-error (not operator-actionable) — no BOT ERRORS alert',
    );
    return;
  }

  const now = (deps.now ?? Date.now)();
  for (const [key, recordedAt] of deps.recentToolFailureAlerts) {
    if (now - recordedAt > TOOL_FAILURE_ALERT_DEDUP_MS) {
      deps.recentToolFailureAlerts.delete(key);
    }
  }

  const provider = deps.resolveProvider();
  const source = `runtime-tool-error:${safeAlertSegment(provider)}:${safeAlertSegment(args.toolName)}`;
  const fingerprint = [
    deps.instanceName,
    provider,
    args.toolName,
    args.classification.category,
    args.content.replace(/\s+/g, ' ').trim().slice(0, 500),
  ].join('\n');

  if (deps.recentToolFailureAlerts.has(fingerprint)) return;
  deps.recentToolFailureAlerts.set(fingerprint, now);
  deps.capDedupeMap(deps.recentToolFailureAlerts);

  const evidence = [
    'runtime_source=src/runtimes/agent/runtime.ts:tool_result',
    `instance=${alertEvidenceValue(deps.instanceName)}`,
    `provider=${alertEvidenceValue(provider)}`,
    `session_scope=${deps.sessionScope}`,
    `chat_jid=${alertEvidenceValue(args.chatJid ?? null)}`,
    `tool_scope_key=${alertEvidenceValue(args.toolScopeKey)}`,
    `map_key=${alertEvidenceValue(args.mapKey ?? null)}`,
    `tool_id=${alertEvidenceValue(args.toolId)}`,
    `tool_name=${alertEvidenceValue(args.toolName)}`,
    `classification=${args.classification.category}`,
    `detail=${alertEvidenceValue(args.classification.detail)}`,
    `cwd=${alertEvidenceValue(deps.cwd ?? process.cwd())}`,
    'error_excerpt:',
    alertExcerpt(args.content) || 'unknown',
  ].join('\n');

  const emit = deps.emitAlert ?? emitAlertChecked;
  try {
    emit(
      deps.instanceName,
      source,
      `Agent tool failure: ${args.toolName}`,
      evidence,
      'warning',
    );
  } catch (err) {
    log.warn({
      instance: deps.instanceName,
      provider,
      toolId: args.toolId,
      toolName: args.toolName,
      err: errorMessage(err),
    }, 'failed to emit BOT ERRORS tool failure alert');
  }
}
