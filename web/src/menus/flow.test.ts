import { describe, expect, it } from 'vitest';
import type { CatalogSong } from '../catalog/schema';
import type { LoadingInfo, SessionState } from '../game/session-contract';
import { DEFAULT_SETTINGS } from '../save/save-data';
import {
  backFrom,
  formatDuration,
  formatTempo,
  isModal,
  nearestScrollSpeed,
  offeredGameModes,
  playButtonFor,
  resolveGameMode,
  resolveSelection,
  SCROLL_SPEEDS,
  setupKey,
  type View,
  viewFor,
} from './flow';

const loading = (
  chartLoaded: boolean,
  loaded = 0,
  backing: LoadingInfo['backing'] = 'none',
): LoadingInfo => ({
  chartLoaded,
  samples: { loaded, failed: 0, total: 88 },
  backing,
});

const song = (id: string): CatalogSong => ({
  id,
  title: id,
  composer: 'c',
  arranger: 'a',
  durationMs: 1000,
  bpm: 100,
  difficulties: {
    easy: { tiles: 1, notesPerSecond: 1 },
    normal: { tiles: 1, notesPerSecond: 1 },
    hard: { tiles: 1, notesPerSecond: 1 },
  },
});

describe('viewFor', () => {
  it.each<[SessionState, string]>([
    ['loading', 'songs'],
    ['ready', 'songs'],
    ['quit', 'songs'],
    ['error', 'songs'],
    ['starting', 'play'],
    ['leadIn', 'play'],
    ['playing', 'play'],
    ['failing', 'play'],
    ['paused', 'pause'],
    ['countdown', 'countdown'],
    ['finished', 'results'],
  ])('shows the menu outside a run, and the run screens during one (%s → %s)', (state, view) => {
    expect(viewFor('songs', state)).toBe(view);
  });

  it('keeps whichever menu screen is open while nothing runs', () => {
    expect(viewFor('home', 'loading')).toBe('home');
    expect(viewFor('settings', 'ready')).toBe('settings');
    expect(viewFor('credits', 'paused')).toBe('pause');
  });
});

describe('backFrom', () => {
  it('goes Settings and Credits → Songs → Home, and no further', () => {
    expect(backFrom('settings')).toBe('songs');
    expect(backFrom('credits')).toBe('songs');
    expect(backFrom('songs')).toBe('home');
    expect(backFrom('home')).toBeUndefined();
  });
});

describe('isModal', () => {
  it('covers the stage for menus, pause and results, but not for play or the countdown', () => {
    const covering: View[] = ['home', 'songs', 'settings', 'credits', 'pause', 'results'];
    expect(covering.every(isModal)).toBe(true);
    expect(isModal('play')).toBe(false);
    expect(isModal('countdown')).toBe(false);
  });
});

describe('playButtonFor', () => {
  const base = { error: undefined, online: true, startFailed: false };

  it('starts once loaded, from ready, quit or finished', () => {
    for (const state of ['ready', 'quit', 'finished'] as const) {
      expect(playButtonFor({ ...base, state, loading: loading(true, 88) })).toEqual({
        action: 'start',
        label: 'Play',
        note: '',
      });
    }
  });

  it('shows the download, then the piano, while loading', () => {
    expect(playButtonFor({ ...base, state: 'loading', loading: loading(false) })).toEqual({
      action: 'wait',
      label: 'Loading',
      note: 'Fetching the song',
    });
    expect(playButtonFor({ ...base, state: 'loading', loading: loading(true, 40) })).toEqual({
      action: 'wait',
      label: 'Loading',
      note: 'Tuning the piano: 40 of 88 notes',
    });
  });

  it("waits for the song's recording once the piano is in", () => {
    const wait = (loaded: number) =>
      playButtonFor({ ...base, state: 'loading', loading: loading(true, loaded, 'loading') });
    expect(wait(40).note).toBe('Tuning the piano: 40 of 88 notes');
    expect(wait(88)).toEqual({
      action: 'wait',
      label: 'Loading',
      note: 'Fetching the recording',
    });
  });

  it('offers to fetch a song again that did not download', () => {
    const failed = { ...base, state: 'error' as const, loading: loading(false) };
    expect(playButtonFor({ ...failed, error: "This song didn't load. HTTP 500" })).toEqual({
      action: 'retry',
      label: 'Try again',
      note: "This song didn't download. Check your connection and try again, or pick another song.",
    });
    expect(playButtonFor({ ...failed, error: 'x', online: false })).toEqual({
      action: 'retry',
      label: 'Try again',
      note: "This song isn't on this device yet. Connect to the internet once to download it, or pick a song you've played before.",
    });
  });

  it('offers a reload when the piano is what failed: the samples load once per launch', () => {
    expect(
      playButtonFor({
        ...base,
        state: 'error',
        loading: loading(true, 80),
        error: 'Notes missing.',
      }),
    ).toEqual({ action: 'reload', label: 'Reload', note: 'Notes missing.' });
  });

  it('says so when the sound did not start, and lets the next tap try again', () => {
    expect(
      playButtonFor({ ...base, state: 'ready', loading: loading(true, 88), startFailed: true }),
    ).toEqual({
      action: 'start',
      label: 'Play',
      note: "The sound didn't start. Tap Play again.",
    });
  });

  it('waits while a start is under way', () => {
    expect(playButtonFor({ ...base, state: 'starting', loading: loading(true, 88) })).toEqual({
      action: 'wait',
      label: 'Starting',
      note: '',
    });
  });
});

describe('resolveSelection', () => {
  const catalog = [song('gentle'), song('busy')];

  it('picks up the saved song, difficulty and speed', () => {
    expect(
      resolveSelection(
        { ...DEFAULT_SETTINGS, songId: 'busy', difficulty: 'hard', tempo: 1.5 },
        catalog,
      ),
    ).toEqual({ songId: 'busy', difficulty: 'hard', tempo: 1.5 });
  });

  it('falls back to the first song when the saved one is gone', () => {
    expect(resolveSelection({ ...DEFAULT_SETTINGS, songId: 'removed' }, catalog).songId).toBe(
      'gentle',
    );
    expect(resolveSelection(DEFAULT_SETTINGS, catalog).songId).toBe('gentle');
  });
});

describe('setupKey', () => {
  it('changes with anything that needs a new load()', () => {
    const settings = { ...DEFAULT_SETTINGS };
    const selection = { songId: 'a', difficulty: 'easy' as const, tempo: 1 as const };
    const key = setupKey(selection, settings, 'rhythm');
    expect(setupKey({ ...selection }, { ...settings, masterVolume: 0.2 }, 'rhythm')).toBe(key);
    expect(setupKey({ ...selection, tempo: 1.5 }, settings, 'rhythm')).not.toBe(key);
    expect(setupKey(selection, { ...settings, failMode: 'relaxed' }, 'rhythm')).not.toBe(key);
    expect(setupKey(selection, { ...settings, scrollDurationMs: 900 }, 'rhythm')).not.toBe(key);
    expect(setupKey(selection, settings, 'tiles')).not.toBe(key);
  });

  it('includes the game played, which may differ from the saved one', () => {
    const settings = { ...DEFAULT_SETTINGS, gameMode: 'tiles' as const };
    const selection = { songId: 'a', difficulty: 'easy' as const, tempo: 1 as const };
    expect(setupKey(selection, settings, 'rhythm')).toBe(
      setupKey(selection, { ...settings, gameMode: 'rhythm' }, 'rhythm'),
    );
  });
});

describe('the Tiles gate', () => {
  it('offers Tiles only with ?debug', () => {
    expect(offeredGameModes(false)).toEqual(['rhythm']);
    expect(offeredGameModes(true)).toEqual(['rhythm', 'tiles']);
  });

  it('plays a saved Tiles choice as Rhythm while Tiles is not offered', () => {
    expect(resolveGameMode('tiles', ['rhythm'])).toBe('rhythm');
    expect(resolveGameMode('tiles', ['rhythm', 'tiles'])).toBe('tiles');
    expect(resolveGameMode('rhythm', ['rhythm', 'tiles'])).toBe('rhythm');
  });
});

describe('nearestScrollSpeed', () => {
  it('maps any stored duration onto the closest choice', () => {
    expect(nearestScrollSpeed(1600).ms).toBe(1600);
    expect(nearestScrollSpeed(1700).ms).toBe(1600);
    expect(nearestScrollSpeed(600).ms).toBe(SCROLL_SPEEDS.at(-1)?.ms);
    expect(nearestScrollSpeed(4000).ms).toBe(SCROLL_SPEEDS[0].ms);
  });
});

describe('formatting', () => {
  it('writes durations as m:ss and tempos as multipliers', () => {
    expect(formatDuration(141_000)).toBe('2:21');
    expect(formatDuration(68_571)).toBe('1:09');
    expect(formatTempo(1)).toBe('1×');
    expect(formatTempo(0.75)).toBe('0.75×');
  });
});
