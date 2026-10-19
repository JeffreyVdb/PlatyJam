import type { WebGLRenderer } from 'three';
import type { GameAudio } from '../audio/game-audio';
import type { GameSession } from '../game/session-contract';
import type { RendererHost, RendererHostState } from '../render/renderer-host';
import type { Lifecycle } from './lifecycle';

/** `?debug` (any value) turns on the debug hook, in production builds too. */
export function isDebugEnabled(search: string): boolean {
  return new URLSearchParams(search).has('debug');
}

/**
 * `?debug&latency=250`: fakes the audio output latency (ms) so the delayed-sound
 * warning shows without Bluetooth headphones. Only with `?debug`; anything that is
 * not a positive number is ignored.
 */
export function debugOutputLatency(search: string): number | undefined {
  if (!isDebugEnabled(search)) return undefined;
  const value = new URLSearchParams(search).get('latency');
  if (value === null || value.trim() === '') return undefined;
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
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
  /** The game session, when sound could start. */
  session?: GameSession | undefined;
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
