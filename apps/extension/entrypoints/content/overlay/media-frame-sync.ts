import {
  getSyncState,
  isRoomBoundPage,
  isRoomTargetUrl,
  subscribeSyncState,
  type MediaSyncState,
  type SyncState,
} from '@/lib/sync-state';

const MEDIA_PUBLISH_EVENTS = ['play', 'pause', 'seeked', 'ratechange', 'loadedmetadata'];
const MEDIA_CONTROL_EVENTS = ['play', 'pause', 'seeking', 'seeked', 'ratechange'];
const USER_INTENT_WINDOW_MS = 2500;
const DETACH_COOLDOWN_MS = 1200;
const SEEK_DETACH_SECONDS = 0.75;

export type MediaFrameSyncOptions = {
  onLocalMediaChange?: (media: MediaSyncState | null) => void;
};

type LocalMediaListener = (media: MediaSyncState | null) => void;

const topFrameLocalMediaListeners = new Set<LocalMediaListener>();

export function subscribeTopFrameLocalMedia(listener: LocalMediaListener): () => void {
  if (!isTopFrame()) return () => {};

  topFrameLocalMediaListeners.add(listener);
  return () => {
    topFrameLocalMediaListeners.delete(listener);
  };
}

function notifyTopFrameLocalMedia(media: MediaSyncState | null) {
  for (const listener of topFrameLocalMediaListeners) {
    listener(media);
  }
}

function reportLocalMedia(
  media: MediaSyncState | null,
  options: MediaFrameSyncOptions,
) {
  options.onLocalMediaChange?.(media);

  if (isTopFrame()) {
    notifyTopFrameLocalMedia(media);
    return;
  }

  if (!media) return;

  browser.runtime
    .sendMessage({
      type: 'bsync:frame-local-media',
      payload: media,
    })
    .catch(() => undefined);
}

function getTargetWatchKey(state: SyncState | null): string {
  return `${state?.targetPage?.normalizedUrl ?? 'none'}|${state?.targetPage?.createdAt ?? 0}`;
}

function isTopFrame(): boolean {
  return window.self === window.top;
}

function getTopFrameUrl(): string | null {
  if (isTopFrame()) return location.href;

  try {
    const top = window.top;
    if (!top) return null;
    return top.location.href;
  } catch {
    return null;
  }
}

function isFrameRoomBound(state: SyncState): boolean {
  const topUrl = getTopFrameUrl();
  if (topUrl) return isRoomBoundPage(state, topUrl);

  return state.roomRole !== 'none' && state.transportEnabled && Boolean(state.targetPage);
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

function shouldScanMedia(state: SyncState | null, roomTargetSeenKey: string): boolean {
  if (!state) return false;

  const targetWatchKey = getTargetWatchKey(state);
  const topUrl = getTopFrameUrl();
  const isActiveRoomPage = topUrl ? isRoomBoundPage(state, topUrl) : isFrameRoomBound(state);
  const canAutoSwitchHostContent =
    state.roomRole === 'host' &&
    state.autoSwitchHostContent &&
    roomTargetSeenKey === targetWatchKey;

  return isActiveRoomPage || canAutoSwitchHostContent;
}

export function startMediaFrameSync(options: MediaFrameSyncOptions = {}): () => void {
  let stateRef: SyncState | null = null;
  let roomTargetSeenKey = '';
  let guestMediaReadySent = false;
  let lastPublishedMediaKey = '';
  let suppressMediaPublishUntil = 0;
  let userIntentUntil = 0;
  let userIntentMediaTime: number | null = null;
  let lastDetachSentAt = 0;
  let cleanupMediaListeners: (() => void) | undefined;
  let mediaScanTimer: ReturnType<typeof setInterval> | null = null;
  let progressTimer: ReturnType<typeof setInterval> | null = null;

  const publishMediaState = () => {
    const latestState = stateRef;
    if (!latestState || !shouldScanMedia(latestState, roomTargetSeenKey)) {
      reportLocalMedia(null, options);
      return;
    }

    const targetWatchKey = getTargetWatchKey(latestState);
    const topUrl = getTopFrameUrl();
    const isBoundPage = topUrl ? isRoomBoundPage(latestState, topUrl) : isFrameRoomBound(latestState);
    const canAutoSwitchHostContent =
      latestState.roomRole === 'host' &&
      latestState.autoSwitchHostContent &&
      roomTargetSeenKey === targetWatchKey;

    if (!isBoundPage && !canAutoSwitchHostContent) {
      reportLocalMedia(null, options);
      return;
    }

    const media = getPrimaryMediaElement();
    if (!media) {
      reportLocalMedia(null, options);
      return;
    }

    const nextMediaState = getMediaState(media);
    reportLocalMedia(nextMediaState, options);

    if (latestState.roomRole !== 'host') return;
    if (Date.now() < suppressMediaPublishUntil) return;

    const publishKey = [
      nextMediaState.paused,
      Math.round(nextMediaState.currentTime),
      nextMediaState.playbackRate,
      nextMediaState.duration ?? 'live',
    ].join('|');

    if (publishKey === lastPublishedMediaKey) return;
    lastPublishedMediaKey = publishKey;

    browser.runtime
      .sendMessage({
        type: 'bsync:media-state',
        payload: nextMediaState,
      })
      .catch(() => undefined);
  };

  const sendDetachFromHost = (reason: string, mediaElement?: HTMLMediaElement | null) => {
    const latestState = stateRef;
    if (!latestState || !isFrameRoomBound(latestState)) return;
    if (latestState.roomRole !== 'guest' || !latestState.followHost) return;

    const now = Date.now();
    if (now - lastDetachSentAt < DETACH_COOLDOWN_MS) return;

    const media = mediaElement ?? getPrimaryMediaElement();
    if (!media) return;

    lastDetachSentAt = now;
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
    const hasUserIntent = now <= userIntentUntil;
    const isRemoteApply = now < suppressMediaPublishUntil;
    const isSeekEvent = eventName === 'seeking' || eventName === 'seeked';

    if (isRemoteApply) return;
    if (!hasUserIntent && !isSeekEvent) return;
    sendDetachFromHost(`Local ${eventName}`);
  };

  const checkUserDrivenTimeShift = () => {
    if (Date.now() > userIntentUntil) return;
    if (Date.now() < suppressMediaPublishUntil) return;

    const initialTime = userIntentMediaTime;
    if (initialTime == null) return;

    const media = getPrimaryMediaElement();
    if (!media || !Number.isFinite(media.currentTime)) return;

    if (Math.abs(media.currentTime - initialTime) < SEEK_DETACH_SECONDS) return;

    sendDetachFromHost('Local seek', media);
    userIntentMediaTime = null;
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

    if (now > userIntentUntil || userIntentMediaTime == null) {
      userIntentMediaTime = media ? media.currentTime : null;
    }

    userIntentUntil = now + USER_INTENT_WINDOW_MS;
    window.setTimeout(checkUserDrivenTimeShift, 250);
    window.setTimeout(checkUserDrivenTimeShift, 900);
  };

  const restartMediaScan = () => {
    cleanupMediaListeners?.();
    cleanupMediaListeners = attachMediaListeners();
    publishMediaState();
  };

  const maybeSendGuestSync = async () => {
    const latestState = stateRef;
    if (!latestState || !isFrameRoomBound(latestState)) return;
    if (latestState.roomRole !== 'guest' || !latestState.followHost) return;
    if (!latestState.roomMedia) return;
    if (!getPrimaryMediaElement()) return;

    const topUrl = getTopFrameUrl();
    const pageUrl = topUrl ?? location.href;
    if (!isRoomTargetUrl(latestState.targetPage, pageUrl)) return;
    if (guestMediaReadySent) return;

    guestMediaReadySent = true;
    browser.runtime.sendMessage({ type: 'bsync:guest-sync' }).catch(() => undefined);
  };

  const messageListener = (message: unknown) => {
    const latestState = stateRef;
    if (!latestState || !isFrameRoomBound(latestState)) return;

    if (!message || typeof message !== 'object') return;
    const candidate = message as { type?: string; payload?: MediaSyncState };

    if (candidate.type === 'bsync:frame-local-media' && isTopFrame()) {
      notifyTopFrameLocalMedia(candidate.payload ?? null);
      return;
    }

    if (candidate.type !== 'bsync:media-apply' || !candidate.payload) return;

    const media = getPrimaryMediaElement();
    if (!media) return;

    const before = getMediaState(media);
    suppressMediaPublishUntil = Date.now() + 1200;
    applyMediaState(media, candidate.payload)
      .then(() => {
        const after = getMediaState(media);
        return browser.runtime.sendMessage({
          type: 'bsync:media-applied',
          payload: {
            requested: candidate.payload!,
            before,
            after,
            driftSeconds: getMediaDriftSeconds(candidate.payload!, after),
          },
        });
      })
      .catch((error) => {
        browser.runtime
          .sendMessage({
            type: 'bsync:media-apply-failed',
            payload: {
              requested: candidate.payload!,
              reason: error instanceof Error ? error.message : 'Media apply failed',
            },
          })
          .catch(() => undefined);
      });
  };

  const onStateChange = (nextState: SyncState) => {
    const previousTargetKey = getTargetWatchKey(stateRef);
    stateRef = nextState;

    const nextTargetKey = getTargetWatchKey(nextState);
    const topUrl = getTopFrameUrl();
    if (topUrl && isRoomBoundPage(nextState, topUrl)) {
      roomTargetSeenKey = nextTargetKey;
    }

    if (previousTargetKey !== nextTargetKey) {
      guestMediaReadySent = false;
    }

    if (!shouldScanMedia(nextState, roomTargetSeenKey)) {
      reportLocalMedia(null, options);
      return;
    }

    restartMediaScan();
    void maybeSendGuestSync();
  };

  const unwatch = subscribeSyncState(onStateChange);

  void getSyncState().then((state) => {
    onStateChange(state);
  });

  cleanupMediaListeners = attachMediaListeners();
  mediaScanTimer = setInterval(() => {
    if (!shouldScanMedia(stateRef, roomTargetSeenKey)) return;
    restartMediaScan();
  }, 1500);
  progressTimer = setInterval(() => {
    if (!shouldScanMedia(stateRef, roomTargetSeenKey)) return;
    publishMediaState();
  }, 1000);

  browser.runtime.onMessage.addListener(messageListener);
  document.addEventListener('pointerdown', markUserIntent, true);
  document.addEventListener('pointerup', checkUserDrivenTimeShift, true);
  document.addEventListener('keydown', markUserIntent, true);
  document.addEventListener('keyup', checkUserDrivenTimeShift, true);
  document.addEventListener('touchstart', markUserIntent, true);
  document.addEventListener('touchend', checkUserDrivenTimeShift, true);

  return () => {
    unwatch();
    cleanupMediaListeners?.();
    if (mediaScanTimer) clearInterval(mediaScanTimer);
    if (progressTimer) clearInterval(progressTimer);
    browser.runtime.onMessage.removeListener(messageListener);
    document.removeEventListener('pointerdown', markUserIntent, true);
    document.removeEventListener('pointerup', checkUserDrivenTimeShift, true);
    document.removeEventListener('keydown', markUserIntent, true);
    document.removeEventListener('keyup', checkUserDrivenTimeShift, true);
    document.removeEventListener('touchstart', markUserIntent, true);
    document.removeEventListener('touchend', checkUserDrivenTimeShift, true);
  };
}
