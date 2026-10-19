import { describe, expect, it } from 'vitest';
import type { Judgment } from './session-contract';
import {
  accuracyOf,
  createScore,
  earnsPerfectBadge,
  multiplierFor,
  scoreUnit,
  starsFor,
} from './scoring';

const play = (judgments: readonly Judgment[]) => {
  const score = createScore();
  for (const judgment of judgments) scoreUnit(score, judgment);
  return score;
};

const times = (n: number, judgment: Judgment): Judgment[] => Array<Judgment>(n).fill(judgment);

describe('scoring', () => {
  it('8 Perfects and 2 Goods at 1x: 900 points, 90% accuracy, combo 10', () => {
    const score = play([...times(8, 'perfect'), ...times(2, 'good')]);
    expect(score.score).toBe(900);
    expect(accuracyOf(score)).toBe(90);
    expect(score.combo).toBe(10);
    expect(score.maxCombo).toBe(10);
  });

  it('the next Perfect after ten consecutive successful units earns 200 points', () => {
    const score = play(times(10, 'perfect'));
    expect(scoreUnit(score, 'perfect')).toBe(200);
    expect(score.score).toBe(1200);
  });

  it('Perfect, Good, Miss: 150 points, 50% accuracy, max combo 2, combo 0', () => {
    const score = play(['perfect', 'good', 'miss']);
    expect(score.score).toBe(150);
    expect(accuracyOf(score)).toBe(50);
    expect(score.maxCombo).toBe(2);
    expect(score.combo).toBe(0);
    expect([score.perfect, score.good, score.miss]).toEqual([1, 1, 1]);
  });

  it('uses the combo before the unit for the multiplier, capped at 4x', () => {
    expect([0, 9, 10, 19, 20, 29, 30, 31, 500].map(multiplierFor)).toEqual([
      1, 1, 2, 2, 3, 3, 4, 4, 4,
    ]);
    const score = play(times(30, 'perfect'));
    // 10 × 100 + 10 × 200 + 10 × 300, then 4×.
    expect(score.score).toBe(6000);
    expect(scoreUnit(score, 'good')).toBe(200);
  });

  it('a Miss resets the multiplier along with the combo', () => {
    const score = play([...times(12, 'perfect'), 'miss']);
    expect(scoreUnit(score, 'perfect')).toBe(100);
    expect(score.maxCombo).toBe(12);
  });

  it('reads 0% accuracy before anything resolves', () => {
    expect(accuracyOf(createScore())).toBe(0);
  });

  it('gives a star at a third, two at two thirds and three only on completion', () => {
    expect(starsFor(0, false)).toBe(0);
    expect(starsFor(0.33, false)).toBe(0);
    expect(starsFor(1 / 3, false)).toBe(1);
    expect(starsFor(0.66, false)).toBe(1);
    expect(starsFor(2 / 3, false)).toBe(2);
    expect(starsFor(1, false)).toBe(2);
    expect(starsFor(1, true)).toBe(3);
  });

  it('awards the Perfect badge only for a cleared run with no Good and no Miss', () => {
    expect(earnsPerfectBadge('cleared', play(times(5, 'perfect')))).toBe(true);
    expect(earnsPerfectBadge('cleared', play([...times(5, 'perfect'), 'good']))).toBe(false);
    expect(earnsPerfectBadge('cleared', play([...times(5, 'perfect'), 'miss']))).toBe(false);
    expect(earnsPerfectBadge('failed', play(times(5, 'perfect')))).toBe(false);
  });
});
