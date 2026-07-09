import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMcpLaunchCommand } from './mcp-launcher.ts';
import { SERVICE_ENV_MAP, resolveProviderKeyService } from '../lib/provider-key-service.ts';
import { writePrivateFileSync } from '../lib/private-fs.ts';
import { createChildLogger } from '../logger.ts';

const log = createChildLogger('provider-mcp-config');

/**
 * Subset of `agentOptions.providerConfig` consumed when writing an opencode
 * config file. `baseUrl` selects a custom OpenAI-compatible cloud endpoint;
 * `model` is the model id opencode should target on that endpoint;
 * `apiKeyService` names the keyring service whose key authenticates the
 * endpoint (defaults to the model-prefix-derived service).
 */
export interface OpencodeProviderConfig {
  baseUrl?: string;
  /** Provider id under opencode's top-level `provider` map. Defaults to `whatsoup-cloud`. */
  providerId?: string;
  model?: string;
  apiKeyService?: string;
}

export interface AdditionalMcpServerConfig {
  name: string;
  /** tsx-runner lane (whatsoup proxy, send-media). Mutually exclusive with command. */
  proxyScriptPath?: string;
  /** Explicit-binary lane (e.g. `node <plugin>/mcp-server/dist/index.js`); paths arrive already resolved (src/core/instance-mcp-servers.ts). */
  command?: string;
  args?: readonly string[];
  env: Record<string, string>;
}

function resolveServerLaunch(server: AdditionalMcpServerConfig): { command: string; args: readonly string[] } {
  return server.command !== undefined
    ? { command: server.command, args: server.args ?? [] }
    : buildMcpLaunchCommand(server.proxyScriptPath!);
}

/** Thrown when a just-written MCP config does not contain a required server — the fail-closed layer behind QR-254's strict-drop residual. */
export class McpSurfaceAssertionError extends Error {
  // Explicit fields, not TS parameter properties — the repo runs native
  // --experimental-strip-types, which cannot erase parameter properties.
  readonly cfgPath: string;
  readonly missing: string[];
  readonly providerId: string;

  constructor(cfgPath: string, missing: string[], providerId: string) {
    super(
      `MCP surface assertion failed for ${providerId} config ${cfgPath}: missing required server(s) ${missing.join(', ')}`,
    );
    this.name = 'McpSurfaceAssertionError';
    this.cfgPath = cfgPath;
    this.missing = missing;
    this.providerId = providerId;
  }
}

/**
 * Re-read a written MCP config and throw unless every required server name is
 * present in the provider's server map. Fail-closed: an unreadable or
 * unparseable file throws too — a partial write must never pass as a surface.
 */
/** Platform-written server names whose presence needs no re-read proof — the generators emit them unconditionally. Asserting them for undeclared instances would change legacy behavior (and break fs-mocked callers) for no signal. */
const PLATFORM_MCP_SERVER_NAMES: ReadonlySet<string> = new Set(['whatsoup', 'send-media']);

export function assertWrittenMcpSurface(
  providerId: string,
  cfgPath: string,
  requiredNames: readonly string[],
): void {
  // Only a config that declares servers beyond the platform's own gets the
  // post-write re-read; undeclared instances keep byte- AND behavior-identical
  // legacy semantics (see the QR-254 regression pin).
  if (!requiredNames.some((n) => !PLATFORM_MCP_SERVER_NAMES.has(n))) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch (err) {
    throw new Error(
      `MCP surface assertion could not re-read ${cfgPath} for ${providerId}: ${(err as Error).message}`,
    );
  }
  const mapKey = providerId === 'opencode-cli' ? 'mcp' : 'mcpServers';
  const serverMap =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)[mapKey]
      : undefined;
  const present =
    serverMap && typeof serverMap === 'object' && !Array.isArray(serverMap)
      ? new Set(Object.keys(serverMap as Record<string, unknown>))
      : new Set<string>();
  const missing = requiredNames.filter((n) => !present.has(n));
  if (missing.length > 0) {
    throw new McpSurfaceAssertionError(cfgPath, missing, providerId);
  }
}

const DEFAULT_OPENCODE_PROVIDER_ID = 'whatsoup-cloud';

export function writeProviderMcpConfigTarget(providerId: string, agentCwd: string): string | null {
  switch (providerId) {
    case 'claude-cli':
    case 'gemini-cli':
    case 'codex-cli':
      return join(agentCwd, '.mcp.json');
    case 'opencode-cli':
      return join(agentCwd, 'opencode.json');
    default:
      return null;
  }
}

/**
 * Generate provider-specific MCP config file content.
 * Returns null for API providers that do not use config files.
 */
export function generateMcpConfigFile(
  providerId: string,
  socketPath: string,
  proxyScriptPath: string,
  additionalServers: AdditionalMcpServerConfig[] = [],
): Record<string, unknown> | null {
  const servers: AdditionalMcpServerConfig[] = [
    {
      name: 'whatsoup',
      proxyScriptPath,
      env: { WHATSOUP_SOCKET: socketPath },
    },
    ...additionalServers,
  ];

  switch (providerId) {
    case 'claude-cli':
    case 'gemini-cli':
    case 'codex-cli':
      return {
        mcpServers: Object.fromEntries(
          servers.map((server) => [
            server.name,
            {
              ...resolveServerLaunch(server),
              env: server.env,
            },
          ]),
        ),
      };

    case 'opencode-cli':
      return {
        mcp: Object.fromEntries(
          servers.map((server) => {
            const { command, args } = resolveServerLaunch(server);
            return [
              server.name,
              {
                type: 'local',
                command: [command, ...args],
                environment: server.env,
                enabled: true,
              },
            ];
          }),
        ),
      };

    default:
      return null;
  }
}

/**
 * F-STICKY-ACTOR (QR-247): generate + write a provider MCP config to an arbitrary
 * absolute path (0600), reusing generateMcpConfigFile. Used to give a per-chat
 * claude-cli session its own --mcp-config pointing at its per-chat socket, without
 * touching the shared cwd .mcp.json. Returns the path written, or null for API
 * providers that use no config file.
 */
export function writeMcpConfigToPath(
  providerId: string,
  absPath: string,
  socketPath: string,
  proxyScriptPath: string,
  // No defaults: every write-site must decide its surface explicitly — a new
  // caller that forgets threading fails to compile instead of silently
  // shipping a whatsoup-only config (the ana-bot/eh-bot failure class).
  additionalServers: AdditionalMcpServerConfig[],
  requiredServerNames: readonly string[],
): string | null {
  const generated = generateMcpConfigFile(providerId, socketPath, proxyScriptPath, additionalServers);
  if (generated === null) return null;
  writePrivateFileSync(absPath, JSON.stringify(generated, null, 2));
  assertWrittenMcpSurface(providerId, absPath, requiredServerNames);
  return absPath;
}

/**
 * Merge the generated opencode `mcp` block into a possibly-existing
 * opencode.json object. Pure — does no IO. Preserves every unrelated top-level
 * key (model, provider catalog, watcher, …) and every sibling MCP server,
 * overwriting only generated MCP entries so stale socket paths are refreshed.
 */
export function mergeOpencodeConfig(
  existing: Record<string, unknown> | null,
  generated: Record<string, unknown>,
  providerConfig?: OpencodeProviderConfig,
): Record<string, unknown> {
  const base: Record<string, unknown> = existing ? { ...existing } : {};

  const generatedMcp = (generated.mcp ?? {}) as Record<string, unknown>;
  const existingMcp = (base.mcp && typeof base.mcp === 'object' && !Array.isArray(base.mcp))
    ? (base.mcp as Record<string, unknown>)
    : {};
  base.mcp = { ...existingMcp, ...generatedMcp };

  if (providerConfig?.baseUrl) {
    const providerId = providerConfig.providerId ?? DEFAULT_OPENCODE_PROVIDER_ID;
    const model = providerConfig.model;
    // Auth: reference the endpoint key via opencode's env interpolation so the
    // key VALUE never lands on disk — buildChildEnv injects the matching env
    // var into the session child. Service: explicit apiKeyService override,
    // else derived from the model prefix. A service SERVICE_ENV_MAP does not
    // know has no env var to interpolate, so apiKey is omitted entirely
    // (the validator rejects unknown apiKeyService values at config load).
    const keyService =
      providerConfig.apiKeyService ?? resolveProviderKeyService('opencode-cli', model);
    const keyEnvVar = keyService ? SERVICE_ENV_MAP[keyService] : undefined;
    const existingProvider = (base.provider && typeof base.provider === 'object' && !Array.isArray(base.provider))
      ? (base.provider as Record<string, unknown>)
      : {};
    base.provider = {
      ...existingProvider,
      [providerId]: {
        options: {
          baseURL: providerConfig.baseUrl,
          ...(keyEnvVar ? { apiKey: `{env:${keyEnvVar}}` } : {}),
        },
        models: model ? { [model]: {} } : {},
      },
    };
    if (model) {
      base.model = `${providerId}/${model}`;
    }
  } else {
    const providerId = providerConfig?.providerId ?? DEFAULT_OPENCODE_PROVIDER_ID;
    if (base.provider && typeof base.provider === 'object' && !Array.isArray(base.provider)) {
      const existingProvider = { ...(base.provider as Record<string, unknown>) };
      delete existingProvider[providerId];
      if (Object.keys(existingProvider).length > 0) {
        base.provider = existingProvider;
      } else {
        delete base.provider;
      }
    }
    if (typeof base.model === 'string' && base.model.startsWith(`${providerId}/`)) {
      delete base.model;
    }
  }

  return base;
}

/**
 * Write the whatsoup MCP config to the file the given provider's CLI reads,
 * returning the absolute path written (or `null` for native-bridge/API
 * providers that need no config file).
 *
 * - claude/gemini/codex -> `<agentCwd>/.mcp.json` (claude `mcpServers` shape,
 *   deterministic overwrite, exactly as before).
 * - opencode-cli -> `<agentCwd>/opencode.json` (opencode `mcp` shape), MERGED
 *   with any pre-existing user opencode.json so a hand-authored config is never
 *   clobbered.
 *
 * Both paths go through {@link writePrivateFileSync} (0600, symlink-safe).
 */
export function writeProviderMcpConfig(
  providerId: string,
  agentCwd: string,
  socketPath: string,
  proxyScriptPath: string,
  providerConfig?: OpencodeProviderConfig,
  // Defaults preserve exact legacy behavior for instances that declare
  // nothing; runtime/workspace callers thread resolved instance values.
  additionalServers: AdditionalMcpServerConfig[] = [],
  requiredServerNames: readonly string[] = [],
): string | null {
  // A "skipped" write is a silent surface loss for an instance that DECLARED
  // required servers beyond the platform's own — fail closed for those; keep
  // the historical warn-and-skip for undeclared instances (whose required set
  // is only ever the platform-injected whatsoup/send-media).
  const declaredRequired = requiredServerNames.filter((n) => !PLATFORM_MCP_SERVER_NAMES.has(n));
  const failClosedSkip = (reason: string): never => {
    throw new Error(
      `opencode MCP config write skipped (${reason}) but required MCP server(s) ${declaredRequired.join(', ')} are declared for this instance — refusing to start with a partial surface`,
    );
  };

  const generated = generateMcpConfigFile(providerId, socketPath, proxyScriptPath, additionalServers);
  if (generated === null) return null;

  const target = writeProviderMcpConfigTarget(providerId, agentCwd);
  if (target === null) return null;

  if (providerId === 'opencode-cli') {
    try {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) {
        if (declaredRequired.length > 0) failClosedSkip('opencode.json is a symlink');
        log.warn({ target }, 'skipping opencode MCP config write because opencode.json is a symlink');
        return null;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ELOOP') {
        if (declaredRequired.length > 0) failClosedSkip('file stat failed with ELOOP');
        log.warn({ err, target }, 'skipping opencode MCP config write after file stat failed');
        return null;
      }
      if (code !== 'ENOENT') throw err;
    }

    let existing: Record<string, unknown> | null = null;
    if (existsSync(target)) {
      try {
        const parsed = JSON.parse(readFileSync(target, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>;
        }
      } catch (err) {
        // Corrupt/unreadable user config — fall back to a fresh merge base
        // rather than refusing to wire MCP. The whatsoup block is what matters.
        log.warn({ err, target }, 'failed to parse existing opencode.json before MCP config write; overwriting managed entries');
        existing = null;
      }
    }
    const merged = mergeOpencodeConfig(existing, generated, providerConfig);
    try {
      writePrivateFileSync(target, JSON.stringify(merged, null, 2));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
        if (declaredRequired.length > 0) failClosedSkip('write failed with ELOOP');
        log.warn({ err, target }, 'skipping opencode MCP config write because opencode.json is a symlink');
        return null;
      }
      throw err;
    }
    assertWrittenMcpSurface(providerId, target, requiredServerNames);
    return target;
  }

  // claude / gemini / codex: overwrite .mcp.json with the mcpServers shape
  // via the single write+assert choke point (QR-254 dedup).
  return writeMcpConfigToPath(
    providerId,
    target,
    socketPath,
    proxyScriptPath,
    additionalServers,
    requiredServerNames,
  );
}
