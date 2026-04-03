import { type FC, useState } from "react";
import { RotateCw } from "lucide-react";
import type { FeedEvent, Mode } from "../types";
import FeedIcon from "./FeedIcon";
import { formatTimeWithSeconds } from "../lib/format-time";

// ---------------------------------------------------------------------------
//  Reason labels
// ---------------------------------------------------------------------------

const reasonLabel: Record<string, string> = {
  unavailableService: "WhatsApp unavailable",
  connectionClosed: "connection closed",
  connectionLost: "connection lost",
  connectionReplaced: "replaced by another session",
  timedOut: "timed out",
  loggedOut: "logged out",
  Unknown: "disconnected",
};

// ---------------------------------------------------------------------------
//  Instance mode → wash color for the instance tag
// ---------------------------------------------------------------------------

const modeWash: Record<Mode, string> = {
  passive: "var(--m-pas-wash)",
  chat: "var(--m-cht-wash)",
  agent: "var(--m-agt-wash)",
};

const modeColor: Record<Mode, string> = {
  passive: "var(--color-m-pas)",
  chat: "var(--color-m-cht)",
  agent: "var(--color-m-agt)",
};

// ---------------------------------------------------------------------------
//  Severity edge — left border color encoding state
// ---------------------------------------------------------------------------

function edgeColor(event: FeedEvent): string {
  const d = event.detail;
  if (!d) return "var(--b1)";
  if (event.isError) return "var(--color-s-crit)";

  switch (d.type) {
    case "connection":
      if (d.state === "connected") return "var(--color-s-ok)";
      if (d.state === "connecting" || d.reconnecting) return "var(--color-s-warn)";
      if (d.state === "disconnected" || d.statusCode) return "var(--color-s-crit)";
      return "var(--b2)";
    case "message":
      return d.direction === "inbound" ? "var(--color-m-cht)" : "var(--color-m-agt)";
    case "health":
      return d.status === "online" ? "var(--color-s-ok)" : d.status === "unreachable" ? "var(--color-s-crit)" : "var(--color-s-warn)";
    case "tool_error": return "var(--color-s-crit)";
    case "session": return "var(--color-m-agt)";
    default: return "var(--b1)";
  }
}

// ---------------------------------------------------------------------------
//  Strip backend prefixes from text
// ---------------------------------------------------------------------------

function cleanText(event: FeedEvent): string {
  let text = event.text;
  if (event.instance && text.startsWith(`${event.instance}: `))
    text = text.slice(event.instance.length + 2);
  if (event.component && text.startsWith(`[${event.component}] `))
    text = text.slice(event.component.length + 3);
  return text;
}

// ---------------------------------------------------------------------------
//  Card variants — each event type renders differently
// ---------------------------------------------------------------------------

function ConnectionCard({ event, d }: { event: FeedEvent; d: Extract<FeedEvent["detail"], { type: "connection" }> }) {
  const code = d.statusCode;
  const reason = d.reason ? (reasonLabel[d.reason] ?? d.reason) : undefined;

  // Simple state labels
  if (d.state === "connected") return <span className="fc-status fc-status--ok">connected</span>;
  if (d.state === "connecting") return <span className="fc-status fc-status--muted">connecting\u2026</span>;
  if (d.state === "disconnected") return <span className="fc-status fc-status--warn">disconnected</span>;
  if (d.reconnecting && !code && !reason) return <span className="fc-status fc-status--muted">reconnecting\u2026</span>;

  // Error with optional lifecycle suffix
  if (!code && !reason) return <span className="fc-body">{cleanText(event)}</span>;

  return (
    <div className="fc-conn-detail">
      {code && <span className={`fc-code ${code >= 500 ? "fc-code--5xx" : code >= 400 ? "fc-code--4xx" : ""}`}>{code}</span>}
      {reason && <span className={event.isError ? "fc-status fc-status--crit" : "fc-body"}>{reason}</span>}
      {d.reconnecting && <span className="fc-lifecycle">{"\u2192"} reconnecting</span>}
      {d.state === "connected" && <span className="fc-lifecycle fc-lifecycle--ok">{"\u2192"} reconnected</span>}
    </div>
  );
}

function MessageCard({ d }: { d: Extract<FeedEvent["detail"], { type: "message" }> }) {
  const isIn = d.direction === "inbound";
  const isNonText = d.contentType && d.contentType !== "text";
  const chatShort = d.chatJid ? d.chatJid.replace(/@.*/, "").slice(-8) : undefined;

  return (
    <div className="fc-msg">
      <span className={`fc-dir ${isIn ? "fc-dir--in" : "fc-dir--out"}`}>
        {isIn ? "\u2193 recv" : "\u2191 sent"}
      </span>
      {d.senderName && isIn && <span className="fc-sender">{d.senderName}</span>}
      {!d.senderName && chatShort && <span className="fc-chat">{chatShort}</span>}
      {isNonText && <span className="fc-content-type">[{d.contentType}]</span>}
      {d.preview && <span className="fc-preview">{d.preview.length > 90 ? d.preview.slice(0, 87) + "\u2026" : d.preview}</span>}
    </div>
  );
}

function ToolErrorCard({ d }: { d: Extract<FeedEvent["detail"], { type: "tool_error" }> }) {
  return (
    <div className="fc-tool-err">
      <span className="fc-tool-name">{d.toolName}</span>
      <span className="fc-error-body">{d.error}</span>
    </div>
  );
}

function SessionCard({ event, d }: { event: FeedEvent; d: Extract<FeedEvent["detail"], { type: "session" }> }) {
  const shortId = d.sessionId?.slice(0, 8);
  return (
    <div className="fc-session">
      <span className={event.isError ? "fc-status fc-status--crit" : "fc-body"}>{d.action}</span>
      {shortId && <span className="fc-session-id">{shortId}</span>}
      {d.reason && <span className="fc-reason">{"\u2014"} {d.reason}</span>}
    </div>
  );
}

function HealthCard({ d }: { d: Extract<FeedEvent["detail"], { type: "health" }> }) {
  const cls = d.status === "online" ? "fc-status--ok" : d.status === "unreachable" ? "fc-status--crit" : "fc-status--warn";
  const label = d.status === "online" ? "came online"
    : d.status === "unreachable" ? "connection lost"
    : `degraded \u2014 ${d.error ?? "unknown"}`;
  return <span className={`fc-status ${cls}`}>{label}</span>;
}

function ImportCard({ d }: { d: Extract<FeedEvent["detail"], { type: "import" }> }) {
  return (
    <>
      <span className="fc-badge">import</span>
      <span className="fc-body">
        {d.table ?? ""}{d.skipped ? " (skipped)" : d.count !== undefined ? ` \u2014 ${d.count} rows` : ""}
      </span>
    </>
  );
}

// ---------------------------------------------------------------------------
//  Metadata row — disclosed on hover/focus
// ---------------------------------------------------------------------------

function MetaRow({ event }: { event: FeedEvent }) {
  const d = event.detail;
  const parts: string[] = [];
  parts.push(formatTimeWithSeconds(event.time));
  if (event.component) parts.push(event.component);
  if (d?.type === "message") {
    if (d.messageId) parts.push(d.messageId);
    if (d.chatJid) parts.push(d.chatJid);
  } else if (d?.type === "tool_error" || d?.type === "tool_use") {
    if (d.toolId) parts.push(d.toolId);
  } else if (d?.type === "session" && d.chatJid) {
    parts.push(d.chatJid);
  }
  if (parts.length <= 1) return null;
  return <div className="fc-meta">{parts.join(" \u00b7 ")}</div>;
}

// ---------------------------------------------------------------------------
//  Quick actions — contextual per event type
// ---------------------------------------------------------------------------

function QuickActions({ event, onRestart }: { event: FeedEvent; onRestart?: (instance: string) => void }) {
  const d = event.detail;
  if (!d || !event.instance) return null;

  // Connection errors: restart button
  if (d.type === "connection" && event.isError && onRestart) {
    return (
      <button
        className="fc-action"
        onClick={(e) => { e.stopPropagation(); onRestart(event.instance!); }}
        title={`Restart ${event.instance}`}
      >
        <RotateCw size={11} strokeWidth={2} />
        <span>restart</span>
      </button>
    );
  }

  // Health unreachable: restart button
  if (d.type === "health" && d.status === "unreachable" && onRestart) {
    return (
      <button
        className="fc-action"
        onClick={(e) => { e.stopPropagation(); onRestart(event.instance!); }}
        title={`Restart ${event.instance}`}
      >
        <RotateCw size={11} strokeWidth={2} />
        <span>restart</span>
      </button>
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
//  Main card component
// ---------------------------------------------------------------------------

interface FeedCardProps {
  event: FeedEvent;
  onRestart?: (instance: string) => void;
}

const FeedCard: FC<FeedCardProps> = ({ event, onRestart }) => {
  const [expanded, setExpanded] = useState(false);
  const d = event.detail;
  const isErr = !!event.isError;

  // Render the type-specific content
  let content: React.ReactNode;
  if (!d || d.type === "generic") {
    content = <span className="fc-body">{cleanText(event)}</span>;
  } else {
    switch (d.type) {
      case "connection": content = <ConnectionCard event={event} d={d} />; break;
      case "message": content = <MessageCard d={d} />; break;
      case "tool_error": content = <ToolErrorCard d={d} />; break;
      case "session": content = <SessionCard event={event} d={d} />; break;
      case "health": content = <HealthCard d={d} />; break;
      case "import": content = <ImportCard d={d} />; break;
      case "tool_use": content = <><span className="fc-badge">{d.toolName}</span></>; break;
      default: content = <span className="fc-body">{cleanText(event)}</span>;
    }
  }

  return (
    <div
      className={`fc ${isErr ? "fc--error" : ""} ${d?.type === "tool_error" ? "fc--tall" : ""}`}
      tabIndex={0}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
      onFocus={() => setExpanded(true)}
      onBlur={() => setExpanded(false)}
      style={{ borderLeftColor: edgeColor(event) }}
    >
      {/* Primary row */}
      <div className="fc__primary">
        <span className="fc__time">{formatTimeWithSeconds(event.time)}</span>
        <span className="fc__icon"><FeedIcon event={event} /></span>

        {/* Instance tag */}
        {event.instance && (
          <span
            className="fc__inst"
            style={{ backgroundColor: modeWash[event.mode], color: modeColor[event.mode] }}
          >
            {event.instance}
          </span>
        )}

        {/* Type-specific content */}
        <div className="fc__content">{content}</div>

        {/* Quick actions (visible on hover) */}
        {expanded && <QuickActions event={event} onRestart={onRestart} />}
      </div>

      {/* Metadata row — hover/focus only */}
      {expanded && <MetaRow event={event} />}
    </div>
  );
};

export default FeedCard;
