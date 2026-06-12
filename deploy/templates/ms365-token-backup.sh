#!/usr/bin/env bash
# ms365-token-backup.sh — backs up MS365 MCP token files nightly.
# Retains the 14 most-recent copies of each file; older copies are pruned.
#
# Install to: ~/.local/bin/ms365-token-backup
# chmod +x after writing.
set -e

SRC="$HOME/.ms365-mcp"
DST="$HOME/.ms365-mcp-backups"

mkdir -p "$DST"
chmod 700 "$DST"

TS=$(date +%Y%m%dT%H%M%S)

[ -s "$SRC/token-cache.json" ]       && cp -p "$SRC/token-cache.json"       "$DST/token-cache.json.$TS"
[ -s "$SRC/selected-account.json" ]  && cp -p "$SRC/selected-account.json"  "$DST/selected-account.json.$TS"

# Keep 14 copies (two weeks of daily backups).
ls -t "$DST"/token-cache.json.*      2>/dev/null | tail -n +15 | xargs -r rm -f
ls -t "$DST"/selected-account.json.* 2>/dev/null | tail -n +15 | xargs -r rm -f

echo "[$(date +%FT%T)] backed up to $DST"
