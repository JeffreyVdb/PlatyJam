/** Tempo multipliers the game offers; anything else is clamped into this range. */
export const MIN_TEMPO = 0.75;
export const MAX_TEMPO = 1.5;

/**
 * The song clock: maps audio-context time (seconds) to song time (chart ms at 1×).
 *
 * It holds no Web Audio objects. `now` reads the current context time; every method
 * that changes the anchor also accepts an explicit context time, which keeps the
 * maths testable and lets callers anchor to a time they already sampled.
 *
 * While running, song time advances `tempo` chart ms per real ms. Pausing stores
 * the song position only; resuming re-anchors it to the context time at resume. A
 * context-time anchor never survives a pause, because a recreated AudioContext
 * starts again at `currentTime` 0.
 */
export interface SongClock {
  readonly isRunning: boolean;
  readonly tempo: number;
  /**
   * Bumped on every start, pause and resume: song time may jump across these, so
   * anything smoothing it (the monotonic `songTime()`) must reset.
   */
  readonly generation: number;
  /** Starts (or seeks) at `songMs`, anchored at context time `atCtx`. */
  start(songMs: number, atCtx?: number): void;
  pause(atCtx?: number): void;
  resume(atCtx?: number): void;
  /** Changes the tempo without moving the current song position. */
  setTempo(tempo: number, atCtx?: number): void;
  /** Song ms at context time `ctxSec`. While paused or stopped: the held position. */
  songTimeAt(ctxSec: number): number;
  /** Context seconds at which song time reaches `songMs`. Throws unless running. */
  ctxTimeFor(songMs: number): number;
  /** Song ms now. */
  position(): number;
}

export function clampTempo(tempo: number): number {
  return Math.min(MAX_TEMPO, Math.max(MIN_TEMPO, tempo));
}

export function createSongClock(now: () => number): SongClock {
  let running = false;
  let tempo = 1;
  let generation = 0;
  // Running: song time `anchorSongMs` was reached at context time `anchorCtx`.
  let anchorCtx = 0;
  let anchorSongMs = 0;
  // Paused or stopped: where the song is held.
  let heldSongMs = 0;

  const songTimeAt = (ctxSec: number) =>
    running ? anchorSongMs + (ctxSec - anchorCtx) * 1000 * tempo : heldSongMs;

  const anchor = (songMs: number, atCtx: number) => {
    anchorSongMs = songMs;
    anchorCtx = atCtx;
  };

  return {
    get isRunning() {
      return running;
    },
    get tempo() {
      return tempo;
    },
    get generation() {
      return generation;
    },
    start(songMs, atCtx = now()) {
      anchor(songMs, atCtx);
      running = true;
      generation += 1;
    },
    pause(atCtx = now()) {
      if (!running) return;
      heldSongMs = songTimeAt(atCtx);
      running = false;
      generation += 1;
    },
    resume(atCtx = now()) {
      if (running) return;
      anchor(heldSongMs, atCtx);
      running = true;
      generation += 1;
    },
    setTempo(next, atCtx = now()) {
      const clamped = clampTempo(next);
      if (running) anchor(songTimeAt(atCtx), atCtx);
      tempo = clamped;
    },
    songTimeAt,
    ctxTimeFor(songMs) {
      if (!running) throw new Error('SongClock.ctxTimeFor needs a running clock');
      return anchorCtx + (songMs - anchorSongMs) / (1000 * tempo);
    },
    position: () => songTimeAt(now()),
  };
}
