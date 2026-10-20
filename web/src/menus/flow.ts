import type { CatalogSong } from '../catalog/schema';
import type { DifficultyName } from '../chart/schema';
import type { GameMode, LoadingInfo, SessionState, Tempo } from '../game/session-contract';
import type { Settings } from '../save/save-data';

/**
 * The menus' navigation rules, pure: which screen shows for a menu position and a
 * session state, where Back goes, and what the Play tile does.
 */

/** Where the player is in the menus. A run shows over whichever was open. */
export type MenuScreen = 'home' | 'songs' | 'settings' | 'credits';

/** What is on screen: a menu, or one of the run's own screens. */
export type View = MenuScreen | 'play' | 'pause' | 'countdown' | 'results';

export function viewFor(menu: MenuScreen, state: SessionState): View {
  switch (state) {
    case 'paused':
      return 'pause';
    case 'countdown':
      return 'countdown';
    case 'finished':
      return 'results';
    case 'starting':
    case 'leadIn':
    case 'playing':
    case 'failing':
      return 'play';
    case 'loading':
    case 'ready':
    case 'quit':
    case 'error':
      return menu;
  }
}

/** Escape and the Back buttons: Home ← Songs ← Settings and Credits. */
export function backFrom(screen: MenuScreen): MenuScreen | undefined {
  switch (screen) {
    case 'settings':
    case 'credits':
      return 'songs';
    case 'songs':
      return 'home';
    case 'home':
      return undefined;
  }
}

/**
 * Views that cover the stage: the stage and play HUD underneath are inert. Play and
 * the countdown leave the lanes live (the countdown reclaims held lanes).
 */
export function isModal(view: View): boolean {
  return view !== 'play' && view !== 'countdown';
}

export interface PlayButton {
  /**
   * - `start`: `session.start()`, in the gesture.
   * - `wait`: nothing yet; loading or starting.
   * - `retry`: download the song again (`load()`).
   * - `reload`: reload the page; the piano samples only load at launch.
   */
  action: 'start' | 'wait' | 'retry' | 'reload';
  label: string;
  /** A line under the tile: progress or what went wrong. */
  note: string;
}

export interface PlayButtonInput {
  state: SessionState;
  loading: LoadingInfo;
  error: string | undefined;
  online: boolean;
  /** The last Play tap fell back because the sound never started. */
  startFailed: boolean;
}

const FAILED_NOTE =
  "This song didn't download. Check your connection and try again, or pick another song.";
const OFFLINE_NOTE =
  "This song isn't on this device yet. Connect to the internet once to download it, or pick a song you've played before.";

export function playButtonFor({
  state,
  loading,
  error,
  online,
  startFailed,
}: PlayButtonInput): PlayButton {
  switch (state) {
    case 'loading': {
      const { chartLoaded, samples } = loading;
      const pianoDone = samples.loaded + samples.failed >= samples.total;
      return {
        action: 'wait',
        label: 'Loading',
        note: !chartLoaded
          ? 'Fetching the song'
          : pianoDone && loading.backing === 'loading'
            ? 'Fetching the recording'
            : `Tuning the piano: ${samples.loaded + samples.failed} of ${samples.total} notes`,
      };
    }
    case 'error':
      // The chart arrived, so a piano note is what failed: only a reload fetches those.
      if (loading.chartLoaded) {
        return { action: 'reload', label: 'Reload', note: error ?? "The piano didn't load." };
      }
      // The session's error names the technical cause (logged); the player needs the way out.
      return { action: 'retry', label: 'Try again', note: online ? FAILED_NOTE : OFFLINE_NOTE };
    case 'ready':
    case 'quit':
    case 'finished':
      return {
        action: 'start',
        label: 'Play',
        note: startFailed ? "The sound didn't start. Tap Play again." : '',
      };
    default:
      return { action: 'wait', label: 'Starting', note: '' };
  }
}

export interface Selection {
  songId: string;
  difficulty: DifficultyName;
  tempo: Tempo;
}

/** The saved choice, or the first (gentlest) song when the saved one is gone. */
export function resolveSelection(
  settings: Readonly<Settings>,
  songs: readonly CatalogSong[],
): Selection {
  const saved = songs.find((song) => song.id === settings.songId);
  return {
    songId: saved?.id ?? songs[0]?.id ?? '',
    difficulty: settings.difficulty,
    tempo: settings.tempo,
  };
}

/** The saved game, or Rhythm when the saved one is not offered. */
export function resolveGameMode(saved: GameMode, offered: readonly GameMode[]): GameMode {
  return offered.includes(saved) ? saved : 'rhythm';
}

/**
 * Identifies a session setup: a different key needs a new `load()`. `mode` is the game
 * the session plays (`resolveGameMode`), not necessarily the saved one.
 */
export function setupKey(
  selection: Selection,
  settings: Readonly<Settings>,
  mode: GameMode,
): string {
  const { songId, difficulty, tempo } = selection;
  return [
    mode,
    songId,
    difficulty,
    tempo,
    settings.failMode,
    settings.scrollDurationMs,
    // Rhythm draws every tile alike.
    mode === 'tiles' ? settings.tileSize : '',
  ].join('/');
}

/** The scroll speeds Settings offers, slowest first: real ms a tile is visible. */
export const SCROLL_SPEEDS = [
  { label: 'Slow', ms: 2600 },
  { label: 'Calm', ms: 2000 },
  { label: 'Normal', ms: 1600 },
  { label: 'Quick', ms: 1250 },
  { label: 'Rapid', ms: 950 },
] as const;

export type ScrollSpeed = (typeof SCROLL_SPEEDS)[number];

/** The offered speed closest to a stored duration (which may be any valid value). */
export function nearestScrollSpeed(ms: number): ScrollSpeed {
  let best: ScrollSpeed = SCROLL_SPEEDS[2];
  for (const speed of SCROLL_SPEEDS) {
    if (Math.abs(speed.ms - ms) < Math.abs(best.ms - ms)) best = speed;
  }
  return best;
}

/** `2:21`. */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** `1.25×`. */
export function formatTempo(tempo: number): string {
  return `${tempo}×`;
}
