export type RoomRole = 'none' | 'host' | 'guest';

export interface MediaSyncState {
  url: string;
  mediaId: string;
  paused: boolean;
  currentTime: number;
  duration: number | null;
  playbackRate: number;
  volume: number;
  muted: boolean;
  updatedAt: number;
}

export interface RoomTargetPage {
  title: string;
  url: string;
  normalizedUrl: string;
  hostname: string;
  createdAt: number;
}

export type BsyncWsClientMessage =
  | {
      type: 'join';
      roomCode: string;
      clientId: string;
      roomRole: RoomRole;
      displayName: string;
      targetPage: RoomTargetPage | null;
      sentAt: number;
    }
  | {
      type: 'room:update';
      roomCode: string;
      clientId: string;
      targetPage: RoomTargetPage;
      sentAt: number;
    }
  | {
      type: 'room:focus';
      roomCode: string;
      clientId: string;
      targetPage: RoomTargetPage;
      sentAt: number;
    }
  | {
      type: 'media:update';
      roomCode: string;
      clientId: string;
      media: MediaSyncState;
      sentAt: number;
    }
  | {
      type: 'media:request';
      roomCode: string;
      clientId: string;
      sentAt: number;
    }
  | {
      type: 'ping';
      roomCode: string;
      clientId: string;
      sentAt: number;
    };

export type BsyncWsServerMessage =
  | {
      type: 'joined';
      roomCode: string;
      peerCount: number;
      targetPage: RoomTargetPage | null;
      sentAt: number;
    }
  | {
      type: 'presence';
      roomCode: string;
      peerCount: number;
      sentAt: number;
    }
  | {
      type: 'room:update';
      roomCode: string;
      clientId: string;
      targetPage: RoomTargetPage;
      sentAt: number;
    }
  | {
      type: 'room:focus';
      roomCode: string;
      clientId: string;
      targetPage: RoomTargetPage;
      sentAt: number;
    }
  | {
      type: 'media:update';
      roomCode: string;
      clientId: string;
      media: MediaSyncState;
      sentAt: number;
    }
  | {
      type: 'pong';
      roomCode: string;
      clientId: string;
      sentAt: number;
    }
  | {
      type: 'error';
      message: string;
      sentAt: number;
    };

export function isBsyncWsServerMessage(message: unknown): message is BsyncWsServerMessage {
  if (!message || typeof message !== 'object') return false;

  const candidate = message as BsyncWsServerMessage;
  return typeof candidate.type === 'string' && typeof candidate.sentAt === 'number';
}
