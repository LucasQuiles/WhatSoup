#!/usr/bin/env bash
d=$(mktemp -d)                       # secure: private dir
f=$(mktemp "${TMPDIR:-/tmp}/safe.XXXXXX")  # templated (TMPDIR + .XXX)
f2=$(mktemp /tmp/safeXXXXXX)        # FP-1 safe: X-run template, no dot separator
# /tmp/foo in a comment is fine
