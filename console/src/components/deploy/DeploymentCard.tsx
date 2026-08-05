/**
 * DeploymentCard — v3.5 Deployments card anatomy (mockup deployments.html
 * .dcard): head (icon, name, sub, state pill, version, actions), 4-cell body
 * (lines / agents / issues-or-load / uptime), org-hub row.
 *
 * Honest build: the only deployment that exists is this host (the admin lane
 * is a designed concept with zero runtime basis, v35/05 §instance-model).
 * Org-hub row renders the designed anatomy disabled with the no-endpoint
 * note (the b-05 posture verbatim).
 */
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import type { LineInstance } from '../../types'
import { api } from '../../lib/api'
import {
  CHANNEL_SHORT,
  DEPLOYMENT_STATE_LABEL,
  channelCountsOf,
  countOnline,
  agentLinesOf,
  issueLinesOf,
  deploymentStateOf,
  formatUptime,
  miniTagOverflow,
} from '../../lib/deployments'
import { Button } from '../primitives/Button'

const STATE_CLASS: Record<string, string> = {
  healthy: 'deploy-st--ok',
  degraded: 'deploy-st--warn',
  crit: 'deploy-st--crit',
}

export function DeploymentCard({ lines, queryError }: { lines: LineInstance[]; queryError?: boolean }) {
  const navigate = useNavigate()
  const { data: version } = useQuery({
    queryKey: ['version'],
    queryFn: () => api.getVersion(),
    staleTime: 60_000,
  })
  const { data: livez } = useQuery({
    queryKey: ['livez'],
    queryFn: () => api.getLivez(),
    refetchInterval: 60_000,
    retry: false,
  })

  const state = deploymentStateOf(lines, queryError)
  const online = countOnline(lines)
  const channelCounts = channelCountsOf(lines)
  const agents = agentLinesOf(lines)
  const issues = issueLinesOf(lines)
  const agentTags = miniTagOverflow(agents.map((l) => l.name))

  return (
    <div className="deploy-dcard" data-testid="deploy-card-local">
      <div className="deploy-dhead">
        <span className="deploy-dicon" aria-hidden="true">
          <svg viewBox="0 0 16 16"><path d="M2 3h12v4H2zM2 9h12v4H2z" /></svg>
        </span>
        <div>
          <div className="deploy-dhead__nm">
            local <span className="deploy-dhead__suffix">· this host</span>
          </div>
          <div className="deploy-dhead__sub">this console&apos;s fleet · primary</div>
        </div>
        <span className={`deploy-st ${STATE_CLASS[state]}`} data-testid="deploy-state">
          {DEPLOYMENT_STATE_LABEL[state]}
        </span>
        <span className="deploy-ver">
          {version ? `v${version.sha.slice(0, 7)}` : 'v…'}
          {version?.updateAvailable ? (
            <span
              className="deploy-ver__up"
              title="In-place update is retired — deploy the release to update this deployment"
            >
              {' '}
              → update available ({version.remoteSha.slice(0, 7)})
            </span>
          ) : null}
        </span>
        <div className="deploy-acts">
          <Button variant="ghost" size="sm" onClick={() => navigate('/')}>
            console
          </Button>
          <Button variant="ghost" size="sm" onClick={() => navigate('/ops')}>
            logs
          </Button>
        </div>
      </div>

      <div className="deploy-dbody">
        <div className="deploy-dcell">
          <div className="deploy-dcell__k">Lines</div>
          <div className="deploy-dcell__v">
            {online} <span className="deploy-dcell__sub">/ {lines.length}</span>
          </div>
          <div className="deploy-mini">
            {[...channelCounts.entries()].map(([kind, n]) => (
              <span key={kind}>{`${CHANNEL_SHORT[kind] ?? kind} ×${n}`}</span>
            ))}
            {lines.length === 0 ? <span>no lines</span> : null}
          </div>
        </div>
        <div className="deploy-dcell">
          <div className="deploy-dcell__k">Agents</div>
          <div className="deploy-dcell__v">{agents.length}</div>
          <div className="deploy-mini">
            {agentTags.shown.map((n) => (
              <span key={n} className="deploy-mini__agt">
                {n}
              </span>
            ))}
            {agentTags.overflow > 0 ? <span className="deploy-mini__agt">+{agentTags.overflow}</span> : null}
            {agents.length === 0 ? <span>no agent-mode lines</span> : null}
          </div>
        </div>
        <div className="deploy-dcell">
          <div className="deploy-dcell__k">{issues.length > 0 ? 'Issues' : 'Load'}</div>
          <div className="deploy-dcell__v">{issues.length > 0 ? issues.length : '—'}</div>
          <div className="deploy-mini">
            {issues.slice(0, 2).map((l) => (
              <span key={l.name} className="deploy-mini__warn" title={l.statusReason ?? l.status}>
                {l.name}: {l.statusReason ?? l.status}
              </span>
            ))}
            {issues.length > 2 ? <span className="deploy-mini__warn">+{issues.length - 2}</span> : null}
            {issues.length === 0 ? <span>no line issues</span> : null}
          </div>
        </div>
        <div className="deploy-dcell">
          <div className="deploy-dcell__k">Uptime</div>
          <div className="deploy-dcell__v">
            {livez ? formatUptime(livez.uptime_seconds) : '—'}{' '}
            <span className="deploy-dcell__sub">fleet process</span>
          </div>
          <div className="deploy-mini">
            <span>{livez?.alive ? 'live' : 'liveness unread'}</span>
          </div>
        </div>
      </div>

      <div className="deploy-hub">
        <span className="deploy-hub__dot" aria-hidden="true" />
        <span className="deploy-hub__text">org hub — no shared catalog endpoint today</span>
        <Button
          variant="ghost"
          size="sm"
          className="deploy-hub__pull"
          disabled
          title="org hub lands with the hub API — no shared catalog endpoint today"
          aria-description="Disabled: there is no org hub or shared skills endpoint; the row renders the designed anatomy."
        >
          pull updates
        </Button>
      </div>
    </div>
  )
}
