import type { DifficultyName } from '../chart/schema';
import type { FinalResults, Tempo } from '../game/session-contract';
import {
  bestKey,
  type BestScore,
  mergeBest,
  parseSave,
  type SaveData,
  type Settings,
} from './save-data';

/**
 * Every `localStorage` key PlatyJam writes, `platyjam.<name>.v<N>`. A new kind of
 * saved data gets its key here, and a new schema version a new key.
 *
 * - `save`: settings and best scores, written by this module (`SaveData`).
 * - `calibration`: the latency offsets, written by `audio/calibration-store.ts`
 *   (`{ version: 1, audioOffsetMs, inputOffsetMs, calibratedAt }`).
 */
export const STORAGE_KEYS = {
  save: 'platyjam.save.v1',
  calibration: 'platyjam.calibration.v1',
} as const;

export const SAVE_KEY = STORAGE_KEYS.save;

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** A getter, because touching `window.localStorage` can itself throw (blocked storage). */
export type StorageAccess = () => KeyValueStorage | null;

export const defaultStorage: StorageAccess = () => window.localStorage;

export interface RecordedResults {
  /** The run beat the stored best score. */
  newBest: boolean;
  /** The stored best before this run. */
  previous: BestScore | undefined;
  /** The stored best now. */
  best: BestScore;
}

/**
 * The player's settings and best scores, kept in `localStorage` under `SAVE_KEY`.
 * Every change is written at once. Reads and writes never throw: when storage is
 * blocked, full or missing, the save lives in memory for the session.
 */
export interface SaveStore {
  readonly settings: Readonly<Settings>;
  updateSettings(patch: Partial<Settings>): void;
  best(songId: string, difficulty: DifficultyName, tempo: Tempo): BestScore | undefined;
  /** Folds a finished run into its best, deciding `newBest` first, and saves. */
  recordResults(results: FinalResults): RecordedResults;
  /** Writes the save again (on the lifecycle `pause`, or to retry a refused write). */
  flush(): void;
  /** False while storage refuses us: progress then lasts only until PlatyJam closes. */
  readonly persistent: boolean;
}

export interface SaveStoreOptions {
  storage?: StorageAccess;
  now?: () => Date;
  /** Called once, the first time storage refuses a read or a write. */
  onUnavailable?: () => void;
}

export function createSaveStore({
  storage = defaultStorage,
  now = () => new Date(),
  onUnavailable,
}: SaveStoreOptions = {}): SaveStore {
  let persistent = true;
  let told = false;

  const refused = (what: string, error?: unknown) => {
    persistent = false;
    if (error !== undefined) console.warn(`[platyjam] could not ${what} the save`, error);
    if (told) return;
    told = true;
    onUnavailable?.();
  };

  const read = (): SaveData => {
    let raw: string | null;
    try {
      const target = storage();
      if (!target) {
        refused('read');
        return parseSave(undefined);
      }
      raw = target.getItem(SAVE_KEY);
    } catch (error) {
      refused('read', error);
      return parseSave(undefined);
    }
    if (raw === null) return parseSave(undefined);
    try {
      return parseSave(JSON.parse(raw));
    } catch (error) {
      console.warn('[platyjam] the save was unreadable; starting afresh', error);
      return parseSave(undefined);
    }
  };

  const data = read();

  const write = () => {
    try {
      const target = storage();
      if (!target) {
        refused('write');
        return;
      }
      target.setItem(SAVE_KEY, JSON.stringify(data));
      persistent = true;
    } catch (error) {
      refused('write', error);
    }
  };

  return {
    get settings() {
      return data.settings;
    },
    updateSettings(patch) {
      Object.assign(data.settings, patch);
      write();
    },
    best(songId, difficulty, tempo) {
      const best = data.bests[bestKey(songId, difficulty, tempo)];
      return best ? { ...best } : undefined;
    },
    recordResults(results) {
      const key = bestKey(results.songId, results.difficulty, results.tempo);
      const previous = data.bests[key];
      const { best, newBest } = mergeBest(previous, results, now().toISOString());
      data.bests[key] = best;
      write();
      return { newBest, previous: previous && { ...previous }, best: { ...best } };
    },
    flush: write,
    get persistent() {
      return persistent;
    },
  };
}
