import type { Lifecycle } from '../app/lifecycle';
import { createBackingPlayer, type BackingPlayer } from './backing-player';
import { createBackingTrack, loadBackingTrack } from './backing-track';
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
  /**
   * The song's recording (`chart.audio`), through the accompaniment's submix so its
   * volume applies. Loaded with the song; started, paused and stopped with the run.
   */
  readonly backing: BackingPlayer;
  /**
   * Tunes both pianos to a recording played at `rate` (its tempo): they play at
   * `playbackRate = rate`, so the notes move with the recording's pitch. 1 is
   * concert pitch. Applies to notes started from now on.
   */
  setTuning(rate: number): void;
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

  const backing = createBackingPlayer({
    loadBuffer: (src) =>
      loadBackingTrack({
        url: src,
        base,
        decode: (data) => engine.context.decodeAudioData(data),
      }),
    createTrack: (buffer, trackStartMs) =>
      createBackingTrack({
        target: accompanimentMix,
        clock: engine.clock,
        audioOffsetMs: () => engine.offsets.audioOffsetMs,
        buffer,
        trackStartMs,
      }),
  });

  // Both pianos fade on every stop: the player's notes and tap-pad voices too.
  engine.events.on('interrupted', () => {
    accompaniment.pause(PAUSE_FADE_MS);
    backing.pause(PAUSE_FADE_MS);
    piano.stopAll(PAUSE_FADE_MS);
  });
  engine.events.on('recreated', () => {
    piano.reset();
    accompanimentPiano.reset();
    backing.reset();
  });
  engine.events.on('resumed', () => {
    accompaniment.resume();
    backing.resume();
  });
  engine.events.on('silenced', ({ fadeMs }) => {
    accompaniment.stopAll(fadeMs);
    backing.stopAll(fadeMs);
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
    backing,
    setTuning(rate) {
      piano.setPlaybackRate(rate);
      accompanimentPiano.setPlaybackRate(rate);
    },
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
