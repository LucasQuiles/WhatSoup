# Agent Runtime Probes

Secret-safe diagnostic probes for Claude Code, Codex, OpenCode, and Pi runtime
topology.

Default behavior is intentionally conservative:

- Print names, counts, paths, config keys, and env-var names.
- Do not print raw prompt bodies, auth values, cookies, tokens, or transcript
  contents.
- Do not mutate config.
- Avoid provider calls unless a script has an explicit `--run` or `--live`
  option documenting the tradeoff.

## Scripts

| Script | Purpose | Provider call by default? |
|---|---|---|
| `mutation_proof_chain.py` | CAPE proof-chain attestation spine (plane-agnostic): per-step linear hash chain with dual continuity invariant + chain-id-bound genesis, run-twice+perturbation determinism gate, structural delta-type classifier with fail-closed purpose↔delta constraints (defends structural≠semantic prompt poisoning), frozen closed-field `Attestation`/`Benefit`, and `verify_chain` emitting a metadata-only verdict (hashes/enums/booleans only) | No |
| `cache_stable_prefix_auditor.py` | Measures init/tool-surface churn across >=2 caller-supplied offline Claude stream-json captures (model/permission/tool-set churn with the triggering hash/index datum) plus optional caller-supplied redacted prefix-section map and `opencode stats` cache counters; honest-scope: default mode proves init/tool churn + cache-risk only, NOT raw provider prefix layout | No |
| `bot_errors_proof_ladder.py` | BOT ERRORS proof-class ladder separating code presence, static expectation, historical observation, and live observation | No |
| `bot_errors_daily_health_artifact_probe.py` | BOT ERRORS daily-health artifact adapter; parses a caller-supplied event JSON or evidence text into counts/classes/hashes without raw evidence, provider output, paths, instance names, JIDs, or credential material | No |
| `bot_errors_health_surface_probe.py` | BOT ERRORS health-check source/static surface inventory: daily-health inventory calls, provider failure classes, plugin coverage checks, runtime-manifest markers, managed-component categories, and redacted adapter opportunities without running health checks | No |
| `runtime_doctor.py` | Version/config/state summary for Claude, Codex, OpenCode, Pi | No |
| `runtime_budget_rail.py` | Metadata-only cross-harness budget rail: local config ceilings, state-store pressure, instruction-budget estimates, latest Codex session size, and optional aggregate OpenCode stats without raw transcripts or provider payloads | No provider call; runs local `opencode stats` by default unless `--no-opencode-stats` |
| `compaction_survival_canary.py` | Metadata-only handoff/compaction canary: verifies required evidence/state/safety anchors survive compacted summaries, forbidden payloads stay suppressed, and risky completion claims retain qualifiers without raw source or summary text | No |
| `config_surface_doctor.py` | Allowlisted JSON/TOML/YAML/Markdown/plist/directory/wrapper/capability config-surface inventory with values suppressed | No |
| `codex_hook_dual_path_probe.py` | Codex hook config reconciliation between current `config.toml` hooks and legacy `hooks.json`; emits matchers, counts, command basenames/hashes, and drift flags without raw command strings | No |
| `codex_config_redactor.py` | Codex config-surface redactor over local config/profile/agent/hook files, managed-requirements presence, and optional doctor metadata; scalar values and path-like keys suppressed | No; `--run-doctor` may perform provider/network reachability checks |
| `codex_prompt_input_shape_probe.py` | Codex `debug prompt-input` shape probe; default synthetic fake-root mode and optional `--real-local` mode emit roles, content counts, byte sizes, hashes, and canary booleans without raw model-visible text | No |
| `codex_rules_inventory_probe.py` | Codex `.rules` command-policy inventory; emits rule counts, decisions, line hashes, token families, and risk flags without raw command patterns, URLs, account names, env vars, or local paths from rules | No |
| `codex_rules_runtime_check_probe.py` | Codex `.rules` runtime matcher proof through `codex execpolicy check --rules ... -- <tokens>`; emits case ids, decisions, counts, hashes, token families, and matched-prefix shapes without raw command tokens, matched prefixes, stdout/stderr content, rule paths, shell snippets, URLs, or accounts | No provider call; runs local policy matcher only |
| `codex_session_tool_table_probe.py` | Metadata-only reducer for caller-supplied or latest local Codex session JSONL tool evidence; emits tool names, channel counts, namespace counts, active-vs-used sets, and recorded MCP-vs-static-config reconciliation without raw transcript text, inputs, outputs, provider payloads, paths, or config values | No |
| `tool_schema_budgeter.py` | Metadata-only MCP tool/skill schema budget auditor (Headroom++ A2); offline by default — inventories local MCP/skill config, counts per-tool schema bytes ONLY from a caller-supplied `--schema-artifact` (static config stays `schema_source_class=static_config_only`/`schema_bytes=null`), overlays active-vs-deferred + last-use from `--tool-artifact`, and emits advisory defer-eligibility with `cache_mutation_risk` instead of auto-safe reclaim, without arg values, auth, raw schemas, or descriptions | No |
| `tool_surface_diff.py` | Claude init/tool-table reducer: dry-run by default, offline stream-json parser for supplied captures, and optional live mode for default/safe/bare/tool-filtered diffs; emits tool names/counts and mode metadata without prompt/provider/tool payloads | No by default; `--run` can call provider |
| `claude_observability_hook_probe.py` | Historical Claude observability hook-event metadata reducer; summarizes `metadata/hook_events.jsonl` counts, event/origin/tool classes, stdout/stderr byte totals, hook identity hashes/safe basenames, and duplicate hook/tool-event groups while suppressing paths, session ids, prompt hashes, error text, tool refs, raw hook values, and secret-shaped labels | No |
| `hook_context_profiler.py` | Claude hook event/byte-count profiler with raw stdout/stderr/additionalContext suppressed; dry-run by default, offline `--input-jsonl` parser and duplicate-hook grouping available, and live provider-touching profiling only with explicit `--run` | No by default; `--run` can call the provider |
| `instruction_budget_auditor.py` | Metadata-only instruction/context budget audit for allowlisted instruction files, Codex embedded developer instructions, and skill-description metadata; emits rough token estimates, hashes, path classes, bucket counts, and review findings without raw text or scalar values | No |
| `launchd_plist_inventory_probe.py` | Read-only LaunchAgent/LaunchDaemon plist metadata inventory; emits label/path/argument hashes or classes, env key names, schedule/restart/log shapes, and WhatSoup managed-component summaries without raw plist values or launchctl state | No |
| `loom_memory_line_probe.py` | Metadata-only N6/Loom memory-line implementation proof: local module/test counts, admission/lint/conflict/source-ref capability status, latest battery metrics, optional pytest summary, and README drift without raw memory notes, source text, stdout bodies, or provider payloads | No; `--run-tests` runs local Loom pytest only |
| `managed_config_presence_monitor.py` | Metadata-only monitor for high-precedence Claude/Codex/OpenCode managed config insertion points; emits presence, size/mode classes, parse shapes, key hashes, and payload status without raw paths or values | No |
| `mcp_json_diagnostic.py` | Read-only `.mcp.json` parseability diagnostic; reports absent/valid/fault, size/mode classes, key/server-name hashes, transport counts, and remediation guidance without raw JSON values, command strings, URLs, env values, or mutation | No |
| `mcp_schema_inventory_probe.py` | MCP configured-surface and selected `tools/list` schema inventory; emits tool names, argument-shape counts, description hashes/sizes, side-effect guesses, and skip reasons with values suppressed | No; `--probe-tools` starts selected local stdio MCP servers |
| `model_todo_provenance_probe.py` | Metadata-only provenance probe for Claude/Codex model config and TodoWrite/Task* claims; demotes fallback-model and historical transcript/version claims, optionally reduces caller-supplied init/tool-table artifacts, parses the latest local Codex session JSONL into tool names/channels, and reconciles recorded `mcp__` tool names against static Codex MCP config without raw transcript text, inputs, outputs, or config values | No |
| `opencode_config_redactor.py` | OpenCode resolved-config redactor; captures `debug config` internally, preserves structure, emits hashes/counts, and redacts scalar leaf values | No provider call; runs local `opencode debug config` by default |
| `opencode_topology_export.py` | OpenCode config/MCP/state inventory with redaction | No; `--live` runs OpenCode diagnostics |
| `paired_trial_harness.py` | B3 adoption-eligibility verdict for the pre-reducer gate: consumes two paired-trial reports over identical task fixtures (`--baseline` vs `--intervention`) plus the B2 `--canary-report` and B1 `--handle-report`, defines its own paired-trial event schema (never overloading `run_ledger`, attached only as supplemental run-health), and emits a deterministic `adoption_eligible` verdict that is ALL of {same task fixture set, quality not worse, cache not worse, retry not worse, canary pass, handle present, rollback_rule present, evidence_class not raw-output-only} — explicitly false for raw-output-%-only evidence, with every failed predicate named; token estimates labeled heuristic; fail-closed to typed `not_comparable`/`ineligible`/`parse_status` markers | No |
| `pi_presence_probe.py` | Local Pi installation/config presence check | No |
| `usage_truth_probe.py` | Bead 0.1 CAPE substrate: extracts provider-truth token/cache fields from a caller-supplied offline capture (response JSON or stream JSONL); absent fields → "unknown", never 0; never chars/4 | No |
| `sensitive_pattern_loader.py` | Bead 2.1 CAPE SSOT: single sensitive-pattern source for the masker + residual scan; loads provider-token shapes from secret-patterns.json (read-only, never mutated) plus CAPE-embedded structural patterns (PATH/USER/HOST/REPO/ID) the secret SSOT lacks; malformed/missing config → conservative fallback, never silent-empty | No |
| `prompt_sanitizer.py` | Bead 2.2 CAPE privacy boundary: deterministic HMAC-keyed masker over caller-supplied text using the 2.1 SSOT; NFC-normalizes, masks longest-match-first/non-overlapping into `__CAPE_<16hex-nonce>_<TYPE>_<N>__` placeholders (stable per distinct entity = coreference), exact byte-identical rehydrate, zero-tolerance residual_scan (type-labels/hashes only), collision + invalid-session-key fail closed; swapmap is in-memory-only (never persisted, R1); metadata-only report | No |
| `prompt_rehydration_gate.py` | Bead 2.3 CAPE masked-delegation gate: the safe round-trip `store(original)->mask->delegate(masked)->integrity check->rehydrate OR B1 verbatim fallback` over a pluggable `Delegate=Callable[[str],str]` (default identity stub); B1-ORDERING (F8) stores the verbatim original to a caller-supplied 0700/0600 `--store-dir` B1 handle BEFORE masking/delegation, so a store error, invalid session key, or sanitizer-rejected artifact short-circuits to verbatim passthrough with the delegate NEVER invoked; integrity="ok" requires the returned placeholder set be an exact-token subset of the sent set (no mutation/drop/hallucination), the returned masked text be residual-clean, rehydration be byte-identical to the original, and the B1 anchor reconstruct byte-identical — any failure discards the delegate output, sets integrity="violated"/fallback="verbatim_b1", and retrieves the byte-identical original from B1; metadata-only report (integrity, fallback, sent/returned placeholder counts, handle_present, store_status, residual_clean) with no raw prompt/original/delegate text or placeholder strings | No |
| `injection_fence.py` | Bead 2.7 CAPE untrusted-context fence (F9): safely wraps UNTRUSTED retrieved/memory content before it is injected as additive context; uses a distinct PER-CALL random nonce (a fixed/forgeable delimiter is escapable) via a caller-injectable RNG seam; `sanitize_field` neutralizes forged `</cape-fence …>` delimiter look-alikes + control chars so embedded forgeries are CONTAINED not escaped, `unfence` returns content iff the nonce matches exactly (wrong/absent → None, documented), `claim_guard` flags authority/approval/instruction-injection phrases as CATEGORY LABELS only (never raw text), `inject_at_end` asserts END placement (never prepend → cache-prefix/lost-in-the-middle); malformed input → typed fail-closed, empty → degraded marker; metadata-only report | No |
| `injection_budget_rail.py` | Bead 2.6 CAPE injection budget rail: caps additive enrichment per turn by total tokens (default 500) AND item count (default 5), dropping marginal items deterministically; unknown per-item token counts → budget_status=unknown_tokens_block_adoption (measurement-only, never adoption-eligible); provider-truth tokens only; metadata-only report | No |
| `enrichment_control_fixtures.py` | Bead 2.4 CAPE enricher control-arm generator: deterministically (`random.Random(seed)` only — no global random/time/entropy) builds the control arms the lift-gate (2.5) needs to prove a quality lift is content-driven, not gamed, from a `--query-fixtures` file or built-in synthetic set — gold (answers the query), random (Power-of-Noise arXiv 2401.14887 noise-floor that CAN help), near_miss (the HARD related-but-wrong control carrying `{similarity_tag, wrongness_reason, verifier}`; unverifiable wrongness → counted `invalid_nearmiss`, never silently valid), padding (gold-token-count contentless filler), and position_ablation (same gold content, different position, query fixed — H10 positional-vs-content attribution); malformed query fixtures → typed invalid, empty → degraded, fixture CONTENT to optional `--out-dir` only; metadata-only report `{arm,item_count,token_estimate,provenance,similarity_tag?,wrongness_reason?,verifier?}` + `invalid_nearmiss_count` | No |
| `enricher_lift_gate.py` | Bead 2.5 CAPE H1 make-or-break enricher ADOPTION GATE: the statistically rigorous decision of whether an additive enricher can EVER be adopted — on QUALITY LIFT only, NEVER on B3's cache-reduction gate (two-plane separation: deliberately does NOT `import paired_trial_harness`). Over paired baseline/enriched reports on IDENTICAL fixtures + a blind judge report + random/near_miss/padding control arms + a provider-truth usage report, `adoption_eligible` is true iff ALL: comparable_fixtures (else `not_comparable`), evidence_class ∈ {direct_task_outcome, blind_judge_comparison} (proxy/raw_token_percent/synthetic_only/unknown insufficient), bootstrap_ci_lower>0 (BOTH percentile AND BCa, ≥10000 seeded resamples, n≥50 else `inconclusive_sample_size`, material divergence → `inconclusive_unstable_ci`), LiftEfficiency=win_rate_delta_pp/(added_tokens/1000) ≥ tau (seed 3.0 pp/1k, sensitivity sweep at 1.0/3.0/5.0), controls beat random+near_miss+padding under Holm correction (uncorrected p<0.05 NOT proof), judge MAD≤0.15 AND SD≤0.25 (else `inconclusive_noise`), added_tokens≤budget, and prefix_churn==false (cache-NEUTRAL passes — the ONLY cache term, no cache-positive requirement); missing arm/report → `ineligible`, missing provider tokens → `inconclusive`; every failed predicate NAMED; metadata-only report (never raw prompt/judge/fixture text) | No |
| `block_window_auditor.py` | Bead 0.3 CAPE substrate: audits content-block count against the ~20-block cache lookback window and flags silent-cache-miss RISK; proves counter logic only — provider cache behavior requires live capture (gated E1); provider claims are HYPOTHESES, not proofs | No |
| `cache_floor_probe.py` | Bead 0.2b CAPE substrate: given a model ID and prefix token count, reports whether the prefix clears the model's minimum cacheable floor using the research-seed registry (cache_floor_registry.json); unknown model → floor_tokens="unknown", NEVER 4096; research_seed floor → risk="research_seed_floor_unverified" (not adoption-sufficient) | No |
| `savings_vs_session_length_meter.py` | Bead 0.4 CAPE Phase-5 entry gate: quantifies retrieval-over-replay savings curve from offline run/usage summaries or synthetic fixtures; emits per-bucket replay/handle-return token counts, estimated_savings_ratio (labeled heuristic if chars/4 derived), proof_class (local_measured/synthetic/unknown), and phase5_entry_gate verdict; blocked_research_only unless real local_measured data present | No |
| `q_namespace_lint.py` | Runtime/fleet doc lint for ambiguous `Q` namespace references | No |
| `raw_output_handle_protocol.py` | B1 reversibility-proof mechanism for the pre-reducer gate: content-addressed raw-output store keyed by full SHA-256, atomic 0600 write+fsync+verify under a caller-supplied 0700 `--store-dir`, byte-identical retrieve, and `reduce_with_handle` that fails open on error-heavy/unknown/unverifiable reductions and fails closed on store/hash/handle faults; emits handles, display hashes, byte/omission counts, sensitivity class, and store status without raw output, reduced text, or secrets | No |
| `reducer_canary_corpus.py` | B2 reducer canary corpus for the pre-reducer gate: runs a pluggable `reduce(raw)->str\|{reduced,handle?}` against a fixed inventory of synthetic raw-output fixtures (`.env` existence, detached HEAD, failing tests, migration warnings, rare JSON anomalies, middle-only critical log lines), proving per-fixture that load-bearing required anchors survive in the reduced view OR are recoverable byte-identical via a B1 handle and that synthetic forbidden payloads never survive a lossy reduction; ships identity/corrupting/handle_backed reference reducers as test fixtures only (corrupting MUST fail — the corruption-detection proof), selectable via `--reducer {identity,corrupting,handle_backed}` (default identity) which stamps the actual `reducer_id` as a top-level report field so a downstream gate can assert which reducer the canary tested; emits anchor/forbidden counts, a per-fixture `forbidden_check` (`checked` vs `not_applicable_lossless`) so a verbatim passthrough never silently excuses the leak check, raw/reduced byte counts, content hashes, restore status, handle presence, and `fail_reasons` with NO total-session deltas (B2-TOTAL), without raw output, reduced text, regex bodies, fixture paths, or secrets | No |
| `faithfulness_evaluator.py` | P1 "no quality compromise" proof for the reducer plane: deterministic offline groundedness evaluator that scores task-success on the ANSWER (answer-anchor survival + negation polarity), NOT on BLEU/lexical overlap — a broken negation forces success to 0.0 (meaning inversion is worse than no answer); emits per-fixture + worst-case faithfulness deltas with fail-closed WORST-CASE adoption (one destroyed fixture sinks the corpus; means are advisory only) and a per-fixture success floor; honest scope: a `deterministic_verifier` groundedness proxy, NOT a full LLM task eval; metadata-only (scores/counts/deltas/ids, never raw text, question, or anchors) | No |
| `bleu_faithfulness_gap.py` | P1 proxy-gaming (Goodhart) detector for the reducer plane: computes `gap = lexical_overlap(BLEU-1 clipped unigram precision) - faithfulness` on the same pair (faithfulness reused from `faithfulness_evaluator` so the scores are comparable) and flags the high-lexical/low-groundedness gaming shape where a compressor keeps the original's wording but drops the answer-anchors; worst-case fail-closed (clean only if NO fixture's gap exceeds the threshold); honest scope: a heuristic SIGNAL not a proof — cannot catch gaming that also degrades lexical overlap nor anchor-preserving semantic drift; metadata-only | No |
| `faithfulness_canary_corpus.py` | P1 content-class fidelity-cliff proof: curated synthetic corpus (one fixture per content class — numeric, date, identifier, negation, entity) each carrying a FAITHFUL and a CLIFF compression, run through both `faithfulness_evaluator` and `bleu_faithfulness_gap` to prove together (1) NO FALSE ALARM — every faithful compression is ADOPT + clean, and (2) EVERY CLIFF CAUGHT — every cliff is caught by the UNION of the two scorers (anchor drop / negation break / proxy-gaming flag), with per-class catch attribution; honest scope: covers the catchable classes only, not anchor-preserving semantic drift; fail-closed (empty corpus, any uncaught cliff, or any faithful false-alarm FAILs); metadata-only (class ids, detectors, scores/flags — never raw text) | No |
| `secret_guard_canary.py` | Synthetic secret-access guard coverage canary; inventories visible Bash/Read guard wiring, correlates present guard command basenames with historical Claude observability hook metadata, and runs fake PreToolUse payloads against local guard scripts with inputs hashed, including project `.env` policy-signal variants | No; `--run` executes local guard scripts with synthetic JSON only |
| `skill_metadata_inventory_probe.py` | Metadata-only Agent Skill inventory across direct roots and enabled plugin-cache candidates; emits source classes, names, description lengths/hashes, trigger-breadth heuristics, and packaging counts without raw descriptions, bodies, paths, or asset filenames | No |
| `skill_description_linter.py` | Metadata-only Agent Skill description policy linter; emits issue codes, severity counts, broad-term labels, duplicate-description hashes, and source classes without raw descriptions, bodies, paths, or asset filenames | No |
| `tmup_dag_schema_probe.py` | tmup source/state DAG inventory: schema/migrations/runtime contract, registry/session counts, SQLite table/index/count metadata, with task/message payloads suppressed and covered by helper-level plus CLI-envelope redaction tests | No |
| `tmup_policy_runtime_diff.py` | tmup policy/runtime drift report across tmup policy, plugin Codex agent templates, installed Codex tmup agents, Codex base/profile config, OpenCode tmup agents, and selected tmup model mentions without raw instructions, command bodies, env values, absolute paths, task payloads, or provider calls | No |
| `whatsoup_alias_map.py` | WhatSoup static fleet/health-profile/runbook alias map plus host policy/proof-class rows with live host access suppressed | No |
| `whatsoup_agent_options_projection_probe.py` | WhatSoup `agentOptions` source/doc/test projection plus optional provider-free generated-workspace metadata fixture: path-classed defaults, provider/fallback/compaction/plugin/M365 rules, runtime forwarding refs, config target classes, file modes, key names, and live-fleet boundary without raw configs or generated workspace values | No; `--synthetic-generated-workspace` runs local temp workspace provisioning only |
| `whatsoup_checkout_state_probe.py` | WhatSoup checkout-state recapture helper; emits current branch/head/clean state, dirty path counts, base-to-HEAD relative path deltas, and whether deltas touch R10 scan paths without file contents or live fleet access | No |
| `whatsoup_deny_floor_probe.py` | WhatSoup connector deny-floor source/test/local-settings projection: REQUIRED_DENY counts, category summaries, enforcement path refs, and repo-local settings subset coverage without raw settings values or permission entries | No |
| `whatsoup_m365_env_gate_probe.py` | WhatSoup spawned-CLI M365 mutation env-gate projection: `ALLOW_M365_MUTATIONS` / `WHATSOUP_CONNECTOR_FAILCLOSED` truth table, source/test refs, and live-fleet boundary without env values or provider calls | No |
| `whatsoup_provider_roster_probe.py` | WhatSoup provider roster source/doc/test projection: closed provider IDs, implementation-file coverage, Gemini first-class source status, Pi absence, parser/catalog refs, and live-provider boundary without running binaries or providers | No |
| `whatsoup_r10_branch_relationship_probe.py` | WhatSoup R10 branch/worktree relationship proof: candidate ref existence, current-head ancestry, containing branches, cherry metadata hashes/counts, changed relative paths, and worktree path hashes/classes without diffs, file contents, raw paths, provider calls, SSH, or fleet access | No |
| `whatsoup_sandbox_per_chat_boundary_probe.py` | WhatSoup `sandboxPerChat` source/doc/test boundary projection plus optional provider-free generated-workspace and fake parent-credential canary metadata fixture; emits isolated/shared/conditional surfaces, config target classes, file modes, env-key names, credential-canary hit counts, and live-fleet boundary without raw config/socket/JID/credential values | No; `--synthetic-workspace` runs local temp workspace provisioning only |
| `whatsoup_shared_cwd_collision_probe.py` | WhatSoup shared-agent cwd collision projection: source/test/docs refs plus optional local config-root metadata scan, emitting cwd hashes/classes, collision counts, provider/session enums, and instance-name hashes without raw names, paths, prompts, phones, values, or live fleet access | No |
| `whatsoup_spawn_config_probe.py` | Static WhatSoup spawned-CLI env/config-root/workspace proof plus R10 fake-root config-resolution fixture; classifies whether the current source has opt-in HOME/XDG config-root isolation markers and can optionally run provider-free local CLI diagnostics under fake roots with `--synthetic-runtime` | No by default; `--synthetic-runtime` runs local help/doctor/debug-path commands only |
| `whatsoup_settings_manifest_probe.py` | Caller-supplied WhatSoup settings-manifest adapter; compares included raw deny arrays against current `REQUIRED_DENY` and classifies count-only rows without raw settings values, hook commands, env values, permission entries, hostnames, JIDs, provider payloads, live host reads, SSH, or fleet mutation | No |
| `whatsoup_tool_surface_probe.py` | WhatSoup MCP tool-surface source/doc projection plus optional in-memory `ToolRegistry` and focused mocked `emit_heal_result` fixtures: canonical counts, registration gates, scope counts, scenario projections, runtime registry counts, and inline heal-tool test coverage without schemas/descriptions or live fleet access | No; `--synthetic-registry` and `--synthetic-heal-test` run local fixtures only |
| `pipeline_telemetry.py` | Per-mutation observability/telemetry layer for the CAPE pipeline: each step emits a metadata-only record with tokens-in→tokens-out (provider-truth `measured` or labeled `heuristic`, missing→`unknown` never 0), before/after sha256_16 + byte/token deltas, a VALIDATED metadata-only mutation_summary (raw-content/path/secret shapes typed-rejected), the step's claim and `claim_backed` audit flag, and the reversibility handle; `summarize()` aggregates the pipeline observability report (per-plane token deltas, unbacked-claims list, reversibility coverage, heuristic-token fraction, proof-class rollup) with no raw before/after text | No |

## Tools

| Script | Purpose | Provider call by default? |
|---|---|---|
| `tools/dependency_audit.py` | Fail-closed supply-chain guard for any out-of-band test-lane dependency: verifies a pinned manifest's sha256 against live PyPI digests (tamper-evidence), records PEP 740 / Sigstore provenance, checks OSV advisories (offline `--osv-zip` or `--allow-network`), and FAILS CLOSED on digest mismatch / advisory / `--require-signed`. Never installs; emits a metadata-only verdict. Probes stay stdlib-only; vetted deps live in `.venv-test` (outside the probe import path), see `requirements-test.txt` + `tests/property/`. | No provider call; PyPI/OSV network only with `--allow-network` |

## Examples

```bash
python3 agent-runtime-probes/tools/runp.py runtime_doctor.py
python3 agent-runtime-probes/tools/run_ledger.py --summary --pretty
python3 agent-runtime-probes/bot_errors_proof_ladder.py --pretty
python3 agent-runtime-probes/bot_errors_daily_health_artifact_probe.py --artifact /path/to/redacted-or-local-artifact.json --pretty
python3 agent-runtime-probes/bot_errors_health_surface_probe.py --pretty
python3 agent-runtime-probes/runtime_doctor.py
python3 agent-runtime-probes/runtime_doctor.py --live
python3 agent-runtime-probes/runtime_budget_rail.py --pretty
python3 agent-runtime-probes/runtime_budget_rail.py --no-opencode-stats --pretty
python3 agent-runtime-probes/compaction_survival_canary.py --pretty
python3 agent-runtime-probes/compaction_survival_canary.py --artifact /path/to/redacted-or-local-canaries.json --pretty
python3 agent-runtime-probes/config_surface_doctor.py --pretty
python3 agent-runtime-probes/config_surface_doctor.py --include-missing --pretty
python3 agent-runtime-probes/codex_hook_dual_path_probe.py --pretty
python3 agent-runtime-probes/codex_config_redactor.py --pretty
python3 agent-runtime-probes/codex_prompt_input_shape_probe.py --pretty
python3 agent-runtime-probes/codex_prompt_input_shape_probe.py --real-local --cwd /Users/testuser --timeout 120 --pretty
python3 agent-runtime-probes/codex_rules_inventory_probe.py --pretty
python3 agent-runtime-probes/codex_rules_runtime_check_probe.py --pretty
python3 agent-runtime-probes/codex_session_tool_table_probe.py --latest --pretty
python3 agent-runtime-probes/codex_session_tool_table_probe.py --artifact /path/to/init-or-session.jsonl --pretty
python3 agent-runtime-probes/tool_schema_budgeter.py --pretty
python3 agent-runtime-probes/tool_schema_budgeter.py --schema-artifact /path/to/tools-list.json --tool-artifact /path/to/init-or-tool-table.jsonl --pretty
python3 agent-runtime-probes/tool_surface_diff.py --input-jsonl /path/to/claude-stream.jsonl
python3 agent-runtime-probes/tool_surface_diff.py --run
python3 agent-runtime-probes/claude_observability_hook_probe.py --pretty
python3 agent-runtime-probes/hook_context_profiler.py --run
python3 agent-runtime-probes/hook_context_profiler.py --input-jsonl /path/to/stream-json-capture.jsonl
python3 agent-runtime-probes/instruction_budget_auditor.py --pretty
python3 agent-runtime-probes/launchd_plist_inventory_probe.py --pretty
python3 agent-runtime-probes/loom_memory_line_probe.py --pretty
python3 agent-runtime-probes/loom_memory_line_probe.py --run-tests --pretty
python3 agent-runtime-probes/managed_config_presence_monitor.py --pretty
python3 agent-runtime-probes/mcp_json_diagnostic.py --pretty
python3 agent-runtime-probes/mcp_schema_inventory_probe.py --pretty
python3 agent-runtime-probes/mcp_schema_inventory_probe.py --probe-tools --pretty
python3 agent-runtime-probes/model_todo_provenance_probe.py --pretty
python3 agent-runtime-probes/model_todo_provenance_probe.py --tool-artifact /path/to/init-or-tool-table.jsonl --pretty
python3 agent-runtime-probes/model_todo_provenance_probe.py --latest-codex-session --pretty
python3 agent-runtime-probes/opencode_config_redactor.py --source debug --pretty
python3 agent-runtime-probes/opencode_config_redactor.py --source file --pretty
python3 agent-runtime-probes/opencode_topology_export.py --live
python3 agent-runtime-probes/pi_presence_probe.py
python3 agent-runtime-probes/q_namespace_lint.py --pretty
python3 agent-runtime-probes/secret_guard_canary.py --pretty
python3 agent-runtime-probes/secret_guard_canary.py --run --pretty
python3 agent-runtime-probes/skill_metadata_inventory_probe.py --pretty
python3 agent-runtime-probes/skill_description_linter.py --pretty
python3 agent-runtime-probes/tmup_dag_schema_probe.py --pretty
python3 agent-runtime-probes/tmup_dag_schema_probe.py --max-dbs 0
python3 agent-runtime-probes/tmup_policy_runtime_diff.py --pretty
python3 agent-runtime-probes/whatsoup_alias_map.py --pretty
python3 agent-runtime-probes/whatsoup_agent_options_projection_probe.py --pretty
python3 agent-runtime-probes/whatsoup_agent_options_projection_probe.py --synthetic-generated-workspace --pretty
python3 agent-runtime-probes/whatsoup_checkout_state_probe.py --pretty
python3 agent-runtime-probes/whatsoup_deny_floor_probe.py --pretty
python3 agent-runtime-probes/whatsoup_m365_env_gate_probe.py --pretty
python3 agent-runtime-probes/whatsoup_provider_roster_probe.py --pretty
python3 agent-runtime-probes/whatsoup_r10_branch_relationship_probe.py --pretty
python3 agent-runtime-probes/whatsoup_sandbox_per_chat_boundary_probe.py --pretty
python3 agent-runtime-probes/whatsoup_sandbox_per_chat_boundary_probe.py --synthetic-workspace --pretty
python3 agent-runtime-probes/whatsoup_shared_cwd_collision_probe.py --pretty
python3 agent-runtime-probes/whatsoup_spawn_config_probe.py --pretty
python3 agent-runtime-probes/whatsoup_settings_manifest_probe.py --artifact /path/to/redacted-settings-manifest.json --pretty
python3 agent-runtime-probes/whatsoup_tool_surface_probe.py --pretty
python3 agent-runtime-probes/whatsoup_tool_surface_probe.py --synthetic-registry --pretty
python3 agent-runtime-probes/whatsoup_tool_surface_probe.py --synthetic-heal-test --pretty
```

## Tests

```bash
python3 agent-runtime-probes/tests/test_corpus_guard.py
python3 agent-runtime-probes/tests/test_bot_errors_proof_ladder.py
python3 agent-runtime-probes/tests/test_bot_errors_daily_health_artifact_probe.py
python3 agent-runtime-probes/tests/test_bot_errors_health_surface_probe.py
python3 agent-runtime-probes/tests/test_codex_config_redactor.py
python3 agent-runtime-probes/tests/test_codex_prompt_input_shape_probe.py
python3 agent-runtime-probes/tests/test_codex_rules_inventory_probe.py
python3 agent-runtime-probes/tests/test_codex_rules_runtime_check_probe.py
python3 agent-runtime-probes/tests/test_codex_session_tool_table_probe.py
python3 agent-runtime-probes/tests/test_claude_observability_hook_probe.py
python3 agent-runtime-probes/tests/test_config_surface_doctor.py
python3 agent-runtime-probes/tests/test_tool_schema_budgeter.py
python3 agent-runtime-probes/tests/test_tool_surface_diff.py
python3 agent-runtime-probes/tests/test_coverage_check.py
python3 agent-runtime-probes/tests/test_hook_context_profiler.py
python3 agent-runtime-probes/tests/test_instruction_budget_auditor.py
python3 agent-runtime-probes/tests/test_probelib.py
python3 agent-runtime-probes/tests/test_redact.py
python3 agent-runtime-probes/tests/test_loom_memory_line_probe.py
python3 agent-runtime-probes/tests/test_managed_config_presence_monitor.py
python3 agent-runtime-probes/tests/test_codex_hook_dual_path_probe.py
python3 agent-runtime-probes/tests/test_launchd_plist_inventory_probe.py
python3 agent-runtime-probes/tests/test_mcp_json_diagnostic.py
python3 agent-runtime-probes/tests/test_mcp_schema_inventory_probe.py
python3 agent-runtime-probes/tests/test_model_todo_provenance_probe.py
python3 agent-runtime-probes/tests/test_opencode_config_redactor.py
python3 agent-runtime-probes/tests/test_opencode_topology_export.py
python3 agent-runtime-probes/tests/test_q_namespace_lint.py
python3 agent-runtime-probes/tests/test_runtime_doctor.py
python3 agent-runtime-probes/tests/test_runtime_budget_rail.py
python3 agent-runtime-probes/tests/test_compaction_survival_canary.py
python3 agent-runtime-probes/tests/test_run_ledger.py
python3 agent-runtime-probes/tests/test_runp.py
python3 agent-runtime-probes/tests/test_secret_guard_canary.py
python3 agent-runtime-probes/tests/test_skill_metadata_inventory_probe.py
python3 agent-runtime-probes/tests/test_skill_description_linter.py
python3 agent-runtime-probes/tests/test_tmup_dag_schema_probe.py
python3 agent-runtime-probes/tests/test_tmup_policy_runtime_diff.py
python3 agent-runtime-probes/tests/test_whatsoup_agent_options_projection_probe.py
python3 agent-runtime-probes/tests/test_whatsoup_alias_map.py
python3 agent-runtime-probes/tests/test_whatsoup_checkout_state_probe.py
python3 agent-runtime-probes/tests/test_whatsoup_deny_floor_probe.py
python3 agent-runtime-probes/tests/test_whatsoup_m365_env_gate_probe.py
python3 agent-runtime-probes/tests/test_whatsoup_provider_roster_probe.py
python3 agent-runtime-probes/tests/test_whatsoup_r10_branch_relationship_probe.py
python3 agent-runtime-probes/tests/test_whatsoup_sandbox_per_chat_boundary_probe.py
python3 agent-runtime-probes/tests/test_whatsoup_shared_cwd_collision_probe.py
python3 agent-runtime-probes/tests/test_whatsoup_spawn_config_probe.py
python3 agent-runtime-probes/tests/test_whatsoup_settings_manifest_probe.py
python3 agent-runtime-probes/tests/test_whatsoup_tool_surface_probe.py
```

## Redaction Policy

The probes redact values for keys containing:

```text
token, secret, key, password, credential, auth, cookie, header, client_id,
tenant_id, url
```

They still report key presence and safe names because topology work needs to
know that an auth route exists without seeing the value.

`config_surface_doctor.py` is intentionally not a broad filesystem crawler. It
includes selected control planes plus direct skill, agent, plugin, theme,
script, wrapper, launchd, directory, and generated-workspace policy surfaces.
Missing managed-policy candidates are omitted by default and included only with
`--include-missing`. Add new paths deliberately with a source class and
redaction posture.
