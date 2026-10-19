import { DIFFICULTIES, type DifficultyName } from '../chart/schema';
import {
  DEFAULT_SCROLL_DURATION_MS,
  FAIL_MODES,
  type FailMode,
  MAX_SCROLL_DURATION_MS,
  MIN_SCROLL_DURATION_MS,
  type Tempo,
  TEMPOS,
} from './session-contract';

/**
 * A stand-in for PLA-7's song select and settings: the session inputs come from the
 * query string, e.g. `?song=beethoven-fur-elise&difficulty=hard&tempo=1.25&fail=relaxed&scroll=1200`.
 * Every missing or invalid value falls back to its default.
 */
export interface UrlSetup {
  /** Chart id: `songs/<song>.json`. */
  song: string;
  difficulty: DifficultyName;
  tempo: Tempo;
  failMode: FailMode;
  scrollDurationMs: number;
}

export const DEFAULT_SONG = 'beethoven-fur-elise';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function oneOf<T extends string | number>(options: readonly T[], value: unknown, fallback: T): T {
  return options.find((option) => option === value) ?? fallback;
}

export function setupFromQuery(search: string): UrlSetup {
  const params = new URLSearchParams(search);
  const song = params.get('song') ?? '';
  const scroll = Number(params.get('scroll') ?? Number.NaN);
  return {
    song: SLUG.test(song) ? song : DEFAULT_SONG,
    difficulty: oneOf(DIFFICULTIES, params.get('difficulty'), 'normal'),
    tempo: oneOf(TEMPOS, Number(params.get('tempo') ?? 1), 1),
    failMode: oneOf(FAIL_MODES, params.get('fail'), 'classic'),
    scrollDurationMs:
      Number.isFinite(scroll) &&
      scroll >= MIN_SCROLL_DURATION_MS &&
      scroll <= MAX_SCROLL_DURATION_MS
        ? scroll
        : DEFAULT_SCROLL_DURATION_MS,
  };
}
