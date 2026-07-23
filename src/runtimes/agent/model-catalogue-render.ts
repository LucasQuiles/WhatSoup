/**
 * `/model list` render surface — the configured-model catalogue and the
 * numbered pickable menu that backs `/model N`.
 *
 * Extracted from AgentRuntime as a slice of the god-class decomposition, in
 * the same shape as the runtime-turn port (`createRuntimeTurnHost` in
 * runtime.ts): free functions over a narrow `ModelCatalogueRenderPort` the
 * runtime satisfies with a host object, so AgentRuntime keeps thin delegating
 * privates and every existing call site is unchanged. Behavior is identical to
 * the previous inline implementation — see the `/model list` characterization
 * suite in tests/runtimes/agent/model-pin.test.ts.
 */
import { createChildLogger } from '../../logger.ts';
import type { AgentFallbackEntry } from '../../core/fallback-chain.ts';
import { resolveProviderCredentialState, isProviderRoutable } from '../../lib/provider-credential-eligibility.ts';
import { fallbackProviderConfigFor } from './fallback-config.ts';
import {
  OWNER_BULLET,
  displayedRoute,
  isDisplayedRoute,
  modelModifierTags,
  modifierSuffix,
  MODEL_CATALOGUE_CAP,
  type DisplayRoute,
} from './owner-render-format.ts';
import { configPointer, scopedCatalogue } from './model-catalogue.ts';
import type { ProviderDescriptor } from './providers/provider-descriptor.ts';
import type { CatalogueSnapshotCache, CatalogueEntry } from './model-snapshot-cache.ts';

// Same component name as AgentRuntime: the catalogue-section warning keeps its
// existing `component: 'agent-runtime'` log binding (no observable change).
const log = createChildLogger('agent-runtime');

/**
 * The AgentRuntime surface the `/model list` render reads. Declared here rather
 * than importing AgentRuntime so this module stays free of a cycle back into
 * runtime.ts; the runtime supplies it as a host object.
 */
export interface ModelCatalogueRenderPort {
  readonly instanceName: string;
  readonly agentProvider: string;
  readonly agentProviderConfig: Record<string, unknown> | undefined;
  readonly model: string | undefined;
  readonly agentFallbacks: AgentFallbackEntry[];
  readonly catalogueSnapshot: CatalogueSnapshotCache;
  // D15: the strongest/fastest intent→provider map. Supplied by the runtime
  // host (which owns the config read) so this render module stays free of a
  // composition-layer import (ring-boundary discipline).
  readonly nlRoutingTiers: { strongest?: string; fastest?: string } | null | undefined;
  sendDirect(chatJid: string, text: string): void;
  loadRouteView(chatJid: string, senderJid: string): { live: DisplayRoute | null; next: DisplayRoute };
}

/**
 * D15: true when at least one of strongest/fastest maps to a provider via
 * nlRoutingTiers — the single source both renderModelCatalogue and /help
 * (help-render.ts's tiersConfigured input) read, so the two surfaces can
 * never disagree about whether the verbs are a no-op on this instance.
 */
export function tiersConfigured(tiers: { strongest?: string; fastest?: string } | null | undefined): boolean {
  return tiers !== null && tiers !== undefined && (tiers.strongest !== undefined || tiers.fastest !== undefined);
}

/**
 * B26 /model list — the model catalogue. Rendered ENTIRELY from config
 * (honesty contract: the served model is unobservable, so nothing here is
 * presented as what actually serves — the primary and every fallback entry
 * are configuration). Names follow the shipped F8 convention:
 * provider (model). D6/D15: plain language — the words "line"/"tier"/
 * "weight" are banned from this render; the strongest/fastest verb mapping
 * only appears when nlRoutingTiers is actually configured (advertising a
 * no-op is worse than omitting it).
 */
export function renderModelCatalogue(port: ModelCatalogueRenderPort): string {
  const primary = port.model !== undefined
    ? `${port.agentProvider} (${port.model} — configured)`
    : `${port.agentProvider} (provider default — no model configured)`;
  // strongest/fastest resolve ONLY through nlRoutingTiers — an absent map
  // means the verbs are a no-op on this instance, so D15 hides the whole
  // line rather than advertising it (canary shape: tiers unset).
  const tiers = port.nlRoutingTiers;
  const tiersAreConfigured = tiersConfigured(tiers);
  // b28 r2d: one `• ` bullet per MODEL (primary + each fallback). Each bullet
  // carries its provider + config-derived modifiers ONLY (D7): a catalog
  // lifecycle advisory keyed off the configured model ID (silent for IDs the
  // catalog does not recognize, e.g. third-party kimi/glm) and a tag when
  // the provider is a configured strongest/fastest target.
  const modelBullets: string[] = [
    `Primary: ${primary}${modifierSuffix(modelModifierTags(port.model, port.agentProvider, tiers))}`,
  ];
  if (port.agentFallbacks.length > 0) {
    for (const e of port.agentFallbacks) {
      const label = e.model ? `${e.provider} (${e.model})` : e.provider;
      modelBullets.push(`Fallback: ${label}${modifierSuffix(modelModifierTags(e.model, e.provider, tiers))}`);
    }
  } else {
    modelBullets.push('Fallbacks: none configured');
  }
  const lines = [
    '*Configured models*',
    ...modelBullets.map((b) => `${OWNER_BULLET}${b}`),
  ];
  if (tiersAreConfigured && tiers) {
    lines.push(`strongest → ${tiers.strongest ?? 'not configured (default route)'}; fastest → ${tiers.fastest ?? 'not configured (default route)'}`);
  }
  return lines.join('\n');
}

/** Shared by the `/model list` handler and a disclosed re-render on a
 *  snapshot miss (D16): the config-derived block sends first (unconditional,
 *  synchronous — Q 2b#1), then the pickable menu follows fire-and-forget.
 *  senderJid threads through to the snapshot seam (Important-2, final-
 *  review): the numbered menu is captured per-(chat, sender), so a second
 *  render by a different group member never repoints this sender's pick. */
export function sendModelCatalogue(
  port: ModelCatalogueRenderPort,
  chatJid: string,
  senderJid: string,
  filter: string | null,
): void {
  port.sendDirect(chatJid, renderModelCatalogue(port));
  void sendDynamicModelCatalogueSection(port, chatJid, senderJid, filter);
}

/**
 * A fallback entry's credential state, described the same way Task A's
 * `describeProvider` describes a bare provider id — but MODEL-aware (an
 * entry carries `model`, which changes the resolved key service for a
 * multi-model harness like opencode-cli). Scoped to the configured fallback
 * chain ONLY (never a global provider sweep): probing a provider's
 * credential this instance was never told to use would trigger a real,
 * unmocked keyring/keychain lookup for no operational reason.
 */
export function fallbackProviderDescriptor(
  port: ModelCatalogueRenderPort,
  entry: AgentFallbackEntry,
): ProviderDescriptor {
  // Same-provider shortcut mirrors isEntryCredentialed/routablePinTargets —
  // a same-provider entry shares the primary's unconditional routability
  // and is never re-probed.
  if (entry.provider === port.agentProvider) {
    return { id: entry.provider, configured: true, state: 'present-valid', audience: 'keyed' };
  }
  const state = resolveProviderCredentialState({
    provider: entry.provider,
    model: entry.model,
    providerConfig: fallbackProviderConfigFor(entry.provider, port.agentProvider, port.agentProviderConfig),
  });
  return {
    id: entry.provider,
    configured: isProviderRoutable(state),
    state,
    audience: state === 'native' ? 'native' : 'keyed',
  };
}

/**
 * Send the DYNAMIC pickable model menu as the follow-up to the config-
 * derived `/model list` block (which the caller already delivered).
 * D6/D16/D17: the pickable set is the primary (if a model is configured)
 * plus every fallback entry that names a concrete model — the exact
 * (provider, model) pairs renderModelCatalogue already enumerates as
 * bullets, so a numbered pick always names something the user just saw.
 * Numbers are dense, 1-based, flat across providers.
 *
 * SNAPSHOT SEAM (spiked, do not deviate): sendDirect enqueues text
 * asynchronously and returns void — there is no synchronous outbound msgId
 * here — so the snapshot is written under `latestByChat` semantics only
 * (a synthetic, stable, non-colliding id; never a real WhatsApp msgId).
 * SHARED-ENTRIES INVARIANT: `entries` below is the SAME ordered list the
 * numbers are rendered from, built exactly once.
 *
 * Important-2 (final-review): the synthetic msgId is a per-CHAT constant,
 * so the "latest" coordinate MUST be keyed per-sender too (senderJid,
 * threaded through to the cache) — otherwise a second render in the same
 * chat by a different group member silently overwrites the first
 * sender's still-pending numbered pick, even though both renders share
 * the same synthetic key.
 *
 * Never throws — a rendering bug here just omits the section (the config
 * block already went out).
 */
export async function sendDynamicModelCatalogueSection(
  port: ModelCatalogueRenderPort,
  chatJid: string,
  senderJid: string,
  filter: string | null,
): Promise<void> {
  try {
    const { live, next } = port.loadRouteView(chatJid, senderJid);
    const active = displayedRoute(live, next);
    const candidates: Array<{ provider: string; model: string }> = [];
    if (port.model !== undefined) candidates.push({ provider: port.agentProvider, model: port.model });
    for (const e of port.agentFallbacks) {
      if (e.model !== undefined) candidates.push({ provider: e.provider, model: e.model });
    }
    const pool = filter
      ? candidates.filter((e) => e.model.toLowerCase().includes(filter.toLowerCase()))
      : candidates;
    const shown = pool.slice(0, MODEL_CATALOGUE_CAP);

    const entries: CatalogueEntry[] = shown.map((e) => ({ providerId: e.provider, id: e.model }));
    port.catalogueSnapshot.putCatalogueSnapshot(chatJid, senderJid, `model-list:${chatJid}`, entries);

    const lines: string[] = [];
    if (shown.length > 0) {
      lines.push('*Pick a model:*');
      shown.forEach((e, i) => {
        const isCurrent = isDisplayedRoute(e, active);
        lines.push(`${i + 1}. ${e.provider} (${e.model})${isCurrent ? ' (active route)' : ''}`);
      });
      lines.push('Reply `/model N` to switch to that one.');
      if (pool.length > shown.length) {
        lines.push(`showing 1–${shown.length} of ${pool.length} — /model list <text> to narrow`);
      }
    } else if (filter !== null) {
      lines.push(`_No configured model matches '${filter}'._`);
    } else {
      lines.push('_No named models configured to pick from yet._');
    }

    // D6 discovery: a configured fallback provider whose key is missing.
    // Deduped to the first entry per provider — one line per provider even
    // when several fallback entries share it (e.g. two opencode-cli models).
    const firstEntryByProvider = new Map<string, AgentFallbackEntry>();
    for (const e of port.agentFallbacks) {
      if (!firstEntryByProvider.has(e.provider)) firstEntryByProvider.set(e.provider, e);
    }
    const descriptors = [...firstEntryByProvider.values()].map((e) => fallbackProviderDescriptor(port, e));
    const { configPointers } = scopedCatalogue(descriptors);
    for (const id of configPointers) lines.push(`_${configPointer(id)}_`);

    port.sendDirect(chatJid, lines.join('\n'));
  } catch (err) {
    log.warn({ err, instance: port.instanceName }, '/model list dynamic catalogue section failed');
  }
}
