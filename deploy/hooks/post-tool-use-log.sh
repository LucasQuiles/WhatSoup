#!/usr/bin/env bash
set +e

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$HERE/post-tool-use-log.mjs"
exit 0
