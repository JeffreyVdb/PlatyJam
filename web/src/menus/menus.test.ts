import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../app/events';
import type { CatalogSong } from '../catalog/schema';
import type { Chart } from '../chart/schema';
import type { Credits } from '../credits/schema';
import type {
  CountdownInfo,
  FinalResults,
  GameSession,
  LoadingInfo,
  PauseInfo,
  SessionConfig,
  SessionEvents,
  SessionSetup,
  SessionState,
} from '../game/session-contract';
import { createSaveStore, type SaveStore } from '../save/save-store';
import { createMenus, type Menus } from './menus';

// ---- A scripted GameSession ----

class FakeSession implements GameSession {
  state: SessionState = 'loading';
  readonly events = createEventBus<SessionEvents>();
  config: SessionConfig | undefined;
  loading: LoadingInfo = { chartLoaded: false, samples: { loaded: 0, failed: 0, total: 88 } };
  pauseInfo: PauseInfo | undefined;
  countdown: CountdownInfo | undefined;
  results: FinalResults | undefined;
  error: string | undefined;
  readonly loads: SessionSetup[] = [];
  readonly calls: string[] = [];

  stats() {
    return {
      score: 0,
      combo: 0,
      maxCombo: 0,
      perfect: 0,
      good: 0,
      miss: 0,
      accuracy: 0,
      progress: 0,
      stars: 0,
    };
  }

  set(state: SessionState) {
    const previous = this.state;
    this.state = state;
    this.events.emit('statechange', { state, previous });
  }

  load(setup: SessionSetup) {
    this.loads.push(setup);
    this.calls.push('load');
    this.loading = { chartLoaded: false, samples: { loaded: 0, failed: 0, total: 88 } };
    this.error = undefined;
    this.set('loading');
  }
  /** The chart and piano arrived. */
  ready() {
    this.loading = { chartLoaded: true, samples: { loaded: 88, failed: 0, total: 88 } };
    this.set('ready');
  }
  start() {
    this.calls.push('start');
    if (this.state === 'ready' || this.state === 'quit') this.set('leadIn');
  }
  pause() {
    this.calls.push('pause');
    if (this.state === 'leadIn' || this.state === 'playing') {
      this.pauseInfo = { reason: 'player', audio: 'running', heldLanes: [] };
      this.set('paused');
    }
  }
  resume() {
    this.calls.push('resume');
  }
  restart() {
    this.calls.push('restart');
    this.set('quit');
    this.set('leadIn');
  }
  quit() {
    this.calls.push('quit');
    this.set('quit');
  }
  finish(results: Partial<FinalResults> = {}) {
    this.results = { ...RESULTS, ...results };
    this.set('finished');
  }
}

const RESULTS: FinalResults = {
  outcome: 'cleared',
  songId: 'gentle',
  songTitle: 'Gentle Song',
  difficulty: 'normal',
  tempo: 1,
  failMode: 'classic',
  score: 4200,
  combo: 0,
  maxCombo: 30,
  perfect: 20,
  good: 4,
  miss: 0,
  accuracy: 91.7,
  progress: 1,
  stars: 3,
  perfectBadge: false,
};

const song = (id: string, title: string): CatalogSong => ({
  id,
  title,
  composer: `${title} composer`,
  arranger: 'someone',
  durationMs: 61_000,
  bpm: 100,
  difficulties: {
    easy: { tiles: 10, notesPerSecond: 0.2 },
    normal: { tiles: 20, notesPerSecond: 0.4 },
    hard: { tiles: 30, notesPerSecond: 0.6 },
  },
});

const SONGS = [song('gentle', 'Gentle Song'), song('busy', 'Busy Song')];

const CREDITS: Credits = {
  sections: [
    {
      kind: 'songs',
      title: 'Songs',
      items: [
        {
          id: 'gentle',
          title: 'Gentle Song',
          byline: 'A. Composer · A. Typesetter',
          license: { label: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
          source: 'https://www.example.com/gentle',
          changes: 'Unmodified.',
        },
      ],
    },
    {
      kind: 'fonts',
      title: 'Fonts',
      items: [
        {
          id: 'font',
          title: 'A Font',
          byline: 'Type Foundry',
          license: { label: 'OFL-1.1', url: 'https://openfontlicense.org/' },
          source: 'https://example.org/font',
          changes: 'Subset.',
          note: 'Non-commercial use only.',
        },
      ],
    },
  ],
};

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

// ---- Harness ----

let menus: Menus | undefined;
let root: HTMLElement;
let stage: HTMLElement;

beforeEach(() => {
  // jsdom has no matchMedia; the countdown asks about reduced motion.
  window.matchMedia = (query: string) => ({ matches: true, media: query }) as MediaQueryList;
  stage = document.createElement('main');
  root = document.createElement('div');
  root.innerHTML = '<div class="play-hud"></div>';
  document.body.append(stage, root);
});

afterEach(() => {
  menus?.dispose();
  menus = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
});

function setup({
  storage = memoryStorage(),
  online = true,
}: { storage?: ReturnType<typeof memoryStorage>; online?: boolean } = {}) {
  const session = new FakeSession();
  const store: SaveStore = createSaveStore({ storage: () => storage });
  const fetched: string[] = [];
  const charts = {
    get: (id: string) => {
      fetched.push(id);
      return { id } as unknown as Chart;
    },
  };
  const setVolume = vi.fn();
  const reload = vi.fn();
  let closeCalibration: (() => void) | undefined;
  const openCalibration = vi.fn((onClose: () => void) => {
    closeCalibration = onClose;
  });
  menus = createMenus({
    root,
    stage,
    session,
    store,
    songs: SONGS,
    credits: CREDITS,
    charts,
    setVolume,
    offsets: () => ({ audioOffsetMs: 40, inputOffsetMs: -10 }),
    openCalibration,
    reload,
    online: () => online,
  });
  return {
    session,
    store,
    fetched,
    setVolume,
    reload,
    openCalibration,
    closeCalibration: () => closeCalibration?.(),
    storage,
  };
}

const q = (selector: string) => {
  const node = root.querySelector<HTMLElement>(selector);
  if (!node) throw new Error(`missing ${selector}`);
  return node;
};
const key = (name: string, target: EventTarget = document.body) => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
};
const buttonNamed = (name: string) => {
  const found = [...root.querySelectorAll('button')].find(
    (node) => node.textContent.trim() === name || node.getAttribute('aria-label') === name,
  );
  if (!found) throw new Error(`no button ${name}`);
  return found;
};
const tap = (node: HTMLElement) => {
  node.click();
};
const toSongs = (session: FakeSession) => {
  tap(q('.home-tile'));
  session.ready();
};

describe('menus', () => {
  it('opens on Home, fetching the remembered song meanwhile, with the stage inert', () => {
    const { session, fetched } = setup();
    expect(menus?.view).toBe('home');
    expect(q('.home-title').textContent).toContain('PlatyJam');
    expect(stage.inert).toBe(true);
    expect(root.classList.contains('has-menu')).toBe(true);
    expect(fetched).toEqual(['gentle']);
    expect(session.loads[0]).toMatchObject({
      difficulty: 'normal',
      tempo: 1,
      failMode: 'classic',
      scrollDurationMs: 1600,
    });
  });

  it('goes from Home to the songs with a tap, Enter or Space', () => {
    for (const how of ['tap', 'Enter', ' '] as const) {
      const { session } = setup();
      if (how === 'tap') tap(q('.home-tile'));
      else key(how);
      expect(menus?.view).toBe('songs');
      expect(session.loads).toHaveLength(1);
      menus?.dispose();
      document.body.replaceChildren(stage, root);
      root.replaceChildren();
    }
  });

  it('lists every song with its best stars and score for the picked difficulty and speed', () => {
    const storage = memoryStorage();
    const first = setup({ storage });
    first.store.recordResults({ ...RESULTS, score: 4200, stars: 2 });
    menus?.dispose();
    root.replaceChildren();
    setup({ storage });
    toSongs(new FakeSession());
    const rows = [...root.querySelectorAll('.song-row')];
    expect(rows.map((row) => row.querySelector('.song-title')?.textContent)).toEqual([
      'Gentle Song',
      'Busy Song',
    ]);
    expect(rows[0]?.querySelector('.song-best-score')?.textContent).toBe('4,200');
    expect(rows[0]?.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('2 of 3 stars');
    expect(rows[1]?.textContent).toContain('Not played');
    expect(q('.song-list-caption').textContent).toBe('Best scores on Normal at 1×');

    // Another difficulty has no best yet.
    q('.choice--tabs input[value="hard"]').click();
    expect(rows[0]?.textContent).toContain('Not played');
  });

  it('reloads the session when the song, difficulty or speed changes, and remembers them', () => {
    const storage = memoryStorage();
    const { session, fetched, store } = setup({ storage });
    toSongs(session);
    q('.song-input[value="busy"]').click();
    q('.choice--tabs input[value="easy"]').click();
    q('.choice--speed input[value="1.25"]').click();
    expect(session.loads.slice(1).map(({ difficulty, tempo }) => [difficulty, tempo])).toEqual([
      ['normal', 1],
      ['easy', 1],
      ['easy', 1.25],
    ]);
    expect(fetched.at(-1)).toBe('busy');
    expect(store.settings).toMatchObject({ songId: 'busy', difficulty: 'easy', tempo: 1.25 });
    expect(q('.song-panel-title').textContent).toBe('Busy Song');
    expect(q('.song-panel-facts').textContent).toBe(
      'Busy Song composer. 1:01 long, 10 notes on Easy.',
    );
  });

  it('shows loading on the Play tile, and starts only once ready, inside the tap', () => {
    const { session } = setup();
    tap(q('.home-tile'));
    const play = q('.play-tile');
    expect(play.textContent).toBe('Loading');
    expect(play.getAttribute('aria-disabled')).toBe('true');
    expect(q('.play-note').textContent).toBe('Fetching the song');
    tap(play);
    expect(session.calls).not.toContain('start');

    session.ready();
    expect(play.textContent).toBe('Play');
    tap(play);
    expect(session.calls).toContain('start');
    expect(menus?.view).toBe('play');
    expect(stage.inert).toBe(false);
    expect(q('.play-hud').inert).toBe(false);
    expect(root.querySelector('.screen')).toBeNull();
  });

  it('starts with Enter from the song list, but never from a lane key', () => {
    const { session } = setup();
    toSongs(session);
    key('d', q('.song-input'));
    key(' ', q('.song-input'));
    expect(session.calls).not.toContain('start');
    key('Enter', q('.song-input'));
    expect(session.calls).toContain('start');
  });

  it('goes back with Escape and the Back buttons: Settings → Songs → Home', () => {
    const { session } = setup();
    toSongs(session);
    tap(buttonNamed('Settings'));
    expect(menus?.view).toBe('settings');
    expect(document.activeElement).toBe(q('.screen--settings .screen-title'));
    key('Escape');
    expect(menus?.view).toBe('songs');
    // Focus returns to the button that opened Settings.
    expect(document.activeElement?.textContent).toBe('Settings');
    tap(buttonNamed('Credits'));
    tap(q('.screen--credits .icon-button'));
    expect(menus?.view).toBe('songs');
    key('Escape');
    expect(menus?.view).toBe('home');
    key('Escape');
    expect(menus?.view).toBe('home');
  });

  it('pauses with Escape during play, and resumes, restarts or quits from the pause screen', () => {
    const { session } = setup();
    toSongs(session);
    tap(q('.play-tile'));
    session.set('playing');
    key('Escape');
    expect(menus?.view).toBe('pause');
    expect(document.activeElement?.textContent).toBe('Resume');
    expect(q('.game-card-text').textContent).toContain('Take a breath');
    expect(stage.inert).toBe(true);

    key('Escape');
    expect(session.calls.at(-1)).toBe('resume');
    tap(buttonNamed('Restart'));
    expect(session.calls).toContain('restart');

    session.set('playing');
    session.pause();
    tap(buttonNamed('Quit'));
    expect(session.calls.at(-1)).toBe('quit');
    expect(menus?.view).toBe('songs');
  });

  it('shows how to get the sound back on the pause screen', () => {
    const { session } = setup();
    toSongs(session);
    tap(q('.play-tile'));
    session.pauseInfo = { reason: 'interrupted', audio: 'needsGesture', heldLanes: [1, 2] };
    session.set('paused');
    expect(q('.game-card-alert').textContent).toBe(
      "The sound didn't come back. Tap Resume once more to restart it.",
    );
    session.pauseInfo = { reason: 'interrupted', audio: 'running', heldLanes: [1, 2] };
    session.events.emit('pause', session.pauseInfo);
    expect(q('.game-card-alert').textContent).toBe(
      'Then hold the left and right lanes again during the count.',
    );
  });

  it('lets the countdown through to the lanes', () => {
    const { session } = setup();
    toSongs(session);
    tap(q('.play-tile'));
    session.countdown = { beat: 3, heldLanes: [0], reclaimedLanes: [] };
    session.set('countdown');
    expect(q('.countdown-beat').textContent).toBe('3');
    expect(q('.countdown-hint').textContent).toBe('Hold the far left lane to keep your notes.');
    expect(stage.inert).toBe(false);
  });

  it('records the results, says "New best!" only when the stored best was beaten', () => {
    const { session, store } = setup();
    toSongs(session);
    tap(q('.play-tile'));
    session.finish({ score: 4200 });
    expect(menus?.view).toBe('results');
    expect(q('.game-card-title').textContent).toBe('Song cleared');
    expect(q('.result-score').textContent).toBe('4,200');
    expect(q('.result-badge').textContent).toBe('New best!');
    expect(document.activeElement?.textContent).toBe('Retry');
    expect(store.best('gentle', 'normal', 1)?.score).toBe(4200);

    tap(buttonNamed('Retry'));
    expect(session.calls.at(-1)).toBe('restart');
    session.finish({ score: 3000, outcome: 'failed', stars: 1 });
    expect(q('.game-card-title').textContent).toBe('A note got away');
    expect(q('.result-badge').textContent).toBe('Best 4,200');

    tap(buttonNamed('Song list'));
    expect(session.calls.at(-1)).toBe('quit');
    expect(menus?.view).toBe('songs');
    expect(q('.song-best-score').textContent).toBe('4,200');
  });

  it('announces the results in a live region', () => {
    vi.useFakeTimers();
    const { session } = setup();
    toSongs(session);
    tap(q('.play-tile'));
    session.finish();
    vi.advanceTimersByTime(500);
    expect(q('.game-card [role="status"]').textContent).toBe(
      'Song cleared. 3 of 3 stars, score 4,200. New best!',
    );
  });

  it('offers a way out of a song that did not download: try again, or pick another', () => {
    const { session, fetched } = setup({ online: false });
    tap(q('.home-tile'));
    session.error = "This song didn't load.";
    session.set('error');
    const play = q('.play-tile');
    expect(play.textContent).toBe('Try again');
    expect(q('.play-note').textContent).toContain("isn't on this device yet");
    tap(play);
    expect(fetched).toEqual(['gentle', 'gentle']);
    expect(session.state).toBe('loading');

    session.set('error');
    q('.song-input[value="busy"]').click();
    expect(fetched.at(-1)).toBe('busy');
  });

  it('reloads the page when the piano notes are what failed', () => {
    const { session, reload } = setup();
    toSongs(session);
    session.loading = { chartLoaded: true, samples: { loaded: 80, failed: 8, total: 88 } };
    session.error = 'Some piano notes this song needs did not download.';
    session.set('error');
    expect(q('.play-tile').textContent).toBe('Reload');
    tap(q('.play-tile'));
    expect(reload).toHaveBeenCalled();
  });

  it('applies settings: fail mode and tile speed to the next load, volumes at once', () => {
    const { session, store, setVolume } = setup();
    toSongs(session);
    tap(buttonNamed('Settings'));
    q('.screen--settings input[value="relaxed"]').click();
    expect(session.loads.at(-1)).toMatchObject({ failMode: 'relaxed' });
    q('.screen--settings input[value="950"]').click();
    expect(session.loads.at(-1)).toMatchObject({ scrollDurationMs: 950 });
    expect(q('.screen--settings').textContent).toContain('Tiles take 0.95 s to reach the line.');

    const [master] = root.querySelectorAll<HTMLElement>('[role="slider"]');
    master?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(setVolume).toHaveBeenLastCalledWith('masterVolume', 0.95);
    expect(store.settings.masterVolume).toBe(0.95);
    expect(master?.getAttribute('aria-valuetext')).toBe('95%');
    expect(store.settings).toMatchObject({ failMode: 'relaxed', scrollDurationMs: 950 });
  });

  it('opens the calibration from Settings, and comes back to Settings when it closes', () => {
    const { session, openCalibration, closeCalibration } = setup();
    toSongs(session);
    tap(buttonNamed('Settings'));
    expect(q('.screen--settings').textContent).toContain('Now: sound +40 ms, touch -10 ms.');
    tap(buttonNamed('Calibrate timing'));
    expect(openCalibration).toHaveBeenCalledTimes(1);
    expect(q('.screen--settings').inert).toBe(true);
    // The calibration handles its own Escape; Settings stays open underneath.
    key('Escape');
    expect(menus?.view).toBe('settings');
    closeCalibration();
    expect(q('.screen--settings').inert).toBe(false);
    expect(document.activeElement?.textContent).toBe('Calibrate timing');

    // Its Escape closes it first (in a handler on the sheet), then reaches the window.
    tap(buttonNamed('Calibrate timing'));
    const sheet = document.createElement('div');
    sheet.className = 'calibration';
    root.append(sheet);
    sheet.addEventListener('keydown', () => {
      sheet.remove();
      closeCalibration();
    });
    key('Escape', sheet);
    expect(menus?.view).toBe('settings');
  });

  it('credits every work in the credits data, with real links that open outside the game', () => {
    const { session } = setup();
    toSongs(session);
    tap(buttonNamed('Credits'));
    const credits = q('.screen--credits');
    expect([...credits.querySelectorAll('.credit-title')].map((n) => n.textContent)).toEqual([
      'Gentle Song',
      'A Font',
    ]);
    const links = [...credits.querySelectorAll('a')];
    expect(links.map((a) => [a.textContent, a.href, a.target, a.rel])).toEqual([
      [
        'CC BY 4.0',
        'https://creativecommons.org/licenses/by/4.0/',
        '_blank',
        'noopener noreferrer',
      ],
      ['example.com', 'https://www.example.com/gentle', '_blank', 'noopener noreferrer'],
      ['OFL-1.1', 'https://openfontlicense.org/', '_blank', 'noopener noreferrer'],
      ['example.org', 'https://example.org/font', '_blank', 'noopener noreferrer'],
    ]);
    expect(credits.textContent).toContain('Non-commercial use only.');
  });

  it('remembers the song a run was started with', () => {
    const storage = memoryStorage();
    const { session, store } = setup({ storage });
    toSongs(session);
    expect(store.settings.songId).toBeNull();
    tap(q('.play-tile'));
    expect(store.settings.songId).toBe('gentle');
  });

  it('says so when the sound did not start, and lets the next tap try again', () => {
    const { session } = setup();
    toSongs(session);
    session.set('starting');
    session.set('ready');
    expect(q('.play-note').textContent).toBe("The sound didn't start. Tap Play again.");
  });
});
