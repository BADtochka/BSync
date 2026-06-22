import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { OverlayPosition } from '@/lib/sync-state';
import { OVERLAY_SNAP_HOLD_MS } from './constants';
import { getApproachZones, getOverlayPanelSize, hitTestDropZone, type OverlayPanelSize } from './geometry';

type UseOverlaySnapOptions = {
  isDragging: boolean;
  panelRef: { current: HTMLDivElement | null };
};

export function useOverlaySnap({ isDragging, panelRef }: UseOverlaySnapOptions) {
  const [hintedZones, setHintedZones] = useState<OverlayPosition[]>([]);
  const [hoveredZone, setHoveredZone] = useState<OverlayPosition | null>(null);
  const [activeZone, setActiveZone] = useState<OverlayPosition | null>(null);
  const [panelSize, setPanelSize] = useState<OverlayPanelSize>({ width: 0, height: 0 });
  const panelSizeRef = useRef<OverlayPanelSize>({ width: 0, height: 0 });
  const holdTimerRef = useRef<number | null>(null);
  const holdZoneRef = useRef<OverlayPosition | null>(null);

  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current != null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  const resetSnap = useCallback(() => {
    clearHoldTimer();
    holdZoneRef.current = null;
    setHintedZones([]);
    setHoveredZone(null);
    setActiveZone(null);
  }, [clearHoldTimer]);

  const scheduleHold = useCallback(
    (zone: OverlayPosition | null) => {
      clearHoldTimer();
      holdZoneRef.current = zone;
      setHoveredZone(zone);
      setActiveZone(null);

      if (!zone) return;

      holdTimerRef.current = window.setTimeout(() => {
        setActiveZone(zone);
      }, OVERLAY_SNAP_HOLD_MS);
    },
    [clearHoldTimer],
  );

  const updateSnap = useCallback(
    (event: PointerEvent) => {
      const panel = panelRef.current;
      if (!panel) return;

      const nextPanelSize = getOverlayPanelSize(panel);
      panelSizeRef.current = nextPanelSize;
      setPanelSize(nextPanelSize);

      const panelRect = panel.getBoundingClientRect();
      const approachZones = getApproachZones(panelRect);
      const pointerZone = hitTestDropZone(event.clientX, event.clientY, nextPanelSize);
      const hints = [...new Set([...approachZones, ...(pointerZone ? [pointerZone] : [])])];

      setHintedZones(hints);

      if (pointerZone !== holdZoneRef.current) {
        scheduleHold(pointerZone);
      }
    },
    [panelRef, scheduleHold],
  );

  const resolveSnapPosition = useCallback((event: PointerEvent): OverlayPosition | null => {
    const size = panelRef.current ? getOverlayPanelSize(panelRef.current) : panelSizeRef.current;
    return activeZone ?? hitTestDropZone(event.clientX, event.clientY, size);
  }, [activeZone, panelRef]);

  useEffect(() => {
    if (!isDragging) {
      resetSnap();
      return;
    }

    const panel = panelRef.current;
    if (!panel) return;

    const nextPanelSize = getOverlayPanelSize(panel);
    panelSizeRef.current = nextPanelSize;
    setPanelSize(nextPanelSize);
  }, [isDragging, panelRef, resetSnap]);

  useEffect(() => () => clearHoldTimer(), [clearHoldTimer]);

  return {
    hintedZones,
    hoveredZone,
    activeZone,
    panelSize,
    updateSnap,
    resetSnap,
    resolveSnapPosition,
  };
}
