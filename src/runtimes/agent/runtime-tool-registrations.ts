// src/runtimes/agent/runtime-tool-registrations.ts
// Inline MCP tool registrations that AgentRuntime.start() wires conditionally:
// `emit_heal_result` (control-plane repair completion) and `restart_self`
// (agent-triggered safe self-restart).
//
// Both were inline `this.registry.register(...)` blocks inside start(). They lift
// out here as a factory (`buildEmitHealResultTool`, mirroring the sibling
// `buildRestartSelfTool` in self-restart.ts) plus a single registration entry
// point (`registerRuntimeInlineTools`) that applies each tool's exact guard.
// The emit_heal_result handler couples to the runtime's control-report slot,
// which is also touched by the control-terminal path — so instead of a wildcard
// `this`, it receives a NARROW port exposing only the control-report accessors it
// needs (get active / already-completed / mark-completed) plus the control queue,
// durability, messenger, and db. This is the extraction that gives QR-017
// tool-group tagging a home outside the runtime's arch.file-size ceiling (#1977).

import type { Database } from '../../core/database.ts';
import { type DurabilityEngine, sendTracked } from '../../core/durability.ts';
import { EmitHealResultSchema } from '../../core/heal-protocol.ts';
import { toPersonalJid } from '../../core/jid-constants.ts';
import type { Messenger } from '../../core/types.ts';
import { createChildLogger } from '../../logger.ts';
import type { ToolRegistry } from '../../mcp/registry.ts';
import type { ToolDeclaration } from '../../mcp/types.ts';

import type { ControlQueue } from './control-queue.ts';
import { buildRestartSelfTool, type RestartSelfToolDeps } from './self-restart.ts';

// This logic is a pure extraction from AgentRuntime, so retain the existing
// component binding for operator filters and repair diagnostics.
const log = createChildLogger('agent-runtime');

/**
 * Narrow view of the runtime state + collaborators the `emit_heal_result` handler
 * needs. Deliberately not `this`: the control-report slot
 * (`activeControlReportId` / `controlProtocolCompletedReportId`) is shared with
 * the control-terminal path, so it is exposed only through get/is/mark accessors.
 * `getDurability` is a live getter (durability is attached post-construction via
 * setDurability), while `messenger`/`db` are the runtime's readonly references.
 */
export interface EmitHealResultToolDeps {
  /** Report ID currently being repaired, or null if none is in-flight. */
  getActiveControlReportId(): string | null;
  /** Whether the given report has already emitted its terminal result. */
  isControlReportCompleted(reportId: string): boolean;
  /** Record that the given report's result has been emitted (do not advance the slot). */
  markControlReportCompleted(reportId: string): void;
  /** The internal control queue, or null if not bound. */
  getControlQueue(): ControlQueue | null;
  /** Live durability engine, or null before it is attached. */
  getDurability(): DurabilityEngine | null;
  messenger: Messenger;
  db: Database;
  /** Configured control peers (name → phone); the `loops` entry is the escalation target. */
  controlPeers: Map<string, string>;
  /** Configured admin phones; the first is DM'd on escalation. */
  adminPhones: Set<string>;
}

/**
 * Build the `emit_heal_result` tool declaration. The handler validates the call
 * against the active repair slot, notifies Loops (HEAL_COMPLETE / HEAL_ESCALATE)
 * and — on escalation — DMs the admin, marks the pending row resolved, and records
 * the terminal-result emission. Thin factory mirroring `buildRestartSelfTool`.
 */
export function buildEmitHealResultTool(deps: EmitHealResultToolDeps): ToolDeclaration {
  return {
    name: 'emit_heal_result',
    description: 'Signal completion of a repair cycle. Only callable during an active repair session.',
    schema: EmitHealResultSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    core: false,
    handler: async (params) => {
      const parsed = EmitHealResultSchema.parse(params);

      // Validate: must match active repair
      const activeReportId = deps.getActiveControlReportId();
      if (!activeReportId) {
        throw new Error('No active repair session');
      }
      if (parsed.reportId !== activeReportId) {
        throw new Error(`No active repair for reportId ${parsed.reportId}. Active: ${activeReportId}`);
      }
      if (deps.isControlReportCompleted(parsed.reportId)) {
        throw new Error(`Repair result already emitted for reportId ${parsed.reportId}`);
      }

      const controlQueue = deps.getControlQueue();
      if (!controlQueue) {
        throw new Error('Control queue not found');
      }

      // Determine target JID (Loops)
      const loopsPhone = [...deps.controlPeers.entries()].find(([name]) => name === 'loops')?.[1];
      const loopsJid = loopsPhone ? toPersonalJid(loopsPhone) : null;

      if (parsed.result === 'fixed') {
        if (loopsJid) {
          await controlQueue.sendControlMessage(loopsJid, 'HEAL_COMPLETE', {
            reportId: parsed.reportId,
            errorClass: parsed.errorClass,
            result: 'fixed',
            commitSha: parsed.commitSha,
            diagnosis: parsed.diagnosis,
          }, deps.getDurability() ?? undefined);
        }
      } else {
        // escalate
        if (loopsJid) {
          await controlQueue.sendControlMessage(loopsJid, 'HEAL_ESCALATE', {
            reportId: parsed.reportId,
            errorClass: parsed.errorClass,
            diagnosis: parsed.diagnosis,
          }, deps.getDurability() ?? undefined);
        }
        // Also DM admin
        const adminPhone = [...deps.adminPhones][0];
        if (adminPhone) {
          const adminJid = toPersonalJid(adminPhone);
          await sendTracked(deps.messenger, adminJid,
            `[HEAL_ESCALATE] Repair for ${parsed.errorClass} escalated.\n\n${parsed.diagnosis}`,
            deps.getDurability() ?? undefined, { replayPolicy: 'safe' });
        }
      }

      // Resolve pending_heal_reports row (Type 3 cleanup)
      try {
        deps.db.raw.prepare(
          "UPDATE pending_heal_reports SET state = 'resolved' WHERE report_id = ?",
        ).run(parsed.reportId);
      } catch (err) {
        // best-effort, but visible: a stuck-pending row re-fires stale-open re-notify
        log.warn({ err, reportId: parsed.reportId }, 'failed to mark heal report resolved; row stays pending');
      }

      // The MCP result still has to travel back through this exact provider
      // request. Retain the immutable report owner and the timeout until the
      // provider emits its terminal result; advancing here lets report A's
      // trailing result terminalize a newly-dispatched report B.
      deps.markControlReportCompleted(parsed.reportId);

      return { sent: true, reportId: parsed.reportId, result: parsed.result };
    },
  };
}

/** Registration deps for {@link registerRuntimeInlineTools}. */
export interface RuntimeInlineToolsDeps {
  /** Sandboxed (per-instance) — repair target / non-restarter. */
  sandbox: boolean;
  /** Per-chat sandbox — repair target / non-restarter. */
  sandboxPerChat: boolean;
  /** emit_heal_result deps; registered only when `controlPeers` is non-empty. */
  emitHealResult: EmitHealResultToolDeps;
  /** restart_self deps, or null when no fleet service restarter is wired. */
  restartSelf: RestartSelfToolDeps | null;
}

/**
 * Register the runtime's two inline MCP tools with their exact activation gates,
 * previously inline in AgentRuntime.start():
 *
 * - `emit_heal_result` — only when control peers are configured AND the instance
 *   is neither sandboxed nor per-chat-sandboxed (repairers only, not targets).
 * - `restart_self` — only on a non-sandboxed instance with a service restarter.
 *
 * Registration order (emit_heal_result then restart_self) is preserved.
 */
export function registerRuntimeInlineTools(registry: ToolRegistry, deps: RuntimeInlineToolsDeps): void {
  // Register emit_heal_result MCP tool (once, for control-plane repair completion).
  // Only on non-sandboxed instances (Q) — sandboxed instances (Loops) are repair targets, not repairers.
  // Tagged `core: false` because this registration is conditional on configured control peers;
  // see `src/mcp/types.ts` for the contract — non-core tools must tolerate absence on instances
  // that do not meet the gate (no control peers, sandbox mode, or per-chat sandbox).
  if (deps.emitHealResult.controlPeers.size > 0 && !deps.sandboxPerChat && !deps.sandbox) {
    registry.register(buildEmitHealResultTool(deps.emitHealResult));
  }

  // Register restart_self MCP tool (agent instance only — sandboxed instances
  // are repair targets, not self-restarters). Routes through the existing
  // graceful shutdown via ServiceManager.restart; logic lives in self-restart.ts.
  // Requires the fleet-owned restarter injected from the composition root.
  if (!deps.sandbox && !deps.sandboxPerChat && deps.restartSelf) {
    registry.register(buildRestartSelfTool(deps.restartSelf));
  }
}
