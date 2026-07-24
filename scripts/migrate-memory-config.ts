import { takeValue } from './lib/cli-args.ts';
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
  rollback: boolean;
}

export interface RollbackResult {
  configPath: string;
  backupPath: string;
  wouldRestore: boolean;
  restored: boolean;
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
    rollback: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--root') {
      // takeValue, not `argv[++i] ?? ''`: the old form consumed the NEXT FLAG as the value
      // when the value was omitted, so `--root --write` set root='--write' AND silently
      // dropped --write. In a script that mutates config files, that is a garbage path
      // plus a switched-off flag, with no error.
      const taken = takeValue(argv, i);
      args.root = taken.value;
      i = taken.index;
    } else if (arg === '--config') {
      const taken = takeValue(argv, i);
      args.configs.push(taken.value);
      i = taken.index;
    } else if (arg === '--instance') {
      const taken = takeValue(argv, i);
      args.instances.push(taken.value);
      i = taken.index;
    } else if (arg === '--write') {
      args.write = true;
    } else if (arg === '--no-backup') {
      args.backup = false;
    } else if (arg === '--keep-legacy') {
      args.removeLegacy = false;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--rollback') {
      args.rollback = true;
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
  try {
    fs.writeFileSync(tmpPath, contents, { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      throw new Error(`Cannot write config file (permission denied): ${configPath}`);
    }
    throw err;
  }

  try {
    fs.renameSync(tmpPath, configPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup only.
    }
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      throw new Error(`Cannot replace config file (permission denied): ${configPath}`);
    }
    throw err;
  }
}

export function migrateMemoryConfigFile(
  configPath: string,
  options: { write?: boolean; backup?: boolean; removeLegacy?: boolean } = {},
): ConfigMigrationFileResult {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`Config file not found: ${configPath}`);
    }
    if (code === 'EACCES') {
      throw new Error(`Cannot read config file (permission denied): ${configPath}`);
    }
    throw err;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Malformed JSON in config file: ${configPath}: ${(err as Error).message}`);
  }
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

function findMostRecentBackup(configPath: string): string | null {
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }

  const prefix = `${base}.bak-`;
  const backups = entries.filter((entry) => entry.startsWith(prefix)).sort();
  if (backups.length === 0) return null;
  return path.join(dir, backups[backups.length - 1]);
}

export function rollbackConfigFile(
  configPath: string,
  options: { write?: boolean } = {},
): RollbackResult {
  const backupPath = findMostRecentBackup(configPath);
  if (!backupPath) {
    throw new Error(`No backups found for ${configPath}`);
  }

  const configStat = fs.statSync(configPath);
  const backupStat = fs.statSync(backupPath);
  if (backupStat.mtimeMs > configStat.mtimeMs) {
    throw new Error(
      `Backup ${backupPath} is newer than current config ${configPath}; refusing to clobber a concurrent write`,
    );
  }

  if (!options.write) {
    return { configPath, backupPath, wouldRestore: true, restored: false };
  }

  try {
    fs.renameSync(backupPath, configPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      throw new Error(`Cannot restore backup (permission denied): ${configPath}`);
    }
    throw err;
  }
  return { configPath, backupPath, wouldRestore: true, restored: true };
}

export function runRollback(argv: string[]): RollbackResult[] {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return [];
  }

  const configFiles = findConfigFiles(args);
  const results = configFiles.map((configPath) =>
    rollbackConfigFile(configPath, { write: args.write }),
  );

  for (const result of results) {
    if (result.restored) {
      console.log(`restored: ${result.configPath} <- ${result.backupPath}`);
    } else {
      console.log(`would restore: ${result.configPath} <- ${result.backupPath}`);
    }
  }
  if (!args.write) {
    console.log('dry run only; pass --write to apply rollback');
  }

  return results;
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
  --rollback          Restore the most recent config.json.bak-* backup.
                      Defaults to dry-run; pass --write to apply.
  --help              Show this help.

The migrator only reads and writes config.json files. It does not touch
tokens.env, auth/, bot.db, keychains, or provider credentials.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const argv = process.argv.slice(2);
    if (argv.includes('--rollback')) {
      runRollback(argv);
    } else {
      runMigration(argv);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
