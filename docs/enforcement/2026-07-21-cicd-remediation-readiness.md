# WhatSoup CI/CD Remediation-Readiness Specs — R-03 / R-04 / R-05

**Status:** proposals only — every change below is **OWNER-GATED**. Nothing in this
document has been applied. This analyst is strictly read-only (no repo edits, no
commit, no push).

**Anchor OID:** `cb3b90b164fb1af9ad2df52798598cffae656cd8` (current `main` tip,
`fix(guards): skip .tmup-artifacts in insecure-tempfile scan (#2008)`, 2026-07-21).
All blobs read via `git show cb3b90b164:<path>`; line numbers are against that blob.
Local checkout HEAD is `c4d25ba6…` (one commit ahead of the anchor); the workflow /
guard / registry blobs cited here are byte-identical at both (verified by reading the
anchor blob directly). Apply against `main` at merge time.

**Evidence labels:** OBSERVED = read directly from the anchored blob / live API.
INFERRED = reasoned from history or design intent, flagged as such.

**Action-SHA resolution (R-03):** resolved live via `gh api` (authed read-only,
`LucasQuiles/WhatSoup`) at audit time 2026-07-21. The `# vX.Y.Z` comment records the
human-readable release the moving `@vN` tag currently points at; pin the SHA, keep the
version in a comment.

---

## R-03 — Pin external actions to commit SHAs + assess merge queue

### OBSERVED — enumeration (14 external `uses:` refs across 3 workflows)

`git ls-tree` of `.github/workflows/` at the anchor lists exactly three files:
`quality.yml`, `tag-release-gate.yml`, `whatsoup-guard.yml`. Every `uses:` in all
three points at an `actions/*` repo pinned to a **mutable major tag** (`@v4` / `@v5`).
Count = 14 refs, over **5 unique actions**:

| # | action @ tag | occurrences (file:line) |
|---|---|---|
| 1 | `actions/checkout@v4`       | quality.yml:32, quality.yml:350, tag-release-gate.yml:36, whatsoup-guard.yml:30 |
| 2 | `actions/setup-node@v4`     | quality.yml:51, quality.yml:354, tag-release-gate.yml:40, whatsoup-guard.yml:31 |
| 3 | `actions/setup-python@v5`   | quality.yml:63, quality.yml:360 |
| 4 | `actions/cache@v4`          | quality.yml:290, tag-release-gate.yml:115 |
| 5 | `actions/upload-artifact@v4`| quality.yml:337, tag-release-gate.yml:130 |

4 + 4 + 2 + 2 + 2 = **14 refs → 5 unique SHAs to resolve.** No third-party
(non-`actions/*`) actions are used, so all pins are to the first-party GitHub org.

### OBSERVED — resolved SHAs (live `gh api repos/<owner>/<repo>/git/ref/tags/<tag>`)

| action | current tag | resolved commit SHA | tag currently == |
|---|---|---|---|
| `actions/checkout`        | `v4` | `11d5960a326750d5838078e36cf38b85af677262` | `v4.4.0` |
| `actions/setup-node`      | `v4` | `49933ea5288caeca8642d1e84afbd3f7d6820020` | `v4.4.0` |
| `actions/setup-python`    | `v5` | `a26af69be951a213d495a4c3e4e4022e16d87065` | `v5.6.0` |
| `actions/cache`           | `v4` | `0057852bfaa89a56745cba8c7296529d2fc39830` | `v4.3.0` |
| `actions/upload-artifact` | `v4` | `ea165f8d65b6e75b540449e92b4886f43607fa02` | `v4.6.2` |

All five refs dereferenced directly to a `commit` object (no annotated-tag
indirection). Re-resolve at apply time if this doc is applied well after 2026-07-21 —
these moving tags advance.

### Exact replacement lines

Preserve each site's existing indentation and its `uses:` vs `- uses:` form; only the
ref token changes. Replacement token per action (append the version comment):

```
uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262        # v4.4.0
uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020      # v4.4.0
uses: actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065    # v5.6.0
uses: actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830          # v4.3.0
uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
```

Per-site application (14 edits):

- **quality.yml** — L32 checkout, L51 setup-node, L63 setup-python, L290 cache,
  L337 upload-artifact, L350 checkout, L354 setup-node, L360 setup-python.
- **tag-release-gate.yml** — L36 checkout, L40 setup-node, L115 cache,
  L130 upload-artifact.
- **whatsoup-guard.yml** — L30 checkout (`- uses:` inline form), L31 setup-node
  (`- uses:` inline form).

### merge_group assessment

- **OBSERVED:** no workflow currently declares a `merge_group:` trigger; there is no
  GitHub merge queue wired. `quality.yml` triggers on `pull_request` + `push:main`;
  `whatsoup-guard.yml` on `pull_request`/`push` filtered to `tools/whatsoup_guard/**`;
  `tag-release-gate.yml` on `push: tags: v*`.
- **Recommendation (OWNER-GATED):** if a merge queue is desired, add `merge_group:` to
  the two PR-gate workflows so queued candidates re-run the gate against the
  speculative merge commit. Exact YAML (insert into the existing `on:` block):

  `quality.yml` (after L7, inside `on:`):
  ```yaml
    merge_group:
      types: [checks_requested]
  ```
  `whatsoup-guard.yml` (after L8, inside `on:`):
  ```yaml
    merge_group:
      types: [checks_requested]
  ```
  Do **not** add `merge_group:` to `tag-release-gate.yml` — it is tag-triggered and
  never participates in a PR merge queue.

- **DEPENDENCY / caveat (do not surprise the owner):**
  1. `merge_group` events require the repo's **merge queue to be enabled in GitHub repo
     settings** (branch-protection UI) — the YAML trigger alone does nothing without it.
  2. **`whatsoup-guard.yml` is `paths:`-filtered.** `merge_group` events do **not**
     honor the `pull_request.paths` filter; adding `merge_group:` there makes that job
     run on **every** queued merge regardless of whether `tools/whatsoup_guard/**`
     changed. Harmless (it is a fast typecheck+test job) but it is a behavior change —
     flag it. If path-scoping in the queue matters, gate the job body on a
     `dorny/paths-filter`-style step instead (adds a new third-party action → itself
     needs SHA-pinning, so weigh against the simplicity of "just always run it").

**Risk:** LOW. SHA-pinning is inert to all current gates — no repo guard enforces or
forbids action-ref format (confirmed: no `guard:*` script references `.github/workflows`
ref pinning). Pins only change supply-chain immutability. `merge_group` is additive.
**Rollback:** revert the workflow edits (pure YAML; no state).
**Readiness:** TURNKEY for the 14 pins (copy-paste). Merge queue is a policy decision +
a GitHub-settings prerequisite, so semi-turnkey.

---

## R-04 — Three "orphaned" guards (each needs a *different* disposition)

Confirmed exact paths at anchor: `scripts/grant-resolver-inventory-guard.ts`,
`scripts/required-suites.ts`, `scripts/check-launchd-drift.sh`. These are **not** the
same class of orphan — only the first is a genuine wiring gap.

**Two mechanical constraints that shape every option here (OBSERVED):**
- **Meta-guard** `scripts/guard-test-coverage-check.ts` (`enumerateGuardScripts`):
  guard-family = `scripts/*.ts` whose basename `includes('guard')` **or** starts with
  `check-`. Each such script must have a companion test **wired in
  `verify:push:branch`** (or carry a top-of-file `// meta-guard:no-test <reason>`).
  `.sh` files and `.ts` files not matching that predicate are **out of scope**.
- **Public-surface guard** `scripts/public-surface-drift-check.ts` (wired in quality.yml
  L182 + both verify chains): every `guard:*` npm script must have a matching row in
  `docs/public-surface.md` keyed `cli:npm.guard-<name>`. Adding a `guard:*` script
  **without** the row makes `guard:public-surface-drift` fail.

### R-04a — `grant-resolver-inventory-guard.ts` → **WIRE IT** (genuine gap)

- **Intent (OBSERVED):** its own header calls it a "CI inventory guard for QR-143 / B4";
  introduced in commit `7122fb9f3` whose message reads "CI inventory guard … fails the
  build when a NEW … grant composition appears." A security tripwire meant to run in CI.
- **Wiring status (OBSERVED):** **no** `guard:*` npm script exists for it; it appears in
  **no** workflow. `git log -S` over `package.json`/`.github/` finds no npm-script ever
  added. So the guard's `main()` (which scans `src/` and sets a nonzero exit) **never
  runs against the repo in any gate.** Its **test**
  `tests/scripts/grant-resolver-inventory-guard.test.ts` **IS** wired in
  `verify:push:branch` (explicit list) and runs under CI `coverage:check` — but a unit
  test validates the guard's logic on fixtures; it does **not** run the guard against the
  real tree (the exact L5-01 gap quality.yml L233-238 already calls out for the
  arc-binding / critical-surface guards). This is why the meta-guard is green yet the
  guard is unenforced: the meta-guard checks the **test** is wired, not that the guard
  **runs** in a gate.
- **Wire-safety (OBSERVED):** reproduced the guard's scan (regex
  `isAdminPhone\s*\(\s*resolvePhoneFromJid\s*\(`, comment-stripped, `src/**/*.ts`
  non-test, minus the `GRANT_RESOLVER_ALLOWLIST` entry `src/core/outbound-message-safety.ts`).
  Live candidate lines: `src/core/access-list.ts:209` (inside a block comment → stripped,
  not flagged) and `src/core/outbound-message-safety.ts:118/129` (L118 comment; L129 real
  code but the file is allowlisted). **Net = 0 findings.** Wiring it stays green today; it
  only catches future drift.
- **Exact wiring change (4 edits, OWNER-GATED):**
  1. `package.json` scripts block — add beside the other `guard:*` entries (e.g. after
     `guard:insecure-tempfile`, L56):
     ```json
     "guard:grant-resolver": "bash scripts/run-with-pinned-node.sh scripts/grant-resolver-inventory-guard.ts",
     ```
  2. `docs/public-surface.md` — add a row (model on the `cli:npm.guard-insecure-tempfile`
     row at L302):
     ```
     | `cli:npm.guard-grant-resolver` | `npm run guard:grant-resolver` | `package.json` | internal | active | Fail the build on a new ungated inline isAdminPhone(resolvePhoneFromJid(...)) grant composition in src/ (QR-143/B4; use resolvePhoneFromJidForGrant or an allowlist row) |
     ```
  3. `.github/workflows/quality.yml` — add a step in the guard cluster (e.g. after the
     "Insecure tempfile guard" step, L224-225):
     ```yaml
     - name: Grant resolver inventory guard
       run: npm run guard:grant-resolver
     ```
  4. `package.json` — append `&& npm run guard:grant-resolver` to `verify:push:branch`
     (L89) and `verify:release` (L90) so local pre-push and release chains enforce it too.
- **Companion obligations already satisfied:** meta-guard passes (test is wired, alias
  resolution `grant-resolver-inventory-guard.ts → grant-resolver-inventory-guard.test.ts`
  is exact). No `// meta-guard:no-test` needed.
- **Risk:** LOW (green on arrival; forward-only tripwire). **Rollback:** revert the 4
  edits. **Readiness:** TURNKEY.

### R-04b — `required-suites.ts` → **NOT a gate by design; add discoverability alias OR retire**

- **Intent (OBSERVED):** its docblock states it is a **WARN-tier triage aid**: "It is
  informational (WARN-tier): it always exits 0 and mutates nothing." It computes the
  minimum local suite set (functional ∪ all-fitness) so the #1507/#1514 gap classes can't
  recur; the docblock explicitly names `npm run verify:push:branch` as the canonical gate
  and this script as "NOT a substitute for it."
- **Wiring status (OBSERVED):** never wired — no history in `package.json`/`.github/`, no
  current npm script, no `docs/public-surface.md` row. Out of the **meta-guard** scope
  (basename has neither `guard` nor `check-`), which is why its unwired test does not fail
  `guard:guard-test-coverage`. Its test `tests/scripts/required-suites.test.ts` exists and
  runs under CI `coverage:check` (full `vitest run`), just not in the `verify:push:branch`
  explicit list.
- **Importer check (OBSERVED):** grep for `required-suites` / its exports
  (`computeRequiredSuites`, `functionalSuites`, `fitnessGuardSuites`,
  `enumerateTestSuites`, …) across `src/ scripts/ tests/ console/ deploy/ tools/` finds
  **no importer other than its own test.** Retirement is safe (nothing depends on it).
- **Recommendation (OWNER-GATED) — pick one:**
  - **(preferred) Keep + make discoverable.** Add a **non-gate** npm alias so the tool is
    actually invokable instead of dead code. Because it always exits 0, it must **not** be
    added to any gate chain (a gate that can't fail is vacuous — cf. `meta.no-redundant-gates`).
    ```json
    "triage:required-suites": "bash scripts/run-with-pinned-node.sh scripts/required-suites.ts",
    ```
    Deliberately named `triage:` not `guard:` so it does not trip the public-surface
    `guard:*` row requirement and is not mistaken for an enforcement gate. (A
    `docs/public-surface.md` row is still good hygiene for any npm script but is only
    *enforced* for the `guard:*` namespace.)
  - **(alternative) Retire.** Delete `scripts/required-suites.ts` (whole file) and
    `tests/scripts/required-suites.test.ts` (whole file). No `verify:push:branch` edit is
    needed (the test is not in the explicit list); no `// meta-guard:no-test` implication
    (out of scope). Justified only if the local-triage workflow it supports is unused.
- **Recommended disposition:** keep + alias. The file is functional, tested, and encodes
  two proven CI-gap lessons; the only defect is that nothing invokes it.
- **Risk:** VERY LOW either way. **Rollback:** revert the one-line add / restore the two
  files. **Readiness:** TURNKEY (alias) / TURNKEY (retire).

### R-04c — `check-launchd-drift.sh` → **host diagnostic; add `guard:launchd-drift` alias for sibling parity, do NOT CI-gate**

- **Intent (OBSERVED):** header: "macOS sibling of `scripts/check-unit-drift.sh`
  (systemd)." It compares installed `$HOME/Library/LaunchAgents/com.whatsoup.*` surfaces
  against checked-in templates (substitute-then-compare, fail-closed on surviving
  placeholders, secret-safe structural-only check of credential-bearing per-bot plists).
  It is a **deployed-macOS-host** tool: on the CI runners (ubuntu) there is no
  `LaunchAgents` dir, so it exits 3 ("LaunchAgents directory not found") unless
  `--allow-missing-launchd-dir`. Correctly **not** meant to gate CI.
- **Wiring status (OBSERVED):** no npm script, no workflow, no verify-chain reference, no
  `docs/public-surface.md` row (`grep -c guard-launchd` = 0). Out of **meta-guard** scope
  (it is `.sh`). Its manifest-parity test `tests/scripts/launchd-drift.test.ts` **does**
  exist, `spawnSync`s the script (so its logic runs in CI via the full suite), and asserts
  the call-site manifest parity the script's own L301-302 comment marks "VERBATIM."
- **Sibling parity (OBSERVED):** the systemd sibling `check-unit-drift.sh` **is** exposed
  as `guard:unit-drift` (package.json L45) **and carries a public-surface row**
  (`cli:npm.guard-unit-drift`, docs/public-surface.md L299) — but `guard:unit-drift` is
  itself **not** in quality.yml or either verify chain. So the established repo treatment
  for a host-drift check is: **npm alias + public-surface row, but not CI-gated.**
  `check-launchd-drift.sh` is missing exactly that alias + row.
- **Recommendation (OWNER-GATED) — bring to sibling parity (do NOT gate):**
  1. `package.json` — add beside `guard:unit-drift` (L45):
     ```json
     "guard:launchd-drift": "bash scripts/check-launchd-drift.sh",
     ```
  2. `docs/public-surface.md` — add a row modeled on `cli:npm.guard-unit-drift` (L299):
     ```
     | `cli:npm.guard-launchd-drift` | `npm run guard:launchd-drift` | `package.json` | internal | active | Compare installed macOS com.whatsoup.* LaunchAgents with checked-in templates (substitute-then-compare; secret-bearing plists structural-only) |
     ```
  Do **not** add it to quality.yml / verify chains — CI is ubuntu and it would exit 3.
  If the owner ever wants a CI smoke, the only safe form is
  `bash scripts/check-launchd-drift.sh --allow-missing-launchd-dir` (exits 0 with a skip
  message), which proves the script runs but tests nothing — low value, not recommended.
- **Retire?** **Not recommended.** It has a wired parity test, encodes the mini7/8/9
  hand-render incident class, and mirrors a maintained sibling. Retiring would delete
  live macOS-host drift coverage.
- **Risk:** VERY LOW (alias + doc row only; not gated). **Rollback:** revert the two
  additions. **Readiness:** TURNKEY.

---

## R-05 — `process.no-destructive-git` is severity `block` with no implementer

### OBSERVED — the finding, and why it slips through

- The rule lives at `scripts/lib/fitness/registry.ts:190-198`: `id:
  'process.no-destructive-git'`, `category: 'process'`, `detect: 'mechanical'`, `rings:
  ['guard', 'hook']`, `severity: 'block'`, `source: ['feedback:no_git_clean',
  'developer-instructions:git-safety']`.
- **No implementer exists.** Grepping the whole tree at the anchor for `no-destructive-git`
  returns only two hits: the registry declaration and the taxonomy-doc row
  (`docs/architecture/fitness-taxonomy.md:65`). No `guard:*` npm script, no
  `scripts/*.ts`/`*.sh` scans for destructive git. `detect: 'mechanical'` + `rings:
  ['guard','hook']` promise a mechanical guard/hook enforcer that is simply absent.
- **INFERRED (history) — none ever existed.** `git log --all -S 'no-destructive-git'`
  yields only `28f65d453 base` and `1260c07e8 feat(fitness): add architectural fitness
  registry and guard enforcement` (the commit that introduced the registry). `-S
  'no_git_clean'` adds only two codex working-tree snapshots (untracked feedback content,
  not implementers). The rule was born `block` and never got an enforcer.
- **Why the gate is green anyway (enforcement model, OBSERVED):** the registry is a
  **passive catalog**; enforcement is wired **ad hoc, per rule**, by separate guard
  scripts. `tests/scripts/fitness-registry.test.ts` validates only: unique namespaced
  ids, valid enum values (`FITNESS_SEVERITIES` includes `advisory`), non-empty `source`,
  exactly **36** rules, taxonomy-doc **id** presence (`doc.toContain(\`\${rule.id}\`)` —
  the *id*, not the severity cell), and ratchet/baseline bookkeeping for the ratcheted
  rules. **There is no assertion that a `block`/`guard`-ring rule has a wired implementer.**
  So a rule can be `block` forever with nothing enforcing it and every gate stays green.

Both options below keep the `fitnessRules` length at 36 and change no ratchet/baseline,
so `fitness-registry.test.ts` stays green either way.

### Option (a) — Build the implementer (close the gap by enforcing)

- **Blast-radius / green-on-arrival (OBSERVED):** scanned the entire committed-automation
  surface (`scripts/ deploy/ tools/ .husky/ src/`, excluding tests/fixtures/docs) for
  `git clean`, `git reset --hard`, `git checkout -f/--force`, `git push --force/-f`,
  `git branch -D`, `git update-ref -d`, `git stash clear`, `git reflog expire`,
  `git gc --prune`, `filter-branch`, `filter-repo`. **The only hit is the registry
  rationale string itself** ("Committed scripts and hooks must not use destructive git
  cleanup commands."). There are **zero live destructive-git invocations** in committed
  automation → a new guard would be **green on arrival**: no baseline, no allowlist, no
  pre-cleanup required. (The implementer must, however, avoid self-flagging that
  rationale — see scan-surface note.)
- **What it must scan (proposed banned set).** `source` tags `feedback:no_git_clean` /
  `developer-instructions:git-safety` are provenance labels (feedback memory + developer
  instructions), **not** an in-repo doc — there is no `docs/**/git-safety.md` to import a
  canonical list from (confirmed: grep finds only mentions inside taxonomy + plan docs).
  So the banned set is a **proposed enumeration for owner confirmation**, derived from the
  rationale ("destructive git cleanup commands"):
  - `git clean` (any `-f/-d/-x` form)
  - `git reset --hard`
  - `git checkout -f` / `git checkout --force` / `git switch --force`
  - `git push --force` / `git push -f` (consider whether `--force-with-lease` is
    allowed — recommend still flag, advise `--force-with-lease` is *less* destructive but
    still rewrites remote history)
  - `git branch -D` (force-delete)
  - `git update-ref -d`, `git stash clear`, `git reflog expire --expire`,
    `git gc --prune=now`
  - `git filter-branch`, `git filter-repo`
- **Where it lives + house pattern.** Model on `scripts/check-insecure-tempfile.ts` (the
  closest analog: mechanical banned-pattern scan of committed scripts, comment-stripping,
  no baseline, exports pure scan functions + a `main()` that sets nonzero exit; extension/
  shebang classification of what to read). New file:
  `scripts/no-destructive-git-guard.ts` (basename contains `guard` → satisfies the
  meta-guard naming convention and maps to `tests/scripts/no-destructive-git-guard.test.ts`).
  - **Scan surface:** `.sh` files + shebang-detected shell scripts + `.husky/` hooks under
    `scripts/`, `deploy/`, `tools/`, `.husky/`. Strip comments before matching (a `#`
    line, or the trailing-comment split, like check-insecure-tempfile). **Exclude**
    `scripts/lib/fitness/registry.ts` and `docs/` (the rationale/taxonomy prose that
    *names* the commands is not a live call) — either by not scanning `.ts` data files at
    all, or by string/comment-stripping. Recommend: scan shell/hook surfaces only (the
    rule's own text is "scripts and hooks"), which sidesteps the registry-prose false
    positive cleanly.
- **How to wire (mirrors R-04a; OWNER-GATED):**
  1. `package.json`:
     `"guard:no-destructive-git": "bash scripts/run-with-pinned-node.sh scripts/no-destructive-git-guard.ts",`
  2. `docs/public-surface.md`: add `cli:npm.guard-no-destructive-git` row (mandatory for
     `guard:public-surface-drift`).
  3. `.github/workflows/quality.yml`: add a "No destructive git guard" step in the guard
     cluster.
  4. `package.json`: append `&& npm run guard:no-destructive-git` to `verify:push:branch`
     and `verify:release`.
  5. **Companion test (mandatory):** ship `tests/scripts/no-destructive-git-guard.test.ts`
     AND add its path to the `verify:push:branch` explicit `npm test --` list — otherwise
     `guard:guard-test-coverage` fails the build (basename contains `guard` → in
     meta-guard scope; a red-path failure test is also required by that meta-guard's
     semantic check).
  6. **`hook` ring (rings include `'hook'`):** add
     `bash scripts/run-with-pinned-node.sh scripts/no-destructive-git-guard.ts` to
     `.husky/pre-commit` (or `.husky/pre-push`) so the declared hook ring is real. This is
     secondary to the guard-ring wiring but is what makes the `['guard','hook']` claim
     honest.
- **Risk:** LOW-MEDIUM. Green on arrival, but a new mechanical guard has false-positive
  surface (e.g. a legit `git clean` in a throwaway CI temp dir, or a documented recovery
  script). Mitigate with a comment-stripped scan + a small justification allowlist
  (like `GRANT_RESOLVER_ALLOWLIST`) so a legitimate future use has an escape hatch.
  **Rollback:** revert the wiring + delete the new script/test.
  **Readiness:** SPEC-READY, not code-ready — the guard must be written and its banned set
  ratified by the owner. This is the higher-effort option but the one that makes the
  `block` severity truthful.

### Option (b) — Demote severity `block` → `advisory` (make the catalog honest cheaply)

- **Exact registry edit** — `scripts/lib/fitness/registry.ts`, the
  `process.no-destructive-git` object, line 196:
  ```
  -    severity: 'block',
  +    severity: 'advisory',
  ```
- **Taxonomy sync (implication)** — `docs/architecture/fitness-taxonomy.md:65`, change the
  severity cell so the doc doesn't misreport:
  ```
  - | `process.no-destructive-git` | mechanical | block | guard, hook | Keep destructive git cleanup commands out of committed automation. |
  + | `process.no-destructive-git` | mechanical | advisory | guard, hook | Keep destructive git cleanup commands out of committed automation. |
  ```
  Note (OBSERVED): `fitness-registry.test.ts` only asserts the **id** appears in the doc
  (`doc.toContain(\`\${rule.id}\`)`), **not** the severity cell — so the test stays green
  even if the cell is left stale. Update the cell anyway for honesty; consider also
  flipping the `rings` to reflect that no guard/hook implements it (e.g. drop to
  `['sdlc']` or annotate), though that is optional and beyond the minimal demotion.
- **Inertness proof (OBSERVED):** grepped every consumer of `fitnessRules` /
  `.severity`. Consumers of the registry are `scripts/import-boundary-check.ts`,
  `scripts/transport-pattern-check.ts`, and the two fitness tests — **none branch on a
  fitness rule's `.severity`** (the only `.severity` reads in the guard scripts are ESLint
  *message* severities in `eslint-fitness-check.ts:66-67`, unrelated). So block→advisory
  is **functionally inert to enforcement** (there is no enforcement to weaken) and changes
  no gate outcome. `advisory` is a valid `FITNESS_SEVERITIES` member, so the enum
  assertion passes; length stays 36; no ratchet touched.
- **Risk:** VERY LOW. **Rollback:** one-line revert (+ the doc cell). **Readiness:**
  TURNKEY.

### Recommendation for R-05

Two coherent end-states; the owner picks the posture:
- If destructive-git-in-automation is a real threat worth *blocking* (the original
  intent), do **(a)** — it is green on arrival, so wiring cost is the only cost.
- If it is better handled by review/instruction than a mechanical gate, do **(b)** to stop
  the registry from advertising an enforcement that does not exist.
**Do not leave it as-is:** `block` with no implementer is a false-green — the catalog
claims a hard gate that never runs.

---

## Cross-cutting companion-change checklist (applies to any wiring above)

- Any **new `guard:*` npm script** ⇒ **must** add a `cli:npm.guard-<name>` row to
  `docs/public-surface.md` (else `guard:public-surface-drift` fails). Applies to R-04a,
  R-04c, R-05(a).
- Any **new `scripts/*guard*.ts` or `scripts/check-*.ts`** ⇒ **must** ship
  `tests/scripts/<name>.test.ts` **and** add its path to the `verify:push:branch` explicit
  test list, or add `// meta-guard:no-test <reason>` (else `guard:guard-test-coverage`
  fails). Applies to R-05(a). R-04a already satisfies this; R-04c is `.sh` (out of scope);
  R-04b's `triage:` name keeps it out of scope.
- **Re-resolve R-03 SHAs** if applied materially later than 2026-07-21 (moving tags
  advance).

## Provenance
- Anchor `cb3b90b164`; workflows/guards/registry read via `git show cb3b90b164:<path>`.
- Action SHAs: live `gh api repos/<owner>/<repo>/git/ref/tags/<tag>` (+ `tags` match for
  the `# vX.Y.Z` labels), 2026-07-21.
- Wiring history: `git log --all -S`, `git grep` over the anchor tree.
- Every recommendation is a **proposal, OWNER-GATED**; nothing applied.
