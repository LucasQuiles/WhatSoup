export const FITNESS_CATEGORIES = [
  'architecture',
  'invariant',
  'process',
  'hygiene',
  'test',
  'meta',
  'portability',
] as const;

export const DETECTABILITIES = ['mechanical', 'ast', 'semantic', 'human'] as const;
export const FITNESS_RINGS = ['hook', 'eslint', 'guard', 'ci', 'sdlc'] as const;
export const FITNESS_SEVERITIES = ['block', 'warn', 'advisory'] as const;

export type RuleCategory = typeof FITNESS_CATEGORIES[number];
export type Detectability = typeof DETECTABILITIES[number];
export type Ring = typeof FITNESS_RINGS[number];
export type Severity = typeof FITNESS_SEVERITIES[number];

export interface FitnessRule {
  id: string;
  title: string;
  category: RuleCategory;
  rationale: string;
  detect: Detectability;
  rings: Ring[];
  severity: Severity;
  ratchet?: boolean;
  params?: Record<string, unknown>;
  source: string[];
  /**
   * What actually enforces this rule, machine-readably. REQUIRED for `severity: 'block'`
   * and asserted by `tests/scripts/fitness-registry-backing.test.ts`.
   *
   * Each entry is either:
   *   - an npm script name  (`'guard:transport-patterns'`, `'typecheck:all'`) — must exist
   *     in package.json and be gate-reachable, or
   *   - a repo-relative test path (`'tests/scripts/foo.test.ts'`) — must exist on disk and
   *     be collected by vitest, which CI runs in full via `coverage:check`.
   *
   * Why this field exists: before it, the rule→enforcement link lived only in prose inside
   * `rationale` and in a row of `docs/architecture/fitness-taxonomy.md`. Establishing that
   * all 17 block rules were genuinely enforced took a dozen greps and a subagent, because
   * four of them (`arch.file-size`, `hygiene.commit-author`, `hygiene.internal-labels`,
   * `test.typecheck-all-required`) had NO reference to their rule id anywhere outside the
   * registry and that doc. Archaeology is not an enforcement mechanism.
   *
   * Scope of the claim, stated precisely: this field plus its test prove every block rule
   * DECLARES a real, gate-reachable backstop. They do NOT prove the backstop actually
   * detects what the rule describes — that semantic link stays hand-asserted, in `rationale`
   * and in each guard's own tests.
   */
  implementedBy?: string[];
}

export const fitnessRules = [
  {
    id: 'arch.file-size',
    title: 'File size ratchet',
    category: 'architecture',
    rationale: 'Large files concentrate unrelated behavior and should not grow beyond an explicit baseline.',
    detect: 'mechanical',
    rings: ['hook', 'eslint', 'guard', 'ci'],
    severity: 'block',
    implementedBy: ['tests/scripts/fitness-file-size-warning-budget.test.ts'],
    ratchet: true,
    params: { maxLines: 2000 },
    source: ['retrospective:runtime.ts-6009-lines', 'retrospective:runtime-test-churn'],
  },
  {
    id: 'arch.god-class',
    title: 'God class warning',
    category: 'architecture',
    rationale: 'A single class owning poll, turn sequencing, gate, compact, and persistence behavior hides invariants.',
    detect: 'ast',
    rings: ['eslint'],
    severity: 'warn',
    params: { maxClassLines: 1200, maxMethods: 80 },
    source: ['retrospective:AgentRuntime-mixed-responsibilities'],
  },
  {
    id: 'arch.sqlite-busy-timeout-ssot',
    title: 'SQLite busy-timeout single source',
    category: 'architecture',
    rationale:
      'Statically resolvable numeric PRAGMA busy_timeout strings reaching direct member calls named exec/prepare and node:sqlite DatabaseSync timeout options can drift across connections; active src/ and scripts/ code must use the canonical constants, while ambiguous argument spreads, unresolvable options, and recognized const-object mutations fail visibly.',
    detect: 'ast',
    rings: ['eslint'],
    severity: 'warn',
    source: ['issue:2217', 'incident:sqlite-busy-timeout-drift'],
  },
  {
    id: 'arch.test-colocation-churn',
    title: 'Test colocation churn',
    category: 'architecture',
    rationale: 'A test file with churn far above peer files signals an unstable unit boundary.',
    detect: 'mechanical',
    rings: ['guard'],
    severity: 'advisory',
    params: { commitsPerWindow: 10, days: 8 },
    source: ['retrospective:runtime.test.ts-20-commits'],
  },
  {
    id: 'arch.defense-both-layers',
    title: 'Defense at service and route layers',
    category: 'architecture',
    rationale: 'A service-layer guard is incomplete if the route or caller does not thread the required context.',
    detect: 'semantic',
    rings: ['sdlc'],
    severity: 'advisory',
    source: ['feedback:service_route_boundary'],
  },
  {
    id: 'arch.import-boundaries',
    title: 'Import boundary ring rule',
    category: 'architecture',
    rationale: 'Import direction between src layers is an architectural invariant; uncontrolled cross-layer reach couples modules and defeats abstraction boundaries.',
    detect: 'mechanical',
    rings: ['guard', 'ci'],
    severity: 'block',
    implementedBy: ['guard:boundaries'],
    ratchet: true,
    params: {
      // Importer layer → allowed target layers. Same-layer imports are always
      // permitted by the checker itself; the self-entries here are
      // documentation only, not enforcement.
      layers: {
        lib: ['lib'],
        core: ['core', 'lib'],
        transport: ['transport', 'core', 'lib'],
        mcp: ['mcp', 'core', 'lib', 'transport'],
        runtimes: ['runtimes', 'core', 'lib', 'mcp', 'transport'],
        fleet: ['fleet', 'core', 'lib', 'mcp', 'transport', 'runtimes'],
        memory: ['memory', 'core', 'lib'],
        root: ['*'],
      },
      anyMayImportRoot: true,
    },
    source: ['docs:duplicates-report.md', 'architecture:CLAUDE.md'],
  },
  {
    id: 'invariant.seq-locality',
    title: 'Sequence invariant locality',
    category: 'invariant',
    rationale: 'User inbound sequence and system-turn result counters must be owned by one local abstraction.',
    detect: 'mechanical',
    rings: ['guard'],
    severity: 'warn',
    params: { ownerModule: 'src/runtimes/agent' },
    source: ['commit:a150f7e8', 'commit:fb780bbd', 'retrospective:recurring-seq-bug'],
  },
  {
    id: 'invariant.fail-closed-scanner',
    title: 'Scanners fail closed',
    category: 'invariant',
    rationale: 'Scanner parse or read failures must surface as findings instead of silently returning no issues.',
    detect: 'ast',
    rings: ['eslint', 'sdlc'],
    severity: 'warn',
    source: ['feedback:audit_scanners_fail_closed'],
  },
  {
    id: 'invariant.timer-rearm-without-clear',
    title: 'Inline timer in Map.set re-armed without clear',
    category: 'invariant',
    rationale:
      'Forward-looking guard: writing a timer handle INLINE in a Map.set value literal (map.set(key, { t: setTimeout(...) })) and re-arming the key without first clearing the previous entry orphans the old timer. Catches only the inline shape, which the build-then-set codebase does not currently use (zero findings today); the field-assigned OperationTracker.onToolStart variant is covered by its regression test, not this lexical rule.',
    detect: 'ast',
    rings: ['eslint'],
    severity: 'warn',
    source: ['feedback:operation_tracker_timer_rearm_leak'],
  },
  {
    id: 'invariant.outbox-env-gated',
    title: 'Bot-errors outbox writes go through the env-aware resolver',
    category: 'invariant',
    rationale:
      'A write to the bot-errors outbox via a hardcoded path literal bypasses resolveBotErrorsOutbox() and lands in the PROD outbox even under VITEST/NODE_ENV=test. Outbox writes must derive their path from the resolver so the test-redirect applies.',
    detect: 'ast',
    rings: ['eslint'],
    severity: 'warn',
    source: ['audit:detector-misconceptions#alert-emitter-not-env-gated', 'feedback:dry_run_purity_run_level_test'],
  },
  {
    id: 'invariant.fail-closed-gate',
    title: 'Shell gates fail closed',
    category: 'invariant',
    rationale: 'Readiness and health gates must not mask command failures with sentinel success output.',
    detect: 'mechanical',
    rings: ['guard', 'hook'],
    severity: 'block',
    implementedBy: ['guard:fail-closed-gate'],
    source: ['feedback:writing_fail_closed_gates', 'feedback:shell_exit_via_pipe'],
  },
  {
    id: 'process.fix-cluster',
    title: 'Fix cluster escalation',
    category: 'process',
    rationale: 'Several fixes to one subsystem in a short window should require a design note before more patches.',
    detect: 'mechanical',
    rings: ['ci'],
    severity: 'advisory',
    params: { fixCommits: 3, days: 7 },
    source: ['prs:704-709', 'retrospective:fix-cluster'],
  },
  {
    id: 'process.canary-before-fleet',
    title: 'Canary before fleet rollout',
    category: 'process',
    rationale: 'Timing-dependent features need single-host canary evidence before fleet-wide enablement.',
    detect: 'human',
    rings: ['sdlc'],
    severity: 'advisory',
    source: ['incident:auto-compact-slow-response'],
  },
  {
    id: 'process.deploy-sha-drift',
    title: 'Deployment SHA drift',
    category: 'process',
    rationale: 'Live hosts drifting behind origin/main hide whether fixes are actually deployed.',
    detect: 'mechanical',
    rings: ['guard'],
    severity: 'advisory',
    params: { maxBehindCommits: 0 },
    source: ['audit:anabot-10-commits-behind', 'feedback:dm_runtime_worktree_skew'],
  },
  {
    id: 'process.no-destructive-git',
    title: 'No destructive git commands',
    category: 'process',
    rationale: 'Committed scripts and hooks must not use destructive git cleanup commands.',
    detect: 'mechanical',
    rings: ['guard', 'hook'],
    severity: 'block',
    implementedBy: ['guard:no-destructive-git'],
    source: ['feedback:no_git_clean', 'developer-instructions:git-safety'],
  },
  {
    id: 'process.verify-before-claim',
    title: 'Verify before completion claims',
    category: 'process',
    rationale: 'Completion claims need fresh evidence from source control, CI, or runtime checks.',
    detect: 'human',
    rings: ['sdlc'],
    severity: 'advisory',
    source: ['feedback:pr_landing_check', 'feedback:agent_commit_verification'],
  },
  {
    id: 'process.evidence-sha-anchor',
    title: 'Evidence SHA anchoring',
    category: 'process',
    rationale: 'Evidence that cites a commit must match the reviewed or published SHA.',
    detect: 'mechanical',
    rings: ['guard'],
    severity: 'warn',
    source: ['feedback:evidence_sha_anchoring'],
  },
  {
    id: 'process.shared-checkout-safety',
    title: 'Shared checkout safety',
    category: 'process',
    rationale: 'Agents must not clean, switch, or commit over another session in a shared checkout.',
    detect: 'human',
    rings: ['hook', 'sdlc'],
    severity: 'advisory',
    source: ['feedback:shared_checkout_multi_agent', 'feedback:worktree_state_safety'],
  },
  {
    id: 'hygiene.commit-author',
    title: 'Canonical commit author',
    category: 'hygiene',
    rationale: 'Placeholder or tool-generated author identities must not enter public history.',
    detect: 'mechanical',
    rings: ['guard', 'ci'],
    severity: 'block',
    implementedBy: ['guard:repo:commit-authors'],
    params: { allowedIdentityRefs: ['canonical-local-author', 'github-noreply-author'] },
    source: ['audit:whatsoup-test-invalid-history'],
  },
  {
    id: 'hygiene.internal-labels',
    title: 'Internal label hygiene',
    category: 'hygiene',
    rationale: 'Public repo content must not leak internal planning labels or private workstream names.',
    detect: 'mechanical',
    rings: ['guard'],
    severity: 'block',
    // Three invocation paths reach the same `internal-workstream-label` pattern in
    // repo-hygiene-guard.ts. `release-hygiene` (scanTrackedFiles) is listed because it is
    // the ONLY one wired into tag-release-gate.yml — omitting it hid the fact that this
    // rule is covered on the tag path while its neighbours are not.
    implementedBy: ['guard:repo:staged', 'guard:repo:branch-diff', 'guard:repo:release-hygiene'],
    source: ['feedback:hygiene_internal_labels', 'existing:repo-hygiene-guard'],
  },
  {
    id: 'hygiene.pr-scope-coherence',
    title: 'PR scope coherence',
    category: 'hygiene',
    rationale: 'PR title type should match diff scope so broad systems do not hide inside narrow labels.',
    detect: 'semantic',
    rings: ['sdlc'],
    severity: 'advisory',
    source: ['feedback:pr_scope_title_coherence'],
  },
  {
    id: 'hygiene.no-wa-jid-literal-in-generic-ui',
    title: 'No WhatsApp JID literals in generic UI/ops surfaces',
    category: 'hygiene',
    rationale: 'Transport-agnostic surfaces (console UI, deploy ops scripts) must not hard-code WhatsApp JID forms; per-transport id construction belongs in the transport layer or shared helpers so Signal/iMessage lines render correctly.',
    detect: 'mechanical',
    rings: ['guard', 'ci'],
    severity: 'block',
    implementedBy: ['guard:transport-patterns'],
    ratchet: true,
    params: {
      globs: ['console/src', 'deploy/scripts'],
      extensions: ['.ts', '.tsx', '.py'],
      patterns: ['@s.whatsapp.net', '@g.us'],
      allowlistPaths: [
        'console/src/mock-data.ts',
        'deploy/scripts/tests/',
      ],
    },
    source: ['audit:2026-07-20-signal-imessage-surface-sweep#S4,S14,S18'],
  },
  {
    id: 'hygiene.no-whatsapp-copy-in-generic-ui',
    title: 'No WhatsApp-presuming copy in generic console components',
    category: 'hygiene',
    rationale: 'Generic console copy must not presume WhatsApp; per-transport copy variants keep Signal/iMessage operators from being misled. Existing occurrences are baselined; new ones block.',
    detect: 'mechanical',
    rings: ['guard', 'ci'],
    severity: 'block',
    implementedBy: ['guard:transport-patterns'],
    ratchet: true,
    params: {
      globs: ['console/src'],
      extensions: ['.ts', '.tsx'],
      patterns: ['WhatsApp'],
      allowlistPaths: [
        'console/src/mock-data.ts',
        // transport-identity.ts is the console-wide transport-identity home
        // (T5 b-07): CHANNEL_LABEL names each channel there, so generic
        // consumers never hardcode one transport's name. The fleet glyph map
        // (channel-kind.ts) converged onto it at the b-13 gate and inherits the
        // shared copy, so it no longer needs an entry of its own.
        'console/src/lib/transport-identity.ts',
      ],
    },
    source: ['audit:2026-07-20-signal-imessage-surface-sweep#S2,S3,S15'],
  },
  {
    id: 'hygiene.no-health-whatsapp-key-read',
    title: 'No direct health.whatsapp key reads in console',
    category: 'hygiene',
    rationale: 'The fleet health payload is being generalized to a transport-keyed block; direct health.whatsapp reads entrench the legacy key and mis-report Signal/iMessage lines. Reads must go through the generic-first accessor with legacy fallback.',
    detect: 'mechanical',
    rings: ['guard', 'ci'],
    severity: 'block',
    implementedBy: ['guard:transport-patterns'],
    ratchet: true,
    params: {
      globs: ['console/src'],
      extensions: ['.ts', '.tsx'],
      patterns: ['health?.whatsapp', 'health.whatsapp'],
      allowlistPaths: [
        'console/src/mock-data.ts',
        // transport-identity.ts is the designated generic-first accessor for
        // transport identity (T5 b-07): the legacy health.whatsapp read lives
        // there alone as the documented Baileys fallback; all consumers route
        // through transportConnectedOf / channelOf / baileysFallbackChannel
        // (the fleet glyph fallback converged onto it at the b-13 gate).
        'console/src/lib/transport-identity.ts',
      ],
    },
    source: ['audit:2026-07-20-signal-imessage-surface-sweep#S17'],
  },
  {
    id: 'hygiene.catch-justification',
    title: 'Swallowed catch justification',
    category: 'hygiene',
    rationale:
      'A catch whose body is empty or only performs syntactic no-ops silently swallows errors; binding an unused variable or adding a magic-word comment does not provide handling. New swallows must perform observable handling or carry a reasoned justification. The 127 inherited semantic identities are shrink-only ratchet debt.',
    detect: 'ast',
    rings: ['eslint'],
    severity: 'warn',
    ratchet: true,
    params: { baselinePath: 'eslint-rules/catch-ratchet-baseline.json' },
    source: ['issue:2190'],
  },
  {
    id: 'test.typecheck-all-required',
    title: 'Full typecheck required',
    category: 'test',
    rationale: 'Local push and CI paths must typecheck tests with tsconfig.test.json, not only source files.',
    detect: 'mechanical',
    rings: ['guard', 'ci'],
    severity: 'block',
    implementedBy: ['typecheck:all'],
    source: ['feedback:test_author_typecheck_all', 'audit:verify-push-branch-typecheck-gap'],
  },
  {
    id: 'test.skip-categorization',
    title: 'Categorized skips',
    category: 'test',
    rationale: 'Environment-dependent skips and timing-dependent skips need different handling and evidence.',
    detect: 'ast',
    rings: ['eslint'],
    severity: 'advisory',
    source: ['feedback:skip_categorization', 'feedback:masked_test_signal'],
  },
  {
    id: 'test.red-green-required',
    title: 'Red-green proof',
    category: 'test',
    rationale: 'A fix should include a test that would fail before the change, not only characterize fragile behavior.',
    detect: 'semantic',
    rings: ['sdlc'],
    severity: 'advisory',
    source: ['retrospective:characterization-tests', 'feedback:verification_before_completion'],
  },
  {
    id: 'meta.no-redundant-gates',
    title: 'No redundant gates',
    category: 'meta',
    rationale: 'New enforcement should feed existing guards and agents rather than adding parallel L1 checks.',
    detect: 'human',
    rings: ['sdlc'],
    severity: 'advisory',
    source: ['feedback:l1_pipeline_weight'],
  },
  {
    id: 'arch.approved-api-client',
    title: 'Console network requests through approved API client',
    category: 'architecture',
    rationale: 'Direct fetch calls in console UI bypass auth-ticket handling, timeouts, response parsing, and the test surface that agents preserve.',
    detect: 'ast',
    rings: ['eslint'],
    severity: 'warn',
    source: ['architecture:console-api-client'],
  },
  {
    id: 'arch.ring-boundaries',
    title: 'Backend ring boundary enforcement',
    category: 'architecture',
    rationale: 'Lower architectural rings must not import higher rings; coupling direction is an architectural invariant for autonomous agent reliability. Promoted from eslint-warn-only to a guard-ring ratchet (2026-07-19): the current violation count is baselined in .claude/fitness/baseline.json and may only shrink; the eslint ring stays a warn-severity visibility mirror (meta.no-redundant-gates).',
    detect: 'ast',
    rings: ['eslint', 'guard'],
    severity: 'block',
    implementedBy: ['guard:ring-boundary-ratchet'],
    ratchet: true,
    source: ['architecture:ring-boundaries', 'spec:2026-07-19-ssot-enforcement-ratchet'],
  },
  {
    id: 'invariant.no-unsafe-type-escapes',
    title: 'No unsafe TypeScript type escapes in production code',
    category: 'invariant',
    rationale: 'any and TypeScript suppressions erase compiler feedback that autonomous agents depend on as operating boundaries.',
    detect: 'ast',
    rings: ['eslint'],
    severity: 'warn',
    source: ['feedback:feedback_runner_api_verification'],
  },
  {
    id: 'arch.ssot-lid-reads',
    title: 'LID resolution through the lid-resolver SSOT',
    category: 'architecture',
    rationale:
      'Raw lid_mappings SQL reads outside src/core/lid-resolver.ts fork the LID→phone resolution discipline (staleness fold, disk fallback, telemetry) that resolveLid centralizes; hand-rolled copies drift. Count-ratcheted via .claude/fitness/baseline.json (allowlisted sites are the recorded debt) and enforced by scripts/ssot-pattern-guard.ts.',
    detect: 'mechanical',
    rings: ['guard', 'ci'],
    severity: 'block',
    implementedBy: ['guard:ssot-patterns'],
    ratchet: true,
    source: ['spec:2026-07-19-ssot-enforcement-ratchet', 'retrospective:b25-resolver-hardening'],
  },
  {
    id: 'arch.ssot-jid-construction',
    title: 'JID construction through jid-constants',
    category: 'architecture',
    rationale:
      'Inline `${x}@s.whatsapp.net`-class template construction and literal `.endsWith(\'@lid\')`-class predicates outside src/core/jid-constants.ts re-derive the JID domain grammar the module centralizes (its header already bans this). Count-ratcheted via .claude/fitness/baseline.json; enforced by scripts/ssot-pattern-guard.ts.',
    detect: 'mechanical',
    rings: ['guard', 'ci'],
    severity: 'block',
    implementedBy: ['guard:ssot-patterns'],
    ratchet: true,
    source: ['spec:2026-07-19-ssot-enforcement-ratchet', 'architecture:jid-constants-header'],
  },
  {
    id: 'arch.ssot-name-ladder',
    title: 'Owner-facing names through the display-name ladder',
    category: 'architecture',
    rationale:
      'SQL touching the name columns of contacts/chats/groups/chat_aliases outside src/core/chat-display-name.ts forks the owner-facing name ladder (alias → subject → chat name → contact names) and its LID-suspect disambiguation. Count-ratcheted via .claude/fitness/baseline.json; W1.5 migrations shrink the allowlist. Enforced by scripts/ssot-pattern-guard.ts.',
    detect: 'mechanical',
    rings: ['guard', 'ci'],
    severity: 'block',
    implementedBy: ['guard:ssot-patterns'],
    ratchet: true,
    source: ['spec:2026-07-19-ssot-enforcement-ratchet', 'retrospective:b25-chat-display-name'],
  },
  {
    id: 'arch.ssot-phone-shape',
    title: 'Phone shape checks and formatting through src/lib/phone.ts',
    category: 'architecture',
    rationale:
      'Anchored phone-shape regex literals (/^\\+?\\d{m,n}$/-class) and `+${…phone…}` plus-formatting outside src/lib/phone.ts fork the phone-identity discipline (isPhoneLocal/normalizePhone/normalizePhoneE164). Count-ratcheted via .claude/fitness/baseline.json; the console browser fork is a NOTE\'d allowlisted exception. Enforced by scripts/ssot-pattern-guard.ts.',
    detect: 'mechanical',
    rings: ['guard', 'ci'],
    severity: 'block',
    implementedBy: ['guard:ssot-patterns'],
    ratchet: true,
    source: ['spec:2026-07-19-ssot-enforcement-ratchet', 'commit:qr-033-phone-auth-boundary'],
  },
  {
    id: 'arch.ssot-presentation-literals',
    title: 'Registry-carried presentation phrases stay single-sourced',
    category: 'architecture',
    rationale:
      'User-facing phrases duplicated as literals across render modules drift apart (GATE_PRESENTATION class). Starts narrow: the pass-through phrase is carried by command-registry.ts PASSTHROUGH_PHRASE and both /help renders compose it; a re-typed literal copy anywhere else in src/ is blocked (zero baseline — a pure block). Enforced by scripts/ssot-pattern-guard.ts.',
    detect: 'mechanical',
    rings: ['guard', 'ci'],
    severity: 'block',
    implementedBy: ['guard:ssot-patterns'],
    ratchet: true,
    source: ['spec:2026-07-19-ssot-enforcement-ratchet', 'retrospective:help-render-passthrough-fork'],
  },
  {
    id: 'test.insecure-tempfile',
    title: 'No insecure temp-file creation in python or shell',
    category: 'test',
    rationale:
      'tempfile.mktemp() and hardcoded /tmp write-targets create predictable paths (TOCTOU race, cross-user readable). Fixed repo-wide; this rule blocks regression. Detects creation/write only, not read-only references. f-string /tmp write-targets are covered; os.path.join/shutil/os.open /tmp write-targets are a known detector gap (dataflow analysis required to avoid false positives).',
    detect: 'mechanical',
    rings: ['guard', 'ci'],
    severity: 'block',
    implementedBy: ['guard:insecure-tempfile'],
    source: ['codeql:py/insecure-temporary-file', 'spec:2026-06-27-insecure-tempfile'],
  },
  {
    id: 'portability.no-hardcoded-platform-binaries',
    title: 'No hardcoded platform binary paths',
    category: 'portability',
    rationale:
      'Hardcoded paths like /usr/bin/python3, /usr/bin/rustdesk, or /usr/bin/git break on macOS and NixOS where these binaries live elsewhere. Must use environment variables (PYTHON), shutil.which() (Python), or which() shell lookups. The /usr/bin/env shebang is exempt (POSIX-mandated); runtime fallback defaults are the only exceptions.',
    detect: 'mechanical',
    rings: ['guard', 'ci'],
    severity: 'block',
    implementedBy: ['guard:platform-patterns'],
    ratchet: true,
    params: {
      globs: ['src', 'scripts', 'deploy/scripts', 'tools/agent-runtime-probes'],
      extensions: ['.ts', '.py', '.sh'],
      patterns: [
        '"/usr/bin/python',
        '"/usr/bin/git',
        '"/usr/bin/rustdesk',
        '"/usr/bin/secret-tool',
        '"/usr/bin/true',
        '"/usr/bin/node',
        '"/usr/bin/plutil',
        "\'/usr/bin/python",
        "\'/usr/bin/git",
      ],
      allowlistPaths: [
        'tools/agent-runtime-probes/config_surface_doctor.py',
        'deploy/scripts/tests/',
        'plugins/tokenomics/tests/',
        'tools/agent-runtime-probes/tests/',
        'docker/',
        'scripts/lib/verify-lib.sh',
        'scripts/lib/fitness/',
        'scripts/check-launchd-drift.sh',
      ],
    },
    source: ['issue:2616', 'issue:2623'],
  },
  {
    id: 'portability.platform-paths-guarded',
    title: 'Linux-only paths must be platform-guarded',
    category: 'portability',
    rationale:
      '/proc/, /sys/, /run/ paths raise OSError on macOS. Each occurrence must be behind a process.platform === "linux" guard or equivalent. Enforced by guard:platform-patterns; existing unguarded occurrences are baselined debt.',
    detect: 'mechanical',
    rings: ['guard', 'ci'],
    severity: 'block',
    implementedBy: ['guard:platform-patterns'],
    ratchet: true,
    params: {
      globs: ['src', 'scripts', 'deploy/scripts'],
      extensions: ['.ts', '.py', '.sh'],
      patterns: ['/proc/', '/sys/', '/run/'],
      allowlistPaths: [
        'deploy/scripts/tests/',
        'plugins/tokenomics/tests/',
      ],
    },
    source: ['issue:2623'],
  },
  {
    id: 'portability.systemctl-guarded',
    title: 'systemctl calls must have macOS launchctl fallback',
    category: 'portability',
    rationale:
      'systemctl is Linux-only; on macOS the equivalent service manager is launchctl. Production scripts that invoke systemctl must either be behind a HOST_PLATFORM guard or provide a launchctl-equivalent branch. Enforced by guard:platform-patterns.',
    detect: 'mechanical',
    rings: ['guard', 'ci'],
    severity: 'block',
    implementedBy: ['guard:platform-patterns'],
    ratchet: true,
    params: {
      globs: ['deploy/scripts', 'src', 'scripts'],
      extensions: ['.py', '.ts'],
      patterns: ['"systemctl', "'systemctl"],
      allowlistPaths: [
        'deploy/scripts/bot-errors-health-check.py',
        'deploy/scripts/bot-errors-heartbeat-watchdog.py',
        'deploy/scripts/bot-errors-runtime-staleness.py',
        'deploy/scripts/tests/',
      ],
    },
    source: ['issue:2621'],
  },
  {
    id: 'portability.gnu-bsd-shell-flags',
    title: 'Shell scripts must avoid GNU-only flags',
    category: 'portability',
    rationale:
      'readlink -f, sha256sum without shasum fallback, stat -c, grep -P, sed -i without backup, mktemp without template, and similar GNU-specific flags fail on BSD/macOS. Shell scripts must use portable alternatives or explicit platform branches. Enforced by guard:platform-patterns.',
    detect: 'mechanical',
    rings: ['hook', 'guard', 'ci'],
    severity: 'block',
    implementedBy: ['guard:platform-patterns'],
    ratchet: true,
    params: {
      globs: ['scripts', 'deploy', 'tools', 'console'],
      extensions: ['.sh'],
      patterns: [
        'readlink -f',
        'sha256sum',
        'stat -c ',
        'grep -P',
        'mktemp --directory',
      ],
      allowlistPaths: [
        'deploy/lib/read-private-health-token.sh',
        'deploy/scripts/whatsoup-bot-errors-deploy.sh',
        'scripts/install-transcription-deps.sh',
        'tests/fixtures/',
      ],
    },
    source: ['issue:2622'],
  },
  {
    id: 'portability.editorconfig-present',
    title: '.editorconfig present',
    category: 'portability',
    rationale:
      'Cross-platform editor consistency requires .editorconfig. Editors on all platforms respect it automatically. Absence permits TAB/space and line-ending drift.',
    detect: 'mechanical',
    rings: ['guard'],
    severity: 'advisory',
    source: ['retrospective:editorconfig-consistency'],
  },
  {
    id: 'portability.fetch-timeout',
    title: 'fetch() calls must specify timeout',
    category: 'portability',
    rationale:
      'fetch() without AbortSignal.timeout() can hang indefinitely on unresponsive hosts. This is a portability concern across network environments (different proxy timeouts, DNS resolution differences between platforms). All fetch() calls must include a signal option.',
    detect: 'ast',
    rings: ['eslint'],
    severity: 'warn',
    source: ['retrospective:ssrf-fetch-timeout', 'retrospective:http-proxy-hang'],
  },
  {
    id: 'portability.sync-exec-timeout',
    title: 'Synchronous child_process calls must specify timeout',
    category: 'portability',
    rationale:
      'execSync, execFileSync, and spawnSync without timeout block the Node.js event loop forever on hanging subprocesses. Subprocess behavior differs across platforms (path resolution, signal handling), making cross-platform hangs more likely without explicit timeouts.',
    detect: 'ast',
    rings: ['eslint'],
    severity: 'warn',
    source: ['retrospective:execfile-sync-no-timeout', 'retrospective:process-lock-hang'],
  },
  {
    id: 'portability.arch-blind-binary-resolution',
    title: 'Binary resolution must consider process.arch on heterogeneous architectures',
    category: 'portability',
    rationale:
      'Custom resolveBinaryPath() in local-audio.ts:18-27 is arch-aware (searches /opt/homebrew/bin first) but the bare-name provider binary resolution in session.ts:345-361 (returning bare names like "claude", "codex") and execFile calls in video.ts:43,112,129 (ffprobe/ffmpeg) and tree-liveness.ts:54 (ps) have zero arch awareness. process.arch is already recorded in health telemetry (health.ts:398, connection-snapshot.ts:63) but never consumed for adaptive resolution. On arm64 macOS, PATH-dependent resolution misses brew-installed binaries in stripped environments. New binary resolution code SHOULD use or extend resolveBinaryPath() to include arch-aware discovery.',
    detect: 'semantic',
    rings: ['guard', 'ci'],
    severity: 'warn',
    source: ['issue:2642'],
  },
  {
    id: 'portability.arch-blind-path-fallback',
    title: 'PATH fallbacks must include arch-aware Homebrew prefix',
    category: 'portability',
    rationale:
      'Hardcoded PATH fallbacks in fleet/platform.ts:104 and boundary-run-cli/shared.ts:233 omit /opt/homebrew/bin — the standard Homebrew prefix on ARM macOS. In stripped-environment runs (launchd, systemd --user with minimal env), the fallback is used directly and brew-installed binaries (ffmpeg, whisper-cli, secret-tool) become invisible on Apple Silicon. All PATH fallbacks must include /opt/homebrew/bin when the default contains /usr/local/bin.',
    detect: 'mechanical',
    rings: ['guard', 'ci'],
    severity: 'warn',
    params: {
      globs: ['src', 'scripts', 'deploy'],
      extensions: ['.ts', '.mjs', '.js', '.sh'],
      patterns: [
        "process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'",
      ],
      allowlistPaths: ['scripts/lib/fitness/'],
    },
    source: ['issue:2642'],
  },
  {
    id: 'portability.hardcoded-signal-name',
    title: 'Signal names must use shared constants, not string literals',
    category: 'portability',
    rationale:
      '29 signal string literals (SIGTERM, SIGKILL, SIGINT) are hardcoded across src/ and scripts/ in .kill(), process.on(), and spawn killSignal options. POSIX signal names have no equivalent on Windows (SIGKILL is absent, SIGTERM must be used instead), and the SIGTERM→SIGKILL escalation pattern appears identically at 7 call sites. A shared constants module (src/lib/signals.ts) provides a single-point abstraction for cross-platform signal mapping, making Windows adaptation a one-file change. ESLint rule should flag kill(\'SIG*\'), process.on(\'SIG*\'), and killSignal: \'SIG*\' string literals.',
    detect: 'mechanical',
    rings: ['eslint', 'guard', 'ci'],
    severity: 'warn',
    params: {
      globs: ['src', 'scripts', 'deploy'],
      extensions: ['.ts', '.mjs', '.js'],
      patterns: [
        ".kill('SIGTERM')",
        ".kill('SIGKILL')",
        "process.on('SIGINT'",
        "process.on('SIGTERM'",
        "killSignal: 'SIGKILL'",
        "killSignal: 'SIGTERM'",
        'killSignal: "SIGKILL"',
        'killSignal: "SIGTERM"',
      ],
      allowlistPaths: ['tests/', 'node_modules/', 'scripts/lib/fitness/'],
    },
    source: ['issue:2643'],
  },
] satisfies FitnessRule[];
