#!/bin/bash
# tmux-helpers.sh — Tmux utility functions for tmup

# Check if a process in a pane is an agent (not a shell)
is_agent_process() {
  local cmd="${1:-}"
  case "$cmd" in
    codex|node|npm|npx) return 0 ;;
    *) return 1 ;;
  esac
}

# Wait for a pane to be at a shell prompt
wait_for_shell_ready() {
  local session="$1" pane="$2" max_wait="${3:-5}"
  local waited=0
  while [[ $waited -lt $max_wait ]]; do
    local cmd
    cmd=$(tmux display-message -t "$session:0.$pane" -p '#{pane_current_command}' 2>/dev/null) || cmd=""
    case "$cmd" in
      bash|zsh|sh|fish) return 0 ;;
    esac
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

# Strip ANSI escape codes from text
strip_ansi() {
  sed 's/\x1b\[[0-9;]*[a-zA-Z]//g; s/\x1b\][^\x07]*\x07//g'
}

# Get the actual running command in a pane (walks process tree)
get_pane_command() {
  local session="${1:-}" pane_index="${2:-0}"
  local target="${session}:0.${pane_index}"
  tmux display-message -t "$target" -p '#{pane_current_command}' 2>/dev/null || echo ""
}

capture_pane_scrollback() {
  local target="${1:-}" start="${2:--20}"
  tmux capture-pane -t "$target" -p -S "$start" 2>/dev/null | strip_ansi
}

codex_scrollback_shows_work() {
  local scrollback="${1:-}"

  if echo "$scrollback" | grep -qF "Working ("; then
    return 0
  fi

  # Tool execution lines are a second strong signal that Codex accepted the submit.
  if echo "$scrollback" | grep -qiE \
    'functions\.[a-z_]+|multi_tool_use\.parallel|web\.(search_query|image_query|open|click|find|screenshot|sports|finance|weather|time)|apply_patch|exec_command|write_stdin|spawn_agent|send_input|wait_agent|read_mcp_resource|list_mcp_resources|list_mcp_resource_templates|update_plan'; then
    return 0
  fi

  return 1
}

codex_scrollback_shows_idle_prompt() {
  local scrollback="${1:-}"
  if codex_scrollback_shows_work "$scrollback"; then
    return 1
  fi
  echo "$scrollback" | grep -qE '❯|›'
}

wait_for_codex_submit_confirmation() {
  local session="${1:-}" pane_index="${2:-0}" delay_seconds="${3:-2}"
  local target="${session}:0.${pane_index}"
  local scrollback

  sleep "$delay_seconds"
  scrollback=$(capture_pane_scrollback "$target" "-40") || scrollback=""
  codex_scrollback_shows_work "$scrollback"
}

# Check if a pane is at an idle shell prompt
is_shell_ready() {
  local session="$1" pane_index="${2:-0}"
  local cmd
  cmd=$(get_pane_command "$session" "$pane_index")
  case "$cmd" in
    bash|zsh|sh|fish|"") return 0 ;;
    *) return 1 ;;
  esac
}

# Check if an agent in a pane is idle (not actively "Working")
is_agent_idle() {
  local session="$1" pane_index="${2:-0}"
  local target="${session}:0.${pane_index}"
  local scrollback
  scrollback=$(capture_pane_scrollback "$target" "-20") || return 1
  codex_scrollback_shows_idle_prompt "$scrollback"
}

# Clear any stale input from a pane
clear_pane_input() {
  local session="$1" pane_index="${2:-0}"
  local target="${session}:0.${pane_index}"
  tmux send-keys -t "$target" C-u 2>/dev/null || true
  sleep 0.1
}

send_codex_prompt_with_retry() {
  local session="${1:-}" pane_index="${2:-0}" prompt_text="${3:-}" mode="${4:-dispatch}"
  local target="${session}:0.${pane_index}"
  local max_full_retries=1
  local failure_message="failed to confirm Codex accepted the prompt"

  if [[ -z "$session" || -z "$prompt_text" ]]; then
    echo "send_codex_prompt_with_retry: session and prompt_text required" >&2
    return 1
  fi

  case "$mode" in
    dispatch)
      max_full_retries=3
      failure_message="failed to confirm Codex accepted the initial prompt"
      ;;
    reprompt)
      max_full_retries=1
      failure_message="failed to confirm Codex accepted the reprompt"
      ;;
    *)
      echo "send_codex_prompt_with_retry: unknown mode '$mode'" >&2
      return 1
      ;;
  esac

  local full_retry
  for full_retry in $(seq 1 "$max_full_retries"); do
    if [[ "$full_retry" -gt 1 ]]; then
      tmux send-keys -t "$target" C-c 2>/dev/null || true
      sleep 0.2
    fi

    clear_pane_input "$session" "$pane_index"

    if ! tmux send-keys -l -t "$target" "$prompt_text" 2>/dev/null; then
      echo "send_codex_prompt_with_retry: failed to send text to $target" >&2
      return 1
    fi

    sleep 0.2

    local submit_attempt
    for submit_attempt in 1 2 3; do
      if [[ "$mode" == "dispatch" && "$submit_attempt" -eq 2 ]]; then
        tmux send-keys -t "$target" S-Tab 2>/dev/null || true
        sleep 0.2
      fi

      tmux send-keys -t "$target" Enter 2>/dev/null || true
      if wait_for_codex_submit_confirmation "$session" "$pane_index" 2; then
        return 0
      fi
    done
  done

  echo "send_codex_prompt_with_retry: ${failure_message}" >&2
  return 1
}

# Send a follow-up prompt to a running agent
# Args: session pane_index prompt_text
# Returns: 0 on success, 1 on failure
send_reprompt() {
  local session="${1:-}" pane_index="${2:-0}" prompt_text="${3:-}"

  if [[ -z "$session" || -z "$prompt_text" ]]; then
    echo "send_reprompt: session and prompt_text required" >&2
    return 1
  fi

  # Verify session exists
  if ! tmux has-session -t "$session" 2>/dev/null; then
    echo "send_reprompt: session '$session' does not exist" >&2
    return 1
  fi

  local target="${session}:0.${pane_index}"

  # Guard: pane must be running a process, NOT at an idle shell prompt
  if is_shell_ready "$session" "$pane_index"; then
    echo "send_reprompt: pane $target is at shell prompt, not a running agent" >&2
    return 1
  fi

  # Guard: agent must be idle (not actively working)
  if ! is_agent_idle "$session" "$pane_index"; then
    echo "send_reprompt: pane $target is not at an idle Codex prompt" >&2
    return 1
  fi

  send_codex_prompt_with_retry "$session" "$pane_index" "$prompt_text" "reprompt"
}
