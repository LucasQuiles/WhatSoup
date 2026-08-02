import { type FC, type ReactNode } from "react";
import { RotateCw, Square, Copy, ExternalLink } from "lucide-react";
import type { FeedEvent, Mode } from "../types";
import FeedIcon from "./FeedIcon";
import { formatWhatsAppText } from "../lib/format-wa-text";
import { getProvider } from "../lib/providers";
import { statusAlertMessage, statusColorToken, statusSeverity } from "../lib/status-severity";
import { isNonEmptyString } from "../lib/type-guards";
import { Button } from "./primitives/Button";

// ---------------------------------------------------------------------------
//  Constants
// ---------------------------------------------------------------------------

const reasonLabel: Record<string, string> = {
  unavailableService: "channel unavailable",
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

type BadgeTone = "neutral" | "ok" | "warn" | "crit" | "recv" | "sent" | "agent";

const badgeToneClass: Record<BadgeTone, string> = {
  neutral: "fc-badge--neutral",
  ok: "fc-badge--ok",
  warn: "fc-badge--warn",
  crit: "fc-badge--crit",
  recv: "fc-badge--recv",
  sent: "fc-badge--sent",
  agent: "fc-badge--agent",
};

type FeedDetail = NonNullable<FeedEvent["detail"]>;
type ConnectionDetail = Extract<FeedDetail, { type: "connection" }>;
type MessageDetail = Extract<FeedDetail, { type: "message" }>;
type ToolErrorDetail = Extract<FeedDetail, { type: "tool_error" }>;
type SessionDetail = Extract<FeedDetail, { type: "session" }>;
type HealthDetail = Extract<FeedDetail, { type: "health" }>;
type ImportDetail = Extract<FeedDetail, { type: "import" }>;

const EMPTY_TEXT = "\u2014";

function displayText(value: unknown): string {
  return isNonEmptyString(value) ? value : EMPTY_TEXT;
}

function optionalText(value: unknown): string | undefined {
  return isNonEmptyString(value) ? value : undefined;
}

function healthTone(d: HealthDetail): BadgeTone {
  const severity = statusSeverity(d.status);
  if (severity === "ok") return "ok";
  if (severity === "crit") return "crit";
  return "warn";
}

function healthEdgeColor(d: HealthDetail): string {
  return statusColorToken(statusSeverity(d.status));
}

function healthHeadline(d: HealthDetail): string {
  if (d.status === "online") return "came online";
  return statusAlertMessage(d.status);
}

function edgeColor(event: FeedEvent): string {
  const d = event.detail;
  if (!d) return "var(--border-hairline)";
  if (d.type === "health") return healthEdgeColor(d);
  if (event.isError) return statusColorToken("crit");
  switch (d.type) {
    case "connection":
      if (d.state === "connected") return statusColorToken("ok");
      if (d.state === "connecting" || d.reconnecting) return statusColorToken("warn");
      if (d.state === "disconnected" || d.statusCode) return statusColorToken("crit");
      return "var(--border-subtle)";
    case "message": return d.direction === "inbound" ? "var(--color-m-cht)" : "var(--color-m-agt)";
    case "tool_error": return statusColorToken("crit");
    case "session": return "var(--color-m-agt)";
    default: return "var(--border-hairline)";
  }
}

function cleanText(event: FeedEvent): string {
  let text = displayText(event.text);
  if (event.instance && text.startsWith(`${event.instance}: `))
    text = text.slice(event.instance.length + 2);
  if (event.component && text.startsWith(`[${event.component}] `))
    text = text.slice(event.component.length + 3);
  return text;
}

function shortChatJid(chatJid?: string): string | undefined {
  return chatJid ? chatJid.replace(/@.*/, "").slice(-8) : undefined;
}

function parseCollapsedCount(text: string): number | undefined {
  const match = text.match(/\u00d7(\d+)/);
  if (!match) return undefined;
  const count = Number.parseInt(match[1], 10);
  return Number.isNaN(count) ? undefined : count;
}

function connectionTone(event: FeedEvent, d: ConnectionDetail): BadgeTone {
  if (event.isError) return "crit";
  if (d.state === "connected") return "ok";
  if (d.state === "connecting" || d.reconnecting) return "warn";
  if (d.state === "disconnected" || d.statusCode) return "crit";
  return "neutral";
}

function joinParts(parts: Array<string | undefined>): string | undefined {
  const filtered = parts.filter(Boolean) as string[];
  return filtered.length > 0 ? filtered.join(" · ") : undefined;
}

function Badge({ children, tone = "neutral" }: {
  children: ReactNode;
  tone?: BadgeTone;
}) {
  return (
    <span className={`fc-badge ${badgeToneClass[tone]}`}>
      {children}
    </span>
  );
}

interface CardPresentation {
  badge: string;
  badgeTone?: BadgeTone;
  headline: ReactNode;
  headlineTone?: BadgeTone;
  context?: ReactNode;
  detail?: ReactNode;
  detailClassName?: string;
}

function connectionPresentation(event: FeedEvent, d: ConnectionDetail): CardPresentation {
  const reason = d.reason ? (reasonLabel[d.reason] ?? d.reason) : undefined;
  let headline = "connection";
  let context = reason;

  if (d.state === "connected" && (d.statusCode || d.reason || d.reconnecting)) {
    headline = "reconnected";
    context = reason ?? (d.statusCode ? `status ${d.statusCode}` : "session restored");
  } else if (d.state === "connected") {
    headline = "connected";
  } else if (d.state === "connecting") {
    headline = "connecting";
  } else if (d.reconnecting) {
    headline = "reconnecting";
    context = reason ?? (d.statusCode ? `status ${d.statusCode}` : "retry scheduled");
  } else if (d.state === "disconnected") {
    headline = "disconnected";
  } else if (reason || d.statusCode) {
    headline = "connection issue";
    context = reason ?? (d.statusCode ? `status ${d.statusCode}` : undefined);
  } else {
    headline = cleanText(event);
  }

  return (
    {
      badge: d.statusCode ? String(d.statusCode) : "conn",
      badgeTone: connectionTone(event, d),
      headline,
      headlineTone: connectionTone(event, d),
      context,
    }
  );
}

function messagePresentation(event: FeedEvent, d: MessageDetail): CardPresentation {
  const isIn = d.direction === "inbound";
  const isNonText = d.contentType && d.contentType !== "text";
  const count = parseCollapsedCount(displayText(event.text));
  const chatShort = shortChatJid(d.chatJid);
  const preview = optionalText(d.preview);

  return {
    badge: `${isIn ? "recv" : "sent"}${count && count > 1 ? ` \u00d7${count}` : ""}`,
    badgeTone: isIn ? "recv" : "sent",
    headline: d.senderName ?? chatShort ?? (isIn ? "incoming" : "outgoing"),
    headlineTone: isIn ? "recv" : "sent",
    context: joinParts([
      d.senderName ? chatShort : undefined,
      isNonText ? `[${d.contentType}]` : undefined,
    ]),
    detail: preview ? formatWhatsAppText(preview) : isNonText ? `[${d.contentType}]` : undefined,
  };
}

function toolErrorPresentation(d: ToolErrorDetail): CardPresentation {
  return {
    badge: d.toolName || "tool",
    badgeTone: "crit",
    headline: "tool failed",
    headlineTone: "crit",
    detail: formatWhatsAppText(displayText(d.error)),
    detailClassName: "fc-detail--error fc-detail--wrap",
  };
}

function sessionPresentation(event: FeedEvent, d: SessionDetail): CardPresentation {
  return {
    badge: "session",
    badgeTone: "agent",
    headline: d.action,
    headlineTone: event.isError ? "crit" : "agent",
    context: d.sessionId ? `#${d.sessionId.slice(0, 8)}` : undefined,
    detail: d.reason ? `\u2014 ${d.reason}` : undefined,
    detailClassName: "fc-detail--muted",
  };
}

function healthPresentation(d: HealthDetail): CardPresentation {
  const tone = healthTone(d);
  return {
    badge: "health",
    badgeTone: tone,
    headline: healthHeadline(d),
    headlineTone: tone,
    context: d.error,
  };
}

function importPresentation(d: ImportDetail): CardPresentation {
  return {
    badge: "import",
    headline: d.table ?? "data",
    context: d.skipped ? "skipped" : d.count !== undefined ? `${d.count} rows` : undefined,
  };
}

function genericPresentation(event: FeedEvent): CardPresentation {
  return {
    badge: "event",
    headline: cleanText(event),
  };
}

function renderCard(event: FeedEvent): CardPresentation {
  const d = event.detail;
  if (!d || d.type === "generic") return genericPresentation(event);

  switch (d.type) {
    case "connection":
      return connectionPresentation(event, d);
    case "message":
      return messagePresentation(event, d);
    case "tool_error":
      return toolErrorPresentation(d);
    case "tool_use":
      return {
        badge: d.toolName || "tool",
        badgeTone: "agent",
        headline: "tool used",
        headlineTone: "agent",
      };
    case "session":
      return sessionPresentation(event, d);
    case "health":
      return healthPresentation(d);
    case "import":
      return importPresentation(d);
    default:
      return genericPresentation(event);
  }
}

function eventIsCritical(event: FeedEvent): boolean {
  const d = event.detail;
  if (d?.type === "health") return statusSeverity(d.status) === "crit";
  return !!event.isError;
}

// ---------------------------------------------------------------------------
//  Metadata row — hover/focus disclosure
// ---------------------------------------------------------------------------

function metadataParts(event: FeedEvent): string[] {
  const d = event.detail;
  const parts: string[] = [];
  if (event.time) parts.push(`time:${event.time}`);
  if (event.component) parts.push(`component:${event.component}`);
  if (d?.type === "message") {
    if (d.messageId) parts.push(`id:${d.messageId}`);
    if (d.chatJid) parts.push(d.chatJid);
  } else if ((d?.type === "tool_error" || d?.type === "tool_use") && d.toolId) {
    parts.push(d.toolId);
  } else if (d?.type === "session" && d.chatJid) {
    parts.push(d.chatJid);
  }
  return parts;
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
    <Button
      key="copy"
      variant="ghost"
      className="fc-action"
      aria-label="Copy to clipboard"
      icon={<Copy size={12} strokeWidth={1.75} />}
      onClick={(e) => {
        e.stopPropagation();
        const text = copyContent(event);
        navigator.clipboard.writeText(text)
          .then(() => onCopyResult?.(true))
          .catch(() => onCopyResult?.(false));
      }}
    >
      <span className="fc-action__label">copy</span>
    </Button>
  );

  // Jump to conversation — message events with conversationKey
  if (d?.type === "message" && (d as { conversationKey?: string }).conversationKey && inst && onNavigate) {
    const ck = (d as { conversationKey?: string }).conversationKey!;
    actions.push(
      <Button
        key="jump"
        variant="ghost"
        className="fc-action"
        aria-label="Open conversation"
        icon={<ExternalLink size={12} strokeWidth={1.75} />}
        onClick={(e) => {
          e.stopPropagation();
          onNavigate(`/inbox?line=${encodeURIComponent(inst)}&chat=${encodeURIComponent(ck)}`);
        }}
      >
        <span className="fc-action__label">open</span>
      </Button>
    );
  }

  // Restart — connection errors, health unreachable
  if (inst && onRestart) {
    const show = (d?.type === "connection" && event.isError)
      || (d?.type === "health" && statusSeverity(d.status) === "crit");
    if (show) {
      actions.push(
        <Button
          key="restart"
          variant="ghost"
          className="fc-action"
          aria-label={`Restart ${inst}`}
          icon={<RotateCw size={12} strokeWidth={1.75} />}
          onClick={(e) => { e.stopPropagation(); onRestart(inst); }}
        >
          <span className="fc-action__label">restart</span>
        </Button>
      );
    }
  }

  // Stop line — connection errors, health unreachable
  if (inst && onStop) {
    const show = (d?.type === "connection" && event.isError)
      || (d?.type === "health" && statusSeverity(d.status) === "crit");
    if (show) {
      actions.push(
        <Button
          key="stop"
          variant="danger"
          className="fc-action fc-action--danger"
          aria-label={`Stop ${inst} instance`}
          icon={<Square size={12} strokeWidth={1.75} />}
          onClick={(e) => { e.stopPropagation(); onStop(inst); }}
        >
          <span className="fc-action__label">stop</span>
        </Button>
      );
    }
  }

  if (actions.length === 0) return null;
  return <div className="fc-actions">{actions}</div>;
}

function copyContent(event: FeedEvent): string {
  const d = event.detail;
  if (!d) return displayText(event.text);
  switch (d.type) {
    case "message": return optionalText((d as { preview?: unknown }).preview) ?? displayText(event.text);
    case "tool_error": return displayText(d.error);
    case "session": return `${d.action}${d.reason ? ` — ${d.reason}` : ""}`;
    case "connection": {
      const code = d.statusCode ? `${d.statusCode} ` : "";
      const reason = d.reason ? (reasonLabel[d.reason] ?? d.reason) : "";
      let text = `${code}${reason}`.trim();
      if (d.reconnecting) text += " \u2192 reconnecting";
      if (d.state === "connected" && d.statusCode) text += " \u2192 reconnected";
      return text || displayText(event.text);
    }
    case "health": {
      if (d.status === "online") return "came online";
      if (statusSeverity(d.status) === "crit") return statusAlertMessage(d.status);
      return `degraded \u2014 ${d.error ?? "unknown"}`;
    }
    default: return displayText(event.text);
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
  const isErr = eventIsCritical(event);
  const card = renderCard(event);
  const meta = metadataParts(event);
  const hasMeta = meta.length > 0;

  return (
    <div
      className={`fc ${isErr ? "fc--error" : ""}`}
      tabIndex={0}
      style={{ borderLeftColor: edgeColor(event) }}
    >
      <div className="fc-main">
        <div className="fc-line1">
          <span className="fc-icon"><FeedIcon event={event} /></span>
          <Badge tone={card.badgeTone}>{card.badge}</Badge>
          {event.instance && (
            <span className={`fc-inst ${modeClass[event.mode]}`}>
              {event.instance}
            </span>
          )}
          {event.provider && (
            <span className="fc-badge text-text-3">
              {getProvider(event.provider)?.shortName ?? event.provider}
            </span>
          )}
          <div className="fc-summary">
            <span className={`fc-headline ${card.headlineTone ? `fc-headline--${card.headlineTone}` : ""}`}>
              {card.headline}
            </span>
            {card.context && <span className="fc-context">{card.context}</span>}
          </div>
        </div>

        {card.detail && (
          <div className={`fc-detail ${card.detailClassName ?? ""}`}>
            {card.detail}
          </div>
        )}

        {hasMeta && <div className="fc-meta">{meta.join(" \u00b7 ")}</div>}
      </div>

      <QuickActions
        event={event}
        onRestart={onRestart}
        onStop={onStop}
        onNavigate={onNavigate}
        onCopyResult={onCopyResult}
      />
    </div>
  );
};

export default FeedCard;
