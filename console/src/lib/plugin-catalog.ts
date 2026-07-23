/**
 * plugin-catalog (T5 b-05) — the console's known-plugin catalog, extracted
 * from the hatch wizard (ConfigStep) so the Skills Hub and the wizard read
 * the same SSOT. Entries are real: every key is installable via
 * agentOptions.enabledPlugins today.
 *
 * Source classes map the entry's marketplace namespace onto the mockup's
 * badge vocabulary (skills-hub.html .src): official = claude-plugins-official;
 * community = superpowers-marketplace; local = *-dev sources. The catalog
 * carries no third-party/unverified entries today — the warn-note anatomy
 * exists for when one lands.
 */

export type PluginCategory = 'core' | 'dev' | 'integration' | 'lsp';
export type PluginSource = 'official' | 'community' | 'local' | 'thirdparty';

export interface PluginCatalogEntry {
  key: string;
  label: string;
  description: string;
  category: PluginCategory;
  /** Parsed from the key's @namespace — never hand-declared. */
  source: PluginSource;
}

const RAW_CATALOG: Array<Omit<PluginCatalogEntry, 'source'>> = [
  // Core
  { key: 'superpowers@superpowers-marketplace', label: 'Superpowers', description: 'Brainstorming, TDD, debugging, plans, verification', category: 'core' },
  { key: 'episodic-memory@superpowers-marketplace', label: 'Episodic Memory', description: 'Cross-session conversation memory', category: 'core' },
  { key: 'commit-commands@claude-plugins-official', label: 'Commit Commands', description: 'Git commit, push, PR workflows', category: 'core' },
  { key: 'elements-of-style@superpowers-marketplace', label: 'Elements of Style', description: 'Writing quality for docs and messages', category: 'core' },
  { key: 'claude-md-management@claude-plugins-official', label: 'CLAUDE.md Management', description: 'Audit and improve instruction files', category: 'core' },
  { key: 'hookify@claude-plugins-official', label: 'Hookify', description: 'Create hooks from conversation analysis', category: 'core' },
  // Dev
  { key: 'sdlc-os@sdlc-os-dev', label: 'SDLC-OS', description: 'Multi-agent SDLC workflow (45 agents, heavy context)', category: 'dev' },
  { key: 'tmup@tmup-dev', label: 'tmup', description: 'Multi-agent task coordination via tmux', category: 'dev' },
  { key: 'ralph-loop-v2@ralph-loop-v2-dev', label: 'Ralph Loop v2', description: 'Hardened iteration loops with telemetry', category: 'dev' },
  { key: 'plugin-dev@claude-plugins-official', label: 'Plugin Dev', description: 'Plugin creation and validation tools', category: 'dev' },
  { key: 'superpowers-developing-for-claude-code@superpowers-marketplace', label: 'CC Dev Docs', description: 'Official CC documentation', category: 'dev' },
  { key: 'feature-dev@claude-plugins-official', label: 'Feature Dev', description: 'Guided feature development workflow', category: 'dev' },
  { key: 'code-review@claude-plugins-official', label: 'Code Review', description: 'Confidence-based code review', category: 'dev' },
  { key: 'frontend-design@claude-plugins-official', label: 'Frontend Design', description: 'Production-grade UI generation', category: 'dev' },
  { key: 'security-guidance@claude-plugins-official', label: 'Security Guidance', description: 'Security best practices', category: 'dev' },
  // Integrations
  { key: 'microsoft_365@microsoft-365-dev', label: 'Microsoft 365', description: 'Email, calendar, Teams, SharePoint', category: 'integration' },
  { key: 'microsoft-docs@claude-plugins-official', label: 'Microsoft Docs', description: 'Official Microsoft documentation search', category: 'integration' },
  { key: 'superpowers-chrome@superpowers-marketplace', label: 'Chrome DevTools', description: 'Browser inspection and automation', category: 'integration' },
  { key: 'superpowers-lab@superpowers-marketplace', label: 'Superpowers Lab', description: 'Slack, Windows VM, tmux, duplicate detection', category: 'integration' },
  { key: 'playwright@claude-plugins-official', label: 'Playwright', description: 'Browser automation and testing', category: 'integration' },
  // LSP
  { key: 'pyright-lsp@claude-plugins-official', label: 'Pyright LSP', description: 'Python language server', category: 'lsp' },
  { key: 'typescript-lsp@claude-plugins-official', label: 'TypeScript LSP', description: 'TypeScript language server', category: 'lsp' },
];

/** namespace → mockup source badge class. Unknown namespaces parse to
 *  thirdparty — a NEW source lands with the warn-note anatomy automatically. */
export function sourceOf(key: string): PluginSource {
  const ns = key.split('@')[1] ?? '';
  if (ns === 'claude-plugins-official') return 'official';
  if (ns === 'superpowers-marketplace') return 'community';
  if (ns.endsWith('-dev')) return 'local';
  return 'thirdparty';
}

export const PLUGIN_CATALOG: PluginCatalogEntry[] = RAW_CATALOG.map((e) => ({
  ...e,
  source: sourceOf(e.key),
}));

export const CATEGORY_LABELS: Record<PluginCategory, string> = {
  core: 'Core',
  dev: 'Development',
  integration: 'Integrations',
  lsp: 'Language servers',
};

/** The wizard's plugin picker consumes the catalog in its declared order. */
export const ALL_PLUGINS = PLUGIN_CATALOG;
