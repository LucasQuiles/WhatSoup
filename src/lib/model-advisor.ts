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
import { errorMessage } from './error-message.ts';

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
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    attemptedVendors.push('anthropic');
    fetches.push(fetchModelIds(
      'https://api.anthropic.com/v1/models?limit=100',
      { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      'anthropic',
    ));
  }
  const openaiKey = process.env.OPENAI_API_KEY;
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
  const { ids: liveIds, liveScan } = await fetchLiveModelIdsWithStatus();
  const advisories: ModelAdvisory[] = [];
  for (const [role, modelId] of Object.entries(models)) {
    if (!modelId || modelId.trim() === '') continue;
    const advisory = adviseModel(modelId, liveIds);
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
