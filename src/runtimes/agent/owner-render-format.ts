/**
 * WhatSoup owner-render formatting seam (b28 r2a/r2d).
 *
 * WhatsApp is a narrow column with only three controls (single-`*` bold,
 * `_italic_`, backtick mono). Owner-facing route/model/session renders must not
 * cram enumerations onto a long ` → `-joined line; instead each entry gets its
 * own `• ` bullet. These helpers are PURE and hold no runtime state so they can
 * be unit-tested directly — the runtime assembles config-derived values and
 * passes them through here AFTER the sanitize choke point (formatChatRefForOwner
 * et al.), never before, so this layer only shapes already-safe strings.
 */

import { adviseModel } from '../../lib/model-catalog.ts';

/** WhatsApp bullet prefix for owner-facing enumerations. */
export const OWNER_BULLET = '• ';

export interface DisplayRoute {
  provider: string;
  model?: string;
}

export function displayedRoute(live: DisplayRoute | null, next: DisplayRoute): DisplayRoute {
  return live ?? next;
}

export function isDisplayedRoute(candidate: DisplayRoute, active: DisplayRoute): boolean {
  return candidate.provider === active.provider && candidate.model === active.model;
}

export function fallbackRouteLabel(entry: DisplayRoute | null): string | null {
  return entry ? (entry.model ? `${entry.provider} (${entry.model})` : entry.provider) : null;
}

export function renderPinPreferenceOutcome(
  label: string,
  outcome: 'noop' | 'recycled' | 'deferred',
  fallbackRoute: string | null,
): string {
  if (fallbackRoute) {
    return `_Saved ${label} as this chat's 24h preference. Health fallback is active; new sessions still use ${fallbackRoute} until recovery. reply keep to make it permanent, /reset to undo._`;
  }
  if (outcome === 'recycled') return `_Now answering with ${label}. reply keep to make it permanent, /reset to undo._`;
  if (outcome === 'deferred') return `_${label} is pinned — it'll answer from your next message. reply keep to make it permanent, /reset to undo._`;
  return `_Pinned ${label} for 24h — reply keep to make it permanent, /reset to undo._`;
}

export function fallbackReconfirmationOutcome(
  label: string,
  alreadySetText: string,
  fallbackRoute: string | null,
): string | null {
  if (!fallbackRoute) return null;
  const lifetime = alreadySetText.includes('sticky') ? 'permanent' : 'extended for 24h';
  return `_Saved preference remains ${label} (${lifetime}). Health fallback is active; new sessions still use ${fallbackRoute} until recovery. /reset to undo._`;
}

export function savedPreferenceLine(
  pref: { intent: string; requestedProvider: string | null; requestedModel: string | null; modelPinVerified: boolean | null; expiresAt: number | null } | null,
  fallbackActive: boolean,
  now = Date.now(),
): string {
  if (!pref) return 'Saved preference: none';
  const target = (pref.modelPinVerified === true ? pref.requestedModel : null) ?? pref.requestedProvider ?? pref.intent;
  const expiry = pref.expiresAt === null ? '' : ` (expires in ~${Math.max(1, Math.round((pref.expiresAt - now) / 3_600_000))}h)`;
  return `Saved preference: ${target}${expiry}${fallbackActive ? ' — health fallback currently decides new sessions' : ' — steers new sessions'}`;
}

/**
 * Render an enumeration as a header line followed by one `• ` bullet per entry
 * — the WhatsApp-narrow-column shape. Callers only reach here with a non-empty
 * list (the empty case renders a scalar "none configured" line instead), so a
 * genuinely empty `items` degrades to the bare header rather than throwing.
 */
export function bulletedSection(header: string, items: readonly string[]): string {
  return [header, ...items.map((item) => `${OWNER_BULLET}${item}`)].join('\n');
}

/**
 * Join zero or more short modifier tags into a trailing ` [a] [b]` suffix.
 * Empty → '' so a model with no modifiers renders exactly `provider (model)`.
 */
export function modifierSuffix(tags: readonly string[]): string {
  return tags.length > 0 ? ` ${tags.map((tag) => `[${tag}]`).join(' ')}` : '';
}

/**
 * Config-derived modifier tags for one model bullet on /model list.
 *
 * D7 honesty discipline: EVERY tag is a fact derivable from configuration —
 * the configured model ID (via the advisory catalog) and the configured tier
 * map (nlRoutingTiers). The catalog is model-agnostic: an ID it does not
 * recognize (e.g. `kimi/kimi-k3`, `glm/glm-5.2`) parses to null and yields NO
 * advisory, so this never invents a lifecycle claim about a third-party model.
 * A provider that is a configured tier target is tagged with that tier.
 */
export function modelModifierTags(
  modelId: string | undefined,
  provider: string,
  tiers: { strongest?: string; fastest?: string } | null | undefined,
): string[] {
  const tags: string[] = [];
  if (modelId !== undefined) {
    const advisory = adviseModel(modelId);
    if (advisory) {
      if (advisory.level === 'upgrade-available' && advisory.recommended) {
        tags.push(`newer: ${advisory.recommended}`);
      } else if (advisory.level === 'deprecated') {
        tags.push(`deprecated${advisory.recommended ? ` → ${advisory.recommended}` : ''}`);
      } else if (advisory.level === 'retired') {
        tags.push(`retired${advisory.recommended ? ` → ${advisory.recommended}` : ''}`);
      }
    }
  }
  if (tiers?.strongest && tiers.strongest === provider) tags.push('strongest');
  if (tiers?.fastest && tiers.fastest === provider) tags.push('fastest');
  return tags;
}

/** Cap on catalogue ids rendered in `/config model` — ONE constant across all
 *  harnesses (Q ruling 2026-07-19: no per-harness tuning). 12 fits the WhatsApp
 *  narrow column; larger sets truncate with an honest `showing N of M` line. */
export const MODEL_CATALOGUE_CAP = 12;

/** Why a per-harness catalogue could not be listed. Distinct reasons carry
 *  distinct fixes (Q 2b#2/#4) — collapsing them into a single "unavailable" is
 *  the dead-knob defect (the actionable line lies when the real cause differs). */
export type UnavailableReason =
  | { kind: 'no-adapter'; harness: string }
  // 'no-key' = NO anthropic credential at all — neither the claude-cli's OAuth
  // token nor an ANTHROPIC_API_KEY. This is a STRUCTURAL absence (no source
  // exists → the caller suppresses the section). Vocabulary is credential-
  // neutral: the live source is an OAuth Bearer token, not necessarily a key.
  | { kind: 'no-key' }
  // 'key-rejected' = a credential WAS presented and the server refused it
  // (401/403) — a revoked OAuth token or a bad API key. Distinct from
  // 'credential-expired' (a stale token that self-heals, never "rejected").
  | { kind: 'key-rejected' }
  // 'credential-expired' = the claude-cli OAuth token is past its expiry; the
  // CLI refreshes it on the next agent turn, so this is a benign, self-healing
  // TRANSIENT state ("try again shortly"), NOT a rejection or a broken key.
  | { kind: 'credential-expired' }
  | { kind: 'timeout' }
  // 'empty' = the harness ran and produced no model lines; the base line-parser
  // cannot tell a genuinely empty catalogue from an output-shape change (any
  // non-blank line becomes an id), so its text does NOT assert emptiness (Q 2b).
  | { kind: 'empty' }
  // 'unparseable' = the resolver's shape check judged the output present but not
  // a model list (a format regression). Its fix points at the PARSER, not the
  // harness — the silent failure mode a bare "empty" would mask (Q 2b).
  | { kind: 'unparseable' }
  // 'probe-failed' = the harness catalogue command could not be RUN at all
  // (spawn error / binary not runnable). Distinct from 'no-adapter' (an adapter
  // exists; the binary just wouldn't run) and 'empty' (which asserts it ran) —
  // the fix is the binary/PATH, not the parser or the harness support (Q 2b).
  | { kind: 'probe-failed' }
  // 'lookup-failed' = a vendor catalogue call failed transiently (HTTP 500 /
  // network) — the server "can't answer", NOT "you can't ask" (key present, not
  // rejected, not timed out). Distinct fix from no-key/key-rejected/timeout (Q 2b).
  | { kind: 'lookup-failed' };

/** The resolver-produced catalogue listing the formatter renders. `asOfLabel`
 *  is the CAPTURE stamp (Q 2b#1) — when the source was probed, NOT render time. */
export type AvailableModelsListing =
  | { status: 'ok'; ids: readonly string[]; sourceLabel: string; asOfLabel: string }
  | { status: 'unavailable'; reason: UnavailableReason; asOfLabel: string };

/**
 * STRUCTURAL vs TRANSIENT catalogue absence — a render-policy classifier. A
 * *structural* absence means no catalogue SOURCE exists for this harness at all,
 * so there is nothing to retry:
 *   - `no-key`     → NO anthropic credential whatsoever (neither the claude-cli's
 *                    OAuth token nor an ANTHROPIC_API_KEY). With OAuth sourcing a
 *                    healthy claude-cli harness is `ok`, so this now means the
 *                    credential is genuinely missing/broken — rare, not routine.
 *   - `no-adapter` → the harness has no catalogue source wired at all (e.g. codex).
 *
 * SOLICITATION split (Q 2026-07-20): this predicate gates ONLY the UNSOLICITED /
 * aggregate render (e.g. the `/config` overview or a `/status` model line), where
 * a "couldn't list models here" line is noise the user didn't ask for → suppress.
 * A DIRECT request (`/model list`, `/config model`) must ALWAYS render the named
 * reason instead — silence is a bad answer to a direct question, and leaves the
 * user unable to tell "unsupported here" from "broken". The direct `/model list`
 * caller therefore does NOT consult this predicate; the aggregate render does.
 *
 * Every OTHER unavailable reason (`key-rejected`/`credential-expired`/`timeout`/
 * `empty`/`unparseable`/`probe-failed`/`lookup-failed`) is a TRANSIENT failure of a
 * source that DOES exist — "try again shortly" is actionable — so it renders even
 * in the aggregate case.
 */
export function isStructuralCatalogueAbsence(listing: AvailableModelsListing): boolean {
  return (
    listing.status === 'unavailable' &&
    (listing.reason.kind === 'no-key' || listing.reason.kind === 'no-adapter')
  );
}

/** Outcome of resolving a user model-selection token (Q 2026-07-20). */
export type ModelSelectorResult =
  | { ok: true; id: string; viaSelector: boolean }
  | { ok: false; error: 'out-of-range'; count: number }
  | { ok: false; error: 'invalid-shape' };

/**
 * The ONE shared resolver for a human model pick (owner directive 3 + Q DRY):
 * called by BOTH `/model <N>` and `/config model <N>` so numbers mean the same
 * thing wherever a numbered list is rendered — a second call site inventing its
 * own indexing is the drift this centralization prevents.
 *
 * A purely-numeric token is a 1-based SELECTOR into `orderedIds` — the SAME
 * stable ordering the render numbered (catalogue order; current is annotated in
 * place, never reordered, so the coordinate does not move under the write, Q's
 * "write mutates its own coordinate system" catch). Out of range → structured
 * `out-of-range` with the count, never a silent mis-pick.
 *
 * Any other token is an exact id, accepted FAIL-OPEN behind a shape gate (Q R2):
 * an obvious typo (whitespace / empty) bounces as `invalid-shape`, but a
 * shape-valid id is accepted even when the catalogue cannot confirm it — the
 * write path tags such a pin `unverified`. Pure and total; never throws.
 */
export function resolveModelSelector(input: string, orderedIds: readonly string[]): ModelSelectorResult {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (n >= 1 && n <= orderedIds.length) {
      return { ok: true, id: orderedIds[n - 1]!, viaSelector: true };
    }
    return { ok: false, error: 'out-of-range', count: orderedIds.length };
  }
  if (trimmed.length > 0 && !/\s/.test(trimmed)) {
    return { ok: true, id: trimmed, viaSelector: false };
  }
  return { ok: false, error: 'invalid-shape' };
}

/** Input for {@link formatAvailableModels}. All values are config- or
 *  catalogue-derived and sanitize-safe; this layer only shapes strings. */
export interface AvailableModelsInput {
  /** The resolved active harness, named on EVERY render so a misresolution is
   *  visible in output rather than inferred from a surprising list (Q 2b#4). */
  harnessLabel: string;
  /** Configured/pinned model id — ranked first and marked `[current]`, if present. */
  currentModelId: string | null;
  /** Configured fallback model ids — ranked after the current model, in order. */
  fallbackModelIds: readonly string[];
  /** The resolver-produced listing (dynamic per harness). */
  listing: AvailableModelsListing;
  /** Optional case-insensitive substring filter from `/config model <filter>`. */
  filter: string | null;
  /** Max ids to render before truncating (pass {@link MODEL_CATALOGUE_CAP}). */
  cap: number;
}

/** The actionable, reason-specific line for an unavailable catalogue (Q 2b#2). */
function unavailableMessage(reason: UnavailableReason): string {
  switch (reason.kind) {
    case 'no-key':
      return 'no anthropic credential reachable on this host';
    case 'key-rejected':
      return 'anthropic credential rejected (401/403)';
    case 'credential-expired':
      return 'anthropic OAuth credential expired — refreshes on the next agent turn, try again shortly';
    case 'timeout':
      return 'catalogue lookup timed out';
    case 'empty':
      return 'harness ran but returned no model lines';
    case 'unparseable':
      return 'harness output not recognizable as a model list (parser may need updating)';
    case 'probe-failed':
      return 'harness catalogue command could not be run (binary missing?)';
    case 'lookup-failed':
      return 'catalogue lookup failed (try again shortly)';
    case 'no-adapter':
      return `no catalogue adapter for harness '${reason.harness}'`;
  }
}

/**
 * Render the dynamic PER-HARNESS available-models section for `/config model`
 * (CONFIG-MODEL-RENDER-SPEC.md; Q rulings 2026-07-19/20). The caller renders the
 * config-derived pin/primary block ABOVE this, so this section degrades
 * INDEPENDENTLY — its failure never takes the "what am I on" answer down.
 *
 * Load-bearing constraints:
 *  - the resolved `harness:` is named on EVERY state (misresolution visible);
 *  - `ok` carries a `source:` provenance line (the tag on the LIST) with the
 *    CAPTURE-time as-of — never labeled "what this harness can run";
 *  - ranked head current→fallbacks→rest (deduped); when nothing config-derived
 *    ranks it, the truncation line SAYS it is catalogue order, not "the top";
 *  - `showing N of M` only when M > cap;
 *  - filter-miss is rendered distinctly from catalogue-unavailable;
 *  - `unavailable` is actionable and reason-specific (no-key ≠ key-rejected ≠
 *    timeout ≠ empty ≠ no-adapter) — the fix differs per reason.
 *
 * Pure and stateless. Never throws. Caching + time-budget live in the resolver.
 */
export function formatAvailableModels(input: AvailableModelsInput): string {
  const { harnessLabel, currentModelId, listing, filter, cap } = input;

  // Unavailable → actionable, reason-specific line. The pin is the caller's
  // config-derived block above, so this degrades independently.
  if (listing.status === 'unavailable') {
    return `*Available models:* unavailable — ${unavailableMessage(listing.reason)} (harness: ${harnessLabel}, as of ${listing.asOfLabel})`;
  }

  const { ids, sourceLabel, asOfLabel } = listing;

  // Each entry keeps its TRUE 1-based index in the STABLE catalogue order — the
  // single, value-independent coordinate system (Q 2026-07-20). No reranking: a
  // ranked order would move a number under the write that selects by it. The
  // number is what resolveModelSelector indexes, so render and selection agree.
  const entries = ids.map((id, i) => ({ id, n: i + 1 }));

  // Optional case-insensitive substring filter. The matched subset KEEPS its true
  // indices (non-contiguous) — it is never renumbered 1..k, or `2` would mean a
  // different model on a filtered screen than on the unfiltered one (Q).
  let pool = entries;
  if (filter !== null) {
    const needle = filter.toLowerCase();
    pool = entries.filter((e) => e.id.toLowerCase().includes(needle));
    if (pool.length === 0) {
      // Filter-miss is NOT catalogue-unavailable — count the full catalogue that
      // was searched, and keep the provenance so the two states never collapse.
      return `*Available models:* no models match '${filter}' (${ids.length} in catalogue) (harness: ${harnessLabel}, source: ${sourceLabel}, as of ${asOfLabel})`;
    }
  }

  const header =
    filter !== null
      ? `*Available models* matching '${filter}' — harness: ${harnessLabel}`
      : `*Available models* — harness: ${harnessLabel}`;
  const sourceLine = `_source: ${sourceLabel}, as of ${asOfLabel}_`;
  const renderLine = (e: { id: string; n: number }): string =>
    `${e.n}. ${e.id}${e.id === currentModelId ? ' (current)' : ''}`;

  const shown = pool.slice(0, cap);
  const lines = [header, sourceLine, ...shown.map(renderLine)];

  // Surface the current model OUT-OF-BAND at its TRUE index when it is in scope
  // (matches the active filter / no filter) but sits beyond the browse window —
  // the window stays a fixed property instead of sliding to include current,
  // which would be the coordinate-mutates-on-write bug one layer up (Q 02:20).
  if (currentModelId !== null) {
    const currentInPool = pool.find((e) => e.id === currentModelId);
    const currentShown = shown.some((e) => e.id === currentModelId);
    if (currentInPool && !currentShown) lines.push(renderLine(currentInPool));
  }

  // Disclose the window so the hidden-but-valid number space is not a guessing
  // game (Q 02:20): under no filter the whole 1..M space is pickable.
  if (pool.length > cap) {
    lines.push(
      filter !== null
        ? `showing ${cap} of ${pool.length} matches — /model list <text> to narrow further`
        : `showing 1–${cap} of ${ids.length} — any number 1–${ids.length} works; /model list <text> to narrow`,
    );
  }

  return lines.join('\n');
}
