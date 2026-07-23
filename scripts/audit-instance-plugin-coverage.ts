import { takeValue } from './lib/cli-args.ts';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isRecord } from '../src/lib/type-guards.ts';

interface ParsedArgs {
  root: string;
  settingsPath: string;
  instances: string[];
  json: boolean;
  failOnGap: boolean;
  help: boolean;
}

export interface PluginCoverageGap {
  plugin: string;
  inheritedValue: boolean;
}

export interface InstancePluginCoverage {
  name: string;
  type: string;
  configPath: string;
  checked: boolean;
  reason?: string;
  userScopeKeyCount: number;
  instanceKeyCount: number;
  missingEnabled: PluginCoverageGap[];
  missingDisabled: PluginCoverageGap[];
}

export interface PluginCoverageAudit {
  root: string;
  settingsPath: string;
  userScopePlugins: Record<string, boolean>;
  results: InstancePluginCoverage[];
  hasGaps: boolean;
}

function defaultRoot(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  return xdgConfig
    ? path.join(xdgConfig, 'whatsoup', 'instances')
    : path.join(os.homedir(), '.config', 'whatsoup', 'instances');
}

function defaultSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function readJsonRecord(filePath: string): Record<string, unknown> {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`${filePath} must contain a JSON object`);
  }
  return parsed;
}

function booleanPluginMap(value: unknown): Record<string, boolean> {
  if (!isRecord(value)) return {};
  const out: Record<string, boolean> = {};
  for (const [key, pluginValue] of Object.entries(value)) {
    if (typeof pluginValue === 'boolean') {
      out[key] = pluginValue;
    }
  }
  return out;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    root: defaultRoot(),
    settingsPath: defaultSettingsPath(),
    instances: [],
    json: false,
    failOnGap: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--root') {
      // takeValue, not `argv[++i] ?? ''`. The old form made `--root --fail-on-gap` set
      // root='--fail-on-gap' and leave failOnGap FALSE — an audit the operator explicitly
      // asked to fail on gaps, silently reporting success instead.
      const taken = takeValue(argv, i);
      args.root = taken.value;
      i = taken.index;
    } else if (arg === '--settings') {
      const taken = takeValue(argv, i);
      args.settingsPath = taken.value;
      i = taken.index;
    } else if (arg === '--instance') {
      const taken = takeValue(argv, i);
      args.instances.push(taken.value);
      i = taken.index;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--fail-on-gap') {
      args.failOnGap = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.root.trim()) throw new Error('--root must not be empty');
  if (!args.settingsPath.trim()) throw new Error('--settings must not be empty');
  if (args.instances.some((name) => !name.trim())) throw new Error('--instance requires a name');
  return args;
}

export function findConfigFiles(root: string, instances: string[] = []): string[] {
  if (instances.length > 0) {
    return instances.map((name) => path.join(root, name, 'config.json'));
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch (err) {
    throw new Error(`Failed to read instance root ${root}: ${(err as Error).message}`);
  }

  return entries
    .map((name) => path.join(root, name, 'config.json'))
    .filter((configPath) => fs.existsSync(configPath))
    .sort();
}

export function auditConfigFile(
  configPath: string,
  userScopePlugins: Record<string, boolean>,
): InstancePluginCoverage {
  const config = readJsonRecord(configPath);
  const name = typeof config.name === 'string' && config.name.trim() ? config.name : path.basename(path.dirname(configPath));
  const type = typeof config.type === 'string' ? config.type : 'unknown';
  const userKeys = Object.keys(userScopePlugins).sort();

  if (type !== 'agent') {
    return {
      name,
      type,
      configPath,
      checked: false,
      reason: 'not an agent instance',
      userScopeKeyCount: userKeys.length,
      instanceKeyCount: 0,
      missingEnabled: [],
      missingDisabled: [],
    };
  }

  const agentOptions = isRecord(config.agentOptions) ? config.agentOptions : {};
  const instancePlugins = booleanPluginMap(agentOptions.enabledPlugins);
  const missingEnabled: PluginCoverageGap[] = [];
  const missingDisabled: PluginCoverageGap[] = [];

  for (const plugin of userKeys) {
    if (Object.prototype.hasOwnProperty.call(instancePlugins, plugin)) continue;
    const inheritedValue = userScopePlugins[plugin]!;
    const gap = { plugin, inheritedValue };
    if (inheritedValue) {
      missingEnabled.push(gap);
    } else {
      missingDisabled.push(gap);
    }
  }

  return {
    name,
    type,
    configPath,
    checked: true,
    userScopeKeyCount: userKeys.length,
    instanceKeyCount: Object.keys(instancePlugins).length,
    missingEnabled,
    missingDisabled,
  };
}

export function auditInstancePluginCoverage(args: Pick<ParsedArgs, 'root' | 'settingsPath' | 'instances'>): PluginCoverageAudit {
  const settings = fs.existsSync(args.settingsPath) ? readJsonRecord(args.settingsPath) : {};
  const userScopePlugins = booleanPluginMap(settings.enabledPlugins);
  const results = findConfigFiles(args.root, args.instances)
    .map((configPath) => auditConfigFile(configPath, userScopePlugins));
  const hasGaps = results.some((result) => result.missingEnabled.length > 0 || result.missingDisabled.length > 0);

  return {
    root: args.root,
    settingsPath: args.settingsPath,
    userScopePlugins,
    results,
    hasGaps,
  };
}

function formatList(gaps: PluginCoverageGap[]): string {
  return gaps.map((gap) => gap.plugin).join(', ');
}

export function printAudit(audit: PluginCoverageAudit): void {
  const userScopeCount = Object.keys(audit.userScopePlugins).length;
  console.log(`settings: ${audit.settingsPath}`);
  console.log(`instances: ${audit.root}`);
  console.log(`user-scope plugin keys: ${userScopeCount}`);

  for (const result of audit.results) {
    if (!result.checked) {
      console.log(`skip ${result.name}: ${result.reason}`);
      continue;
    }

    const missing = result.missingEnabled.length + result.missingDisabled.length;
    if (missing === 0) {
      console.log(`ok ${result.name}: ${result.instanceKeyCount}/${result.userScopeKeyCount} user-scope keys covered`);
      continue;
    }

    console.log(`gap ${result.name}: ${missing}/${result.userScopeKeyCount} user-scope keys missing from agentOptions.enabledPlugins`);
    if (result.missingEnabled.length > 0) {
      console.log(`  missing inherited enabled: ${formatList(result.missingEnabled)}`);
    }
    if (result.missingDisabled.length > 0) {
      console.log(`  missing inherited disabled: ${formatList(result.missingDisabled)}`);
    }
  }

  if (audit.hasGaps) {
    console.log('coverage gaps found; add explicit true/false entries for every inherited key');
  } else {
    console.log('no coverage gaps found');
  }
}

function printHelp(): void {
  console.log(`Usage: npm run audit:instance-plugins -- [options]

Options:
  --root <dir>        Instance root. Defaults to ~/.config/whatsoup/instances.
  --settings <path>   User-scope settings path. Defaults to ~/.claude/settings.json.
  --instance <name>   Audit one instance under --root. Repeatable.
  --json              Print JSON results.
  --fail-on-gap       Exit 1 when any user-scope plugin key is missing from an agent map.
  --help              Show this help.

This is read-only. It compares host user-scope enabledPlugins against each
agent instance's agentOptions.enabledPlugins map and reports inherited keys
that are not explicitly covered.`);
}

export function run(argv: string[] = process.argv.slice(2)): PluginCoverageAudit | null {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return null;
  }

  const audit = auditInstancePluginCoverage(args);
  if (args.json) {
    console.log(JSON.stringify(audit, null, 2));
  } else {
    printAudit(audit);
  }
  if (args.failOnGap && audit.hasGaps) {
    process.exitCode = 1;
  }
  return audit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
