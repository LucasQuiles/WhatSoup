#!/usr/bin/env bash
# console/scripts/design-regression.sh
#
# Design-regression check suite (lint-plan section 5).
# Implements all 16 labeled checks from the lint-plan's rg-based regression table.
#
# Shadow stage policy:
#   - All checks are REPORT-ONLY at shadow stage.
#   - This script always exits 0 (counts reported, never blocking).
#   - When a check is promoted to CI-blocking, update the EXIT_ON_FAIL array below.
#
# Usage:
#   bash console/scripts/design-regression.sh          (from repo root)
#   npm --prefix console run design:regression         (via npm script)
#
# Requirements: rg (ripgrep), node (for check 9), bash >= 3.2

# Do not use set -e: rg exits 1 when there are no matches (expected behavior here).
set -uo pipefail

# Script must be run from repo root (where console/ lives)
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONSOLE_SRC="$REPO_ROOT/console/src"
CONSOLE_DIR="$REPO_ROOT/console"

# Checks marked EXIT_ON_FAIL will cause a non-zero exit if they find unexpected results.
# At shadow stage: empty array (all report-only).
# Promoted checks (D6 packet §10 rollback table, commit 3):
#   - Check 1: tightened hex pattern correct (no false-positive decimal IDs); zero real hex
#               colors verified live; promotes FAIL on any real color leak.
#   - Check 2: live PASS (zero rgb()/hsl() in components/pages/lib); fail path real.
#   - Check 6: live PASS (split wordmark ">What<...>Soup<" absent); fail path real.
#   - Check 8: fixed to assert exact title content (was vacuous); FAIL on title drift.
#   - Check 10: live PASS (all three protected contracts present); FAIL on deletion.
#   - Check 12: live PASS (zero TSX outline-none after Inbox + HistoryTab composer
#               migrations); FAIL on focus suppression reintroduction.
#   - Check 13: live PASS (exactly 5 infinite occurrences, all sanctioned/waivered); FAIL on new.
#   - Check 14: live PASS (no expired waivers); deterministic date check, zero FP surface.
#   - Check 15: live PASS after use-exit-presence dead suppression cleanup; FAIL on any
#               lint suppression lacking a waiver:<id> tag.
#   - Check 16: live PASS (zero legacy lane vars); FAIL on reintroduction.
#   - Check 17: live PASS (zero component-tier CSS raw colors after --shadow-hover);
#               FAIL on raw hex/rgb/hsl/oklch reintroduction outside token tiers.
# Immature checks remaining report-only (d6-investigation.md §5):
#   - Checks 3,4: post-P2 gate (alias-layer not complete).
#   - Checks 5,7: post-P4 gate (copy flip not landed).
#   - Check 9: theme-parity promoted via design:theme-parity path.
#   - Check 11: utility-smell; warn-on-changed-files ceiling only.
EXIT_ON_FAIL=(1 2 6 8 10 12 13 14 15 16 17)

FAILED_CHECKS=()
PASS=0
WARN=0

# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

print_header() {
  echo ""
  echo "----------------------------------------"
  echo "  SOUP Design-Regression Check Suite"
  echo "  $(date '+%Y-%m-%d %H:%M:%S')"
  echo "----------------------------------------"
  echo ""
}

check_start() {
  local num="$1"
  local label="$2"
  echo "--- Check $num: $label"
}

check_result() {
  local num="$1"
  local count="$2"
  local expectation="$3"
  local status="$4"   # OK | WARN | FAIL

  local is_blocking=false
  for n in "${EXIT_ON_FAIL[@]:-}"; do
    if [ "$n" = "$num" ]; then is_blocking=true; break; fi
  done

  if [ "$status" = "OK" ]; then
    echo "    PASS  count=$count  ($expectation)"
    PASS=$((PASS + 1))
  elif [ "$status" = "WARN" ]; then
    echo "    WARN  count=$count  ($expectation)"
    WARN=$((WARN + 1))
    if [ "$is_blocking" = true ]; then
      FAILED_CHECKS+=("$num")
    fi
  else
    echo "    FAIL  count=$count  ($expectation)"
    WARN=$((WARN + 1))
    if [ "$is_blocking" = true ]; then
      FAILED_CHECKS+=("$num")
    fi
  fi
  echo ""
}

rg_count() {
  # Returns count of matching lines, 0 if none (rg exits 1 on no match)
  rg "$@" --count-matches 2>/dev/null | awk -F: '{sum+=$NF} END{print sum+0}'
}

# ---------------------------------------------------------------------------
print_header
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Check 1: Raw hex colors in TSX/TS
# Expectation: zero real hex colors (WVR-003/WVR-004 subjects gone; registry retirement pending)
#
# Pattern tightened to color contexts only:
#   - At least one hex letter [a-fA-F] in a 3-8 digit sequence (#f00, #3fb, #ABC123), OR
#   - Exactly 6 or 8 hex digits (full long-form: #000000, #00000080)
# This excludes pure-decimal identifiers (#4921, #512, #237) which are
# order/build/issue numbers, never CSS colors.
#
# Comment filter covers // inline and ' * ' block-comment continuation lines.
# rg -n directory output is 'path:line:content', so the filter anchors past
# the prefix — a bare '^\s*//' never matches rg output and silently passes
# commented-out hex through.
# ---------------------------------------------------------------------------
check_start "1" "Raw hex colors in TSX/TS"
C1_COUNT=$(rg -n '#(?:[0-9a-fA-F]{6,8}|[0-9a-fA-F]*[a-fA-F][0-9a-fA-F]*)\b' \
  "$CONSOLE_SRC" --type-add 'tsx:*.tsx' -t ts -t tsx 2>/dev/null \
  | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*)' \
  | wc -l | tr -d ' ')
echo "    Matches: $C1_COUNT (color-context pattern; comment lines excluded)"
echo "    Note: WVR-003/WVR-004 subjects eliminated from the tree; registry retirement is a later D6 commit"
if [ "$C1_COUNT" -eq 0 ]; then
  check_result "1" "$C1_COUNT" "zero raw hex colors" "OK"
else
  check_result "1" "$C1_COUNT" "raw hex colors found -- review for violations" "FAIL"
fi

# ---------------------------------------------------------------------------
# Check 2: Raw rgb()/hsl() in TSX + CSS semantic tier
# Expectation: zero after P1 (primitive tier files exempt)
# ---------------------------------------------------------------------------
check_start "2" "Raw rgb()/hsl() in TSX + CSS semantic tier"
C2_COUNT=$(rg_count 'rgba?\(|hsla?\(' \
  "$CONSOLE_SRC/components" \
  "$CONSOLE_SRC/pages" \
  "$CONSOLE_SRC/lib" 2>/dev/null)
echo "    Matches: $C2_COUNT"
echo "    Expectation: zero after P1 (primitive tier files exempt at shadow stage)"
if [ "$C2_COUNT" -eq 0 ]; then
  check_result "2" "$C2_COUNT" "zero -- clean" "OK"
else
  check_result "2" "$C2_COUNT" "zero after P1 -- shadow baseline" "WARN"
fi

# ---------------------------------------------------------------------------
# Check 3: Legacy token refs var(--color-d*/t*) and var(--b1..b4) (post-P2 gate)
# Expectation: zero at P2-complete. Shadow: just count baseline.
# ---------------------------------------------------------------------------
check_start "3" "Legacy token refs var(--color-d*/t*) and var(--b1..b4)"
C3_COUNT=$(rg_count 'var\(--color-[dt][0-9]\)|var\(--b[1-4]\)' "$CONSOLE_SRC")
echo "    Matches: $C3_COUNT"
echo "    Expectation: zero at P2-complete (shadow baseline -- non-blocking)"
check_result "3" "$C3_COUNT" "zero at P2-complete; current shadow baseline" "WARN"

# ---------------------------------------------------------------------------
# Check 4: Legacy utilities bg-d*/text-t* (post-P2 gate)
# ---------------------------------------------------------------------------
check_start "4" "Legacy utility classes bg-d*/text-t*"
C4_COUNT=$(rg_count '\b(bg-d[0-6]|text-t[1-5])\b' "$CONSOLE_SRC")
echo "    Matches: $C4_COUNT"
echo "    Expectation: zero at P2-complete (shadow baseline -- non-blocking)"
check_result "4" "$C4_COUNT" "zero at P2-complete; current shadow baseline" "WARN"

# ---------------------------------------------------------------------------
# Check 5: WhatSoup in UI copy (non-comment, non-contract lines)
# Contract allowlist: WhatSoupError, mcp__whatsoup__, whatsoup:, /run/whatsoup/,
#                    ~/.local/share/whatsoup/, whatsoup@, whatsoup/instances, ~/.config/whatsoup/
# ---------------------------------------------------------------------------
check_start "5" "WhatSoup in UI copy (non-contract lines)"
# Get all matches, then filter out: comment lines, contract-pattern lines, and test files.
# rg output format: path:linenum:content -- filter on the content part (after 2nd colon).
RAW_MATCHES=$(rg -n 'WhatSoup' "$CONSOLE_SRC" --glob '!**/*.test.*' 2>/dev/null || true)
# Filter: exclude lines whose CONTENT (3rd field) is a comment or contract identifier.
# Use awk to extract content after "path:N:" prefix, then apply filters.
FILTERED=$(echo "$RAW_MATCHES" | awk -F: 'NF>=3 {
  # Join fields 3+ (content may contain colons)
  content = $3; for(i=4;i<=NF;i++) content = content ":" $i;
  # Strip leading whitespace for comment check
  stripped = content; sub(/^[ \t]*/, "", stripped);
  # Skip comment lines
  if (stripped ~ /^\/\//) next;
  if (stripped ~ /^\/\*/) next;
  print $0
}' | grep -v 'WhatSoupError\|mcp__whatsoup__\|whatsoup:\|/run/whatsoup/\|whatsoup/instances\|whatsoup@\|config/whatsoup' | grep -v 'wizard/ConfigStep.tsx' || true)
# ConfigStep.tsx exemption: system-prompt template is bot-identity/protocol copy (EXEMPT-PROTECTED
# in branding-touchpoints.md) -- kept in lockstep with the soup/no-brand-regression ESLint exemption.
C5_COUNT=$(echo "$FILTERED" | grep -c 'WhatSoup' || echo 0)
echo "    Non-contract matches: $C5_COUNT"
if [ -n "$FILTERED" ] && [ "$C5_COUNT" -gt 0 ]; then
  echo "$FILTERED" | head -10 | sed 's/^/    /'
fi
echo "    Expectation: only EXEMPT-PROTECTED sites after P4 (shadow: baseline)"
echo "    Current known UI copy: UpdateModal.tsx (P4 flip), Nav.tsx (split wordmark)"
check_result "5" "$C5_COUNT" "only EXEMPT-PROTECTED after P4" "WARN"

# ---------------------------------------------------------------------------
# Check 6: Split-wordmark evasion (>What< adjacent to >Soup<)
# ---------------------------------------------------------------------------
check_start "6" "Split-wordmark evasion pattern"
C6_COUNT=$(rg -n -U '>What<.{0,80}>Soup<' "$CONSOLE_SRC" 2>/dev/null | wc -l | tr -d ' ')
echo "    Matches: $C6_COUNT"
echo "    Expectation: zero after P4"
echo "    Current: Nav.tsx:39-40 split wordmark (P4 flip)"
if [ "$C6_COUNT" -eq 0 ]; then
  # The split wordmark in Nav uses className spans so the > < pattern may not match
  check_result "6" "$C6_COUNT" "zero (or Nav spans don't match > < -- see soup/no-brand-regression)" "OK"
else
  check_result "6" "$C6_COUNT" "zero after P4" "WARN"
fi

# ---------------------------------------------------------------------------
# Check 7: Soup Kitchen label (should become "Fleet" at P4)
# ---------------------------------------------------------------------------
check_start "7" "Soup Kitchen label usage"
C7_COUNT=$(rg_count 'Soup Kitchen' "$CONSOLE_SRC" "$REPO_ROOT/docs/console-guide.md" 2>/dev/null)
echo "    Matches: $C7_COUNT"
echo "    Expectation: zero after P4 (vocabulary: Fleet)"
echo "    Current: SoupKitchen page name, Nav.tsx link text"
check_result "7" "$C7_COUNT" "zero after P4 (shadow baseline)" "WARN"

# ---------------------------------------------------------------------------
# Check 8: index.html title
# Asserts the title tag content equals the pinned value exactly.
# Emits FAIL on content drift or if the tag is missing.
# Re-pin the EXPECTED_TITLE constant in the C4 branding flip PR.
# ---------------------------------------------------------------------------
check_start "8" "index.html <title> content"
EXPECTED_TITLE="<title>WhatSoup Console</title>"
# Extract the full title tag from index.html; strip surrounding whitespace for comparison.
ACTUAL_TITLE_RAW=$(rg -o '<title>[^<]*</title>' "$CONSOLE_DIR/index.html" 2>/dev/null || true)
ACTUAL_TITLE=$(echo "$ACTUAL_TITLE_RAW" | tr -d ' \t')
EXPECTED_TITLE_STRIPPED=$(echo "$EXPECTED_TITLE" | tr -d ' \t')
echo "    Found:    $ACTUAL_TITLE_RAW"
echo "    Expected: $EXPECTED_TITLE"
if [ -z "$ACTUAL_TITLE" ]; then
  echo "    ERROR: <title> tag not found in index.html"
  check_result "8" "0" "title tag missing -- possible template deletion" "FAIL"
elif [ "$ACTUAL_TITLE" = "$EXPECTED_TITLE_STRIPPED" ]; then
  check_result "8" "1" "title matches pinned value" "OK"
else
  echo "    DRIFT: title does not match pinned value"
  check_result "8" "1" "title drift detected -- update copy or re-pin EXPECTED_TITLE" "FAIL"
fi

# ---------------------------------------------------------------------------
# Check 9: Theme parity (requires check-theme-parity.mjs)
# ---------------------------------------------------------------------------
check_start "9" "Theme parity (light/dark token symmetry)"
PARITY_SCRIPT="$CONSOLE_DIR/scripts/check-theme-parity.mjs"
if [ -f "$PARITY_SCRIPT" ]; then
  if node "$PARITY_SCRIPT" 2>&1; then
    check_result "9" "0" "both theme scopes define identical token name sets" "OK"
  else
    check_result "9" "?" "parity check failed -- see output above" "WARN"
  fi
else
  echo "    SKIP -- $PARITY_SCRIPT not yet created (P1 task)"
  echo "    Expectation: shadow until the light scope exists, then CI-blocking"
  check_result "9" "N/A" "script not yet created -- SKIP" "OK"
fi

# ---------------------------------------------------------------------------
# Check 10: Protected contracts still present
# ---------------------------------------------------------------------------
check_start "10" "Protected protocol contracts still present"
C10_FAIL=0
check_contract() {
  local pattern="$1"
  local file="$2"
  local desc="$3"
  local count
  count=$(rg -c "$pattern" "$REPO_ROOT/$file" 2>/dev/null || echo 0)
  if [ "$count" -ge 1 ]; then
    echo "    OK  ($count hits) $desc: $pattern"
  else
    echo "    FAIL  (0 hits) MISSING $desc: $pattern in $file"
    C10_FAIL=$((C10_FAIL + 1))
  fi
}
check_contract "whatsoup:" "console/src/lib/preferences.ts" "localStorage namespace"
check_contract "/run/whatsoup/" "console/src/mock-data.ts" "socket path"
check_contract "whatsoup/instances" "console/src/lib/agent-cwd.ts" "agent workspace path"
if [ "$C10_FAIL" -eq 0 ]; then
  check_result "10" "0" "all protected contracts present" "OK"
else
  check_result "10" "$C10_FAIL" "MISSING contracts -- possible over-eager rename" "FAIL"
fi

# ---------------------------------------------------------------------------
# Check 11: Undocumented variants / utility smell
# ---------------------------------------------------------------------------
check_start "11" "Utility smell: non-var() arbitrary values (w-[]/h-[]/rounded-[])"
# Using basic rg patterns (no --pcre2 required)
C11A_COUNT=$(rg_count '\b[wh]-\[[0-9]' "$CONSOLE_SRC")
C11B_COUNT=$(rg_count 'rounded-\[[0-9]' "$CONSOLE_SRC")
C11_COUNT=$((C11A_COUNT + C11B_COUNT))
echo "    w-[N]/h-[N] matches: $C11A_COUNT"
echo "    rounded-[N] matches: $C11B_COUNT"
echo "    Total: $C11_COUNT"
echo "    Expectation: only waivered"
check_result "11" "$C11_COUNT" "only waivered" "WARN"

# ---------------------------------------------------------------------------
# Check 12: Focus suppression (outline-none without focus-visible:)
# ---------------------------------------------------------------------------
check_start "12" "Focus suppression: outline-none without focus-visible:"
C12_ALL=$(rg -n 'outline-none' "$CONSOLE_SRC" 2>/dev/null || true)
C12_COUNT=$(printf '%s\n' "$C12_ALL" | grep -v 'focus-visible:' | grep -c 'outline-none' || true)
C12_COUNT=${C12_COUNT:-0}
echo "    outline-none without focus-visible: count: $C12_COUNT"
if [ "$C12_COUNT" -gt 0 ]; then
  printf '%s\n' "$C12_ALL" | grep -v 'focus-visible:' | head -5 | sed 's/^/    /'
fi
echo "    Expectation: zero after P2"
echo "    Current: zero TSX outline-none sites; Inbox and HistoryTab composer carve-outs retired"
if [ "$C12_COUNT" -eq 0 ]; then
  check_result "12" "$C12_COUNT" "zero focus suppression sites" "OK"
else
  check_result "12" "$C12_COUNT" "zero focus suppression sites" "WARN"
fi

# ---------------------------------------------------------------------------
# Check 13: Infinite animation allowlist
# CSS-side: checks composites.css and tokens.*.css for 'infinite'
# Allowed: breathe-ring (ok-breathing), breathe, typing-bounce, shimmer (waivered)
# ---------------------------------------------------------------------------
check_start "13" "Infinite animation allowlist"
CSS_FILES=$(find "$CONSOLE_SRC/styles" "$CONSOLE_SRC" -maxdepth 1 -name "*.css" 2>/dev/null)
C13_ALL=$(rg -n 'infinite' $CSS_FILES 2>/dev/null || true)
C13_COUNT=$(echo "$C13_ALL" | grep -c 'infinite' || echo 0)
echo "    'infinite' occurrences in CSS: $C13_COUNT"
if [ -n "$C13_ALL" ]; then
  echo "$C13_ALL" | sed 's|'"$CONSOLE_SRC/"'||' | sed 's/^/    /'
fi
echo "    Sanctioned: breathe-ring x2 (ok-disc halo in composites+primitives), breathe, typing-bounce"
echo "    Waivered until P5: shimmer (WVR-005), typing-bounce (WVR-006)"
echo "    Unsanctioned: any new 'infinite' not in the above list"
# Unsanctioned count = total minus the 5 known occurrences
# (+1 at C2: primitives.css uses breathe-ring for the ok-disc halo, same sanctioned animation)
C13_UNSANCTIONED=$((C13_COUNT - 5))
if [ "$C13_UNSANCTIONED" -le 0 ]; then
  check_result "13" "$C13_COUNT" "all $C13_COUNT occurrences are waivered/sanctioned" "OK"
else
  check_result "13" "$C13_COUNT" "$C13_UNSANCTIONED unsanctioned infinite animations" "FAIL"
fi

# ---------------------------------------------------------------------------
# Check 14: Expired waivers
# ---------------------------------------------------------------------------
check_start "14" "Expired waivers in eslint-waivers.yaml"
WAIVERS_FILE="$CONSOLE_DIR/eslint-waivers.yaml"
TODAY=$(date '+%Y-%m-%d')
if [ ! -f "$WAIVERS_FILE" ]; then
  echo "    SKIP -- eslint-waivers.yaml not found"
  check_result "14" "N/A" "waivers file missing" "OK"
else
  C14_COUNT=0
  while IFS= read -r line; do
    if echo "$line" | grep -q 'expiry:'; then
      EXPIRY=$(echo "$line" | sed 's/.*expiry:\s*//' | tr -d ' "')
      if [ "$EXPIRY" \< "$TODAY" ] || [ "$EXPIRY" = "$TODAY" ]; then
        echo "    EXPIRED: expiry=$EXPIRY (today=$TODAY)"
        C14_COUNT=$((C14_COUNT + 1))
      fi
    fi
  done < "$WAIVERS_FILE"
  if [ "$C14_COUNT" -eq 0 ]; then
    check_result "14" "0" "no expired waivers" "OK"
  else
    check_result "14" "$C14_COUNT" "EXPIRED waivers must be resolved or renewed" "FAIL"
  fi
fi

# ---------------------------------------------------------------------------
# Check 15: Lint-suppression directives without waiver: tag
# ---------------------------------------------------------------------------
check_start "15" "Suppression directives without waiver: tag"
# Look for lint-suppression directives in TS/TSX files, filtering those that have waiver:
DISABLE_PATTERN='eslint-''disable'  # split to avoid self-matching the hygiene guard
ALL_DISABLES=$(rg -n "$DISABLE_PATTERN" "$CONSOLE_SRC" -g '*.ts' -g '*.tsx' 2>/dev/null || true)
UNTAGGED=$(echo "$ALL_DISABLES" | grep -v 'waiver:' || true)
C15_COUNT=$(printf '%s' "$UNTAGGED" | grep -c "$DISABLE_PATTERN" || true)
C15_COUNT=${C15_COUNT:-0}
echo "    Untagged disable directives: $C15_COUNT"
if [ -n "$UNTAGGED" ] && [ "$C15_COUNT" -gt 0 ]; then
  echo "$UNTAGGED" | head -5 | sed 's/^/    /'
fi
echo "    Expectation: zero (all suppressions must carry waiver:<id>)"
if [ "$C15_COUNT" -eq 0 ]; then
  check_result "15" "0" "all suppressions carry waiver: tag" "OK"
else
  check_result "15" "$C15_COUNT" "untagged suppressions -- add waiver:<id> (shadow: non-blocking)" "WARN"
fi

# ---------------------------------------------------------------------------
# Check 16: Legacy fixed table/log lane vars (removed in C2.3)
# ---------------------------------------------------------------------------
check_start "16" "Legacy --sk-col-* / --log-col-* lane vars"
C16_HITS=$(rg -n -- "--sk-col-|--log-col-" "$CONSOLE_SRC" 2>/dev/null || true)
C16_COUNT=$(printf '%s' "$C16_HITS" | grep -c -- "-col-" || true)
C16_COUNT=${C16_COUNT:-0}
echo "    Legacy lane var references: $C16_COUNT"
if [ -n "$C16_HITS" ] && [ "$C16_COUNT" -gt 0 ]; then
  echo "$C16_HITS" | head -5 | sed 's/^/    /'
fi
echo "    Expectation: zero (Table squeeze + LogStream lane tokens own geometry)"
if [ "$C16_COUNT" -eq 0 ]; then
  check_result "16" "0" "no legacy lane vars" "OK"
else
  check_result "16" "$C16_COUNT" "legacy lane vars reintroduced" "FAIL"
fi

# ---------------------------------------------------------------------------
# CSS tier-boundary checks (17-20)
#
# Derived from tokens-v3 §1 "three layers with must-not-own boundaries":
#   Primitive owns raw values; semantic/component tiers must only var()-reference.
#   Semantic owns per-theme role assignments; component tier must not own reused values.
#   Component tier values are scoped to the owning component only.
#
# ALL four checks are REPORT-ONLY (not in EXIT_ON_FAIL) per lint-plan §2 lifecycle.
# Promote only after baseline count is zero or fully waivered.
#
# CSS-tier file groups used by checks 17-20:
CSS_TIER_COMPONENT_FILES="$CONSOLE_SRC/styles/tokens.component.css $CONSOLE_SRC/styles/primitives.css $CONSOLE_SRC/styles/composites.css"
CSS_TIER_PRIMITIVE_FILE="$CONSOLE_SRC/styles/tokens.primitive.css"
CSS_TIER_SEMANTIC_FILE="$CONSOLE_SRC/styles/tokens.semantic.css"
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Check 17: Raw color values in component/primitives/composites CSS
#
# Spec: tokens-v3 §1 — "Component: must NOT own … raw values duplicating a
# primitive." The component tier must only var()-reference colors defined in the
# primitive or semantic tiers. Raw hex, rgb(), hsl(), oklch() in these files is a
# boundary violation. tokens.primitive.css and tokens.semantic.css are the ONLY
# files permitted to contain raw color literals (primitive = value assignments;
# semantic = per-theme value assignments per §3).
#
# Fixture proof — FIRES on violation:
#   printf '.c { box-shadow: 0 4px rgba(0,0,0,0.3); }\n' > /tmp/f17v.css
#   rg 'rgba?\(' /tmp/f17v.css                           # exits 0, 1 hit
# Fixture proof — SILENT on compliant:
#   printf '.c { box-shadow: var(--shadow-overlay); }\n' > /tmp/f17c.css
#   rg 'rgba?\(' /tmp/f17c.css                           # exits 1, 0 hits
#
# Live-tree violations: 0 after .c-kpi-hover moved to --shadow-hover.
# Burndown: raw-color-css ceiling is 0; any future component-tier raw color must
# move to a semantic token in the same packet.
# ---------------------------------------------------------------------------
check_start "17" "CSS tier-boundary: raw color values in component/primitives/composites CSS"
C17_RGB_HITS=""
# shellcheck disable=SC2086
C17_RGB_HITS=$(rg -n 'rgba?\(|hsla?\(|oklch\(' $CSS_TIER_COMPONENT_FILES 2>/dev/null \
  | grep -v '/\*' || true)
C17_HEX_HITS=""
# shellcheck disable=SC2086
C17_HEX_HITS=$(rg -n '#(?:[0-9a-fA-F]{6,8}|[0-9a-fA-F]*[a-fA-F][0-9a-fA-F]*)' \
  $CSS_TIER_COMPONENT_FILES 2>/dev/null \
  | grep -v '/\*' || true)
C17_RGB_COUNT=0
C17_HEX_COUNT=0
if [ -n "$C17_RGB_HITS" ]; then
  C17_RGB_COUNT=$(printf '%s\n' "$C17_RGB_HITS" | grep -c '.' || true)
fi
if [ -n "$C17_HEX_HITS" ]; then
  C17_HEX_COUNT=$(printf '%s\n' "$C17_HEX_HITS" | grep -c '.' || true)
fi
C17_TOTAL=$((C17_RGB_COUNT + C17_HEX_COUNT))
echo "    rgb/rgba/hsl/oklch hits in component-tier CSS: $C17_RGB_COUNT"
echo "    hex hits in component-tier CSS: $C17_HEX_COUNT"
if [ "$C17_RGB_COUNT" -gt 0 ]; then
  printf '%s\n' "$C17_RGB_HITS" | head -5 | sed "s|$CONSOLE_SRC/||" | sed 's/^/    /'
fi
if [ "$C17_HEX_COUNT" -gt 0 ]; then
  printf '%s\n' "$C17_HEX_HITS" | head -5 | sed "s|$CONSOLE_SRC/||" | sed 's/^/    /'
fi
echo "    Spec: tokens-v3 §1 (component tier must not own raw color values)"
echo "    Lifecycle: BLOCKING — raw-color-css is zeroed and token-tier ownership is pinned"
if [ "$C17_TOTAL" -eq 0 ]; then
  check_result "17" "$C17_TOTAL" "zero raw colors in component-tier CSS" "OK"
else
  check_result "17" "$C17_TOTAL" "raw component-tier CSS colors found -- move to semantic tokens" "FAIL"
fi

# ---------------------------------------------------------------------------
# Check 18: Legacy alias names defined inside tokens.primitive.css
#
# Spec: tokens-v3 §7 — "Aliases live in a clearly marked tokens-legacy-aliases.css
# block." The authoritative home for §7 migration aliases (--color-d*, --color-t*,
# --b1..4, --color-m-*, --color-s-*, --ease, --dur-norm) is tokens.semantic.css
# (the alias block at lines 224-301). Defining these same names ALSO in
# tokens.primitive.css's @theme inline block creates a dual-authority SSOT violation
# and cascade ordering fragility.
#
# Fixture proof — FIRES:
#   printf '@theme inline { --color-d0: var(--surface-base); }\n' > /tmp/f18v.css
#   rg '^\s*--color-d[0-6]\s*:' /tmp/f18v.css             # exits 0, 1 hit
# Fixture proof — SILENT (the semantic file IS the authority; check is scoped to
#   primitive file only, so tokens.semantic.css passing this pattern is CORRECT):
#   The same pattern on tokens.semantic.css fires but this check only reads the
#   primitive file.
#
# Live-tree violations (21 in tokens.primitive.css):
#   --color-d0..d6 (7), --color-t1..t5 (5), --color-m-{pas,cht,agt} (3),
#   --color-s-{ok,warn,crit} (3), --ease (1), --dur-norm (1), --color-s-ok (1
#   — already counted above), plus mode aliases: 21 total definitions found.
# Burndown: remove duplicate aliases from tokens.primitive.css @theme inline block
#           at C2 alias consolidation; tokens.semantic.css is the sole SSOT.
# ---------------------------------------------------------------------------
check_start "18" "CSS tier-boundary: legacy alias names defined in tokens.primitive.css"
C18_HITS=""
C18_HITS=$(rg -n '^\s*--(color-d[0-6]|color-t[1-5]|color-m-[a-z]+|color-s-[a-z]+|b[1-4]|ease|dur-norm)\s*:' \
  "$CSS_TIER_PRIMITIVE_FILE" 2>/dev/null || true)
C18_COUNT=0
if [ -n "$C18_HITS" ]; then
  C18_COUNT=$(printf '%s\n' "$C18_HITS" | grep -c '.' || true)
fi
echo "    Legacy alias names defined in tokens.primitive.css: $C18_COUNT"
if [ -n "$C18_HITS" ] && [ "$C18_COUNT" -gt 0 ]; then
  printf '%s\n' "$C18_HITS" | head -12 | sed "s|$CSS_TIER_PRIMITIVE_FILE:|tokens.primitive.css:|" | sed 's/^/    /'
  echo "    BURNDOWN: remove duplicate aliases from tokens.primitive.css @theme inline block"
  echo "    Authority: tokens.semantic.css §7 alias block (lines 224-301)"
fi
echo "    Spec: tokens-v3 §7 (alias block authority is semantic tier, not primitive)"
echo "    Lifecycle: REPORT-ONLY (shadow); promote at C2 alias consolidation"
check_result "18" "$C18_COUNT" "zero legacy aliases in primitive tier (report-only baseline)" "WARN"

# ---------------------------------------------------------------------------
# Check 19: Dangling var() references without fallback in component-tier CSS
#
# Spec: tokens-v3 §1 (highest-value check) — a var(--X) that has no definition
# and no fallback resolves to empty string at runtime = silent visual breakage.
# This check parses var(--X) refs that have no comma (no fallback) in the
# component/primitives/composites CSS files and reports any --X absent from the
# combined definition set of all CSS tier files.
#
# Per-theme dual definitions (dark + light) within the SAME file are legitimate;
# the definition scan uses sort -u so each name is counted once.
# Fallback form var(--X, fallback) is intentional (runtime override) and excluded:
# only var(--X) with no comma inside is checked.
#
# Fixture proof — FIRES:
#   printf '.c { color: var(--z-nonexistent); }\n' > /tmp/f19v.css
#   The token --z-nonexistent is absent from the definition set; appears in dangling list.
# Fixture proof — SILENT:
#   printf '.c { color: var(--z-nonexistent, red); }\n' > /tmp/f19c.css
#   Fallback form excluded from no-fallback ref set; not reported.
#
# Live-tree dangling no-fallback refs (5):
#   --r-1, --r-2        not yet defined in any CSS file (§2.3 radii tokens missing
#                       from tokens.primitive.css — P0 CSS split incomplete)
#   --type-label        not yet defined (§2.6 type ramp tokens not added to CSS yet)
#   --type-body-st      not yet defined (§2.6 type ramp tokens not added to CSS yet)
#   --wizard-accent     runtime inline custom property set from AddLineWizard.tsx:265
#                       via style={{ '--wizard-accent': ... }} — never a CSS definition.
#                       WVR-014 (filed): runtime-injected; TSX sets it before CSS consumes it.
# Burndown: add --r-1 (4px), --r-2 (6px) to tokens.primitive.css §2.3 radii block;
#           add --type-label, --type-body-st to tokens.primitive.css §2.6 type ramp block.
#           --wizard-accent documented as WVR-014 in eslint-waivers.yaml (filed 2026-06-12).
# ---------------------------------------------------------------------------
check_start "19" "CSS tier-boundary: dangling var() refs without fallback in component-tier CSS"

# Step 1: Build definition set (LHS names only) from ALL CSS tier files combined.
# Use --no-filename + sed to strip values after the first colon, ensuring only the
# property name on the left side of each definition is captured (not token names
# inside var() values on the right side).
# shellcheck disable=SC2086
C19_DEFINED=$(rg --no-filename '^\s*--[a-zA-Z0-9_-]+\s*:' \
  "$CSS_TIER_PRIMITIVE_FILE" "$CSS_TIER_SEMANTIC_FILE" \
  $CSS_TIER_COMPONENT_FILES 2>/dev/null \
  | sed 's/:.*//' | sed 's/^[[:space:]]*//' | sort -u || true)

# Step 2: Extract var(--name) refs WITHOUT fallback from component-tier files.
# Pattern: var( then --name then ) — the closing ) immediately follows the name
# with no comma inside, meaning no fallback value is present.
C19_NO_FALLBACK_REFS=""
# shellcheck disable=SC2086
C19_NO_FALLBACK_REFS=$(rg -o 'var\(--[a-zA-Z0-9_-]+\)' \
  $CSS_TIER_COMPONENT_FILES 2>/dev/null \
  | grep -oE -- '--[a-zA-Z0-9_-]+' | sort -u || true)

# Step 3: Set difference — no-fallback refs not present in the definition set
C19_DANGLING=""
if [ -n "$C19_NO_FALLBACK_REFS" ] && [ -n "$C19_DEFINED" ]; then
  C19_DANGLING=$(comm -23 \
    <(printf '%s\n' "$C19_NO_FALLBACK_REFS") \
    <(printf '%s\n' "$C19_DEFINED") 2>/dev/null || true)
fi

C19_COUNT=0
if [ -n "$C19_DANGLING" ]; then
  C19_COUNT=$(printf '%s\n' "$C19_DANGLING" | grep -c '.' || true)
fi
echo "    Dangling var() refs (no fallback, no CSS definition): $C19_COUNT"
if [ -n "$C19_DANGLING" ] && [ "$C19_COUNT" -gt 0 ]; then
  printf '%s\n' "$C19_DANGLING" | sed 's/^/    /'
  echo ""
  echo "    BURNDOWN:"
  echo "      --r-1: add to tokens.primitive.css §2.3 (--r-1: 4px)"
  echo "      --r-2: add to tokens.primitive.css §2.3 (--r-2: 6px)"
  echo "      --type-label: add to tokens.primitive.css §2.6 (500 12px/16px var(--font-sans))"
  echo "      --type-body-st: add to tokens.primitive.css §2.6 (500 14px/20px var(--font-sans))"
  echo "      --wizard-accent: WAIVER-RUNTIME-VAR (AddLineWizard.tsx:265 inline style prop)"
fi
echo "    Spec: tokens-v3 §1 (highest-value: undefined tokens = silent visual breakage)"
echo "    Lifecycle: REPORT-ONLY (shadow); promote after P0 type+radius token definitions land"
if [ "$C19_COUNT" -eq 0 ]; then
  check_result "19" "0" "no dangling var() refs without fallback" "OK"
else
  check_result "19" "$C19_COUNT" "dangling var() refs found -- see burndown above" "WARN"
fi

# ---------------------------------------------------------------------------
# Check 20: Cross-tier duplicate custom property definitions (SSOT violation)
#
# Spec: tokens-v3 §1 — each tier owns its names exclusively. A --name defined in
# BOTH tokens.primitive.css AND tokens.semantic.css violates SSOT: the CSS cascade
# ordering between @import statements determines which definition wins, making the
# effective value fragile to import reordering.
#
# Per-theme dual definitions (dark + light) within the SAME file are legitimate
# and are excluded: this check diffs name sets across FILE BOUNDARIES only.
#
# Fixture proof — FIRES:
#   Define --surface-base in both a primitive-file and semantic-file fixture; extract
#   each file's name set; comm -12 returns the duplicate → count > 0.
# Fixture proof — SILENT:
#   Define --surface-base only in the semantic fixture; comm -12 returns empty.
#
# Live-tree cross-tier duplicates (20 total):
#   --color-d0..d6 (7), --color-t1..t5 (5), --color-m-{pas,cht,agt} (3),
#   --color-s-{ok,warn,crit} (3), --ease (1), --dur-norm (1)
#   Root cause: tokens.primitive.css @theme inline block re-defines the §7 migration
#   aliases already owned by tokens.semantic.css §7 alias block (lines 224-301).
# Burndown: remove the duplicate definitions from tokens.primitive.css @theme inline
#           block and :root block at C2 consolidation; authority = tokens.semantic.css.
# ---------------------------------------------------------------------------
check_start "20" "CSS tier-boundary: cross-tier duplicate custom property definitions (SSOT)"

C20_PRIM_NAMES=""
# Use sed to extract LHS property names only (strip value after first colon).
# This prevents token names inside var() references from appearing as false duplicates.
C20_PRIM_NAMES=$(rg --no-filename '^\s*--[a-zA-Z0-9_-]+\s*:' \
  "$CSS_TIER_PRIMITIVE_FILE" 2>/dev/null \
  | sed 's/:.*//' | sed 's/^[[:space:]]*//' | sort -u || true)

C20_SEM_NAMES=""
C20_SEM_NAMES=$(rg --no-filename '^\s*--[a-zA-Z0-9_-]+\s*:' \
  "$CSS_TIER_SEMANTIC_FILE" 2>/dev/null \
  | sed 's/:.*//' | sed 's/^[[:space:]]*//' | sort -u || true)

C20_DUPES=""
if [ -n "$C20_PRIM_NAMES" ] && [ -n "$C20_SEM_NAMES" ]; then
  C20_DUPES=$(comm -12 \
    <(printf '%s\n' "$C20_PRIM_NAMES") \
    <(printf '%s\n' "$C20_SEM_NAMES") 2>/dev/null || true)
fi

C20_COUNT=0
if [ -n "$C20_DUPES" ]; then
  C20_COUNT=$(printf '%s\n' "$C20_DUPES" | grep -c '.' || true)
fi
echo "    Custom properties in BOTH tokens.primitive.css AND tokens.semantic.css: $C20_COUNT"
if [ -n "$C20_DUPES" ] && [ "$C20_COUNT" -gt 0 ]; then
  printf '%s\n' "$C20_DUPES" | sed 's/^/    /'
  echo ""
  echo "    Root cause: tokens.primitive.css @theme inline block re-defines §7 migration"
  echo "    aliases already owned by tokens.semantic.css (lines 224-301)."
  echo "    BURNDOWN: remove duplicate definitions from tokens.primitive.css at C2 consolidation"
fi
echo "    Spec: tokens-v3 §1 (each tier owns its names; §7 aliases belong in semantic tier)"
echo "    Lifecycle: REPORT-ONLY (shadow); promote at C2 alias consolidation gate"
check_result "20" "$C20_COUNT" "zero cross-tier duplicates (report-only baseline)" "WARN"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo "----------------------------------------"
echo "  SUMMARY"
echo "----------------------------------------"
echo "  Checks passed:  $PASS"
echo "  Checks warned:  $WARN"
echo ""

if [ "${#FAILED_CHECKS[@]}" -gt 0 ] 2>/dev/null; then
  echo "  BLOCKING checks failed: ${FAILED_CHECKS[*]}"
  echo "  (Fix before pushing.)"
  exit 1
else
  echo "  Blocking checks: ${EXIT_ON_FAIL[*]} (all PASS)"
  exit 0
fi
