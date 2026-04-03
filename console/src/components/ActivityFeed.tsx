import { type FC, useState, useMemo } from "react";
import { Pause, Play, Circle, Square } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useToast } from "../hooks/toast-context";
import { api } from "../lib/api";
import FilterPill from "./FilterPill";
import FeedCard from "./FeedCard";
import ConfirmDialog from "./ConfirmDialog";
import type { FeedEvent } from "../types";

interface ActivityFeedProps {
  events: FeedEvent[];
}

type FeedFilter = "all" | "msgs" | "conn" | "errors" | "health" | "sessions";

const filterConfig: { key: FeedFilter; label: string }[] = [
  { key: "all", label: "all" },
  { key: "msgs", label: "msgs" },
  { key: "conn", label: "conn" },
  { key: "errors", label: "errors" },
  { key: "health", label: "health" },
  { key: "sessions", label: "sessions" },
];

function matchesFilter(event: FeedEvent, filter: FeedFilter): boolean {
  if (filter === "all") return true;
  const t = event.detail?.type;
  switch (filter) {
    case "msgs": return t === "message";
    case "conn": return t === "connection";
    case "errors": return t === "tool_error" || !!event.isError;
    case "health": return t === "health";
    case "sessions": return t === "session";
    default: return true;
  }
}

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
  const navigate = useNavigate();
  const toast = useToast();

  const [paused, setPaused] = useState(false);
  const [snapshot, setSnapshot] = useState<FeedEvent[] | null>(null);
  const [filter, setFilter] = useState<FeedFilter>("all");
  const [stopTarget, setStopTarget] = useState<string | null>(null);

  const displayEvents = snapshot ?? events;

  const filtered = useMemo(
    () => displayEvents.filter((e) => matchesFilter(e, filter)),
    [displayEvents, filter],
  );

  const filterCounts = useMemo(() => {
    const counts: Record<FeedFilter, number> = { all: displayEvents.length, msgs: 0, conn: 0, errors: 0, health: 0, sessions: 0 };
    for (const e of displayEvents) {
      const t = e.detail?.type;
      if (t === "message") counts.msgs++;
      if (t === "connection") counts.conn++;
      if (t === "tool_error" || e.isError) counts.errors++;
      if (t === "health") counts.health++;
      if (t === "session") counts.sessions++;
    }
    return counts;
  }, [displayEvents]);

  // Only the newest unresolved connection/health error per instance gets restart/stop
  const actionableKeys = useMemo(() => {
    const seen = new Set<string>();
    const keys = new Set<string>();
    for (const event of filtered) {
      const inst = event.instance;
      const d = event.detail;
      if (!inst || seen.has(inst)) continue;
      if (d?.type === "connection" && d.state === "connected") { seen.add(inst); continue; }
      if (d?.type === "health" && d.status === "online") { seen.add(inst); continue; }
      const isConnErr = d?.type === "connection" && event.isError;
      const isHealthErr = d?.type === "health" && (d.status === "unreachable" || d.status === "degraded");
      if (isConnErr || isHealthErr) {
        seen.add(inst);
        keys.add(eventKey(event));
      }
    }
    return keys;
  }, [filtered]);

  // Per-instance pending lock
  const [pendingInstances, setPendingInstances] = useState<Set<string>>(new Set());

  const handleRestart = (instance: string) => {
    if (pendingInstances.has(instance)) return;
    setPendingInstances((s) => new Set(s).add(instance));
    toast.info(`Restarting ${instance}...`);
    api.restart(instance)
      .then(() => toast.success(`${instance} restart requested`))
      .catch((err: Error) => toast.error(`Failed to restart: ${err.message}`))
      .finally(() => setPendingInstances((s) => { const n = new Set(s); n.delete(instance); return n; }));
  };

  const handleStop = (instance: string) => {
    if (pendingInstances.has(instance)) return;
    setStopTarget(instance);
  };

  const confirmStop = () => {
    if (!stopTarget) return;
    setPendingInstances((s) => new Set(s).add(stopTarget));
    toast.info(`Stopping ${stopTarget}...`);
    api.stopInstance(stopTarget)
      .then(() => toast.success(`${stopTarget} stop requested`))
      .catch((err: Error) => toast.error(`Failed to stop: ${err.message}`))
      .finally(() => setPendingInstances((s) => { const n = new Set(s); n.delete(stopTarget); return n; }));
    setStopTarget(null);
  };

  const handleNavigate = (path: string) => { navigate(path); };

  const handleCopyResult = (success: boolean) => {
    if (success) toast.success("Copied to clipboard");
    else toast.error("Failed to copy");
  };

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
            if (paused) { setSnapshot(null); setPaused(false); }
            else { setSnapshot(events); setPaused(true); }
          }}
          className="feed-toolbar__pause"
        >
          {paused ? <Play size={10} /> : <Pause size={10} />}
          {paused ? "resume" : "pause"}
        </button>
      </div>

      {/* ── Filter bar — single compact row ── */}
      <div className="feed-filters">
        <div className="feed-filters__row">
          {filterConfig.map((f) => (
            <FilterPill
              key={f.key}
              label={f.label}
              isActive={filter === f.key}
              activeColor={f.key === "errors" ? "text-s-crit" : "text-t2"}
              activeBorder={
                filter === f.key
                  ? `var(--bw) solid ${f.key === "errors" ? "var(--color-s-crit)" : "var(--b3)"}`
                  : undefined
              }
              count={filterCounts[f.key]}
              onClick={() => setFilter(f.key)}
            />
          ))}
        </div>
      </div>

      {/* ── Feed stream ── */}
      <div className="feed-stream">
        {filtered.map((event) => {
          const key = eventKey(event);
          const canAct = actionableKeys.has(key);
          return (
            <FeedCard
              key={key}
              event={event}
              onRestart={canAct ? handleRestart : undefined}
              onStop={canAct ? handleStop : undefined}
              onNavigate={handleNavigate}
              onCopyResult={handleCopyResult}
            />
          );
        })}

        {filtered.length === 0 && (
          <div className="feed-empty">
            {filter === "errors" ? "No errors" : "No activity"}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!stopTarget}
        title="Stop line"
        confirmLabel="Stop line"
        confirmVariant="danger"
        confirmIcon={<Square size={14} strokeWidth={2} />}
        onConfirm={confirmStop}
        onCancel={() => setStopTarget(null)}
      >
        Stop the <strong>{stopTarget}</strong> line? This will disconnect the WhatsApp session.
      </ConfirmDialog>
    </div>
  );
};

export default ActivityFeed;
