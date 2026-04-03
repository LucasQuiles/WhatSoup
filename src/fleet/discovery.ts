import * as fs from 'node:fs';
import * as path from 'node:path';
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

        const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

        // Resolve paths using XDG conventions (mirror instance-loader.ts resolvePaths)
        const instDataRoot = dataRoot(name);
        const instStateRoot = stateRoot(name);
        const logDir = path.join(instDataRoot, 'logs');
        const dbPath = path.join(instDataRoot, 'bot.db');

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
          socketPath = raw.socketPath ?? path.join(instStateRoot, 'whatsoup.sock');
        } else if (raw.type === 'agent') {
          socketPath = path.join(instStateRoot, 'whatsoup.sock');
        }

        this.instances.set(name, {
          name,
          type: raw.type ?? 'chat',
          accessMode: raw.accessMode ?? 'self_only',
          healthPort: raw.healthPort ?? 3010,
          dbPath,
          stateRoot: instStateRoot,
          logDir,
          healthToken,
          configPath,
          socketPath,
          gui: raw.gui,
          guiPort: raw.guiPort,
          models: raw.models ?? undefined,
          sandboxPerChat: raw.agentOptions?.sandboxPerChat ?? undefined,
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
