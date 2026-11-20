import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { expandHomePath } from '../lib/home-path.ts';

export type AgentInstructionsPathFailureReason =
  | 'blank'
  | 'ambiguous_cwd'
  | 'outside_home'
  | 'missing'
  | 'not_regular_file'
  | 'unreadable'
  | 'invalid_home';

export type AgentInstructionsPathValidation =
  | { ok: true; resolvedPath: string }
  | { ok: false; reason: AgentInstructionsPathFailureReason };

export interface AgentInstructionsPathInput {
  instructionsPath: string;
  cwd?: string;
  homeDirectory: string;
}

export function resolveAgentInstructionsPath(input: AgentInstructionsPathInput): string {
  const configuredPath = input.instructionsPath.trim();
  if (path.isAbsolute(configuredPath)) return path.normalize(configuredPath);
  return path.resolve(input.cwd?.trim() || input.homeDirectory, configuredPath);
}

/**
 * Where a sandboxPerChat session's `instructionsPath` is decided. The session
 * resolves a relative path against its per-chat workspace, which does not exist
 * when config loads.
 * - `checked_at_load`: blank and `~` forms (refused wherever they would be
 *   read), absolute paths, and a relative path that normalizes to CLAUDE.md,
 *   which provisioning links in every workspace to `<cwd>/CLAUDE.md`.
 * - `outside_chat_workspace`: any other relative path that, after trimming, is
 *   not in normal form (`path.normalize` would change it) or has a `..`
 *   segment. Only a normal-form path with no `..` segment stays lexically inside
 *   the workspace, so config load, the restart preflight and the session's read
 *   each refuse the rest.
 * - `chat_workspace`: every other relative path, which only the session reads.
 */
export type SandboxInstructionsPathKind = 'checked_at_load' | 'chat_workspace' | 'outside_chat_workspace';

export function sandboxInstructionsPathKind(instructionsPath: string): SandboxInstructionsPathKind {
  const configuredPath = instructionsPath.trim();
  if (!configuredPath || configuredPath === '~' || configuredPath.startsWith('~/')) return 'checked_at_load';
  if (path.isAbsolute(configuredPath) || path.normalize(configuredPath) === 'CLAUDE.md') return 'checked_at_load';
  const confined = path.normalize(configuredPath) === configuredPath && !configuredPath.split('/').includes('..');
  return confined ? 'chat_workspace' : 'outside_chat_workspace';
}

function isAtOrInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function validateAgentInstructionsPath(
  input: AgentInstructionsPathInput,
): AgentInstructionsPathValidation {
  const configuredPath = input.instructionsPath.trim();
  if (!configuredPath) return { ok: false, reason: 'blank' };
  if (configuredPath === '~' || configuredPath.startsWith('~/')) {
    return { ok: false, reason: 'outside_home' };
  }

  const homePath = path.resolve(input.homeDirectory);
  let homeReal: string;
  try {
    homeReal = realpathSync(homePath);
  } catch {
    return { ok: false, reason: 'invalid_home' };
  }

  // main.ts expands a `~` cwd before the session reads the file, so the check
  // expands it the same way; any other relative cwd has no known read location.
  const configuredCwd = input.cwd?.trim();
  const effectiveCwd = configuredCwd ? expandHomePath(configuredCwd, homePath) : homePath;
  if (!path.isAbsolute(effectiveCwd)) {
    return { ok: false, reason: 'ambiguous_cwd' };
  }

  const resolvedPath = resolveAgentInstructionsPath({ ...input, cwd: effectiveCwd });
  if (!isAtOrInside(resolvedPath, homePath)) {
    return { ok: false, reason: 'outside_home' };
  }

  let targetReal: string;
  try {
    const stat = statSync(resolvedPath);
    if (!stat.isFile()) return { ok: false, reason: 'not_regular_file' };
    targetReal = realpathSync(resolvedPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'missing' };
    return { ok: false, reason: 'unreadable' };
  }

  if (!isAtOrInside(targetReal, homeReal)) {
    return { ok: false, reason: 'outside_home' };
  }

  try {
    accessSync(targetReal, constants.R_OK);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }

  return { ok: true, resolvedPath: targetReal };
}
