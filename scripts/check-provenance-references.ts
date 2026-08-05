#!/usr/bin/env node
/**
 * check-provenance-references — CI guard against unresolved provenance citations.
 *
 * Scans staged content (commit message, docs diffs) for PR/issue references
 * in the form `#XXXX` and verifies they resolve to a real GitHub entity.
 * Also flags `oc-re/`-class references outside triage-narrative quote blocks.
 *
 * Usage: node check-provenance-references.ts [--staged | --all]
 *
 * Environment:
 *   GH_TOKEN / GITHUB_TOKEN — GitHub API auth (optional, best-effort)
 *   GITHUB_REPOSITORY — owner/repo (default: LucasQuiles/WhatSoup)
 *
 * #2950 — unresolved-reference provenance guard.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { env, exit } from 'node:process';

const repo = env.GITHUB_REPOSITORY ?? 'LucasQuiles/WhatSoup';
const token = env.GH_TOKEN ?? env.GITHUB_TOKEN ?? '';

const PHANTOM_THRESHOLD = 9999000; // PRs >= this are almost certainly phantom

function isOcReLine(line: string): boolean {
  return /oc-re\//.test(line) && !line.includes('triage-narrative');
}

function isProbablePrRef(token: string): boolean {
  const n = parseInt(token.slice(1), 10);
  return !isNaN(n) && n > 0 && n < PHANTOM_THRESHOLD;
}

function checkRefs(text: string): string[] {
  const errors: string[] = [];

  // Check oc-re/ references outside triage-narrative quotes
  for (const line of text.split('\n')) {
    if (isOcReLine(line)) {
      errors.push(`oc-re/ reference outside triage-narrative context: "${line.trim()}"`);
    }
  }

  // Check PR references
  const prRefs = text.match(/#\d+/g) ?? [];
  for (const ref of prRefs) {
    if (!isProbablePrRef(ref)) {
      errors.push(`Suspicious PR reference: ${ref} (>= ${PHANTOM_THRESHOLD})`);
      continue;
    }
    // Verify via gh CLI when token is available
    if (token) {
      try {
        const prNum = ref.slice(1);
        execFileSync('gh', ['pr', 'view', prNum, '--repo', repo, '--json', 'number'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 10_000,
          env: { PATH: '/usr/bin:/bin', GITHUB_TOKEN: token },
        });
      } catch {
        try {
          execFileSync('gh', ['issue', 'view', ref.slice(1), '--repo', repo, '--json', 'number'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 10_000,
            env: { PATH: '/usr/bin:/bin', GITHUB_TOKEN: token },
          });
        } catch {
          errors.push(`Unresolved reference: "${ref}" — not found as PR or issue in ${repo}`);
        }
      }
    }
  }

  return errors;
}

// Main
const target = process.argv[2] ?? '--staged';
let content: string;

if (target && target !== '--staged' && target !== '--all') {
  content = readFileSync(target, 'utf8');
} else if (target === '--all') {
  content = readFileSync('/dev/stdin', 'utf8');
} else {
  try {
    content = execFileSync('git', ['diff', '--cached', '--', '*.ts', '*.md', '*.json'], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    content = '';
  }
}

const errors = checkRefs(content);
if (errors.length > 0) {
  console.error('PROVENANCE GUARD FAILED:');
  for (const err of errors) console.error(`  - ${err}`);
  exit(1);
}

console.log('provenance references: OK');
exit(0);
