import { useEffect, useRef, useState } from 'preact/hooks';
import {
  addTrustedDomain,
  canonicalRoomPageUrl,
  isRoomBoundPage,
  isRoomTargetUrl,
  resolveSyncState,
  shouldShowOverlayOnPage,
  subscribeSyncState,
  updateSyncState,
  getSyncState,
  type BsyncContentMessage,
  type ContentPageSnapshot,
  type MediaSyncState,
  type SyncState,
} from '@/lib/sync-state';
import { OverlayDropGuides } from './OverlayDropGuides';
import { OverlayPanel } from './OverlayPanel';
import { getMediaDriftLabel } from './media';
import { getOverlayPanelSize } from './geometry';
import { useOverlayDrag } from './useOverlayDrag';
import { useOverlaySnap } from './useOverlaySnap';

const MEDIA_PUBLISH_EVENTS = ['play', 'pause', 'seeked', 'ratechange', 'loadedmetadata'];
const MEDIA_CONTROL_EVENTS = ['play', 'pause', 'seeking', 'seeked', 'ratechange'];
const USER_INTENT_WINDOW_MS = 2500;
const DETACH_COOLDOWN_MS = 1200;
const SEEK_DETACH_SECONDS = 0.75;

function getTargetWatchKey(state: SyncState | null): string {
  return `${state?.targetPage?.normalizedUrl ?? 'none'}|${state?.targetPage?.createdAt ?? 0}`;
}

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

export function SyncOverlay() {
  const [state, setState] = useState<SyncState | null>(null);
  const [pageSnapshot, setPageSnapshot] = useState<ContentPageSnapshot>(() => getPageSnapshot());
  const [currentPageUrl, setCurrentPageUrl] = useState(() => location.href);
  const [localMediaState, setLocalMediaState] = useState<MediaSyncState | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const gripRef = useRef<HTMLDivElement>(null);
  const snapApiRef = useRef({
    updateSnap: (_event: PointerEvent) => {},
    resolveSnapPosition: (_event: PointerEvent) => null as SyncState['position'] | null,
    resetSnap: () => {},
  });
  const suppressMediaPublishUntilRef = useRef(0);
  const userIntentUntilRef = useRef(0);
  const userIntentMediaTimeRef = useRef<number | null>(null);
  const lastDetachSentAtRef = useRef(0);
  const stateRef = useRef<SyncState | null>(null);
  const lastPublishedMediaKeyRef = useRef('');
  const guestMediaReadySentRef = useRef(false);
  const onDragEndRef = useRef<(event: PointerEvent) => void>(() => {});
  const roomTargetSeenInThisTabRef = useRef('');

  const pageUrl = currentPageUrl;
  const isActiveRoomPage = state != null && isRoomBoundPage(state, pageUrl);
  const shouldRenderOverlay = state != null && shouldShowOverlayOnPage(state, pageUrl);
  const targetWatchKey = getTargetWatchKey(state);
  const shouldScanMedia =
    isActiveRoomPage ||
    (state?.roomRole === 'host' &&
      state.autoSwitchHostContent &&
      roomTargetSeenInThisTabRef.current === targetWatchKey);

  useEffect(() => {
    const syncPageUrl = () => setCurrentPageUrl(location.href);

    syncPageUrl();
    window.addEventListener('hashchange', syncPageUrl);
    window.addEventListener('popstate', syncPageUrl);
    document.addEventListener('readystatechange', syncPageUrl);

    const originalPushState = history.pushState.bind(history);
    const originalReplaceState = history.replaceState.bind(history);

    history.pushState = (...args) => {
      originalPushState(...args);
      syncPageUrl();
    };
    history.replaceState = (...args) => {
      originalReplaceState(...args);
      syncPageUrl();
    };

    return () => {
      window.removeEventListener('hashchange', syncPageUrl);
      window.removeEventListener('popstate', syncPageUrl);
      document.removeEventListener('readystatechange', syncPageUrl);
      history.pushState = originalPushState;
      history.replaceState = originalReplaceState;
    };
  }, []);

  const {
    dragOffset,
    isDragging,
    onGripPointerDown,
    resetDragOffset,
  } = useOverlayDrag({
    panelRef,
    gripRef,
    watchKey: `${state?.overlayVisible}-${state?.compact}`,
    onMove: (event) => snapApiRef.current.updateSnap(event),
    onEnd: (event) => onDragEndRef.current(event),
  });

  onDragEndRef.current = async (event: PointerEvent) => {
    const snapPosition = snapApiRef.current.resolveSnapPosition(event);
    snapApiRef.current.resetSnap();

    const current = stateRef.current;
    if (!snapPosition || !current) return;

    resetDragOffset();
    await updateSyncState((current) => ({
      ...current,
      position: snapPosition,
    }));
  };

  const snap = useOverlaySnap({
    isDragging,
    panelRef,
  });

  snapApiRef.current = {
    updateSnap: snap.updateSnap,
    resolveSnapPosition: snap.resolveSnapPosition,
    resetSnap: snap.resetSnap,
  };

  useEffect(() => {
    if (!state?.position) return;
    resetDragOffset();
  }, [state?.position, resetDragOffset]);

  useEffect(() => {
    const unwatch = subscribeSyncState((merged) => {
      stateRef.current = merged;
      setState(merged);
    });

    return unwatch;
  }, []);

  useEffect(() => {
    setCurrentPageUrl(location.href);
  }, [state?.targetPage?.normalizedUrl, state?.targetPage?.createdAt, state?.roomRole]);

  useEffect(() => {
    if (isActiveRoomPage) {
      roomTargetSeenInThisTabRef.current = targetWatchKey;
    }
  }, [isActiveRoomPage, targetWatchKey]);

  useEffect(() => {
    if (!shouldScanMedia) return;

    const publishMediaState = () => {
      const latestState = stateRef.current;
      if (!latestState) return;

      const latestTargetWatchKey = getTargetWatchKey(latestState);
      const isBoundPage = isRoomBoundPage(latestState, location.href);
      const canAutoSwitchHostContent =
        latestState.roomRole === 'host' &&
        latestState.autoSwitchHostContent &&
        roomTargetSeenInThisTabRef.current === latestTargetWatchKey;

      if (!isBoundPage && !canAutoSwitchHostContent) return;

      const media = getPrimaryMediaElement();
      if (!media) {
        setLocalMediaState(null);
        return;
      }

      const nextMediaState = getMediaState(media);
      setLocalMediaState(nextMediaState);

      if (latestState.roomRole !== 'host') return;
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
      if (!latestState || !isRoomBoundPage(latestState, location.href)) return;
      if (latestState.roomRole !== 'guest' || !latestState.followHost) return;

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
      const latestState = stateRef.current;
      if (!latestState || !isRoomBoundPage(latestState, location.href)) return;

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
  }, [
    currentPageUrl,
    isActiveRoomPage,
    shouldScanMedia,
    state?.autoSwitchHostContent,
    state?.roomRole,
    state?.targetPage?.normalizedUrl,
    state?.transportEnabled,
    targetWatchKey,
  ]);

  useEffect(() => {
    if (!isTopFrame() || !isActiveRoomPage) return;

    const publish = () => {
      const latestState = stateRef.current;
      if (!latestState || !isRoomBoundPage(latestState, location.href)) return;

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
  }, [currentPageUrl, isActiveRoomPage, state?.targetPage?.normalizedUrl, state?.roomRole, state?.transportEnabled]);

  useEffect(() => {
    if (!isActiveRoomPage) return;

    guestMediaReadySentRef.current = false;
  }, [currentPageUrl, isActiveRoomPage, state?.targetPage?.normalizedUrl]);

  useEffect(() => {
    if (!isActiveRoomPage) return;

    const latestState = stateRef.current;
    if (!latestState) return;
    if (latestState.roomRole !== 'guest' || !latestState.followHost) return;
    if (!latestState.roomMedia || !localMediaState) return;
    if (!isRoomTargetUrl(latestState.targetPage, location.href)) return;
    if (guestMediaReadySentRef.current) return;

    guestMediaReadySentRef.current = true;
    browser.runtime.sendMessage({ type: 'bsync:guest-sync' }).catch(() => undefined);
  }, [
    currentPageUrl,
    isActiveRoomPage,
    localMediaState,
    state?.followHost,
    state?.roomMedia,
    state?.targetPage?.normalizedUrl,
  ]);

  useEffect(() => {
    const host = document.querySelector<HTMLElement>('bsync-page-overlay');
    if (!host) return;

    host.dataset.bsyncMounted = 'true';
    host.dataset.bsyncHasState = String(Boolean(state));
    host.dataset.bsyncShouldShow = String(shouldRenderOverlay);
    host.dataset.bsyncEnabled = String(state?.enabled ?? null);
    host.dataset.bsyncOverlayVisible = String(state?.overlayVisible ?? null);
    host.dataset.bsyncRole = state?.roomRole ?? 'none';
    host.dataset.bsyncTransportEnabled = String(state?.transportEnabled ?? null);
    host.dataset.bsyncPendingFocus = String(Boolean(state?.pendingFocusRequest));
    host.dataset.bsyncPageUrl = pageUrl;
    host.dataset.bsyncCanonicalPageUrl = canonicalRoomPageUrl(pageUrl) ?? '';
    host.dataset.bsyncRawTargetUrl = state?.targetPage?.url ?? '';
    host.dataset.bsyncTargetUrl = state?.targetPage?.normalizedUrl ?? '';
    host.dataset.bsyncCanonicalTargetUrl = state?.targetPage
      ? (canonicalRoomPageUrl(state.targetPage.normalizedUrl) ?? '')
      : '';
  }, [
    pageUrl,
    shouldRenderOverlay,
    state,
    state?.enabled,
    state?.overlayVisible,
    state?.pendingFocusRequest,
    state?.roomRole,
    state?.targetPage?.normalizedUrl,
    state?.targetPage?.url,
    state?.transportEnabled,
  ]);

  if (!isTopFrame() || !state || !shouldRenderOverlay) {
    return null;
  }

  const handleHide = async () => {
    await updateSyncState((current) => ({
      ...current,
      overlayVisible: false,
    }));
  };

  const handleFollowHost = async () => {
    await updateSyncState((current) => ({
      ...current,
      followHost: true,
      detachedReason: null,
    }));
  };

  const openPendingFocus = async (mode: 'current' | 'new', trustSite: boolean) => {
    const current = await getSyncState();
    const focusRequest = resolveSyncState(current).pendingFocusRequest;
    if (!focusRequest) return;

    const { targetPage } = focusRequest;

    await browser.runtime.sendMessage({
      type: 'bsync:focus-open',
      payload: { mode, targetPage, trustSite },
    });

    await updateSyncState((latest) => ({
      ...latest,
      targetPage,
      overlayVisible: true,
      pendingFocusRequest: null,
      followHost: true,
      detachedReason: null,
      trustedDomains: trustSite
        ? addTrustedDomain(latest.trustedDomains ?? [], targetPage.hostname || targetPage.url)
        : latest.trustedDomains,
    }));
  };

  const handleToggleCompact = async () => {
    await updateSyncState((current) => ({
      ...current,
      compact: !current.compact,
    }));
  };

  const mediaDriftLabel = getMediaDriftLabel(state.roomMedia, localMediaState);
  const dropGuidesPanelSize = panelRef.current
    ? getOverlayPanelSize(panelRef.current)
    : snap.panelSize;

  return (
    <>
      <OverlayDropGuides
        visible={isDragging}
        currentPosition={state.position}
        panelSize={dropGuidesPanelSize}
        hintedZones={snap.hintedZones}
        hoveredZone={snap.hoveredZone}
        activeZone={snap.activeZone}
      />
      <OverlayPanel
        state={state}
        pageSnapshot={pageSnapshot}
        localMediaState={localMediaState}
        mediaDriftLabel={mediaDriftLabel}
        isDragging={isDragging}
        dragOffset={dragOffset}
        panelRef={panelRef}
        gripRef={gripRef}
        onGripPointerDown={onGripPointerDown}
        onToggleCompact={handleToggleCompact}
        onHide={handleHide}
        onFollowHost={handleFollowHost}
        onOpenPendingFocus={openPendingFocus}
      />
    </>
  );
}
