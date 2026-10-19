import type { Judgment } from './session-contract';

// Windows are REAL ms, equally generous at every tempo. At tempo x, a real ms is x
// chart ms, so every comparison below scales the window instead of dividing the
// error: that keeps the boundaries exact (all offered tempos are binary fractions).

/** |error| ≤ this is Perfect. */
export const PERFECT_WINDOW_MS = 50;
/** |error| ≤ this (and > Perfect) is Good; a head is eligible inside it. */
export const GOOD_WINDOW_MS = 120;
/** A hold released at most this long before its scheduled tail still succeeds. */
export const TAIL_TOLERANCE_MS = 120;

/**
 * How a press at chart ms `inputMs` judges a head at chart ms `t`: Perfect, Good,
 * or undefined when it is outside the window (the tile is not eligible).
 */
export function judgeHead(t: number, inputMs: number, tempo: number): Judgment | undefined {
  const error = Math.abs(inputMs - t);
  if (error <= PERFECT_WINDOW_MS * tempo) return 'perfect';
  if (error <= GOOD_WINDOW_MS * tempo) return 'good';
  return undefined;
}

/** The last chart ms at which a head at `t` can still be hit. */
export function headDeadline(t: number, tempo: number): number {
  return t + GOOD_WINDOW_MS * tempo;
}

/** An unhit head becomes a Miss strictly after its late boundary. */
export function headIsExpired(t: number, songMs: number, tempo: number): boolean {
  return songMs > headDeadline(t, tempo);
}

/** Whether releasing a hold at `releaseMs` completes its tail at `end` successfully. */
export function tailReleaseIsSuccessful(end: number, releaseMs: number, tempo: number): boolean {
  return releaseMs >= end - TAIL_TOLERANCE_MS * tempo;
}
