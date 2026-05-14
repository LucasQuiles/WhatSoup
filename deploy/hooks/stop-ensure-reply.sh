#!/usr/bin/env bash
set +e

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$HERE/stop-ensure-reply.mjs"
exit 0
