export const PLAYING_DRIFT_TOLERANCE_MS = 250;
export const PLAYING_SEEK_THRESHOLD_MS = 1000;
export const MAX_SOFT_RATE_ADJUSTMENT = 0.05;
export const MAX_MESSAGE_AGE_MS = 5000;
export const MAX_RTT_MS = 2000;
export const MIN_MEDIA_PLAYBACK_RATE = 0.0625;
export const MAX_MEDIA_PLAYBACK_RATE = 16;

export type DriftCorrection = 'none' | 'soft' | 'seek' | 'align';

export type DriftDecision = {
  correction: DriftCorrection;
  expectedTime: number;
  driftSeconds: number;
  playbackRate: number;
};

export type DriftControllerInput = {
  localTime: number;
  paused: boolean;
  hostTime: number;
  hostPlaybackRate: number;
  hostUpdatedAt: number;
  now: number;
  duration: number | null;
  rttMs?: number;
};

function boundedFinite(value: number | undefined, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value!));
}

export function decideMediaDrift(input: DriftControllerInput): DriftDecision {
  const hostPlaybackRate =
    Number.isFinite(input.hostPlaybackRate) && input.hostPlaybackRate > 0
      ? Math.min(MAX_MEDIA_PLAYBACK_RATE, Math.max(MIN_MEDIA_PLAYBACK_RATE, input.hostPlaybackRate))
      : 1;
  const hostTime = boundedFinite(input.hostTime, 0, Number.MAX_SAFE_INTEGER);
  const messageAgeMs = boundedFinite(input.now - input.hostUpdatedAt, 0, MAX_MESSAGE_AGE_MS);
  const oneWayLatencyMs = boundedFinite(input.rttMs, 0, MAX_RTT_MS) / 2;
  const projectedTime = input.paused
    ? hostTime
    : hostTime + ((messageAgeMs + oneWayLatencyMs) / 1000) * hostPlaybackRate;
  const expectedTime =
    input.duration === null || !Number.isFinite(input.duration)
      ? Math.max(0, projectedTime)
      : Math.min(Math.max(0, input.duration), Math.max(0, projectedTime));
  const localTime = Number.isFinite(input.localTime) ? input.localTime : 0;
  const driftSeconds = expectedTime - localTime;
  const absoluteDriftMs = Math.abs(driftSeconds) * 1000;

  if (input.paused) {
    return {
      correction: 'align',
      expectedTime,
      driftSeconds,
      playbackRate: hostPlaybackRate,
    };
  }

  if (absoluteDriftMs < PLAYING_DRIFT_TOLERANCE_MS) {
    return {
      correction: 'none',
      expectedTime,
      driftSeconds,
      playbackRate: hostPlaybackRate,
    };
  }

  if (absoluteDriftMs <= PLAYING_SEEK_THRESHOLD_MS) {
    const rateAdjustment = Math.min(
      MAX_SOFT_RATE_ADJUSTMENT,
      Math.max(-MAX_SOFT_RATE_ADJUSTMENT, driftSeconds * 0.1),
    );
    return {
      correction: 'soft',
      expectedTime,
      driftSeconds,
      playbackRate: Math.min(
        MAX_MEDIA_PLAYBACK_RATE,
        Math.max(MIN_MEDIA_PLAYBACK_RATE, hostPlaybackRate + rateAdjustment),
      ),
    };
  }

  return {
    correction: 'seek',
    expectedTime,
    driftSeconds,
    playbackRate: hostPlaybackRate,
  };
}
