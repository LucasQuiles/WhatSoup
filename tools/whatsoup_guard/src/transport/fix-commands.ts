import type { PolicyActionKey } from '../policy/runtime.ts';

/**
 * Copy-pasteable fix-command templates for `propose_fix` alerts.
 *
 * Spec reference: docs/specs/2026-05-08-whatsoup-protection-layer-design.md
 *   §6.5 (Actions): "propose_fix - Same as alert, with a copy-pasteable fix
 *                    command in the alert body. The engine never runs it."
 *   §7.4 (Alert content shape): action taken renders as
 *                    `propose_fix:<command>` when this resolver returns one.
 *
 * Each template receives the raw event payload. Templates that need context
 * the payload does not carry (e.g. a `path` field) return `undefined` so the
 * formatter falls back to the bare label, preserving §6.5's "engine never
 * runs it" invariant without lying to the operator with a half-built command.
 */
export type FixCommandTemplate = (payload: Record<string, unknown>) => string | undefined;

const TEMPLATES: Record<string, FixCommandTemplate> = {
  'exposure.unauthenticated_mutation': (p) => {
    const route = readString(p.route) ?? readString(p.path);
    if (!route) return 'whatsoup-guard inspect --domain exposure --probe app.routes';
    return `whatsoup-guard inspect --domain exposure --probe app.routes --route ${shellQuote(route)}`;
  },
  'exposure.public_funnel_internal': (p) => {
    const funnel = readString(p.funnel) ?? readString(p.name);
    if (!funnel) return 'tailscale funnel status';
    return `tailscale funnel reset ${shellQuote(funnel)}`;
  },
  'exposure.firewall_disabled': () => {
    return 'sudo pfctl -e';
  },
  'capability.role_violation': (p) => {
    const role = readString(p.role);
    const probe = readString(p.probe_id) ?? readString(p.scope_id);
    const target = role ?? probe;
    if (!target) return 'whatsoup-guard inspect --domain capability';
    return `whatsoup-guard inspect --domain capability --role ${shellQuote(target)}`;
  },
  'credential.file_mode_widened': (p) => {
    const path = readString(p.path);
    if (!path) return undefined;
    const mode = readMode(p.expected_mode) ?? '0600';
    return `chmod ${mode} ${shellQuote(path)}`;
  },
  'credential.token_aging': (p) => {
    const path = readString(p.path);
    if (!path) return undefined;
    return `whatsoup-guard rotate-token --path ${shellQuote(path)}`;
  },
  'change.new_persistence_unit': (p) => {
    return acceptOrRollbackCommand(p, 'change.new_persistence_unit');
  },
  'change.new_application_route': (p) => {
    return acceptOrRollbackCommand(p, 'change.new_application_route');
  },
  'alerting.self_secret_widened': (p) => {
    const path = readString(p.path);
    if (!path) return undefined;
    const mode = readMode(p.expected_mode) ?? '0600';
    return `chmod ${mode} ${shellQuote(path)}`;
  },
  'alerting.baseline_integrity_fail': (p) => {
    const scope = readString(p.scope_id);
    const probe = readString(p.probe_id);
    if (scope && probe) {
      return `whatsoup-guard baseline rebuild --scope ${shellQuote(scope)} --probe ${shellQuote(probe)}`;
    }
    return 'whatsoup-guard baseline rebuild';
  },
  'alerting.transport_failed': () => {
    return 'whatsoup-guard transport diagnose';
  },
};

export const FIX_COMMAND_TEMPLATES: Readonly<Record<string, FixCommandTemplate>> = TEMPLATES;

export function resolveFixCommand(
  key: PolicyActionKey | string,
  payload: Record<string, unknown> | undefined,
): string | undefined {
  const template = TEMPLATES[key];
  if (!template) return undefined;
  return template(payload ?? {});
}

function acceptOrRollbackCommand(payload: Record<string, unknown>, reasonCode: string): string {
  const field = readString(payload.field);
  const added = readStringArray(readDiffAdded(payload));
  const fieldArg = field ? ` --field ${shellQuote(field)}` : '';
  const reasonArg = ` --reason ${shellQuote(reasonCode)}`;
  if (added.length === 0) {
    return `whatsoup-guard baseline accept${fieldArg}${reasonArg}`;
  }
  const addedArgs = added.map((v) => ` --added ${shellQuote(v)}`).join('');
  return `whatsoup-guard baseline accept${fieldArg}${reasonArg}${addedArgs}`;
}

function readDiffAdded(payload: Record<string, unknown>): unknown {
  const diff = payload.diff;
  if (diff && typeof diff === 'object' && !Array.isArray(diff)) {
    return (diff as Record<string, unknown>).added;
  }
  return payload.added;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

function readMode(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return '0' + value.toString(8).padStart(3, '0');
  }
  if (typeof value === 'string' && /^0?[0-7]{3,4}$/u.test(value)) {
    return value.startsWith('0') ? value : '0' + value;
  }
  return undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
