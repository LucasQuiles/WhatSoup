import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';

type RuntimeFactory = (options: {
  cwd: string;
  sessionScope?: 'per_chat';
  perChatConversationBound?: boolean;
}) => AgentRuntime;

export function registerRuntimeHomeConfinementTests(
  createRuntime: RuntimeFactory,
  mockSession: { sendTurn: unknown; spawnSession: unknown },
): void {
  it('F6 binds admitted runtime cwd before the first actor socket acquisition', async () => {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const { homedir } = await import('node:os');
    const { isPathWithinAllowedRoot } = await import('../../../src/lib/path-boundary.ts');
    const { mkdirSync } = await import('node:fs');
    const fixture = fs.mkdtempSync(join(homedir(), 'f6-runtime-binding-'));
    const outside = fs.mkdtempSync(join(process.env.TEMP!, 'f6-runtime-binding-outside-'));
    const physical = join(fixture, 'physical');
    const alias = join(fixture, 'alias');
    const previousMkdir = vi.mocked(mkdirSync).getMockImplementation();
    let runtime: AgentRuntime | undefined;
    try {
      fs.mkdirSync(physical);
      fs.symlinkSync(physical, alias);
      const insideFile = join(physical, 'inside.txt');
      const outsideFile = join(outside, 'outside.txt');
      fs.writeFileSync(insideFile, 'inside');
      fs.writeFileSync(outsideFile, 'outside');
      vi.mocked(mkdirSync).mockImplementation(fs.mkdirSync);
      runtime = createRuntime({
        cwd: alias,
        sessionScope: 'per_chat',
        perChatConversationBound: true,
      });
      const state = runtime as unknown as {
        cwd?: string;
        perChatMcpSocketManager: {
          consumedAllowedRoots: string[];
          resources: Map<string, unknown>;
          acquire(identity: string): { ready: Promise<void> };
        };
      };
      const manager = state.perChatMcpSocketManager;
      await runtime.start();
      expect(state.cwd).toBe(fs.realpathSync.native(physical));
      expect(manager.consumedAllowedRoots).toEqual([]);
      expect(manager.resources.size).toBe(0);

      // Retarget AFTER runtime admission, BEFORE the first actor acquisition.
      fs.unlinkSync(alias);
      fs.symlinkSync(outside, alias);
      await manager.acquire('later@s.whatsapp.net').ready;
      expect(manager.consumedAllowedRoots).toHaveLength(1);
      const consumed = manager.consumedAllowedRoots[0];
      expect(isPathWithinAllowedRoot(fs.realpathSync.native(outsideFile), consumed)).toBe(false);
      expect(isPathWithinAllowedRoot(fs.realpathSync.native(insideFile), consumed)).toBe(true);
      expect(consumed).toBe(fs.realpathSync.native(physical));
      expect(mockSession.sendTurn).not.toHaveBeenCalled();
    } finally {
      try {
        await runtime?.shutdown();
      } finally {
        vi.mocked(mkdirSync).mockImplementation(previousMkdir ?? (() => undefined));
        fs.rmSync(fixture, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
      }
    }
  });

  it('F6 rejects a replaced cwd before creating runtime files outside home', async () => {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const { homedir } = await import('node:os');
    const home = homedir();
    const outside = fs.mkdtempSync(join(process.env.TEMP!, 'f6-runtime-outside-'));
    const cwd = join(home, 'f6-runtime-cwd');
    fs.symlinkSync(outside, cwd);
    const { mkdirSync } = await import('node:fs');
    const previousMkdir = vi.mocked(mkdirSync).getMockImplementation();
    vi.mocked(mkdirSync).mockImplementation(fs.mkdirSync);
    const runtime = createRuntime({ cwd });
    try {
      await expect(runtime.start()).rejects.toThrow(/home/);
      expect(fs.readdirSync(outside)).toEqual([]);
      expect(mockSession.spawnSession).not.toHaveBeenCalled();
    } finally {
      await runtime.shutdown();
      vi.mocked(mkdirSync).mockImplementation(previousMkdir ?? (() => undefined));
      fs.unlinkSync(cwd);
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
}
