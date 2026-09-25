// scripts/terminal-latch-cli.ts
//
// Owner-only CLI over the terminal-latch journal (T3.2 of the q-canary
// re-pair enablement lane). There is NO raw JSON-edit procedure for the
// journal: inspect reads, plan-* prints the exact transition that would be
// appended, apply-* appends under expected-revision CAS with a single-use
// operation id. Every apply requires an authorization id; release records it
// durably in the transition, create echoes it into the result for the
// operator's receipt capture (the latch_created contract deliberately carries
// no authorization field — creation authority is the operational procedure,
// release authority is the recorded fact).
//
// Exit codes: 0 success; 2 refused (bad usage, invalid input, or a journal
// refusal — the refusal name is printed on stderr).

import { pathToFileURL } from 'node:url';
import {
  appendLatchTransition,
  readTerminalLatchJournal,
  terminalLatchJournalPath,
  TERMINAL_LATCH_REASONS,
  type LatchTransitionV1,
  type TerminalLatchReason,
  type TerminalLatchV1,
} from '../src/transport/terminal-latch.ts';
import { computeCredentialTreeDigest } from '../src/transport/auth-generation-v2.ts';
import { parseAccountScopeId } from '../src/transport/auth-custody-contracts.ts';

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const COMMANDS = ['inspect', 'plan-create', 'apply-create', 'plan-release', 'apply-release'] as const;
type Command = (typeof COMMANDS)[number];

const KNOWN_FLAGS = new Set([
  '--state-root',
  '--scope',
  '--revoked-tree',
  '--revoked-digest',
  '--latched-generation',
  '--reason',
  '--evidence-digest',
  '--authorization-id',
  '--owner-authorization-id',
  '--operation-id',
  '--expected-revision',
  '--at',
]);

const HEX64_RE = /^[0-9a-f]{64}$/;

function usage(io: CliIo): number {
  io.stderr('usage: terminal-latch-cli <inspect|plan-create|apply-create|plan-release|apply-release> --state-root <dir> [flags]');
  io.stderr('  create flags: --scope --revoked-tree <dir>|--revoked-digest <hex64> --reason <' + TERMINAL_LATCH_REASONS.join('|') + '> --evidence-digest <hex64> [--latched-generation <id>]');
  io.stderr('  apply-create adds: --authorization-id --operation-id --expected-revision');
  io.stderr('  apply-release adds: --owner-authorization-id --operation-id --expected-revision');
  io.stderr('  [--at <ISO>] pins the transition timestamp (defaults to now)');
  return 2;
}

function parseFlags(args: string[], io: CliIo): Map<string, string> | null {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!KNOWN_FLAGS.has(key)) {
      io.stderr(`unknown flag: ${key}`);
      return null;
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      io.stderr(`flag ${key} requires a value`);
      return null;
    }
    if (flags.has(key)) {
      io.stderr(`duplicate flag: ${key}`);
      return null;
    }
    flags.set(key, value);
  }
  return flags;
}

function requireFlag(flags: Map<string, string>, key: string, io: CliIo): string | null {
  const value = flags.get(key);
  if (value === undefined || value.length === 0) {
    io.stderr(`missing required flag: ${key}`);
    return null;
  }
  return value;
}

function resolveRevokedDigest(flags: Map<string, string>, io: CliIo): string | null {
  const fromTree = flags.get('--revoked-tree');
  const explicit = flags.get('--revoked-digest');
  if (fromTree !== undefined && explicit !== undefined) {
    io.stderr('--revoked-tree and --revoked-digest are mutually exclusive');
    return null;
  }
  if (explicit !== undefined) {
    if (!HEX64_RE.test(explicit)) {
      io.stderr('--revoked-digest must be 64 lowercase hex chars');
      return null;
    }
    return explicit;
  }
  if (fromTree === undefined) {
    io.stderr('one of --revoked-tree or --revoked-digest is required');
    return null;
  }
  const digest = computeCredentialTreeDigest(fromTree);
  if (!digest.ok) {
    io.stderr(`cannot digest revoked tree: ${digest.failure}`);
    return null;
  }
  return digest.digest;
}

function buildLatch(flags: Map<string, string>, io: CliIo, at: string): TerminalLatchV1 | null {
  const scopeRaw = requireFlag(flags, '--scope', io);
  if (scopeRaw === null) return null;
  const scopeId = parseAccountScopeId(scopeRaw);
  if (scopeId === null) {
    io.stderr('invalid --scope (opaque configured scope id required)');
    return null;
  }
  const reasonRaw = requireFlag(flags, '--reason', io);
  if (reasonRaw === null) return null;
  const reason = TERMINAL_LATCH_REASONS.find(r => r === reasonRaw) as TerminalLatchReason | undefined;
  if (reason === undefined) {
    io.stderr(`invalid --reason (expected one of ${TERMINAL_LATCH_REASONS.join(', ')})`);
    return null;
  }
  const evidenceDigest = requireFlag(flags, '--evidence-digest', io);
  if (evidenceDigest === null) return null;
  if (!HEX64_RE.test(evidenceDigest)) {
    io.stderr('--evidence-digest must be 64 lowercase hex chars');
    return null;
  }
  const latchedCredentialTreeDigest = resolveRevokedDigest(flags, io);
  if (latchedCredentialTreeDigest === null) return null;
  return {
    v: 1,
    scopeId,
    latchedGenerationId: flags.get('--latched-generation') ?? null,
    latchedCredentialTreeDigest,
    reason,
    evidenceDigest,
    latchedAt: at,
  };
}

export function runTerminalLatchCli(argv: string[], io: CliIo): number {
  const command = argv[0] as Command | undefined;
  if (command === undefined || !COMMANDS.includes(command)) return usage(io);
  const flags = parseFlags(argv.slice(1), io);
  if (flags === null) return usage(io);
  const stateRoot = requireFlag(flags, '--state-root', io);
  if (stateRoot === null) return usage(io);
  const at = flags.get('--at') ?? new Date().toISOString();

  const state = readTerminalLatchJournal(stateRoot);
  if (command === 'inspect') {
    io.stdout(JSON.stringify({
      journalPath: terminalLatchJournalPath(stateRoot),
      state,
    }, null, 2));
    return 0;
  }

  const currentRevision = state.status === 'corrupt' ? null : state.revision;

  if (command === 'plan-create' || command === 'apply-create') {
    const latch = buildLatch(flags, io, at);
    if (latch === null) return 2;
    if (command === 'plan-create') {
      if (currentRevision === null) {
        io.stderr('journal is corrupt; no plan can be offered (preserve the bytes for forensics)');
        return 2;
      }
      const plan: LatchTransitionV1 = {
        v: 1,
        scopeId: latch.scopeId,
        kind: 'latch_created',
        revision: currentRevision + 1,
        expectedPriorRevision: currentRevision,
        at,
        operationId: '<single-use operation id required at apply>',
        ownerAuthorizationId: null,
        latch,
        supersededByGenerationId: null,
      };
      io.stdout(JSON.stringify({ plan, note: 'nothing written; use apply-create' }, null, 2));
      return 0;
    }
    const authorizationId = requireFlag(flags, '--authorization-id', io);
    const operationId = requireFlag(flags, '--operation-id', io);
    const expectedRevisionRaw = requireFlag(flags, '--expected-revision', io);
    if (authorizationId === null || operationId === null || expectedRevisionRaw === null) return 2;
    const expectedPriorRevision = Number(expectedRevisionRaw);
    if (!Number.isInteger(expectedPriorRevision) || expectedPriorRevision < 0) {
      io.stderr('--expected-revision must be a non-negative integer');
      return 2;
    }
    const result = appendLatchTransition(stateRoot, {
      v: 1,
      scopeId: latch.scopeId,
      kind: 'latch_created',
      revision: expectedPriorRevision + 1,
      expectedPriorRevision,
      at,
      operationId,
      ownerAuthorizationId: null,
      latch,
      supersededByGenerationId: null,
    });
    if (!result.ok) {
      io.stderr(`apply-create refused: ${result.refusal}`);
      return 2;
    }
    io.stdout(JSON.stringify({ ok: true, authorizationId, operationId, state: result.state }, null, 2));
    return 0;
  }

  // plan-release / apply-release
  const scopeRaw = requireFlag(flags, '--scope', io);
  if (scopeRaw === null) return 2;
  const scopeId = parseAccountScopeId(scopeRaw);
  if (scopeId === null) {
    io.stderr('invalid --scope (opaque configured scope id required)');
    return 2;
  }
  if (command === 'plan-release') {
    if (currentRevision === null) {
      io.stderr('journal is corrupt; no plan can be offered (preserve the bytes for forensics)');
      return 2;
    }
    io.stdout(JSON.stringify({
      plan: {
        v: 1,
        scopeId,
        kind: 'owner_released',
        revision: currentRevision + 1,
        expectedPriorRevision: currentRevision,
        at,
        operationId: '<single-use operation id required at apply>',
        ownerAuthorizationId: '<owner authorization id required at apply>',
        latch: null,
        supersededByGenerationId: null,
      },
      note: 'nothing written; use apply-release',
    }, null, 2));
    return 0;
  }
  const ownerAuthorizationId = requireFlag(flags, '--owner-authorization-id', io);
  const operationId = requireFlag(flags, '--operation-id', io);
  const expectedRevisionRaw = requireFlag(flags, '--expected-revision', io);
  if (ownerAuthorizationId === null || operationId === null || expectedRevisionRaw === null) return 2;
  const expectedPriorRevision = Number(expectedRevisionRaw);
  if (!Number.isInteger(expectedPriorRevision) || expectedPriorRevision < 0) {
    io.stderr('--expected-revision must be a non-negative integer');
    return 2;
  }
  const result = appendLatchTransition(stateRoot, {
    v: 1,
    scopeId,
    kind: 'owner_released',
    revision: expectedPriorRevision + 1,
    expectedPriorRevision,
    at,
    operationId,
    ownerAuthorizationId,
    latch: null,
    supersededByGenerationId: null,
  });
  if (!result.ok) {
    io.stderr(`apply-release refused: ${result.refusal}`);
    return 2;
  }
  io.stdout(JSON.stringify({ ok: true, ownerAuthorizationId, operationId, state: result.state }, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = runTerminalLatchCli(process.argv.slice(2), {
    stdout: line => console.log(line),
    stderr: line => console.error(line),
  });
  process.exitCode = code;
}
