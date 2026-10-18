import type { WebGLRenderer } from 'three';
import type { GameAudio } from '../audio/game-audio';
import type { RendererHost, RendererHostState } from '../render/renderer-host';
import type { Lifecycle } from './lifecycle';

/** `?debug` (any value) turns on the debug hook, in production builds too. */
export function isDebugEnabled(search: string): boolean {
  return new URLSearchParams(search).has('debug');
}

export interface DebugHook {
  /** Drops the WebGL context, as iPadOS does under memory pressure. */
  loseContext(): void;
  /** Restores it. Skip this call to exercise the stuck-context fallback (~3 s). */
  restoreContext(): void;
  state(): RendererHostState & { sceneBuilds: number };
  readonly renderer: WebGLRenderer;
  readonly lifecycle: Lifecycle;
  /** The audio engine, piano and accompaniment, when sound could start. */
  audio?: GameAudio;
}

declare global {
  interface Window {
    __platyjam?: DebugHook;
  }
}

export function installDebugHook(
  win: Window,
  host: RendererHost,
  bus: Lifecycle,
  sceneBuilds: () => number,
): DebugHook {
  const hook: DebugHook = {
    loseContext: () => {
      host.loseContext();
    },
    restoreContext: () => {
      host.restoreContext();
    },
    state: () => ({ ...host.state(), sceneBuilds: sceneBuilds() }),
    // Getter: the renderer is replaced after a stuck context.
    get renderer() {
      return host.renderer;
    },
    lifecycle: bus,
  };
  win.__platyjam = hook;
  return hook;
}
