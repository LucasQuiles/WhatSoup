import { type FC, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Pause, Play, AlertTriangle, Circle, Square } from "lucide-react";
import FilterPill from "./FilterPill";
import FeedCard from "./FeedCard";
import ConfirmDialog from "./ConfirmDialog";
import type { Mode, FeedEvent } from "../types";
import { api } from "../lib/api";
import { useToast } from "../hooks/toast-context";

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

  const navigate = useNavigate();
  const toast = useToast();
  const [stopTarget, setStopTarget] = useState<string | null>(null);

  const displayEvents = snapshot ?? events;

  const filtered = useMemo(() => {
    let result = displayEvents;
    if (modeFilter !== "all") result = result.filter((e) => e.mode === modeFilter);
    if (errorsOnly) result = result.filter((e) => e.isError);
    if (typeFilter !== "all") {
      result = result.filter((e) => {
        const t = e.detail?.type;
        if (!t) return false; // events without a detail type don't match any typed filter
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

  // Only the newest error card per instance gets restart/stop actions
  const actionableKeys = useMemo(() => {
    const seen = new Set<string>();
    const keys = new Set<string>();
    for (const event of filtered) {
      const inst = event.instance;
      if (inst && event.isError && !seen.has(inst)) {
        seen.add(inst);
        keys.add(eventKey(event));
      }
    }
    return keys;
  }, [filtered]);

  // Track in-flight instance actions to prevent double-clicks
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const handleRestart = (instance: string) => {
    if (pendingAction) return;
    setPendingAction(instance);
    toast.info(`Restarting ${instance}...`);
    api.restart(instance)
      .then(() => toast.success(`${instance} restart requested`))
      .catch((err: Error) => toast.error(`Failed to restart: ${err.message}`))
      .finally(() => setPendingAction(null));
  };

  const handleStop = (instance: string) => {
    if (pendingAction) return;
    setStopTarget(instance);
  };

  const confirmStop = () => {
    if (!stopTarget) return;
    setPendingAction(stopTarget);
    toast.info(`Stopping ${stopTarget}...`);
    api.stopInstance(stopTarget)
      .then(() => toast.success(`${stopTarget} stop requested`))
      .catch((err: Error) => toast.error(`Failed to stop: ${err.message}`))
      .finally(() => setPendingAction(null));
    setStopTarget(null);
  };

  const handleNavigate = (path: string) => {
    navigate(path);
  };

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
            {errorsOnly ? "No errors" : "No activity"}
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
