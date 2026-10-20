import { DIFFICULTIES, type DifficultyName } from '../chart/schema';
import {
  DEFAULT_SCROLL_DURATION_MS,
  FAIL_MODES,
  type FailMode,
  type FinalResults,
  GAME_MODES,
  type GameMode,
  MAX_SCROLL_DURATION_MS,
  MIN_SCROLL_DURATION_MS,
  type Tempo,
  TEMPOS,
} from '../game/session-contract';

/**
 * The player's save: settings and best scores. Pure data and rules, no storage;
 * `save-store.ts` keeps it in `localStorage`. Flat and JSON-only, so it can later be
 * synced to the server as one document.
 */

export const SAVE_VERSION = 2;

export interface Settings {
  /** The game last picked on Home or in Settings. */
  gameMode: GameMode;
  /** Whether the player has seen each game's How to play card. */
  seenIntro: Record<GameMode, boolean>;
  failMode: FailMode;
  /** Real ms a tile is visible before the hit line. */
  scrollDurationMs: number;
  /** The speed picked on song select. */
  tempo: Tempo;
  /** 0 to 1, on top of the engine's own headroom. */
  masterVolume: number;
  /** 0 to 1: the notes the game plays by itself, not the player's. */
  accompanimentVolume: number;
  /** 0 to 1: Tiles' sound effects. Saves from before it read as the default. */
  effectsVolume: number;
  /** The song and difficulty last picked, so song select opens on them. */
  songId: string | null;
  difficulty: DifficultyName;
  /**
   * "Don't ask again" on the delayed-sound warning: the output latency (ms) measured when
   * the player chose it, or null to ask whenever the sound is delayed. A delay far from
   * this asks again (see `BAND_TOLERANCE_MS`).
   */
  latencyWarningMutedAtMs: number | null;
}

/**
 * The best run of one song, difficulty and tempo: the score, accuracy and max combo
 * of the highest-scoring run, the most stars any run earned, and whether any run
 * earned the Perfect badge.
 */
export interface BestScore {
  score: number;
  /** 0 to 3. */
  stars: number;
  /** Percent, 0 to 100. */
  accuracy: number;
  maxCombo: number;
  perfectBadge: boolean;
  /** When the best score was set, ISO 8601. */
  achievedAt: string;
}

export interface SaveData {
  version: typeof SAVE_VERSION;
  settings: Settings;
  /** Keyed by `bestKey()`: `<mode>/<songId>/<difficulty>/<tempo>`. */
  bests: Record<string, BestScore>;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  gameMode: 'rhythm',
  seenIntro: { rhythm: false, tiles: false },
  failMode: 'classic',
  scrollDurationMs: DEFAULT_SCROLL_DURATION_MS,
  tempo: 1,
  masterVolume: 1,
  accompanimentVolume: 1,
  effectsVolume: 0.7,
  songId: null,
  difficulty: 'normal',
  latencyWarningMutedAtMs: null,
};

export function defaultSave(): SaveData {
  return {
    version: SAVE_VERSION,
    settings: { ...DEFAULT_SETTINGS, seenIntro: { ...DEFAULT_SETTINGS.seenIntro } },
    bests: {},
  };
}

export function bestKey(
  mode: GameMode,
  songId: string,
  difficulty: DifficultyName,
  tempo: Tempo,
): string {
  return `${mode}/${songId}/${difficulty}/${tempo}`;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BEST_KEY = new RegExp(
  `^(?:${GAME_MODES.join('|')})/[a-z0-9]+(?:-[a-z0-9]+)*/(?:${DIFFICULTIES.join('|')})/(?:${TEMPOS.join('|').replaceAll('.', '\\.')})$`,
);

type Fields = Partial<Record<string, unknown>>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNumberIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

/** Well above any real output latency; anything larger is not a measurement. */
const MAX_LATENCY_MS = 10_000;

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

function oneOf<T>(options: readonly T[], value: unknown, fallback: T): T {
  return options.find((option) => option === value) ?? fallback;
}

/** Each field is checked on its own: one broken value resets only itself. */
function parseSettings(json: unknown): Settings {
  const fields = isRecord(json) ? json : {};
  const d = DEFAULT_SETTINGS;
  const {
    scrollDurationMs,
    masterVolume,
    accompanimentVolume,
    effectsVolume,
    songId,
    latencyWarningMutedAtMs,
  } = fields;
  const seen = isRecord(fields.seenIntro) ? fields.seenIntro : {};
  return {
    gameMode: oneOf(GAME_MODES, fields.gameMode, d.gameMode),
    seenIntro: {
      rhythm: seen.rhythm === true,
      tiles: seen.tiles === true,
    },
    failMode: oneOf(FAIL_MODES, fields.failMode, d.failMode),
    scrollDurationMs: isNumberIn(scrollDurationMs, MIN_SCROLL_DURATION_MS, MAX_SCROLL_DURATION_MS)
      ? scrollDurationMs
      : d.scrollDurationMs,
    tempo: oneOf(TEMPOS, fields.tempo, d.tempo),
    masterVolume: isNumberIn(masterVolume, 0, 1) ? masterVolume : d.masterVolume,
    accompanimentVolume: isNumberIn(accompanimentVolume, 0, 1)
      ? accompanimentVolume
      : d.accompanimentVolume,
    effectsVolume: isNumberIn(effectsVolume, 0, 1) ? effectsVolume : d.effectsVolume,
    songId: typeof songId === 'string' && SLUG.test(songId) ? songId : d.songId,
    difficulty: oneOf(DIFFICULTIES, fields.difficulty, d.difficulty),
    latencyWarningMutedAtMs: isNumberIn(latencyWarningMutedAtMs, 0, MAX_LATENCY_MS)
      ? latencyWarningMutedAtMs
      : d.latencyWarningMutedAtMs,
  };
}

function parseBest(json: unknown): BestScore | undefined {
  if (!isRecord(json)) return undefined;
  const { score, stars, accuracy, maxCombo, perfectBadge, achievedAt } = json;
  if (!isCount(score) || !isCount(stars) || stars > 3 || !isCount(maxCombo)) return undefined;
  if (!isNumberIn(accuracy, 0, 100) || typeof perfectBadge !== 'boolean') return undefined;
  if (typeof achievedAt !== 'string') return undefined;
  return { score, stars, accuracy, maxCombo, perfectBadge, achievedAt };
}

function parseBests(json: unknown): Record<string, BestScore> {
  const bests: Record<string, BestScore> = {};
  if (!isRecord(json)) return bests;
  for (const [key, value] of Object.entries(json)) {
    const best = parseBest(value);
    if (best && BEST_KEY.test(key)) bests[key] = best;
  }
  return bests;
}

/**
 * Version 1 had one game: its settings carry over playing Rhythm, and each best
 * (`<songId>/<difficulty>/<tempo>`) becomes Rhythm's.
 */
function fromVersion1(json: Fields): Fields {
  const settings = isRecord(json.settings) ? json.settings : {};
  const bests = isRecord(json.bests) ? json.bests : {};
  return {
    version: 2,
    settings: { ...settings, gameMode: 'rhythm', seenIntro: undefined },
    bests: Object.fromEntries(
      Object.entries(bests).map(([key, best]) => [`rhythm/${key}`, best] as const),
    ),
  };
}

/**
 * Parsed JSON to a save. Never throws: anything unreadable reads as the defaults.
 *
 * Migrations go here: when the shape changes, bump `SAVE_VERSION` and the storage
 * key, and turn each older version into the current one before parsing. A save from
 * a newer version than this code knows reads as the defaults.
 */
export function parseSave(json: unknown): SaveData {
  if (!isRecord(json)) return defaultSave();
  if (json.version === 1) return parseSave(fromVersion1(json));
  if (json.version !== SAVE_VERSION) return defaultSave();
  return {
    version: SAVE_VERSION,
    settings: parseSettings(json.settings),
    bests: parseBests(json.bests),
  };
}

/**
 * Folds a finished run into the stored best for its song, difficulty and tempo.
 * `newBest` is decided against `previous`, before anything is saved: the run beat
 * the stored score (a first run must score above 0). A failed run counts too.
 */
export function mergeBest(
  previous: BestScore | undefined,
  run: FinalResults,
  achievedAt: string,
): { best: BestScore; newBest: boolean } {
  const newBest = run.score > (previous?.score ?? 0);
  const best: BestScore =
    newBest || !previous
      ? {
          score: run.score,
          stars: Math.max(run.stars, previous?.stars ?? 0),
          accuracy: run.accuracy,
          maxCombo: run.maxCombo,
          perfectBadge: run.perfectBadge || (previous?.perfectBadge ?? false),
          achievedAt,
        }
      : {
          ...previous,
          stars: Math.max(run.stars, previous.stars),
          perfectBadge: run.perfectBadge || previous.perfectBadge,
        };
  return { best, newBest };
}
