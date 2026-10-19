/**
 * When to warn that the sound is delayed (PLA-10), pure: latency readings and the
 * saved "don't ask again" in, decisions out. Wireless headphones add 150–300 ms to
 * every note, and calibration cannot remove that from the player's own taps.
 *
 * All values are milliseconds. `AudioContext.outputLatency` is in seconds; the engine
 * converts it once (`AudioEngine.outputLatency()`), so nothing here sees seconds.
 */

/** A reading at or above this counts as delayed. Retune after measuring real devices. */
export const DELAYED_OUTPUT_MS = 80;

/**
 * "Don't ask again" holds for the latency measured when it was chosen: a new delayed
 * reading further than this from it asks again (another pair of headphones).
 */
export const BAND_TOLERANCE_MS = 50;

/** How many readings in a row must agree before the output counts as delayed or on time. */
export const VERDICT_SAMPLES = 3;

/** How often the output latency is read while watching. */
export const SAMPLE_INTERVAL_MS = 100;

/** One reading: milliseconds, or `undefined` when unknown (missing, 0, or audio not running). */
export type LatencySample = number | undefined;

/**
 * - `delayed`: the last `VERDICT_SAMPLES` readings are all known and at least `DELAYED_OUTPUT_MS`.
 * - `onTime`: they are all known and below it.
 * - `unsure`: anything else. Too few readings, a mix, or an unknown one: the value settles
 *   right after a route change, and an unknown reading breaks the run instead of
 *   counting toward either verdict. A small value is no proof of speakers, but
 *   `unsure` never warns, and playing never waits on it.
 */
export type OutputVerdict = 'delayed' | 'onTime' | 'unsure';

/** Adds a reading to the window of the most recent `VERDICT_SAMPLES`. */
export function appendSample(
  window: readonly LatencySample[],
  sample: LatencySample,
): LatencySample[] {
  return [...window, sample].slice(-VERDICT_SAMPLES);
}

export function judgeOutput(window: readonly LatencySample[]): OutputVerdict {
  const recent = window.slice(-VERDICT_SAMPLES);
  if (recent.length < VERDICT_SAMPLES) return 'unsure';
  if (recent.every((ms) => ms !== undefined && ms >= DELAYED_OUTPUT_MS)) return 'delayed';
  if (recent.every((ms) => ms !== undefined && ms < DELAYED_OUTPUT_MS)) return 'onTime';
  return 'unsure';
}

/** The median of the known readings in the window, or `undefined` when none is known. */
export function typicalLatency(window: readonly LatencySample[]): number | undefined {
  const known = window.filter((ms): ms is number => ms !== undefined).sort((a, b) => a - b);
  if (known.length === 0) return undefined;
  const middle = Math.floor(known.length / 2);
  return known.length % 2 === 1
    ? known[middle]
    : ((known[middle - 1] ?? 0) + (known[middle] ?? 0)) / 2;
}

/**
 * Whether to show the warning before a song: the output is delayed, and the player has
 * not chosen "don't ask again" for about this much delay. `mutedAtMs` is the latency
 * saved when they did (`null` = never).
 */
export function shouldWarn(
  verdict: OutputVerdict,
  latencyMs: number | undefined,
  mutedAtMs: number | null,
): boolean {
  if (verdict !== 'delayed' || latencyMs === undefined) return false;
  return mutedAtMs === null || Math.abs(latencyMs - mutedAtMs) > BAND_TOLERANCE_MS;
}

/** "About 190 ms": to the nearest 10, never 0. */
export function approximateMs(ms: number): number {
  return Math.max(10, Math.round(ms / 10) * 10);
}
