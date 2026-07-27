/**
 * PairCard — v3.5 Deployments pair anatomy (mockup .pair), rendered as an
 * honest designed-state: no pairing endpoint, pair CLI, or QR backend exists
 * (verified against the route table and package.json). The code block is a
 * placeholder, both actions are disabled with the reason disclosed — same
 * posture as b-05's org-hub controls.
 */
import { forwardRef } from 'react'
import { Button } from '../primitives/Button'

export const PairCard = forwardRef<HTMLDivElement>(function PairCard(_props, ref) {
  return (
    <div className="deploy-dcard deploy-pair" ref={ref} data-testid="deploy-pair-card">
      <div className="deploy-pair__head">
        <div className="deploy-dhead__nm">Pair a new deployment</div>
        <p className="deploy-pair__pi">
          Deployment pairing lands with the fleet-federation platform work — there is no
          pairing endpoint, pair CLI, or QR backend today. When it lands, a new deployment
          inherits the org skills hub and admin identity.
        </p>
        <div className="deploy-pair__row">
          <span className="deploy-code" aria-label="No pair code — pairing backend not available">
            — — — — · — — — —
          </span>
          <div className="deploy-acts">
            <Button
              variant="neutral"
              disabled
              title="No pairing endpoint exists — deployment pairing is designed, not built"
              aria-description="Disabled: there is no deployment pairing backend."
            >
              Enter code
            </Button>
            <Button
              variant="ghost"
              disabled
              title="No QR backend exists — deployment pairing is designed, not built"
              aria-description="Disabled: there is no pairing QR backend."
            >
              Show QR
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
})
