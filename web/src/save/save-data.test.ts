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
    mode: 'rhythm',
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
      version: 2 as const,
      settings: {
        ...DEFAULT_SETTINGS,
        gameMode: 'tiles' as const,
        seenIntro: { rhythm: false, tiles: true },
        failMode: 'relaxed' as const,
        tempo: 1.25 as const,
        masterVolume: 0.4,
        effectsVolume: 0.25,
        songId: 'fur-elise',
        difficulty: 'hard' as const,
        latencyWarningMutedAtMs: 187,
      },
      bests: { 'rhythm/fur-elise/hard/1.25': best(), 'tiles/fur-elise/hard/1.25': best() },
    };
    expect(parseSave(JSON.parse(JSON.stringify(save)))).toEqual(save);
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['an array', []],
    ['a string', 'save'],
    ['no version', { settings: { tempo: 1.5 } }],
    ['a newer version', { version: 3, settings: { tempo: 1.5 } }],
  ])('reads %s as the defaults', (_, json) => {
    expect(parseSave(json)).toEqual(defaultSave());
  });

  it('keeps every valid setting and resets only the broken ones', () => {
    const { settings } = parseSave({
      version: 2,
      settings: {
        gameMode: 'piano',
        seenIntro: { rhythm: 'yes', tiles: true },
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
      seenIntro: { rhythm: false, tiles: true },
      failMode: 'relaxed',
      masterVolume: 0.5,
      difficulty: 'easy',
    });
  });

  it('keeps a saved "don\'t ask again" latency, and reads anything else as asking', () => {
    const read = (value: unknown) =>
      parseSave({ version: 2, settings: { latencyWarningMutedAtMs: value } }).settings
        .latencyWarningMutedAtMs;
    expect(read(187)).toBe(187);
    expect(read(0)).toBe(0);
    for (const bad of [-1, Number.NaN, 1e9, '187', true, undefined, null]) {
      expect(read(bad)).toBeNull();
    }
  });

  it('keeps a saved effects volume, and reads anything else as the default', () => {
    const read = (value: unknown) =>
      parseSave({ version: 2, settings: { effectsVolume: value } }).settings.effectsVolume;
    expect(DEFAULT_SETTINGS.effectsVolume).toBe(0.7);
    expect(read(0)).toBe(0);
    expect(read(0.35)).toBe(0.35);
    expect(read(1)).toBe(1);
    for (const bad of [-0.1, 1.01, Number.NaN, Infinity, '0.5', true, null, undefined]) {
      expect(read(bad)).toBe(0.7);
    }
  });

  it('loads a save written before the effects, at the default effects volume', () => {
    const { settings } = parseSave({
      version: 2,
      settings: { gameMode: 'tiles', masterVolume: 0.5, accompanimentVolume: 0.3 },
    });
    expect(settings).toEqual({
      ...DEFAULT_SETTINGS,
      gameMode: 'tiles',
      masterVolume: 0.5,
      accompanimentVolume: 0.3,
    });
    expect(settings.effectsVolume).toBe(0.7);
  });

  it('keeps a saved tile size, and reads anything else as Normal', () => {
    const read = (value: unknown) =>
      parseSave({ version: 2, settings: { tileSize: value } }).settings.tileSize;
    expect(DEFAULT_SETTINGS.tileSize).toBe('normal');
    expect(read('big')).toBe('big');
    expect(read('normal')).toBe('normal');
    for (const bad of ['huge', 'Big', 2, true, null, undefined]) {
      expect(read(bad)).toBe('normal');
    }
  });

  it('loads a save written before the tile size at Normal, keeping everything else', () => {
    const old = {
      ...DEFAULT_SETTINGS,
      gameMode: 'tiles' as const,
      failMode: 'relaxed' as const,
      scrollDurationMs: 2000,
    };
    const withoutSize = Object.fromEntries(
      Object.entries(old).filter(([key]) => key !== 'tileSize'),
    );
    const { settings } = parseSave({ version: 2, settings: withoutSize });
    expect(settings).toEqual({ ...old, tileSize: 'normal' });
  });

  it('loads a save written before the latency warning, asking by default', () => {
    const { settings } = parseSave({
      version: 2,
      settings: { failMode: 'relaxed', masterVolume: 0.5 },
    });
    expect(settings).toEqual({ ...DEFAULT_SETTINGS, failMode: 'relaxed', masterVolume: 0.5 });
    expect(settings.latencyWarningMutedAtMs).toBeNull();
  });

  it('drops best scores with a bad key or bad values, and keeps the rest', () => {
    const { bests } = parseSave({
      version: 2,
      bests: {
        'rhythm/fur-elise/normal/1': best(),
        'tiles/fur-elise/normal/1': best(),
        'fur-elise/normal/1': best(),
        'piano/fur-elise/normal/1': best(),
        'rhythm/fur-elise/normal/2': best(),
        'rhythm/fur-elise/extreme/1': best(),
        'rhythm/satie/easy/0.75': { ...best(), stars: 4 },
        'rhythm/satie/easy/1': { ...best(), score: -5 },
        'rhythm/satie/hard/1.5': 'great',
      },
    });
    expect(bests).toEqual({
      'rhythm/fur-elise/normal/1': best(),
      'tiles/fur-elise/normal/1': best(),
    });
  });

  describe('a version 1 save', () => {
    const v1 = {
      version: 1,
      settings: {
        failMode: 'relaxed',
        scrollDurationMs: 2000,
        tempo: 1.25,
        masterVolume: 0.4,
        accompanimentVolume: 0.7,
        songId: 'satie',
        difficulty: 'hard',
        latencyWarningMutedAtMs: 187,
      },
      bests: {
        'fur-elise/normal/1': best(),
        'satie/hard/1.25': best({ score: 2400, stars: 2 }),
        'satie/extreme/1': best(),
      },
    };

    it('becomes a version 2 save with its settings, playing Rhythm', () => {
      expect(parseSave(v1)).toEqual({
        version: 2,
        settings: {
          ...v1.settings,
          gameMode: 'rhythm',
          seenIntro: { rhythm: false, tiles: false },
          // Version 1 had no effects and one tile size: the defaults.
          effectsVolume: 0.7,
          tileSize: 'normal',
        },
        bests: {
          'rhythm/fur-elise/normal/1': best(),
          'rhythm/satie/hard/1.25': best({ score: 2400, stars: 2 }),
        },
      });
    });

    it('never takes a game choice or a game-keyed best from it', () => {
      const { settings, bests } = parseSave({
        version: 1,
        settings: { gameMode: 'tiles', seenIntro: { tiles: true } },
        bests: { 'tiles/fur-elise/normal/1': best() },
      });
      expect(settings.gameMode).toBe('rhythm');
      expect(settings.seenIntro).toEqual({ rhythm: false, tiles: false });
      expect(bests).toEqual({});
    });

    it('reads anything broken in it as the defaults, without throwing', () => {
      expect(parseSave({ version: 1, settings: 'x', bests: [] })).toEqual(defaultSave());
    });
  });

  it('does not share the default objects between saves', () => {
    const a = defaultSave();
    a.settings.tempo = 1.5;
    a.settings.seenIntro.tiles = true;
    a.bests.x = best();
    expect(defaultSave().settings.tempo).toBe(1);
    expect(defaultSave().settings.seenIntro.tiles).toBe(false);
    expect(defaultSave().bests).toEqual({});
  });
});

describe('bestKey', () => {
  it('is game, song, difficulty and tempo', () => {
    expect(bestKey('rhythm', 'fur-elise', 'hard', 0.75)).toBe('rhythm/fur-elise/hard/0.75');
    expect(bestKey('tiles', 'fur-elise', 'normal', 1)).toBe('tiles/fur-elise/normal/1');
  });

  it('keeps each game apart', () => {
    expect(bestKey('rhythm', 'fur-elise', 'normal', 1)).not.toBe(
      bestKey('tiles', 'fur-elise', 'normal', 1),
    );
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
