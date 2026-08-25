// @ts-expect-error Bun's test runner provides this module; extension builds do not include Bun types.
import { describe, expect, test } from 'bun:test';
import {
  MediaRegistry,
  compareMediaCandidates,
  type MediaCandidate,
  type MediaCandidateReport,
} from './media-registry';

const baseReport: MediaCandidateReport = {
  tabId: 1,
  frameId: 0,
  documentId: 'document-a',
  mediaKey: 'media-a',
  url: 'https://example.test/video',
  paused: true,
  currentTime: 0,
  duration: 120,
  readyState: 4,
  visible: true,
  viewportArea: 10_000,
};

function candidate(overrides: Partial<MediaCandidate> = {}): MediaCandidate {
  return { ...baseReport, lastSeenAt: 0, ...overrides };
}

describe('media candidate scoring', () => {
  test('prioritizes playing, visibility, area, then meaningful duration', () => {
    expect(compareMediaCandidates(candidate({ paused: false }), candidate({ viewportArea: 1_000_000 })))
      .toBeGreaterThan(0);
    expect(compareMediaCandidates(candidate({ visible: true }), candidate({ visible: false, viewportArea: 1_000_000 })))
      .toBeGreaterThan(0);
    expect(compareMediaCandidates(candidate({ viewportArea: 20_000 }), candidate({ duration: 10_000 })))
      .toBeGreaterThan(0);
    expect(compareMediaCandidates(candidate({ duration: 300 }), candidate({ duration: 100 })))
      .toBeGreaterThan(0);
  });

  test('breaks exact ties by stable candidate identity', () => {
    const registryA = new MediaRegistry();
    const registryB = new MediaRegistry();
    const mediaA = { ...baseReport, mediaKey: 'a' };
    const mediaB = { ...baseReport, mediaKey: 'b' };

    registryA.report(mediaB, 0);
    registryA.report(mediaA, 0);
    registryB.report(mediaA, 0);
    registryB.report(mediaB, 0);

    expect(compareMediaCandidates(candidate({ mediaKey: 'a' }), candidate({ mediaKey: 'b' })))
      .toBeGreaterThan(0);
    expect(registryA.selectionSnapshot(1, 0).candidate?.mediaKey).toBe('a');
    expect(registryB.selectionSnapshot(1, 0).candidate?.mediaKey).toBe('a');
  });
});

describe('MediaRegistry', () => {
  test('uses hysteresis for small score changes and switches for a material change', () => {
    const registry = new MediaRegistry();
    registry.report(baseReport, 0);

    expect(registry.report({ ...baseReport, mediaKey: 'slightly-larger', viewportArea: 12_000 }, 1)
      .candidate?.mediaKey).toBe('media-a');
    expect(registry.report({ ...baseReport, mediaKey: 'clearly-larger', viewportArea: 13_000 }, 2)
      .candidate?.mediaKey).toBe('clearly-larger');
    expect(registry.report({ ...baseReport, mediaKey: 'playing', paused: false, viewportArea: 1 }, 3)
      .candidate?.mediaKey).toBe('playing');
  });

  test('prunes candidates with stale heartbeats from their exact expiry time', () => {
    const registry = new MediaRegistry({ staleAfterMs: 1_000, graceMs: 3_000 });
    registry.report(baseReport, 100);

    expect(registry.selectionSnapshot(1, 1_099).status).toBe('selected');
    expect(registry.selectionSnapshot(1, 1_100)).toMatchObject({
      status: 'reacquiring',
      candidate: null,
      graceExpiresAt: 4_100,
    });
    expect(registry.selectionSnapshot(1, 4_100).status).toBe('no-candidate');
  });

  test('replaces all candidates from an older frame document', () => {
    const registry = new MediaRegistry();
    registry.report(baseReport, 0);
    registry.report({ ...baseReport, mediaKey: 'media-b' }, 1);

    const snapshot = registry.report({
      ...baseReport,
      documentId: 'document-b',
      mediaKey: 'replacement',
      viewportArea: 1,
    }, 2);

    expect(snapshot.candidate).toMatchObject({ documentId: 'document-b', mediaKey: 'replacement' });
    registry.remove({ ...baseReport, mediaKey: 'replacement', documentId: 'document-b' }, 3);
    expect(registry.selectionSnapshot(1, 3).candidate).toBeNull();
  });

  test('frame removal preserves candidates in other frames', () => {
    const registry = new MediaRegistry();
    registry.report({ ...baseReport, frameId: 1, mediaKey: 'frame-one', paused: false }, 0);
    registry.report({ ...baseReport, frameId: 2, mediaKey: 'frame-two' }, 1);

    expect(registry.removeFrame(1, 1, 2)).toMatchObject({
      status: 'selected',
      candidate: { frameId: 2, mediaKey: 'frame-two' },
    });
  });

  test('reacquires during the 3000ms grace and expires only at its boundary', () => {
    const registry = new MediaRegistry({ staleAfterMs: 10_000 });
    registry.report(baseReport, 0);
    const identity = {
      tabId: 1,
      frameId: 0,
      documentId: 'document-a',
      mediaKey: 'media-a',
    };

    expect(registry.remove(identity, 500)).toMatchObject({
      status: 'reacquiring',
      graceExpiresAt: 3_500,
    });
    expect(registry.selectionSnapshot(1, 3_499).status).toBe('reacquiring');
    expect(registry.report({ ...baseReport, mediaKey: 'replacement' }, 3_499).status).toBe('selected');

    registry.remove({ ...identity, mediaKey: 'replacement' }, 4_000);
    expect(registry.selectionSnapshot(1, 6_999).status).toBe('reacquiring');
    expect(registry.selectionSnapshot(1, 7_000).status).toBe('no-candidate');
  });
});
