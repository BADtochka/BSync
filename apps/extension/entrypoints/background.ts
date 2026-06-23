import {
  addActivity,
  addTrustedDomain,
  createGuestTargetPageState,
  createRoomTargetPage,
  createTabSnapshotFromBrowserTab,
  ensureBrowserSessionScopedRoomState,
  isBsyncRuntimeMessage,
  isBsyncWsServerMessage,
  isRoomTargetUrl,
  leaveRoomState,
  normalizeSyncUrl,
  openRoomTargetPage,
  resetRoomSessionForBrowserStartup,
  resolveInRoomSyncStatus,
  resolveSyncState,
  resolveTrustedOpenTabId,
  statusLabel,
  syncStateItem,
  tabStateItem,
  type BsyncWsClientMessage,
  type BsyncWsServerMessage,
  type ContentPageSnapshot,
  type MediaSyncState,
  type RoomTargetPage,
  type SyncActivity,
  type GuestTargetPageResolution,
  type BsyncStateSyncMessage,
  type SyncState,
} from '@/lib/sync-state';

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
const CONNECT_TIMEOUT_MS = 8000;
const MEDIA_ACTIVITY_THROTTLE_MS = 5000;
const MEDIA_APPLY_ACK_TIMEOUT_MS = 4000;

export default defineBackground(() => {
  browser.runtime.onStartup.addListener(() => {
    resetRoomSessionForBrowserStartup().catch(console.error);
  });

  ensureBrowserSessionScopedRoomState().catch(console.error);

  let socket: WebSocket | null = null;
  let socketUrl = '';
  let activeState: SyncState | null = null;
  const manuallyClosingSockets = new WeakSet<WebSocket>();
  const timedOutSockets = new WeakSet<WebSocket>();
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let connectTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let lastJoinKey = '';
  let lastRoomTargetKey = '';
  let lastMediaKey = '';
  let lastTransportReconcileKey = '';
  let statePatchQueue: Promise<unknown> = Promise.resolve();
  const activityLogAt = new Map<string, number>();
  const pendingMediaApplyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingGuestSyncUrls = new Set<string>();
  let previousWatchState: SyncState | null = null;
  let stateBroadcastTimer: ReturnType<typeof setTimeout> | null = null;

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

  const openFocusTarget = async (mode: 'current' | 'new') => {
    const latestState = await syncStateItem.getValue();
    const focusRequest = latestState.pendingFocusRequest;
    if (!focusRequest) return;

    const { targetPage } = focusRequest;
    const resolvedMode = await openRoomTargetPage(
      targetPage,
      mode,
      latestState.trustedDomains ?? [],
    );

    await patchSyncState((state) =>
      addActivity(
        {
          ...state,
          targetPage,
          pendingFocusRequest: null,
        },
        `Focused room page ${resolvedMode === 'new' ? 'in new tab' : 'in current tab'}`,
        'success',
      ),
    );
  };

  const send = (message: BsyncWsClientMessage) => {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  };

  const makeJoinKey = (state: SyncState) =>
    [state.serverUrl, state.roomCode, state.clientId, state.displayName].join('|');

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
      state.serverUrl,
      state.roomCode,
      state.clientId,
      state.displayName,
      state.roomRole,
      state.targetPage?.normalizedUrl ?? 'none',
      state.targetPage?.createdAt ?? 0,
    ].join('|');

  const makeMediaKey = (media: MediaSyncState) =>
    [
      media.mediaId,
      media.paused,
      Math.round(media.currentTime * 2) / 2,
      media.playbackRate,
      media.duration ?? 'live',
    ].join('|');

  const publishJoin = (state: SyncState) => {
    const joinKey = makeJoinKey(state);
    if (joinKey === lastJoinKey) return;

    lastJoinKey = joinKey;
    send({
      type: 'join',
      roomCode: state.roomCode,
      clientId: state.clientId,
      roomRole: state.roomRole,
      displayName: state.displayName,
      targetPage: state.roomRole === 'host' ? state.targetPage : null,
      sentAt: Date.now(),
    });
  };

  const publishRoomTarget = (state: SyncState) => {
    const targetKey = makeRoomTargetKey(state);
    if (targetKey === lastRoomTargetKey || !state.targetPage || state.roomRole !== 'host') return;

    lastRoomTargetKey = targetKey;
    send({
      type: 'room:focus',
      roomCode: state.roomCode,
      clientId: state.clientId,
      targetPage: state.targetPage,
      sentAt: Date.now(),
    });
  };

  const publishMediaState = (state: SyncState, media: MediaSyncState) => {
    const mediaKey = makeMediaKey(media);
    if (mediaKey === lastMediaKey) return;

    lastMediaKey = mediaKey;
    const sent = send({
      type: 'media:update',
      roomCode: state.roomCode,
      clientId: state.clientId,
      media,
      sentAt: Date.now(),
    });

    logActivity(
      sent
        ? `Media host published: ${getMediaActivityLabel(media)}`
        : 'Media host publish skipped: socket offline',
      sent ? 'info' : 'warning',
      'media:host-publish',
      MEDIA_ACTIVITY_THROTTLE_MS,
    );
  };

  const requestHostMediaState = (state: SyncState) => {
    if (state.roomRole !== 'guest' || !state.followHost) return;

    const sent = send({
      type: 'media:request',
      roomCode: state.roomCode,
      clientId: state.clientId,
      sentAt: Date.now(),
    });

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
    if (socket?.readyState !== WebSocket.OPEN) return;
    publishJoin(state);
    publishRoomTarget(state);
  };

  const clearTimers = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (pingTimer) clearInterval(pingTimer);
    if (connectTimeoutTimer) clearTimeout(connectTimeoutTimer);
    for (const timer of pendingMediaApplyTimers.values()) {
      clearTimeout(timer);
    }
    reconnectTimer = null;
    pingTimer = null;
    connectTimeoutTimer = null;
    pendingMediaApplyTimers.clear();
  };

  const closeSocket = () => {
    clearTimers();
    if (socket) {
      manuallyClosingSockets.add(socket);
      socket.close();
    }
    socket = null;
    socketUrl = '';
    lastJoinKey = '';
    lastRoomTargetKey = '';
    lastMediaKey = '';
    lastTransportReconcileKey = '';
  };

  const setTransportOffline = async () => {
    await patchSyncState((state) => ({
      ...state,
      transportStatus: 'offline',
      connectedAt: null,
      peerCount: 1,
    }));
  };

  const scheduleReconnect = () => {
    if (!activeState?.transportEnabled || reconnectTimer) return;

    const delayMs = Math.min(12000, 1000 * 2 ** reconnectAttempt);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (activeState) connect(activeState);
    }, delayMs);
  };

  const handleServerMessage = async (message: BsyncWsServerMessage) => {
    if (!activeState || message.type === 'pong') {
      if (message.type === 'pong') {
        const latencyMs = Math.max(1, Date.now() - message.sentAt);
        await patchSyncState((state) => ({
          ...state,
          latencyMs,
          ...(state.roomRole === 'guest' && state.followHost && latencyMs > UNSTABLE_LATENCY_MS
            ? {
                followHost: false,
                detachedReason: `Unstable connection (${latencyMs}ms)`,
              }
            : {}),
        }));
      }
      return;
    }

    if ('clientId' in message && message.clientId === activeState.clientId) return;

    switch (message.type) {
      case 'joined': {
        const [activeTab] = await browser.tabs.query({
          active: true,
          currentWindow: true,
        });
        const activeTabUrl = activeTab?.url;
        const joinedBaseState = await syncStateItem.getValue();
        const joinedTrustedDomains = joinedBaseState.trustedDomains ?? [];
        const joinedPageState =
          message.targetPage != null
            ? createGuestTargetPageState(
                joinedBaseState,
                message.targetPage,
                'join',
                activeTabUrl,
                joinedTrustedDomains,
              )
            : {
                targetPage: joinedBaseState.targetPage ?? message.targetPage,
                pendingFocusRequest: joinedBaseState.pendingFocusRequest,
                openInCurrentTab: false,
              };

        await patchSyncState((state) =>
          addActivity(
            {
              ...state,
              peerCount: message.peerCount,
              targetPage: joinedPageState.targetPage,
              pendingFocusRequest: joinedPageState.pendingFocusRequest,
              followHost:
                state.roomRole === 'guest'
                  ? joinedPageState.openInCurrentTab
                    ? true
                    : state.followHost
                  : true,
              detachedReason: joinedPageState.openInCurrentTab ? null : state.detachedReason,
              status: resolveInRoomSyncStatus(state, state.transportStatus),
            },
            `Connected to ${message.roomCode}`,
            'success',
          ),
        );

        await applyGuestTargetPageResolution(
          joinedPageState,
          activeTab?.id,
          joinedTrustedDomains,
        );

        const joinedState = await syncStateItem.getValue();
        if (
          joinedState.roomRole === 'guest' &&
          joinedState.targetPage &&
          !joinedState.pendingFocusRequest &&
          activeTabUrl &&
          isRoomTargetUrl(joinedState.targetPage, activeTabUrl)
        ) {
          await syncGuestWithHost(activeTabUrl);
        }
        break;
      }
      case 'presence':
        await patchSyncState((state) => ({
          ...state,
          peerCount: message.peerCount,
        }));
        break;
      case 'room:closed':
        await patchSyncState((state) =>
          addActivity(
            leaveRoomState(state),
            message.reason || 'Room closed',
            'warning',
          ),
        );
        break;
      case 'room:update': {
        const [activeTab] = await browser.tabs.query({
          active: true,
          currentWindow: true,
        });
        const activeTabUrl = activeTab?.url;
        const updateBaseState = await syncStateItem.getValue();
        const updateTrustedDomains = updateBaseState.trustedDomains ?? [];
        const updatePageState = createGuestTargetPageState(
          updateBaseState,
          message.targetPage,
          'focus',
          activeTabUrl,
          updateTrustedDomains,
        );

        await patchSyncState((state) =>
          addActivity(
            {
              ...state,
              targetPage: updatePageState.targetPage,
              pendingFocusRequest: updatePageState.pendingFocusRequest,
              ...(updatePageState.openInCurrentTab
                ? { followHost: true, detachedReason: null }
                : {}),
            },
            updatePageState.openInCurrentTab
              ? `Room page received in current tab: ${message.targetPage.hostname || message.targetPage.title}`
              : `Room page received: ${message.targetPage.hostname || message.targetPage.title}`,
            'success',
          ),
        );

        await applyGuestTargetPageResolution(
          updatePageState,
          activeTab?.id,
          updateTrustedDomains,
        );
        break;
      }
      case 'room:focus': {
        const [activeTab] = await browser.tabs.query({
          active: true,
          currentWindow: true,
        });
        const activeTabUrl = activeTab?.url;
        const focusBaseState = await syncStateItem.getValue();
        const focusTrustedDomains = focusBaseState.trustedDomains ?? [];

        if (focusBaseState.roomRole === 'host') {
          await patchSyncState((state) =>
            addActivity(
              state,
              `Host focused: ${message.targetPage.hostname || message.targetPage.title}`,
              'info',
            ),
          );
          break;
        }

        const focusPageState = createGuestTargetPageState(
          focusBaseState,
          message.targetPage,
          'focus',
          activeTabUrl,
          focusTrustedDomains,
        );

        await patchSyncState((state) =>
          addActivity(
            {
              ...state,
              targetPage: focusPageState.targetPage,
              pendingFocusRequest: focusPageState.pendingFocusRequest,
              ...(focusPageState.openInCurrentTab
                ? { followHost: true, detachedReason: null }
                : {}),
            },
            focusPageState.openInCurrentTab
              ? `Host focused in current tab: ${message.targetPage.hostname || message.targetPage.title}`
              : `Host focused: ${message.targetPage.hostname || message.targetPage.title}`,
            'info',
          ),
        );

        await applyGuestTargetPageResolution(
          focusPageState,
          activeTab?.id,
          focusTrustedDomains,
        );
        break;
      }
      case 'media:update':
        const shouldApplyMedia =
          activeState.roomRole !== 'guest' || activeState.followHost;

        logActivity(
          shouldApplyMedia
            ? `Media host received: ${getMediaActivityLabel(message.media)}`
            : `Media host received while detached: ${getMediaActivityLabel(message.media)}`,
          shouldApplyMedia ? 'info' : 'warning',
          shouldApplyMedia ? 'media:host-received' : 'media:host-received-detached',
          MEDIA_ACTIVITY_THROTTLE_MS,
        );

        if (shouldApplyMedia) {
          await applyRemoteMediaState(message.media);
        }
        await patchSyncState((state) => ({
          ...state,
          ...(shouldApplyMedia
            ? { status: message.media.paused ? 'paused' : 'synced' }
            : {}),
          progressPercent: getMediaProgressPercent(message.media),
          roomMedia: message.media,
          lastSyncedAt: Date.now(),
        }));
        break;
      case 'error':
        await patchSyncState((state) =>
          addActivity(
            {
              ...state,
              transportStatus: 'error',
              lastTransportError: message.message,
            },
            message.message,
            'error',
          ),
        );
        break;
    }
  };

  const applyRemoteMediaState = async (media: MediaSyncState) => {
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

    logActivity(
      `Media apply sent to ${targetTabs.length} tab${targetTabs.length === 1 ? '' : 's'}: ${getMediaActivityLabel(media)}`,
      'info',
      'media:apply-sent',
      MEDIA_ACTIVITY_THROTTLE_MS,
    );

    await Promise.all(
      targetTabs.map((tab) => {
        if (tab.id == null) return Promise.resolve();
        const applyKey = `${tab.id}|${makeMediaKey(media)}`;
        const existingTimer = pendingMediaApplyTimers.get(applyKey);
        if (existingTimer) clearTimeout(existingTimer);

        pendingMediaApplyTimers.set(
          applyKey,
          setTimeout(() => {
            pendingMediaApplyTimers.delete(applyKey);
            logActivity(
              `Media apply ack timeout: tab ${tab.id}`,
              'warning',
              `media:apply-timeout:${tab.id}`,
              MEDIA_ACTIVITY_THROTTLE_MS,
            );
          }, MEDIA_APPLY_ACK_TIMEOUT_MS),
        );

        return sendMessageToAllTabFrames(tab.id, {
          type: 'bsync:media-apply',
          payload: media,
        }).catch((error) => {
            const timer = pendingMediaApplyTimers.get(applyKey);
            if (timer) clearTimeout(timer);
            pendingMediaApplyTimers.delete(applyKey);
            logActivity(
              `Media apply failed to send: tab ${tab.id} (${error instanceof Error ? error.message : 'content script unavailable'})`,
              'error',
              `media:apply-send-failed:${tab.id}`,
              MEDIA_ACTIVITY_THROTTLE_MS,
            );
          });
      }),
    );
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
    tabUrl: string | undefined,
    media: MediaSyncState,
  ) => {
    const latestState = await syncStateItem.getValue();
    activeState = latestState;

    const pageUrl = tabUrl || media.url;
    if (latestState.roomRole !== 'host') return;

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

  function connect(state: SyncState) {
    if (!state.transportEnabled || !state.serverUrl) return;
    if (socket && socketUrl === state.serverUrl && socket.readyState <= WebSocket.OPEN) {
      publishCurrentState(state);
      return;
    }

    closeSocket();
    socketUrl = state.serverUrl;

    patchSyncState((current) => ({
      ...current,
      transportStatus: 'connecting',
      lastTransportError: null,
      status: resolveInRoomSyncStatus(current, 'connecting'),
    })).catch(console.error);

    try {
      socket = new WebSocket(state.serverUrl);
    } catch (error) {
      patchSyncState((current) =>
        addActivity(
          {
            ...current,
            transportStatus: 'error',
            lastTransportError: error instanceof Error ? error.message : 'WebSocket failed',
          },
          'WebSocket failed to start',
          'error',
        ),
      ).catch(console.error);
      scheduleReconnect();
      return;
    }

    const currentSocket = socket;
    if (!currentSocket) return;

    connectTimeoutTimer = setTimeout(() => {
      if (socket !== currentSocket || currentSocket.readyState !== WebSocket.CONNECTING) return;

      timedOutSockets.add(currentSocket);
      currentSocket.close();
    }, CONNECT_TIMEOUT_MS);

    currentSocket.addEventListener('open', () => {
      if (socket !== currentSocket) return;
      if (connectTimeoutTimer) clearTimeout(connectTimeoutTimer);
      connectTimeoutTimer = null;
      reconnectAttempt = 0;
      patchSyncState((current) =>
        addActivity(
          {
            ...current,
            transportStatus: 'online',
            connectedAt: Date.now(),
            lastTransportError: null,
            status: resolveInRoomSyncStatus(current, 'online'),
          },
          `Connected to ${state.serverUrl}`,
          'success',
        ),
      ).catch(console.error);

      if (activeState) {
        publishCurrentState(activeState);
        requestHostMediaState(activeState);
      }
      pingTimer = setInterval(() => {
        const latest = activeState;
        if (!latest) return;
        send({
          type: 'ping',
          roomCode: latest.roomCode,
          clientId: latest.clientId,
          sentAt: Date.now(),
        });
      }, 5000);
    });

    currentSocket.addEventListener('message', (event) => {
      if (socket !== currentSocket) return;
      try {
        const message = JSON.parse(String(event.data));
        if (isBsyncWsServerMessage(message)) {
          handleServerMessage(message).catch(console.error);
        }
      } catch (error) {
        console.error(error);
      }
    });

    currentSocket.addEventListener('error', () => {
      if (socket !== currentSocket) return;
      patchSyncState((current) => ({
        ...current,
        transportStatus: 'error',
        lastTransportError: 'WebSocket connection error',
      })).catch(console.error);
    });

    currentSocket.addEventListener('close', () => {
      if (socket !== currentSocket) return;
      clearTimers();
      socket = null;
      socketUrl = '';
      if (manuallyClosingSockets.has(currentSocket)) {
        setTransportOffline().catch(console.error);
        return;
      }

      patchSyncState((current) => ({
        ...current,
        transportStatus: 'error',
        connectedAt: null,
        lastTransportError: timedOutSockets.has(currentSocket)
          ? 'WebSocket connection timeout'
          : 'WebSocket disconnected',
        ...(current.roomRole === 'guest' && current.followHost
          ? {
              followHost: false,
              detachedReason: 'Connection lost',
            }
          : {}),
      })).catch(console.error);
      scheduleReconnect();
    });
  }

  const reconcileTransport = (state: SyncState) => {
    const previousState = activeState;
    activeState = state;
    const transportReconcileKey = makeTransportReconcileKey(state);

    if (!state.transportEnabled || !state.enabled) {
      if (socket) closeSocket();
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

    const shouldReconcileSocket =
      transportReconcileKey !== lastTransportReconcileKey ||
      !socket ||
      socketUrl !== state.serverUrl ||
      socket.readyState >= WebSocket.CLOSING;

    if (shouldReconcileSocket) {
      connect(state);
      publishCurrentState(state);
      lastTransportReconcileKey = transportReconcileKey;
    }

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

  refreshBadge().catch(console.error);

  syncStateItem.getValue().then((state) => {
    reconcileTransport(state);
    broadcastSyncState(state);
  }).catch(console.error);

  syncStateItem.watch((state) => {
    maybeQueueGuestSyncAfterFocus(previousWatchState, state);
    previousWatchState = state;
    refreshBadge().catch(console.error);
    reconcileTransport(state);
    broadcastSyncState(state);
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'bsync:get-state') {
      return syncStateItem.getValue().then((state) => ({
        type: 'bsync:state-sync',
        payload: resolveSyncState(state),
      } satisfies BsyncStateSyncMessage));
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

    if (message?.type === 'bsync:content-ready' && sender.tab?.id != null) {
      void syncStateItem.getValue().then((state) => {
        void sendMessageToAllTabFrames(sender.tab!.id!, {
          type: 'bsync:state-sync',
          payload: resolveSyncState(state),
        } satisfies BsyncStateSyncMessage);
      });
      return;
    }

    if (message?.type === 'bsync:frame-local-media' && sender.tab?.id != null) {
      void sendMessageToAllTabFrames(sender.tab.id, message);
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

    if (message.type === 'bsync:media-state') {
      handleLocalMediaState(sender.tab.id, sender.tab.url, message.payload).catch(console.error);
      return;
    }

    if (message.type === 'bsync:media-detach') {
      detachFromHost(message.payload.reason, sender.tab.url, message.payload.media).catch(console.error);
      return;
    }

    if (message.type === 'bsync:media-applied') {
      const applyKey = `${sender.tab.id}|${makeMediaKey(message.payload.requested)}`;
      const timer = pendingMediaApplyTimers.get(applyKey);
      if (timer) clearTimeout(timer);
      pendingMediaApplyTimers.delete(applyKey);

      logActivity(
        `Media applied: drift ${message.payload.driftSeconds}s, local ${getMediaActivityLabel(message.payload.after)}`,
        message.payload.driftSeconds <= 1 ? 'success' : 'warning',
        `media:applied:${sender.tab.id}`,
        MEDIA_ACTIVITY_THROTTLE_MS,
      );
      return;
    }

    if (message.type === 'bsync:media-apply-failed') {
      const applyKey = `${sender.tab.id}|${makeMediaKey(message.payload.requested)}`;
      const timer = pendingMediaApplyTimers.get(applyKey);
      if (timer) clearTimeout(timer);
      pendingMediaApplyTimers.delete(applyKey);

      logActivity(
        `Media apply failed: ${message.payload.reason}`,
        'error',
        `media:apply-failed:${sender.tab.id}`,
        MEDIA_ACTIVITY_THROTTLE_MS,
      );
      return;
    }

    if (message.type === 'bsync:focus-open') {
      void (async () => {
        const latestState = await syncStateItem.getValue();
        const { mode, targetPage, trustSite } = message.payload;
        const trustedDomains = trustSite
          ? addTrustedDomain(
              latestState.trustedDomains ?? [],
              targetPage.hostname || targetPage.url,
            )
          : (latestState.trustedDomains ?? []);

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

  browser.tabs.onRemoved.addListener((tabId) => {
    handleTabRemoved(tabId).catch(console.error);
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
