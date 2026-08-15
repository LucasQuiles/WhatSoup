# 2192-s4 — slice-4 design scout: transcription family + remaining env stragglers

- **Surveyed at:** detached worktree at `origin/main` = `22d0a95bb851db72786ac5783d436bf2febe89a3` (tip commit: `config: absorb three boolean feature flags; keep the rollout dial env-late (#3238)` — fetched fresh this session)
- **Mode:** LOCAL-ONLY, read-only. No GitHub writes, no pushes, no mutation of existing worktrees (survey worktree lived under `/tmp/opencode`, removed after the scout).
- **Format:** q-pi2's home-relative `reviews/2192-s3-design.md` was **unreachable** (no ssh key for q-pi2 as q/q-pi/lucas/root over tailnet) — this report uses the task's fallback format verbatim.
- **Verification tools actually run:** `scripts/ring-boundary-guard.ts` against the survey worktree (output: `arch.ring-boundaries: 46 violation(s), at baseline (recorded debt)`), plus a one-off runner importing the guard's exported `countRingViolations` to enumerate the per-edge debt list (46/46 edges captured, reproduced in §3). Everything else is source reading at the pinned SHA.

## 1. Ratchet context

| Ratchet | Pin | Interaction with this slice |
|---|---|---|
| `tests/scripts/env-read-allowlist.test.ts` (#3236) | per-file, comment-excluded `process.env` line counts; in-scope files: config.ts 34, arc-binding-health 1, model-advisor 1, auth 4, baileys-version 1, platform 3, runtime-tunables 6, runtime-turn-result-handler 2, faster-whisper 2, whisper-cpp 2, local-audio 1 | every mover edits counts in the same diff; survivors get rewritten per-var reasons (the #3238 fleet-health-gate pattern: the old "typed candidate" promises on kept vars are replaced with real grounds) |
| `arch.ring-boundaries` guard (baseline 46 in `.claude/fitness/baseline.json`, twin row `docs/architecture/fitness-taxonomy.md:282`) | TOTAL count ratchet over `src/**`; count>46 fails, count<46 fails demanding the twins drop, same-commit add+remove swap holds flat (guard header `scripts/ring-boundary-guard.ts:20-24`) | a NEW `import { config }` from runtimes/transport/core/lib is +1 finding → FAIL unless offset. Verified at HEAD by running the guard. |
| Ring map (`eslint-rules/ring-boundaries.mjs:62-99`) | shared=lib/logger/errors(0) < domain=core/transport-contract/runtimes-types(1) < adapter=transport(2) < runtime=runtimes/mcp(3) < composition=fleet/**/`src/config`/instance-loader/main/bootstrap*(4) | `src/config` is ring 4: runtimes→config imports are findings; **fleet→config is ring-legal (4→4)** |
| #3237 (slice 2) | absorb pattern: typed field with instance-config first / env second / default; config.ts count 28→31 as the seam absorbs; consumer entries drop; TMPDIR stays published (`src/config.ts:526` `process.env.TMPDIR = processTmpDir`) | seam (b) publish-then-read: consumer env reads REMAIN (entry not retired); only direct typed reads or param-DI retire entries |
| #3238 (slice 2b) | `autoRestore: config.authBondAutoRestore` passed into guard deps (`src/transport/connection.ts:595+`), guard env fallback → plain default; `oneMessageHandoff`: env-reading fn **deleted** from pure `fallback-config.ts`, runtime (grandfathered importer) supplies value as explicit param — in-code comment: "keeping this module and handoff-notice-prefix pure and inside the ring rules (runtimes must not import src/config.ts)"; FLEET_HEALTH_VERIFY_GATE kept env-late on three named grounds; mid-test env toggles became config-mock/field mutations | seam (a) canonical shape for this slice; seam (c) requires explicit per-var grounds, not "candidate" promises |

## 2. Verdict at a glance

Seams: **(a)** param-DI / typed read via grandfathered importer · **(b)** config-publishes-env bridge · **(c)** keep env-late with explicit reasons.

| Var | file:line | read-time | seam | conf | why |
|---|---|---|---|---|---|
| WHATSOUP_FASTER_WHISPER_MODEL | faster-whisper.ts:13 | module-eval | **c** | MED | host-local toolchain pick; retirement needs factory-DI through non-grandfathered processor.ts; per-instance desire unknowable from code |
| WHATSOUP_FASTER_WHISPER_PYTHON | faster-whisper.ts:17 | call-time | **c** | MED-HIGH | ambient venv toolchain; absence drives the managed-venv auto-probe chain (absence-is-load-bearing) |
| WHATSOUP_WHISPER_CPP_MODEL | whisper-cpp.ts:9 | module-eval | **c** | MED | host-level model path under `~/.local/share/whatsoup` |
| WHATSOUP_WHISPER_CPP_BIN | whisper-cpp.ts:12 | call-time | **c** | MED-HIGH | explicit binary override resolved via resolveBinaryPath; ambient toolchain |
| PATH (ambient) | local-audio.ts:37 | call-time | **c** | HIGH | OS ambient; `?? DEFAULT_EXECUTABLE_PATH` fallback exists for stripped service envs — absence handling is load-bearing |
| CLAUDE_CONFIG_DIR | model-advisor.ts:238 | call-time | **c** now, **(b)** if ever typed | MED-HIGH | external-tool interop var; must track the env the spawned claude CLI sees; vitest isolation setup deletes it (`tests/setup/bot-errors-vitest-isolation.ts:91`) — env is the sanctioned channel |
| WHATSOUP_PAIR_NUMBER | auth.ts:121,214,222,243 | call-time | **c** | MED | per-CLI-invocation mode selector (QR↔pairing-code) + operator PII input; mechanically absorbable (grandfathered import) but persists E.164 at rest and makes an ephemeral per-run choice permanent instance state |
| WHATSOUP_BAILEYS_VERSION | baileys-version.ts:15 (param-default) | call-time (per connect) | **a — MOVE** | MED-HIGH | pure resolver + param-default already; connection.ts (grandfathered :25) passes `config.baileysVersionPinned`; exact #3238 authBondAutoRestore shape |
| WHATSOUP_NODE | platform.ts:153 | call-time (plist build) | **c** | MED-HIGH | set by deploy wrappers in the *generating* shell; host-level, pre-instance; platform.ts→config import would couple the platform detector + deploy/setup tests to config's import-time mkdir side effects |
| WHATSOUP_PROVIDER_FALLBACK_NOTICE_DEDUP_MS | runtime-tunables.ts:41 | module-eval | **a — MOVE** | MED | tuning knob (not a rollout dial) beside typed `agentOptions.fallbacks[]`; consumers reachable via `RuntimeFallbackPort` host DI (constructor runtime-fallback.ts:210) |
| WHATSOUP_PROVIDER_FALLBACK_PRIMARY_RECHECK_MS | runtime-tunables.ts:45 | module-eval | **a — MOVE** | MED | same; clamp [30s,30m] preserved in config resolution |
| WHATSOUP_PROVIDER_FALLBACK_PROBE_STALL_THRESHOLD | runtime-tunables.ts:58 | module-eval | **a — MOVE** | MED | same; clamp [3,100] |
| WHATSOUP_PROVIDER_FALLBACK_PROBE_STALL_CEILING_MULTIPLE | runtime-tunables.ts:64 | module-eval | **a — MOVE** | MED | same; clamp [1,1000] |
| WHATSOUP_DIAGNOSTIC_BUNDLE | runtime-tunables.ts:72 + runtime-turn-result-handler.ts:757 (dup) | call-time | **c** | MED-HIGH | staged-rollout flag pair member ("Requires WHATSOUP_RESPONSE_REGISTRY_DISPATCH"); transitional migration flag — typed-field investment likely throwaway; fleet-health-gate ground #1 applies |
| WHATSOUP_RESPONSE_REGISTRY_DISPATCH | runtime-turn-result-handler.ts:75 | call-time | **c** | MED-HIGH | rollout dial ("Enable first, confirm green in production"); equivalence-locked transitional flag; 3 test files toggle mid-run relying on call-time env |
| WHATSOUP_REPO_ROOT | arc-binding-health.ts:35 (param-default) | call-time | **c** (keep param seam) | MED-HIGH | deploy-wrapper assertion input (launchd plists + setup.sh pin the reviewed checkout); resolver *validates* env↔module-location agreement — config-sourcing is self-referential |

Slice-3 annotation corrections this scout owes the allowlist (all #3238-style honesty fixes, land with Car 2/3 diffs or a doc-only car): model-advisor "typed config.claudeConfigDir candidate" → interop-var grounds; platform "WHATSOUP_NODE is slice-3 typed" → generating-shell grounds; auth "slice-3 typed field" → per-invocation PII grounds; arc-binding-health "typed-field candidate" → assertion-input grounds; transcription "slice-4 typed config.transcription.*" → host-toolchain grounds; runtime-turn-result-handler "slice-2/3 typed fields" → rollout-dial grounds (already half-corrected by #3238's dispatch entry? no — the entry still promises typed).

## 3. Full site map (verified at 22d0a95bb)

**faster-whisper.ts** — `:13` MODEL module-eval const (used :38 `--model`, :50 log). `:17` PYTHON inside `resolvePython()` (callers: `transcribeWithFasterWhisper:31`, `isAvailable:57`) — absence → VENV probe chain → `null` → "not installed". **whisper-cpp.ts** — `:9` MODEL module-eval (used :31,36,42,49; absence → homedir default; missing file → throw). `:12` BIN inside `resolveWhisperCli()` (call-time; absence → `whisper-cli` on PATH). **local-audio.ts** — `:37` PATH inside `resolveBinaryPath()` (call-time; serves whisper-cli, ffmpeg via `withNormalizedAudioFile:158`, arch-suffix retry :47-54). **model-advisor.ts** — `:238` inside `claudeCredentialsPath()` → `resolveClaudeOAuthCred:263` → `fetchAnthropicModelIdsWithStatus:305` (call-time; `|| ~/.claude` fallback). **auth.ts** — `:121` QR gate (unset→print QR), `:214` pairingGate, `:222` deferred requestPairingCode, `:243` main() validation (all call-time; unset→QR is the default path). **baileys-version.ts** — `:15` param-default of `parsePinnedBaileysVersion`, called `:39` from `resolveBaileysVersion` (per connection attempt). **platform.ts** — `:41` WHATSOUP_DOCKER (memoized `detectPlatform`), `:150` PATH (plist generation), `:153` WHATSOUP_NODE → plist `EnvironmentVariables` block `:195-199` (omitted when unset). **runtime-tunables.ts** — `:8` `envPositiveInt` dynamic-key helper (also mediates WHATSOUP_SESSION_IDLE_MS/SWEEP/ZOMBIE/AMBIGUOUS/MAX_SESSIONS/MIN_RESIDENCY + SYSTEM_TURN_TIMEOUT at :17-28,99 — NOT direct reads, invisible to the per-line count); `:41,45,58,64` module-eval IIFEs (file header :1-4 states module-eval is deliberate, preserving the original runtime.ts read timing); `:72` `diagnosticBundleEnabled()` call-time. **runtime-turn-result-handler.ts** — `:75` `responseRegistryDispatchEnabled()` call-time; `:757` **local duplicate** of `diagnosticBundleEnabled()` call-time. **arc-binding-health.ts** — `:35` `env: { WHATSOUP_REPO_ROOT?: string } = process.env` param-default of `resolveArcRepoRoot`; semantics: explicit root accepted only if `realpath === realpath(SOURCE_REPO_ROOT)` else `{loaded:false}`.

**46-edge ring debt (guard output, grouped):** config.ts imported from: core×10 (access-policy, admin, command-router, durability, health×2, heal, ingest, media-download + transport-runtime-connection×3/adapter), lib×1 (http→fleet/discovery), mcp×8, runtimes×17 (incl. **runtime-turn-result-handler.ts:7**, **runtimes/agent/runtime.ts:251**, media-prep.ts:15, **transcription/openai-whisper.ts:2**), transport×2 (**auth.ts:19**, connection.ts:25), plus core→runtimes×1. Grandfathered importers relevant here: auth.ts, connection.ts, runtime.ts (agent), runtime-turn-result-handler.ts, openai-whisper.ts, media-prep.ts, mcp/tools/media.ts:13, runtimes/chat/runtime.ts:34. NOT importers (new config import = +1 finding): faster-whisper, whisper-cpp, local-audio, chain, model-advisor (lib, impossible), runtime-tunables, runtime-fallback, platform.ts (legal ring 4→4 but see §7 platform entry), media/processor.ts, session.ts.

## 4. Caller spread where DI is considered

**Transcription chain** — `transcribeAudio(buffer, mimeType)` (chain.ts:38) called from: `src/runtimes/chat/media/processor.ts:114` (static import; processor NOT a config importer; its own caller is the chat stack incl. grandfathered runtimes/chat/runtime.ts:34), `src/mcp/tools/media.ts:502` (dynamic; grandfathered), `src/runtimes/agent/media-prep.ts:140` (dynamic; grandfathered). Providers are module consts (`fasterWhisperProvider` etc.) assembled in `chain.ts:10-12`. Any typed-config retirement means factory-izing providers + threading a tunables param through a seam mocked in 5 test files — the cost floor that sinks the transcription "typed" verdicts. `resolveBinaryPath` additionally serves `src/main.ts:948` (ffmpeg preflight) — a PATH lookup shared beyond transcription.

**Provider-fallback tunables** — consts consumed by `runtime-fallback.ts` at :737, :805, :1259, :1308, :1312, :1332, :1378, :1399 (class with `constructor(host: RuntimeFallbackPort)` :210 — the 3a ToolFailureAlertDeps-style host seam exists) and by `runtimes/agent/runtime.ts` (imports :83-91; uses incl. :800, :8055). runtime.ts is a grandfathered config importer (:251) → legal supply point.

**Baileys pin** — `resolveBaileysVersion()` ← `transport/connection.ts` (grandfathered :25). Single-caller param-DI; zero spread.

**WHATSOUP_NODE** — `buildPlist()` used only inside platform.ts (:389, :416 via the service-manager backend); platform.ts's export surface consumed by fleet/index.ts:32, fleet/routes/*:36-37, main.ts:82 (`createServiceManager`). Threading config in means touching every `createServiceManager` caller AND platform.ts still hosts WHATSOUP_DOCKER (:41) + PATH (:150) which can never move — partial retirement splits a coherent generation-time env block for one line.

## 5. Per-var migration recipes (movers)

### Car 1 — WHATSOUP_BAILEYS_VERSION → `config.baileysVersionPinned` (S)
1. `src/config.ts`: add `baileysVersionPinned: optionalString(env-or-instance)` — instance-config first (`transport.baileysVersion`), env `WHATSOUP_BAILEYS_VERSION` second, undefined default. Keep the RAW string unvalidated here only if you must preserve today's throw-at-connect timing; preferred (name the delta in the PR): validate the dotted-tuple at config load mirroring `baileys-version.ts:19-33` rules so SET-but-invalid fails loud at startup (matches config's `requireFiniteNumber` philosophy). allowlist: config.ts 34→35.
2. `src/transport/connection.ts`: at the existing version-resolution call site, pass the pinned tuple: parse `config.baileysVersionPinned` via `parsePinnedBaileysVersion(raw)` — the param-default at baileys-version.ts:15 drops to plain `raw: string | undefined = undefined` (exact #3238 guard-fallback shape). allowlist: baileys-version 1→0 (entry removed).
3. Tests: `tests/transport/baileys-version.test.ts` keeps param-based cases; its env-default case (if any) becomes an explicit-arg or config-resolution case. Run: `npx vitest run --pool=forks tests/transport/baileys-version.test.ts tests/scripts/env-read-allowlist.test.ts` + `npm run typecheck`.
4. docs/configuration.md: env row → instance field row (or env-secondary row), citing connection.ts.
5. Named behavior deltas: (i) pin changes now need restart (today each connection attempt re-reads env — live-flip loss; operational sign-off in open questions); (ii) invalid values throw at load, not first connect.

### Car 2 — 4× PROVIDER_FALLBACK_* → `agentOptions.fallbackTunables.*` (M)
1. `src/config.ts`: under the existing `agentOptions` section, add `fallbackTunables: { noticeDedupMs, primaryRecheckMs, probeStallThreshold, probeStallCeilingMultiple }` — instance-config first, env second, **defaults and clamps byte-identical to runtime-tunables.ts:41-67** (30m/5m clamp[30s,30m]/12 clamp[3,100]/10 clamp[1,1000]); unit-test the clamps at the config layer. allowlist: config.ts → +4.
2. `src/runtimes/agent/runtime-tunables.ts`: delete the four IIFEs (file header comment updated: env reads that remain are the helper + DIAGNOSTIC_BUNDLE). allowlist: 6→2.
3. `src/runtimes/agent/runtime-fallback.ts`: extend `RuntimeFallbackPort` with the four values (grouped object, not 4 scalars); replace the 8 const references with host reads. `runtimes/agent/runtime.ts` (grandfathered) constructs the host from `config.agentOptions.fallbackTunables`; its own direct uses (:800, :8055) read config directly.
4. Tests: `fallback-probe-stall-env.test.ts` + `fallback-probe-stall-ceiling-env.test.ts` re-anchor from `vi.hoisted` env sets to instance-config fixtures/config-mock field mutations (#3238 handoff-test precedent, save-restore discipline); their clamp assertions move to the config-resolution tests. `fallback-probe-stall.test.ts` — not fully read this scout; verify whether it sets env or only references the constant (grep hit only). `fallback-persistence-integration.test.ts:193` is a comment-only reference — zero cost.
5. Read-time honesty: module-eval today → typed config tomorrow = restart-to-change in BOTH worlds; no live-flip regression. Run the four test files + allowlist + typecheck; full agent battery before push (push-gate subset caveat per CLAUDE.md).

## 6. Keep-env-late reasons (survivors) — the text for the rewritten allowlist entries

- **faster-whisper MODEL/PYTHON, whisper-cpp MODEL/BIN (5 sites):** host-local transcription toolchain (managed venv, whisper-cli, GGML paths) — deployment facts, not per-instance preference; the one per-instance transcription concern (OpenAI endpoint/key) already has its typed field (`config.transcriptionOpenAIProviderConfig`, consumed by the dir's only grandfathered importer). Retirement would require factory-DI threaded through non-grandfathered `media/processor.ts` and a seam mocked in 5 test files — cost with no demonstrated per-instance need. PYTHON/BIN absence is load-bearing (auto-probe chains); MODEL reads are module-eval so typed migration wouldn't even change liveness.
- **PATH (local-audio:37):** ambient OS contract; `DEFAULT_EXECUTABLE_PATH` fallback exists precisely for stripped service environments.
- **CLAUDE_CONFIG_DIR (model-advisor:238):** mirrors the claude CLI's own resolution to find the same credentials file the CLI writes/reads; spawned CLI children receive it via child-env forwards (child-env.ts, session.ts, runtime.ts, primary-model-usability-adapters.ts) — one env var is the interoperability contract across all readers; a WhatSoup-side typed field could desync from the CLI's actual env unless also published. The vitest isolation setup deletes it (`bot-errors-vitest-isolation.ts:91`), proving env is the sanctioned channel. If per-instance claude dirs are ever wanted: seam (b), instance-value-only publish-then-read (slice-3a pattern), fixing model-advisor + session.ts:1161 + child forwards at once.
- **WHATSOUP_PAIR_NUMBER (auth ×4):** per-CLI-invocation mode selector and operator PII (E.164 phone) input; env keeps it ephemeral (nothing persisted post-pairing) while instance.json would store the number at rest and silently re-engage pairing mode on future re-auth of a registered instance (pairingGate only checks `registered`); the fleet relink contract is env-spawn + stdout JSON. bootstrap-auth does load config, so the mechanics exist — the grounds are semantic.
- **WHATSOUP_NODE (platform:153):** set by deploy wrappers (`deploy/whatsoup*`, resolve-node.sh) in the plist-GENERATING shell; docs promise "when set in the generating process's environment"; host-level and pre-instance. platform.ts must stay importable by deploy/setup tests without config's mkdir side effects; siblings (:41 docker sentinel, :150 PATH) are unmovable anyway.
- **DIAGNOSTIC_BUNDLE + RESPONSE_REGISTRY_DISPATCH:** staged rollout pair with documented enable ordering (configuration.md:314-315, docs/runbooks/error-response-workflows.md); fleet-health-gate ground #1 (rollout dial, not a preference) applies; both read call-time and 3 test files toggle mid-run on that. If the registry reaches GA these flags delete — typed-field investment likely throwaway. (Live-flip *operator* need is unknowable from code; the in-process call-time semantics are what tests pin.)
- **WHATSOUP_REPO_ROOT (arc-binding-health:35):** the value asserts "the env the wrapper gave me points at the checkout I am running from" — set per-invocation by launchd plists and setup.sh; the resolver *validates* env↔source-location agreement, so re-sourcing it from config (which lives inside the validated tree) is self-referential. Keep the exemplar param-default seam verbatim; reason text updated from "typed-field candidate" to "deploy-wrapper assertion input".

## 7. Toggling-test inventory + adaptation cost

| Test file | Var(s) | Mechanism today | Adaptation |
|---|---|---|---|
| tests/transport/baileys-version.test.ts | BAILEYS_VERSION | param + env-default | LOW (Car 1) |
| tests/runtimes/agent/fallback-probe-stall-env.test.ts | STALL_THRESHOLD | `vi.hoisted` pre-import env (header: import-time const) | MEDIUM (Car 2) — re-anchor to config fixture/mock; clamps → config tests |
| tests/runtimes/agent/fallback-probe-stall-ceiling-env.test.ts | CEILING_MULTIPLE | same | MEDIUM (Car 2) |
| tests/runtimes/agent/fallback-probe-stall.test.ts | STALL_THRESHOLD | grep hit; **not fully read** | verify; likely LOW |
| tests/runtimes/agent/fallback-persistence-integration.test.ts | PRIMARY_RECHECK | comment-only (:193) | ZERO |
| tests/runtimes/agent/runtime-turn-result-handler.test.ts | RESPONSE_REGISTRY | mid-run set/delete (:271,278,301) | NONE (kept env) |
| tests/runtimes/agent/runtime-edge-coverage.test.ts | DIAGNOSTIC + RESPONSE_REGISTRY | mid-run set/delete (:712,716-717,869); config already mocked (`mockConfig`) | NONE (kept env) |
| tests/runtimes/agent/runtime.test.ts | RESPONSE_REGISTRY | referenced | NONE |
| tests/runtimes/chat/providers/transcription/whisper-providers.test.ts | all 4 transcription vars | beforeEach set/delete + `vi.resetModules()` cold-load (:145-151, :239-246) | NONE (kept env) |
| tests/runtimes/chat/providers/transcription-chain-integration.test.ts | absence semantics | depends on "clean CI env" unavailability (:98-106) | NONE |
| 11 files incl. setup/bot-errors-vitest-isolation.ts, session/child-env/filestore tests | CLAUDE_CONFIG_DIR | isolation delete + forwards | NONE |
| arc/health/setup-platform/launchd-drift/drain-stuck-replies/check-service-units/release-drift tests | WHATSOUP_REPO_ROOT | param env objects + wrapper contracts | NONE |
| tests/scripts/env-read-allowlist.test.ts | ALL | count pin | mandatory per car (LOW, exact numbers §8) |
| deploy/preflight-check / setup-platform / whatsoup-health-token-wrapper / platform.test / bot-errors-health-check / hooks-installed-guard / pre-push-guard / run-with-pinned-node-symlink / wrapper-node-version-gate | WHATSOUP_NODE | wrapper/tooling contract | NONE (kept env) |

No deploy/ or .github/ template sets any PROVIDER_FALLBACK_*/DIAGNOSTIC/RESPONSE_REGISTRY/transcription var (verified by grep) — no unit-template collisions for the cars.

## 8. Allowlist delta (post-train, Cars 1+2)

| File | now | after | delta |
|---|---|---|---|
| src/config.ts | 34 | 39 | +1 baileys, +4 fallback tunables |
| src/transport/baileys-version.ts | 1 | 0 | entry removed |
| src/runtimes/agent/runtime-tunables.ts | 6 | 2 | −4 (helper :8 + DIAGNOSTIC :72 remain, reasons rewritten) |
| all other in-scope files | — | — | unchanged counts; reasons rewritten per §6 |

Net: 21 in-scope pinned lines → 16; 10 in-scope file entries → 9.

## 9. One-PR car plan (easiest→hardest)

1. **Car 1 (S):** baileys pin → typed field (single-caller param-DI, 1 test file, allowlist 35/0). Includes the configuration.md row move.
2. **Car 2 (M):** provider-fallback tunables → `agentOptions.fallbackTunables` (host-port DI + runtime.ts supply; 2 env test files re-anchored; clamps unit-tested at config layer; allowlist 39/2).
3. **Car 3 (doc-only, S):** allowlist reason rewrites for all §6 survivors + configuration.md stale-anchor fixes (PAIR_NUMBER cited auth.ts:104,210 → actual :121,214,222,243; WHATSOUP_NODE cited platform.ts:105 → :153). No count changes; can ride with Car 2 instead if preferred.
- Out of this train (follow-up, not folded in): `diagnosticBundleEnabled` dedup (see §11), config-side typing of transcription provider config (see §11.3), the helper-mediated session tunables (a future slice's decision, ratchet-blind-spot noted).

## 10. Risks / open questions

- **Live-flip loss on the Baileys pin** (restart-to-change after Car 1): today a re-pin takes effect on the next connection attempt without restart. Operator sign-off wanted; if live-flip is required, Car 1 must instead adopt a call-time `config`-accessor (config object is load-frozen) or stay env — **unknowable from code, hence MED-HIGH not HIGH**.
- **Clamp relocation regressions** (Car 2): the [30s,30m]/[3,100]/[1,1000] clamps must be re-pinned in config-layer tests before the tunables IIFEs are deleted.
- **Rollout-flag fate:** if RESPONSE_REGISTRY_DISPATCH is transitional (registry GA deletes the legacy ladders), the keep-env verdict is permanent; if it becomes a standing feature toggle, revisit as a typed boolean via the already-grandfathered import in turn-result-handler. Owner question.
- **RuntimeFallbackPort growth** (Car 2): one grouped object field, not four scalars, to avoid port bloat.
- Not verified: full test suite / typecheck (read-only scout; only the lint guard was executed); runtime.ts's exact diagnosticBundleEnabled call line (import at :85 confirmed); fallback-probe-stall.test.ts internals; openai-whisper.ts lines 81-160; q-pi2 s3 format.

## 11. Out-of-scope latent findings (flagged, not folded)

1. **Duplicate `diagnosticBundleEnabled`** — runtime-tunables.ts:71-73 (exported; used by runtime.ts) vs runtime-turn-result-handler.ts:756-758 (local). Divergence risk if one changes semantics; dedup is a follow-up, not part of any car here.
2. **docs/configuration.md stale anchors** for WHATSOUP_PAIR_NUMBER and WHATSOUP_NODE (§9 Car 3).
3. **openai-whisper.ts:30 double-cast**: `config.transcriptionOpenAIProviderConfig as OpenAIProviderConfig | undefined` — config types the field as `Record<string, unknown>` and the consumer re-casts. Future transcription typing should define the shape config-side rather than extend the cast pattern.
4. **Ratchet blind spot:** `envPositiveInt` (runtime-tunables.ts:8) mediates ~8 WHATSOUP_* session/system vars that never appear in the per-line allowlist count — by design (the helper is the single counted seam) but worth naming in the final slice's per-site justification pass.

---

## CORRECTIONS (appended post-landing; scout text above preserved verbatim)

1. **§4 "Baileys pin — single-caller param-DI; zero spread" under-counted.**
   `resolveBaileysVersion()` had TWO src callers at survey time:
   `transport/connection.ts:857` AND `transport/auth.ts:88` (both grandfathered
   config importers). Car s4a (#3245) converted both; the 3245 adversarial
   review independently confirmed the second conversion was required for a
   complete retirement.
2. **§5 Car 2 field path.** The recipe names `agentOptions.fallbackTunables.*`
   as the config field; the landed shape (#3247) is a top-level
   `config.fallbackTunables` grouped object RESOLVED FROM the
   `agentOptions.fallbackTunables.*` instance-config section — consistent with
   how other agentOptions-sourced values surface flat on config
   (agentProvider, agentFallbacks).
