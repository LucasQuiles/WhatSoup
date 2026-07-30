import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createChildLogger } from '../logger.ts';
import { cleanGitEnv } from '../lib/git-env.ts';
import {
  DEFAULT_UPDATE_BRANCH,
  githubPublicHttpsUrlFromRemote,
  publicFetchArgs,
  shouldRetryWithPublicHttps,
} from '../lib/git-public-remote.ts';

const execFileAsync = promisify(execFile);
const log = createChildLogger('update-checker');

export interface UpdateState {
  sha: string;
  remoteSha: string;
  updateAvailable: boolean;
  checkedAt: string;
}

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes

export class UpdateChecker {
  private repoRoot: string;
  private state: UpdateState = {
    sha: 'unknown',
    remoteSha: 'unknown',
    updateAvailable: false,
    checkedAt: '',
  };
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
  }

  getState(): UpdateState {
    return { ...this.state };
  }

  async checkNow(): Promise<UpdateState> {
    try {
      const localSha = await this.execGit(['rev-parse', '--short', 'HEAD']);
      this.state.sha = localSha;

      try {
        await this.fetchOriginMain();
        const remoteSha = await this.execGit(['rev-parse', '--short', 'origin/main']);
        this.state.remoteSha = remoteSha;
        // Only flag update if remote has commits we don't have (remote is ahead).
        // `rev-list HEAD..origin/main` counts commits on remote not reachable from local.
        const behind = await this.execGit(['rev-list', '--count', 'HEAD..origin/main']);
        this.state.updateAvailable = parseInt(behind, 10) > 0;
      } catch (err) {
        log.warn({ err }, 'git fetch failed — skipping remote check');
        this.state.remoteSha = 'unknown';
        this.state.updateAvailable = false;
      }

      this.state.checkedAt = new Date().toISOString();
    } catch (err) {
      log.error({ err }, 'failed to read local git SHA');
    }
    return this.getState();
  }

  start(): void {
    if (this.timer) return;
    this.checkNow().catch((err) => log.warn({ err }, 'update-checker: initial check failed'));
    this.timer = setInterval(() => {
      this.checkNow().catch((err) => log.warn({ err }, 'update-checker: periodic check failed'));
    }, CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  protected async execGit(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd: this.repoRoot,
      timeout: 30_000,
      env: cleanGitEnv(),
    });
    return stdout.trim();
  }

  private async fetchOriginMain(): Promise<void> {
    try {
      await this.execGit(['fetch', 'origin', DEFAULT_UPDATE_BRANCH, '--quiet']);
      return;
    } catch (err) {
      if (!shouldRetryWithPublicHttps(err)) {
        throw err;
      }

      let remoteUrl: string;
      try {
        remoteUrl = await this.execGit(['remote', 'get-url', 'origin']);
      } catch {
        throw err;
      }
      const publicUrl = githubPublicHttpsUrlFromRemote(remoteUrl);
      if (!publicUrl) {
        throw err;
      }

      await this.execGit(publicFetchArgs(publicUrl, DEFAULT_UPDATE_BRANCH));
      log.warn({ publicUrl }, 'git SSH fetch failed; retried update check through public HTTPS');
    }
  }
}
