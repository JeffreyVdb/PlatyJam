import { describe, expect, it } from 'vitest';
import type { FinalResults } from '../game/session-contract';
import {
  bestKey,
  type BestScore,
  DEFAULT_SETTINGS,
  defaultSave,
  mergeBest,
  parseSave,
} from './save-data';

function results(overrides: Partial<FinalResults> = {}): FinalResults {
  return {
    outcome: 'cleared',
    songId: 'fur-elise',
    songTitle: 'Für Elise',
    difficulty: 'normal',
    tempo: 1,
    failMode: 'classic',
    score: 1000,
    combo: 0,
    maxCombo: 20,
    perfect: 15,
    good: 5,
    miss: 0,
    accuracy: 87.5,
    progress: 1,
    stars: 3,
    perfectBadge: false,
    ...overrides,
  };
}

const AT = '2026-10-19T10:00:00.000Z';
const LATER = '2026-10-20T10:00:00.000Z';

const best = (overrides: Partial<BestScore> = {}): BestScore => ({
  score: 1000,
  stars: 3,
  accuracy: 87.5,
  maxCombo: 20,
  perfectBadge: false,
  achievedAt: AT,
  ...overrides,
});

describe('parseSave', () => {
  it('round-trips a valid save', () => {
    const save = {
      version: 1 as const,
      settings: {
        ...DEFAULT_SETTINGS,
        failMode: 'relaxed' as const,
        tempo: 1.25 as const,
        masterVolume: 0.4,
        songId: 'fur-elise',
        difficulty: 'hard' as const,
      },
      bests: { 'fur-elise/hard/1.25': best() },
    };
    expect(parseSave(JSON.parse(JSON.stringify(save)))).toEqual(save);
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['an array', []],
    ['a string', 'save'],
    ['no version', { settings: { tempo: 1.5 } }],
    ['a newer version', { version: 2, settings: { tempo: 1.5 } }],
  ])('reads %s as the defaults', (_, json) => {
    expect(parseSave(json)).toEqual(defaultSave());
  });

  it('keeps every valid setting and resets only the broken ones', () => {
    const { settings } = parseSave({
      version: 1,
      settings: {
        failMode: 'relaxed',
        scrollDurationMs: 99999,
        tempo: 1.1,
        masterVolume: 0.5,
        accompanimentVolume: Number.NaN,
        songId: 'Not A Slug',
        difficulty: 'easy',
      },
    });
    expect(settings).toEqual({
      ...DEFAULT_SETTINGS,
      failMode: 'relaxed',
      masterVolume: 0.5,
      difficulty: 'easy',
    });
  });

  it('drops best scores with a bad key or bad values, and keeps the rest', () => {
    const { bests } = parseSave({
      version: 1,
      bests: {
        'fur-elise/normal/1': best(),
        'fur-elise/normal/2': best(),
        'fur-elise/extreme/1': best(),
        'satie/easy/0.75': { ...best(), stars: 4 },
        'satie/easy/1': { ...best(), score: -5 },
        'satie/hard/1.5': 'great',
      },
    });
    expect(bests).toEqual({ 'fur-elise/normal/1': best() });
  });

  it('does not share the default objects between saves', () => {
    const a = defaultSave();
    a.settings.tempo = 1.5;
    a.bests.x = best();
    expect(defaultSave().settings.tempo).toBe(1);
    expect(defaultSave().bests).toEqual({});
  });
});

describe('bestKey', () => {
  it('is song, difficulty and tempo', () => {
    expect(bestKey('fur-elise', 'hard', 0.75)).toBe('fur-elise/hard/0.75');
    expect(bestKey('fur-elise', 'normal', 1)).toBe('fur-elise/normal/1');
  });
});

describe('mergeBest', () => {
  it('records a first run with a score as a new best', () => {
    expect(mergeBest(undefined, results(), AT)).toEqual({ best: best(), newBest: true });
  });

  it('records a first run that scored nothing, without calling it a new best', () => {
    const merged = mergeBest(undefined, results({ score: 0, stars: 0, accuracy: 0 }), AT);
    expect(merged.newBest).toBe(false);
    expect(merged.best).toMatchObject({ score: 0, stars: 0 });
  });

  it('replaces the run with a higher score', () => {
    const merged = mergeBest(
      best(),
      results({ score: 1500, accuracy: 80, maxCombo: 12, stars: 2, outcome: 'failed' }),
      LATER,
    );
    expect(merged).toEqual({
      // The stars never drop: the earlier run cleared the song.
      best: best({ score: 1500, accuracy: 80, maxCombo: 12, stars: 3, achievedAt: LATER }),
      newBest: true,
    });
  });

  it('lets a failed run set a best: it keeps its stars and score', () => {
    const merged = mergeBest(
      best({ score: 200, stars: 0 }),
      results({ outcome: 'failed', score: 600, stars: 1, progress: 0.4 }),
      LATER,
    );
    expect(merged.newBest).toBe(true);
    expect(merged.best).toMatchObject({ score: 600, stars: 1, achievedAt: LATER });
  });

  it('keeps the best run on an equal or lower score, but counts more stars and the badge', () => {
    expect(mergeBest(best(), results(), LATER)).toEqual({ best: best(), newBest: false });
    const merged = mergeBest(
      best({ stars: 2 }),
      results({ score: 900, stars: 3, perfectBadge: true, accuracy: 100 }),
      LATER,
    );
    expect(merged).toEqual({ best: best({ stars: 3, perfectBadge: true }), newBest: false });
  });
});
