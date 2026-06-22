import { useEffect, useRef, useState } from 'preact/hooks';
import type { OverlayPosition } from '@/lib/sync-state';
import { OVERLAY_DROP_GUIDES_FADE_MS } from './constants';
import { getDropZoneRects, OVERLAY_POSITION_LABELS, type OverlayPanelSize } from './geometry';

type OverlayDropGuidesProps = {
  visible: boolean;
  currentPosition: OverlayPosition;
  panelSize: OverlayPanelSize;
  hintedZones: OverlayPosition[];
  hoveredZone: OverlayPosition | null;
  activeZone: OverlayPosition | null;
};

type GuidesPhase = 'hidden' | 'entering' | 'visible' | 'exiting';

export function OverlayDropGuides({
  visible,
  currentPosition,
  panelSize,
  hintedZones,
  hoveredZone,
  activeZone,
}: OverlayDropGuidesProps) {
  const [phase, setPhase] = useState<GuidesPhase>(visible ? 'entering' : 'hidden');
  const exitTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (exitTimerRef.current != null) {
      window.clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }

    if (visible) {
      setPhase('entering');
      const frame = window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          setPhase('visible');
        });
      });
      return () => window.cancelAnimationFrame(frame);
    }

    setPhase((current) => (current === 'hidden' ? 'hidden' : 'exiting'));
    exitTimerRef.current = window.setTimeout(() => {
      setPhase('hidden');
      exitTimerRef.current = null;
    }, OVERLAY_DROP_GUIDES_FADE_MS);

    return () => {
      if (exitTimerRef.current != null) {
        window.clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
    };
  }, [visible]);

  useEffect(() => () => {
    if (exitTimerRef.current != null) {
      window.clearTimeout(exitTimerRef.current);
    }
  }, []);

  if (phase === 'hidden' || panelSize.width <= 0 || panelSize.height <= 0) return null;

  return (
    <div
      className={[
        'bsync-drop-guides',
        phase === 'entering' ? 'is-entering' : '',
        phase === 'visible' ? 'is-visible' : '',
        phase === 'exiting' ? 'is-exiting' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-hidden="true"
    >
      {getDropZoneRects(panelSize).map((zone) => {
        const isCurrent = currentPosition === zone.position;
        const isHinted = hintedZones.includes(zone.position);
        const isHovered = hoveredZone === zone.position;
        const isActive = activeZone === zone.position;

        return (
          <div
            key={zone.position}
            className={[
              'bsync-drop-zone',
              `bsync-drop-zone--${zone.position}`,
              isCurrent ? 'is-current' : '',
              isHinted ? 'is-hinted' : '',
              isHovered ? 'is-hovered' : '',
              isActive ? 'is-active' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            style={{
              left: `${zone.left}px`,
              top: `${zone.top}px`,
              width: `${zone.width}px`,
              height: `${zone.height}px`,
            }}
          >
            <span>{OVERLAY_POSITION_LABELS[zone.position]}</span>
          </div>
        );
      })}
    </div>
  );
}
