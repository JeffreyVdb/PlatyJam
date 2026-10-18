import type { LatencyOffsets } from './timeline';

/**
 * Latency calibration maths. The procedure (two tap-along phases, see
 * `src/calibration/`) measures:
 *
 * - SEE: taps to flashes, no sound. Signed error P_seen = V + I.
 * - HEAR: taps to clicks, no beat-locked visuals. P_heard = A + I.
 *
 * With V assumed 0 (folded into I): I = P_seen and A = P_heard − P_seen. Errors are
 * tap minus beat in song ms: positive = late, as everywhere else.
 */

export interface BeatGrid {
  /** Spacing between beats, ms. Beat k is at `k * beatMs`. */
  beatMs: number;
  /** Unscored beats before the first scored beat. */
  countInBeats: number;
  scoredBeats: number;
}

/** 100 BPM, a 4-beat count-in, then 16 scored beats per phase. */
export const CALIBRATION_GRID: Readonly<BeatGrid> = {
  beatMs: 600,
  countInBeats: 4,
  scoredBeats: 16,
};

/** Scored taps discarded at the start while the player settles into the beat. */
export const SETTLING_TAPS = 4;
/** A tap further than this from its beat is a miss or a stray tap. */
export const MAX_TAP_ERROR_MS = 120;
export const MIN_TAPS = 8;
/** Wider than this, the taps are too scattered to trust. */
export const MAX_IQR_MS = 60;

export const AUDIO_OFFSET_RANGE_MS = { min: -150, max: 400 } as const;
export const INPUT_OFFSET_RANGE_MS = { min: -150, max: 250 } as const;

export function median(values: readonly number[]): number {
  return quantile(
    [...values].sort((a, b) => a - b),
    0.5,
  );
}

/** Q3 − Q1, with linearly interpolated quartiles. */
export function interquartileRange(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return quantile(sorted, 0.75) - quantile(sorted, 0.25);
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const below = sorted[lo] ?? Number.NaN;
  const above = sorted[Math.ceil(pos)] ?? below;
  return below + (above - below) * (pos - lo);
}

/**
 * Signed error of each tap (song ms) to its nearest beat, in tap order. Taps whose
 * nearest beat is a count-in beat or lies past the last scored beat are ignored,
 * as is every tap after the first on the same beat.
 */
export function tapErrors(tapSongMs: readonly number[], grid: BeatGrid): number[] {
  const first = grid.countInBeats;
  const last = grid.countInBeats + grid.scoredBeats - 1;
  const used = new Set<number>();
  const errors: number[] = [];
  for (const tap of tapSongMs) {
    const beat = Math.round(tap / grid.beatMs);
    if (beat < first || beat > last || used.has(beat)) continue;
    used.add(beat);
    errors.push(tap - beat * grid.beatMs);
  }
  return errors;
}

export type PhaseResult =
  | { ok: true; offsetMs: number; iqrMs: number; taps: number }
  | { ok: false; reason: 'too-few-taps' | 'inconsistent'; taps: number };

/** Turns one phase's signed tap errors into its offset (the median), or a reason to retry. */
export function summarizePhase(errors: readonly number[]): PhaseResult {
  const kept = errors.slice(SETTLING_TAPS).filter((e) => Math.abs(e) <= MAX_TAP_ERROR_MS);
  if (kept.length < MIN_TAPS) return { ok: false, reason: 'too-few-taps', taps: kept.length };
  const iqrMs = interquartileRange(kept);
  if (iqrMs > MAX_IQR_MS) return { ok: false, reason: 'inconsistent', taps: kept.length };
  return { ok: true, offsetMs: median(kept), iqrMs, taps: kept.length };
}

function clamp(value: number, range: { min: number; max: number }): number {
  return Math.min(range.max, Math.max(range.min, value));
}

export function clampOffsets({ audioOffsetMs, inputOffsetMs }: LatencyOffsets): LatencyOffsets {
  return {
    audioOffsetMs: clamp(Math.round(audioOffsetMs), AUDIO_OFFSET_RANGE_MS),
    inputOffsetMs: clamp(Math.round(inputOffsetMs), INPUT_OFFSET_RANGE_MS),
  };
}

/** I = P_seen, A = P_heard − P_seen; rounded to whole ms and clamped. */
export function deriveOffsets({ seenMs, heardMs }: { seenMs: number; heardMs: number }) {
  return clampOffsets({ audioOffsetMs: heardMs - seenMs, inputOffsetMs: seenMs });
}
