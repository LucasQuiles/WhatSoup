/**
 * Shared instance-config validator used by CREATE, PATCH, and loader/discovery paths.
 *
 * Closes a class of drift bugs (#244, #249) where each call site enforced an
 * inconsistent subset of rules. Returns a structured ValidationError so callers
 * can map it to either a thrown Error (loader), a string (discovery), or a
 * 4xx HTTP response (CREATE/PATCH).
 *
 * CONSTRAINT: Only Node built-ins. No HTTP, no logger. Pure validation.
 */

// Canonical enum sets — kept HERE (no import from instance-loader.ts) so the
// loader can import from this module without a circular dependency. The
// loader re-exports these for backwards compatibility with existing callers
// (fleet/discovery.ts, fleet/routes/ops.ts, lib/*).
export const VALID_TYPES: ReadonlySet<string> = new Set(['chat', 'agent', 'passive']);
export const VALID_ACCESS_MODES: ReadonlySet<string> = new Set([
  'self_only',
  'allowlist',
  'open_dm',
  'groups_only',
]);
export const VALID_SESSION_SCOPES: ReadonlySet<string> = new Set([
  'single',
  'shared',
  'per_chat',
]);

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

  // --- claudeMd size cap (write paths only — loader does not store it) ---
  if ((ctx.mode === 'create' || ctx.mode === 'patch') && typeof raw['claudeMd'] === 'string') {
    if ((raw['claudeMd'] as string).length > 32_768) {
      return err('claudeMd', 'claudeMd exceeds maximum size (32KB)');
    }
  }

  // --- numeric bounds ---
  const numBoundsErr = validateNumericBounds(raw);
  if (numBoundsErr) return numBoundsErr;

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

  return null;
}

function validateAgentOptions(
  raw: Record<string, unknown>,
  ctx: ValidatorContext,
): ValidationError | null {
  const agentOpts = raw['agentOptions'];

  if (agentOpts === undefined || agentOpts === null) {
    // No agentOptions: existing rule — requires self_only.
    if (raw['accessMode'] !== undefined && raw['accessMode'] !== 'self_only') {
      return err(
        'accessMode',
        `Agent instances require accessMode "self_only", got "${String(raw['accessMode'])}"`,
      );
    }
    return null;
  }

  if (typeof agentOpts !== 'object' || Array.isArray(agentOpts)) {
    return err('agentOptions', 'agentOptions must be an object');
  }
  const opts = agentOpts as Record<string, unknown>;

  // sessionScope is required on load/discovery; optional-but-validated on CREATE/PATCH.
  const scope = opts['sessionScope'];
  if (ctx.mode === 'load' || ctx.mode === 'discovery') {
    if (!VALID_SESSION_SCOPES.has(String(scope ?? ''))) {
      return err(
        'agentOptions.sessionScope',
        `agentOptions.sessionScope is required and must be one of ${[...VALID_SESSION_SCOPES].join(', ')}`,
      );
    }
  } else {
    if (scope !== undefined && !VALID_SESSION_SCOPES.has(String(scope))) {
      // Match the CREATE-path string for back-compat with tests / existing UI.
      return err(
        'agentOptions.sessionScope',
        'agentOptions.sessionScope must be single, shared, or per_chat',
      );
    }
  }

  // cwd must be a string when provided.
  if (opts['cwd'] !== undefined && typeof opts['cwd'] !== 'string') {
    return err('agentOptions.cwd', 'agentOptions.cwd must be a string when provided');
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

  // provider: non-empty string when present.
  if (opts['provider'] !== undefined) {
    if (typeof opts['provider'] !== 'string' || (opts['provider'] as string).trim() === '') {
      return err(
        'agentOptions.provider',
        'agentOptions.provider must be a non-empty string when provided',
      );
    }
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
  }

  // Cross-field: sessionScope === 'single' requires accessMode === 'self_only'.
  if (scope === 'single' && raw['accessMode'] !== 'self_only') {
    if (ctx.mode === 'create') {
      return err(
        'accessMode',
        'agent with sessionScope "single" requires accessMode "self_only"',
      );
    }
    if (ctx.mode === 'patch') {
      return err('accessMode', 'sessionScope "single" requires accessMode "self_only"');
    }
    return err(
      'accessMode',
      `Agent instances require accessMode "self_only", got "${String(raw['accessMode'])}"`,
    );
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
