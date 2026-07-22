import { emitAlertChecked } from '../../lib/emit-alert.ts';
import { createChildLogger } from '../../logger.ts';
import {
  alertEvidenceValue,
  alertExcerpt,
  safeAlertSegment,
  shouldEmitToolFailureAlert,
} from './tool-update.ts';
import type { ToolUpdate } from './outbound-queue.ts';

const log = createChildLogger('agent-runtime');
const TOOL_FAILURE_ALERT_DEDUP_MS = 60 * 1000;
const MAX_TOOL_FAILURE_ALERT_DEDUP_KEYS = 1_000;

export function capDedupeMap(
  map: Map<string, unknown>,
  max = MAX_TOOL_FAILURE_ALERT_DEDUP_KEYS,
): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function emitRuntimeToolFailureAlert(options: {
  recentAlerts: Map<string, number>;
  instanceName: string;
  provider: string;
  sessionScope: string;
  cwd: string;
  chatJid: string | null | undefined;
  toolId: string;
  toolName: string;
  content: string;
  classification: ToolUpdate;
  toolScopeKey: string;
  mapKey?: string;
}): void {
  if (process.env['BOT_ERRORS_RUNTIME_TOOL_FAILURE_ALERTS'] === '0') return;
  if (!shouldEmitToolFailureAlert(options.classification.category, options.content)) {
    log.debug(
      {
        instance: options.instanceName,
        toolName: options.toolName,
        category: options.classification.category,
      },
      'suppressing benign tool-error (not operator-actionable) — no BOT ERRORS alert',
    );
    return;
  }

  const now = Date.now();
  for (const [key, recordedAt] of options.recentAlerts) {
    if (now - recordedAt > TOOL_FAILURE_ALERT_DEDUP_MS) options.recentAlerts.delete(key);
  }
  const fingerprint = [
    options.instanceName,
    options.provider,
    options.toolName,
    options.classification.category,
    options.content.replace(/\s+/g, ' ').trim().slice(0, 500),
  ].join('\n');
  if (options.recentAlerts.has(fingerprint)) return;
  options.recentAlerts.set(fingerprint, now);
  capDedupeMap(options.recentAlerts);

  const source = `runtime-tool-error:${safeAlertSegment(options.provider)}:${safeAlertSegment(options.toolName)}`;
  const evidence = [
    'runtime_source=src/runtimes/agent/runtime.ts:tool_result',
    `instance=${alertEvidenceValue(options.instanceName)}`,
    `provider=${alertEvidenceValue(options.provider)}`,
    `session_scope=${options.sessionScope}`,
    `chat_jid=${alertEvidenceValue(options.chatJid ?? null)}`,
    `tool_scope_key=${alertEvidenceValue(options.toolScopeKey)}`,
    `map_key=${alertEvidenceValue(options.mapKey ?? null)}`,
    `tool_id=${alertEvidenceValue(options.toolId)}`,
    `tool_name=${alertEvidenceValue(options.toolName)}`,
    `classification=${options.classification.category}`,
    `detail=${alertEvidenceValue(options.classification.detail)}`,
    `cwd=${alertEvidenceValue(options.cwd)}`,
    'error_excerpt:',
    alertExcerpt(options.content) || 'unknown',
  ].join('\n');

  try {
    emitAlertChecked(
      options.instanceName,
      source,
      `Agent tool failure: ${options.toolName}`,
      evidence,
      'warning',
    );
  } catch (err) {
    log.warn(
      {
        instance: options.instanceName,
        provider: options.provider,
        toolId: options.toolId,
        toolName: options.toolName,
        err: err instanceof Error ? err.message : String(err),
      },
      'failed to emit BOT ERRORS tool failure alert',
    );
  }
}
