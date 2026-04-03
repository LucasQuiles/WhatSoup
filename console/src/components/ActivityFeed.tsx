import { type FC, useState, useMemo } from "react";
import { Pause, Play, AlertTriangle } from "lucide-react";
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
  // Include direction + chatJid to avoid collisions between inbound/outbound at same timestamp
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

  // Pause: capture snapshot on toggle, clear on resume. The snapshot is set
  // in the onClick handler (not an effect), so it captures the exact events
  // visible at the moment the user clicks pause.
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

  const errorCount = useMemo(() => events.filter((e) => e.isError).length, [events]);

  return (
    <div className="flex flex-col h-full">
      {/* Header — 2 rows matching table's toolbar + column header rows */}
      <div className="flex flex-col flex-shrink-0 bg-d3">
        {/* Row 1: Title + pause — matches table toolbar height */}
        <div
          className="flex items-center justify-between c-toolbar"
          style={{ borderBottom: "var(--bw) solid var(--b1)", minHeight: "var(--toolbar-h)" }}
        >
          <span className="c-heading">Live Activity</span>
          <button
            type="button"
            onClick={() => {
              if (paused) {
                // Resume: clear snapshot, show live events
                setSnapshot(null);
                setPaused(false);
              } else {
                // Pause: capture current events as snapshot
                setSnapshot(events);
                setPaused(true);
              }
            }}
            className="flex items-center font-mono text-t5 hover:text-t3 c-hover cursor-pointer"
            style={{ fontSize: "var(--font-size-xs)", gap: "var(--sp-1)" }}
          >
            {paused ? <Play size={11} /> : <Pause size={11} />}
            {paused ? "resume" : "pause"}
          </button>
        </div>

        {/* Row 2: Filter pills — matches table column header row (c-cell + --b2 border) */}
        <div
          className="flex items-center justify-between c-cell"
          style={{ borderBottom: "var(--bw) solid var(--b2)" }}
        >
          <div className="flex items-center" style={{ gap: "var(--sp-1)" }}>
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

            {/* Separator */}
            <span className="text-t5" style={{ margin: "0 var(--sp-1)" }}>|</span>

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
      </div>

      {/* Feed items */}
      <div className="flex-1 overflow-y-auto scrollbar-hide">
        {filtered.map((event) => (
          <FeedCard key={eventKey(event)} event={event} />
        ))}

        {filtered.length === 0 && (
          <div
            className="text-center text-t5 font-mono"
            style={{ padding: "var(--sp-8) var(--sp-4)", fontSize: "var(--font-size-sm)" }}
          >
            {errorsOnly ? "No errors" : "No activity"}
          </div>
        )}
      </div>
    </div>
  );
};

export default ActivityFeed;
