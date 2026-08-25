export const DEFAULT_MEDIA_STALE_AFTER_MS = 5_000;
export const DEFAULT_MEDIA_GRACE_MS = 3_000;
export const DEFAULT_HYSTERESIS_RATIO = 1.25;
export const MIN_MEANINGFUL_DURATION_SECONDS = 30;

export interface MediaCandidateReport {
  tabId: number;
  frameId: number;
  documentId: string;
  mediaKey: string;
  url: string;
  paused: boolean;
  currentTime: number;
  duration: number | null;
  readyState: number;
  visible: boolean;
  viewportArea?: number;
  lastPlayingAt?: number;
}

export interface MediaCandidate extends MediaCandidateReport {
  lastSeenAt: number;
}

export interface MediaCandidateScore {
  playing: 0 | 1;
  visible: 0 | 1;
  viewportArea: number;
  meaningfulDuration: number;
  lastPlayingAt: number;
}

export type MediaSelectionStatus = 'selected' | 'reacquiring' | 'no-candidate';

export interface MediaSelectionSnapshot {
  tabId: number;
  status: MediaSelectionStatus;
  candidate: MediaCandidate | null;
  selectedKey: string | null;
  changedAt: number;
  graceExpiresAt: number | null;
}

export interface MediaCandidateIdentity {
  tabId: number;
  frameId: number;
  documentId: string;
  mediaKey: string;
}

export interface MediaRegistryOptions {
  staleAfterMs?: number;
  graceMs?: number;
  hysteresisRatio?: number;
}

interface TabRegistry {
  candidates: Map<string, MediaCandidate>;
  frameDocuments: Map<number, string>;
  selectedKey: string | null;
  emptySince: number | null;
  changedAt: number;
}

function finiteNonNegative(value: number | undefined | null): number {
  return Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
}

function candidateKey(candidate: MediaCandidateIdentity): string {
  return `${candidate.frameId}\u0000${candidate.documentId}\u0000${candidate.mediaKey}`;
}

function deterministicKey(candidate: MediaCandidate): string {
  return `${String(candidate.tabId).padStart(16, '0')}\u0000${String(candidate.frameId).padStart(16, '0')}\u0000${candidate.documentId}\u0000${candidate.mediaKey}`;
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function scoreMediaCandidate(candidate: MediaCandidate): MediaCandidateScore {
  const duration = finiteNonNegative(candidate.duration);

  return {
    playing: candidate.paused ? 0 : 1,
    visible: candidate.visible ? 1 : 0,
    viewportArea: finiteNonNegative(candidate.viewportArea),
    meaningfulDuration: duration >= MIN_MEANINGFUL_DURATION_SECONDS ? duration : 0,
    lastPlayingAt: finiteNonNegative(candidate.lastPlayingAt),
  };
}

/** Returns a positive number when left is preferred, and uses identity for exact ties. */
export function compareMediaCandidates(left: MediaCandidate, right: MediaCandidate): number {
  const leftScore = scoreMediaCandidate(left);
  const rightScore = scoreMediaCandidate(right);
  const fields: (keyof MediaCandidateScore)[] = [
    'playing',
    'visible',
    'viewportArea',
    'meaningfulDuration',
    'lastPlayingAt',
  ];

  for (const field of fields) {
    const difference = leftScore[field] - rightScore[field];
    if (difference !== 0) return difference;
  }

  return compareKeys(deterministicKey(right), deterministicKey(left));
}

export class MediaRegistry {
  readonly staleAfterMs: number;
  readonly graceMs: number;
  readonly hysteresisRatio: number;

  private readonly tabs = new Map<number, TabRegistry>();

  constructor(options: MediaRegistryOptions = {}) {
    this.staleAfterMs = finiteNonNegative(
      options.staleAfterMs ?? DEFAULT_MEDIA_STALE_AFTER_MS,
    );
    this.graceMs = finiteNonNegative(options.graceMs ?? DEFAULT_MEDIA_GRACE_MS);
    this.hysteresisRatio = Math.max(1, options.hysteresisRatio ?? DEFAULT_HYSTERESIS_RATIO);
  }

  report(report: MediaCandidateReport, now: number): MediaSelectionSnapshot {
    const tab = this.getOrCreateTab(report.tabId, now);
    this.pruneTab(tab, now);

    const previousDocument = tab.frameDocuments.get(report.frameId);
    if (previousDocument !== undefined && previousDocument !== report.documentId) {
      for (const [key, candidate] of tab.candidates) {
        if (candidate.frameId === report.frameId) tab.candidates.delete(key);
      }
      if (tab.selectedKey && !tab.candidates.has(tab.selectedKey)) tab.selectedKey = null;
    }

    tab.frameDocuments.set(report.frameId, report.documentId);
    const key = candidateKey(report);
    const previous = tab.candidates.get(key);
    tab.candidates.set(key, {
      ...report,
      lastPlayingAt: report.lastPlayingAt ?? previous?.lastPlayingAt,
      lastSeenAt: now,
    });

    return this.select(report.tabId, tab, now);
  }

  remove(identity: MediaCandidateIdentity, now: number): MediaSelectionSnapshot {
    const tab = this.tabs.get(identity.tabId);
    if (!tab) return this.emptySnapshot(identity.tabId, now);

    this.pruneTab(tab, now);
    const key = candidateKey(identity);
    if (tab.candidates.delete(key) && tab.selectedKey === key) tab.selectedKey = null;
    return this.select(identity.tabId, tab, now);
  }

  removeFrame(tabId: number, frameId: number, now: number): MediaSelectionSnapshot {
    const tab = this.tabs.get(tabId);
    if (!tab) return this.emptySnapshot(tabId, now);

    this.pruneTab(tab, now);
    for (const [key, candidate] of tab.candidates) {
      if (candidate.frameId === frameId) tab.candidates.delete(key);
    }
    tab.frameDocuments.delete(frameId);
    if (tab.selectedKey && !tab.candidates.has(tab.selectedKey)) tab.selectedKey = null;
    return this.select(tabId, tab, now);
  }

  removeTab(tabId: number, now: number): MediaSelectionSnapshot {
    this.tabs.delete(tabId);
    return this.emptySnapshot(tabId, now);
  }

  pruneStale(now: number): number {
    let removed = 0;
    for (const tab of this.tabs.values()) removed += this.pruneTab(tab, now);
    return removed;
  }

  selectionSnapshot(tabId: number, now: number): MediaSelectionSnapshot {
    const tab = this.tabs.get(tabId);
    if (!tab) return this.emptySnapshot(tabId, now);

    this.pruneTab(tab, now);
    return this.select(tabId, tab, now);
  }

  observeTab(tabId: number, now: number): MediaSelectionSnapshot {
    return this.select(tabId, this.getOrCreateTab(tabId, now), now);
  }

  selectionSnapshots(now: number): MediaSelectionSnapshot[] {
    return [...this.tabs.keys()]
      .sort((left, right) => left - right)
      .map((tabId) => this.selectionSnapshot(tabId, now));
  }

  private getOrCreateTab(tabId: number, now: number): TabRegistry {
    let tab = this.tabs.get(tabId);
    if (!tab) {
      tab = {
        candidates: new Map(),
        frameDocuments: new Map(),
        selectedKey: null,
        emptySince: null,
        changedAt: now,
      };
      this.tabs.set(tabId, tab);
    }
    return tab;
  }

  private pruneTab(tab: TabRegistry, now: number): number {
    let removed = 0;
    let earliestExpiry = Number.POSITIVE_INFINITY;

    for (const [key, candidate] of tab.candidates) {
      const expiresAt = candidate.lastSeenAt + this.staleAfterMs;
      if (now < expiresAt) continue;
      earliestExpiry = Math.min(earliestExpiry, expiresAt);
      tab.candidates.delete(key);
      removed += 1;
    }

    if (tab.selectedKey && !tab.candidates.has(tab.selectedKey)) tab.selectedKey = null;
    if (removed > 0 && tab.candidates.size === 0 && tab.emptySince == null) {
      tab.emptySince = earliestExpiry;
      tab.changedAt = earliestExpiry;
    }
    return removed;
  }

  private select(tabId: number, tab: TabRegistry, now: number): MediaSelectionSnapshot {
    if (tab.candidates.size === 0) {
      if (tab.emptySince == null) {
        tab.emptySince = now;
        tab.changedAt = now;
      }
      tab.selectedKey = null;
      const graceExpiresAt = tab.emptySince + this.graceMs;
      return {
        tabId,
        status: now < graceExpiresAt ? 'reacquiring' : 'no-candidate',
        candidate: null,
        selectedKey: null,
        changedAt: tab.changedAt,
        graceExpiresAt,
      };
    }

    tab.emptySince = null;
    const ranked = [...tab.candidates.entries()].sort((left, right) => {
      const preference = compareMediaCandidates(right[1], left[1]);
      return preference || compareKeys(left[0], right[0]);
    });
    const best = ranked[0];
    if (!best) return this.emptySnapshot(tabId, now);

    const current = tab.selectedKey ? tab.candidates.get(tab.selectedKey) : undefined;
    const next = current && !this.shouldReplace(current, best[1])
      ? [tab.selectedKey as string, current] as const
      : best;

    if (tab.selectedKey !== next[0]) tab.changedAt = now;
    tab.selectedKey = next[0];
    return {
      tabId,
      status: 'selected',
      candidate: { ...next[1] },
      selectedKey: next[0],
      changedAt: tab.changedAt,
      graceExpiresAt: null,
    };
  }

  private shouldReplace(current: MediaCandidate, challenger: MediaCandidate): boolean {
    if (candidateKey(current) === candidateKey(challenger)) return false;
    const currentScore = scoreMediaCandidate(current);
    const challengerScore = scoreMediaCandidate(challenger);

    if (challengerScore.playing !== currentScore.playing) {
      return challengerScore.playing > currentScore.playing;
    }
    if (challengerScore.visible !== currentScore.visible) {
      return challengerScore.visible > currentScore.visible;
    }
    if (challengerScore.viewportArea !== currentScore.viewportArea) {
      return challengerScore.viewportArea > currentScore.viewportArea * this.hysteresisRatio;
    }
    if (challengerScore.meaningfulDuration !== currentScore.meaningfulDuration) {
      return challengerScore.meaningfulDuration > currentScore.meaningfulDuration * this.hysteresisRatio;
    }

    if (challengerScore.lastPlayingAt !== currentScore.lastPlayingAt) return false;

    // Resolve exact score ties independently of report arrival order.
    return compareMediaCandidates(challenger, current) > 0;
  }

  private emptySnapshot(tabId: number, now: number): MediaSelectionSnapshot {
    return {
      tabId,
      status: 'no-candidate',
      candidate: null,
      selectedKey: null,
      changedAt: now,
      graceExpiresAt: null,
    };
  }
}
