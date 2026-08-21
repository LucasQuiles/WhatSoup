import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

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

  const effectiveCwd = input.cwd?.trim() || homePath;
  if (!path.isAbsolute(effectiveCwd) || effectiveCwd === '~' || effectiveCwd.startsWith('~/')) {
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
