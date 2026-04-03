/**
 * Shared timestamp formatting utilities.
 * All user-facing timestamps should use these — never display raw ISO strings.
 */

/** "just now", "3m ago", "2h ago", "1d ago" */
export function formatRelative(iso: string): string {
  const now = Date.now();
  // Handle SQLite "YYYY-MM-DD HH:MM:SS" format (no T, no Z) — treat as UTC
  const normalized = iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z';
  const then = new Date(normalized).getTime();
  if (isNaN(then)) return "\u2014";
  const diffS = Math.floor((now - then) / 1000);
  if (diffS < 0) return "just now";
  if (diffS < 60) return "just now";
  const diffM = Math.floor(diffS / 60);
  if (diffM < 60) return `${diffM}m ago`;
  const diffH = Math.floor(diffM / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d ago`;
}

/** "4:02 PM", "10:45 AM" — 12h clock for message bubbles */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "\u2014";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** "04:02:15" — 24h with seconds for log entries (technical context) */
export function formatTimeWithSeconds(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "\u2014";
  return d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** "4:02 PM" / "Yesterday" / "Mar 29" — for chat lists */
export function formatChatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "\u2014";
  const now = new Date();

  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";

  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
