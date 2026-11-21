#!/usr/bin/env bash
set -euo pipefail

# WhatSoup Setup Script
# Checks requirements, installs wrapper scripts, systemd unit, and builds the console.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$HOME/.local/bin"
SYSTEMD_DIR="$HOME/.config/systemd/user"
PLATFORM="$(uname -s)"
MACHINE="$(uname -m)"

# Credential-store probes must be bounded on BOTH platforms; `timeout(1)` is not
# present on stock macOS (see deploy/lib/bounded-exec.sh).
# shellcheck source=deploy/lib/bounded-exec.sh
. "$REPO_ROOT/deploy/lib/bounded-exec.sh"

# --- arch-aware binary suffix ---
# Prebuilt binary distributions (e.g. Homebrew, self-hosted CI artifacts)
# sometimes publish an arch-suffixed name (`ffmpeg-arm64`) alongside the bare
# one. Kept consistent with src/lib/arch.ts's getArchBinSuffix() aliasing
# (aarch64 -> arm64, x86_64 -> x64) so the shell-side and TypeScript-side
# binary resolvers never disagree about which suffixed name a host resolves
# to (src/runtimes/chat/providers/transcription/local-audio.ts:resolveBinaryPath
# applies the same fallback for the TS-side ffmpeg/ffprobe lookup). `amd64` is
# included defensively — it is a FreeBSD `uname -m` value; Linux and macOS
# always report `x86_64` and never reach it.
arch_bin_suffix() {
  case "$MACHINE" in
    arm64|aarch64) printf '%s' '-arm64' ;;
    x64|x86_64|amd64) printf '%s' '-x64' ;;
    *) printf '' ;;
  esac
}

LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
LAUNCHD_TIMER_LABELS=(
  "com.whatsoup.harness-maintenance"
  "com.whatsoup.reply-guarantee"
)
BOT_ERRORS_SYSTEMD_UNITS=(
  "bot-errors-dispatcher.service"
  "bot-errors-q-loop.service"
  "bot-errors-collector.service"
  "bot-errors-deadman.service"
  "bot-errors-deadman.timer"
  "bot-errors-health-check.service"
  "bot-errors-health-check.timer"
  "bot-errors-heartbeat-watchdog.service"
  "bot-errors-heartbeat-watchdog.timer"
  "bot-errors-runtime-staleness.service"
  "bot-errors-runtime-staleness.timer"
)

read_env_file_value() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 0
  awk -v key="$key" '
    /^[[:space:]]*#/ { next }
    index($0, key "=") == 1 { value=substr($0, length(key) + 2); found=1 }
    END { if (found) printf "%s", value }
  ' "$file"
}
# The last assignment of a key in an environment file, read as systemd reads
# the ordinary forms, for the release-drift label keys.
# deploy/scripts/whatsoup-release-drift-linux.sh holds the same function, so
# setup reads a label file as the wrapper does.
read_env_label() {
  # $1 file, $2 key. Leading whitespace and "#" or ";" comment lines are
  # skipped; trailing whitespace and one pair of matching quotes around the
  # whole value are removed. A value systemd reads otherwise, such as one with
  # escapes or a quoted value over several lines, reads differently here.
  awk -v key="$2" -v sq="'" -v dq='"' '
    { line = $0; sub(/^[ \t]+/, "", line) }
    line ~ /^[#;]/ { next }
    index(line, key "=") == 1 {
      value = substr(line, length(key) + 2)
      sub(/[ \t\r]+$/, "", value)
      first = substr(value, 1, 1)
      if (length(value) >= 2 && (first == sq || first == dq) && substr(value, length(value)) == first) {
        value = substr(value, 2, length(value) - 2)
      }
      found = 1
    }
    END { if (found) printf "%s", value }
  ' "$1"
}
env_file_has_key() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 1
  awk -v key="$key" '
    /^[[:space:]]*#/ { next }
    index($0, key "=") == 1 { found=1 }
    END { exit found ? 0 : 1 }
  ' "$file"
}
append_env_key_if_missing() {
  local file="$1" key="$2" value="$3"
  if ! env_file_has_key "$file" "$key"; then
    printf "%s=%s\n" "$key" "$value" >> "$file"
    echo "  - Added missing $key to ~/.config/whatsoup/bot-errors.env"
  fi
}
resolve_bot_errors_health_profile() {
  local env_file="$HOME/.config/whatsoup/bot-errors.env" profile host
  profile="$(read_env_file_value "$env_file" BOT_ERRORS_HEALTH_PROFILE)"
  if [ -n "$profile" ]; then
    printf "%s" "$profile"
    return 0
  fi
  if [ -n "${BOT_ERRORS_HEALTH_PROFILE:-}" ]; then
    printf "%s" "$BOT_ERRORS_HEALTH_PROFILE"
    return 0
  fi
  host="$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"
  printf "%s/deploy/health-profiles/%s.json" "$REPO_ROOT" "$host"
}
require_readable_bot_errors_health_profile() {
  local profile
  profile="$(resolve_bot_errors_health_profile)"
  if [ -z "$profile" ] || [ ! -f "$profile" ] || [ ! -r "$profile" ]; then
    echo "  ✗ missing BOT_ERRORS_HEALTH_PROFILE; expected readable profile path" >&2
    echo "    Set BOT_ERRORS_HEALTH_PROFILE or create the host profile before installing BOT ERRORS units." >&2
    exit 2
  fi
  printf "%s" "$profile"
}

# --- release guard helpers start ---
# tests/deploy/setup-release-guard.test.ts runs this block alone, with BIN_DIR,
# REPO_ROOT and PLATFORM set as above.

# A release export carries this manifest at its root (scripts/release-export.ts).
# deploy/preflight-check.sh and deploy/whatsoup read the same marker name and
# decide release mode by git first. The guard below uses the same git probe but
# checks the manifest before it: a manifest inside a work tree counts as a
# release, which only refuses more.
RELEASE_MANIFEST_FILE=".whatsoup-release-manifest.json"
SWITCH_RELEASE_TREE_FLAG="--switch-release-tree"

# resolve_path PATH: print PATH with every symlink resolved, both in the link
# chain at its end and in its directories. Status 1 when a directory on the way
# is missing or the chain is longer than 40 links. A final name that does not
# exist, in a directory that does, still prints.
resolve_path() {
  local p="$1" target hops=0 dir
  while [ -L "$p" ]; do
    hops=$((hops + 1))
    [ "$hops" -le 40 ] || return 1
    target="$(readlink "$p")" || return 1
    case "$target" in
      /*) p="$target" ;;
      *) p="$(dirname "$p")/$target" ;;
    esac
  done
  dir="$(cd -P "$(dirname "$p")" 2>/dev/null && pwd)" || return 1
  printf '%s/%s\n' "$dir" "$(basename "$p")"
}

# is_git_checkout DIR: status 0 when git reports DIR as a work tree, by the probe
# deploy/whatsoup and scripts/source-runtime-drift-check.ts use to choose git
# mode. Inherited GIT_* variables are dropped, discovery stops at DIR's physical
# parent so an unrelated ancestor .git does not count, and only git's literal
# "true" counts (inside a .git directory the probe prints "false"). Without git,
# nothing is a checkout. Call it only as a condition.
is_git_checkout() (
  dir="$1"
  while IFS='=' read -r git_env_name _; do
    case "$git_env_name" in
      GIT_*) unset "$git_env_name" 2>/dev/null || : ;;
    esac
  done < <(env)
  physical="$(cd -P "$dir" 2>/dev/null && pwd)" || exit 1
  GIT_CEILING_DIRECTORIES="$(dirname "$physical")"
  export GIT_CEILING_DIRECTORIES
  [ "$(git -C "$physical" rev-parse --is-inside-work-tree 2>/dev/null)" = "true" ]
)

# is_checkout DIR: DIR is a git checkout and carries no release manifest. A
# manifest in a work tree makes it count as a release, which only refuses more.
# Call it only as a condition.
is_checkout() {
  [ ! -e "$1/$RELEASE_MANIFEST_FILE" ] && [ ! -L "$1/$RELEASE_MANIFEST_FILE" ] && is_git_checkout "$1"
}

# refuse_release_bound_change ACTION: exit 2 unless ACTION keeps the bot on the
# tree it already runs, or moves it between two git checkouts. The wrapper link
# selects the bot's tree, and on macOS the timer plists bake in REPO_ROOT.
# Either change takes effect at the job's next start (a crash restart, a
# watchdog restart, a reboot), outside release:activate, which checks
# preconditions, backs up, verifies and rolls back. A switch passes only after
# both trees are positively identified as checkouts: an older release without a
# manifest, or a wrapper that cannot be resolved, must not pass for "no release
# involved". No wrapper at all is a first install, with nothing to switch.
# release:activate is macOS only. On Linux, switch_release_tree=1
# (--switch-release-tree, which the parser admits only on Linux and only for a
# default run) lets a wrapper that resolves move to this tree: the old and the
# new target are printed once, before the preflight, as the rollback record.
refuse_release_bound_change() {
  local action="$1" link="$BIN_DIR/whatsoup" current="" current_tree="" this_tree named reason
  [ -L "$link" ] || [ -e "$link" ] || return 0
  this_tree="$(cd -P "$REPO_ROOT" && pwd)"
  if current="$(resolve_path "$link")" && [ -f "$current" ]; then
    case "$current" in
      */deploy/whatsoup) current_tree="${current%/deploy/whatsoup}" ;;
    esac
  fi
  if [ -z "$current_tree" ]; then
    reason="the wrapper does not resolve to an existing deploy/whatsoup, so the tree the bot runs is unknown; remove ~/.local/bin/whatsoup first if this is a fresh install"
  elif [ "${switch_release_tree:-0}" -eq 1 ]; then
    named="$(readlink "$link" 2>/dev/null || true)"
    # A wrapper that already names this tree by the same text is no switch.
    if [ "${release_tree_switch_announced:-0}" -ne 1 ] && [ "$named" != "$REPO_ROOT/deploy/whatsoup" ]; then
      old_setup="$current_tree/deploy/setup.sh"
      echo "  Switching this host's tree ($SWITCH_RELEASE_TREE_FLAG):"
      echo "    Old wrapper target: ${named:-$current} (resolves to $current)"
      echo "    New wrapper target: $REPO_ROOT/deploy/whatsoup"
      echo "    To roll back, run the old tree's setup:"
      if [ -f "$old_setup" ] && grep -qF -- "$SWITCH_RELEASE_TREE_FLAG" "$old_setup"; then
        echo "      bash $(printf '%q' "$old_setup") $SWITCH_RELEASE_TREE_FLAG"
      else
        echo "      bash $(printf '%q' "$old_setup")"
        echo "    That older setup.sh has no $SWITCH_RELEASE_TREE_FLAG: it switches the host back without the release-tree check."
      fi
      echo ""
      release_tree_switch_announced=1
    fi
    return 0
  elif [ "$current_tree" = "$this_tree" ]; then
    # Same tree. Unless it is a checkout, the run must also write the exact path
    # the wrapper names: release:activate compares it as a string, and a link
    # made through a symlinked path would follow that symlink when it moves.
    named="$(readlink "$link" 2>/dev/null || true)"
    if [ "$named" = "$REPO_ROOT/deploy/whatsoup" ] || is_checkout "$this_tree"; then
      return 0
    fi
    reason="the wrapper names ${named:-a file}, but this run would write $REPO_ROOT/deploy/whatsoup; run setup through the path the wrapper names. If that path is relative or unnormalized, first relink the wrapper by hand (macOS, while no activation runs) to exactly the resolved path below, only after checking it is an existing regular file and the same file (test -ef), with a new link renamed over the old one (mv -fh), never rm then ln, and read it back. Follow the steps in docs/runbooks/release-deployment.md (\"Helper links after an activation\")"
  elif is_checkout "$current_tree" && is_checkout "$this_tree"; then
    return 0
  else
    reason="the bot wrapper runs another tree, and the two are not both git checkouts"
  fi
  {
    echo "  ✗ Refusing to $action: $reason."
    echo "    Bot wrapper: $link -> ${current:-unresolvable}"
    echo "    This tree:   $this_tree"
    if [ "$PLATFORM" = "Darwin" ]; then
      echo "    Only release:activate moves a release host to another tree. It checks"
      echo "    preconditions, backs up, verifies and rolls back:"
      echo "      npm --silent run release:activate -- --instance <instance> \\"
      echo "        --release <new-release> --expect-current <current-release> \\"
      echo "        --aux-label com.whatsoup.harness-maintenance=setup-timer \\"
      echo "        --aux-label com.whatsoup.reply-guarantee=setup-timer \\"
      echo "        --backup-dir <dir> --plan"
      echo "    Pass one --aux-label for each timer plist the host has installed; see"
      echo "    docs/runbooks/release-deployment.md (\"Activating a release\")."
    elif [ -n "$current_tree" ]; then
      echo "    On Linux, where release:activate refuses, re-run with $SWITCH_RELEASE_TREE_FLAG to switch this host to this tree on purpose (docs/runbooks/release-deployment.md, \"Switching a Linux host to another tree\")."
    else
      # The flag needs the old tree, so it cannot help here.
      echo "    On Linux, where release:activate refuses, no option switches a wrapper that does not resolve: repair or remove it first, as the reason above says."
    fi
    echo "    From any tree, --npmrc-only (step 5) still runs. --skip-wrappers skips"
    echo "    step 3, but on macOS step 4 still needs the active release. From the"
    echo "    active release, --wrappers-only (step 3) moves the helper links."
  } >&2
  exit 2
}
# --- release guard helpers end ---

# install_wrapper_link NAME TARGET: point $BIN_DIR/NAME at TARGET. The new link
# is made beside the old one and renamed over it, so NAME is never missing or
# half-written (a forced `ln` unlinks the old name first). A directory at NAME,
# or a link to one, is refused. The rename does not follow a link at NAME
# either (GNU mv -T, BSD mv -h), so a link that turns into a link to a
# directory after the check is replaced, not moved into; the link is read back
# after the rename. TARGET is made executable only when it is not already, so a
# run from a live release writes nothing inside it.
install_wrapper_link() {
  local name="$1" target="$2" link tmp no_deref named
  link="$BIN_DIR/$name"
  [ -x "$target" ] || chmod +x "$target"
  if [ -d "$link" ]; then
    echo "  ✗ $link is a directory or links to one; not replacing it" >&2
    exit 1
  fi
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]; then
    echo "  ✓ $name → $target (unchanged)"
    return 0
  fi
  # Only GNU mv answers --version. The flavour is read from mv itself, not from
  # PLATFORM: a macOS host can have GNU coreutils first on PATH.
  if mv --version >/dev/null 2>&1; then no_deref=-T; else no_deref=-h; fi
  tmp="$BIN_DIR/.$name.setup-$$"
  rm -f "$tmp"
  if ! ln -s "$target" "$tmp"; then
    echo "  ✗ could not create the new link $tmp; $link is unchanged" >&2
    exit 1
  fi
  if ! mv -f "$no_deref" "$tmp" "$link"; then
    rm -f "$tmp"
    echo "  ✗ could not replace $link" >&2
    exit 1
  fi
  named="$(readlink "$link" 2>/dev/null || true)"
  if [ "$named" != "$target" ]; then
    if [ "$(readlink "$tmp" 2>/dev/null || true)" = "$target" ]; then rm -f "$tmp"; fi
    echo "  ✗ $link names ${named:-nothing} after the rename, not $target" >&2
    exit 1
  fi
  echo "  ✓ $name → $target"
}

if [ "${1:-}" = "--check" ]; then
  [ "$#" -eq 1 ] || { echo "--check cannot be combined with other options" >&2; exit 2; }
  # macOS hosts have no systemd user dir — tolerate the documented skip
  # (exit 3 without the flag) instead of failing every Darwin --check.
  exec "$REPO_ROOT/scripts/check-unit-drift.sh" --allow-missing-systemd-dir
fi
if [ "${1:-}" = "--remove-timers" ]; then
  [ "$#" -eq 1 ] || { echo "--remove-timers cannot be combined with other options" >&2; exit 2; }
  if [ "$PLATFORM" != "Darwin" ]; then
    echo "--remove-timers applies to macOS launchd timers only." >&2
    echo "On Linux, disable the systemd timers instead:" >&2
    echo "  systemctl --user disable --now harness-maintenance.timer whatsoup-reply-guarantee.timer whatsoup-release-drift.timer" >&2
    exit 1
  fi
  for label in "${LAUNCHD_TIMER_LABELS[@]}"; do
    plist_dest="$LAUNCH_AGENTS_DIR/$label.plist"
    if [ -f "$plist_dest" ]; then
      rm "$plist_dest"
      echo "  ✓ Removed $plist_dest"
    else
      echo "  - $label.plist not installed — nothing to remove"
    fi
    echo "    If the job is currently loaded, unload it as a deployment step:"
    echo "      launchctl bootout gui/\$(id -u)/$label"
  done
  exit 0
fi
if [ "${1:-}" = "--reconcile" ]; then
  shift
  reconcile_check=0
  if [ "${1:-}" = "--check" ]; then
    reconcile_check=1
    shift
  fi
  if [ "$#" -gt 0 ]; then
    echo "--reconcile accepts at most a single trailing --check flag" >&2
    exit 2
  fi

  # Expected service sets — MUST mirror the step-4 install surface:
  # the 9 named systemd cp targets enumerated below + every entry of
  # BOT_ERRORS_SYSTEMD_UNITS, and the launchd labels in LAUNCHD_TIMER_LABELS.
  # Per-instance units (whatsoup@<name>.service, the fleet-generated
  # com.whatsoup.<name>.plist) are intentionally OUT of the expected set —
  # they are operator-managed per-instance and excluded from discovery, never
  # reconciled. This mode is print-only: it never executes launchctl/systemctl
  # mutations (preserving the setup-platform.test.ts launchd-mutation
  # invariant); the operator copies the printed remediation commands.
  RECONCILE_SYSTEMD_EXPECTED=(
    "whatsoup@.service"
    "whatsoup-fleet.service"
    "whatsoup-heal-notify@.service"
    "whatsoup-reply-guarantee.service"
    "whatsoup-reply-guarantee.timer"
    "harness-maintenance.service"
    "harness-maintenance.timer"
    "whatsoup-release-drift.service"
    "whatsoup-release-drift.timer"
  )
  RECONCILE_SYSTEMD_EXPECTED+=("${BOT_ERRORS_SYSTEMD_UNITS[@]}")

  reconcile_orphans_found=0
  reconcile_missing_found=0

  # Linear set membership (bash 3.2-safe: no associative arrays). Returns 0
  # when $needle equals any remaining positional arg. Callers pass arrays via
  # the ${arr[@]+"${arr[@]}"} guard so an empty installed-set does not trip
  # `set -u`.
  reconcile_set_contains() {
    local needle="$1"
    shift
    local item
    for item in "$@"; do
      [ "$item" = "$needle" ] && return 0
    done
    return 1
  }

  echo "WhatSoup service reconcile"
  echo "=========================="
  echo ""

  if [ "$PLATFORM" = "Darwin" ]; then
    # --- reconcile: darwin (macos launchd) filesystem plist discovery ---
    # Uses filesystem discovery (not `launchctl list`) so a stale plist that
    # is no longer loaded — but still on disk — is still surfaced.
    echo "macOS launchd reconcile — filesystem plist discovery in $LAUNCH_AGENTS_DIR"
    echo ""
    shopt -s nullglob
    installed_plists=()
    if [ -d "$LAUNCH_AGENTS_DIR" ]; then
      for f in "$LAUNCH_AGENTS_DIR"/com.whatsoup.*.plist; do
        # Existence guard: literal (non-wildcard) glob entries survive nullglob
        # and would otherwise be reported as installed. Wildcard misses are
        # already elided by nullglob; this also covers symlink/race edge cases.
        [ -e "$f" ] || continue
        installed_plists+=("$(basename "$f" .plist)")
      done
    fi
    shopt -u nullglob

    # Missing: an expected timer label whose plist is not installed.
    for label in "${LAUNCHD_TIMER_LABELS[@]}"; do
      if ! reconcile_set_contains "$label" ${installed_plists[@]+"${installed_plists[@]}"}; then
        echo "  missing: $label.plist not installed in $LAUNCH_AGENTS_DIR"
        echo "    Reinstall with: deploy/setup.sh"
        reconcile_missing_found=1
      fi
    done

    # Orphan candidates: any installed com.whatsoup.* plist that is not one of
    # the setup-managed timer labels. Fleet-managed instance plists
    # (com.whatsoup.<name>.plist for active lines) and any other
    # intentionally-installed timer are NOT in the expected set, so the report
    # asks the operator to verify before removing. Nothing is auto-removed.
    for inst in ${installed_plists[@]+"${installed_plists[@]}"}; do
      if ! reconcile_set_contains "$inst" "${LAUNCHD_TIMER_LABELS[@]}"; then
        echo "  orphan candidate: $inst.plist installed but not in the setup-managed timer set"
        echo "    (operator: verify this is stale — not an active fleet instance plist"
        echo "     or another intentionally-managed timer — before removing)"
        echo "    To remove (operator step, never auto-run):"
        echo "      rm $LAUNCH_AGENTS_DIR/$inst.plist"
        echo "      launchctl bootout gui/\$(id -u)/$inst"
        reconcile_orphans_found=1
      fi
    done
  else
    # --- reconcile: linux (systemd) filesystem unit discovery ---
    echo "Linux systemd reconcile — filesystem unit discovery in $SYSTEMD_DIR"
    echo ""
    shopt -s nullglob
    installed_units=()
    if [ -d "$SYSTEMD_DIR" ]; then
      for f in "$SYSTEMD_DIR"/whatsoup*.service "$SYSTEMD_DIR"/whatsoup*.timer \
               "$SYSTEMD_DIR"/bot-errors-*.service "$SYSTEMD_DIR"/bot-errors-*.timer \
               "$SYSTEMD_DIR"/harness-maintenance.service "$SYSTEMD_DIR"/harness-maintenance.timer; do
        # Existence guard: the harness-maintenance entries are literal (no
        # wildcard), so nullglob does NOT elide them when absent and they
        # would be falsely reported as installed. Wildcard misses are already
        # elided by nullglob; this guard closes the literal-pattern hole and
        # also covers symlink/race edge cases.
        [ -e "$f" ] || continue
        name="$(basename "$f")"
        # Exclude per-instance units (whatsoup@<name>.service,
        # whatsoup-heal-notify@<name>.service) — operator-managed, not
        # reconciled. Templates (whatsoup@.service) carry an empty instance
        # slot and are kept.
        case "$name" in
          *@[^.]*.service|*@[^.]*.timer) continue ;;
        esac
        installed_units+=("$name")
      done
    fi
    shopt -u nullglob

    for unit in "${RECONCILE_SYSTEMD_EXPECTED[@]}"; do
      if ! reconcile_set_contains "$unit" ${installed_units[@]+"${installed_units[@]}"}; then
        echo "  missing: $unit not installed in $SYSTEMD_DIR"
        echo "    Reinstall with: deploy/setup.sh"
        reconcile_missing_found=1
      fi
    done

    for inst in ${installed_units[@]+"${installed_units[@]}"}; do
      if ! reconcile_set_contains "$inst" "${RECONCILE_SYSTEMD_EXPECTED[@]}"; then
        echo "  orphan: $inst installed but not in the expected set"
        echo "    To remove (operator step, never auto-run):"
        echo "      rm $SYSTEMD_DIR/$inst"
        echo "      systemctl --user disable --now $inst"
        reconcile_orphans_found=1
      fi
    done
  fi

  echo ""
  if [ "$reconcile_orphans_found" -eq 0 ] && [ "$reconcile_missing_found" -eq 0 ]; then
    echo "Reconcile clean: installed services match the expected set."
    exit 0
  fi
  echo "Reconcile complete: review the items above; remediation commands are printed, not executed."
  if [ "$reconcile_check" -eq 1 ]; then
    exit 1
  fi
  exit 0
fi
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  cat <<'USAGE'
Usage: deploy/setup.sh [--profile <runtime|quality|release>] [--install-host-dependencies] [--yes]
                       [--skip-wrappers] [--wrappers-only] [--timers-only] [--npmrc-only]
                       [--switch-release-tree]
       deploy/setup.sh [--check | --remove-timers | --reconcile [--check]]

  --profile PROFILE  Validate the runtime, quality, or release capability profile.
  --install-host-dependencies
                     Apply the explicit host package plan before setup.
  --yes              Confirm the host package plan non-interactively; valid only
                     with --install-host-dependencies.
  --skip-wrappers    Skip step 3 (the ~/.local/bin wrapper links).
  --wrappers-only    Run only step 3: the bot wrapper and the seven helper links
                     in ~/.local/bin. Cannot be combined with --skip-wrappers.
  --timers-only      Run only step 4: the launchd timer plists (macOS) or the
                     systemd units (Linux), plus the ~/.config/whatsoup env
                     templates.
  --npmrc-only       Run only step 5: merge the hardened ~/.npmrc.
                     The --*-only flags combine. The preflight and the
                     step 1 checks always run.

  When ~/.local/bin/whatsoup exists, step 3 and, on macOS, step 4 refuse
  with exit 2 unless this tree is the one the wrapper already runs, reached
  through the path it names, or both trees are git checkouts. A wrapper that
  cannot be resolved is refused too; on a fresh install, remove it first.
  Move a release host to another release with release:activate (macOS;
  docs/runbooks/release-deployment.md), then run --wrappers-only from the
  active release to move the helper links.
  --switch-release-tree
                     Linux only, default run only: switch a host whose wrapper
                     resolves to another tree to this tree on purpose. Prints
                     the old and new wrapper targets and the rollback command
                     before the preflight, installs dependencies (step 2)
                     before the links move, and reads the wrapper back after
                     step 3. A wrapper that does not resolve is still refused.
  --check         Compare checked-in systemd units with installed user units.
  --remove-timers  macOS only: remove the launchd maintenance timer plists from
                    ~/Library/LaunchAgents. Prints the bootout commands to unload
                    any currently loaded jobs — they are never run automatically.
  --reconcile      Compare installed launchd plists (Darwin) and systemd units
                    (Linux) against the setup-managed expected set; report
                    missing services and orphan candidates and PRINT remediation
                    commands (the operator runs the launchd unload / systemd
                    disable steps themselves — setup.sh never executes them).
                    With --check, exits non-zero when any missing service or
                    orphan is found (CI/scripting); without --check, exits 0
                    after the report. Per-instance units are operator-managed
                    and excluded.
USAGE
  exit 0
fi

profile=runtime
install_host_dependencies=0
assume_yes=0
skip_wrappers=0
only_wrappers=0
only_timers=0
only_npmrc=0
switch_release_tree=0
release_tree_switch_announced=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      [ "$#" -ge 2 ] || { echo "--profile requires a value" >&2; exit 2; }
      profile="$2"
      shift 2
      ;;
    --install-host-dependencies)
      install_host_dependencies=1
      shift
      ;;
    --yes)
      assume_yes=1
      shift
      ;;
    --skip-wrappers)
      skip_wrappers=1
      shift
      ;;
    --wrappers-only)
      only_wrappers=1
      shift
      ;;
    --timers-only)
      only_timers=1
      shift
      ;;
    --npmrc-only)
      only_npmrc=1
      shift
      ;;
    --switch-release-tree)
      switch_release_tree=1
      shift
      ;;
    *)
      echo "Unknown setup option: $1" >&2
      exit 2
      ;;
  esac
done
case "$profile" in
  runtime|quality|release) ;;
  *) echo "Unsupported setup profile: $profile" >&2; exit 2 ;;
esac
if [ "$assume_yes" -eq 1 ] && [ "$install_host_dependencies" -ne 1 ]; then
  echo "--yes requires --install-host-dependencies" >&2
  exit 2
fi
if [ "$only_wrappers" -eq 1 ] && [ "$skip_wrappers" -eq 1 ]; then
  echo "--wrappers-only and --skip-wrappers cannot be combined" >&2
  exit 2
fi
if [ "$switch_release_tree" -eq 1 ]; then
  # A tree switch runs every step: dependencies before the links move, then the
  # units, so no partial run can leave the links and the units on two trees.
  for selection_option in --wrappers-only:"$only_wrappers" --timers-only:"$only_timers" \
    --npmrc-only:"$only_npmrc" --skip-wrappers:"$skip_wrappers"; do
    if [ "${selection_option##*:}" -eq 1 ]; then
      echo "$SWITCH_RELEASE_TREE_FLAG cannot be combined with ${selection_option%:*}: a tree switch runs every step" >&2
      exit 2
    fi
  done
  if [ "$PLATFORM" = "Darwin" ]; then
    echo "$SWITCH_RELEASE_TREE_FLAG is Linux only. On macOS, move a release host with release:activate, which checks preconditions, backs up, verifies and rolls back (docs/runbooks/release-deployment.md, \"Activating a release\")." >&2
    exit 2
  fi
fi
# The Linux release-drift unit labels its BOT ERRORS alerts with this value, so
# it is checked here, before setup changes anything. The wrapper passes it after
# --instance, where a leading dash reads as another option (the scheduler's
# --help, or isFlagToken in scripts/lib/cli-args.ts for the observer).
# deploy/scripts/whatsoup-release-drift-linux.sh refuses the same labels.
release_drift_instance="${WHATSOUP_RELEASE_DRIFT_INSTANCE:-}"
if [ "$PLATFORM" != "Darwin" ] && [ -n "$release_drift_instance" ] \
  && [[ ! "$release_drift_instance" =~ ^[A-Za-z0-9._][A-Za-z0-9._-]*$ ]]; then
  echo "  ✗ unsafe WHATSOUP_RELEASE_DRIFT_INSTANCE: use only letters, digits, dot, underscore, and dash, and do not begin with a dash" >&2
  exit 2
fi

# Steps 2-7 that this run performs; the preflight and step 1 always run.
run_deps=1 run_wrappers=1 run_services=1 run_npmrc=1 run_console=1 run_keys=1
if [ "$only_wrappers" -eq 1 ] || [ "$only_timers" -eq 1 ] || [ "$only_npmrc" -eq 1 ]; then
  run_deps=0 run_console=0 run_keys=0
  run_wrappers="$only_wrappers" run_services="$only_timers" run_npmrc="$only_npmrc"
fi
if [ "$skip_wrappers" -eq 1 ]; then
  run_wrappers=0
fi
all_steps=$((run_deps & run_wrappers & run_services & run_npmrc & run_console & run_keys))

# Refuse a release-bound change before any step runs; steps 3 and 4 check again
# when they reach it.
if [ "$run_wrappers" -eq 1 ]; then
  refuse_release_bound_change "repoint the wrappers in $BIN_DIR"
fi
if [ "$run_services" -eq 1 ] && [ "$PLATFORM" = "Darwin" ]; then
  refuse_release_bound_change "render the launchd timer plists"
fi

echo "WhatSoup Setup"
echo "=============="
echo ""

installer_args=(--profile "$profile")
bash "$REPO_ROOT/deploy/scripts/install-host-dependencies.sh" "${installer_args[@]}"
bash "$REPO_ROOT/deploy/scripts/ensure-node-installed.sh"
pinned_version="$(tr -d '[:space:]' < "$REPO_ROOT/.nvmrc")"
pinned_bin="${NVM_DIR:-$HOME/.nvm}/versions/node/v${pinned_version}/bin"
if [ -x "$pinned_bin/node" ]; then
  PATH="$pinned_bin:$PATH"
  export PATH
fi
if [ "$install_host_dependencies" -eq 1 ]; then
  installer_args+=(--apply)
  [ "$assume_yes" -eq 1 ] && installer_args+=(--yes)
  bash "$REPO_ROOT/deploy/scripts/install-host-dependencies.sh" "${installer_args[@]}"
fi
bash "$REPO_ROOT/deploy/scripts/whatsoup-host-doctor.sh" --profile "$profile"
echo ""

# ── Step 1: Check requirements ──────────────────────────────────────
echo "[1/7] Checking requirements..."
errors=0

# Node.js
if command -v node &>/dev/null; then
  node_version="$(node -v | sed 's/^v//')"
  node_major="${node_version%%.*}"
  engine_max_exclusive_major="$(node -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const range = pkg.engines && pkg.engines.node;
if (typeof range !== "string") process.exit(2);
const match = range.match(/<\s*(\d+)/);
if (!match) process.exit(3);
process.stdout.write(match[1]);
' "$REPO_ROOT/package.json" 2>/dev/null || true)"
  required_major="$(tr -d '[:space:]' < "$REPO_ROOT/.nvmrc" 2>/dev/null | sed -E 's/^([0-9]+).*/\1/')"
  if ! printf '%s' "$required_major" | grep -qE '^[0-9]+$' \
    || ! printf '%s' "$engine_max_exclusive_major" | grep -qE '^[0-9]+$'; then
    echo "  ✗ Could not parse Node bounds from .nvmrc and package.json#engines.node"
    errors=$((errors + 1))
  elif ! printf '%s' "$node_major" | grep -qE '^[0-9]+$'; then
    echo "  ✗ Could not parse Node.js major from version $node_version"
    errors=$((errors + 1))
  elif [ "$node_major" -ge "$required_major" ] && [ "$node_major" -lt "$engine_max_exclusive_major" ]; then
    echo "  ✓ Node.js $node_version (>= $required_major and < $engine_max_exclusive_major required)"
  else
    echo "  ✗ Node.js $node_version found — version >= $required_major and < $engine_max_exclusive_major required"
    echo "    Install: https://nodejs.org/ or use nvm/fnm"
    errors=$((errors + 1))
  fi
else
  echo "  ✗ Node.js not found — version $(tr -d '[:space:]' < "$REPO_ROOT/.nvmrc" 2>/dev/null || echo 24.15.0) required"
  echo "    Install: https://nodejs.org/ or use nvm/fnm"
  errors=$((errors + 1))
fi

# Service manager and credential store — platform-specific
if [ "$PLATFORM" = "Darwin" ]; then
  # --- darwin (macos launchd) requirements ---
  if command -v launchctl &>/dev/null; then
    echo "  ✓ launchd available (launchctl)"
  else
    echo "  ✗ launchctl not found — launchd is required for instance management on macOS"
    errors=$((errors + 1))
  fi

  # macOS Keychain (security binary ships with macOS) — warn but don't block
  if command -v security &>/dev/null; then
    echo "  ✓ macOS Keychain available (security)"
  else
    echo "  ⚠ security not found (optional)"
    echo "    API keys can be set via environment variables instead"
  fi
else
  # --- linux (systemd) requirements ---
  if command -v systemctl &>/dev/null; then
    if systemctl --user list-units &>/dev/null; then
      echo "  ✓ systemd user units available"
    else
      echo "  ✗ systemctl found but user session unavailable"
      echo "    Ensure you're logged into a graphical session or enable lingering:"
      echo "    loginctl enable-linger $USER"
      errors=$((errors + 1))
    fi
  else
    echo "  ✗ systemctl not found — systemd is required for instance management"
    echo "    WhatSoup uses systemd user units to manage WhatsApp instances"
    errors=$((errors + 1))
  fi

  # secret-tool (GNOME Keyring) — warn but don't block
  if command -v secret-tool &>/dev/null; then
    echo "  ✓ secret-tool available (GNOME Keyring)"
  else
    echo "  ⚠ secret-tool not found (optional)"
    echo "    API keys can be set via environment variables in systemd overrides instead"
    echo "    Install: sudo apt install libsecret-tools  (Debian/Ubuntu)"
  fi
fi

# ffmpeg — optional
ffmpeg_arch_suffix="$(arch_bin_suffix)"
if command -v ffmpeg &>/dev/null; then
  echo "  ✓ ffmpeg available"
elif [ -n "$ffmpeg_arch_suffix" ] && command -v "ffmpeg$ffmpeg_arch_suffix" &>/dev/null; then
  echo "  ✓ ffmpeg available (arch-suffixed: ffmpeg$ffmpeg_arch_suffix)"
else
  echo "  - ffmpeg not found (optional — video processing in chat mode disabled)"
fi

if [ "$errors" -gt 0 ]; then
  echo ""
  echo "  $errors required dependency missing. Fix the above and re-run: npm run setup"
  exit 1
fi
echo ""

# ── Step 2: Install dependencies ────────────────────────────────────
# Matches .github/workflows/quality.yml install step exactly so local
# setup, CI, and Docker all reproduce the pinned lockfile tree.
echo "[2/7] Installing dependencies..."
if [ "$run_deps" -eq 1 ]; then
  (cd "$REPO_ROOT" && npm ci)
  echo "  ✓ Root dependencies installed"
else
  echo "  - Skipped (not selected)"
fi

# ── Step 3: Install wrapper scripts ─────────────────────────────────
if [ "$run_wrappers" -eq 1 ]; then
  echo "[3/7] Installing wrapper scripts to $BIN_DIR..."
  refuse_release_bound_change "repoint the wrappers in $BIN_DIR"
  mkdir -p "$BIN_DIR"
  install_wrapper_link "whatsoup" "$REPO_ROOT/deploy/whatsoup"
  install_wrapper_link "whatsoup-fleet" "$REPO_ROOT/deploy/whatsoup-fleet"
  install_wrapper_link "whatsoup-auth" "$REPO_ROOT/deploy/whatsoup-auth"
  install_wrapper_link "whatsoup-ensure-node" "$REPO_ROOT/deploy/scripts/ensure-node-installed.sh"
  install_wrapper_link "whatsoup-harness-maintenance" "$REPO_ROOT/deploy/scripts/harness-maintenance.sh"
  install_wrapper_link "whatsoup-reply-guarantee-drain" "$REPO_ROOT/deploy/scripts/reply-guarantee-drain.sh"
  install_wrapper_link "whatsoup-heal-notify" "$REPO_ROOT/deploy/scripts/heal-notify.sh"
  # Keeps its .sh name: deploy/whatsoup-release-drift.service executes it by that name.
  install_wrapper_link "whatsoup-release-drift-linux.sh" "$REPO_ROOT/deploy/scripts/whatsoup-release-drift-linux.sh"
  if [ "$switch_release_tree" -eq 1 ]; then
    switched_target="$(readlink "$BIN_DIR/whatsoup" 2>/dev/null || true)"
    if [ "$switched_target" != "$REPO_ROOT/deploy/whatsoup" ]; then
      if [ "$release_tree_switch_announced" -eq 1 ]; then
        echo "  ✗ after step 3 $BIN_DIR/whatsoup names ${switched_target:-nothing}, not $REPO_ROOT/deploy/whatsoup: the switch did not complete; roll back with the command printed above" >&2
      else
        echo "  ✗ after step 3 $BIN_DIR/whatsoup names ${switched_target:-nothing}, not $REPO_ROOT/deploy/whatsoup: the switch did not complete" >&2
      fi
      exit 1
    fi
    echo "  ✓ the bot wrapper now names $REPO_ROOT/deploy/whatsoup"
  fi

  # Ensure ~/.local/bin is on PATH
  if ! echo "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
    echo "  ⚠ $BIN_DIR is not on your PATH"
    echo "    Add to your shell profile: export PATH=\"\$HOME/.local/bin:\$PATH\""
  fi
else
  echo "[3/7] Skipped: wrapper scripts (not selected)"
fi

# ── Step 4: Install service units ───────────────────────────────────
# --- step 4 start ---
if [ "$run_services" -ne 1 ]; then
  echo "[4/7] Skipped: service units and timers (not selected)"
elif [ "$PLATFORM" = "Darwin" ]; then
  echo "[4/7] Configuring service management (macOS)..."
  refuse_release_bound_change "render the launchd timer plists"
  echo "  macOS: instance services are launchd plists generated by the fleet on line creation"
  echo "         (~/Library/LaunchAgents/com.whatsoup.<name>.plist) — no unit install needed"
  # --- darwin (macos launchd) timer install ---
  mkdir -p "$LAUNCH_AGENTS_DIR" "$HOME/Library/Logs/whatsoup"
  install_launchd_timer() {
    local label="$1"
    local cron_marker="$2"
    local src="$REPO_ROOT/deploy/$label.plist"
    local dest="$LAUNCH_AGENTS_DIR/$label.plist"
    local rendered backup
    rendered="$(sed -e "s|__WHATSOUP_REPO_ROOT__|$REPO_ROOT|g" -e "s|__HOME__|$HOME|g" -e "s|\${WHATSOUP_REPO_ROOT}|$REPO_ROOT|g" -e "s|\${HOME}|$HOME|g" "$src")"
    # Carry the host's single service.claudeConfigDir (if any) so the job's
    # provider CLI uses the bot's credential store; with none configured, keep
    # the value the installed plist already has. harness-maintenance instead
    # always gets its own $HOME/.claude-maint: its agent CLI must never share
    # (and so be able to refresh) a bot's login. scripts/check-launchd-drift.sh
    # applies the same filter, so its render of this job matches what setup
    # installs. A carried-forward value is re-rendered in the template's layout;
    # a hand-edited plist's own formatting is not kept.
    # An installed plist that mentions CLAUDE_CONFIG_DIR but cannot be read makes
    # the filter fail; the return 1 below then aborts setup under set -e rather
    # than overwrite a value it could not carry forward.
    if ! rendered="$(printf '%s\n' "$rendered" | bash "$REPO_ROOT/scripts/run-with-pinned-node.sh" \
      "$REPO_ROOT/scripts/launchd-claude-config-env.ts" --home "$HOME" --preserve-from "$dest")"; then
      echo "  ✗ cannot resolve service.claudeConfigDir for $label; not installing" >&2
      return 1
    fi
    # Duplicate-scheduler guard: an equivalent cron entry means this job is
    # already scheduled by another mechanism — warn and skip, don't double-run.
    if crontab -l 2>/dev/null | grep -v '^[[:space:]]*#' | grep -q "$cron_marker"; then
      echo "  ⚠ crontab already schedules '$cron_marker' — skipping $label install to avoid a duplicate timer"
      return 0
    fi
    # Duplicate-timer guard: an already-loaded label keeps its running
    # definition; only the on-disk plist is refreshed.
    if launchctl list 2>/dev/null | grep -Fq "$label"; then
      echo "  ⚠ $label is already loaded in launchd — refreshing the plist on disk only;"
      echo "    the loaded job keeps its current definition until reloaded (deployment step)"
    fi
    if [ -f "$dest" ]; then
      if printf '%s\n' "$rendered" | cmp -s - "$dest"; then
        echo "  ✓ $label.plist already installed (unchanged)"
        return 0
      fi
      backup="$dest.whatsoup-backup-$(date -u +%Y%m%dT%H%M%SZ)"
      cp "$dest" "$backup"
      echo "  ✓ Existing $label.plist backed up to $backup"
    fi
    printf '%s\n' "$rendered" > "$dest"
    echo "  ✓ $label.plist installed to ~/Library/LaunchAgents (not loaded)"
  }
  install_launchd_timer "com.whatsoup.harness-maintenance" "harness-maintenance"
  install_launchd_timer "com.whatsoup.reply-guarantee" "reply-guarantee"
  echo "  Timers are installed but NOT loaded — they activate on next login."
  echo "  On a host that logs in automatically, the next reboot loads them, so"
  echo "  installing them is a live change."
  echo "  To load now (deployment step, run manually):"
  echo "     launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/com.whatsoup.harness-maintenance.plist"
  echo "     launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/com.whatsoup.reply-guarantee.plist"
else
  echo "[4/7] Installing systemd user units..."
  # --- linux (systemd) unit install ---
  bot_errors_required_health_profile="$(require_readable_bot_errors_health_profile)"
  echo "  ✓ BOT ERRORS health profile readable: $bot_errors_required_health_profile"
  mkdir -p "$SYSTEMD_DIR"
  cp "$REPO_ROOT/deploy/whatsoup@.service" "$SYSTEMD_DIR/whatsoup@.service"
  cp "$REPO_ROOT/deploy/whatsoup-fleet.service" "$SYSTEMD_DIR/whatsoup-fleet.service"
  cp "$REPO_ROOT/deploy/whatsoup-heal-notify@.service" "$SYSTEMD_DIR/whatsoup-heal-notify@.service"
  cp "$REPO_ROOT/deploy/whatsoup-reply-guarantee.service" "$SYSTEMD_DIR/whatsoup-reply-guarantee.service"
  cp "$REPO_ROOT/deploy/whatsoup-reply-guarantee.timer" "$SYSTEMD_DIR/whatsoup-reply-guarantee.timer"
  cp "$REPO_ROOT/deploy/harness-maintenance.service" "$SYSTEMD_DIR/harness-maintenance.service"
  cp "$REPO_ROOT/deploy/harness-maintenance.timer" "$SYSTEMD_DIR/harness-maintenance.timer"
  cp "$REPO_ROOT/deploy/whatsoup-release-drift.service" "$SYSTEMD_DIR/whatsoup-release-drift.service"
  cp "$REPO_ROOT/deploy/whatsoup-release-drift.timer" "$SYSTEMD_DIR/whatsoup-release-drift.timer"
  for unit in "${BOT_ERRORS_SYSTEMD_UNITS[@]}"; do
    cp "$REPO_ROOT/deploy/$unit" "$SYSTEMD_DIR/$unit"
  done
  if ! systemctl --user daemon-reload; then
    echo "  ✗ systemctl --user daemon-reload failed after installing units" >&2
    exit 1
  fi
  reenable_units=()
  seen_reenable_units=" "
  shopt -s nullglob
  for link in "$SYSTEMD_DIR"/*.target.wants/whatsoup@*.service "$SYSTEMD_DIR"/*.target.wants/whatsoup-fleet.service; do
    unit="$(basename "$link")"
    case "$seen_reenable_units" in
      *" $unit "*) continue ;;
    esac
    seen_reenable_units="$seen_reenable_units$unit "
    reenable_units+=("$unit")
  done
  shopt -u nullglob
  if [ "${#reenable_units[@]}" -gt 0 ]; then
    if ! systemctl --user reenable "${reenable_units[@]}"; then
      echo "  ✗ systemctl --user reenable failed after installing units" >&2
      exit 1
    fi
    echo "  ✓ refreshed systemd enablement for ${reenable_units[*]}"
  fi
  echo "  ✓ whatsoup@.service installed"
  echo "  ✓ whatsoup-fleet.service installed"
  echo "  ✓ whatsoup-heal-notify@.service installed"
  echo "  ✓ whatsoup-reply-guarantee.{service,timer} installed"
  echo "  ✓ harness-maintenance.{service,timer} installed"
  echo "  ✓ whatsoup-release-drift.{service,timer} installed"
  echo "  ✓ BOT ERRORS service/timer units installed"
  # whatsoup-release-drift.service reads its BOT ERRORS instance label,
  # WHATSOUP_RELEASE_DRIFT_INSTANCE, from this file, never from bot-errors.env:
  # every BOT ERRORS unit loads that file. The wrapper ignores WHATSOUP_INSTANCE,
  # which also selects per-instance agent state (deploy/hooks). Setup writes the
  # file only from an explicit label and never writes to a path that exists at
  # this check: any entry, a symlink or a dangling symlink included, counts as
  # present (a label is read through a symlink, as systemd reads it). Under
  # noclobber (set -C), a regular file, a link to one or a dangling symlink that
  # appears after this check is refused too; a FIFO or device that appears, or a
  # link to one, is written into, since bash adds O_EXCL only when stat finds
  # nothing.
  release_drift_env="$HOME/.config/whatsoup/release-drift.env"
  # The wrapper refuses a label file path outside this character set (the same
  # list, without ranges); setup reports it and goes on.
  case "$release_drift_env" in
    *[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/._-]* | */../* | */..)
      echo "  ⚠ whatsoup-release-drift.service refuses this home folder path for its label file: $release_drift_env holds a character other than A-Z, a-z, 0-9, /, ., _ and -, or a .. component, so every run exits 2"
      ;;
  esac
  if [ -e "$release_drift_env" ] || [ -L "$release_drift_env" ]; then
    # A failed read warns and never ends setup (set -e), which has already
    # linked the launchers, installed the units and reloaded systemd. Only a
    # regular file is read, so any other path reads as a file without a label.
    # The file is read as the wrapper reads it (read_env_label), and a value the
    # wrapper refuses is never reported as preserved.
    release_drift_existing=""
    if [ -f "$release_drift_env" ] \
      && ! release_drift_existing="$(read_env_label "$release_drift_env" WHATSOUP_RELEASE_DRIFT_INSTANCE 2>/dev/null)"; then
      echo "  ⚠ setup cannot read ~/.config/whatsoup/release-drift.env: whatsoup-release-drift.service will fail until that file can be read and sets WHATSOUP_RELEASE_DRIFT_INSTANCE"
      if [ -n "$release_drift_instance" ]; then
        echo "    The requested label was not applied: setup never replaces an existing file."
      fi
    elif [ -z "$release_drift_existing" ]; then
      echo "  ⚠ ~/.config/whatsoup/release-drift.env exists but sets no WHATSOUP_RELEASE_DRIFT_INSTANCE: whatsoup-release-drift.service will fail until it does"
      if [ -n "$release_drift_instance" ]; then
        echo "    The requested label was not applied: setup never replaces an existing file."
      fi
    elif [[ ! "$release_drift_existing" =~ ^[A-Za-z0-9._][A-Za-z0-9._-]*$ ]]; then
      echo "  ⚠ ~/.config/whatsoup/release-drift.env sets WHATSOUP_RELEASE_DRIFT_INSTANCE to a value whatsoup-release-drift.service refuses: write it as one line, WHATSOUP_RELEASE_DRIFT_INSTANCE=<instance>, with only letters, digits, dot, underscore and dash, not beginning with a dash"
      if [ -n "$release_drift_instance" ]; then
        echo "    The requested label was not applied: setup never replaces an existing file."
      fi
    elif [ -n "$release_drift_instance" ] && [ "$release_drift_existing" != "$release_drift_instance" ]; then
      echo "  ⚠ Existing release-drift instance label kept at ~/.config/whatsoup/release-drift.env: the requested WHATSOUP_RELEASE_DRIFT_INSTANCE was ignored"
    else
      # Not "accepted": the unit uses the label only when systemd loads the same
      # value from this file, which setup's reader cannot confirm.
      echo "  - Existing release-drift label file left unchanged at ~/.config/whatsoup/release-drift.env"
    fi
  elif [ -n "$release_drift_instance" ]; then
    mkdir -p "$HOME/.config/whatsoup"
    if (set -C; umask 077; printf 'WHATSOUP_RELEASE_DRIFT_INSTANCE=%s\n' "$release_drift_instance" > "$release_drift_env"); then
      echo "  ✓ Release-drift instance label written to ~/.config/whatsoup/release-drift.env"
    else
      echo "  ⚠ Release-drift instance label was not written: ~/.config/whatsoup/release-drift.env appeared after setup's check or cannot be created, and setup never replaces it"
    fi
  else
    # A unit installed by hand took its label from WHATSOUP_INSTANCE, set in a
    # drop-in or in bot-errors.env, which it loaded. Setup has just replaced that
    # unit but keeps the setting, so every run exits 2 until the label file exists.
    # A WHATSOUP_RELEASE_DRIFT_INSTANCE line in bot-errors.env labels no run
    # either: the wrapper takes the label only when the label file assigns it.
    # Setup never guesses the instance: each warning states what it found, and
    # one instruction asks the operator to choose. Both keys are found with a
    # tolerant match (leading whitespace, "export", spaces around "="), so a
    # loosely written line is still reported; no value is taken from it.
    # All checks sit in if conditions: a file setup cannot read must not end setup.
    release_drift_bot_errors_env="$HOME/.config/whatsoup/bot-errors.env"
    release_drift_old_label=""
    release_drift_shared_label=""
    if [ -f "$release_drift_bot_errors_env" ] \
      && grep -qsE '^[[:space:]]*(export[[:space:]]+)?WHATSOUP_RELEASE_DRIFT_INSTANCE[[:space:]]*=' "$release_drift_bot_errors_env"; then
      release_drift_shared_label=1
    fi
    if grep -qsE '^[[:space:]]*Environment[[:space:]]*=.*WHATSOUP_INSTANCE=' "$SYSTEMD_DIR/whatsoup-release-drift.service.d"/*.conf; then
      release_drift_old_label="a drop-in in ~/.config/systemd/user/whatsoup-release-drift.service.d"
    elif [ -f "$release_drift_bot_errors_env" ] \
      && grep -qsE '^[[:space:]]*(export[[:space:]]+)?WHATSOUP_INSTANCE[[:space:]]*=' "$release_drift_bot_errors_env"; then
      release_drift_old_label="the file ~/.config/whatsoup/bot-errors.env"
    fi
    if [ -n "$release_drift_old_label" ]; then
      echo "  ⚠ whatsoup-release-drift.service no longer reads WHATSOUP_INSTANCE, which $release_drift_old_label contains: a release-drift unit installed by hand took its label from that setting."
    fi
    if [ -n "$release_drift_shared_label" ]; then
      echo "  ⚠ ~/.config/whatsoup/bot-errors.env contains WHATSOUP_RELEASE_DRIFT_INSTANCE, which is not read for the label: whatsoup-release-drift.service takes it only from ~/.config/whatsoup/release-drift.env."
    fi
    if [ -n "$release_drift_old_label" ] || [ -n "$release_drift_shared_label" ]; then
      echo "  ⚠ Every run exits 2 without observing until ~/.config/whatsoup/release-drift.env holds the label. Choose the instance this host's bot runs as and write it there once:"
      echo "     (set -C; umask 077; echo WHATSOUP_RELEASE_DRIFT_INSTANCE=<instance> > ~/.config/whatsoup/release-drift.env)"
    else
      echo "  - Release-drift instance label not set: write WHATSOUP_RELEASE_DRIFT_INSTANCE=<instance> to ~/.config/whatsoup/release-drift.env before enabling whatsoup-release-drift.timer"
    fi
  fi
fi
# --- step 4 env templates ---
if [ "$run_services" -eq 1 ]; then
  mkdir -p "$HOME/.config/whatsoup"
  if [ ! -f "$HOME/.config/whatsoup/fleet.env" ]; then
    cp "$REPO_ROOT/deploy/fleet.env.example" "$HOME/.config/whatsoup/fleet.env.example"
    echo "  - Optional fleet bind template installed to ~/.config/whatsoup/fleet.env.example"
  fi
  cp "$REPO_ROOT/deploy/bot-errors.env.example" "$HOME/.config/whatsoup/bot-errors.env.example"
  if [ ! -f "$HOME/.config/whatsoup/bot-errors.env" ]; then
    bot_errors_instance="${BOT_ERRORS_INSTANCE:-personal}"
    bot_errors_jid="${BOT_ERRORS_JID:-}"
    bot_errors_expected_jid="${BOT_ERRORS_EXPECTED_JID:-$bot_errors_jid}"
    bot_errors_socket="${BOT_ERRORS_SOCKET_PATH:-${BOT_ERRORS_SOCKET:-$HOME/.local/state/whatsoup/instances/$bot_errors_instance/whatsoup.sock}}"
    bot_errors_db="${BOT_ERRORS_DB:-$HOME/.local/share/whatsoup/instances/$bot_errors_instance/bot.db}"
    bot_errors_host="$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"
    bot_errors_health_profile="$(resolve_bot_errors_health_profile)"
    bot_errors_authority_url="${BOT_ERRORS_INCIDENT_AUTHORITY_URL:-http://127.0.0.1:9099/api/signals}"
    bot_errors_dispatcher_credential="${BOT_ERRORS_DISPATCHER_AUTHORITY_CREDENTIAL_FILE:-$HOME/.config/whatsoup/bot-errors-dispatcher.credential}"
    bot_errors_q_loop_credential="${BOT_ERRORS_Q_LOOP_AUTHORITY_CREDENTIAL_FILE:-$HOME/.config/whatsoup/bot-errors-q-loop.credential}"
    umask 077
    {
      echo "# Private BOT ERRORS routing config generated by deploy/setup.sh."
      echo "# Fill BOT_ERRORS_JID before enabling bot-errors-dispatcher.service or bot-errors-q-loop.service."
      echo "BOT_ERRORS_JID=$bot_errors_jid"
      echo "BOT_ERRORS_EXPECTED_JID=$bot_errors_expected_jid"
      echo "BOT_ERRORS_SOCKET_PATH=$bot_errors_socket"
      echo "BOT_ERRORS_SOCKET=$bot_errors_socket"
      echo "BOT_ERRORS_DB=$bot_errors_db"
      echo "BOT_ERRORS_HEALTH_PROFILE=$bot_errors_health_profile"
      echo "# IncidentStore authority. observe (the default) asks for a grant and records the"
      echo "# answer but sends every notice; enforce sends nothing without a grant. Switch a host"
      echo "# to enforce only after enrolling both producers and reading its record"
      echo "# (deploy/scripts/README-bot-errors.md)."
      echo "BOT_ERRORS_INCIDENT_AUTHORITY_MODE=observe"
      echo "BOT_ERRORS_INCIDENT_AUTHORITY_URL=$bot_errors_authority_url"
      echo "BOT_ERRORS_DISPATCHER_AUTHORITY_CREDENTIAL_FILE=$bot_errors_dispatcher_credential"
      echo "BOT_ERRORS_Q_LOOP_AUTHORITY_CREDENTIAL_FILE=$bot_errors_q_loop_credential"
    } > "$HOME/.config/whatsoup/bot-errors.env"
    echo "  - BOT ERRORS routing template installed to ~/.config/whatsoup/bot-errors.env"
  else
    bot_errors_env_file="$HOME/.config/whatsoup/bot-errors.env"
    bot_errors_instance="${BOT_ERRORS_INSTANCE:-personal}"
    bot_errors_host="$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"
    bot_errors_jid="$(read_env_file_value "$bot_errors_env_file" BOT_ERRORS_JID)"
    bot_errors_socket_path="$(read_env_file_value "$bot_errors_env_file" BOT_ERRORS_SOCKET_PATH)"
    bot_errors_socket="$(read_env_file_value "$bot_errors_env_file" BOT_ERRORS_SOCKET)"
    bot_errors_default_socket="$HOME/.local/state/whatsoup/instances/$bot_errors_instance/whatsoup.sock"
    bot_errors_default_db="$HOME/.local/share/whatsoup/instances/$bot_errors_instance/bot.db"
    bot_errors_default_health_profile="$(resolve_bot_errors_health_profile)"
    append_env_key_if_missing "$bot_errors_env_file" "BOT_ERRORS_EXPECTED_JID" "$bot_errors_jid"
    if [ -n "$bot_errors_socket" ]; then
      append_env_key_if_missing "$bot_errors_env_file" "BOT_ERRORS_SOCKET_PATH" "$bot_errors_socket"
    else
      append_env_key_if_missing "$bot_errors_env_file" "BOT_ERRORS_SOCKET_PATH" "$bot_errors_default_socket"
    fi
    if [ -n "$bot_errors_socket_path" ]; then
      append_env_key_if_missing "$bot_errors_env_file" "BOT_ERRORS_SOCKET" "$bot_errors_socket_path"
    else
      append_env_key_if_missing "$bot_errors_env_file" "BOT_ERRORS_SOCKET" "${bot_errors_socket:-$bot_errors_default_socket}"
    fi
    append_env_key_if_missing "$bot_errors_env_file" "BOT_ERRORS_DB" "$bot_errors_default_db"
    append_env_key_if_missing "$bot_errors_env_file" "BOT_ERRORS_HEALTH_PROFILE" "$bot_errors_default_health_profile"
    # Only when missing: an owner's enforce setting is kept. No credential path
    # is added; until a host is enrolled its record says "not configured".
    append_env_key_if_missing "$bot_errors_env_file" "BOT_ERRORS_INCIDENT_AUTHORITY_MODE" "observe"
    append_env_key_if_missing "$bot_errors_env_file" "BOT_ERRORS_INCIDENT_AUTHORITY_URL" \
      "${BOT_ERRORS_INCIDENT_AUTHORITY_URL:-http://127.0.0.1:9099/api/signals}"
    echo "  ✓ Existing BOT ERRORS routing config preserved at ~/.config/whatsoup/bot-errors.env"
    echo "  - IncidentStore authority runs in observe mode unless this host's env file says enforce:"
    echo "    every notice is sent and each authority answer is recorded. To enroll this host and"
    echo "    read its record, see deploy/scripts/README-bot-errors.md (authority modes)."
  fi
fi

# ── Step 5: Install hardened npm defaults ───────────────────────────
echo "[5/7] Installing hardened npm defaults..."
if [ "$run_npmrc" -eq 1 ]; then
  if [ -f "$HOME/.npmrc" ] && ! cmp -s "$REPO_ROOT/deploy/npmrc.hardened" "$HOME/.npmrc"; then
    npmrc_backup="$HOME/.npmrc.whatsoup-backup-$(date -u +%Y%m%dT%H%M%SZ)"
    cp "$HOME/.npmrc" "$npmrc_backup"
    echo "  ✓ Existing ~/.npmrc backed up to $npmrc_backup"
  fi
  node --experimental-strip-types "$REPO_ROOT/scripts/npmrc-merge.ts" \
    "$REPO_ROOT/deploy/npmrc.hardened" "$HOME/.npmrc"
  echo "  ✓ ~/.npmrc hardened with 7-day npm release cooldown while preserving local settings"
else
  echo "  - Skipped (not selected)"
fi

# ── Step 6: Build console ───────────────────────────────────────────
# Matches .github/workflows/quality.yml console-install + console-build
# exactly. stderr is left visible so peer-dep / build failures surface.
echo "[6/7] Building fleet console..."
if [ "$run_console" -ne 1 ]; then
  echo "  - Skipped (not selected)"
elif [ -f "$REPO_ROOT/console/package.json" ]; then
  (cd "$REPO_ROOT/console" && npm ci && npm run build)
  echo "  ✓ Console built to dist/"
else
  echo "  ⚠ Console not found — skipping build"
fi

# ── Step 7: Check API keys ──────────────────────────────────────────
echo "[7/7] Checking API keys..."
if [ "$run_keys" -ne 1 ]; then
  echo "  - Skipped (not selected)"
elif [ "$PLATFORM" = "Darwin" ]; then
  # --- darwin (macos keychain) key check ---
  # Uses the same lookup conventions as src/lib/keyring.ts: security find-generic-password -s <service> -a <username> -w
  check_key() {
    local service="$1"
    local required="$2"
    if whatsoup_run_bounded 3 security find-generic-password -s "$service" -a "$USER" -w &>/dev/null; then
      echo "  ✓ $service key found in macOS Keychain"
    elif [ "$required" = "required" ]; then
      echo "  ✗ $service key missing — run: security add-generic-password -s $service -a \"\$USER\" -w"
    else
      echo "  - $service key not set (optional)"
    fi
  }
  check_key "anthropic" "required"
  check_key "openai" "optional"
  check_key "pinecone" "optional"
  # minimax/deepseek keys are required when agentOptions.fallbackProvider uses those model prefixes
  check_key "minimax" "optional"
  check_key "deepseek" "optional"
else
  # --- linux (secret-tool) key check ---
  if command -v secret-tool &>/dev/null; then
    check_key() {
      local service="$1"
      local required="$2"
      if whatsoup_run_bounded 3 secret-tool lookup service "$service" &>/dev/null; then
        echo "  ✓ $service key found in keyring"
      elif [ "$required" = "required" ]; then
        echo "  ✗ $service key missing — run: secret-tool store --label='$service' service $service"
      else
        echo "  - $service key not set (optional)"
      fi
    }
    check_key "anthropic" "required"
    check_key "openai" "optional"
    check_key "pinecone" "optional"
    # minimax/deepseek keys are required when agentOptions.fallbackProvider uses those model prefixes
    check_key "minimax" "optional"
    check_key "deepseek" "optional"
  else
    echo "  Skipped — no secret-tool (set keys via environment variables)"
    echo "  Required: ANTHROPIC_API_KEY"
    echo "  Optional: OPENAI_API_KEY, PINECONE_API_KEY"
  fi
fi

echo ""
if [ "$all_steps" -ne 1 ]; then
  echo "Selected setup steps complete."
  exit 0
fi
echo "Setup complete. Next steps:"
echo ""
echo "  1. Start the fleet server:"
echo "     npm run fleet"
echo ""
echo "  2. Open http://localhost:9099 in your browser"
echo ""
echo "  3. Click 'Add Line' to create your first WhatsApp instance"
echo ""
echo "  4. Scan the QR code with WhatsApp → Linked Devices → Link a Device"
echo ""
if [ "$PLATFORM" = "Darwin" ]; then
  echo "  macOS: instances are managed via launchctl (plists auto-generated by the fleet)"
  echo "  macOS: maintenance timer plists are installed but not loaded; they activate on"
  echo "  next login, or load them now as a deployment step:"
  echo "     launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/com.whatsoup.harness-maintenance.plist"
  echo "     launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/com.whatsoup.reply-guarantee.plist"
  echo "  Verify:    launchctl print gui/\$(id -u)/com.whatsoup.harness-maintenance"
  echo "  Uninstall: deploy/setup.sh --remove-timers   (see docs/runbook.md §2)"
else
  echo "  To run the fleet server as a persistent background service:"
  echo "     systemctl --user enable --now whatsoup-fleet"
  echo "     systemctl --user status whatsoup-fleet"
  echo ""
  echo "  To run harness maintenance daily:"
  echo "     systemctl --user enable --now harness-maintenance.timer"
  echo "     whatsoup-harness-maintenance --check"
  echo ""
  echo "  To run reply-guarantee drain every minute:"
  echo "     systemctl --user enable --now whatsoup-reply-guarantee.timer"
  echo ""
  echo "  BOT ERRORS runs in IncidentStore authority observe mode by default: without enrolled"
  echo "  producers or credential files every notice is still sent, and each authority answer is"
  echo "  recorded. Enroll the dispatcher and Q-loop producers and write their credential files"
  echo "  before a host is switched to enforce (deploy/scripts/README-bot-errors.md)."
  echo "  To run BOT ERRORS monitoring after filling ~/.config/whatsoup/bot-errors.env:"
  echo "     systemctl --user enable --now bot-errors-dispatcher.service bot-errors-q-loop.service bot-errors-collector.service"
  echo "     systemctl --user enable --now bot-errors-deadman.timer bot-errors-health-check.timer bot-errors-heartbeat-watchdog.timer bot-errors-runtime-staleness.timer"
  echo ""
  echo "  To check the deployed release for drift and currency every 5 minutes (once per host):"
  echo "  the observer needs ~/.local/bin/whatsoup to point into an exported release that holds"
  echo "  .whatsoup-release-manifest.json. Setup has just pointed it at this tree, so on a host"
  echo "  installed from a clone every run raises manifest-missing and inconclusive alerts and"
  echo "  exits 2. Other causes fail the unit too, among them a missing or unsafe label, a runner,"
  echo "  observer or emit failure, a network failure or a timeout, and exit 1 from a release whose"
  echo "  scheduler predates --bootstrap-exit-code 2; docs/runbook.md describes each exit status."
  echo "  Give the timer the bot instance that labels its BOT ERRORS alerts (unless setup wrote"
  echo "  it from WHATSOUP_RELEASE_DRIFT_INSTANCE; this command never replaces an existing file):"
  echo "     (set -C; umask 077; echo WHATSOUP_RELEASE_DRIFT_INSTANCE=<instance> > ~/.config/whatsoup/release-drift.env)"
  echo "  then enable it:"
  echo "     systemctl --user enable --now whatsoup-release-drift.timer"
fi
echo ""
