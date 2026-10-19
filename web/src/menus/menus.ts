import type { LatencyOffsets } from '../audio/timeline';
import type { CatalogSong } from '../catalog/schema';
import type { Credits } from '../credits/schema';
import { type GameSession, isRunActive, type SessionState } from '../game/session-contract';
import type { Settings } from '../save/save-data';
import type { RecordedResults, SaveStore } from '../save/save-store';
import type { ChartCache } from './chart-cache';
import {
  backFrom,
  isModal,
  type MenuScreen,
  playButtonFor,
  resolveSelection,
  type Selection,
  setupKey,
  type View,
  viewFor,
} from './flow';
import { createCountdownScreen, createPauseScreen, createResultsScreen } from './run-screens';
import { createCreditsScreen, createHomeScreen, type Screen } from './screens';
import { createSettingsScreen, type VolumeKind } from './settings-screen';
import { createSongSelect } from './song-select';

/**
 * The screens around gameplay (PLA-7): Home, song select, settings and credits, and
 * during a run the pause, countdown and results screens. The menus drive the game
 * only through the `GameSession` contract; the save store keeps the choices and the
 * best scores.
 */
export interface Menus {
  readonly view: View;
  dispose(): void;
}

export interface MenusOptions {
  /** The HUD layer: screens mount here, outside the touch-guarded stage. */
  root: HTMLElement;
  /** The stage: inert while a screen covers it. */
  stage: HTMLElement;
  session: GameSession;
  store: SaveStore;
  /** From the catalog, gentlest first. */
  songs: readonly CatalogSong[];
  credits: Credits;
  charts: ChartCache;
  /** Applies a volume to the sound at once (the store keeps it separately). */
  setVolume: (kind: VolumeKind, volume: number) => void;
  /** The latency offsets in use, for Settings. */
  offsets: () => Readonly<LatencyOffsets>;
  /** Opens the latency calibration; `onClose` runs when it closes. */
  openCalibration: (onClose: () => void) => void;
  /** Reloads the page: the way to fetch piano notes that failed at launch. */
  reload: () => void;
  online?: () => boolean;
}

/** Loading progress has no event: poll it while the Play tile shows it. */
const LOADING_POLL_MS = 200;

const isMenu = (view: View): view is MenuScreen =>
  view === 'home' || view === 'songs' || view === 'settings' || view === 'credits';

/** Elements where Enter and Space already do something of their own. */
const isOwnControl = (target: EventTarget | null) =>
  target instanceof HTMLButtonElement ||
  target instanceof HTMLAnchorElement ||
  (target instanceof HTMLElement && target.getAttribute('role') === 'slider');

export function createMenus({
  root,
  stage,
  session,
  store,
  songs,
  credits,
  charts,
  setVolume,
  offsets,
  openCalibration,
  reload,
  online = () => navigator.onLine,
}: MenusOptions): Menus {
  let menu: MenuScreen = 'home';
  let selection: Selection = resolveSelection(store.settings, songs);
  let loadedKey: string | undefined;
  let startFailed = false;
  let recorded: RecordedResults | undefined;
  let calibrating = false;
  let shown: View | undefined;
  /** Where focus returns when a screen opened from a button closes. */
  let opener: HTMLElement | undefined;

  /** Loads the session for the current choice, unless it already has it (or `force`). */
  const ensureLoaded = (force = false) => {
    if (isRunActive(session.state) || !selection.songId) return;
    const key = setupKey(selection, store.settings);
    if (!force && key === loadedKey) return;
    loadedKey = key;
    startFailed = false;
    const { failMode, scrollDurationMs } = store.settings;
    session.load({
      chart: charts.get(selection.songId),
      difficulty: selection.difficulty,
      tempo: selection.tempo,
      failMode,
      scrollDurationMs,
    });
  };

  const go = (next: MenuScreen) => {
    menu = next;
    if (next === 'songs') ensureLoaded();
    render();
  };

  const back = () => {
    const previous = backFrom(menu);
    if (previous) go(previous);
  };

  const openFrom = (next: MenuScreen, from: HTMLElement) => {
    opener = from;
    go(next);
  };

  /** Inside the gesture: `start()` must run synchronously in it. */
  const play = () => {
    const action = currentPlay().action;
    if (action === 'start') {
      session.start();
      // Song select opens on this song next time, even if it was never picked.
      store.updateSettings({ ...selection });
    } else if (action === 'retry') {
      ensureLoaded(true);
    } else if (action === 'reload') {
      reload();
    }
  };

  const currentPlay = () =>
    playButtonFor({
      state: session.state,
      loading: session.loading,
      error: session.error,
      online: online(),
      startFailed,
    });

  const toSongList = () => {
    menu = 'songs';
    session.quit();
    render();
  };

  const select = (patch: Partial<Selection>) => {
    selection = { ...selection, ...patch };
    store.updateSettings(patch);
    ensureLoaded();
    songSelect.refresh();
    renderPlay();
  };

  // ---- Screens ----

  const home = createHomeScreen({
    onPlay: () => {
      go('songs');
    },
  });
  const songSelect = createSongSelect({
    songs,
    selection: () => selection,
    best: (songId, difficulty, tempo) => store.best(songId, difficulty, tempo),
    onSelect: select,
    onPlay: play,
    onBack: back,
    onSettings: () => {
      openFrom('settings', songSelect.settingsButton);
    },
    onCredits: () => {
      openFrom('credits', songSelect.creditsButton);
    },
  });
  const settingsScreen = createSettingsScreen({
    settings: () => store.settings,
    offsets,
    onChange: (patch: Partial<Settings>) => {
      store.updateSettings(patch);
      ensureLoaded();
    },
    onVolume: setVolume,
    onVolumeCommit: (kind, volume) => {
      setVolume(kind, volume);
      store.updateSettings({ [kind]: volume });
    },
    onCalibrate: () => {
      calibrating = true;
      settingsScreen.node.inert = true;
      openCalibration(() => {
        calibrating = false;
        settingsScreen.node.inert = false;
        settingsScreen.refresh();
        settingsScreen.calibrateButton.focus({ preventScroll: true });
      });
    },
    onBack: back,
  });
  const creditsScreen = createCreditsScreen({ credits, onBack: back });
  const pause = createPauseScreen(session, toSongList);
  const countdown = createCountdownScreen(session);
  const results = createResultsScreen({
    onRetry: () => {
      session.restart();
    },
    onSongList: toSongList,
  });

  const screens: Record<Exclude<View, 'play'>, Screen> = {
    home,
    songs: songSelect,
    settings: settingsScreen,
    credits: creditsScreen,
    pause,
    countdown,
    results,
  };

  // ---- Rendering ----

  const renderPlay = () => {
    songSelect.setPlay(currentPlay());
  };

  const focusFor = (view: View, previous: View | undefined): HTMLElement | undefined => {
    if (view === 'play' || view === 'countdown') return undefined;
    // Back from a screen opened by a button: return to that button.
    if (view === 'songs' && (previous === 'settings' || previous === 'credits') && opener) {
      return opener;
    }
    return screens[view].focusTarget();
  };

  const render = () => {
    const view = viewFor(menu, session.state);
    if (view === 'songs') renderPlay();
    if (view === 'pause') pause.refresh();
    if (view === 'countdown') countdown.refresh();
    if (view === shown) return;

    const previous = shown;
    shown = view;
    if (view === 'results' && session.results) results.show(session.results, recorded);
    if (view === 'settings') settingsScreen.refresh();
    if (view === 'songs') songSelect.refresh();
    for (const [name, screen] of Object.entries(screens)) {
      if (name !== view) screen.node.remove();
    }
    if (view !== 'play') {
      const node = screens[view].node;
      if (!node.isConnected) root.append(node);
    }
    const covered = isModal(view);
    stage.inert = covered;
    const playHud = root.querySelector<HTMLElement>('.play-hud');
    if (playHud) playHud.inert = covered;
    root.classList.toggle('has-menu', isMenu(view));

    const target = focusFor(view, previous);
    if (target) {
      target.focus({ preventScroll: true });
    } else if (document.activeElement instanceof HTMLElement) {
      // Keep focus off the screens' buttons so lane keys never activate them.
      document.activeElement.blur();
    }
  };

  // ---- Session ----

  const onState = ({ state, previous }: { state: SessionState; previous: SessionState }) => {
    if (state === 'finished' && session.results) {
      // Decided against the stored best before saving, per song, difficulty and tempo.
      recorded = store.recordResults(session.results);
    }
    if (state === 'error') console.warn(`[platyjam] ${session.error ?? 'the song did not load'}`);
    if (previous === 'starting' && state !== 'leadIn') startFailed = true;
    if (state === 'leadIn') startFailed = false;
    render();
  };

  const offs = [
    session.events.on('statechange', onState),
    session.events.on('pause', () => {
      if (shown === 'pause') pause.refresh();
    }),
    session.events.on('countdown', () => {
      if (shown === 'countdown') countdown.refresh();
    }),
  ];

  const poll = setInterval(() => {
    if (shown === 'songs' && session.state === 'loading') renderPlay();
  }, LOADING_POLL_MS);

  const onConnectivity = () => {
    if (shown === 'songs') renderPlay();
  };
  window.addEventListener('online', onConnectivity);
  window.addEventListener('offline', onConnectivity);

  // ---- Keyboard: Enter is the screen's main action, Escape goes back or pauses ----

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.repeat || event.defaultPrevented || calibrating) return;
    // The calibration closes itself on Escape before this runs: that key was its own.
    if (event.target instanceof Element && event.target.closest('.calibration')) return;
    const view = viewFor(menu, session.state);
    if (event.key === 'Escape') {
      if (view === 'play') {
        if (session.state === 'leadIn' || session.state === 'playing') session.pause('player');
      } else if (view === 'pause') {
        session.resume();
      } else if (view === 'results') {
        toSongList();
      } else if (isMenu(view)) {
        back();
      }
      return;
    }
    const enter = event.key === 'Enter';
    const space = event.key === ' ';
    if ((!enter && !space) || isOwnControl(event.target)) return;
    // Space selects radio buttons; outside Home only Enter is the main action.
    if (space && view !== 'home') return;
    let handled = true;
    if (view === 'home') go('songs');
    else if (view === 'songs') play();
    else if (view === 'pause') session.resume();
    else if (view === 'results') session.restart();
    else handled = false;
    if (handled) event.preventDefault();
  };
  window.addEventListener('keydown', onKeyDown);

  // Fetch the last song while the player is still on Home.
  ensureLoaded();
  render();

  return {
    get view() {
      return viewFor(menu, session.state);
    },
    dispose() {
      for (const off of offs) off();
      clearInterval(poll);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('online', onConnectivity);
      window.removeEventListener('offline', onConnectivity);
      for (const screen of Object.values(screens)) screen.node.remove();
      stage.inert = false;
      root.classList.remove('has-menu');
    },
  };
}
