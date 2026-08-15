// Pure, env-derived runtime tunables extracted from runtime.ts (2026-08-11,
// arch.file-size headroom — see docs/architecture/fitness-taxonomy.md "Growing
// past a ceiling"). Module-evaluation-time env reads, no runtime state: the
// import from runtime.ts preserves the original read timing exactly.
import { MS_PER_MINUTE, MS_PER_HOUR, MS_PER_DAY } from '../../lib/time-units.ts';

export const envPositiveInt = (key: string, fallback: number): number => {
  // env-allowed: dynamic-key helper for session tunables; the counted seam by design
  const raw = Number(process.env[key]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
};

// Idle per-chat agent session lifecycle bounds. A resident session idle (no
// message) beyond SESSION_IDLE_MS is suspended; sessions support --resume so the
// next message rehydrates. MAX_RESIDENT_SESSIONS is an LRU ceiling so a burst of
// distinct chats cannot pin unbounded memory; SESSION_MIN_RESIDENCY_MS is an
// anti-thrash floor so a freshly-spawned session is never immediately evicted.
export const SESSION_IDLE_MS = envPositiveInt('WHATSOUP_SESSION_IDLE_MS', MS_PER_HOUR); // 1h
export const SESSION_SWEEP_INTERVAL_MS = envPositiveInt('WHATSOUP_SESSION_SWEEP_MS', 10 * MS_PER_MINUTE); // 10m
// #1756: the agent_sessions DB classifier used to run startup-only, so an
// init-failure session landing in the 'ambiguous' bucket was skipped forever.
// ZOMBIE_SESSION_SWEEP_INTERVAL_MS re-runs the classifier periodically;
// AMBIGUOUS_SESSION_MAX_AGE_MS is the age (with zero processed messages)
// past which an ambiguous row is independently re-verified and, if still not
// alive+owned, marked terminal (see resolveAmbiguousAgeFallback).
export const ZOMBIE_SESSION_SWEEP_INTERVAL_MS = envPositiveInt('WHATSOUP_ZOMBIE_SWEEP_MS', 30 * MS_PER_MINUTE); // 30m
export const AMBIGUOUS_SESSION_MAX_AGE_MS = envPositiveInt('WHATSOUP_AMBIGUOUS_SESSION_MAX_AGE_MS', MS_PER_DAY); // 24h
export const MAX_RESIDENT_SESSIONS = envPositiveInt('WHATSOUP_MAX_SESSIONS', 12);
export const SESSION_MIN_RESIDENCY_MS = envPositiveInt('WHATSOUP_SESSION_MIN_RESIDENCY_MS', 5 * MS_PER_MINUTE); // 5m

export const MAX_TOOL_FAILURE_ALERT_DEDUP_KEYS = 1_000;

// Default provider-fallback window when the usage-limit message names no reset
// time. Claude usage limits operate on 5-hour rolling windows, so 5h is a safe
// upper-bound estimate for when the primary provider becomes available again.
export const DEFAULT_FALLBACK_WINDOW_MS = 5 * MS_PER_HOUR; // 18_000_000 ms (5h)
// Clamp the fallback window so a malformed/adversarial reset time can neither
// revert almost immediately nor pin the fallback for an unreasonable span.
export const MIN_FALLBACK_WINDOW_MS = MS_PER_MINUTE; // 1 minute
export const MAX_FALLBACK_WINDOW_MS = MS_PER_DAY; // 24 hours
// The four WHATSOUP_PROVIDER_FALLBACK_* tunables (notice dedup, primary
// recheck, probe-stall threshold, stall-ceiling multiple) moved to
// config.fallbackTunables (#2192 s4b) — instance-config first, env fallback,
// identical defaults and clamps — and reach consumers via RuntimeFallbackPort.
// The primary model usability probe has its own longer CLI deadline in
// primary-model-usability-adapters.ts; shorter binary presence checks keep
// their 5 s preflight timeout in providers/binary-preflight.ts.
// Opt-in: on an arming provider failure (via the registry dispatcher), run the
// best-effort diagnostic bundle and emit its findings to the alert outbox.
// Fire-and-forget — never blocks, delays, or alters the turn's fallback path.
export function diagnosticBundleEnabled(): boolean {
  // env-allowed: staged-rollout dial; live-flip semantics, flag deletes at GA
  return process.env['WHATSOUP_DIAGNOSTIC_BUNDLE'] === '1';
}
// Guardrail: the diagnostic bundle probes the PRIMARY provider's health, which
// is instance-global (identical across chats). Throttle it to at most once per
// window so a fallback storm — many chats failing at once, or rapid repeated
// failures — cannot spawn a flurry of CLI auth-status probes, and so we do not
// re-probe the same primary health redundantly.
export const DIAGNOSTIC_BUNDLE_THROTTLE_MS = MS_PER_MINUTE;
// Max age of a handoff artifact before it is considered stale and dropped from
// the injected system block. A stale summary misleads the stand-in, so the
// prelude builder rejects artifacts older than this when composing context.
export const HANDOFF_STALE_MS = 2 * MS_PER_MINUTE;

// Time to wait for an auto-triggered /compact to complete before giving up.
// A /compact must summarize the whole conversation, so on large contexts it can
// legitimately take a few minutes; 2 min was too short and produced false
// timeouts that fed an unbounded-growth spiral. Must stay < SILENT_COMPACT_TTL_MS
// (defined in auto-compact-controller.ts) so the silent-compact flag does not
// expire mid-compaction.
export const AUTO_COMPACT_TIMEOUT_MS = 4 * MS_PER_MINUTE;
// Absolute wall bound for every non-auto provider request owned by the runtime.
// Operator-overridable via WHATSOUP_SYSTEM_TURN_TIMEOUT_MS (positive integer,
// milliseconds): the previously hardcoded bound is implicated in group-turn
// failures where an injected context window full of unanswered asks provokes a
// long, effect-suppressed system turn that blows this timeout (ml-bot
// 2026-08-10 RCA — "no config knob"). Values well above the default extend how
// long a wedged system turn can hold its lane; tune with care.
export const SYSTEM_TURN_TIMEOUT_MS = envPositiveInt(
  'WHATSOUP_SYSTEM_TURN_TIMEOUT_MS',
  AUTO_COMPACT_TIMEOUT_MS,
);
// Cooldown after a timed-out /compact before another auto-compact may be tried.
// Kept short so a session that times out retries soon (bounding how far it grows
// between attempts) rather than degrading for a long window; still long enough to
// prevent a per-turn retry storm. A session that genuinely cannot compact is
// ultimately recovered by the prompt-too-long kill+respawn path.
export const AUTO_COMPACT_TIMEOUT_BACKOFF_MS = 5 * MS_PER_MINUTE;
