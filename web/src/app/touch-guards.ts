/**
 * Stops iPadOS from treating play as page gestures: scrolling, double-tap zoom,
 * pinch zoom, the long-press magnifier loupe and the callout menu.
 *
 * The touch listeners sit on the play surface, the element that wraps the canvas,
 * rather than on the canvas itself, so they survive the renderer swapping in a new
 * canvas after a lost context. HUD controls live outside that element and stay
 * ordinary, tappable buttons.
 *
 * Calling preventDefault on `touchstart` also suppresses the click events iOS would
 * synthesise from those touches. Game input on the play surface must therefore use
 * Pointer Events (`pointerdown` / `pointerup`), never `click`.
 *
 * Every listener that calls preventDefault is registered with `passive: false`;
 * iOS ignores preventDefault from passive listeners.
 */
export function installTouchGuards(surface: HTMLElement, doc: Document = document): () => void {
  const block = (event: Event) => {
    event.preventDefault();
  };
  const active: AddEventListenerOptions = { passive: false };

  surface.addEventListener('touchstart', block, active);
  surface.addEventListener('touchmove', block, active);
  // WebKit-only pinch events; belt and braces next to `touch-action: none`.
  for (const type of GESTURE_EVENTS) doc.addEventListener(type, block, active);
  doc.addEventListener('contextmenu', block);

  return () => {
    surface.removeEventListener('touchstart', block, active);
    surface.removeEventListener('touchmove', block, active);
    for (const type of GESTURE_EVENTS) doc.removeEventListener(type, block, active);
    doc.removeEventListener('contextmenu', block);
  };
}

const GESTURE_EVENTS = ['gesturestart', 'gesturechange', 'gestureend'] as const;
