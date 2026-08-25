// @ts-expect-error Bun's test runner provides this module; extension builds do not include Bun types.
import { describe, expect, test } from 'bun:test';
import {
  getReconnectDelayMs,
  shouldAcceptServerSequence,
  shouldConnectTransport,
} from './reconnect-policy';

describe('reconnect backoff', () => {
  test('uses the configured exponential sequence without jitter', () => {
    expect([0, 1, 2, 3, 4, 5, 10].map((attempt) => getReconnectDelayMs(attempt, () => 0.5))).toEqual([
      500,
      1_000,
      2_000,
      4_000,
      8_000,
      15_000,
      15_000,
    ]);
  });

  test('applies bounded jitter', () => {
    expect(getReconnectDelayMs(0, () => 0)).toBe(400);
    expect(getReconnectDelayMs(0, () => 1)).toBe(600);
  });

  test('rejects stale and duplicate server sequences', () => {
    expect(shouldAcceptServerSequence(8, 7)).toBe(false);
    expect(shouldAcceptServerSequence(8, 8)).toBe(false);
    expect(shouldAcceptServerSequence(8, 9)).toBe(true);
  });

  test('does not bypass a scheduled reconnect when state updates', () => {
    expect(shouldConnectTransport({
      configurationChanged: false,
      reconnectScheduled: true,
      socketUnavailable: true,
      serverChanged: true,
      socketClosing: true,
    })).toBe(false);
  });

  test('reconnects immediately when connection configuration changes', () => {
    expect(shouldConnectTransport({
      configurationChanged: true,
      reconnectScheduled: true,
      socketUnavailable: true,
      serverChanged: false,
      socketClosing: false,
    })).toBe(true);
  });
});
