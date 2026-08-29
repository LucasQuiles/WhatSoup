// src/runtimes/agent/account-identity-verifier.ts
//
// Runtime-side coordinator for the ratified-row account-identity check
// (task-21). Owns the verification result the health snapshot reads and the
// operator alert surface; the CLI-facing work lives in
// providers/claude-account-identity.ts. Driven from the existing
// primary-usability probe seam (startup / periodic / manual) — no poller of
// its own.
//
// Alert contract (sources are the same literals as the degradedReasons):
//   match        -> no alert; clears any active identity alert. The first
//                   match of a process clears BOTH sources idempotently so an
//                   incident a prior process opened does not outlive it
//                   (same rule as primary_model_unusable, #2394).
//   mismatch     -> critical `credential_identity_mismatch`.
//   unverifiable -> warning  `credential_identity_unverifiable`. Does NOT
//                   clear an open mismatch: unknown is not resolution.
//   disabled     -> one info note per process; no state, no alert.
// Evidence is content-free: trigger, status, bounded reason, provider, and
// 12-hex digest prefixes. Never a raw identifier, never CLI output.

import { clearAlertSourceChecked, emitAlertChecked } from '../../lib/emit-alert.ts';
import { createChildLogger } from '../../logger.ts';
import {
  verifyClaudeAccountIdentity,
  type AccountIdentityVerification,
} from './providers/claude-account-identity.ts';
import { alertEvidenceValue } from './tool-update.ts';

export type AccountIdentityProbeTrigger = 'startup' | 'manual' | 'periodic';

export type AccountIdentityVerifyFn = (
  expectedDigest: string | null,
  signal?: AbortSignal,
) => Promise<AccountIdentityVerification>;

export const CREDENTIAL_IDENTITY_ALERT_SOURCES = [
  'credential_identity_mismatch',
  'credential_identity_unverifiable',
] as const;

type CredentialIdentityAlertSource = (typeof CREDENTIAL_IDENTITY_ALERT_SOURCES)[number];

/** Live-getter port onto the runtime (RuntimeRoutingPort convention): the
 *  result is runtime-owned state so the health snapshot reads it directly. */
export interface AccountIdentityVerifierHost {
  readonly instanceName: string;
  readonly agentProvider: string;
  readonly expectedAccountDigest: string | null;
  readonly shutdownRequested: boolean;
  accountIdentity: AccountIdentityVerification | null;
}

export interface AccountIdentityVerifierDeps {
  verify?: AccountIdentityVerifyFn;
  emitAlertChecked?: typeof emitAlertChecked;
  clearAlertSourceChecked?: typeof clearAlertSourceChecked;
  log?: { info: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void };
}

export class AccountIdentityVerifier {
  private readonly host: AccountIdentityVerifierHost;
  private readonly verify: AccountIdentityVerifyFn;
  private readonly emitAlert: typeof emitAlertChecked;
  private readonly clearAlert: typeof clearAlertSourceChecked;
  private readonly log: NonNullable<AccountIdentityVerifierDeps['log']>;
  private inFlight: Promise<AccountIdentityVerification | null> | null = null;
  private disabledNoted = false;
  private carryOverCleared = false;
  private readonly activeAlerts = new Set<CredentialIdentityAlertSource>();

  constructor(host: AccountIdentityVerifierHost, deps: AccountIdentityVerifierDeps = {}) {
    this.host = host;
    this.verify = deps.verify ?? ((expected, signal) => verifyClaudeAccountIdentity(expected, {}, signal));
    this.emitAlert = deps.emitAlertChecked ?? emitAlertChecked;
    this.clearAlert = deps.clearAlertSourceChecked ?? clearAlertSourceChecked;
    this.log = deps.log ?? createChildLogger('account-identity');
  }

  /** Verify once for this trigger. Coalesces onto an in-flight verification;
   *  never rejects. Returns null when verification is disabled, not
   *  applicable to the provider, or dropped after shutdown. */
  run(trigger: AccountIdentityProbeTrigger): Promise<AccountIdentityVerification | null> {
    if (this.host.agentProvider !== 'claude-cli') return Promise.resolve(null);
    const expected = this.host.expectedAccountDigest;
    if (expected === null) {
      if (!this.disabledNoted) {
        this.disabledNoted = true;
        this.log.info(
          { instanceName: this.host.instanceName },
          'account identity verification disabled: no service.expectedAccountDigest configured',
        );
      }
      return Promise.resolve(null);
    }
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = this.verify(expected)
      .catch((): AccountIdentityVerification => ({
        status: 'unverifiable',
        reason: 'probe-threw',
        expectedDigestPrefix: null,
        observedDigestPrefix: null,
        checkedAt: 0,
      }))
      .then((result) => this.record(result, trigger))
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private record(
    result: AccountIdentityVerification,
    trigger: AccountIdentityProbeTrigger,
  ): AccountIdentityVerification | null {
    if (this.host.shutdownRequested) {
      // A verification started before shutdown resolved after it: drop it
      // whole — no evidence mutation, no alert, no clear (mirrors
      // recordPrimaryModelUsability).
      return null;
    }
    this.host.accountIdentity = result;
    const evidence = this.evidence(result, trigger);
    const fields = {
      instanceName: this.host.instanceName,
      trigger,
      status: result.status,
      reason: result.reason,
      expectedDigestPrefix: result.expectedDigestPrefix,
      observedDigestPrefix: result.observedDigestPrefix,
    };

    if (result.status === 'match') {
      const toClear: CredentialIdentityAlertSource[] = this.carryOverCleared
        ? [...this.activeAlerts]
        : [...CREDENTIAL_IDENTITY_ALERT_SOURCES];
      this.carryOverCleared = true;
      for (const source of toClear) this.clearAlert(this.host.instanceName, source, evidence);
      this.activeAlerts.clear();
      this.log.info(fields, 'account identity verified against the ratified digest');
      return result;
    }

    if (result.status === 'mismatch') {
      this.log.warn(fields, 'account identity MISMATCH: the claude CLI is serving with an account that is not the ratified one');
      this.emitAlert(
        this.host.instanceName,
        'credential_identity_mismatch',
        'Claude account identity does not match the ratified expectation',
        evidence,
        'critical',
      );
      this.activeAlerts.add('credential_identity_mismatch');
      return result;
    }

    if (result.status === 'unverifiable') {
      this.log.warn(fields, 'account identity could not be verified against the ratified digest (fail closed)');
      this.emitAlert(
        this.host.instanceName,
        'credential_identity_unverifiable',
        'Claude account identity could not be verified against the ratified expectation',
        evidence,
        'warning',
      );
      this.activeAlerts.add('credential_identity_unverifiable');
      return result;
    }

    // 'disabled' cannot reach here (expected !== null), kept for totality.
    return result;
  }

  private evidence(result: AccountIdentityVerification, trigger: AccountIdentityProbeTrigger): string {
    return [
      `trigger=${trigger}`,
      `status=${result.status}`,
      `reason=${alertEvidenceValue(result.reason ?? 'none')}`,
      `provider=${this.host.agentProvider}`,
      `expected=${alertEvidenceValue(result.expectedDigestPrefix ?? 'none')}`,
      `observed=${alertEvidenceValue(result.observedDigestPrefix ?? 'absent')}`,
    ].join(' ');
  }
}
