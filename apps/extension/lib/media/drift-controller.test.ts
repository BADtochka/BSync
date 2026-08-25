// @ts-expect-error Bun's test runner provides this module; extension builds do not include Bun types.
import { describe, expect, test } from 'bun:test';
import {
  MAX_MESSAGE_AGE_MS,
  MAX_RTT_MS,
  MAX_SOFT_RATE_ADJUSTMENT,
  decideMediaDrift,
} from './drift-controller';

const baseInput = {
  localTime: 10,
  paused: false,
  hostTime: 10,
  hostPlaybackRate: 1,
  hostUpdatedAt: 1000,
  now: 1000,
  duration: 60,
};

describe('media drift controller', () => {
  test('does not correct playing drift below 250ms and restores the host rate', () => {
    expect(
      decideMediaDrift({ ...baseInput, localTime: 10.249, hostPlaybackRate: 1.25 }),
    ).toMatchObject({ correction: 'none', playbackRate: 1.25 });
  });

  test('uses bounded soft playback-rate correction from 250ms through 1000ms', () => {
    const behind = decideMediaDrift({ ...baseInput, localTime: 9.75 });
    const ahead = decideMediaDrift({ ...baseInput, localTime: 11 });

    expect(behind.correction).toBe('soft');
    expect(behind.playbackRate).toBeCloseTo(1.025);
    expect(ahead.correction).toBe('soft');
    expect(ahead.playbackRate).toBe(1 - MAX_SOFT_RATE_ADJUSTMENT);
  });

  test('never produces a negative browser playback rate', () => {
    const decision = decideMediaDrift({
      ...baseInput,
      hostPlaybackRate: 0.01,
      localTime: 10.5,
    });
    expect(decision.correction).toBe('soft');
    expect(decision.playbackRate).toBeGreaterThan(0);
  });

  test('seeks when playing drift exceeds 1000ms', () => {
    expect(decideMediaDrift({ ...baseInput, localTime: 8.999 })).toMatchObject({
      correction: 'seek',
      expectedTime: 10,
      playbackRate: 1,
    });
  });

  test('aligns paused media exactly without projecting its position', () => {
    expect(
      decideMediaDrift({
        ...baseInput,
        paused: true,
        localTime: 10.01,
        now: 5000,
        rttMs: 800,
      }),
    ).toMatchObject({ correction: 'align', expectedTime: 10 });
  });

  test('projects playing position with sanitized message age and bounded RTT/2', () => {
    const projected = decideMediaDrift({
      ...baseInput,
      localTime: 0,
      hostPlaybackRate: 2,
      now: 1000 + MAX_MESSAGE_AGE_MS + 10_000,
      rttMs: MAX_RTT_MS + 10_000,
    });
    const futureTimestamp = decideMediaDrift({
      ...baseInput,
      localTime: 0,
      hostUpdatedAt: 2000,
      rttMs: Number.NaN,
    });

    expect(projected.expectedTime).toBe(22);
    expect(futureTimestamp.expectedTime).toBe(10);
  });

  test('clamps projected position to finite media duration', () => {
    expect(
      decideMediaDrift({ ...baseInput, localTime: 59, hostTime: 59.5, now: 6000 }),
    ).toMatchObject({ correction: 'soft', expectedTime: 60 });
  });
});
