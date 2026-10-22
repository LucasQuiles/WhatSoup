import { statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { SQLITE_BUSY_TIMEOUT_PRAGMA } from '../src/lib/sqlite-constants.ts';
import {
  HARD_LIMITS,
  applyPreparation,
  planPreparation,
  realAfter,
  sha256,
  type PrepDeps,
  type PrepOptions,
  type PrepResult,
} from './lib/recovered-audio-prep.ts';

export const LOCAL_PROVIDERS = ['whisper.cpp', 'faster-whisper'] as const;
export type LocalProvider = (typeof LOCAL_PROVIDERS)[number];

const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const REQUIRED_COLUMNS = ['message_id', 'conversation_key', 'content_type', 'content', 'content_text', 'raw_message', 'media_path', 'deleted_at'];

export interface CliArgs extends PrepOptions {
  dbPath: string;
  outPath: string;
  apply: boolean;
  provider: LocalProvider | null;
  mediaDir: string | null;
}

function usage(): string {
  return [
    'Usage: prepare-recovered-audio --db PATH --out MANIFEST --message-id ID [--message-id ID ...]',
    '         [--exclude ID ...] [--apply --provider whisper.cpp|faster-whisper --media-dir DIR]',
    '         [--max-wall-seconds N] [--max-audio-seconds N]',
    '',
    'Preview (default) checks the selection and budgets and writes nothing but the manifest.',
    '--apply downloads and transcribes the selected voice notes with the named local provider.',
    'Exit: 0 ready (apply) or executable (preview); 2 selection blocked; 3 apply finished not ready.',
  ].join('\n');
}

const VALUE_FLAGS = new Set(['--db', '--out', '--message-id', '--exclude', '--provider', '--media-dir', '--max-wall-seconds', '--max-audio-seconds']);
const REPEATABLE = new Set(['--message-id', '--exclude']);

function positiveInt(flag: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer`);
  return n;
}

export function parsePrepareRecoveredAudioArgs(argv: string[]): CliArgs {
  if (argv.includes('--help')) throw new Error(usage());
  const single = new Map<string, string>();
  const repeated = new Map<string, string[]>([['--message-id', []], ['--exclude', []]]);
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === '--apply') { apply = true; continue; }
    if (!VALUE_FLAGS.has(flag)) throw new Error(`Unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--') || value.length === 0) throw new Error(`${flag} requires a value`);
    index += 1;
    if (REPEATABLE.has(flag)) { repeated.get(flag)!.push(value); continue; }
    if (single.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    single.set(flag, value);
  }
  const dbPath = single.get('--db');
  const outPath = single.get('--out');
  if (!dbPath) throw new Error('--db is required');
  if (!outPath) throw new Error('--out is required');
  const provider = single.get('--provider') ?? null;
  if (provider !== null && !(LOCAL_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`--provider must be one of: ${LOCAL_PROVIDERS.join(', ')}`);
  }
  const mediaDir = single.get('--media-dir') ?? null;
  if (apply && (provider === null || mediaDir === null)) throw new Error('--apply requires --provider and --media-dir');
  return {
    dbPath: resolve(dbPath),
    outPath: resolve(outPath),
    apply,
    provider: provider as LocalProvider | null,
    mediaDir: mediaDir === null ? null : resolve(mediaDir),
    messageIds: repeated.get('--message-id')!,
    exclude: repeated.get('--exclude')!,
    maxWallSeconds: positiveInt('--max-wall-seconds', single.get('--max-wall-seconds'), 900),
    maxTotalAudioSeconds: positiveInt('--max-audio-seconds', single.get('--max-audio-seconds'), 1800),
  };
}

function assertMessagesSchema(db: DatabaseSync): void {
  const columns = new Set((db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map((c) => c.name));
  const missing = REQUIRED_COLUMNS.filter((c) => !columns.has(c));
  if (missing.length > 0) throw new Error(`messages table lacks required columns: ${missing.join(', ')}`);
}

async function loadProvider(name: LocalProvider): Promise<PrepDeps['transcribe']> {
  const provider = name === 'whisper.cpp'
    ? (await import('../src/runtimes/chat/providers/transcription/whisper-cpp.ts')).whisperCppProvider
    : (await import('../src/runtimes/chat/providers/transcription/faster-whisper.ts')).fasterWhisperProvider;
  if (!provider.isAvailable()) throw new Error(`Transcription provider ${name} is not available on this host`);
  return (buffer, mimeType) => provider.transcribe(buffer, mimeType);
}

async function downloadAudio(rawMessage: unknown, _mime: string, declaredBytes: number | null): Promise<Buffer> {
  if (declaredBytes !== null && declaredBytes > MAX_AUDIO_BYTES) throw new Error('declared size exceeds 25MB');
  const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const buffer = await Promise.race([
      downloadMediaMessage(rawMessage as Parameters<typeof downloadMediaMessage>[0], 'buffer', {}) as Promise<Buffer>,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('download timed out')), DOWNLOAD_TIMEOUT_MS); }),
    ]);
    if (buffer.length > MAX_AUDIO_BYTES) throw new Error('downloaded size exceeds 25MB');
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

function writeManifest(path: string, args: CliArgs, result: PrepResult): string {
  const body = JSON.stringify({
    contract: 'recovered-audio-prep.v1',
    generatedAt: new Date(Date.now()).toISOString(),
    provider: args.provider,
    limits: { ...HARD_LIMITS, maxWallSeconds: args.maxWallSeconds, maxTotalAudioSeconds: args.maxTotalAudioSeconds },
    ...result,
  }, null, 2);
  writeFileSync(path, `${body}\n`, { mode: 0o600, flag: 'wx' });
  return sha256(body);
}

export async function runPrepareRecoveredAudioCli(argv: string[], depsOverride?: Partial<PrepDeps>): Promise<number> {
  const args = parsePrepareRecoveredAudioArgs(argv);
  if (!statSync(args.dbPath).isFile()) throw new Error('--db must be an existing regular file');
  if (args.mediaDir !== null && !statSync(args.mediaDir).isDirectory()) throw new Error('--media-dir must be an existing directory');
  const db = new DatabaseSync(args.dbPath, { readOnly: !args.apply });
  try {
    db.exec(SQLITE_BUSY_TIMEOUT_PRAGMA);
    assertMessagesSchema(db);
    const plan = planPreparation(db, args);
    let result = plan;
    if (args.apply && plan.blockers.length === 0) {
      const mediaDir = args.mediaDir!;
      const deps: PrepDeps = {
        download: depsOverride?.download ?? downloadAudio,
        transcribe: depsOverride?.transcribe ?? await loadProvider(args.provider!),
        writeMedia: depsOverride?.writeMedia ?? ((fileName, buffer) => {
          const path = join(mediaDir, fileName);
          try {
            writeFileSync(path, buffer, { mode: 0o600, flag: 'wx' });
          } catch (error) {
            // Names derive from the audio hash, so an existing file already holds these bytes.
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          }
          return path;
        }),
        nowMs: depsOverride?.nowMs ?? (() => performance.now()),
        after: depsOverride?.after ?? realAfter,
      };
      result = await applyPreparation(db, plan, args, deps);
    }
    const manifestSha256 = writeManifest(args.outPath, args, result);
    process.stdout.write(`${JSON.stringify({
      ok: result.blockers.length === 0,
      mode: result.mode,
      ready: result.ready,
      blockers: result.blockers,
      statuses: result.items.map((i) => ({ messageId: i.messageId, status: i.status, reason: i.reason })),
      manifest: args.outPath,
      manifestSha256,
    })}\n`);
    if (result.blockers.length > 0) return 2;
    if (result.mode === 'apply' && !result.ready) return 3;
    return 0;
  } finally {
    db.close();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  runPrepareRecoveredAudioCli(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
      process.exitCode = 1;
    },
  );
}
