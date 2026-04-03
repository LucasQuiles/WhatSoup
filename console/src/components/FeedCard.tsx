import { type FC, useState } from "react";
import type { FeedEvent } from "../types";
import FeedIcon from "./FeedIcon";
import { formatTimeWithSeconds } from "../lib/format-time";

// ---------------------------------------------------------------------------
//  Constants
// ---------------------------------------------------------------------------

const reasonLabel: Record<string, string> = {
  unavailableService: "unavailable",
  connectionClosed: "closed",
  connectionLost: "lost",
  connectionReplaced: "replaced",
  timedOut: "timed out",
  loggedOut: "logged out",
  Unknown: "unknown",
};

// ---------------------------------------------------------------------------
//  Severity edge color — the 2px left border that encodes state at a glance
// ---------------------------------------------------------------------------

function severityColor(event: FeedEvent): string {
  const d = event.detail;
  if (!d) return "var(--b1)";

  if (event.isError) return "var(--color-s-crit)";

  switch (d.type) {
    case "connection":
      if (d.state === "connected") return "var(--color-s-ok)";
      if (d.state === "connecting" || d.reconnecting) return "var(--color-s-warn)";
      if (d.state === "disconnected") return "var(--color-s-crit)";
      if (d.statusCode) return "var(--color-s-crit)";
      return "var(--b2)";
    case "message":
      return d.direction === "inbound" ? "var(--color-m-cht)" : "var(--color-m-agt)";
    case "health":
      if (d.status === "online") return "var(--color-s-ok)";
      if (d.status === "unreachable") return "var(--color-s-crit)";
      return "var(--color-s-warn)";
    case "tool_error":
      return "var(--color-s-crit)";
    case "session":
      return "var(--color-m-agt)";
    case "import":
      return "var(--b2)";
    default:
      return "var(--b1)";
  }
}

// ---------------------------------------------------------------------------
//  Text helpers
// ---------------------------------------------------------------------------

function cleanText(event: FeedEvent): string {
  let text = event.text;
  if (event.instance && text.startsWith(`${event.instance}: `)) {
    text = text.slice(event.instance.length + 2);
  }
  if (event.component && text.startsWith(`[${event.component}] `)) {
    text = text.slice(event.component.length + 3);
  }
  return text;
}

function statusCodeBadge(code: number): string {
  if (code >= 500) return "feed-badge-crit";
  if (code >= 400) return "feed-badge-warn";
  return "feed-badge-muted";
}

// ---------------------------------------------------------------------------
//  Primary line — the main status content
// ---------------------------------------------------------------------------

function renderPrimary(event: FeedEvent): React.ReactNode {
  const d = event.detail;

  if (!d || d.type === "generic") {
    return <span className="feed-text-secondary">{cleanText(event)}</span>;
  }

  switch (d.type) {
    case "connection": {
      if (d.state === "connected") return <span className="feed-text-ok">connected</span>;
      if (d.state === "connecting") return <span className="feed-text-muted">connecting</span>;
      if (d.state === "disconnected") return <span className="feed-text-warn">disconnected</span>;
      if (d.reconnecting && !d.statusCode && !d.reason) return <span className="feed-text-muted">reconnecting</span>;

      const code = d.statusCode;
      const reason = d.reason ? (reasonLabel[d.reason] ?? d.reason) : undefined;
      if (!code && !reason) return <span className="feed-text-muted">{cleanText(event)}</span>;

      return (
        <>
          {code && <span className={`feed-badge ${statusCodeBadge(code)}`}>{code}</span>}
          {reason && <span className={event.isError ? "feed-text-crit" : "feed-text-secondary"}>{reason}</span>}
          {d.reconnecting && <span className="feed-text-muted">{"\u2192"} reconnecting</span>}
          {d.state === "connected" && <span className="feed-text-ok">{"\u2192"} reconnected</span>}
        </>
      );
    }

    case "tool_error":
      return <span className="feed-badge feed-badge-tool">{d.toolName}</span>;

    case "session": {
      const shortId = d.sessionId ? d.sessionId.slice(0, 8) : undefined;
      return (
        <>
          <span className={event.isError ? "feed-text-crit" : "feed-text-agent"}>{d.action}</span>
          {shortId && <span className="feed-text-dim">{shortId}</span>}
        </>
      );
    }

    case "health": {
      const cls = d.status === "online" ? "feed-text-ok"
        : d.status === "unreachable" ? "feed-text-crit" : "feed-text-warn";
      const label = d.status === "online" ? "came online"
        : d.status === "unreachable" ? "connection lost"
        : `degraded \u2014 ${d.error ?? "unknown"}`;
      return <span className={cls}>{label}</span>;
    }

    case "message": {
      const dirCls = d.direction === "inbound" ? "feed-badge-recv" : "feed-badge-sent";
      const countMatch = event.text.match(/\u00d7(\d+)/);
      const count = countMatch ? parseInt(countMatch[1], 10) : undefined;
      const isNonText = d.contentType && d.contentType !== "text";

      return (
        <>
          <span className={`feed-badge ${dirCls}`}>
            {d.direction === "inbound" ? "\u2193 recv" : "\u2191 sent"}
            {count && count > 1 ? ` \u00d7${count}` : ""}
          </span>
          {d.senderName && d.direction === "inbound" && (
            <span className="feed-text-primary">{d.senderName}</span>
          )}
          {!d.senderName && d.chatJid && (
            <span className="feed-text-dim">{d.chatJid.replace(/@.*/, "").slice(-8)}</span>
          )}
          {isNonText && <span className="feed-text-dim">[{d.contentType}]</span>}
        </>
      );
    }

    case "import":
      return (
        <>
          <span className="feed-badge feed-badge-muted">import</span>
          <span className="feed-text-secondary">
            {d.table ?? ""}{d.skipped ? " (skipped)" : d.count !== undefined ? ` \u2014 ${d.count} rows` : ""}
          </span>
        </>
      );

    case "tool_use":
      return <span className="feed-badge feed-badge-tool">{d.toolName}</span>;

    default:
      return <span className="feed-text-secondary">{cleanText(event)}</span>;
  }
}

// ---------------------------------------------------------------------------
//  Detail line — preview, error body, reason
// ---------------------------------------------------------------------------

function renderDetail(event: FeedEvent, expanded: boolean): React.ReactNode {
  const d = event.detail;
  if (!d) return null;

  if (d.type === "tool_error") {
    return (
      <div
        className="feed-detail feed-detail-error"
        style={expanded ? { whiteSpace: "pre-wrap", overflow: "visible", textOverflow: "clip" } : undefined}
      >
        {d.error}
      </div>
    );
  }

  if (d.type === "message" && d.preview) {
    return <div className="feed-detail">{d.preview}</div>;
  }

  if (d.type === "session" && d.reason) {
    return <div className="feed-detail">\u2014 {d.reason}</div>;
  }

  return null;
}

// ---------------------------------------------------------------------------
//  Metadata row — timestamp, component, IDs (hover/focus only)
// ---------------------------------------------------------------------------

function renderMeta(event: FeedEvent): string {
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
  return parts.join(" \u00b7 ");
}

// ---------------------------------------------------------------------------
//  Main component
// ---------------------------------------------------------------------------

const FeedCard: FC<{ event: FeedEvent }> = ({ event }) => {
  const [expanded, setExpanded] = useState(false);
  const isErr = !!event.isError;
  const detail = renderDetail(event, expanded);
  const meta = renderMeta(event);

  return (
    <div
      className={`feed-card ${isErr ? "feed-card--error" : ""}`}
      tabIndex={0}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
      onFocus={() => setExpanded(true)}
      onBlur={() => setExpanded(false)}
      style={{ borderLeftColor: severityColor(event) }}
    >
      {/* Row: time | icon | content */}
      <div className="feed-card__row">
        <span className="feed-card__time">
          {formatTimeWithSeconds(event.time)}
        </span>

        <span className="feed-card__icon">
          <FeedIcon event={event} />
        </span>

        <span className="feed-card__instance">
          {event.instance ?? ""}
        </span>

        <span className="feed-card__content">
          {renderPrimary(event)}
        </span>
      </div>

      {/* Detail line — preview / error / reason */}
      {detail && (
        <div className="feed-card__detail-row">
          {detail}
        </div>
      )}

      {/* Metadata — hover/focus only */}
      <div
        className="feed-card__meta"
        style={{ opacity: expanded ? 0.6 : 0, height: expanded ? "auto" : 0 }}
        aria-hidden={!expanded}
      >
        {meta}
      </div>
    </div>
  );
};

export default FeedCard;
