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
 * Everything here is advisory and fail-open: network errors, missing keys,
 * and unrecognized model IDs all degrade to silence, never to a blocked
 * startup. Notifications ride the existing BOT_ERRORS alert pipeline
 * (emit-alert.ts) so operators see them where every other incident lands.
 */
import { createChildLogger } from '../logger.ts';
import { emitAlert, clearAlertSource } from './emit-alert.ts';
import { adviseModel, type ModelAdvisory } from './model-catalog.ts';

const log = createChildLogger('model-advisor');

const ALERT_SOURCE = 'model-currency';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;

let cachedAdvisories: ModelAdvisory[] = [];
let lastCheckedAt: string | null = null;
// Dedupe key of the last advisory set we alerted on — re-alert only when the
// set changes (and once per process start), not on every daily re-check.
let lastNotifiedKey: string | null = null;

/** Snapshot for the /health endpoint. */
export function getModelAdvisories(): { checkedAt: string | null; advisories: ModelAdvisory[] } {
  return { checkedAt: lastCheckedAt, advisories: cachedAdvisories };
}

/** Test-only: reset module state between cases. */
export function __resetModelAdvisorForTest(): void {
  cachedAdvisories = [];
  lastCheckedAt = null;
  lastNotifiedKey = null;
}

interface ModelsListResponse {
  data?: Array<{ id?: unknown }>;
}

async function fetchModelIds(
  url: string,
  headers: Record<string, string>,
  vendor: string,
): Promise<string[]> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      log.debug({ vendor, status: res.status }, 'models API returned non-OK; using static catalog');
      return [];
    }
    const body = (await res.json()) as ModelsListResponse;
    const ids = (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string');
    log.debug({ vendor, count: ids.length }, 'live model list fetched');
    return ids;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.debug({ vendor, err: reason }, 'models API unreachable; using static catalog');
    return [];
  }
}

/** Fetch currently-served model IDs from vendors we have credentials for. */
export async function fetchLiveModelIds(): Promise<string[]> {
  const fetches: Promise<string[]>[] = [];
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    fetches.push(fetchModelIds(
      'https://api.anthropic.com/v1/models?limit=100',
      { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      'anthropic',
    ));
  }
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    fetches.push(fetchModelIds(
      'https://api.openai.com/v1/models',
      { Authorization: `Bearer ${openaiKey}` },
      'openai',
    ));
  }
  return (await Promise.all(fetches)).flat();
}

/**
 * Check every configured role→model pair and return advisories for the ones
 * that are behind, deprecated, or retired. Roles with empty values are skipped.
 */
export async function checkModelCurrency(
  models: Record<string, string | undefined>,
): Promise<ModelAdvisory[]> {
  const liveIds = await fetchLiveModelIds();
  const advisories: ModelAdvisory[] = [];
  for (const [role, modelId] of Object.entries(models)) {
    if (!modelId || modelId.trim() === '') continue;
    const advisory = adviseModel(modelId, liveIds);
    if (advisory) advisories.push({ ...advisory, role });
  }
  return advisories;
}

/**
 * Record advisories (for /health) and notify operators through the
 * BOT_ERRORS pipeline. Deprecated/retired models alert at 'warning';
 * pure upgrade availability alerts at 'info'. The alert source is cleared
 * once a previously-flagged config comes back clean.
 */
export function notifyModelAdvisories(instance: string, advisories: ModelAdvisory[]): void {
  cachedAdvisories = advisories;
  lastCheckedAt = new Date().toISOString();

  const key = advisories
    .map((a) => `${a.role}:${a.model}:${a.level}:${a.recommended ?? ''}`)
    .sort()
    .join('|');

  if (advisories.length === 0) {
    if (lastNotifiedKey !== null && lastNotifiedKey !== '') {
      clearAlertSource(instance, ALERT_SOURCE);
    }
    lastNotifiedKey = '';
    log.info({}, 'model currency check: all configured models current');
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
  emitAlert(instance, ALERT_SOURCE, summary, JSON.stringify(advisories));
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
      notifyModelAdvisories(instance, await checkModelCurrency(models));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn({ err: reason }, 'model currency check failed');
    }
  };
  void run();
  setInterval(() => { void run(); }, CHECK_INTERVAL_MS).unref();
}
