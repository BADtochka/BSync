import {
    addActivity,
    addTrustedDomain,
    createRoomTargetPage,
    mergeRoomTargetPageForFocus,
    formatTimeAgo,
    generateRoomCode,
    getFocusRequestTitle,
    getRoomTargetLabel,
    getTabPageLabel,
    leaveRoomState,
    normalizeRoomCode,
    openRoomTargetPage,
    resetExtensionData,
    resolveFocusRequestSource,
    resolveInRoomSyncStatus,
    statusLabel,
    syncStateItem,
    tabStateItem,
    type SyncState,
    type TabSyncState,
    type TransportStatus,
} from '@/lib/sync-state';
import { useEffect, useState } from 'preact/hooks';
import './App.css';
import { SettingsPanel } from './SettingsPanel';
import logoUrl from '/logo.svg';

function transportLabel(status: TransportStatus): string {
  switch (status) {
    case 'connecting':
      return 'Connecting';
    case 'online':
      return 'Online';
    case 'error':
      return 'Error';
    case 'offline':
    default:
      return 'Offline';
  }
}

type ActiveBrowserTab = {
  id?: number;
  title?: string;
  url?: string;
};

function getHostname(url: string | undefined): string {
  if (!url) return '';

  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function getFallbackTabState(tab: ActiveBrowserTab | null): TabSyncState | null {
  if (tab?.id == null) return null;

  return {
    tabId: tab.id,
    title: tab.title || getHostname(tab.url) || 'Active tab',
    url: tab.url || '',
    hostname: getHostname(tab.url),
    documentState: 'complete',
    visible: true,
    updatedAt: Date.now(),
  };
}

function App() {
  const [state, setState] = useState<SyncState | null>(null);
  const [tabStates, setTabStates] = useState<Record<string, TabSyncState>>({});
  const [activeBrowserTab, setActiveBrowserTab] = useState<ActiveBrowserTab | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [popupView, setPopupView] = useState<'main' | 'settings'>('main');
  const [trustFocusSite, setTrustFocusSite] = useState(false);

  useEffect(() => {
    setTrustFocusSite(false);
  }, [state?.pendingFocusRequest?.targetPage.url]);

  useEffect(() => {
    let mounted = true;

    syncStateItem.getValue().then((value) => {
      if (mounted) {
        setState(value);
      }
    });

    const unwatch = syncStateItem.watch((value) => {
      setState(value);
    });

    return () => {
      mounted = false;
      unwatch();
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const activeTabIdRef = { current: undefined as number | undefined };

    const refreshActiveTab = async () => {
      const [tab] = await browser.tabs.query({
        active: true,
        lastFocusedWindow: true,
      });

      if (!mounted) return;

      activeTabIdRef.current = tab?.id;
      setActiveBrowserTab(tab ? { id: tab.id, title: tab.title, url: tab.url } : null);
    };

    tabStateItem.getValue().then((value) => {
      if (mounted) setTabStates(value);
    });

    const unwatch = tabStateItem.watch((value) => {
      if (mounted) setTabStates(value);
    });

    const handleActivated = () => {
      refreshActiveTab().catch(console.error);
    };

    const handleUpdated = (
      tabId: number,
      changeInfo: Browser.tabs.OnUpdatedInfo,
    ) => {
      if (tabId !== activeTabIdRef.current) return;
      if (changeInfo.url || changeInfo.title || changeInfo.status === 'complete') {
        refreshActiveTab().catch(console.error);
      }
    };

    const handleWindowFocusChanged = (windowId: number) => {
      if (windowId === browser.windows.WINDOW_ID_NONE) return;
      refreshActiveTab().catch(console.error);
    };

    refreshActiveTab().catch(console.error);
    browser.tabs.onActivated.addListener(handleActivated);
    browser.tabs.onUpdated.addListener(handleUpdated);
    browser.windows.onFocusChanged.addListener(handleWindowFocusChanged);

    return () => {
      mounted = false;
      unwatch();
      browser.tabs.onActivated.removeListener(handleActivated);
      browser.tabs.onUpdated.removeListener(handleUpdated);
      browser.windows.onFocusChanged.removeListener(handleWindowFocusChanged);
    };
  }, []);

  const commit = async (
    updater: (current: SyncState) => SyncState,
    label?: string,
    tone: Parameters<typeof addActivity>[2] = 'info',
  ) => {
    if (!state) return;
    const next = updater(state);
    await syncStateItem.setValue(label ? addActivity(next, label, tone) : next);
  };

  const resetAllExtensionData = async () => {
    const nextState = await resetExtensionData();
    setState(nextState);
    setTabStates({});
    setJoinCode('');
    setTrustFocusSite(false);
  };

  const getActiveTabState = () => {
    if (activeBrowserTab?.id == null) return null;

    const fallback = getFallbackTabState(activeBrowserTab);
    const tracked = tabStates[String(activeBrowserTab.id)];
    if (!fallback) return tracked ?? null;
    if (!tracked) return fallback;

    return {
      ...tracked,
      title: fallback.title,
      url: fallback.url,
      hostname: fallback.hostname,
      updatedAt: Math.max(tracked.updatedAt, fallback.updatedAt),
    };
  };

  const hostRoom = async () => {
    const currentTabState = getActiveTabState();
    if (!currentTabState?.url) {
      await commit(
        (current) => ({
          ...current,
          status: 'error',
        }),
        'Open a page before creating a room',
        'error',
      );
      return;
    }

    const targetPage = createRoomTargetPage(currentTabState);
    const roomCode = generateRoomCode();
    const transportStatus: TransportStatus =
      state?.transportStatus === 'online' ? 'online' : 'connecting';
    const nextRoomState = {
      roomRole: 'host' as const,
      transportEnabled: true,
      transportStatus,
    };

    await commit(
      (current) => ({
        ...current,
        enabled: true,
        overlayVisible: true,
        ...nextRoomState,
        roomCode,
        followHost: true,
        detachedReason: null,
        status: resolveInRoomSyncStatus(
          { ...current, ...nextRoomState },
          transportStatus,
        ),
        targetPage,
        pendingFocusRequest: null,
        progressPercent: 0,
        roomMedia: null,
        lastSyncedAt: null,
      }),
      `Room ${roomCode} created`,
      'success',
    );
  };

  const joinRoom = async () => {
    const roomCode = normalizeRoomCode(joinCode);
    if (roomCode.length !== 6 || roomCode === '000000') {
      await commit(
        (current) => ({
          ...current,
          status: 'error',
        }),
        'Enter a valid 6 digit room code',
        'error',
      );
      return;
    }

    const transportStatus: TransportStatus =
      state?.transportStatus === 'online' ? 'online' : 'connecting';
    const nextRoomState = {
      roomRole: 'guest' as const,
      transportEnabled: true,
      transportStatus,
    };

    await commit(
      (current) => ({
        ...current,
        enabled: true,
        overlayVisible: true,
        ...nextRoomState,
        roomCode,
        followHost: true,
        detachedReason: null,
        targetPage: null,
        pendingFocusRequest: null,
        roomMedia: null,
        status: resolveInRoomSyncStatus(
          { ...current, ...nextRoomState },
          transportStatus,
        ),
        peerCount: 1,
        lastTransportError: null,
      }),
      `Joining room ${roomCode}`,
      'info',
    );
  };

  const leaveRoom = async () => {
    await commit(
      leaveRoomState,
      'Left room',
      'warning',
    );
  };

  if (!state) {
    return <main className='popup-shell is-loading'>Loading</main>;
  }

  const activeTabState = activeBrowserTab?.id == null ? null : getActiveTabState();
  const roomRole = state.roomRole ?? 'none';
  const isInRoom = roomRole !== 'none';

  const followHost = async () => {
    await commit(
      (current) => ({
        ...current,
        followHost: true,
        detachedReason: null,
      }),
      'Following host playback',
      'success',
    );
  };

  const focusActiveTab = async () => {
    const currentTabState = getActiveTabState();
    if (!currentTabState?.url) {
      await commit(
        (current) => ({
          ...current,
          status: 'error',
        }),
        'Open a page before focusing the room',
        'error',
      );
      return;
    }

    const targetPage = mergeRoomTargetPageForFocus(
      state?.targetPage ?? null,
      createRoomTargetPage(currentTabState),
      currentTabState.url,
    );

    await commit(
      (current) => ({
        ...current,
        overlayVisible: true,
        targetPage,
        pendingFocusRequest: null,
        progressPercent: 0,
        roomMedia: null,
        lastSyncedAt: null,
      }),
      `Focused room on ${targetPage.hostname || targetPage.title}`,
      'success',
    );
  };

  const openPendingFocus = async (mode: 'current' | 'new') => {
    const focusRequest = state.pendingFocusRequest;
    if (!focusRequest) return;

    const { targetPage } = focusRequest;
    const trustedDomains = trustFocusSite
      ? addTrustedDomain(state.trustedDomains ?? [], targetPage.hostname || targetPage.url)
      : (state.trustedDomains ?? []);
    const resolvedMode = await openRoomTargetPage(
      targetPage,
      mode,
      trustedDomains,
    );

    await commit(
      (current) => ({
        ...current,
        targetPage,
        pendingFocusRequest: null,
        followHost: true,
        detachedReason: null,
        trustedDomains: trustFocusSite
          ? addTrustedDomain(current.trustedDomains ?? [], targetPage.hostname || targetPage.url)
          : current.trustedDomains,
      }),
      trustFocusSite
        ? `Focused room page ${resolvedMode === 'new' ? 'in new tab' : 'in current tab'} and trusted ${targetPage.hostname || 'site'}`
        : `Focused room page ${resolvedMode === 'new' ? 'in new tab' : 'in current tab'}`,
      'success',
    );
    setTrustFocusSite(false);
  };

  if (popupView === 'settings') {
    return (
      <main className='popup-shell'>
        <SettingsPanel
          state={state!}
          onBack={() => setPopupView('main')}
          onCommit={commit}
          onResetData={resetAllExtensionData}
        />
      </main>
    );
  }

  return (
    <main className='popup-shell'>
      <section className='hero'>
        <div className='brand'>
          <img src={logoUrl} alt='' className='brand-logo' />
          <div>
            <h1>BSync</h1>
          </div>
        </div>
        <div className='hero-actions'>
          <button
            type='button'
            className='settings-button'
            onClick={() => setPopupView('settings')}
            aria-label='Open settings'
          >
            Settings
          </button>
          <button
            type='button'
            className={state.enabled ? 'power is-on' : 'power'}
          onClick={() =>
            commit(
              (current) => ({
                ...(current.enabled ? leaveRoomState(current) : current),
                enabled: !current.enabled,
                overlayVisible: !current.enabled ? true : current.overlayVisible,
                status: !current.enabled ? 'idle' : 'paused',
              }),
              state.enabled
                ? isInRoom
                  ? 'Extension disabled and room left'
                  : 'Extension paused'
                : 'Extension enabled',
              state.enabled ? 'warning' : 'success',
            )
          }
          aria-label={state.enabled ? 'Disable BSync' : 'Enable BSync'}
        >
          {state.enabled ? 'On' : 'Off'}
        </button>
        </div>
      </section>

      {isInRoom ? (
        <section className='current-room'>
          <span>{roomRole === 'host' ? 'Hosting room' : 'Joined room'}</span>
          <strong>{state.roomCode}</strong>
          <div className='current-room-status'>
            <span className={`status-pill status-pill--${state.status}`}>{statusLabel(state.status)}</span>
            <span className={`transport-pill transport-pill--${state.transportStatus}`}>
              {transportLabel(state.transportStatus)}
            </span>
          </div>
          {roomRole === 'guest' ? (
            <div className={state.followHost ? 'follow-state is-on' : 'follow-state'}>
              <span>{state.followHost ? 'Following host' : 'Detached'}</span>
              <small>{state.detachedReason ?? 'Local playback changes are ignored by the room.'}</small>
              {!state.followHost ? (
                <button type='button' className='primary' onClick={followHost}>
                  Follow host
                </button>
              ) : null}
            </div>
          ) : null}
          {roomRole === 'host' ? (
            <button type='button' className='primary' onClick={focusActiveTab}>
              Focus active tab
            </button>
          ) : null}
          {roomRole !== 'host' && state.pendingFocusRequest ? (
            <div className='focus-request'>
              <span>{getFocusRequestTitle(resolveFocusRequestSource(state.pendingFocusRequest))}</span>
              <strong>{state.pendingFocusRequest.targetPage.title}</strong>
              <small className='focus-request-url'>{state.pendingFocusRequest.targetPage.url}</small>
              <label className='field-row focus-request-trust trust-switch'>
                <span>Always trust this site</span>
                <span className='trust-switch-control'>
                  <input
                    type='checkbox'
                    checked={trustFocusSite}
                    onChange={(event) => setTrustFocusSite(event.currentTarget.checked)}
                  />
                  <span className='trust-switch-track' aria-hidden='true' />
                </span>
              </label>
              <div className='button-row'>
                <button type='button' className='primary' onClick={() => openPendingFocus('current')}>
                  In current tab
                </button>
                <button type='button' onClick={() => openPendingFocus('new')}>
                  In new tab
                </button>
              </div>
            </div>
          ) : null}
          <button type='button' className='danger' onClick={leaveRoom}>
            Leave room
          </button>
        </section>
      ) : (
        <section className='session-panel'>
          <label>
            <span>Name</span>
            <input
              value={state.displayName}
              onChange={(event) =>
                commit((current) => ({
                  ...current,
                  displayName: event.currentTarget.value,
                }))
              }
            />
          </label>

          <label>
            <span>Server</span>
            <input
              value={state.serverUrl}
              onChange={(event) =>
                commit((current) => ({
                  ...current,
                  serverUrl: event.currentTarget.value.trim(),
                }))
              }
            />
          </label>

          <div className='room-choice'>
            <div>
              <span>Create room</span>
              <small>Uses the active tab as the shared page.</small>
            </div>
            <button type='button' className='primary' onClick={hostRoom}>
              Create
            </button>
          </div>

          <div className='join-box'>
            <label>
              <span>Join room</span>
              <input
                inputMode='numeric'
                maxLength={6}
                placeholder='6 digit code'
                value={joinCode}
                onChange={(event) => setJoinCode(event.currentTarget.value.replace(/\D/g, '').slice(0, 6))}
              />
            </label>
            <button type='button' onClick={joinRoom}>
              Join
            </button>
          </div>
        </section>
      )}

      <section className='metrics'>
        <div>
          <span>Peers</span>
          <strong>{state.peerCount}</strong>
        </div>
        <div>
          <span>Latency</span>
          <strong>{state.latencyMs}ms</strong>
        </div>
        <div>
          <span>Last sync</span>
          <strong>{formatTimeAgo(state.lastSyncedAt)}</strong>
        </div>
      </section>

      <section className='active-tab'>
        <span>Active tab</span>
        <strong>{getTabPageLabel(activeTabState)}</strong>
        <small>
          {activeTabState
            ? `${activeTabState.visible ? 'visible' : 'background'} · ${formatTimeAgo(activeTabState.updatedAt)}`
            : 'Waiting for content script'}
        </small>
      </section>

      <section className='room-target'>
        <span>Room page</span>
        <strong>{getRoomTargetLabel(state.targetPage)}</strong>
        <small>
          {state.targetPage
            ? `created ${formatTimeAgo(state.targetPage.createdAt)}`
            : 'Create a room from the page you want to sync'}
        </small>
      </section>

      {state.lastTransportError ? (
        <section className='transport-error'>
          <span>Transport</span>
          <strong>{state.lastTransportError}</strong>
        </section>
      ) : null}
    </main>
  );
}

export default App;
