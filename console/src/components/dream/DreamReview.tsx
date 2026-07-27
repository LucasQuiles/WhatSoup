import { Fragment, type FC } from 'react';
import { Button } from '../primitives/Button';
import { DreamAvatar } from './DreamCard';
import type { Dream } from './types';

/** Review pane (mockup .review): rhead, rationale, proposed diff (capped
 *  72ch — the bead acceptance item), impact columns, decision actions.
 *  The decide callback is wired by the page; with no Dream API today the
 *  page never renders this component for real, so actions are test-proven. */
export const DreamReview: FC<{
  dream: Dream;
  metaLine: string;
  onDecide: (id: string, decision: 'approved' | 'rejected') => void;
}> = ({ dream, metaLine, onDecide }) => (
  <>
    <div className="dream-rhead">
      <DreamAvatar name={dream.agentName} size="lg" />
      <div className="dream-rhead__body">
        <h2>
          {dream.kind === 'persona' ? 'Persona edit' : dream.kind === 'skills' ? 'Skills edit' : 'Routine edit'} — {dream.summary}
        </h2>
        <div className="dream-rhead__meta">{metaLine}</div>
      </div>
    </div>

    <div className="dream-rationale">
      <span className="dream-rationale__ic" aria-hidden="true">✦</span>
      <p>“{dream.rationale}”</p>
    </div>

    <div className="dream-panel">
      <div className="dream-panel__h">
        <h3>Proposed diff</h3>
        <span className="dream-panel__tag">{dream.diffTarget}</span>
      </div>
      <div className="dream-panel__b dream-diff">
        {dream.diff.map((sec, si) => (
          <Fragment key={`sec-${si}`}>
            <span className="dream-diff__sec">{sec.title}</span>
            {sec.lines.map((line, i) => (
              <span
                key={`${sec.title}-${i}`}
                className={`dream-diff__line dream-diff__line--${line.kind}`}
              >
                {line.kind === 'del' ? '- ' : line.kind === 'add' ? '+ ' : '  '}
                {line.text}
              </span>
            ))}
          </Fragment>
        ))}
      </div>
    </div>

    <div className="dream-panel">
      <div className="dream-panel__h">
        <h3>Impact</h3>
      </div>
      <div className="dream-panel__b dream-impact">
        <div className="dream-impact__col">
          <div className="dream-impact__k">Applies to</div>
          <div className="dream-impact__v">{dream.impact.appliesTo}</div>
        </div>
        <div className="dream-impact__col">
          <div className="dream-impact__k">Reversible</div>
          <div className="dream-impact__v">{dream.impact.reversible}</div>
        </div>
        <div className="dream-impact__col">
          <div className="dream-impact__k">Risk</div>
          <div className="dream-impact__v">{dream.impact.risk}</div>
        </div>
      </div>
    </div>

    <div className="dream-actions">
      <Button variant="primary" onClick={() => onDecide(dream.id, 'approved')}>
        ✓ Approve &amp; apply
      </Button>
      <Button variant="danger" onClick={() => onDecide(dream.id, 'rejected')}>
        ✕ Reject
      </Button>
    </div>
    <div className="dream-actions-note">Approval applies to the profile; instances pick it up next turn.</div>
  </>
);
