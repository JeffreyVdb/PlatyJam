import { describe, expect, it, vi } from 'vitest';
import type { FinalResults } from '../game/session-contract';
import { DEFAULT_SETTINGS, defaultSave } from './save-data';
import { createSaveStore, SAVE_KEY, STORAGE_KEYS } from './save-store';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
  };
}

const run: FinalResults = {
  outcome: 'cleared',
  songId: 'fur-elise',
  songTitle: 'Für Elise',
  difficulty: 'hard',
  tempo: 1.25,
  failMode: 'classic',
  score: 4200,
  combo: 0,
  maxCombo: 40,
  perfect: 30,
  good: 10,
  miss: 0,
  accuracy: 87.5,
  progress: 1,
  stars: 3,
  perfectBadge: false,
};

const now = () => new Date('2026-10-19T10:00:00Z');
const saved = (storage: ReturnType<typeof memoryStorage>): unknown =>
  JSON.parse(storage.data.get(SAVE_KEY) ?? 'null');

describe('save store', () => {
  it('documents every key it and the calibration use', () => {
    expect(STORAGE_KEYS).toEqual({
      save: 'platyjam.save.v1',
      calibration: 'platyjam.calibration.v1',
    });
    expect(SAVE_KEY).toBe(STORAGE_KEYS.save);
  });

  it('starts from the defaults and writes each settings change at once', () => {
    const storage = memoryStorage();
    const store = createSaveStore({ storage: () => storage, now });
    expect(store.settings).toEqual(DEFAULT_SETTINGS);
    store.updateSettings({ tempo: 1.5, failMode: 'relaxed' });
    expect(store.settings).toMatchObject({ tempo: 1.5, failMode: 'relaxed' });
    expect(saved(storage)).toMatchObject({ version: 1, settings: { tempo: 1.5 } });
    expect(store.persistent).toBe(true);
  });

  it('reads back what an earlier session saved', () => {
    const storage = memoryStorage();
    const first = createSaveStore({ storage: () => storage, now });
    first.updateSettings({ masterVolume: 0.25 });
    first.recordResults(run);
    const second = createSaveStore({ storage: () => storage, now });
    expect(second.settings.masterVolume).toBe(0.25);
    expect(second.best('fur-elise', 'hard', 1.25)).toMatchObject({ score: 4200, stars: 3 });
    expect(second.best('fur-elise', 'hard', 1)).toBeUndefined();
  });

  it('decides a new best against the stored best before saving it', () => {
    const storage = memoryStorage();
    const store = createSaveStore({ storage: () => storage, now });
    expect(store.recordResults(run)).toMatchObject({ newBest: true, previous: undefined });
    const again = store.recordResults({ ...run, score: 3000 });
    expect(again).toMatchObject({ newBest: false, previous: { score: 4200 } });
    expect(store.recordResults({ ...run, score: 5000 })).toMatchObject({
      newBest: true,
      previous: { score: 4200 },
      best: { score: 5000, achievedAt: '2026-10-19T10:00:00.000Z' },
    });
    expect(saved(storage)).toMatchObject({ bests: { 'fur-elise/hard/1.25': { score: 5000 } } });
  });

  it('reads corrupt data as the defaults without throwing, and overwrites it on change', () => {
    const storage = memoryStorage({ [SAVE_KEY]: '{not json' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = createSaveStore({ storage: () => storage, now });
    expect(store.settings).toEqual(DEFAULT_SETTINGS);
    expect(store.persistent).toBe(true);
    store.updateSettings({ tempo: 0.75 });
    expect(saved(storage)).toMatchObject({ settings: { tempo: 0.75 } });
    warn.mockRestore();
  });

  it('keeps working in memory when storage cannot even be reached, and says so once', () => {
    const onUnavailable = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = createSaveStore({
      storage: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      now,
      onUnavailable,
    });
    expect(store.settings).toEqual(defaultSave().settings);
    store.updateSettings({ tempo: 1.25 });
    store.recordResults(run);
    expect(store.settings.tempo).toBe(1.25);
    expect(store.best('fur-elise', 'hard', 1.25)?.score).toBe(4200);
    expect(store.persistent).toBe(false);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('keeps progress in memory when a write is refused, and says so once', () => {
    const storage = memoryStorage();
    storage.setItem.mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const onUnavailable = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = createSaveStore({ storage: () => storage, now, onUnavailable });
    store.updateSettings({ tempo: 1.25 });
    store.updateSettings({ tempo: 1.5 });
    expect(store.settings.tempo).toBe(1.5);
    expect(store.persistent).toBe(false);
    expect(onUnavailable).toHaveBeenCalledTimes(1);

    // Storage recovers: the next write (or flush) saves everything again.
    storage.setItem.mockImplementation((key: string, value: string) => {
      storage.data.set(key, value);
    });
    store.flush();
    expect(saved(storage)).toMatchObject({ settings: { tempo: 1.5 } });
    expect(store.persistent).toBe(true);
    warn.mockRestore();
  });

  it('treats a missing localStorage as unavailable', () => {
    const onUnavailable = vi.fn();
    const store = createSaveStore({ storage: () => null, now, onUnavailable });
    store.updateSettings({ tempo: 1.25 });
    expect(store.persistent).toBe(false);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it('hands out copies, so callers cannot change the save behind its back', () => {
    const store = createSaveStore({ storage: () => memoryStorage(), now });
    store.recordResults(run);
    const best = store.best('fur-elise', 'hard', 1.25);
    if (best) best.score = 1;
    expect(store.best('fur-elise', 'hard', 1.25)?.score).toBe(4200);
  });
});
