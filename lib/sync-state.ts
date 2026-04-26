import { storage } from 'wxt/utils/storage';

export type SyncStatus = 'idle' | 'connecting' | 'synced' | 'paused' | 'error';
export type TransportStatus = 'offline' | 'connecting' | 'online' | 'error';
export type OverlayPosition = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
export type RoomRole = 'none' | 'host' | 'guest';

export interface SyncActivity {
  id: string;
  label: string;
  at: number;
  tone: 'info' | 'success' | 'warning' | 'error';
}

export interface SyncState {
  enabled: boolean;
  overlayVisible: boolean;
  compact: boolean;
  status: SyncStatus;
  transportEnabled: boolean;
  transportStatus: TransportStatus;
  serverUrl: string;
  clientId: string;
  roomCode: string;
  roomRole: RoomRole;
  followHost: boolean;
  detachedReason: string | null;
  displayName: string;
  peerCount: number;
  latencyMs: number;
  progressPercent: number;
  position: OverlayPosition;
  lastSyncedAt: number | null;
  connectedAt: number | null;
  lastTransportError: string | null;
  targetPage: RoomTargetPage | null;
  activity: SyncActivity[];
}

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

export interface TabSyncState {
  tabId: number;
  title: string;
  url: string;
  hostname: string;
  documentState: DocumentReadyState;
  visible: boolean;
  updatedAt: number;
}

export type TabSyncStateMap = Record<string, TabSyncState>;

export type ContentPageSnapshot = Omit<TabSyncState, 'tabId' | 'updatedAt'>;

export type BsyncRuntimeMessage = {
  type: 'bsync:tab-page';
  payload: ContentPageSnapshot;
} | {
  type: 'bsync:media-state';
  payload: MediaSyncState;
} | {
  type: 'bsync:media-detach';
  payload: {
    reason: string;
    media: MediaSyncState;
  };
};

export type BsyncContentMessage = {
  type: 'bsync:media-apply';
  payload: MediaSyncState;
};

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

export const DEFAULT_SYNC_STATE: SyncState = {
  enabled: true,
  overlayVisible: true,
  compact: false,
  status: 'idle',
  transportEnabled: false,
  transportStatus: 'offline',
  serverUrl: 'ws://localhost:8787',
  clientId: `client-${Math.random().toString(36).slice(2, 10)}`,
  roomCode: '000000',
  roomRole: 'none',
  followHost: true,
  detachedReason: null,
  displayName: 'Browser',
  peerCount: 1,
  latencyMs: 0,
  progressPercent: 0,
  position: 'top-right',
  lastSyncedAt: null,
  connectedAt: null,
  lastTransportError: null,
  targetPage: null,
  activity: [],
};

export const syncStateItem = storage.defineItem<SyncState>('local:bsync-state', {
  fallback: DEFAULT_SYNC_STATE,
});

export const tabStateItem = storage.defineItem<TabSyncStateMap>('local:bsync-tab-states', {
  fallback: {},
});

export function isBsyncRuntimeMessage(message: unknown): message is BsyncRuntimeMessage {
  if (!message || typeof message !== 'object') return false;

  const candidate = message as BsyncRuntimeMessage;
  return (
    (candidate.type === 'bsync:tab-page' && typeof candidate.payload?.url === 'string') ||
    (candidate.type === 'bsync:media-state' && typeof candidate.payload?.currentTime === 'number') ||
    (candidate.type === 'bsync:media-detach' && typeof candidate.payload?.reason === 'string')
  );
}

export function isBsyncWsServerMessage(message: unknown): message is BsyncWsServerMessage {
  if (!message || typeof message !== 'object') return false;

  const candidate = message as BsyncWsServerMessage;
  return typeof candidate.type === 'string' && typeof candidate.sentAt === 'number';
}

export function getTabPageLabel(tabState: TabSyncState | null | undefined): string {
  if (!tabState) return 'No active tab data yet';

  const title = tabState.title || tabState.hostname || 'Untitled page';
  return tabState.hostname ? `${title} · ${tabState.hostname}` : title;
}

export function normalizeSyncUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

export function createRoomTargetPage(page: Pick<TabSyncState, 'title' | 'url' | 'hostname'>): RoomTargetPage {
  return {
    title: page.title || page.hostname || 'Untitled page',
    url: page.url,
    normalizedUrl: normalizeSyncUrl(page.url),
    hostname: page.hostname,
    createdAt: Date.now(),
  };
}

export function isRoomTargetUrl(targetPage: RoomTargetPage | null | undefined, url: string): boolean {
  if (!targetPage) return false;
  return targetPage.normalizedUrl === normalizeSyncUrl(url);
}

export function getRoomTargetLabel(targetPage: RoomTargetPage | null | undefined): string {
  if (!targetPage) return 'No room page selected';
  return targetPage.hostname ? `${targetPage.title} · ${targetPage.hostname}` : targetPage.title;
}

export function normalizeRoomCode(roomCode: string): string {
  const normalized = roomCode.replace(/\D/g, '').slice(0, 6);
  return normalized || '000000';
}

export function generateRoomCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function addActivity(
  state: SyncState,
  label: string,
  tone: SyncActivity['tone'] = 'info',
): SyncState {
  return {
    ...state,
    activity: [
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        label,
        at: Date.now(),
        tone,
      },
      ...state.activity,
    ].slice(0, 5),
  };
}

export async function updateSyncState(
  updater: (state: SyncState) => SyncState,
): Promise<SyncState> {
  const current = await syncStateItem.getValue();
  const next = updater(current);
  await syncStateItem.setValue(next);
  return next;
}

export function statusLabel(status: SyncStatus): string {
  switch (status) {
    case 'connecting':
      return 'Connecting';
    case 'synced':
      return 'Synced';
    case 'paused':
      return 'Paused';
    case 'error':
      return 'Attention';
    case 'idle':
    default:
      return 'Ready';
  }
}

export function formatTimeAgo(timestamp: number | null): string {
  if (!timestamp) return 'never';

  const seconds = Math.max(1, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}
