import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { migrateLegacyMemoryConfig } from '../src/config-memory-migration.ts';

interface ParsedArgs {
  root: string;
  configs: string[];
  instances: string[];
  write: boolean;
  backup: boolean;
  removeLegacy: boolean;
  json: boolean;
  help: boolean;
}

export interface ConfigMigrationFileResult {
  configPath: string;
  changed: boolean;
  wrote: boolean;
  backupPath: string | null;
  moved: Array<{ from: string; to: string }>;
  removed: string[];
}

function defaultRoot(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  return xdgConfig
    ? path.join(xdgConfig, 'whatsoup', 'instances')
    : path.join(os.homedir(), '.config', 'whatsoup', 'instances');
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    root: defaultRoot(),
    configs: [],
    instances: [],
    write: false,
    backup: true,
    removeLegacy: true,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--root') {
      args.root = argv[++i] ?? '';
    } else if (arg === '--config') {
      args.configs.push(argv[++i] ?? '');
    } else if (arg === '--instance') {
      args.instances.push(argv[++i] ?? '');
    } else if (arg === '--write') {
      args.write = true;
    } else if (arg === '--no-backup') {
      args.backup = false;
    } else if (arg === '--keep-legacy') {
      args.removeLegacy = false;
    } else if (arg === '--json') {
      args.json = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.root.trim()) {
    throw new Error('--root must not be empty');
  }
  if (args.configs.some((configPath) => !configPath.trim())) {
    throw new Error('--config requires a path');
  }
  if (args.instances.some((name) => !name.trim())) {
    throw new Error('--instance requires a name');
  }

  return args;
}

export function findConfigFiles(args: Pick<ParsedArgs, 'root' | 'configs' | 'instances'>): string[] {
  if (args.configs.length > 0) {
    return args.configs.map((configPath) => path.resolve(configPath));
  }

  if (args.instances.length > 0) {
    return args.instances.map((name) => path.join(args.root, name, 'config.json'));
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(args.root);
  } catch (err) {
    throw new Error(`Failed to read instance root ${args.root}: ${(err as Error).message}`);
  }

  return entries
    .map((name) => path.join(args.root, name, 'config.json'))
    .filter((configPath) => fs.existsSync(configPath))
    .sort();
}

function writeAtomic(configPath: string, contents: string): void {
  const tmpPath = `${configPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, contents, { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmpPath, configPath);
}

export function migrateMemoryConfigFile(
  configPath: string,
  options: { write?: boolean; backup?: boolean; removeLegacy?: boolean } = {},
): ConfigMigrationFileResult {
  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const migration = migrateLegacyMemoryConfig(parsed, {
    removeLegacy: options.removeLegacy ?? true,
  });

  let backupPath: string | null = null;
  let wrote = false;
  if (options.write && migration.changed) {
    if (options.backup !== false) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      backupPath = `${configPath}.bak-${stamp}`;
      fs.copyFileSync(configPath, backupPath);
    }
    writeAtomic(configPath, JSON.stringify(migration.config, null, 2) + '\n');
    wrote = true;
  }

  return {
    configPath,
    changed: migration.changed,
    wrote,
    backupPath,
    moved: migration.moved,
    removed: migration.removed,
  };
}

export function runMigration(argv: string[] = process.argv.slice(2)): ConfigMigrationFileResult[] {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return [];
  }

  const configFiles = findConfigFiles(args);
  const results = configFiles.map((configPath) =>
    migrateMemoryConfigFile(configPath, {
      write: args.write,
      backup: args.backup,
      removeLegacy: args.removeLegacy,
    }),
  );

  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const result of results) {
      const action = result.wrote ? 'wrote' : result.changed ? 'would update' : 'unchanged';
      console.log(`${action}: ${result.configPath}`);
      if (result.backupPath) console.log(`  backup: ${result.backupPath}`);
      for (const move of result.moved) console.log(`  ${move.from} -> ${move.to}`);
      if (result.removed.length > 0) console.log(`  removed legacy: ${result.removed.join(', ')}`);
    }
    if (!args.write) {
      console.log('dry run only; pass --write to modify config.json');
    }
  }

  return results;
}

function printHelp(): void {
  console.log(`Usage: npm run migrate-memory-config -- [options]

Options:
  --root <dir>        Instance root. Defaults to ~/.config/whatsoup/instances.
  --instance <name>   Migrate one instance under --root. Repeatable.
  --config <path>     Migrate one config.json path. Repeatable.
  --write             Write migrated config.json files. Default is dry-run.
  --no-backup         Skip config.json.bak-* backup in --write mode.
  --keep-legacy       Keep legacy flat fields after projecting memory.*.
  --json              Print JSON results.
  --help              Show this help.

The migrator only reads and writes config.json files. It does not touch
tokens.env, auth/, bot.db, keychains, or provider credentials.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    runMigration();
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
