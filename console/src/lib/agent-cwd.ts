import { isNonEmptyString } from './type-guards';

const FALLBACK_AGENT_NAME = 'new-agent';

export function slugAgentWorkspaceName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function normalizeAgentWorkspaceName(name: string): string {
  return slugAgentWorkspaceName(name) || FALLBACK_AGENT_NAME;
}

export function defaultAgentWorkspacePath(name: string): string {
  return `~/.local/share/whatsoup/instances/${normalizeAgentWorkspaceName(name)}/workspace`;
}

export function withDefaultAgentWorkspace<T extends Record<string, unknown>>(data: T): T {
  if (data.type !== 'agent') return data;

  const agentOptions = ((data.agentOptions && typeof data.agentOptions === 'object' && !Array.isArray(data.agentOptions))
    ? data.agentOptions
    : {}) as Record<string, unknown>;
  const cwd = agentOptions.cwd;
  if (isNonEmptyString(cwd)) return data;

  const workspaceName = slugAgentWorkspaceName((data.name as string | undefined) ?? '');
  if (!workspaceName) return data;

  return {
    ...data,
    agentOptions: {
      ...agentOptions,
      cwd: defaultAgentWorkspacePath(workspaceName),
    },
  };
}
