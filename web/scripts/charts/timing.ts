import { STRENGTHS, type Strength } from './config.ts';
import type { SourceNote } from './extract.ts';

/** A note in chart time: integer ms, still carrying its (quantized) onset tick for the meter. */
export interface TimedNote {
  t: number;
  dur: number;
  pitch: number;
  vel: number;
  tick: number;
}

export interface QuantizeOptions {
  /** Grid step, ticks. */
  step: number;
  /** Snap only when within this fraction of a step. */
  tolerance: number;
}

/** Snaps `tick` to the nearest grid line if it is close enough, otherwise leaves it. */
export function quantizeTick(tick: number, { step, tolerance }: QuantizeOptions): number {
  const snapped = Math.round(Math.round(tick / step) * step);
  return Math.abs(snapped - tick) <= step * tolerance ? snapped : tick;
}

/**
 * Quantizes onsets and ends lightly and converts them to integer ms with the file's
 * tempo map. `dur` is the difference of the rounded end and start, so a note ending
 * where the next starts never overlaps it after rounding.
 */
export function timeNotes(
  notes: readonly SourceNote[],
  ticksToMs: (tick: number) => number,
  quantize: QuantizeOptions,
): TimedNote[] {
  return notes.map((note) => {
    const tick = quantizeTick(note.tick, quantize);
    let end = quantizeTick(note.tick + note.durTicks, quantize);
    if (end <= tick) end = Math.max(tick + 1, note.tick + note.durTicks);
    const t = Math.round(ticksToMs(tick));
    const dur = Math.max(1, Math.round(ticksToMs(end)) - t);
    return { t, dur, pitch: note.pitch, vel: note.vel, tick };
  });
}

export interface TimeSignature {
  ticks: number;
  /** [numerator, denominator] */
  timeSignature: readonly number[];
}

export interface Meter {
  ppq: number;
  /** Sorted by `ticks`. Empty means 4/4 throughout. */
  timeSignatures: readonly TimeSignature[];
}

/**
 * The metric strength of an onset (see `STRENGTHS`), assuming each time signature
 * starts a bar. Compound meters (6/8, 9/8, 12/8) count dotted beats.
 */
export function strengthAt(tick: number, { ppq, timeSignatures }: Meter): Strength {
  let start = 0;
  let [numerator, denominator] = [4, 4];
  for (const sig of timeSignatures) {
    if (sig.ticks > tick) break;
    start = sig.ticks;
    numerator = sig.timeSignature[0] ?? 4;
    denominator = sig.timeSignature[1] ?? 4;
  }
  const unit = (ppq * 4) / denominator;
  const compound = denominator >= 8 && numerator > 3 && numerator % 3 === 0;
  const beat = compound ? unit * 3 : unit;
  const beatsPerBar = compound ? numerator / 3 : numerator;
  const half = compound ? unit : beat / 2;
  const pos = (tick - start) % (beat * beatsPerBar);

  if (isMultiple(pos, beat * beatsPerBar)) return 'downbeat';
  if (isMultiple(pos, beat)) {
    return beatsPerBar % 2 === 0 && Math.round(pos / beat) === beatsPerBar / 2 ? 'strong' : 'beat';
  }
  if (isMultiple(pos, half)) return 'half-beat';
  if (isMultiple(pos, half / 2)) return 'quarter-beat';
  return 'any';
}

function isMultiple(value: number, step: number): boolean {
  const ratio = value / step;
  return Math.abs(ratio - Math.round(ratio)) < 1e-9;
}

/** Orders strengths: positive when `a` is stronger than `b`. */
export function compareStrength(a: Strength, b: Strength): number {
  return STRENGTHS.indexOf(a) - STRENGTHS.indexOf(b);
}
