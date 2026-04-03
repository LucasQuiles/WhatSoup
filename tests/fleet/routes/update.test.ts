import { describe, it, expect, vi } from 'vitest';
import { handleGetVersion } from '../../../src/fleet/routes/update.ts';

function createMockReqRes() {
  const chunks: string[] = [];
  const res = {
    writeHead: vi.fn(),
    write: vi.fn((c: string) => chunks.push(c)),
    end: vi.fn((c?: string) => { if (c) chunks.push(c); }),
    getBody: () => chunks.join(''),
  } as any;
  return { res, chunks };
}

describe('handleGetVersion', () => {
  it('returns update state as JSON', () => {
    const { res } = createMockReqRes();
    const mockChecker = {
      getState: () => ({
        sha: 'abc1234',
        remoteSha: 'def5678',
        updateAvailable: true,
        checkedAt: '2026-04-02T00:00:00Z',
      }),
    };
    handleGetVersion({} as any, res, mockChecker as any);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'Content-Type': 'application/json',
    }));
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body.sha).toBe('abc1234');
    expect(body.updateAvailable).toBe(true);
  });
});
