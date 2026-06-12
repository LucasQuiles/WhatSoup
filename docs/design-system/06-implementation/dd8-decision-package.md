# DD-8 Decision Package — ghost-tier essential-text spec conflict

Status: **DECIDED 2026-06-12 — Option B approved by operator** (promote the time lane
and detail-component to --text-2). Spec amendment landed in log-stream.md; the two
CSS ink changes landed with the decision-execution commit. Remaining DD-8 work is the
per-screen essential-text corrections in the package's decision-independent list,
owned by the C3 stage. Contrast claims in this package were independently recomputed
by the integrator before approval (4.14/3.37 fail; 7.60/6.03 pass).
Inputs: `06-implementation/dd8-ghost-survey.md` (staged survey), `03-spec/color.md`,
`03-spec/components/log-stream.md`, the design-debt register DD-8 row, live tokens in
`console/src/styles/tokens.semantic.css`, and a fresh whole-tree call-site sweep
(69 ghost-tier hits re-classified, 2026-06-12).

All contrast figures below were recomputed (WCAG 2.2 relative luminance) from the live
values in `console/src/styles/tokens.semantic.css`, not copied from the spec tables.
Where they confirm the spec's numbers this is stated; where the spec table shows the
superseded v2 value, the live value is used.

---

## 1. The conflict, stated precisely

### 1.1 What color.md requires

`03-spec/color.md` §4.1 (dark ink table, text-3 verdict cell):

> "below 4.5 everywhere — **lawful only because text-3 is classified incidental**
> (never sole carrier; lint-enforced). Passes the 3:1 non-text floor on all surfaces."

`03-spec/color.md` §7 (enforcement hooks):

> "`incidental-ink-guard` — `--text-3`/`.ghost` may not be the only rendering of a datum."

So the law is: any datum whose only rendering is `--text-3` ink is a spec violation.
`--text-3` exists for incidental ink — decoration, placeholders, de-emphasis — and is
deliberately allowed to sit below the 4.5:1 AA threshold for normal text on that basis.

### 1.2 What log-stream.md prescribes

`03-spec/components/log-stream.md`, Anatomy:

> "time — --type-data-sm, --text-3"

and for level tags:

> "D = `--text-3` + dashed border."

The implementation follows the spec faithfully: `console/src/styles/primitives.css:1064-1071`
(`.soup-log__time`, `color: var(--text-3)` at line 1067, `--type-data-sm` = 11px mono),
rendered by `console/src/components/primitives/LogStream.tsx:133`
(`<span className="soup-log__time">{entry.timestamp}</span>`).

### 1.3 Why both cannot hold

The time lane renders the event timestamp — a datum, with no redundant rendering anywhere
(no title attribute, no detail-bed copy; verified in `LogStream.tsx`). Therefore either:

- the timestamp is **essential**, in which case `--text-3` is unlawful for it under
  color.md §4/§7 and the time lane must move up the ink ladder, **or**
- the timestamp is **incidental metadata**, in which case color.md needs an explicit
  carve-out, because as written the `incidental-ink-guard` ("only rendering of a datum")
  condemns it: the time lane *is* the only rendering of that datum.

There is no reading under which both documents stand unamended. And the conflict cannot
be waved off with "text-3 is close enough to AA," because it is not:

### 1.4 Contrast numbers (computed from live tokens, both themes)

`--type-data-sm` is 11px — normal text under WCAG SC 1.4.3, so the AA requirement is
**4.5:1**. Live token values: dark `--text-3: #6B7480`; light `--text-3: #7C8490`
(the color.md §5 must-fix value; the superseded v2 `#8A919C` is already off the tree).

| Ink × surface | base | raised | overlay | inset | AA 4.5:1 verdict |
|---|---|---|---|---|---|
| dark text-3 `#6B7480` | 4.02 | 3.76 | 3.49 | **4.14** | fails every bed |
| light text-3 `#7C8490` | 3.62 | 3.78 | 3.78 | **3.37** | fails every bed |
| dark text-2 `#9AA2AD` | 7.39 | 6.90 | 6.41 | 7.60 | passes every bed |
| light text-2 `#555C66` | 6.47 | 6.75 | 6.75 | 6.03 | passes every bed |

The inset column is the operative one: log-stream.md puts every LogStream on a
`--surface-inset` bed. So the time lane as shipped runs at **4.14:1 (dark)** and
**3.37:1 (light)** against a 4.5:1 requirement. The light figure matches color.md §5's
own worst-pair note for the fixed value ("3.37 on inset") and clears only the 3:1
incidental/non-text floor — with 0.37 of headroom. Dark is near-miss; light is not close.

Conclusion: "essential text at text-3" is unsatisfiable in either theme on any surface.
The conflict is real, binary, and must be resolved by classification or by re-tiering —
not by nudging the token (any text-3 dark enough to pass 4.5:1 stops being a ghost tier
and collapses into text-2).

---

## 2. Live-code inventory — ghost tier at every call site

Whole-tree sweep of `--text-3` / `text-t5` / `--color-t5` consumers under `console/src`
(69 hits; token-definition files excluded). Alias fact re-verified against
`tokens.semantic.css`: `--color-t4` resolves to `--text-2` (not ghost) and `--color-t5`
to `--text-3` — only t5/text-3 sites are listed. Classification uses color.md's own
definition: **essential** = the ghost rendering is the only rendering of a datum;
**incidental** = decorative, placeholder, de-emphasis, or redundantly rendered elsewhere.

### 2.1 Essential — direct subjects of this decision

| Surface | Screen(s) | Location | Classification |
|---|---|---|---|
| LogStream time lane | Ops (`pages/Ops.tsx:275`), SoupKitchen (`pages/SoupKitchen.tsx:302`), LineDetail (`components/line-detail/LogsTab.tsx:66`) | `styles/primitives.css:1067`; rendered at `components/primitives/LogStream.tsx:133` | **ESSENTIAL** — sole rendering of event time; 11px mono on inset bed (4.14 dark / 3.37 light) |
| LogStream detail-bed component name | same three screens | `styles/primitives.css:1148`; rendered at `LogStream.tsx:153-155` (`component: {entry.component}`) | **ESSENTIAL (conditional)** — sole rendering of `entry.component`, which is a distinct field from the `entry.source` lane |
| MessageBubble timestamp + type row | Inbox | `components/MessageBubble.tsx:229` (row), `:232` (media type), `:236` (`formatTime`) | **ESSENTIAL** — sole at-rest rendering of message time; the full timestamp exists only in the hover card (`MessageBubble.tsx:45`), which is pointer-gated. B4 owns MessageBubble; fold per survey |
| Nav "Polling" badge | global chrome | `components/Nav.tsx:153-156` | **ESSENTIAL** — a degraded-transport status rendered at ghost (its healthy sibling "Live" gets `text-s-ok`). Redundancy is icon + title attr only. Routed to the nav slice (DD-5) per survey, but the classification belongs in this register |
| Bare `c-col-header` (defaults to t5) | Inbox detail panel, LineDetail ModeTab | utility default `styles/composites.css:528-535`; bare uses `pages/Inbox.tsx:489`, `:512`, `components/line-detail/ModeTab.tsx:47` | **ESSENTIAL** — section/column headers are sole carriers of their label. Note the inconsistency: 11 of 14 call sites already override with `text-t4` (text-2); the utility default is the outlier. Fix is decision-independent: re-tier the default to t4 |
| Inbox chat meta lane | Inbox | `pages/Inbox.tsx:255` (`{activeLine} · group/direct`) | **ESSENTIAL** — sole rendering of the chat's owning line and group/direct kind in the detail panel |

### 2.2 Borderline — classify with the decision, not unilaterally

| Surface | Screen(s) | Location | Classification |
|---|---|---|---|
| Debug level tag "D" | log screens | `styles/primitives.css:1095-1100`; spec'd by log-stream.md | **LAWFUL-REDUNDANT, marginal** — level is triple-channel (letter + uniquely dashed border + position), so text-3 ink is not the sole carrier; but at 9px the letter itself is sub-AA in both themes. If Option B is chosen, consider aligning D with the I tag at text-2 |
| Empty-state copy cluster | Ops, Inbox, LineDetail, SoupKitchen feed, charts | `pages/Ops.tsx:137`, `:141`; `pages/Inbox.tsx:596`; `components/line-detail/AccessTab.tsx:160`; `components/ChartPanel.tsx:78`; `styles/composites.css:223` (`.feed-empty`) | **BORDERLINE** — when a region is empty, this copy is the region's only content and carries the remedy line. Recommend text-2 via the C3 state-taxonomy index page regardless of the time-lane decision |
| Resting ghost on interactive controls | Inbox, LineDetail, SoupKitchen feed | `pages/Inbox.tsx:359` (load more), `components/line-detail/HistoryTab.tsx:134`, `:186` (load older, hover lifts to t2), `:148` ("No more messages"), `styles/composites.css:173` (`.feed-toolbar__pause` — the WCAG 2.2.2 pause control) | **BORDERLINE** — labels are the sole rendering of the affordance at rest; hover reveals t2/t3. The pause control deserves special scrutiny: log-stream.md requires the paused state "visibly labeled" |
| Heatmap axis labels | LineDetail (MetricsTab) | `components/ActiveHoursHeatmap.tsx:31`, `:98`, `:127`, `:184`, `:227` | **INCIDENTAL-BY-REDUNDANCY (weak)** — every cell carries a title tooltip with full date/hour/value (`ActiveHoursHeatmap.tsx:82` etc.), so axis text is not the sole carrier, but the redundancy is pointer-gated |
| Feed provider badge | SoupKitchen (ActivityFeed) | `components/FeedCard.tsx:484` | **INCIDENTAL (marginal)** — supplementary provenance metadata on a feed event; no redundant rendering, but not operationally load-bearing. Confirm at the SoupKitchen C3 pass |
| Ops footer status bar | Ops | `pages/Ops.tsx:292-296` | **INCIDENTAL-BY-REDUNDANCY** — entry count duplicates the toolbar filter-pill counts (`pages/Ops.tsx:265`); active line and mode are carried by the line picker |

### 2.3 Exempt — absent-value ghosts and conventional de-emphasis

| Surface | Location | Classification |
|---|---|---|
| Table em-dash ghost | `styles/primitives.css:840-844` (`.soup-table-ghost`); sole consumer `components/primitives/Table.tsx:296` with `aria-label="none"` | **EXEMPT** — the datum is absence; the em-dash is a placeholder glyph and the aria-label is a second rendering, satisfying the incidental-ink-guard literally. Recommend color.md name this exemption explicitly (see §3, all options) |
| Zero-count de-emphasis | `pages/SoupKitchen.tsx:939`, content-empty em-dash `components/MessageContent.tsx:258`, `components/AlertBanner.tsx:45` (separator dash) | **EXEMPT (same family)** — zero/absent values quieted by design; calm-by-default |
| Placeholders | `styles/composites.css:630`, `:664`, `styles/primitives.css:973`, `components/shared/SearchInput.tsx:15` | **EXEMPT** — placeholder convention; light text-3 clears the 3:1 floor on inset (3.37) per color.md §5 |
| Disabled / pending / skipped states | `styles/primitives.css:1363` (disabled tab), `components/UpdateModal.tsx:317`, `:320`, `:376`, `:380`, `:437`, `components/AddLineWizard.tsx:46-76` (incomplete steps), `components/MessageBubble.tsx:53`, `:97` | **EXEMPT** — state de-emphasis; the datum returns to full ink when the state activates |
| Decorative icons, separators, hints | `components/FeedIcon.tsx:23`, `:53`, `components/EmptyState.tsx:38` (icon only), `components/Nav.tsx:158`, `:185`, `:192`, `components/line-detail/PipelineTab.tsx:71`, `components/KeyboardShortcutsHelp.tsx:57`, `styles/composites.css:410` (hover-reveal meta row), `styles/primitives.css:126` (unknown-mode dot), `components/line-detail/ModeTab.tsx:103` (boolean dot off-state), `components/wizard/ConfigStep.tsx:342`, `:705`, `components/wizard/IdentityStep.tsx:151` ("(optional)" tags, descriptions) | **EXEMPT** — incidental by color.md's definition; non-text items need only the 3:1 floor, which live text-3 clears on every bed in both themes |
| Orphan mapping | `lib/log-theme.ts:7` (`debug: 'text-t5'`) | **DEAD CODE (apparent)** — no importer found in `console/src`; flag for deletion at the LogStream-adjacent C3 pass rather than classification |

Survey cross-check: the staged survey's four essential-suspects are confirmed (items 1-4
above, with current line numbers — `primitives.css` drifted from ~1057/~1138 to
1067/1148). The sweep adds three findings the survey's per-screen tallies did not
itemize: the bare `c-col-header` default, the Inbox chat meta lane, and the
empty-state/pause-control borderline clusters.

---

## 3. Resolution options (decision is USER-GATED)

Common to all options: color.md should name the absent-value exemption explicitly
(em-dash/zero ghosts with an accessible-name second rendering), and the `c-col-header`
default re-tiers to text-2 — both are decision-independent corrections.

### Option A — Carve-out: timestamps are metadata; color.md gains an exemption

- **Spec edit:** color.md §4/§7 add a named exemption: "temporal metadata lanes
  (log time lane, message timestamps) are incidental provided the full timestamp is
  redundantly available." log-stream.md unchanged.
- **Code surfaces:** no ink changes; add the redundancy the exemption demands — title
  attribute or detail-bed timestamp in `LogStream.tsx`, and a non-pointer-gated full-time
  rendering for `MessageBubble.tsx` (the current hover card does not serve keyboard or
  touch).
- **Contrast outcome:** time lanes stay at 4.14:1 dark / 3.37:1 light on inset — passing
  only the 3:1 floor, with 0.37 light-theme headroom.
- **Operator-scan rationale:** weakest option. The reference library's operator-console
  findings cut against it: the aviation annunciator-panel finding ("consistent placement
  so operators scan by position, not by reading") justifies a *recessive* lane, but the
  library's observability anchors — Grafana as "the reference for time-series panels +
  dense ops dashboards" and Datadog's "same filtering/time-range/graph interactions
  everywhere" — both treat time as the organizing axis of an observability console.
  Incident triage is correlate-by-time: the operator scans the time lane to find the
  window, then reads messages. A scan anchor used under stress, at the smallest type
  size in the system (11px), in the failing theme at 3.37:1, is the wrong place to
  spend the ghost tier.
- **Migration cost:** lowest (docs + two redundancy patches), but it permanently
  weakens the `incidental-ink-guard` lint by introducing an exempt-datum category, and
  DD-8 is marked "blocks final acceptance: YES" — an exemption this marginal will be
  re-litigated at closeout.

### Option B — Promote: time lanes are essential; log-stream.md amends to --text-2

- **Spec edit:** log-stream.md anatomy line changes to "time — --type-data-sm,
  --text-2"; same for the detail-bed component name; color.md unchanged (the law is
  upheld, no exemption machinery). Optionally align the D level tag with the I tag at
  text-2 (border style keeps debug distinct).
- **Code surfaces:** `styles/primitives.css:1067` and `:1148` (one-line ink changes);
  `components/MessageBubble.tsx:229/:232/:236` rides the B4 MessageBubble slice; Nav
  "Polling" stays a DD-5 nav-slice call (status channel vs text-2) but is unblocked by
  the same principle.
- **Contrast outcome:** time lane lands at 7.60:1 dark / 6.03:1 light on inset — AA
  pass on every bed in both themes.
- **Operator-scan rationale:** strongest. Time becomes a legible scan anchor; recession
  is preserved by *size and weight*, not sub-AA ink — at 11px tabular mono against a
  13px/12.5px body ladder the lane still reads as quiet chrome next to the text-1
  message lane. This matches the program's creative bar ("restrained contrast, operator
  scan paths") without spending accessibility to get the restraint.
- **Migration cost:** small and bounded: two CSS lines, two spec lines, one B4 fold-in,
  no token changes, no lint changes. The CI token-pair contrast check and
  `incidental-ink-guard` need no new categories.

### Option C — New ink step: a fourth "data-muted" tier engineered to clear 4.5:1

- **Spec edit:** tokens-v3 §3.2 ink ladder gains a step between text-2 and text-3,
  tuned per theme to sit at roughly 4.6-5.5:1 on inset; color.md tables, the CI contrast
  check, and the lint vocabulary all extend; log-stream.md re-points the time lane at it.
- **Code surfaces:** token files, both spec docs, the same primitives.css lines, plus
  Tailwind utility registration and alias-map review.
- **Contrast outcome:** AA pass by construction, with a visibly quieter lane than
  text-2.
- **Operator-scan rationale:** equal to B functionally; slightly finer typographic
  hierarchy.
- **Migration cost:** highest, and it reopens the locked three-step ink ladder — which
  is itself a G2-locked direction, so Option C requires the same user gate twice over.
  A four-step ladder also invites future tier-shopping, the failure mode the three-step
  ladder was locked to prevent.

### Recommendation (advisory; decision remains USER-GATED)

**Option B.** It is the only option that resolves the conflict by *upholding* the
stricter law rather than amending it; the contrast outcome is unambiguous in both
themes; the code delta is two lines plus a planned B4 fold-in; and the operator-scan
argument from the reference library favors a legible time anchor. Option A's light-theme
3.37:1 leaves a finding marked acceptance-blocking resting on 0.37 of headroom above the
wrong threshold; Option C buys marginal nuance at the price of reopening a locked token
direction.

---

## 4. Impact on C3 sequencing

C3 is the per-screen polish stage; DD-8's expiration condition is "every screen
migration confirms no essential text on ghost tier," and it blocks final acceptance.

**Blocked on this decision (cannot close their DD-8 checklist line):**

- **Ops** — LogStream service log (time lane + detail component + D tag classification).
- **SoupKitchen** — its LogStream instance; the feed provider badge confirm rides the
  same pass but is classification work, not blocked work.
- **LineDetail** — LogsTab's LogStream; the HistoryTab/heatmap items are borderline
  classifications that the decision's reasoning will settle by precedent.
- **B4 / Inbox (partial)** — the MessageBubble timestamp fold-in is blocked; the rest of
  the Inbox pass is not.
- **Nav slice (DD-5, partial)** — the "Polling" badge tiering call is informed by, not
  strictly blocked by, this decision; sequencing it after avoids a re-touch.

**Proceed regardless:**

- Every non-ghost line of every C3 screen checklist (layout, motion, states, keyboard,
  theme parity).
- The decision-independent corrections: `c-col-header` default re-tier to text-2, the
  empty-state copy tier (settle via the C3 state-taxonomy index page), the absent-value
  exemption wording in color.md, deletion of the orphan `lib/log-theme.ts`, and the
  Inbox chat-meta-lane re-tier (essential under any option, since no option reclassifies
  *identity* metadata).
- All exempt-class surfaces in §2.3 — no rework under any option.

Note the asymmetry: if Option B is chosen, the blocked set unblocks with a two-line CSS
change plus two spec lines, and C3 proceeds at full width. Options A and C keep the
blocked set open longer (redundancy patches / token-ladder rework respectively).

---

## 5. Strong-claim audit (this document's own claims)

- Contrast ratios: computed 2026-06-12 from `console/src/styles/tokens.semantic.css`
  literals via WCAG 2.2 relative luminance; light-inset 3.37 independently matches
  color.md §5's worst-pair note. Confidence: high.
- "No redundant rendering of the LogStream timestamp": verified by reading
  `LogStream.tsx` (no title attr, detail bed re-renders `entry.msg` and
  `entry.component` only). Confidence: high.
- "`entry.component` is distinct from `entry.source`": inferred from the component's
  props rendering both fields separately; whether real log payloads ever populate
  `component` differently from `source` was not traced to the data source. Confidence:
  medium — if they are always identical, the detail-component site downgrades to
  incidental-by-redundancy.
- "`lib/log-theme.ts` has no importer": text search over `console/src` only; a dynamic
  or aliased import would evade it. Confidence: medium.
- Reference-library citations (annunciator scan-by-position, Grafana, Datadog) are
  quoted from `01-research/reference-library.md` entries marked known-canon /
  search-verified there; the operator-triage "correlate-by-time" claim is argument from
  those findings, not a measured study.
- The 69-hit sweep covered `--text-3`, `text-t5`, and `--color-t5` spellings; a raw-hex
  ghost (which would itself violate `no-raw-color-in-components`) would not be caught.
