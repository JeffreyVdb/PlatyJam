import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../app/events';
import type { CatalogSong } from '../catalog/schema';
import type { Chart } from '../chart/schema';
import type { Credits } from '../credits/schema';
import type {
  CountdownInfo,
  FinalResults,
  GameMode,
  GameSession,
  LoadingInfo,
  PauseInfo,
  SessionConfig,
  SessionEvents,
  SessionSetup,
  SessionState,
} from '../game/session-contract';
import { createOutputLatencyWatch } from '../audio/latency-watch';
import {
  BAND_TOLERANCE_MS,
  DELAYED_OUTPUT_MS,
  SAMPLE_INTERVAL_MS,
  VERDICT_SAMPLES,
} from '../audio/latency-warning';
import { createSaveStore, type SaveStore } from '../save/save-store';
import { createMenus, type Menus } from './menus';

// ---- A scripted GameSession ----

class FakeSession implements GameSession {
  state: SessionState = 'loading';
  readonly events = createEventBus<SessionEvents>();
  config: SessionConfig | undefined;
  loading: LoadingInfo = {
    chartLoaded: false,
    samples: { loaded: 0, failed: 0, total: 88 },
    backing: 'none',
  };
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
    this.loading = {
      chartLoaded: false,
      samples: { loaded: 0, failed: 0, total: 88 },
      backing: 'none',
    };
    this.error = undefined;
    this.set('loading');
  }
  /** The chart and piano arrived. */
  ready() {
    this.loading = {
      chartLoaded: true,
      samples: { loaded: 88, failed: 0, total: 88 },
      backing: 'none',
    };
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
  mode: 'rhythm',
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

/** A delayed output, and one that is on time. */
const DELAYED = DELAYED_OUTPUT_MS + 150;
const ON_TIME = 10;

function setup({
  storage = memoryStorage(),
  online = true,
  audioRunning = true,
  modes,
}: {
  storage?: ReturnType<typeof memoryStorage>;
  online?: boolean;
  audioRunning?: boolean;
  modes?: readonly GameMode[];
} = {}) {
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
  // The output latency the fake device reports; the real watch judges it.
  const output: { ms: number | undefined; running: boolean } = {
    ms: undefined,
    running: audioRunning,
  };
  const latency = createOutputLatencyWatch({ read: () => output.ms });
  /** Readings taken while the player browsed the song list. */
  const primeLatency = (ms: number | undefined) => {
    output.ms = ms;
    for (let i = 0; i < VERDICT_SAMPLES; i += 1) latency.sampleNow();
  };
  menus = createMenus({
    root,
    stage,
    session,
    store,
    songs: SONGS,
    ...(modes ? { modes } : {}),
    credits: CREDITS,
    charts,
    setVolume,
    offsets: () => ({ audioOffsetMs: 40, inputOffsetMs: -10 }),
    openCalibration,
    latency,
    audioRunning: () => output.running,
    platform: 'other',
    reload,
    online: () => online,
  });
  return {
    latency,
    output,
    primeLatency,
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
/** A finger tap as a touch browser sends it: pointer events, then a synthesized click. */
const touchTap = (node: HTMLElement, { click = node }: { click?: HTMLElement } = {}) => {
  const pointer = (type: string) =>
    node.dispatchEvent(
      new PointerEvent(type, { pointerId: 7, pointerType: 'touch', bubbles: true }),
    );
  pointer('pointerdown');
  pointer('pointerup');
  // The click goes to whatever is under the finger once pointerup has run.
  click.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
};
/** A touch's click is dropped for a moment; the next pointer press ends that (see `onGesture`). */
const nextPress = () => {
  document.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch' }));
};
const card = (mode: GameMode) => q(`.mode-card[data-mode="${mode}"]`);
const toSongs = (session: FakeSession, mode: GameMode = 'rhythm') => {
  tap(card(mode));
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
      if (how === 'tap') tap(card('rhythm'));
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
    tap(card('rhythm'));
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

  it("never lets a touch's click land on the screen its command opened", () => {
    const { session, store } = setup();
    // Home's game card opens the songs: the click lands on a song row.
    session.ready();
    touchTap(card('rhythm'), { click: card('rhythm') });
    expect(menus?.view).toBe('songs');
    // Song select is built once: the same row is back under the finger after Quit.
    const busy = q('.song-input[value="busy"]') as HTMLInputElement;
    busy.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(busy.checked).toBe(false);

    // Quit on the pause screen: the reported case.
    tap(q('.play-tile'));
    session.set('playing');
    session.pause();
    const loads = session.loads.length;
    touchTap(buttonNamed('Quit'), { click: busy });
    expect(menus?.view).toBe('songs');
    expect(busy.isConnected).toBe(true);
    expect(busy.checked).toBe(false);
    expect(store.settings.songId).toBe('gentle');
    expect(session.loads).toHaveLength(loads);

    // The next real tap on the row picks it.
    touchTap(busy);
    expect(store.settings.songId).toBe('busy');
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
    expect(store.best('rhythm', 'gentle', 'normal', 1)?.score).toBe(4200);

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
    tap(card('rhythm'));
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
    session.loading = {
      chartLoaded: true,
      samples: { loaded: 80, failed: 8, total: 88 },
      backing: 'none',
    };
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

  it('offers Tile size, Normal by default, for the next Tiles run, and keeps it', () => {
    const storage = memoryStorage();
    const { session, store } = setup({ storage, modes: ['rhythm', 'tiles'] });
    store.updateSettings({ gameMode: 'tiles' });
    toSongs(session, 'tiles');
    tap(buttonNamed('Settings'));
    const size = (value: string) =>
      q(`.screen--settings input[value="${value}"]`) as unknown as HTMLInputElement;
    expect(size('normal').checked).toBe(true);
    expect(q('.screen--settings').textContent).toContain('Tiles only.');
    size('big').click();
    expect(store.settings.tileSize).toBe('big');
    expect(session.loads.at(-1)).toMatchObject({ mode: 'tiles', tileSize: 'big' });
    // A relaunch reads it back.
    menus?.dispose();
    root.replaceChildren();
    const again = setup({ storage, modes: ['rhythm', 'tiles'] });
    expect(again.store.settings.tileSize).toBe('big');
    toSongs(again.session, 'tiles');
    expect(again.session.loads.at(-1)).toMatchObject({ tileSize: 'big' });
  });

  it('applies the Effects volume at once and saves it, apart from the others', () => {
    const { session, store, setVolume } = setup();
    toSongs(session);
    tap(buttonNamed('Settings'));
    expect(q('.screen--settings').textContent).toContain('The taps, sparkles and misses in Tiles.');
    const effects = [...root.querySelectorAll<HTMLElement>('[role="slider"]')].find(
      (node) => node.getAttribute('aria-valuetext') === '70%',
    );
    expect(effects).toBeDefined();
    effects?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(setVolume).toHaveBeenLastCalledWith('effectsVolume', 0.75);
    expect(store.settings).toMatchObject({
      effectsVolume: 0.75,
      masterVolume: 1,
      accompanimentVolume: 1,
    });
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

  describe('a delayed output', () => {
    const dialog = () => root.querySelector<HTMLElement>('.game-sheet--latency');
    /** A button in the dialog: the screens underneath have a Back of their own. */
    const inDialog = (name: string) => {
      const found = [...(dialog()?.querySelectorAll('button') ?? [])].find(
        (node) => node.textContent.trim() === name,
      );
      if (!found) throw new Error(`no dialog button ${name}`);
      return found;
    };
    const started = (session: FakeSession) => session.calls.filter((call) => call === 'start');
    /** On the song list with a delayed output already measured. */
    const delayed = (options: Parameters<typeof setup>[0] = {}) => {
      const made = setup(options);
      toSongs(made.session);
      made.primeLatency(DELAYED);
      return made;
    };

    it('asks before starting, and starts nothing yet', () => {
      const { session } = delayed();
      tap(q('.play-tile'));
      expect(started(session)).toEqual([]);
      expect(dialog()?.getAttribute('role')).toBe('dialog');
      expect(q('.game-card-title').textContent).toBe('Your sound is delayed');
      expect(dialog()?.textContent).toContain(`add about ${DELAYED}\u00a0ms`);
      expect(q('.screen--songs').inert).toBe(true);
      expect(document.activeElement?.textContent).toBe('Use speakers');
    });

    it('starts at once when the output is on time, unknown, or not measured yet', () => {
      for (const prime of [ON_TIME, undefined, 'none'] as const) {
        const { session, primeLatency } = setup();
        toSongs(session);
        if (prime !== 'none') primeLatency(prime);
        tap(q('.play-tile'));
        expect(started(session)).toEqual(['start']);
        expect(dialog()).toBeNull();
        menus?.dispose();
        document.body.replaceChildren(stage, root);
        root.replaceChildren();
      }
    });

    it('takes one more reading on the tap: a first reading alone never warns', () => {
      const { session, output } = setup();
      toSongs(session);
      output.ms = DELAYED;
      tap(q('.play-tile'));
      expect(started(session)).toEqual(['start']);
    });

    it('starts the song from "Play anyway", inside that tap, and asks again next time', () => {
      const { session, store } = delayed();
      tap(q('.play-tile'));
      touchTap(inDialog('Play anyway'));
      expect(started(session)).toEqual(['start']);
      expect(dialog()).toBeNull();
      expect(menus?.view).toBe('play');
      expect(store.settings.latencyWarningMutedAtMs).toBeNull();

      session.quit();
      nextPress();
      tap(q('.play-tile'));
      expect(dialog()).not.toBeNull();
    });

    it('remembers "Play, don\'t ask again" across a relaunch, for about the same delay', () => {
      const storage = memoryStorage();
      const first = delayed({ storage });
      tap(q('.play-tile'));
      touchTap(inDialog("Play, don't ask again"));
      expect(started(first.session)).toEqual(['start']);
      expect(first.store.settings.latencyWarningMutedAtMs).toBe(DELAYED);
      menus?.dispose();
      document.body.replaceChildren(stage, root);
      root.replaceChildren();

      nextPress();
      const second = setup({ storage });
      toSongs(second.session);
      second.primeLatency(DELAYED + BAND_TOLERANCE_MS);
      tap(q('.play-tile'));
      expect(started(second.session)).toEqual(['start']);
      expect(dialog()).toBeNull();
    });

    it('asks again when the delay is another band than the one silenced', () => {
      const storage = memoryStorage();
      setup({ storage }).store.updateSettings({ latencyWarningMutedAtMs: DELAYED });
      menus?.dispose();
      root.replaceChildren();
      const { session, primeLatency } = setup({ storage });
      toSongs(session);
      primeLatency(DELAYED + BAND_TOLERANCE_MS + 1);
      tap(q('.play-tile'));
      expect(started(session)).toEqual([]);
      expect(dialog()).not.toBeNull();
    });

    it('closes the dialog on Escape and stays on the song list, on the Play tile', () => {
      const { session } = delayed();
      tap(q('.play-tile'));
      key('Escape');
      expect(dialog()).toBeNull();
      expect(menus?.view).toBe('songs');
      expect(started(session)).toEqual([]);
      expect(q('.screen--songs').inert).toBe(false);
      expect(document.activeElement).toBe(q('.play-tile'));
    });

    it('does not start the song on Enter behind the dialog', () => {
      const { session } = delayed();
      tap(q('.play-tile'));
      key('Enter');
      expect(started(session)).toEqual([]);
      expect(dialog()).not.toBeNull();
    });

    describe('Use speakers', () => {
      it('shows how to switch, and the delay it still sees', () => {
        const { primeLatency } = delayed();
        tap(q('.play-tile'));
        tap(inDialog('Use speakers'));
        expect(q('.game-card-title').textContent).toBe('Switch to the speaker');
        expect(dialog()?.querySelectorAll('.latency-step').length).toBeGreaterThan(0);
        expect(q('.latency-status').textContent).toBe(`Still about ${DELAYED}\u00a0ms late.`);
        primeLatency(DELAYED + 100);
        expect(q('.latency-status').textContent).toBe(`Still about ${DELAYED + 100}\u00a0ms late.`);
      });

      it('goes back to the choices, from its button or Escape', () => {
        delayed();
        tap(q('.play-tile'));
        tap(inDialog('Use speakers'));
        tap(inDialog('Back'));
        expect(q('.game-card-title').textContent).toBe('Your sound is delayed');
        tap(inDialog('Use speakers'));
        key('Escape');
        expect(q('.game-card-title').textContent).toBe('Your sound is delayed');
        expect(dialog()).not.toBeNull();
      });

      it('carries on by itself once the output is on time, debounced', () => {
        const { session, output, latency } = delayed();
        tap(q('.play-tile'));
        tap(inDialog('Use speakers'));
        output.ms = ON_TIME;
        for (let i = 0; i < VERDICT_SAMPLES - 1; i += 1) latency.sampleNow();
        expect(started(session)).toEqual([]);
        expect(dialog()).not.toBeNull();
        latency.sampleNow();
        expect(started(session)).toEqual(['start']);
        expect(dialog()).toBeNull();
        expect(menus?.view).toBe('play');
      });

      it('waits while the readings are unknown right after the switch', () => {
        const { session, output, latency } = delayed();
        tap(q('.play-tile'));
        tap(inDialog('Use speakers'));
        output.ms = undefined;
        for (let i = 0; i < VERDICT_SAMPLES * 2; i += 1) latency.sampleNow();
        expect(started(session)).toEqual([]);
        expect(q('.latency-status').textContent).toBe('Checking the sound…');
        output.ms = ON_TIME;
        for (let i = 0; i < VERDICT_SAMPLES; i += 1) latency.sampleNow();
        expect(started(session)).toEqual(['start']);
      });

      it('does not start a song while the sound is not running, and leaves the Play tile', () => {
        const { session, output, latency } = delayed();
        tap(q('.play-tile'));
        tap(inDialog('Use speakers'));
        output.running = false;
        output.ms = ON_TIME;
        for (let i = 0; i < VERDICT_SAMPLES; i += 1) latency.sampleNow();
        expect(started(session)).toEqual([]);
        expect(dialog()).toBeNull();
        expect(menus?.view).toBe('songs');
        expect(document.activeElement).toBe(q('.play-tile'));
      });

      it('polls on a timer when the watch runs', () => {
        vi.useFakeTimers();
        const { session, output, latency } = delayed();
        tap(q('.play-tile'));
        tap(inDialog('Use speakers'));
        latency.start();
        output.ms = ON_TIME;
        vi.advanceTimersByTime(SAMPLE_INTERVAL_MS * VERDICT_SAMPLES);
        expect(started(session)).toEqual(['start']);
        latency.dispose();
      });
    });

    it('offers the calibration, and returns to the dialog when it closes', () => {
      const { session, openCalibration, closeCalibration } = delayed();
      tap(q('.play-tile'));
      tap(inDialog('Calibrate timing'));
      expect(openCalibration).toHaveBeenCalledTimes(1);
      expect(dialog()?.inert).toBe(true);
      // Escape belongs to the calibration while it is open.
      key('Escape');
      expect(dialog()).not.toBeNull();
      closeCalibration();
      expect(dialog()?.inert).toBe(false);
      expect(document.activeElement?.textContent).toBe('Calibrate timing');
      expect(started(session)).toEqual([]);
    });

    it('is gone when the song list is, and when the menus are disposed', () => {
      const { session } = delayed();
      tap(q('.play-tile'));
      session.set('starting');
      session.set('leadIn');
      expect(dialog()).toBeNull();
      expect(q('.play-hud')).not.toBeNull();
    });
  });

  describe('the output latency in Settings', () => {
    const settings = () => q('.screen--settings').textContent;

    it('shows the latency in ms, or unknown', () => {
      vi.useFakeTimers();
      const { session, primeLatency } = setup();
      toSongs(session);
      tap(buttonNamed('Settings'));
      expect(settings()).toContain('Audio output latency: unknown');
      primeLatency(187.4);
      vi.advanceTimersByTime(300);
      expect(settings()).toContain('Audio output latency: 187 ms');
    });

    it('shows a silenced warning, and turns it back on', () => {
      const storage = memoryStorage();
      const { session, store, primeLatency } = setup({ storage });
      store.updateSettings({ latencyWarningMutedAtMs: 190 });
      toSongs(session);
      tap(buttonNamed('Settings'));
      expect(settings()).toContain("won't warn you before a song");
      expect(settings()).toContain('about 190 ms');

      tap(buttonNamed('Warn me again'));
      expect(store.settings.latencyWarningMutedAtMs).toBeNull();
      expect(q('.settings-muted').hidden).toBe(true);

      primeLatency(DELAYED);
      tap(q('.screen--settings .icon-button'));
      tap(q('.play-tile'));
      expect(root.querySelector('.game-sheet--latency')).not.toBeNull();
    });

    it('hides the line about a silenced warning when nothing is silenced', () => {
      const { session } = setup();
      toSongs(session);
      tap(buttonNamed('Settings'));
      expect(q('.settings-muted').hidden).toBe(true);
    });
  });

  describe('the two games', () => {
    const BOTH: readonly GameMode[] = ['rhythm', 'tiles'];
    const badge = () => q('.screen--songs .mode-badge').textContent;
    const intro = () => root.querySelector<HTMLElement>('.game-sheet--intro');
    const started = (session: FakeSession) => session.calls.filter((call) => call === 'start');

    it('shows Rhythm alone without ?debug, and plays a saved Tiles choice as Rhythm', () => {
      const storage = memoryStorage();
      setup({ storage }).store.updateSettings({ gameMode: 'tiles' });
      menus?.dispose();
      root.replaceChildren();
      const { session } = setup({ storage });
      expect(
        [...root.querySelectorAll('.mode-card')].map((n) => n.getAttribute('aria-label')),
      ).toEqual(['Play Rhythm']);
      expect(q('.mode-cards').dataset.count).toBe('1');
      expect(session.loads[0]?.mode).toBe('rhythm');
      key('Enter');
      expect(badge()).toBe('Rhythm');
      tap(buttonNamed('Settings'));
      expect(root.querySelectorAll('.choice--games input')).toHaveLength(1);
    });

    it('offers both games as cards, each with a preview and a line about it', () => {
      setup({ modes: BOTH });
      const cards = [...root.querySelectorAll<HTMLElement>('.mode-card')];
      expect(cards.map((n) => n.getAttribute('aria-label'))).toEqual(['Play Rhythm', 'Play Tiles']);
      expect(cards.every((n) => n.querySelector('.preview[aria-hidden="true"]'))).toBe(true);
      const line = document.getElementById(card('tiles').getAttribute('aria-describedby') ?? '');
      expect(line?.textContent).toBe(
        "Tap every tile before it falls off the screen. Timing doesn't matter.",
      );
      expect(document.activeElement).toBe(card('rhythm'));
    });

    it('opens the songs of the game a card picks, once per touch, and loads that game', () => {
      const { session, store } = setup({ modes: BOTH });
      touchTap(card('tiles'));
      expect(menus?.view).toBe('songs');
      expect(store.settings.gameMode).toBe('tiles');
      expect(badge()).toBe('Tiles');
      expect(q('.screen--songs').dataset.mode).toBe('tiles');
      expect(session.loads.map((load) => load.mode)).toEqual(['rhythm', 'tiles']);
      nextPress();
    });

    it('goes back to Home from Change game, on the picked card; Enter opens that game', () => {
      const { session } = setup({ modes: BOTH });
      toSongs(session, 'tiles');
      tap(buttonNamed('Change game'));
      expect(menus?.view).toBe('home');
      expect(document.activeElement).toBe(card('tiles'));
      key('Enter', document.body);
      expect(menus?.view).toBe('songs');
      expect(badge()).toBe('Tiles');
    });

    it('shows and changes the same choice in Settings, and remembers it after a relaunch', () => {
      const storage = memoryStorage();
      const { session, store } = setup({ storage, modes: BOTH });
      toSongs(session);
      tap(buttonNamed('Settings'));
      const checked = () =>
        q('.choice--games input:checked').getAttribute('value') as GameMode | null;
      expect(checked()).toBe('rhythm');
      expect(q('.screen--settings').textContent).toContain('The first missed note ends the song.');
      q('.choice--games input[value="tiles"]').click();
      expect(store.settings.gameMode).toBe('tiles');
      expect(session.loads.at(-1)?.mode).toBe('tiles');
      expect(q('.screen--settings').textContent).toContain(
        'A tile that falls off, or a tap on empty space, ends the song.',
      );
      q('.screen--settings input[value="relaxed"]').click();
      expect(q('.screen--settings').textContent).toContain(
        'A tile that falls off breaks your combo, and the song plays on.',
      );
      key('Escape');
      expect(badge()).toBe('Tiles');
      menus?.dispose();
      root.replaceChildren();

      setup({ storage, modes: BOTH });
      expect(document.activeElement).toBe(card('tiles'));
      key('Enter');
      expect(badge()).toBe('Tiles');
    });

    it('keeps the bests of each game apart, and says New best! within the game', () => {
      const storage = memoryStorage();
      setup({ storage, modes: BOTH }).store.recordResults({ ...RESULTS, score: 4200 });
      menus?.dispose();
      root.replaceChildren();
      const { session } = setup({ storage, modes: BOTH });
      toSongs(session, 'tiles');
      expect(root.querySelector('.song-best-score')).toBeNull();
      session.finish({ mode: 'tiles', score: 100 });
      expect(q('.result-badge').textContent).toBe('New best!');
      expect(q('.game-sheet--results .mode-badge').textContent).toBe('Tiles');
      tap(buttonNamed('Song list'));
      expect(q('.song-best-score').textContent).toBe('100');
      tap(buttonNamed('Change game'));
      tap(card('rhythm'));
      expect(q('.song-best-score').textContent).toBe('4,200');
    });

    it('names the game on the pause screen', () => {
      const { session } = setup({ modes: BOTH });
      toSongs(session, 'tiles');
      session.config = { ...(session.loads.at(-1) as SessionConfig) };
      tap(q('.play-tile'));
      tap(buttonNamed('Got it'));
      session.set('playing');
      session.pause();
      expect(q('.game-sheet .mode-badge').textContent).toBe('Tiles');
    });

    describe('How to play', () => {
      it('comes before the first Tiles run, and Got it starts the song inside its tap', () => {
        const { session, store } = setup({ modes: BOTH });
        toSongs(session, 'tiles');
        tap(q('.play-tile'));
        expect(started(session)).toEqual([]);
        expect(intro()?.getAttribute('role')).toBe('dialog');
        expect(
          [...(intro()?.querySelectorAll('.intro-step') ?? [])].map((n) => n.textContent),
        ).toEqual([
          'Tap the lowest tile first, anywhere on it. The next one is tinted.',
          'Hold long tiles until they fill up.',
          "A tile that shakes isn't next yet. Don't let one fall off, or tap empty space.",
        ]);
        expect(intro()?.querySelector('.preview--tiles')).not.toBeNull();
        expect(q('.screen--songs').inert).toBe(true);
        expect(document.activeElement?.textContent).toBe('Got it');
        // Enter behind it starts nothing.
        key('Enter');
        expect(started(session)).toEqual([]);

        touchTap(buttonNamed('Got it'));
        expect(started(session)).toEqual(['start']);
        expect(intro()).toBeNull();
        expect(store.settings.seenIntro).toEqual({ rhythm: false, tiles: true });

        session.quit();
        nextPress();
        tap(q('.play-tile'));
        expect(intro()).toBeNull();
        expect(started(session)).toEqual(['start', 'start']);
      });

      it('closes on Escape before the first run, starting nothing, and asks again next time', () => {
        const { session, store } = setup({ modes: BOTH });
        toSongs(session, 'tiles');
        tap(q('.play-tile'));
        key('Escape');
        expect(intro()).toBeNull();
        expect(menus?.view).toBe('songs');
        expect(started(session)).toEqual([]);
        expect(document.activeElement).toBe(q('.play-tile'));
        expect(store.settings.seenIntro.tiles).toBe(false);
        tap(q('.play-tile'));
        expect(intro()).not.toBeNull();
      });

      it('never comes before a Rhythm run', () => {
        const { session } = setup({ modes: BOTH });
        toSongs(session);
        tap(q('.play-tile'));
        expect(intro()).toBeNull();
        expect(started(session)).toEqual(['start']);
      });

      it('reopens from song select for either game, and gives focus back to its button', () => {
        const { session } = setup({ modes: BOTH });
        toSongs(session);
        tap(buttonNamed('How to play'));
        expect(intro()?.querySelector('.mode-badge')?.textContent).toBe('Rhythm');
        expect(intro()?.querySelectorAll('.intro-step')).toHaveLength(3);
        tap(buttonNamed('Got it'));
        expect(intro()).toBeNull();
        expect(started(session)).toEqual([]);
        expect(document.activeElement?.textContent).toBe('How to play');

        tap(buttonNamed('Change game'));
        tap(card('tiles'));
        tap(buttonNamed('How to play'));
        expect(intro()?.querySelector('.mode-badge')?.textContent).toBe('Tiles');
        key('Escape');
        expect(intro()).toBeNull();
        expect(menus?.view).toBe('songs');
        expect(document.activeElement?.textContent).toBe('How to play');
      });

      it('is gone when the song list is', () => {
        const { session } = setup({ modes: BOTH });
        toSongs(session);
        tap(buttonNamed('How to play'));
        session.set('starting');
        expect(intro()).toBeNull();
        session.set('ready');
        expect(menus?.view).toBe('songs');
        expect(q('.screen--songs').inert).toBe(false);
      });
    });
  });
});
