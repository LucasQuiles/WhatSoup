/**
 * Model catalog — single source of truth for LLM model currency.
 *
 * WhatSoup is a model-agnostic harness: model IDs are passed through to
 * providers opaquely and never gate execution. This catalog is ADVISORY
 * only — it tells operators when a configured model has a newer sibling,
 * is deprecated upstream, or has been retired. It must never block a
 * model string it does not recognize.
 *
 * Future-proofing: IDs are compared by parsing vendor version conventions
 * (`claude-<family>-<major>[-<minor>]`, `gpt-<major>[.<minor>]`, `o<N>`),
 * so a model released after this file was last touched is still recognized
 * and ordered correctly. A configured ID that parses NEWER than anything
 * in the catalog produces no advisory (we trust the operator), and live
 * Models-API discovery (model-advisor.ts) can recommend brand-new IDs as
 * upgrades without a code change here.
 */

export type ModelStatus = 'current' | 'legacy' | 'deprecated' | 'retired';

export interface CatalogEntry {
  id: string;
  status: ModelStatus;
  /** Recommended replacement when status is not 'current'. */
  successor?: string;
  /** ISO date the vendor stops serving the model, when announced. */
  retiresAt?: string;
}

export interface ParsedModel {
  vendor: 'anthropic' | 'openai';
  /** Version line the ID belongs to, e.g. 'opus', 'sonnet', 'fable', 'gpt', 'gpt-codex'. */
  family: string;
  /** Comparable version: major * 100 + minor (claude-opus-4-8 → 408, gpt-5.4 → 504). */
  version: number;
  /** Input with routing suffixes ([1m], -fast, date snapshot) stripped. */
  normalized: string;
}

export type AdvisoryLevel = 'upgrade-available' | 'deprecated' | 'retired';

export interface ModelAdvisory {
  /** The configured model ID that triggered the advisory. */
  model: string;
  /** Which config slot it came from (conversation/extraction/…); set by the advisor. */
  role?: string;
  level: AdvisoryLevel;
  recommended?: string;
  retiresAt?: string;
  message: string;
}

/**
 * Known models. Keep newest-first within a family. Statuses follow the
 * vendors' published lifecycle; update opportunistically — the version
 * parser keeps advisories correct for IDs missing from this list.
 */
export const MODEL_CATALOG: readonly CatalogEntry[] = Object.freeze([
  // ── Anthropic — current ──
  { id: 'claude-fable-5', status: 'current' },
  { id: 'claude-opus-4-8', status: 'current' },
  { id: 'claude-sonnet-4-6', status: 'current' },
  { id: 'claude-haiku-4-5', status: 'current' },
  // ── Anthropic — legacy (still served; newer sibling exists) ──
  { id: 'claude-opus-4-7', status: 'legacy', successor: 'claude-opus-4-8' },
  { id: 'claude-opus-4-6', status: 'legacy', successor: 'claude-opus-4-8' },
  { id: 'claude-opus-4-5', status: 'legacy', successor: 'claude-opus-4-8' },
  { id: 'claude-opus-4-1', status: 'legacy', successor: 'claude-opus-4-8' },
  { id: 'claude-sonnet-4-5', status: 'legacy', successor: 'claude-sonnet-4-6' },
  // ── Anthropic — deprecated (retirement announced) ──
  { id: 'claude-opus-4-0', status: 'deprecated', successor: 'claude-opus-4-8', retiresAt: '2026-06-15' },
  { id: 'claude-opus-4-20250514', status: 'deprecated', successor: 'claude-opus-4-8', retiresAt: '2026-06-15' },
  { id: 'claude-sonnet-4-0', status: 'deprecated', successor: 'claude-sonnet-4-6', retiresAt: '2026-06-15' },
  { id: 'claude-sonnet-4-20250514', status: 'deprecated', successor: 'claude-sonnet-4-6', retiresAt: '2026-06-15' },
  { id: 'claude-3-haiku-20240307', status: 'deprecated', successor: 'claude-haiku-4-5', retiresAt: '2026-04-19' },
  // ── Anthropic — retired (vendor returns 404) ──
  { id: 'claude-3-7-sonnet-20250219', status: 'retired', successor: 'claude-sonnet-4-6' },
  { id: 'claude-3-5-haiku-20241022', status: 'retired', successor: 'claude-haiku-4-5' },
  { id: 'claude-3-opus-20240229', status: 'retired', successor: 'claude-opus-4-8' },
  { id: 'claude-3-5-sonnet-20241022', status: 'retired', successor: 'claude-sonnet-4-6' },
  { id: 'claude-3-5-sonnet-20240620', status: 'retired', successor: 'claude-sonnet-4-6' },
  // ── OpenAI — only lines this repo configures; live discovery extends this ──
  { id: 'gpt-5.4', status: 'current' },
  { id: 'gpt-4o', status: 'legacy', successor: 'gpt-5.4' },
]);

// Strip routing/serving suffixes that don't change the model identity:
// context-window selectors (claude-opus-4-6[1m]), speed variants
// (claude-opus-4-6-fast), and dated snapshots (claude-haiku-4-5-20251001).
export function stripSuffixes(id: string): string {
  return id
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-fast$/, '')
    .replace(/-\d{8}$/, '');
}

// Modern Anthropic: claude-<family>-<major>[-<minor>] (claude-opus-4-8,
// claude-fable-5). Family is generic so future lines parse without edits.
const ANTHROPIC_MODERN = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/;
// Legacy Anthropic: claude-<major>[-<minor>]-<family> (claude-3-5-sonnet).
const ANTHROPIC_LEGACY = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)$/;
// OpenAI GPT: gpt-<major>[.<minor>][-<variant>] (gpt-5.4, gpt-4o,
// gpt-5.1-codex-max). Variants form their own comparison line.
const OPENAI_GPT = /^gpt-(\d+)(?:\.(\d+))?-?([a-z][a-z0-9.-]*)?$/;
// OpenAI o-series: o<major>[-<variant>] (o3, o4-mini).
const OPENAI_O = /^o(\d+)(?:-([a-z0-9-]+))?$/;

/** Parse a model ID into vendor/family/version. Returns null for IDs we
 * don't understand — callers must treat null as "no opinion", never an error. */
export function parseModelId(id: string): ParsedModel | null {
  const normalized = stripSuffixes(id.trim().toLowerCase());

  let m = ANTHROPIC_MODERN.exec(normalized);
  if (m) {
    return {
      vendor: 'anthropic',
      family: m[1],
      version: Number(m[2]) * 100 + Number(m[3] ?? 0),
      normalized,
    };
  }
  m = ANTHROPIC_LEGACY.exec(normalized);
  if (m) {
    return {
      vendor: 'anthropic',
      family: m[3],
      version: Number(m[1]) * 100 + Number(m[2] ?? 0),
      normalized,
    };
  }
  m = OPENAI_GPT.exec(normalized);
  if (m) {
    return {
      vendor: 'openai',
      family: m[3] ? `gpt-${m[3].replace(/[\d.]+/g, '').replace(/-+$/, '') || m[3]}` : 'gpt',
      version: Number(m[1]) * 100 + Number(m[2] ?? 0),
      normalized,
    };
  }
  m = OPENAI_O.exec(normalized);
  if (m) {
    return {
      vendor: 'openai',
      family: m[2] ? `o-${m[2]}` : 'o',
      version: Number(m[1]) * 100,
      normalized,
    };
  }
  return null;
}

const catalogById = new Map(MODEL_CATALOG.map((e) => [e.id, e]));

function lookupCatalog(id: string): CatalogEntry | undefined {
  return catalogById.get(id) ?? catalogById.get(stripSuffixes(id.trim().toLowerCase()));
}

// Stability markers that pin an ID to a pre-release line (gpt-5.6-preview,
// claude-opus-4-9-beta). Stable comparison excludes these — parseModelId puts
// them in their own family — while `stable: false` admits them by comparing on
// the base ID's version. Variant PRODUCT lines (-codex, -mini) are NOT markers:
// they stay excluded from the base family in both modes.
const STABILITY_MARKER = /-(preview|beta|alpha|experimental|exp|rc\d*|next)(?=$|-)/;

export interface LatestInFamilyOptions {
  /**
   * When false, pre-release IDs (…-preview, …-beta, …) whose base parses into
   * the target family are admitted as candidates; the winning pre-release ID
   * is returned verbatim in `normalized` so it can be served as-is. On a
   * version tie a stable ID beats a pre-release one. Default: true (today's
   * behavior — stable current/legacy only).
   */
  stable?: boolean;
}

// Parse `id` as a candidate for the vendor+family line. Direct parses match
// exactly; when stable comparison is off, a stability-marked ID whose base
// parses into the family is admitted with the served ID kept in `normalized`.
function parseFamilyCandidate(
  id: string,
  vendor: ParsedModel['vendor'],
  family: string,
  stable: boolean,
): { parsed: ParsedModel; prerelease: boolean } | null {
  const direct = parseModelId(id);
  if (direct && direct.vendor === vendor && direct.family === family) {
    return { parsed: direct, prerelease: false };
  }
  if (stable) return null;
  const lowered = stripSuffixes(id.trim().toLowerCase());
  const m = STABILITY_MARKER.exec(lowered);
  if (!m) return null;
  const base = parseModelId(lowered.slice(0, m.index) + lowered.slice(m.index + m[0].length));
  if (!base || base.vendor !== vendor || base.family !== family) return null;
  return {
    parsed: { vendor, family, version: base.version, normalized: lowered },
    prerelease: true,
  };
}

/** Newest known model in the same vendor+family line, drawing from the
 * static catalog plus any extra IDs (e.g. live Models-API results). */
export function latestInFamily(
  parsed: ParsedModel,
  extraKnownIds: readonly string[] = [],
  options: LatestInFamilyOptions = {},
): ParsedModel | null {
  const stable = options.stable !== false;
  let best: ParsedModel | null = null;
  let bestPrerelease = false;
  const candidates = [
    ...MODEL_CATALOG.filter((e) => e.status === 'current' || e.status === 'legacy').map((e) => e.id),
    ...extraKnownIds,
  ];
  for (const id of candidates) {
    const cand = parseFamilyCandidate(id, parsed.vendor, parsed.family, stable);
    if (!cand) continue;
    const wins = !best
      || cand.parsed.version > best.version
      || (cand.parsed.version === best.version && bestPrerelease && !cand.prerelease);
    if (wins) {
      best = cand.parsed;
      bestPrerelease = cand.prerelease;
    }
  }
  return best;
}

/**
 * Advise on a configured model ID. Returns null when the model is current,
 * newer than anything we know about, or simply unrecognized (model-agnostic:
 * unknown providers/IDs are passed through silently).
 */
export function adviseModel(
  modelId: string,
  extraKnownIds: readonly string[] = [],
): ModelAdvisory | null {
  const entry = lookupCatalog(modelId);
  if (entry && (entry.status === 'deprecated' || entry.status === 'retired')) {
    const verb = entry.status === 'retired' ? 'has been retired upstream' : 'is deprecated';
    const when = entry.retiresAt ? ` (retires ${entry.retiresAt})` : '';
    return {
      model: modelId,
      level: entry.status,
      recommended: entry.successor,
      retiresAt: entry.retiresAt,
      message: `model "${modelId}" ${verb}${when}${entry.successor ? ` — switch to "${entry.successor}"` : ''}`,
    };
  }

  const parsed = parseModelId(modelId);

  // Parse-based comparison first: it can see live-discovered IDs newer than
  // the catalog. Falls through to the explicit legacy successor below for IDs
  // whose family line can't be compared (e.g. gpt-4o vs gpt-5.4 variants).
  const latest = parsed ? latestInFamily(parsed, extraKnownIds) : null;
  if (entry?.status === 'legacy' && entry.successor
      && !(parsed && latest && latest.version > parsed.version)) {
    return {
      model: modelId,
      level: 'upgrade-available',
      recommended: entry.successor,
      message: `model "${modelId}" has a newer sibling — "${entry.successor}" is available`,
    };
  }
  if (!parsed) return null;

  if (latest && latest.version > parsed.version) {
    return {
      model: modelId,
      level: 'upgrade-available',
      recommended: latest.normalized,
      message: `model "${modelId}" has a newer sibling — "${latest.normalized}" is available`,
    };
  }
  return null;
}
