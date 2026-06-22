import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { clampDragOffset, type DragAnchor, type DragOffset } from './geometry';

type ElementRef = { current: HTMLDivElement | null };

type UseOverlayDragOptions = {
  panelRef: ElementRef;
  gripRef: ElementRef;
  watchKey?: string;
  onMove?: (event: PointerEvent) => void;
  onEnd?: (event: PointerEvent) => void;
};

export function useOverlayDrag({
  panelRef,
  gripRef,
  watchKey = '',
  onMove,
  onEnd,
}: UseOverlayDragOptions) {
  const [dragOffset, setDragOffset] = useState<DragOffset>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const dragOffsetRef = useRef<DragOffset>({ x: 0, y: 0 });
  const dragAnchorRef = useRef<DragAnchor>({ pointerX: 0, pointerY: 0, offsetX: 0, offsetY: 0 });
  const onMoveRef = useRef(onMove);
  const onEndRef = useRef(onEnd);

  useEffect(() => {
    onMoveRef.current = onMove;
  }, [onMove]);

  useEffect(() => {
    onEndRef.current = onEnd;
  }, [onEnd]);

  const applyViewportClamp = useCallback(() => {
    const clamped = clampDragOffset(panelRef.current, dragOffsetRef.current);
    if (clamped.x === dragOffsetRef.current.x && clamped.y === dragOffsetRef.current.y) return;

    dragOffsetRef.current = clamped;
    setDragOffset(clamped);
  }, [panelRef]);

  const resetDragOffset = useCallback(() => {
    dragOffsetRef.current = { x: 0, y: 0 };
    setDragOffset({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    isDraggingRef.current = isDragging;
  }, [isDragging]);

  useEffect(() => {
    dragOffsetRef.current = dragOffset;
  }, [dragOffset]);

  useEffect(() => {
    const keepOverlayInViewport = () => {
      applyViewportClamp();
    };

    window.addEventListener('resize', keepOverlayInViewport);
    window.addEventListener('focus', keepOverlayInViewport);
    document.addEventListener('visibilitychange', keepOverlayInViewport);
    window.visualViewport?.addEventListener('resize', keepOverlayInViewport);
    window.visualViewport?.addEventListener('scroll', keepOverlayInViewport);

    return () => {
      window.removeEventListener('resize', keepOverlayInViewport);
      window.removeEventListener('focus', keepOverlayInViewport);
      document.removeEventListener('visibilitychange', keepOverlayInViewport);
      window.visualViewport?.removeEventListener('resize', keepOverlayInViewport);
      window.visualViewport?.removeEventListener('scroll', keepOverlayInViewport);
    };
  }, [applyViewportClamp]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    const observer = new ResizeObserver(() => {
      applyViewportClamp();
    });

    observer.observe(panel);
    return () => observer.disconnect();
  }, [applyViewportClamp, panelRef, watchKey]);

  useEffect(() => {
    const grip = gripRef.current;
    if (!grip) return;

    const endDrag = (event: PointerEvent) => {
      isDraggingRef.current = false;
      setIsDragging(false);
      applyViewportClamp();
      onEndRef.current?.(event);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!isDraggingRef.current) return;

      const panel = panelRef.current;
      if (!panel) return;

      const anchor = dragAnchorRef.current;
      const nextOffset = {
        x: anchor.offsetX + (event.clientX - anchor.pointerX),
        y: anchor.offsetY + (event.clientY - anchor.pointerY),
      };
      const clamped = clampDragOffset(panel, nextOffset, dragOffsetRef.current);
      if (clamped.x !== dragOffsetRef.current.x || clamped.y !== dragOffsetRef.current.y) {
        dragOffsetRef.current = clamped;
        setDragOffset(clamped);
      }

      onMoveRef.current?.(event);
    };

    grip.addEventListener('pointermove', onPointerMove);
    grip.addEventListener('pointerup', endDrag);
    grip.addEventListener('pointercancel', endDrag);
    grip.addEventListener('lostpointercapture', endDrag);

    return () => {
      grip.removeEventListener('pointermove', onPointerMove);
      grip.removeEventListener('pointerup', endDrag);
      grip.removeEventListener('pointercancel', endDrag);
      grip.removeEventListener('lostpointercapture', endDrag);
    };
  }, [applyViewportClamp, gripRef, panelRef, watchKey]);

  const onGripPointerDown = useCallback((event: PointerEvent) => {
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    isDraggingRef.current = true;
    dragAnchorRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      offsetX: dragOffsetRef.current.x,
      offsetY: dragOffsetRef.current.y,
    };
    setIsDragging(true);
  }, []);

  return {
    dragOffset,
    isDragging,
    onGripPointerDown,
    applyViewportClamp,
    resetDragOffset,
  };
}
