import { canonicalize, fingerprint, structuralDiff } from '../canonical.ts';
import type { DeploymentRole } from '../policy/schema.ts';
import type { Domain, ProbeDoc, Severity } from '../types.ts';
import type { EvaluatorEventInput } from './types.ts';

export interface DriftRuleArgs {
  observed: ProbeDoc;
  baseline: ProbeDoc | undefined;
  severity: Severity;
  domain: Domain;
}

export interface CapabilityRoleRuleArgs {
  observed: ProbeDoc;
  deploymentRole: DeploymentRole | undefined;
}

export function driftRule(args: DriftRuleArgs): EvaluatorEventInput[] {
  const { observed, baseline, severity, domain } = args;
  if (!baseline) {
    return [];
  }

  if (canonicalize(observed.fields) === canonicalize(baseline.fields)) {
    return [];
  }

  const diff = structuralDiff(observed, baseline);
  return [{
    ts: observed.captured_at,
    kind: 'drift',
    domain,
    scope_id: observed.scope_id,
    probe_id: observed.probe_id,
    severity,
    fingerprint: fingerprint(observed.probe_id, observed, baseline),
    payload: { diff },
  }];
}

export function capabilityRoleRule(args: CapabilityRoleRuleArgs): EvaluatorEventInput[] {
  const { observed, deploymentRole } = args;
  if (!deploymentRole) return [];

  const findings: EvaluatorEventInput[] = [];
  const actualRuntimeType = readString(observed.fields.runtime_type);
  if (deploymentRole.runtime_type !== undefined && actualRuntimeType !== deploymentRole.runtime_type) {
    findings.push(roleViolation({
      observed,
      reason: 'runtime_type_mismatch',
      details: {
        expected_runtime_type: deploymentRole.runtime_type,
        actual_runtime_type: actualRuntimeType ?? null,
      },
    }));
  }

  const providerEnv = readProviderEnv(observed.fields.provider_env);
  for (const [key, expectation] of Object.entries(deploymentRole.provider_env ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const present = providerEnv[key] ?? false;
    if (expectation === 'required' && !present) {
      findings.push(roleViolation({
        observed,
        reason: 'provider_env_required_absent',
        details: { provider_key: key, expected: 'required', actual: 'absent' },
      }));
    }
    if (expectation === 'forbidden' && present) {
      findings.push(roleViolation({
        observed,
        reason: 'provider_env_forbidden_present',
        details: { provider_key: key, expected: 'forbidden', actual: 'present' },
      }));
    }
  }

  const enabledPlugins = readStringArray(observed.fields.enabled_plugins);
  if (deploymentRole.enabled_plugins_max !== undefined && enabledPlugins.length > deploymentRole.enabled_plugins_max) {
    findings.push(roleViolation({
      observed,
      reason: 'enabled_plugins_max_exceeded',
      details: {
        expected_max: deploymentRole.enabled_plugins_max,
        actual_count: enabledPlugins.length,
      },
    }));
  }

  if (deploymentRole.enabled_plugins !== undefined) {
    const allowed = new Set(deploymentRole.enabled_plugins);
    const disallowed = enabledPlugins.filter((p) => !allowed.has(p)).sort((a, b) => a.localeCompare(b));
    if (disallowed.length > 0) {
      findings.push(roleViolation({
        observed,
        reason: 'enabled_plugins_outside_allowlist',
        details: {
          allowed: [...deploymentRole.enabled_plugins].sort((a, b) => a.localeCompare(b)),
          disallowed,
        },
      }));
    }
  }

  const accessMode = readAccessMode(observed.fields.access_mode);
  for (const [key, expected] of Object.entries(deploymentRole.access_mode ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const actual = accessMode[key];
    if (actual === undefined || actual !== expected) {
      findings.push(roleViolation({
        observed,
        reason: 'access_mode_mismatch',
        details: {
          access_key: key,
          expected_value: expected,
          actual_value: actual === undefined ? null : actual,
        },
      }));
    }
  }

  if (deploymentRole.mcp_tool_set !== undefined) {
    const observedTools = readStringArray(observed.fields.mcp_tool_set);
    const allowed = new Set(deploymentRole.mcp_tool_set);
    const disallowed = observedTools.filter((t) => !allowed.has(t)).sort((a, b) => a.localeCompare(b));
    if (disallowed.length > 0) {
      findings.push(roleViolation({
        observed,
        reason: 'mcp_tool_set_outside_allowlist',
        details: {
          allowed: [...deploymentRole.mcp_tool_set].sort((a, b) => a.localeCompare(b)),
          disallowed,
        },
      }));
    }
  }

  return findings;
}

function roleViolation(args: {
  observed: ProbeDoc;
  reason: string;
  details: Record<string, unknown>;
}): EvaluatorEventInput {
  return {
    ts: args.observed.captured_at,
    kind: 'drift',
    domain: 'capability',
    scope_id: args.observed.scope_id,
    probe_id: args.observed.probe_id,
    severity: 'high',
    fingerprint: capabilityFingerprint(args.observed, args.reason, args.details),
    payload: {
      action: 'alert',
      reason_code: 'capability.role_violation',
      reason: args.reason,
      role: readString(args.observed.fields.role) ?? null,
      ...args.details,
    },
  };
}

function capabilityFingerprint(observed: ProbeDoc, reason: string, details: Record<string, unknown>): string {
  return fingerprint(
    'capability.role_violation',
    { ...observed, fields: { reason, details } },
    { ...observed, fields: { reason, details: {} } },
  );
}

function readProviderEnv(value: unknown): Record<string, boolean> {
  if (!isRecord(value)) return {};
  const out: Record<string, boolean> = {};
  for (const [key, marker] of Object.entries(value)) {
    if (typeof marker === 'boolean') out[key] = marker;
    else if (marker === 'present') out[key] = true;
    else if (marker === 'absent') out[key] = false;
  }
  return out;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function readAccessMode(value: unknown): Record<string, boolean | string> {
  if (!isRecord(value)) return {};
  const out: Record<string, boolean | string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'boolean' || typeof raw === 'string') out[key] = raw;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
