import { useEffect, useRef, useState, type MouseEvent, type RefObject } from 'react';

export interface TipAnchor {
  x: number;
  y: number;
  flipX: boolean;
  flipY: boolean;
}

/* A tooltip anchored inside a positioned wrapper, flipped away from the near edges */
export function useTip<T>(wrapRef: RefObject<HTMLElement | null>) {
  const [tip, setTip] = useState<(TipAnchor & { data: T }) | null>(null);
  const place = (e: MouseEvent, data: T) => {
    const box = wrapRef.current?.getBoundingClientRect();
    if (!box || !box.width) { return; }
    const x = e.clientX - box.left;
    const y = e.clientY - box.top;
    setTip({ x, y, flipX: x > box.width * 0.55, flipY: y > box.height * 0.6, data });
  };
  const clear = () => setTip(null);
  const style = tip ? {
    left: tip.x + 14,
    top: tip.y + 14,
    transform: `translate(${tip.flipX ? 'calc(-100% - 28px)' : '0'}, ${tip.flipY ? 'calc(-100% - 28px)' : '0'})`,
  } : undefined;
  return { tip: tip?.data ?? null, place, clear, style };
}

/* Width of an element, kept current as it resizes */
export function useWidth<T extends HTMLElement>(fallback = 600): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver !== 'function') { return; }
    const observer = new ResizeObserver(() => setWidth(el.clientWidth || fallback));
    observer.observe(el);
    setWidth(el.clientWidth || fallback);
    return () => observer.disconnect();
  }, [fallback]);
  return [ref, width];
}

/* A canvas sized for the device pixel ratio, drawn in CSS pixels. Null when there is no 2D
 * context (jsdom), which every chart treats as "do not draw" */
export function prepareCanvas(canvas: HTMLCanvasElement | null, width: number, height: number): CanvasRenderingContext2D | null {
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) { return null; }
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return ctx;
}
