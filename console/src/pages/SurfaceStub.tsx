/**
 * SurfaceStub — honest placeholder for v3.5 surfaces whose routes are shelled
 * by T5 b-02 but whose content lands with a later bead (20-t5-cutover-plan.md:
 * b-04 Agents, b-05 Skills, b-06 Dream Lab, b-08 Deployments, b-09 Settings).
 * No mock UI — the surface name, the bead that will fill it, and nothing else.
 * Owns the route's h1 (h1 law: the page surface, never the chrome header).
 */
import { type FC } from 'react';

interface SurfaceStubProps {
  surface: string;
  bead: string;
}

const SurfaceStub: FC<SurfaceStubProps> = ({ surface, bead }) => (
  <div className="flex-1 flex items-center justify-center min-h-0">
    <div className="text-center">
      <h1 className="text-text-2 font-medium">{surface}</h1>
      <p className="text-text-3 font-mono text-xs mt-[var(--sp-1)]">
        This surface lands with bead {bead} (docs/design-system/v35/20-t5-cutover-plan.md).
      </p>
    </div>
  </div>
);

export default SurfaceStub;
