#!/usr/bin/env bash
PATTERN='constructor\s*\([^)]*\b(private|public|protected|readonly)\s'
staged=$(git diff --cached --name-only --diff-filter=ACM -- '*.ts' 2>/dev/null || true)
[ -z "$staged" ] && exit 0
matches=""
for f in $staged; do
  hit=$(grep -n -E "$PATTERN" "$f" 2>/dev/null || true)
  [ -n "$hit" ] && matches="${matches}${f}:${hit}\n"
done
if [ -n "$matches" ]; then
  echo "Pre-commit: TypeScript parameter properties detected:"
  echo -e "$matches"
  exit 1
fi
