import { describe, expect, it } from 'vitest';
import { COMBO_MILESTONE, effectCues, GAME_EFFECTS } from './effect-cues';
import type { JudgmentEvent } from './session-contract';

const event = (
  unit: JudgmentEvent['unit'],
  judgment: JudgmentEvent['judgment'],
  combo = 3,
): Pick<JudgmentEvent, 'unit' | 'judgment' | 'combo'> => ({ unit, judgment, combo });

describe('effectCues', () => {
  it('plays effects in Tiles only: Rhythm sounds as it always did', () => {
    expect(GAME_EFFECTS).toEqual({ rhythm: false, tiles: true });
    for (const unit of ['tap', 'head', 'tail', 'empty'] as const) {
      for (const judgment of ['perfect', 'good', 'clear', 'miss'] as const) {
        expect(effectCues(event(unit, judgment, COMBO_MILESTONE), 'rhythm')).toEqual({
          oneShots: [],
        });
      }
    }
  });

  it('knocks and sparkles a tap tile, which one press claims and clears', () => {
    expect(effectCues(event('tap', 'clear'), 'tiles')).toEqual({ oneShots: ['tap', 'clear'] });
  });

  it('knocks a long tile when it is claimed and starts its fill', () => {
    expect(effectCues(event('head', 'clear'), 'tiles')).toEqual({
      oneShots: ['tap'],
      fill: 'start',
    });
  });

  it('plays the bigger sparkle when a long tile completes, and ends its fill', () => {
    expect(effectCues(event('tail', 'clear'), 'tiles')).toEqual({
      oneShots: ['complete'],
      fill: 'stop',
    });
  });

  it('thuds on every Miss, and ends the fill of a long tile let go early', () => {
    expect(effectCues(event('tap', 'miss', 0), 'tiles')).toEqual({ oneShots: ['miss'] });
    expect(effectCues(event('head', 'miss', 0), 'tiles')).toEqual({ oneShots: ['miss'] });
    expect(effectCues(event('empty', 'miss', 0), 'tiles')).toEqual({ oneShots: ['miss'] });
    expect(effectCues(event('tail', 'miss', 0), 'tiles')).toEqual({
      oneShots: ['miss'],
      fill: 'stop',
    });
  });

  it(`adds the combo flourish every ${COMBO_MILESTONE} in a row, and only then`, () => {
    expect(COMBO_MILESTONE).toBe(50);
    expect(effectCues(event('tap', 'clear', 50), 'tiles').oneShots).toEqual([
      'tap',
      'clear',
      'combo',
    ]);
    expect(effectCues(event('head', 'clear', 100), 'tiles').oneShots).toEqual(['tap', 'combo']);
    expect(effectCues(event('tail', 'clear', 150), 'tiles').oneShots).toEqual([
      'complete',
      'combo',
    ]);
    for (const combo of [0, 1, 49, 51, 99]) {
      expect(effectCues(event('tap', 'clear', combo), 'tiles').oneShots).not.toContain('combo');
    }
    // A Miss resets the combo to 0: never a milestone.
    expect(effectCues(event('tap', 'miss', 0), 'tiles').oneShots).not.toContain('combo');
  });
});
