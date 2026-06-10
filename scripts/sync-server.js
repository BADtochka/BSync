const wsServer = new URL(process.env.WXT_WS_SERVER || 'ws://localhost:8787');
console.log(wsServer);
const port = Number(wsServer.port);
const rooms = new Map();

function getRoom(roomCode) {
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

function findRoom(roomCode) {
  return rooms.get(roomCode || '000000') ?? null;
}

function send(ws, message) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ ...message, sentAt: message.sentAt ?? Date.now() }));
}

function broadcast(roomCode, message, exceptClientId) {
  const room = rooms.get(roomCode);
  if (!room) return;

  for (const [clientId, ws] of room.clients) {
    if (clientId === exceptClientId) continue;
    send(ws, message);
  }
}

function broadcastPresence(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  broadcast(roomCode, {
    type: 'presence',
    roomCode,
    peerCount: room.clients.size,
  });
}

function leaveRoom(ws) {
  const { roomCode, clientId } = ws.data;
  if (!roomCode || !clientId) return;

  const room = rooms.get(roomCode);
  if (!room) return;
  if (room.clients.get(clientId) !== ws) return;

  room.clients.delete(clientId);
  if (room.clients.size === 0) {
    rooms.delete(roomCode);
    return;
  }

  broadcastPresence(roomCode);
}

function getCurrentMediaState(media) {
  if (!media || media.paused) return media;

  const elapsedSeconds = Math.max(0, (Date.now() - media.updatedAt) / 1000);
  const currentTime = media.currentTime + elapsedSeconds * (media.playbackRate || 1);

  return {
    ...media,
    currentTime: media.duration ? Math.min(currentTime, media.duration) : currentTime,
    updatedAt: Date.now(),
  };
}

Bun.serve({
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
      let message;
      try {
        message = JSON.parse(String(rawMessage));
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
