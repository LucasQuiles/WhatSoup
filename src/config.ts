import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { printErr } from './lib/cli-print.ts';
import { normalizePhoneE164, normalizePhoneE164Wire } from './lib/phone.ts';
import { asRecord, isNonEmptyString } from './lib/type-guards.ts';
import { migrateLegacyMemoryConfig } from './config-memory-migration.ts';
import { resolveConfiguredAccountScope } from './transport/coordination-lease.ts';
import type { Profile } from './core/profiles.ts';
import { DEFAULT_BIND_ADDRESS } from './fleet/constants.ts';
import { VALID_ACCESS_MODES, VALID_GROUP_SENDER_POLICIES, type AccessMode, type GroupSenderPolicy } from './instance-loader.ts';
import { DEFAULT_TRANSPORT_ID, isTransportId, type TransportId } from './transport/registry.ts';
import { DEFAULT_FLEET_PORT, DEFAULT_INSTANCE_HEALTH_PORT } from './fleet/constants.ts';
import { DEFAULT_TWILIO_SMS, DEFAULT_TWILIO_VOICE, type TwilioSmsConfig, type TwilioInboundMode, type TwilioWebhookConfig, type TwilioVoiceConfig } from './transport/twilio/types.ts';
import { DEFAULT_IMESSAGE, type ImessageConfig, type ImessageInboundMode } from './transport/imessage/types.ts';
import { DEFAULT_SIGNAL, SIGNAL_UUID_RE, type SignalConfig, type SignalInboundMode } from './transport/signal/types.ts';
import { canonicalizeImessageDirectIdentity } from './core/transport-refs.ts';
import { parseCapabilityObligationsOptions } from './core/capability-contract.ts';
import { normalizeFallbackDiscoveryFromAgentOptions, normalizeFallbackEntriesFromAgentOptions } from './core/fallback-chain.ts';
import {
  isProviderBoundaryMode,
  isProviderDataPolicy,
} from './core/provider-data-policy.ts';
import { errorMessage } from './lib/error-message.ts';
import { validateModelRoleValue } from './lib/model-resolver.ts';
import { MS_PER_SECOND, MS_PER_MINUTE, MS_PER_HOUR } from './lib/time-units.ts';
import { ConfigValidationError } from './lib/startup-error.ts';
import { parseRuntimeBootstrapConfig, type RuntimeBootstrapConfig } from './lib/instance-config-shape.ts';

const APP_NAME = 'whatsoup';

// Name of the Pinecone index used for the memory/chat search mode.
// This is an index name (data), not a project reference.
const DEFAULT_PINECONE_INDEX = 'whatsapp-bot';
const DEFAULT_PINECONE_API_KEY_ENV = 'PINECONE_API_KEY';
const DEFAULT_PINECONE_RERANK_MODEL = 'pinecone-rerank-v0';
const DEFAULT_KNOWLEDGE_EMBED_URL = 'http://127.0.0.1:8799/embed';

export type { AccessMode, GroupSenderPolicy } from './instance-loader.ts';
export type PineconeSearchMode = 'memory' | 'entity';
export type KnowledgeSearchMode = 'entity' | 'text' | 'vector';

export interface PineconeNamespaceConfig {
  facts: string;
  chunks: string;
  summaries: string;
  legacy: string;
  contacts: string;
  localDocs: string;
  oneDrive: string;
  [key: string]: string;
}

export interface KnowledgeProfileConfig {
  namespace: string;
  namespaces: string[];
  searchMode: KnowledgeSearchMode;
  rerank: boolean;
  rerankModel: string;
  topK: number;
  rerankTopN: number;
  minScore?: number;
  description: string;
  embedUrl?: string;
}

export interface MemoryConfig {
  adminJid: string;
  vaultPath: string;
  observationConfidenceMin: number;
  sweep: {
    beadProposeMin: number;
    beadUpdateMin: number;
    lookbackHours: number;
    reviewByDays: number;
    overdueProposalAlertThreshold: number;
  };
  watchTtl: {
    defaultHours: number;
    maxHours: number;
  };
  /**
   * poll.file watch path policy. `allowedRoots` is the explicit allowlist of
   * filesystem roots a `poll.file` trigger may resolve under. It defaults to
   * EMPTY = deny-all (fail-closed): the trigger poller runs unsandboxed in the
   * main process, so a confused-deputy watch spec must not be able to probe
   * arbitrary host paths. Operators opt specific roots in via
   * `memory.fileWatch.allowed_roots` in instance config.
   */
  fileWatch: {
    allowedRoots: string[];
  };
  conversation: {
    recent: number;
    extended: number;
    extendedWithinMs: number;
  };
  retention: {
    days: number;
  };
  consolidation: {
    enabled: boolean;
    intervalHours: number;
    lookbackDays: number;
    dryRun: boolean;
  };
  enrichment: {
    intervalMs: number;
    batchSize: number;
    minConfidence: number;
    dedupThreshold: number;
    maxRetries: number;
  };
  pinecone: {
    apiKeyEnv: string;
    projectId?: string;
    expectedHostSuffix?: string;
    index: string;
    namespaces: PineconeNamespaceConfig;
    contextTopK: number;
    senderTopK: number;
    selfFactTopK: number;
    searchMode: PineconeSearchMode;
    rerank: boolean;
    rerankModel: string;
    topK: number;
    rerankTopN: number;
    allowedIndexes: string[];
    embedUrl: string;
    knowledgeSearch: {
      enabled: boolean;
      allowGlobalAgentSessions: boolean;
    };
    knowledgeProfiles: Record<string, KnowledgeProfileConfig>;
  };
}

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
  /**
   * Persistent per-chat minimum spacing (ms) between progress placeholders.
   * Caps the "Still working…" flood on long turns regardless of placeholder text
   * uniqueness or turn boundaries. 0 disables the floor. Default 180_000.
   */
  progressPlaceholderRateLimitMs: number;
  /**
   * PR-E: hard per-turn cap on STATUS-NARRATION messages (tool-status batches +
   * progress placeholders). Bounds the dominant chat-flood source without ever
   * gating the user's content/answer/media. Default 10 (MAX_STATUS_MESSAGES_PER_TURN).
   */
  maxStatusMessagesPerTurn: number;
  /**
   * Status-narration cap shared across logical turns in one chat. This closes
   * the reset gap where a burst of related messages can evade the per-turn cap.
   */
  maxStatusMessagesPerWindow: number;
  /** Sliding-window duration for maxStatusMessagesPerWindow. Default 300_000. */
  statusMessageWindowMs: number;
  toolThresholds: Record<string, ToolThreshold>;
}

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

function intEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!isNonEmptyString(raw)) return fallback;
  // Full-string validation: parseInt would accept "123abc" as 123 and
  // "0x10" as 0, silently truncating typos into wrong-but-plausible values.
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return fallback;
  const n = parseInt(trimmed, 10);
  return Number.isSafeInteger(n) ? n : fallback;
}

function positiveIntValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function positiveIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!isNonEmptyString(raw)) return fallback;
  const trimmed = raw.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return fallback;
  return parseInt(trimmed, 10);
}

function stringProp(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  return isNonEmptyString(value) ? value : undefined;
}

function numberProp(source: Record<string, unknown> | undefined, key: string, fallback: number): number {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** For fields where a SET-but-invalid value must fail loud at startup rather
 *  than silently coerce (rate-limit windows becoming NaN disables limiting;
 *  a non-string path would send filesystem state to a stringified junk dir). */
function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new ConfigValidationError(`${label} must be a finite number, got ${JSON.stringify(value)}`);
}

function requirePathString(value: unknown, label: string): string {
  if (isNonEmptyString(value)) return value;
  throw new ConfigValidationError(`${label} must be a non-empty string path, got ${JSON.stringify(value)}`);
}

/** Instance path fields must be absolute (#2295 M7/M8): a relative dbPath or
 *  root would scatter filesystem state under whatever cwd the service manager
 *  happened to launch from. */
function requireAbsolutePathString(value: unknown, label: string): string {
  const path = requirePathString(value, label);
  if (!isAbsolute(path)) {
    throw new ConfigValidationError(`${label} must be an absolute path, got ${JSON.stringify(path)}`);
  }
  return path;
}

/** Env-driven ports mirror the instance validator's 1024-65535 bound (#2295
 *  M5) — out-of-range values fall back like every other env misconfiguration
 *  in this file rather than throwing. */
function portEnv(key: string, fallback: number): number {
  const n = intEnv(key, fallback);
  return n >= 1024 && n <= 65_535 ? n : fallback;
}

/** Optional-field variants for the former raw `as T | undefined` casts (#2295
 *  slice 3). Absent (undefined) and JSON null both mean "unset" and return
 *  undefined so the caller's `??` default applies — exactly what the casts'
 *  nullish coalescing did — while a SET wrong-typed value fails loud instead of
 *  flowing on under a lying type. */
function optionalFiniteNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requireFiniteNumber(value, label);
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  throw new ConfigValidationError(`${label} must be a string, got ${JSON.stringify(value)}`);
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  throw new ConfigValidationError(`${label} must be a boolean, got ${JSON.stringify(value)}`);
}

function optionalEnum<T extends string>(value: unknown, label: string, allowed: readonly T[]): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  throw new ConfigValidationError(`${label} must be one of: ${allowed.join(', ')}, got ${JSON.stringify(value)}`);
}

function configSection(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  const obj = asRecord(value);
  if (!obj) throw new ConfigValidationError(`${label} must be an object, got ${JSON.stringify(value)}`);
  return obj;
}

function requireStringEntries(values: readonly unknown[], label: string): string[] {
  return values.map((entry, index) => {
    if (isNonEmptyString(entry)) return entry;
    throw new ConfigValidationError(`${label}[${index}] must be a non-empty string, got ${JSON.stringify(entry)}`);
  });
}

function boundedIntProp(
  source: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = source?.[key];
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
    ? value
    : fallback;
}

function hasInvalidBoundedIntProp(
  source: Record<string, unknown> | undefined,
  key: string,
  min: number,
  max: number,
): boolean {
  if (!source || !(key in source)) return false;
  const value = source?.[key];
  return typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < min ||
    value > max;
}

function booleanProp(source: Record<string, unknown> | undefined, key: string, fallback: boolean): boolean {
  const value = source?.[key];
  return typeof value === 'boolean' ? value : fallback;
}

function expandTilde(p: string): string {
  if (p.startsWith('~/')) {
    return join(process.env.HOME ?? homedir(), p.slice(2));
  }
  if (p === '~') return process.env.HOME ?? homedir();
  return p;
}

function stringArrayProp(source: Record<string, unknown> | null | undefined, key: string): string[] {
  const value = source?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => isNonEmptyString(item))
    : [];
}

function stringRecordProp(source: Record<string, unknown> | null | undefined, key: string): Record<string, string> {
  const value = source?.[key];
  if (value === undefined) return {};
  const obj = asRecord(value);
  if (!obj) {
    throw new ConfigValidationError(`${key} must be an object of non-empty string values`);
  }

  const result: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(obj)) {
    const alias = rawKey.trim();
    if (alias === '' || !isNonEmptyString(rawValue)) {
      throw new ConfigValidationError(`${key} must be an object of non-empty string values`);
    }
    if (result[alias] !== undefined) {
      throw new ConfigValidationError(`${key} contains duplicate alias after trimming: ${alias}`);
    }
    result[alias] = rawValue.trim();
  }
  return result;
}

function profileRecordProp(source: Record<string, unknown> | null | undefined, key: string): Record<string, Profile> {
  const value = source?.[key];
  if (value === undefined) return {};
  const obj = asRecord(value);
  if (!obj) {
    throw new ConfigValidationError(`${key} must be an object of profile names to profile objects`);
  }

  const allowedFields = new Set(['prefix', 'tag', 'linkPreview']);
  const result: Record<string, Profile> = {};
  for (const [rawName, rawProfile] of Object.entries(obj)) {
    const profileName = rawName.trim();
    if (profileName === '') {
      throw new ConfigValidationError(`${key} must not contain empty profile names`);
    }
    if (result[profileName] !== undefined) {
      throw new ConfigValidationError(`${key} contains duplicate profile after trimming: ${profileName}`);
    }

    const profileObj = asRecord(rawProfile);
    if (!profileObj) {
      throw new ConfigValidationError(`${key}.${profileName} must be an object`);
    }
    for (const field of Object.keys(profileObj)) {
      if (!allowedFields.has(field)) {
        throw new ConfigValidationError(`${key}.${profileName} contains unknown field: ${field}`);
      }
    }

    const profile: Profile = {};
    if (profileObj.prefix !== undefined) {
      if (typeof profileObj.prefix !== 'string') {
        throw new ConfigValidationError(`${key}.${profileName}.prefix must be a string`);
      }
      profile.prefix = profileObj.prefix;
    }
    if (profileObj.tag !== undefined) {
      if (typeof profileObj.tag !== 'string') {
        throw new ConfigValidationError(`${key}.${profileName}.tag must be a string`);
      }
      profile.tag = profileObj.tag;
    }
    if (profileObj.linkPreview !== undefined) {
      if (profileObj.linkPreview !== 'auto' && profileObj.linkPreview !== 'off') {
        throw new ConfigValidationError(`${key}.${profileName}.linkPreview must be "auto" or "off"`);
      }
      profile.linkPreview = profileObj.linkPreview;
    }
    result[profileName] = profile;
  }
  return result;
}

function pineconeSearchMode(value: unknown, fallback: PineconeSearchMode): PineconeSearchMode {
  return value === 'memory' || value === 'entity' ? value : fallback;
}

function knowledgeSearchMode(value: unknown, fallback: KnowledgeSearchMode): KnowledgeSearchMode {
  return value === 'entity' || value === 'text' || value === 'vector' ? value : fallback;
}

// ---------------------------------------------------------------------------
// INSTANCE_CONFIG — set by bootstrap/instance-loader for multi-instance mode
// When absent, behavior is identical to before (backward compat for all tests).
// ---------------------------------------------------------------------------
const DEFAULT_TOOL_THRESHOLDS: Record<string, ToolThreshold> = {
  agent:   { expectedMs: 2 * MS_PER_MINUTE, slowMultiplier: 1.5, stallMultiplier: 3 },
  bash:    { expectedMs: 15 * MS_PER_SECOND, slowMultiplier: 2,   stallMultiplier: 5 },
  read:    { expectedMs: 3 * MS_PER_SECOND,  slowMultiplier: 3,   stallMultiplier: 10 },
  edit:    { expectedMs: 2 * MS_PER_SECOND,  slowMultiplier: 3,   stallMultiplier: 10 },
  web:     { expectedMs: 10 * MS_PER_SECOND, slowMultiplier: 2,   stallMultiplier: 4 },
  mcp:     { expectedMs: 15 * MS_PER_SECOND, slowMultiplier: 2,   stallMultiplier: 5 },
  skill:   { expectedMs: 3 * MS_PER_SECOND,  slowMultiplier: 3,   stallMultiplier: 10 },
  default: { expectedMs: 10 * MS_PER_SECOND, slowMultiplier: 2,   stallMultiplier: 5 },
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
let instance: Record<string, unknown> | null = null;
let bootstrapConfig: RuntimeBootstrapConfig | null = null;
if (instanceRaw) {
  bootstrapConfig = parseRuntimeBootstrapConfig(instanceRaw);
  instance = bootstrapConfig.raw;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function resolveDir(explicit: string | undefined, explicitLabel: string, xdgBase: string | undefined, fallback: string): string {
  // #2295 M7: an explicit override must land at an absolute location — a
  // relative dir would scatter state under whatever cwd the service manager
  // launched from. Tilde is expanded first (env vars set outside a shell,
  // e.g. launchd plists, never get shell expansion).
  const expandedExplicit = explicit !== undefined ? expandTilde(explicit) : undefined;
  if (expandedExplicit !== undefined && !isAbsolute(expandedExplicit)) {
    throw new ConfigValidationError(`${explicitLabel} must be an absolute path, got ${JSON.stringify(explicit)}`);
  }
  // #2295 M8: the XDG Base Directory spec requires relative XDG_*_HOME values
  // to be IGNORED, not honored.
  const xdgBaseAbs = xdgBase !== undefined && isAbsolute(xdgBase) ? xdgBase : undefined;
  const dir = expandedExplicit ?? (xdgBaseAbs ? join(xdgBaseAbs, APP_NAME) : join(homedir(), fallback, APP_NAME));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

let configRoot: string;
let dataRoot: string;
let stateRoot: string;

if (bootstrapConfig) {
  // Multi-instance mode: use paths from INSTANCE_CONFIG
  configRoot = requireAbsolutePathString(bootstrapConfig.paths.configRoot, 'paths.configRoot');
  dataRoot = requireAbsolutePathString(bootstrapConfig.paths.dataRoot, 'paths.dataRoot');
  stateRoot = requireAbsolutePathString(bootstrapConfig.paths.stateRoot, 'paths.stateRoot');
  mkdirSync(configRoot, { recursive: true, mode: 0o700 });
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
} else {
  // Single-instance / legacy mode: XDG resolution (unchanged behavior)
  configRoot = resolveDir(
    process.env.WHATSOUP_CONFIG_DIR,
    'WHATSOUP_CONFIG_DIR',
    process.env.XDG_CONFIG_HOME,
    '.config',
  );
  dataRoot = resolveDir(
    process.env.WHATSOUP_DATA_DIR,
    'WHATSOUP_DATA_DIR',
    process.env.XDG_DATA_HOME,
    '.local/share',
  );
  stateRoot = resolveDir(
    process.env.WHATSOUP_STATE_DIR,
    'WHATSOUP_STATE_DIR',
    process.env.XDG_STATE_HOME,
    '.local/state',
  );
}

const logDir = bootstrapConfig ? requireAbsolutePathString(bootstrapConfig.paths.logDir, 'paths.logDir') : join(dataRoot, 'logs');
mkdirSync(logDir, { recursive: true, mode: 0o700 });
// Expose logDir to logger.ts via env var — logger.ts evaluates after config.ts in the
// ESM module graph (no transitive dependency between them), so this is available in time.
process.env.LOG_DIR = logDir;

const mediaDir = bootstrapConfig ? requireAbsolutePathString(bootstrapConfig.paths.mediaDir, 'paths.mediaDir') : join(dataRoot, 'media', 'tmp');
mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
const processTmpDir = bootstrapConfig?.paths.tmpDir
  ? requireAbsolutePathString(bootstrapConfig.paths.tmpDir, 'paths.tmpDir')
  : join(dataRoot, 'tmp');
mkdirSync(processTmpDir, { recursive: true, mode: 0o700 });
process.env.TMPDIR = processTmpDir;
// Ensure media/cache/ sibling directory exists alongside media/tmp/ (SP7)
mkdirSync(join(mediaDir, '..', 'cache'), { recursive: true, mode: 0o700 });

// ---------------------------------------------------------------------------
// Bot-errors alert routing (#2192 slice 3a) — resolve, then PUBLISH back to
// process.env (the TMPDIR/LOG_DIR pattern above): src/lib/emit-alert.ts and
// src/core/outbound-message-safety.ts read these vars call-time and cannot
// import config (ring rules), so the env var is the sanctioned lib-side
// channel. The publish is instance-value-only — an env-sourced or absent
// value leaves process.env byte-identical, because absence is load-bearing
// (emit-alert fail-closes the legacy helper on a missing JID, and the
// spawned legacy alert script inherits this environment).
// ---------------------------------------------------------------------------
const instanceBotErrorsJid = optionalString(instance?.botErrorsJid, 'botErrorsJid');
if (instanceBotErrorsJid !== undefined) process.env.BOT_ERRORS_JID = instanceBotErrorsJid;
const instanceBotErrorsExpectedJid = optionalString(instance?.botErrorsExpectedJid, 'botErrorsExpectedJid');
if (instanceBotErrorsExpectedJid !== undefined) process.env.BOT_ERRORS_EXPECTED_JID = instanceBotErrorsExpectedJid;
const instanceBotErrorsRequireExpected = optionalBoolean(instance?.botErrorsRequireExpected, 'botErrorsRequireExpected');
if (instanceBotErrorsRequireExpected !== undefined) {
  process.env.BOT_ERRORS_REQUIRE_EXPECTED = instanceBotErrorsRequireExpected ? '1' : '0';
}
// Post-publish reads: the typed fields and the env-reading sites see the same
// bytes by construction. Parsing mirrors emit-alert.ts (trim; the require flag
// treats 0/false/no/off as disabling, anything else — including unset — as on).
const botErrorsJid = process.env.BOT_ERRORS_JID?.trim() || null;
const botErrorsExpectedJid = process.env.BOT_ERRORS_EXPECTED_JID?.trim() || null;
const rawBotErrorsRequireExpected = process.env.BOT_ERRORS_REQUIRE_EXPECTED?.trim().toLowerCase();
const botErrorsRequireExpected = rawBotErrorsRequireExpected
  ? !['0', 'false', 'no', 'off'].includes(rawBotErrorsRequireExpected)
  : true;
// #2192 slice 3b — same instance-value-only publish for the legacy-alert
// throttle window (emit-alert.ts resolves it call-time) and the safe-shape
// credential-path redaction flag (bot-errors-outbox.ts). Parsing mirrors each
// reader exactly: throttle clamps negatives to 0 and falls back on non-finite;
// safe-shape accepts 1/true/yes/on.
const instanceEmitAlertThrottleMs = optionalFiniteNumber(instance?.emitAlertThrottleMs, 'emitAlertThrottleMs');
if (instanceEmitAlertThrottleMs !== undefined) {
  process.env.EMIT_ALERT_THROTTLE_MS = String(instanceEmitAlertThrottleMs);
}
const rawEmitAlertThrottleMs = Number(process.env.EMIT_ALERT_THROTTLE_MS);
const emitAlertThrottleMs = Number.isFinite(rawEmitAlertThrottleMs) ? Math.max(0, rawEmitAlertThrottleMs) : 300_000;
const instanceSafeShapeCredPath = optionalBoolean(instance?.botErrorsSafeShapeCredPath, 'botErrorsSafeShapeCredPath');
if (instanceSafeShapeCredPath !== undefined) {
  process.env.BOT_ERRORS_SAFE_SHAPE_CRED_PATH = instanceSafeShapeCredPath ? '1' : '0';
}
const rawSafeShapeCredPath = (process.env.BOT_ERRORS_SAFE_SHAPE_CRED_PATH ?? '').trim().toLowerCase();
const botErrorsSafeShapeCredPath = ['1', 'true', 'yes', 'on'].includes(rawSafeShapeCredPath);

// ---------------------------------------------------------------------------
// Model defaults — priority: instance.models > env vars > built-in defaults
// ---------------------------------------------------------------------------
const instanceModels = configSection(instance?.models, 'models');

const rawAdminPhones: string[] = instance
  ? (Array.isArray(instance.adminPhones) && instance.adminPhones.length > 0
      // Fail loud on a junk entry (was an unchecked string[] cast that let a
      // non-string crash later in resolveAdminIdentities with a bare TypeError).
      ? requireStringEntries(instance.adminPhones, 'adminPhones')
      : [])
  : (process.env.ADMIN_PHONES ?? '').split(',').map(p => p.trim()).filter(Boolean);
export function resolveAdminIdentities(
  identities: readonly string[],
  transport: TransportId,
): string[] {
  return identities.map((identity) => {
    const trimmed = identity.trim();
    if (transport === 'signal') {
      const lower = trimmed.toLowerCase();
      if (SIGNAL_UUID_RE.test(lower)) return lower;
      const wireIdentity = normalizePhoneE164Wire(trimmed);
      if (!wireIdentity) {
        throw new ConfigValidationError('Signal admin identity must be a UUID or E.164 phone number');
      }
      return wireIdentity;
    }
    if (transport === 'imessage') {
      const directIdentity = canonicalizeImessageDirectIdentity(trimmed);
      if (directIdentity !== null) return directIdentity;
      const wireIdentity = normalizePhoneE164Wire(trimmed);
      if (wireIdentity !== null) {
        return canonicalizeImessageDirectIdentity(wireIdentity) ?? wireIdentity;
      }
      throw new ConfigValidationError('iMessage admin identity must be an AppleID email or E.164 phone number');
    }
    return normalizePhoneE164(trimmed);
  });
}

const adminIdentityTransport: TransportId = isTransportId(instance?.transport)
  ? instance.transport
  : DEFAULT_TRANSPORT_ID;
const resolvedAdminPhones = resolveAdminIdentities(rawAdminPhones, adminIdentityTransport);

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
const DEFAULT_RATE_WINDOW_MS = MS_PER_HOUR; // 1 hour
const resolvedRateLimitWindowMs: number = (() => {
  if (instance?.rateLimitWindowMs != null) {
    return requireFiniteNumber(instance.rateLimitWindowMs, 'rateLimitWindowMs');
  }
  if (instance?.rateLimitNoticeWindowMs != null) {
    // Startup deprecation nudge before the logger exists (config sets LOG_DIR,
    // so importing the logger here would evaluate it too early); the legacy
    // rateLimitNoticeWindowMs fallback is still supported (read at
    // runtime.ts:176), so this nudge is retained, not scheduled for removal;
    // expires 2026-12-31.
    printErr(
      `[config] DEPRECATION: rateLimitWindowMs not set — falling back to rateLimitNoticeWindowMs (${instance.rateLimitNoticeWindowMs}ms). ` +
        'Set rateLimitWindowMs explicitly to silence this warning.',
    );
    return requireFiniteNumber(instance.rateLimitNoticeWindowMs, 'rateLimitNoticeWindowMs');
  }
  return DEFAULT_RATE_WINDOW_MS;
})();

const DEFAULT_PINECONE_NAMESPACES: PineconeNamespaceConfig = {
  facts: 'whatsapp-facts',
  chunks: 'whatsapp-chunks',
  summaries: 'whatsapp-summaries',
  legacy: 'whatsapp',
  contacts: 'whatsapp-contacts',
  localDocs: 'local-docs',
  oneDrive: 'onedrive',
};

const BUILTIN_KNOWLEDGE_PROFILE_NAMES = new Set([
  'mw-mind',
  'oneplatform-search',
  'oneplatform-entities',
]);

function warnConfigDeprecation(payload: Record<string, unknown>, message: string): void {
  // Startup deprecation warning before the logger exists (same LOG_DIR
  // evaluation-order constraint as above); payload stays pino-shaped so a
  // later lazy-logger handoff can move this to the structured pipeline.
  printErr(`${message} ${JSON.stringify(payload)}`);
}

function resolvePineconeNamespaces(source: Record<string, unknown> | undefined): PineconeNamespaceConfig {
  const namespaces: PineconeNamespaceConfig = { ...DEFAULT_PINECONE_NAMESPACES };
  for (const [key, value] of Object.entries(source ?? {})) {
    if (isNonEmptyString(value)) {
      namespaces[key] = value;
    }
  }
  return namespaces;
}

function defaultKnowledgeProfiles(
  namespaces: PineconeNamespaceConfig,
  defaultEmbedUrl: string,
): Record<string, KnowledgeProfileConfig> {
  return {
    'oneplatform-search': {
      namespace: '__default__',
      namespaces: [],
      searchMode: 'entity',
      rerank: true,
      rerankModel: DEFAULT_PINECONE_RERANK_MODEL,
      topK: 20,
      rerankTopN: 6,
      description: 'BES business data — accounts, contacts, buildings, work orders, invoices',
    },
    'oneplatform-entities': {
      namespace: '',
      namespaces: ['accounts', 'contacts', 'buildings', 'people', 'externals'],
      searchMode: 'entity',
      rerank: true,
      rerankModel: DEFAULT_PINECONE_RERANK_MODEL,
      topK: 20,
      rerankTopN: 6,
      description: 'Structured entities — accounts, contacts, buildings, people, external system records',
    },
    'mw-mind': {
      namespace: '',
      namespaces: [
        namespaces.localDocs,
        namespaces.oneDrive,
        namespaces.legacy,
        namespaces.contacts,
        namespaces.facts,
        namespaces.chunks,
        namespaces.summaries,
      ],
      searchMode: 'vector',
      rerank: false,
      rerankModel: '',
      topK: 20,
      rerankTopN: 6,
      embedUrl: defaultEmbedUrl,
      description:
        "Standalone memory index with local docs, OneDrive files, WhatsApp messages, facts, summaries, chunks, and contacts.",
    },
  };
}

function mergeKnowledgeProfile(
  base: KnowledgeProfileConfig,
  override: Record<string, unknown> | undefined,
): KnowledgeProfileConfig {
  if (!override) return base;
  const minScore = override['minScore'];
  return {
    namespace: stringProp(override, 'namespace') ?? base.namespace,
    namespaces: stringArrayProp(override, 'namespaces').length > 0
      ? stringArrayProp(override, 'namespaces')
      : base.namespaces,
    searchMode: knowledgeSearchMode(override.searchMode, base.searchMode),
    rerank: booleanProp(override, 'rerank', base.rerank),
    rerankModel: stringProp(override, 'rerankModel') ?? base.rerankModel,
    topK: numberProp(override, 'topK', base.topK),
    rerankTopN: numberProp(override, 'rerankTopN', base.rerankTopN),
    minScore: typeof minScore === 'number' && Number.isFinite(minScore)
      ? minScore
      : base.minScore,
    description: stringProp(override, 'description') ?? base.description,
    embedUrl: stringProp(override, 'embedUrl') ?? base.embedUrl,
  };
}

function mergeKnowledgeProfiles(
  namespaces: PineconeNamespaceConfig,
  defaultEmbedUrl: string,
  source: Record<string, unknown> | undefined,
): Record<string, KnowledgeProfileConfig> {
  const profiles = defaultKnowledgeProfiles(namespaces, defaultEmbedUrl);
  for (const [indexName, value] of Object.entries(source ?? {})) {
    const override = asRecord(value);
    if (!override) continue;
    const base = profiles[indexName] ?? {
      namespace: '',
      namespaces: [],
      searchMode: 'entity' as KnowledgeSearchMode,
      rerank: false,
      rerankModel: DEFAULT_PINECONE_RERANK_MODEL,
      topK: 20,
      rerankTopN: 6,
      description: indexName,
    };
    profiles[indexName] = mergeKnowledgeProfile(base, override);
  }
  return profiles;
}

// ---------------------------------------------------------------------------
// resolveTwilioSmsConfig — resolve and apply defaults to a raw twilioConfig block.
// Returns undefined when the source is absent or missing the required 'account'
// field. Mirrors the resolveMemoryConfig pattern: record/stringProp/numberProp
// helpers + default merging. Does NOT resolve keyring secrets or instantiate
// any SDK; config data only.
export function resolveImessageConfig(
  rawSource: Record<string, unknown> | null | undefined,
): ImessageConfig | undefined {
  const src = asRecord(rawSource ?? undefined);
  if (!src) return undefined;

  // Required discriminator: abort if 'account' is absent (not an imessageConfig block)
  const account = stringProp(src, 'account');
  if (!account) return undefined;

  const rawBackend = src['backend'];
  const backend = rawBackend === 'imsg' || rawBackend === 'bluebubbles'
    ? rawBackend
    : DEFAULT_IMESSAGE.backend;

  const sender = stringProp(src, 'sender') ?? '';
  const rawMode = src['inboundMode'];
  const inboundMode: ImessageInboundMode =
    rawMode === 'poll' || rawMode === 'webhook'
      ? rawMode
      : DEFAULT_IMESSAGE.inboundMode;
  const pollIntervalMs = numberProp(src, 'pollIntervalMs', DEFAULT_IMESSAGE.pollIntervalMs);

  const rateLimitSrc = asRecord(src['rateLimit']);
  const messagesPerMinute = numberProp(
    rateLimitSrc,
    'messagesPerMinute',
    DEFAULT_IMESSAGE.rateLimit.messagesPerMinute,
  );

  const imsgSocketPath = stringProp(src, 'imsgSocketPath') ?? DEFAULT_IMESSAGE.imsgSocketPath;
  const bluebubblesUrl = stringProp(src, 'bluebubblesUrl');
  const bluebubblesPasswordService = stringProp(src, 'bluebubblesPasswordService');

  return {
    account,
    backend,
    sender,
    inboundMode,
    pollIntervalMs,
    rateLimit: { messagesPerMinute },
    imsgSocketPath,
    ...(bluebubblesUrl !== undefined ? { bluebubblesUrl } : {}),
    ...(bluebubblesPasswordService !== undefined ? { bluebubblesPasswordService } : {}),
  };
}

// ---------------------------------------------------------------------------
export function resolveTwilioSmsConfig(
  rawSource: Record<string, unknown> | null | undefined,
): TwilioSmsConfig | undefined {
  const src = asRecord(rawSource ?? undefined);
  if (!src) return undefined;

  // Required discriminator: abort if 'account' is absent (not a twilioConfig block)
  const account = stringProp(src, 'account');
  if (!account) return undefined;

  const accountSid = stringProp(src, 'accountSid') ?? '';
  const authTokenService = stringProp(src, 'authTokenService') ?? '';
  const phoneNumber = stringProp(src, 'phoneNumber');
  const messagingServiceSid = stringProp(src, 'messagingServiceSid');

  // inboundMode: validated string, default to DEFAULT_TWILIO_SMS.inboundMode
  const rawMode = src['inboundMode'];
  const inboundMode: TwilioInboundMode =
    rawMode === 'poll' || rawMode === 'webhook'
      ? rawMode
      : DEFAULT_TWILIO_SMS.inboundMode;

  const pollIntervalMs = numberProp(src, 'pollIntervalMs', DEFAULT_TWILIO_SMS.pollIntervalMs);

  // rateLimit: nested object with smsPerMinute
  const rateLimitSrc = asRecord(src['rateLimit']);
  const smsPerMinute = numberProp(rateLimitSrc, 'smsPerMinute', DEFAULT_TWILIO_SMS.rateLimit.smsPerMinute);

  // webhook block: pass through when present, normalize trailing slash in publicBaseUrl
  const webhookSrc = asRecord(src['webhook']);
  let webhookConfig: TwilioWebhookConfig | undefined;
  if (webhookSrc !== undefined) {
    const rawBaseUrl = stringProp(webhookSrc, 'publicBaseUrl') ?? '';
    const publicBaseUrl = rawBaseUrl.endsWith('/') ? rawBaseUrl.slice(0, -1) : rawBaseUrl;
    const listenPort = numberProp(webhookSrc, 'listenPort', 0);
    const listenAddress = stringProp(webhookSrc, 'listenAddress');
    webhookConfig = {
      publicBaseUrl,
      listenPort,
      ...(listenAddress !== undefined ? { listenAddress } : {}),
    };
  }

  // voice block: merge with DEFAULT_TWILIO_VOICE defaults
  const voiceSrc = asRecord(src['voice']);
  let voiceConfig: TwilioVoiceConfig | undefined;
  if (voiceSrc !== undefined) {
    const enabled =
      typeof voiceSrc['enabled'] === 'boolean'
        ? (voiceSrc['enabled'] as boolean)
        : DEFAULT_TWILIO_VOICE.enabled;
    const voicemailMaxLengthSec = numberProp(
      voiceSrc,
      'voicemailMaxLengthSec',
      DEFAULT_TWILIO_VOICE.voicemailMaxLengthSec,
    );
    const voicemailGreeting = stringProp(voiceSrc, 'voicemailGreeting');
    voiceConfig = {
      enabled,
      voicemailMaxLengthSec,
      ...(voicemailGreeting !== undefined ? { voicemailGreeting } : {}),
    };
  }

  // Build result without optional fields, then spread them in only if defined.
  // This preserves the XOR invariant: absent fields remain undefined (not present),
  // matching the type signature readonly phoneNumber?: string.
  return {
    account,
    accountSid,
    authTokenService,
    inboundMode,
    pollIntervalMs,
    rateLimit: { smsPerMinute },
    ...(phoneNumber !== undefined ? { phoneNumber } : {}),
    ...(messagingServiceSid !== undefined ? { messagingServiceSid } : {}),
    ...(webhookConfig !== undefined ? { webhook: webhookConfig } : {}),
    ...(voiceConfig !== undefined ? { voice: voiceConfig } : {}),
  };
}

export function resolveSignalConfig(
  rawSource: Record<string, unknown> | null | undefined,
): SignalConfig | undefined {
  const src = asRecord(rawSource ?? undefined);
  if (!src) return undefined;

  const account = stringProp(src, 'account');
  if (!account) return undefined;

  const rawMode = src['inboundMode'];
  if (rawMode !== undefined && rawMode !== 'poll') {
    throw new ConfigValidationError(
      `Invalid signalConfig.inboundMode ${JSON.stringify(rawMode)} — streaming is not implemented; use "poll"`,
    );
  }
  const inboundMode: SignalInboundMode = 'poll';
  const phoneNumber = stringProp(src, 'phoneNumber') ?? '';
  const socketPath = stringProp(src, 'socketPath');
  const tcpPort = numberProp(src, 'tcpPort', 0) || undefined;
  const tcpHost = stringProp(src, 'tcpHost');
  const rateLimitSrc = asRecord(src['rateLimit']);
  const pollIntervalMs = numberProp(src, 'pollIntervalMs', DEFAULT_SIGNAL.pollIntervalMs);
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0 || pollIntervalMs > 2_147_483_647) {
    throw new ConfigValidationError('Invalid signalConfig.pollIntervalMs — expected a positive 32-bit timer integer');
  }
  if (socketPath !== undefined && !isAbsolute(socketPath)) {
    throw new ConfigValidationError('Invalid signalConfig.socketPath — expected an absolute path');
  }
  if (socketPath !== undefined && tcpPort !== undefined) {
    throw new ConfigValidationError('Invalid signalConfig endpoint — select exactly one of socketPath or tcpPort');
  }
  if (tcpHost !== undefined && tcpPort === undefined) {
    throw new ConfigValidationError('Invalid signalConfig endpoint — tcpHost requires tcpPort');
  }
  if (socketPath === undefined && tcpPort === undefined) {
    throw new ConfigValidationError('Invalid signalConfig endpoint — select exactly one of socketPath or tcpPort');
  }
  if (
    tcpHost !== undefined &&
    tcpHost !== '127.0.0.1' &&
    tcpHost !== '::1' &&
    tcpHost !== 'localhost'
  ) {
    throw new ConfigValidationError('Invalid signalConfig endpoint — plaintext TCP must use a loopback host');
  }

  return {
    account,
    phoneNumber,
    inboundMode,
    pollIntervalMs,
    rateLimit: {
      messagesPerMinute: numberProp(
        rateLimitSrc,
        'messagesPerMinute',
        DEFAULT_SIGNAL.rateLimit.messagesPerMinute,
      ),
    },
    ...(socketPath !== undefined ? { socketPath } : {}),
    ...(tcpPort !== undefined ? { tcpPort } : {}),
    ...(tcpHost !== undefined ? { tcpHost } : {}),
  };
}

export function resolveMemoryConfig(rawSource: Record<string, unknown> | null | undefined): MemoryConfig {
  const migrated = migrateLegacyMemoryConfig(rawSource ?? {}, { removeLegacy: false }).config;
  const memoryRoot = asRecord(migrated.memory);
  const sweep = asRecord(memoryRoot?.sweep);
  const watchTtl = asRecord(memoryRoot?.watch_ttl);
  const fileWatch = asRecord(memoryRoot?.file_watch);
  const conversation = asRecord(memoryRoot?.conversation);
  const retention = asRecord(memoryRoot?.retention);
  const consolidation = asRecord(memoryRoot?.consolidation);
  const invalidConsolidationSchedule =
    hasInvalidBoundedIntProp(consolidation, 'intervalHours', 1, 168) ||
    hasInvalidBoundedIntProp(consolidation, 'lookbackDays', 1, 90);
  const enrichment = asRecord(memoryRoot?.enrichment);
  const pinecone = asRecord(memoryRoot?.pinecone);
  const index = stringProp(pinecone, 'index') ?? process.env.PINECONE_INDEX ?? DEFAULT_PINECONE_INDEX;
  const namespaces = resolvePineconeNamespaces(asRecord(pinecone?.namespaces));
  const pineconeEmbedUrl = stringProp(pinecone, 'embedUrl');
  const embedUrl =
    pineconeEmbedUrl ??
    process.env.KNOWLEDGE_EMBED_URL ??
    process.env.MW_MIND_EMBED_URL ??
    DEFAULT_KNOWLEDGE_EMBED_URL;
  if (process.env.MW_MIND_EMBED_URL && !pineconeEmbedUrl && !process.env.KNOWLEDGE_EMBED_URL) {
    warnConfigDeprecation(
      {
        alias: 'MW_MIND_EMBED_URL',
        canonical: 'memory.pinecone.embedUrl or KNOWLEDGE_EMBED_URL',
        expires: '2026-10-26',
      },
      'memory.pinecone.embedUrl is using a deprecated environment alias',
    );
  }
  const defaultMode: PineconeSearchMode = index === DEFAULT_PINECONE_INDEX ? 'memory' : 'entity';
  const knowledgeSearch = asRecord(pinecone?.knowledgeSearch);
  const allowedIndexes = stringArrayProp(pinecone, 'allowedIndexes');
  const rawKnowledgeProfiles = asRecord(pinecone?.knowledgeProfiles);
  const declaredProfiles = new Set(Object.keys(rawKnowledgeProfiles ?? {}));
  for (const profileName of allowedIndexes) {
    if (BUILTIN_KNOWLEDGE_PROFILE_NAMES.has(profileName) && !declaredProfiles.has(profileName)) {
      warnConfigDeprecation(
        {
          profile: profileName,
          allowedIndexes,
          declaredProfiles: [...declaredProfiles],
          expires: '2026-10-26',
        },
        'memory.pinecone.allowedIndexes references a built-in profile that is not declared in knowledgeProfiles',
      );
    }
  }

  return {
    adminJid: stringProp(memoryRoot, 'admin_jid') ?? resolvedAdminPhones[0] ?? '',
    vaultPath: expandTilde(
      stringProp(memoryRoot, 'vaultPath') ?? `${process.env.HOME ?? homedir()}/Documents/Obsidian/whatsoup-memory`,
    ),
    observationConfidenceMin: numberProp(memoryRoot, 'observation_confidence_min', 0.40),
    sweep: {
      beadProposeMin: numberProp(sweep, 'bead_propose_min', 0.55),
      beadUpdateMin: numberProp(sweep, 'bead_update_min', 0.80),
      lookbackHours: numberProp(sweep, 'lookback_hours', 48),
      reviewByDays: numberProp(sweep, 'review_by_days', 7),
      // #1773 rem-3: backlog-growth alert threshold. The trigger poller emits
      // a single alert (state-transition guarded — see
      // TriggerPoller.overdueProposalAlertEmitted) once the count of
      // status='proposed' beads past review_by_at exceeds this many rows.
      overdueProposalAlertThreshold: numberProp(sweep, 'overdue_proposal_alert_threshold', 10),
    },
    watchTtl: {
      defaultHours: numberProp(watchTtl, 'default_hours', 24),
      maxHours: numberProp(watchTtl, 'max_hours', 72),
    },
    fileWatch: {
      // Deny-all by default (empty allowlist). Tilde-expanded so operators can
      // configure roots like "~/watched". The poll.file executor additionally
      // realpaths + re-checks each target at exec time (symlink-escape defense).
      allowedRoots: stringArrayProp(fileWatch, 'allowed_roots').map(expandTilde),
    },
    conversation: {
      recent: numberProp(conversation, 'recent', 50),
      extended: numberProp(conversation, 'extended', 100),
      extendedWithinMs: numberProp(conversation, 'extendedWithinMs', 10 * MS_PER_MINUTE),
    },
    retention: {
      days: numberProp(retention, 'days', 30),
    },
    consolidation: {
      enabled: booleanProp(consolidation, 'enabled', false) && !invalidConsolidationSchedule,
      intervalHours: boundedIntProp(consolidation, 'intervalHours', 24, 1, 168),
      lookbackDays: boundedIntProp(consolidation, 'lookbackDays', 14, 1, 90),
      dryRun: booleanProp(consolidation, 'dryRun', true),
    },
    enrichment: {
      intervalMs: numberProp(enrichment, 'intervalMs', MS_PER_MINUTE),
      batchSize: numberProp(enrichment, 'batchSize', 200),
      minConfidence: numberProp(enrichment, 'minConfidence', 0.7),
      dedupThreshold: numberProp(enrichment, 'dedupThreshold', 0.95),
      maxRetries: numberProp(enrichment, 'maxRetries', 3),
    },
    pinecone: {
      apiKeyEnv: stringProp(pinecone, 'apiKeyEnv') ?? DEFAULT_PINECONE_API_KEY_ENV,
      projectId: stringProp(pinecone, 'projectId') ?? process.env.PINECONE_PROJECT_ID,
      expectedHostSuffix: stringProp(pinecone, 'expectedHostSuffix') ?? process.env.PINECONE_EXPECTED_HOST_SUFFIX,
      index,
      namespaces,
      contextTopK: numberProp(pinecone, 'contextTopK', 10),
      senderTopK: numberProp(pinecone, 'senderTopK', 5),
      selfFactTopK: numberProp(pinecone, 'selfFactTopK', 5),
      searchMode: pineconeSearchMode(pinecone?.searchMode, defaultMode),
      rerank: booleanProp(pinecone, 'rerank', false),
      rerankModel: stringProp(pinecone, 'rerankModel') ?? DEFAULT_PINECONE_RERANK_MODEL,
      topK: numberProp(pinecone, 'topK', 20),
      rerankTopN: numberProp(pinecone, 'rerankTopN', 6),
      allowedIndexes,
      embedUrl,
      knowledgeSearch: {
        enabled: booleanProp(knowledgeSearch, 'enabled', true),
        allowGlobalAgentSessions: booleanProp(knowledgeSearch, 'allowGlobalAgentSessions', false),
      },
      knowledgeProfiles: mergeKnowledgeProfiles(namespaces, embedUrl, rawKnowledgeProfiles),
    },
  };
}

const resolvedMemory = resolveMemoryConfig(instance);

const resolvedTransport: TransportId = (() => {
  const raw = instance?.transport;
  if (typeof raw === 'string' && isTransportId(raw)) return raw;
  return DEFAULT_TRANSPORT_ID;
})();

// Only resolved when the twilio transport is selected — validation rejects a
// twilioConfig on other transports, and this gate keeps the invariant
// self-documenting at the resolution site too.
const resolvedTwilioConfig: TwilioSmsConfig | undefined =
  resolvedTransport === 'twilio' && asRecord(instance?.twilioConfig) != null
    ? resolveTwilioSmsConfig(instance?.twilioConfig as Record<string, unknown>)
    : undefined;

// Same gating for the imessage transport: validation rejects imessageConfig
// on other transports; the resolver only runs when transport === 'imessage'.
const resolvedImessageConfig: ImessageConfig | undefined =
  resolvedTransport === 'imessage' && asRecord(instance?.imessageConfig) != null
    ? resolveImessageConfig(instance?.imessageConfig as Record<string, unknown>)
    : undefined;

const resolvedSignalConfig: SignalConfig | undefined =
  resolvedTransport === 'signal' && asRecord(instance?.signalConfig) != null
    ? resolveSignalConfig(instance?.signalConfig as Record<string, unknown>)
    : undefined;

const resolvedAgentOptions = configSection(instance?.agentOptions, 'agentOptions') ?? {};
const resolvedFallbacks = normalizeFallbackEntriesFromAgentOptions(resolvedAgentOptions);
const resolvedChatOptions = configSection(instance?.chatOptions, 'chatOptions') ?? {};
const resolvedTranscriptionOptions = configSection(instance?.transcriptionOptions, 'transcriptionOptions') ?? {};

// Nested config sections, validated once here: a SET-but-non-object section
// fails loud instead of every field inside it silently reading undefined.
const outboundGovernorSection = configSection(instance?.outboundGovernor, 'outboundGovernor');
const restartLoopGuardSection = configSection(instance?.restartLoopGuard, 'restartLoopGuard');
const operationTrackerSection = configSection(instance?.operationTracker, 'operationTracker');
const pollResolutionSection = configSection(instance?.pollResolution, 'pollResolution');
const echoGuardSection = configSection(instance?.echoGuard, 'echoGuard');
const elevenlabsSection = configSection(instance?.elevenlabs, 'elevenlabs');
const mediaRetentionSection = configSection(instance?.mediaRetention, 'mediaRetention');
const ingestSection = configSection(instance?.ingest, 'ingest');
const advancedSection = configSection(instance?.advanced, 'advanced');
const instancePathsSection = instance ? configSection(instance.paths, 'paths') : undefined;

// Load-time model-role validation: a malformed symbolic model value is a permanent
// config typo. validateModelRoleValue throws a bare Error; convert it to a
// ConfigValidationError so a model typo exits EX_CONFIG(78) (stops the restart-flap)
// rather than exit 1. (validateInstanceConfig does NOT validate the model value
// format, only a top-level/models.conversation consistency rule, so this is the sole
// gate for symbolic-model typos on the startup path.)
function configModelRole(value: string, role: string): string {
  try {
    return validateModelRoleValue(value, role);
  } catch (err) {
    throw new ConfigValidationError(errorMessage(err));
  }
}

// Load-time capability-obligation validation mirrors configModelRole: a
// malformed `enabled: true` body is a permanent config defect and must exit
// EX_CONFIG(78) (stops the restart-flap), never a bare throw with exit 1.
function configCapabilityObligations() {
  try {
    return parseCapabilityObligationsOptions(resolvedAgentOptions['capabilityObligations']);
  } catch (err) {
    throw new ConfigValidationError(
      `agentOptions.capabilityObligations is enabled but malformed: ${errorMessage(err)}`,
    );
  }
}

export const config = {
  // Capability-obligation replay (all-or-inert; default OFF). `enabled: true`
  // with a malformed body fails startup as EX_CONFIG — never a partial activation.
  capabilityObligations: configCapabilityObligations(),

  // NL-first routing aliases + per-sender preference store (owner-approved
  // PR-plan v2). Default false: flag off keeps behavior byte-identical —
  // /model,/why,/reset stay forwarded and no preference table is created.
  nlRouting: resolvedAgentOptions['nlRouting'] === true,
  // Intent→provider tier map for NL routing ('strongest'/'fastest'). Unset
  // tiers resolve to the default route honestly — never a hidden opinion.
  nlRoutingTiers: (resolvedAgentOptions['nlRoutingTiers'] ?? null) as { strongest?: string; fastest?: string } | null,
  // Sink dir for the fail-closed route-event sidecar; default (null) resolves
  // to the per-instance config dir at emit time. Tests point this at a tmpdir.
  nlRoutingEventsDir: optionalString(resolvedAgentOptions['nlRoutingEventsDir'], 'agentOptions.nlRoutingEventsDir') ?? null,

  // Identity
  botName: optionalString(instance?.name, 'name') ?? 'Loops',
  // Defense in depth: validateInstanceConfig already rejects an invalid type
  // on the load path, so this throw is unreachable for validated configs.
  instanceType: optionalEnum(instance?.type, 'type', ['passive', 'chat', 'agent'] as const) ?? 'chat',

  // Paths
  configRoot,
  dataRoot,
  stateRoot,
  authDir: instancePathsSection ? requireAbsolutePathString(instancePathsSection.authDir, 'paths.authDir') : join(configRoot, 'auth_info'),
  dbPath: instancePathsSection ? requireAbsolutePathString(instancePathsSection.dbPath, 'paths.dbPath') : join(dataRoot, 'bot.db'),
  logDir,
  lockPath: instancePathsSection ? requireAbsolutePathString(instancePathsSection.lockPath, 'paths.lockPath') : join(stateRoot, 'bot.lock'),

  // Models — deep merge: instance > env var > default. Each value is either a
  // literal model ID (pinned, exact passthrough — the default) or a symbolic
  // `<vendor>[:<family>]:latest[-stable]` form resolved at point of use
  // (src/lib/model-resolver.ts). Validation throws at load on malformed
  // symbolic values so typos never reach a provider as bogus literal IDs.
  models: {
    conversation: configModelRole(optionalString(instanceModels?.conversation, 'models.conversation') ?? process.env.CONVERSATION_MODEL ?? 'claude-opus-4-8', 'conversation'),
    extraction: configModelRole(optionalString(instanceModels?.extraction, 'models.extraction') ?? process.env.EXTRACTION_MODEL ?? 'claude-sonnet-4-6', 'extraction'),
    validation: configModelRole(optionalString(instanceModels?.validation, 'models.validation') ?? process.env.VALIDATION_MODEL ?? 'claude-haiku-4-5', 'validation'),
    fallback: configModelRole(optionalString(instanceModels?.fallback, 'models.fallback') ?? process.env.FALLBACK_MODEL ?? 'gpt-5.4', 'fallback'),
  },

  // Conversation
  maxTokens: optionalFiniteNumber(instance?.maxTokens, 'maxTokens') ?? intEnv('MAX_TOKENS', 750),
  memory: resolvedMemory,
  conversationWindow: resolvedMemory.conversation.recent,
  conversationWindowExtended: resolvedMemory.conversation.extended,
  windowExtensionThresholdMs: resolvedMemory.conversation.extendedWithinMs,

  // Rate limiting
  rateLimitPerHour: optionalFiniteNumber(instance?.rateLimitPerHour, 'rateLimitPerHour') ?? intEnv('RATE_LIMIT_PER_HOUR', 45),
  rateLimitWindowMs: resolvedRateLimitWindowMs, // measurement window for counting responses (SP6)
  rateLimitNoticeWindowMs: instance?.rateLimitNoticeWindowMs != null
    ? requireFiniteNumber(instance.rateLimitNoticeWindowMs, 'rateLimitNoticeWindowMs')
    : DEFAULT_RATE_WINDOW_MS, // dedup window for rate-limit notices

  // Outbound socket governor (PR-F) — bounds the send RATE to any conversation
  // across EVERY send path (runtime, MCP send tools, raw-socket tools) at the
  // Baileys socket seam. Pace-not-drop by default: a legit multi-part answer is
  // smoothed to a safe cadence and delivered in full. A send is SHED only past
  // the per-conversation catastrophe ceiling or when a paced send would wait
  // past maxWaitMs (kept < the queue's 15s SEND_TIMEOUT so pacing never turns
  // into a timeout→retry→drop). Defaults are conservative — pure passthrough
  // under normal load (a few messages per answer never wait) — and every field
  // is per-instance overridable. windowMs is kept <= maxWaitMs so a full-window
  // pacing wait for a single reservation never itself trips the shed.
  outboundGovernor: {
    enabled: optionalBoolean(outboundGovernorSection?.enabled, 'outboundGovernor.enabled') ?? true,
    windowMs: optionalFiniteNumber(outboundGovernorSection?.windowMs, 'outboundGovernor.windowMs') ?? 3 * MS_PER_SECOND,
    maxPerWindow: optionalFiniteNumber(outboundGovernorSection?.maxPerWindow, 'outboundGovernor.maxPerWindow') ?? 6,
    maxWaitMs: optionalFiniteNumber(outboundGovernorSection?.maxWaitMs, 'outboundGovernor.maxWaitMs') ?? 5 * MS_PER_SECOND,
    hardCeiling: optionalFiniteNumber(outboundGovernorSection?.hardCeiling, 'outboundGovernor.hardCeiling') ?? 120,
    hardCeilingWindowMs: optionalFiniteNumber(outboundGovernorSection?.hardCeilingWindowMs, 'outboundGovernor.hardCeilingWindowMs') ?? MS_PER_HOUR,
    globalMaxPerWindow: optionalFiniteNumber(outboundGovernorSection?.globalMaxPerWindow, 'outboundGovernor.globalMaxPerWindow') ?? 40,
    globalWindowMs: optionalFiniteNumber(outboundGovernorSection?.globalWindowMs, 'outboundGovernor.globalWindowMs') ?? 3 * MS_PER_SECOND,
  },

  // Enrichment
  enrichmentIntervalMs: resolvedMemory.enrichment.intervalMs,
  enrichmentBatchSize: resolvedMemory.enrichment.batchSize,
  enrichmentMinConfidence: resolvedMemory.enrichment.minConfidence,
  enrichmentDedupThreshold: resolvedMemory.enrichment.dedupThreshold,

  // Pinecone
  pineconeIndex: resolvedMemory.pinecone.index,
  pineconeContextTopK: resolvedMemory.pinecone.contextTopK,
  pineconeSenderTopK: resolvedMemory.pinecone.senderTopK,
  pineconeSelfFactTopK: resolvedMemory.pinecone.selfFactTopK,
  pineconeSearchMode: resolvedMemory.pinecone.searchMode,
  pineconeRerank: resolvedMemory.pinecone.rerank,
  pineconeTopK: resolvedMemory.pinecone.topK,
  pineconeRerankTopN: resolvedMemory.pinecone.rerankTopN,
  pineconeAllowedIndexes: resolvedMemory.pinecone.allowedIndexes,

  // Recency decay — Ebbinghaus-style exponential forgetting for memory search
  recencyHalfLifeDays: positiveIntValue(instance?.recencyHalfLifeDays, positiveIntEnv('RECENCY_HALF_LIFE_DAYS', 14)),
  maxAgeDays: positiveIntValue(instance?.maxAgeDays, positiveIntEnv('MAX_AGE_DAYS', 90)),

  // Tool update verbosity: 'full' (default — all updates shown to user),
  // 'friendly' (all updates in plain language for non-technical users),
  // 'minimal' (suppress most updates — only critical status shown)
  toolUpdateMode: optionalEnum(instance?.toolUpdateMode, 'toolUpdateMode', ['full', 'friendly', 'minimal'] as const) ?? 'full',
  toolUpdateRedirectJid: stringProp(instance ?? undefined, 'toolUpdateRedirectJid') ?? null,
  // Gate the agent restart/back-online notification. Default true preserves existing behavior.
  startupNotifications: booleanProp(instance ?? undefined, 'startupNotifications', true),
  // How long the instance must stay up AND connected before the back-online
  // notice sends. Boots inside the window aggregate into ONE summary message
  // (see src/core/startup-notify.ts) so flap or maintenance can never ping
  // the user once per recovery. 0 restores the legacy immediate send; an
  // invalid or out-of-range value falls back to 600 rather than silently
  // disabling the debounce.
  startupNotificationStabilitySeconds: boundedIntProp(instance ?? undefined, 'startupNotificationStabilitySeconds', 600, 0, 86_400),
  // Gate proactive per_chat session resume on startup. Default true preserves existing behavior.
  proactiveResumeOnStartup: booleanProp(instance ?? undefined, 'proactiveResumeOnStartup', true),
  // C5 restart-loop guard: suppress proactive resume after repeated crashy
  // boots (resume-replay circuit breaker; see
  // src/runtimes/agent/restart-loop-guard.ts). Defaults trip on the 3rd
  // crashy boot inside 300s — strictly before systemd's 10-per-300s wedge —
  // so the instance self-heals instead of going dark. windowMs is clamped to
  // >= 1s inside the guard; maxRestarts <= 0 disables tripping.
  restartLoopGuard: {
    enabled: optionalBoolean(restartLoopGuardSection?.enabled, 'restartLoopGuard.enabled') ?? true,
    maxRestarts: positiveIntValue(restartLoopGuardSection?.maxRestarts, 3),
    windowMs: positiveIntValue(restartLoopGuardSection?.windowMs, 5 * MS_PER_MINUTE),
  },
  textAggregateDelayMs: positiveIntValue(instance?.textAggregateDelayMs, 2 * MS_PER_SECOND),

  // Operation tracker: per-tool progress reporting & stall detection
  operationTracker: {
    enabled: optionalBoolean(operationTrackerSection?.enabled, 'operationTracker.enabled') ?? true,
    progressIntervalMs: optionalFiniteNumber(operationTrackerSection?.progressIntervalMs, 'operationTracker.progressIntervalMs') ?? 30 * MS_PER_SECOND,
    thinkingLongMs: optionalFiniteNumber(operationTrackerSection?.thinkingLongMs, 'operationTracker.thinkingLongMs') ?? 45 * MS_PER_SECOND,
    thinkingStallMs: optionalFiniteNumber(operationTrackerSection?.thinkingStallMs, 'operationTracker.thinkingStallMs') ?? 5 * MS_PER_MINUTE,
    progressPlaceholderRateLimitMs:
      optionalFiniteNumber(operationTrackerSection?.progressPlaceholderRateLimitMs, 'operationTracker.progressPlaceholderRateLimitMs') ?? 3 * MS_PER_MINUTE,
    // PR-E status-narration cap default; literal mirrors MAX_STATUS_MESSAGES_PER_TURN
    // in outbound-queue.ts (kept literal here to avoid a config↔queue import cycle).
    maxStatusMessagesPerTurn:
      optionalFiniteNumber(operationTrackerSection?.maxStatusMessagesPerTurn, 'operationTracker.maxStatusMessagesPerTurn') ?? 10,
    maxStatusMessagesPerWindow:
      positiveIntValue(operationTrackerSection?.maxStatusMessagesPerWindow, 10),
    statusMessageWindowMs:
      positiveIntValue(operationTrackerSection?.statusMessageWindowMs, 5 * MS_PER_MINUTE),
    toolThresholds: mergeToolThresholds(operationTrackerSection?.toolThresholds),
  } satisfies OperationTrackerConfig,

  // Poll resolution: configurable group poll behavior
  pollResolution: {
    defaultStrategy: optionalString(pollResolutionSection?.defaultStrategy, 'pollResolution.defaultStrategy') ?? 'first-vote-wins',
    defaultTimeoutMs: optionalFiniteNumber(pollResolutionSection?.defaultTimeoutMs, 'pollResolution.defaultTimeoutMs') ?? MS_PER_HOUR,
  },

  // Health
  healthPort: optionalFiniteNumber(instance?.healthPort, 'healthPort') ?? portEnv('HEALTH_PORT', DEFAULT_INSTANCE_HEALTH_PORT),
  // R7a bind address, instance-config -> env -> loopback default (#2192). The
  // non-loopback guard at startHealthServer still fail-fasts without opt-in.
  healthBindAddress: optionalString(instance?.healthBindAddress, 'healthBindAddress')
    ?? process.env.HEALTH_BIND_ADDRESS ?? '127.0.0.1',
  // Fleet server bind, same chain; guard at fleet start() unchanged (#2192).
  fleetBindAddress: optionalString(instance?.fleetBindAddress, 'fleetBindAddress')
    ?? process.env.FLEET_BIND_ADDRESS ?? DEFAULT_BIND_ADDRESS,
  // Allowed root for schedule files served by the health surface; undefined
  // keeps today's unset behavior (#2192).
  scheduleRoot: optionalString(instance?.scheduleRoot, 'scheduleRoot')
    ?? process.env.WHATSOUP_SCHEDULE_ROOT,
  // Auth-bond auto-restore, inverted env semantics preserved: ON unless the
  // env var is exactly '0' (#2192 slice 2b).
  authBondAutoRestore: optionalBoolean(instance?.authBondAutoRestore, 'authBondAutoRestore')
    ?? process.env.WHATSOUP_AUTH_BOND_AUTO_RESTORE !== '0',
  // Opaque account-scope identity for the fenced coordination lease. Absent
  // keeps the lease machinery inert (legacy instances); a present but
  // malformed value throws HERE at config load rather than silently
  // disabling coordination.
  accountScopeId: resolveConfiguredAccountScope(
    optionalString(instance?.accountScopeId, 'accountScopeId')
      ?? process.env.WHATSOUP_ACCOUNT_SCOPE_ID,
  ),
  // Baileys protocol version pin, string passthrough (#2192 s4a). Parsing and
  // validation stay call-time in parsePinnedBaileysVersion so a malformed
  // value throws at connect (today's timing), not at config load.
  baileysVersionPinned: optionalString(instance?.baileysVersionPinned, 'baileysVersionPinned')
    ?? process.env.WHATSOUP_BAILEYS_VERSION,
  // In-process EgressProxy fail-open. The identically named env var ALSO
  // drives the out-of-band shell hook (deploy/hooks/agent-sandbox.sh) in
  // manual deployments — this field owns only the in-process channel (#2192).
  sandboxFailOpen: optionalBoolean(instance?.sandboxFailOpen, 'sandboxFailOpen')
    ?? process.env.WHATSOUP_SANDBOX_FAIL_OPEN === '1',
  // One-message handoff notice flag (#2192 slice 2b).
  oneMessageHandoff: optionalBoolean(instance?.oneMessageHandoff, 'oneMessageHandoff')
    ?? process.env.WHATSOUP_ONE_MESSAGE_HANDOFF === '1',

  // Bot-errors alert routing (#2192 slice 3a). Resolved AND published back to
  // process.env in the pre-literal block above (search: "Bot-errors alert
  // routing") so these typed fields and the env-reading lib/core sites cannot
  // disagree. Validation (group-JID shape, expected-JID pin) stays in
  // emit-alert.ts where the fail-closed warn-once semantics live.
  botErrorsJid,
  botErrorsExpectedJid,
  botErrorsRequireExpected,
  // Master switch for the runtime's per-tool-failure operator alerts,
  // threaded to tool-failure-alert.ts via ToolFailureAlertDeps (param-DI from
  // this grandfathered importer; the module itself reads no env). Inverted
  // env semantics preserved: ON unless the env var is exactly '0'.
  toolFailureAlertsEnabled: optionalBoolean(instance?.toolFailureAlertsEnabled, 'toolFailureAlertsEnabled')
    ?? process.env.BOT_ERRORS_RUNTIME_TOOL_FAILURE_ALERTS !== '0',
  // Legacy-alert throttle window + safe-shape credential redaction flag
  // (#2192 slice 3b), resolved and published in the pre-literal block above.
  emitAlertThrottleMs,
  botErrorsSafeShapeCredPath,

  // GUI
  gui: optionalBoolean(instance?.gui, 'gui') ?? false,
  guiPort: optionalFiniteNumber(instance?.guiPort, 'guiPort') ?? portEnv('WHATSOUP_GUI_PORT', DEFAULT_FLEET_PORT),

  // API
  // P3.6 review D-2: env-var override for operator-actionable timeout
  // tuning. The mwlab runbook's "raise apiTimeoutMs" recovery step is
  // now actionable without a code edit via WHATSOUP_API_TIMEOUT_MS.
  // Invalid values (non-numeric) and non-positive values (0, negative)
  // fall back to the 30_000 default — intEnv() handles the non-numeric
  // case, the positive-only guard below handles 0 / negative.
  apiTimeoutMs: (() => {
    const n = intEnv('WHATSOUP_API_TIMEOUT_MS', 30 * MS_PER_SECOND);
    return n > 0 ? n : 30 * MS_PER_SECOND;
  })(),
  apiRetryDelayMs: 2 * MS_PER_SECOND,

  // Access control — rehydrate from instance (string[]) or use defaults
  adminPhones: new Set<string>(resolvedAdminPhones),

  // Exact authenticated DM peers used for internal operator coordination.
  // This is deliberately separate from adminPhones: audience classification
  // must not widen inbound access-control authority.
  internalPeerJids: new Set<string>(
    (Array.isArray(instance?.internalPeerJids) ? instance.internalPeerJids : [])
      .filter((jid: unknown): jid is string => isNonEmptyString(jid))
      .map((jid: string) => jid.trim()),
  ),

  // Control peers — phones trusted to send self-healing control messages.
  // stringRecordProp fails loud on non-string values (and trims), replacing
  // the former unchecked Record cast.
  controlPeers: new Map<string, string>(
    Object.entries(stringRecordProp(instance, 'controlPeers'))
  ),

  // Sibling bot phones — phone numbers of other WhatSoup instances that share
  // groups with this instance.  Messages from siblings are silently ignored in
  // groups to prevent infinite echo loops between co-located bots.
  siblingPhones: new Set<string>(
    (Array.isArray(instance?.siblingPhones) ? instance.siblingPhones : [])
      .filter((p: unknown): p is string => isNonEmptyString(p))
      .map((p: string) => normalizePhoneE164(p)),
  ),

  // Echo guard — per-group outbound cooldown to prevent cascade floods.
  // Session-aware: intra-session rapid sends are exempt, only cross-session
  // sends respect the cooldown. 1s default catches sub-second echo loops
  // without blocking crash recovery or /new session first responses.
  // In-memory, resets on restart. DMs are never affected.
  echoGuard: {
    enabled: optionalBoolean(echoGuardSection?.enabled, 'echoGuard.enabled') !== false,
    groupCooldownMs: optionalFiniteNumber(echoGuardSection?.groupCooldownMs, 'echoGuard.groupCooldownMs') ?? MS_PER_SECOND,
  },

  // Paused chats — messages are stored but never dispatched to runtime.
  // Toggle groups on/off without losing messages. Add JIDs like "120363555555555002@g.us".
  pausedChats: new Set<string>(
    (Array.isArray(instance?.pausedChats) ? instance.pausedChats : [])
      .filter((j: unknown): j is string => isNonEmptyString(j)),
  ),

  // Paused-chat dispatch bypass — case-insensitive regex sources matched
  // against inbound content in a paused chat. A match dispatches the message
  // as if the chat were not paused, so operator-directed traffic (e.g.
  // escalations) survives pausing a busy bot-noise group. Default [] keeps
  // paused-chat behavior unchanged. Invalid regex entries are rejected by the
  // instance-config validator and skipped defensively at runtime.
  pausedChatBypassPatterns: stringArrayProp(instance, 'pausedChatBypassPatterns'),

  // Media
  mediaDir,
  tmpDir: processTmpDir,

  // Per-instance seed data for chat_aliases.
  chatAliases: stringRecordProp(instance, 'chatAliases'),

  // Group JIDs the bot auto-responds to (no @mention required). Seeded into the
  // access_list as 'allowed' at startup — the durable, source-reproducible
  // equivalent of a hand-inserted access grant. See seedAutoRespondGroups.
  autoRespondGroups: stringArrayProp(instance, 'autoRespondGroups'),

  // Per-instance send decoration policies.
  profiles: profileRecordProp(instance, 'profiles'),

  // Token budget
  tokenBudget: optionalFiniteNumber(instance?.tokenBudget, 'tokenBudget') ?? 100_000,

  // Working-memory summarize-before-trim (#1445 QR-010). When the conversation
  // window would exceed tokenBudget, the oldest overflow turns are summarized
  // in one cheap LLM call and prepended as a synthetic turn instead of being
  // silently dropped. Default true. When false (or when the summarization call
  // fails), a deterministic "[N earlier turns omitted]" marker is used instead
  // — there is never silent, untraceable loss either way.
  workingMemorySummarization: optionalBoolean(instance?.workingMemorySummarization, 'workingMemorySummarization') ?? true,

  // Retention
  retentionDays: resolvedMemory.retention.days,

  // Enrichment retry
  enrichmentMaxRetries: resolvedMemory.enrichment.maxRetries,

  // Logging
  logLevel: process.env.LOG_LEVEL ?? 'info',

  // System prompt
  systemPrompt: optionalString(instance?.systemPrompt, 'systemPrompt') ?? DEFAULT_SYSTEM_PROMPT,

  // Link preview quality — when true, Baileys generates high-quality thumbnails
  generateHighQualityLinkPreview: optionalBoolean(instance?.generateHighQualityLinkPreview, 'generateHighQualityLinkPreview') ?? false,


  // Agent provider selection — read from agentOptions.provider / agentOptions.providerConfig
  // Defaults to 'claude-cli' for backward compatibility when not specified.
  agentProvider: optionalString(resolvedAgentOptions['provider'], 'agentOptions.provider') ?? 'claude-cli',
  agentProviderConfig: (resolvedAgentOptions['providerConfig'] as Record<string, unknown> | undefined) ?? undefined,
  agentProviderDataPolicy: isProviderDataPolicy(resolvedAgentOptions['providerDataPolicy'])
    ? resolvedAgentOptions['providerDataPolicy']
    : null,
  agentProviderBoundaryMode: isProviderBoundaryMode(resolvedAgentOptions['providerBoundaryMode'])
    ? resolvedAgentOptions['providerBoundaryMode']
    : 'shadow',

  // Chat OpenAI provider endpoint/key override — read from
  // chatOptions.openaiProviderConfig (QR-218 PR-2). Undefined (the default)
  // keeps createOpenAIProvider() on its bare, env-only construction.
  chatOpenAIProviderConfig:
    (resolvedChatOptions['openaiProviderConfig'] as Record<string, unknown> | undefined) ?? undefined,

  // OpenAI Whisper transcription endpoint/key override — read from
  // transcriptionOptions.openaiProviderConfig (QR-218 PR-B). Undefined keeps
  // openai-whisper.ts on the legacy bare SDK construction.
  transcriptionOpenAIProviderConfig:
    (resolvedTranscriptionOptions['openaiProviderConfig'] as Record<string, unknown> | undefined) ?? undefined,

  // Automatic provider fallback — read from agentOptions.fallbacks[] or the
  // legacy agentOptions.fallbackProvider / fallbackModel pair. When the primary
  // provider hits a usage limit, new sessions are routed to the selected
  // fallback until the limit resets. An empty chain disables fallback.
  agentFallbacks: resolvedFallbacks,
  agentFallbackProvider: resolvedFallbacks[0]?.provider,
  agentFallbackModel: resolvedFallbacks[0]?.model,
  agentFallbackDataPolicy: resolvedFallbacks[0]?.dataPolicy,

  // Discovery-mode fallback (R6) — read from agentOptions.fallbackDiscovery.
  // When present (mode:"auto"), the runtime DERIVES the chain per host from
  // the gateway's credential-aware model catalogue; config admission rejects
  // combining it with a non-empty fallbacks list. Null = static-list behavior.
  agentFallbackDiscovery: normalizeFallbackDiscoveryFromAgentOptions(resolvedAgentOptions),

  // Provider-fallback tunables (#2192 s4b) — instance-config
  // (agentOptions.fallbackTunables.*) first, env second, defaults and clamps
  // byte-identical to the retired runtime-tunables module-eval IIFEs. Those
  // were module-eval and this is config-load: restart-to-change in both
  // worlds, no live-flip regression. Consumed via RuntimeFallbackPort.
  fallbackTunables: ((): { noticeDedupMs: number; primaryRecheckMs: number; probeStallThreshold: number; probeStallCeilingMultiple: number } => {
    const section = configSection(resolvedAgentOptions['fallbackTunables'], 'agentOptions.fallbackTunables') ?? {};
    const resolveTunable = (
      instanceValue: number | undefined,
      envKey: string,
      fallback: number,
      clamp?: { min: number; max: number; trunc?: boolean },
    ): number => {
      const raw = instanceValue ?? Number(process.env[envKey]);
      if (!Number.isFinite(raw) || raw <= 0) return fallback;
      const value = clamp?.trunc ? Math.trunc(raw) : raw;
      return clamp ? Math.min(Math.max(value, clamp.min), clamp.max) : value;
    };
    return {
      noticeDedupMs: resolveTunable(
        optionalFiniteNumber(section['noticeDedupMs'], 'agentOptions.fallbackTunables.noticeDedupMs'),
        'WHATSOUP_PROVIDER_FALLBACK_NOTICE_DEDUP_MS',
        30 * MS_PER_MINUTE,
      ),
      primaryRecheckMs: resolveTunable(
        optionalFiniteNumber(section['primaryRecheckMs'], 'agentOptions.fallbackTunables.primaryRecheckMs'),
        'WHATSOUP_PROVIDER_FALLBACK_PRIMARY_RECHECK_MS',
        5 * MS_PER_MINUTE,
        { min: 30 * MS_PER_SECOND, max: 30 * MS_PER_MINUTE },
      ),
      probeStallThreshold: resolveTunable(
        optionalFiniteNumber(section['probeStallThreshold'], 'agentOptions.fallbackTunables.probeStallThreshold'),
        'WHATSOUP_PROVIDER_FALLBACK_PROBE_STALL_THRESHOLD',
        12,
        { min: 3, max: 100, trunc: true },
      ),
      probeStallCeilingMultiple: resolveTunable(
        optionalFiniteNumber(section['probeStallCeilingMultiple'], 'agentOptions.fallbackTunables.probeStallCeilingMultiple'),
        'WHATSOUP_PROVIDER_FALLBACK_PROBE_STALL_CEILING_MULTIPLE',
        10,
        { min: 1, max: 1000, trunc: true },
      ),
    };
  })(),

  // Voice (ElevenLabs TTS)
  elevenlabs: {
    defaultVoiceId: optionalString(elevenlabsSection?.defaultVoiceId, 'elevenlabs.defaultVoiceId') ?? 'pNInz6obpgDQGcFmaJgB',
    defaultModel: optionalString(elevenlabsSection?.defaultModel, 'elevenlabs.defaultModel') ?? 'eleven_multilingual_v2',
    stability: optionalFiniteNumber(elevenlabsSection?.stability, 'elevenlabs.stability') ?? 0.5,
    similarityBoost: optionalFiniteNumber(elevenlabsSection?.similarityBoost, 'elevenlabs.similarityBoost') ?? 0.75,
  },
  voiceReply: optionalEnum(instance?.voiceReply, 'voiceReply', ['always', 'when_received', 'never'] as const) ?? 'never',

  // Typing simulation (SP5)
  autoTyping: optionalEnum(instance?.autoTyping, 'autoTyping', ['composing', 'recording', 'off'] as const) ?? 'off',

  // Temporary capability grants (#1835): named groups of tool patterns that an
  // admin `/grant <group>` can temporarily unlock (auto-reverting on expiry).
  // Empty by default — configure per instance; each group is validated at
  // startup to not intersect the REQUIRED_DENY floor.
  capabilityGrantGroups: ((): Record<string, { capabilities: string[] }> => {
    const raw = instance?.capabilityGrantGroups;
    const out: Record<string, { capabilities: string[] }> = {};
    if (raw && typeof raw === 'object') {
      for (const [name, def] of Object.entries(raw as Record<string, unknown>)) {
        const caps = (def as { capabilities?: unknown } | null)?.capabilities;
        if (Array.isArray(caps) && caps.every((c) => typeof c === 'string')) {
          out[name] = { capabilities: caps as string[] };
        }
      }
    }
    return out;
  })(),

  // Media retention (SP7) — per-instance config with safe defaults
  mediaRetention: {
    tempHours:     optionalFiniteNumber(mediaRetentionSection?.tempHours, 'mediaRetention.tempHours') ?? 72,
    cacheHours:    optionalFiniteNumber(mediaRetentionSection?.cacheHours, 'mediaRetention.cacheHours') ?? 168, // 7 days
    intervalHours: optionalFiniteNumber(mediaRetentionSection?.intervalHours, 'mediaRetention.intervalHours') ?? 6,
  },

  // Ingest backpressure (SP1)
  ingest: {
    maxConcurrent: optionalFiniteNumber(ingestSection?.maxConcurrent, 'ingest.maxConcurrent') ?? 20,
    maxQueueDepth: optionalFiniteNumber(ingestSection?.maxQueueDepth, 'ingest.maxQueueDepth') ?? 500,
  },

  // Connection exhaustion (SP2) — exit after N exhaustion cycles so systemd can restart
  maxExhaustionCycles: optionalFiniteNumber(instance?.maxExhaustionCycles, 'maxExhaustionCycles') ?? 2,

  // Turn queue depth cap (SP3)
  agentMaxQueueDepth: optionalFiniteNumber(instance?.agentMaxQueueDepth, 'agentMaxQueueDepth') ?? 25,

  // Admin allow replay throttle (SP4)
  adminReplayMax: optionalFiniteNumber(instance?.adminReplayMax, 'adminReplayMax') ?? 5,
  adminReplayDelayMs: optionalFiniteNumber(instance?.adminReplayDelayMs, 'adminReplayDelayMs') ?? 2000,

  // Advanced tool gates (SP5)
  advanced: {
    enableRelayMessage: optionalBoolean(advancedSection?.enableRelayMessage, 'advanced.enableRelayMessage') ?? false,
    enableResync: optionalBoolean(advancedSection?.enableResync, 'advanced.enableResync') ?? false,
    relayMaxPayloadBytes: optionalFiniteNumber(advancedSection?.relayMaxPayloadBytes, 'advanced.relayMaxPayloadBytes') ?? 1_048_576, // 1MB
    // poll.url watch gate (F2 Slice B). Default OFF: create_watch rejects
    // source:'poll.url' at creation and the poller fails closed at exec time
    // unless an operator opts in. Mirrors enableRelayMessage/enableResync.
    enableUrlWatch: optionalBoolean(advancedSection?.enableUrlWatch, 'advanced.enableUrlWatch') ?? false,
  },

  // Access mode (from instance config, defaults to allowlist for backward compat).
  // Source of truth: VALID_ACCESS_MODES + AccessMode in ./instance-loader.ts,
  // which re-exports from ./core/agent-config-validator.ts.
  accessMode: (() => {
    const raw = optionalString(instance?.accessMode, 'accessMode') ?? 'allowlist';
    if (!VALID_ACCESS_MODES.has(raw)) {
      throw new ConfigValidationError(
        `Invalid accessMode "${raw}" — must be one of: ${[...VALID_ACCESS_MODES].join(', ')}`,
      );
    }
    return raw as AccessMode;
  })(),

  // R5: per-sender group response policy. Default 'any_member' preserves current
  // behavior (any non-blocked group participant can trigger a response). Set
  // 'allowlisted_only' (per-instance config or WHATSOUP_GROUP_SENDER_POLICY env) to
  // require the group sender to be allowlisted or admin. Env takes precedence so an
  // operator can flip strict mode per instance without editing config.json.
  groupSenderPolicy: (() => {
    const raw = process.env.WHATSOUP_GROUP_SENDER_POLICY
      ?? optionalString(instance?.groupSenderPolicy, 'groupSenderPolicy')
      ?? 'any_member';
    if (!VALID_GROUP_SENDER_POLICIES.has(raw)) {
      throw new ConfigValidationError(
        `Invalid groupSenderPolicy "${raw}" — must be one of: ${[...VALID_GROUP_SENDER_POLICIES].join(', ')}`,
      );
    }
    return raw as GroupSenderPolicy;
  })(),

  // Transport selection — read from instance.transport, defaults to DEFAULT_TRANSPORT_ID.
  // Mirroring agentProvider: simple inline read with a default.
  transport: resolvedTransport,

  // Outbound identity guard mode. Staged rollout: default log-only (audit-only,
  // no behavior change). Per-instance flip to 'enforce' via env.
  outboundIdentityMode:
    process.env.WHATSOUP_OUTBOUND_IDENTITY_MODE === 'enforce' ? 'enforce' : 'log-only',

  // Twilio SMS config — present only when instance.twilioConfig is set.
  // Defaults for inboundMode/pollIntervalMs/rateLimit are applied by resolveTwilioSmsConfig.
  twilioConfig: resolvedTwilioConfig,

  // iMessage config — present only when instance.imessageConfig is set.
  // Defaults for backend/socket/inboundMode/pollIntervalMs/rateLimit are
  // applied by resolveImessageConfig.
  imessageConfig: resolvedImessageConfig,

  // Signal config — poll-only until a streaming receive path is implemented.
  signalConfig: resolvedSignalConfig,
} as const;

// Make intEnv available for external use (e.g. tests, future env-driven fields)
export { intEnv };
