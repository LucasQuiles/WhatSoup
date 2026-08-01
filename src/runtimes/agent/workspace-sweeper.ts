/**
 * workspace-sweeper.ts — idle per-chat workspace eviction policy + timer.
 *
 * Extracted from AgentRuntime's module/class scope as a god-class decomposition
 * slice (BEAD-WORKSPACE-4). The `workspaceResources` registry itself STAYS in
 * AgentRuntime (it is woven across start / shutdown / createSessionManager /
 * handoff / MCP-socket allocation — ~14 sites); the sweeper borrows a reference
 * to that same Map and owns only the idle-eviction responsibility: the periodic
 * sweep timer, the eviction pass, and the per-turn activity touch.
 *
 * `isSessionActive` is a late-bound predicate over AgentRuntime.chatSessions so
 * the sweeper preserves workspaces whose chat session is still active without
 * holding a reference to the whole session registry. Behavior is identical to
 * the prior in-class methods; the migrated characterization suite is the proof.
 */
import { createChildLogger } from '../../logger.ts';
import { WhatSoupSocketServer } from '../../mcp/socket-server.ts';
import { type MediaBridge } from './media-bridge.ts';
import { MS_PER_MINUTE } from '../../lib/time-units.ts';

const log = createChildLogger('agent-runtime');

export interface WorkspaceResource {
  socketPath: string;
  workspacePath: string;
  socketServer: WhatSoupSocketServer | null;
  mediaBridge: MediaBridge | null;
  lastActivity: number;
}

export class WorkspaceSweeper {
  /** The periodic sweep interval handle. Public so tests can assert lifecycle. */
  timer: ReturnType<typeof setInterval> | null = null;

  private static readonly WORKSPACE_IDLE_MS = 30 * MS_PER_MINUTE;
  private static readonly WORKSPACE_SWEEP_INTERVAL_MS = 5 * MS_PER_MINUTE;

  // Explicit fields + assignment, NOT TS constructor parameter-properties: Node's
  // --experimental-strip-types rejects the access-modifier-in-constructor-args
  // shorthand with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX (tests/strip-types-compat.test.ts).
  private readonly sandboxPerChat: boolean;
  private readonly workspaces: Map<string, WorkspaceResource>;
  private readonly isSessionActive: (workspaceKey: string) => boolean;

  constructor(
    sandboxPerChat: boolean,
    workspaces: Map<string, WorkspaceResource>,
    isSessionActive: (workspaceKey: string) => boolean,
  ) {
    this.sandboxPerChat = sandboxPerChat;
    this.workspaces = workspaces;
    this.isSessionActive = isSessionActive;
  }

  start(): void {
    if (!this.sandboxPerChat || this.timer) return;
    this.timer = setInterval(
      () => this.sweep(),
      WorkspaceSweeper.WORKSPACE_SWEEP_INTERVAL_MS,
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  sweep(): void {
    if (!this.sandboxPerChat) return;

    const now = Date.now();
    for (const [workspaceKey, res] of this.workspaces) {
      if (this.isSessionActive(workspaceKey)) {
        res.lastActivity = now;
        continue;
      }

      const idleMs = now - res.lastActivity;
      if (idleMs <= WorkspaceSweeper.WORKSPACE_IDLE_MS) continue;

      log.info({ workspaceKey, idleMs }, 'evicting idle workspace resources');

      if (res.socketServer) {
        try {
          res.socketServer.stop();
        } catch (err) {
          log.warn({ err, workspaceKey, socketPath: res.socketPath }, 'idle workspace socket server stop failed');
        }
      }
      if (res.mediaBridge) {
        try {
          res.mediaBridge();
        } catch (err) {
          log.warn({ err, workspaceKey, workspacePath: res.workspacePath }, 'idle workspace media bridge stop failed');
        }
      }

      this.workspaces.delete(workspaceKey);
    }
  }

  touch(mapKey: string | undefined): void {
    if (mapKey === undefined) return;
    const res = this.workspaces.get(mapKey);
    if (res) {
      res.lastActivity = Date.now();
    }
  }
}
