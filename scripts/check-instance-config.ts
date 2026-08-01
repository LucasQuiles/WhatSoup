/**
 * Instance-config integrity guard.
 *
 * Validates committed example instance configs plus checked-in health profiles
 * (and, via --root, a host's live
 * `~/.config/whatsoup/instances/<name>/config.json` tree offline) against the
 * canonical contract, catching two failure classes the permissive runtime
 * schema lets through silently:
 *
 *   Class A — malformed memory config silently disables the memory layer.
 *     An agent/chat instance with explicit Pinecone config but an empty or
 *     guard-less `memory.pinecone` loads fine, then the runtime project guard
 *     refuses every query (`project_mismatch`) with no startup error — the
 *     ml-bot / ew-bot `"memory": {}` dead-memory incident. We require a
 *     non-empty `memory.pinecone.expectedHostSuffix` of the documented
 *     `<slug>.svc.<env>.pinecone.io` shape and forbid UUID-shaped `projectId`
 *     values (the `host.includes("-<projectId>.")` trap that fails closed
 *     against the standard host format).
 *
 *   Class B — health-port collisions / console squats / off-band ports.
 *     The runtime accepts any 1024-65535 port. Two instances on one host can
 *     collide, and a bot can squat DEFAULT_FLEET_PORT. We enforce a per-host
 *     unique, in-band port map that never equals the fleet console port.
 *
 * Wraps src/core/agent-config-validator.ts (shared schema SSOT) and
 * src/fleet/constants.ts (port SSOT) so the guard stays in lockstep with the
 * runtime rather than re-deriving rules.
 *
 * CONSTRAINT: Node built-ins only (matches scripts/check-node-pin-consistency.ts).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  validateInstanceConfig,
  type ValidationError,
} from '../src/core/agent-config-validator.ts';
import {
  DEFAULT_FLEET_PORT,
  DEFAULT_INSTANCE_HEALTH_PORT,
  INSTANCE_HEALTH_PORT_MIN,
  INSTANCE_HEALTH_PORT_MAX,
} from '../src/fleet/constants.ts';
import { isNonEmptyString, isRecord } from '../src/lib/type-guards.ts';

// ---------------------------------------------------------------------------
// SSOT for the host-suffix shape and projectId-UUID shape.
// expectedHostSuffix examples (docs/configuration.md):
//   "-nf9hzvy.svc.aped-4627-b74a.pinecone.io"
//   "-team-project-id.svc.aped-4627-b74a.pinecone.io"
// Always begins with "-", contains ".svc.", ends with ".pinecone.io". The
// environment segment may itself contain dots (AWS/GCP serverless zone names
// such as "us-east-1.aws"), so dots are allowed there.
// ---------------------------------------------------------------------------
const HOST_SUFFIX_RE = /^-[a-z0-9-]+\.svc\.[a-z0-9.-]+\.pinecone\.io$/i;
const PROJECT_ID_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;

export interface ConfigFinding {
  /** Logical instance name (directory name or config "name"). */
  instance: string;
  /** Source file path. */
  filePath: string;
  /** Failure class for triage. */
  category: 'A-memory' | 'B-port' | 'schema';
  /** Dotted field path. */
  field: string;
  /** Human-readable message. */
  message: string;
}

export interface CheckResult {
  /** Files scanned. */
  scanned: { instance: string; filePath: string; healthPort?: number }[];
  findings: ConfigFinding[];
}

export interface CheckOptions {
  /** Canonical fleet/console port that bots must never squat. */
  fleetPort?: number;
  /** Inclusive per-host band for instance health ports. */
  portMin?: number;
  portMax?: number;
  /**
   * Port an instance resolves to at runtime when healthPort is absent. Used for
   * collision detection so two no-port instances (both binding this default)
   * are flagged rather than silently passing.
   */
  defaultPort?: number;
}

type PortConfig = { instance: string; filePath: string; healthPort?: number };

function nonBlankString(value: unknown): value is string {
  return isNonEmptyString(value);
}

/**
 * True when this config has an explicit Pinecone setup that the runtime project
 * guard will act on. Mirrors hasExplicitPineconeConfig in the validator but
 * scoped to the canonical `memory.pinecone` shape the examples/live configs use
 * (the flat legacy fields are migration-only and not emitted by the fleet API).
 */
function hasExplicitMemoryPinecone(raw: Record<string, unknown>): boolean {
  const memory = isRecord(raw['memory']) ? raw['memory'] : undefined;
  if (!memory) return false;
  const pinecone = isRecord(memory['pinecone']) ? memory['pinecone'] : undefined;
  // An empty `memory: {}` (the ml/ew dead-memory shape) on a bot that needs
  // memory is itself the defect — but we can only assert "needs memory" for
  // agent/chat types. Caller gates on type; here we report whether a pinecone
  // block is present at all.
  return pinecone !== undefined && Object.keys(pinecone).length > 0;
}

/**
 * Class A: memory-config integrity for pinecone-capable instance types.
 *
 * agent/chat instances are the memory consumers. For those:
 *  - an empty `memory: {}` (or absent pinecone block) while the type is a
 *    memory consumer is the silent-dead shape → ERROR;
 *  - a present pinecone block MUST carry a well-shaped expectedHostSuffix;
 *  - it MUST NOT carry a UUID-shaped projectId (the host-match trap).
 */
export function checkMemoryIntegrity(
  raw: Record<string, unknown>,
  instance: string,
  filePath: string,
): ConfigFinding[] {
  const findings: ConfigFinding[] = [];
  const type = String(raw['type'] ?? '');
  const isMemoryConsumer = type === 'agent' || type === 'chat';
  if (!isMemoryConsumer) return findings;

  const memory = isRecord(raw['memory']) ? raw['memory'] : undefined;
  const pinecone =
    memory && isRecord(memory['pinecone']) ? memory['pinecone'] : undefined;

  // Empty memory: {} or memory with an empty/absent pinecone block on a
  // memory-consuming bot is the ml/ew silent-dead class. We only flag when a
  // `memory` key is PRESENT (an instance that intentionally omits memory
  // entirely is a different, explicit choice and not this failure mode).
  if (memory !== undefined && !hasExplicitMemoryPinecone(raw)) {
    findings.push({
      instance,
      filePath,
      category: 'A-memory',
      field: 'memory.pinecone',
      message:
        'memory is present but memory.pinecone is empty/absent — on an ' +
        `${type} instance the runtime project guard will fire project_mismatch ` +
        'and the memory layer is silently dead (the ml-bot/ew-bot incident). ' +
        'Provide memory.pinecone.expectedHostSuffix, or remove the memory key entirely.',
    });
    return findings;
  }

  if (!pinecone) return findings;

  // UUID-shaped projectId trap: host.includes(`-${projectId}.`) fails closed
  // against the standard `<slug>.svc.<env>.pinecone.io` host, killing memory.
  // Short-slug projectId values are allowed because they match the host slug.
  const projectId = pinecone['projectId'];
  if (typeof projectId === 'string' && PROJECT_ID_UUID_RE.test(projectId)) {
    findings.push({
      instance,
      filePath,
      category: 'A-memory',
      field: 'memory.pinecone.projectId',
      message:
        'memory.pinecone.projectId must not be UUID-shaped — the runtime guard checks ' +
        'host.includes("-<projectId>.") which fails closed against the standard ' +
        'slug-based host shape and silently disables memory. Use the short slug or ' +
        'expectedHostSuffix instead.',
    });
  }

  const suffix = pinecone['expectedHostSuffix'];
  if (!nonBlankString(suffix)) {
    findings.push({
      instance,
      filePath,
      category: 'A-memory',
      field: 'memory.pinecone.expectedHostSuffix',
      message:
        'memory.pinecone is configured but expectedHostSuffix is missing/empty — ' +
        'without it the project guard cannot fail-open safely and memory routing ' +
        'is unverified. Set a "-<slug>.svc.<env>.pinecone.io" suffix.',
    });
  } else if (!HOST_SUFFIX_RE.test(suffix)) {
    findings.push({
      instance,
      filePath,
      category: 'A-memory',
      field: 'memory.pinecone.expectedHostSuffix',
      message:
        `memory.pinecone.expectedHostSuffix ${JSON.stringify(suffix)} does not match ` +
        'the host-suffix shape "-<slug>.svc.<env>.pinecone.io" — a malformed suffix ' +
        'either never matches (memory dead) or uses a UUID where the host has a slug.',
    });
  }

  return findings;
}

/**
 * Class B: port-map integrity across all scanned configs on one host.
 *
 * Flags: (1) duplicate effective port across instances — an absent healthPort
 * resolves to options.defaultPort, so two no-port instances are caught rather
 * than silently both binding the default at runtime; (2) an explicit healthPort
 * equal to the canonical fleet/console port (the squat); (3) an explicit
 * healthPort outside the agreed [portMin, portMax] band. Squat/band checks
 * apply to EXPLICIT ports only — the runtime default is in-band and not the
 * fleet port by construction, so omitting healthPort is not itself a finding.
 */
export function checkPortMap(
  configs: PortConfig[],
  options: Required<CheckOptions>,
): ConfigFinding[] {
  const findings: ConfigFinding[] = [];
  const byPort = new Map<number, { instance: string; filePath: string; explicit: boolean }[]>();

  for (const cfg of configs) {
    const explicit = cfg.healthPort !== undefined;
    const port = cfg.healthPort ?? options.defaultPort;

    if (explicit) {
      if (port === options.fleetPort) {
        findings.push({
          instance: cfg.instance,
          filePath: cfg.filePath,
          category: 'B-port',
          field: 'healthPort',
          message:
            `healthPort ${port} equals the canonical fleet/console port ` +
            `(${options.fleetPort}) — this bot squats the console port, so fleet ` +
            'tooling that assumes the console there hits the bot instead (the ew-bot squat).',
        });
      } else if (port < options.portMin || port > options.portMax) {
        findings.push({
          instance: cfg.instance,
          filePath: cfg.filePath,
          category: 'B-port',
          field: 'healthPort',
          message:
            `healthPort ${port} is outside the agreed per-host band ` +
            `[${options.portMin}, ${options.portMax}] — off-band ports drift away from ` +
            'central validation and collide with unrelated services.',
        });
      }
    }

    const list = byPort.get(port) ?? [];
    list.push({ instance: cfg.instance, filePath: cfg.filePath, explicit });
    byPort.set(port, list);
  }

  for (const [port, owners] of byPort) {
    if (owners.length < 2) continue;
    const names = owners.map((o) => o.instance).sort().join(', ');
    // If every colliding owner inherited the default (no explicit port), make
    // the runtime-default cause explicit in the message.
    const allImplicit = owners.every((o) => !o.explicit);
    const suffix = allImplicit
      ? ` — all omit healthPort and resolve to the runtime default (${options.defaultPort}); set distinct explicit ports.`
      : '. Each instance needs a unique port.';
    for (const owner of owners) {
      findings.push({
        instance: owner.instance,
        filePath: owner.filePath,
        category: 'B-port',
        field: 'healthPort',
        message:
          `healthPort ${port} collides on this host across instances: ${names}${suffix}`,
      });
    }
  }

  return findings;
}

/**
 * Schema completeness via the shared validator (load mode = strictest
 * persisted-file checks: name/type/accessMode/adminPhones required, port
 * range, twilio coherence, etc.).
 */
export function checkSchema(
  raw: Record<string, unknown>,
  instance: string,
  filePath: string,
): ConfigFinding[] {
  const err: ValidationError | null = validateInstanceConfig(raw, {
    name: instance,
    mode: 'load',
  });
  if (!err) return [];
  return [
    {
      instance,
      filePath,
      category: 'schema',
      field: err.field,
      message: err.message,
    },
  ];
}

function parseConfig(filePath: string): Record<string, unknown> {
  const text = readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`${filePath} must contain a JSON object`);
  }
  return parsed;
}

function defaultCheckOptions(options: CheckOptions = {}): Required<CheckOptions> {
  return {
    fleetPort: options.fleetPort ?? DEFAULT_FLEET_PORT,
    portMin: options.portMin ?? INSTANCE_HEALTH_PORT_MIN,
    portMax: options.portMax ?? INSTANCE_HEALTH_PORT_MAX,
    defaultPort: options.defaultPort ?? DEFAULT_INSTANCE_HEALTH_PORT,
  };
}

/**
 * Discover instance config files under a root. Accepts either:
 *  - a single config.json file path, or
 *  - a directory containing <name>/config.json subdirs (the live host layout
 *    and the committed example layout).
 */
export function discoverConfigFiles(root: string): { instance: string; filePath: string }[] {
  const st = statSync(root);
  if (st.isFile()) {
    const instance = path.basename(path.dirname(root)) || path.basename(root);
    return [{ instance, filePath: root }];
  }
  const out: { instance: string; filePath: string }[] = [];
  for (const entry of readdirSync(root)) {
    const dir = path.join(root, entry);
    let entryStat;
    try {
      entryStat = statSync(dir);
    } catch {
      continue;
    }
    if (!entryStat.isDirectory()) continue;
    const candidate = path.join(dir, 'config.json');
    try {
      if (statSync(candidate).isFile()) {
        out.push({ instance: entry, filePath: candidate });
      }
    } catch {
      // no config.json in this dir — skip
    }
  }
  out.sort((a, b) => a.instance.localeCompare(b.instance));
  return out;
}

export function checkInstanceConfigs(
  root: string,
  options: CheckOptions = {},
): CheckResult {
  const opts = defaultCheckOptions(options);

  const files = discoverConfigFiles(root);
  const findings: ConfigFinding[] = [];
  const scanned: CheckResult['scanned'] = [];
  const portConfigs: PortConfig[] = [];

  for (const { instance, filePath } of files) {
    let raw: Record<string, unknown>;
    try {
      raw = parseConfig(filePath);
    } catch (e) {
      findings.push({
        instance,
        filePath,
        category: 'schema',
        field: '(parse)',
        message: (e as Error).message,
      });
      continue;
    }
    const name = nonBlankString(raw['name']) ? raw['name'] : instance;
    const healthPort =
      typeof raw['healthPort'] === 'number' ? (raw['healthPort'] as number) : undefined;

    scanned.push({ instance: name, filePath, healthPort });
    portConfigs.push({ instance: name, filePath, healthPort });

    findings.push(...checkSchema(raw, name, filePath));
    findings.push(...checkMemoryIntegrity(raw, name, filePath));
  }

  // Port map is cross-config (per host/root).
  findings.push(...checkPortMap(portConfigs, opts));

  return { scanned, findings };
}

/**
 * Discover checked-in health profile files. Accepts either:
 *  - a single <host>.json profile path, or
 *  - a directory containing one or more *.json profiles.
 *
 * Health profiles are not instance config files, so they intentionally bypass
 * Class A and shared instance-schema validation. They do carry per-host
 * instance health ports, so they feed the same Class B checkPortMap SSOT.
 */
export function discoverHealthProfileFiles(root: string): string[] {
  const st = statSync(root);
  if (st.isFile()) return [root];

  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    if (!entry.endsWith('.json')) continue;
    const candidate = path.join(root, entry);
    try {
      if (statSync(candidate).isFile()) out.push(candidate);
    } catch {
      // disappeared during scan — skip and let the next guard run observe it
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

export function checkHealthProfiles(
  root: string,
  options: CheckOptions = {},
): CheckResult {
  const opts = defaultCheckOptions(options);
  const findings: ConfigFinding[] = [];
  const scanned: CheckResult['scanned'] = [];

  for (const filePath of discoverHealthProfileFiles(root)) {
    let raw: Record<string, unknown>;
    try {
      raw = parseConfig(filePath);
    } catch (e) {
      findings.push({
        instance: path.basename(filePath, '.json'),
        filePath,
        category: 'schema',
        field: '(parse)',
        message: (e as Error).message,
      });
      continue;
    }

    const instancesRaw = raw['instances'];
    if (instancesRaw === undefined) continue;
    if (!Array.isArray(instancesRaw)) {
      findings.push({
        instance: path.basename(filePath, '.json'),
        filePath,
        category: 'schema',
        field: 'instances',
        message: 'health profile instances must be an array when present',
      });
      continue;
    }

    const portConfigs: PortConfig[] = [];
    instancesRaw.forEach((item, index) => {
      if (!isRecord(item)) {
        findings.push({
          instance: `${path.basename(filePath, '.json')}:instances[${index}]`,
          filePath,
          category: 'schema',
          field: `instances[${index}]`,
          message: 'health profile instance must be a JSON object',
        });
        return;
      }

      const instance = nonBlankString(item['name'])
        ? item['name']
        : `${path.basename(filePath, '.json')}:instances[${index}]`;
      const rawHealthPort = item['healthPort'];
      if (rawHealthPort !== undefined && rawHealthPort !== null && typeof rawHealthPort !== 'number') {
        findings.push({
          instance,
          filePath,
          category: 'schema',
          field: `instances[${index}].healthPort`,
          message: 'health profile healthPort must be a number when present',
        });
        scanned.push({ instance, filePath });
        portConfigs.push({ instance, filePath });
        return;
      }

      const healthPort = typeof rawHealthPort === 'number' ? rawHealthPort : undefined;
      scanned.push({ instance, filePath, healthPort });
      portConfigs.push({ instance, filePath, healthPort });
    });

    findings.push(...checkPortMap(portConfigs, opts));
  }

  return { scanned, findings };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function defaultExamplesRoot(cwd: string): string {
  return path.join(cwd, 'deploy', 'examples', 'instances');
}

function defaultHealthProfilesRoot(cwd: string): string {
  return path.join(cwd, 'deploy', 'health-profiles');
}

interface ParsedArgs {
  root: string;
  fleetPort?: number;
  portMin?: number;
  portMax?: number;
  help: boolean;
  explicitRoot: boolean;
}

export function parseArgs(argv: string[], cwd: string): ParsedArgs {
  const out: ParsedArgs = { root: defaultExamplesRoot(cwd), help: false, explicitRoot: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      out.help = true;
    } else if (a === '--root' || a === '--path') {
      out.root = argv[++i] ?? out.root;
      out.explicitRoot = true;
    } else if (a === '--fleet-port') {
      out.fleetPort = Number(argv[++i]);
    } else if (a === '--port-min') {
      out.portMin = Number(argv[++i]);
    } else if (a === '--port-max') {
      out.portMax = Number(argv[++i]);
    } else if (a && !a.startsWith('-')) {
      out.root = a;
      out.explicitRoot = true;
    }
  }
  return out;
}

const HELP = `Usage: check-instance-config [--root <dir|config.json>] [--fleet-port N] [--port-min N] [--port-max N]

Validates instance config.json files for memory-config integrity (Class A) and
health-port map integrity (Class B). With no --root, validates both committed
example configs under deploy/examples/instances and checked-in health profiles
under deploy/health-profiles. Pass --root to validate a host's live
~/.config/whatsoup/instances tree offline; explicit roots retain the historical
config-tree behavior and do not also scan health profiles.

Exit code 1 on any finding.`;

export function run(
  argv: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
): CheckResult {
  const args = parseArgs(argv, cwd);
  if (args.help) {
    console.log(HELP);
    return { scanned: [], findings: [] };
  }

  const options = {
    fleetPort: args.fleetPort,
    portMin: args.portMin,
    portMax: args.portMax,
  };
  const instanceResult = checkInstanceConfigs(args.root, options);
  const result = args.explicitRoot
    ? instanceResult
    : (() => {
        const healthResult = checkHealthProfiles(defaultHealthProfilesRoot(cwd), options);
        return {
          scanned: [...instanceResult.scanned, ...healthResult.scanned],
          findings: [...instanceResult.findings, ...healthResult.findings],
        };
      })();
  const scope = args.explicitRoot
    ? args.root
    : `${args.root} + ${defaultHealthProfilesRoot(cwd)}`;

  if (result.findings.length === 0) {
    console.log(
      `instance-config integrity check passed (${result.scanned.length} config(s) under ${scope})`,
    );
    return result;
  }

  console.error(
    `instance-config integrity check FAILED — ${result.findings.length} finding(s):`,
  );
  for (const f of result.findings) {
    console.error(`  [${f.category}] ${f.instance} (${f.field}): ${f.message}`);
    console.error(`           ${f.filePath}`);
  }
  process.exitCode = 1;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
