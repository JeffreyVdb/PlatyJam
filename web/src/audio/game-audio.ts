import type { Lifecycle } from '../app/lifecycle';
import { loadOffsets } from './calibration-store';
import { createAudioEngine, type AudioEngine } from './engine';
import { type LoadProgress, loadPianoSamples, type PianoSamples } from './piano-samples';
import { createSampler, type Sampler } from './sampler';
import { createAccompaniment, type Accompaniment, PAUSE_FADE_MS } from './scheduler';
import { createSubmix } from './submix';

/** Everything the game plays, wired to the engine's interruptions. */
export interface GameAudio {
  readonly engine: AudioEngine;
  /** The player's notes (and the ?debug tap pad), straight into the master output. */
  readonly piano: Sampler;
  /**
   * Chart accompaniment on the engine's song clock, through a second piano on the
   * same samples with its own volume.
   */
  readonly accompaniment: Accompaniment;
  /** 0 to 1: the accompaniment's volume. The master volume is `engine.setMasterVolume`. */
  readonly accompanimentVolume: number;
  setAccompanimentVolume(volume: number): void;
  /** Voices sounding on both pianos, for the ?debug readout. */
  activeVoices(): number;
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
  // Decoded buffers are shared; only the voices and their output differ.
  const accompanimentMix = createSubmix(engine);
  const accompanimentPiano = createSampler({ target: accompanimentMix, buffers });
  const accompaniment = createAccompaniment({
    timeline: engine.timeline,
    now: () => engine.context.currentTime,
    instrument: accompanimentPiano,
  });

  // Both pianos fade on every stop: the player's notes and tap-pad voices too.
  engine.events.on('interrupted', () => {
    accompaniment.pause(PAUSE_FADE_MS);
    piano.stopAll(PAUSE_FADE_MS);
  });
  engine.events.on('recreated', () => {
    piano.reset();
    accompanimentPiano.reset();
  });
  engine.events.on('resumed', () => {
    accompaniment.resume();
  });
  engine.events.on('silenced', ({ fadeMs }) => {
    accompaniment.stopAll(fadeMs);
    piano.stopAll(fadeMs);
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

  return {
    engine,
    piano,
    accompaniment,
    get accompanimentVolume() {
      return accompanimentMix.volume;
    },
    setAccompanimentVolume(volume) {
      accompanimentMix.setVolume(volume);
    },
    activeVoices: () => piano.activeVoices() + accompanimentPiano.activeVoices(),
    samples: { progress, ready },
  };
}
