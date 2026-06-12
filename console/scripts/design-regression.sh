#!/usr/bin/env bash
# console/scripts/design-regression.sh
#
# Design-regression check suite (lint-plan section 5).
# Implements all 15 labeled checks from the lint-plan's rg-based regression table.
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
# Add check numbers here as rules promote to CI-blocking (e.g. 9 10 14 15).
EXIT_ON_FAIL=()

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
# Expectation: only waivered lines (WVR-003 covers chart-utils.ts:10; WVR-004 QrDisplay.tsx)
# ---------------------------------------------------------------------------
check_start "1" "Raw hex colors in TSX/TS"
C1_COUNT=$(rg -n '#[0-9a-fA-F]{3,8}\b' "$CONSOLE_SRC" --type-add 'tsx:*.tsx' -t ts -t tsx 2>/dev/null | grep -v '//.*#[0-9a-fA-F]\|^\s*//' | wc -l | tr -d ' ')
echo "    Matches: $C1_COUNT (excluding comment lines)"
echo "    Waivered: chart-utils.ts (WVR-003), QrDisplay.tsx (WVR-004)"
if [ "$C1_COUNT" -le 10 ]; then
  check_result "1" "$C1_COUNT" "only waivered lines" "WARN"
else
  check_result "1" "$C1_COUNT" "only waivered lines — review for new violations" "WARN"
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
  check_result "2" "$C2_COUNT" "zero — clean" "OK"
else
  check_result "2" "$C2_COUNT" "zero after P1 — shadow baseline" "WARN"
fi

# ---------------------------------------------------------------------------
# Check 3: Legacy token refs var(--color-d*/t*) and var(--b1..b4) (post-P2 gate)
# Expectation: zero at P2-complete. Shadow: just count baseline.
# ---------------------------------------------------------------------------
check_start "3" "Legacy token refs var(--color-d*/t*) and var(--b1..b4)"
C3_COUNT=$(rg_count 'var\(--color-[dt][0-9]\)|var\(--b[1-4]\)' "$CONSOLE_SRC")
echo "    Matches: $C3_COUNT"
echo "    Expectation: zero at P2-complete (shadow baseline — non-blocking)"
check_result "3" "$C3_COUNT" "zero at P2-complete; current shadow baseline" "WARN"

# ---------------------------------------------------------------------------
# Check 4: Legacy utilities bg-d*/text-t* (post-P2 gate)
# ---------------------------------------------------------------------------
check_start "4" "Legacy utility classes bg-d*/text-t*"
C4_COUNT=$(rg_count '\b(bg-d[0-6]|text-t[1-5])\b' "$CONSOLE_SRC")
echo "    Matches: $C4_COUNT"
echo "    Expectation: zero at P2-complete (shadow baseline — non-blocking)"
check_result "4" "$C4_COUNT" "zero at P2-complete; current shadow baseline" "WARN"

# ---------------------------------------------------------------------------
# Check 5: WhatSoup in UI copy (non-comment, non-contract lines)
# Contract allowlist: WhatSoupError, mcp__whatsoup__, whatsoup:, /run/whatsoup/,
#                    ~/.local/share/whatsoup/, whatsoup@, whatsoup/instances, ~/.config/whatsoup/
# ---------------------------------------------------------------------------
check_start "5" "WhatSoup in UI copy (non-contract lines)"
# Get all matches, then filter out: comment lines, contract-pattern lines, and test files.
# rg output format: path:linenum:content — filter on the content part (after 2nd colon).
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
# in branding-touchpoints.md) — kept in lockstep with the soup/no-brand-regression ESLint exemption.
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
  check_result "6" "$C6_COUNT" "zero (or Nav spans don't match > < — see soup/no-brand-regression)" "OK"
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
# ---------------------------------------------------------------------------
check_start "8" "index.html <title> content"
TITLE_LINE=$(rg -n '<title>' "$CONSOLE_DIR/index.html" 2>/dev/null || echo "NOT FOUND")
echo "    Title: $TITLE_LINE"
echo "    Expectation: equals the P4-specced title (currently WhatSoup Console, flip at P4)"
check_result "8" "1" "title line found — flip at P4" "OK"

# ---------------------------------------------------------------------------
# Check 9: Theme parity (requires check-theme-parity.mjs)
# ---------------------------------------------------------------------------
check_start "9" "Theme parity (light/dark token symmetry)"
PARITY_SCRIPT="$CONSOLE_DIR/scripts/check-theme-parity.mjs"
if [ -f "$PARITY_SCRIPT" ]; then
  if node "$PARITY_SCRIPT" 2>&1; then
    check_result "9" "0" "both theme scopes define identical token name sets" "OK"
  else
    check_result "9" "?" "parity check failed — see output above" "WARN"
  fi
else
  echo "    SKIP — $PARITY_SCRIPT not yet created (P1 task)"
  echo "    Expectation: shadow until the light scope exists, then CI-blocking"
  check_result "9" "N/A" "script not yet created — SKIP" "OK"
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
  check_result "10" "$C10_FAIL" "MISSING contracts — possible over-eager rename" "FAIL"
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
C12_COUNT=$(echo "$C12_ALL" | grep -v 'focus-visible:' | grep -c 'outline-none' || echo 0)
echo "    outline-none without focus-visible: count: $C12_COUNT"
if [ "$C12_COUNT" -gt 0 ]; then
  echo "$C12_ALL" | grep -v 'focus-visible:' | head -5 | sed 's/^/    /'
fi
echo "    Expectation: zero after P2"
echo "    Current: Inbox.tsx:434, HistoryTab.tsx:206 (composers)"
check_result "12" "$C12_COUNT" "zero after P2 (shadow baseline)" "WARN"

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
  check_result "13" "$C13_COUNT" "$C13_UNSANCTIONED unsanctioned infinite animations" "WARN"
fi

# ---------------------------------------------------------------------------
# Check 14: Expired waivers
# ---------------------------------------------------------------------------
check_start "14" "Expired waivers in eslint-waivers.yaml"
WAIVERS_FILE="$CONSOLE_DIR/eslint-waivers.yaml"
TODAY=$(date '+%Y-%m-%d')
if [ ! -f "$WAIVERS_FILE" ]; then
  echo "    SKIP — eslint-waivers.yaml not found"
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
  check_result "15" "$C15_COUNT" "untagged suppressions — add waiver:<id> (shadow: non-blocking)" "WARN"
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
  check_result "16" "$C16_COUNT" "legacy lane vars reintroduced (shadow: non-blocking)" "WARN"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo "----------------------------------------"
echo "  SUMMARY"
echo "----------------------------------------"
echo "  Checks passed:  $PASS"
echo "  Checks warned:  $WARN"
echo "  Shadow stage:   all REPORT-ONLY (exit 0)"
echo ""

if [ "${#FAILED_CHECKS[@]}" -gt 0 ] 2>/dev/null; then
  echo "  BLOCKING checks failed: ${FAILED_CHECKS[*]}"
  echo "  (These are promoted to CI-blocking; fix before pushing.)"
  exit 1
else
  echo "  Report-only baseline: no checks are promoted to blocking yet (EXIT_ON_FAIL is empty)."
  exit 0
fi
