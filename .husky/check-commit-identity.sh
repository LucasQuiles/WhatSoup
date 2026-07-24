#!/usr/bin/env bash
#
# check-commit-identity.sh — fail-closed allowlist for the PENDING commit's
# author and committer identity (WhatSoup repo-local enforcement).
#
# WHY THIS EXISTS IN THE REPO (not just the machine-global hook): WhatSoup sets
# core.hooksPath=.husky, which REPLACES the user's global git hooks. So the
# machine-wide identity gate in ~/.config/git/hooks does NOT run here. This
# self-contained, committed copy guarantees the mandate travels with the repo to
# every clone and fleet host, none of which have the global hook.
#
# At commit time git has already resolved author/committer from
# GIT_AUTHOR_*/GIT_COMMITTER_* env or user.{name,email} config, so
# `git var GIT_AUTHOR_IDENT` is exactly what will be written. Any identity not on
# the allowlist is rejected BEFORE the commit object exists.
#
# Background: three 2026-06 coverage commits landed authored `whatsoup-bot
# <bot@users.noreply.github.com>` — an ad-hoc identity that read like an unknown
# contributor. The pre-existing commit-author guard was a denylist scanned in CI
# (after the fact); this is a strict allowlist enforced at creation.
#
# Bypass (discouraged, audited by absence): git commit --no-verify
#
set -euo pipefail

# ── POLICY ──────────────────────────────────────────────────────────────────
# Humans: matched by EMAIL (any display name passes — commits land under both
# "Lucas Quiles" and "LucasQuiles"). This is a PUBLIC repo, so only privacy-safe
# GitHub noreply addresses are allowed here — personal addresses (gmail/proton/
# etc.) are deliberately NOT accepted as a committer identity on WhatSoup and are
# rejected by the repo publication guard anyway. Set this repo's user.email to a
# noreply address (the repo-local config already does).
APPROVED_HUMAN_EMAILS=(
  "180208450+LucasQuiles@users.noreply.github.com"   # canonical GitHub noreply (primary)
  "LucasQuiles@users.noreply.github.com"             # legacy GitHub noreply
  "lhquiles@users.noreply.github.com"                # legacy GitHub noreply
)
# Sanctioned automation: matched on the EXACT "Name <email>" identity, so each
# address is only valid paired with its approved display name. The retired
# `whatsoup-bot <bot@users.noreply.github.com>` identity matches nothing here and
# is rejected.
APPROVED_BOT_IDENTS=(
  "SoupBot <soupbot@users.noreply.github.com>"
  "SoupBot QPI 1 <308864230+qpi-lab@users.noreply.github.com>"
  "SoupBot QPI 2 <308865677+qpi-lab2@users.noreply.github.com>"
  "dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>"
)
# ────────────────────────────────────────────────────────────────────────────

_strip_time() { printf '%s' "$1" | sed -E 's/ [0-9]+ [-+][0-9]{4}$//'; }
_email_of()   { printf '%s' "$1" | sed -E 's/^.*<([^>]*)>$/\1/'; }

_is_allowed() {
  local ident="$1" email e
  email="$(_email_of "$ident")"
  for e in "${APPROVED_HUMAN_EMAILS[@]}"; do
    [ "$email" = "$e" ] && return 0
  done
  for e in "${APPROVED_BOT_IDENTS[@]}"; do
    [ "$ident" = "$e" ] && return 0
  done
  return 1
}

author_ident="$(_strip_time "$(git var GIT_AUTHOR_IDENT 2>/dev/null || true)")"
committer_ident="$(_strip_time "$(git var GIT_COMMITTER_IDENT 2>/dev/null || true)")"

fail=0
for pair in "author|$author_ident" "committer|$committer_ident"; do
  role="${pair%%|*}"
  ident="${pair#*|}"
  [ -z "$ident" ] && continue
  if ! _is_allowed "$ident"; then
    if [ "$fail" -eq 0 ]; then echo "" >&2; fi
    echo "✖ commit BLOCKED — $role identity is not approved:" >&2
    echo "    $ident" >&2
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "  Mandate: commit author AND committer must be an approved identity." >&2
  echo "  • Human:      set an approved git user.email (see policy block)." >&2
  echo "  • Automation: use an exact identity from APPROVED_BOT_IDENTS." >&2
  echo "  Edit policy:  .husky/check-commit-identity.sh" >&2
  echo "  Bypass (discouraged, audited): git commit --no-verify" >&2
  echo "" >&2
  exit 1
fi
exit 0
