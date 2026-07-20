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
    expect(renderHelp({ nlRouting: false })).not.toContain('/model');
  });

  it('D11: /why is gone from the registry — never appears in the list, either flag state', () => {
    expect(renderHelp({ nlRouting: false })).not.toContain('/why');
    expect(renderHelp({ nlRouting: true })).not.toContain('/why');
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
    const detail = renderHelpDetail('kill-session', { nlRouting: false });
    expect(detail).toContain('`/kill-session [N]`'); // backtick-wrapped
    expect(detail.toLowerCase()).toContain('admin');
  });
  it('E1 (real proof): [N] SURVIVES markdownToWhatsApp because detail is backtick-wrapped', () => {
    // whatsapp-format.ts:87 strips bare [text]→text; :100 strips <tags>. Inline-code
    // spans (:42-45) are placeholder-protected + restored (:138), so a backtick-
    // wrapped [N] survives while a BARE [N] degrades — the falsifier below proves
    // the guard tests the protection, not a converter that ignores brackets.
    expect(markdownToWhatsApp(renderHelpDetail('kill-session', { nlRouting: false }))).toContain('[N]');
    const bare = markdownToWhatsApp('/kill-session [N]');   // un-backticked control
    expect(bare).not.toContain('[N]');
    expect(bare).toContain('kill-session N');                // degraded to bare N
    expect(markdownToWhatsApp('/kill-session <N>')).not.toContain('<N>'); // our stripHtmlLikeTags, not WA
  });
  it('/help <unknown> returns an invalid-arg hint, not a throw', () => {
    expect(() => renderHelpDetail('nope', { nlRouting: false })).not.toThrow();
    expect(renderHelpDetail('nope', { nlRouting: false })).toMatch(/unknown|not a command/i);
  });
});

describe('B21-B /help fixes (RED-first)', () => {
  it('#1: admin-shared-scope list tag is scope-accurate, not the bare _(admin)_', () => {
    // /new is gate:'admin-shared-scope' — ungated in a per_chat 1:1 DM (WG-5),
    // so tagging it plain _(admin)_ in the list misrepresents scope the same
    // way the detail note did pre-G34. The list tag must carry the same
    // scope-accurate wording the G34 detail note established.
    const list = renderHelp({ nlRouting: false });
    const newLine = list.split('\n').find((l) => l.includes('*/new*'));
    expect(newLine).toBeDefined();
    expect(newLine).toContain('_(admin in groups & shared sessions)_');
    expect(newLine).not.toContain('_(admin)_');
  });

  it('#2: routing-alias detail renders local semantics ONLY when nlRouting is on', () => {
    // Flag off, /model|/reset FORWARD (byte-identical-off, D7) — so
    // /help must not describe local-routing semantics the command won't have.
    // (B23 refines the flag-off wording to an honest pass-through note — see
    // the B23 describe below — but the D7 no-local-semantics bar is unchanged.)
    const on = renderHelpDetail('model', { nlRouting: true });
    expect(on).toContain('`/model [status|list|strongest|fastest|provider-id]`'); // B26: list verb; D12 dropped default
    const off = renderHelpDetail('model', { nlRouting: false });
    expect(off).not.toContain('`/model [status');
    expect(renderHelpDetail('reset', { nlRouting: true })).toContain('`/reset`');
  });

  it('C3/D15: strongest|fastest are hidden from BOTH the /model list line and the /model detail when tiersConfigured is false', () => {
    const list = renderHelp({ nlRouting: true, tiersConfigured: false });
    expect(list).toContain('/model');
    expect(list).not.toContain('strongest');
    expect(list).not.toContain('fastest');
    expect(list).toContain('pin provider-id');

    const detail = renderHelpDetail('model', { nlRouting: true, tiersConfigured: false });
    expect(detail).toContain('`/model [status|list|provider-id]`');
    expect(detail).not.toContain('strongest');
    expect(detail).not.toContain('fastest');
  });

  it('C3/D15: tiersConfigured defaults to true — every existing caller (omitting it) keeps showing the verbs', () => {
    const list = renderHelp({ nlRouting: true });
    expect(list).toContain('strongest|fastest|provider-id');
    const detail = renderHelpDetail('model', { nlRouting: true });
    expect(detail).toContain('strongest|fastest|provider-id');
  });

  it('C3/D15: tiersConfigured:true renders the verbs explicitly (byte-identical to the default)', () => {
    const list = renderHelp({ nlRouting: true, tiersConfigured: true });
    expect(list).toContain('strongest|fastest|provider-id');
  });

  it('#3: detail arg is normalized — case, leading slash, first token only', () => {
    expect(renderHelpDetail('Status', { nlRouting: false })).toContain('`/status`');
    expect(renderHelpDetail('/new', { nlRouting: false })).toContain('`/new`');
    expect(renderHelpDetail('kill-session 1', { nlRouting: false })).toContain('`/kill-session [N]`');
  });

  it('#4: list trailer restores slash-command passthrough discoverability', () => {
    // The base /help documented that unrecognized slash commands pass straight
    // through to the agent CLI; the W1-T5 rewrite dropped that line. Wording
    // here deviates from the base literal ("...passed directly to C____ C___.")
    // because repo hygiene (model-attribution, scripts/repo-hygiene-guard.ts)
    // bans the product name in new text — W1-T5 scrubbed the sibling
    // "_Any other message is forwarded_" line the same way.
    for (const nlRouting of [false, true]) {
      expect(renderHelp({ nlRouting })).toContain(
        'Other slash commands (e.g. `/compact`) are passed through to the agent.',
      );
    }
  });

  it('#5: unknown-command echo strips backticks from the arg (E1 span-pairing class)', () => {
    // A backtick in the raw arg lands inside the echo's `…` span and breaks
    // pairing (the old render produced `/`whoami`` — a dangling double tick).
    const detail = renderHelpDetail('`whoami`', { nlRouting: false });
    expect(detail).toContain('`/whoami`');
    expect(detail).not.toContain('``');
  });
});

describe('B23 UX polish — honest alias-off /help detail', () => {
  it('alias-off detail says the command is passed through, NOT that it is unknown', () => {
    // With nlRouting off the routing aliases still FORWARD to the agent
    // (byte-identical-off, D7) — so `/help model` calling /model "Unknown"
    // is dishonest about a command that demonstrably does something. The
    // alias-off branch must name the pass-through instead, while STILL not
    // rendering the local semantics the flag disables.
    for (const alias of ['model', 'reset']) {
      const off = renderHelpDetail(alias, { nlRouting: false });
      expect(off).toContain(`\`/${alias}\` is not active here`);
      expect(off).toContain('passed through to the agent');
      expect(off).toContain('`/help`');
      expect(off).not.toMatch(/unknown command/i);
      expect(off).not.toContain(`\`/${alias} [`); // no local syntax leaks (D7)
    }
  });
  it('genuinely-unknown commands keep the unknown-command hint on BOTH flag states', () => {
    for (const nlRouting of [false, true]) {
      const detail = renderHelpDetail('nope', { nlRouting });
      expect(detail).toContain('Unknown command `/nope`');
      expect(detail).not.toContain('passed through to the agent');
    }
  });
  it('alias detail with nlRouting ON is untouched by the B23 wording', () => {
    const on = renderHelpDetail('model', { nlRouting: true });
    expect(on).not.toContain('is not active here');
    expect(on).toContain('`/model [status|list|strongest|fastest|provider-id]`'); // B26: list verb; D12 dropped default
  });
});

describe('B26 /help model-catalogue guidance (registry-derived, no hand-rolled literals)', () => {
  // Owner ruling: 'no updated guidance under the help command either'.
  // The guidance lives in the registry entry's summary/syntax ONLY — the
  // renderer stays a pure function of (registry, {nlRouting}) and the D7
  // byte-identical-off contract holds: flag off, no catalogue guidance leaks.

  it('the /help list line for /model surfaces the catalogue affordance when nlRouting is on', () => {
    const list = renderHelp({ nlRouting: true });
    const modelLine = list.split('\n').find((l) => l.includes('*/model*'));
    expect(modelLine).toBeDefined();
    expect(modelLine).toContain('/model list — see what you can pick');
  });

  it('/help model detail carries the catalogue verb and the pin guidance', () => {
    const detail = renderHelpDetail('model', { nlRouting: true });
    expect(detail).toContain('`/model [status|list|strongest|fastest|provider-id]`'); // D12 dropped default
    expect(detail).toContain('/model list — see what you can pick');
  });

  it('D7: flag off renders NO catalogue guidance in list or detail', () => {
    expect(renderHelp({ nlRouting: false })).not.toContain('/model list');
    expect(renderHelpDetail('model', { nlRouting: false })).not.toContain('see what you can pick');
  });
});
