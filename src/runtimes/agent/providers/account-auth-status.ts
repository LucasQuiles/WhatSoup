/**
 * Account / auth-status diagnostic probe.
 *
 * Best-effort assessment of whether a provider's account is usable right now —
 * the richer, confidence-labelled sibling of `AgentRuntime.probePrimaryProvider-
 * Recovered` (which returns a bare boolean). It answers one of the diagnostics
 * the bundle orchestrator runs on an arming provider failure.
 *
 * Account / subscription APIs are limited across providers, so this is
 * deliberately best-effort with graceful degradation and explicit confidence:
 *  - **key-presence** (API providers / keyed CLIs) tells us a credential exists,
 *    not that it is valid → `probable` when present; an *absent* key is
 *    `confirmed` (we can see it is missing).
 *  - **CLI `auth status --json`** is `confirmed` when it cleanly reports auth-ok
 *    or auth-required, but a failed/timed-out probe is `suspected` (inconclusive,
 *    possibly transient).
 *
 * Built as a factory over injected dependencies so it is pure and unit-testable
 * without spawning processes or touching the keyring. The runtime supplies the
 * real implementations (`resolveProviderKeyService`, `lookupCredential`,
 * `getProviderBinary`, `probeBinaryAuthStatus`, `isProviderAuthRequiredMessage`).
 *
 * Summaries never include raw probe output (which can carry tokens) — only fixed
 * strings plus the non-secret service / provider identifier.
 */

import type { DiagnosticProbe, DiagnosticProbeResult } from '../diagnostic-bundle.ts';

export interface AccountAuthTarget {
  provider: string;
  model?: string;
  providerConfig?: Record<string, unknown>;
}

export interface AccountAuthStatusDeps {
  resolveKeyService: (provider: string, model: string | undefined, config: Record<string, unknown> | undefined) => string | null;
  lookupCredential: (service: string) => string | null;
  getProviderBinary: (provider: string) => string | null;
  probeBinaryAuthStatus: (binary: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ status: 'ok' | 'failed'; output: string }>;
  isAuthRequiredMessage: (text: string) => boolean;
  env: NodeJS.ProcessEnv;
}

const AUTH_STATUS_ARGS = ['auth', 'status', '--json'];

/** Scrubbed env for the CLI probe — only what the binary needs to resolve auth. */
function scrubbedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    HOME: env['HOME'],
    PATH: env['PATH'],
    USER: env['USER'],
    NO_COLOR: '1',
    // Forward CLAUDE_CONFIG_DIR (if set) so the auth-status probe resolves creds
    // from the same place as the model probe + real turns. On launchd-managed
    // macOS hosts the keychain cred item is unreadable in the non-GUI context;
    // CLAUDE_CONFIG_DIR=$HOME/.claude routes the cli to the readable file store.
    // No-op where unset → no change on hosts that omit it. See RCA 2026-06-24.
    ...(env['CLAUDE_CONFIG_DIR'] ? { CLAUDE_CONFIG_DIR: env['CLAUDE_CONFIG_DIR'] } : {}),
  };
}

export function makeAccountAuthStatusProbe(
  target: AccountAuthTarget,
  deps: AccountAuthStatusDeps,
): DiagnosticProbe {
  return async (signal): Promise<DiagnosticProbeResult> => {
    // Keyed providers (API backends, keyed CLIs): credential presence check.
    const service = deps.resolveKeyService(target.provider, target.model, target.providerConfig);
    if (service) {
      const present = deps.lookupCredential(service) !== null;
      return present
        ? { ok: true, confidence: 'probable', summary: `credential present for ${service}`, data: { mode: 'keyring', service } }
        : { ok: false, confidence: 'confirmed', summary: `no credential found for ${service}`, data: { mode: 'keyring', service } };
    }

    // Self-authenticating CLI providers: probe the binary's auth status.
    const binary = deps.getProviderBinary(target.provider);
    if (!binary) {
      return { ok: false, confidence: 'confirmed', summary: `no binary for provider ${target.provider}`, data: { mode: 'binary', provider: target.provider } };
    }
    // The orchestrator may have already abandoned us; skip the spawn if so.
    if (signal.aborted) {
      return { ok: false, confidence: 'suspected', summary: `auth-status probe aborted for ${target.provider}`, data: { mode: 'binary', provider: target.provider } };
    }

    let result: { status: 'ok' | 'failed'; output: string };
    try {
      result = await deps.probeBinaryAuthStatus(binary, AUTH_STATUS_ARGS, scrubbedEnv(deps.env));
    } catch {
      // probeBinaryAuthStatus is documented never-throw, but stay defensive.
      return { ok: false, confidence: 'suspected', summary: `auth-status probe errored for ${target.provider}`, data: { mode: 'binary', provider: target.provider } };
    }

    if (result.status !== 'ok') {
      return { ok: false, confidence: 'suspected', summary: `auth-status probe did not complete for ${target.provider}`, data: { mode: 'binary', provider: target.provider } };
    }
    if (deps.isAuthRequiredMessage(result.output)) {
      return { ok: false, confidence: 'confirmed', summary: `${target.provider} reports auth required`, data: { mode: 'binary', provider: target.provider } };
    }
    return { ok: true, confidence: 'confirmed', summary: `${target.provider} auth ok`, data: { mode: 'binary', provider: target.provider } };
  };
}
