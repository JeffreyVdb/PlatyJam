import type { Lifecycle } from '../app/lifecycle';
import { loadOffsets } from './calibration-store';
import { createAudioEngine, type AudioEngine } from './engine';
import { type LoadProgress, loadPianoSamples, type PianoSamples } from './piano-samples';
import { createSampler, type Sampler } from './sampler';
import { createAccompaniment, type Accompaniment, PAUSE_FADE_MS } from './scheduler';

/** Everything the game plays, wired to the engine's interruptions. */
export interface GameAudio {
  readonly engine: AudioEngine;
  readonly piano: Sampler;
  /** Chart accompaniment through the piano, on the engine's song clock. */
  readonly accompaniment: Accompaniment;
  readonly samples: {
    readonly progress: LoadProgress;
    /** Settles once every key has loaded or failed; never rejects. */
    readonly ready: Promise<PianoSamples>;
  };
}

export interface GameAudioOptions {
  bus: Lifecycle;
  /** App base URL (`import.meta.env.BASE_URL`). */
  base: string;
}

/**
 * Builds the engine, piano and accompaniment, applies the saved calibration and
 * starts loading the piano (decoding works while the context is still suspended).
 */
export function createGameAudio({ bus, base }: GameAudioOptions): GameAudio {
  const engine = createAudioEngine({ bus });
  engine.setOffsets(loadOffsets());

  const buffers = new Map<number, AudioBuffer>();
  const piano = createSampler({ target: engine, buffers });
  const accompaniment = createAccompaniment({
    timeline: engine.timeline,
    now: () => engine.context.currentTime,
    instrument: piano,
  });

  engine.events.on('interrupted', () => {
    accompaniment.pause(PAUSE_FADE_MS);
  });
  engine.events.on('recreated', () => {
    piano.reset();
  });
  engine.events.on('resumed', () => {
    accompaniment.resume();
  });

  const progress: LoadProgress = { loaded: 0, failed: 0, total: 88 };
  const ready = loadPianoSamples({
    base,
    buffers,
    decode: (data) => engine.context.decodeAudioData(data),
    onProgress: (next) => {
      Object.assign(progress, next);
    },
  });

  return { engine, piano, accompaniment, samples: { progress, ready } };
}
