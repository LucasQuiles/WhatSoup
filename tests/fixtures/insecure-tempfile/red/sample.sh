#!/usr/bin/env bash
echo hello > /tmp/red-fixture-sh   # sh-redirect
work=$(mktemp)                     # sh-mktemp (no template/dir)
