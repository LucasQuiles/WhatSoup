/**
 * SummaryStrip — v3.5 Deployments summary strip (mockup .sum): four KPI
 * cells. Three wire live; "Shared skills" renders the honest no-hub state
 * (the b-05 n/a pattern — never a fabricated count or sync time).
 */
import type { LineInstance } from '../../types'
import {
  DEPLOYMENT_STATE_LABEL,
  agentLinesOf,
  channelCountsOf,
  countOnline,
  deploymentStateOf,
} from '../../lib/deployments'

export function SummaryStrip({ lines, queryError }: { lines: LineInstance[]; queryError?: boolean }) {
  const state = deploymentStateOf(lines, queryError)
  const online = countOnline(lines)
  const channelCount = channelCountsOf(lines).size
  const agents = agentLinesOf(lines)
  const liveAgents = agents.filter((l) => (l.activeSessions ?? 0) > 0).length

  return (
    <section className="deploy-sum" aria-label="Deployment summary">
      <div className="deploy-kpi">
        <div className="deploy-kpi__k">Deployments</div>
        <div className="deploy-kpi__v">1</div>
        <div className="deploy-kpi__d">{DEPLOYMENT_STATE_LABEL[state]} · this host</div>
      </div>
      <div className="deploy-kpi">
        <div className="deploy-kpi__k">Total lines</div>
        <div className="deploy-kpi__v">{lines.length}</div>
        <div className="deploy-kpi__d">
          {online} online · {channelCount} channel{channelCount === 1 ? '' : 's'}
        </div>
      </div>
      <div className="deploy-kpi">
        <div className="deploy-kpi__k">Total agents</div>
        <div className="deploy-kpi__v">{agents.length}</div>
        <div className="deploy-kpi__d">
          {liveAgents} with live sessions · {agents.length - liveAgents} idle
        </div>
      </div>
      <div className="deploy-kpi">
        <div className="deploy-kpi__k">Shared skills</div>
        <div className="deploy-kpi__v">—</div>
        <div className="deploy-kpi__d">no org hub API</div>
      </div>
    </section>
  )
}
