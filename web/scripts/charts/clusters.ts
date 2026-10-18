import type { Strength } from './config.ts';
import { compareStrength, type TimedNote } from './timing.ts';

/** Melody notes that start together: one chord, at most one tile or a double. */
export interface Cluster {
  /** Onset of the earliest note, ms. */
  t: number;
  strength: Strength;
  /** Highest pitch first, one note per pitch. */
  notes: TimedNote[];
}

/** Total order on notes, so equal inputs always give equal outputs. */
export function compareNotes(a: TimedNote, b: TimedNote): number {
  return a.t - b.t || a.pitch - b.pitch || a.dur - b.dur || a.vel - b.vel || a.tick - b.tick;
}

/**
 * Groups melody notes whose onsets lie within `windowMs` of the first onset of the
 * group. A pitch struck twice in one group keeps its longer (then louder) note.
 */
export function clusterNotes(
  notes: readonly TimedNote[],
  windowMs: number,
  strengthOf: (tick: number) => Strength,
): Cluster[] {
  const clusters: Cluster[] = [];
  let current: Cluster | undefined;
  for (const note of [...notes].sort(compareNotes)) {
    if (!current || note.t - current.t > windowMs) {
      current = { t: note.t, strength: strengthOf(note.tick), notes: [] };
      clusters.push(current);
    }
    const same = current.notes.findIndex((n) => n.pitch === note.pitch);
    const existing = current.notes[same];
    if (!existing) current.notes.push(note);
    else if (note.dur > existing.dur || (note.dur === existing.dur && note.vel > existing.vel)) {
      current.notes[same] = note;
    }
  }
  for (const cluster of clusters) cluster.notes.sort((a, b) => b.pitch - a.pitch);
  return clusters;
}

/**
 * Thins clusters for a difficulty: drops those weaker than `minStrength`, then keeps
 * clusters strongest-first (earliest first among equals) as long as no kept onset is
 * closer than `minIntervalMs`. Returns one flag per cluster.
 */
export function selectClusters(
  clusters: readonly Cluster[],
  minStrength: Strength,
  minIntervalMs: number,
): boolean[] {
  const keep = clusters.map(() => false);
  const order = clusters
    .map((cluster, index) => ({ cluster, index }))
    .filter(({ cluster }) => compareStrength(cluster.strength, minStrength) >= 0)
    .sort(
      (a, b) =>
        compareStrength(b.cluster.strength, a.cluster.strength) ||
        a.cluster.t - b.cluster.t ||
        a.index - b.index,
    );
  /** Onsets kept so far, ascending. */
  const kept: number[] = [];
  for (const { cluster, index } of order) {
    const at = lowerBound(kept, cluster.t);
    const before = kept[at - 1];
    const after = kept[at];
    if (before !== undefined && cluster.t - before < minIntervalMs) continue;
    if (after !== undefined && after - cluster.t < minIntervalMs) continue;
    kept.splice(at, 0, cluster.t);
    keep[index] = true;
  }
  return keep;
}

function lowerBound(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] ?? 0) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
