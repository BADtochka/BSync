import { createProtocolMessage, type BsyncWsServerMessage } from '@bsync/sync-protocol';
import { RoomManager } from './room-manager';

type ServerWebSocketData = {
  connectedAt: number;
  messageWindowStartedAt: number;
  messageCount: number;
  authenticationTimer?: ReturnType<typeof setTimeout>;
};
type ServerWebSocket = Bun.ServerWebSocket<ServerWebSocketData>;

const MAX_MESSAGE_BYTES = 64 * 1024;
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MESSAGES = 120;
const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};
const MAX_CONNECTIONS = positiveInteger(process.env.MAX_CONNECTIONS, 10_000);
const MAX_ROOMS = positiveInteger(process.env.MAX_ROOMS, 10_000);
const MAX_SESSIONS_PER_ROOM = positiveInteger(process.env.MAX_SESSIONS_PER_ROOM, 100);
let activeConnections = 0;
const wsServer = new URL(process.env.WS_SERVER_URL || process.env.WXT_WS_SERVER || 'ws://localhost:8787');
const port = Number(process.env.PORT || wsServer.port || 8787);

const roomManager = new RoomManager<ServerWebSocket>({
  send(ws, message: BsyncWsServerMessage) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  },
  closePeer(ws) {
    ws.close(4001, 'Session resumed on another connection');
  },
  maxRooms: MAX_ROOMS,
  maxSessionsPerRoom: MAX_SESSIONS_PER_ROOM,
});

Bun.serve<ServerWebSocketData>({
  port,
  fetch(request, server) {
    const isWebSocket = request.headers.get('upgrade')?.toLowerCase() === 'websocket';
    if (isWebSocket && activeConnections >= MAX_CONNECTIONS) {
      return new Response('WebSocket capacity reached.\n', { status: 503 });
    }
    if (server.upgrade(request, {
        data: { connectedAt: Date.now(), messageWindowStartedAt: Date.now(), messageCount: 0 },
      })) {
      activeConnections += 1;
      return;
    }
    return new Response('BSync protocol v2 relay is running.\n', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
  websocket: {
    open(ws) {
      ws.data.authenticationTimer = setTimeout(() => {
        if (!roomManager.hasSession(ws)) ws.close(1008, 'Authentication timeout');
      }, 10_000);
    },
    message(ws, rawMessage) {
      const now = Date.now();
      if (now - ws.data.messageWindowStartedAt >= RATE_LIMIT_WINDOW_MS) {
        ws.data.messageWindowStartedAt = now;
        ws.data.messageCount = 0;
      }
      ws.data.messageCount += 1;
      if (ws.data.messageCount > RATE_LIMIT_MESSAGES) {
        ws.send(
          JSON.stringify(
            createProtocolMessage('error', {
              code: 'rate-limited' as const,
              message: 'Message rate limit exceeded',
              retryable: true,
            }) satisfies BsyncWsServerMessage,
          ),
        );
        ws.close(1008, 'Rate limit exceeded');
        return;
      }
      const messageBytes =
        typeof rawMessage === 'string' ? Buffer.byteLength(rawMessage) : rawMessage.byteLength;
      if (messageBytes > MAX_MESSAGE_BYTES) {
        ws.close(1009, 'Message too large');
        return;
      }
      try {
        roomManager.receive(ws, JSON.parse(String(rawMessage)));
      } catch {
        roomManager.receive(ws, null);
      }
    },
    close(ws) {
      if (ws.data.authenticationTimer) clearTimeout(ws.data.authenticationTimer);
      activeConnections = Math.max(0, activeConnections - 1);
      roomManager.disconnect(ws);
    },
  },
});

console.log(`BSync WebSocket relay listening on ws://localhost:${port}`);
