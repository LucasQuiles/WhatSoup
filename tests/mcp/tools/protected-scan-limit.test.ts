/**
 * The sock tool factory redacts protected links in every WhatsApp-backed
 * reader's result. A large but legitimate result must come back whole. The
 * socket call has completed before the scan, so a result past the scan bound
 * is withheld whole and keeps its success, never a silently cut result.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/logger.ts', async () => (await import('../../helpers/logger-mock.ts')).loggerMock());

import {
  MAX_SANITIZE_NODES,
  PROTECTED_MESSAGE_MARKER,
  PROTECTED_TEXT_WITHHELD_MARKER,
} from '../../../src/core/protected-message.ts';
import { registerGroupTools } from '../../../src/mcp/tools/groups.ts';
import { ToolRegistry } from '../../helpers/resolved-tool-registry.ts';

function group(index: number, members: number) {
  return {
    id: `group-${index}@g.us`,
    subject: `group ${index}`,
    participants: Array.from({ length: members }, (_, member) => ({ id: `${index}-${member}@lid`, admin: null })),
  };
}

async function listGroups(groups: ReturnType<typeof group>[]) {
  const registry = new ToolRegistry();
  const sock = { groupFetchAllParticipating: async () => Object.fromEntries(groups.map((entry) => [entry.id, entry])) };
  registerGroupTools(() => sock as never, (tool) => registry.register(tool));
  return registry.call('list_groups', {}, { tier: 'global' });
}

describe('list_groups through the sock tool factory scan bound', () => {
  // 262,144 participants pass through the factory and registry scans: about 3 s locally, and over the default
  // 10 s on a loaded CI runner (12.4 s observed), so this case gets its own limit.
  it('returns 256 groups at the 1,024-member cap whole', async () => {
    const groups = Array.from({ length: 256 }, (_, index) => group(index, 1024));

    const result = await listGroups(groups);

    expect(result.isError, result.content[0].text.slice(0, 200)).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text) as { groups: Array<{ participants: unknown[] }> };
    expect(parsed.groups).toHaveLength(256);
    expect(parsed.groups.every((entry) => entry.participants.length === 1024)).toBe(true);
    expect(result.content[0].text).not.toContain(PROTECTED_MESSAGE_MARKER);
  }, 30_000);

  it('withholds a result past the scan bound whole and keeps it a success', async () => {
    // One group whose member count alone reaches the bound.
    const result = await listGroups([group(0, MAX_SANITIZE_NODES)]);

    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: 'text', text: PROTECTED_TEXT_WITHHELD_MARKER }]);
  });
});
