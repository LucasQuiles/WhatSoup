# The launchd governed-environment reader contract

Two programs read the `EnvironmentVariables` dictionary out of a generated
`com.whatsoup.<instance>.plist`, and they are written in different languages:

| reader | entry point | what it drives |
|---|---|---|
| TypeScript | `compareGovernedLaunchdEnv` in `src/fleet/launchd-env-drift.ts` | the `--apply` gate of `scripts/reconcile-launchd-restart-policy.ts`, through `refuseApplyThatDropsEnv` in `src/fleet/platform.ts` |
| Python | `instance_plist_environment` in `deploy/scripts/bot-errors-health-check.py` | the provider probe's governed-PATH and governed-prepend checks |

They were mirrored by hand, one fix at a time, and they drifted. Duplicate-key
refusal reached the two sides months apart. A missing marker meant "empty" on
one side and "unreadable" on the other, and the empty answer let `--apply`
delete keys it had never enumerated. This document is the single answer set both
readers are held to, and `tests/fixtures/launchd-env-plist-contract/` is the
corpus that proves it: plain `.plist` files with a manifest, driven by
`tests/fleet/launchd-env-drift.test.ts` and by
`deploy/scripts/tests/test_bot_errors_health_check_provider_probe.py`.

## Why these readers exist at all

The authoritative parser is the system one (`plutil`, and launchd itself). These
readers are not trying to replace it. They answer one narrow question — *which
keys does the installed job carry* — in two places where shelling out to
`plutil` is not available or not wanted, and a governed value must never be
printed. That makes their failure mode specific: **disagreeing with the system
parser about a valid file, silently.** Every rule below exists because one of
them did.

## The answer vocabulary

Every input shape covered by this contract resolves to exactly one of three
answers. "Unspecified" is not a cell, and a corpus fixture without a decided
answer fails its own suite.

| answer | TypeScript | Python | meaning |
|---|---|---|---|
| **refuse** | `comparable: false`, `reason: 'environment-variables-unparseable'` | `None` (`GOVERNED_PLIST_UNREADABLE`) | the reader cannot enumerate the dictionary. Callers must treat it as drift, never as "no drift"; `--apply` refuses without `--drop-non-governed-env`. |
| **empty** | `comparable: true` with every governed key of the render reported `missing` and nothing dropped | `{}` | the element is present and genuinely holds nothing. |
| **map** | `comparable: true`; governed keys compared by SHA-256 of the decoded value, non-governed keys by NAME only | the whole key/value map | the reader read the dictionary. |

`refuse` and `empty` are not interchangeable. `empty` is a positive claim that
there are no keys, and on the apply surface that claim empties the dropped-key
list, so the gate sees nothing to drop and the re-render erases whatever the
installed job carried without naming a single key.

## The cells

Every corpus row is pinned by a fixture in
`tests/fixtures/launchd-env-plist-contract/`, driven by both reader suites.
Additional dict and marker variants are pinned directly by the spelling tables
in `tests/fleet/launchd-env-drift.test.ts` and
`deploy/scripts/tests/test_bot_errors_health_check_provider_probe.py`; the
corpus does not cover every spelling in this table. The nested-marker known
residual records measured current behavior rather than a parser promise.

| input shape | answer | why |
|---|---|---|
| plain dict, governed and non-governed keys | map | the control |
| `<dict>`, `<dict >`, `<dict\n>` | map | the same element to any plist reader |
| `<dict/>`, `<dict />` | empty | present and empty is not unreadable |
| `<dict class="x">`, `<dict foo="a>b">` | refuse | detected broadly, parsed narrowly: consuming to the first `>` would end the token inside an attribute value and read the rest of the opening tag as body pairs |
| nested dict inside the body | refuse | the body truncates at the first `</dict>`, so a key after it reads as absent |
| duplicate key | refuse | TypeScript took the last, Python took the first; neither precedence is defensible against a parser with its own |
| comment / CDATA / processing instruction inside the body | refuse | the body must be fully consumed by matched key/string pairs and XML whitespace |
| comment / CDATA / processing instruction **before** the marker, carrying a decoy dict | map, from the live dict | inert text is not markup: the decoy must make no difference at all. The CDATA corpus decoy sits inside a plist-valid string value |
| unterminated `<!--`, `<![CDATA[` or `<?` | refuse | not well-formed XML; ignoring it parses every following byte as live markup. `unterminated-comment.plist` is the intentionally malformed corpus fixture |
| no `EnvironmentVariables` element | refuse | the reader cannot claim "no keys" about an element it never found |
| `EnvironmentVariables` declared more than once using canonical or XML-whitespace-padded key tags | refuse | the duplicate detector covers these measured tag forms. It does not claim general XML-equivalent spelling detection |
| marker that exists only inside a nested dictionary | map, from the nested dict — **known residual, not fixed here** | both readers search by position rather than document depth, so they mistake the nested marker for the top-level environment |
| marker spelled `<key >EnvironmentVariables</key >` | refuse | see below |
| the five XML predefined entities in a value | map, decoded | the shipped escaping |
| leading or trailing whitespace in a value | map, kept verbatim | `<string>` content is significant |

### Why a non-canonical marker spelling is refused rather than parsed

`<key >EnvironmentVariables</key >` is the same element to the system parser, and
`plutil` reads the file correctly. Both readers select a dictionary through one
literal marker and therefore do not parse this spelling, which lands in
`refuse`. The separate duplicate detector sees this spelling when a canonical
marker also exists.

Broadening the marker to an element token — the way the dict token is already
broadened — would make these readers newly **accept** a file they used to refuse.
That is a contract widening, and the reason not to take it is written in
`src/fleet/launchd-env-drift.ts` itself: making this reader newly accept a plist
it used to refuse is a change these fixes are not the place for. A refusal names
the operator's problem accurately ("I could not find the element you are about
to overwrite") and costs one acknowledgement flag; a second parsing dialect on a
security-sensitive reader costs a class of surprises. If the spelling ever turns
up in the field, widening it is a deliberate change with its own disclosure —
and this row is where it gets decided.

The duplicate detector is narrower than XML equivalence. It counts the
canonical marker and markers whose opening or closing `key` tag has only XML
whitespace before `>`. The canonical literal remains the only marker that
selects a dictionary to parse. Entity-encoded key text, key text split by CDATA
or comments, document depth, and other full-XML semantics remain outside this
detector and require separate contract rows before either reader changes.

### Why inert regions are masked AND their spans are reported

Both readers blank comments, CDATA sections and processing instructions to runs
of `-`, preserving length so every offset below stays byte-aligned with the real
file. The filler is deliberately not XML whitespace, so an inert region sitting
in a whitespace-only gap still fails the checks that require whitespace there.

That is not sufficient on its own, and the shortfall was measured rather than
reasoned about. In **character data** a dash is perfectly legal: masking
`<string><![CDATA[/opt/bin]]></string>` yields `<string>` plus twenty dashes plus
`</string>`, which the pair pattern's `[^<]*` value group matches happily. The
body would then count as fully consumed and parse to a dash-valued key — two
cells that fail closed today turned fail-open by their own fix. So the mask
returns the spans it blanked, and both readers refuse when a span intersects the
`EnvironmentVariables` body. The whitespace rules keep catching a region in a
gap; the span rule catches one in character data, which they cannot.

At each step the **earliest** opener wins, not the first kind in the list: a
processing instruction may carry `<!--` as literal text, and a comment may carry
`<?`.

A DOCTYPE internal subset is not masked. plist(5) files carry an external
DOCTYPE with no internal subset, so a fourth region kind would widen these
readers for a shape the generator never emits. Stated as a known residual.

## Stated asymmetries

These are deliberate and are not drift. The Python reader owns a file-path input
the TypeScript comparator never sees, so it carries guards the comparator has no
place for.

| guard | side | why |
|---|---|---|
| `Label` must match `com.whatsoup.<instance>` before the marker search | Python only | the Python reader resolves the pathname itself, so an unrelated or planted plist at the expected pathname must never be parsed. The comparator is handed bytes by a caller that already asserted the generated identity. |
| 65536-byte size cap, regular non-symlink file only | Python only | same reason: it opens the file. |

## Open divergence: entity decoding

**Not resolved. Pinned, so that a unilateral change breaks the corpus.**

The TypeScript reader decodes exactly the five XML predefined entities
(`&lt; &gt; &quot; &apos; &amp;`). The Python reader uses `html.unescape`, which
also resolves numeric character references and the full HTML5 named set. A
governed value containing `&#47;` therefore compares as written on one reader and
as `/` on the other, for the same file.

Closing it needs BOTH halves: widening the TypeScript side to numeric character
references, and narrowing the Python side away from HTML5 named entities. Both
are behaviour changes on a security-sensitive parser and belong in their own
change with their own disclosure. Until then the corpus carries the cell with
each reader's answer stated explicitly, in the manifest's `openDivergence` field.

The two halves of that field are deliberately asymmetric. A case's
`environment` is the TypeScript reader's answer and the corpus's reference
answer; `openDivergence.python` is the Python reader's answer and is used only
by the Python suite. So fixing ONE side turns that side's row red while the
other stays green, which is the intended behaviour: a unilateral change cannot
pass, and whoever makes it has to come back here and decide the cell. Deciding
it means replacing `openDivergence` with a single agreed `environment`.

## Changing this contract

1. Decide the cell here first, in the vocabulary above.
2. Add or amend the fixture and its manifest row in
   `tests/fixtures/launchd-env-plist-contract/`.
3. Make both readers agree with the row.
4. Both suites assert the manifest's entry count AND that the manifest names
   exactly the `.plist` files on disk — a count alone stays green when a fixture
   and its row are deleted together, and misses a fixture that is never listed.
