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
 * Whether a sandboxPerChat session reads `instructionsPath` only inside a
 * per-chat workspace, which does not exist when config loads. The session
 * resolves a relative path against that workspace; the one relative file known
 * there is CLAUDE.md, which provisioning links to `<cwd>/CLAUDE.md`. Blank and
 * `~` forms are refused wherever they would be read, so they stay checked.
 */
export function isReadOnlyFromChatWorkspace(instructionsPath: string): boolean {
  const configuredPath = instructionsPath.trim();
  if (!configuredPath || configuredPath === '~' || configuredPath.startsWith('~/')) return false;
  return !path.isAbsolute(configuredPath) && path.normalize(configuredPath) !== 'CLAUDE.md';
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
