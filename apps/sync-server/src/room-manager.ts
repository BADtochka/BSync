import {
  createProtocolMessage,
  isBsyncWsClientMessage,
  type BsyncWsClientMessage,
  type BsyncWsServerMessage,
  type MediaSyncStateV2,
  type ProtocolErrorCode,
  type RoomSnapshotV2,
  type RoomTargetPage,
  type ServerRoomRole,
} from '@bsync/sync-protocol';

type Session<Peer> = {
  clientId: string;
  displayName: string;
  role: ServerRoomRole;
  resumeToken: string;
  peer: Peer | null;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
};

type Room<Peer> = {
  roomId: string;
  inviteToken: string;
  inviteExpiresAt: number;
  targetPage: RoomTargetPage | null;
  media: MediaSyncStateV2 | null;
  seq: number;
  sessions: Map<string, Session<Peer>>;
  resumeTokens: Map<string, Session<Peer>>;
  hostClientId: string;
  hostGraceTimer: ReturnType<typeof setTimeout> | null;
};

export interface RoomManagerOptions<Peer> {
  send(peer: Peer, message: BsyncWsServerMessage): void;
  closePeer?(peer: Peer): void;
  now?: () => number;
  createId?: () => string;
  createToken?: () => string;
  hostReconnectGraceMs?: number;
  guestReconnectGraceMs?: number;
  inviteTtlMs?: number;
  maxRooms?: number;
  maxSessionsPerRoom?: number;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class RoomManager<Peer> {
  readonly hostReconnectGraceMs: number;
  readonly guestReconnectGraceMs: number;
  readonly inviteTtlMs: number;
  readonly maxRooms: number;
  readonly maxSessionsPerRoom: number;
  private readonly rooms = new Map<string, Room<Peer>>();
  private readonly peerSessions = new Map<Peer, { room: Room<Peer>; session: Session<Peer> }>();
  private readonly sendMessage: RoomManagerOptions<Peer>['send'];
  private readonly closePeer: NonNullable<RoomManagerOptions<Peer>['closePeer']>;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly createToken: () => string;
  private readonly schedule: NonNullable<RoomManagerOptions<Peer>['schedule']>;
  private readonly cancelSchedule: NonNullable<RoomManagerOptions<Peer>['cancelSchedule']>;

  constructor(options: RoomManagerOptions<Peer>) {
    this.sendMessage = options.send;
    this.closePeer = options.closePeer ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => crypto.randomUUID().replaceAll('-', '').slice(0, 8));
    this.createToken =
      options.createToken ?? (() => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''));
    this.hostReconnectGraceMs = options.hostReconnectGraceMs ?? 30_000;
    this.guestReconnectGraceMs = options.guestReconnectGraceMs ?? 30_000;
    this.inviteTtlMs = options.inviteTtlMs ?? 24 * 60 * 60 * 1_000;
    this.maxRooms = options.maxRooms ?? 10_000;
    this.maxSessionsPerRoom = options.maxSessionsPerRoom ?? 100;
    this.schedule = options.schedule ?? setTimeout;
    this.cancelSchedule = options.cancelSchedule ?? clearTimeout;
  }

  receive(peer: Peer, rawMessage: unknown): void {
    if (!isBsyncWsClientMessage(rawMessage)) {
      this.sendError(peer, 'invalid-message', 'Message does not match protocol v2', undefined, false);
      return;
    }

    const message = rawMessage;
    switch (message.type) {
      case 'room:create':
        this.createRoom(peer, message);
        return;
      case 'room:join':
        this.joinRoom(peer, message);
        return;
      case 'room:resume':
        this.resumeRoom(peer, message);
        return;
      case 'ping':
        this.send(peer, 'pong', { pingSentAt: message.payload.pingSentAt });
        return;
    }

    const membership = this.peerSessions.get(peer);
    if (!membership || membership.session.peer !== peer) {
      this.sendError(peer, 'not-joined', 'Join or resume a room first', message.messageId, true);
      return;
    }

    switch (message.type) {
      case 'room:leave':
        this.leave(peer, true);
        return;
      case 'room:focus':
        this.updateFocus(peer, membership.room, membership.session, message);
        return;
      case 'media:snapshot':
        this.updateMedia(peer, membership.room, membership.session, message);
        return;
      case 'media:request-snapshot':
        this.sendMediaSnapshot(peer, membership.room);
        return;
    }
  }

  disconnect(peer: Peer): void {
    this.leave(peer, false);
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  hasSession(peer: Peer): boolean {
    return this.peerSessions.has(peer);
  }

  private createRoom(
    peer: Peer,
    message: Extract<BsyncWsClientMessage, { type: 'room:create' }>,
  ): void {
    this.leave(peer, true);
    if (this.rooms.size >= this.maxRooms) {
      this.sendError(peer, 'rate-limited', 'Room capacity reached', message.messageId, false);
      return;
    }
    let roomId = this.createId();
    while (this.rooms.has(roomId)) roomId = this.createId();

    const clientId = this.createId();
    const session: Session<Peer> = {
      clientId,
      displayName: message.payload.displayName,
      role: 'host',
      resumeToken: this.createToken(),
      peer,
      disconnectTimer: null,
    };
    const room: Room<Peer> = {
      roomId,
      inviteToken: this.createToken(),
      inviteExpiresAt: this.now() + this.inviteTtlMs,
      targetPage: message.payload.targetPage,
      media: null,
      seq: 1,
      sessions: new Map([[clientId, session]]),
      resumeTokens: new Map([[session.resumeToken, session]]),
      hostClientId: clientId,
      hostGraceTimer: null,
    };
    this.rooms.set(roomId, room);
    this.peerSessions.set(peer, { room, session });

    this.send(peer, 'room:created', {
      roomId,
      inviteToken: room.inviteToken,
      inviteExpiresAt: room.inviteExpiresAt,
      resumeToken: session.resumeToken,
      snapshot: this.snapshot(room, 'host'),
    });
  }

  private joinRoom(
    peer: Peer,
    message: Extract<BsyncWsClientMessage, { type: 'room:join' }>,
  ): void {
    const room = this.rooms.get(message.payload.roomId);
    if (!room) {
      this.sendError(peer, 'room-not-found', 'Room not found', message.messageId, false);
      return;
    }
    if (room.inviteToken !== message.payload.inviteToken) {
      this.sendError(peer, 'invalid-invite', 'Invite token is invalid', message.messageId, false);
      return;
    }
    if (this.now() >= room.inviteExpiresAt) {
      this.sendError(peer, 'invalid-invite', 'Invite has expired', message.messageId, false);
      return;
    }
    if (room.sessions.size >= this.maxSessionsPerRoom) {
      this.sendError(peer, 'rate-limited', 'Room participant capacity reached', message.messageId, false);
      return;
    }

    this.leave(peer, true);
    const clientId = this.createId();
    const session: Session<Peer> = {
      clientId,
      displayName: message.payload.displayName,
      role: 'guest',
      resumeToken: this.createToken(),
      peer,
      disconnectTimer: null,
    };
    room.sessions.set(clientId, session);
    room.resumeTokens.set(session.resumeToken, session);
    this.peerSessions.set(peer, { room, session });
    room.seq += 1;

    this.send(peer, 'room:joined', {
      roomId: room.roomId,
      resumeToken: session.resumeToken,
      snapshot: this.snapshot(room, 'guest'),
    });
    this.broadcastPresence(room, peer);
  }

  private resumeRoom(
    peer: Peer,
    message: Extract<BsyncWsClientMessage, { type: 'room:resume' }>,
  ): void {
    const room = this.rooms.get(message.payload.roomId);
    const session = room?.resumeTokens.get(message.payload.resumeToken);
    if (!room || !session) {
      this.sendError(peer, 'invalid-resume', 'Room session cannot be resumed', message.messageId, false);
      return;
    }

    this.leave(peer, true);
    if (session.peer && session.peer !== peer) {
      this.peerSessions.delete(session.peer);
      this.closePeer(session.peer);
    }
    session.peer = peer;
    if (session.disconnectTimer) {
      this.cancelSchedule(session.disconnectTimer);
      session.disconnectTimer = null;
    }
    this.peerSessions.set(peer, { room, session });
    if (session.role === 'host' && room.hostGraceTimer) {
      this.cancelSchedule(room.hostGraceTimer);
      room.hostGraceTimer = null;
    }
    room.seq += 1;

    this.send(peer, 'room:joined', {
      roomId: room.roomId,
      resumeToken: session.resumeToken,
      snapshot: this.snapshot(room, session.role),
    });
    this.broadcastPresence(room, peer);
  }

  private updateFocus(
    peer: Peer,
    room: Room<Peer>,
    session: Session<Peer>,
    message: Extract<BsyncWsClientMessage, { type: 'room:focus' }>,
  ): void {
    if (session.role !== 'host') {
      this.sendError(peer, 'forbidden', 'Only the host can update the room page', message.messageId, false);
      return;
    }
    room.targetPage = message.payload.targetPage;
    room.seq += 1;
    this.broadcast(room, 'room:focus', {
      roomId: room.roomId,
      targetPage: room.targetPage,
      seq: room.seq,
    }, peer);
  }

  private updateMedia(
    peer: Peer,
    room: Room<Peer>,
    session: Session<Peer>,
    message: Extract<BsyncWsClientMessage, { type: 'media:snapshot' }>,
  ): void {
    if (session.role !== 'host') {
      this.sendError(peer, 'forbidden', 'Only the host can publish media', message.messageId, false);
      return;
    }
    room.seq += 1;
    room.media = message.payload.media
      ? { ...message.payload.media, updatedAt: this.now(), seq: room.seq }
      : null;
    this.broadcast(
      room,
      'media:command',
      {
        roomId: room.roomId,
        commandId: message.messageId,
        media: room.media,
        seq: room.seq,
      },
      peer,
    );
  }

  private leave(peer: Peer, explicit: boolean): void {
    const membership = this.peerSessions.get(peer);
    if (!membership || membership.session.peer !== peer) return;
    const { room, session } = membership;
    this.peerSessions.delete(peer);
    session.peer = null;

    if (session.role === 'host') {
      if (explicit) {
        this.closeRoom(room, 'Host left the room');
        return;
      }
      room.seq += 1;
      this.broadcastPresence(room);
      if (!room.hostGraceTimer) {
        room.hostGraceTimer = this.schedule(() => {
          room.hostGraceTimer = null;
          const host = room.sessions.get(room.hostClientId);
          if (!host?.peer) this.closeRoom(room, 'Host reconnect timeout');
        }, this.hostReconnectGraceMs);
      }
      return;
    }

    if (explicit) {
      if (session.disconnectTimer) this.cancelSchedule(session.disconnectTimer);
      room.sessions.delete(session.clientId);
      room.resumeTokens.delete(session.resumeToken);
    } else if (!session.disconnectTimer) {
      session.disconnectTimer = this.schedule(() => {
        session.disconnectTimer = null;
        if (session.peer) return;
        room.sessions.delete(session.clientId);
        room.resumeTokens.delete(session.resumeToken);
      }, this.guestReconnectGraceMs);
    }
    room.seq += 1;
    this.broadcastPresence(room);
  }

  private closeRoom(room: Room<Peer>, reason: string): void {
    if (room.hostGraceTimer) this.cancelSchedule(room.hostGraceTimer);
    room.hostGraceTimer = null;
    room.seq += 1;
    this.broadcast(room, 'room:closed', { roomId: room.roomId, reason, seq: room.seq });
    for (const session of room.sessions.values()) {
      if (session.disconnectTimer) this.cancelSchedule(session.disconnectTimer);
      if (session.peer) this.peerSessions.delete(session.peer);
      session.peer = null;
    }
    this.rooms.delete(room.roomId);
  }

  private snapshot(room: Room<Peer>, role: ServerRoomRole): RoomSnapshotV2 {
    return {
      roomId: room.roomId,
      role,
      peerCount: this.connectedPeerCount(room),
      hostConnected: Boolean(room.sessions.get(room.hostClientId)?.peer),
      targetPage: room.targetPage,
      media: this.currentMedia(room.media),
      seq: room.seq,
    };
  }

  private currentMedia(media: MediaSyncStateV2 | null): MediaSyncStateV2 | null {
    if (!media || media.paused) return media;
    const elapsed = Math.max(0, (this.now() - media.updatedAt) / 1000);
    const currentTime = media.currentTime + elapsed * media.playbackRate;
    return {
      ...media,
      currentTime: media.duration === null ? currentTime : Math.min(currentTime, media.duration),
      updatedAt: this.now(),
    };
  }

  private sendSnapshot(peer: Peer, room: Room<Peer>, role: ServerRoomRole): void {
    this.send(peer, 'room:snapshot', { snapshot: this.snapshot(room, role) });
  }

  private sendMediaSnapshot(peer: Peer, room: Room<Peer>): void {
    const media = this.currentMedia(room.media);
    this.send(peer, 'media:snapshot', {
      roomId: room.roomId,
      media: media ? { ...media, seq: room.seq } : null,
      seq: room.seq,
    });
  }

  private broadcastPresence(room: Room<Peer>, exceptPeer?: Peer): void {
    this.broadcast(
      room,
      'room:presence',
      {
        roomId: room.roomId,
        peerCount: this.connectedPeerCount(room),
        hostConnected: Boolean(room.sessions.get(room.hostClientId)?.peer),
        seq: room.seq,
      },
      exceptPeer,
    );
  }

  private connectedPeerCount(room: Room<Peer>): number {
    let count = 0;
    for (const session of room.sessions.values()) {
      if (session.peer) count += 1;
    }
    return count;
  }

  private broadcast(
    room: Room<Peer>,
    type: BsyncWsServerMessage['type'],
    payload: BsyncWsServerMessage['payload'],
    exceptPeer?: Peer,
  ): void {
    for (const session of room.sessions.values()) {
      if (!session.peer || session.peer === exceptPeer) continue;
      this.send(session.peer, type, payload);
    }
  }

  private send(
    peer: Peer,
    type: BsyncWsServerMessage['type'],
    payload: BsyncWsServerMessage['payload'],
  ): void {
    this.sendMessage(peer, createProtocolMessage(type, payload) as BsyncWsServerMessage);
  }

  private sendError(
    peer: Peer,
    code: ProtocolErrorCode,
    message: string,
    requestMessageId: string | undefined,
    retryable: boolean,
  ): void {
    this.send(peer, 'error', { code, message, requestMessageId, retryable });
  }
}
