import type { BsyncWsServerMessage, MediaSyncState, RoomTargetPage } from '@bsync/sync-protocol';

type ServerWebSocketData = {
  clientId: string | null;
  roomCode: string | null;
  displayName: string | null;
};

type ServerWebSocket = Bun.ServerWebSocket<ServerWebSocketData>;

type Room = {
  targetPage: RoomTargetPage | null;
  hostClientId: string | null;
  lastMedia: MediaSyncState | null;
  clients: Map<string, ServerWebSocket>;
};

type IncomingMessage = {
  type?: string;
  roomCode?: string;
  clientId?: string;
  roomRole?: string;
  displayName?: string;
  targetPage?: RoomTargetPage | null;
  media?: MediaSyncState;
  sentAt?: number;
};

type ServerMessage = BsyncWsServerMessage | ({ type: string; sentAt?: number } & Record<string, unknown>);

const wsServer = new URL(process.env.WS_SERVER_URL || process.env.WXT_WS_SERVER || 'ws://localhost:8787');
const port = Number(process.env.PORT || wsServer.port || 8787);
const rooms = new Map<string, Room>();

function getRoom(roomCode: string | null | undefined): Room {
  const key = roomCode || '000000';
  let room = rooms.get(key);

  if (!room) {
    room = {
      targetPage: null,
      hostClientId: null,
      lastMedia: null,
      clients: new Map(),
    };
    rooms.set(key, room);
  }

  return room;
}

function findRoom(roomCode: string | null | undefined): Room | null {
  return rooms.get(roomCode || '000000') ?? null;
}

function send(ws: ServerWebSocket, message: ServerMessage) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ ...message, sentAt: message.sentAt ?? Date.now() }));
}

function broadcast(roomCode: string, message: ServerMessage, exceptClientId?: string) {
  const room = rooms.get(roomCode);
  if (!room) return;

  for (const [clientId, ws] of room.clients) {
    if (clientId === exceptClientId) continue;
    send(ws, message);
  }
}

function broadcastPresence(roomCode: string) {
  const room = rooms.get(roomCode);
  if (!room) return;

  broadcast(roomCode, {
    type: 'presence',
    roomCode,
    peerCount: room.clients.size,
  });
}

function leaveRoom(ws: ServerWebSocket) {
  const { roomCode, clientId } = ws.data;
  if (!roomCode || !clientId) return;

  const room = rooms.get(roomCode);
  if (!room) return;
  if (room.clients.get(clientId) !== ws) return;

  const wasHost = room.hostClientId === clientId;
  room.clients.delete(clientId);
  ws.data.roomCode = null;
  ws.data.clientId = null;
  ws.data.displayName = null;

  if (wasHost) {
    for (const peer of room.clients.values()) {
      send(peer, {
        type: 'room:closed',
        roomCode,
        reason: 'Host left the room',
      });
      peer.data.roomCode = null;
      peer.data.clientId = null;
      peer.data.displayName = null;
    }
    rooms.delete(roomCode);
    return;
  }

  if (room.clients.size === 0) {
    rooms.delete(roomCode);
    return;
  }

  broadcastPresence(roomCode);
}

function getCurrentMediaState(media: MediaSyncState | null): MediaSyncState | null {
  if (!media || media.paused) return media;

  const elapsedSeconds = Math.max(0, (Date.now() - media.updatedAt) / 1000);
  const currentTime = media.currentTime + elapsedSeconds * (media.playbackRate || 1);

  return {
    ...media,
    currentTime: media.duration ? Math.min(currentTime, media.duration) : currentTime,
    updatedAt: Date.now(),
  };
}

Bun.serve<ServerWebSocketData>({
  port,
  fetch(request, server) {
    if (
      server.upgrade(request, {
        data: {
          clientId: null,
          roomCode: null,
          displayName: null,
        },
      })
    ) {
      return;
    }

    return new Response('BSync WebSocket relay is running.\n', {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
      },
    });
  },
  websocket: {
    message(ws, rawMessage) {
      let message: IncomingMessage;
      try {
        message = JSON.parse(String(rawMessage)) as IncomingMessage;
      } catch {
        send(ws, {
          type: 'error',
          message: 'Invalid JSON message',
        });
        return;
      }

      if (message.type === 'join') {
        leaveRoom(ws);

        const roomCode = message.roomCode || '000000';
        const clientId = message.clientId || crypto.randomUUID();
        const roomRole = message.roomRole === 'host' ? 'host' : 'guest';
        const existingRoom = findRoom(roomCode);

        if (roomRole === 'guest' && (!existingRoom || !existingRoom.targetPage)) {
          send(ws, {
            type: 'error',
            message: 'Room not found or host page is not ready',
          });
          return;
        }

        const room = existingRoom ?? getRoom(roomCode);

        ws.data.roomCode = roomCode;
        ws.data.clientId = clientId;
        ws.data.displayName = message.displayName || 'Browser';
        room.clients.set(clientId, ws);

        if (message.targetPage && (!room.hostClientId || room.hostClientId === clientId)) {
          room.targetPage = message.targetPage;
          room.hostClientId = clientId;
        }

        send(ws, {
          type: 'joined',
          roomCode,
          peerCount: room.clients.size,
          targetPage: room.targetPage,
        });

        if (room.lastMedia && room.hostClientId !== clientId) {
          const currentMedia = getCurrentMediaState(room.lastMedia);
          room.lastMedia = currentMedia;
          send(ws, {
            type: 'media:update',
            roomCode,
            clientId: room.hostClientId,
            media: currentMedia,
          });
        }

        broadcastPresence(roomCode);

        if (room.targetPage) {
          broadcast(
            roomCode,
            {
              type: 'room:update',
              roomCode,
              clientId,
              targetPage: room.targetPage,
            },
            clientId,
          );
        }

        return;
      }

      const { roomCode, clientId } = ws.data;
      if (!roomCode || !clientId) {
        send(ws, {
          type: 'error',
          message: 'Join a room before sending room events',
        });
        return;
      }

      if (message.type === 'room:update' && message.targetPage) {
        const room = getRoom(roomCode);
        if (room.hostClientId !== clientId) {
          send(ws, {
            type: 'error',
            message: 'Only the host can update the room page',
          });
          return;
        }

        room.targetPage = message.targetPage;
        broadcast(
          roomCode,
          {
            type: 'room:update',
            roomCode,
            clientId,
            targetPage: message.targetPage,
          },
          clientId,
        );
        return;
      }

      if (message.type === 'room:focus' && message.targetPage) {
        const room = getRoom(roomCode);
        if (room.hostClientId !== clientId) {
          send(ws, {
            type: 'error',
            message: 'Only the host can focus the room page',
          });
          return;
        }

        room.targetPage = message.targetPage;
        broadcast(
          roomCode,
          {
            type: 'room:focus',
            roomCode,
            clientId,
            targetPage: message.targetPage,
          },
          clientId,
        );
        return;
      }

      if (message.type === 'media:update' && message.media) {
        const room = getRoom(roomCode);
        if (room.hostClientId !== clientId) {
          send(ws, {
            type: 'error',
            message: 'Only the host can control playback',
          });
          return;
        }

        room.lastMedia = {
          ...message.media,
          updatedAt: Date.now(),
        };
        broadcast(
          roomCode,
          {
            type: 'media:update',
            roomCode,
            clientId,
            media: room.lastMedia,
          },
          clientId,
        );
        return;
      }

      if (message.type === 'media:request') {
        const room = getRoom(roomCode);
        if (room.lastMedia && room.hostClientId) {
          const currentMedia = getCurrentMediaState(room.lastMedia);
          room.lastMedia = currentMedia;
          send(ws, {
            type: 'media:update',
            roomCode,
            clientId: room.hostClientId,
            media: currentMedia,
          });
        }
        return;
      }

      if (message.type === 'ping') {
        send(ws, {
          type: 'pong',
          roomCode,
          clientId,
          sentAt: message.sentAt,
        });
      }
    },
    close(ws) {
      leaveRoom(ws);
    },
  },
});

console.log(`BSync WebSocket relay listening on ws://localhost:${port}`);
