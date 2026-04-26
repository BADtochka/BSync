import {
  addActivity,
  createRoomTargetPage,
  formatTimeAgo,
  generateRoomCode,
  getRoomTargetLabel,
  getTabPageLabel,
  normalizeRoomCode,
  statusLabel,
  syncStateItem,
  tabStateItem,
  type OverlayPosition,
  type SyncState,
  type TabSyncState,
  type TransportStatus,
} from '@/lib/sync-state';
import './App.css';

const positions: Array<{ value: OverlayPosition; label: string }> = [
  { value: 'top-right', label: 'TR' },
  { value: 'top-left', label: 'TL' },
  { value: 'bottom-right', label: 'BR' },
  { value: 'bottom-left', label: 'BL' },
];

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

  useEffect(() => {
    let mounted = true;

    syncStateItem.getValue().then((value) => {
      if (mounted) setState(value);
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

    const refreshActiveTab = async () => {
      const [tab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });

      if (mounted) {
        setActiveBrowserTab(tab ? { id: tab.id, title: tab.title, url: tab.url } : null);
      }
    };

    tabStateItem.getValue().then((value) => {
      if (mounted) setTabStates(value);
    });

    const unwatch = tabStateItem.watch((value) => {
      setTabStates(value);
    });

    const handleActivated = () => {
      refreshActiveTab().catch(console.error);
    };

    const handleUpdated = (tabId: number) => {
      if (tabId === activeBrowserTab?.id) {
        refreshActiveTab().catch(console.error);
      }
    };

    refreshActiveTab().catch(console.error);
    browser.tabs.onActivated.addListener(handleActivated);
    browser.tabs.onUpdated.addListener(handleUpdated);

    return () => {
      mounted = false;
      unwatch();
      browser.tabs.onActivated.removeListener(handleActivated);
      browser.tabs.onUpdated.removeListener(handleUpdated);
    };
  }, [activeBrowserTab?.id]);

  const commit = async (
    updater: (current: SyncState) => SyncState,
    label?: string,
    tone: Parameters<typeof addActivity>[2] = 'info',
  ) => {
    if (!state) return;
    const next = updater(state);
    await syncStateItem.setValue(label ? addActivity(next, label, tone) : next);
  };

  const getActiveTabState = () => {
    if (activeBrowserTab?.id == null) return null;
    return tabStates[String(activeBrowserTab.id)] ?? getFallbackTabState(activeBrowserTab);
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

    await commit(
      (current) => ({
        ...current,
        enabled: true,
        overlayVisible: true,
        transportEnabled: true,
        transportStatus: current.transportStatus === 'online' ? 'online' : 'connecting',
        roomCode,
        roomRole: 'host',
        followHost: true,
        detachedReason: null,
        status: 'idle',
        targetPage,
        progressPercent: 0,
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

    await commit(
      (current) => ({
        ...current,
        enabled: true,
        overlayVisible: true,
        transportEnabled: true,
        transportStatus: current.transportStatus === 'online' ? 'online' : 'connecting',
        roomCode,
        roomRole: 'guest',
        followHost: true,
        detachedReason: null,
        targetPage: null,
        status: 'connecting',
        peerCount: 1,
        lastTransportError: null,
      }),
      `Joining room ${roomCode}`,
      'info',
    );
  };

  const leaveRoom = async () => {
    await commit(
      (current) => ({
        ...current,
        transportEnabled: false,
        transportStatus: 'offline',
        connectedAt: null,
        peerCount: 1,
        roomRole: 'none',
        followHost: true,
        detachedReason: null,
        roomCode: '000000',
        targetPage: null,
        status: 'idle',
        progressPercent: 0,
        lastSyncedAt: null,
        lastTransportError: null,
      }),
      'Left room',
      'warning',
    );
  };

  if (!state) {
    return <main className="popup-shell is-loading">Loading</main>;
  }

  const activeTabState =
    activeBrowserTab?.id == null ? null : getActiveTabState();
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

  return (
    <main className="popup-shell">
      <section className="hero">
        <div>
          <span className={`status-pill status-pill--${state.status}`}>
            {statusLabel(state.status)}
          </span>
          <span className={`transport-pill transport-pill--${state.transportStatus}`}>
            {transportLabel(state.transportStatus)}
          </span>
          <h1>BSync</h1>
        </div>
        <button
          type="button"
          className={state.enabled ? 'power is-on' : 'power'}
          onClick={() =>
            commit(
              (current) => ({
                ...current,
                enabled: !current.enabled,
                overlayVisible: !current.enabled ? true : current.overlayVisible,
                status: !current.enabled ? 'idle' : 'paused',
              }),
              state.enabled ? 'Extension paused' : 'Extension enabled',
              state.enabled ? 'warning' : 'success',
            )
          }
          aria-label={state.enabled ? 'Disable BSync' : 'Enable BSync'}
        >
          {state.enabled ? 'On' : 'Off'}
        </button>
      </section>

      {isInRoom ? (
        <section className="current-room">
          <span>{roomRole === 'host' ? 'Hosting room' : 'Joined room'}</span>
          <strong>{state.roomCode}</strong>
          <small>
            {transportLabel(state.transportStatus)} · {state.peerCount} peer
            {state.peerCount === 1 ? '' : 's'}
          </small>
          {roomRole === 'guest' ? (
            <div className={state.followHost ? 'follow-state is-on' : 'follow-state'}>
              <span>{state.followHost ? 'Following host' : 'Detached'}</span>
              <small>{state.detachedReason ?? 'Local playback changes are ignored by the room.'}</small>
              {!state.followHost ? (
                <button type="button" className="primary" onClick={followHost}>
                  Follow host
                </button>
              ) : null}
            </div>
          ) : null}
          <button type="button" className="danger" onClick={leaveRoom}>
            Leave room
          </button>
        </section>
      ) : (
        <section className="session-panel">
          <label>
            <span>Name</span>
            <input
              value={state.displayName}
              onChange={(event) =>
                commit((current) => ({
                  ...current,
                  displayName: event.target.value,
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
                  serverUrl: event.target.value.trim(),
                }))
              }
            />
          </label>

          <div className="room-choice">
            <div>
              <span>Create room</span>
              <small>Uses the active tab as the shared page.</small>
            </div>
            <button type="button" className="primary" onClick={hostRoom}>
              Create
            </button>
          </div>

          <div className="join-box">
            <label>
              <span>Join room</span>
              <input
                inputMode="numeric"
                maxLength={6}
                placeholder="6 digit code"
                value={joinCode}
                onChange={(event) => setJoinCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              />
            </label>
            <button type="button" onClick={joinRoom}>
              Join
            </button>
          </div>
        </section>
      )}

      <section className="metrics">
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

      <section className="active-tab">
        <span>Active tab</span>
        <strong>{getTabPageLabel(activeTabState)}</strong>
        <small>
          {activeTabState
            ? `${activeTabState.visible ? 'visible' : 'background'} · ${formatTimeAgo(
                activeTabState.updatedAt,
              )}`
            : 'Waiting for content script'}
        </small>
      </section>

      <section className="room-target">
        <span>Room page</span>
        <strong>{getRoomTargetLabel(state.targetPage)}</strong>
        <small>
          {state.targetPage
            ? `created ${formatTimeAgo(state.targetPage.createdAt)}`
            : 'Create a room from the page you want to sync'}
        </small>
      </section>

      {state.lastTransportError ? (
        <section className="transport-error">
          <span>Transport</span>
          <strong>{state.lastTransportError}</strong>
        </section>
      ) : null}

      <section className="control-panel">
        <div className="field-row">
          <span>Overlay</span>
          <button
            type="button"
            className={state.overlayVisible ? 'toggle is-on' : 'toggle'}
            onClick={() =>
              commit(
                (current) => ({
                  ...current,
                  overlayVisible: !current.overlayVisible,
                }),
                state.overlayVisible ? 'Overlay hidden' : 'Overlay shown',
              )
            }
          >
            {state.overlayVisible ? 'Visible' : 'Hidden'}
          </button>
        </div>

        <div className="field-row">
          <span>Compact</span>
          <button
            type="button"
            className={state.compact ? 'toggle is-on' : 'toggle'}
            onClick={() =>
              commit((current) => ({
                ...current,
                compact: !current.compact,
              }))
            }
          >
            {state.compact ? 'On' : 'Off'}
          </button>
        </div>

        <div className="segmented" aria-label="Overlay position">
          {positions.map((position) => (
            <button
              key={position.value}
              type="button"
              className={state.position === position.value ? 'is-active' : ''}
              onClick={() =>
                commit((current) => ({
                  ...current,
                  position: position.value,
                }))
              }
            >
              {position.label}
            </button>
          ))}
        </div>
      </section>

      <section className="activity">
        <div className="section-title">
          <span>Activity</span>
          <button
            type="button"
            onClick={() =>
              commit((current) => ({
                ...current,
                activity: [],
              }))
            }
          >
            Clear
          </button>
        </div>

        {state.activity.length > 0 ? (
          state.activity.map((item) => (
            <div key={item.id} className={`activity-item activity-item--${item.tone}`}>
              <span />
              <p>{item.label}</p>
              <time>{formatTimeAgo(item.at)}</time>
            </div>
          ))
        ) : (
          <p className="empty">No events yet</p>
        )}
      </section>
    </main>
  );
}

export default App;
