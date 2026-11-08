/** Process-wide counters, exposed by /api/stats (and /metrics in Lab 8). */
export interface Stats {
  connections: number;
  disconnections: number;
  players: number;
  httpRequests: number;
  messagesIn: number;
  messagesOut: number;
  bytesIn: number;
  bytesOut: number;
  droppedMessages: number;
  closedSlow: number;
  rejectedPaths: number;
  rejected: Record<string, number>; // close code → count
}

export function createStats(): Stats {
  return {
    connections: 0,
    disconnections: 0,
    players: 0,
    httpRequests: 0,
    messagesIn: 0,
    messagesOut: 0,
    bytesIn: 0,
    bytesOut: 0,
    droppedMessages: 0,
    closedSlow: 0,
    rejectedPaths: 0,
    rejected: {},
  };
}
