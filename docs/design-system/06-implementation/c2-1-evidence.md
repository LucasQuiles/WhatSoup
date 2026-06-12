# Slice Evidence — C2.1 (Badge/Button primitives + shape-law status) + oversight waves 3–4

Worktree `soup-impl`, commit `fb67b43f`. Resolves DD-6 (status shape law) and starts DD-10
(target-size assertions). This packet also serves as the dedicated D1.5 packet the wave-3 audit
requested (D1.5 was tooling/doc remediation; its five-review evidence is the wave-3 disposition
table below plus the executable checks it produced).

## Five reviews

| Review | Verdict | Evidence |
|---|---|---|
| Positive-path | **PASS** | lint clean · build green · **1,674/1,674 tests** (115 files; +55 new) · parity 101 tokens · regression **8 PASS / 7 WARN** (check 15 now a true PASS) · live review: Fleet (electric-blue primary "Add Line"), LineDetail header (amber diamond + "degraded"), Ops fleet list + LinePicker (discs/diamond/square + labels, both themes, no overflow) |
| Negative-path | **PASS (scoped)** | unknown status → fail-visible outline + raw label (tested); icon-only Button without aria-label → compile-time type error (permanent negative fixture); disabled/loading/aria-busy tested; reduced-motion: halo static (global policy) |
| Omission review | below | |
| Regression review | **PASS** | StatusDot/ModeBadge kept as thin wrappers (prop-compatible); badge test rewritten from dot-only law to shape law (the old test enforced the superseded contract); 5 nav/app assertions from D1.2 unchanged; rollback = single-commit revert |
| Design-system conformance | **PASS** (frontend-design checkpoints pre + post) | shape law exact per badge.md (disc/diamond/square/outline 8px + label always); crit-blink rejected, single ambient budget honored; primary re-pointed `--color-s-ok`→`--accent` (P2-12, G2-sanctioned); map is the single rendering driver |

## Audit wave 3 (7 findings) disposition

1. D1.5 evidence packet — covered by this packet (see header).
2. Checks opt-in until P6 — acknowledged; doc wording already corrected in D1.5; no over-claims remain.
3. Check-15 counting bug — **FIXED** (`printf | grep -c || true`; was `echo "" | grep -c || echo 0` → "0\n0").
4. Per-rule ratchet maskable — **FIXED**: baseline now rule×file granularity (153 buckets, total 635 — the
   +21 over the old 614 is the shadow run now carrying the base config's selectors console-wide, see #policy).
5. Theme parity = name parity only — **acknowledged as necessary-not-sufficient**; value/contrast validation
   is the C1 spec contrast tables + visual QA matrix; noted in script header intent.
6. Evidence 406/135 vs baseline 407/136 — **reconciled**: evidence numbers were the agent's pre-rebase run;
   `console/lint-shadow-baseline.json` is canonical from its commit forward.
7. Negative fixtures for stub rules — scheduled with each rule's activation slice (per lint-plan lifecycle);
   the Button type-contract fixture (this slice) is the first executable negative fixture.

## Audit wave 4 (9 findings) disposition

1. <a id="policy"></a>Shadow exemption policy hole — **FIXED differently than framed**: there was no `off`
   override (base error rules always covered primitives), but a real flat-config rule-key collision meant the
   shadow run replaced the base selectors for non-primitive files. The shadow block now carries
   base + shadow selectors deduped (superset run; default lint remains the error gate).
2. status-map false SSOT — **FIXED**: entries now carry `shapeClass`/`labelClass`/`modeClass`; renderers
   consume map fields; unused `washToken` removed; fail-visible fallback spreads the unlinked entry.
3. Button aria contract — **FIXED**: discriminated-union props (icon-only ⇒ `aria-label` required at
   compile time) + permanent `ts-expect-error` negative fixture; runtime warn removed (repo guard bans
   ad-hoc console calls; the type contract is the durable enforcement).
4. primitives.css raw px — **FIXED**: tokenized (bw/sp/radius/dot/input-btn/feed-preview-max); header claim
   amended honestly (remaining raw px = spec-normative shape geometry only).
5. StatusDot wrapper behavior change — **REVIEWED LIVE**: Ops fleet list + LinePicker render shape+label
   without overflow in both themes (screenshots in session log); `size` prop deprecation documented.
6. LineDetail raw/c-btn buttons remain — **EXPLICIT DISPOSITION**: this slice migrated LineDetail's STATUS
   renderer only; its 4 buttons migrate in the LineDetail C2 button slice (tracked by the per-file ratchet
   bucket `soup/no-raw-button :: src/pages/LineDetail.tsx`).
7. FeedCard/FeedIcon tone maps — **SEPARATE DOMAIN** (feed event tones ≠ line status taxonomy), documented
   here; SummaryTab's connection-health map IS status-adjacent → folds into status-map at its C2/C3 slice
   (debt DD-11).
8. Mojibake in tokens.component.css — **FIXED** (corrupted banner glyphs replaced).
9. Weak badge assertions — **FIXED**: exact contract values asserted (token names, classes, labels);
   washToken assertions updated to the consumed contract.

## Omission audit
- Not touched: all other c-btn consumers (30 files — ratchet buckets are the burn-down), Pill/Modal/Table/
  Toolbar/Drawer primitives (next C2 slices), feed tone maps (DD-11 boundary documented).
- Viewports: desktop both themes reviewed; Ops at ~half-width renders compactly without overflow; 390px nav
  verified in D1.4 (unchanged here).
- Worktree hygiene: 3 stale agent worktrees verified fully-harvested (no unique commits; dirty copies are
  supersets-in-worse-form of committed work) — removal requires operator approval (classifier-gated).

## Design debt delta
| ID | Change |
|---|---|
| DD-6 | **CLOSED** — shape law live everywhere status renders |
| DD-10 | **STARTED** — xs=24px floor + 28px ActionButton hit area asserted in primitive tests |
| DD-11 | **NEW** — SummaryTab connection-health map folds into status-map at its migration slice |

## Verdict: **PASS**. Next slices: Pill primitive, then Modal/useDismissable (DD-7), then Table/Toolbar/LogStream/Drawer toward the Fleet pilot rehearsal.
