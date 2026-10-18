/**
 * Beyond this, an output timestamp is treated as broken (stale after a stall, or a
 * WebKit context whose clock froze) and `currentTime` is used instead.
 */
export const MAX_TIMESTAMP_DISAGREEMENT_S = 0.5;

/** The values `contextTimeAt` needs, read from the context at one instant. */
export interface OutputTimeSample {
  currentTime: number;
  /** `performance.now()` when `currentTime` was read. */
  nowMs: number;
  /** `ctx.getOutputTimestamp()`, where the browser has it. */
  timestamp?: AudioTimestamp;
}

/**
 * Maps a `performance.now()`-based time (an `event.timeStamp`, a frame time) onto
 * context time, in seconds.
 *
 * The output timestamp says which context time was audible at which performance
 * time, so the result is the context time the listener hears at `perfMs`. Without a
 * usable timestamp it falls back to `currentTime`, which runs slightly ahead of the
 * speaker; the calibrated offsets absorb that constant difference.
 */
export function contextTimeAt(perfMs: number, sample: OutputTimeSample): number {
  const fallback = sample.currentTime + (perfMs - sample.nowMs) / 1000;
  const contextTime = sample.timestamp?.contextTime;
  const performanceTime = sample.timestamp?.performanceTime;
  // Both are 0 until the graph renders its first block.
  if (contextTime === undefined || performanceTime === undefined) return fallback;
  if (contextTime === 0 && performanceTime === 0) return fallback;

  const outputNow = contextTime + (sample.nowMs - performanceTime) / 1000;
  if (Math.abs(outputNow - sample.currentTime) > MAX_TIMESTAMP_DISAGREEMENT_S) return fallback;
  return contextTime + (perfMs - performanceTime) / 1000;
}

type TimestampedContext = Pick<BaseAudioContext, 'currentTime'> &
  Partial<Pick<AudioContext, 'getOutputTimestamp'>>;

/** Reads a sample from a live context. `getOutputTimestamp` needs Safari 14.1. */
export function sampleOutputTime(
  ctx: TimestampedContext,
  nowMs: number = performance.now(),
): OutputTimeSample {
  return { currentTime: ctx.currentTime, nowMs, timestamp: ctx.getOutputTimestamp?.() };
}
