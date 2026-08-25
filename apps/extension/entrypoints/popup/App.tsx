import {
    addActivity,
    addTrustedDomain,
    createRoomTargetPage,
    mergeRoomTargetPageForFocus,
    formatTimeAgo,
    getFocusRequestTitle,
    getRoomTargetLabel,
    getTabPageLabel,
    openRoomTargetPage,
    protocolSessionItem,
    resetExtensionData,
    resolveFocusRequestSource,
    statusLabel,
    syncStateItem,
    tabStateItem,
    type SyncState,
    type ProtocolSessionState,
    type ConnectionState,
    type RoomTargetPage,
    type TabSyncState,
} from '@/lib/sync-state';
import { useEffect, useState } from 'preact/hooks';
import { createInviteUrl, decodeInviteEnvelope } from '@bsync/invite';
import './App.css';
import { SettingsPanel } from './SettingsPanel';
import logoUrl from '/logo.svg';

const ALLOW_LOCAL_INVITES =
  import.meta.env.DEV || import.meta.env.WXT_ALLOW_LOCAL_ENDPOINTS === 'true';

function connectionLabel(status: ConnectionState): string {
  switch (status) {
    case 'resolving-invite':
      return 'Resolving invite';
    case 'connecting':
      return 'Connecting';
    case 'joining':
      return 'Joining';
    case 'synced':
      return 'Synced';
    case 'reconnecting':
      return 'Reconnecting';
    case 'degraded':
      return 'Degraded';
    case 'error':
      return 'Error';
    case 'idle':
    default:
      return 'Idle';
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

function getServerLabel(url: string | null | undefined): string {
  if (!url) return 'Not configured';

  try {
    return new URL(url).host;
  } catch {
    return url;
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
  const [joinError, setJoinError] = useState<string | null>(null);
  const [roomActionPending, setRoomActionPending] = useState(false);
  const [protocolSession, setProtocolSession] = useState<ProtocolSessionState | null>(null);
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
    protocolSessionItem.getValue().then(setProtocolSession).catch(console.error);
    return protocolSessionItem.watch(setProtocolSession);
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
    const current = await syncStateItem.getValue();
    const next = updater(current);
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
    if (roomActionPending) return;
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

    let targetPage: RoomTargetPage;
    try {
      targetPage = createRoomTargetPage(currentTabState);
    } catch (error) {
      await commit(
        (current) => ({ ...current, status: 'error' }),
        error instanceof Error ? error.message : 'Open an HTTP(S) page before creating a room',
        'error',
      );
      return;
    }
    setRoomActionPending(true);
    try {
      await browser.runtime.sendMessage({
        type: 'bsync:room-create',
        payload: { targetPage },
      });
    } finally {
      setRoomActionPending(false);
    }
  };

  const joinRoom = async () => {
    if (roomActionPending) return;
    let invite;
    try {
      invite = decodeInviteEnvelope(joinCode, { allowLocal: ALLOW_LOCAL_INVITES });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invite is invalid';
      setJoinError(message);
      await commit(
        (current) => ({
          ...current,
          status: 'error',
        }),
        message,
        'error',
      );
      return;
    }

    setJoinError(null);
    setRoomActionPending(true);
    try {
      await browser.runtime.sendMessage({
        type: 'bsync:room-join',
        payload: {
          roomId: invite.roomId,
          inviteToken: invite.inviteToken,
          serverUrl: invite.serverUrl,
        },
      });
    } finally {
      setRoomActionPending(false);
    }
  };

  const leaveRoom = async () => {
    await browser.runtime.sendMessage({ type: 'bsync:room-leave' });
  };

  const toggleExtension = async () => {
    if (state?.enabled) {
      if (isInRoom) await browser.runtime.sendMessage({ type: 'bsync:room-leave' });
      const current = await syncStateItem.getValue();
      await syncStateItem.setValue({ ...current, enabled: false, status: 'paused' });
      return;
    }

    await commit(
      (current) => ({ ...current, enabled: true, overlayVisible: true, status: 'idle' }),
      'Extension enabled',
      'success',
    );
  };

  if (!state) {
    return <main className='popup-shell is-loading'>Loading</main>;
  }

  const activeTabState = activeBrowserTab?.id == null ? null : getActiveTabState();
  const roomRole = state.roomRole ?? 'none';
  const isInRoom = roomRole !== 'none' || state.transportEnabled;
  const isDetached = roomRole === 'guest' && !state.followHost;
  const connectionUnhealthy =
    state.connectionState === 'connecting' ||
    state.connectionState === 'joining' ||
    state.connectionState === 'reconnecting' ||
    state.connectionState === 'degraded' ||
    state.connectionState === 'error';
  const healthyPaused = state.status === 'paused' && state.transportStatus === 'online';
  const syncPresentation = isDetached
    ? { label: 'Desynced', tone: 'error' }
    : connectionUnhealthy
      ? {
          label: connectionLabel(state.connectionState),
          tone: state.connectionState === 'error' ? 'error' : 'connecting',
        }
      : healthyPaused
      ? { label: 'Synced | Paused', tone: 'synced' }
      : { label: statusLabel(state.status), tone: state.status };
  const roomCredential =
    protocolSession?.roomId &&
    protocolSession.inviteToken &&
    protocolSession.inviteExpiresAt &&
    protocolSession.serverUrl
      ? (() => {
          try {
            const publicWebOrigin =
              import.meta.env.WXT_PUBLIC_WEB_ORIGIN ||
              (ALLOW_LOCAL_INVITES ? 'http://localhost:4175' : '');
            if (!publicWebOrigin) return null;
            return createInviteUrl(
              publicWebOrigin,
              {
                v: 2,
                serverUrl: protocolSession.serverUrl,
                roomId: protocolSession.roomId,
                inviteToken: protocolSession.inviteToken,
                expiresAt: protocolSession.inviteExpiresAt,
              },
              { allowLocal: ALLOW_LOCAL_INVITES },
            );
          } catch {
            return null;
          }
        })()
      : null;
  const share = (navigator as Navigator & {
    share?: (data: ShareData) => Promise<void>;
  }).share;

  const copyInvite = async () => {
    if (!roomCredential) return;
    try {
      await navigator.clipboard.writeText(roomCredential);
      await commit((current) => current, 'Invite copied', 'success');
    } catch {
      await commit((current) => current, 'Could not copy invite', 'error');
    }
  };

  const shareInvite = async () => {
    if (!roomCredential || typeof share !== 'function') return;
    try {
      await share.call(navigator, { title: 'Join my BSync room', url: roomCredential });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      await commit((current) => current, 'Could not share invite', 'error');
    }
  };

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

    let targetPage: RoomTargetPage;
    try {
      targetPage = mergeRoomTargetPageForFocus(
        state?.targetPage ?? null,
        createRoomTargetPage(currentTabState),
        currentTabState.url,
      );
    } catch (error) {
      await commit(
        (current) => ({ ...current, status: 'error' }),
        error instanceof Error ? error.message : 'Open an HTTP(S) page before focusing the room',
        'error',
      );
      return;
    }

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
        ? `Opening room page and trusted ${targetPage.hostname || 'site'}`
        : 'Opening room page',
      'success',
    );
    await openRoomTargetPage(targetPage, mode, trustedDomains);
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
            <h1 className='bsync-wordmark'>BSync</h1>
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
          onClick={toggleExtension}
          aria-label={state.enabled ? 'Disable BSync' : 'Enable BSync'}
        >
          {state.enabled ? 'On' : 'Off'}
        </button>
        </div>
      </section>

      {isInRoom ? (
        <section className='current-room'>
          <span>{roomRole === 'host' ? 'Hosting room' : roomRole === 'guest' ? 'Joined room' : 'Connecting'}</span>
          <strong>{state.roomCode === '000000' ? 'Awaiting server' : state.roomCode}</strong>
          {roomRole === 'host' && roomCredential ? (
            <div className='button-row'>
              <button type='button' className='primary' onClick={copyInvite}>Copy invite</button>
              {typeof share === 'function' ? <button type='button' onClick={shareInvite}>Share</button> : null}
            </div>
          ) : null}
          {roomRole === 'host' && protocolSession?.roomId && !roomCredential ? (
            <p className='invite-error' role='alert'>
              Invite unavailable: public web origin or room credentials are not configured.
            </p>
          ) : null}
          <div className='current-room-status'>
            <span className={`status-pill status-pill--${syncPresentation.tone}`}>
              {syncPresentation.label}
            </span>
            <span className={`transport-pill transport-pill--${state.transportStatus}`}>
              Connection: {connectionLabel(state.connectionState)}
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
              maxLength={80}
              onChange={(event) =>
                commit((current) => ({
                  ...current,
                  displayName: event.currentTarget.value.slice(0, 80),
                }))
              }
            />
          </label>

          <div className='room-choice'>
            <div>
              <span>Create room</span>
              <small>Uses the active tab as the shared page.</small>
            </div>
            <button type='button' className='primary' onClick={hostRoom} disabled={roomActionPending}>
              {roomActionPending ? 'Creating' : 'Create'}
            </button>
          </div>

          <div className='join-box'>
            <label>
               <span>Join from invite</span>
               <input
                id='join-invite'
                placeholder='Paste BSync invite URL'
                maxLength={4096}
                value={joinCode}
                aria-invalid={Boolean(joinError)}
                aria-describedby={joinError ? 'join-invite-error' : undefined}
                onChange={(event) => {
                  setJoinCode(event.currentTarget.value.trim());
                  setJoinError(null);
                }}
              />
            </label>
            <button type='button' onClick={joinRoom} disabled={roomActionPending}>
              {roomActionPending ? 'Joining' : 'Join'}
            </button>
            {joinError ? (
              <p id='join-invite-error' className='invite-error' role='alert'>
                {joinError}
              </p>
            ) : null}
          </div>
        </section>
      )}

      <section className='system-summary' aria-label='Connection summary'>
        <div>
          <span>Connection</span>
          <strong>{connectionLabel(state.connectionState)}</strong>
        </div>
        <div>
          <span>Role</span>
          <strong>{roomRole === 'none' ? 'Idle' : roomRole}</strong>
        </div>
        <div>
          <span>Server</span>
          <strong title={protocolSession?.serverUrl ?? state.serverUrl}>
            {getServerLabel(protocolSession?.serverUrl ?? state.serverUrl)}
          </strong>
        </div>
        <div>
          <span>Media</span>
          <strong>{state.roomMedia ? (state.roomMedia.paused ? 'Paused' : 'Playing') : 'None'}</strong>
        </div>
      </section>

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
