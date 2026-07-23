import { type FC, useMemo, useState } from "react";
import { Button } from "../components/primitives/Button";
import EmptyState from "../components/EmptyState";
import { DreamCard } from "../components/dream/DreamCard";
import { DreamReview } from "../components/dream/DreamReview";
import { formatRelative } from "../lib/format-time";
import type { Dream } from "../components/dream/types";

/**
 * Dream Lab (T5 b-06) — the agent self-suggestion review surface.
 *
 * NO Dream backend exists today (verified: no route, no store, no schema).
 * The queue renders the honest empty state and every dream-shaped affordance
 * says so; the anatomy is proven against synthetic fixtures in
 * tests/console/dream-lab.test.tsx. When the Dream API lands, `useDreams()`
 * replaces the empty constant and the surface goes live without UI changes.
 */
function useDreams(): Dream[] {
  return [];
}

const DreamLab: FC = () => {
  const dreams = useDreams();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = useMemo(
    () => dreams.find((d) => d.id === selectedId) ?? dreams[0] ?? null,
    [dreams, selectedId],
  );
  const decided = useMemo(() => dreams.filter((d) => d.state !== "queued"), [dreams]);

  // No Dream API today — the decide path is test-proven on fixtures; when
  // the endpoint lands this posts the decision and invalidates the queue.
  const decide: (id: string, decision: "approved" | "rejected") => void = () => {};

  return (
    <div className="dream-page">
      <div className="dream-pagerow">
        <h1>Dream Lab</h1>
        <span className="dream-qpill" data-testid="dream-qpill">
          <span className="dream-qpill__ic" aria-hidden="true">✦</span>
          {dreams.length === 0
            ? "0 dreams queued"
            : `${dreams.length} dream${dreams.length === 1 ? "" : "s"} queued`}
        </span>
        <div className="dream-pagerow__spacer" />
        <Button
          variant="ghost"
          disabled
          title="decision history lands with the Dream API — nothing decided yet"
          aria-description="decision history lands with the Dream API — nothing decided yet"
        >
          history
        </Button>
      </div>

      <div className="dream-wrap">
        <aside className="dream-queue" aria-label="dream queue">
          <div className="dream-qhead">Queued · review in order</div>
          {dreams.length === 0 ? (
            <div className="dream-empty" data-testid="dream-queue-empty">
              No dreams queued. When an agent suggests a persona, skills, or routine edit, it lands
              here for review in order.
            </div>
          ) : (
            dreams.map((d) => (
              <DreamCard
                key={d.id}
                dream={d}
                selected={selected?.id === d.id}
                onSelect={setSelectedId}
                whenLabel={formatRelative(d.suggestedAt)}
              />
            ))
          )}

          <div className="dream-qhead dream-qhead--mt">Filters</div>
          <Button
            variant="ghost"
            className="dream-fstrip"
            disabled
            title="filters activate when dreams exist — the queue is empty today"
            aria-description="filters activate when dreams exist — the queue is empty today"
          >
            agent: all · type: all · state: queued <span className="dream-fstrip__caret">▾</span>
          </Button>

          <div className="dream-qhead dream-qhead--mt">Recently decided</div>
          <div className="dream-hist">
            {decided.length === 0 ? (
              <div className="dream-empty" data-testid="dream-history-empty">
                Nothing decided yet.
              </div>
            ) : (
              decided.map((d) => (
                <div className="dream-hrow" key={d.id}>
                  <span className={`dream-hst dream-hst--${d.state}`}>{d.state}</span>
                  <p title={`${d.agentName} — ${d.summary}`}>
                    <b>{d.agentName}</b> — {d.summary}
                  </p>
                  <span className="dream-hwhen">{formatRelative(d.suggestedAt)}</span>
                </div>
              ))
            )}
          </div>
        </aside>

        <section className="dream-review" aria-label="dream review">
          {selected ? (
            <DreamReview
              dream={selected}
              metaLine={`${selected.agentName.toLowerCase()} · ${selected.kind} · suggested ${formatRelative(selected.suggestedAt)} from instance ${selected.instanceLabel}`}
              onDecide={decide}
            />
          ) : (
            <EmptyState
              title="No dream selected"
              description="Queued dreams appear in the rail; pick one to review its rationale, diff, and impact here."
            />
          )}
        </section>
      </div>
    </div>
  );
};

export default DreamLab;
