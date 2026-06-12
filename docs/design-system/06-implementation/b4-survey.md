# B4 Pre-Investigation Survey — Inbox (DD-17 + DD-18r legs)

Read-only survey (2026-06-12) feeding the B4 A0 packet.

- Three-pane layout (Inbox page, 663 ln): fixed widths via --panel-chat-list 288px /
  --panel-contact 256px, all flex-shrink-0, NO responsive collapse of any kind.
  layout-density.md is explicit: contact pane hides under ~1080px ("Inbox keeps the
  active conversation, drops the contact pane"). Token drift vs tokens-v3: spec says
  264/248, implementation has 288/256 — reconcile in-packet.
- Chat list (DD-17): role="listbox" + role="option" with aria-selected and Enter/Space —
  but EVERY item carries tabIndex 0, which matches NEITHER WAI pattern
  (aria-activedescendant nor roving tabindex). Recommendation: roving tabindex (simpler
  under virtualization). ChatListItem is 77 ln, single edit site.
- MessageBubble hover card (DD-18r leg): absolute bottom-100% left-0, 500ms delay, NO
  keyboard alternative, NO viewport-edge handling (clips near top/right). 573-line
  extended test suite pins current behavior incl. the delay — test migration is the
  bulk of the work.
- Search input: hand-rolled c-input with own debounce — input.md mandates ONE
  SearchInput component; Inbox is the named adoption site.
- Composer textarea: standard pattern, fine. One of the two no-focus-suppression hits
  (outline-none) lives in the Inbox composer — B4 can take it.
- Tests: selection/virtualization/bubble rendering covered; ZERO tests pin pane layout,
  collapse, or listbox semantics — B4 writes the first ones.
- B4 candidate shape: (1) roving-tabindex chat list + arrow nav; (2) contact-pane
  collapse via container query (reuse the C2.3 squeeze idiom) + token reconciliation;
  (3) MessageBubble keyboard alternative + edge-aware positioning; (4) SearchInput
  adoption (depends on B2's input/search work — sequence after, or extract SearchInput
  first); (5) composer focus-suppression fix.
