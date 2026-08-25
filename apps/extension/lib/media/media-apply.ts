export type MediaApplyTabTarget<TCandidate> = {
  tabId: number;
  active: boolean;
  candidate: TCandidate;
  candidateKey: string;
};

export function selectMediaApplyTarget<TTarget extends MediaApplyTabTarget<unknown>>(
  targets: TTarget[],
): TTarget | null {
  return (
    [...targets].sort(
      (left, right) => Number(right.active) - Number(left.active) || left.tabId - right.tabId,
    )[0] ?? null
  );
}
