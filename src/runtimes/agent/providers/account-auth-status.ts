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
import type { BinaryAuthStatusResult, BinaryCommandProbeOptions } from './binary-preflight.ts';

export interface AccountAuthTarget {
  provider: string;
  model?: string;
  providerConfig?: Record<string, unknown>;
}

export interface AccountAuthStatusDeps {
  resolveKeyService: (provider: string, model: string | undefined, config: Record<string, unknown> | undefined) => string | null;
  lookupCredential: (service: string) => string | null;
  getProviderBinary: (provider: string) => string | null;
  probeBinaryAuthStatus: (
    binary: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    options?: BinaryCommandProbeOptions,
  ) => Promise<BinaryAuthStatusResult>;
  isAuthRequiredMessage: (text: string) => boolean;
  env: NodeJS.ProcessEnv;
  /** claude-cli: refresh-ahead run before the killable auth-status child (claude-refresh-ahead.ts). */
  refreshAhead?: (binary: string, env: NodeJS.ProcessEnv) => Promise<unknown>;
  /** claude-cli: refresh-lock wait before the auth-status child is signalled. */
  terminationGrace?: (env: NodeJS.ProcessEnv) => Promise<unknown> | null;
}

/** `claude auth status --json` — shared with the account-identity verifier
 *  (claude-account-identity.ts) so both read the same CLI surface. */
export const CLAUDE_AUTH_STATUS_ARGS: readonly string[] = ['auth', 'status', '--json'];
const AUTH_STATUS_ARGS = [...CLAUDE_AUTH_STATUS_ARGS];

/** Scrubbed env for the CLI probe — only what the binary needs to resolve auth. */
export function scrubbedAuthStatusEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return scrubbedEnv(env);
}

function scrubbedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    HOME: env['HOME'],
    PATH: env['PATH'],
    USER: env['USER'],
    NO_COLOR: '1',
    // Preserve the same credential selection as serving turns, including the
    // defined-empty secure-storage override that selects the CLI default.
    ...(env['CLAUDE_CONFIG_DIR'] ? { CLAUDE_CONFIG_DIR: env['CLAUDE_CONFIG_DIR'] } : {}),
    ...(env['CLAUDE_SECURESTORAGE_CONFIG_DIR'] !== undefined
      ? { CLAUDE_SECURESTORAGE_CONFIG_DIR: env['CLAUDE_SECURESTORAGE_CONFIG_DIR'] } : {}),
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
    const env = scrubbedEnv(deps.env);
    const isClaude = target.provider === 'claude-cli';
    // A due token refresh runs first in a child nothing kills. The bundle's
    // deadline may abandon this finding meanwhile; the refresh still finishes,
    // and the killable spawn below is then skipped.
    if (isClaude && deps.refreshAhead && !signal.aborted) {
      try {
        await deps.refreshAhead(binary, env);
      } catch { /* deliberately: refresh-ahead is fail-open (documented never-reject); the probe below runs as it did without it */ }
    }
    // The orchestrator may have already abandoned us; skip the spawn if so.
    if (signal.aborted) {
      return { ok: false, confidence: 'suspected', summary: `auth-status probe aborted for ${target.provider}`, data: { mode: 'binary', provider: target.provider } };
    }

    let result: { status: 'ok' | 'failed'; output: string };
    try {
      const grace = isClaude ? deps.terminationGrace : undefined;
      result = grace
        ? await deps.probeBinaryAuthStatus(binary, AUTH_STATUS_ARGS, env, { terminationGrace: () => grace(env) })
        : await deps.probeBinaryAuthStatus(binary, AUTH_STATUS_ARGS, env);
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
