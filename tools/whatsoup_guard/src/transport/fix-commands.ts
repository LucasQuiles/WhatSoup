import type { PolicyActionKey } from '../policy/runtime.ts';

/**
 * Resolves `propose_fix` follow-up text for an alert.
 *
 * Spec reference: docs/specs/2026-05-08-whatsoup-protection-layer-design.md
 *   §6.5 (Actions): "propose_fix - Same as alert, with a copy-pasteable fix
 *                    command in the alert body. The engine never runs it."
 *   §7.4 (Alert content shape): action taken renders as
 *                    `propose_fix:<command>` when a command is available;
 *                    otherwise a `remediation_hint:` line points at a
 *                    documented runbook path.
 *
 * Anti-fabrication discipline (critical — PR #462 was closed unmerged for
 * inventing subcommands):
 *
 *   - Shell commands MUST be real POSIX/macOS binaries or one of the six
 *     whatsoup-guard subcommands: `ping`, `cycle`, `mute`, `status`,
 *     `simulate`, `watchdog` (tools/whatsoup_guard/src/cli/index.ts:29-43).
 *   - Anything that cannot be reduced to a single deterministic command
 *     (token rotation, baseline acceptance, route auth) gets a
 *     `remediation_hint` referencing this spec doc instead. Inventing
 *     `whatsoup-guard inspect / rotate-token / baseline-rebuild /
 *     baseline-accept / transport-diagnose` subcommands is forbidden.
 */

export interface ProposeFixFollowUp {
  /** Real shell command, suitable for `propose_fix:<cmd>`. */
  fixCommand?: string;
  /** Free-text hint, suitable for `remediation_hint:<text>`. */
  remediationHint?: string;
}

export type FixCommandResolver = (payload: Record<string, unknown>) => ProposeFixFollowUp | undefined;

const SPEC_PATH = 'docs/specs/2026-05-08-whatsoup-protection-layer-design.md';

const TEMPLATES: Partial<Record<string, FixCommandResolver>> = {
  // Shell-fix path: payload from runSelfProtectionChecks carries `path` and
  // `expected_mode` deterministically, so `chmod <mode> <path>` is real POSIX.
  'alerting.self_secret_widened': (payload) => {
    const path = readString(payload.path);
    if (!path) {
      return { remediationHint: `restrict the guard self-secret to mode 0600 by hand; see ${SPEC_PATH} §4.5` };
    }
    const mode = readMode(payload.expected_mode) ?? '0600';
    return { fixCommand: `chmod ${mode} ${shellQuote(path)}` };
  },

  // Shell-fix path identical to self_secret_widened — drift collectors that
  // emit `credential.file_mode_widened` with `{path, expected_mode}` get a
  // real chmod. When fields are missing, fall back to a hint.
  'credential.file_mode_widened': (payload) => {
    const path = readString(payload.path);
    if (!path) {
      return { remediationHint: `tighten the secret file's mode to the policy expectation; see ${SPEC_PATH} §4.2` };
    }
    const mode = readMode(payload.expected_mode) ?? '0600';
    return { fixCommand: `chmod ${mode} ${shellQuote(path)}` };
  },

  // Shell-fix path: macOS Application Layer Firewall has a real CLI binary at
  // /usr/libexec/ApplicationFirewall/socketfilterfw. `--setglobalstate on`
  // re-enables the firewall. Requires sudo on default installs.
  'exposure.firewall_disabled': () => ({
    fixCommand: 'sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate on',
  }),

  // Non-shell: token rotation crosses provider/transport boundaries. The
  // operator must pick the right rotation procedure; we link the spec.
  'credential.token_aging': () => ({
    remediationHint: `rotate the credential per the deployment's documented procedure, then re-run \`whatsoup-guard cycle\`; see ${SPEC_PATH} §4.2`,
  }),

  // Non-shell: role-violations are policy/config decisions, not commands.
  'capability.role_violation': () => ({
    remediationHint: `align the instance to its declared deployment role (or update the role declaration); see ${SPEC_PATH} §4.3 and §8.1`,
  }),

  // Non-shell: accepting a baseline change is a policy decision. The operator
  // either re-captures the baseline (deployment-specific) or reverts the
  // change. There is no engine subcommand for either path in v1.
  'change.new_persistence_unit': () => ({
    remediationHint: `update the declared baseline to include the new persistence unit, or revert the deployment change; see ${SPEC_PATH} §4.4`,
  }),
  'change.new_application_route': () => ({
    remediationHint: `update the declared baseline to include the new route, or revert the deployment change; see ${SPEC_PATH} §4.4`,
  }),

  // Non-shell: route authentication is a code-level fix.
  'exposure.unauthenticated_mutation': () => ({
    remediationHint: `add an authentication guard to the route handler, or update policy if the route is intentionally public; see ${SPEC_PATH} §4.1`,
  }),

  // Non-shell: tailscale funnel/serve config is operator-managed.
  'exposure.public_funnel_internal': () => ({
    remediationHint: `remove the public binding for the internal port from the tunneling daemon config; see ${SPEC_PATH} §4.1`,
  }),

  // Non-shell: baseline integrity failures need operator investigation before
  // any baseline action is safe. Pointing at `whatsoup-guard simulate` is a
  // safe diagnostic-only hint.
  'alerting.baseline_integrity_fail': () => ({
    remediationHint: `inspect the failing baseline with \`whatsoup-guard simulate\`, then capture a fresh baseline if the drift is approved; see ${SPEC_PATH} §4.5`,
  }),

  // alerting.transport_failed is routed to meta_alert by the spec, not
  // propose_fix, but we provide a hint in case a profile overrides the
  // default action — without inventing a `transport-diagnose` subcommand.
  'alerting.transport_failed': () => ({
    remediationHint: `verify the alert sink credentials and connectivity, then re-run \`whatsoup-guard cycle\` to confirm delivery; see ${SPEC_PATH} §7.1`,
  }),
};

export const FIX_COMMAND_TEMPLATES: Readonly<Partial<Record<string, FixCommandResolver>>> = TEMPLATES;

export function resolveProposeFixFollowUp(
  key: PolicyActionKey | string | undefined,
  payload: Record<string, unknown> | undefined,
): ProposeFixFollowUp | undefined {
  if (!key) return undefined;
  const resolver = TEMPLATES[key];
  if (!resolver) return undefined;
  return resolver(payload ?? {});
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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
