export const PROTOCOL_VERSION = 2 as const;

export type RoomRole = 'none' | 'host' | 'guest';
export type ServerRoomRole = Exclude<RoomRole, 'none'>;

// Local extension media state. Wire messages use MediaSyncStateV2 instead.
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

export interface MediaSyncStateV2 {
  mediaKey: string;
  url: string;
  paused: boolean;
  currentTime: number;
  duration: number | null;
  playbackRate: number;
  updatedAt: number;
  seq: number;
}

export interface RoomTargetPage {
  title: string;
  url: string;
  normalizedUrl: string;
  hostname: string;
  createdAt: number;
}

export interface RoomSnapshotV2 {
  roomId: string;
  role: ServerRoomRole;
  peerCount: number;
  hostConnected: boolean;
  targetPage: RoomTargetPage | null;
  media: MediaSyncStateV2 | null;
  seq: number;
}

export interface ProtocolEnvelope<TType extends string, TPayload> {
  protocolVersion: typeof PROTOCOL_VERSION;
  type: TType;
  messageId: string;
  sentAt: number;
  payload: TPayload;
}

export type BsyncWsClientMessage =
  | ProtocolEnvelope<
      'room:create',
      { displayName: string; targetPage: RoomTargetPage | null }
    >
  | ProtocolEnvelope<
      'room:join',
      { roomId: string; inviteToken: string; displayName: string }
    >
  | ProtocolEnvelope<
      'room:resume',
      { roomId: string; resumeToken: string; lastSeq: number }
    >
  | ProtocolEnvelope<'room:leave', Record<string, never>>
  | ProtocolEnvelope<'room:focus', { targetPage: RoomTargetPage }>
  | ProtocolEnvelope<'media:snapshot', { media: Omit<MediaSyncStateV2, 'seq'> | null }>
  | ProtocolEnvelope<'media:request-snapshot', Record<string, never>>
  | ProtocolEnvelope<'ping', { pingSentAt: number }>;

export type BsyncWsServerMessage =
  | ProtocolEnvelope<
      'room:created',
      {
        roomId: string;
        inviteToken: string;
        inviteExpiresAt: number;
        resumeToken: string;
        snapshot: RoomSnapshotV2;
      }
    >
  | ProtocolEnvelope<
      'room:joined',
      { roomId: string; resumeToken: string; snapshot: RoomSnapshotV2 }
    >
  | ProtocolEnvelope<'room:snapshot', { snapshot: RoomSnapshotV2 }>
  | ProtocolEnvelope<
      'room:presence',
      { roomId: string; peerCount: number; hostConnected: boolean; seq: number }
    >
  | ProtocolEnvelope<
      'room:focus',
      { roomId: string; targetPage: RoomTargetPage; seq: number }
    >
  | ProtocolEnvelope<'room:closed', { roomId: string; reason: string; seq: number }>
  | ProtocolEnvelope<'media:snapshot', { roomId: string; media: MediaSyncStateV2 | null; seq: number }>
  | ProtocolEnvelope<
      'media:command',
      { roomId: string; commandId: string; media: MediaSyncStateV2 | null; seq: number }
    >
  | ProtocolEnvelope<'pong', { pingSentAt: number }>
  | ProtocolEnvelope<
      'error',
      { code: ProtocolErrorCode; message: string; requestMessageId?: string; retryable: boolean }
    >;

export type ProtocolErrorCode =
  | 'invalid-message'
  | 'invalid-request'
  | 'not-joined'
  | 'room-not-found'
  | 'invalid-invite'
  | 'invalid-resume'
  | 'forbidden'
  | 'room-closed'
  | 'rate-limited';

export function createProtocolMessage<TType extends string, TPayload>(
  type: TType,
  payload: TPayload,
  options: { messageId?: string; sentAt?: number } = {},
): ProtocolEnvelope<TType, TPayload> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type,
    messageId: options.messageId ?? crypto.randomUUID(),
    sentAt: options.sentAt ?? Date.now(),
    payload,
  };
}

export function isBsyncWsClientMessage(message: unknown): message is BsyncWsClientMessage {
  if (!isEnvelope(message)) return false;

  switch (message.type) {
    case 'room:create':
      return (
        isRecord(message.payload) &&
        hasOnlyKeys(message.payload, ['displayName', 'targetPage']) &&
        isBoundedString(message.payload.displayName, 1, 80) &&
        (message.payload.targetPage === null || isRoomTargetPage(message.payload.targetPage))
      );
    case 'room:join':
      return (
        isRecord(message.payload) &&
        hasOnlyKeys(message.payload, ['roomId', 'inviteToken', 'displayName']) &&
        isIdentifier(message.payload.roomId) &&
        isToken(message.payload.inviteToken) &&
        isBoundedString(message.payload.displayName, 1, 80)
      );
    case 'room:resume':
      return (
        isRecord(message.payload) &&
        hasOnlyKeys(message.payload, ['roomId', 'resumeToken', 'lastSeq']) &&
        isIdentifier(message.payload.roomId) &&
        isToken(message.payload.resumeToken) &&
        isSequence(message.payload.lastSeq)
      );
    case 'room:leave':
    case 'media:request-snapshot':
      return isEmptyRecord(message.payload);
    case 'room:focus':
      return (
        isRecord(message.payload) &&
        hasOnlyKeys(message.payload, ['targetPage']) &&
        isRoomTargetPage(message.payload.targetPage)
      );
    case 'media:snapshot':
      return (
        isRecord(message.payload) &&
        hasOnlyKeys(message.payload, ['media']) &&
        (message.payload.media === null || isMediaSyncStateV2(message.payload.media, false))
      );
    case 'ping':
      return (
        isRecord(message.payload) &&
        hasOnlyKeys(message.payload, ['pingSentAt']) &&
        isFiniteNumber(message.payload.pingSentAt)
      );
    default:
      return false;
  }
}

export function isBsyncWsServerMessage(message: unknown): message is BsyncWsServerMessage {
  if (!isEnvelope(message)) return false;

  switch (message.type) {
    case 'room:created':
      return (
        isRecord(message.payload) &&
        hasOnlyKeys(message.payload, [
          'roomId',
          'inviteToken',
          'inviteExpiresAt',
          'resumeToken',
          'snapshot',
        ]) &&
        isIdentifier(message.payload.roomId) &&
        isToken(message.payload.inviteToken) &&
        isSequence(message.payload.inviteExpiresAt) &&
        isToken(message.payload.resumeToken) &&
        isRoomSnapshotV2(message.payload.snapshot) &&
        message.payload.snapshot.roomId === message.payload.roomId &&
        message.payload.snapshot.role === 'host'
      );
    case 'room:joined':
      return (
        isRecord(message.payload) &&
        hasOnlyKeys(message.payload, ['roomId', 'resumeToken', 'snapshot']) &&
        isIdentifier(message.payload.roomId) &&
        isToken(message.payload.resumeToken) &&
        isRoomSnapshotV2(message.payload.snapshot) &&
        message.payload.snapshot.roomId === message.payload.roomId
      );
    case 'room:snapshot':
      return (
        isRecord(message.payload) &&
        hasOnlyKeys(message.payload, ['snapshot']) &&
        isRoomSnapshotV2(message.payload.snapshot)
      );
    case 'room:presence':
      return (
        isRecord(message.payload) &&
        hasOnlyKeys(message.payload, ['roomId', 'peerCount', 'hostConnected', 'seq']) &&
        isIdentifier(message.payload.roomId) &&
        isSequence(message.payload.peerCount) &&
        typeof message.payload.hostConnected === 'boolean' &&
        isSequence(message.payload.seq)
      );
    case 'room:focus':
      return (
        isRecord(message.payload) &&
        hasOnlyKeys(message.payload, ['roomId', 'targetPage', 'seq']) &&
        isIdentifier(message.payload.roomId) &&
        isRoomTargetPage(message.payload.targetPage) &&
        isSequence(message.payload.seq)
      );
    case 'room:closed':
      return (
        isRecord(message.payload) &&
        hasOnlyKeys(message.payload, ['roomId', 'reason', 'seq']) &&
        isIdentifier(message.payload.roomId) &&
        isBoundedString(message.payload.reason, 1, 300) &&
        isSequence(message.payload.seq)
      );
    case 'media:snapshot':
      return (
        isRecord(message.payload) &&
        hasOnlyKeys(message.payload, ['roomId', 'media', 'seq']) &&
        isIdentifier(message.payload.roomId) &&
        (message.payload.media === null || isMediaSyncStateV2(message.payload.media, true)) &&
        isSequence(message.payload.seq) &&
        hasMediaSequence(message.payload.media, message.payload.seq)
      );
    case 'media:command':
      return (
        isRecord(message.payload) &&
        hasOnlyKeys(message.payload, ['roomId', 'commandId', 'media', 'seq']) &&
        isIdentifier(message.payload.roomId) &&
        isBoundedString(message.payload.commandId, 1, 128) &&
        (message.payload.media === null || isMediaSyncStateV2(message.payload.media, true)) &&
        isSequence(message.payload.seq) &&
        hasMediaSequence(message.payload.media, message.payload.seq)
      );
    case 'pong':
      return (
        isRecord(message.payload) &&
        hasOnlyKeys(message.payload, ['pingSentAt']) &&
        isFiniteNumber(message.payload.pingSentAt)
      );
    case 'error':
      return (
        isRecord(message.payload) &&
        hasOnlyKeys(message.payload, [
          'code',
          'message',
          'requestMessageId',
          'retryable',
        ]) &&
        isProtocolErrorCode(message.payload.code) &&
        isBoundedString(message.payload.message, 1, 500) &&
        typeof message.payload.retryable === 'boolean' &&
        (message.payload.requestMessageId === undefined ||
          isBoundedString(message.payload.requestMessageId, 1, 128))
      );
    default:
      return false;
  }
}

function isEnvelope(value: unknown): value is ProtocolEnvelope<string, unknown> {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['protocolVersion', 'type', 'messageId', 'sentAt', 'payload']) &&
    value.protocolVersion === PROTOCOL_VERSION &&
    isBoundedString(value.type, 1, 64) &&
    isBoundedString(value.messageId, 1, 128) &&
    isFiniteNumber(value.sentAt) &&
    'payload' in value
  );
}

function isRoomSnapshotV2(value: unknown): value is RoomSnapshotV2 {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'roomId',
      'role',
      'peerCount',
      'hostConnected',
      'targetPage',
      'media',
      'seq',
    ]) &&
    isIdentifier(value.roomId) &&
    (value.role === 'host' || value.role === 'guest') &&
    isSequence(value.peerCount) &&
    typeof value.hostConnected === 'boolean' &&
    (value.targetPage === null || isRoomTargetPage(value.targetPage)) &&
    (value.media === null || isMediaSyncStateV2(value.media, true)) &&
    isSequence(value.seq)
  );
}

function isRoomTargetPage(value: unknown): value is RoomTargetPage {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, ['title', 'url', 'normalizedUrl', 'hostname', 'createdAt']) ||
    !isBoundedString(value.title, 0, 300) ||
    !isBoundedString(value.url, 1, 4096) ||
    !isBoundedString(value.normalizedUrl, 1, 4096) ||
    !isBoundedString(value.hostname, 0, 253) ||
    !isFiniteNumber(value.createdAt)
  ) {
    return false;
  }

  try {
    const url = new URL(value.url);
    const normalizedUrl = new URL(value.normalizedUrl);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (normalizedUrl.protocol === 'http:' || normalizedUrl.protocol === 'https:') &&
      value.hostname === url.hostname &&
      normalizedUrl.hostname === url.hostname
    );
  } catch {
    return false;
  }
}

function isMediaSyncStateV2(value: unknown, requireSeq: boolean): boolean {
  if (!isRecord(value)) return false;
  return (
    hasOnlyKeys(value, [
      'mediaKey',
      'url',
      'paused',
      'currentTime',
      'duration',
      'playbackRate',
      'updatedAt',
      ...(requireSeq ? ['seq'] : []),
    ]) &&
    isBoundedString(value.mediaKey, 1, 256) &&
    isBoundedString(value.url, 1, 4096) &&
    typeof value.paused === 'boolean' &&
    isFiniteNumber(value.currentTime) &&
    value.currentTime >= 0 &&
    (value.duration === null || (isFiniteNumber(value.duration) && value.duration >= 0)) &&
    isFiniteNumber(value.playbackRate) &&
    value.playbackRate > 0 &&
    isFiniteNumber(value.updatedAt) &&
    (!requireSeq || isSequence(value.seq)) &&
    (requireSeq || value.seq === undefined)
  );
}

function isProtocolErrorCode(value: unknown): value is ProtocolErrorCode {
  return (
    value === 'invalid-message' ||
    value === 'invalid-request' ||
    value === 'not-joined' ||
    value === 'room-not-found' ||
    value === 'invalid-invite' ||
    value === 'invalid-resume' ||
    value === 'forbidden' ||
    value === 'room-closed' ||
    value === 'rate-limited'
  );
}

function hasMediaSequence(value: unknown, seq: unknown): boolean {
  return value === null || (isRecord(value) && value.seq === seq);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(value);
}

function isToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(value);
}

function isSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isBoundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isEmptyRecord(value: unknown): value is Record<string, never> {
  return isRecord(value) && Object.keys(value).length === 0;
}
