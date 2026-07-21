import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VALID_TYPES } from '../instance-loader.ts';
import { validateInstanceConfig } from '../core/agent-config-validator.ts';
import { expandHomePath } from '../lib/home-path.ts';
import { createChildLogger } from '../logger.ts';
import { DEFAULT_INSTANCE_HEALTH_PORT } from './constants.ts';
import { configRoot as defaultConfigRoot, dataRoot, stateRoot } from './paths.ts';

const log = createChildLogger('fleet:discovery');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InstanceModels {
  conversation?: string;
  fallback?: string;
  extraction?: string;
  validation?: string;
}

export interface DiscoveredInstance {
  name: string;
  type: 'passive' | 'chat' | 'agent';
  accessMode: string;
  healthPort: number;
  dbPath: string;
  stateRoot: string;
  logDir: string;
  healthToken: string | null;
  configPath: string;
  socketPath: string | null;
  transport?: string;
  gui?: boolean;
  guiPort?: number;
  models?: InstanceModels;
  sandboxPerChat?: boolean;
  provider?: string;
  configError?: string | null;
  /**
   * Names of other agent instances whose effective working directory resolves
   * to the same path as this one. A shared cwd is a misconfiguration: each
   * agent runtime writes MCP config files (opencode.json / .mcp.json) into its
   * cwd at startup via read-merge-write, so concurrent instances interleave
   * those writes. Discovery surfaces the collision; it does not lock.
   * Absent when the cwd is unique (or for non-agent instances).
   */
  sharedCwdWith?: string[];
}

/**
 * Grouping marker for agent instances without an explicit agentOptions.cwd.
 * The agent runtime falls back to os.homedir(), so two defaulting instances
 * collide regardless of what homedir resolves to at runtime — group on the
 * marker rather than resolving homedir here.
 */
const HOME_DEFAULT_CWD = '<home-default>';

// ---------------------------------------------------------------------------
// FleetDiscovery
// ---------------------------------------------------------------------------

export class FleetDiscovery {
  private instances: Map<string, DiscoveredInstance> = new Map();
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private readonly configRoot: string;

  constructor(configRoot?: string) {
    this.configRoot = configRoot ?? defaultConfigRoot();
  }

  /** Synchronous filesystem scan of instances directory */
  scan(): Map<string, DiscoveredInstance> {
    this.instances.clear();

    // Effective working directory per agent-type instance, used to detect
    // shared-cwd misconfigurations after the scan loop.
    const agentCwds = new Map<string, string>();

    let entries: string[];
    try {
      entries = fs.readdirSync(this.configRoot);
    } catch {
      log.warn({ configRoot: this.configRoot }, 'instances directory not found');
      return this.instances;
    }

    for (const name of entries) {
      try {
        const configPath = path.join(this.configRoot, name, 'config.json');
        if (!fs.existsSync(configPath)) continue;

        // Resolve paths using XDG conventions (mirror instance-loader.ts resolvePaths)
        const instDataRoot = dataRoot(name);
        const instStateRoot = stateRoot(name);
        const logDir = path.join(instDataRoot, 'logs');
        const dbPath = path.join(instDataRoot, 'bot.db');

        let raw: Record<string, unknown> = {};
        let configError: string | null = null;
        try {
          const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            configError = 'Invalid config.json: config is not a JSON object';
          } else {
            raw = parsed as Record<string, unknown>;
            configError = validateConfig(raw, name);
          }
        } catch (err) {
          configError = `Invalid config.json: ${(err as Error).message}`;
        }

        // Honor the `enabled: false` opt-out so operators can keep a config on
        // disk while taking it out of fleet rotation (no polling, no proxy).
        if (raw.enabled === false) {
          log.info({ name }, 'fleet scan: skipping disabled instance');
          continue;
        }

        // Read health token from tokens.env
        let healthToken: string | null = null;
        const tokensPath = path.join(this.configRoot, name, 'tokens.env');
        try {
          const tokensContent = fs.readFileSync(tokensPath, 'utf-8');
          for (const line of tokensContent.split('\n')) {
            const match = line.match(/^WHATSOUP_HEALTH_TOKEN=(.+)$/);
            if (match) {
              healthToken = match[1].trim();
              break;
            }
          }
        } catch (err) {
          // ENOENT is the normal no-token case; anything else (perms, encoding)
          // would silently strand the instance behind 401s downstream.
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            log.warn({ err, tokensPath }, 'tokens.env unreadable; instance polled without a health token');
          }
        }

        // Determine socket path based on instance type
        let socketPath: string | null = null;
        if (raw.type === 'passive') {
          socketPath = typeof raw.socketPath === 'string' && raw.socketPath ? raw.socketPath : path.join(instStateRoot, 'whatsoup.sock');
        } else if (raw.type === 'agent') {
          // Agent runtime creates socket at <cwd>/.claude/whatsoup.sock (for Claude Code IDE integration),
          // NOT in the XDG state directory. Resolve from agentOptions.cwd or homedir fallback.
          const agentOpts = typeof raw.agentOptions === 'object' && raw.agentOptions !== null && !Array.isArray(raw.agentOptions)
            ? raw.agentOptions as Record<string, unknown> : {};
          const rawCwd = typeof agentOpts.cwd === 'string' ? agentOpts.cwd : os.homedir();
          const agentCwd = expandHomePath(rawCwd);
          socketPath = path.join(agentCwd, '.claude', 'whatsoup.sock');
          // Record the effective cwd for shared-cwd collision detection. An
          // explicit non-empty cwd groups on its expanded path; otherwise the
          // instance defaults to homedir at runtime, so it groups on the
          // home-default marker.
          agentCwds.set(
            name,
            typeof agentOpts.cwd === 'string' && agentOpts.cwd.trim() !== ''
              ? expandHomePath(agentOpts.cwd)
              : HOME_DEFAULT_CWD,
          );
        }

        this.instances.set(name, {
          name,
          type: VALID_TYPES.has(String(raw.type)) ? (raw.type as 'passive' | 'chat' | 'agent') : 'chat',
          accessMode: typeof raw.accessMode === 'string' ? raw.accessMode : 'self_only',
          healthPort: typeof raw.healthPort === 'number' ? raw.healthPort : DEFAULT_INSTANCE_HEALTH_PORT,
          dbPath,
          stateRoot: instStateRoot,
          logDir,
          healthToken,
          configPath,
          socketPath,
          transport: raw.transport === undefined
            ? 'baileys'
            : typeof raw.transport === 'string' ? raw.transport : 'invalid',
          gui: typeof raw.gui === 'boolean' ? raw.gui : undefined,
          guiPort: typeof raw.guiPort === 'number' ? raw.guiPort : undefined,
          models: raw.models as InstanceModels | undefined,
          sandboxPerChat: typeof raw.agentOptions === 'object' && raw.agentOptions !== null && !Array.isArray(raw.agentOptions)
            ? ((raw.agentOptions as Record<string, unknown>).sandboxPerChat as boolean | undefined)
            : undefined,
          provider: typeof raw.agentOptions === 'object' && raw.agentOptions !== null && !Array.isArray(raw.agentOptions)
            ? ((raw.agentOptions as Record<string, unknown>).provider as string | undefined) ?? undefined
            : undefined,
          configError,
        });
      } catch (err) {
        log.warn(
          { name, error: (err as Error).message },
          'failed to parse instance config',
        );
      }
    }

    this.flagSharedAgentCwds(agentCwds);

    log.info({ count: this.instances.size }, 'fleet scan complete');
    return this.instances;
  }

  /**
   * Warn once per group of agent instances that resolve the same effective
   * working directory, and mark each member with the names of its peers.
   * Non-fatal: the collision is surfaced (log + sharedCwdWith), never locked.
   */
  private flagSharedAgentCwds(agentCwds: Map<string, string>): void {
    const groups = new Map<string, string[]>();
    for (const [name, cwd] of agentCwds) {
      const group = groups.get(cwd);
      if (group) {
        group.push(name);
      } else {
        groups.set(cwd, [name]);
      }
    }

    for (const [cwd, names] of groups) {
      if (names.length < 2) continue;
      const instances = [...names].sort();
      log.warn(
        { cwd, instances },
        'fleet scan: agent instances share a working directory',
      );
      for (const name of instances) {
        const inst = this.instances.get(name);
        if (inst) inst.sharedCwdWith = instances.filter((peer) => peer !== name);
      }
    }
  }

  /** Start 60-second refresh interval */
  startAutoRefresh(): void {
    if (this.refreshInterval) return;
    this.scan();
    this.refreshInterval = setInterval(() => this.scan(), 60_000);
    this.refreshInterval.unref();
  }

  /** Stop auto-refresh */
  stop(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  /** Get current fleet map (returns a copy) */
  getInstances(): Map<string, DiscoveredInstance> {
    return new Map(this.instances);
  }

  /** Get single instance by name */
  getInstance(name: string): DiscoveredInstance | undefined {
    return this.instances.get(name);
  }
}

function validateConfig(raw: Record<string, unknown>, name: string): string | null {
  // Thin wrapper around the shared validator. Discovery stays aligned with
  // load-time validation so scans do not mark a config valid when restart would
  // reject it. Invalid configs are still surfaced with configError in the UI.
  const error = validateInstanceConfig(raw, { name, mode: 'discovery' });
  return error ? error.message : null;
}
