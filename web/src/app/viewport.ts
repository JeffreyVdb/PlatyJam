/** iPad Pro panels are 2x; anything above that only costs fill rate. */
export const MAX_PIXEL_RATIO = 2;

/**
 * Some iPadOS builds report the previous orientation's size inside the events
 * (WebKit 170595, 218983), so the size is measured once more after this delay.
 */
export const ORIENTATION_REMEASURE_MS = 250;

export interface ViewportSize {
  /** CSS pixels. */
  width: number;
  /** CSS pixels. */
  height: number;
  /** Device pixels per CSS pixel to render at, already capped. */
  pixelRatio: number;
}

export function capPixelRatio(devicePixelRatio: number, max = MAX_PIXEL_RATIO): number {
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) return 1;
  return Math.min(devicePixelRatio, max);
}

/** Rounds a measured CSS box into a render size that is never zero. */
export function computeViewportSize(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  maxPixelRatio = MAX_PIXEL_RATIO,
): ViewportSize {
  return {
    width: Math.max(1, Math.round(cssWidth)),
    height: Math.max(1, Math.round(cssHeight)),
    pixelRatio: capPixelRatio(devicePixelRatio, maxPixelRatio),
  };
}

export function sameViewportSize(a: ViewportSize | undefined, b: ViewportSize): boolean {
  return a?.width === b.width && a.height === b.height && a.pixelRatio === b.pixelRatio;
}

export interface ViewportWatchOptions {
  win?: Window;
  /** Measures the drawing surface in CSS pixels. CSS owns its size; we only read it. */
  measure: () => { width: number; height: number };
  /** Called with the first size, then only when the size actually changes. */
  onChange: (size: ViewportSize) => void;
}

/**
 * Watches `resize`, `visualViewport` resize and orientation changes. Reads are deferred
 * to the next animation frame and coalesced; phantom resizes with no size change
 * (iOS toolbar and tab events) are dropped.
 */
export function watchViewport({ win = window, measure, onChange }: ViewportWatchOptions): {
  /** Measures now, bypassing the frame debounce. */
  measureNow: () => void;
  dispose: () => void;
} {
  let last: ViewportSize | undefined;
  let frame = 0;
  const timers = new Set<number>();

  const measureNow = () => {
    frame = 0;
    const { width, height } = measure();
    const next = computeViewportSize(width, height, win.devicePixelRatio);
    if (sameViewportSize(last, next)) return;
    last = next;
    onChange(next);
  };

  const schedule = () => {
    if (frame !== 0) win.cancelAnimationFrame(frame);
    frame = win.requestAnimationFrame(measureNow);
  };

  const onOrientation = () => {
    schedule();
    const timer = win.setTimeout(() => {
      timers.delete(timer);
      schedule();
    }, ORIENTATION_REMEASURE_MS);
    timers.add(timer);
  };

  // Missing before iPadOS 16.4 despite what lib.dom says.
  const { orientation } = win.screen as Partial<Screen>;

  win.addEventListener('resize', schedule);
  win.visualViewport?.addEventListener('resize', schedule);
  // `orientationchange` is deprecated but is what iPadOS reliably fires;
  // `screen.orientation` is the standard replacement where it exists.
  win.addEventListener('orientationchange', onOrientation);
  orientation?.addEventListener('change', onOrientation);

  measureNow();

  return {
    measureNow,
    dispose() {
      win.removeEventListener('resize', schedule);
      win.visualViewport?.removeEventListener('resize', schedule);
      win.removeEventListener('orientationchange', onOrientation);
      orientation?.removeEventListener('change', onOrientation);
      if (frame !== 0) win.cancelAnimationFrame(frame);
      for (const timer of timers) win.clearTimeout(timer);
      timers.clear();
    },
  };
}
