#!/usr/bin/env bash
echo hello > /tmp/red-fixture-sh   # sh-redirect
work=$(mktemp)                     # sh-mktemp (no template/dir)
tee -a /tmp/tee-append-flag        # FN-4a: tee with short flag; sh-redirect
tee --append /tmp/tee-long-flag    # FN-4b: tee with long flag; sh-redirect
