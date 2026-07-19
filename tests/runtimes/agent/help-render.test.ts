import { describe, it, expect } from 'vitest';
import { renderHelp, renderHelpDetail } from '../../../src/runtimes/agent/help-render.ts';
// The DECISIVE outbound transform — the real rule that ate E1's <N> and would eat
// a bare [N]. preprocessText (outbound-queue.ts:201, NOT exported) is just this +
// checkbox rules, so importing markdownToWhatsApp is the faithful, local proof.
import { markdownToWhatsApp } from '../../../src/runtimes/agent/whatsapp-format.ts';

describe('renderHelp (registry-derived, W1-T5)', () => {
  it('lists commands with summaries and the detail hint; nlRouting off', () => {
    expect(renderHelp({ nlRouting: false })).toMatchSnapshot();
  });
  it('includes routing aliases only when nlRouting is on', () => {
    expect(renderHelp({ nlRouting: true })).toContain('/model');
    expect(renderHelp({ nlRouting: false })).not.toContain('/why');
  });
  it('list shows the BOLD command name and no placeholder (placeholders live in detail)', () => {
    // Bold/backtick nesting conflict: a placeholder inside *bold* cannot also be
    // backtick-protected (the inline-code extractor pulls the span OUT of the bold
    // run → `*…IC0…*`). So the list is bold names only; the [N] syntax is in
    // /help <cmd> detail, backtick-wrapped. Matches U2 (list = nouns + one-liners).
    const list = renderHelp({ nlRouting: false });
    expect(list).toContain('*/kill-session*'); // bold name
    expect(list).not.toContain('[N]');         // no placeholder in the list
    expect(list).toContain('_(admin)_');       // gate:'admin' tagged, not hidden (W04 3/11)
  });
  it('B (visibility SPLIT, not suppression): sections by the static visibility field, BOTH shown', () => {
    // W1-lead tie-break (iter-82 "visibility split" + purity row are jointly
    // satisfiable ONLY here): W1 SECTIONS by the static `visibility` field — pure,
    // no sender identity, so renderHelp({nlRouting}) signature is unchanged. Both
    // sections render to EVERYONE; audience-based SUPPRESSION (non-admins don't see
    // the operator section) is W2. Exercises D4: visibility → section, gate → tag.
    const list = renderHelp({ nlRouting: false });
    expect(list).toMatch(/operator/i);                    // an operator section header exists
    expect(list).toContain('*/sessions*');                // visibility:'operator' → shown (not hidden)
    expect(list).toContain('*/kill-session*');
    // `new` is gate:'admin' BUT visibility:'end-user' → it sits in the end-user
    // section (before the operator header) WITH its _(admin)_ tag — the D4
    // "admin-gated yet end-user-visible" composition, rendered correctly.
    expect(list.indexOf('*/new*')).toBeLessThan(list.search(/operator/i));
  });
  it('/help <cmd> detail wraps syntax in a backtick span so [N] survives conversion', () => {
    const detail = renderHelpDetail('kill-session');
    expect(detail).toContain('`/kill-session [N]`'); // backtick-wrapped
    expect(detail.toLowerCase()).toContain('admin');
  });
  it('E1 (real proof): [N] SURVIVES markdownToWhatsApp because detail is backtick-wrapped', () => {
    // whatsapp-format.ts:87 strips bare [text]→text; :100 strips <tags>. Inline-code
    // spans (:42-45) are placeholder-protected + restored (:138), so a backtick-
    // wrapped [N] survives while a BARE [N] degrades — the falsifier below proves
    // the guard tests the protection, not a converter that ignores brackets.
    expect(markdownToWhatsApp(renderHelpDetail('kill-session'))).toContain('[N]');
    const bare = markdownToWhatsApp('/kill-session [N]');   // un-backticked control
    expect(bare).not.toContain('[N]');
    expect(bare).toContain('kill-session N');                // degraded to bare N
    expect(markdownToWhatsApp('/kill-session <N>')).not.toContain('<N>'); // our stripHtmlLikeTags, not WA
  });
  it('/help <unknown> returns an invalid-arg hint, not a throw', () => {
    expect(() => renderHelpDetail('nope')).not.toThrow();
    expect(renderHelpDetail('nope')).toMatch(/unknown|not a command/i);
  });
});
