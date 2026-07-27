/**
 * Deployments — v3.5 admin-lane surface (T5 b-08; mockup deployments.html SSOT).
 *
 * Honest scope (verified): the multi-host admin lane has zero runtime basis
 * (v35/05: "Deployments … admin lane has zero runtime basis — fully designed
 * concept"). The surface renders the ONE real deployment (local · this host)
 * wired live to /api/lines + /api/version + /livez; org-hub and pairing
 * anatomies render as disclosed designed-states.
 */
import { useRef } from 'react'
import { useLines } from '../hooks/use-fleet'
import { SummaryStrip } from '../components/deploy/SummaryStrip'
import { DeploymentCard } from '../components/deploy/DeploymentCard'
import { PairCard } from '../components/deploy/PairCard'
import { Button } from '../components/primitives/Button'

export default function Deployments() {
  const { data: lines } = useLines()
  const pairRef = useRef<HTMLDivElement>(null)

  return (
    <div className="deploy-page">
      <div className="deploy-pagerow">
        <h1>Deployments</h1>
        <span className="deploy-admin">admin lane</span>
        <div className="deploy-pagerow__spacer" />
        <Button variant="primary" onClick={() => pairRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })}>
          ＋ Pair deployment
        </Button>
      </div>
      <main className="deploy-main">
        <SummaryStrip lines={lines ?? []} />
        <DeploymentCard lines={lines ?? []} />
        <PairCard ref={pairRef} />
      </main>
    </div>
  )
}
