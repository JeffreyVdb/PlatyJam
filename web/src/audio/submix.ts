import type { AudioEngine } from './engine';

/**
 * A group of voices with its own volume: a GainNode feeding the engine's master
 * output. Pass it as a sampler's `target`. The engine replaces the context and the
 * master output when it recreates them; the submix rebuilds itself on the new
 * context then, at the same volume.
 */
export interface Submix {
  /** The engine's current context. */
  readonly context: AudioContext;
  /** Connect voices here. Replaced when the context is recreated. */
  readonly output: GainNode;
  /** 0 to 1. */
  readonly volume: number;
  setVolume(volume: number): void;
  dispose(): void;
}

const clampVolume = (volume: number) =>
  Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0;

export function createSubmix(
  engine: Pick<AudioEngine, 'context' | 'output' | 'events'>,
  initialVolume = 1,
): Submix {
  let volume = clampVolume(initialVolume);
  let output!: GainNode;

  const build = () => {
    output = engine.context.createGain();
    output.gain.value = volume;
    output.connect(engine.output);
  };

  build();
  const off = engine.events.on('recreated', build);

  return {
    get context() {
      return engine.context;
    },
    get output() {
      return output;
    },
    get volume() {
      return volume;
    },
    setVolume(next) {
      volume = clampVolume(next);
      output.gain.value = volume;
    },
    dispose() {
      off();
    },
  };
}
