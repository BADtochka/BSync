import type { MediaSyncState } from '@/lib/sync-state';

export function getMediaDisplayLabel(media: MediaSyncState): string {
  return `${media.paused ? 'Paused' : 'Playing'} · ${Math.round(media.currentTime)}s${
    media.duration ? ` / ${Math.round(media.duration)}s` : ''
  }`;
}

export function getMediaDriftLabel(
  hostMedia: MediaSyncState | null,
  localMedia: MediaSyncState | null,
): string | null {
  if (!hostMedia || !localMedia) return null;

  const driftSeconds = Math.round(Math.abs(localMedia.currentTime - hostMedia.currentTime));
  if (driftSeconds < 1 && localMedia.paused === hostMedia.paused) return 'in sync';

  const playbackState = localMedia.paused === hostMedia.paused ? '' : ' · state differs';
  return `${driftSeconds}s drift${playbackState}`;
}
