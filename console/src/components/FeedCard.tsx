import { type FC, useState } from "react";
import type { FeedEvent } from "../types";
import FeedIcon from "./FeedIcon";
import { formatTimeWithSeconds } from "../lib/format-time";

// ---------------------------------------------------------------------------
//  Local helpers (ported from ActivityFeed.tsx)
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

function statusCodeColor(code?: number): string {
  if (!code) return "text-t4";
  if (code >= 500) return "text-s-crit";
  if (code >= 400) return "text-s-warn";
  return "text-t3";
}

function Badge({
  children,
  color = "text-t3",
}: {
  children: React.ReactNode;
  color?: string;
}) {
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

/** Strip `${instance}: ` and `[${component}] ` prefixes that the backend prepends to text. */
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

// ---------------------------------------------------------------------------
//  Line renderers
// ---------------------------------------------------------------------------

/** Line 1: icon + badge + instance label + short status (always visible). */
function renderLine1(event: FeedEvent): React.ReactNode {
  const d = event.detail;
  const isErr = event.isError;

  const inst = event.instance ? (
    <span className="text-t2 font-medium" style={{ marginRight: "var(--sp-1)" }}>
      {event.instance}
    </span>
  ) : null;

  if (!d || d.type === "generic") {
    return (
      <>
        {inst}
        <span>{cleanText(event)}</span>
      </>
    );
  }

  switch (d.type) {
    case "connection": {
      if (d.state === "connected") {
        return (
          <>
            {inst}
            <span className="text-s-ok">connected</span>
          </>
        );
      }
      if (d.state === "connecting") {
        return (
          <>
            {inst}
            <span className="text-t4">connecting</span>
          </>
        );
      }
      if (d.state === "disconnected") {
        return (
          <>
            {inst}
            <span className="text-s-warn">disconnected</span>
          </>
        );
      }
      if (d.reconnecting && !d.statusCode && !d.reason) {
        return (
          <>
            {inst}
            <span className="text-t4">reconnecting</span>
          </>
        );
      }
      const code = d.statusCode;
      const reason = d.reason ? (reasonLabel[d.reason] ?? d.reason) : undefined;
      if (!code && !reason) {
        return (
          <>
            {inst}
            <span className="text-t4">{cleanText(event)}</span>
          </>
        );
      }
      return (
        <>
          {inst}
          {code && <Badge color={statusCodeColor(code)}>{code}</Badge>}
          {reason && (
            <span
              className={isErr ? "text-s-crit" : "text-t3"}
              style={{ marginLeft: "var(--sp-1)" }}
            >
              {reason}
            </span>
          )}
          {d.reconnecting && (
            <span className="text-t4" style={{ marginLeft: "var(--sp-1)" }}>
              {"\u2192"} reconnecting
            </span>
          )}
          {d.state === "connected" && (
            <span className="text-s-ok" style={{ marginLeft: "var(--sp-1)" }}>
              {"\u2192"} reconnected
            </span>
          )}
        </>
      );
    }

    case "tool_error":
      // Line 1 shows icon + tool name badge only — error body goes to line 2
      return (
        <>
          {inst}
          <Badge>{d.toolName}</Badge>
        </>
      );

    case "session": {
      const shortId = d.sessionId ? d.sessionId.slice(0, 8) : undefined;
      return (
        <>
          {inst}
          <span className={isErr ? "text-s-crit" : "text-m-agt"}>{d.action}</span>
          {shortId && (
            <span className="text-t5" style={{ marginLeft: "var(--sp-1)" }}>
              {shortId}
            </span>
          )}
        </>
      );
    }

    case "health": {
      const statusColor =
        d.status === "online"
          ? "text-s-ok"
          : d.status === "unreachable"
          ? "text-s-crit"
          : "text-s-warn";
      const label =
        d.status === "online"
          ? "came online"
          : d.status === "unreachable"
          ? "connection lost"
          : `degraded \u2014 ${d.error ?? "unknown"}`;
      return (
        <>
          {inst}
          <span className={statusColor}>{label}</span>
        </>
      );
    }

    case "message": {
      const dirColor = d.direction === "inbound" ? "text-m-cht" : "text-m-agt";
      const chatShort = d.chatJid
        ? d.chatJid.replace(/@.*/, "").slice(-8)
        : undefined;
      const countMatch = event.text.match(/\u00d7(\d+)/);
      const count = countMatch ? parseInt(countMatch[1], 10) : undefined;
      const isNonText = d.contentType && d.contentType !== "text";
      return (
        <>
          {inst}
          <Badge color={dirColor}>
            {d.direction === "inbound" ? "recv" : "sent"}
            {count && count > 1 ? ` \u00d7${count}` : ""}
          </Badge>
          {d.senderName && d.direction === "inbound" && (
            <span className="text-t2 font-medium" style={{ marginLeft: "var(--sp-1)" }}>
              {d.senderName}
            </span>
          )}
          {!d.senderName && chatShort && (
            <span className="text-t4" style={{ marginLeft: "var(--sp-1)" }}>
              {chatShort}
            </span>
          )}
          {isNonText && (
            <span className="text-t5" style={{ marginLeft: "var(--sp-1)" }}>
              [{d.contentType}]
            </span>
          )}
        </>
      );
    }

    case "import":
      return (
        <>
          {inst}
          <Badge>import</Badge>
          <span className="text-t3" style={{ marginLeft: "var(--sp-1)" }}>
            {d.table}
            {d.skipped
              ? " (skipped)"
              : d.count !== undefined
              ? ` \u2014 ${d.count} rows`
              : ""}
          </span>
        </>
      );

    case "tool_use":
      return (
        <>
          {inst}
          <Badge>{d.toolName}</Badge>
        </>
      );

    default: {
      return (
        <>
          {inst}
          <span>{cleanText(event)}</span>
        </>
      );
    }
  }
}

/**
 * Line 2: detail / preview (conditional).
 * - tool_error  → full error text (CSS controls truncation vs expand via hover)
 * - message     → preview text
 * - session     → disconnect reason
 */
function renderLine2(event: FeedEvent, hovered: boolean): React.ReactNode {
  const d = event.detail;
  if (!d) return null;

  if (d.type === "tool_error") {
    return (
      <span
        className="text-s-crit font-mono"
        style={{
          fontSize: "var(--font-size-xs)",
          wordBreak: "break-word",
          whiteSpace: hovered ? "pre-wrap" : "nowrap",
          overflow: hovered ? "visible" : "hidden",
          textOverflow: hovered ? "clip" : "ellipsis",
          display: "block",
        }}
      >
        {d.error}
      </span>
    );
  }

  if (d.type === "message" && d.preview) {
    return (
      <span
        className="text-t4 font-mono"
        style={{
          fontSize: "var(--font-size-xs)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          display: "block",
        }}
      >
        {d.preview}
      </span>
    );
  }

  if (d.type === "session" && d.reason) {
    return (
      <span
        className="text-t4 font-mono"
        style={{
          fontSize: "var(--font-size-xs)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          display: "block",
        }}
      >
        {d.reason}
      </span>
    );
  }

  return null;
}

/** Line 3 (metadata): timestamp · component · messageId · chatJid · toolId — only on hover/focus. */
function renderMetadata(event: FeedEvent): React.ReactNode {
  const d = event.detail;
  const parts: string[] = [];

  parts.push(formatTimeWithSeconds(event.time));

  if (event.component) parts.push(event.component);

  if (d) {
    if (d.type === "message") {
      if (d.messageId) parts.push(d.messageId);
      if (d.chatJid) parts.push(d.chatJid);
    } else if (d.type === "tool_error" || d.type === "tool_use") {
      if (d.toolId) parts.push(d.toolId);
    } else if (d.type === "session") {
      if (d.chatJid) parts.push(d.chatJid);
    }
  }

  return (
    <span
      className="text-t5 font-mono"
      style={{ fontSize: "var(--font-size-xs)" }}
    >
      {parts.join(" \u00b7 ")}
    </span>
  );
}

// ---------------------------------------------------------------------------
//  Main component
// ---------------------------------------------------------------------------

const FeedCard: FC<{ event: FeedEvent }> = ({ event }) => {
  const [hovered, setHovered] = useState(false);
  const isErr = !!event.isError;

  const line2 = renderLine2(event, hovered);

  return (
    <div
      className="feed-card-enter c-hover"
      tabIndex={0}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      style={{
        padding: "var(--sp-2h) var(--sp-3)",
        borderBottom: "var(--bw) solid var(--b1)",
        outline: "none",
        ...(isErr ? { backgroundColor: "var(--s-crit-wash)" } : {}),
      }}
    >
      {/* Line 1: icon + content */}
      <div
        className="flex items-center font-mono"
        style={{
          gap: "var(--sp-1)",
          fontSize: "var(--font-size-sm)",
          color: isErr ? "var(--color-s-crit)" : "var(--color-t3)",
        }}
      >
        {/* Icon — 14px fixed width keeps content aligned */}
        <span
          className="flex-shrink-0 flex items-center"
          style={{ width: 14, height: 14 }}
        >
          <FeedIcon event={event} />
        </span>

        {/* Line-1 content */}
        <span className="flex items-center" style={{ gap: "var(--sp-1)" }}>
          {renderLine1(event)}
        </span>
      </div>

      {/* Line 2: detail/preview (conditional) */}
      {line2 && (
        <div style={{ paddingLeft: 22 }}>
          {line2}
        </div>
      )}

      {/* Line 3: metadata — only on hover/focus */}
      {hovered && (
        <div style={{ paddingLeft: 22, marginTop: "var(--sp-1)" }}>
          {renderMetadata(event)}
        </div>
      )}
    </div>
  );
};

export default FeedCard;
