const gitChildEnvKeys = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'NODE_PATH',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'SSH_AUTH_SOCK',
  'SUDO_ASKPASS',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
] as const;

// GIT_OPTIONAL_LOCKS is set, never inherited: `git status` otherwise takes
// index.lock to write refreshed stat data, and a child killed by an
// uncatchable signal strands that lock for every later commit. Writes (add,
// commit, checkout) still lock the index.
// Git documents the variable for status; a worktree `git diff` still rewrites the index.
export function cleanGitEnv(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      gitChildEnvKeys
        // env-allowed: build-meta env lookup; bounded key list for git identity
        .map((key) => [key, process.env[key]] as const)
        .filter(([, value]) => value !== undefined),
    ),
    GIT_OPTIONAL_LOCKS: '0',
  } as NodeJS.ProcessEnv;
}

const FULL_GIT_SHA_RE = /^[0-9a-f]{40}$/i;

function readNonEmptyEnv(name: string): string | null {
  // env-allowed: build-meta env lookup; bounded key list for git identity
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function readWhatsoupGitSha(): string | null {
  const value = readNonEmptyEnv('WHATSOUP_GIT_SHA') ?? readNonEmptyEnv('GIT_SHA');
  if (!value || !FULL_GIT_SHA_RE.test(value)) return null;
  return value.toLowerCase();
}

export function readWhatsoupGitBranch(): string | null {
  return readNonEmptyEnv('WHATSOUP_GIT_BRANCH');
}
