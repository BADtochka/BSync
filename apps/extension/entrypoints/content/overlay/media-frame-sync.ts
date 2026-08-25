import {
  getSyncState,
  isRoomBoundPage,
  isRoomTargetUrl,
  subscribeSyncState,
  type MediaSyncState,
  type LocalMediaSelection,
  type SyncState,
} from '@/lib/sync-state';
import { decideMediaDrift } from '@/lib/media/drift-controller';

const MEDIA_EVENTS = [
  'play',
  'pause',
  'playing',
  'waiting',
  'seeking',
  'seeked',
  'loadedmetadata',
  'durationchange',
  'ratechange',
  'emptied',
];
const USER_INTENT_WINDOW_MS = 2500;
const DETACH_COOLDOWN_MS = 1200;
const SEEK_DETACH_SECONDS = 0.75;
const HEARTBEAT_MS = 1000;

type LocalMediaListener = (selection: LocalMediaSelection) => void;

const topFrameLocalMediaListeners = new Set<LocalMediaListener>();
let selectedTopFrameMedia: LocalMediaSelection = { status: 'no-candidate', media: null };

export function subscribeTopFrameLocalMedia(listener: LocalMediaListener): () => void {
  if (!isTopFrame()) return () => {};
  topFrameLocalMediaListeners.add(listener);
  listener(selectedTopFrameMedia);
  return () => topFrameLocalMediaListeners.delete(listener);
}

function notifyTopFrameLocalMedia(selection: LocalMediaSelection) {
  selectedTopFrameMedia = selection;
  for (const listener of topFrameLocalMediaListeners) listener(selection);
}

function isTopFrame(): boolean {
  return window.self === window.top;
}

function getTopFrameUrl(): string | null {
  if (isTopFrame()) return location.href;
  try {
    return window.top?.location.href ?? null;
  } catch {
    return null;
  }
}

function isFrameRoomBound(state: SyncState): boolean {
  const topUrl = getTopFrameUrl();
  if (topUrl) return isRoomBoundPage(state, topUrl);
  return state.roomRole !== 'none' && state.transportEnabled && Boolean(state.targetPage);
}

function getTargetWatchKey(state: SyncState | null): string {
  return `${state?.targetPage?.normalizedUrl ?? 'none'}|${state?.targetPage?.createdAt ?? 0}`;
}

function shouldScanMedia(state: SyncState | null): boolean {
  if (!state) return false;
  const topUrl = getTopFrameUrl();
  const isActiveRoomPage = topUrl ? isRoomBoundPage(state, topUrl) : isFrameRoomBound(state);
  const canAutoSwitchHostContent =
    state.roomRole === 'host' &&
    state.autoSwitchHostContent;
  return isActiveRoomPage || canAutoSwitchHostContent;
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

function getViewportArea(media: HTMLMediaElement): number {
  const rect = media.getBoundingClientRect();
  const width = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
  const height = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
  return width * height;
}

function isMediaVisible(media: HTMLMediaElement, viewportArea: number): boolean {
  if (!media.isConnected || viewportArea <= 0) return false;
  const style = getComputedStyle(media);
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
}

function getMediaDriftSeconds(left: MediaSyncState, right: MediaSyncState): number {
  return Math.round(Math.abs(left.currentTime - right.currentTime) * 10) / 10;
}

async function applyMediaState(
  media: HTMLMediaElement,
  remoteState: MediaSyncState,
  rttMs?: number,
) {
  const decision = decideMediaDrift({
    localTime: media.currentTime,
    paused: remoteState.paused,
    hostTime: remoteState.currentTime,
    hostPlaybackRate: remoteState.playbackRate,
    hostUpdatedAt: remoteState.updatedAt,
    now: Date.now(),
    duration: remoteState.duration,
    rttMs,
  });
  if (media.playbackRate !== decision.playbackRate) media.playbackRate = decision.playbackRate;
  if (
    (decision.correction === 'seek' || decision.correction === 'align') &&
    media.currentTime !== decision.expectedTime
  ) {
    media.currentTime = decision.expectedTime;
  }
  if (remoteState.paused && !media.paused) media.pause();
  if (!remoteState.paused && media.paused) await media.play();
}

export function startMediaFrameSync(): () => void {
  const documentId = globalThis.crypto?.randomUUID?.() ?? `document-${Date.now()}-${Math.random()}`;
  const mediaKeys = new WeakMap<HTMLMediaElement, string>();
  const mediaByKey = new Map<string, HTMLMediaElement>();
  const cleanupByKey = new Map<string, () => void>();
  const lastPlayingAt = new Map<string, number>();
  let nextMediaKey = 0;
  let stateRef: SyncState | null = null;
  let roomTargetSeenKey = '';
  let guestMediaReadySent = false;
  let suppressMediaPublishUntil = 0;
  let userIntentUntil = 0;
  let userIntentMediaTime: number | null = null;
  let userIntentMedia: HTMLMediaElement | null = null;
  let lastDetachSentAt = 0;
  let pendingUserAction: {
    commandId: string;
    mediaKey: string;
    media: MediaSyncState;
    rttMs?: number;
  } | null = null;
  let activeApplyCommandId: string | null = null;
  let activeApplyMediaKey: string | null = null;
  let resumeButton: HTMLButtonElement | null = null;

  const hideResumeButton = () => {
    resumeButton?.remove();
    resumeButton = null;
  };

  const sendRemove = (mediaKey: string) => {
    browser.runtime.sendMessage({
      type: 'bsync:media-candidate-remove',
      payload: { documentId, mediaKey },
    }).catch(() => undefined);
  };

  const reportMedia = (media: HTMLMediaElement) => {
    if (!shouldScanMedia(stateRef)) return;
    const mediaKey = mediaKeys.get(media);
    if (!mediaKey) return;
    const viewportArea = getViewportArea(media);
    browser.runtime.sendMessage({
      type: 'bsync:media-candidate-upsert',
      payload: {
        documentId,
        mediaKey,
        media: getMediaState(media),
        readyState: media.readyState,
        visible: isMediaVisible(media, viewportArea),
        viewportArea,
        lastPlayingAt: lastPlayingAt.get(mediaKey),
      },
    }).catch(() => undefined);
  };

  const detachFromHost = (eventName: string, media: HTMLMediaElement) => {
    const state = stateRef;
    if (!state || !isFrameRoomBound(state) || state.roomRole !== 'guest' || !state.followHost) return;
    const now = Date.now();
    if (now < suppressMediaPublishUntil || now > userIntentUntil) return;
    if (now - lastDetachSentAt < DETACH_COOLDOWN_MS) return;
    lastDetachSentAt = now;
    browser.runtime.sendMessage({
      type: 'bsync:media-detach',
      payload: { reason: `Local ${eventName}`, media: getMediaState(media) },
    }).catch(() => undefined);
  };

  const attachMedia = (media: HTMLMediaElement) => {
    if (mediaKeys.has(media)) return;
    const mediaKey = `media-${++nextMediaKey}`;
    mediaKeys.set(media, mediaKey);
    mediaByKey.set(mediaKey, media);
    if (!media.paused) lastPlayingAt.set(mediaKey, Date.now());

    const handlers = MEDIA_EVENTS.map((eventName) => {
      const handler = () => {
        if (eventName === 'play' || eventName === 'playing') {
          lastPlayingAt.set(mediaKey, Date.now());
        }
        reportMedia(media);
        if (['play', 'pause', 'seeking', 'seeked', 'ratechange'].includes(eventName)) {
          detachFromHost(eventName, media);
        }
      };
      media.addEventListener(eventName, handler);
      return { eventName, handler };
    });
    cleanupByKey.set(mediaKey, () => {
      for (const { eventName, handler } of handlers) media.removeEventListener(eventName, handler);
    });
    reportMedia(media);
  };

  const removeMedia = (mediaKey: string) => {
    const media = mediaByKey.get(mediaKey);
    cleanupByKey.get(mediaKey)?.();
    cleanupByKey.delete(mediaKey);
    mediaByKey.delete(mediaKey);
    lastPlayingAt.delete(mediaKey);
    if (media) mediaKeys.delete(media);
    guestMediaReadySent = false;
    if (pendingUserAction?.mediaKey === mediaKey) {
      pendingUserAction = null;
      hideResumeButton();
    }
    if (activeApplyMediaKey === mediaKey) {
      activeApplyCommandId = null;
      activeApplyMediaKey = null;
    }
    sendRemove(mediaKey);
  };

  const scanMedia = () => {
    const found = new Set(document.querySelectorAll<HTMLMediaElement>('video, audio'));
    for (const media of found) attachMedia(media);
    for (const [mediaKey, media] of mediaByKey) {
      if (!found.has(media)) removeMedia(mediaKey);
    }
  };

  const reportAllMedia = () => {
    if (!shouldScanMedia(stateRef)) {
      for (const mediaKey of [...mediaByKey.keys()]) removeMedia(mediaKey);
      return;
    }
    for (const media of mediaByKey.values()) reportMedia(media);
  };

  const attachMediaInNode = (node: Node) => {
    if (node instanceof HTMLMediaElement) attachMedia(node);
    if (!(node instanceof Element)) return;
    for (const media of node.querySelectorAll<HTMLMediaElement>('video, audio')) attachMedia(media);
  };

  const maybeSendGuestSync = () => {
    const state = stateRef;
    if (!state || !isFrameRoomBound(state) || state.roomRole !== 'guest' || !state.followHost) return;
    if (!state.roomMedia || mediaByKey.size === 0 || guestMediaReadySent) return;
    const topUrl = getTopFrameUrl();
    if (topUrl && !isRoomTargetUrl(state.targetPage, topUrl)) return;
    guestMediaReadySent = true;
    browser.runtime.sendMessage({ type: 'bsync:guest-sync' }).catch(() => undefined);
  };

  const checkUserDrivenTimeShift = () => {
    if (Date.now() > userIntentUntil || Date.now() < suppressMediaPublishUntil) return;
    if (!userIntentMedia || userIntentMediaTime == null) return;
    if (Math.abs(userIntentMedia.currentTime - userIntentMediaTime) < SEEK_DETACH_SECONDS) return;
    detachFromHost('seek', userIntentMedia);
    userIntentMediaTime = null;
  };

  const markUserIntent = (event: Event) => {
    const media = event.composedPath().find((node): node is HTMLMediaElement =>
      node instanceof HTMLMediaElement,
    ) ?? null;
    userIntentMedia = media;
    userIntentMediaTime = media?.currentTime ?? null;
    userIntentUntil = Date.now() + USER_INTENT_WINDOW_MS;
    setTimeout(checkUserDrivenTimeShift, 250);
    setTimeout(checkUserDrivenTimeShift, 900);
  };

  const showResumeButton = () => {
    if (resumeButton) return;
    resumeButton = document.createElement('button');
    resumeButton.type = 'button';
    resumeButton.textContent = 'Click to resume sync';
    resumeButton.setAttribute('aria-label', 'Click to resume BSync playback');
    Object.assign(resumeButton.style, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      zIndex: '2147483647',
      padding: '10px 12px',
      border: '1px solid #65f3ff',
      borderRadius: '2px',
      background: '#0e131b',
      color: '#f1f6fa',
      font: '600 12px/1.2 monospace',
      cursor: 'pointer',
    });
    resumeButton.addEventListener('click', () => {
      const pending = pendingUserAction;
      if (pending) applyRequestedMedia(pending.commandId, pending.mediaKey, pending.media, pending.rttMs);
    });
    document.documentElement.append(resumeButton);
  };

  const applyRequestedMedia = (
    commandId: string,
    mediaKey: string,
    requested: MediaSyncState,
    rttMs?: number,
  ) => {
    const media = mediaByKey.get(mediaKey);
    if (!media) return;
    activeApplyCommandId = commandId;
    activeApplyMediaKey = mediaKey;
    const before = getMediaState(media);
    suppressMediaPublishUntil = Date.now() + 1200;
    applyMediaState(media, requested, rttMs)
      .then(() => {
        if (activeApplyCommandId !== commandId) return;
        activeApplyCommandId = null;
        activeApplyMediaKey = null;
        pendingUserAction = null;
        hideResumeButton();
        const after = getMediaState(media);
        return browser.runtime.sendMessage({
          type: 'bsync:media-applied',
          payload: {
            commandId,
            requested,
            before,
            after,
            driftSeconds: getMediaDriftSeconds(requested, after),
          },
        });
      })
      .catch((error) => {
        if (activeApplyCommandId !== commandId) return;
        const userActionRequired = error instanceof Error && error.name === 'NotAllowedError';
        if (userActionRequired) {
          pendingUserAction = { commandId, mediaKey, media: requested, rttMs };
          showResumeButton();
        }
        return browser.runtime.sendMessage({
          type: 'bsync:media-apply-failed',
          payload: {
            commandId,
            requested,
            reason: error instanceof Error ? error.message : 'Media apply failed',
            code: userActionRequired ? 'user-action-required' : undefined,
          },
        }).catch(() => undefined);
      });
  };

  const messageListener = (message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const candidate = message as {
      type?: string;
      payload?: LocalMediaSelection | {
        commandId?: string;
        mediaKey?: string;
        media?: MediaSyncState;
        rttMs?: number;
      };
    };
    if (candidate.type === 'bsync:selected-local-media' && isTopFrame()) {
      notifyTopFrameLocalMedia(candidate.payload as LocalMediaSelection);
      return;
    }
    if (candidate.type === 'bsync:media-apply-cancel') {
      pendingUserAction = null;
      activeApplyCommandId = null;
      activeApplyMediaKey = null;
      hideResumeButton();
      return;
    }
    if (
      candidate.type === 'bsync:media-apply-pending' &&
      candidate.payload &&
      'mediaKey' in candidate.payload
    ) {
      const { commandId, mediaKey, media, rttMs } = candidate.payload;
      if (!commandId || !mediaKey || !media || !mediaByKey.has(mediaKey)) return;
      activeApplyCommandId = commandId;
      activeApplyMediaKey = mediaKey;
      pendingUserAction = { commandId, mediaKey, media, rttMs };
      showResumeButton();
      return;
    }
    if (candidate.type !== 'bsync:media-apply' || !candidate.payload || !('mediaKey' in candidate.payload)) return;
    const { commandId, mediaKey, media: requested, rttMs } = candidate.payload;
    if (!commandId || !mediaKey || !requested) return;
    applyRequestedMedia(commandId, mediaKey, requested, rttMs);
  };

  const onStateChange = (state: SyncState) => {
    const previousTargetKey = getTargetWatchKey(stateRef);
    stateRef = state;
    const nextTargetKey = getTargetWatchKey(state);
    const topUrl = getTopFrameUrl();
    if (topUrl && isRoomBoundPage(state, topUrl)) roomTargetSeenKey = nextTargetKey;
    if (previousTargetKey !== nextTargetKey) guestMediaReadySent = false;
    scanMedia();
    reportAllMedia();
    maybeSendGuestSync();
  };

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) attachMediaInNode(node);
    }
    for (const [mediaKey, media] of mediaByKey) {
      if (!media.isConnected) removeMedia(mediaKey);
    }
    reportAllMedia();
    maybeSendGuestSync();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  const heartbeat = setInterval(() => {
    reportAllMedia();
    maybeSendGuestSync();
  }, HEARTBEAT_MS);
  const unwatch = subscribeSyncState(onStateChange);
  void getSyncState().then(onStateChange);
  scanMedia();
  browser.runtime.onMessage.addListener(messageListener);
  document.addEventListener('pointerdown', markUserIntent, true);
  document.addEventListener('keydown', markUserIntent, true);
  document.addEventListener('pointerup', checkUserDrivenTimeShift, true);
  document.addEventListener('keyup', checkUserDrivenTimeShift, true);

  return () => {
    unwatch();
    observer.disconnect();
    clearInterval(heartbeat);
    pendingUserAction = null;
    hideResumeButton();
    for (const mediaKey of [...mediaByKey.keys()]) removeMedia(mediaKey);
    browser.runtime.onMessage.removeListener(messageListener);
    document.removeEventListener('pointerdown', markUserIntent, true);
    document.removeEventListener('keydown', markUserIntent, true);
    document.removeEventListener('pointerup', checkUserDrivenTimeShift, true);
    document.removeEventListener('keyup', checkUserDrivenTimeShift, true);
  };
}
