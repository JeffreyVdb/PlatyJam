import type { WebGLRenderer } from 'three';
import { createEventBus, type EventBus } from './events';
import type { ViewportSize } from './viewport';

/**
 * App lifecycle events other modules subscribe to:
 *
 *   const off = lifecycle.on('pause', () => audio.suspend());
 */
export interface LifecycleEvents {
  /** The page went to the background. Save progress here; nothing renders until `resume`. */
  pause: { reason: 'hidden' | 'pagehide' };
  /** The page is visible again. */
  resume: { reason: 'visible' | 'pageshow' };
  /** The WebGL context is gone. GPU resources are invalid; rendering has stopped. */
  contextlost: { canvas: HTMLCanvasElement };
  /**
   * Rendering can start again. Rebuild every GPU resource (geometries, materials,
   * textures) against `renderer`. `recreated` is true when the old renderer never
   * recovered and a new renderer and canvas replaced it (WebKit bug 278010).
   */
  contextrestored: { renderer: WebGLRenderer; recreated: boolean };
  /** No working WebGL context could be created. */
  contextfailed: { error: unknown };
  /** The drawing surface changed size. Sizes are CSS pixels. */
  resize: ViewportSize;
  /** A Cache API or IndexedDB write hit the storage quota and was skipped. */
  storagequotaexceeded: { context: string; error: unknown };
}

export type Lifecycle = EventBus<LifecycleEvents>;

export function createLifecycle(): Lifecycle {
  return createEventBus<LifecycleEvents>();
}

/** The app-wide lifecycle bus. */
export const lifecycle: Lifecycle = createLifecycle();

/**
 * Maps page visibility to `pause` / `resume`, emitting each transition once.
 *
 * `visibilitychange` is the last event reliably delivered on iPadOS before the app
 * is suspended, so it is the primary signal; `pagehide` / `pageshow` cover bfcache.
 */
export function installPageLifecycle(bus: Lifecycle, win: Window = window): () => void {
  const doc = win.document;
  let paused = doc.visibilityState === 'hidden';

  const pause = (reason: LifecycleEvents['pause']['reason']) => {
    if (paused) return;
    paused = true;
    bus.emit('pause', { reason });
  };
  const resume = (reason: LifecycleEvents['resume']['reason']) => {
    if (!paused || doc.visibilityState === 'hidden') return;
    paused = false;
    bus.emit('resume', { reason });
  };

  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') pause('hidden');
    else resume('visible');
  };
  const onPageHide = () => {
    pause('pagehide');
  };
  const onPageShow = () => {
    resume('pageshow');
  };

  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('pagehide', onPageHide);
  win.addEventListener('pageshow', onPageShow);

  return () => {
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('pagehide', onPageHide);
    win.removeEventListener('pageshow', onPageShow);
  };
}
