import { backingTrackStartMs, type BackingTrack } from './backing-track';

/** What `load` was asked for and how it went. */
export type BackingLoadState =
  /** The chart has no recording. */
  | 'none'
  | 'loading'
  | 'loaded'
  /** It did not download or decode: the song plays without it. */
  | 'failed';

/** A chart's `audio`: the file (relative to the app base) and its position at chart t = 0. */
export interface BackingSource {
  src: string;
  offsetMs: number;
}

/**
 * The recording of the chosen song, with the lifecycle of the accompaniment: `play`
 * when a run starts, `pause` and `resume` around interruptions, `stopAll` when the
 * run ends. The methods mirror `Accompaniment`; the engine's events drive them in
 * `createGameAudio`, and the session drives `load`, `play`, `pause` and `stopAll`.
 */
export interface BackingPlayer {
  /**
   * Fetches and decodes the recording for the next run, keeping the buffer (the one
   * recording only, and across loads of the same file). `undefined` forgets it.
   * Settles once it has loaded or failed; never rejects. A call that a later one
   * overtook settles without changing anything.
   */
  load(audio: BackingSource | undefined): Promise<void>;
  readonly state: BackingLoadState;
  /** A recording is ready to play. */
  readonly loaded: boolean;
  /** A run starts: plays from the running song clock, and arms `resume`. */
  play(): void;
  /** Fades it out; `resume` brings it back from the clock. */
  pause(fadeMs: number): void;
  /** Plays again from the running song clock, if `play` was called and not stopped. */
  resume(): void;
  /** The run is over: fades it out and forgets that it was playing. */
  stopAll(fadeMs: number): void;
  /** Drops the node without touching it: its context was closed and replaced. */
  reset(): void;
}

export interface BackingPlayerOptions {
  /** Fetches and decodes `src`; null when it failed (see `loadBackingTrack`). */
  loadBuffer: (src: string) => Promise<AudioBuffer | null>;
  createTrack: (buffer: AudioBuffer, trackStartMs: number) => BackingTrack;
}

export function createBackingPlayer({
  loadBuffer,
  createTrack,
}: BackingPlayerOptions): BackingPlayer {
  let state: BackingLoadState = 'none';
  let track: BackingTrack | undefined;
  let kept: { src: string; buffer: AudioBuffer } | undefined;
  let inflight: { src: string; promise: Promise<AudioBuffer | null> } | undefined;
  let request = 0;
  let armed = false;

  const forgetTrack = () => {
    track?.stop(0);
    track = undefined;
    armed = false;
  };

  return {
    async load(audio) {
      const id = (request += 1);
      forgetTrack();
      if (!audio) {
        kept = undefined;
        inflight = undefined;
        state = 'none';
        return;
      }
      const { src } = audio;
      if (kept && kept.src !== src) kept = undefined;
      let buffer: AudioBuffer | null;
      if (kept) {
        buffer = kept.buffer;
      } else {
        state = 'loading';
        const attempt = inflight?.src === src ? inflight : { src, promise: loadBuffer(src) };
        inflight = attempt;
        buffer = await attempt.promise;
        if (inflight === attempt) inflight = undefined;
        if (id !== request) return;
      }
      if (buffer) {
        kept = { src, buffer };
        track = createTrack(buffer, backingTrackStartMs(audio));
        state = 'loaded';
      } else {
        kept = undefined;
        state = 'failed';
      }
    },
    get state() {
      return state;
    },
    get loaded() {
      return track !== undefined;
    },
    play() {
      armed = true;
      track?.play();
    },
    pause(fadeMs) {
      track?.stop(fadeMs);
    },
    resume() {
      if (armed) track?.play();
    },
    stopAll(fadeMs) {
      armed = false;
      track?.stop(fadeMs);
    },
    reset() {
      track?.reset();
    },
  };
}
