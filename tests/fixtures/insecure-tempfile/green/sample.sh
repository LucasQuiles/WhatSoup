#!/usr/bin/env bash
d=$(mktemp -d)                       # secure: private dir
f=$(mktemp "${TMPDIR:-/tmp}/safe.XXXXXX")  # templated
# /tmp/foo in a comment is fine
