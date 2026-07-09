import { createChildLogger } from '../logger.ts';
import { clearAlertSourceChecked, emitAlertChecked } from '../lib/emit-alert.ts';
import type { BotErrorsCriticalAssetDiagnostic } from '../lib/bot-errors-outbox.ts';
// Aliased to keep this module's call sites unchanged (asRecord returns
// `undefined` for non-records; the one null-typed seam adapts with `?? null`).
import { asRecord } from '../lib/type-guards.ts';
import { sqliteUtcToEpochMs } from '../lib/sqlite-time.ts';
import { ALERT_THROTTLE_INTERVAL_MS, loadAlertThrottleDetailed, recordAlertThrottle } from './alert-throttle-store.ts';
import { isInstanceSilenced } from './silence-manager.ts';
import { hasExplicitAuthLossSignal } from './auth-loss-signals.ts';
import { classifyProviderReauthSignal, providerReauthClearProof } from './provider-reauth-signal.ts';
import { jidPattern } from '../lib/redaction-patterns.ts';

const log = createChildLogger('fleet:health-poller');

const MIN_ALERT_INTERVAL_MS = ALERT_THROTTLE_INTERVAL_MS;
const TERMINAL_AUTH_FAILURE_CLASSES = new Set([
  'pairing_required',
  'serverside_logout_irreversible',
]);
const WEAK_LOGGED_OUT_POLLS = 3;
const LOGGED_OUT_SETTLE_GRACE_SECONDS = 60;
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const INSTANCE_UNREACHABLE_ALERT_DWELL_MS = readNonNegativeEnvInt(
  'WHATSOUP_INSTANCE_UNREACHABLE_ALERT_DWELL_MS',
  30_000,
);
const HEALTH_BODY_DEGRADED_ALERT_POLLS = Math.max(1, readNonNegativeEnvInt(
  'WHATSOUP_HEALTH_BODY_DEGRADED_ALERT_POLLS',
  2,
));
const HEALTH_BODY_DEGRADED_ALERT_DWELL_MS = readNonNegativeEnvInt(
  'WHATSOUP_HEALTH_BODY_DEGRADED_ALERT_DWELL_MS',
  10_000,
);
const HEALTH_PROBE_TIMEOUT_UNDER_PROXY_LOAD = 'health_probe_timeout_under_proxy_load';
const ALERT_SOURCES_SUPERSEDED_BY_LOGGED_OUT = new Set([
  'health_body_degraded',
  'health_probe_auth_failed',
  'instance_degraded',
  'instance_never_reachable',
  'instance_unreachable',
]);
const KEYED_PHONE_RE = /\b(phone|phone[_-]?number|msisdn|line)(\s*[:=]\s*|\s+)(\+?\d{10,16})\b/gi;
const CONTEXT_PHONE_RE = /\b(for)(\s+)(\+?\d{10,16})\b/gi;
const PHONE_LIKE_RE = /(^|[^\w])(\+?(?:\d[\d\s().-]{8,}\d))(?![\w])/g;
const BEARER_SECRET_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi;
const KEYED_SECRET_RE = /\b(token|secret|password|passphrase|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|authorization|cookie)=([^\s,;]+)/gi;
const PEM_PRIVATE_KEY_RE = /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g;

function readNonNegativeEnvInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export interface InstanceHealth {
  name: string;
  type: string;
  accessMode: string;
  healthPort: number;
  healthToken: string | null;
}

export interface InstanceStatus {
  name: string;
  health: Record<string, unknown> | null;
  lastPollAt: string;
  consecutiveFailures: number;
  everReachable: boolean;
  status: 'online' | 'degraded' | 'unreachable' | 'logged_out';
  statusConfidence: 'confirmed' | 'inferred' | 'ambiguous';
  statusReason: string;
  statusEvidence: string[];
  error: string | null;
  lastAlertAt: string | null;
  silencedUntil: string | null;
  activeAlertSources: string[];
}

export type StatusChangeCallback = (instance: string, newStatus: InstanceStatus['status'], oldStatus: InstanceStatus['status']) => void;


type StatusConfidence = InstanceStatus['statusConfidence'];

export const LOGGED_OUT_CONFIRMATION_CONTRACT = Object.freeze({
  requiredFields: Object.freeze([
    'confirmed',
    'weak',
    'reason',
    'failureCode',
    'confidence',
    'evidence',
  ] as const),
  reasons: Object.freeze([
    'explicit_auth_loss',
    'connected',
    'not_weak_signal',
    'weak_signal_inside_settle_grace',
    'weak_signal_waiting_for_persistence',
    'weak_signal_persisted',
  ] as const),
  failureCodes: Object.freeze([
    'WA_AUTH_BOND_SERVER_REVOKED',
    'WEAK_LOGGED_OUT_SIGNAL',
    'NONE',
  ] as const),
} as const);

export type LoggedOutConfirmationReason = typeof LOGGED_OUT_CONFIRMATION_CONTRACT.reasons[number];
export type LoggedOutFailureCode = typeof LOGGED_OUT_CONFIRMATION_CONTRACT.failureCodes[number];
type LoggedOutAlertFailureCode = Exclude<LoggedOutFailureCode, 'NONE'>;

export interface LoggedOutConfirmation {
  confirmed: boolean;
  weak: boolean;
  reason: LoggedOutConfirmationReason;
  failureCode: LoggedOutFailureCode;
  confidence: InstanceStatus['statusConfidence'];
  evidence: string;
}

interface HealthSnapshotClassification {
  status: 'online' | 'degraded' | 'logged_out';
  confidence: StatusConfidence;
  reason: string;
  evidence: string[];
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function evidenceField(name: string, value: unknown): string {
  if (value === undefined || value === null || value === '') return `${name}=unknown`;
  return `${name}=${String(value)}`;
}

function classifyHealthSnapshot(health: Record<string, unknown>): HealthSnapshotClassification {
  const healthStatus = stringValue(health.status);
  const whatsapp = asRecord(health.whatsapp);
  const connected = booleanValue(whatsapp?.connected);
  const accountJid = stringValue(whatsapp?.account_jid);
  const connection = asRecord(whatsapp?.connection);
  const connectionState = stringValue(connection?.state);
  const reconnectPhase = stringValue(connection?.reconnect_phase);
  const reconnectAttempts = numberValue(connection?.reconnect_attempts);
  const lastDisconnectReason = stringValue(connection?.last_disconnect_reason);
  const lastStatusCode = numberValue(connection?.last_status_code);
  const authFailureClass = stringValue(connection?.auth_failure_class);
  const recentDisconnects = asRecord(connection?.recent_disconnects);
  const recentDisconnectCount = numberValue(recentDisconnects?.count);
  const recentDisconnectThreshold = numberValue(recentDisconnects?.degraded_threshold);
  const recentDisconnectWindowMs = numberValue(recentDisconnects?.window_ms);
  const recentDisconnectLastAt = stringValue(recentDisconnects?.last_at);
  const recentDisconnectLastReason = stringValue(recentDisconnects?.last_reason);
  const recentDisconnectLastStatusCode = numberValue(recentDisconnects?.last_status_code);
  const accountJidStatus = accountJid === null
    ? 'missing'
    : accountJid === 'not connected'
      ? 'not_connected'
      : 'present';

  const baseEvidence = [
    evidenceField('health_status', healthStatus),
    evidenceField('whatsapp_connected', connected),
    evidenceField('account_jid_status', accountJidStatus),
    evidenceField('connection_state', connectionState),
    evidenceField('reconnect_phase', reconnectPhase),
    evidenceField('reconnect_attempts', reconnectAttempts),
    evidenceField('last_disconnect_reason', lastDisconnectReason),
    evidenceField('last_status_code', lastStatusCode),
    evidenceField('auth_failure_class', authFailureClass),
    evidenceField('recent_disconnect_count', recentDisconnectCount),
    evidenceField('recent_disconnect_threshold', recentDisconnectThreshold),
    evidenceField('recent_disconnect_window_ms', recentDisconnectWindowMs),
    evidenceField('recent_disconnect_last_at', recentDisconnectLastAt),
    evidenceField('recent_disconnect_last_reason', recentDisconnectLastReason),
    evidenceField('recent_disconnect_last_status_code', recentDisconnectLastStatusCode),
  ];

  const staleReconnectHint = connected === true && accountJidStatus === 'present' && connectionState === 'connected';
  const loggedOutHeuristic = reconnectPhase === 'backoff' && reconnectAttempts === 0 && !staleReconnectHint;
  const disconnectedCorroboration =
    connected === false ||
    accountJid === 'not connected' ||
    connectionState === 'disconnected' ||
    healthStatus === 'unhealthy';
  const explicitAuthLossSignal =
    hasExplicitAuthLossSignal({ lastStatusCode, lastDisconnectReason, authFailureClass });

  if (loggedOutHeuristic && disconnectedCorroboration && explicitAuthLossSignal) {
    return {
      status: 'logged_out',
      confidence: 'confirmed',
      reason: 'whatsapp_auth_loss_with_disconnect_corroboration',
      evidence: baseEvidence,
    };
  }

  if (loggedOutHeuristic && disconnectedCorroboration) {
    return {
      status: 'degraded',
      confidence: 'ambiguous',
      reason: 'whatsapp_backoff_zero_attempts_with_disconnect_without_auth_loss_signal',
      evidence: baseEvidence,
    };
  }

  if (loggedOutHeuristic) {
    return {
      status: 'degraded',
      confidence: 'ambiguous',
      reason: 'whatsapp_backoff_zero_attempts_without_disconnect_corroboration',
      evidence: baseEvidence,
    };
  }

  if (healthStatus === 'unhealthy') {
    return {
      status: 'degraded',
      confidence: 'confirmed',
      reason: 'health_body_unhealthy',
      evidence: baseEvidence,
    };
  }

  if (healthStatus === 'degraded') {
    return {
      status: 'degraded',
      confidence: 'confirmed',
      reason: 'health_body_degraded',
      evidence: baseEvidence,
    };
  }

  return {
    status: 'online',
    confidence: 'confirmed',
    reason: 'health_body_ok',
    evidence: baseEvidence,
  };
}

function isNonOnlineClassification(
  classification: HealthSnapshotClassification,
): classification is HealthSnapshotClassification & { status: 'degraded' | 'logged_out' } {
  return classification.status !== 'online';
}

function classificationEvidenceText(classification: HealthSnapshotClassification): string {
  return [`confidence=${classification.confidence}`, `reason=${classification.reason}`, ...classification.evidence].join(' ');
}

export class HealthPoller {
  private statuses: Map<string, InstanceStatus> = new Map();
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private getInstances: () => Map<string, InstanceHealth>;
  private selfName: string;
  private getSelfHealth: () => Record<string, unknown>;
  private intervalMs: number;
  private statusChangeListeners: StatusChangeCallback[] = [];
  private persistedAlertThrottle: Map<string, string>;
  private alertThrottleLoadErrorCode: string | null;
  private weakLoggedOutPolls: Map<string, number> = new Map();
  private failureStartedAt: Map<string, number> = new Map();
  private healthBodyDegradedStartedAt: Map<string, number> = new Map();
  private healthBodyDegradedPolls: Map<string, number> = new Map();
  private unreachableAlerted: Set<string> = new Set();
  private targetPids: Map<string, number> = new Map();

  constructor(
    getInstances: () => Map<string, InstanceHealth>,
    selfName: string,
    getSelfHealth: () => Record<string, unknown>,
    intervalMs = 5_000,
  ) {
    this.getInstances = getInstances;
    this.selfName = selfName;
    this.getSelfHealth = getSelfHealth;
    this.intervalMs = intervalMs;
    const throttle = loadAlertThrottleDetailed();
    this.persistedAlertThrottle = throttle.entries;
    this.alertThrottleLoadErrorCode = throttle.loadError?.code ?? (throttle.loadError ? 'UNKNOWN' : null);
  }

  /** Register a callback for instance status changes. */
  on(event: 'statusChange', callback: StatusChangeCallback): void {
    if (event === 'statusChange') this.statusChangeListeners.push(callback);
  }

  private emitStatusChange(instance: string, newStatus: InstanceStatus['status'], oldStatus: InstanceStatus['status']): void {
    for (const cb of this.statusChangeListeners) {
      try {
        cb(instance, newStatus, oldStatus);
      } catch (err) {
        log.warn({ err, instance, newStatus, oldStatus }, 'status change listener failed');
      }
    }
  }

  /**
   * Start polling. Returns a Promise that resolves once the initial poll
   * completes, so callers (especially tests) can await deterministic readiness
   * instead of sleeping. Subsequent polls are fire-and-forget on the interval.
   */
  start(): Promise<void> {
    if (this.pollInterval) return Promise.resolve();
    const initial = this.poll(); // initial poll
    this.pollInterval = setInterval(() => this.poll(), this.intervalMs);
    this.pollInterval.unref();
    return initial;
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  getStatuses(): Map<string, InstanceStatus> {
    return this.statuses;
  }

  getStatus(name: string): InstanceStatus | undefined {
    return this.statuses.get(name);
  }

  private alertThrottleKey(name: string, source: string): string {
    return `${name}:${source}`;
  }

  private lastAlertAtFor(name: string, existing: InstanceStatus | undefined): string | null {
    if (existing?.lastAlertAt) return existing.lastAlertAt;
    let latest = this.persistedAlertThrottle.get(name) ?? null;
    const prefix = `${name}:`;
    for (const [key, value] of this.persistedAlertThrottle.entries()) {
      if (!key.startsWith(prefix)) continue;
      if (latest === null || new Date(value).getTime() > new Date(latest).getTime()) {
        latest = value;
      }
    }
    return latest;
  }

  private async poll(): Promise<void> {
    const instances = this.getInstances();

    const promises = Array.from(instances.entries()).map(async ([name, inst]) => {
      if (name === this.selfName) {
        // Self-instance: use callback, no HTTP. The snapshot is classified
        // with the SAME semantics as a remote payload — forcing 'online'
        // here hid degraded/logged-out states the instance reported about
        // itself.
        try {
          const health = this.getSelfHealth();
          const classification = classifyHealthSnapshot(health);
          if (isNonOnlineClassification(classification)) {
            this.updateFromHealthSnapshot(name, health, classification);
            return;
          }
          const existing = this.statuses.get(name);
          this.statuses.set(name, {
            name,
            health,
            lastPollAt: new Date().toISOString(),
            consecutiveFailures: 0,
            everReachable: true,
            status: 'online',
            statusConfidence: 'confirmed',
            statusReason: 'self_health_callback',
            statusEvidence: ['self_health_callback=ok'],
            error: null,
            lastAlertAt: this.lastAlertAtFor(name, existing),
            silencedUntil: existing?.silencedUntil ?? null,
            activeAlertSources: [],
          });
        } catch (err) {
          this.updateFailure(name, (err as Error).message);
        }
        return;
      }

      // Remote instance: HTTP poll
      let reached = false;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3_000);

        const headers: Record<string, string> = {};
        if (inst.healthToken) {
          headers['Authorization'] = `Bearer ${inst.healthToken}`;
        }

        let health: Record<string, unknown>;
        try {
          const res = await fetch(`http://127.0.0.1:${inst.healthPort}/health`, {
            signal: controller.signal,
            headers,
          });
          reached = true;

          if (!res.ok) {
            const failureHealth = await this.readHealthBody(res);
            if (res.status === 401 || res.status === 403) {
              this.updateDegraded(
                name,
                failureHealth ?? { status: 'degraded' },
                'degraded',
                `health_probe_auth_failed http_status=${res.status} health_port=${inst.healthPort}`,
                true,
                'health_probe_auth_failed',
                `whatsoup@${name} health probe auth failed`,
              );
              return;
            }
            if (failureHealth !== null) {
              const loggedOutSignal = this.classifyLoggedOutSignal(name, failureHealth);
              if (loggedOutSignal.confirmed) {
                this.updateLoggedOutFromConfirmation(name, failureHealth, loggedOutSignal);
                return;
              }
              const failureProviderReauth = classifyProviderReauthSignal(failureHealth);
              if (failureProviderReauth.confirmed) {
                this.updateDegraded(
                  name, failureHealth, 'degraded',
                  failureProviderReauth.evidence.join(' '), true,
                  'provider_reauth_required',
                  `whatsoup@${name} primary provider needs re-authentication`,
                  true, false, 'confirmed', 'provider_reauth_required',
                  failureProviderReauth.evidence,
                );
                return;
              }
              const classification = classifyHealthSnapshot(failureHealth);
              if (isNonOnlineClassification(classification)) {
                this.updateFromHealthSnapshot(name, failureHealth, classification);
                return;
              }
            }
            this.updateFailure(name, `HTTP ${res.status}`, true);
            return;
          }

          health = (await res.json()) as Record<string, unknown>;
        } finally {
          clearTimeout(timeout);
        }

        const loggedOutSignal = this.classifyLoggedOutSignal(name, health);
        const classification = classifyHealthSnapshot(health);

        const healthStatus = typeof health['status'] === 'string' ? health['status'] : '';

        // HTTP 200 but body signals degraded/unhealthy → treat as degraded
        if (loggedOutSignal.confirmed) {
          this.updateLoggedOutFromConfirmation(name, health, loggedOutSignal);
          return;
        }
        if (classification.status === 'logged_out') {
          this.updateFromHealthSnapshot(name, health, classification);
          return;
        }

        // WS-ALERT (spec §2): a confirmed provider-reauth body must page as its
        // own critical source, not fall into the generic health_body_degraded
        // path (which the dispatcher tiers as transient while WhatsApp stays
        // connected — the exact mechanism that buried the mini10 outage).
        const providerReauth = classifyProviderReauthSignal(health);
        if (providerReauth.confirmed) {
          this.updateDegraded(
            name,
            health,
            'degraded',
            providerReauth.evidence.join(' '),
            true,
            'provider_reauth_required',
            `whatsoup@${name} primary provider needs re-authentication`,
            true,
            false,
            'confirmed',
            'provider_reauth_required',
            providerReauth.evidence,
          );
          return;
        }
        this.maybeClearProviderReauth(name, health); // degraded-flow clear (Task 12)

        if (healthStatus === 'unhealthy' || healthStatus === 'degraded') {
          const degradedEvidence = `Health body reports status=${healthStatus}`;
          const degradedAlert = healthStatus === 'degraded'
            ? this.shouldAlertHealthBodyDegraded(name, health, degradedEvidence)
            : { shouldAlert: true, evidence: degradedEvidence };
          this.updateDegraded(
            name,
            health,
            'degraded',
            degradedAlert.evidence,
            !loggedOutSignal.weak,
            healthStatus === 'degraded' ? 'health_body_degraded' : 'instance_degraded',
            healthStatus === 'degraded' ? `whatsoup@${name} health is degraded` : undefined,
            healthStatus === 'degraded' ? degradedAlert.shouldAlert : true,
            false,
            classification.confidence,
            classification.reason,
            classification.evidence,
          );
          return;
        }

        if (classification.status === 'degraded') {
          this.updateFromHealthSnapshot(name, health, classification);
          return;
        }

        const existing = this.statuses.get(name);
        const prevStatus = existing?.status ?? 'online';
        this.trackTargetPid(name, health);
        this.weakLoggedOutPolls.delete(name);
        this.failureStartedAt.delete(name);
        this.resetHealthBodyDegradedDebounce(name);
        this.statuses.set(name, {
          name,
          health,
          lastPollAt: new Date().toISOString(),
          consecutiveFailures: 0,
          everReachable: true,
          status: 'online',
          statusConfidence: classification.confidence,
          statusReason: classification.reason,
          statusEvidence: classification.evidence,
          error: null,
          lastAlertAt: this.lastAlertAtFor(name, existing),
          silencedUntil: existing?.silencedUntil ?? null,
          activeAlertSources: existing?.activeAlertSources ?? [],
        });
        if (prevStatus !== 'online') {
          this.emitStatusChange(name, 'online', prevStatus);
          this.clearRecoveredAlert(name, existing, health);
        } else if (existing?.activeAlertSources.length) {
          this.clearRecoveredAlert(name, existing, health);
        }
      } catch (err) {
        this.updateProbeFailure(name, inst, err as Error, reached);
      }
    });

    await Promise.allSettled(promises);

    const discoveredNames = new Set(instances.keys());
    for (const name of this.statuses.keys()) {
      if (!discoveredNames.has(name)) {
        this.statuses.delete(name);
        this.targetPids.delete(name);
        this.resetHealthBodyDegradedDebounce(name);
      }
    }
  }

  private async readHealthBody(res: Response): Promise<Record<string, unknown> | null> {
    try {
      const parsed = await res.json();
      return asRecord(parsed) ?? null;
    } catch (err) {
      log.debug({ err }, 'readHealthBody: JSON parse failed; returning null');
      return null;
    }
  }

  private classifyLoggedOutSignal(name: string, health: Record<string, unknown>): LoggedOutConfirmation {
    const whatsapp = this.readRecord(health['whatsapp']);
    const connection = this.readRecord(whatsapp?.['connection']);
    const connected = whatsapp?.['connected'] === true && connection?.['state'] === 'connected';
    const lastStatusCode = connection?.['last_status_code'];
    const lastReason = String(connection?.['last_disconnect_reason'] ?? '');
    const authFailureClass = typeof connection?.['auth_failure_class'] === 'string'
      ? connection['auth_failure_class']
      : '';
    const disconnectClass = typeof connection?.['disconnect_class'] === 'string'
      ? connection['disconnect_class']
      : '';
    const reconnectPhase = connection?.['reconnect_phase'];
    const reconnectAttempts = connection?.['reconnect_attempts'];
    const uptimeSeconds = this.readNumber(health['uptime_seconds']);

    const explicit =
      TERMINAL_AUTH_FAILURE_CLASSES.has(authFailureClass) ||
      lastStatusCode === 401 ||
      lastStatusCode === '401' ||
      lastReason === 'loggedOut' ||
      lastReason.includes('device_removed');
    if (explicit) {
      this.weakLoggedOutPolls.delete(name);
      return {
        confirmed: true,
        weak: false,
        reason: 'explicit_auth_loss',
        failureCode: 'WA_AUTH_BOND_SERVER_REVOKED',
        confidence: 'confirmed',
        evidence: this.loggedOutEvidence(health, [
          `connected=${String(whatsapp?.['connected'])}`,
          `state=${String(connection?.['state'] ?? 'unknown')}`,
          `disconnect_class=${disconnectClass || 'unknown'}`,
          `auth_failure_class=${authFailureClass || 'unknown'}`,
          `last_status_code=${String(lastStatusCode ?? 'unknown')}`,
          `last_disconnect_reason=${lastReason || 'unknown'}`,
          `reconnect_phase=${String(reconnectPhase ?? 'unknown')}`,
          `reconnect_attempts=${String(reconnectAttempts ?? 'unknown')}`,
        ]),
      };
    }

    if (connected) {
      this.weakLoggedOutPolls.delete(name);
      return {
        confirmed: false,
        weak: false,
        reason: 'connected',
        failureCode: 'NONE',
        confidence: 'confirmed',
        evidence: '',
      };
    }

    const weak = reconnectPhase === 'backoff' && reconnectAttempts === 0;
    if (!weak) {
      this.weakLoggedOutPolls.delete(name);
      return {
        confirmed: false,
        weak: false,
        reason: 'not_weak_signal',
        failureCode: 'NONE',
        confidence: 'confirmed',
        evidence: '',
      };
    }

    if (uptimeSeconds === null || uptimeSeconds < LOGGED_OUT_SETTLE_GRACE_SECONDS) {
      this.weakLoggedOutPolls.delete(name);
      log.info({ name, uptimeSeconds }, 'weak logged-out signal observed inside settle grace; waiting');
      return {
        confirmed: false,
        weak: true,
        reason: 'weak_signal_inside_settle_grace',
        failureCode: 'WEAK_LOGGED_OUT_SIGNAL',
        confidence: 'ambiguous',
        evidence: '',
      };
    }

    const samples = (this.weakLoggedOutPolls.get(name) ?? 0) + 1;
    this.weakLoggedOutPolls.set(name, samples);
    if (samples < WEAK_LOGGED_OUT_POLLS) {
      log.info({ name, samples, uptimeSeconds }, 'weak logged-out signal observed; waiting for persistence');
      return {
        confirmed: false,
        weak: true,
        reason: 'weak_signal_waiting_for_persistence',
        failureCode: 'WEAK_LOGGED_OUT_SIGNAL',
        confidence: 'ambiguous',
        evidence: '',
      };
    }

    return {
      confirmed: true,
      weak: true,
      reason: 'weak_signal_persisted',
      failureCode: 'WEAK_LOGGED_OUT_SIGNAL',
      confidence: 'inferred',
      evidence: this.loggedOutEvidence(health, [
        `connected=${String(whatsapp?.['connected'])}`,
        `state=${String(connection?.['state'] ?? 'unknown')}`,
        `disconnect_class=${disconnectClass || 'unknown'}`,
        `reconnect_phase=backoff`,
        `reconnect_attempts=0`,
        `uptime_seconds=${uptimeSeconds === null ? 'unknown' : String(uptimeSeconds)}`,
        `weak_signal_polls=${samples}`,
      ]),
    };
  }

  private loggedOutEvidence(health: Record<string, unknown>, base: string[]): string {
    const whatsapp = this.readRecord(health['whatsapp']);
    const lifecycle = this.readRecord(whatsapp?.['credential_lifecycle']);
    const healthAuthBond = this.readRecord(whatsapp?.['auth_bond']);
    const lifecycleAuthBond = this.readRecord(lifecycle?.['currentAuthBond']);
    const evidence = [...base];
    this.pushEvidenceField(evidence, 'health_status', health['status']);
    this.pushEvidenceField(evidence, 'uptime_seconds', health['uptime_seconds']);
    this.appendLifecycleEvidence(evidence, lifecycle);
    this.appendAuthBondEvidence(evidence, healthAuthBond ?? lifecycleAuthBond);
    return this.uniqueEvidence(evidence).join(' ');
  }

  private updateLoggedOutFromConfirmation(
    name: string,
    health: Record<string, unknown>,
    confirmation: LoggedOutConfirmation,
  ): void {
    this.updateDegraded(
      name,
      health,
      'logged_out',
      confirmation.evidence,
      true,
      'instance_logged_out',
      undefined,
      true,
      confirmation.weak,
      confirmation.confidence,
      'instance_logged_out',
      confirmation.evidence.split(/\s+/).filter(Boolean),
      this.loggedOutAlertFailureCode(confirmation),
    );
  }

  private loggedOutAlertFailureCode(confirmation: LoggedOutConfirmation): LoggedOutAlertFailureCode {
    return confirmation.failureCode === 'NONE'
      ? 'WA_AUTH_BOND_SERVER_REVOKED'
      : confirmation.failureCode;
  }

  private shouldEmitLoggedOutAlert(
    name: string,
    prevStatus: InstanceStatus['status'],
    existing: InstanceStatus | undefined,
    loggedOutWeak: boolean,
    loggedOutFailureCode: LoggedOutAlertFailureCode,
  ): boolean {
    if (prevStatus !== 'logged_out') return true;
    if (!this.hasConfirmedAlert(name, 'instance_logged_out')) return true;
    return (
      existing?.status === 'logged_out'
      && existing.statusConfidence !== 'confirmed'
      && !loggedOutWeak
      && loggedOutFailureCode === 'WA_AUTH_BOND_SERVER_REVOKED'
    );
  }

  private appendLifecycleEvidence(evidence: string[], lifecycle: Record<string, unknown> | null): void {
    if (!lifecycle) return;
    this.pushEvidenceField(evidence, 'baileys_version', lifecycle['latestBaileysVersion']);
    this.pushEvidenceField(evidence, 'lifecycle_connect_started_at', lifecycle['connectStartedAt']);
    this.pushEvidenceField(evidence, 'lifecycle_last_open_at', lifecycle['lastOpenAt']);
    this.pushEvidenceField(evidence, 'lifecycle_last_close_at', lifecycle['lastCloseAt']);
    this.pushEvidenceField(evidence, 'lifecycle_last_qr_at', lifecycle['lastQrAt']);
    this.pushEvidenceField(evidence, 'lifecycle_last_creds_update_at', lifecycle['lastCredsUpdateAt']);
    this.pushEvidenceField(evidence, 'lifecycle_last_creds_update_failed_at', lifecycle['lastCredsUpdateFailedAt']);
    this.pushEvidenceField(evidence, 'lifecycle_last_auth_snapshot_at', lifecycle['lastAuthSnapshotAt']);
    this.pushEvidenceField(evidence, 'lifecycle_last_auth_snapshot_failed_at', lifecycle['lastAuthSnapshotFailedAt']);
    this.pushEvidenceField(evidence, 'lifecycle_creds_update_count', lifecycle['credsUpdateCount']);
    this.pushEvidenceField(evidence, 'lifecycle_auth_snapshot_count', lifecycle['authSnapshotCaptureCount']);
    this.pushEvidenceField(evidence, 'lifecycle_auth_snapshot_failure_count', lifecycle['authSnapshotFailureCount']);

    const environment = this.readRecord(lifecycle['environment']);
    this.pushEvidenceField(evidence, 'lifecycle_host', environment?.['host']);
    this.pushEvidenceField(evidence, 'lifecycle_pid', environment?.['pid']);
    this.pushEvidenceField(evidence, 'lifecycle_node_version', environment?.['nodeVersion']);
    this.pushEvidenceField(evidence, 'lifecycle_platform', environment?.['platform']);
    this.pushEvidenceField(evidence, 'lifecycle_arch', environment?.['arch']);
    this.pushEvidenceField(evidence, 'lifecycle_process_uptime_seconds', environment?.['processUptimeSeconds']);
    this.pushEvidenceField(evidence, 'lifecycle_os_uptime_seconds', environment?.['osUptimeSeconds']);
    const memory = this.readRecord(environment?.['memory']);
    this.pushEvidenceField(evidence, 'lifecycle_memory_free_bytes', memory?.['freeBytes']);
    this.pushEvidenceField(evidence, 'lifecycle_memory_total_bytes', memory?.['totalBytes']);

    const lastDisconnect = this.readRecord(lifecycle['lastDisconnectDiagnostic']);
    this.pushEvidenceField(evidence, 'lifecycle_disconnect_status_code', lastDisconnect?.['statusCode']);
    this.pushEvidenceField(evidence, 'lifecycle_disconnect_reason', lastDisconnect?.['reason']);
    this.pushEvidenceField(evidence, 'lifecycle_disconnect_message', lastDisconnect?.['message'], 180);

    const recentEvents = Array.isArray(lifecycle['recentEvents']) ? lifecycle['recentEvents'] : [];
    const events = recentEvents
      .filter((event): event is Record<string, unknown> => this.readRecord(event) !== null)
      .map((event) => event as Record<string, unknown>)
      .slice(-8);
    if (events.length > 0) {
      const names = events
        .map((event) => typeof event['event'] === 'string' ? this.formatEvidenceValue(event['event'], 64) : null)
        .filter((name): name is string => name !== null);
      this.pushEvidenceField(evidence, 'credential_lifecycle_event_count', recentEvents.length);
      if (names.length > 0) evidence.push(`credential_lifecycle_events=${names.join(',')}`);
      const latest = events[events.length - 1];
      this.pushEvidenceField(evidence, 'credential_lifecycle_last_event', latest?.['event']);
      this.pushEvidenceField(evidence, 'credential_lifecycle_last_event_at', latest?.['at']);
      this.pushEvidenceField(evidence, 'credential_lifecycle_last_event_status_code', latest?.['statusCode']);
      this.pushEvidenceField(evidence, 'credential_lifecycle_last_event_reason', latest?.['reason']);
    }
  }

  private appendAuthBondEvidence(evidence: string[], authBond: Record<string, unknown> | null): void {
    if (!authBond) return;
    this.pushEvidenceField(evidence, 'auth_bond_status', authBond['status']);
    const issues = Array.isArray(authBond['issues']) ? authBond['issues'] : [];
    if (issues.length > 0) {
      const formatted = issues
        .map((issue) => this.formatEvidenceValue(issue, 80))
        .filter((issue): issue is string => issue !== null);
      if (formatted.length > 0) evidence.push(`auth_bond_issues=${formatted.slice(0, 8).join(',')}`);
    }

    const authDir = this.readRecord(authBond['auth_dir']) ?? this.readRecord(authBond['authDir']);
    this.pushEvidenceField(evidence, 'auth_bond_auth_dir_exists', authDir?.['exists']);
    this.pushEvidenceField(evidence, 'auth_bond_auth_dir_mode', authDir?.['mode']);
    this.pushEvidenceField(evidence, 'auth_bond_auth_dir_mtime', authDir?.['mtime']);

    const creds = this.readRecord(authBond['creds']);
    this.pushEvidenceField(evidence, 'auth_bond_creds_exists', creds?.['exists']);
    this.pushEvidenceField(evidence, 'auth_bond_creds_mode', creds?.['mode']);
    this.pushEvidenceField(evidence, 'auth_bond_creds_size', creds?.['size']);
    this.pushEvidenceField(evidence, 'auth_bond_creds_mtime', creds?.['mtime']);
    this.pushEvidenceField(evidence, 'auth_bond_creds_hash', creds?.['hash'] ?? creds?.['sha256']);
    this.pushEvidenceField(evidence, 'auth_bond_identity_hash', creds?.['identityHash'] ?? authBond['me_hash'] ?? authBond['meHash']);
    this.pushEvidenceField(evidence, 'auth_bond_creds_empty_hash', creds?.['empty_hash']);
    this.pushEvidenceField(evidence, 'auth_bond_tree_hash', authBond['tree_hash'] ?? authBond['treeHash']);

    const backup = this.readRecord(authBond['backup']);
    const latestBackup = backup?.['latest'];
    if (backup) {
      evidence.push(`auth_bond_backup_latest_present=${String(typeof latestBackup === 'string' && latestBackup.length > 0)}`);
      this.pushEvidenceField(evidence, 'auth_bond_backup_latest_at', backup['latest_at'] ?? backup['latestAt']);
      this.pushEvidenceField(evidence, 'auth_bond_backup_latest_reason', backup['latest_reason'] ?? backup['latestReason']);
      this.pushEvidenceField(evidence, 'auth_bond_backup_latest_tree_hash', backup['latest_tree_hash'] ?? backup['latestTreeHash']);
      this.pushEvidenceField(evidence, 'auth_bond_backup_last_capture_at', backup['last_capture_at'] ?? backup['lastCaptureAt']);
      this.pushEvidenceField(evidence, 'auth_bond_backup_last_capture_reason', backup['last_capture_reason'] ?? backup['lastCaptureReason']);
      this.pushEvidenceField(evidence, 'auth_bond_backup_last_capture_error', backup['last_capture_error'] ?? backup['lastCaptureError'], 180);
      this.pushEvidenceField(evidence, 'auth_bond_backup_last_capture_deferred_at', backup['last_capture_deferred_at'] ?? backup['lastCaptureDeferredAt']);
      this.pushEvidenceField(evidence, 'auth_bond_backup_last_capture_deferred_reason', backup['last_capture_deferred_reason'] ?? backup['lastCaptureDeferredReason']);
      this.pushEvidenceField(evidence, 'auth_bond_backup_last_capture_deferred_age_ms', backup['last_capture_deferred_age_ms'] ?? backup['lastCaptureDeferredAgeMs']);
      this.pushEvidenceField(evidence, 'auth_bond_backup_last_restore_at', backup['last_restore_at'] ?? backup['lastRestoreAt']);
      const restoreSource = backup['last_restore_source'] ?? backup['lastRestoreSource'];
      evidence.push(`auth_bond_backup_last_restore_source_present=${String(typeof restoreSource === 'string' && restoreSource.length > 0)}`);
      this.pushEvidenceField(evidence, 'auth_bond_backup_last_restore_error', backup['last_restore_error'] ?? backup['lastRestoreError'], 180);
    }
  }

  private pushEvidenceField(evidence: string[], key: string, value: unknown, maxLength = 120): void {
    const formatted = this.formatEvidenceValue(value, maxLength);
    if (formatted !== null) evidence.push(`${key}=${formatted}`);
  }

  private formatEvidenceValue(value: unknown, maxLength: number): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
    if (typeof value === 'boolean') return String(value);
    if (typeof value !== 'string') return null;
    const redacted = this.redactEvidenceString(value.trim());
    if (!redacted) return null;
    return redacted
      .replace(/\s+/g, '_')
      .slice(0, maxLength);
  }

  private redactEvidenceString(value: string): string {
    return value
      .replace(PEM_PRIVATE_KEY_RE, '[REDACTED_PRIVATE_KEY]')
      .replace(jidPattern(), '[REDACTED_JID]')
      .replace(KEYED_PHONE_RE, (_match, key: string, sep: string) => `${key}${sep}[REDACTED_PHONE]`)
      .replace(CONTEXT_PHONE_RE, (_match, key: string, sep: string) => `${key}${sep}[REDACTED_PHONE]`)
      .replace(PHONE_LIKE_RE, (match, prefix: string, candidate: string) => {
        const digits = candidate.replace(/\D/g, '');
        const hasPhoneSyntax = candidate.trim().startsWith('+') || /[\s().-]/.test(candidate);
        return hasPhoneSyntax && digits.length >= 10 && digits.length <= 15 ? `${prefix}[REDACTED_PHONE]` : match;
      })
      .replace(BEARER_SECRET_RE, '$1[REDACTED]')
      .replace(KEYED_SECRET_RE, '$1=[REDACTED]');
  }

  private uniqueEvidence(evidence: string[]): string[] {
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const item of evidence) {
      if (seen.has(item)) continue;
      seen.add(item);
      unique.push(item);
    }
    return unique;
  }

  private readNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  }

  private resetHealthBodyDegradedDebounce(name: string): void {
    this.healthBodyDegradedStartedAt.delete(name);
    this.healthBodyDegradedPolls.delete(name);
  }

  private shouldAlertHealthBodyDegraded(
    name: string,
    health: Record<string, unknown>,
    baseEvidence: string,
  ): { shouldAlert: boolean; evidence: string } {
    const now = Date.now();
    const startedAt = this.healthBodyDegradedStartedAt.get(name) ?? now;
    this.healthBodyDegradedStartedAt.set(name, startedAt);
    const polls = (this.healthBodyDegradedPolls.get(name) ?? 0) + 1;
    this.healthBodyDegradedPolls.set(name, polls);
    const dwellMs = now - startedAt;
    const whatsapp = this.readRecord(health['whatsapp']);
    const connection = this.readRecord(whatsapp?.['connection']);
    const evidence = [
      baseEvidence,
      `health_body_degraded_polls=${polls}`,
      `health_body_degraded_dwell_ms=${dwellMs}`,
      `health_body_degraded_required_polls=${HEALTH_BODY_DEGRADED_ALERT_POLLS}`,
      `health_body_degraded_required_dwell_ms=${HEALTH_BODY_DEGRADED_ALERT_DWELL_MS}`,
      `whatsapp_connected=${String(whatsapp?.['connected'] ?? 'unknown')}`,
      `connection_state=${String(connection?.['state'] ?? 'unknown')}`,
    ].join('\n');
    const shouldAlert = polls >= HEALTH_BODY_DEGRADED_ALERT_POLLS
      && dwellMs >= HEALTH_BODY_DEGRADED_ALERT_DWELL_MS;
    if (!shouldAlert) {
      log.info({
        name,
        polls,
        dwellMs,
        requiredPolls: HEALTH_BODY_DEGRADED_ALERT_POLLS,
        requiredDwellMs: HEALTH_BODY_DEGRADED_ALERT_DWELL_MS,
      }, 'health body degraded; waiting for debounce before alert');
    }
    return { shouldAlert, evidence };
  }

  private trackTargetPid(name: string, health: Record<string, unknown>): void {
    const instance = health['instance'];
    const pid = typeof instance === 'object' && instance !== null && !Array.isArray(instance)
      ? this.readNumber((instance as Record<string, unknown>)['pid'])
      : null;
    if (pid !== null && pid > 0) {
      this.targetPids.set(name, Math.floor(pid));
    }
  }

  private targetPidEvidence(name: string): string {
    const pid = this.targetPids.get(name);
    return pid === undefined ? 'target_pid=unknown' : `target_pid=${pid}`;
  }

  private updateFailure(name: string, error: string, reached = false): void {
    const existing = this.statuses.get(name);
    const prevStatus = existing?.status ?? 'online';
    const failures = (existing?.consecutiveFailures ?? 0) + 1;
    const newStatus: InstanceStatus['status'] = failures >= 3 ? 'unreachable' : 'degraded';
    const everReachable = existing?.everReachable === true || reached;
    const firstFailureAt = this.failureStartedAt.get(name) ?? Date.now();
    this.failureStartedAt.set(name, firstFailureAt);
    this.resetHealthBodyDegradedDebounce(name);

    log.warn({ name, failures, error, everReachable }, 'instance health poll failed');
    this.statuses.set(name, {
      name,
      health: existing?.health ?? null,
      lastPollAt: new Date().toISOString(),
      consecutiveFailures: failures,
      everReachable,
      status: newStatus,
      statusConfidence: newStatus === 'unreachable' ? 'confirmed' : 'inferred',
      statusReason: newStatus === 'unreachable' ? 'health_poll_failed_threshold' : 'health_poll_failed_transient',
      statusEvidence: [`consecutive_failures=${failures}`, `error=${error}`],
      error,
      lastAlertAt: this.lastAlertAtFor(name, existing),
      silencedUntil: existing?.silencedUntil ?? null,
      activeAlertSources: existing?.activeAlertSources ?? [],
    });

    // Notify listeners on any status transition
    if (newStatus !== prevStatus) {
      this.emitStatusChange(name, newStatus, prevStatus);
    }

    // Never-reachable is a bootstrap/config signal; keep the existing 3-failure warning.
    if (newStatus === 'unreachable' && !everReachable) {
      const emitted = this.maybeEmitAlert(name, 'instance_never_reachable',
        `whatsoup@${name} has never answered health checks`,
        `Last error: ${error}\n${this.targetPidEvidence(name)}`,
        'warning',
      );
      this.trackActiveAlertSource(name, 'instance_never_reachable', emitted);
      return;
    }

    if (newStatus === 'unreachable' && everReachable && !this.unreachableAlerted.has(name)) {
      const failureAgeMs = Date.now() - firstFailureAt;
      if (failureAgeMs < INSTANCE_UNREACHABLE_ALERT_DWELL_MS) {
        log.info({ name, failures, failureAgeMs, dwellMs: INSTANCE_UNREACHABLE_ALERT_DWELL_MS }, 'instance unreachable; waiting for sustained dwell before alert');
        return;
      }
      const emitted = this.maybeEmitAlert(name, 'instance_unreachable',
        `whatsoup@${name} unreachable (${failures} consecutive poll failures)`,
        `Last error: ${error}\nfailure_age_ms=${failureAgeMs}\ndwell_ms=${INSTANCE_UNREACHABLE_ALERT_DWELL_MS}\n${this.targetPidEvidence(name)}`,
      );
      this.trackActiveAlertSource(name, 'instance_unreachable', emitted);
      if (emitted) this.unreachableAlerted.add(name);
    }
  }

  private updateProbeFailure(name: string, inst: InstanceHealth, err: Error, reached: boolean): void {
    if (this.isProbeAbortBeforeConnect(err, reached)) {
      this.updateProbeStarved(name, inst, err);
      return;
    }
    this.updateFailure(name, err.message, reached);
  }

  private isProbeAbortBeforeConnect(err: Error, reached: boolean): boolean {
    if (reached) return false;
    const message = err.message.toLowerCase();
    return err.name === 'AbortError' ||
      message === 'the operation was aborted' ||
      message === 'this operation was aborted' ||
      message === 'aborted';
  }

  private updateProbeStarved(name: string, inst: InstanceHealth, err: Error): void {
    const existing = this.statuses.get(name);
    const prevStatus = existing?.status ?? 'online';
    const evidence = [
      'reason=probe_aborted_before_connect',
      `health_port=${inst.healthPort}`,
      'event_loop_suspected=true',
      `error=${err.message}`,
      this.targetPidEvidence(name),
    ].join(' ');

    log.warn({ name, error: err.message, healthPort: inst.healthPort }, 'health probe aborted before connect; treating as local poller starvation');
    this.failureStartedAt.delete(name);
    this.statuses.set(name, {
      name,
      health: existing?.health ?? null,
      lastPollAt: new Date().toISOString(),
      consecutiveFailures: existing?.consecutiveFailures ?? 0,
      everReachable: existing?.everReachable ?? false,
      status: 'degraded',
      statusConfidence: 'ambiguous',
      statusReason: HEALTH_PROBE_TIMEOUT_UNDER_PROXY_LOAD,
      statusEvidence: evidence.split(/\s+/).filter(Boolean),
      error: `${HEALTH_PROBE_TIMEOUT_UNDER_PROXY_LOAD} ${evidence}`,
      lastAlertAt: this.lastAlertAtFor(name, existing),
      silencedUntil: existing?.silencedUntil ?? null,
      activeAlertSources: existing?.activeAlertSources ?? [],
    });

    if (prevStatus !== 'degraded') {
      this.emitStatusChange(name, 'degraded', prevStatus);
    }
  }

  private updateDegraded(
    name: string,
    health: Record<string, unknown>,
    newStatus: 'degraded' | 'logged_out',
    evidence: string,
    shouldAlert = true,
    alertSource = newStatus === 'logged_out' ? 'instance_logged_out' : 'instance_degraded',
    alertSummary?: string,
    allowHealthBodyDegradedAlert = true,
    loggedOutWeak = false,
    statusConfidence: StatusConfidence = loggedOutWeak ? 'inferred' : 'confirmed',
    statusReason = alertSource,
    statusEvidence: string[] = evidence.split(/\s+/).filter(Boolean),
    loggedOutFailureCode: LoggedOutAlertFailureCode = 'WA_AUTH_BOND_SERVER_REVOKED',
  ): void {
    const existing = this.statuses.get(name);
    const prevStatus = existing?.status ?? 'online';
    this.failureStartedAt.delete(name);
    if (alertSource !== 'health_body_degraded') {
      this.resetHealthBodyDegradedDebounce(name);
    }

    this.statuses.set(name, {
      name,
      health,
      lastPollAt: new Date().toISOString(),
      consecutiveFailures: existing?.consecutiveFailures ?? 0,
      everReachable: true,
      status: newStatus,
      statusConfidence,
      statusReason,
      statusEvidence,
      error: null,
      lastAlertAt: this.lastAlertAtFor(name, existing),
      silencedUntil: existing?.silencedUntil ?? null,
      activeAlertSources: existing?.activeAlertSources ?? [],
    });

    if (newStatus !== prevStatus) {
      this.emitStatusChange(name, newStatus, prevStatus);
      if (newStatus !== 'logged_out' && prevStatus === 'unreachable') {
        this.clearRecoveredAlert(name, existing, health);
      }
    }

    if (!shouldAlert || !allowHealthBodyDegradedAlert) {
      return;
    }

    if (
      newStatus === 'logged_out'
      && this.shouldEmitLoggedOutAlert(name, prevStatus, existing, loggedOutWeak, loggedOutFailureCode)
    ) {
      const emitted = this.maybeEmitAlert(name, 'instance_logged_out',
        `whatsoup@${name} appears logged out`,
        evidence,
        'critical',
        this.loggedOutCriticalAsset(name, evidence, loggedOutWeak, loggedOutFailureCode),
      );
      this.trackActiveAlertSource(name, 'instance_logged_out', emitted);
      if (emitted) this.dropSupersededAlertSources(name, ALERT_SOURCES_SUPERSEDED_BY_LOGGED_OUT);
    } else if (
      newStatus === 'degraded'
      && (
        prevStatus !== 'degraded'
        || (alertSource !== 'instance_degraded' && alertSource !== 'provider_reauth_required')
        || !this.hasConfirmedAlert(name, alertSource)
      )
    ) {
      const emitted = this.maybeEmitAlert(name, alertSource,
        alertSummary ?? `whatsoup@${name} is degraded`,
        evidence,
      );
      this.trackActiveAlertSource(name, alertSource, emitted);
    }
  }

  private maybeClearProviderReauth(_name: string, _health: Record<string, unknown>): void {
    // Implemented with the clear guard (spec §2 degraded-flow clear).
  }


  private updateFromHealthSnapshot(
    name: string,
    health: Record<string, unknown>,
    classification: HealthSnapshotClassification,
  ): void {
    if (classification.status === 'online') return;
    this.updateDegraded(
      name,
      health,
      classification.status,
      classificationEvidenceText(classification),
      true,
      classification.status === 'logged_out' ? 'instance_logged_out' : 'instance_degraded',
      undefined,
      true,
      classification.confidence !== 'confirmed',
      classification.confidence,
      classification.reason,
      classification.evidence,
    );
  }

  private clearRecoveredAlert(
    name: string,
    previous: InstanceStatus | undefined,
    currentHealth?: Record<string, unknown>,
  ): void {
    const prevStatus = previous?.status;
    const activeSources = new Set(previous?.activeAlertSources ?? []);
    if (prevStatus === 'logged_out') activeSources.add('instance_logged_out');
    if (prevStatus === 'unreachable') {
      if (previous?.everReachable === false) activeSources.add('instance_never_reachable');
      if (this.unreachableAlerted.has(name)) activeSources.add('instance_unreachable');
    }
    const sources = Array.from(activeSources);
    if (sources.length === 0) return;
    const retainedSources: string[] = [];
    for (const source of sources) {
      if (!this.shouldClearRecoveredSource(source, previous, currentHealth)) {
        retainedSources.push(source);
        log.info({ name, source }, 'recovered alert clear withheld until recovery proof is complete');
        continue;
      }
      try {
        const evidence = source === 'instance_logged_out' && currentHealth
          ? this.relinkRecoveryEvidence(name, currentHealth)
          : `repair_lane:${name}`;
        const criticalAsset = source === 'instance_logged_out' && currentHealth
          ? this.relinkRecoveryCriticalAsset(name, currentHealth)
          : undefined;
        if (!clearAlertSourceChecked(name, source, evidence, criticalAsset)) {
          retainedSources.push(source);
          continue;
        }
        if (source === 'instance_unreachable') this.unreachableAlerted.delete(name);
      } catch (err) {
        log.warn({ err, name, source }, 'failed to emit alert clear');
        retainedSources.push(source);
      }
    }
    const current = this.statuses.get(name);
    if (current) {
      current.activeAlertSources = retainedSources;
    }
  }

  private shouldClearRecoveredSource(
    source: string,
    previous: InstanceStatus | undefined,
    currentHealth: Record<string, unknown> | undefined,
  ): boolean {
    if (source !== 'instance_logged_out') return true;
    return this.hasVerifiedRelinkRecovery(previous, currentHealth);
  }

  private hasVerifiedRelinkRecovery(
    previous: InstanceStatus | undefined,
    health: Record<string, unknown> | undefined,
  ): boolean {
    if (!health) return false;
    const whatsapp = this.readRecord(health['whatsapp']);
    if (!whatsapp || whatsapp['connected'] !== true) return false;

    const connection = this.readRecord(whatsapp['connection']);
    if (connection?.['state'] !== 'connected') return false;

    const authBond = this.readRecord(whatsapp['auth_bond']);
    const creds = this.readRecord(authBond?.['creds']);
    if (!authBond || !creds) return false;
    if (authBond['status'] !== 'present') return false;
    if (creds['exists'] !== true) return false;

    const size = this.readNumber(creds['size']);
    if (size === null || size <= 0) return false;

    if (creds['empty_hash'] !== false) {
      const hash = typeof creds['hash'] === 'string'
        ? creds['hash']
        : (typeof creds['sha256'] === 'string' ? creds['sha256'] : null);
      if (hash === null || hash.length === 0 || EMPTY_SHA256.startsWith(hash)) {
        return false;
      }
    }

    const credsMtimeMs = this.readTimestampMs(creds['mtime']);
    if (credsMtimeMs === null) return false;

    const latestSendMs = this.readTimestampMs(this.readLatestSuccessfulSendAt(health));
    if (latestSendMs === null) return false;
    if (latestSendMs < credsMtimeMs) return false;

    const incidentMs = this.readTimestampMs(previous?.lastPollAt);
    if (incidentMs !== null && latestSendMs < incidentMs) return false;

    return true;
  }

  private loggedOutCriticalAsset(
    name: string,
    evidence: string,
    weak: boolean,
    failureCode: LoggedOutAlertFailureCode,
  ): BotErrorsCriticalAssetDiagnostic {
    return {
      asset: {
        kind: 'whatsapp_linked_device',
        instance: name,
        owner: 'whatsoup',
      },
      failure: {
        code: failureCode,
        domain: 'account_linkage',
        recoverability: 'manual_relink_required',
        confidence: weak ? 'probable' : 'confirmed',
        operatorAction: 'Preserve auth material and backups, inspect for duplicate services/auth trees, and do not mark resolved until verified relink recovery proof is present.',
        clearRequirement: 'connected WhatsApp state, present non-empty auth bond, and successful outbound send after creds mtime and after the incident',
      },
      evidenceRefs: evidence.split(/\s+/).filter(Boolean).slice(0, 12),
    };
  }

  private relinkRecoveryEvidence(name: string, health: Record<string, unknown>): string {
    const whatsapp = this.readRecord(health['whatsapp']);
    const connection = this.readRecord(whatsapp?.['connection']);
    const authBond = this.readRecord(whatsapp?.['auth_bond']);
    const creds = this.readRecord(authBond?.['creds']);
    const latestSendAt = this.readLatestSuccessfulSendAt(health);
    return [
      `repair_lane:${name}`,
      'clear_code=WA_AUTH_BOND_RELINK_VERIFIED',
      `whatsapp_connected=${String(whatsapp?.['connected'] ?? 'unknown')}`,
      `connection_state=${String(connection?.['state'] ?? 'unknown')}`,
      `auth_bond_status=${String(authBond?.['status'] ?? 'unknown')}`,
      `creds_exists=${String(creds?.['exists'] ?? 'unknown')}`,
      `creds_size=${String(creds?.['size'] ?? 'unknown')}`,
      `creds_hash=${String(creds?.['hash'] ?? creds?.['sha256'] ?? 'unknown')}`,
      `creds_mtime=${String(creds?.['mtime'] ?? 'unknown')}`,
      `latest_successful_send_at=${String(latestSendAt ?? 'unknown')}`,
    ].join('\n');
  }

  private relinkRecoveryCriticalAsset(
    name: string,
    health: Record<string, unknown>,
  ): BotErrorsCriticalAssetDiagnostic {
    const whatsapp = this.readRecord(health['whatsapp']);
    const authBond = this.readRecord(whatsapp?.['auth_bond']);
    const creds = this.readRecord(authBond?.['creds']);
    return {
      asset: {
        kind: 'whatsapp_linked_device',
        instance: name,
        owner: 'whatsoup',
        fingerprint: typeof creds?.['hash'] === 'string'
          ? creds['hash'] as string
          : (typeof creds?.['sha256'] === 'string' ? creds['sha256'] as string : undefined),
      },
      failure: {
        code: 'WA_AUTH_BOND_RELINK_VERIFIED',
        domain: 'account_linkage',
        recoverability: 'operator_recoverable',
        confidence: 'confirmed',
        operatorAction: 'No further action for this linked-device incident unless the same source reopens.',
        clearRequirement: 'clear emitted only after health-poller verified connected state, non-empty auth bond, and post-relink send proof',
      },
      evidenceRefs: [
        `auth_bond_status=${String(authBond?.['status'] ?? 'unknown')}`,
        `creds_mtime=${String(creds?.['mtime'] ?? 'unknown')}`,
        `latest_successful_send_at=${String(this.readLatestSuccessfulSendAt(health) ?? 'unknown')}`,
      ],
    };
  }

  private readRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  }

  private readLatestSuccessfulSendAt(health: Record<string, unknown>): unknown {
    const outboundSends = this.readRecord(health['outbound_sends']) ?? this.readRecord(health['outboundSends']);
    return outboundSends?.['latest_successful_send_at']
      ?? outboundSends?.['latestSuccessfulSendAt']
      ?? null;
  }

  private readTimestampMs(value: unknown): number | null {
    if (typeof value !== 'string' || value.trim() === '') return null;
    return sqliteUtcToEpochMs(value.trim());
  }

  private trackActiveAlertSource(name: string, source: string, emitted: boolean): void {
    const status = this.statuses.get(name);
    if (!status) return;
    if (!emitted && !this.hasConfirmedAlert(name, source)) return;
    if (status.activeAlertSources.includes(source)) return;
    status.activeAlertSources = [...status.activeAlertSources, source];
  }

  private hasConfirmedAlert(name: string, source: string): boolean {
    const status = this.statuses.get(name);
    return status?.activeAlertSources.includes(source) === true
      || this.persistedAlertThrottle.has(this.alertThrottleKey(name, source));
  }

  private dropSupersededAlertSources(name: string, supersededSources: Set<string>): void {
    const status = this.statuses.get(name);
    if (!status) return;
    status.activeAlertSources = status.activeAlertSources.filter((source) => !supersededSources.has(source));
    if (supersededSources.has('instance_unreachable')) this.unreachableAlerted.delete(name);
  }

  private maybeEmitAlert(
    name: string,
    source: string,
    summary: string,
    evidence: string,
    severity: 'critical' | 'error' | 'warning' | 'info' = 'critical',
    criticalAsset?: BotErrorsCriticalAssetDiagnostic,
  ): boolean {
    const bypassSuppression = source === 'instance_logged_out';
    if (!bypassSuppression && isInstanceSilenced(name)) {
      log.info({ name, source }, 'alert suppressed — instance is silenced');
      return false;
    }

    const existing = this.statuses.get(name);
    const throttleKey = this.alertThrottleKey(name, source);
    const lastAlertAt = this.persistedAlertThrottle.get(throttleKey) ?? null;
    if (!bypassSuppression && lastAlertAt !== null) {
      const elapsed = Date.now() - new Date(lastAlertAt).getTime();
      if (elapsed < MIN_ALERT_INTERVAL_MS) {
        log.info({ name, source, elapsed }, 'alert suppressed — rate limit (15min)');
        return false;
      }
    }

    const throttleLoadErrorCode = this.alertThrottleLoadErrorCode;
    const throttleEvidence = throttleLoadErrorCode
      ? `${evidence} alert_throttle_load_error=true alert_throttle_load_error_code=${throttleLoadErrorCode}`
      : evidence;
    const emitted = emitAlertChecked(name, source, summary, throttleEvidence, severity, criticalAsset);
    if (!emitted) return false;

    if (existing) {
      const now = new Date().toISOString();
      existing.lastAlertAt = now;
      this.persistedAlertThrottle.set(throttleKey, now);
      try {
        recordAlertThrottle(throttleKey, now);
        this.alertThrottleLoadErrorCode = null;
      } catch (err) {
        log.warn({ err, name, source, throttleKey }, 'failed to persist alert throttle');
      }
    }

    return true;
  }
}
