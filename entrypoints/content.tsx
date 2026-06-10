import React from 'react';
import ReactDOM from 'react-dom/client';
import {
  formatTimeAgo,
  getRoomTargetLabel,
  getTabPageLabel,
  isRoomTargetUrl,
  statusLabel,
  syncStateItem,
  type BsyncContentMessage,
  type ContentPageSnapshot,
  type MediaSyncState,
  type SyncState,
  type TabSyncState,
} from '@/lib/sync-state';
import './content/styles.css';

const MEDIA_PUBLISH_EVENTS = ['play', 'pause', 'seeked', 'ratechange', 'loadedmetadata'];
const MEDIA_CONTROL_EVENTS = ['play', 'pause', 'seeking', 'seeked', 'ratechange'];
const USER_INTENT_WINDOW_MS = 2500;
const DETACH_COOLDOWN_MS = 1200;
const SEEK_DETACH_SECONDS = 0.75;

function isTopFrame(): boolean {
  return window.self === window.top;
}

function getPageSnapshot(): ContentPageSnapshot {
  return {
    title: document.title || location.hostname,
    url: location.href,
    hostname: location.hostname,
    documentState: document.readyState,
    visible: !document.hidden,
  };
}

function getPrimaryMediaElement(): HTMLMediaElement | null {
  const mediaElements = [...document.querySelectorAll<HTMLMediaElement>('video, audio')];
  if (mediaElements.length === 0) return null;

  return mediaElements.sort((left, right) => {
    const leftDuration = Number.isFinite(left.duration) ? left.duration : 0;
    const rightDuration = Number.isFinite(right.duration) ? right.duration : 0;
    return rightDuration - leftDuration;
  })[0] ?? null;
}

function getMediaId(media: HTMLMediaElement): string {
  return media.id || media.currentSrc || media.getAttribute('src') || media.tagName.toLowerCase();
}

function getMediaState(media: HTMLMediaElement): MediaSyncState {
  return {
    url: location.href,
    mediaId: getMediaId(media),
    paused: media.paused,
    currentTime: Number.isFinite(media.currentTime) ? media.currentTime : 0,
    duration: Number.isFinite(media.duration) ? media.duration : null,
    playbackRate: media.playbackRate || 1,
    volume: media.volume,
    muted: media.muted,
    updatedAt: Date.now(),
  };
}

function getMediaDisplayLabel(media: MediaSyncState): string {
  return `${media.paused ? 'Paused' : 'Playing'} · ${Math.round(media.currentTime)}s${
    media.duration ? ` / ${Math.round(media.duration)}s` : ''
  }`;
}

function getMediaDriftLabel(hostMedia: MediaSyncState | null, localMedia: MediaSyncState | null): string | null {
  if (!hostMedia || !localMedia) return null;

  const driftSeconds = Math.round(Math.abs(localMedia.currentTime - hostMedia.currentTime));
  if (driftSeconds < 1 && localMedia.paused === hostMedia.paused) return 'in sync';

  const playbackState = localMedia.paused === hostMedia.paused ? '' : ' · state differs';
  return `${driftSeconds}s drift${playbackState}`;
}

function getMediaDriftSeconds(left: MediaSyncState, right: MediaSyncState): number {
  return Math.round(Math.abs(left.currentTime - right.currentTime) * 10) / 10;
}

async function applyMediaState(media: HTMLMediaElement, remoteState: MediaSyncState) {
  if (Number.isFinite(remoteState.playbackRate) && media.playbackRate !== remoteState.playbackRate) {
    media.playbackRate = remoteState.playbackRate;
  }

  const driftSeconds = Math.abs(media.currentTime - remoteState.currentTime);
  if (Number.isFinite(remoteState.currentTime) && driftSeconds > 0.75) {
    media.currentTime = remoteState.currentTime;
  }

  if (remoteState.paused && !media.paused) {
    media.pause();
  }

  if (!remoteState.paused && media.paused) {
    await media.play().catch(() => undefined);
  }
}

function SyncOverlay() {
  const [state, setState] = useState<SyncState | null>(null);
  const [pageSnapshot, setPageSnapshot] = useState<ContentPageSnapshot>(() => getPageSnapshot());
  const [localMediaState, setLocalMediaState] = useState<MediaSyncState | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const suppressMediaPublishUntilRef = useRef(0);
  const userIntentUntilRef = useRef(0);
  const userIntentMediaTimeRef = useRef<number | null>(null);
  const lastDetachSentAtRef = useRef(0);
  const stateRef = useRef<SyncState | null>(null);
  const lastPublishedMediaKeyRef = useRef('');

  useEffect(() => {
    let mounted = true;

    syncStateItem.getValue().then((value) => {
      if (mounted) {
        stateRef.current = value;
        setState(value);
      }
    });

    const unwatch = syncStateItem.watch((value) => {
      stateRef.current = value;
      setState(value);
    });

    return () => {
      mounted = false;
      unwatch();
    };
  }, []);

  useEffect(() => {
    const publishMediaState = () => {
      const media = getPrimaryMediaElement();
      if (!media) {
        setLocalMediaState(null);
        return;
      }

      const nextMediaState = getMediaState(media);
      setLocalMediaState(nextMediaState);

      const latestState = stateRef.current;
      if (latestState?.roomRole !== 'host') return;
      if (Date.now() < suppressMediaPublishUntilRef.current) return;

      const publishKey = [
        nextMediaState.paused,
        Math.round(nextMediaState.currentTime),
        nextMediaState.playbackRate,
        nextMediaState.duration ?? 'live',
      ].join('|');

      if (publishKey === lastPublishedMediaKeyRef.current) return;
      lastPublishedMediaKeyRef.current = publishKey;

      browser.runtime
        .sendMessage({
          type: 'bsync:media-state',
          payload: nextMediaState,
        })
        .catch(() => undefined);
    };

    const sendDetachFromHost = (reason: string, mediaElement?: HTMLMediaElement | null) => {
      const latestState = stateRef.current;
      if (latestState?.roomRole !== 'guest' || !latestState.followHost) return;

      const now = Date.now();
      if (now - lastDetachSentAtRef.current < DETACH_COOLDOWN_MS) return;

      const media = mediaElement ?? getPrimaryMediaElement();
      if (!media) return;

      lastDetachSentAtRef.current = now;
      browser.runtime
        .sendMessage({
          type: 'bsync:media-detach',
          payload: {
            reason,
            media: getMediaState(media),
          },
        })
        .catch(() => undefined);
    };

    const detachFromHost = (eventName: string) => {
      const now = Date.now();
      const hasUserIntent = now <= userIntentUntilRef.current;
      const isRemoteApply = now < suppressMediaPublishUntilRef.current;
      const isSeekEvent = eventName === 'seeking' || eventName === 'seeked';

      if (isRemoteApply) return;
      if (!hasUserIntent && !isSeekEvent) return;
      sendDetachFromHost(`Local ${eventName}`);
    };

    const checkUserDrivenTimeShift = () => {
      if (Date.now() > userIntentUntilRef.current) return;
      if (Date.now() < suppressMediaPublishUntilRef.current) return;

      const initialTime = userIntentMediaTimeRef.current;
      if (initialTime == null) return;

      const media = getPrimaryMediaElement();
      if (!media || !Number.isFinite(media.currentTime)) return;

      if (Math.abs(media.currentTime - initialTime) < SEEK_DETACH_SECONDS) return;

      sendDetachFromHost('Local seek', media);
      userIntentMediaTimeRef.current = null;
    };

    const attachMediaListeners = () => {
      const media = getPrimaryMediaElement();
      if (!media) return;

      for (const eventName of MEDIA_PUBLISH_EVENTS) {
        media.addEventListener(eventName, publishMediaState);
      }

      const controlHandlers = MEDIA_CONTROL_EVENTS.map((eventName) => {
        const handler = () => detachFromHost(eventName);
        media.addEventListener(eventName, handler);
        return { eventName, handler };
      });

      return () => {
        for (const eventName of MEDIA_PUBLISH_EVENTS) {
          media.removeEventListener(eventName, publishMediaState);
        }
        for (const { eventName, handler } of controlHandlers) {
          media.removeEventListener(eventName, handler);
        }
      };
    };

    const markUserIntent = () => {
      const now = Date.now();
      const media = getPrimaryMediaElement();

      if (now > userIntentUntilRef.current || userIntentMediaTimeRef.current == null) {
        userIntentMediaTimeRef.current = media ? media.currentTime : null;
      }

      userIntentUntilRef.current = now + USER_INTENT_WINDOW_MS;
      window.setTimeout(checkUserDrivenTimeShift, 250);
      window.setTimeout(checkUserDrivenTimeShift, 900);
    };

    let cleanupMediaListeners = attachMediaListeners();
    const mediaScanTimer = setInterval(() => {
      cleanupMediaListeners?.();
      cleanupMediaListeners = attachMediaListeners();
      publishMediaState();
    }, 1500);

    const progressTimer = setInterval(publishMediaState, 1000);

    const messageListener = (message: unknown) => {
      const candidate = message as BsyncContentMessage;
      if (candidate?.type !== 'bsync:media-apply') return;

      const media = getPrimaryMediaElement();
      if (!media) {
        browser.runtime
          .sendMessage({
            type: 'bsync:media-apply-failed',
            payload: {
              requested: candidate.payload,
              reason: 'No media element on page',
            },
          })
          .catch(() => undefined);
        return;
      }

      const before = getMediaState(media);
      suppressMediaPublishUntilRef.current = Date.now() + 1200;
      applyMediaState(media, candidate.payload)
        .then(() => {
          const after = getMediaState(media);
          return browser.runtime.sendMessage({
            type: 'bsync:media-applied',
            payload: {
              requested: candidate.payload,
              before,
              after,
              driftSeconds: getMediaDriftSeconds(candidate.payload, after),
            },
          });
        })
        .catch((error) => {
          browser.runtime
            .sendMessage({
              type: 'bsync:media-apply-failed',
              payload: {
                requested: candidate.payload,
                reason: error instanceof Error ? error.message : 'Media apply failed',
              },
            })
            .catch(() => undefined);
        });
    };

    browser.runtime.onMessage.addListener(messageListener);
    document.addEventListener('pointerdown', markUserIntent, true);
    document.addEventListener('pointerup', checkUserDrivenTimeShift, true);
    document.addEventListener('keydown', markUserIntent, true);
    document.addEventListener('keyup', checkUserDrivenTimeShift, true);
    document.addEventListener('touchstart', markUserIntent, true);
    document.addEventListener('touchend', checkUserDrivenTimeShift, true);
    publishMediaState();

    return () => {
      cleanupMediaListeners?.();
      clearInterval(mediaScanTimer);
      clearInterval(progressTimer);
      browser.runtime.onMessage.removeListener(messageListener);
      document.removeEventListener('pointerdown', markUserIntent, true);
      document.removeEventListener('pointerup', checkUserDrivenTimeShift, true);
      document.removeEventListener('keydown', markUserIntent, true);
      document.removeEventListener('keyup', checkUserDrivenTimeShift, true);
      document.removeEventListener('touchstart', markUserIntent, true);
      document.removeEventListener('touchend', checkUserDrivenTimeShift, true);
    };
  }, []);

  useEffect(() => {
    if (!isTopFrame()) return;

    const publish = () => {
      const snapshot = getPageSnapshot();
      setPageSnapshot(snapshot);
      browser.runtime
        .sendMessage({
          type: 'bsync:tab-page',
          payload: snapshot,
        })
        .catch(() => undefined);
    };

    publish();

    const titleElement = document.querySelector('title');
    const titleObserver = new MutationObserver(publish);
    if (titleElement) {
      titleObserver.observe(titleElement, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }

    window.addEventListener('hashchange', publish);
    window.addEventListener('popstate', publish);
    document.addEventListener('visibilitychange', publish);
    document.addEventListener('readystatechange', publish);

    return () => {
      titleObserver?.disconnect();
      window.removeEventListener('hashchange', publish);
      window.removeEventListener('popstate', publish);
      document.removeEventListener('visibilitychange', publish);
      document.removeEventListener('readystatechange', publish);
    };
  }, []);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      if (!isDragging) return;
      setDragOffset((current) => ({
        x: current.x + event.movementX,
        y: current.y + event.movementY,
      }));
    };

    const onPointerUp = () => setIsDragging(false);

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [isDragging]);

  if (
    !isTopFrame() ||
    !state ||
    !state.enabled ||
    !state.overlayVisible ||
    !isRoomTargetUrl(state.targetPage, location.href)
  ) {
    return null;
  }

  const handleHide = async () => {
    await syncStateItem.setValue(
      {
        ...state,
        overlayVisible: false,
      },
    );
  };

  const handleFollowHost = async () => {
    const current = await syncStateItem.getValue();
    await syncStateItem.setValue({
      ...current,
      followHost: true,
      detachedReason: null,
    });
  };

  const openPendingFocus = async (mode: 'current' | 'new') => {
    const current = await syncStateItem.getValue();
    const focusRequest = current.pendingFocusRequest;
    if (!focusRequest) return;

    const { targetPage } = focusRequest;

    await browser.runtime.sendMessage({
      type: 'bsync:focus-open',
      payload: { mode, targetPage },
    });

    await syncStateItem.setValue({
      ...current,
      targetPage,
      overlayVisible: true,
      pendingFocusRequest: null,
    });
  };

  const mediaDriftLabel = getMediaDriftLabel(state.roomMedia, localMediaState);

  return (
    <div
      ref={panelRef}
      className={`bsync-overlay bsync-overlay--${state.position} ${
        collapsed || state.compact ? 'is-compact' : ''
      } ${isDragging ? 'is-dragging' : ''}`}
      style={{
        transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)`,
      }}
    >
      <div
        className="bsync-grip"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          setIsDragging(true);
        }}
        title="Drag overlay"
      >
        <span />
        <span />
        <span />
      </div>

      <div className="bsync-header">
        <div>
          <span className={`bsync-dot bsync-dot--${state.status}`} />
          <strong>{statusLabel(state.status)}</strong>
        </div>
        <button type="button" onClick={() => setCollapsed((value) => !value)}>
          {collapsed || state.compact ? 'Open' : 'Min'}
        </button>
      </div>

      <div className="bsync-body">
        <div className="bsync-room">
          <span>{state.roomCode}</span>
          <small>
            {state.roomRole === 'host'
              ? 'Host control'
              : state.followHost
                ? 'Following host'
                : 'Detached'}
          </small>
        </div>

        {state.roomRole !== 'host' && state.pendingFocusRequest ? (
          <div className="bsync-focus-request">
            <div>
              <strong>Host wants to switch page</strong>
              <small>{getRoomTargetLabel(state.pendingFocusRequest.targetPage)}</small>
            </div>
            <div className="bsync-focus-actions">
              <button type="button" className="is-primary" onClick={() => openPendingFocus('current')}>
                В текущей
              </button>
              <button type="button" onClick={() => openPendingFocus('new')}>
                В новой
              </button>
            </div>
          </div>
        ) : null}

        {state.roomRole === 'guest' && !state.followHost ? (
          <div className="bsync-detached">
            <div>
              <strong>Not synced with host</strong>
              <small>{state.detachedReason ?? 'Local playback control'}</small>
            </div>
            <button type="button" className="is-primary" onClick={handleFollowHost}>
              Follow host
            </button>
          </div>
        ) : null}

        <div className="bsync-progress" aria-label="Sync progress">
          <span style={{ width: `${state.progressPercent}%` }} />
        </div>

        <div className="bsync-grid">
          <div>
            <small>Peers</small>
            <strong>{state.peerCount}</strong>
          </div>
          <div>
            <small>Latency</small>
            <strong>{state.latencyMs}ms</strong>
          </div>
          <div>
            <small>Last sync</small>
            <strong>{formatTimeAgo(state.lastSyncedAt)}</strong>
          </div>
        </div>

        <p className="bsync-page">
          {getTabPageLabel({
            tabId: 0,
            ...pageSnapshot,
            updatedAt: Date.now(),
          } satisfies TabSyncState)}
        </p>

        <p className="bsync-page">
          {state.roomMedia
            ? `Host: ${getMediaDisplayLabel(state.roomMedia)}`
            : 'No room media found'}
        </p>

        {state.roomRole === 'guest' ? (
          <p className="bsync-page">
            {localMediaState
              ? `Local: ${getMediaDisplayLabel(localMediaState)}${
                  mediaDriftLabel ? ` · ${mediaDriftLabel}` : ''
                }`
              : 'Local: no media found'}
          </p>
        ) : null}

        <div className="bsync-actions">
          <button type="button" onClick={handleHide}>
            Hide
          </button>
        </div>
      </div>
    </div>
  );
}

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  matchAboutBlank: true,
  cssInjectionMode: 'ui',
  runAt: 'document_idle',
  async main(ctx) {
    const ui = await createShadowRootUi(ctx, {
      name: 'bsync-page-overlay',
      position: 'overlay',
      alignment: 'top-left',
      zIndex: 2147483647,
      isolateEvents: true,
      onMount(container) {
        const root = ReactDOM.createRoot(container);
        root.render(
          <React.StrictMode>
            <SyncOverlay />
          </React.StrictMode>,
        );
        return root;
      },
      onRemove(root) {
        root?.unmount();
      },
    });

    ui.mount();
  },
});
