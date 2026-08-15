/**
 * process.env read allowlist ratchet (#2192 slice 0).
 *
 * WhatSoup's typed RuntimeConfig SSOT is src/config.ts: instance-config first,
 * env second, default last. A direct process.env access anywhere else bypasses
 * validation, typing, and the instance-config layer. This ratchet pins the
 * exact per-file baseline so new direct reads fail closed while the migration
 * slices retire the existing ones file by file (each migration edits the
 * allowlist down in the same diff).
 *
 * Counting convention mirrors tests/scripts/console-usage-budget.test.ts:
 * one site = one non-comment source line containing a process.env access
 * (reads, writes, and whole-object param-default references all count).
 * Per-file reasons live on the allowlist entries; per-site env-allowed
 * justifications arrive with the final slice.
 *
 * Companion: #2192 (baseline audited at the #3235 landing tree).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const srcRoot = resolve(repoRoot, 'src');

const ENV_ACCESS_PATTERN = /process\.env/;

const ALLOWLIST: Record<string, number> = {
  // SSOT env→typed-RuntimeConfig conversion seam; every read is instance-config→env→default.
  'src/config.ts': 34,
  // param-default `env` seam (WHATSOUP_REPO_ROOT) — new typed-field candidate, not a bypass.
  'src/core/arc-binding-health.ts': 1,
  // build-time injected WHATSOUP_GIT_SHA / WHATSOUP_GIT_BRANCH (deploy hook, no typed source).
  'src/core/database-compatibility-early.ts': 2,
  // guard `env: … = process.env` DI seam — keeps the guard unit-testable.
  'src/core/health-bind-guard.ts': 1,
  // bounded MCP key-list passthrough (.map over an explicit key list).
  'src/core/mcp-launcher.ts': 1,
  // WHATSOUP_INTERNAL_JIDS / BOT_ERRORS_JID safety config — slice-3 typed field.
  'src/core/outbound-message-safety.ts': 2,
  // INSTANCE_CONFIG WRITE — multi-instance bootstrap protocol.
  'src/database-compatibility-config.ts': 1,
  // guard `env: … = process.env` DI seam — keeps the guard unit-testable.
  'src/fleet/bind-guard.ts': 1,
  // bounded poll-target env lookup (per-name).
  'src/fleet/health-poller.ts': 1,
  // bounded path env-key lookup.
  'src/fleet/paths.ts': 1,
  // WHATSOUP_DOCKER_ENV + WHATSOUP_NODE detection, PATH ambient — WHATSOUP_NODE is slice-3 typed.
  'src/fleet/platform.ts': 3,
  // bounded credential-presence env check (envKey !== undefined guard).
  'src/fleet/routes/credentials.ts': 1,
  // deliberate ops-token presence scan (Object.entries over process.env).
  'src/fleet/routes/ops-auth.ts': 2,
  // VITEST / VITEST_POOL_ID / VITEST_WORKER_ID test-runner detection.
  'src/fleet/silence-registry-episode-store.ts': 4,
  // TMPDIR + INSTANCE_CONFIG WRITES — multi-instance bootstrap protocol.
  'src/instance-loader.ts': 2,
  // secret resolver W-3 env fallback (process.env[opts.envVar]) — must stay env-late.
  'src/lib/api-key-resolver.ts': 2,
  // outbox config group (BOT_ERRORS_*) + VITEST detection + TMPDIR (env-late by
  // design: lib cannot import config, and config WRITES TMPDIR at load — the env
  // var is the sanctioned lib-side channel) — slice-3 typed outbox module.
  'src/lib/bot-errors-outbox.ts': 19,
  // outbox/alert config (BOT_ERRORS_*, EMIT_ALERT_THROTTLE_MS, WHATSOUP_ALERT_SINK) — slice-3.
  'src/lib/emit-alert.ts': 8,
  // FLEET_HEALTH_VERIFY_GATE rollout enum (off/shadow/warn/enforce) — env-late
  // by design: lib cannot import config, and the dial must flip live without a
  // restart during staged fleet rollouts.
  'src/lib/fleet-health-gate.ts': 1,
  // build-meta env lookup (bounded key list, git identity).
  'src/lib/git-env.ts': 2,
  // INSTANCE_CONFIG read — bootstrap protocol (pairs with config.ts:450).
  'src/lib/instance-context.ts': 1,
  // secret resolver + REQUIRE_OS_KEYRING flag + XDG ambient — resolver stays
  // env-late. Fifth site: lookupEnvCredential, the env-only read for values
  // that are authoritative by contract (launcher-provenanced health token).
  'src/lib/keyring.ts': 5,
  // CLAUDE_CONFIG_DIR ambient Claude path (typed config.claudeConfigDir candidate, slice-4).
  'src/lib/model-advisor.ts': 1,
  // BOT_ERRORS_STATE_DIR + WHATSOUP_INSTANCE + XDG ambient — slice-3 typed outbox.
  'src/lib/recovery-authority-store.ts': 3,
  // bootstrap-early logger (LOG_LEVEL/LOG_DIR/VITEST) — cannot import config (eval-order cycle).
  'src/logger.ts': 3,
  // preflight import probe (2) — remaining after the slice-2 migrations.
  'src/main.ts': 2,
  // memory-write API key resolver — must stay env-late (secret surface).
  'src/mcp/register-all.ts': 1,
  // whole-object process.env → resolveReleaseIdentity (build/release identity).
  'src/runtimes/agent/capability-obligation-runtime.ts': 1,
  // exemplar pure resolver `env: Env = process.env` param-defaults — the idiom to extend.
  'src/runtimes/agent/handoff-distill-config.ts': 3,
  // passes env into the pure resolver at the call boundary (not a bypass).
  'src/runtimes/agent/handoff-distill-coordinator.ts': 2,
  // child-env forward for canary probe (explicit allow-list of ambient vars).
  'src/runtimes/agent/provider-canary-proof.ts': 6,
  // child-env builder: explicit allow-list, not passthrough — highest-leak-risk seam.
  'src/runtimes/agent/providers/child-env.ts': 35,
  // VITEST/NODE_ENV detection + `deps.env ?? process.env` DI seam.
  'src/runtimes/agent/providers/claude-filestore-heal.ts': 2,
  // child-env forward (HOME/PATH/USER/CLAUDE_CONFIG_DIR) for usability adapters.
  'src/runtimes/agent/providers/primary-model-usability-adapters.ts': 4,
  // WHATSOUP_PROVIDER_FALLBACK_* + DIAGNOSTIC_BUNDLE tunables — slice-3 typed fallback config.
  'src/runtimes/agent/runtime-tunables.ts': 6,
  // RESPONSE_REGISTRY_DISPATCH + DIAGNOSTIC_BUNDLE flags — slice-2/3 typed fields.
  'src/runtimes/agent/runtime-turn-result-handler.ts': 2,
  // child-env forward (HOME/PATH/USER/CLAUDE_CONFIG_DIR) for the auth-status probe.
  'src/runtimes/agent/runtime.ts': 4,
  // positiveIntEnv dynamic-key helper + CLAUDE_CONFIG_DIR ambient (gemini keys migrated in slice-1).
  'src/runtimes/agent/session.ts': 2,
  // BOT_ERRORS_RUNTIME_TOOL_FAILURE_ALERTS flag — slice-3 outbox/alert field.
  'src/runtimes/agent/tool-failure-alert.ts': 1,
  // MW_MIND_RUN_ID external-subsystem per-run id (read 3×, same value).
  'src/runtimes/chat/enrichment/fact-export-queue.ts': 3,
  // transcription model/python path — slice-4 typed config.transcription.fasterWhisper.*.
  'src/runtimes/chat/providers/transcription/faster-whisper.ts': 2,
  // PATH ambient executable lookup.
  'src/runtimes/chat/providers/transcription/local-audio.ts': 1,
  // transcription model/bin path — slice-4 typed config.transcription.whisperCpp.*.
  'src/runtimes/chat/providers/transcription/whisper-cpp.ts': 2,
  // WHATSOUP_PAIR_NUMBER transport pairing — slice-3 typed field.
  'src/transport/auth.ts': 4,
  // WHATSOUP_BAILEYS_VERSION param-default — slice-3 typed field.
  'src/transport/baileys-version.ts': 1,
  // bounded relay env key lookup.
  'src/transport/imessage/imsg-rpc-relay.ts': 1,
};

function collectSrcFiles(): string[] {
  return readdirSync(srcRoot, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.ts'))
    .map((d) => resolve(d.parentPath || srcRoot, d.name));
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function collectEnvSites(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of collectSrcFiles()) {
    const relative = file.replace(repoRoot + '/', '');
    const lines = readFileSync(file, 'utf8').split('\n');
    let count = 0;
    for (const line of lines) {
      if (isCommentLine(line)) continue;
      if (ENV_ACCESS_PATTERN.test(line)) count += 1;
    }
    if (count > 0) counts.set(relative, count);
  }
  return counts;
}

describe('process.env read allowlist ratchet', () => {
  it('every direct process.env access in src/ matches the pinned baseline exactly', () => {
    const actual = Object.fromEntries([...collectEnvSites().entries()].sort());
    const expected = Object.fromEntries(Object.entries(ALLOWLIST).sort());
    expect(
      actual,
      'Direct process.env access outside the pinned baseline. Route new '
        + 'values through the typed config (src/config.ts) or, for genuinely '
        + 'env-late seams, extend the allowlist consciously in the same diff.',
    ).toEqual(expected);
  });

  it('scanner sanity: the SSOT seam itself is present (smoke)', () => {
    // config.ts is the conversion layer and must always appear — if it ever
    // vanishes from the scan, the file discovery is broken, not the code.
    expect(collectEnvSites().get('src/config.ts')).toBeGreaterThan(0);
  });
});
