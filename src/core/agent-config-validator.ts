/**
 * Shared instance-config validator used by CREATE, PATCH, and loader/discovery paths.
 *
 * Closes a class of drift bugs (#244, #249) where each call site enforced an
 * inconsistent subset of rules. Returns a structured ValidationError so callers
 * can map it to either a thrown Error (loader), a string (discovery), or a
 * 4xx HTTP response (CREATE/PATCH).
 *
 * CONSTRAINT: Only Node built-ins. No HTTP, no logger. Validation is pure apart
 * from one filesystem identity read for the agentOptions.cwd home-root invariant
 * (#1862) — the same device/inode check AgentRuntime.start() performs, shared here
 * so config load / API writes / preflight all fail closed on it before a restart.
 */

// Canonical enum sets — kept HERE (no import from instance-loader.ts) so the
// loader can import from this module without a circular dependency. The
// loader re-exports these for backwards compatibility with existing callers
// (fleet/discovery.ts, fleet/routes/ops.ts, lib/*).
//
// PROVIDER_IDS is the single source of truth for agentOptions.provider —
// see src/runtimes/agent/providers/index.ts and issue #447.
import { homedir } from 'node:os';
import { PROVIDER_IDS } from '../runtimes/agent/providers/index.ts';
import { PROVIDER_API_KEY_SERVICES } from '../lib/provider-key-service.ts';
import { isRecord } from '../lib/type-guards.ts';
import { isSamePhysicalDirectory } from '../lib/home-path.ts';
import { resolveAgentModel } from './agent-model.ts';
import { fallbackEntryKey, isSameAsPrimaryFallbackEntry, type AgentFallbackEntry } from './fallback-chain.ts';
import { DEFAULT_TRANSPORT_ID, isTransportId, TRANSPORT_IDS } from '../transport/registry.ts';
import { ACCOUNT_RE } from './transport-refs.ts';
import { E164_RE } from '../transport/twilio/types.ts';
import RE2 from 're2';

export const VALID_TYPES: ReadonlySet<string> = new Set(['chat', 'agent', 'passive']);
export const ACCESS_MODES = [
  'self_only',
  'allowlist',
  'open_dm',
  'groups_only',
] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];
export const VALID_ACCESS_MODES: ReadonlySet<string> = new Set(ACCESS_MODES);
// R5: per-sender group response policy. `any_member` (default) preserves current
// behavior — any non-blocked group participant can trigger a response. `allowlisted_only`
// requires the group sender to be allowlisted (access_list phone `allowed`) or admin.
export const GROUP_SENDER_POLICIES = ['any_member', 'allowlisted_only'] as const;
export type GroupSenderPolicy = (typeof GROUP_SENDER_POLICIES)[number];
export const VALID_GROUP_SENDER_POLICIES: ReadonlySet<string> = new Set(GROUP_SENDER_POLICIES);
export const VALID_SESSION_SCOPES: ReadonlySet<string> = new Set([
  'single',
  'shared',
  'per_chat',
]);

// Managed-loop API providers (no CLI binary; the runtime drives the HTTP API
// directly). A fallbackProvider of this type needs an explicit fallbackModel.
const API_PROVIDER_IDS: ReadonlySet<string> = new Set(['openai-api', 'anthropic-api']);

export interface ValidationError {
  /** Dotted path of the offending field (e.g. "agentOptions.sessionScope"). */
  field: string;
  /** Human-readable error message — matches existing call-site strings where reasonable. */
  message: string;
  /** Suggested HTTP status (default 400). 409 for conflicts (e.g. duplicate healthPort). */
  status?: number;
}

export interface ValidatorContext {
  /** Logical instance name (matched against raw.name except on PATCH where name is immutable). */
  name: string;
  /**
   * Mode controls strictness:
   *  - 'create': healthPort range 1024-65535, full strict validation, name format checked by caller.
   *  - 'patch':  healthPort range 1024-65535, immutability of name/type enforced, full strict.
   *  - 'load':   healthPort range 1024-65535 (defense-in-depth on persisted file).
   *  - 'discovery': healthPort range 1024-65535 to match load-time validation.
   * The 'load' and 'discovery' modes also accept absent agentOptions on non-agent types.
   */
  mode: 'create' | 'patch' | 'load' | 'discovery';
  /** Existing instances keyed by name, used for healthPort duplicate detection. */
  existingHealthPorts?: ReadonlyMap<string, number>;
  /** On PATCH, the pre-merge type from the persisted config. */
  originalType?: unknown;
  /** When true (loader auth-only flow), skip agentOptions/systemPrompt-shape rules. */
  authOnly?: boolean;
}

function err(field: string, message: string, status = 400): ValidationError {
  return { field, message, status };
}

function nonBlankString(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function normalizedModelString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function hasAnyOwn(raw: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.some(field => Object.prototype.hasOwnProperty.call(raw, field));
}

function pineconeBlock(raw: Record<string, unknown>): Record<string, unknown> {
  const memory = isRecord(raw['memory']) ? raw['memory'] : undefined;
  const pinecone = memory && isRecord(memory['pinecone']) ? memory['pinecone'] : undefined;
  return pinecone ?? {};
}

function hasExplicitPineconeConfig(raw: Record<string, unknown>): boolean {
  const pinecone = pineconeBlock(raw);
  return (
    hasAnyOwn(raw, [
      'pineconeApiKeyEnv',
      'pineconeIndex',
      'pineconeAllowedIndexes',
      'pineconeSearchMode',
      'pineconeRerank',
      'pineconeRerankModel',
      'pineconeTopK',
      'pineconeRerankTopN',
      'pineconeContextTopK',
      'pineconeSenderTopK',
      'pineconeSelfFactTopK',
      'pineconeNamespaces',
      'pineconeNamespace',
      'pineconeFactsNamespace',
      'pineconeChunksNamespace',
      'pineconeSummariesNamespace',
      'pineconeLegacyNamespace',
      'pineconeContactsNamespace',
      'pineconeLocalDocsNamespace',
      'pineconeOneDriveNamespace',
      'pineconeKnowledgeSearch',
      'pineconeKnowledgeProfiles',
      'pineconeEmbedUrl',
      'recencyHalfLifeDays',
      'maxAgeDays',
    ]) ||
    hasAnyOwn(pinecone, [
      'apiKeyEnv',
      'index',
      'allowedIndexes',
      'namespaces',
      'searchMode',
      'rerank',
      'rerankModel',
      'topK',
      'rerankTopN',
      'contextTopK',
      'senderTopK',
      'selfFactTopK',
      'recencyHalfLifeDays',
      'maxAgeDays',
      'knowledgeSearch',
      'knowledgeProfiles',
      'embedUrl',
    ])
  );
}

function validatePineconeProjectGuard(
  raw: Record<string, unknown>,
  ctx: ValidatorContext,
): ValidationError | null {
  if (ctx.mode !== 'create' && ctx.mode !== 'patch') return null;

  const name = String(raw['name'] ?? ctx.name).trim().toLowerCase();
  if (!name || name === 'q') return null;
  if (!hasExplicitPineconeConfig(raw)) return null;

  const pinecone = pineconeBlock(raw);
  const hasGuard =
    nonBlankString(pinecone['projectId']) ||
    nonBlankString(pinecone['expectedHostSuffix']) ||
    nonBlankString(raw['pineconeProjectId']) ||
    nonBlankString(raw['pineconeExpectedHostSuffix']);

  if (hasGuard) return null;
  return err(
    'memory.pinecone.projectId',
    'non-q instances with Pinecone config must set memory.pinecone.projectId or memory.pinecone.expectedHostSuffix',
  );
}

function validateAgentModelConsistency(raw: Record<string, unknown>): ValidationError | null {
  const topLevelModel = normalizedModelString(raw['model']);
  const models = raw['models'];
  const conversationModel = isRecord(models)
    ? normalizedModelString(models['conversation'])
    : null;

  if (
    topLevelModel !== null &&
    conversationModel !== null &&
    topLevelModel !== conversationModel
  ) {
    return err(
      'model',
      'top-level model and models.conversation must match when both are set; keep one configured model source or remove one field',
    );
  }

  return null;
}

/**
 * Validate an entire instance config. Returns the first ValidationError, or null.
 *
 * `raw` is the post-merge view on PATCH, or the assembled config on CREATE, or
 * the on-disk JSON on load/discovery.
 */
export function validateInstanceConfig(
  raw: Record<string, unknown>,
  ctx: ValidatorContext,
): ValidationError | null {
  if (ctx.mode === 'load') {
    if (raw['name'] === undefined) {
      return err('name', `Missing required field "name" in ${ctx.name}`);
    }
    if (raw['type'] === undefined) {
      return err('type', `Missing required field "type" in ${ctx.name}`);
    }
    if (raw['accessMode'] === undefined) {
      return err('accessMode', `Missing required field "accessMode" in ${ctx.name}`);
    }
  }

  // --- name ---
  // On 'load' the file's name MUST match the directory name (legacy behavior).
  // On 'patch' the name field is immutable — patch payload cannot rewrite it.
  if (ctx.mode === 'load' || ctx.mode === 'discovery') {
    if (raw['name'] !== undefined && raw['name'] !== ctx.name) {
      return err(
        'name',
        `Instance name mismatch: expected "${ctx.name}" but config.json has "${String(raw['name'])}"`,
      );
    }
  } else {
    if (raw['name'] !== undefined && raw['name'] !== ctx.name) {
      return err('name', 'name is immutable and cannot be changed via PATCH');
    }
  }

  // --- type ---
  if (ctx.mode === 'patch' && ctx.originalType !== undefined && raw['type'] !== ctx.originalType) {
    return err('type', 'type is immutable and cannot be changed via PATCH');
  }
  if (raw['type'] !== undefined && !VALID_TYPES.has(String(raw['type']))) {
    if (ctx.mode === 'create' || ctx.mode === 'patch') {
      return err('type', `type must be one of: ${[...VALID_TYPES].join(', ')}`);
    }
    return err(
      'type',
      `Invalid type "${String(raw['type'])}": must be one of ${[...VALID_TYPES].join(', ')}`,
    );
  }

  // --- accessMode ---
  if (raw['accessMode'] !== undefined && !VALID_ACCESS_MODES.has(String(raw['accessMode']))) {
    if (ctx.mode === 'create' || ctx.mode === 'patch') {
      return err(
        'accessMode',
        `accessMode must be one of: ${[...VALID_ACCESS_MODES].join(', ')}`,
      );
    }
    return err(
      'accessMode',
      `Invalid accessMode "${String(raw['accessMode'])}": must be one of ${[...VALID_ACCESS_MODES].join(', ')}`,
    );
  }

  // --- healthPort ---
  if (raw['healthPort'] !== undefined && raw['healthPort'] !== null) {
    const port = raw['healthPort'];
    if (typeof port !== 'number' || !Number.isFinite(port) || !Number.isInteger(port)) {
      return err('healthPort', 'healthPort must be an integer');
    }
    if (port < 1024 || port > 65535) {
      return err('healthPort', 'healthPort must be between 1024 and 65535');
    }
    // Duplicate check (CREATE / PATCH only; existingHealthPorts excludes self by caller).
    if ((ctx.mode === 'create' || ctx.mode === 'patch') && ctx.existingHealthPorts) {
      for (const [otherName, otherPort] of ctx.existingHealthPorts) {
        if (otherName === ctx.name) continue;
        if (otherPort === port) {
          return err(
            'healthPort',
            `healthPort ${port} is already in use`,
            409,
          );
        }
      }
    }
  }

  // --- adminPhones ---
  if (raw['adminPhones'] !== undefined || ctx.mode === 'load') {
    const phones = raw['adminPhones'];
    if (!Array.isArray(phones) || phones.length === 0) {
      return err('adminPhones', 'adminPhones must be a non-empty array of phone numbers');
    }
    if (phones.some((p) => typeof p !== 'string' || (p as string).trim() === '')) {
      // Preserve the loader's instance-path-flavored message vs the route's array message.
      if (ctx.mode === 'load') {
        return err(
          'adminPhones',
          `adminPhones must contain only non-empty strings in ${ctx.name}`,
        );
      }
      return err('adminPhones', 'adminPhones must be a non-empty array of strings');
    }
  }

  // --- chatAliases (shape) ---
  const chatAliases = raw['chatAliases'];
  if (chatAliases !== undefined) {
    if (typeof chatAliases !== 'object' || chatAliases === null || Array.isArray(chatAliases)) {
      return err('chatAliases', 'chatAliases must be an object of alias -> chatJid strings');
    }
    const seen = new Set<string>();
    for (const [alias, chatJid] of Object.entries(chatAliases as Record<string, unknown>)) {
      const trimmed = alias.trim();
      if (trimmed === '' || typeof chatJid !== 'string' || (chatJid as string).trim() === '') {
        return err('chatAliases', 'chatAliases must contain only non-empty alias -> chatJid strings');
      }
      if (seen.has(trimmed)) {
        return err('chatAliases', `chatAliases contains duplicate alias after trimming: ${trimmed}`);
      }
      seen.add(trimmed);
    }
  }

  // --- pausedChatBypassPatterns (shape + bounds + safe-regex compile) ---
  // Operator-supplied regex sources are compiled and matched (src/core/ingest.ts)
  // with RE2 — a linear-time engine with no catastrophic backtracking — so a
  // config cannot introduce a ReDoS. Supported syntax is RE2's safe subset:
  // NO lookaround and NO backreferences (both require backtracking). The same
  // engine guards config-time and match-time, so a pattern that validates here
  // always compiles at runtime. The count/length caps are defense-in-depth.
  const bypassPatterns = raw['pausedChatBypassPatterns'];
  if (bypassPatterns !== undefined) {
    if (!Array.isArray(bypassPatterns)) {
      return err('pausedChatBypassPatterns', 'pausedChatBypassPatterns must be an array of regex source strings');
    }
    if (bypassPatterns.length > 32) {
      return err('pausedChatBypassPatterns', 'pausedChatBypassPatterns must contain at most 32 patterns');
    }
    for (const pattern of bypassPatterns) {
      if (!nonBlankString(pattern)) {
        return err('pausedChatBypassPatterns', 'pausedChatBypassPatterns must contain only non-empty regex source strings');
      }
      if ((pattern as string).length > 200) {
        return err('pausedChatBypassPatterns', 'pausedChatBypassPatterns entries must be at most 200 characters');
      }
      try {
        // Validate with RE2 (the same engine used at match time). Lookaround and
        // backreferences are unsupported by RE2 and rejected here as invalid.
        new RE2(pattern as string, 'i');
      } catch {
        return err('pausedChatBypassPatterns', `pausedChatBypassPatterns contains an invalid regular expression: ${pattern}`);
      }
    }
  }

  // --- claudeMd size cap (write paths only — loader does not store it) ---
  if ((ctx.mode === 'create' || ctx.mode === 'patch') && typeof raw['claudeMd'] === 'string') {
    if ((raw['claudeMd'] as string).length > 32_768) {
      return err('claudeMd', 'claudeMd exceeds maximum size (32KB)');
    }
  }

  // --- numeric bounds ---
  const numBoundsErr = validateNumericBounds(raw);
  if (numBoundsErr) return numBoundsErr;

  const pineconeGuardErr = validatePineconeProjectGuard(raw, ctx);
  if (pineconeGuardErr) return pineconeGuardErr;

  const transportErr = validateTransportConfig(raw);
  if (transportErr) return transportErr;

  if (raw['type'] === 'agent') {
    const modelConsistencyErr = validateAgentModelConsistency(raw);
    if (modelConsistencyErr) return modelConsistencyErr;
  }

  // Auth-only mode (loader bootstrap-auth path) stops here.
  if (ctx.authOnly) return null;

  // --- Type-specific rules ---
  const type = raw['type'];

  // Chat: requires systemPrompt (loader-only — CREATE/PATCH allow deferred prompt).
  if (type === 'chat' && ctx.mode === 'load') {
    if (!raw['systemPrompt']) {
      return err('systemPrompt', 'Chat instances must have a non-empty systemPrompt');
    }
  }

  // Passive: no systemPrompt, self_only required.
  if (type === 'passive') {
    if (raw['systemPrompt']) {
      if (ctx.mode === 'create') {
        return err('systemPrompt', 'passive instances must not have a systemPrompt');
      }
      return err('systemPrompt', 'Passive instances must not have a systemPrompt');
    }
    if (raw['accessMode'] !== undefined && raw['accessMode'] !== 'self_only') {
      return err(
        'accessMode',
        `Passive instances require accessMode "self_only", got "${String(raw['accessMode'])}"`,
      );
    }
  }

  // Agent: agentOptions rules.
  if (type === 'agent') {
    const agentOptsErr = validateAgentOptions(raw, ctx);
    if (agentOptsErr) return agentOptsErr;
  }

  // Chat: chatOptions rules (openaiProviderConfig shape — QR-218 PR-2). Runs
  // in every mode (create/patch/load/discovery): a malformed chatOptions is
  // equally unsafe to boot from a fresh CREATE or a persisted config.json.
  if (type === 'chat') {
    const chatOptsErr = validateChatOptions(raw);
    if (chatOptsErr) return chatOptsErr;
  }

  // Shared transcription config (QR-218 PR-B) is type-agnostic because chat
  // media handling, agent media-prep, and the global MCP transcribe_audio tool
  // all use the same Whisper singleton in an instance process.
  const transcriptionOptsErr = validateTranscriptionOptions(raw);
  if (transcriptionOptsErr) return transcriptionOptsErr;

  return null;
}

/**
 * Pure shape validator for the baseUrl/apiKeyService pair shared by
 * agentOptions.providerConfig (openai-api/anthropic-api/opencode-cli) and
 * chatOptions.openaiProviderConfig (chat OpenAI provider, QR-218 PR-2) and
 * transcriptionOptions.openaiProviderConfig (OpenAI Whisper, QR-218 PR-B):
 * baseUrl must be a non-empty, parseable http(s) URL; apiKeyService must be a
 * non-empty string naming a service PROVIDER_API_KEY_SERVICES knows, and is
 * rejected when set without a baseUrl (it would authenticate no endpoint).
 * apiKeyService is intentionally checked against PROVIDER_API_KEY_SERVICES
 * (an inference-provider-only subset of SERVICE_ENV_MAP), not SERVICE_ENV_MAP
 * itself — SERVICE_ENV_MAP also holds non-provider secrets (pinecone,
 * elevenlabs, the health token) that a BYOK config must never be able to name
 * alongside an operator-supplied baseUrl. `path` is
 * the caller's dotted field prefix (e.g. "agentOptions.providerConfig" or
 * "chatOptions.openaiProviderConfig") so error fields stay call-site-accurate.
 * AGENT-ONLY rules (budget shape, opencode-cli baseUrl-needs-model) are NOT
 * here — they stay at the agentOptions call site.
 */
function validateProviderConfigShape(
  pc: Record<string, unknown>,
  path: string,
): ValidationError | null {
  // baseUrl: custom OpenAI-compatible endpoint. When present it must be a
  // non-empty, parseable absolute http(s) URL — a malformed value would
  // silently break routing at agent/chat startup.
  if (pc['baseUrl'] !== undefined) {
    if (typeof pc['baseUrl'] !== 'string' || pc['baseUrl'].trim() === '') {
      return err(
        `${path}.baseUrl`,
        `${path}.baseUrl must be a non-empty string when provided`,
      );
    }
    let baseUrl: URL;
    try {
      baseUrl = new URL(pc['baseUrl'] as string);
    } catch {
      return err(
        `${path}.baseUrl`,
        `${path}.baseUrl must be a valid URL when provided`,
      );
    }
    if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
      return err(
        `${path}.baseUrl`,
        `${path}.baseUrl must use http or https`,
      );
    }
  }

  // apiKeyService: names the keyring service whose key authenticates a
  // custom endpoint. It must be an inference-provider service (SECURITY: NOT
  // any SERVICE_ENV_MAP entry — pinecone/elevenlabs/the health token are
  // non-provider secrets that must never be namable here, or a BYOK config
  // could exfiltrate one to an operator-supplied baseUrl as a Bearer token),
  // and is only meaningful alongside baseUrl: without one there is no
  // endpoint for the key to authenticate, so the setting would be silently
  // inert — reject.
  if (pc['apiKeyService'] !== undefined) {
    if (typeof pc['apiKeyService'] !== 'string' || pc['apiKeyService'].trim() === '') {
      return err(
        `${path}.apiKeyService`,
        `${path}.apiKeyService must be a non-empty string when provided`,
      );
    }
    if (!PROVIDER_API_KEY_SERVICES.has(pc['apiKeyService'])) {
      return err(
        `${path}.apiKeyService`,
        `${path}.apiKeyService ${JSON.stringify(pc['apiKeyService'])} is not a valid provider service — valid provider services: ${Array.from(PROVIDER_API_KEY_SERVICES).join(', ')}`,
      );
    }
    if (pc['baseUrl'] === undefined) {
      return err(
        `${path}.apiKeyService`,
        `${path}.apiKeyService is set but ${path}.baseUrl is not — the key service only authenticates a custom endpoint, so without one it would be silently inert; set baseUrl or remove apiKeyService`,
      );
    }
  }

  return null;
}

/**
 * chatOptions rules for `type: 'chat'` instances. Currently just
 * openaiProviderConfig (chat OpenAI provider endpoint/key override — QR-218
 * PR-2); more chat-runtime knobs may land here over time. Deliberately does
 * NOT reuse validateAgentOptions or import anything agent-specific — chat and
 * agent config are independent shapes.
 */
function validateChatOptions(raw: Record<string, unknown>): ValidationError | null {
  const chatOpts = raw['chatOptions'];
  if (chatOpts === undefined || chatOpts === null) {
    return null;
  }
  if (typeof chatOpts !== 'object' || Array.isArray(chatOpts)) {
    return err('chatOptions', 'chatOptions must be an object');
  }
  const opts = chatOpts as Record<string, unknown>;

  const providerConfig = opts['openaiProviderConfig'];
  if (providerConfig === undefined || providerConfig === null) {
    return null;
  }
  if (typeof providerConfig !== 'object' || Array.isArray(providerConfig)) {
    return err(
      'chatOptions.openaiProviderConfig',
      'chatOptions.openaiProviderConfig must be an object when provided',
    );
  }

  return validateProviderConfigShape(
    providerConfig as Record<string, unknown>,
    'chatOptions.openaiProviderConfig',
  );
}

/**
 * Transcription options apply to all instance types that can receive or handle
 * audio. They share the same OpenAI-compatible endpoint/key shape as chat
 * OpenAI config, without inheriting agent-only providerConfig rules.
 */
function validateTranscriptionOptions(raw: Record<string, unknown>): ValidationError | null {
  const transcriptionOpts = raw['transcriptionOptions'];
  if (transcriptionOpts === undefined || transcriptionOpts === null) {
    return null;
  }
  if (typeof transcriptionOpts !== 'object' || Array.isArray(transcriptionOpts)) {
    return err('transcriptionOptions', 'transcriptionOptions must be an object');
  }
  const opts = transcriptionOpts as Record<string, unknown>;

  const providerConfig = opts['openaiProviderConfig'];
  if (providerConfig === undefined || providerConfig === null) {
    return null;
  }
  if (typeof providerConfig !== 'object' || Array.isArray(providerConfig)) {
    return err(
      'transcriptionOptions.openaiProviderConfig',
      'transcriptionOptions.openaiProviderConfig must be an object when provided',
    );
  }

  return validateProviderConfigShape(
    providerConfig as Record<string, unknown>,
    'transcriptionOptions.openaiProviderConfig',
  );
}

function validateAgentOptions(
  raw: Record<string, unknown>,
  ctx: ValidatorContext,
): ValidationError | null {
  const agentOpts = raw['agentOptions'];

  if (agentOpts === undefined || agentOpts === null) {
    return null;
  }

  if (typeof agentOpts !== 'object' || Array.isArray(agentOpts)) {
    return err('agentOptions', 'agentOptions must be an object');
  }
  const opts = agentOpts as Record<string, unknown>;

  // sessionScope is optional on every path — the agent runtime defaults a
  // missing value to 'single' (src/runtimes/agent/runtime.ts AgentRuntime
  // constructor: `options?.sessionScope ?? (options?.shared ? 'shared' :
  // 'single')`), so a config the runtime boots happily must not surface
  // config_error at load or discovery time. Invalid VALUES are still rejected.
  const scope = opts['sessionScope'];
  if (scope !== undefined && !VALID_SESSION_SCOPES.has(String(scope))) {
    return err(
      'agentOptions.sessionScope',
      'agentOptions.sessionScope must be single, shared, or per_chat',
    );
  }

  // cwd must be a string when provided.
  if (opts['cwd'] !== undefined && typeof opts['cwd'] !== 'string') {
    return err('agentOptions.cwd', 'agentOptions.cwd must be a string when provided');
  }

  // cwd, when explicitly configured, must not resolve to the user home directory.
  // AgentRuntime.start() throws on exactly this (`this.cwd &&
  // isSamePhysicalDirectory(this.cwd, homedir())`, runtime.ts), so config load,
  // API writes, and preflight must fail closed on the SAME device/inode check
  // before a restart mutates the service — rather than discovering it only after
  // startup begins (#1862). An absent cwd legitimately falls back to homedir() at
  // runtime and stays allowed; only an explicit home-root cwd is rejected.
  if (typeof opts['cwd'] === 'string') {
    let cwdResolvesToHome: boolean;
    try {
      cwdResolvesToHome = isSamePhysicalDirectory(opts['cwd'], homedir());
    } catch {
      // Ambiguous/dangling path identity — fail closed, matching the runtime guard.
      return err('agentOptions.cwd', 'agentOptions.cwd could not be resolved to a physical directory');
    }
    if (cwdResolvesToHome) {
      return err('agentOptions.cwd', 'agentOptions.cwd must not resolve to the user home directory');
    }
  }

  // instructionsPath must be a string when present.
  if (opts['instructionsPath'] !== undefined && typeof opts['instructionsPath'] !== 'string') {
    return err('agentOptions.instructionsPath', 'agentOptions.instructionsPath must be a string');
  }

  // pluginDirs: array of strings (home-confinement check is route-specific).
  if (opts['pluginDirs'] !== undefined) {
    if (
      !Array.isArray(opts['pluginDirs']) ||
      !(opts['pluginDirs'] as unknown[]).every((d) => typeof d === 'string')
    ) {
      return err('agentOptions.pluginDirs', 'agentOptions.pluginDirs must be an array of strings');
    }
  }

  // sandboxPerChat requires sessionScope 'per_chat'.
  if (opts['sandboxPerChat'] === true && opts['sessionScope'] !== 'per_chat') {
    return err(
      'agentOptions.sandboxPerChat',
      'agentOptions.sandboxPerChat requires sessionScope "per_chat"',
    );
  }

  // perChatConversationBound hardens the non-sandbox per-chat actor socket:
  // it requires per_chat scope and is rejected alongside sandboxPerChat,
  // whose sessions are chat-scoped (already confined) and never construct
  // that socket.
  if (opts['perChatConversationBound'] === true) {
    if (opts['sessionScope'] !== 'per_chat') {
      return err(
        'agentOptions.perChatConversationBound',
        'agentOptions.perChatConversationBound requires sessionScope "per_chat"',
      );
    }
    if (opts['sandboxPerChat'] === true) {
      return err(
        'agentOptions.perChatConversationBound',
        'agentOptions.perChatConversationBound is incompatible with sandboxPerChat',
      );
    }
  }

  // allowM365Mutations (#411): per-instance opt-in for propagating the
  // `ALLOW_M365_MUTATIONS` env var when WHATSOUP_CONNECTOR_FAILCLOSED=1.
  // The REQUIRED_DENY floor is enforced separately in settings templates.
  if (
    opts['allowM365Mutations'] !== undefined &&
    typeof opts['allowM365Mutations'] !== 'boolean'
  ) {
    return err(
      'agentOptions.allowM365Mutations',
      'agentOptions.allowM365Mutations must be a boolean when provided',
    );
  }

  // nlRouting: flag-gated NL-first routing aliases + per-sender preference
  // store. Strictly boolean — config.ts arms it with `=== true`, so a
  // mistyped "true"/1 would otherwise pass validation and silently leave
  // the feature off (F11).
  if (opts['nlRouting'] !== undefined && typeof opts['nlRouting'] !== 'boolean') {
    return err(
      'agentOptions.nlRouting',
      'agentOptions.nlRouting must be a boolean when provided',
    );
  }

  // nlRoutingTiers: optional intent→provider map for NL routing.
  if (opts['nlRoutingTiers'] !== undefined) {
    const tiers = opts['nlRoutingTiers'];
    if (typeof tiers !== 'object' || tiers === null || Array.isArray(tiers)) {
      return err(
        'agentOptions.nlRoutingTiers',
        'agentOptions.nlRoutingTiers must be an object when provided',
      );
    }
    for (const [tierKey, tierValue] of Object.entries(tiers as Record<string, unknown>)) {
      if (tierKey !== 'strongest' && tierKey !== 'fastest') {
        return err(
          'agentOptions.nlRoutingTiers',
          `agentOptions.nlRoutingTiers.${tierKey} is not a recognized tier (strongest|fastest)`,
        );
      }
      if (typeof tierValue !== 'string') {
        return err(
          'agentOptions.nlRoutingTiers',
          `agentOptions.nlRoutingTiers.${tierKey} must be a provider id string`,
        );
      }
    }
  }

  if (opts['nlRoutingEventsDir'] !== undefined && typeof opts['nlRoutingEventsDir'] !== 'string') {
    return err(
      'agentOptions.nlRoutingEventsDir',
      'agentOptions.nlRoutingEventsDir must be a string when provided',
    );
  }

  if (opts['autoCompactInputTokens'] !== undefined) {
    const threshold = opts['autoCompactInputTokens'];
    if (
      typeof threshold !== 'number' ||
      !Number.isFinite(threshold) ||
      !Number.isInteger(threshold) ||
      threshold < 50_000 ||
      threshold > 100_000_000
    ) {
      return err(
        'agentOptions.autoCompactInputTokens',
        'agentOptions.autoCompactInputTokens must be an integer between 50,000 and 100,000,000',
      );
    }
  }

  // provider: must be a canonical ID from the shared registry (#447). The
  // session.ts switches throw on unknown IDs, so rejecting drift here gives
  // the operator a clear 400-class error instead of a runtime crash.
  if (opts['provider'] !== undefined) {
    if (
      typeof opts['provider'] !== 'string' ||
      !(PROVIDER_IDS as readonly string[]).includes(opts['provider'] as string)
    ) {
      return err(
        'agentOptions.provider',
        `agentOptions.provider must be one of: ${PROVIDER_IDS.join(', ')}`,
      );
    }
  }

  if (opts['fallbacks'] !== undefined) {
    if (opts['fallbackProvider'] !== undefined || opts['fallbackModel'] !== undefined) {
      return err(
        'agentOptions.fallbacks',
        'agentOptions.fallbacks cannot be combined with agentOptions.fallbackProvider or agentOptions.fallbackModel',
      );
    }
    if (!Array.isArray(opts['fallbacks'])) {
      return err('agentOptions.fallbacks', 'agentOptions.fallbacks must be an array when provided');
    }
    const fallbacks = opts['fallbacks'] as unknown[];
    if (fallbacks.length > 8) {
      return err('agentOptions.fallbacks', 'agentOptions.fallbacks may contain at most 8 entries');
    }
    const seen = new Set<string>();
    for (let i = 0; i < fallbacks.length; i++) {
      const rawEntry = fallbacks[i];
      const field = `agentOptions.fallbacks[${i}]`;
      if (!isRecord(rawEntry)) {
        return err(field, `${field} must be an object`);
      }
      const provider = rawEntry['provider'];
      if (
        typeof provider !== 'string' ||
        !(PROVIDER_IDS as readonly string[]).includes(provider)
      ) {
        return err(
          `${field}.provider`,
          `${field}.provider must be one of: ${PROVIDER_IDS.join(', ')}`,
        );
      }
      const model = rawEntry['model'];
      if (model !== undefined && (typeof model !== 'string' || model.trim() === '')) {
        return err(`${field}.model`, `${field}.model must be a non-empty string when provided`);
      }
      if (API_PROVIDER_IDS.has(provider) && model === undefined) {
        return err(
          `${field}.model`,
          `${field}.provider "${provider}" is an API provider and requires model to be set`,
        );
      }
      const entry: AgentFallbackEntry = typeof model === 'string'
        ? { provider, model: model.trim() }
        : { provider };
      const key = fallbackEntryKey(entry);
      if (seen.has(key)) {
        return err(field, `${field} duplicates an earlier fallback entry`);
      }
      seen.add(key);
      if (isSameAsPrimaryFallbackEntry(entry, raw)) {
        return err(field, `${field} matches the primary provider/model pair`);
      }
    }
  }

  // fallbackProvider: when present, must be a canonical PROVIDER_ID, same as
  // `provider`. Routes new sessions to this provider when the primary hits a
  // usage limit. An unknown ID would fall through the session.ts switches.
  if (opts['fallbackProvider'] !== undefined) {
    if (
      typeof opts['fallbackProvider'] !== 'string' ||
      !(PROVIDER_IDS as readonly string[]).includes(opts['fallbackProvider'] as string)
    ) {
      return err(
        'agentOptions.fallbackProvider',
        `agentOptions.fallbackProvider must be one of: ${PROVIDER_IDS.join(', ')}`,
      );
    }
  }

  // fallbackModel: a non-empty model string for the fallback provider when present.
  if (opts['fallbackModel'] !== undefined) {
    if (
      typeof opts['fallbackModel'] !== 'string' ||
      opts['fallbackModel'].trim() === ''
    ) {
      return err(
        'agentOptions.fallbackModel',
        'agentOptions.fallbackModel must be a non-empty string when provided',
      );
    }
  }

  // Cross-field: an API-type fallbackProvider requires an explicit
  // fallbackModel. The managed-loop providers (openai-api / anthropic-api)
  // take their model from fallbackModel during a fallback window; without it
  // the window would silently run on a provider-internal default the operator
  // never chose. CLI fallback providers keep their own default model and stay
  // valid without one.
  if (
    typeof opts['fallbackProvider'] === 'string' &&
    API_PROVIDER_IDS.has(opts['fallbackProvider']) &&
    opts['fallbackModel'] === undefined
  ) {
    return err(
      'agentOptions.fallbackModel',
      `agentOptions.fallbackProvider "${opts['fallbackProvider']}" is an API provider and requires agentOptions.fallbackModel to be set`,
    );
  }

  // providerConfig: plain object when present.
  if (opts['providerConfig'] !== undefined) {
    if (
      typeof opts['providerConfig'] !== 'object' ||
      Array.isArray(opts['providerConfig']) ||
      opts['providerConfig'] === null
    ) {
      return err(
        'agentOptions.providerConfig',
        'agentOptions.providerConfig must be an object when provided',
      );
    }
    const pc = opts['providerConfig'] as Record<string, unknown>;
    // AGENT-ONLY: budget shape (not part of the shared baseUrl/apiKeyService
    // rules chat also uses — chatOptions.openaiProviderConfig has no budget).
    if (pc['budget'] !== undefined) {
      if (
        typeof pc['budget'] !== 'object' ||
        Array.isArray(pc['budget']) ||
        pc['budget'] === null
      ) {
        return err(
          'agentOptions.providerConfig.budget',
          'agentOptions.providerConfig.budget must be an object when provided',
        );
      }
    }
    // Shared shape rules (baseUrl format+scheme; apiKeyService format,
    // PROVIDER_API_KEY_SERVICES membership, and apiKeyService-requires-baseUrl)
    // — see validateProviderConfigShape for the single source of truth, also
    // used by chatOptions.openaiProviderConfig.
    const shapeErr = validateProviderConfigShape(pc, 'agentOptions.providerConfig');
    if (shapeErr) return shapeErr;
    // AGENT-ONLY: for opencode-cli, baseUrl is written into opencode.json as a
    // custom provider block that is only exercised when the instance's
    // resolved model (top-level `model`, else `models.conversation`) routes
    // to it. Without a resolvable model the block would never be used —
    // reject instead of shipping a silently inert endpoint. API providers
    // (openai-api / anthropic-api) consume baseUrl directly as an endpoint
    // override with their own model defaults, so they are exempt. Chat has no
    // opencode-cli concept at all, so this rule stays agent-only.
    if (
      pc['baseUrl'] !== undefined &&
      opts['provider'] === 'opencode-cli' &&
      resolveAgentModel(raw) === undefined
    ) {
      return err(
        'agentOptions.providerConfig.baseUrl',
        'agentOptions.providerConfig.baseUrl is set but no model is configured — without a top-level "model" or "models.conversation" the custom endpoint would never be used; set one that routes to it',
      );
    }
  }

  return null;
}

const _TWILIO_ACCOUNT_SID_RE = /^AC[0-9a-f]{32}$/;

const _TWILIO_MSG_SVC_SID_RE = /^MG[0-9a-f]{32}$/;

function validateTransportConfig(
  raw: Record<string, unknown>,
): ValidationError | null {
  const transport = raw['transport'];
  const twilioConfig = raw['twilioConfig'];

  // transport, if present, must be a known TransportId.
  if (transport !== undefined) {
    if (!isTransportId(transport)) {
      return err(
        'transport',
        `transport must be one of: ${TRANSPORT_IDS.join(', ')} (got ${JSON.stringify(transport)})`,
      );
    }
  }

  // twilioConfig present with non-twilio transport (or absent transport) → reject as inconsistent.
  const effectiveTransport = transport ?? DEFAULT_TRANSPORT_ID;
  if (twilioConfig !== undefined && effectiveTransport !== 'twilio') {
    return err(
      'twilioConfig',
      'twilioConfig is inconsistent with transport ' + JSON.stringify(effectiveTransport) +
        ' — twilioConfig is only valid when transport is "twilio"',
    );
  }

  // twilioConfig is REQUIRED when transport === 'twilio'.
  if (effectiveTransport === 'twilio') {
    if (twilioConfig === undefined || twilioConfig === null) {
      return err('twilioConfig', 'twilioConfig is required when transport is "twilio"');
    }
    if (typeof twilioConfig !== 'object' || Array.isArray(twilioConfig)) {
      return err('twilioConfig', 'twilioConfig must be an object');
    }
    const healthPort =
      typeof raw['healthPort'] === 'number' ? (raw['healthPort'] as number) : undefined;
    return validateTwilioConfig(twilioConfig as Record<string, unknown>, healthPort);
  }

  return null;
}

function validateTwilioConfig(tc: Record<string, unknown>, healthPort?: number): ValidationError | null {
  // account: non-empty, matches ACCOUNT_RE
  const account = tc['account'];
  if (typeof account !== 'string' || account === '' || !ACCOUNT_RE.test(account)) {
    return err(
      'twilioConfig.account',
      'twilioConfig.account must be a non-empty lowercase alphanumeric-and-dash string starting with a letter',
    );
  }

  // accountSid: matches ^AC[0-9a-f]{32}$
  const accountSid = tc['accountSid'];
  if (typeof accountSid !== 'string' || !_TWILIO_ACCOUNT_SID_RE.test(accountSid)) {
    return err(
      'twilioConfig.accountSid',
      'twilioConfig.accountSid must match AC[0-9a-f]{32} (hex must be lowercase)',
    );
  }

  // authTokenService: non-empty, no whitespace, max 128 chars
  const authTokenService = tc['authTokenService'];
  if (
    typeof authTokenService !== 'string' ||
    authTokenService === '' ||
    /\s/.test(authTokenService) ||
    authTokenService.length > 128
  ) {
    return err(
      'twilioConfig.authTokenService',
      'twilioConfig.authTokenService must be a non-empty keyring service name (no whitespace, max 128 chars)',
    );
  }

  // Sender XOR: phoneNumber XOR messagingServiceSid
  const phoneNumber = tc['phoneNumber'];
  const messagingServiceSid = tc['messagingServiceSid'];
  const hasPhone = phoneNumber !== undefined && phoneNumber !== null;
  const hasMss = messagingServiceSid !== undefined && messagingServiceSid !== null;

  if (hasPhone && hasMss) {
    return err(
      'twilioConfig.phoneNumber',
      'twilioConfig: set exactly one of phoneNumber or messagingServiceSid, not both',
    );
  }
  if (!hasPhone && !hasMss) {
    return err(
      'twilioConfig.phoneNumber',
      'twilioConfig: exactly one of phoneNumber or messagingServiceSid is required',
    );
  }

  if (hasPhone) {
    if (typeof phoneNumber !== 'string' || !E164_RE.test(phoneNumber)) {
      return err(
        'twilioConfig.phoneNumber',
        'twilioConfig.phoneNumber must be an E.164 number (e.g. +15559990000)',
      );
    }
  }

  if (hasMss) {
    if (typeof messagingServiceSid !== 'string' || !_TWILIO_MSG_SVC_SID_RE.test(messagingServiceSid)) {
      return err(
        'twilioConfig.messagingServiceSid',
        'twilioConfig.messagingServiceSid must match MG[0-9a-f]{32} (hex must be lowercase)',
      );
    }
  }

  // inboundMode: if present must be 'poll' or 'webhook'
  const inboundMode = tc['inboundMode'];
  if (inboundMode !== undefined && inboundMode !== 'poll' && inboundMode !== 'webhook') {
    return err(
      'twilioConfig.inboundMode',
      "twilioConfig.inboundMode must be 'poll' or 'webhook'",
    );
  }
  const effectiveInboundMode = inboundMode ?? 'poll';

  // webhook block: required iff inboundMode === 'webhook', forbidden otherwise (fail closed).
  const webhookBlock = tc['webhook'];
  if (effectiveInboundMode === 'webhook') {
    if (webhookBlock === undefined || webhookBlock === null) {
      return err(
        'twilioConfig.webhook',
        "twilioConfig.webhook is required when inboundMode is 'webhook'",
      );
    }
    if (typeof webhookBlock !== 'object' || Array.isArray(webhookBlock)) {
      return err('twilioConfig.webhook', 'twilioConfig.webhook must be an object');
    }
    const wb = webhookBlock as Record<string, unknown>;
    const publicBaseUrl = wb['publicBaseUrl'];
    if (typeof publicBaseUrl !== 'string' || publicBaseUrl === '') {
      return err(
        'twilioConfig.webhook.publicBaseUrl',
        'twilioConfig.webhook.publicBaseUrl must be a non-empty string',
      );
    }
    let parsed: URL | null = null;
    try { parsed = new URL(publicBaseUrl); } catch { /* fall through */ }
    if (!parsed || parsed.protocol !== 'https:') {
      return err(
        'twilioConfig.webhook.publicBaseUrl',
        'twilioConfig.webhook.publicBaseUrl must be an https:// URL',
      );
    }
    const listenPort = wb['listenPort'];
    if (
      typeof listenPort !== 'number' ||
      !Number.isInteger(listenPort) ||
      listenPort < 1 ||
      listenPort > 65535
    ) {
      return err(
        'twilioConfig.webhook.listenPort',
        'twilioConfig.webhook.listenPort must be an integer between 1 and 65535',
      );
    }
    if (healthPort !== undefined && listenPort === healthPort) {
      return err(
        'twilioConfig.webhook.listenPort',
        `twilioConfig.webhook.listenPort ${listenPort} conflicts with healthPort`,
      );
    }
    const listenAddress = wb['listenAddress'];
    if (listenAddress !== undefined && typeof listenAddress !== 'string') {
      return err(
        'twilioConfig.webhook.listenAddress',
        'twilioConfig.webhook.listenAddress must be a string',
      );
    }
  } else if (webhookBlock !== undefined) {
    // poll mode: webhook block is forbidden (fail closed)
    return err(
      'twilioConfig.webhook',
      "twilioConfig.webhook must not be set when inboundMode is 'poll'",
    );
  }

  // voice optional block
  const voiceBlock = tc['voice'];
  if (voiceBlock !== undefined && voiceBlock !== null) {
    if (typeof voiceBlock !== 'object' || Array.isArray(voiceBlock)) {
      return err('twilioConfig.voice', 'twilioConfig.voice must be an object');
    }
    const vb = voiceBlock as Record<string, unknown>;
    const voiceEnabled = vb['enabled'];
    if (voiceEnabled !== undefined && typeof voiceEnabled !== 'boolean') {
      return err('twilioConfig.voice.enabled', 'twilioConfig.voice.enabled must be a boolean');
    }
    const maxLen = vb['voicemailMaxLengthSec'];
    if (maxLen !== undefined) {
      if (
        typeof maxLen !== 'number' ||
        !Number.isInteger(maxLen) ||
        (maxLen as number) < 5 ||
        (maxLen as number) > 600
      ) {
        return err(
          'twilioConfig.voice.voicemailMaxLengthSec',
          'twilioConfig.voice.voicemailMaxLengthSec must be an integer between 5 and 600',
        );
      }
    }
    const greeting = vb['voicemailGreeting'];
    if (greeting !== undefined) {
      if (typeof greeting !== 'string' || (greeting as string).length > 500) {
        return err(
          'twilioConfig.voice.voicemailGreeting',
          'twilioConfig.voice.voicemailGreeting must be a string of at most 500 characters',
        );
      }
    }
    // Coherence rules for voice.enabled
    if (voiceEnabled === true) {
      if (effectiveInboundMode !== 'webhook') {
        return err(
          'twilioConfig.voice',
          "voice requires inboundMode:'webhook' (transcription arrives via webhook callbacks)",
        );
      }
      // calls.create requires from: string — messagingServiceSid-only configs cannot place calls
      const hasPhone =
        typeof tc['phoneNumber'] === 'string' && (tc['phoneNumber'] as string).length > 0;
      if (!hasPhone) {
        return err(
          'twilioConfig.voice',
          'voice requires phoneNumber (calls cannot originate from a messagingServiceSid)',
        );
      }
    }
  }

  // pollIntervalMs: if present, integer in [5000, 86400000] — the floor protects
  // against rate-limit storms, the 24h ceiling against a config typo silently
  // disabling inbound polling.
  const pollIntervalMs = tc['pollIntervalMs'];
  if (pollIntervalMs !== undefined) {
    if (
      typeof pollIntervalMs !== 'number' ||
      !Number.isFinite(pollIntervalMs) ||
      !Number.isInteger(pollIntervalMs) ||
      pollIntervalMs < 5000 ||
      pollIntervalMs > 86_400_000
    ) {
      return err(
        'twilioConfig.pollIntervalMs',
        'twilioConfig.pollIntervalMs must be an integer between 5000 and 86400000',
      );
    }
  }

  // rateLimit.smsPerMinute: if present, integer in [1, 600] — protects the
  // rate-limiter layer from zero/negative caps.
  const rateLimit = tc['rateLimit'];
  if (rateLimit !== undefined) {
    if (typeof rateLimit !== 'object' || rateLimit === null || Array.isArray(rateLimit)) {
      return err('twilioConfig.rateLimit', 'twilioConfig.rateLimit must be an object');
    }
    const smsPerMinute = (rateLimit as Record<string, unknown>)['smsPerMinute'];
    if (smsPerMinute !== undefined) {
      if (
        typeof smsPerMinute !== 'number' ||
        !Number.isInteger(smsPerMinute) ||
        smsPerMinute < 1 ||
        smsPerMinute > 600
      ) {
        return err(
          'twilioConfig.rateLimit.smsPerMinute',
          'twilioConfig.rateLimit.smsPerMinute must be an integer between 1 and 600',
        );
      }
    }
  }

  return null;
}

function validateNumericBounds(raw: Record<string, unknown>): ValidationError | null {
  if (
    raw['rateLimitPerHour'] !== undefined &&
    typeof raw['rateLimitPerHour'] === 'number' &&
    ((raw['rateLimitPerHour'] as number) < 1 || (raw['rateLimitPerHour'] as number) > 10000)
  ) {
    return err('rateLimitPerHour', 'rateLimitPerHour must be between 1 and 10,000');
  }
  if (
    raw['maxTokens'] !== undefined &&
    typeof raw['maxTokens'] === 'number' &&
    ((raw['maxTokens'] as number) < 256 || (raw['maxTokens'] as number) > 200000)
  ) {
    return err('maxTokens', 'maxTokens must be between 256 and 200,000');
  }
  if (
    raw['tokenBudget'] !== undefined &&
    typeof raw['tokenBudget'] === 'number' &&
    ((raw['tokenBudget'] as number) < 1000 || (raw['tokenBudget'] as number) > 10000000)
  ) {
    return err('tokenBudget', 'tokenBudget must be between 1,000 and 10,000,000');
  }
  return null;
}
