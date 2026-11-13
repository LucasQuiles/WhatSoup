import type { MessagingDeps, PollRegistrar } from '../../src/mcp/tools/messaging.ts';

type FakeRegisterCall = {
  pollId: string;
  chatJid: string;
  options: string[];
  resolution: string;
  timeoutMs: number;
  abortSignal: AbortSignal | undefined;
};

type FakePollRegistrar = PollRegistrar & {
  calls: FakeRegisterCall[];
  resolveLast(answer: string): void;
  rejectLast(err: Error): void;
};

export function makeFakePollRegistrar(): FakePollRegistrar {
  const calls: FakeRegisterCall[] = [];
  let pendingResolve: ((answer: string) => void) | null = null;
  let pendingReject: ((err: Error) => void) | null = null;
  const registrar: FakePollRegistrar = {
    calls,
    resolveLast(answer: string): void {
      if (!pendingResolve) throw new Error('no pending registrar call to resolve');
      pendingResolve(answer);
      pendingResolve = null;
      pendingReject = null;
    },
    rejectLast(err: Error): void {
      if (!pendingReject) throw new Error('no pending registrar call to reject');
      pendingReject(err);
      pendingResolve = null;
      pendingReject = null;
    },
    async register(pollId, chatJid, options, resolution, timeoutMs, abortSignal) {
      calls.push({ pollId, chatJid, options, resolution, timeoutMs, abortSignal });
      return new Promise<string>((resolve, reject) => {
        pendingResolve = resolve;
        pendingReject = reject;
        if (abortSignal) {
          abortSignal.addEventListener('abort', () => reject(new Error('aborted')));
        }
      });
    },
  };
  return registrar;
}

export function depsWithRegistrar(base: MessagingDeps, registrar: FakePollRegistrar): MessagingDeps {
  return Object.assign({}, base, { pollRegistrar: registrar });
}
