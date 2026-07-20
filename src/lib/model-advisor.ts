/**
 * Model currency advisor — startup + daily check that the configured models
 * are still the right ones, with operator notification when they are not.
 *
 * Sources, in order of authority:
 *   1. Live vendor Models APIs (Anthropic GET /v1/models, OpenAI GET
 *      /v1/models) when the matching API key is present — this is what makes
 *      brand-new releases detectable without a code change.
 *   2. The static catalog in model-catalog.ts as the offline fallback.
 *
 * Everything here is advisory and non-blocking: network errors, missing keys,
 * and unrecognized model IDs never block startup, but live-scan degradation is
 * surfaced separately so operators do not confuse static fallback with proof
 * that every configured model is current. Notifications ride the existing
 * BOT_ERRORS alert pipeline (emit-alert.ts) so operators see them where every
 * other incident lands.
 */
import { createChildLogger } from '../logger.ts';
import { clearAlertSourceChecked, emitAlertChecked } from './emit-alert.ts';
import { adviseModel, type ModelAdvisory } from './model-catalog.ts';
import {
  parseSymbolicModel,
  resolveSymbolicFromCatalog,
  resolveSymbolicFromIds,
  type SymbolicModelSpec,
} from './model-resolver.ts';
import { errorMessage } from './error-message.ts';
import { resolveApiKey } from './api-key-resolver.ts';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const log = createChildLogger('model-advisor');

const ALERT_SOURCE = 'model-currency';
const LIVE_SCAN_ALERT_SOURCE = 'model-currency-live-scan';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;

let cachedAdvisories: ModelAdvisory[] = [];
let cachedLiveScan: LiveModelScanStatus | null = null;
let lastCheckedAt: string | null = null;
// Dedupe key of the last advisory set we alerted on — re-alert only when the
// set changes (and once per process start), not on every daily re-check.
let lastNotifiedKey: string | null = null;
let lastLiveScanFailureKey: string | null = null;

export interface LiveModelFetchFailure {
  vendor: string;
  reason: string;
  status?: number;
}

export interface LiveModelScanStatus {
  mode: 'static-only' | 'live' | 'degraded';
  attemptedVendors: string[];
  degradedVendors: LiveModelFetchFailure[];
  fetchedCount: number;
}

export interface ModelCurrencyCheckResult {
  advisories: ModelAdvisory[];
  liveScan: LiveModelScanStatus;
}

interface VendorModelFetchResult {
  ids: string[];
  failure: LiveModelFetchFailure | null;
}

interface NotifyModelAdvisoryOptions {
  logAllCurrent?: boolean;
}

/** Snapshot for the /health endpoint. */
export function getModelAdvisories(): {
  checkedAt: string | null;
  advisories: ModelAdvisory[];
  liveScan: LiveModelScanStatus | null;
} {
  return { checkedAt: lastCheckedAt, advisories: cachedAdvisories, liveScan: cachedLiveScan };
}

/** Test-only: reset module state between cases. */
export function __resetModelAdvisorForTest(): void {
  cachedAdvisories = [];
  cachedLiveScan = null;
  lastCheckedAt = null;
  lastNotifiedKey = null;
  lastLiveScanFailureKey = null;
  liveIdsCache = null;
}

interface ModelsListResponse {
  data?: Array<{ id?: unknown }>;
}

async function fetchModelIds(
  url: string,
  headers: Record<string, string>,
  vendor: string,
): Promise<VendorModelFetchResult> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      log.warn({ vendor, status: res.status }, 'models API returned non-OK; using static catalog');
      return {
        ids: [],
        failure: { vendor, status: res.status, reason: `HTTP ${res.status}` },
      };
    }
    const body = (await res.json()) as ModelsListResponse;
    const ids = (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string');
    log.debug({ vendor, count: ids.length }, 'live model list fetched');
    return { ids, failure: null };
  } catch (err) {
    const reason = sanitizeFetchFailureReason(err);
    log.warn({ vendor, err: reason }, 'models API unreachable; using static catalog');
    return {
      ids: [],
      failure: { vendor, reason },
    };
  }
}

function sanitizeFetchFailureReason(err: unknown): string {
  const raw = errorMessage(err);
  return raw
    .replace(/\b(?:sk|sk-ant|sk-proj)-[A-Za-z0-9._-]{8,}\b/g, '[redacted-key]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi, 'Bearer [redacted]');
}

export async function fetchLiveModelIdsWithStatus(): Promise<{ ids: string[]; liveScan: LiveModelScanStatus }> {
  const fetches: Promise<VendorModelFetchResult>[] = [];
  const attemptedVendors: string[] = [];
  const anthropicKey = resolveApiKey({ envVar: 'ANTHROPIC_API_KEY' });
  if (anthropicKey) {
    attemptedVendors.push('anthropic');
    fetches.push(fetchModelIds(
      'https://api.anthropic.com/v1/models?limit=100',
      { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      'anthropic',
    ));
  }
  const openaiKey = resolveApiKey({ envVar: 'OPENAI_API_KEY' });
  if (openaiKey) {
    attemptedVendors.push('openai');
    fetches.push(fetchModelIds(
      'https://api.openai.com/v1/models',
      { Authorization: `Bearer ${openaiKey}` },
      'openai',
    ));
  }
  const results = await Promise.all(fetches);
  const ids = results.flatMap((result) => result.ids);
  const degradedVendors = results
    .map((result) => result.failure)
    .filter((failure): failure is LiveModelFetchFailure => failure !== null);
  const mode = attemptedVendors.length === 0
    ? 'static-only'
    : degradedVendors.length > 0 ? 'degraded' : 'live';
  return {
    ids,
    liveScan: {
      mode,
      attemptedVendors,
      degradedVendors,
      fetchedCount: ids.length,
    },
  };
}

/** Fetch currently-served model IDs from vendors we have credentials for. */
export async function fetchLiveModelIds(): Promise<string[]> {
  return (await fetchLiveModelIdsWithStatus()).ids;
}

/** A vendor Models-API failure classified by HTTP CONCEPT, not render vocabulary
 *  — 'unauthorized' (the key is not accepted), 'timeout' (no answer in time), or
 *  'lookup-failed' (the server could not answer: 5xx / 429 / network). */
export type ModelFetchFailureCategory = 'unauthorized' | 'timeout' | 'lookup-failed';

/**
 * Classify a {@link LiveModelFetchFailure}. This is the SINGLE status→category
 * mapping any vendor-facing caller shares, so a 403 can never be labeled a
 * 'timeout' by one path and 'unauthorized' by another (Q 2b: extract the
 * classifier, don't reimplement it per call site). Render-reason translation
 * stays in the caller (the catalogue resolver), also in one place.
 */
export function classifyModelFetchFailure(failure: { status?: number; reason: string }): ModelFetchFailureCategory {
  if (failure.status === 401 || failure.status === 403) return 'unauthorized';
  // AbortSignal.timeout rejects with a TimeoutError/AbortError and no HTTP
  // status; fetchModelIds surfaces its (sanitized) message as `reason`.
  if (failure.status === undefined && /timeout|abort/i.test(failure.reason)) return 'timeout';
  // 5xx, 429, or any other non-auth failure: the server could not answer.
  return 'lookup-failed';
}

const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models?limit=100';

/**
 * The claude-cli's OWN OAuth credential state, read from its credentials file.
 * The subscription CLI authenticates `/v1/models` with `Authorization: Bearer`
 * (verified live on the WhatSoup host 2026-07-20 — a Bearer OAuth token, NOT an x-api-key,
 * returns the org catalogue), so q needs no separate anthropic API key to list
 * models — it reuses the credential the harness already has.
 *   - `present` → an unexpired accessToken to send as `Bearer`;
 *   - `expired` → an accessToken past `expiresAt`; the CLI refreshes it on the
 *     next agent turn, so this is a benign, self-healing TRANSIENT state (never
 *     rendered as "credential rejected");
 *   - `absent`  → no creds file / no token → the caller falls back to an
 *     explicit ANTHROPIC_API_KEY, and if that is also missing, `no-key`.
 */
export type ClaudeOAuthCredResult =
  | { status: 'present'; token: string }
  // `hasRefreshToken` distinguishes expired-refreshable (the CLI refreshes at
  // spawn → routable) from expired-no-refresh (not routable). Presence only —
  // a present token may still be revoked/aged, which surfaces at spawn, not here.
  | { status: 'expired'; hasRefreshToken: boolean }
  | { status: 'absent' };

/** Path to the claude-cli credentials file (honors CLAUDE_CONFIG_DIR like the CLI). */
function claudeCredentialsPath(): string {
  const configDir = process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude');
  return join(configDir, '.credentials.json');
}

/** Default reader: the raw credentials-file text, or null if unreadable/missing. */
function defaultReadCredentialsText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Resolve the claude-cli OAuth credential, read FRESH from disk each call (the
 * CLI rewrites the refreshed token in place, so a cached token would go stale).
 * Never logs or returns the token except in the `present` result the caller
 * hands straight to the single `/v1/models` GET. `readFileText` + `nowMs` are
 * injectable so unit tests need no real creds file or wall clock.
 */
export function resolveClaudeOAuthCred(
  deps: { readFileText?: (path: string) => string | null; nowMs?: number } = {},
): ClaudeOAuthCredResult {
  const readFileText = deps.readFileText ?? defaultReadCredentialsText;
  const nowMs = deps.nowMs ?? Date.now();
  const raw = readFileText(claudeCredentialsPath());
  if (!raw) return { status: 'absent' };
  let oauth: { accessToken?: unknown; expiresAt?: unknown; refreshToken?: unknown } | undefined;
  try {
    oauth = (JSON.parse(raw) as { claudeAiOauth?: typeof oauth }).claudeAiOauth;
  } catch {
    return { status: 'absent' };
  }
  const token = oauth?.accessToken;
  if (typeof token !== 'string' || token.length === 0) return { status: 'absent' };
  const expiresAt = oauth?.expiresAt;
  if (typeof expiresAt === 'number' && expiresAt <= nowMs) {
    const refresh = oauth?.refreshToken;
    return { status: 'expired', hasRefreshToken: typeof refresh === 'string' && refresh.length > 0 };
  }
  return { status: 'present', token };
}

/** Anthropic-only live model listing, classified. */
export type AnthropicModelsResult =
  | { status: 'ok'; ids: string[] }
  | { status: 'no-key' }
  | { status: 'credential-expired' }
  | { status: 'failed'; category: ModelFetchFailureCategory };

/**
 * Fetch the anthropic org's live model catalogue for the `/config model`
 * resolver (claude-cli harness). Reuses the internal `fetchModelIds` + the
 * shared classifier — deliberately NOT `fetchLiveModelIdsWithStatus`, which
 * flattens all vendors and cannot tag an id's vendor: rendering an OpenAI id
 * under an `anthropic /v1/models` provenance label would make the source line
 * lie (Q 2b).
 *
 * Credential precedence for the claude-cli harness (Q 2026-07-20, "this uses
 * oauth — we don't need a key"): prefer the CLI's OWN OAuth token (`Bearer`, no
 * separate key needed), fall back to an explicit ANTHROPIC_API_KEY (`x-api-key`).
 * The returned set is the credential's ORG catalogue, not "what the harness can
 * run" — the caller labels it as such. `readOAuthCred` is injectable for tests.
 */
export async function fetchAnthropicModelIdsWithStatus(
  deps: { readOAuthCred?: () => ClaudeOAuthCredResult } = {},
): Promise<AnthropicModelsResult> {
  const cred = (deps.readOAuthCred ?? (() => resolveClaudeOAuthCred()))();
  // Expired OAuth token → benign transient (self-heals when the CLI refreshes);
  // do not spend a request that would 401 and read as "rejected".
  if (cred.status === 'expired') return { status: 'credential-expired' };

  let headers: Record<string, string>;
  if (cred.status === 'present') {
    headers = { Authorization: `Bearer ${cred.token}`, 'anthropic-version': '2023-06-01' };
  } else {
    const anthropicKey = resolveApiKey({ envVar: 'ANTHROPIC_API_KEY' });
    if (!anthropicKey) return { status: 'no-key' };
    headers = { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' };
  }

  const result = await fetchModelIds(ANTHROPIC_MODELS_URL, headers, 'anthropic');
  if (result.failure) {
    return { status: 'failed', category: classifyModelFetchFailure(result.failure) };
  }
  return { status: 'ok', ids: result.ids };
}

// ---------------------------------------------------------------------------
// Live-ID cache + symbolic model resolution
//
// Symbolic model-role values (`<vendor>:<family>:latest[-stable]` — grammar
// and selection in model-resolver.ts) resolve against the live vendor lists.
// The cache below is the single in-process source for those lists: the
// currency monitor refreshes it on startup and on its daily tick, and
// point-of-use resolution (resolveModelRole) reads through it, so a hot chat
// path never adds a second network fetch.
// ---------------------------------------------------------------------------

const LIVE_IDS_CACHE_TTL_MS = CHECK_INTERVAL_MS;
let liveIdsCache: { fetchedAt: number; ids: string[]; liveScan: LiveModelScanStatus } | null = null;

async function refreshLiveModelIdsCache(): Promise<{ ids: string[]; liveScan: LiveModelScanStatus }> {
  const result = await fetchLiveModelIdsWithStatus();
  liveIdsCache = { fetchedAt: Date.now(), ...result };
  return result;
}

/** Live model IDs through the shared daily cache (refresh on miss/expiry). */
export async function fetchLiveModelIdsCached(): Promise<{ ids: string[]; liveScan: LiveModelScanStatus }> {
  if (liveIdsCache && Date.now() - liveIdsCache.fetchedAt < LIVE_IDS_CACHE_TTL_MS) {
    return { ids: liveIdsCache.ids, liveScan: liveIdsCache.liveScan };
  }
  return refreshLiveModelIdsCache();
}

// Resolve a parsed symbolic spec against a live scan. When the spec's vendor
// was not scanned live (missing key) or its scan degraded, fall back to the
// static catalog `current` entry for the family — warn-logged, never thrown.
function resolveSpecWithScan(
  spec: SymbolicModelSpec,
  liveIds: readonly string[],
  liveScan: LiveModelScanStatus,
): string {
  const vendorLive = liveScan.attemptedVendors.includes(spec.vendor)
    && !liveScan.degradedVendors.some((failure) => failure.vendor === spec.vendor);
  if (vendorLive) {
    const resolved = resolveSymbolicFromIds(spec, liveIds);
    if (resolved) return resolved;
  }
  const fromCatalog = resolveSymbolicFromCatalog(spec);
  log.warn(
    { model: spec.raw, resolved: fromCatalog, scanMode: liveScan.mode, vendor: spec.vendor },
    vendorLive
      ? 'symbolic model matched nothing in the live list — resolved from static catalog'
      : 'live scan unavailable for vendor — symbolic model resolved from static catalog',
  );
  return fromCatalog ?? spec.raw;
}

// Parse a role value, treating malformed symbolic values as literals here:
// config load already rejects them loudly (validateModelRoleValue), so a
// runtime parse failure can only come from an unvalidated source — advisory
// paths must not throw for it.
function parseSymbolicLenient(value: string): SymbolicModelSpec | null {
  try {
    return parseSymbolicModel(value);
  } catch {
    return null;
  }
}

/**
 * Resolve a configured model-role value to the concrete ID to send to a
 * provider. Literal IDs return unchanged without touching the network.
 * Symbolic values resolve through the shared live-ID cache and degrade to
 * the static catalog `current` for the family — this never throws and never
 * blocks on anything slower than one cached vendor-list fetch.
 */
export async function resolveModelRole(value: string): Promise<string> {
  const spec = parseSymbolicLenient(value);
  if (!spec) return value;
  try {
    const { ids, liveScan } = await fetchLiveModelIdsCached();
    return resolveSpecWithScan(spec, ids, liveScan);
  } catch (err) {
    const fromCatalog = resolveSymbolicFromCatalog(spec);
    log.warn(
      { model: value, resolved: fromCatalog, err: errorMessage(err) },
      'symbolic model resolution failed — resolved from static catalog',
    );
    return fromCatalog ?? value;
  }
}

/**
 * Check every configured role→model pair and return advisories for the ones
 * that are behind, deprecated, or retired. Roles with empty values are skipped.
 */
export async function checkModelCurrency(
  models: Record<string, string | undefined>,
): Promise<ModelAdvisory[]> {
  return (await checkModelCurrencyStatus(models)).advisories;
}

export async function checkModelCurrencyStatus(
  models: Record<string, string | undefined>,
): Promise<ModelCurrencyCheckResult> {
  // Force-refresh (not read-through) so the startup check and each daily tick
  // re-resolve symbolic values against a fresh vendor list, priming the shared
  // cache that point-of-use resolution reads.
  const { ids: liveIds, liveScan } = await refreshLiveModelIdsCache();
  const advisories: ModelAdvisory[] = [];
  for (const [role, modelId] of Object.entries(models)) {
    if (!modelId || modelId.trim() === '') continue;
    // Advise on the RESOLVED target: for symbolic values the advisory-worthy
    // question is whether what they currently resolve to is current, not
    // whether the symbolic string itself parses as a model ID.
    const spec = parseSymbolicLenient(modelId);
    const target = spec ? resolveSpecWithScan(spec, liveIds, liveScan) : modelId;
    const advisory = adviseModel(target, liveIds);
    if (advisory) advisories.push({ ...advisory, role });
  }
  return { advisories, liveScan };
}

/**
 * Record advisories (for /health) and notify operators through the
 * BOT_ERRORS pipeline. Deprecated/retired models alert at 'warning';
 * pure upgrade availability alerts at 'info'. The alert source is cleared
 * once a previously-flagged config comes back clean.
 */
export function notifyModelAdvisories(
  instance: string,
  advisories: ModelAdvisory[],
  options: NotifyModelAdvisoryOptions = {},
): void {
  cachedAdvisories = advisories;
  lastCheckedAt = new Date().toISOString();

  const key = advisories
    .map((a) => `${a.role}:${a.model}:${a.level}:${a.recommended ?? ''}`)
    .sort()
    .join('|');

  if (advisories.length === 0) {
    if (lastNotifiedKey !== null && lastNotifiedKey !== '') {
      clearAlertSourceChecked(instance, ALERT_SOURCE);
    }
    lastNotifiedKey = '';
    if (options.logAllCurrent !== false) {
      log.info({}, 'model currency check: all configured models current');
    }
    return;
  }

  for (const a of advisories) {
    const line = { role: a.role, model: a.model, recommended: a.recommended, retiresAt: a.retiresAt };
    if (a.level === 'upgrade-available') log.info(line, a.message);
    else log.warn(line, a.message);
  }

  if (key === lastNotifiedKey) return; // already alerted on this exact set
  lastNotifiedKey = key;

  const severity = advisories.some((a) => a.level !== 'upgrade-available') ? 'warning' : 'info';
  const summary = `[${severity}] model updates available (${advisories.length}): ` + advisories
    .map((a) => `${a.role}=${a.model} → ${a.recommended ?? '?'} [${a.level}]`)
    .join('; ');
  emitAlertChecked(instance, ALERT_SOURCE, summary, JSON.stringify(advisories), severity);
}

export function notifyModelLiveScanStatus(instance: string, liveScan: LiveModelScanStatus): void {
  cachedLiveScan = liveScan;

  if (liveScan.degradedVendors.length === 0) {
    if (lastLiveScanFailureKey !== null && lastLiveScanFailureKey !== '') {
      clearAlertSourceChecked(instance, LIVE_SCAN_ALERT_SOURCE);
    }
    lastLiveScanFailureKey = '';
    return;
  }

  const key = liveScan.degradedVendors
    .map((failure) => `${failure.vendor}:${failure.status ?? ''}:${failure.reason}`)
    .sort()
    .join('|');
  if (key === lastLiveScanFailureKey) return;
  lastLiveScanFailureKey = key;

  const summary = '[warning] model currency live scan degraded: ' + liveScan.degradedVendors
    .map((failure) => `${failure.vendor}=${failure.reason}`)
    .join('; ') + '; static catalog fallback in use';
  log.warn({ liveScan }, 'model currency live scan degraded');
  emitAlertChecked(instance, LIVE_SCAN_ALERT_SOURCE, summary, JSON.stringify(liveScan), 'warning');
}

export function notifyModelCurrencyResult(instance: string, result: ModelCurrencyCheckResult): void {
  notifyModelAdvisories(instance, result.advisories, {
    logAllCurrent: result.liveScan.mode !== 'degraded',
  });
  notifyModelLiveScanStatus(instance, result.liveScan);
}

/**
 * Run the currency check now and then daily. Non-blocking; errors are
 * logged and swallowed — model advisories must never affect availability.
 */
export function startModelCurrencyMonitor(
  instance: string,
  models: Record<string, string | undefined>,
): void {
  const run = async (): Promise<void> => {
    try {
      notifyModelCurrencyResult(instance, await checkModelCurrencyStatus(models));
    } catch (err) {
      const reason = errorMessage(err);
      log.warn({ err: reason }, 'model currency check failed');
    }
  };
  void run();
  setInterval(() => { void run(); }, CHECK_INTERVAL_MS).unref();
}
