import {
  addActivity,
  isBsyncRuntimeMessage,
  isBsyncWsServerMessage,
  isRoomTargetUrl,
  normalizeSyncUrl,
  statusLabel,
  syncStateItem,
  tabStateItem,
  type BsyncWsClientMessage,
  type BsyncWsServerMessage,
  type ContentPageSnapshot,
  type MediaSyncState,
  type RoomTargetPage,
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
    [tabId]: {
      tabId,
      ...snapshot,
      updatedAt: Date.now(),
    },
  });
}

async function removeTabState(tabId: number) {
  const tabStates = await tabStateItem.getValue();
  if (!(tabId in tabStates)) return;

  const next = { ...tabStates };
  delete next[tabId];
  await tabStateItem.setValue(next);
}

function getMediaProgressPercent(media: MediaSyncState): number {
  if (!media.duration || media.duration <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((media.currentTime / media.duration) * 100)));
}

const UNSTABLE_LATENCY_MS = 2500;
const CONNECT_TIMEOUT_MS = 8000;

export default defineBackground(() => {
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
  let lastEnsuredTargetUrl = '';

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
    const current = await syncStateItem.getValue();
    const next = updater(current);
    await syncStateItem.setValue(next);
    return next;
  };

  const ensureTargetPageTab = async (targetPage: RoomTargetPage) => {
    const normalizedTargetUrl = normalizeSyncUrl(targetPage.url);
    if (!normalizedTargetUrl || normalizedTargetUrl === lastEnsuredTargetUrl) return;

    const tabs = await browser.tabs.query({});
    const existingTab = tabs.find((tab) => {
      if (!tab.url) return false;
      return normalizeSyncUrl(tab.url) === normalizedTargetUrl;
    });

    lastEnsuredTargetUrl = normalizedTargetUrl;

    if (existingTab?.id != null) {
      await browser.tabs.update(existingTab.id, { active: true });
      await patchSyncState((state) =>
        addActivity(
          state,
          `Room page tab activated: ${targetPage.hostname || targetPage.title}`,
          'info',
        ),
      );
      return;
    }

    await browser.tabs.create({
      url: targetPage.url,
      active: true,
    });

    await patchSyncState((state) =>
      addActivity(
        state,
        `Room page opened: ${targetPage.hostname || targetPage.title}`,
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
    [state.roomCode, state.clientId, state.targetPage?.normalizedUrl ?? 'none'].join('|');

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
      type: 'room:update',
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
    send({
      type: 'media:update',
      roomCode: state.roomCode,
      clientId: state.clientId,
      media,
      sentAt: Date.now(),
    });
  };

  const requestHostMediaState = (state: SyncState) => {
    if (state.roomRole !== 'guest' || !state.followHost) return;

    send({
      type: 'media:request',
      roomCode: state.roomCode,
      clientId: state.clientId,
      sentAt: Date.now(),
    });
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
    reconnectTimer = null;
    pingTimer = null;
    connectTimeoutTimer = null;
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
      case 'joined':
        if (message.targetPage) {
          await ensureTargetPageTab(message.targetPage);
        }

        await patchSyncState((state) =>
          addActivity(
            {
              ...state,
              peerCount: message.peerCount,
              targetPage: state.targetPage ?? message.targetPage,
              followHost: state.roomRole === 'guest' ? state.followHost : true,
            },
            `Connected to ${message.roomCode}`,
            'success',
          ),
        );
        break;
      case 'presence':
        await patchSyncState((state) => ({
          ...state,
          peerCount: message.peerCount,
        }));
        break;
      case 'room:update':
        await ensureTargetPageTab(message.targetPage);

        await patchSyncState((state) =>
          addActivity(
            {
              ...state,
              targetPage: message.targetPage,
              overlayVisible: true,
            },
            `Room page received: ${message.targetPage.hostname || message.targetPage.title}`,
            'success',
          ),
        );
        break;
      case 'media:update':
        if (activeState.roomRole === 'guest' && !activeState.followHost) return;

        await applyRemoteMediaState(message.media);
        await patchSyncState((state) => ({
          ...state,
          status: message.media.paused ? 'paused' : 'synced',
          progressPercent: getMediaProgressPercent(message.media),
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
    if (!latestState.targetPage) return;

    const tabs = await browser.tabs.query({});
    const targetTabs = tabs.filter((tab) => {
      if (!tab.url) return false;
      return isRoomTargetUrl(latestState.targetPage, tab.url);
    });

    await Promise.all(
      targetTabs.map((tab) => {
        if (tab.id == null) return Promise.resolve();
        return browser.tabs
          .sendMessage(tab.id, {
            type: 'bsync:media-apply',
            payload: media,
          })
          .catch(() => undefined);
      }),
    );
  };

  const handleLocalMediaState = async (tabId: number, media: MediaSyncState) => {
    const latestState = await syncStateItem.getValue();
    activeState = latestState;

    if (!latestState.targetPage || !isRoomTargetUrl(latestState.targetPage, media.url)) return;
    if (latestState.roomRole !== 'host') return;

    const nextStatus = media.paused ? 'paused' : 'synced';
    await patchSyncState((state) => ({
      ...state,
      status: nextStatus,
      progressPercent: getMediaProgressPercent(media),
      lastSyncedAt: Date.now(),
    }));

    if (latestState.transportEnabled && latestState.transportStatus === 'online') {
      publishMediaState(latestState, media);
    }
  };

  const detachFromHost = async (reason: string, media: MediaSyncState) => {
    const latestState = await syncStateItem.getValue();
    activeState = latestState;

    if (
      latestState.roomRole !== 'guest' ||
      !latestState.followHost ||
      !latestState.targetPage ||
      !isRoomTargetUrl(latestState.targetPage, media.url)
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
        },
        'Detached from host playback',
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

    if (!state.transportEnabled || !state.enabled) {
      closeSocket();
      if (
        state.transportStatus !== 'offline' ||
        state.connectedAt !== null ||
        state.peerCount !== 1
      ) {
        setTransportOffline().catch(console.error);
      }
      return;
    }

    connect(state);
    publishCurrentState(state);
    if (
      state.roomRole === 'guest' &&
      state.followHost &&
      (!previousState ||
        !previousState.followHost ||
        previousState.roomCode !== state.roomCode ||
        previousState.clientId !== state.clientId)
    ) {
      requestHostMediaState(state);
    }
  };

  refreshBadge().catch(console.error);

  syncStateItem.getValue().then(reconcileTransport).catch(console.error);

  syncStateItem.watch((state) => {
    refreshBadge().catch(console.error);
    reconcileTransport(state);
  });

  browser.runtime.onMessage.addListener((message, sender) => {
    if (!isBsyncRuntimeMessage(message) || sender.tab?.id == null) return;

    if (message.type === 'bsync:tab-page') {
      updateTabState(sender.tab.id, message.payload).catch(console.error);
      return;
    }

    if (message.type === 'bsync:media-state') {
      handleLocalMediaState(sender.tab.id, message.payload).catch(console.error);
      return;
    }

    if (message.type === 'bsync:media-detach') {
      detachFromHost(message.payload.reason, message.payload.media).catch(console.error);
    }
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    removeTabState(tabId).catch(console.error);
  });
});
