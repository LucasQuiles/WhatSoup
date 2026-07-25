/**
 * StepRail — the journey step rail (14-onboarding §1: bars + labels;
 * done = hairline + ✓, current = accent, upcoming = recessed).
 */
const STEPS = ['Kind', 'Channel', 'Agent', 'Link', 'Hatch'] as const
export type JourneyStepId = 0 | 1 | 2 | 3 | 4

export function StepRail({ current }: { current: JourneyStepId }) {
  return (
    <div className="journey-steps" aria-label={`Hatch step ${current + 1} of ${STEPS.length}: ${STEPS[current]}`}>
      {STEPS.map((label, i) => (
        <div
          key={label}
          className={`journey-step${i < current ? ' journey-step--done' : i === current ? ' journey-step--now' : ''}`}
          aria-current={i === current ? 'step' : undefined}
        >
          <div className="journey-step__bar" />
          <span>{label}</span>
        </div>
      ))}
    </div>
  )
}
