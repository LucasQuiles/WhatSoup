// WhatSoup — restart-safety import-closure probe.
//
// Imports the live startup entrypoint (src/main.ts) and classifies the outcome so
// the pre-flight gate can decide whether the on-disk tree is safe to start.
//
// Invoked by deploy/preflight-check.sh as:
//   <pinned-node> --experimental-strip-types preflight-probe.ts <abs-path-to-main.ts>
//
// It is kept as a standalone file (not an inline `node -e` string) so the probe
// logic is lintable/testable and so the wrapper script stays free of embedded JS.
//
// Exit codes (consumed by preflight-check.sh):
//   0  SAFE     — import graph fully linked (resolved, or stopped at credential/env init)
//   3  LANDMINE — phantom module / missing export on the live import path
//   4  DEPS     — node_modules not installed (distinct, recoverable with `npm ci`)
//   5  UNKNOWN  — unclassified import-time failure (caller fails closed)

const target = process.argv[2];

if (!target) {
  console.error('PREFLIGHT-PROBE: ERROR no entrypoint path argument');
  process.exit(5);
}

// A credential/env init failure means every import RESOLVED and the module graph
// linked — the tree is import-clean and therefore safe to start.
const SAFE_RE =
  /Missing credentials|OPENAI_API_KEY|ANTHROPIC_API_KEY|PINECONE_API_KEY|environment variable|\bapiKey\b/i;
// Dependencies not installed — recoverable, but not safe to start as-is.
const DEPS_RE = /Cannot find package/i;
// A phantom module or missing export on the live import path — the landmine class.
const LANDMINE_RE = /does not provide an export|Cannot find module|ERR_MODULE_NOT_FOUND/i;

import(target)
  .then(() => {
    console.error('PREFLIGHT-PROBE: RESOLVED-OK');
    process.exit(0);
  })
  .catch((e: unknown) => {
    const err = e as { message?: unknown; code?: unknown };
    const msg =
      err && typeof err.message === 'string' ? err.message : String(e);
    if (SAFE_RE.test(msg)) {
      console.error('PREFLIGHT-PROBE: CRED-OK ' + msg);
      process.exit(0);
    }
    if (DEPS_RE.test(msg)) {
      console.error('PREFLIGHT-PROBE: DEPS-MISSING ' + msg);
      process.exit(4);
    }
    if (LANDMINE_RE.test(msg) || err.code === 'ERR_MODULE_NOT_FOUND') {
      console.error('PREFLIGHT-PROBE: LANDMINE ' + msg);
      process.exit(3);
    }
    console.error('PREFLIGHT-PROBE: UNKNOWN ' + msg);
    process.exit(5);
  });
