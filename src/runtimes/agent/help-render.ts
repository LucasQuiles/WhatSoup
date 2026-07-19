// src/runtimes/agent/help-render.ts
// Registry-derived /help rendering. Pure functions of (COMMAND_REGISTRY,
// {nlRouting}) — NO runtime/db/clock/config reads inside (render-purity row
// R3c-1.3). The handler (runtime.ts `case 'help'`) supplies nlRouting from
// config and does nothing else; these functions only format.
//
// E1/V30 (VERIFICATION-LEDGER): our OWN markdownToWhatsApp strips bare
// `[text]` → `text` (whatsapp-format.ts:87) and `<tags>` (:100) — this ate
// `/kill-session <N>` in the live exhibit, not the WhatsApp client. Inline-code
// spans (`` `…` ``) are placeholder-protected and restored verbatim (:42-45,
// :138), so any placeholder-bearing syntax MUST render inside a backtick span.
// A placeholder can't ALSO be backtick-protected inside a *bold* run (the
// inline-code extractor pulls the span out of the bold run) — so the /help
// LIST shows bold command names with no placeholder, and the `[N]`-bearing
// syntax lives only in the backtick-wrapped /help <cmd> DETAIL render.
//
// W1-lead ruling B (visibility SPLIT, not suppression — resolves a
// dispatch-vs-packet conflict flagged mid-flight): the registry's `visibility`
// field drives a STATIC SECTION split (end-user section, then an operator
// section) — BOTH sections render to EVERYONE. No sender identity is read, so
// the render stays a pure function of (registry, {nlRouting}) — R3c-1.3 holds.
// The gate VALUE drives a SEPARATE axis: the inline gate tag (a
// GATE_PRESENTATION lookup — scope-accurate per value, G34), composed
// independently of the section (D4 — e.g. `new` is gate:'admin-shared-scope'
// but visibility:'end-user', so it renders in the end-user section WITH its
// tag — discoverable, GRANT-denied on use, W04 3/11 tag-don't-hide).
// Audience-based SUPPRESSION (non-admins don't see the operator section at
// all) is deferred to W2/T9c when the render audience is threaded through —
// E2's full fix is a two-stage rollout: T5 = registry-derived section/tag
// structure (this file), W2/T9c = true per-sender suppression.

import {
  COMMAND_REGISTRY,
  GATE_PRESENTATION,
  PASSTHROUGH_PHRASE,
  getCommandSpec,
  type CommandSpec,
} from './command-registry.ts';

// Widen the narrow `as const` tuple to the interface array so optional-field
// reads (routingAlias) typecheck on entries that omit them — same pattern as
// commands.ts's classifier derivation (W1-T2).
const REGISTRY: readonly CommandSpec[] = COMMAND_REGISTRY;

function findSpec(name: string): CommandSpec | undefined {
  return REGISTRY.find((c) => c.name === name);
}

function toListLine(c: CommandSpec): string {
  return `*/${c.name}* — ${c.summary}${GATE_PRESENTATION[c.gate].listTag}`;
}

/**
 * Render the /help command list, SECTIONED by the registry's static
 * `visibility` field (ruling B — see module header): an end-user section,
 * then an operator section, both shown to every reader. Within each section,
 * one bold-name line per command, tagged with its gate value's list tag
 * (GATE_PRESENTATION — scope-accurate per value, G34; a separate axis from
 * the section, composed independently, D4).
 * Routing-alias commands (/model /why /reset) only appear when `nlRouting`
 * is on (byte-identical-off contract, D7). No placeholder/syntax in the list
 * — see module header.
 */
export function renderHelp({ nlRouting }: { nlRouting: boolean }): string {
  const visible = REGISTRY.filter((c) => !c.routingAlias || nlRouting);
  const endUserLines = visible.filter((c) => c.visibility === 'end-user').map(toListLine);
  const operatorLines = visible.filter((c) => c.visibility === 'operator').map(toListLine);

  const sections = [...endUserLines];
  if (operatorLines.length > 0) {
    sections.push('', '_Operator commands:_', ...operatorLines);
  }

  // Pull the /help command's own syntax from the registry (DRY — no second
  // hand-copy of the placeholder grammar; getCommandSpec fails closed, so a
  // missing 'help' entry is loud registry drift, not a silent fallback) and
  // backtick-wrap it so the [command] placeholder survives markdownToWhatsApp
  // (E1/V30).
  const detailHint = `\`${getCommandSpec('help').syntax}\` for detail`;

  return [
    ...sections,
    '',
    '_Any other message is forwarded._',
    // Passthrough discoverability (restores the base-/help trailer the W1-T5
    // rewrite dropped). Provider-neutral wording: the model-attribution
    // hygiene rule bans the agent-CLI product name in new repo text. The
    // phrase itself is registry-carried (PASSTHROUGH_PHRASE — SSOT,
    // arch.ssot-presentation-literals; renderHelpDetail composes the same one).
    `Other slash commands (e.g. \`/compact\`) are ${PASSTHROUGH_PHRASE}.`,
    `(${detailHint})`,
  ].join('\n');
}

/**
 * Render the /help <cmd> detail: the command's usage `syntax` wrapped in a
 * backtick span (so `[N]`-style placeholders survive markdownToWhatsApp —
 * E1/V30), its summary, and the gate value's detail note (GATE_PRESENTATION
 * — value-specific wording, G34; the Record over the CommandGate union is
 * truly exhaustive, so a future gate value without a table row is a compile
 * error rather than a silent render gap). The raw arg is normalized first —
 * first whitespace token, backticks removed, leading '/' stripped, lowercased
 * — so '/help Status', '/help /new', '/help kill-session 1' all resolve.
 * Takes the same `nlRouting` input renderHelp does: routing-alias commands
 * (/model /why /reset) are LOCAL only when the flag is on (byte-identical-off
 * contract, D7) — flag off they forward, so their local semantics must not
 * render; they get an honest pass-through note instead (B23 — the command
 * DOES forward, so calling it "Unknown" was a lie). Genuinely-unknown
 * commands return an invalid-arg hint string — this NEVER throws (fail-open
 * UX; contrast with command-registry.ts's getCommandSpec, which fails closed
 * for internal drift-detection callers).
 */
export function renderHelpDetail(name: string, { nlRouting }: { nlRouting: boolean }): string {
  // Backtick removal doubles as the E1-class echo guard: the normalized token
  // is what gets interpolated inside the unknown-echo's `…` span below, and a
  // backtick there would break the span pairing.
  const query = (name.trim().split(/\s+/)[0] ?? '')
    .replaceAll('`', '')
    .replace(/^\//, '')
    .toLowerCase();
  const spec = findSpec(query);
  if (spec !== undefined && spec.routingAlias === true && !nlRouting) {
    // Alias off ≠ unknown: the command still FORWARDS to the agent
    // (byte-identical-off, D7), so the honest detail names the pass-through
    // — without rendering the local semantics the flag disables (B23).
    // Wording matches renderHelp's trailer BY CONSTRUCTION: both compose the
    // registry-carried PASSTHROUGH_PHRASE (SSOT, arch.ssot-presentation-literals).
    return `\`/${query}\` is not active here — it is ${PASSTHROUGH_PHRASE}. See \`/help\` for the full list.`;
  }
  if (!spec) {
    return `Unknown command \`/${query}\`. Not a command — try \`/help\` for the full list.`;
  }
  return `\`${spec.syntax}\`\n${spec.summary}${GATE_PRESENTATION[spec.gate].detailNote}`;
}
