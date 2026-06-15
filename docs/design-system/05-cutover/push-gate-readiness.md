# Push-Gate Cutover Readiness Package — SOUP v3 Foundation Branch

Snapshot date: 2026-06-12. Branch under evaluation: `feat/soup-v3-foundation`
(implementation worktree) at HEAD `bf3a9a41`, measured against `origin/main` at
`0aca386f` (fetched the same day). This package is decision support for the push
gate only — the push itself remains a hard gate requiring explicit operator
approval as a named action (`program-directives.md` §2). Nothing in this document
authorizes a push, PR, or deploy.

Snapshot caveats (read before relying on any number below):

- The implementation worktree carried uncommitted in-flight work at snapshot time
  (Inbox/Modal/test/enforcement files — an active B4-era lane). Every number here
  is anchored to committed HEAD `bf3a9a41`; the gate run (§3.1) executed on the
  tree as found, dirty files included. The push gate requires a clean, committed
  tree, so all of §3 re-runs at push time.
- `origin/main` advanced the same day; the branch was 3 commits behind at
  snapshot. Branch currency (§3.5) is therefore RED right now by construction and
  flips only with a fresh origin absorption.

---

## 1. Branch inventory

Counts (from `git rev-list --count` against `origin/main`, 2026-06-12):

| Measure | Value |
|---|---|
| Commits ahead | 175 |
| Commits behind | 3 (origin moved the day of the snapshot) |
| Merge commits | 58 — 26 absorb `origin/main`, 32 carry `design/soup-rebrand` docs into the impl branch |
| Non-merge commits | 117 |
| Diff vs merge base | 224 files, ~47,000 insertions / ~4,100 deletions |
| Top-level surfaces touched | `docs/` (80 files), `console/` (80), `tests/` (56), root verify/CI plumbing (`package.json`, `vitest.browser.config.ts`, `vitest.config.ts`, `.husky/`, `.github/`), `package-lock.json` |
| `src/` (server) files touched | 0 — see §5 |

Thematic shape of the 117 non-merge commits (conventional-commit scopes: 49
docs(design), 23 feat(console), 15 refactor(console), 14 fix(console), 8+1
test, 6 chore, 1 feat(guards)):

| Group | Content | Representative commits | Evidence packet(s) |
|---|---|---|---|
| Design program record | T1–T7 scaffold, inventories, research, direction mockups, v2 lock, formal spec, enforcement + cutover plans, G1–G3 gate records, program directives, investigation packets, debt register | ~49 docs(design) commits | the `docs/design-system/` tree itself |
| Foundation / tokens (C0+C1, D1.x) | tiered token split (zero visual change), v2 palette + dual designed themes, Geist self-hosted, theme toggle, motion tokens, AA fixes | `4e98f0b5`, `9b0087ef`, D1.4 QA remediation, DD-4 font self-host | `d1-1-evidence.md`, `d1-2-evidence.md` |
| Lint shadow infrastructure (D1.3/D1.5) | soup/* shadow plugin, 16-check design-regression suite, waiver registry, theme-parity script, baseline ratchet | `5e7a9979`, `472c5b5a`, D1.5 remediation | `d1-3-4-evidence.md` |
| Primitives (C2.1–C2.3) | Badge/Button (shape law), Pill, Modal + useDismissable, Table, Toolbar, LogStream, Drawer (900px squeeze), Tabs, Popover; Fleet pilot adoption | `fb67b43f`, `59ceeb4f`, `701a7ff7`, `1d27f116`, `1f9bde39` | `c2-1-evidence.md`, `c2-2-evidence.md`, `c2-3-evidence.md` |
| Page migrations (B1, B2, B4) | LineDetail (Tabs, header, overflow), picker/input family on Popover (combobox contracts, orphan deletion), Inbox (ChatList listbox DD-17, contact-pane collapse, MessageBubble keyboard) | `048a26f7`, `d7feb2a4`, `8ca44a4f`-era B2 commits, `bb9ba869`, `68a7beda`, `d5627923` | `b1-evidence.md`, `b2-evidence.md`; B4 has an investigation packet only — evidence packet outstanding |
| Dialog migrations (B3 waves 1–3) | Modal size tokens + initialFocus; SaveContact, Relink, CreateGroup (wave 1); ConfigEditDialog, ScheduleComposerModal (wave 2); UpdateModal, GroupDetailModal (wave 3) | `71d77108`, `d73bef54`, wave-1 commit set | `b3-wave1-evidence.md`; wave 2/3 evidence packets outstanding |
| Enforcement (D6 + ratchets) | shadow rules promoted to scoped error, design gates wired into verify + pre-push, deterministic drift metrics, CSS tier-boundary checks, gate-placement parity, per-directory coverage ratchet, stale-ceiling metric | `ba4ed643`, `44897b16`, `d761d01d`, `64332ce8`, `f09f5dc3`, `b4140452` | `d6-investigation.md` (Ready with Constraints); evidence packet outstanding |
| Tests / integrity (D7 start + hardening) | vitest browser mode + trusted-event smoke gate, +72 cover-now tests, negative-fixture suite for all shadow rules, test-integrity baseline driven to zero, weak-assertion strengthening waves | `c3b1ac52`, `168f63b2`, `2d829a64` | `d7-investigation.md` (Ready with Constraints); evidence packet outstanding |
| Debt closures riding their lanes | DD-4 (fonts), DD-6/7 (primitives), DD-8 Option B ink promotion, DD-11..16, DD-20 (MotionConfig), removable-Pill 24px hit fix | spread across the groups above | `dd8-decision-package.md`, register Closed table |

Inventory surprises found while compiling this package (each verified):

1. **Merge volume is 58, not ~30.** The "absorbed origin merges" figure of ~30
   undercounts by category: 26 merges absorb `origin/main`, and a further 32
   merges carry the design branch's docs into the impl branch. Both kinds sit in
   the history any split strategy must handle.
2. **Branch is behind 3** as of the snapshot — origin advanced the same day.
   Currency must be re-established immediately before push, not assumed.
3. **The implementation worktree is dirty and actively shared.** Uncommitted
   files appeared and grew between two observations minutes apart. The push gate
   requires this lane to land or be explicitly dispositioned first (no stash —
   `program-directives.md` §2).
4. **`execution-log.md` is stale.** Its last entry is B2 + B3 wave 1; B3 waves
   2–3, B4 commits, D6 enforcement, D7 browser mode, and the coverage-audit work
   are committed but unlogged. The integrator's log catch-up should land before
   or with the push so the PR body can cite a current program record.
5. **`conformance-manifest.md` is stale.** Tally still reads 12 PASS / 9
   INCONCLUSIVE / 3 PENDING "as of the C2.3-accepted tree with B1 in flight";
   the Tabs row awaits `b1-evidence.md` which has existed for some time, and the
   typography row still describes the Google Fonts CDN import although DD-4
   closed with self-hosted woff2. Several flips are clerical given existing
   evidence; the refresh is Stage E work but a pre-push refresh would make the
   PR body honest at lower cost.
6. **Evidence packets are missing for landed slices**: B3 waves 2–3, B4, D6,
   and the D7 work landed so far have investigation packets but no acceptance
   evidence packets. Under the program's own A0/acceptance discipline these
   slices are committed but not yet *accepted*.

## 2. PR strategy

Constraints on record: the cutover plan's universal rule is one PR per phase,
with large phases allowed to split into stacked sub-PRs, each independently
revertable (`cutover-plan.md` §1). The D1.5 oversight entry recorded the branch
as a FOUNDATION PACKAGE and directed that at push-gate the split question be
evaluated, noting that single-package framing requires an explicit operator
choice (`execution-log.md`, D1.5 item 10).

### Option A — single foundation-package PR

One PR carrying the whole branch, squash-merged.

- Review surface: very large (224 files, ~47k insertions), but navigable — the
  per-slice evidence packets in `06-implementation/` are the review map, and
  ~80 of the files are the docs record itself.
- CI cost: one quality-workflow matrix run (plus re-runs on origin catch-up).
- Revert granularity: coarse — one revert removes everything. Mitigated
  structurally: the C0 alias-layer design means visual behavior is value swaps
  behind stable names, and `src/` is untouched, so revert risk concentrates in
  the console only.
- Origin merges: squash-merge collapses all 58 merge commits harmlessly (their
  origin-side content is already on main). No history surgery at all.

### Option B — stacked split (the program's named option)

Concrete boundaries along the thematic groups, in dependency order:

| Split | Scope | Depends on | Evidence packet supporting review |
|---|---|---|---|
| S0 | `docs/design-system/` program record | none (file-disjoint) | the record itself |
| S1 | C0 token split + C1 values/themes/fonts | none | `d1-1-evidence.md`, `d1-2-evidence.md` |
| S2 | lint shadow infra (soup/* plugin, regression suite, waivers, baselines) | S1 | `d1-3-4-evidence.md` |
| S3 | primitives + Fleet pilot (C2.1–C2.3, Tabs, Popover) | S1, S2 | `c2-1`/`c2-2`/`c2-3-evidence.md` |
| S4 | page migrations (B1 LineDetail, B2 pickers, B4 Inbox) | S3 | `b1-evidence.md`, `b2-evidence.md`; B4 evidence gap |
| S5 | dialog migrations (B3 waves 1–3) | S3 | `b3-wave1-evidence.md`; wave 2/3 evidence gap |
| S6 | enforcement promotions, verify/pre-push wiring, coverage ratchet (D6) | S2–S5 (promotions assume migrated surfaces at zero) | `d6-investigation.md` only |
| S7 | browser mode + integrity/test hardening (D7 start) | S3 | `d7-investigation.md` only |

- Review surface: humane per PR; eight reviews total.
- CI cost: eight matrix runs minimum, plus cascade re-runs every time a parent
  split lands or origin moves.
- Revert granularity: excellent — per split.
- **Squash-or-rebase decision per split, and the safe path.** The history
  contains 58 merge commits; it cannot be split by rebase or cherry-pick
  cascade. Rebasing a stacked chain across absorbed merges replays every
  origin conflict, and the standing operating lessons this program runs
  under forbid the cascade pattern: rebase-plus-force-push of an upstream PR
  destabilizes its children, and a parent squash-merge races and orphans the
  stack. The safe
  construction is **content snapshots, not history surgery**: each split branch
  is cut fresh from `origin/main` and receives its file set as a path-scoped
  diff from the foundation branch; each split PR is **squash-merged** in
  dependency order; no split is ever rebased after its children exist; and
  content equivalence against the foundation branch is re-verified immediately
  before each push, not only at split time (snapshot equivalence is not
  durable).
- Known entanglement costs, named honestly: the shadow-ratchet baseline
  (`console/lint-shadow-baseline.json`) is a single shared ratchet file that
  nearly every split mutates (615 at D1.3, 511 at this snapshot; fall-only for
  SOUP-lane buckets, with documented accommodations when main-side surfaces
  enter at their current counts) — each split
  needs its own regenerated, internally consistent baseline; test-assertion
  hardening commits cross group boundaries; and S6's verify wiring references
  scripts S2 introduces. These are exactly the seams where split reconstruction
  drifts from the proven tree.

### Option C — hybrid

Two PRs: **PR-1, the docs record** (`docs/design-system/` — file-disjoint,
trivially safe to carve out, reviewable as prose); **PR-2, the code as one
foundation package** (console + tests + root verify plumbing), squash-merged.
Optionally S6+S7 (enforcement + browser-mode infra) carve out as a third PR if
reviewers want the gate plumbing isolated; the seams listed under Option B make
finer splits progressively riskier.

### Recommendation

**Option C (hybrid, two PRs), with PR-2 squash-merged.** Reasoning: the code
tree's ratchet, baseline, and test-hardening state is sequentially entangled
across all thematic groups — an eight-way reconstruction maximizes drift risk
at the precise step where the program has the least verification history,
while squash-merging collapses the 58-merge history with zero surgery. Logical
revertability is preserved by the C0 alias design and the per-slice evidence
packets even when physical revert is coarse. The docs record splits out for
free and halves the reviewed code surface.

Named operator decision required: the D1.5 record explicitly reserves
single-package code framing (which Option C's PR-2 is) for operator choice. If
the operator prefers the program's named stacked split instead, the S0–S7
boundaries above are the proposal, with squash-per-split and no-rebase as
binding construction rules.

## 3. Push-gate checklist (verbatim-critical items)

Every item re-verifies at push time; snapshot status is advisory.

1. **`verify:push:branch` green at push time.** Status at this readiness
   snapshot: **GREEN** — a full run on 2026-06-12 against HEAD `bf3a9a41`
   exited 0 under the then-live gate. Current design-enforcement refresh
   (2026-06-14): `verify:console-design` exited 0 with design-regression 20
   checks; all twelve blocking design-regression checks (1, 2, 6, 8, 10, 12,
   13, 14, 15, 16, 17, 19) PASS; theme parity 122 tokens;
   lint-shadow-baseline.json total 352; burndown 661 total / 596 blocking; and
   `test:design-guards` 14 files / 155 tests. Caveats: the historical snapshot
   run executed on a tree carrying the in-flight lane's uncommitted files, and
   the push gate still requires a clean, current `verify:push:branch` run on the
   candidate commit. Re-run on the clean, current tree at push time.
2. **Commit-author email resolved at squash.** Per `program-directives.md` §2
   and the D1.3/D1.4 disposition, author identity is controlled at the squash
   step using the merge tool's author-email control. The address itself stays
   out of committed text, including this document.
3. **Explicit operator approval for the push, as a named action.** Blanket
   "proceed" responses do not cross the publish boundary; the approval must
   name the push.
4. **Protected-identifier final grep sweep.** The protected set
   (`program-directives.md` §2): the `whatsoup:` localStorage prefix;
   `/run/whatsoup/` socket paths; instance data paths; the `mcp__whatsoup__*`
   namespace; `WhatSoupError`; the ConfigStep "via WhatSoup" system prompt;
   systemd/launchd unit names. Design-regression check 10 ("all protected
   contracts present") passed in the snapshot run and re-runs as part of item
   1; the manual sweep is the independent second look.
5. **Branch currency: behind 0 at push time.** Snapshot status: **behind 3**
   (origin advanced the same day). A fresh origin absorption plus the full
   per-commit battery must precede the push.
6. **Clean committed tree.** The in-flight lane's uncommitted files must be
   committed through the normal integrator path or explicitly dispositioned
   (no stash, per directives) before the push candidate is cut.
7. **Record currency (recommended, not gate-blocking):** execution-log
   catch-up through the landed slices and the clerical conformance-manifest
   flips (§1 surprises 4–6), so the PR body cites a current record.

## 4. What blocks vs what rides

"Blocks final acceptance" is the Stage E closure bar from the debt register —
it does not by itself block an interim push, but every blocking row must close
before the program may declare the cutover complete.

**Blocking rows (register "Blocks final acceptance? YES"):**

| ID | What remains | Owner stage |
|---|---|---|
| DD-8 | per-screen ghost-tier classification / visual pass for the remaining borderline surfaces after the Option B decision package | C3 per-screen checklists |
| DD-18r | remaining responsive legs: nav width pressure beyond label hiding and side-panel law for non-Fleet surfaces | C3/D7 |
| DD-35 | SOUP nameplate/brand slice: replace the legacy split wordmark so status-channel green no longer appears on selection/action/nameplate affordances | C4 |

**Riding as documented debt (register "no"):** DD-5 (theme-toggle treatment,
rides the C3 nav slice), DD-9 (half-step spacing aliases), DD-22 (log
virtualization awaits a streaming source), DD-23 (popover collision flip),
DD-24 (collapse-orphaned contact actions), DD-26 (type ramp has consumers
with fallbacks but no CSS definitions), DD-28/DD-29 (state-model spec homes),
DD-32..34 (dialog/ruling/live-QA residues), DD-36..39 (icon/type/card/color-mix
enforcement), and DD-43 (toolkit primitive gaps).

**INCONCLUSIVE conformance rows and what flips them:**

- *Responsive layout rules* — the D7 deterministic viewport matrix now covers
  Fleet/LineDetail/Ops, Inbox contact-pane collapse, and the 900px drawer flip;
  the row flips when the remaining DD-18r legs close (nav width pressure beyond
  label hiding, plus side-panel law for non-Fleet surfaces).
- *Reduced-motion* — flipped PASS after the fresh browser reduced-motion proof:
  modal close now goes through `open={false}` in Chromium's reduce context and
  proves no closing dwell remains.
- *Brand boundary/nameplate/tick, glass chrome, ambient budget, 80ch measure,
  enforcement report-only* — these flip at C3/C4 slices and the enforcement
  promotion schedule.

**Remaining program work:** C3 screen polish and enforcement follow-through
(DD-8 ghost-tier classification, DD-18r's nav-width and non-Fleet side-panel
legs, DD-26 type ramp, glass nav treatment, prose primitive, and report-only
guard promotions); C4 branding flip (nameplate, title, favicon/manifest — the
current favicon is an unrelated purple/blue bolt and the SOUP asset still needs
to be designed, per the C4 refresh survey — plus the SoupKitchen-to-Fleet rename
and its test-assertion set); Stage E closeout (manifest completion rule: no
PENDING/INCONCLUSIVE rows without an
accepted-debt exit, and blocking rows cannot take that exit).

**Interim push vs push-after-Stage-E — recommendation:** **interim push now**
(once §3 items 5–6 are restored), not waiting for Stage E. Reasoning: the
branch is internally consistent and gate-green; the brand flip has not landed,
so nothing half-renamed ships; 175 commits of unpushed work on a single
machine is the program's largest unmanaged risk and it grows daily as origin
advances (26 absorptions so far); and the cutover plan always intended one PR
per phase rather than a single end-of-program drop — C3, C4, and Stage E land
as their own later PRs under the same gates. The cost is some duplicated
review attention across the later PRs. Push-after-Stage-E concentrates risk
further for no gate the program requires. Operator decides.

## 5. Deploy note

This branch ships console (design-system) changes, tests, documentation, and
verify/CI enforcement plumbing only. **No server behavior changes** beyond
what the absorbed origin merges already carry (and those are, by definition,
already on main). Verified against the diff on 2026-06-12: `git diff
origin/main...HEAD --stat -- src/` returns **empty** — zero `src/` files differ
from the merge base; the same holds for the two-dot diff from the merge base.
The full 224-file diff decomposes into `docs/`, `console/`, `tests/`, and root
verify/CI configuration. The one root-level behavioral surface is the
pre-push/verify chain itself (design gates wired into `verify:push:branch` and
the pre-push hook), which affects developer workflow, not the deployed
runtime. Deploying this branch changes what operators see in the console and
what gates contributors pass — it does not change message handling, transport,
MCP tools, or any `src/` runtime path.
