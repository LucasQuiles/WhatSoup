import { describe, it, expect } from 'vitest';
import {
  conversationKeyToJid,
  isGroupConversationKey,
  toConversationKey,
  GLOBAL_CONVERSATION_KEY,
} from '../../src/core/conversation-key.ts';

describe('toConversationKey', () => {
  it('normalizes @s.whatsapp.net DM to bare phone', () => {
    expect(toConversationKey('15550100001@s.whatsapp.net')).toBe('15550100001');
  });

  it('normalizes @lid DM to numeric ID without device qualifier', () => {
    expect(toConversationKey('81536414179557:42@lid')).toBe('81536414179557');
  });

  it('normalizes @lid DM without device qualifier', () => {
    expect(toConversationKey('81536414179557@lid')).toBe('81536414179557');
  });

  it('normalizes @g.us group to _at_g.us form', () => {
    expect(toConversationKey('group-alpha@g.us')).toBe('group-alpha_at_g.us');
  });

  it('handles unknown suffix by stripping domain', () => {
    expect(toConversationKey('unknown@broadcast')).toBe('unknown_at_broadcast');
  });

  it('throws on empty string', () => {
    expect(() => toConversationKey('')).toThrow();
  });

  it('throws on string without @', () => {
    expect(() => toConversationKey('nojid')).toThrow();
  });

  it('throws when the local part is empty', () => {
    expect(() => toConversationKey('@s.whatsapp.net')).toThrow(/empty local part/);
  });
});

describe('isGroupConversationKey', () => {
  it('detects normalized and raw group conversation keys', () => {
    expect(isGroupConversationKey('group-alpha_at_g.us')).toBe(true);
    expect(isGroupConversationKey('group-alpha@g.us')).toBe(true);
  });

  it('does not classify personal or non-group keys as groups', () => {
    expect(isGroupConversationKey('15550100001')).toBe(false);
    expect(isGroupConversationKey('broadcast_at_broadcast')).toBe(false);
  });
});

describe('conversationKeyToJid', () => {
  it('converts normalized group keys back to group JIDs', () => {
    expect(conversationKeyToJid('group-alpha_at_g.us')).toBe('group-alpha@g.us');
  });

  it('leaves non-group keys unchanged', () => {
    expect(conversationKeyToJid('15550100001')).toBe('15550100001');
    expect(conversationKeyToJid('broadcast_at_broadcast')).toBe('broadcast_at_broadcast');
  });
});

// ─── residual-branch coverage ─────────────────────────────────────────────────
//
// This block provides a focused, per-branch mapping for the entire
// `src/core/conversation-key.ts` surface.  Every v8 branch position enumerated
// below maps to a single `it(...)` whose terminal assertion is a concrete value
// (no `.toThrow()` / `.not.toThrow()` / `.toBeUndefined()` lones).  The leaf
// branch numbering is taken from the v8 coverage report (`coverage-final.json`,
// `branchMap` field).  The pure-string module has no I/O or mocks, so the
// "harness" is the same direct import the existing tests above already use.

describe('residual-branch coverage', () => {
  // ── Branch 0 — `isGroupConversationKey` (line 4) `binary-expr` (`||`) ─────
  describe('isGroupConversationKey — both arms of the `||`', () => {
    it('returns true via the LEFT arm when the normalized `_at_g.us` form is present', () => {
      // Branch 0 left:  key.includes('_at_g.us') === true  →  short-circuits, right arm NOT evaluated.
      expect(isGroupConversationKey('120363024555550100_at_g.us')).toBe(true);
    });

    it('returns true via the RIGHT arm when only the raw `@g.us` JID form is present', () => {
      // Branch 0 right: key.includes('_at_g.us') === false  →  evaluates right side
      //                key.includes('@g.us') === true  →  return true.
      expect(isGroupConversationKey('group-bravo@g.us')).toBe(true);
    });
  });

  // ── Branches 1 + 2 — `toConversationKey` top-level guard (line 12) ────────
  describe('toConversationKey — top-level `!jid || !jid.includes("@")` guard', () => {
    it('throws via the LEFT arm of the guard when the jid is empty', () => {
      // Branch 2 left:  !jid === true  →  short-circuits, right side NOT evaluated.
      // Branch 1 true:  enter the `if` body and throw.
      expect(() => toConversationKey('')).toThrow(/Invalid JID/);
    });

    it('throws via the RIGHT arm of the guard when the jid has no `@`', () => {
      // Branch 2 right: !jid === false  →  evaluates right side
      //                !jid.includes('@') === true  →  enter the `if` body.
      expect(() => toConversationKey('nojid')).toThrow(/Invalid JID/);
    });

    it('does not throw (false arm of the guard) for a normal `@s.whatsapp.net` JID', () => {
      // Branch 1 false: !jid === false AND !jid.includes('@') === false  →  skip the throw.
      expect(toConversationKey('15550100001@s.whatsapp.net')).toBe('15550100001');
    });
  });

  // ── Branch 3 — `toConversationKey` empty-local-part guard (line 18) ────────
  describe('toConversationKey — `!local` empty-local-part guard', () => {
    it('throws when the local part is empty (jid starts with `@`)', () => {
      // Branch 3 true: !local === true  →  enter the `if` body and throw.
      expect(() => toConversationKey('@s.whatsapp.net')).toThrow(/empty local part/);
    });

    it('does not throw (false arm) for a normal LID JID', () => {
      // Branch 3 false: !local === false  →  skip the throw, proceed to switch.
      expect(toConversationKey('81536414179557@lid')).toBe('81536414179557');
    });
  });

  // ── Branch 4 — `toConversationKey` `switch (domain)` (line 21, 4 cases) ───
  describe('toConversationKey — switch on domain', () => {
    it('matches the PERSONAL case (returns the bare local)', () => {
      // Branch 4 case 0: DOMAIN_PERSONAL  →  return local.
      expect(toConversationKey('15550100002@s.whatsapp.net')).toBe('15550100002');
    });

    it('matches the LID case (strips the colon-device suffix)', () => {
      // Branch 4 case 1: DOMAIN_LID  →  enter the LID block.  Also covers
      // Branch 5 cond-true: colonIndex >= 0  →  substring(0, colonIndex).
      expect(toConversationKey('81536414179557:42@lid')).toBe('81536414179557');
    });

    it('matches the GROUP case (rewrites @g.us to _at_g.us)', () => {
      // Branch 4 case 2: DOMAIN_GROUP  →  return `${local}_at_g.us`.
      expect(toConversationKey('group-charlie@g.us')).toBe('group-charlie_at_g.us');
    });

    it('matches the default case (rewrites an unknown domain to _at_<domain>)', () => {
      // Branch 4 case 3: default  →  return `${local}_at_${domain}`.
      expect(toConversationKey('15550100003@sms')).toBe('15550100003_at_sms');
    });
  });

  // ── Branch 5 — `toConversationKey` ternary inside the LID case (line 26) ──
  describe('toConversationKey — ternary inside the LID case', () => {
    it('strips everything after the FIRST colon (cond-true: colonIndex >= 0)', () => {
      // Branch 5 cond-true: local.indexOf(':') >= 0  →  substring(0, colonIndex).
      // Multiple colons → only the first is the cut point (substring(0, idx)).
      expect(toConversationKey('81536414179557:42:99@lid')).toBe('81536414179557');
    });

    it('leaves the local part unchanged when no colon is present (cond-false)', () => {
      // Branch 5 cond-false: local.indexOf(':') < 0  →  return local as-is.
      expect(toConversationKey('81536414179557@lid')).toBe('81536414179557');
    });
  });

  // ── Additional edge cases that re-exercise already-covered branches ───────
  describe('conversation-key edge cases', () => {
    it('isGroupConversationKey returns false for a bare phone (no group suffix)', () => {
      // Both arms of `||` evaluate to false → return false.
      expect(isGroupConversationKey('15550100001')).toBe(false);
    });

    it('isGroupConversationKey returns false for an empty string', () => {
      // Confirms the falsy-string path: both `.includes` calls return false.
      expect(isGroupConversationKey('')).toBe(false);
    });

    it('conversationKeyToJid is a no-op when the input does not contain `_at_g.us`', () => {
      // Source line 8: `replace('_at_g.us', '@g.us')`  →  string returned unchanged.
      expect(conversationKeyToJid('15550100001')).toBe('15550100001');
    });

    it('conversationKeyToJid replaces only the FIRST occurrence of `_at_g.us`', () => {
      // String#replace with a string pattern replaces only the first match —
      // verify the function behaves as a single-shot rewrite, not a global one.
      expect(conversationKeyToJid('foo_at_g.us_at_g.us')).toBe('foo@g.us_at_g.us');
    });
  });

  // ── Reserved sentinel key ────────────────────────────────────────────────
  describe('reserved __global__ sentinel', () => {
    it('exports the sentinel as the single-source constant', () => {
      expect(GLOBAL_CONVERSATION_KEY).toBe('__global__');
    });

    it('toConversationKey rejects a personal JID whose local part is the reserved key', () => {
      // Only the personal/LID branch returns the bare local part, so only it
      // can mint a key colliding with the reserved sentinel. Real WhatsApp
      // JIDs carry numeric locals; a '__global__' local is invalid input, and
      // silently returning it would file a chat's rows under the global bucket.
      expect(() => toConversationKey('__global__@s.whatsapp.net')).toThrow(/reserved/);
    });

    it('toConversationKey rejects a LID JID whose device-stripped local is the reserved key', () => {
      expect(() => toConversationKey('__global__:7@lid')).toThrow(/reserved/);
    });

    it('group and foreign-domain keys cannot collide (suffix always appended)', () => {
      expect(toConversationKey('__global__@g.us')).toBe('__global___at_g.us');
      expect(toConversationKey('__global__@broadcast')).toBe('__global___at_broadcast');
    });
  });
});
