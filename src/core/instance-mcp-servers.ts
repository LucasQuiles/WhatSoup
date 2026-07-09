/**
 * Instance-declared additional MCP servers (`agentOptions.additionalMcpServers`).
 *
 * Under the fleet's strict per-chat posture (`--strict-mcp-config`, QR-247
 * F-STICKY-ACTOR) plugin-provided MCP servers never load in per-chat sessions,
 * so this config surface is the ONLY sanctioned way an instance requires an
 * MCP server beyond the platform's own `whatsoup` (and sandbox `send-media`).
 *
 * Import constraint: this module must stay safe for the config validator's
 * no-side-effect module graph — node builtins and the pure
 * provider-key-service map only. The keyring dependency is INJECTED via
 * `ResolveInstanceMcpServersOptions.lookup`; production callers pass
 * `lookupCredential` from keyring.ts.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { MCP_ENV_KEY_SERVICES } from '../lib/provider-key-service.ts';

export interface InstanceMcpServerSpec {
  name: string;
  /** Explicit-binary lane: `'node'` (substituted with the pinned runtime) or an absolute/`~/` path. Mutually exclusive with proxyScriptPath. */
  command?: string;
  args?: string[];
  /** tsx-runner lane (same launcher as the whatsoup proxy). Mutually exclusive with command. */
  proxyScriptPath?: string;
  env?: Record<string, string>;
  /** ENV_VAR -> keyring service name; service must be in MCP_ENV_KEY_SERVICES. */
  envFromKeyring?: Record<string, string>;
  /** Part of the asserted post-write surface. Default true. */
  required?: boolean;
}

/** Resolved, launch-ready shape consumed by provider MCP config generation. */
export interface ResolvedMcpServerConfig {
  name: string;
  command?: string;
  args?: readonly string[];
  proxyScriptPath?: string;
  env: Record<string, string>;
}

/** Platform-owned server names a config may never redeclare (QR-247: the per-chat actor binding rides the `whatsoup` entry). */
export const RESERVED_MCP_SERVER_NAMES: ReadonlySet<string> = new Set(['whatsoup', 'send-media']);
export const MCP_SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const MCP_ENV_VAR_RE = /^[A-Z][A-Z0-9_]*$/;
/** Loader/search-path hijack vectors — not overridable through declared-server env. */
export const FORBIDDEN_MCP_ENV_KEYS: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
]);
export const MAX_ADDITIONAL_MCP_SERVERS = 16;

export interface ResolveInstanceMcpServersOptions {
  instanceName: string;
  /** Keyring resolution seam; production: `lookupCredential` from keyring.ts. */
  lookup: (service: string) => string | null;
  homeDir?: string;
  /** Pinned node runtime substituted for command `'node'`; defaults to process.execPath so declared servers cannot drift from the repo's node pin. */
  nodeBinary?: string;
}

function fail(instance: string, server: string, detail: string): never {
  throw new Error(`additionalMcpServers['${server}'] (instance ${instance}): ${detail}`);
}

function expandTilde(p: string, home: string): string {
  return p.startsWith('~/') ? join(home, p.slice(2)) : p;
}

function assertUnderHome(instance: string, server: string, what: string, p: string, home: string): void {
  const resolved = resolve(p);
  const root = resolve(home);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    fail(instance, server, `${what} '${p}' escapes the home directory '${home}' — declared server paths are home-confined`);
  }
}

function assertScriptExists(instance: string, server: string, what: string, p: string): void {
  if (!existsSync(p)) {
    fail(instance, server, `${what} '${p}' is missing on disk — install/build it before declaring the server`);
  }
}

function resolveEnv(
  spec: InstanceMcpServerSpec,
  opts: ResolveInstanceMcpServersOptions,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    if (FORBIDDEN_MCP_ENV_KEYS.has(key)) {
      fail(opts.instanceName, spec.name, `env key '${key}' is forbidden (loader/search-path hijack vector)`);
    }
    env[key] = value;
  }
  for (const [key, service] of Object.entries(spec.envFromKeyring ?? {})) {
    if (FORBIDDEN_MCP_ENV_KEYS.has(key)) {
      fail(opts.instanceName, spec.name, `envFromKeyring key '${key}' is forbidden (loader/search-path hijack vector)`);
    }
    if (key in env) {
      fail(opts.instanceName, spec.name, `env key '${key}' is declared in both env and envFromKeyring — the two must not collide`);
    }
    // Defense-in-depth: the validator enforces this too, but resolution is the
    // last gate before a secret leaves the keyring.
    if (!MCP_ENV_KEY_SERVICES.has(service)) {
      fail(
        opts.instanceName,
        spec.name,
        `keyring service '${service}' is not an allowed MCP env key service (allowed: ${[...MCP_ENV_KEY_SERVICES].join(', ')})`,
      );
    }
    const secret = opts.lookup(service);
    if (secret === null || secret.trim() === '') {
      fail(
        opts.instanceName,
        spec.name,
        `required env ${key} could not be resolved from keyring service '${service}' — seed it ` +
          `(macOS: security add-generic-password -s '${service}' -a "$USER" -w …; ` +
          `Linux: secret-tool store --label='${service}' service '${service}') and restart`,
      );
    }
    env[key] = secret;
  }
  return env;
}

/**
 * Expand and validate declared server specs into launch-ready configs.
 * Throws (fail-closed, secrets never printed) on: reserved name, missing
 * launch lane, home-escape, missing script, disallowed keyring service, or an
 * unresolvable secret. Callers resolve ONCE at instance startup so a per-chat
 * spawn can never silently degrade to a partial surface.
 */
export function resolveInstanceMcpServers(
  specs: readonly InstanceMcpServerSpec[] | undefined,
  opts: ResolveInstanceMcpServersOptions,
): ResolvedMcpServerConfig[] {
  const home = opts.homeDir ?? homedir();
  const nodeBinary = opts.nodeBinary ?? process.execPath;
  const resolved: ResolvedMcpServerConfig[] = [];
  for (const spec of specs ?? []) {
    if (RESERVED_MCP_SERVER_NAMES.has(spec.name.toLowerCase())) {
      fail(opts.instanceName, spec.name, `'${spec.name}' is a reserved platform server name`);
    }
    const hasCommand = typeof spec.command === 'string' && spec.command.length > 0;
    const hasProxy = typeof spec.proxyScriptPath === 'string' && spec.proxyScriptPath.length > 0;
    if (hasCommand === hasProxy) {
      fail(opts.instanceName, spec.name, 'exactly one of command or proxyScriptPath must be set');
    }
    const env = resolveEnv(spec, opts);
    if (hasProxy) {
      const proxy = expandTilde(spec.proxyScriptPath!, home);
      assertUnderHome(opts.instanceName, spec.name, 'proxyScriptPath', proxy, home);
      assertScriptExists(opts.instanceName, spec.name, 'proxyScriptPath', proxy);
      resolved.push({ name: spec.name, proxyScriptPath: proxy, env });
      continue;
    }
    const args = (spec.args ?? []).map((a) => expandTilde(a, home));
    let command: string;
    if (spec.command === 'node') {
      command = nodeBinary;
      const script = args[0];
      if (script === undefined) {
        fail(opts.instanceName, spec.name, "command 'node' requires args[0] to be the script path");
      }
      assertUnderHome(opts.instanceName, spec.name, 'args[0]', script, home);
      assertScriptExists(opts.instanceName, spec.name, 'args[0]', script);
    } else {
      command = expandTilde(spec.command!, home);
      if (!isAbsolute(command)) {
        fail(opts.instanceName, spec.name, `command '${spec.command}' must be 'node', absolute, or ~/-relative`);
      }
      assertUnderHome(opts.instanceName, spec.name, 'command', command, home);
      assertScriptExists(opts.instanceName, spec.name, 'command', command);
    }
    resolved.push({ name: spec.name, command, args, env });
  }
  return resolved;
}

/** The post-write asserted surface: `whatsoup` always, plus every declared server not marked `required: false`. */
export function requiredMcpServerNames(specs: readonly InstanceMcpServerSpec[] | undefined): string[] {
  return ['whatsoup', ...(specs ?? []).filter((s) => s.required !== false).map((s) => s.name)];
}
