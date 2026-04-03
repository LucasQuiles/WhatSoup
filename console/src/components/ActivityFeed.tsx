import { type FC, useState, useMemo } from "react";
import { Pause, Play, AlertTriangle } from "lucide-react";
import { formatTime } from "../lib/format-time";
import FilterPill from "./FilterPill";
import type { Mode, FeedEvent } from "../types";

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

const reasonLabel: Record<string, string> = {
  unavailableService: "unavailable",
  connectionClosed: "closed",
  connectionLost: "lost",
  connectionReplaced: "replaced",
  timedOut: "timed out",
  loggedOut: "logged out",
  Unknown: "unknown",
};

function statusCodeColor(code?: number): string {
  if (!code) return "text-t4";
  if (code >= 500) return "text-s-crit";
  if (code >= 400) return "text-s-warn";
  return "text-t3";
}

function Badge({ children, color = "text-t3" }: { children: React.ReactNode; color?: string }) {
  return (
    <span
      className={`inline-flex items-center font-mono font-medium ${color}`}
      style={{
        fontSize: "var(--font-size-label)",
        letterSpacing: "var(--tracking-pill)",
        padding: "0 var(--sp-1h)",
        borderRadius: "var(--radius-sm)",
        backgroundColor: "var(--color-d4)",
        borderWidth: "var(--bw)",
        borderStyle: "solid",
        borderColor: "var(--b2)",
      }}
    >
      {children}
    </span>
  );
}

function FeedCardContent({ event }: { event: FeedEvent }) {
  const d = event.detail;
  const isErr = event.isError;

  const inst = event.instance ? (
    <span className="text-t2 font-medium" style={{ marginRight: "var(--sp-1)" }}>
      {event.instance}
    </span>
  ) : null;

  if (!d || d.type === "generic") {
    const text = event.instance && event.text.startsWith(`${event.instance}: `)
      ? event.text.slice(event.instance.length + 2)
      : event.text;
    return <>{inst}<span>{text}</span></>;
  }

  switch (d.type) {
    case "connection": {
      if (d.reconnecting) {
        return <>{inst}<span className="text-t4">reconnecting</span></>;
      }
      const code = d.statusCode;
      const reason = d.reason ? (reasonLabel[d.reason] ?? d.reason) : undefined;
      return (
        <>
          {inst}
          {code && <Badge color={statusCodeColor(code)}>{code}</Badge>}
          {reason && <span className={isErr ? "text-s-crit" : "text-t3"} style={{ marginLeft: "var(--sp-1)" }}>{reason}</span>}
        </>
      );
    }
    case "tool_error":
      return (
        <>
          {inst}
          <Badge>{d.toolName}</Badge>
          <span className="text-s-crit" style={{ marginLeft: "var(--sp-1)" }}>
            {d.error.length > 80 ? d.error.slice(0, 80) + "\u2026" : d.error}
          </span>
        </>
      );
    case "session": {
      const shortId = d.sessionId ? d.sessionId.slice(0, 8) : undefined;
      return (
        <>
          {inst}
          <span className={isErr ? "text-s-crit" : "text-m-agt"}>{d.action}</span>
          {shortId && <span className="text-t5" style={{ marginLeft: "var(--sp-1)" }}>{shortId}</span>}
          {d.reason && <span className="text-t4" style={{ marginLeft: "var(--sp-1)" }}>{"\u2014"} {d.reason}</span>}
        </>
      );
    }
    case "health": {
      const statusColor = d.status === "online" ? "text-s-ok" : d.status === "unreachable" ? "text-s-crit" : "text-s-warn";
      const label = d.status === "online" ? "came online" : d.status === "unreachable" ? "connection lost" : `degraded \u2014 ${d.error ?? "unknown"}`;
      return <>{inst}<span className={statusColor}>{label}</span></>;
    }
    case "message": {
      const dirColor = d.direction === "inbound" ? "text-m-cht" : "text-m-agt";
      const chatShort = d.chatJid ? d.chatJid.replace(/@.*/, "").slice(-8) : undefined;
      return (
        <>
          {inst}
          <Badge color={dirColor}>{d.direction === "inbound" ? "recv" : "sent"}</Badge>
          {chatShort && <span className="text-t4" style={{ marginLeft: "var(--sp-1)" }}>{chatShort}</span>}
        </>
      );
    }
    case "import":
      return (
        <>
          {inst}
          <Badge>import</Badge>
          <span className="text-t3" style={{ marginLeft: "var(--sp-1)" }}>
            {d.table}{d.skipped ? " (skipped)" : d.count !== undefined ? ` \u2014 ${d.count} rows` : ""}
          </span>
        </>
      );
    default:
      return <span>{event.text}</span>;
  }
}

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
          style={{ borderBottom: "var(--bw) solid var(--b1)", minHeight: "var(--toolbar-h)" }}
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
                padding: "var(--sp-2h) var(--sp-3)",
                borderBottom: "var(--bw) solid var(--b1)",
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

              {/* Content */}
              <span
                className={`font-mono leading-normal flex items-center ${isErr ? "text-s-crit" : "text-t3"}`}
                style={{ fontSize: "var(--font-size-sm)", gap: "var(--sp-1)" }}
              >
                <FeedCardContent event={event} />
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
