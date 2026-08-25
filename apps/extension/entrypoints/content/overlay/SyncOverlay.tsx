import { useEffect, useRef, useState } from 'preact/hooks';
import {
  canonicalRoomPageUrl,
  isRoomBoundPage,
  resolveSyncState,
  shouldShowOverlayOnPage,
  subscribeSyncState,
  updateSyncState,
  getSyncState,
  type ContentPageSnapshot,
  type LocalMediaSelection,
  type SyncState,
} from '@/lib/sync-state';
import { OverlayDropGuides } from './OverlayDropGuides';
import { OverlayPanel } from './OverlayPanel';
import { getMediaDriftLabel } from './media';
import { subscribeTopFrameLocalMedia } from './media-frame-sync';
import { getOverlayPanelSize } from './geometry';
import { useOverlayDrag } from './useOverlayDrag';
import { useOverlaySnap } from './useOverlaySnap';

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

export function SyncOverlay() {
  const [state, setState] = useState<SyncState | null>(null);
  const [pageSnapshot, setPageSnapshot] = useState<ContentPageSnapshot>(() => getPageSnapshot());
  const [currentPageUrl, setCurrentPageUrl] = useState(() => location.href);
  const [localMediaSelection, setLocalMediaSelection] = useState<LocalMediaSelection>({
    status: 'no-candidate',
    media: null,
  });
  const panelRef = useRef<HTMLDivElement>(null);
  const gripRef = useRef<HTMLDivElement>(null);
  const snapApiRef = useRef({
    updateSnap: (_event: PointerEvent) => {},
    resolveSnapPosition: (_event: PointerEvent) => null as SyncState['position'] | null,
    resetSnap: () => {},
  });
  const stateRef = useRef<SyncState | null>(null);
  const onDragEndRef = useRef<(event: PointerEvent) => void>(() => {});

  const pageUrl = currentPageUrl;
  const isActiveRoomPage = state != null && isRoomBoundPage(state, pageUrl);
  const shouldRenderOverlay = state != null && shouldShowOverlayOnPage(state, pageUrl);

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
    return subscribeTopFrameLocalMedia(setLocalMediaSelection);
  }, []);

  useEffect(() => {
    setCurrentPageUrl(location.href);
  }, [state?.targetPage?.normalizedUrl, state?.targetPage?.createdAt, state?.roomRole]);

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

  const handleResumeMedia = async () => {
    await browser.runtime.sendMessage({ type: 'bsync:media-resume' });
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
  };

  const handleToggleCompact = async () => {
    await updateSyncState((current) => ({
      ...current,
      compact: !current.compact,
    }));
  };

  const localMediaState = localMediaSelection.media;
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
        localMediaStatus={localMediaSelection.status}
        mediaDriftLabel={mediaDriftLabel}
        isDragging={isDragging}
        dragOffset={dragOffset}
        panelRef={panelRef}
        gripRef={gripRef}
        onGripPointerDown={onGripPointerDown}
        onToggleCompact={handleToggleCompact}
        onHide={handleHide}
        onFollowHost={handleFollowHost}
        onResumeMedia={handleResumeMedia}
        onOpenPendingFocus={openPendingFocus}
      />
    </>
  );
}
