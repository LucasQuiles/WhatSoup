export const DEFAULT_UPDATE_BRANCH = 'main';

export function gitErrorText(err: unknown): string {
  if (!err || typeof err !== 'object') {
    return String(err ?? '');
  }

  const record = err as Record<string, unknown>;
  return [record.stderr, record.stdout, record.message]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n');
}

export function shouldRetryWithPublicHttps(err: unknown): boolean {
  const text = gitErrorText(err);
  return /Permission denied \(publickey\)/i.test(text)
    || /publickey/i.test(text);
}

export function githubPublicHttpsUrlFromRemote(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();

  const httpsMatch = trimmed.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (httpsMatch) {
    return `https://github.com/${httpsMatch[1]}/${httpsMatch[2]}.git`;
  }

  const scpLikeMatch = trimmed.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (scpLikeMatch) {
    return `https://github.com/${scpLikeMatch[1]}/${scpLikeMatch[2]}.git`;
  }

  const sshMatch = trimmed.match(/^ssh:\/\/git@github\.com(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}/${sshMatch[2]}.git`;
  }

  return null;
}

export function publicFetchArgs(publicUrl: string, branch = DEFAULT_UPDATE_BRANCH): string[] {
  return ['fetch', publicUrl, `${branch}:refs/remotes/origin/${branch}`, '--quiet'];
}
