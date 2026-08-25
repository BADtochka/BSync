import {
  addActivity,
  addTrustedDomain,
  createProtocolMessage,
  createGuestTargetPageState,
  createRoomTargetPage,
  createTabSnapshotFromBrowserTab,
  DEFAULT_PROTOCOL_SESSION,
  ensureBrowserSessionScopedRoomState,
  isBsyncRuntimeMessage,
  isBsyncWsServerMessage,
  isRoomTargetUrl,
  leaveRoomState,
  normalizeSyncUrl,
  openRoomTargetPage,
  protocolSessionItem,
  resetRoomSessionForBrowserStartup,
  resolveInRoomSyncStatus,
  resolveSyncState,
  resolveTrustedOpenTabId,
  statusLabel,
  syncStateItem,
  tabStateItem,
  type BsyncWsClientMessage,
  type BsyncWsServerMessage,
  type BsyncContentMessage,
  type ContentPageSnapshot,
  type MediaSyncState,
  type MediaSyncStateV2,
  type ProtocolSessionState,
  type RoomSnapshotV2,
  type RoomTargetPage,
  type SyncActivity,
  type GuestTargetPageResolution,
  type BsyncStateSyncMessage,
  type SyncState,
} from '@/lib/sync-state';
import {
  getReconnectDelayMs,
  shouldAcceptServerSequence,
} from '@/lib/connection/reconnect-policy';
import { ConnectionManager } from '@/lib/connection/connection-manager';
import {
  MediaRegistry,
  type MediaCandidateIdentity,
  type MediaSelectionSnapshot,
} from '@/lib/media/media-registry';
import { selectMediaApplyTarget } from '@/lib/media/media-apply';
import { sanitizeObservedPageUrl } from '@/lib/navigation/normalized-url';
import { validateInviteEnvelope, type InviteEnvelopeV2 } from '@bsync/invite';

type BadgeActionApi = {
  setBadgeText(details: { text?: string | null; tabId?: number | null }): Promise<void> | void;
  setBadgeBackgroundColor(details: {
    color: string | number[];
    tabId?: number | null;
  }): Promise<void> | void;
};

function getBadgeActionApi(): BadgeActionApi | undefined {
  const runtimeBrowser = browser as typeof browser & {
    browserAction?: BadgeActionApi;
    action?: BadgeActionApi;
  };

  return runtimeBrowser.action ?? runtimeBrowser.browserAction;
}

async function updateTabState(tabId: number, snapshot: ContentPageSnapshot) {
  const tabStates = await tabStateItem.getValue();

  await tabStateItem.setValue({
    ...tabStates,
    [String(tabId)]: {
      tabId,
      ...snapshot,
      url: sanitizeObservedPageUrl(snapshot.url),
      updatedAt: Date.now(),
    },
  });
}

async function syncTabStateFromBrowser(tabId: number) {
  try {
    const tab = await browser.tabs.get(tabId);
    const snapshot = createTabSnapshotFromBrowserTab(tab);
    if (!snapshot) return;

    await updateTabState(tabId, snapshot);
  } catch {
    // Tab may disappear while switching.
  }
}

async function sendMessageToAllTabFrames(tabId: number, message: unknown): Promise<void> {
  if (browser.webNavigation?.getAllFrames) {
    try {
      const frames = await browser.webNavigation.getAllFrames({ tabId });
      if (frames?.length) {
        await Promise.all(
          frames.map((frame) =>
            browser.tabs
              .sendMessage(tabId, message, { frameId: frame.frameId })
              .catch(() => undefined),
          ),
        );
        return;
      }
    } catch {
      // Fall back to the top frame when frame enumeration is unavailable.
    }
  }

  await browser.tabs.sendMessage(tabId, message).catch(() => undefined);
}

async function removeTabState(tabId: number) {
  const tabStates = await tabStateItem.getValue();
  const key = String(tabId);
  if (!(key in tabStates)) return;

  const next = { ...tabStates };
  delete next[key];
  await tabStateItem.setValue(next);
}

async function handleTabRemoved(tabId: number) {
  const tabStates = await tabStateItem.getValue();
  const removedTabState = tabStates[String(tabId)];

  await removeTabState(tabId);
  if (!removedTabState?.url) return;

  const state = await syncStateItem.getValue();
  if (state.roomRole === 'none' || !state.targetPage) return;
  if (!isRoomTargetUrl(state.targetPage, removedTabState.url)) return;

  await syncStateItem.setValue(
    addActivity(
      leaveRoomState(state),
      state.roomRole === 'host' ? 'Host room tab closed' : 'Room tab closed',
      'warning',
    ),
  );
}

function getMediaProgressPercent(media: MediaSyncState): number {
  if (!media.duration || media.duration <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((media.currentTime / media.duration) * 100)));
}

function getMediaActivityLabel(media: MediaSyncState): string {
  return `${media.paused ? 'paused' : 'playing'} ${Math.round(media.currentTime)}s${
    media.duration ? `/${Math.round(media.duration)}s` : ''
  }`;
}

const UNSTABLE_LATENCY_MS = 2500;
const MEDIA_ACTIVITY_THROTTLE_MS = 5000;
const MEDIA_APPLY_ACK_TIMEOUT_MS = 4000;
const MEDIA_REGISTRY_PRUNE_INTERVAL_MS = 1000;
const ALLOW_LOCAL_ENDPOINTS =
  import.meta.env.DEV || import.meta.env.WXT_ALLOW_LOCAL_ENDPOINTS === 'true';

function makeMediaCandidateIdentityKey(candidate: MediaCandidateIdentity): string {
  return `${candidate.tabId}\u0000${candidate.frameId}\u0000${candidate.documentId}\u0000${candidate.mediaKey}`;
}

function isAllowedWebSocketServerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
    if (url.protocol === 'wss:') return true;
    return (
      ALLOW_LOCAL_ENDPOINTS &&
      url.protocol === 'ws:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    );
  } catch {
    return false;
  }
}

function isAllowedPublicWebPage(value: string | undefined): boolean {
  const configured = import.meta.env.WXT_PUBLIC_WEB_ORIGIN;
  if (!configured || !value) return false;
  try {
    const actual = new URL(value);
    const invitePath = actual.pathname.replace(/\/$/u, '').replace(/\/index\.html$/u, '');
    return (
      actual.origin === new URL(configured).origin &&
      invitePath === '/invite'
    );
  } catch {
    return false;
  }
}

export default defineBackground(() => {
  browser.runtime.onStartup.addListener(() => {
    resetRoomSessionForBrowserStartup().catch(console.error);
  });

  let activeState: SyncState | null = null;
  let lastRoomTargetKey = '';
  let lastMediaKey = '';
  let lastTransportReconcileKey = '';
  let statePatchQueue: Promise<unknown> = Promise.resolve();
  let hostMediaAuthorityQueue: Promise<unknown> = Promise.resolve();
  let lastHostAuthorityTargetKey = '';
  let webJoinGeneration = 0;
  const activityLogAt = new Map<string, number>();
  const pendingMediaApplyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingMediaApplyCandidates = new Map<string, string>();
  const userActionRequiredCandidates = new Set<string>();
  const mediaRegistry = new MediaRegistry();
  const candidateMedia = new Map<
    string,
    { media: MediaSyncState; lastSeenAt: number }
  >();
  const pendingGuestSyncUrls = new Set<string>();
  let previousWatchState: SyncState | null = null;
  let stateBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
  let activeProtocolSession: ProtocolSessionState = DEFAULT_PROTOCOL_SESSION;
  let initializationPromise: Promise<unknown> = Promise.resolve();
  let connection: ConnectionManager<BsyncWsServerMessage, BsyncWsClientMessage>;

  const broadcastSyncState = (state: SyncState) => {
    if (stateBroadcastTimer) clearTimeout(stateBroadcastTimer);

    stateBroadcastTimer = setTimeout(() => {
      stateBroadcastTimer = null;
      const payload = resolveSyncState(state);

      browser.tabs
        .query({})
        .then((tabs) => {
          for (const tab of tabs) {
            if (tab.id == null) continue;
            void sendMessageToAllTabFrames(tab.id, {
              type: 'bsync:state-sync',
              payload,
            } satisfies BsyncStateSyncMessage);
          }
        })
        .catch(console.error);
    }, 32);
  };

  const refreshBadge = async () => {
    const actionApi = getBadgeActionApi();
    if (!actionApi) return;

    const state = await syncStateItem.getValue();
    const badgeText = state.enabled ? statusLabel(state.status).slice(0, 4) : 'Off';

    await actionApi.setBadgeText({ text: badgeText });
    await actionApi.setBadgeBackgroundColor({
      color: state.transportStatus === 'online' ? '#37c28a' : '#5f6f78',
    });
  };

  const patchSyncState = async (
    updater: (state: SyncState) => SyncState,
  ): Promise<SyncState> => {
    const runPatch = async () => {
      const current = await syncStateItem.getValue();
      const next = updater(current);
      await syncStateItem.setValue(next);
      return next;
    };

    const patch = statePatchQueue.then(runPatch, runPatch);
    statePatchQueue = patch.catch(() => undefined);
    return patch;
  };

  const logActivity = (
    label: string,
    tone: SyncActivity['tone'] = 'info',
    key = label,
    throttleMs = 0,
  ) => {
    const now = Date.now();
    const previousLogAt = activityLogAt.get(key) ?? 0;
    if (throttleMs > 0 && now - previousLogAt < throttleMs) return;

    activityLogAt.set(key, now);
    patchSyncState((state) => addActivity(state, label, tone)).catch(console.error);
  };

  const getSelectedMedia = (snapshot: MediaSelectionSnapshot): MediaSyncState | null => {
    if (!snapshot.candidate) return null;
    return candidateMedia.get(makeMediaCandidateIdentityKey(snapshot.candidate))?.media ?? null;
  };

  const notifySelectedLocalMedia = (tabId: number, snapshot?: MediaSelectionSnapshot) => {
    const selection = snapshot ?? mediaRegistry.selectionSnapshot(tabId, Date.now());
    const message: BsyncContentMessage = {
      type: 'bsync:selected-local-media',
      payload: {
        status: selection.status,
        media: getSelectedMedia(selection),
      },
    };

    void browser.tabs.sendMessage(tabId, message, { frameId: 0 }).catch(() => undefined);
  };

  const syncMediaActionRequired = () => {
    const mediaActionRequired = userActionRequiredCandidates.size > 0;
    patchSyncState((state) =>
      state.mediaActionRequired === mediaActionRequired
        ? state
        : { ...state, mediaActionRequired },
    ).catch(console.error);
  };

  const clearCandidateState = (matches: (candidate: MediaCandidateIdentity) => boolean) => {
    let removedBlockedCandidate = false;
    for (const key of candidateMedia.keys()) {
      const [tabId, frameId, documentId, mediaKey] = key.split('\u0000');
      const candidate = {
        tabId: Number(tabId),
        frameId: Number(frameId),
        documentId: documentId ?? '',
        mediaKey: mediaKey ?? '',
      };
      if (!matches(candidate)) continue;
      candidateMedia.delete(key);
      removedBlockedCandidate = userActionRequiredCandidates.delete(key) || removedBlockedCandidate;
    }
    if (removedBlockedCandidate) syncMediaActionRequired();
  };

  const cancelPendingMediaActions = () => {
    const candidateKeys = new Set([
      ...userActionRequiredCandidates,
      ...pendingMediaApplyCandidates.values(),
    ]);
    for (const key of candidateKeys) {
      const [tabId, frameId] = key.split('\u0000');
      const message: BsyncContentMessage = { type: 'bsync:media-apply-cancel' };
      void browser.tabs
        .sendMessage(Number(tabId), message, { frameId: Number(frameId) })
        .catch(() => undefined);
    }
    for (const timer of pendingMediaApplyTimers.values()) clearTimeout(timer);
    pendingMediaApplyTimers.clear();
    pendingMediaApplyCandidates.clear();
    userActionRequiredCandidates.clear();
  };

  const openFocusTarget = async (mode: 'current' | 'new') => {
    const latestState = await syncStateItem.getValue();
    const focusRequest = latestState.pendingFocusRequest;
    if (!focusRequest) return;

    const { targetPage } = focusRequest;
    await patchSyncState((state) =>
      addActivity(
        {
          ...state,
          targetPage,
          pendingFocusRequest: null,
        },
        'Opening room page',
        'success',
      ),
    );
    await openRoomTargetPage(targetPage, mode, latestState.trustedDomains ?? []);
  };

  const send = (message: BsyncWsClientMessage) => {
    return connection.send(message);
  };

  const makeRoomTargetKey = (state: SyncState) =>
    [
      state.roomCode,
      state.clientId,
      state.targetPage?.normalizedUrl ?? 'none',
      state.targetPage?.createdAt ?? 0,
    ].join('|');

  const makeTransportReconcileKey = (state: SyncState) =>
    [
      state.enabled,
      state.transportEnabled,
      activeProtocolSession.serverUrl ?? state.serverUrl,
      state.roomCode,
      state.clientId,
      state.displayName,
      state.roomRole,
    ].join('|');

  const makeMediaKey = (media: MediaSyncState) =>
    [
      media.mediaId,
      media.paused,
      Math.round(media.currentTime * 2) / 2,
      media.playbackRate,
      media.duration ?? 'live',
    ].join('|');

  const publishRoomTarget = (state: SyncState) => {
    const targetKey = makeRoomTargetKey(state);
    if (targetKey === lastRoomTargetKey || !state.targetPage || state.roomRole !== 'host') return;

    lastRoomTargetKey = targetKey;
    send(createProtocolMessage('room:focus', { targetPage: state.targetPage }));
  };

  const publishMediaState = (state: SyncState, media: MediaSyncState | null) => {
    const mediaKey = media ? makeMediaKey(media) : 'no-media';
    if (mediaKey === lastMediaKey) return;

    lastMediaKey = mediaKey;
    const wireMedia: Omit<MediaSyncStateV2, 'seq'> | null = media
      ? {
          mediaKey: media.mediaId,
          url: media.url,
          paused: media.paused,
          currentTime: media.currentTime,
          duration: media.duration,
          playbackRate: media.playbackRate,
          updatedAt: media.updatedAt,
        }
      : null;
    const sent = send(createProtocolMessage('media:snapshot', { media: wireMedia }));

    logActivity(
      sent
        ? media
          ? `Media host published: ${getMediaActivityLabel(media)}`
          : 'Media host published: no candidate'
        : 'Media host publish skipped: socket offline',
      sent ? 'info' : 'warning',
      'media:host-publish',
      MEDIA_ACTIVITY_THROTTLE_MS,
    );
  };

  const requestHostMediaState = (state: SyncState) => {
    if (state.roomRole !== 'guest' || !state.followHost) return;

    const sent = send(createProtocolMessage('media:request-snapshot', {}));

    logActivity(
      sent ? 'Media follow requested from host' : 'Media follow request skipped: socket offline',
      sent ? 'info' : 'warning',
      'media:follow-request',
      MEDIA_ACTIVITY_THROTTLE_MS,
    );
  };

  const createRoomTargetPageFromTab = async (
    tabId: number,
    pageUrl: string,
  ): Promise<RoomTargetPage | null> => {
    try {
      const tab = await browser.tabs.get(tabId);
      const snapshot = createTabSnapshotFromBrowserTab({
        ...tab,
        url: pageUrl,
      });
      if (snapshot) return createRoomTargetPage(snapshot);
    } catch {
      // Tab may disappear or no longer expose a readable URL.
    }

    try {
      const parsed = new URL(pageUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

      return createRoomTargetPage({
        title: parsed.hostname,
        url: pageUrl,
        hostname: parsed.hostname,
      });
    } catch {
      return null;
    }
  };

  const publishCurrentState = (state: SyncState) => {
    if (!connection.connected || state.transportStatus !== 'online') return;
    publishRoomTarget(state);
  };

  const closeSocket = () => {
    connection.disconnect();
    lastRoomTargetKey = '';
    lastMediaKey = '';
    lastTransportReconcileKey = '';
  };

  const setTransportOffline = async () => {
    await patchSyncState((state) => ({
      ...state,
      transportStatus: 'offline',
      connectionState: 'idle',
      connectedAt: null,
      peerCount: 1,
    }));
  };

  const toLocalMedia = (media: MediaSyncStateV2): MediaSyncState => ({
    url: media.url,
    mediaId: media.mediaKey,
    paused: media.paused,
    currentTime: media.currentTime,
    duration: media.duration,
    playbackRate: media.playbackRate,
    volume: 1,
    muted: false,
    updatedAt: media.updatedAt,
  });

  const updateProtocolSession = async (next: ProtocolSessionState) => {
    activeProtocolSession = next;
    await protocolSessionItem.setValue(next);
  };

  const acceptSequence = async (seq: number): Promise<boolean> => {
    if (!shouldAcceptServerSequence(activeProtocolSession.lastSeq, seq)) return false;
    await updateProtocolSession({ ...activeProtocolSession, lastSeq: seq });
    return true;
  };

  const applyRoomSnapshot = async (snapshot: RoomSnapshotV2, initial: boolean) => {
    if (!initial && !(await acceptSequence(snapshot.seq))) return;
    if (initial && snapshot.seq > activeProtocolSession.lastSeq) {
      await updateProtocolSession({ ...activeProtocolSession, lastSeq: snapshot.seq });
    }

    const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
    const activeTabUrl = activeTab?.url;
    const baseState = await syncStateItem.getValue();
    const trustedDomains = baseState.trustedDomains ?? [];
    const pageState =
      snapshot.role === 'guest' && snapshot.targetPage
        ? createGuestTargetPageState(baseState, snapshot.targetPage, 'join', activeTabUrl, trustedDomains)
        : {
            targetPage: snapshot.targetPage,
            pendingFocusRequest: null,
            openInCurrentTab: false,
          };
    const media = snapshot.media ? toLocalMedia(snapshot.media) : null;

    await patchSyncState((state) =>
      addActivity(
        {
          ...state,
          roomCode: snapshot.roomId,
          roomRole: snapshot.role,
          transportStatus: 'online',
          connectionState: 'synced',
          connectedAt: state.connectedAt ?? Date.now(),
          lastTransportError: null,
          peerCount: snapshot.peerCount,
          targetPage: pageState.targetPage,
          pendingFocusRequest: pageState.pendingFocusRequest,
          followHost: snapshot.role === 'host' || pageState.openInCurrentTab ? true : state.followHost,
          detachedReason: pageState.openInCurrentTab ? null : state.detachedReason,
          status: media ? (media.paused ? 'paused' : 'synced') : resolveInRoomSyncStatus(state, 'online'),
          roomMedia: media,
          mediaActionRequired: false,
          progressPercent: media ? getMediaProgressPercent(media) : 0,
          lastSyncedAt: media ? Date.now() : state.lastSyncedAt,
        },
        `${initial ? 'Connected to' : 'Room snapshot received for'} ${snapshot.roomId}`,
        'success',
      ),
    );

    await applyGuestTargetPageResolution(pageState, activeTab?.id, trustedDomains);
    if (snapshot.role === 'guest' && media && baseState.followHost) {
      await applyRemoteMediaState(media);
    }
  };

  const handleServerMessage = async (message: BsyncWsServerMessage) => {
    switch (message.type) {
      case 'pong': {
        const latencyMs = Math.max(1, Date.now() - message.payload.pingSentAt);
        await patchSyncState((state) => ({
          ...state,
          latencyMs,
          ...(state.roomRole === 'guest' && state.followHost && latencyMs > UNSTABLE_LATENCY_MS
            ? { followHost: false, detachedReason: `Unstable connection (${latencyMs}ms)` }
            : {}),
        }));
        return;
      }
      case 'room:created':
        if (activeProtocolSession.pending?.type !== 'create') return;
        await updateProtocolSession({
          roomId: message.payload.roomId,
          role: 'host',
          serverUrl: activeProtocolSession.serverUrl,
          inviteToken: message.payload.inviteToken,
          inviteExpiresAt: message.payload.inviteExpiresAt,
          resumeToken: message.payload.resumeToken,
          lastSeq: 0,
          pending: null,
        });
        await applyRoomSnapshot(message.payload.snapshot, true);
        publishCurrentState(await syncStateItem.getValue());
        return;
      case 'room:joined':
        if (
          message.payload.roomId !== activeProtocolSession.roomId &&
          message.payload.roomId !==
            (activeProtocolSession.pending?.type === 'join'
              ? activeProtocolSession.pending.roomId
              : null)
        ) {
          return;
        }
        await updateProtocolSession({
          ...activeProtocolSession,
          roomId: message.payload.roomId,
          role: message.payload.snapshot.role,
          resumeToken: message.payload.resumeToken,
          lastSeq: 0,
          pending: null,
        });
        await applyRoomSnapshot(message.payload.snapshot, true);
        return;
      case 'room:snapshot':
        if (message.payload.snapshot.roomId !== activeProtocolSession.roomId) return;
        await applyRoomSnapshot(message.payload.snapshot, false);
        return;
      case 'room:presence':
        if (message.payload.roomId !== activeProtocolSession.roomId) return;
        if (!(await acceptSequence(message.payload.seq))) return;
        await patchSyncState((state) => ({
          ...state,
          peerCount: message.payload.peerCount,
          connectionState: message.payload.hostConnected ? 'synced' : 'degraded',
        }));
        return;
      case 'room:closed':
        if (message.payload.roomId !== activeProtocolSession.roomId) return;
        if (!(await acceptSequence(message.payload.seq))) return;
        await updateProtocolSession(DEFAULT_PROTOCOL_SESSION);
        await patchSyncState((state) =>
          addActivity(leaveRoomState(state), message.payload.reason, 'warning'),
        );
        return;
      case 'room:focus': {
        if (message.payload.roomId !== activeProtocolSession.roomId) return;
        if (!(await acceptSequence(message.payload.seq))) return;
        const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
        const baseState = await syncStateItem.getValue();
        if (baseState.roomRole === 'host') return;
        const trustedDomains = baseState.trustedDomains ?? [];
        const pageState = createGuestTargetPageState(
          baseState,
          message.payload.targetPage,
          'focus',
          activeTab?.url,
          trustedDomains,
        );
        await patchSyncState((state) =>
          addActivity(
            {
              ...state,
              targetPage: pageState.targetPage,
              pendingFocusRequest: pageState.pendingFocusRequest,
              ...(pageState.openInCurrentTab ? { followHost: true, detachedReason: null } : {}),
            },
            `Host focused: ${message.payload.targetPage.hostname || message.payload.targetPage.title}`,
            'info',
          ),
        );
        await applyGuestTargetPageResolution(pageState, activeTab?.id, trustedDomains);
        return;
      }
      case 'media:snapshot':
      case 'media:command': {
        if (message.payload.roomId !== activeProtocolSession.roomId) return;
        if (message.type === 'media:command') {
          if (!(await acceptSequence(message.payload.seq))) return;
        } else if (message.payload.seq < activeProtocolSession.lastSeq) {
          return;
        } else if (message.payload.seq > activeProtocolSession.lastSeq) {
          await acceptSequence(message.payload.seq);
        }
        const media = message.payload.media ? toLocalMedia(message.payload.media) : null;
        if (!media) cancelPendingMediaActions();
        const state = await syncStateItem.getValue();
        const shouldApplyMedia = Boolean(media) && state.roomRole === 'guest' && state.followHost;
        logActivity(
          !media
            ? 'Media host received: no candidate'
            : shouldApplyMedia
            ? `Media host received: ${getMediaActivityLabel(media)}`
            : `Media host received while detached: ${getMediaActivityLabel(media)}`,
          !media || shouldApplyMedia ? 'info' : 'warning',
          !media
            ? 'media:host-received-empty'
            : shouldApplyMedia
              ? 'media:host-received'
              : 'media:host-received-detached',
          MEDIA_ACTIVITY_THROTTLE_MS,
        );
        if (shouldApplyMedia && media) {
          await applyRemoteMediaState(
            media,
            message.type === 'media:command' ? message.payload.commandId : message.messageId,
          );
        }
        await patchSyncState((current) => ({
          ...current,
          ...(shouldApplyMedia && media ? { status: media.paused ? 'paused' : 'synced' } : {}),
          progressPercent: media ? getMediaProgressPercent(media) : 0,
          roomMedia: media,
          mediaActionRequired: media ? current.mediaActionRequired : false,
          lastSyncedAt: media ? Date.now() : current.lastSyncedAt,
        }));
        return;
      }
      case 'error':
        if (
          message.payload.code === 'invalid-resume' ||
          (!message.payload.retryable && activeProtocolSession.pending !== null)
        ) {
          await updateProtocolSession(DEFAULT_PROTOCOL_SESSION);
          await patchSyncState((state) =>
            addActivity(
              { ...leaveRoomState(state), status: 'error', connectionState: 'error', lastTransportError: message.payload.message },
              message.payload.message,
              'error',
            ),
          );
          return;
        }
        await patchSyncState((state) =>
          addActivity(
            {
              ...state,
              transportStatus: 'error',
              connectionState: message.payload.retryable ? 'reconnecting' : 'error',
              lastTransportError: message.payload.message,
            },
            message.payload.message,
            'error',
          ),
        );
        return;
    }
  };

  const applyRemoteMediaState = async (
    media: MediaSyncState,
    commandId: string = crypto.randomUUID(),
  ) => {
    const latestState = activeState ?? (await syncStateItem.getValue());
    if (!latestState.targetPage) {
      logActivity(
        'Media apply skipped: no room page selected',
        'warning',
        'media:apply-no-target',
        MEDIA_ACTIVITY_THROTTLE_MS,
      );
      return;
    }

    const tabs = await browser.tabs.query({});
    const targetTabs = tabs.filter((tab) => {
      if (!tab.url) return false;
      return isRoomTargetUrl(latestState.targetPage, tab.url);
    });

    if (targetTabs.length === 0) {
      logActivity(
        'Media apply skipped: room page tab not found',
        'warning',
        'media:apply-no-tab',
        MEDIA_ACTIVITY_THROTTLE_MS,
      );
      return;
    }

    const selectedTargets = targetTabs.flatMap((tab) => {
      if (tab.id == null) return [];
      const selection = mediaRegistry.selectionSnapshot(tab.id, Date.now());
      if (!selection.candidate) {
        logActivity(
          `Media apply skipped: no selected candidate in tab ${tab.id}`,
          'warning',
          `media:apply-no-candidate:${tab.id}`,
          MEDIA_ACTIVITY_THROTTLE_MS,
        );
        return [];
      }

      return [{
        tabId: tab.id,
        active: Boolean(tab.active),
        candidate: selection.candidate,
        candidateKey: makeMediaCandidateIdentityKey(selection.candidate),
      }];
    });

    if (selectedTargets.length === 0) return;
    const selectedTarget = selectMediaApplyTarget(selectedTargets);
    if (!selectedTarget) return;
    if (userActionRequiredCandidates.has(selectedTarget.candidateKey)) {
      const pendingMessage: BsyncContentMessage = {
        type: 'bsync:media-apply-pending',
        payload: {
          commandId,
          mediaKey: selectedTarget.candidate.mediaKey,
          media,
          ...(latestState.latencyMs > 0 ? { rttMs: latestState.latencyMs } : {}),
        },
      };
      await browser.tabs
        .sendMessage(selectedTarget.tabId, pendingMessage, {
          frameId: selectedTarget.candidate.frameId,
        })
        .catch(() => undefined);
      return;
    }

    logActivity(
      `Media apply sent to tab ${selectedTarget.tabId}: ${getMediaActivityLabel(media)}`,
      'info',
      'media:apply-sent',
      MEDIA_ACTIVITY_THROTTLE_MS,
    );

    const { tabId, candidate, candidateKey } = selectedTarget;
        const applyKey = `${tabId}|${commandId}`;
        const existingTimer = pendingMediaApplyTimers.get(applyKey);
        if (existingTimer) clearTimeout(existingTimer);
        pendingMediaApplyCandidates.set(applyKey, candidateKey);

        pendingMediaApplyTimers.set(
          applyKey,
          setTimeout(() => {
            pendingMediaApplyTimers.delete(applyKey);
            pendingMediaApplyCandidates.delete(applyKey);
            logActivity(
              `Media apply ack timeout: tab ${tabId}`,
              'warning',
              `media:apply-timeout:${tabId}`,
              MEDIA_ACTIVITY_THROTTLE_MS,
            );
          }, MEDIA_APPLY_ACK_TIMEOUT_MS),
        );

        const message: BsyncContentMessage = {
          type: 'bsync:media-apply',
          payload: {
            commandId,
            mediaKey: candidate.mediaKey,
            media,
            ...(latestState.latencyMs > 0 ? { rttMs: latestState.latencyMs } : {}),
          },
        };

    await browser.tabs.sendMessage(tabId, message, { frameId: candidate.frameId }).catch((error) => {
            const timer = pendingMediaApplyTimers.get(applyKey);
            if (timer) clearTimeout(timer);
            pendingMediaApplyTimers.delete(applyKey);
            pendingMediaApplyCandidates.delete(applyKey);
            logActivity(
              `Media apply failed to send: tab ${tabId} (${error instanceof Error ? error.message : 'content script unavailable'})`,
              'error',
              `media:apply-send-failed:${tabId}`,
              MEDIA_ACTIVITY_THROTTLE_MS,
            );
          });
  };

  const syncGuestWithHost = async (tabUrl?: string) => {
    const latestState = await syncStateItem.getValue();
    if (latestState.roomRole !== 'guest') return;
    if (!latestState.targetPage) return;
    if (tabUrl && !isRoomTargetUrl(latestState.targetPage, tabUrl)) return;

    if (!latestState.followHost || latestState.detachedReason) {
      await patchSyncState((state) => ({
        ...state,
        followHost: true,
        detachedReason: null,
      }));
    }

    const state = await syncStateItem.getValue();
    if (state.roomMedia) {
      await applyRemoteMediaState(state.roomMedia);
    }
    requestHostMediaState(state);
  };

  const applyGuestTargetPageResolution = async (
    pageState: GuestTargetPageResolution,
    activeTabId: number | undefined,
    trustedDomains: string[],
  ) => {
    if (!pageState.openInCurrentTab || !pageState.targetPage) return;

    const tabId = await resolveTrustedOpenTabId(
      pageState.targetPage,
      trustedDomains,
      activeTabId,
    );

    await openRoomTargetPage(
      pageState.targetPage,
      'current',
      trustedDomains,
      tabId,
    );
    queueGuestPageSync(pageState.targetPage);
  };

  const queueGuestPageSync = (targetPage: RoomTargetPage) => {
    pendingGuestSyncUrls.add(normalizeSyncUrl(targetPage.url));

    Promise.all([browser.tabs.query({}), tabStateItem.getValue()])
      .then(([tabs, tabStates]) => {
        for (const tab of tabs) {
          if (!tab.url || !isRoomTargetUrl(targetPage, tab.url)) continue;

          const tabState = tabStates[String(tab.id)];
          if (tabState?.documentState !== 'complete') continue;

          handleGuestTargetPageReady(tab.url, tabState).catch(console.error);
          break;
        }
      })
      .catch(console.error);
  };

  const handleGuestTargetPageReady = async (
    tabUrl: string | undefined,
    snapshot: ContentPageSnapshot,
  ) => {
    if (!tabUrl || snapshot.documentState !== 'complete') return;
    if (!pendingGuestSyncUrls.delete(normalizeSyncUrl(tabUrl))) return;

    await syncGuestWithHost(tabUrl);
  };

  const maybeQueueGuestSyncAfterFocus = (previousState: SyncState | null, state: SyncState) => {
    if (state.roomRole !== 'guest' || !state.targetPage) return;
    if (!previousState?.pendingFocusRequest || state.pendingFocusRequest) return;

    queueGuestPageSync(state.targetPage);

    if (!state.followHost || state.detachedReason) {
      patchSyncState((current) => ({
        ...current,
        followHost: true,
        detachedReason: null,
      })).catch(console.error);
    }
  };

  const handleLocalMediaState = async (
    tabId: number,
    frameId: number,
    candidateUrl: string,
    media: MediaSyncState,
  ) => {
    const latestState = await syncStateItem.getValue();
    activeState = latestState;

    const pageUrl = candidateUrl;
    if (latestState.roomRole !== 'host') return;

    logActivity(
      `media.candidate.detected tab=${tabId} frame=${frameId} media=${media.mediaId}`,
      'info',
      `media:candidate:${tabId}:${frameId}`,
      MEDIA_ACTIVITY_THROTTLE_MS,
    );

    const isCurrentTargetPage =
      latestState.targetPage != null && isRoomTargetUrl(latestState.targetPage, pageUrl);
    if (!isCurrentTargetPage && !latestState.autoSwitchHostContent) return;

    const nextStatus = media.paused ? 'paused' : 'synced';

    let stateForPublish: SyncState;
    if (isCurrentTargetPage) {
      stateForPublish = await patchSyncState((state) => ({
        ...state,
        status: nextStatus,
        progressPercent: getMediaProgressPercent(media),
        roomMedia: media,
        lastSyncedAt: Date.now(),
      }));
    } else {
      const nextTargetPage = await createRoomTargetPageFromTab(tabId, pageUrl);
      if (!nextTargetPage) return;

      stateForPublish = await patchSyncState((state) =>
        addActivity(
          {
            ...state,
            targetPage: nextTargetPage,
            pendingFocusRequest: null,
            status: nextStatus,
            progressPercent: getMediaProgressPercent(media),
            roomMedia: media,
            lastSyncedAt: Date.now(),
          },
          `Host content switched: ${nextTargetPage.hostname || nextTargetPage.title}`,
          'success',
        ),
      );
    }

    if (stateForPublish.transportEnabled && stateForPublish.transportStatus === 'online') {
      publishMediaState(stateForPublish, media);
    }
  };

  const reconcileHostMediaAuthority = (observeMissingTabs = false) => {
    const run = async () => {
      const state = await syncStateItem.getValue();
      if (state.roomRole !== 'host' || !state.targetPage) return;
      const now = Date.now();
      const publishNoCandidate = async () => {
        const next = state.roomMedia
          ? await patchSyncState((current) => ({
              ...current,
              status: 'synced',
              progressPercent: 0,
              roomMedia: null,
              mediaActionRequired: false,
            }))
          : state;
        if (next.transportEnabled && next.transportStatus === 'online') {
          publishMediaState(next, null);
        }
      };
      const tabs = (await browser.tabs.query({})).filter(
        (tab) => tab.id != null && tab.url && isRoomTargetUrl(state.targetPage, tab.url),
      );
      if (tabs.length === 0) {
        if (mediaRegistry.selectionSnapshots(now).some((selection) => selection.status === 'reacquiring')) {
          return;
        }
        await publishNoCandidate();
        return;
      }

      const selections = tabs.map((tab) => ({
        tab,
        selection: observeMissingTabs
          ? mediaRegistry.observeTab(tab.id!, now)
          : mediaRegistry.selectionSnapshot(tab.id!, now),
      }));
      const targets = selections.flatMap(({ tab, selection }) => {
        if (!selection.candidate || tab.id == null) return [];
        const media = getSelectedMedia(selection);
        if (!media) return [];
        return [{
          tabId: tab.id,
          active: Boolean(tab.active),
          candidate: selection.candidate,
          candidateKey: makeMediaCandidateIdentityKey(selection.candidate),
          media,
        }];
      });
      const selected = selectMediaApplyTarget(targets);
      if (selected) {
        await handleLocalMediaState(
          selected.tabId,
          selected.candidate.frameId,
          selected.candidate.url,
          selected.media,
        );
        return;
      }
      if (selections.some(({ selection }) => selection.status === 'reacquiring')) return;

      await publishNoCandidate();
    };
    hostMediaAuthorityQueue = hostMediaAuthorityQueue.then(run, run);
    hostMediaAuthorityQueue.catch(console.error);
  };

  const publishSelectedLocalMedia = (_selection: MediaSelectionSnapshot) => {
    reconcileHostMediaAuthority();
  };

  const detachFromHost = async (
    reason: string,
    tabUrl: string | undefined,
    media: MediaSyncState,
  ) => {
    const latestState = await syncStateItem.getValue();
    activeState = latestState;

    const pageUrl = tabUrl || media.url;
    if (
      latestState.roomRole !== 'guest' ||
      !latestState.followHost ||
      !latestState.targetPage ||
      !isRoomTargetUrl(latestState.targetPage, pageUrl)
    ) {
      return;
    }

    await patchSyncState((state) =>
      addActivity(
        {
          ...state,
          followHost: false,
          detachedReason: reason,
          status: media.paused ? 'paused' : state.status,
          roomMedia: state.roomMedia ?? media,
        },
        `Detached from host playback: ${reason}, local ${getMediaActivityLabel(media)}`,
        'warning',
      ),
    );
  };

  const authenticateSocket = (state: SyncState) => {
    const displayName = state.displayName.trim().slice(0, 80) || 'Browser';
    if (activeProtocolSession.roomId && activeProtocolSession.resumeToken) {
      send(
        createProtocolMessage('room:resume', {
          roomId: activeProtocolSession.roomId,
          resumeToken: activeProtocolSession.resumeToken,
          lastSeq: activeProtocolSession.lastSeq,
        }),
      );
      return;
    }

    if (activeProtocolSession.pending?.type === 'create') {
      send(
        createProtocolMessage('room:create', {
          displayName,
          targetPage: activeProtocolSession.pending.targetPage,
        }),
      );
      return;
    }

    if (activeProtocolSession.pending?.type === 'join') {
      send(
        createProtocolMessage('room:join', {
          roomId: activeProtocolSession.pending.roomId,
          inviteToken: activeProtocolSession.pending.inviteToken,
          displayName,
        }),
      );
    }
  };

  connection = new ConnectionManager<BsyncWsServerMessage, BsyncWsClientMessage>({
    createSocket: (url) => new WebSocket(url),
    parseMessage: (raw) => {
      try {
        const message: unknown = JSON.parse(String(raw));
        return isBsyncWsServerMessage(message) ? message : null;
      } catch {
        return null;
      }
    },
    onMessage: (message) => handleServerMessage(message),
    createHeartbeat: (now) => createProtocolMessage('ping', { pingSentAt: now }),
    getReconnectDelayMs,
    onConnecting: ({ reconnecting }) => {
      patchSyncState((current) => ({
        ...current,
        transportStatus: 'connecting',
        connectionState: reconnecting ? 'reconnecting' : 'connecting',
        lastTransportError: null,
        status: resolveInRoomSyncStatus(current, 'connecting'),
      })).catch(console.error);
    },
    onOpen: ({ url }) => {
      patchSyncState((current) =>
        addActivity(
          {
            ...current,
            transportStatus: 'connecting',
            connectionState: 'joining',
            lastTransportError: null,
            status: resolveInRoomSyncStatus(current, 'connecting'),
          },
          `Transport connected to ${url}; authenticating room`,
          'info',
        ),
      ).catch(console.error);
      if (activeState) authenticateSocket(activeState);
    },
    onError: (error) => {
      patchSyncState((current) => ({
        ...current,
        transportStatus: 'error',
        lastTransportError: error instanceof Error ? error.message : 'WebSocket connection error',
      })).catch(console.error);
    },
    onClose: ({ reason, willReconnect }) => {
      if (!willReconnect) return;
      patchSyncState((current) => ({
        ...current,
        transportStatus: 'error',
        connectionState: 'reconnecting',
        connectedAt: null,
        lastTransportError:
          reason === 'connect-timeout'
            ? 'WebSocket connection timeout'
            : reason === 'stale'
              ? 'WebSocket connection stale'
              : 'WebSocket disconnected',
      })).catch(console.error);
    },
  });

  function connect(state: SyncState, resetBackoff = false) {
    const serverUrl = activeProtocolSession.serverUrl ?? state.serverUrl;
    if (!state.transportEnabled || !serverUrl) return;
    if (!isAllowedWebSocketServerUrl(serverUrl)) {
      patchSyncState((current) =>
        addActivity(
          {
            ...leaveRoomState(current),
            status: 'error',
            connectionState: 'error',
            lastTransportError: 'Use wss://, or ws://localhost for local development',
          },
          'Invalid sync server URL',
          'error',
        ),
      ).catch(console.error);
      return;
    }
    connection.connect(serverUrl, resetBackoff);
  }

  const reconcileTransport = (state: SyncState) => {
    const previousState = activeState;
    activeState = state;
    const transportReconcileKey = makeTransportReconcileKey(state);

    if (!state.transportEnabled || !state.enabled) {
      if (connection.currentUrl) closeSocket();
      if (
        state.transportStatus !== 'offline' ||
        state.connectedAt !== null ||
        state.peerCount !== 1
      ) {
        setTransportOffline().catch(console.error);
      }
      lastTransportReconcileKey = transportReconcileKey;
      return;
    }

    const configurationChanged = transportReconcileKey !== lastTransportReconcileKey;
    const serverUrl = activeProtocolSession.serverUrl ?? state.serverUrl;
    if (
      configurationChanged ||
      (!connection.connected && !connection.reconnectScheduled && connection.currentUrl !== serverUrl)
    ) {
      connect(state, connection.currentUrl !== serverUrl);
      lastTransportReconcileKey = transportReconcileKey;
    }
    publishCurrentState(state);

    if (
      state.roomRole === 'guest' &&
      state.followHost &&
      (!previousState ||
        !previousState.followHost ||
        previousState.roomCode !== state.roomCode ||
        previousState.clientId !== state.clientId ||
        previousState.targetPage?.normalizedUrl !== state.targetPage?.normalizedUrl)
    ) {
      requestHostMediaState(state);
      if (state.roomMedia) {
        applyRemoteMediaState(state.roomMedia).catch(console.error);
      }
    }
  };

  const startRoomIntent = async (pending: NonNullable<ProtocolSessionState['pending']>) => {
    await initializationPromise;
    const current = await syncStateItem.getValue();
    const serverUrl = pending.type === 'join' ? pending.serverUrl : current.serverUrl;
    if (!isAllowedWebSocketServerUrl(serverUrl)) {
      await patchSyncState((state) =>
        addActivity(
          {
            ...leaveRoomState(state),
            status: 'error',
            connectionState: 'error',
            lastTransportError: 'Use wss://, or ws://localhost for local development',
          },
          'Invalid sync server URL',
          'error',
        ),
      );
      throw new Error('Invalid sync server URL');
    }
    closeSocket();
    await updateProtocolSession({
      ...DEFAULT_PROTOCOL_SESSION,
      serverUrl,
      pending,
    });
    await patchSyncState((state) => ({
      ...leaveRoomState(state),
      enabled: true,
      overlayVisible: true,
      transportEnabled: true,
      transportStatus: 'connecting',
      connectionState: pending.type === 'join' ? 'resolving-invite' : 'connecting',
      targetPage: pending.type === 'create' ? pending.targetPage : null,
      status: 'connecting',
      lastTransportError: null,
    }));
  };

  const leaveActiveRoom = async () => {
    if (connection.connected && activeProtocolSession.roomId) {
      send(createProtocolMessage('room:leave', {}));
    }
    await updateProtocolSession(DEFAULT_PROTOCOL_SESSION);
    await patchSyncState((state) => addActivity(leaveRoomState(state), 'Left room', 'warning'));
  };

  refreshBadge().catch(console.error);

  initializationPromise = ensureBrowserSessionScopedRoomState()
    .then(() => Promise.all([syncStateItem.getValue(), protocolSessionItem.getValue()]))
    .then(([state, session]) => {
      activeProtocolSession = session;
      if (state.transportEnabled && !session.roomId && !session.pending) {
        const cleared = leaveRoomState(state);
        return syncStateItem.setValue(cleared).then(() => {
          reconcileTransport(cleared);
          broadcastSyncState(cleared);
        });
      }
      reconcileTransport(state);
      broadcastSyncState(state);
    })
    .catch(console.error);

  syncStateItem.watch((state) => {
    maybeQueueGuestSyncAfterFocus(previousWatchState, state);
    previousWatchState = state;
    refreshBadge().catch(console.error);
    reconcileTransport(state);
    broadcastSyncState(state);
    const hostAuthorityTargetKey =
      state.roomRole === 'host'
        ? `${state.targetPage?.normalizedUrl ?? 'none'}|${state.targetPage?.createdAt ?? 0}`
        : 'none';
    if (hostAuthorityTargetKey !== lastHostAuthorityTargetKey) {
      lastHostAuthorityTargetKey = hostAuthorityTargetKey;
      reconcileHostMediaAuthority(true);
    }
  });

  protocolSessionItem.watch((session) => {
    activeProtocolSession = session;
  });

  const joinFromInvite = (value: unknown) => {
    const invite = validateInviteEnvelope(value, { allowLocal: ALLOW_LOCAL_ENDPOINTS });
    return startRoomIntent({
      type: 'join',
      roomId: invite.roomId,
      inviteToken: invite.inviteToken,
      serverUrl: invite.serverUrl,
    });
  };

  const waitForJoinedGuest = (roomId: string): Promise<void> =>
    new Promise((resolve, reject) => {
      let settled = false;
      let unwatch = () => {};
      const timeout = setTimeout(() => finish(new Error('Timed out waiting for the room server')), 15_000);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        unwatch();
        if (error) reject(error);
        else resolve();
      };
      const check = (state: SyncState) => {
        if (
          state.roomRole === 'guest' &&
          state.roomCode === roomId &&
          state.connectionState === 'synced'
        ) {
          finish();
        } else if (state.connectionState === 'error') {
          finish(new Error(state.lastTransportError || 'The room server rejected this invite'));
        }
      };
      unwatch = syncStateItem.watch(check);
      void syncStateItem.getValue().then(check).catch(() => {
        finish(new Error('Could not read room state'));
      });
    });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'bsync:get-state') {
      return syncStateItem.getValue().then((state) => ({
        type: 'bsync:state-sync',
        payload: resolveSyncState(state),
      } satisfies BsyncStateSyncMessage));
    }

    if (
      message?.type === 'bsync:room-create' &&
      message.payload?.targetPage &&
      typeof message.payload.targetPage.url === 'string'
    ) {
      webJoinGeneration += 1;
      return startRoomIntent({ type: 'create', targetPage: message.payload.targetPage })
        .then(() => ({ ok: true }))
        .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : 'Create failed' }));
    }

    if (
      message?.type === 'bsync:room-join' &&
      typeof message.payload?.roomId === 'string' &&
      typeof message.payload?.inviteToken === 'string' &&
      typeof message.payload?.serverUrl === 'string'
    ) {
      webJoinGeneration += 1;
      return Promise.resolve().then(() => joinFromInvite({
        v: 2,
        roomId: message.payload.roomId,
        inviteToken: message.payload.inviteToken,
        serverUrl: message.payload.serverUrl,
      }))
        .then(() => ({ ok: true }))
        .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : 'Join failed' }));
    }

    if (
      message?.type === 'bsync:web-invite-join' &&
      sender.frameId === 0 &&
      isAllowedPublicWebPage(sender.tab?.url)
    ) {
      const invite = message.payload?.invite as InviteEnvelopeV2 | undefined;
      const generation = ++webJoinGeneration;
      return Promise.resolve().then(() => joinFromInvite(invite))
        .then(() => waitForJoinedGuest(invite?.roomId ?? ''))
        .then(() => ({ ok: true }))
        .catch(async (error) => {
          if (generation === webJoinGeneration) {
            await leaveActiveRoom().catch(() => undefined);
          }
          return {
            ok: false,
            error: error instanceof Error ? error.message.slice(0, 512) : 'Join failed',
          };
        });
    }

    if (message?.type === 'bsync:room-leave') {
      webJoinGeneration += 1;
      return leaveActiveRoom()
        .then(() => ({ ok: true }))
        .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : 'Leave failed' }));
    }

    if (message?.type === 'bsync:set-state' && sender.tab?.id != null) {
      return syncStateItem
        .setValue(resolveSyncState(message.payload))
        .then(async () => {
          const state = resolveSyncState(await syncStateItem.getValue());
          return {
            type: 'bsync:state-sync',
            payload: state,
          } satisfies BsyncStateSyncMessage;
        })
        .catch((error) => {
          console.error(error);
          return undefined;
        });
    }

    if (
      message?.type === 'bsync:patch-state' &&
      sender.tab?.id != null &&
      message.payload &&
      typeof message.payload === 'object'
    ) {
      const requested = message.payload as Partial<SyncState>;
      return patchSyncState((state) =>
        resolveSyncState({
          ...state,
          ...(typeof requested.overlayVisible === 'boolean'
            ? { overlayVisible: requested.overlayVisible }
            : {}),
          ...(typeof requested.compact === 'boolean' ? { compact: requested.compact } : {}),
          ...(requested.position === 'top-right' ||
          requested.position === 'top-left' ||
          requested.position === 'bottom-right' ||
          requested.position === 'bottom-left'
            ? { position: requested.position }
            : {}),
          ...(requested.followHost === true
            ? { followHost: true, detachedReason: null }
            : {}),
        }),
      ).then((state) => ({
          type: 'bsync:state-sync',
          payload: state,
        } satisfies BsyncStateSyncMessage));
    }

    if (message?.type === 'bsync:content-ready' && sender.tab?.id != null) {
      void syncStateItem.getValue().then((state) => {
        void sendMessageToAllTabFrames(sender.tab!.id!, {
          type: 'bsync:state-sync',
          payload: resolveSyncState(state),
        } satisfies BsyncStateSyncMessage);
      });
      return;
    }

    if (!isBsyncRuntimeMessage(message) || sender.tab?.id == null) return;

    if (message.type === 'bsync:tab-page') {
      updateTabState(sender.tab.id, message.payload)
        .then(() => handleGuestTargetPageReady(sender.tab?.url, message.payload))
        .catch(console.error);
      return;
    }

    if (message.type === 'bsync:guest-sync') {
      syncGuestWithHost(sender.tab?.url).catch(console.error);
      return;
    }

    if (message.type === 'bsync:media-resume') {
      const selected = mediaRegistry.selectionSnapshot(sender.tab.id, Date.now()).candidate;
      if (selected) {
        userActionRequiredCandidates.delete(makeMediaCandidateIdentityKey(selected));
      }
      const mediaActionRequired = userActionRequiredCandidates.size > 0;
      patchSyncState((state) => ({ ...state, mediaActionRequired }))
        .then((state) => {
          if (state.roomRole === 'guest' && state.followHost && state.roomMedia) {
            return applyRemoteMediaState(state.roomMedia);
          }
        })
        .catch(console.error);
      return;
    }

    if (message.type === 'bsync:media-candidate-upsert') {
      const tabId = sender.tab.id;
      const frameId = sender.frameId ?? 0;
      const now = Date.now();
      const candidateUrl = sender.tab.url || message.payload.media.url;
      const identity = {
        tabId,
        frameId,
        documentId: message.payload.documentId,
        mediaKey: message.payload.mediaKey,
      };
      const identityKey = makeMediaCandidateIdentityKey(identity);
      candidateMedia.set(identityKey, { media: message.payload.media, lastSeenAt: now });
      if (!message.payload.media.paused) {
        userActionRequiredCandidates.delete(identityKey);
        syncMediaActionRequired();
      }

      const selection = mediaRegistry.report(
        {
          ...identity,
          url: candidateUrl,
          paused: message.payload.media.paused,
          currentTime: message.payload.media.currentTime,
          duration: message.payload.media.duration,
          readyState: message.payload.readyState,
          visible: message.payload.visible,
          viewportArea: message.payload.viewportArea,
          lastPlayingAt: message.payload.lastPlayingAt,
        },
        now,
      );
      notifySelectedLocalMedia(tabId, selection);

      if (selection.candidate && makeMediaCandidateIdentityKey(selection.candidate) === identityKey) {
        syncStateItem.getValue().then(async (state) => {
          const isCurrentTarget =
            state.targetPage != null && isRoomTargetUrl(state.targetPage, candidateUrl);
          const [focusedTab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
          if (
            state.roomRole === 'host' &&
            focusedTab?.id === tabId &&
            !isCurrentTarget &&
            state.autoSwitchHostContent
          ) {
            return handleLocalMediaState(tabId, frameId, candidateUrl, message.payload.media);
          }
          reconcileHostMediaAuthority();
        }).catch(console.error);
      }
      return;
    }

    if (message.type === 'bsync:media-candidate-remove') {
      const identity = {
        tabId: sender.tab.id,
        frameId: sender.frameId ?? 0,
        documentId: message.payload.documentId,
        mediaKey: message.payload.mediaKey,
      };
      const identityKey = makeMediaCandidateIdentityKey(identity);
      candidateMedia.delete(identityKey);
      userActionRequiredCandidates.delete(identityKey);
      syncMediaActionRequired();
      const selection = mediaRegistry.remove(identity, Date.now());
      notifySelectedLocalMedia(sender.tab.id, selection);
      publishSelectedLocalMedia(selection);
      return;
    }

    if (message.type === 'bsync:media-detach') {
      detachFromHost(message.payload.reason, sender.tab.url, message.payload.media).catch(console.error);
      return;
    }

    if (message.type === 'bsync:media-applied') {
      const applyKey = `${sender.tab.id}|${message.payload.commandId}`;
      const candidateKey = pendingMediaApplyCandidates.get(applyKey);
      if (!candidateKey) return;
      const timer = pendingMediaApplyTimers.get(applyKey);
      if (timer) clearTimeout(timer);
      pendingMediaApplyTimers.delete(applyKey);
      pendingMediaApplyCandidates.delete(applyKey);

      const appliedCandidate = mediaRegistry.selectionSnapshot(sender.tab.id, Date.now()).candidate;
      if (!appliedCandidate || makeMediaCandidateIdentityKey(appliedCandidate) !== candidateKey) return;
      userActionRequiredCandidates.delete(candidateKey);

      patchSyncState((state) =>
        state.mediaActionRequired && userActionRequiredCandidates.size === 0
          ? { ...state, mediaActionRequired: false }
          : state,
      ).catch(console.error);

      logActivity(
        `media.apply tab=${sender.tab.id} frame=${sender.frameId ?? 0} drift=${message.payload.driftSeconds}s local=${getMediaActivityLabel(message.payload.after)}`,
        message.payload.driftSeconds <= 1 ? 'success' : 'warning',
        `media:applied:${sender.tab.id}`,
        MEDIA_ACTIVITY_THROTTLE_MS,
      );
      return;
    }

    if (message.type === 'bsync:media-apply-failed') {
      const applyKey = `${sender.tab.id}|${message.payload.commandId}`;
      const candidateKey = pendingMediaApplyCandidates.get(applyKey);
      if (!candidateKey) return;
      const timer = pendingMediaApplyTimers.get(applyKey);
      if (timer) clearTimeout(timer);
      pendingMediaApplyTimers.delete(applyKey);
      pendingMediaApplyCandidates.delete(applyKey);

      if (message.payload.code === 'user-action-required') {
        const selected = mediaRegistry.selectionSnapshot(sender.tab.id, Date.now()).candidate;
        if (!selected || makeMediaCandidateIdentityKey(selected) !== candidateKey) return;
        if (userActionRequiredCandidates.has(candidateKey)) return;
        userActionRequiredCandidates.add(candidateKey);
        patchSyncState((state) => ({ ...state, mediaActionRequired: true })).catch(console.error);
        logActivity(
          `media.apply.user-action-required tab=${sender.tab.id} frame=${sender.frameId ?? 0} reason=${message.payload.reason}`,
          'warning',
          `media:apply-user-action-required:${candidateKey ?? sender.tab.id}`,
        );
        return;
      }

      logActivity(
        `media.apply.blocked tab=${sender.tab.id} frame=${sender.frameId ?? 0} reason=${message.payload.reason}`,
        'error',
        `media:apply-failed:${sender.tab.id}`,
        MEDIA_ACTIVITY_THROTTLE_MS,
      );
      return;
    }

    if (message.type === 'bsync:focus-open') {
      return (async () => {
        const latestState = await syncStateItem.getValue();
        const { mode, targetPage, trustSite } = message.payload;
        const trustedDomains = trustSite
          ? addTrustedDomain(
              latestState.trustedDomains ?? [],
              targetPage.hostname || targetPage.url,
            )
          : (latestState.trustedDomains ?? []);

        await patchSyncState((state) => ({
          ...state,
          targetPage,
          overlayVisible: true,
          pendingFocusRequest: null,
          followHost: true,
          detachedReason: null,
          trustedDomains,
        }));
        queueGuestPageSync(targetPage);
        await openRoomTargetPage(
          targetPage,
          mode,
          trustedDomains,
          sender.tab?.id,
        );
      })().catch(console.error);
    }
  });

  setInterval(() => {
    const now = Date.now();
    mediaRegistry.pruneStale(now);
    let removedBlockedCandidate = false;
    for (const [key, entry] of candidateMedia) {
      if (now < entry.lastSeenAt + mediaRegistry.staleAfterMs) continue;
      candidateMedia.delete(key);
      removedBlockedCandidate = userActionRequiredCandidates.delete(key) || removedBlockedCandidate;
    }
    if (removedBlockedCandidate) syncMediaActionRequired();
    for (const snapshot of mediaRegistry.selectionSnapshots(now)) {
      notifySelectedLocalMedia(snapshot.tabId, snapshot);
      publishSelectedLocalMedia(snapshot);
    }
  }, MEDIA_REGISTRY_PRUNE_INTERVAL_MS);

  browser.tabs.onRemoved.addListener((tabId) => {
    mediaRegistry.removeTab(tabId, Date.now());
    clearCandidateState((candidate) => candidate.tabId === tabId);
    void (async () => {
      const tabStates = await tabStateItem.getValue();
      const removedTabState = tabStates[String(tabId)];
      const state = await syncStateItem.getValue();
      if (
        removedTabState?.url &&
        state.roomRole !== 'none' &&
        state.targetPage &&
        isRoomTargetUrl(state.targetPage, removedTabState.url)
      ) {
        await removeTabState(tabId);
        await leaveActiveRoom();
        return;
      }
      await handleTabRemoved(tabId);
    })().catch(console.error);
  });

  browser.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
    const selection = mediaRegistry.removeFrame(tabId, frameId, Date.now());
    clearCandidateState(
      (candidate) => candidate.tabId === tabId && candidate.frameId === frameId,
    );
    notifySelectedLocalMedia(tabId, selection);
    publishSelectedLocalMedia(selection);
  });

  browser.tabs.onActivated.addListener(({ tabId }) => {
    syncTabStateFromBrowser(tabId).catch(console.error);
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.title || changeInfo.status === 'complete') {
      syncTabStateFromBrowser(tabId).catch(console.error);
    }
  });
});
