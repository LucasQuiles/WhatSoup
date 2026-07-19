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
// `gate !== 'none'` drives a SEPARATE axis: the inline `_(admin)_` tag,
// composed independently of the section (D4 — e.g. `new` is gate:'admin' but
// visibility:'end-user', so it renders in the end-user section WITH the tag —
// discoverable, GRANT-denied on use, W04 3/11 tag-don't-hide). Audience-based
// SUPPRESSION (non-admins don't see the operator section at all) is deferred
// to W2/T9c when the render audience is threaded through — E2's full fix is a
// two-stage rollout: T5 = registry-derived section/tag structure (this file),
// W2/T9c = true per-sender suppression.

import { COMMAND_REGISTRY, type CommandSpec } from './command-registry.ts';

// Widen the narrow `as const` tuple to the interface array so optional-field
// reads (routingAlias) typecheck on entries that omit them — same pattern as
// commands.ts's classifier derivation (W1-T2).
const REGISTRY: readonly CommandSpec[] = COMMAND_REGISTRY;

function findSpec(name: string): CommandSpec | undefined {
  return REGISTRY.find((c) => c.name === name);
}

function toListLine(c: CommandSpec): string {
  const adminTag = c.gate !== 'none' ? ' _(admin)_' : '';
  return `*/${c.name}* — ${c.summary}${adminTag}`;
}

/**
 * Render the /help command list, SECTIONED by the registry's static
 * `visibility` field (ruling B — see module header): an end-user section,
 * then an operator section, both shown to every reader. Within each section,
 * one bold-name line per command, tagged `_(admin)_` when `gate !== 'none'`
 * (a separate axis from the section — composed independently, D4).
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
  // hand-copy of the placeholder grammar) and backtick-wrap it so the [command]
  // placeholder survives markdownToWhatsApp (E1/V30).
  const helpSpec = findSpec('help');
  const detailHint = helpSpec ? `\`${helpSpec.syntax}\` for detail` : '`/help [command]` for detail';

  return [...sections, '', '_Any other message is forwarded._', `(${detailHint})`].join('\n');
}

/**
 * Render the /help <cmd> detail: the command's usage `syntax` wrapped in a
 * backtick span (so `[N]`-style placeholders survive markdownToWhatsApp —
 * E1/V30), its summary, and a gate note. Unknown commands return an
 * invalid-arg hint string — this NEVER throws (fail-open UX; contrast with
 * command-registry.ts's getCommandSpec, which fails closed for internal
 * drift-detection callers).
 */
export function renderHelpDetail(name: string): string {
  const spec = findSpec(name);
  if (!spec) {
    return `Unknown command \`/${name}\`. Not a command — try \`/help\` for the full list.`;
  }
  // Value-specific, not `gate !== 'none'` (G34): 'admin-shared-scope' is NOT
  // admin-only — it's ungated in a 1:1 DM, only admin-gated where it hits
  // shared/group state (owner ruling, WG-5). A single "(admin only)" note
  // for any non-none gate would misrepresent that. Exhaustive over
  // CommandGate ('none' | 'admin' | 'admin-shared-scope') so a future gate
  // value fails to typecheck here rather than silently rendering nothing.
  const gateNote: string =
    spec.gate === 'admin'
      ? ' (admin only)'
      : spec.gate === 'admin-shared-scope'
        ? ' (admin in groups & shared sessions)'
        : '';
  return `\`${spec.syntax}\`\n${spec.summary}${gateNote}`;
}
