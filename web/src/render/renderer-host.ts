import { Timer, WebGLRenderer } from 'three';
import type { Lifecycle } from '../app/lifecycle';
import type { ViewportSize } from '../app/viewport';

/** Longest frame step we simulate; a stall or a resume never jumps the song further. */
export const MAX_FRAME_DELTA_S = 0.1;

/**
 * How long a lost context may stay lost while the page is visible before we give up
 * waiting for `webglcontextrestored` and build a new renderer. Works around WebKit
 * 278010, where after a loss on ANGLE/Metal the restore never arrives or the
 * restored context stays broken.
 */
export const STUCK_CONTEXT_TIMEOUT_MS = 3000;

/** Replacement renderers to try in a row before declaring the GPU unusable. */
export const MAX_RENDERER_RECREATIONS = 3;

export type FrameCallback = (deltaSeconds: number, renderer: WebGLRenderer) => void;

export interface RendererHostState {
  running: boolean;
  paused: boolean;
  contextLost: boolean;
  recreations: number;
  frames: number;
}

export interface RendererHost {
  /** The current renderer. It changes after a recreation, so never cache it. */
  readonly renderer: WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  setFrame(callback: FrameCallback): void;
  /** Debug: drops the context through WEBGL_lose_context. */
  loseContext(): void;
  /** Debug: brings a context dropped with loseContext() back. */
  restoreContext(): void;
  state(): RendererHostState;
  dispose(): void;
}

export interface RendererHostOptions {
  /** Element the canvas is placed in. Its CSS owns the canvas size. */
  surface: HTMLElement;
  bus: Lifecycle;
  doc?: Document;
  createRenderer?: (canvas: HTMLCanvasElement) => WebGLRenderer;
  stuckTimeoutMs?: number;
  maxRecreations?: number;
}

export function createWebGLRenderer(canvas: HTMLCanvasElement): WebGLRenderer {
  return new WebGLRenderer({
    canvas,
    // MSAA only below 2x density: on iPad's 2x panels edges are already fine and
    // skipping it saves memory bandwidth. Desktop 1x screens keep smooth edges.
    antialias: window.devicePixelRatio < 2,
    alpha: false,
    powerPreference: 'high-performance',
  });
}

/**
 * Owns the canvas, the WebGL renderer and the animation loop.
 *
 * The loop runs only while the page is visible and the context is alive; it stops
 * with `setAnimationLoop(null)` and the frame timer is reset on restart, so deltas
 * never include time spent paused. Lifecycle events drive it:
 * `pause`/`resume`/`resize` in, `contextlost`/`contextrestored`/`contextfailed` out.
 */
export function createRendererHost({
  surface,
  bus,
  doc = document,
  createRenderer = createWebGLRenderer,
  stuckTimeoutMs = STUCK_CONTEXT_TIMEOUT_MS,
  maxRecreations = MAX_RENDERER_RECREATIONS,
}: RendererHostOptions): RendererHost {
  const timer = new Timer();
  let frame: FrameCallback | undefined;
  let size: ViewportSize | undefined;
  let paused = doc.visibilityState === 'hidden';
  let lost = false;
  let running = false;
  let recreations = 0;
  let frames = 0;
  let stuckTimer: ReturnType<typeof setTimeout> | undefined;

  let canvas!: HTMLCanvasElement;
  let renderer!: WebGLRenderer;

  const tick = (time: number) => {
    timer.update(time);
    frames += 1;
    frame?.(Math.min(timer.getDelta(), MAX_FRAME_DELTA_S), renderer);
  };

  const sync = () => {
    const shouldRun = frame !== undefined && !paused && !lost;
    if (shouldRun === running) return;
    running = shouldRun;
    if (running) {
      // Restart from "now" so the first delta after a pause is a single frame.
      timer.reset();
      renderer.setAnimationLoop(tick);
    } else {
      renderer.setAnimationLoop(null);
    }
  };

  const applySize = () => {
    if (!size) return;
    renderer.setPixelRatio(size.pixelRatio);
    // `false`: leave canvas.style alone, CSS owns the element size.
    renderer.setSize(size.width, size.height, false);
  };

  const clearStuckTimer = () => {
    if (stuckTimer !== undefined) clearTimeout(stuckTimer);
    stuckTimer = undefined;
  };

  const armStuckTimer = () => {
    clearStuckTimer();
    // A hidden page is expected to sit without a context; only count visible time.
    if (!lost || paused) return;
    stuckTimer = setTimeout(recreate, stuckTimeoutMs);
  };

  const onContextLost = (event: Event) => {
    // Without preventDefault the browser never offers a restore.
    event.preventDefault();
    lost = true;
    sync();
    bus.emit('contextlost', { canvas });
    armStuckTimer();
  };

  const onContextRestored = () => {
    clearStuckTimer();
    lost = false;
    recreations = 0;
    bus.emit('contextrestored', { renderer, recreated: false });
    sync();
  };

  const mount = () => {
    canvas = doc.createElement('canvas');
    canvas.className = 'stage-canvas';
    canvas.addEventListener('webglcontextlost', onContextLost);
    canvas.addEventListener('webglcontextrestored', onContextRestored);
    try {
      renderer = createRenderer(canvas);
    } catch (error) {
      unmountListeners();
      throw error;
    }
    surface.prepend(canvas);
    applySize();
  };

  const unmountListeners = () => {
    canvas.removeEventListener('webglcontextlost', onContextLost);
    canvas.removeEventListener('webglcontextrestored', onContextRestored);
  };

  const unmount = () => {
    unmountListeners();
    renderer.setAnimationLoop(null);
    renderer.dispose();
    canvas.remove();
  };

  function recreate() {
    stuckTimer = undefined;
    if (!lost) return;
    if (recreations >= maxRecreations) {
      bus.emit('contextfailed', { error: new Error('WebGL context did not come back') });
      return;
    }
    recreations += 1;
    console.warn(`[platyjam] WebGL context stuck; recreating renderer (${recreations})`);
    running = false;
    unmount();
    try {
      mount();
    } catch (error) {
      bus.emit('contextfailed', { error });
      return;
    }
    lost = false;
    bus.emit('contextrestored', { renderer, recreated: true });
    sync();
  }

  mount();

  const offs = [
    bus.on('pause', () => {
      paused = true;
      clearStuckTimer();
      sync();
    }),
    bus.on('resume', () => {
      paused = false;
      armStuckTimer();
      sync();
    }),
    bus.on('resize', (next) => {
      size = next;
      applySize();
    }),
  ];

  return {
    get renderer() {
      return renderer;
    },
    get canvas() {
      return canvas;
    },
    setFrame(callback) {
      frame = callback;
      sync();
    },
    loseContext() {
      renderer.forceContextLoss();
    },
    restoreContext() {
      renderer.forceContextRestore();
    },
    state: () => ({ running, paused, contextLost: lost, recreations, frames }),
    dispose() {
      for (const off of offs) off();
      clearStuckTimer();
      unmount();
      timer.dispose();
    },
  };
}
