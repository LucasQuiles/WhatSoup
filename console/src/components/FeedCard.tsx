import { type FC, useState } from "react";
import { RotateCw, Square, Copy, ExternalLink } from "lucide-react";
import type { FeedEvent, Mode } from "../types";
import FeedIcon from "./FeedIcon";
import { formatTimeWithSeconds } from "../lib/format-time";
import { formatWhatsAppText } from "../lib/format-wa-text";

// ---------------------------------------------------------------------------
//  Constants
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

const modeClass: Record<Mode, string> = {
  passive: "fc-inst--passive",
  chat: "fc-inst--chat",
  agent: "fc-inst--agent",
};

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
    case "message": return d.direction === "inbound" ? "var(--color-m-cht)" : "var(--color-m-agt)";
    case "health": return d.status === "online" ? "var(--color-s-ok)" : d.status === "unreachable" ? "var(--color-s-crit)" : "var(--color-s-warn)";
    case "tool_error": return "var(--color-s-crit)";
    case "session": return "var(--color-m-agt)";
    default: return "var(--b1)";
  }
}

function cleanText(event: FeedEvent): string {
  let text = event.text;
  if (event.instance && text.startsWith(`${event.instance}: `))
    text = text.slice(event.instance.length + 2);
  if (event.component && text.startsWith(`[${event.component}] `))
    text = text.slice(event.component.length + 3);
  return text;
}

// ---------------------------------------------------------------------------
//  Card header — always present: time + icon + instance tag + type label
// ---------------------------------------------------------------------------

function CardHeader({ event, label, labelClass }: {
  event: FeedEvent;
  label: string;
  labelClass?: string;
}) {
  return (
    <div className="fc-header">
      <span className="fc-time">{formatTimeWithSeconds(event.time)}</span>
      <span className="fc-icon"><FeedIcon event={event} /></span>
      {event.instance && (
        <span className={`fc-inst ${modeClass[event.mode]}`}>
          {event.instance}
        </span>
      )}
      <span className={`fc-label ${labelClass ?? ""}`}>{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Card body variants — each type gets its own multi-line layout
// ---------------------------------------------------------------------------

function ConnectionBody({ event, d }: { event: FeedEvent; d: Extract<FeedEvent["detail"], { type: "connection" }> }) {
  if (d.state === "connected") return <CardHeader event={event} label="connected" labelClass="fc-label--ok" />;
  if (d.state === "connecting") return <CardHeader event={event} label="connecting\u2026" labelClass="fc-label--muted" />;
  if (d.state === "disconnected") return <CardHeader event={event} label="disconnected" labelClass="fc-label--warn" />;
  if (d.reconnecting && !d.statusCode && !d.reason) return <CardHeader event={event} label="reconnecting\u2026" labelClass="fc-label--muted" />;

  const code = d.statusCode;
  const reason = d.reason ? (reasonLabel[d.reason] ?? d.reason) : undefined;

  if (!code && !reason) {
    return <CardHeader event={event} label={cleanText(event)} labelClass="fc-label--muted" />;
  }

  // Error with lifecycle — two-part header
  let statusText = reason ?? "";
  if (d.reconnecting) statusText += " \u2192 reconnecting";
  if (d.state === "connected") statusText += " \u2192 reconnected";

  return (
    <CardHeader
      event={event}
      label={`${code ? `${code} ` : ""}${statusText}`}
      labelClass={event.isError ? "fc-label--crit" : ""}
    />
  );
}

function MessageBody({ event, d }: { event: FeedEvent; d: Extract<FeedEvent["detail"], { type: "message" }> }) {
  const isIn = d.direction === "inbound";
  const isNonText = d.contentType && d.contentType !== "text";
  const chatShort = d.chatJid ? d.chatJid.replace(/@.*/, "").slice(-8) : undefined;

  // Parse collapsed count from event text
  const countMatch = event.text.match(/\u00d7(\d+)/);
  const count = countMatch ? parseInt(countMatch[1], 10) : undefined;

  const who = d.senderName ?? chatShort ?? "";
  const countSuffix = count && count > 1 ? ` \u00d7${count}` : "";

  return (
    <>
      <CardHeader
        event={event}
        label={`${who}${countSuffix}${isNonText ? ` [${d.contentType}]` : ""}`}
        labelClass={isIn ? "fc-label--recv" : "fc-label--sent"}
      />
      {d.preview && (
        <div className="fc-body-text">
          {formatWhatsAppText(d.preview)}
        </div>
      )}
    </>
  );
}

function ToolErrorBody({ event, d }: { event: FeedEvent; d: Extract<FeedEvent["detail"], { type: "tool_error" }> }) {
  return (
    <>
      <CardHeader event={event} label={d.toolName} labelClass="fc-label--crit" />
      <div className="fc-body-text fc-body-text--error">
        {formatWhatsAppText(d.error)}
      </div>
    </>
  );
}

function SessionBody({ event, d }: { event: FeedEvent; d: Extract<FeedEvent["detail"], { type: "session" }> }) {
  const shortId = d.sessionId?.slice(0, 8);
  const label = `${d.action}${shortId ? ` [${shortId}]` : ""}`;
  return (
    <>
      <CardHeader event={event} label={label} labelClass={event.isError ? "fc-label--crit" : "fc-label--agent"} />
      {d.reason && <div className="fc-body-text fc-body-text--dim">{"\u2014"} {d.reason}</div>}
    </>
  );
}

function HealthBody({ event, d }: { event: FeedEvent; d: Extract<FeedEvent["detail"], { type: "health" }> }) {
  const cls = d.status === "online" ? "fc-label--ok" : d.status === "unreachable" ? "fc-label--crit" : "fc-label--warn";
  const label = d.status === "online" ? "came online" : d.status === "unreachable" ? "connection lost" : `degraded \u2014 ${d.error ?? "unknown"}`;
  return <CardHeader event={event} label={label} labelClass={cls} />;
}

function ImportBody({ event, d }: { event: FeedEvent; d: Extract<FeedEvent["detail"], { type: "import" }> }) {
  const suffix = d.skipped ? " (skipped)" : d.count !== undefined ? ` \u2014 ${d.count} rows` : "";
  return <CardHeader event={event} label={`import ${d.table ?? ""}${suffix}`} />;
}

function GenericBody({ event }: { event: FeedEvent }) {
  return <CardHeader event={event} label={cleanText(event)} />;
}

// ---------------------------------------------------------------------------
//  Metadata row — hover/focus disclosure
// ---------------------------------------------------------------------------

function MetaRow({ event }: { event: FeedEvent }) {
  const d = event.detail;
  const parts: string[] = [];
  if (event.component) parts.push(event.component);
  if (d?.type === "message") {
    if (d.messageId) parts.push(`id:${d.messageId}`);
    if (d.chatJid) parts.push(d.chatJid);
  } else if ((d?.type === "tool_error" || d?.type === "tool_use") && d.toolId) {
    parts.push(d.toolId);
  } else if (d?.type === "session" && d.chatJid) {
    parts.push(d.chatJid);
  }
  if (!parts.length) return null;
  return <div className="fc-meta">{parts.join(" \u00b7 ")}</div>;
}

// ---------------------------------------------------------------------------
//  Quick actions
// ---------------------------------------------------------------------------

function QuickActions({ event, onRestart, onStop, onNavigate, onCopyResult }: {
  event: FeedEvent;
  onRestart?: (instance: string) => void;
  onStop?: (instance: string) => void;
  onNavigate?: (path: string) => void;
  onCopyResult?: (success: boolean) => void;
}) {
  const d = event.detail;
  const inst = event.instance;
  const actions: React.ReactNode[] = [];

  // Copy — always available
  actions.push(
    <button
      key="copy"
      className="fc-action"
      aria-label="Copy to clipboard"
      onClick={(e) => {
        e.stopPropagation();
        const text = copyContent(event);
        navigator.clipboard.writeText(text)
          .then(() => onCopyResult?.(true))
          .catch(() => onCopyResult?.(false));
      }}
    >
      <Copy size={12} strokeWidth={2} />
      <span className="fc-action__label">copy</span>
    </button>
  );

  // Jump to conversation — message events with conversationKey
  if (d?.type === "message" && (d as { conversationKey?: string }).conversationKey && inst && onNavigate) {
    const ck = (d as { conversationKey?: string }).conversationKey!;
    actions.push(
      <button
        key="jump"
        className="fc-action"
        aria-label="Open conversation"
        onClick={(e) => {
          e.stopPropagation();
          onNavigate(`/inbox?line=${encodeURIComponent(inst)}&chat=${encodeURIComponent(ck)}`);
        }}
      >
        <ExternalLink size={12} strokeWidth={2} />
        <span className="fc-action__label">open</span>
      </button>
    );
  }

  // Restart — connection errors, health unreachable
  if (inst && onRestart) {
    const show = (d?.type === "connection" && event.isError)
      || (d?.type === "health" && d.status === "unreachable");
    if (show) {
      actions.push(
        <button
          key="restart"
          className="fc-action"
          aria-label={`Restart ${inst}`}
          onClick={(e) => { e.stopPropagation(); onRestart(inst); }}
        >
          <RotateCw size={12} strokeWidth={2} />
          <span className="fc-action__label">restart</span>
        </button>
      );
    }
  }

  // Stop line — connection errors, health unreachable
  if (inst && onStop) {
    const show = (d?.type === "connection" && event.isError)
      || (d?.type === "health" && d.status === "unreachable");
    if (show) {
      actions.push(
        <button
          key="stop"
          className="fc-action fc-action--danger"
          aria-label={`Stop ${inst} line`}
          onClick={(e) => { e.stopPropagation(); onStop(inst); }}
        >
          <Square size={12} strokeWidth={2} />
          <span className="fc-action__label">stop</span>
        </button>
      );
    }
  }

  if (actions.length === 0) return null;
  return <div className="fc-actions">{actions}</div>;
}

function copyContent(event: FeedEvent): string {
  const d = event.detail;
  if (!d) return event.text;
  switch (d.type) {
    case "message": return (d as { preview?: string }).preview ?? event.text;
    case "tool_error": return d.error;
    case "session": return `${d.action}${d.reason ? ` — ${d.reason}` : ""}`;
    case "connection": {
      const code = d.statusCode ? `${d.statusCode} ` : "";
      const reason = d.reason ? (reasonLabel[d.reason] ?? d.reason) : "";
      let text = `${code}${reason}`.trim();
      if (d.reconnecting) text += " \u2192 reconnecting";
      if (d.state === "connected" && d.statusCode) text += " \u2192 reconnected";
      return text || event.text;
    }
    case "health": {
      if (d.status === "online") return "came online";
      if (d.status === "unreachable") return "connection lost";
      return `degraded \u2014 ${d.error ?? "unknown"}`;
    }
    default: return event.text;
  }
}

// ---------------------------------------------------------------------------
//  Main card
// ---------------------------------------------------------------------------

interface FeedCardProps {
  event: FeedEvent;
  onRestart?: (instance: string) => void;
  onStop?: (instance: string) => void;
  onNavigate?: (path: string) => void;
  onCopyResult?: (success: boolean) => void;
}

const FeedCard: FC<FeedCardProps> = ({ event, onRestart, onStop, onNavigate, onCopyResult }) => {
  const [expanded, setExpanded] = useState(false);
  const d = event.detail;
  const isErr = !!event.isError;

  let body: React.ReactNode;
  if (!d || d.type === "generic") body = <GenericBody event={event} />;
  else switch (d.type) {
    case "connection": body = <ConnectionBody event={event} d={d} />; break;
    case "message": body = <MessageBody event={event} d={d} />; break;
    case "tool_error": body = <ToolErrorBody event={event} d={d} />; break;
    case "session": body = <SessionBody event={event} d={d} />; break;
    case "health": body = <HealthBody event={event} d={d} />; break;
    case "import": body = <ImportBody event={event} d={d} />; break;
    case "tool_use": body = <CardHeader event={event} label={d.toolName} />; break;
    default: body = <GenericBody event={event} />;
  }

  return (
    <div
      className={`fc ${isErr ? "fc--error" : ""}`}
      tabIndex={0}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
      onFocus={() => setExpanded(true)}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setExpanded(false);
      }}
      style={{ borderLeftColor: edgeColor(event) }}
    >
      {body}
      {expanded && <MetaRow event={event} />}
      {expanded && <QuickActions event={event} onRestart={onRestart} onStop={onStop} onNavigate={onNavigate} onCopyResult={onCopyResult} />}
    </div>
  );
};

export default FeedCard;
