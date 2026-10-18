/** A seeded PRNG: numbers in [0, 1), the same sequence for the same seed (mulberry32). */
export type Random = () => number;

export function mulberry32(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** One element of a non-empty list, chosen uniformly. */
export function pick<T>(random: Random, items: readonly [T, ...T[]] | readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error('pick() needs a non-empty list');
  return item;
}

/** True with probability `p`. */
export function chance(random: Random, p: number): boolean {
  return random() < p;
}
