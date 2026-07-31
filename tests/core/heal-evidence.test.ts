import { describe, expect, it } from 'vitest';

import {
  HealEvidenceV1Schema,
  allowlistedHealCrashClass,
  parseStoredHealEvidence,
  projectAutomaticHealEvidence,
  type AutomaticHealReportInput,
} from '../../src/core/heal-evidence.ts';

function asUntypedReporterInput(value: Record<string, unknown>): AutomaticHealReportInput {
  return value as unknown as AutomaticHealReportInput;
}

describe('automatic heal evidence boundary', () => {
  it('projects crash diagnostics into a closed, content-free V1 envelope', () => {
    const canary = 'HEAL_EVIDENCE_CANARY_DO_NOT_LEAK';

    const evidence = projectAutomaticHealEvidence(asUntypedReporterInput({
      type: 'crash',
      chatJid: `chat-${canary}`,
      exitCode: 137,
      signal: canary,
      provider: canary,
      crashClass: 'provider_auth_required',
      stderr: canary,
      recentLogs: canary,
    }));

    expect(evidence).toEqual({
      schemaVersion: 1,
      type: 'crash',
      source: 'automatic_crash_reporter',
      cause: 'provider_auth_required',
      stage: 'provider_session',
      impact: 'single_session',
      evidenceCoverage: 'crash_classified',
      counts: { occurrences: 1 },
      action: 'reauthenticate_provider',
      correlation: 'heal:v1:crash:provider_auth_required',
    });
    expect(JSON.stringify(evidence)).not.toContain(canary);
    expect(HealEvidenceV1Schema.safeParse(evidence).success).toBe(true);
  });

  it('uses a bounded unclassified envelope when raw diagnostics have no allowlisted cause', () => {
    const canary = 'HEAL_UNCLASSIFIED_CANARY_DO_NOT_LEAK';

    const evidence = projectAutomaticHealEvidence(asUntypedReporterInput({
      type: 'crash',
      chatJid: canary,
      exitCode: 137,
      signal: canary,
      provider: canary,
      crashClass: canary,
      stderr: canary,
      recentLogs: canary,
    }));

    expect(evidence).toMatchObject({
      schemaVersion: 1,
      type: 'crash',
      cause: 'unclassified',
      evidenceCoverage: 'unclassified',
      action: 'investigate_crash',
      correlation: 'heal:v1:crash:unclassified',
    });
    expect(JSON.stringify(evidence)).not.toContain(canary);
  });

  it('preserves only aggregate decryption counts for degradation evidence', () => {
    const evidence = projectAutomaticHealEvidence({
      type: 'degraded',
      totalFailures: 9,
      affectedScopeCount: 2,
    });

    expect(evidence).toEqual({
      schemaVersion: 1,
      type: 'degraded',
      source: 'automatic_degradation_detector',
      cause: 'decryption_failure_threshold',
      stage: 'inbound_decryption',
      impact: 'delivery_degraded',
      evidenceCoverage: 'threshold_aggregate',
      counts: { occurrences: 9, affectedScopes: 2 },
      action: 'investigate_decryption_failures',
      correlation: 'heal:v1:degraded:decryption_failure_threshold',
    });
  });

  it('rejects extra raw fields from the V1 envelope', () => {
    const evidence = projectAutomaticHealEvidence({
      type: 'crash',
      crashClass: 'provider_auth_required',
    });

    expect(HealEvidenceV1Schema.safeParse({
      ...evidence,
      chatJid: 'HEAL_SCHEMA_CANARY_DO_NOT_LEAK',
    }).success).toBe(false);
    expect(HealEvidenceV1Schema.safeParse({
      ...evidence,
      counts: { occurrences: 1, rawCountDetail: 'HEAL_SCHEMA_CANARY_DO_NOT_LEAK' },
    }).success).toBe(false);
  });

  it('rejects V1 atoms combined into an impossible report kind', () => {
    const degradation = projectAutomaticHealEvidence({
      type: 'degraded',
      totalFailures: 9,
      affectedScopeCount: 2,
    });

    expect(HealEvidenceV1Schema.safeParse({
      ...degradation,
      type: 'crash',
    }).success).toBe(false);
  });

  it('allows registered and structural SessionManager crash causes across the reporter input boundary', () => {
    expect(allowlistedHealCrashClass('provider_auth_required')).toBe('provider_auth_required');
    expect(allowlistedHealCrashClass('spawn_error')).toBe('spawn_error');
    expect(allowlistedHealCrashClass('managed_provider_error')).toBe('managed_provider_error');
    expect(allowlistedHealCrashClass('provider_turn_watchdog')).toBe('provider_turn_watchdog');
    expect(allowlistedHealCrashClass('HEAL_CRASH_CLASS_CANARY_DO_NOT_LEAK')).toBeUndefined();
  });

  it('rejects unregistered causes from the stored V1 envelope too', () => {
    const evidence = projectAutomaticHealEvidence({
      type: 'crash',
      crashClass: 'provider_auth_required',
    });

    expect(HealEvidenceV1Schema.safeParse({
      ...evidence,
      cause: 'HEAL_STORED_CAUSE_CANARY_DO_NOT_LEAK',
    }).success).toBe(false);
  });

  it('does not revive legacy or unknown stored context as repair input', () => {
    const canary = 'HEAL_LEGACY_CONTEXT_CANARY_DO_NOT_LEAK';

    expect(parseStoredHealEvidence(JSON.stringify({ chatJid: canary, stderr: canary }))).toEqual({
      schemaVersion: 1,
      type: 'service_crash',
      source: 'legacy_unclassified',
      cause: 'legacy_unclassified',
      stage: 'unknown',
      impact: 'unknown',
      evidenceCoverage: 'legacy_context_rejected',
      counts: { occurrences: 1 },
      action: 'investigate_legacy_report',
      correlation: 'heal:v1:legacy_unclassified',
    });
  });
});
