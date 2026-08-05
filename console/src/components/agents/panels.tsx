import { useState, type FC, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { useToast } from '../../hooks/toast-context';
import { Button } from '../primitives/Button';
import { TextInput } from '../primitives/FormControl';
import type { LiveSession, ProviderStatus } from '../../types';
import { isNonEmptyString } from '../../lib/type-guards';

/* ── Shared panel shell (mockup .panel/.panel-h/.panel-b) ── */

export const AgentsPanel: FC<{
  title: string;
  tag?: string;
  action?: ReactNode;
  children: ReactNode;
}> = ({ title, tag, action, children }) => (
  <div className="agents-panel">
    <div className="agents-panel__h">
      <h3>{title}</h3>
      {tag ? <span className="agents-panel__tag">{tag}</span> : null}
      <div className="agents-panel__spacer" />
      {action}
    </div>
    <div className="agents-panel__b">{children}</div>
  </div>
);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string | null => (isNonEmptyString(v) ? v : null);

/* ── Brain (mockup .panel: kv rows + swapbar) ─────────────────────────────
   Real data: GET /api/lines/:name/provider-status. The swapbar writes
   agentOptions.model via the existing configUpdate route (deep-merge, so
   sibling agentOptions keys are preserved). */

export const BrainPanel: FC<{ lineName: string; status: ProviderStatus | undefined }> = ({
  lineName,
  status,
}) => {
  const [draft, setDraft] = useState('');
  const [swapping, setSwapping] = useState(false);
  const queryClient = useQueryClient();
  const toast = useToast();

  const primary = status?.primary;
  const fallback = status?.fallback;
  const onFallback = fallback?.active === true;

  const swap = async () => {
    const model = draft.trim();
    if (!model) return;
    setSwapping(true);
    try {
      await api.updateConfig(lineName, { agentOptions: { model } });
      toast.success(`Brain swap queued: ${model}`);
      setDraft('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['provider-status', lineName] }),
        queryClient.invalidateQueries({ queryKey: ['lines', lineName] }),
      ]);
    } catch (e) {
      toast.error(`Swap failed: ${(e as Error).message}`);
    } finally {
      setSwapping(false);
    }
  };

  return (
    <AgentsPanel title="Brain" tag="hot-swap w/ handoff">
      <div className="agents-kv">
        <span className="agents-kv__k">provider</span>
        <span className="agents-kv__v agents-kv__v--mono">{primary?.provider ?? '—'}</span>
      </div>
      <div className="agents-kv">
        <span className="agents-kv__k">model</span>
        <span className="agents-kv__v agents-kv__v--mono">{primary?.model ?? '—'}</span>
      </div>
      <div className="agents-kv">
        <span className="agents-kv__k">fallback</span>
        <span className={`agents-kv__v agents-kv__v--mono${onFallback ? ' agents-kv__v--live' : ''}`}>
          {fallback?.provider
            ? `${fallback.provider}${fallback.model ? ` · ${fallback.model}` : ''}${onFallback ? ' · serving now' : ''}`
            : '—'}
        </span>
      </div>
      <div className="agents-swapbar">
        <span className="agents-swapbar__cur">{primary?.model ?? '—'}</span>
        <span className="agents-swapbar__arrow">→</span>
        <TextInput
          className="agents-swapbar__input"
          placeholder="choose new brain…"
          aria-label="new model"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void swap();
          }}
        />
        <Button variant="neutral" size="sm" onClick={() => void swap()} disabled={swapping || draft.trim() === ''}>
          Swap
        </Button>
      </div>
    </AgentsPanel>
  );
};

/* ── Tool permissions (mockup .trow/.tgl) ─────────────────────────────────
   Honest toggles: only knobs the instance schema actually declares
   (agentOptions.sandbox.bash.enabled, agentOptions.mcp.send_media). Writes go
   through configUpdate; everything else renders as read-only state from the
   live config — never an affordance for a knob the runtime doesn't have. */

interface ToolRow {
  key: string;
  label: string;
  on: boolean;
  scope: string;
  patch?: Record<string, unknown>;
}

export const ToolsPanel: FC<{ lineName: string; config: Record<string, unknown> | undefined }> = ({
  lineName,
  config,
}) => {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const agentOptions = isRecord(config?.agentOptions) ? config.agentOptions : {};
  const sandbox = isRecord(agentOptions.sandbox) ? agentOptions.sandbox : {};
  const bash = isRecord(sandbox.bash) ? sandbox.bash : {};
  const mcp = isRecord(agentOptions.mcp) ? agentOptions.mcp : {};
  const memory = isRecord(config?.memory) ? config.memory : undefined;

  const bashEnabled = typeof bash.enabled === 'boolean' ? bash.enabled : null;
  const sendMedia = typeof mcp.send_media === 'boolean' ? mcp.send_media : null;
  const sandboxPerChat = agentOptions.sandboxPerChat === true;

  const rows: ToolRow[] = [];
  if (bashEnabled !== null) {
    rows.push({
      key: 'bash',
      label: 'Shell',
      on: bashEnabled,
      scope: bash.pathRestricted === true ? 'workspace-only' : 'unrestricted paths',
      patch: { agentOptions: { sandbox: { bash: { enabled: !bashEnabled } } } },
    });
  }
  if (sendMedia !== null) {
    rows.push({
      key: 'send-media',
      label: 'MCP send media',
      on: sendMedia,
      scope: 'send only',
      patch: { agentOptions: { mcp: { send_media: !sendMedia } } },
    });
  }
  if (memory) {
    rows.push({ key: 'memory', label: 'Memory write', on: true, scope: 'scoped store' });
  }
  // Declared-knobs-only law: the empty config renders the honest empty note,
  // not a panel of defaults the operator never set.
  if ('sandboxPerChat' in agentOptions || 'sessionScope' in agentOptions) {
    rows.push({
      key: 'sandbox-per-chat',
      label: 'Sandbox per chat',
      on: sandboxPerChat,
      scope: str(agentOptions.sessionScope) ?? 'per chat',
    });
  }

  const toggle = async (row: ToolRow) => {
    if (!row.patch) return;
    setPendingKey(row.key);
    try {
      await api.updateConfig(lineName, row.patch);
      await queryClient.invalidateQueries({ queryKey: ['lines', lineName] });
    } catch (e) {
      toast.error(`Toggle failed: ${(e as Error).message}`);
    } finally {
      setPendingKey(null);
    }
  };

  if (rows.length === 0) {
    return (
      <AgentsPanel title="Tool permissions" tag="granular">
        <div className="agents-empty">No tool knobs declared in this agent's config.</div>
      </AgentsPanel>
    );
  }

  return (
    <AgentsPanel title="Tool permissions" tag="granular">
      {rows.map((row) => (
        <div className="agents-trow" key={row.key}>
          <Button
            variant="ghost"
            role="switch"
            aria-checked={row.on}
            aria-label={`${row.label}${row.patch ? '' : ' (read-only — managed in line config)'}`}
            className="agents-tgl"
            disabled={!row.patch || pendingKey !== null}
            onClick={() => void toggle(row)}
          />
          <span className="agents-trow__lbl">{row.label}</span>
          <span className="agents-trow__scope">{row.scope}</span>
        </div>
      ))}
    </AgentsPanel>
  );
};

/* ── Assigned lines (mockup .lrow/.g) ─────────────────────────────────────
   Today agent↔line is 1:1 (the agent config lives ON the line). The grant
   chip stays the b-03 hidden-by-default recipe until the Grant API lands
   (R3-13) — never a fabricated level. */

export const AssignedLinesPanel: FC<{
  displayName: string;
  phone: string | null;
  channelLabel: string;
}> = ({ displayName, phone, channelLabel }) => (
  <AgentsPanel title="Assigned lines" tag="grant levels">
    <div className="agents-lrow">
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 1a7 7 0 0 0-6 10.5L1 15l3.6-1A7 7 0 1 0 8 1z" />
      </svg>
      <div>
        <div className="agents-lrow__nm">{displayName}</div>
        <div className="agents-lrow__sub">
          {phone ?? '—'} · {channelLabel}
        </div>
      </div>
      <span
        className="agents-grant agents-grant--hid"
        title="grant levels land with the Grant API (R3-13) — hidden by default"
      >
        ?
      </span>
    </div>
  </AgentsPanel>
);

/* ── Instances (mockup .irow) ─────────────────────────────────────────────
   Real data: GET /api/lines/:name/live-sessions (ps-probe × checkpoint join).
   pause/kill have NO fleet endpoint today — an honest note replaces the
   mockup's action buttons rather than dead affordances. */

const etime = (seconds: number | null): string => {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${Math.max(1, Math.floor(seconds))}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
};

const maskCid = (cid: string): string => {
  const [local, domain] = cid.split('@');
  if (!domain) return cid;
  const head = local.slice(0, 8);
  const tail = local.slice(-3);
  return `${head}···${tail}@${domain}`;
};

const rowState = (s: LiveSession): 'live' | 'paused' | 'dead' => {
  if (s.sessionStatus === 'paused') return 'paused';
  if (s.pidAlive === false || s.anomaly === 'resumable-but-pid-dead') return 'dead';
  return 'live';
};

export const InstancesPanel: FC<{
  sessions: LiveSession[] | undefined;
  probeError?: boolean;
  readError?: boolean;
}> = ({ sessions, probeError, readError }) => {
  const [expanded, setExpanded] = useState(false);
  const list = sessions ?? [];
  const visible = expanded ? list : list.slice(0, 4);

  return (
    <AgentsPanel title="Instances" tag={`${list.length} per-chat`}>
      {readError ? (
        <div className="agents-empty">Session read failed — storage unavailable. Showing nothing rather than a fake calm state.</div>
      ) : probeError ? (
        <div className="agents-empty">Session probe failed — liveness unknown, showing nothing rather than a fake calm state.</div>
      ) : list.length === 0 ? (
        <div className="agents-empty">No live sessions.</div>
      ) : (
        <>
          {visible.map((s) => {
            const state = rowState(s);
            return (
              <div className="agents-irow" key={s.conversationKey}>
                <span
                  className={`agents-irow__st${state === 'paused' ? ' agents-irow__st--paused' : ''}${state === 'dead' ? ' agents-irow__st--dead' : ''}`}
                  role="img"
                  aria-label={`${state} session`}
                />
                <span className="agents-irow__ago">{etime(s.pidEtimeSeconds)}</span>
                <span className="agents-irow__cid" title={s.conversationKey}>
                  {maskCid(s.conversationKey)}
                </span>
                {s.anomaly ? <span className="agents-irow__anom">{s.anomaly}</span> : null}
              </div>
            );
          })}
          {list.length > 4 ? (
            <div className="agents-irow agents-irow--center">
              <Button variant="ghost" className="agents-chip agents-chip--add" onClick={() => setExpanded((v) => !v)}>
                {expanded ? 'show fewer ▴' : `show all ${list.length} instances ▾`}
              </Button>
            </div>
          ) : null}
        </>
      )}
      <div className="agents-inote">pause/kill land with the session-control API — no fleet endpoint today.</div>
    </AgentsPanel>
  );
};

/* ── Skills (mockup .chips/.chip) ─────────────────────────────────────────
   Real data: agentOptions.enabledPlugins (key → on/off). "Add from Hub"
   navigates to the Skills Hub surface (b-05). */

export const SkillsPanel: FC<{ config: Record<string, unknown> | undefined }> = ({ config }) => {
  const navigate = useNavigate();
  const agentOptions = isRecord(config?.agentOptions) ? config.agentOptions : {};
  const plugins = isRecord(agentOptions.enabledPlugins) ? agentOptions.enabledPlugins : {};
  const entries = pluginEntries(plugins);

  return (
    <AgentsPanel title="Skills" tag="via Hub">
      <div className="agents-chips">
        {entries.length === 0 ? (
          <span className="agents-empty">No plugins declared — runtime defaults apply.</span>
        ) : (
          entries.map(([key, on]) => (
            <span className="agents-chip" key={key}>
              <span className="agents-chip__ok" aria-hidden="true">
                {on ? '●' : '○'}
              </span>
              {key}
            </span>
          ))
        )}
        <Button variant="ghost" className="agents-chip agents-chip--add" onClick={() => navigate('/skills')}>
          ＋ add from Hub
        </Button>
      </div>
    </AgentsPanel>
  );
};

// plugins map values may be non-boolean in hand-edited configs — coerce honestly.
function pluginEntries(plugins: Record<string, unknown>): [string, boolean][] {
  return Object.entries(plugins).map(([k, v]) => [k, v === true]);
}

/* ── Memory (mockup .mem-stats/.integ) ────────────────────────────────────
   Real data: config.memory.* (store configuration). Vector counts and
   episodic health are NOT exposed by the fleet API — EM_DASH honesty. */

export const MemoryPanel: FC<{ config: Record<string, unknown> | undefined }> = ({ config }) => {
  const memory = isRecord(config?.memory) ? config.memory : undefined;
  const pinecone = memory && isRecord(memory.pinecone) ? memory.pinecone : undefined;
  const episodic = memory && isRecord(memory.conversation) ? memory.conversation : undefined;
  const indexName = pinecone ? str(pinecone.index) ?? str(pinecone.indexName) : null;

  return (
    <AgentsPanel title="Memory" tag="per-agent store">
      <div className="agents-mstats">
        <div className="agents-mstat">
          <div className="agents-mstat__k">Vectors</div>
          <div className="agents-mstat__v">
            — <span className="agents-mstat__sub">not instrumented</span>
          </div>
        </div>
        <div className="agents-mstat">
          <div className="agents-mstat__k">Episodic</div>
          <div className="agents-mstat__v">
            {episodic ? 'configured' : '—'} <span className="agents-mstat__sub">{episodic ? 'conversation store' : 'no config'}</span>
          </div>
        </div>
        <div className="agents-mstat">
          <div className="agents-mstat__k">Pinecone</div>
          <div className="agents-mstat__v">
            {pinecone ? 'configured' : '—'} <span className="agents-mstat__sub">{indexName ?? (pinecone ? 'index unset' : 'no config')}</span>
          </div>
        </div>
      </div>
      <div className="agents-integ">
        <span className={`agents-integ__st${pinecone ? '' : ' agents-integ__st--off'}`} aria-hidden="true" />
        {pinecone ? `pinecone · ${indexName ?? 'index unset'}` : 'no vector store configured'}
        <span style={{ marginLeft: 'auto', color: 'var(--text-3-v35)' }}>
          {pinecone ? 'config present' : 'connect via line config'}
        </span>
      </div>
      <div className="agents-inote">memory search + live stats land when the fleet API instruments the store.</div>
    </AgentsPanel>
  );
};
