// @ts-expect-error Bun's test runner provides this module; extension builds do not include Bun types.
import { describe, expect, test } from 'bun:test';
import { selectMediaApplyTarget } from './media-apply';

describe('targeted media apply', () => {
  test('selects one active matching tab', () => {
    const selected = selectMediaApplyTarget([
      { tabId: 4, active: false, candidate: 'background', candidateKey: 'a' },
      { tabId: 9, active: true, candidate: 'active', candidateKey: 'b' },
      { tabId: 2, active: false, candidate: 'older', candidateKey: 'c' },
    ]);
    expect(selected).toMatchObject({ tabId: 9, candidate: 'active' });
  });

  test('uses tab id as a deterministic fallback and returns null when empty', () => {
    expect(
      selectMediaApplyTarget([
        { tabId: 8, active: false, candidate: 'later', candidateKey: 'a' },
        { tabId: 3, active: false, candidate: 'first', candidateKey: 'b' },
      ]),
    ).toMatchObject({ tabId: 3, candidate: 'first' });
    expect(selectMediaApplyTarget([])).toBeNull();
  });
});
