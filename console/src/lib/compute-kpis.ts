import type { LineInstance } from '../types';
import { statusNeedsAttention } from './status-severity';

export function computeKpis(lines: LineInstance[]): {
  connected: number;
  needAttention: number;
  unread: number;
  agentSessions: number;
  totalSent: number;
  totalReceived: number;
  totalMedia: number;
} {
  let connected = 0;
  let needAttention = 0;
  let unread = 0;
  let agentSessions = 0;
  let totalSent = 0;
  let totalReceived = 0;
  let totalMedia = 0;

  for (const line of lines) {
    if (line.status === 'online') connected++;
    if (statusNeedsAttention(line.status) || line.error) {
      needAttention++;
    }

    const rt = line.health?.runtime;
    if (rt?.passive) unread += rt.passive.unreadCount;
    if (rt?.agent) agentSessions += rt.agent.activeSessions;

    if (line.messageStats) {
      totalSent += line.messageStats.sent;
      totalReceived += line.messageStats.received;
      totalMedia += line.messageStats.images + line.messageStats.audio + line.messageStats.documents;
    }
  }

  return { connected, needAttention, unread, agentSessions, totalSent, totalReceived, totalMedia };
}
