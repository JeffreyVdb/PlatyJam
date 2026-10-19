import type { Judgment, Outcome, ScoreStats } from './session-contract';

// Every number here is a tunable constant.

/** Base points per scoring unit (a tap, a hold head or a hold tail). */
export const BASE_POINTS: Readonly<Record<Judgment, number>> = { perfect: 100, good: 50, miss: 0 };
/** The multiplier steps up every this many consecutive successful units. */
export const COMBO_STEP = 10;
export const MAX_MULTIPLIER = 4;
/** Progress at which the first and second stars are earned. */
export const STAR_THRESHOLDS = [1 / 3, 2 / 3] as const;

/** The running score of a run. Mutated in place by `scoreUnit`. */
export type Score = Omit<ScoreStats, 'accuracy'>;

export function createScore(): Score {
  return { score: 0, combo: 0, maxCombo: 0, perfect: 0, good: 0, miss: 0 };
}

/** `min(4, 1 + floor(comboBefore / 10))`. */
export function multiplierFor(comboBefore: number): number {
  return Math.min(MAX_MULTIPLIER, 1 + Math.floor(comboBefore / COMBO_STEP));
}

/** Scores one unit: updates counts, combo and score, and returns the points awarded. */
export function scoreUnit(score: Score, judgment: Judgment): number {
  const points = BASE_POINTS[judgment] * multiplierFor(score.combo);
  score[judgment] += 1;
  if (judgment === 'miss') {
    score.combo = 0;
  } else {
    score.combo += 1;
    score.maxCombo = Math.max(score.maxCombo, score.combo);
  }
  score.score += points;
  return points;
}

/** `100 * (perfect + 0.5 * good) / resolved`, over resolved units only; 0 before any. */
export function accuracyOf({ perfect, good, miss }: Score): number {
  const resolved = perfect + good + miss;
  return resolved === 0 ? 0 : (100 * (perfect + 0.5 * good)) / resolved;
}

export function starsFor(progress: number, cleared: boolean): number {
  if (cleared) return 3;
  return STAR_THRESHOLDS.filter((threshold) => progress >= threshold).length;
}

export function earnsPerfectBadge(outcome: Outcome, { good, miss }: Score): boolean {
  return outcome === 'cleared' && good === 0 && miss === 0;
}
