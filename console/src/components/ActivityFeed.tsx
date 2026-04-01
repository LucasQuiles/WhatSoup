import { type FC, useState, useMemo } from "react";
import { Pause, Play, AlertTriangle } from "lucide-react";
import { formatTime } from "../lib/format-time";

type Mode = "passive" | "chat" | "agent";

interface FeedEvent {
  time: string;
  mode: Mode;
  text: string;
  isError?: boolean;
}

interface ActivityFeedProps {
  events: FeedEvent[];
}

const modeFilters: (Mode | "all")[] = ["all", "passive", "chat", "agent"];

const modeDotColor: Record<Mode, string> = {
  passive: "bg-m-pas",
  chat: "bg-m-cht",
  agent: "bg-m-agt",
};

const modeTextColor: Record<string, string> = {
  all: "text-t2",
  passive: "text-m-pas",
  chat: "text-m-cht",
  agent: "text-m-agt",
};

const ActivityFeed: FC<ActivityFeedProps> = ({ events }) => {
  const [paused, setPaused] = useState(false);
  const [modeFilter, setModeFilter] = useState<Mode | "all">("all");
  const [errorsOnly, setErrorsOnly] = useState(false);

  const filtered = useMemo(() => {
    let result = events;
    if (modeFilter !== "all") result = result.filter((e) => e.mode === modeFilter);
    if (errorsOnly) result = result.filter((e) => e.isError);
    return result;
  }, [events, modeFilter, errorsOnly]);

  const errorCount = useMemo(() => events.filter((e) => e.isError).length, [events]);

  return (
    <div className="flex flex-col h-full">
      {/* Header — 2 rows matching table's toolbar + column header rows */}
      <div className="flex flex-col flex-shrink-0 bg-d3">
        {/* Row 1: Title + pause — matches table toolbar height */}
        <div
          className="flex items-center justify-between c-toolbar"
          style={{ borderBottom: "1px solid var(--b1)", minHeight: "var(--toolbar-h)" }}
        >
          <span className="c-heading">Live Activity</span>
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
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
          style={{ borderBottom: "1px solid var(--b2)" }}
        >
          <div className="flex items-center" style={{ gap: "var(--sp-1)" }}>
            {modeFilters.map((m) => {
              const isActive = modeFilter === m;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => setModeFilter(m)}
                  className={`font-mono cursor-pointer c-hover inline-flex items-center ${
                    isActive ? modeTextColor[m] + " bg-d4" : "text-t4 hover:text-t2 hover:bg-d3"
                  }`}
                  style={{
                    fontSize: "var(--font-size-label)",
                    letterSpacing: 'var(--tracking-pill)',
                    padding: "3px var(--sp-2)",
                    borderRadius: "var(--radius-sm)",
                    border: isActive
                      ? `1px solid ${m === "passive" ? "var(--color-m-pas)" : m === "chat" ? "var(--color-m-cht)" : m === "agent" ? "var(--color-m-agt)" : "var(--b4)"}`
                      : "1px solid var(--b1)",
                  }}
                >
                  {m === "all" ? "All" : m}
                </button>
              );
            })}
          </div>

          {errorCount > 0 && (
            <button
              type="button"
              onClick={() => setErrorsOnly((p) => !p)}
              className={`inline-flex items-center font-mono cursor-pointer c-hover ${
                errorsOnly ? "text-s-crit bg-d4" : "text-t4 hover:text-t2 hover:bg-d3"
              }`}
              style={{
                fontSize: "var(--font-size-label)",
                gap: "var(--sp-1)",
                padding: "3px var(--sp-2)",
                borderRadius: "var(--radius-sm)",
                border: errorsOnly ? "1px solid var(--color-s-crit)" : "1px solid var(--b1)",
              }}
            >
              <AlertTriangle size={10} strokeWidth={2} />
              <span>{errorCount}</span>
            </button>
          )}
        </div>
      </div>

      {/* Feed items */}
      <div className="flex-1 overflow-y-auto scrollbar-hide">
        {filtered.map((event, i) => {
          const isErr = event.isError;
          return (
            <div
              key={`${event.time}-${event.mode}-${i}`}
              className={`
                flex items-baseline ${isErr ? "" : "c-row-hover"}
              `}
              style={{
                gap: "var(--sp-2)",
                padding: "10px var(--sp-3)",
                borderBottom: "1px solid var(--b1)",
                ...(isErr
                  ? { backgroundColor: "var(--s-crit-wash)" }
                  : {}),
              }}
            >
              {/* Time */}
              <span
                className={`font-mono flex-shrink-0 ${isErr ? "text-s-crit" : "text-t5"}`}
                style={{ fontSize: "var(--font-size-xs)", minWidth: "40px" }}
              >
                {formatTime(event.time)}
              </span>

              {/* Mode dot */}
              <span
                className={`inline-block rounded-full flex-shrink-0 ${
                  isErr ? "bg-s-crit" : modeDotColor[event.mode]
                }`}
                style={{ width: "var(--dot-feed)", height: "var(--dot-feed)", alignSelf: "center", marginTop: "-1px" }}
              />

              {/* Text */}
              <span
                className={`font-mono leading-normal ${isErr ? "text-s-crit" : "text-t3"}`}
                style={{ fontSize: "var(--font-size-sm)" }}
              >
                {event.text}
              </span>
            </div>
          );
        })}

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
