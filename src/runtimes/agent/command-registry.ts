// src/runtimes/agent/command-registry.ts
// Single source of truth for WhatsApp slash-command metadata. Pure data — no
// runtime imports (would create a cycle with runtime.ts). The classifier
// (commands.ts), the /help renderer, and the derived command doc all read from
// here so command metadata is defined once (DRY/SSOT — kills the hand-sync
// drift class, CH5). The CommandSpec TYPE is built ONCE, schema-forward for the
// converged Phase-2 set (/agents /spawn /harness /stats /plugins /skills) — it
// carries the tier, gate+venue (N17), visibility, sensitiveFields, requires,
// and renderContract (N16) axes those commands need. Only Phase-1 ENTRIES are
// seeded here (KISS/YAGNI); W2/W3/Phase-2 append entries, never re-shape the type.

/** Who may EXECUTE a command (identity axis). Composes with `venue` (N17):
 *  identity is WHO, venue is WHERE — god-priv needs both.
 *  - 'admin'              : authenticated admin (isWhatsAppAuthenticatedJid
 *                           FIRST — QR-143 @sms-closing — then admin-phone),
 *                           enforced inline in runtime.ts. Group-permitting
 *                           since B21-A F3 (base parity: the pre-registry
 *                           phone-only gates let admins run these from groups;
 *                           isAdminMessage's DM-only clause is deliberately NOT
 *                           used). Cross-session admin surfaces (U6) —
 *                           /sessions, /kill-session.
 *  - 'admin-shared-scope' : admin required ONLY where the command's effect hits
 *                           SHARED state (single/shared session-scope, or a
 *                           per_chat GROUP — WG-5); ungated in a per_chat 1:1 DM,
 *                           where the effect is scoped to the sender's own
 *                           conversation. The identity check itself is
 *                           group-permitting (an admin may act in a group) and
 *                           @sms-closing (requires isWhatsAppAuthenticatedJid).
 *                           With EMPTY adminPhones the gate stays open (B21-A
 *                           F2: a no-admin instance has no other reset path).
 *                           Used by /new — enforced in runtime.ts. */
export type CommandGate = 'none' | 'admin' | 'admin-shared-scope';

/** /help presentation strings per gate value — the renderer's single lookup
 *  for the LIST tag and the DETAIL gate note (SSOT; replaces the two
 *  hand-synced branch sites help-render.ts used to carry). A Record over the
 *  CommandGate union is TRULY exhaustive: adding a gate value without a row
 *  here is a compile error, so presentation can never silently lag the union.
 *  Wording is value-specific (G34): 'admin-shared-scope' is NOT "admin only" —
 *  it is ungated in a per_chat 1:1 DM and admin-gated only where the effect
 *  hits groups/shared sessions (WG-5), and both its tag and note say so. */
export const GATE_PRESENTATION: Record<CommandGate, { listTag: string; detailNote: string }> = {
  'none': { listTag: '', detailNote: '' },
  'admin': { listTag: ' _(admin)_', detailNote: ' (admin only)' },
  'admin-shared-scope': {
    listTag: ' _(admin in groups & shared sessions)_',
    detailNote: ' (admin in groups & shared sessions)',
  },
};

/** Registry-carried pass-through wording (GATE_PRESENTATION class, SSOT —
 *  arch.ssot-presentation-literals). Both renderHelp's trailer and
 *  renderHelpDetail's alias-off note must COMPOSE this one constant; the
 *  phrase used to be hand-typed in both render sites and the two copies are a
 *  re-fork risk (the guard scripts/ssot-pattern-guard.ts blocks a new literal
 *  copy anywhere in src/ outside this module). */
export const PASSTHROUGH_PHRASE = 'passed through to the agent';

/** N17 venue gate — WHERE a command may execute, independent of WHO (`gate`).
 *  God-priv commands (spawn/harness/model-switch/kill) require a DM or an
 *  owner-named admin group — NEVER a shared project group — in ADDITION to the
 *  identity gate. Read as a TRUST-FLOOR (least-restrictive venue accepted); a
 *  stricter venue always satisfies a more-permissive one (DM ⊆ admin-group):
 *  - 'dm'          : direct message only — the strictest. NO Phase-1 entry uses
 *                    it since B21-A F3: the 'admin' identity gate is
 *                    group-permitting (base parity), so a 'dm' declaration would
 *                    need its own venue-aware enforcement to be honest.
 *  - 'admin-group' : DM OR an owner-named admin group (DM is stricter, so it also
 *                    passes) — NEVER a shared project group. This is N17's god-priv
 *                    floor. Enforcing it needs a VENUE-AWARE gate (plain
 *                    isAdminMessage denies ALL groups) — built when W3/Phase-2
 *                    god-priv lands, NOT via isAdminMessage. No Phase-1 entry uses it.
 *  - 'any'         : no venue restriction (read-only opens).
 *  Omitted = 'any' (read-only default). Enforcement: message-venue rank
 *  (DM=0, admin-group=1, other=2) must be ≤ the command's threshold. */
export type CommandVenue = 'dm' | 'admin-group' | 'any';

/** Which tier a command lives in (spec design principle 1). Transport-local =
 *  LLM-free sqlite/health/config/catalog reads, <1s, works when the agent is
 *  wedged. Agent-forwarded = needs the CLI's own knowledge (skills, spawning).
 *  Every Phase-1 command is transport-local; /skills (Phase-2) is forwarded. */
export type CommandTier = 'transport-local' | 'agent-forwarded';

/** Who a command RENDERS to in /help. Independent of `gate` (D4): a command may
 *  be admin-gated yet end-user-visible, or operator-only on both axes. */
export type CommandVisibility = 'end-user' | 'operator';

/** N16 state-vs-reality spine rule (the render-honesty contract). Every command
 *  render carries an as-of timestamp for its data read; `fields` declares, per
 *  rendered field, whether the value is config-INTENT ("enabled (config)"),
 *  VERIFIED runtime state ("loaded" / "unit observed"), or a STATIC fact
 *  (catalog/registry). A value that can diverge from config is NEVER rendered
 *  bare — this generalizes the stale-usability / false-degrade / RC-confabulation
 *  bug class (live exhibit E5: /status had no as-of). Phase-2 /agents and
 *  /plugins depend on this axis — intent-vs-observed IS their core honesty. */
export interface RenderContract {
  /** True iff the render includes an explicit as-of timestamp for its data read. */
  readonly asOf: boolean;
  /** Per-rendered-field provenance. Absent = the command renders no divergent state. */
  readonly fields?: Readonly<Record<string, 'config-intent' | 'verified-runtime' | 'static'>>;
}

/** Abstract provider capabilities a command requires (C9). Anchored on
 *  ProviderDescriptor (types.ts:73-90). Phase-1 entries declare these as static
 *  data; a handler must branch only on declared capabilities, never provider id. */
export type ProviderCapability =
  | 'modelSwitch'
  | 'nativeSlashCommands'
  | 'mcpMode'
  | 'mcpPerChatIsolation'
  | 'resumeSupport'
  | 'resumeMechanism'
  | 'forcedCompact'
  | 'nativeCompactObservability'
  | 'backgroundTaskEvents';

/** Per-command error classes. These map into the existing taxonomies (§3
 *  baseline) — they are the registry's declaration of what a handler may emit,
 *  never a fourth parallel failure-class list. `source-unreachable:<source>`
 *  names the specific data source (U5 honesty). */
export type CommandErrorClass =
  | 'invalid-arg'
  | 'not-authorized'
  | 'provider-unsupported'
  | 'internal'
  | `source-unreachable:${string}`;

export interface CommandSpec {
  /** Canonical command name (no leading slash), lowercase. */
  readonly name: string;
  /** One-line summary for /help. */
  readonly summary: string;
  /** Usage grammar, leading slash. NEVER use `<...>` — our own markdownToWhatsApp
   *  strips angle-bracket tags (whatsapp-format.ts:100) AND bare `[text]`→`text`
   *  (:87); E1 was `/kill-session <N>` vanishing. Use `[N]`, `[provider-id]`. The
   *  /help renderer wraps this whole string in a backtick span so the inline-code
   *  protection (:42-45/:138) preserves `[N]`; un-backticked it degrades to `N`. */
  readonly syntax: string;
  readonly tier: CommandTier;
  readonly gate: CommandGate;
  /** N17 venue gate (see CommandVenue). OPTIONAL — omitted = 'any' (read-only
   *  default). Phase-1 admin commands are venue:'any' (B21-A F3 base parity:
   *  the identity gate is group-permitting and no venue-aware enforcement
   *  exists yet); W3/Phase-2 god-priv sets 'admin-group'. */
  readonly venue?: CommandVenue;
  readonly visibility: CommandVisibility;
  /** Fields rendered operator-only; dropped from the end-user render (D3). */
  readonly sensitiveFields?: readonly string[];
  /** Capabilities the command needs; unsupported → honest degraded reply (C9). */
  readonly requires?: readonly ProviderCapability[];
  readonly errorClasses: readonly CommandErrorClass[];
  /** N16 state-vs-reality contract (see RenderContract). OPTIONAL axis — where
   *  present it DECLARES the render's as-of + per-field intent-vs-verified posture;
   *  the N16 review row enforces at the render diff. Every Phase-1 state-rendering
   *  command declares it; carried so Phase-2 lands without a type change. */
  readonly renderContract?: RenderContract;
  /** Classified local ONLY when the nlRouting flag is on (byte-identical off). */
  readonly routingAlias?: boolean;
  /** `/model` sub-verb membership (D5 — grammar stays in the classifier). */
  readonly subVerbs?: readonly string[];
  /** Roadmap phase. Phase-1 entries omit (default 1); Phase-2 (/agents /spawn
   *  /harness /stats /plugins /skills) set 2. Lets /help + docs filter by phase
   *  without a second list. */
  readonly phase?: 1 | 2;
}

// Phase-1 seed ONLY (the 8 commands the classifier knows today). The TYPE above
// is schema-forward for the converged Phase-2 set (/agents /spawn /harness /stats
// /plugins /skills) — those entries are added in their own phase (KISS/YAGNI: no
// Phase-2 entries here). `syntax` uses WhatsApp-safe placeholders (E1); `venue`
// declares N17; `renderContract` declares N16; `tier` is the two-tier split.
export const COMMAND_REGISTRY = [
  {
    name: 'new',
    summary: 'start a fresh session',
    syntax: '/new',
    tier: 'transport-local',
    gate: 'admin-shared-scope', // admin only where the reset hits SHARED state (WG-5); own per_chat DM stays ungated
    venue: 'any', // group-permitting by design (admin may /new in a group); venue is enforced inline via sessionScope/isGroup, not the venue axis
    visibility: 'end-user',
    errorClasses: ['not-authorized', 'internal'],
    renderContract: { asOf: false }, // immediate ack ("Starting new session"), no state read
  },
  {
    name: 'status',
    summary: 'show current session status',
    syntax: '/status',
    tier: 'transport-local',
    gate: 'none',
    venue: 'any',
    visibility: 'end-user',
    sensitiveFields: ['pid', 'sessionId'], // operator-only; W1-T4 drops from end-user render (D3)
    errorClasses: ['source-unreachable:session', 'internal'],
    // N16: reports live runtime state → asOf render required. W1-T4 de-sensitizes
    // (drops PID); W2 /status+ implements the as-of stamp + degrade-reason (E5).
    // B26 fields: model is config-INTENT (rendered with an explicit
    // '(configured)' label — the served weight is unobservable); tokens are
    // verified runtime state (agent_sessions denorm counters); the context
    // budget denominator is config-intent (autoCompactInputTokens/default).
    renderContract: {
      asOf: true,
      fields: {
        started: 'verified-runtime',
        messageCount: 'verified-runtime',
        lastActivity: 'verified-runtime',
        model: 'config-intent',
        tokens: 'verified-runtime',
        context: 'config-intent',
      },
    },
  },
  {
    name: 'help',
    summary: 'show this help',
    syntax: '/help [command]',
    tier: 'transport-local',
    gate: 'none',
    venue: 'any',
    visibility: 'end-user',
    errorClasses: ['invalid-arg', 'internal'],
    renderContract: { asOf: false }, // static registry-derived text
  },
  {
    name: 'sessions',
    summary: 'list all active sessions',
    syntax: '/sessions',
    tier: 'transport-local',
    gate: 'admin',
    // B21-A F3: group-permitting (base parity — the pre-registry gate was
    // phone-only, admins could /sessions from groups). The former 'dm' relied on
    // isAdminMessage's DM-only clause, which the gate deliberately dropped.
    venue: 'any',
    visibility: 'operator',
    errorClasses: ['not-authorized', 'source-unreachable:agent_sessions', 'internal'],
    renderContract: {
      asOf: true,
      fields: { age: 'verified-runtime', msgs: 'verified-runtime', tokens: 'verified-runtime' },
    },
  },
  {
    name: 'kill-session',
    summary: 'terminate a session by number',
    syntax: '/kill-session [N]', // E1: `<N>` is eaten by WhatsApp — use [N]
    tier: 'transport-local',
    gate: 'admin',
    // B21-A F3: group-permitting (base parity, see /sessions above). The W3
    // god-priv 'admin-group' venue floor lands with its venue-aware gate.
    venue: 'any',
    visibility: 'operator',
    errorClasses: ['not-authorized', 'invalid-arg', 'internal'],
    renderContract: { asOf: false }, // receipt names the killed session (old→new), no live-metric read
  },
  {
    name: 'model',
    // B26: /help guidance surfaces the catalogue — presentation renders from
    // this entry only (help-render stays literal-free; D7 keeps it flag-gated).
    // D12: the standalone 'default' verb is dropped from the local surface —
    // /model default no longer has special local handling and just forwards
    // to the CLI's own /model (F04); /reset is the one documented undo.
    // D11: the "no delegation" routing-never-changes-authority reassurance
    // (formerly the /why receipt, now removed) is folded into this command's
    // render (renderRouteStatus) so it is never lost.
    summary: 'route status; /model list — see what you can pick; free text or pin strongest|fastest|provider-id; /reset to undo',
    syntax: '/model [status|list|strongest|fastest|provider-id]', // E1: no `<...>`; B26: list = config-derived catalogue
    tier: 'transport-local',
    gate: 'none', // Phase-1 route-preference is ungated; W3's gated /model <id> is a SEPARATE entry
    venue: 'any', // read/set own route preference; the W3 god-priv model-switch entry is venue:'admin-group'
    visibility: 'end-user',
    requires: ['modelSwitch'],
    errorClasses: ['invalid-arg', 'provider-unsupported', 'internal'],
    renderContract: { asOf: true, fields: { activeModel: 'verified-runtime', pinState: 'verified-runtime' } },
    routingAlias: true,
    subVerbs: ['status', 'list', 'strongest', 'fastest'], // B26: 'list' renders the config-derived model catalogue; D12 dropped 'default'
  },
  {
    name: 'reset',
    summary: 'back to the default route',
    syntax: '/reset',
    tier: 'transport-local',
    gate: 'none',
    venue: 'any',
    visibility: 'end-user',
    errorClasses: ['internal'],
    renderContract: { asOf: false }, // immediate confirmation
    routingAlias: true,
  },
] as const satisfies readonly CommandSpec[];

/** Union of the canonical local command names — the classifier's CommandResult
 *  keys off this, so the name set is defined exactly once (collapses the
 *  commands.ts:7/:66 duplicate union). */
export type LocalCommandName = (typeof COMMAND_REGISTRY)[number]['name'];

const BY_NAME: ReadonlyMap<string, CommandSpec> = new Map(
  // `as const` on the tuple so TS infers [string, CommandSpec], not (string|CommandSpec)[].
  COMMAND_REGISTRY.map((c) => [c.name, c] as const),
);

/** Fail-closed lookup: throws on an unknown name rather than returning
 *  undefined, so a classifier/registry divergence surfaces loudly. */
export function getCommandSpec(name: LocalCommandName): CommandSpec {
  const spec = BY_NAME.get(name);
  if (!spec) throw new Error(`command-registry: no entry for '${name}'`);
  return spec;
}
