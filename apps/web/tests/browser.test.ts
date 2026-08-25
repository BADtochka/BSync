import { describe, expect, test } from 'bun:test';
import { getBrowserPreference, normalizeStoreUrl } from '../src/browser';
import { isExtensionBridgeResponse } from '../src/extension-bridge';

describe('browser store preference', () => {
  test('prefers Firefox without hiding Chrome', () => {
    expect(getBrowserPreference('Mozilla/5.0 Firefox/142.0')).toBe('firefox');
  });

  test('recognizes Chromium-family browsers', () => {
    expect(getBrowserPreference('Mozilla/5.0 Edg/140.0 Chrome/140.0')).toBe('chrome');
  });

  test('accepts only HTTPS store links', () => {
    expect(normalizeStoreUrl('https://example.com/item')).toBe('https://example.com/item');
    expect(normalizeStoreUrl('javascript:alert(1)')).toBeNull();
  });
});

test('extension bridge response is narrowly validated', () => {
  expect(isExtensionBridgeResponse({ source: 'bsync:extension', version: 1, type: 'bsync:extension-ready', requestId: 'a', ok: true })).toBeTrue();
  expect(isExtensionBridgeResponse({ source: 'other', version: 1, type: 'bsync:extension-ready', requestId: 'a', ok: true })).toBeFalse();
});
