import { type FC, useState, useMemo } from "react";
import { Pause, Play, AlertTriangle, Circle } from "lucide-react";
import FilterPill from "./FilterPill";
import FeedCard from "./FeedCard";
import type { Mode, FeedEvent } from "../types";

interface ActivityFeedProps {
  events: FeedEvent[];
}

const modeFilters: (Mode | "all")[] = ["all", "passive", "chat", "agent"];

const modeTextColor: Record<string, string> = {
  all: "text-t2",
  passive: "text-m-pas",
  chat: "text-m-cht",
  agent: "text-m-agt",
};

type TypeFilter = "all" | "messages" | "connections" | "errors" | "health";

/** Derive a stable key for a feed event (no array index). */
function eventKey(event: FeedEvent): string {
  const d = event.detail;
  const msgId = d?.type === "message" ? (d as { messageId?: string }).messageId : undefined;
  if (msgId) return `msg:${event.instance ?? ""}:${msgId}`;
  const dir = d?.type === "message" ? (d as { direction?: string }).direction ?? "" : "";
  const chat = d?.type === "message" ? (d as { chatJid?: string }).chatJid ?? "" : "";
  return `${event.instance ?? ""}:${event.time}:${d?.type ?? "generic"}:${dir}:${chat}`;
}

const ActivityFeed: FC<ActivityFeedProps> = ({ events }) => {
  const [paused, setPaused] = useState(false);
  const [snapshot, setSnapshot] = useState<FeedEvent[] | null>(null);
  const [modeFilter, setModeFilter] = useState<Mode | "all">("all");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");

  const displayEvents = snapshot ?? events;

  const filtered = useMemo(() => {
    let result = displayEvents;
    if (modeFilter !== "all") result = result.filter((e) => e.mode === modeFilter);
    if (errorsOnly) result = result.filter((e) => e.isError);
    if (typeFilter !== "all") {
      result = result.filter((e) => {
        const t = e.detail?.type;
        switch (typeFilter) {
          case "messages": return t === "message";
          case "connections": return t === "connection";
          case "errors": return t === "tool_error";
          case "health": return t === "health";
          default: return true;
        }
      });
    }
    return result;
  }, [displayEvents, modeFilter, errorsOnly, typeFilter]);

  const errorCount = useMemo(() => displayEvents.filter((e) => e.isError).length, [displayEvents]);

  return (
    <div className={`feed-container ${paused ? "feed-container--paused" : ""}`}>
      {/* ── Toolbar ── */}
      <div className="feed-toolbar">
        <div className="feed-toolbar__left">
          <span className="feed-toolbar__title">Activity</span>
          <Circle
            size={6}
            fill={paused ? "var(--color-s-warn)" : "var(--color-s-ok)"}
            stroke="none"
            style={{ marginLeft: "var(--sp-2)" }}
          />
        </div>

        <button
          type="button"
          onClick={() => {
            if (paused) {
              setSnapshot(null);
              setPaused(false);
            } else {
              setSnapshot(events);
              setPaused(true);
            }
          }}
          className="feed-toolbar__pause"
        >
          {paused ? <Play size={10} /> : <Pause size={10} />}
          {paused ? "resume" : "pause"}
        </button>
      </div>

      {/* ── Filter bar ── */}
      <div className="feed-filters">
        <div className="feed-filters__row">
          {/* Mode filters */}
          {modeFilters.map((m) => (
            <FilterPill
              key={m}
              label={m === "all" ? "All" : m}
              isActive={modeFilter === m}
              activeColor={modeTextColor[m]}
              activeBorder={
                modeFilter === m
                  ? `var(--bw) solid ${m === "passive" ? "var(--color-m-pas)" : m === "chat" ? "var(--color-m-cht)" : m === "agent" ? "var(--color-m-agt)" : "var(--b4)"}`
                  : undefined
              }
              onClick={() => setModeFilter(m)}
            />
          ))}

          <span className="feed-filters__sep" />

          {/* Type filters */}
          {(["all", "messages", "connections", "errors", "health"] as TypeFilter[]).map((t) => (
            <FilterPill
              key={`type-${t}`}
              label={t === "all" ? "All types" : t}
              isActive={typeFilter === t}
              activeColor="text-t2"
              activeBorder={typeFilter === t ? "var(--bw) solid var(--b3)" : undefined}
              onClick={() => setTypeFilter(t)}
            />
          ))}
        </div>

        {/* Error counter */}
        {errorCount > 0 && (
          <FilterPill
            label=""
            isActive={errorsOnly}
            activeColor="text-s-crit"
            activeBorder={errorsOnly ? "var(--bw) solid var(--color-s-crit)" : undefined}
            onClick={() => setErrorsOnly((p) => !p)}
            style={{ gap: "var(--sp-1)" }}
            suffix={
              <>
                <AlertTriangle size={10} strokeWidth={2} />
                <span>{errorCount}</span>
              </>
            }
          />
        )}
      </div>

      {/* ── Feed stream ── */}
      <div className="feed-stream">
        {filtered.map((event) => (
          <FeedCard key={eventKey(event)} event={event} />
        ))}

        {filtered.length === 0 && (
          <div className="feed-empty">
            {errorsOnly ? "No errors" : "No activity"}
          </div>
        )}
      </div>
    </div>
  );
};

export default ActivityFeed;
