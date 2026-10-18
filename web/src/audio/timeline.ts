import type { SongClock } from './clock';

/**
 * Calibrated latencies, in real-time ms (never scaled by tempo). Positive = late:
 *
 * - `audioOffsetMs` (A): a sound reaches the ear A ms after it was scheduled.
 * - `inputOffsetMs` (I): a tap reaches the page I ms after it happened. Visual
 *   latency is assumed 0 and folded into I by the calibration.
 */
export interface LatencyOffsets {
  audioOffsetMs: number;
  inputOffsetMs: number;
}

export const ZERO_OFFSETS: Readonly<LatencyOffsets> = { audioOffsetMs: 0, inputOffsetMs: 0 };

/**
 * The song clock with latency applied: the one place that turns song time into
 * "when to start a sound" and "when did this tap happen". Gameplay, the
 * accompaniment and the calibration all go through it, so whatever bias the
 * pipeline has is measured and corrected on the same path.
 */
export interface Timeline {
  readonly clock: SongClock;
  /**
   * Song ms the player hears right now, for rendering. Never decreases while the
   * clock runs (output timestamps jitter); resets on seek, pause and resume.
   */
  songTime(): number;
  /**
   * Song ms at which a tap with this `event.timeStamp` happened. This is the time to
   * judge hits with: the input offset is applied here and nowhere else.
   */
  judgeSongTime(eventTimeStamp: number): number;
  /** Context seconds to start a sound so it is heard at song ms `songMs`. Needs a running clock. */
  startTimeFor(songMs: number): number;
}

export interface TimelineOptions {
  clock: SongClock;
  /** Maps a performance.now()-based time to the context time audible then. */
  contextTimeAt: (perfMs: number) => number;
  nowMs?: () => number;
  /** Read on every call, so a new calibration applies immediately. */
  offsets: () => LatencyOffsets;
}

export function createTimeline({
  clock,
  contextTimeAt,
  nowMs = () => performance.now(),
  offsets,
}: TimelineOptions): Timeline {
  let highWater = -Infinity;
  let generation = -1;

  return {
    clock,
    songTime() {
      if (!clock.isRunning) return clock.position();
      if (clock.generation !== generation) {
        generation = clock.generation;
        highWater = -Infinity;
      }
      highWater = Math.max(highWater, clock.songTimeAt(contextTimeAt(nowMs())));
      return highWater;
    },
    judgeSongTime(eventTimeStamp) {
      return clock.songTimeAt(contextTimeAt(eventTimeStamp - offsets().inputOffsetMs));
    },
    startTimeFor(songMs) {
      return clock.ctxTimeFor(songMs) - offsets().audioOffsetMs / 1000;
    },
  };
}
