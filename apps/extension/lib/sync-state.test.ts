// @ts-expect-error Bun's test runner provides this module; extension builds do not include Bun types.
import { describe, expect, test } from 'bun:test';
import type { RoomTargetPage } from '@bsync/sync-protocol';
import {
  canonicalRoomPageUrl,
  isRoomTargetUrl,
  normalizeSyncUrl,
  sanitizeObservedPageUrl,
} from './navigation/normalized-url';
import { normalizeTrustedDomain } from './navigation/trusted-domain';

describe('normalized room URLs', () => {
  test('normalizes host casing, www, query order, trailing slash, and fragments', () => {
    expect(canonicalRoomPageUrl('HTTPS://WWW.Example.com/watch/?b=2&a=1#episode')).toBe(
      'https://example.com/watch?a=1&b=2',
    );
    expect(normalizeSyncUrl('https://example.com/watch#player')).toBe('https://example.com/watch');
  });

  test('matches equivalent room URLs without matching another path', () => {
    const target: RoomTargetPage = {
      title: 'Watch',
      url: 'https://www.example.com/watch/?b=2&a=1#host',
      normalizedUrl: 'https://example.com/watch?a=1&b=2',
      hostname: 'example.com',
      createdAt: 1,
    };
    expect(isRoomTargetUrl(target, 'https://EXAMPLE.com/watch?a=1&b=2#guest')).toBe(true);
    expect(isRoomTargetUrl(target, 'https://example.com/another?a=1&b=2')).toBe(false);
  });

  test('falls back safely for non-web URLs', () => {
    expect(canonicalRoomPageUrl('not a URL')).toBeNull();
    expect(normalizeSyncUrl('about:blank#section')).toBe('about:blank');
  });

  test('removes capability-bearing fragments before persistent tab storage', () => {
    expect(sanitizeObservedPageUrl('https://bsync.example/invite#secret-capability')).toBe(
      'https://bsync.example/invite',
    );
    expect(sanitizeObservedPageUrl('not a URL#secret')).toBe('');
  });
});

describe('trusted domains', () => {
  test('accepts real hostnames and rejects malformed fallback text', () => {
    expect(normalizeTrustedDomain('https://WWW.Example.com/watch')).toBe('www.example.com');
    expect(normalizeTrustedDomain('not a domain')).toBeNull();
    expect(normalizeTrustedDomain('https://-invalid.example')).toBeNull();
  });
});
