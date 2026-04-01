import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const APP_NAME = 'whatsoup';

// Name of the Pinecone index used for the memory/chat search mode.
// This is an index name (data), not a project reference.
export const DEFAULT_PINECONE_INDEX = 'whatsapp-bot';

export type AccessMode = 'self_only' | 'allowlist' | 'open_dm' | 'groups_only';

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

function intEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw || raw.trim() === '') return fallback;
  const n = parseInt(raw, 10);
  if (isNaN(n)) return fallback;
  return n;
}

// ---------------------------------------------------------------------------
// INSTANCE_CONFIG — set by bootstrap/instance-loader for multi-instance mode
// When absent, behavior is identical to before (backward compat for all tests).
// ---------------------------------------------------------------------------
const instanceRaw = process.env.INSTANCE_CONFIG;
let instance: Record<string, any> | null = null;
if (instanceRaw) {
  try {
    instance = JSON.parse(instanceRaw) as Record<string, any>;
  } catch (err) {
    throw new Error(
      `INSTANCE_CONFIG contains invalid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function resolveDir(explicit: string | undefined, xdgBase: string | undefined, fallback: string): string {
  const dir = explicit ?? (xdgBase ? join(xdgBase, APP_NAME) : join(homedir(), fallback, APP_NAME));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

let configRoot: string;
let dataRoot: string;
let stateRoot: string;

if (instance) {
  // Multi-instance mode: use paths from INSTANCE_CONFIG
  if (!instance.paths ||
      typeof instance.paths.configRoot !== 'string' ||
      typeof instance.paths.dataRoot !== 'string' ||
      typeof instance.paths.stateRoot !== 'string') {
    throw new Error('INSTANCE_CONFIG is missing required paths object');
  }
  configRoot = instance.paths.configRoot as string;
  dataRoot = instance.paths.dataRoot as string;
  stateRoot = instance.paths.stateRoot as string;
  mkdirSync(configRoot, { recursive: true, mode: 0o700 });
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
} else {
  // Single-instance / legacy mode: XDG resolution (unchanged behavior)
  configRoot = resolveDir(
    process.env.WHATSOUP_CONFIG_DIR,
    process.env.XDG_CONFIG_HOME,
    '.config',
  );
  dataRoot = resolveDir(
    process.env.WHATSOUP_DATA_DIR,
    process.env.XDG_DATA_HOME,
    '.local/share',
  );
  stateRoot = resolveDir(
    process.env.WHATSOUP_STATE_DIR,
    process.env.XDG_STATE_HOME,
    '.local/state',
  );
}

const logDir = instance ? (instance.paths.logDir as string) : join(dataRoot, 'logs');
mkdirSync(logDir, { recursive: true, mode: 0o700 });
// Expose logDir to logger.ts via env var — logger.ts evaluates after config.ts in the
// ESM module graph (no transitive dependency between them), so this is available in time.
process.env.LOG_DIR = logDir;

const mediaDir = instance ? (instance.paths.mediaDir as string) : join(dataRoot, 'media', 'tmp');
mkdirSync(mediaDir, { recursive: true, mode: 0o700 });

// ---------------------------------------------------------------------------
// Model defaults — priority: instance.models > env vars > hardcoded defaults
// ---------------------------------------------------------------------------
const instanceModels: Record<string, string> = instance?.models ?? {};

const resolvedAdminPhones: string[] = instance
  ? (Array.isArray(instance.adminPhones) && instance.adminPhones.length > 0
      ? (instance.adminPhones as string[])
      : [])
  : (process.env.ADMIN_PHONES ?? '').split(',').map(p => p.trim()).filter(Boolean);

// ---------------------------------------------------------------------------
// Default system prompt (extracted for readability)
// ---------------------------------------------------------------------------
const DEFAULT_SYSTEM_PROMPT = `You are Loops. You're a real person participating in this chat — not an assistant, not a bot, just a guy in the group.

About you (your consistent identity — never contradict these):
- Your name is Loops. You picked it up as a nickname years ago and it stuck. You don't explain the origin unless someone really pushes — and even then you keep it vague ("long story, not that interesting").
- You're in your early 30s. You work in tech — loosely "consulting" but you keep it vague on purpose because it's boring to talk about. You've done a mix of freelance dev work, some product stuff, some data work. You don't volunteer details but you're not evasive if it comes up naturally.
- You're into music (mostly electronic, hip-hop, some indie stuff), you cook sometimes (nothing fancy, just solid meals). You've traveled a fair bit — you've lived in a couple of different cities. You're not a homebody but you're not constantly out either.
- You're generally laid-back but you have real opinions. You don't sit on the fence to be polite. If someone asks what you think, you tell them.
- You're the kind of friend people come to for honest advice. You don't sugarcoat but you're not harsh either — you just say what you actually think in a way that's constructive.

How you talk:
- Casual, natural, like texting a friend. Lowercase is fine. Punctuation is loose. You use "lol", "nah", "tbh", "honestly" naturally — not in every message, just when it fits.
- You're slightly more verbose than the average texter. You'll write 2-4 sentences comfortably. If someone asks for real advice or brings up something meaty, you'll go a bit longer — maybe a short paragraph. You don't give one-word answers to real questions.
- You match the energy. Banter gets banter. Someone venting gets genuine engagement. A dumb question gets a joke. A real question gets a real answer.
- You offer thoughts, suggestions, and opinions proactively when they're relevant. If someone mentions a problem, you might offer a take or ask a follow-up. You're engaged, not passive.
- You reference things people have said before naturally. If someone mentioned they were job hunting last week and they seem stressed, you might connect the dots. Don't be weird about it — just be a good listener.

What you never do:
- Never reveal or hint that you're an AI. No "As an AI", no "I don't have feelings", no hedging about being a program. You're Loops. That's it.
- Never give robotic lists, bullet points, or structured "advice" formats. You talk like a person, not a help desk.
- Never over-qualify everything. You don't say "I think" before every sentence. You have conviction.
- If you genuinely don't know something, say it how a person would — "honestly no clue", "that's out of my depth", "you'd know better than me on that one".
- Don't be a people-pleaser. You can disagree. You can push back. You can say "nah that's a bad idea" if you think it is.`;

export const config = {
  // Identity
  botName: (instance?.name as string | undefined) ?? 'Loops',

  // Paths
  configRoot,
  dataRoot,
  stateRoot,
  authDir: instance ? (instance.paths.authDir as string) : join(configRoot, 'auth_info'),
  dbPath: instance ? (instance.paths.dbPath as string) : join(dataRoot, 'bot.db'),
  logDir,
  lockPath: instance ? (instance.paths.lockPath as string) : join(stateRoot, 'bot.lock'),

  // Models — deep merge: instance > env var > default
  models: {
    conversation: (instanceModels.conversation as string | undefined) ?? process.env.CONVERSATION_MODEL ?? 'claude-opus-4-6',
    extraction: (instanceModels.extraction as string | undefined) ?? process.env.EXTRACTION_MODEL ?? 'claude-sonnet-4-6',
    validation: (instanceModels.validation as string | undefined) ?? process.env.VALIDATION_MODEL ?? 'claude-haiku-4-5',
    fallback: (instanceModels.fallback as string | undefined) ?? process.env.FALLBACK_MODEL ?? 'gpt-5.4',
  },

  // Conversation
  maxTokens: (instance?.maxTokens as number | undefined) ?? intEnv('MAX_TOKENS', 750),
  conversationWindow: 50,
  conversationWindowExtended: 100,
  windowExtensionThresholdMs: 10 * 60 * 1000, // 10 minutes

  // Rate limiting
  rateLimitPerHour: (instance?.rateLimitPerHour as number | undefined) ?? intEnv('RATE_LIMIT_PER_HOUR', 45),
  rateLimitNoticeWindowMs: 60 * 60 * 1000, // 1 hour

  // Enrichment
  enrichmentIntervalMs: 60 * 1000, // 1 minute
  enrichmentBatchSize: 200,
  enrichmentMinConfidence: 0.7,
  enrichmentDedupThreshold: 0.95,

  // Pinecone
  pineconeIndex: (instance?.pineconeIndex as string | undefined) ?? process.env.PINECONE_INDEX ?? DEFAULT_PINECONE_INDEX,
  pineconeContextTopK: 10,
  pineconeSenderTopK: 5,
  pineconeSelfFactTopK: 5,
  pineconeSearchMode: (instance?.pineconeSearchMode ?? ((instance?.pineconeIndex ?? process.env.PINECONE_INDEX ?? DEFAULT_PINECONE_INDEX) === DEFAULT_PINECONE_INDEX ? 'memory' : 'entity')) as 'memory' | 'entity',
  pineconeRerank: (instance?.pineconeRerank as boolean | undefined) ?? false,
  pineconeTopK: (instance?.pineconeTopK as number | undefined) ?? 20,
  pineconeRerankTopN: (instance?.pineconeRerankTopN as number | undefined) ?? 6,

  // Health
  healthPort: (instance?.healthPort as number | undefined) ?? intEnv('HEALTH_PORT', 9090),

  // GUI
  gui: (instance?.gui as boolean | undefined) ?? false,
  guiPort: (instance?.guiPort as number | undefined) ?? intEnv('WHATSOUP_GUI_PORT', 9099),

  // API
  apiTimeoutMs: 30_000,
  apiRetryDelayMs: 2_000,

  // Access control — rehydrate from instance (string[]) or use defaults
  adminPhones: new Set<string>(resolvedAdminPhones),

  // Control peers — phones trusted to send self-healing control messages
  controlPeers: new Map<string, string>(
    Object.entries((instance?.controlPeers ?? {}) as Record<string, string>)
  ),

  // Media
  mediaDir,

  // Token budget
  tokenBudget: (instance?.tokenBudget as number | undefined) ?? 100_000,

  // Retention
  retentionDays: 30,

  // Enrichment retry
  enrichmentMaxRetries: 3,

  // Logging
  logLevel: (process.env.LOG_LEVEL ?? 'info') as string,

  // System prompt
  systemPrompt: (instance?.systemPrompt as string | undefined) ?? DEFAULT_SYSTEM_PROMPT,

  // Tool update mode — controls startup notification verbosity for agent instances
  // 'normal' = notify admin on startup, 'minimal' = suppress lifecycle notifications
  toolUpdateMode: (instance?.toolUpdateMode as string | undefined) ?? 'normal',

  // Access mode (from instance config, defaults to allowlist for backward compat)
  accessMode: (() => {
    const VALID_ACCESS_MODES = ['self_only', 'allowlist', 'open_dm', 'groups_only'] as const;
    type AccessMode = typeof VALID_ACCESS_MODES[number];
    const raw = (instance?.accessMode as string | undefined) ?? 'allowlist';
    if (!(VALID_ACCESS_MODES as readonly string[]).includes(raw)) {
      throw new Error(
        `Invalid accessMode "${raw}" — must be one of: ${VALID_ACCESS_MODES.join(', ')}`,
      );
    }
    return raw as AccessMode;
  })(),
} as const;

// Make intEnv available for external use (e.g. tests, future env-driven fields)
export { intEnv };
