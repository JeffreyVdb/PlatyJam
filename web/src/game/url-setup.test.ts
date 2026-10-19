import { describe, expect, it } from 'vitest';
import { DEFAULT_SONG, setupFromQuery } from './url-setup';

describe('setupFromQuery', () => {
  it('uses the defaults without parameters', () => {
    expect(setupFromQuery('')).toEqual({
      song: DEFAULT_SONG,
      difficulty: 'normal',
      tempo: 1,
      failMode: 'classic',
      scrollDurationMs: 1600,
    });
  });

  it('reads every parameter', () => {
    expect(
      setupFromQuery(
        '?song=beethoven-pathetique-rondo&difficulty=hard&tempo=1.5&fail=relaxed&scroll=900&debug',
      ),
    ).toEqual({
      song: 'beethoven-pathetique-rondo',
      difficulty: 'hard',
      tempo: 1.5,
      failMode: 'relaxed',
      scrollDurationMs: 900,
    });
  });

  it('falls back to the default for each invalid value', () => {
    expect(
      setupFromQuery('?song=../etc/passwd&difficulty=extreme&tempo=2&fail=hardcore&scroll=50'),
    ).toEqual(setupFromQuery(''));
    expect(setupFromQuery('?song=Not_A_Slug&tempo=abc&scroll=abc').song).toBe(DEFAULT_SONG);
    expect(setupFromQuery('?scroll=99999').scrollDurationMs).toBe(1600);
  });
});
