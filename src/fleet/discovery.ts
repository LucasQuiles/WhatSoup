import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VALID_ACCESS_MODES, VALID_SESSION_SCOPES, VALID_TYPES } from '../instance-loader.ts';
import { createChildLogger } from '../logger.ts';
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
  gui?: boolean;
  guiPort?: number;
  models?: InstanceModels;
  sandboxPerChat?: boolean;
  configError?: string | null;
}

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
        } catch { /* no tokens.env — health token stays null */ }

        // Determine socket path based on instance type
        let socketPath: string | null = null;
        if (raw.type === 'passive') {
          socketPath = typeof raw.socketPath === 'string' && raw.socketPath ? raw.socketPath : path.join(instStateRoot, 'whatsoup.sock');
        } else if (raw.type === 'agent') {
          // Agent runtime creates socket at <cwd>/.claude/whatsoup.sock (for Claude Code IDE integration),
          // NOT in the XDG state directory. Resolve from agentOptions.cwd or homedir fallback.
          const agentOpts = typeof raw.agentOptions === 'object' && raw.agentOptions !== null && !Array.isArray(raw.agentOptions)
            ? raw.agentOptions as Record<string, unknown> : {};
          const agentCwd = typeof agentOpts.cwd === 'string' ? agentOpts.cwd : os.homedir();
          socketPath = path.join(agentCwd, '.claude', 'whatsoup.sock');
        }

        this.instances.set(name, {
          name,
          type: VALID_TYPES.has(String(raw.type)) ? (raw.type as 'passive' | 'chat' | 'agent') : 'chat',
          accessMode: typeof raw.accessMode === 'string' ? raw.accessMode : 'self_only',
          healthPort: typeof raw.healthPort === 'number' ? raw.healthPort : 3010,
          dbPath,
          stateRoot: instStateRoot,
          logDir,
          healthToken,
          configPath,
          socketPath,
          gui: typeof raw.gui === 'boolean' ? raw.gui : undefined,
          guiPort: typeof raw.guiPort === 'number' ? raw.guiPort : undefined,
          models: raw.models as InstanceModels | undefined,
          sandboxPerChat: typeof raw.agentOptions === 'object' && raw.agentOptions !== null && !Array.isArray(raw.agentOptions)
            ? ((raw.agentOptions as Record<string, unknown>).sandboxPerChat as boolean | undefined)
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

    log.info({ count: this.instances.size }, 'fleet scan complete');
    return this.instances;
  }

  /** Start 60-second refresh interval */
  startAutoRefresh(): void {
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
  if (raw.type !== undefined && !VALID_TYPES.has(String(raw.type))) {
    return `Invalid type "${String(raw.type)}": must be one of ${[...VALID_TYPES].join(', ')}`;
  }

  if (raw.accessMode !== undefined && !VALID_ACCESS_MODES.has(String(raw.accessMode))) {
    return `Invalid accessMode "${String(raw.accessMode)}": must be one of ${[...VALID_ACCESS_MODES].join(', ')}`;
  }

  if (raw.healthPort !== undefined && raw.healthPort !== null && (typeof raw.healthPort !== 'number' || raw.healthPort < 1 || raw.healthPort > 65535)) {
    return `Invalid healthPort "${String(raw.healthPort)}": must be a number between 1 and 65535`;
  }

  if (raw.type === 'agent') {
    const agentOpts = raw.agentOptions;
    if (agentOpts !== undefined && agentOpts !== null) {
      if (typeof agentOpts !== 'object' || Array.isArray(agentOpts)) {
        return 'agentOptions must be an object';
      }
      const opts = agentOpts as Record<string, unknown>;
      if (!VALID_SESSION_SCOPES.has(String(opts.sessionScope ?? ''))) {
        return `agentOptions.sessionScope is required and must be one of ${[...VALID_SESSION_SCOPES].join(', ')}`;
      }
      if (opts.cwd !== undefined && typeof opts.cwd !== 'string') {
        return 'agentOptions.cwd must be a string when provided';
      }
      if (opts.instructionsPath !== undefined && typeof opts.instructionsPath !== 'string') {
        return 'agentOptions.instructionsPath must be a string';
      }
      if (opts.pluginDirs !== undefined) {
        if (!Array.isArray(opts.pluginDirs) || !opts.pluginDirs.every((d: unknown) => typeof d === 'string')) {
          return 'agentOptions.pluginDirs must be an array of strings';
        }
      }
      if (opts.sandboxPerChat === true && opts.sessionScope !== 'per_chat') {
        return 'agentOptions.sandboxPerChat requires sessionScope "per_chat"';
      }
      if (opts.provider !== undefined) {
        if (typeof opts.provider !== 'string' || (opts.provider as string).trim() === '') {
          return 'agentOptions.provider must be a non-empty string when provided';
        }
      }
      if (opts.providerConfig !== undefined) {
        if (typeof opts.providerConfig !== 'object' || Array.isArray(opts.providerConfig) || opts.providerConfig === null) {
          return 'agentOptions.providerConfig must be an object when provided';
        }
        const pc = opts.providerConfig as Record<string, unknown>;
        if (pc.budget !== undefined) {
          if (typeof pc.budget !== 'object' || Array.isArray(pc.budget) || pc.budget === null) {
            return 'agentOptions.providerConfig.budget must be an object when provided';
          }
        }
      }
      if (opts.sessionScope !== 'shared' && opts.sessionScope !== 'per_chat' && raw.accessMode !== 'self_only') {
        return `Agent instances require accessMode "self_only", got "${String(raw.accessMode)}"`;
      }
    } else if (raw.accessMode !== undefined && raw.accessMode !== 'self_only') {
      return `Agent instances require accessMode "self_only", got "${String(raw.accessMode)}"`;
    }
  }

  if (raw.type === 'passive') {
    if (raw.systemPrompt) {
      return 'Passive instances must not have a systemPrompt';
    }
    if (raw.accessMode !== undefined && raw.accessMode !== 'self_only') {
      return `Passive instances require accessMode "self_only", got "${String(raw.accessMode)}"`;
    }
  }

  return null;
}
