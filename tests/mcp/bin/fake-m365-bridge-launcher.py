#!/usr/bin/env python3
"""Fixture for the pinned Agent365 bridge launcher invocation."""

import os
import shutil
import sys


if len(sys.argv) != 5 or sys.argv[1] != "--config" or sys.argv[3] != "--":
    raise SystemExit("unexpected bridge launcher arguments")

node = shutil.which("node")
if not node:
    raise SystemExit("node is missing from the launcher PATH")

os.execv(node, [node, sys.argv[4]])
