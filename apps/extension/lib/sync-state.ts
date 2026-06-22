import { storage } from 'wxt/utils/storage';
import { browser } from 'wxt/browser';
import { isBsyncWsServerMessage } from '@bsync/sync-protocol';
import type {
  BsyncWsClientMessage,
  BsyncWsServerMessage,
  MediaSyncState,
  RoomRole,
  RoomTargetPage,
} from '@bsync/sync-protocol';

export type SyncStatus = 'idle' | 'connecting' | 'synced' | 'paused' | 'error';
export type TransportStatus = 'offline' | 'connecting' | 'online' | 'error';
export type OverlayPosition = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
export { isBsyncWsServerMessage };
export type {
  BsyncWsClientMessage,
  BsyncWsServerMessage,
  MediaSyncState,
  RoomRole,
  RoomTargetPage,
};

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
}

export interface RoomSessionState {
  status: SyncStatus;
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
  lastSyncedAt: number | null;
  connectedAt: number | null;
  lastTransportError: string | null;
  targetPage: RoomTargetPage | null;
  pendingFocusRequest: RoomFocusRequest | null;
  activity: SyncActivity[];
}

export interface SyncState extends SyncPreferences, RoomSessionState {}

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

export type ContentPageSnapshot = Omit<TabSyncState, 'tabId' | 'updatedAt'>;

export type BsyncRuntimeMessage =
  | {
      type: 'bsync:tab-page';
      payload: ContentPageSnapshot;
    }
  | {
      type: 'bsync:media-state';
      payload: MediaSyncState;
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
        requested: MediaSyncState;
        before: MediaSyncState;
        after: MediaSyncState;
        driftSeconds: number;
      };
    }
  | {
      type: 'bsync:media-apply-failed';
      payload: {
        requested: MediaSyncState;
        reason: string;
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
      type: 'bsync:get-state';
    }
  | {
      type: 'bsync:set-state';
      payload: SyncState;
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

export type BsyncContentMessage = {
  type: 'bsync:media-apply';
  payload: MediaSyncState;
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
};

export const DEFAULT_ROOM_SESSION: RoomSessionState = {
  status: 'idle',
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
  };
}

export function clearRoomSession(state: SyncState): SyncState {
  return {
    ...state,
    ...DEFAULT_ROOM_SESSION,
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
    (candidate.type === 'bsync:media-state' && typeof candidate.payload?.currentTime === 'number') ||
    (candidate.type === 'bsync:media-detach' && typeof candidate.payload?.reason === 'string') ||
    (candidate.type === 'bsync:media-applied' && typeof candidate.payload?.driftSeconds === 'number') ||
    (candidate.type === 'bsync:media-apply-failed' && typeof candidate.payload?.reason === 'string') ||
    (candidate.type === 'bsync:focus-open' && typeof candidate.payload?.targetPage?.url === 'string') ||
    candidate.type === 'bsync:guest-sync'
  );
}

export function getTabPageLabel(tabState: TabSyncState | null | undefined): string {
  if (!tabState) return 'No active tab data yet';

  const title = tabState.title || tabState.hostname || 'Untitled page';
  return tabState.hostname ? `${title} · ${tabState.hostname}` : title;
}

function stripUrlHash(url: string): string {
  const hashIndex = url.indexOf('#');
  return hashIndex === -1 ? url : url.slice(0, hashIndex);
}

function normalizeRoomPath(pathname: string): string {
  if (!pathname) return '/';
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function normalizeRoomQuery(query: string | undefined): string {
  if (!query) return '';

  return query
    .split('&')
    .filter(Boolean)
    .sort((left, right) => {
      const leftKey = left.split('=', 1)[0] ?? '';
      const rightKey = right.split('=', 1)[0] ?? '';
      return leftKey.localeCompare(rightKey) || left.localeCompare(right);
    })
    .join('&');
}

function normalizeRoomAuthority(authority: string): string | null {
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  if (!hostPort) return null;

  if (hostPort.startsWith('[')) {
    const closingBracketIndex = hostPort.indexOf(']');
    if (closingBracketIndex === -1) return null;

    return `${hostPort.slice(0, closingBracketIndex + 1).toLowerCase()}${hostPort.slice(
      closingBracketIndex + 1,
    )}`;
  }

  const colonIndex = hostPort.lastIndexOf(':');
  const hasPort = colonIndex > -1 && hostPort.indexOf(':') === colonIndex;
  const hostname = (hasPort ? hostPort.slice(0, colonIndex) : hostPort)
    .replace(/^www\./i, '')
    .toLowerCase();
  const port = hasPort ? hostPort.slice(colonIndex) : '';

  return hostname ? `${hostname}${port}` : null;
}

export function canonicalRoomPageUrl(url: string): string | null {
  const withoutHash = stripUrlHash(url.trim());
  const match = withoutHash.match(/^([a-z][a-z0-9+.-]*:)\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?$/i);
  if (!match) return null;

  const [, protocol, authority, rawPathname, rawQuery] = match;
  const normalizedAuthority = normalizeRoomAuthority(authority);
  if (!normalizedAuthority) return null;

  const pathname = normalizeRoomPath(rawPathname);
  const query = normalizeRoomQuery(rawQuery);

  return `${protocol.toLowerCase()}//${normalizedAuthority}${pathname}${query ? `?${query}` : ''}`;
}

export function normalizeSyncUrl(url: string): string {
  return canonicalRoomPageUrl(url) ?? stripUrlHash(url.trim());
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

export function isRoomTargetUrl(targetPage: RoomTargetPage | null | undefined, url: string): boolean {
  if (!targetPage) return false;

  const current = new Set([normalizeSyncUrl(url), stripUrlHash(url.trim())]);
  const target = new Set([
    normalizeSyncUrl(targetPage.url),
    normalizeSyncUrl(targetPage.normalizedUrl),
    stripUrlHash(targetPage.url.trim()),
    stripUrlHash(targetPage.normalizedUrl.trim()),
  ]);

  for (const candidate of current) {
    if (target.has(candidate)) return true;
  }

  return false;
}

export function resolveInRoomSyncStatus(
  state: SyncState,
  transportStatus: TransportStatus = state.transportStatus,
): SyncStatus {
  if (state.status === 'paused' || state.status === 'error') return state.status;
  if (state.roomRole === 'none') return state.status === 'connecting' ? 'connecting' : 'idle';
  if (transportStatus === 'connecting' || transportStatus === 'offline') return 'connecting';
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

export function normalizeTrustedDomain(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  try {
    const withProtocol = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
    return new URL(withProtocol).hostname.replace(/^www\./, '');
  } catch {
    const hostname = trimmed.replace(/^www\./, '').split('/')[0]?.split(':')[0];
    return hostname || null;
  }
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
  const normalizedHost = hostname.toLowerCase().replace(/^www\./, '');
  if (!normalizedHost) return false;

  return trustedDomains.some((domain) => {
    const normalizedDomain = domain.toLowerCase().replace(/^www\./, '');
    return (
      normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`)
    );
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

  if (preferredTabId != null) {
    try {
      await browser.tabs.get(preferredTabId);
      return preferredTabId;
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
