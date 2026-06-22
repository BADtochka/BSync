import type { OverlayPosition } from '@/lib/sync-state';
import {
  OVERLAY_APPROACH_DISTANCE,
  OVERLAY_CORNER_INSET,
  OVERLAY_DROP_ZONE_PADDING,
  OVERLAY_VIEWPORT_MARGIN,
} from './constants';

export type DragOffset = { x: number; y: number };

export type DragAnchor = {
  pointerX: number;
  pointerY: number;
  offsetX: number;
  offsetY: number;
};

export type OverlayPanelSize = {
  width: number;
  height: number;
};

export type DropZoneRect = {
  position: OverlayPosition;
  left: number;
  top: number;
  width: number;
  height: number;
};

export const OVERLAY_POSITIONS: OverlayPosition[] = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
];

export const OVERLAY_POSITION_LABELS: Record<OverlayPosition, string> = {
  'top-left': 'TL',
  'top-right': 'TR',
  'bottom-left': 'BL',
  'bottom-right': 'BR',
};

export function getViewportBounds() {
  const viewport = window.visualViewport;
  if (!viewport) {
    return {
      left: OVERLAY_VIEWPORT_MARGIN,
      top: OVERLAY_VIEWPORT_MARGIN,
      right: window.innerWidth - OVERLAY_VIEWPORT_MARGIN,
      bottom: window.innerHeight - OVERLAY_VIEWPORT_MARGIN,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  }

  return {
    left: viewport.offsetLeft + OVERLAY_VIEWPORT_MARGIN,
    top: viewport.offsetTop + OVERLAY_VIEWPORT_MARGIN,
    right: viewport.offsetLeft + viewport.width - OVERLAY_VIEWPORT_MARGIN,
    bottom: viewport.offsetTop + viewport.height - OVERLAY_VIEWPORT_MARGIN,
    width: viewport.width,
    height: viewport.height,
  };
}

export function getOverlayPanelSize(panel: HTMLElement | null): OverlayPanelSize {
  if (!panel) {
    return { width: 0, height: 0 };
  }

  const rect = panel.getBoundingClientRect();
  return {
    width: rect.width,
    height: rect.height,
  };
}

export function getDropZoneRects(panelSize: OverlayPanelSize): DropZoneRect[] {
  const padding = OVERLAY_DROP_ZONE_PADDING;
  const zoneWidth = panelSize.width + padding * 2;
  const zoneHeight = panelSize.height + padding * 2;
  const inset = OVERLAY_CORNER_INSET;
  const bounds = getViewportBounds();
  const anchorLeft = bounds.left - OVERLAY_VIEWPORT_MARGIN + inset;
  const anchorTop = bounds.top - OVERLAY_VIEWPORT_MARGIN + inset;

  return [
    {
      position: 'top-left',
      left: anchorLeft - padding,
      top: anchorTop - padding,
      width: zoneWidth,
      height: zoneHeight,
    },
    {
      position: 'top-right',
      left: bounds.right - zoneWidth - inset + OVERLAY_VIEWPORT_MARGIN,
      top: anchorTop - padding,
      width: zoneWidth,
      height: zoneHeight,
    },
    {
      position: 'bottom-left',
      left: anchorLeft - padding,
      top: bounds.bottom - zoneHeight - inset + OVERLAY_VIEWPORT_MARGIN,
      width: zoneWidth,
      height: zoneHeight,
    },
    {
      position: 'bottom-right',
      left: bounds.right - zoneWidth - inset + OVERLAY_VIEWPORT_MARGIN,
      top: bounds.bottom - zoneHeight - inset + OVERLAY_VIEWPORT_MARGIN,
      width: zoneWidth,
      height: zoneHeight,
    },
  ];
}

export function hitTestDropZone(
  clientX: number,
  clientY: number,
  panelSize: OverlayPanelSize,
): OverlayPosition | null {
  for (const zone of getDropZoneRects(panelSize)) {
    if (
      clientX >= zone.left &&
      clientX <= zone.left + zone.width &&
      clientY >= zone.top &&
      clientY <= zone.top + zone.height
    ) {
      return zone.position;
    }
  }

  return null;
}

export function getApproachZones(panelRect: DOMRect): OverlayPosition[] {
  const bounds = getViewportBounds();
  const distance = OVERLAY_APPROACH_DISTANCE;
  const zones: OverlayPosition[] = [];

  if (panelRect.top - bounds.top <= distance && panelRect.left - bounds.left <= distance) {
    zones.push('top-left');
  }

  if (panelRect.top - bounds.top <= distance && bounds.right - panelRect.right <= distance) {
    zones.push('top-right');
  }

  if (bounds.bottom - panelRect.bottom <= distance && panelRect.left - bounds.left <= distance) {
    zones.push('bottom-left');
  }

  if (bounds.bottom - panelRect.bottom <= distance && bounds.right - panelRect.right <= distance) {
    zones.push('bottom-right');
  }

  return zones;
}

export function clampDragOffset(
  panel: HTMLElement | null,
  offset: DragOffset,
  currentOffset: DragOffset = offset,
): DragOffset {
  if (!panel) return offset;

  const rect = panel.getBoundingClientRect();
  const deltaX = offset.x - currentOffset.x;
  const deltaY = offset.y - currentOffset.y;
  const projectedLeft = rect.left + deltaX;
  const projectedRight = rect.right + deltaX;
  const projectedTop = rect.top + deltaY;
  const projectedBottom = rect.bottom + deltaY;
  const bounds = getViewportBounds();

  let adjustX = 0;
  let adjustY = 0;

  if (projectedLeft < bounds.left) {
    adjustX = bounds.left - projectedLeft;
  } else if (projectedRight > bounds.right) {
    adjustX = bounds.right - projectedRight;
  }

  if (projectedTop < bounds.top) {
    adjustY = bounds.top - projectedTop;
  } else if (projectedBottom > bounds.bottom) {
    adjustY = bounds.bottom - projectedBottom;
  }

  if (adjustX === 0 && adjustY === 0) return offset;

  return {
    x: offset.x + adjustX,
    y: offset.y + adjustY,
  };
}
