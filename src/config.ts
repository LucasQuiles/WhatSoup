import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { normalizePhoneE164 } from './lib/phone.ts';

const APP_NAME = 'whatsoup';

// Name of the Pinecone index used for the memory/chat search mode.
// This is an index name (data), not a project reference.
export const DEFAULT_PINECONE_INDEX = 'whatsapp-bot';

export type AccessMode = 'self_only' | 'allowlist' | 'open_dm' | 'groups_only';

export interface ToolThreshold {
  expectedMs: number;
  slowMultiplier: number;
  stallMultiplier: number;
}

export interface OperationTrackerConfig {
  enabled: boolean;
  progressIntervalMs: number;
  thinkingLongMs: number;
  thinkingStallMs: number;
  toolThresholds: Record<string, ToolThreshold>;
}

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
const DEFAULT_TOOL_THRESHOLDS: Record<string, ToolThreshold> = {
  agent:   { expectedMs: 120_000, slowMultiplier: 1.5, stallMultiplier: 3 },
  bash:    { expectedMs: 15_000,  slowMultiplier: 2,   stallMultiplier: 5 },
  read:    { expectedMs: 3_000,   slowMultiplier: 3,   stallMultiplier: 10 },
  edit:    { expectedMs: 2_000,   slowMultiplier: 3,   stallMultiplier: 10 },
  web:     { expectedMs: 10_000,  slowMultiplier: 2,   stallMultiplier: 4 },
  mcp:     { expectedMs: 15_000,  slowMultiplier: 2,   stallMultiplier: 5 },
  skill:   { expectedMs: 3_000,   slowMultiplier: 3,   stallMultiplier: 10 },
  default: { expectedMs: 10_000,  slowMultiplier: 2,   stallMultiplier: 5 },
};

function mergeToolThresholds(
  overrides?: Record<string, Partial<ToolThreshold>> | unknown,
): Record<string, ToolThreshold> {
  const result = { ...DEFAULT_TOOL_THRESHOLDS };
  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
    return result;
  }
  for (const [key, partial] of Object.entries(overrides as Record<string, unknown>)) {
    if (typeof partial !== 'object' || partial === null) continue;
    const base = result[key] ?? result.default;
    const p = partial as Partial<ToolThreshold>;
    result[key] = {
      expectedMs: typeof p.expectedMs === 'number' ? p.expectedMs : base.expectedMs,
      slowMultiplier: typeof p.slowMultiplier === 'number' ? p.slowMultiplier : base.slowMultiplier,
      stallMultiplier: typeof p.stallMultiplier === 'number' ? p.stallMultiplier : base.stallMultiplier,
    };
  }
  return result;
}

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
// Ensure media/cache/ sibling directory exists alongside media/tmp/ (SP7)
mkdirSync(join(mediaDir, '..', 'cache'), { recursive: true, mode: 0o700 });

// ---------------------------------------------------------------------------
// Model defaults — priority: instance.models > env vars > hardcoded defaults
// ---------------------------------------------------------------------------
const instanceModels: Record<string, string> = instance?.models ?? {};

const rawAdminPhones: string[] = instance
  ? (Array.isArray(instance.adminPhones) && instance.adminPhones.length > 0
      ? (instance.adminPhones as string[])
      : [])
  : (process.env.ADMIN_PHONES ?? '').split(',').map(p => p.trim()).filter(Boolean);
// Normalize to E.164 digits — "845-978-0919" → "18459780919", "+1 845 978 0919" → "18459780919"
const resolvedAdminPhones = rawAdminPhones.map(normalizePhoneE164);

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

// ---------------------------------------------------------------------------
// Rate-limit window migration (SP6)
// If rateLimitWindowMs is not explicitly set in instance config, fall back to
// rateLimitNoticeWindowMs (the old dual-purpose field) and log a deprecation
// note at startup.
// ---------------------------------------------------------------------------
const DEFAULT_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const resolvedRateLimitWindowMs: number = (() => {
  if (instance?.rateLimitWindowMs != null) {
    return instance.rateLimitWindowMs as number;
  }
  if (instance?.rateLimitNoticeWindowMs != null) {
    // eslint-disable-next-line no-console -- startup deprecation warning before logger is available; expires 2026-07-01
    console.warn(
      '[config] DEPRECATION: rateLimitWindowMs not set — falling back to rateLimitNoticeWindowMs (%dms). ' +
        'Set rateLimitWindowMs explicitly to silence this warning.',
      instance.rateLimitNoticeWindowMs,
    );
    return instance.rateLimitNoticeWindowMs as number;
  }
  return DEFAULT_RATE_WINDOW_MS;
})();

export const config = {
  // Identity
  botName: (instance?.name as string | undefined) ?? 'Loops',
  instanceType: ((instance?.type as string | undefined) ?? 'chat') as 'passive' | 'chat' | 'agent',

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
  rateLimitWindowMs: resolvedRateLimitWindowMs, // measurement window for counting responses (SP6)
  rateLimitNoticeWindowMs: (instance?.rateLimitNoticeWindowMs as number | undefined) ?? DEFAULT_RATE_WINDOW_MS, // dedup window for rate-limit notices

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
  pineconeAllowedIndexes: (Array.isArray(instance?.pineconeAllowedIndexes) ? instance.pineconeAllowedIndexes : []) as string[],

  // Recency decay — Ebbinghaus-style exponential forgetting for memory search
  recencyHalfLifeDays: (instance?.recencyHalfLifeDays as number | undefined) ?? Number(process.env.RECENCY_HALF_LIFE_DAYS ?? 14),
  maxAgeDays: (instance?.maxAgeDays as number | undefined) ?? Number(process.env.MAX_AGE_DAYS ?? 90),

  // Tool update verbosity: 'full' (default — all updates shown to user),
  // 'friendly' (all updates in plain language for non-technical users),
  // 'minimal' (suppress most updates — only critical status shown)
  toolUpdateMode: ((instance?.toolUpdateMode as string | undefined) ?? 'full') as 'full' | 'friendly' | 'minimal',

  // Operation tracker: per-tool progress reporting & stall detection
  operationTracker: {
    enabled: (instance?.operationTracker?.enabled as boolean | undefined) ?? true,
    progressIntervalMs: (instance?.operationTracker?.progressIntervalMs as number | undefined) ?? 30_000,
    thinkingLongMs: (instance?.operationTracker?.thinkingLongMs as number | undefined) ?? 45_000,
    thinkingStallMs: (instance?.operationTracker?.thinkingStallMs as number | undefined) ?? 300_000,
    toolThresholds: mergeToolThresholds(instance?.operationTracker?.toolThresholds),
  } satisfies OperationTrackerConfig,

  // Health
  healthPort: (instance?.healthPort as number | undefined) ?? intEnv('HEALTH_PORT', 9090),

  // GUI
  gui: (instance?.gui as boolean | undefined) ?? false,
  guiPort: (instance?.guiPort as number | undefined) ?? intEnv('WHATSOUP_GUI_PORT', 9099),

  // API
  // P3.6 review D-2: env-var override for operator-actionable timeout
  // tuning. The mwlab runbook's "raise apiTimeoutMs" recovery step is
  // now actionable without a code edit via WHATSOUP_API_TIMEOUT_MS.
  // Invalid values (non-numeric) and non-positive values (0, negative)
  // fall back to the 30_000 default — intEnv() handles the non-numeric
  // case, the positive-only guard below handles 0 / negative.
  apiTimeoutMs: (() => {
    const n = intEnv('WHATSOUP_API_TIMEOUT_MS', 30_000);
    return n > 0 ? n : 30_000;
  })(),
  apiRetryDelayMs: 2_000,

  // Access control — rehydrate from instance (string[]) or use defaults
  adminPhones: new Set<string>(resolvedAdminPhones),

  // Control peers — phones trusted to send self-healing control messages
  controlPeers: new Map<string, string>(
    Object.entries((instance?.controlPeers ?? {}) as Record<string, string>)
  ),

  // Sibling bot phones — phone numbers of other WhatSoup instances that share
  // groups with this instance.  Messages from siblings are silently ignored in
  // groups to prevent infinite echo loops between co-located bots.
  siblingPhones: new Set<string>(
    (Array.isArray(instance?.siblingPhones) ? instance.siblingPhones : [])
      .filter((p: unknown) => typeof p === 'string' && (p as string).trim() !== '')
      .map((p: string) => normalizePhoneE164(p)),
  ),

  // Echo guard — per-group outbound cooldown to prevent cascade floods.
  // In-memory, resets on restart. DMs are never affected.
  echoGuard: {
    enabled: ((instance?.echoGuard as Record<string, unknown> | undefined)?.enabled as boolean | undefined) !== false,
    groupCooldownMs: ((instance?.echoGuard as Record<string, unknown> | undefined)?.groupCooldownMs as number | undefined) ?? 60_000,
  },

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

  // Link preview quality — when true, Baileys generates high-quality thumbnails
  generateHighQualityLinkPreview: (instance?.generateHighQualityLinkPreview as boolean | undefined) ?? false,


  // Agent provider selection — read from agentOptions.provider / agentOptions.providerConfig
  // Defaults to 'claude-cli' for backward compatibility when not specified.
  agentProvider: ((instance?.agentOptions as Record<string, unknown> | undefined)?.['provider'] as string | undefined) ?? 'claude-cli',
  agentProviderConfig: ((instance?.agentOptions as Record<string, unknown> | undefined)?.['providerConfig'] as Record<string, unknown> | undefined) ?? undefined,

  // Voice (ElevenLabs TTS)
  elevenlabs: {
    defaultVoiceId: (instance?.elevenlabs?.defaultVoiceId as string | undefined) ?? 'pNInz6obpgDQGcFmaJgB',
    defaultModel: (instance?.elevenlabs?.defaultModel as string | undefined) ?? 'eleven_multilingual_v2',
    stability: (instance?.elevenlabs?.stability as number | undefined) ?? 0.5,
    similarityBoost: (instance?.elevenlabs?.similarityBoost as number | undefined) ?? 0.75,
  },
  voiceReply: ((instance?.voiceReply as string | undefined) ?? 'never') as 'always' | 'when_received' | 'never',

  // Typing simulation (SP5)
  autoTyping: ((instance?.autoTyping as string | undefined) ?? 'off') as 'composing' | 'recording' | 'off',

  // Media retention (SP7) — per-instance config with safe defaults
  mediaRetention: {
    tempHours:     (instance?.mediaRetention?.tempHours     as number | undefined) ?? 72,
    cacheHours:    (instance?.mediaRetention?.cacheHours    as number | undefined) ?? 168, // 7 days
    intervalHours: (instance?.mediaRetention?.intervalHours as number | undefined) ?? 6,
  },

  // Ingest backpressure (SP1)
  ingest: {
    maxConcurrent: (instance?.ingest?.maxConcurrent as number | undefined) ?? 20,
    maxQueueDepth: (instance?.ingest?.maxQueueDepth as number | undefined) ?? 500,
  },

  // Connection exhaustion (SP2) — exit after N exhaustion cycles so systemd can restart
  maxExhaustionCycles: (instance?.maxExhaustionCycles as number | undefined) ?? 2,

  // Turn queue depth cap (SP3)
  agentMaxQueueDepth: (instance?.agentMaxQueueDepth as number | undefined) ?? 25,

  // Admin allow replay throttle (SP4)
  adminReplayMax: (instance?.adminReplayMax as number | undefined) ?? 5,
  adminReplayDelayMs: (instance?.adminReplayDelayMs as number | undefined) ?? 2000,

  // Advanced tool gates (SP5)
  advanced: {
    enableRelayMessage: (instance?.advanced?.enableRelayMessage as boolean | undefined) ?? false,
    enableResync: (instance?.advanced?.enableResync as boolean | undefined) ?? false,
    relayMaxPayloadBytes: (instance?.advanced?.relayMaxPayloadBytes as number | undefined) ?? 1_048_576, // 1MB
  },

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
