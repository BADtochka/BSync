import { storage } from 'wxt/utils/storage';
import { browser } from 'wxt/browser';
import {
  canonicalRoomPageUrl,
  isRoomTargetUrl,
  normalizeSyncUrl,
  sanitizeObservedPageUrl,
} from './navigation/normalized-url';
import { normalizeTrustedDomain } from './navigation/trusted-domain';
import { createProtocolMessage, isBsyncWsServerMessage } from '@bsync/sync-protocol';
import type {
  BsyncWsClientMessage,
  BsyncWsServerMessage,
  MediaSyncState,
  MediaSyncStateV2,
  RoomRole,
  RoomSnapshotV2,
  RoomTargetPage,
} from '@bsync/sync-protocol';

export type SyncStatus = 'idle' | 'connecting' | 'synced' | 'paused' | 'error';
export type TransportStatus = 'offline' | 'connecting' | 'online' | 'error';
export type ConnectionState =
  | 'idle'
  | 'resolving-invite'
  | 'connecting'
  | 'joining'
  | 'synced'
  | 'reconnecting'
  | 'degraded'
  | 'error';
export type OverlayPosition = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
export { createProtocolMessage, isBsyncWsServerMessage };
export type {
  BsyncWsClientMessage,
  BsyncWsServerMessage,
  MediaSyncState,
  MediaSyncStateV2,
  RoomRole,
  RoomSnapshotV2,
  RoomTargetPage,
};
export { canonicalRoomPageUrl, isRoomTargetUrl, normalizeSyncUrl };
export { normalizeTrustedDomain };

export interface SyncActivity {
  id: string;
  label: string;
  at: number;
  tone: 'info' | 'success' | 'warning' | 'error';
}

export interface SyncPreferences {
  enabled: boolean;
  overlayVisible: boolean;
  compact: boolean;
  position: OverlayPosition;
  serverUrl: string;
  displayName: string;
  clientId: string;
  trustedDomains: string[];
  autoSwitchHostContent: boolean;
  debugMode: boolean;
}

export interface RoomSessionState {
  status: SyncStatus;
  connectionState: ConnectionState;
  transportEnabled: boolean;
  transportStatus: TransportStatus;
  roomCode: string;
  roomRole: RoomRole;
  followHost: boolean;
  detachedReason: string | null;
  peerCount: number;
  latencyMs: number;
  progressPercent: number;
  roomMedia: MediaSyncState | null;
  mediaActionRequired: boolean;
  lastSyncedAt: number | null;
  connectedAt: number | null;
  lastTransportError: string | null;
  targetPage: RoomTargetPage | null;
  pendingFocusRequest: RoomFocusRequest | null;
  activity: SyncActivity[];
}

export interface SyncState extends SyncPreferences, RoomSessionState {}

export interface ProtocolSessionState {
  roomId: string | null;
  role: 'host' | 'guest' | null;
  serverUrl: string | null;
  inviteToken: string | null;
  inviteExpiresAt: number | null;
  resumeToken: string | null;
  lastSeq: number;
  pending:
    | { type: 'create'; targetPage: RoomTargetPage }
    | { type: 'join'; roomId: string; inviteToken: string; serverUrl: string }
    | null;
}

export interface RoomFocusRequest {
  id: string;
  targetPage: RoomTargetPage;
  requestedAt: number;
  source?: FocusRequestSource;
}

export type FocusRequestSource = 'join' | 'focus';

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

export type LocalMediaSelection = {
  status: 'selected' | 'reacquiring' | 'no-candidate';
  media: MediaSyncState | null;
};

export type ContentPageSnapshot = Omit<TabSyncState, 'tabId' | 'updatedAt'>;

export type BsyncRuntimeMessage =
  | {
      type: 'bsync:tab-page';
      payload: ContentPageSnapshot;
    }
  | {
      type: 'bsync:media-candidate-upsert';
      payload: {
        documentId: string;
        mediaKey: string;
        media: MediaSyncState;
        readyState: number;
        visible: boolean;
        viewportArea: number;
        lastPlayingAt?: number;
      };
    }
  | {
      type: 'bsync:media-candidate-remove';
      payload: {
        documentId: string;
        mediaKey: string;
      };
    }
  | {
      type: 'bsync:media-detach';
      payload: {
        reason: string;
        media: MediaSyncState;
      };
    }
  | {
      type: 'bsync:media-applied';
      payload: {
        commandId: string;
        requested: MediaSyncState;
        before: MediaSyncState;
        after: MediaSyncState;
        driftSeconds: number;
      };
    }
  | {
      type: 'bsync:media-apply-failed';
      payload: {
        commandId: string;
        requested: MediaSyncState;
        reason: string;
        code?: 'user-action-required';
      };
    }
  | {
      type: 'bsync:focus-open';
      payload: {
        mode: 'current' | 'new';
        targetPage: RoomTargetPage;
        trustSite?: boolean;
      };
    }
  | {
      type: 'bsync:guest-sync';
    }
  | {
      type: 'bsync:media-resume';
    }
  | {
      type: 'bsync:get-state';
    }
  | {
      type: 'bsync:set-state';
      payload: SyncState;
    }
  | {
      type: 'bsync:patch-state';
      payload: Partial<SyncState>;
    }
  | {
      type: 'bsync:content-ready';
      payload: {
        url: string;
      };
    };

export type BsyncStateSyncMessage = {
  type: 'bsync:state-sync';
  payload: SyncState;
};

export type BsyncContentMessage =
  | {
      type: 'bsync:selected-local-media';
      payload: LocalMediaSelection;
    }
  | {
      type: 'bsync:media-apply';
      payload: {
        commandId: string;
        mediaKey: string;
        media: MediaSyncState;
        rttMs?: number;
      };
    }
  | {
      type: 'bsync:media-apply-pending';
      payload: {
        commandId: string;
        mediaKey: string;
        media: MediaSyncState;
        rttMs?: number;
      };
    }
  | {
      type: 'bsync:media-apply-cancel';
    };

export const DEFAULT_SYNC_PREFERENCES: SyncPreferences = {
  enabled: true,
  overlayVisible: true,
  compact: false,
  position: 'top-right',
  serverUrl: import.meta.env.WXT_WS_SERVER || 'ws://localhost:8787',
  displayName: 'Browser',
  clientId: `client-${Math.random().toString(36).slice(2, 10)}`,
  trustedDomains: [],
  autoSwitchHostContent: true,
  debugMode: false,
};

export const DEFAULT_ROOM_SESSION: RoomSessionState = {
  status: 'idle',
  connectionState: 'idle',
  transportEnabled: false,
  transportStatus: 'offline',
  roomCode: '000000',
  roomRole: 'none',
  followHost: true,
  detachedReason: null,
  peerCount: 1,
  latencyMs: 0,
  progressPercent: 0,
  roomMedia: null,
  mediaActionRequired: false,
  lastSyncedAt: null,
  connectedAt: null,
  lastTransportError: null,
  targetPage: null,
  pendingFocusRequest: null,
  activity: [],
};

export const DEFAULT_SYNC_STATE: SyncState = {
  ...DEFAULT_SYNC_PREFERENCES,
  ...DEFAULT_ROOM_SESSION,
};

export const syncStateItem = storage.defineItem<SyncState>('local:bsync-state', {
  fallback: DEFAULT_SYNC_STATE,
});

export const tabStateItem = storage.defineItem<TabSyncStateMap>('local:bsync-tab-states', {
  fallback: {},
});

export const DEFAULT_PROTOCOL_SESSION: ProtocolSessionState = {
  roomId: null,
  role: null,
  serverUrl: null,
  inviteToken: null,
  inviteExpiresAt: null,
  resumeToken: null,
  lastSeq: 0,
  pending: null,
};

export const protocolSessionItem = storage.defineItem<ProtocolSessionState>(
  'session:bsync-protocol-session',
  { fallback: DEFAULT_PROTOCOL_SESSION },
);

const MIGRATION_FLAG = 'local:bsync-migration-unified-v1';
const BROWSER_SESSION_MARKER = 'local:bsync-browser-session';
const LEGACY_BROWSER_SESSION_MARKER = 'session:bsync-browser-alive';

function extractPreferences(state: SyncState): SyncPreferences {
  return {
    enabled: state.enabled,
    overlayVisible: state.overlayVisible,
    compact: state.compact,
    position: state.position,
    serverUrl: state.serverUrl,
    displayName: state.displayName,
    clientId: state.clientId,
    trustedDomains: state.trustedDomains ?? DEFAULT_SYNC_PREFERENCES.trustedDomains,
    autoSwitchHostContent:
      state.autoSwitchHostContent ?? DEFAULT_SYNC_PREFERENCES.autoSwitchHostContent,
    debugMode: state.debugMode ?? DEFAULT_SYNC_PREFERENCES.debugMode,
  };
}

export function clearRoomSession(state: SyncState): SyncState {
  return {
    ...state,
    ...DEFAULT_ROOM_SESSION,
  };
}

export function leaveRoomState(state: SyncState): SyncState {
  return {
    ...state,
    transportEnabled: false,
    transportStatus: 'offline',
    connectionState: 'idle',
    connectedAt: null,
    peerCount: 1,
    roomRole: 'none',
    followHost: true,
    detachedReason: null,
    roomCode: '000000',
    targetPage: null,
    pendingFocusRequest: null,
    status: 'idle',
    progressPercent: 0,
    roomMedia: null,
    lastSyncedAt: null,
    lastTransportError: null,
  };
}

export function createDefaultSyncState(): SyncState {
  return {
    ...DEFAULT_SYNC_PREFERENCES,
    clientId: `client-${Math.random().toString(36).slice(2, 10)}`,
    ...DEFAULT_ROOM_SESSION,
    activity: [],
  };
}

export async function resetExtensionData(): Promise<SyncState> {
  await browser.storage.local.clear();
  await browser.storage.session?.clear?.();

  const nextState = createDefaultSyncState();
  await syncStateItem.setValue(nextState);
  await tabStateItem.setValue({});

  return nextState;
}

function mergeSyncState(preferences: SyncPreferences, room: RoomSessionState): SyncState {
  return {
    ...DEFAULT_SYNC_PREFERENCES,
    ...preferences,
    ...DEFAULT_ROOM_SESSION,
    ...room,
    activity: room.activity ?? DEFAULT_ROOM_SESSION.activity,
  };
}

async function migrateToUnifiedSyncStorageOnce(): Promise<void> {
  const migrated = await storage.getItem<boolean>(MIGRATION_FLAG);
  if (migrated) return;

  const [existing, preferences, room, legacySession, legacyTabStates] = await Promise.all([
    storage.getItem<SyncState>('local:bsync-state'),
    storage.getItem<SyncPreferences>('local:bsync-preferences'),
    storage.getItem<RoomSessionState>('session:bsync-room'),
    storage.getItem<SyncState>('session:bsync-state'),
    storage.getItem<TabSyncStateMap>('session:bsync-tab-states'),
  ]);

  if (preferences != null || room != null) {
    const resolvedExisting =
      existing && typeof existing === 'object' ? resolveSyncState(existing) : null;

    await syncStateItem.setValue(
      mergeSyncState(
        preferences ?? (resolvedExisting ? extractPreferences(resolvedExisting) : DEFAULT_SYNC_PREFERENCES),
        room ?? DEFAULT_ROOM_SESSION,
      ),
    );
  } else if (legacySession && typeof legacySession === 'object') {
    await syncStateItem.setValue(resolveSyncState(legacySession));
  }

  if (legacyTabStates && typeof legacyTabStates === 'object') {
    const currentTabStates = await tabStateItem.getValue();
    await tabStateItem.setValue({ ...currentTabStates, ...legacyTabStates });
  }

  await storage.removeItems([
    'local:bsync-preferences',
    'session:bsync-room',
    'session:bsync-state',
    'session:bsync-tab-states',
    LEGACY_BROWSER_SESSION_MARKER,
  ]);

  await storage.setItem(MIGRATION_FLAG, true);
}

export async function resetRoomSessionForBrowserStartup(): Promise<void> {
  const current = await syncStateItem.getValue();
  await syncStateItem.setValue(clearRoomSession(resolveSyncState(current)));
  await protocolSessionItem.setValue(DEFAULT_PROTOCOL_SESSION);
  await storage.removeItem(BROWSER_SESSION_MARKER);
}

export async function ensureBrowserSessionScopedRoomState(): Promise<void> {
  await migrateToUnifiedSyncStorageOnce();

  const marker = await storage.getItem<{ startedAt: number }>(BROWSER_SESSION_MARKER);
  if (!marker) {
    await storage.setItem(BROWSER_SESSION_MARKER, { startedAt: Date.now() });
  }
}

const IS_CONTENT_SCRIPT = import.meta.env.ENTRYPOINT === 'content';

export function isContentScriptContext(): boolean {
  if (!IS_CONTENT_SCRIPT) return false;
  if (typeof window === 'undefined') return false;

  const protocol = window.location.protocol;
  return protocol !== 'chrome-extension:' && protocol !== 'moz-extension:';
}

function subscribeSyncStateInContentScript(listener: (state: SyncState) => void): () => void {
  const apply = (value: SyncState | null | undefined) => {
    listener(resolveSyncState(value));
  };

  const onStateSyncMessage = (message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const candidate = message as Partial<BsyncStateSyncMessage>;
    if (candidate.type === 'bsync:state-sync' && candidate.payload) {
      apply(candidate.payload);
    }
  };

  browser.runtime.onMessage.addListener(onStateSyncMessage);
  browser.runtime
    .sendMessage({
      type: 'bsync:content-ready',
      payload: { url: location.href },
    })
    .catch(() => undefined);
  browser.runtime
    .sendMessage({
      type: 'bsync:get-state',
    })
    .then((response) => {
      if (!response || typeof response !== 'object') return;
      const candidate = response as Partial<BsyncStateSyncMessage>;
      if (candidate.type === 'bsync:state-sync' && candidate.payload) {
        apply(candidate.payload);
      }
    })
    .catch(() => undefined);

  return () => {
    browser.runtime.onMessage.removeListener(onStateSyncMessage);
  };
}

function subscribeSyncStateViaStorage(listener: (state: SyncState) => void): () => void {
  const apply = (value: SyncState | null | undefined) => {
    listener(resolveSyncState(value));
  };

  syncStateItem.getValue().then(apply).catch(console.error);

  const unwatch = syncStateItem.watch((value) => {
    apply(value);
  });

  const onStorageChanged = (
    changes: Record<string, Browser.storage.StorageChange>,
    area: string,
  ) => {
    if (area !== 'local') return;

    const change = changes['local:bsync-state'] ?? changes['bsync-state'];
    if (change?.newValue != null) {
      apply(change.newValue as SyncState);
    }
  };

  browser.storage.onChanged.addListener(onStorageChanged);

  return () => {
    unwatch();
    browser.storage.onChanged.removeListener(onStorageChanged);
  };
}

export function subscribeSyncState(listener: (state: SyncState) => void): () => void {
  if (isContentScriptContext()) {
    return subscribeSyncStateInContentScript(listener);
  }

  return subscribeSyncStateViaStorage(listener);
}

export function resolveSyncState(state: SyncState | null | undefined): SyncState {
  if (!state || typeof state !== 'object') {
    return DEFAULT_SYNC_STATE;
  }

  return {
    ...DEFAULT_SYNC_STATE,
    ...state,
    trustedDomains: state.trustedDomains ?? DEFAULT_SYNC_STATE.trustedDomains,
    autoSwitchHostContent:
      state.autoSwitchHostContent ?? DEFAULT_SYNC_STATE.autoSwitchHostContent,
    debugMode: state.debugMode ?? DEFAULT_SYNC_STATE.debugMode,
    activity: state.activity ?? DEFAULT_SYNC_STATE.activity,
  };
}

export function isRoomBoundPage(state: SyncState, pageUrl: string): boolean {
  const resolved = resolveSyncState(state);

  if (resolved.roomRole === 'none' || !resolved.transportEnabled) return false;
  return isRoomTargetUrl(resolved.targetPage, pageUrl);
}

export function shouldShowOverlayOnPage(state: SyncState, pageUrl: string): boolean {
  const resolved = resolveSyncState(state);

  if (!resolved.enabled || !resolved.overlayVisible) return false;
  if (resolved.roomRole !== 'host' && resolved.pendingFocusRequest) return true;
  return isRoomTargetUrl(resolved.targetPage, pageUrl);
}

export function shouldMountSyncOverlay(state: SyncState, pageUrl: string): boolean {
  const resolved = resolveSyncState(state);

  if (!resolved.enabled) return false;
  if (resolved.roomRole !== 'host' && resolved.pendingFocusRequest) return true;

  if (!resolved.transportEnabled || resolved.roomRole === 'none') {
    return false;
  }

  return isRoomBoundPage(resolved, pageUrl);
}

export function isBsyncRuntimeMessage(message: unknown): message is BsyncRuntimeMessage {
  if (!message || typeof message !== 'object') return false;

  const candidate = message as BsyncRuntimeMessage;
  return (
    (candidate.type === 'bsync:tab-page' && typeof candidate.payload?.url === 'string') ||
    (candidate.type === 'bsync:media-candidate-upsert' &&
      typeof candidate.payload?.documentId === 'string' &&
      typeof candidate.payload?.mediaKey === 'string' &&
      isMediaSyncState(candidate.payload?.media) &&
      typeof candidate.payload?.readyState === 'number' &&
      Number.isFinite(candidate.payload.readyState) &&
      typeof candidate.payload?.visible === 'boolean' &&
      typeof candidate.payload?.viewportArea === 'number' &&
      Number.isFinite(candidate.payload.viewportArea) &&
      (candidate.payload.lastPlayingAt === undefined ||
        (typeof candidate.payload.lastPlayingAt === 'number' &&
          Number.isFinite(candidate.payload.lastPlayingAt)))) ||
    (candidate.type === 'bsync:media-candidate-remove' &&
      typeof candidate.payload?.documentId === 'string' &&
      typeof candidate.payload?.mediaKey === 'string') ||
    (candidate.type === 'bsync:media-detach' &&
      typeof candidate.payload?.reason === 'string' &&
      isMediaSyncState(candidate.payload?.media)) ||
    (candidate.type === 'bsync:media-applied' &&
      typeof candidate.payload?.commandId === 'string' &&
      typeof candidate.payload?.driftSeconds === 'number' &&
      isMediaSyncState(candidate.payload?.requested) &&
      isMediaSyncState(candidate.payload?.before) &&
      isMediaSyncState(candidate.payload?.after)) ||
    (candidate.type === 'bsync:media-apply-failed' &&
      typeof candidate.payload?.commandId === 'string' &&
      typeof candidate.payload?.reason === 'string' &&
      isMediaSyncState(candidate.payload?.requested) &&
      (candidate.payload.code === undefined || candidate.payload.code === 'user-action-required')) ||
    (candidate.type === 'bsync:focus-open' && typeof candidate.payload?.targetPage?.url === 'string') ||
    candidate.type === 'bsync:guest-sync' ||
    candidate.type === 'bsync:media-resume'
  );
}

function isMediaSyncState(value: unknown): value is MediaSyncState {
  if (!value || typeof value !== 'object') return false;
  const media = value as MediaSyncState;

  return (
    typeof media.url === 'string' &&
    typeof media.mediaId === 'string' &&
    typeof media.paused === 'boolean' &&
    typeof media.currentTime === 'number' &&
    Number.isFinite(media.currentTime) &&
    (media.duration === null ||
      (typeof media.duration === 'number' && Number.isFinite(media.duration))) &&
    typeof media.playbackRate === 'number' &&
    Number.isFinite(media.playbackRate) &&
    typeof media.volume === 'number' &&
    Number.isFinite(media.volume) &&
    typeof media.muted === 'boolean' &&
    typeof media.updatedAt === 'number' &&
    Number.isFinite(media.updatedAt)
  );
}

export function getTabPageLabel(tabState: TabSyncState | null | undefined): string {
  if (!tabState) return 'No active tab data yet';

  const title = tabState.title || tabState.hostname || 'Untitled page';
  return tabState.hostname ? `${title} · ${tabState.hostname}` : title;
}

export function createRoomTargetPage(page: Pick<TabSyncState, 'title' | 'url' | 'hostname'>): RoomTargetPage {
  const url = sanitizeObservedPageUrl(page.url);
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Open an HTTP(S) page before creating or focusing a room');
  }
  return {
    title: page.title || parsed.hostname || 'Untitled page',
    url,
    normalizedUrl: normalizeSyncUrl(url),
    hostname: parsed.hostname,
    createdAt: Date.now(),
  };
}

export function mergeRoomTargetPageForFocus(
  currentTarget: RoomTargetPage | null,
  nextTarget: RoomTargetPage,
  pageUrl: string,
): RoomTargetPage {
  if (currentTarget && isRoomTargetUrl(currentTarget, pageUrl)) {
    return {
      ...currentTarget,
      title: nextTarget.title,
      url: nextTarget.url,
      hostname: nextTarget.hostname,
      normalizedUrl: nextTarget.normalizedUrl,
    };
  }

  return nextTarget;
}

export function resolveInRoomSyncStatus(
  state: SyncState,
  transportStatus: TransportStatus = state.transportStatus,
): SyncStatus {
  if (state.roomRole === 'none') return state.status === 'connecting' ? 'connecting' : 'idle';
  if (transportStatus === 'connecting' || transportStatus === 'offline') return 'connecting';
  if (transportStatus === 'error') return 'error';
  if (state.status === 'paused') return 'paused';
  return 'synced';
}

export function getRoomTargetLabel(targetPage: RoomTargetPage | null | undefined): string {
  if (!targetPage) return 'No room page selected';
  return targetPage.hostname ? `${targetPage.title} · ${targetPage.hostname}` : targetPage.title;
}

export function getFocusRequestTitle(source: FocusRequestSource = 'focus'): string {
  return source === 'join' ? 'Room page' : 'Host wants to switch page';
}

export function resolveFocusRequestSource(
  request: RoomFocusRequest | null | undefined,
): FocusRequestSource {
  return request?.source ?? 'focus';
}

export type GuestTargetPageResolution = Pick<SyncState, 'targetPage' | 'pendingFocusRequest'> & {
  openInCurrentTab: boolean;
};

export function isRoomTargetTrustedForCurrentTab(
  targetPage: RoomTargetPage,
  activeTabUrl: string | undefined,
  trustedDomains: string[],
): boolean {
  if (!activeTabUrl) return false;
  if (resolveRoomPageOpenTarget('current', activeTabUrl, trustedDomains) !== 'current') {
    return false;
  }

  const targetHostname = targetPage.hostname || getHostnameFromUrl(targetPage.url);
  if (!targetHostname) return false;

  return isTrustedHostname(targetHostname, trustedDomains);
}

export function createGuestTargetPageState(
  state: SyncState,
  targetPage: RoomTargetPage,
  source: FocusRequestSource,
  activeTabUrl: string | undefined,
  trustedDomains: string[] = [],
): GuestTargetPageResolution {
  if (state.roomRole !== 'guest') {
    return {
      targetPage: state.targetPage ?? targetPage,
      pendingFocusRequest: state.pendingFocusRequest,
      openInCurrentTab: false,
    };
  }

  if (activeTabUrl && isRoomTargetUrl(targetPage, activeTabUrl)) {
    return {
      targetPage,
      pendingFocusRequest: null,
      openInCurrentTab: false,
    };
  }

  if (isRoomTargetTrustedForCurrentTab(targetPage, activeTabUrl, trustedDomains)) {
    return {
      targetPage,
      pendingFocusRequest: null,
      openInCurrentTab: true,
    };
  }

  return {
    targetPage: state.targetPage,
    pendingFocusRequest: {
      id: `${state.roomCode}-${targetPage.createdAt}-${source}`,
      targetPage,
      requestedAt: Date.now(),
      source,
    },
    openInCurrentTab: false,
  };
}

export function normalizeRoomCode(roomCode: string): string {
  const normalized = roomCode.replace(/\D/g, '').slice(0, 6);
  return normalized || '000000';
}

export function generateRoomCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function addActivity(state: SyncState, label: string, tone: SyncActivity['tone'] = 'info'): SyncState {
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
    ].slice(0, 20),
  };
}

export async function getSyncState(): Promise<SyncState> {
  return resolveSyncState(await syncStateItem.getValue());
}

export async function updateSyncState(updater: (state: SyncState) => SyncState): Promise<SyncState> {
  const current = resolveSyncState(await syncStateItem.getValue());
  const next = updater(current);
  if (isContentScriptContext()) {
    const patch = Object.fromEntries(
      Object.entries(next).filter(([key, value]) => !Object.is(current[key as keyof SyncState], value)),
    ) as Partial<SyncState>;
    const response = await browser.runtime.sendMessage({
      type: 'bsync:patch-state',
      payload: patch,
    });
    if (response?.type === 'bsync:state-sync' && response.payload) {
      return resolveSyncState(response.payload);
    }
    return next;
  }
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

export function parseTrustedDomainsInput(input: string): string[] {
  const domains = input
    .split(/[\n,]+/)
    .map(normalizeTrustedDomain)
    .filter((domain): domain is string => Boolean(domain));

  return [...new Set(domains)];
}

export function formatTrustedDomains(domains: string[]): string {
  return domains.join('\n');
}

export function addTrustedDomain(trustedDomains: string[], hostnameOrUrl: string): string[] {
  const normalized = normalizeTrustedDomain(hostnameOrUrl);
  if (!normalized) return trustedDomains;

  const alreadyListed = trustedDomains.some(
    (domain) => domain.toLowerCase() === normalized.toLowerCase(),
  );
  if (alreadyListed) return trustedDomains;

  return [...trustedDomains, normalized];
}

export function isTrustedHostname(hostname: string, trustedDomains: string[]): boolean {
  const normalizedHost = hostname.toLowerCase();
  if (!normalizedHost) return false;

  return trustedDomains.some((domain) => {
    const normalizedDomain = normalizeTrustedDomain(domain);
    return normalizedDomain != null && normalizedHost === normalizedDomain;
  });
}

export function getHostnameFromUrl(url: string | undefined): string | null {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname;
  } catch {
    return null;
  }
}

export function createTabSnapshotFromBrowserTab(
  tab: Browser.tabs.Tab,
): ContentPageSnapshot | null {
  const hostname = getHostnameFromUrl(tab.url);
  if (!tab.url || !hostname) return null;

  return {
    title: tab.title || hostname || 'Untitled page',
    url: tab.url,
    hostname,
    documentState: 'complete',
    visible: tab.active ?? true,
  };
}

export function resolveRoomPageOpenTarget(
  preferredMode: 'current' | 'new',
  activeTabUrl: string | undefined,
  trustedDomains: string[],
): 'current' | 'new' {
  if (preferredMode === 'new') return 'new';

  const hostname = getHostnameFromUrl(activeTabUrl);
  if (!hostname) return 'new';

  return isTrustedHostname(hostname, trustedDomains) ? 'current' : 'new';
}

export async function resolveActiveBrowserTabId(
  preferredTabId?: number,
): Promise<number | undefined> {
  if (preferredTabId != null) {
    try {
      const tab = await browser.tabs.get(preferredTabId);
      if (tab.id != null) return tab.id;
    } catch {
      // Preferred tab is gone.
    }
  }

  const [activeTab] = await browser.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  return activeTab?.id;
}

export async function resolveTrustedOpenTabId(
  targetPage: RoomTargetPage,
  trustedDomains: string[],
  preferredTabId?: number,
): Promise<number | undefined> {
  const tabs = await browser.tabs.query({});

  for (const tab of tabs) {
    if (tab.id == null || !tab.url) continue;
    if (isRoomTargetUrl(targetPage, tab.url)) return tab.id;
  }

  if (preferredTabId != null) {
    try {
      await browser.tabs.get(preferredTabId);
      return preferredTabId;
    } catch {
      // Preferred tab is gone.
    }
  }

  const targetHostname = targetPage.hostname || getHostnameFromUrl(targetPage.url);
  if (targetHostname && isTrustedHostname(targetHostname, trustedDomains)) {
    for (const tab of tabs) {
      if (tab.id == null || !tab.url) continue;
      const tabHostname = getHostnameFromUrl(tab.url);
      if (tabHostname && isTrustedHostname(tabHostname, trustedDomains)) {
        return tab.id;
      }
    }
  }

  const [activeTab] = await browser.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  return activeTab?.id;
}

export async function openRoomTargetPage(
  targetPage: RoomTargetPage,
  preferredMode: 'current' | 'new',
  _trustedDomains: string[] = [],
  sourceTabId?: number,
): Promise<'current' | 'new'> {
  if (preferredMode === 'new') {
    await browser.tabs.create({
      url: targetPage.url,
      active: true,
    });
    return 'new';
  }

  const tabId = await resolveActiveBrowserTabId(sourceTabId);
  if (tabId == null) {
    await browser.tabs.create({
      url: targetPage.url,
      active: true,
    });
    return 'new';
  }

  try {
    await browser.tabs.update(tabId, {
      url: targetPage.url,
      active: true,
    });
    return 'current';
  } catch {
    await browser.tabs.create({
      url: targetPage.url,
      active: true,
    });
    return 'new';
  }
}
