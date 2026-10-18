// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Tile } from '../../src/chart/schema.ts';
import { laneRuleIssues } from './rules.ts';

const tap = (t: number, lane: number, pitch = 60): Tile => ({ t, lane, pitches: [pitch], vel: 90 });

describe('laneRuleIssues', () => {
  it('passes a clean pattern', () => {
    expect(laneRuleIssues([tap(0, 0, 60), tap(0, 2, 67), tap(100, 0), tap(200, 1)], 100)).toEqual(
      [],
    );
  });

  it('measures the lane gap from the end of a hold', () => {
    const tiles = [{ ...tap(0, 0), dur: 500 }, tap(550, 0)];
    expect(laneRuleIssues(tiles, 100)).toEqual([
      {
        index: 1,
        message:
          'tile at 550 in lane 0 is 50 ms after the previous one there ends; the minimum is 100 ms',
      },
    ]);
  });

  it('wants the lower note of a double on the left', () => {
    expect(laneRuleIssues([tap(0, 0, 72), tap(0, 1, 60)], 0)[0]?.message).toMatch(/lower note/);
  });

  it('includes the chart format rules', () => {
    const issues = laneRuleIssues([tap(0, 0), tap(0, 1, 62), tap(0, 2, 64)], 0);
    expect(issues.map((issue) => issue.message)).toContain('more than two tiles at 0');
    expect(issues.map((issue) => issue.message)).toContain(
      '3 tiles active at 0; at most 2 allowed',
    );
  });
});
