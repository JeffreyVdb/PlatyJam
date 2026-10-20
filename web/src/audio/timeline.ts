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
  /**
   * Song ms the stage was showing at this `event.timeStamp`: `songTime()` then, with
   * no input offset. Where a finger landed on the board is read against it, never
   * when the press counts (that is `judgeSongTime`).
   */
  shownSongTime(eventTimeStamp: number): number;
  /**
   * Song ms at which a tap received right now would be judged: `judgeSongTime(now)`
   * while the clock runs. Once `pause()` stopped it, that value from the instant
   * before. Once something else stopped it, the held position less the input offset,
   * as for a tap received the moment it stopped (`judgeSongTime` can only return the
   * held position then, and the output mapping is lost).
   */
  judgeSongTimeNow(): number;
  /**
   * `shownSongTime` for an event received right now, as `judgeSongTimeNow` is for
   * `judgeSongTime`: once `pause()` stopped the clock, the value from the instant
   * before; once something else stopped it, the held position.
   */
  shownSongTimeNow(): number;
  /**
   * Pauses the clock, keeping what `judgeSongTimeNow()` and `shownSongTimeNow()` read
   * just before for this pause.
   */
  pause(): void;
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
  // `judgeSongTimeNow()` and `shownSongTimeNow()` as `pause()` stopped the clock, valid
  // while it stays stopped.
  let held: { generation: number; judgeMs: number; shownMs: number } | undefined;

  const judgeSongTime = (eventTimeStamp: number) =>
    clock.songTimeAt(contextTimeAt(eventTimeStamp - offsets().inputOffsetMs));
  const shownSongTime = (eventTimeStamp: number) => clock.songTimeAt(contextTimeAt(eventTimeStamp));

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
    judgeSongTime,
    shownSongTime,
    judgeSongTimeNow() {
      if (clock.isRunning) return judgeSongTime(nowMs());
      if (held?.generation === clock.generation) return held.judgeMs;
      return clock.position() - offsets().inputOffsetMs * clock.tempo;
    },
    shownSongTimeNow() {
      if (clock.isRunning) return shownSongTime(nowMs());
      if (held?.generation === clock.generation) return held.shownMs;
      return clock.position();
    },
    pause() {
      if (!clock.isRunning) return;
      const at = nowMs();
      const judgeMs = judgeSongTime(at);
      const shownMs = shownSongTime(at);
      clock.pause();
      held = { generation: clock.generation, judgeMs, shownMs };
    },
    startTimeFor(songMs) {
      return clock.ctxTimeFor(songMs) - offsets().audioOffsetMs / 1000;
    },
  };
}
