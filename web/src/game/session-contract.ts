import type { EventBus } from '../app/events';
import type { Chart, DifficultyName } from '../chart/schema';

/**
 * The contract between gameplay (PLA-6) and the screens around it (PLA-7).
 *
 * PLA-6 owns the simulation, input, rendering, judgment, scoring, the session
 * controls and the HUD pause button. PLA-7 owns the menu, pause, countdown and
 * results screens, persisted settings and best scores. PLA-7 drives a session only
 * through the commands below and reads only the outputs below.
 */

/**
 * The two games, on the same songs, charts and settings:
 *
 * - `rhythm`: hit each tile on the line, in time. Judged Perfect, Good or Miss.
 * - `tiles`: tap every tile, anywhere on it, before it falls off the screen; timing
 *   doesn't matter, but the tiles go in order. Judged Cleared or Miss. Where a tile
 *   falls off, and how tall it is drawn, depend on the screen
 *   (`GameplaySession.setTilesFrame`). With no timing to judge, the input calibration
 *   plays no part: a tile can be claimed while it is shown, and inputs count at the
 *   song time the stage showed when they happened.
 */
export const GAME_MODES = ['rhythm', 'tiles'] as const;
export type GameMode = (typeof GAME_MODES)[number];

/** Tempos the game offers. Chart time runs this many ms per real ms. */
export const TEMPOS = [0.75, 1, 1.25, 1.5] as const;
export type Tempo = (typeof TEMPOS)[number];

/**
 * - `classic` (default): the first Miss or empty-lane press ends the run.
 * - `relaxed`: a Miss breaks the combo and the song continues.
 */
export const FAIL_MODES = ['classic', 'relaxed'] as const;
export type FailMode = (typeof FAIL_MODES)[number];

/**
 * Tiles: how tall tiles are drawn (`TILE_HEIGHTS` in scene/lane-layout.ts). `normal`
 * (default) is about a quarter of the screen, `big` a third, for younger players and
 * bigger thumbs. Only the height changes: lead time, the rules and scoring don't.
 */
export const TILE_SIZES = ['normal', 'big'] as const;
export type TileSize = (typeof TILE_SIZES)[number];

/** How long a tile takes from the top of the lane to the hit line, real ms. */
export const DEFAULT_SCROLL_DURATION_MS = 1600;
export const MIN_SCROLL_DURATION_MS = 600;
export const MAX_SCROLL_DURATION_MS = 4000;

/** Session inputs: what to play and how. */
export interface SessionSetup {
  /** The chart, or the download that delivers it (the session waits in `loading`). */
  chart: Chart | Promise<Chart>;
  /** The game: it picks the rules (judgment, scoring, misses) the run is played by. */
  mode: GameMode;
  difficulty: DifficultyName;
  tempo: Tempo;
  failMode: FailMode;
  /**
   * Real ms a tile is visible before it reaches the hit line. Independent of the
   * tempo: at 1.5× the lane shows 1.5 times as much chart.
   */
  scrollDurationMs: number;
  /** Tiles: how tall tiles are drawn. Rhythm ignores it. */
  tileSize: TileSize;
}

/** The setup once the chart has arrived. */
export interface SessionConfig extends Omit<SessionSetup, 'chart'> {
  chart: Chart;
}

/**
 * Session state. Transitions:
 *
 *   loading → ready → starting → leadIn → playing ⇄ paused → countdown → playing
 *   playing → failing → finished            (Classic failure, after the visual rewind)
 *   playing → finished                      (song completed)
 *   any run state → quit                    (`quit()`; `start()` begins a new run)
 *   loading → error                         (the chart or a piano note it needs did not load)
 *
 * `leadIn`, `paused` and `countdown` can also be entered from `leadIn`, and
 * `restart()` goes from any run state (or `finished`) straight back to `starting`.
 */
export type SessionState =
  /** Waiting for the chart, the piano samples and the song's recording. Show `loading` progress. */
  | 'loading'
  /** Everything is loaded: show the Start tile. */
  | 'ready'
  /** Start was pressed; waiting for the audio context to run. */
  | 'starting'
  /** The song clock runs below 0: tiles scroll in. Early hits inside a window count. */
  | 'leadIn'
  | 'playing'
  /** Song and judgment frozen. Show the pause screen; see `PauseInfo`. */
  | 'paused'
  /** 3-2-1 before play continues. Lanes may be re-pressed to reclaim held tiles. */
  | 'countdown'
  /** Classic failure: the stage plays its short visual rewind; results follow. */
  | 'failing'
  /** The run is over; `results` is set. */
  | 'finished'
  /** The player quit; nothing is playing. `start()` begins a new run. */
  | 'quit'
  /**
   * The chart, or a piano sample one of its notes needs, could not be loaded;
   * `error` says why. Start stays unavailable: `load()` again (another song, or the
   * same chart once it can download). Piano samples load once, at launch: for those,
   * reloading the page is the way out.
   */
  | 'error';

/** States in which a run exists (the session owns the clock and pause UI). */
export const RUN_STATES: readonly SessionState[] = [
  'starting',
  'leadIn',
  'playing',
  'paused',
  'countdown',
  'failing',
];

export function isRunActive(state: SessionState): boolean {
  return RUN_STATES.includes(state);
}

export type PauseReason =
  /** The HUD pause button, or PLA-7 calling `pause()`. */
  | 'player'
  /** The page went to the background, or the audio was interrupted. */
  | 'interrupted'
  /** A touch was cancelled by the system (a gesture, palm rejection, rotation). */
  | 'inputcancel'
  /** The window lost keyboard focus. */
  | 'blur';

/**
 * - `running`: audio runs; `resume()` starts the countdown at once.
 * - `interrupted`: the audio stopped (backgrounding, a call). `resume()` must come
 *   from a tap: it brings the audio back first.
 * - `recovering`: `resume()` was called and the audio is coming back. The countdown
 *   starts by itself when it has; the song clock stays paused meanwhile.
 * - `needsGesture`: the audio did not come back. Ask for one more tap and call
 *   `resume()` from it again (that tap recreates the audio context).
 */
export type AudioRecovery = 'running' | 'interrupted' | 'recovering' | 'needsGesture';

export interface PauseInfo {
  reason: PauseReason;
  audio: AudioRecovery;
  /** Lanes holding a hold tile when play paused: re-press them during the countdown. */
  heldLanes: readonly number[];
}

export interface CountdownInfo {
  /** 3, 2, 1. */
  beat: number;
  /** Lanes still waiting to be re-pressed. A hold not reclaimed becomes a tail Miss. */
  heldLanes: readonly number[];
  /** Lanes reclaimed so far. */
  reclaimedLanes: readonly number[];
}

export interface LoadingInfo {
  chartLoaded: boolean;
  /** Piano samples: loaded and failed so far, of `total`. */
  samples: { loaded: number; failed: number; total: number };
  /**
   * The song's recording: `none` for a chart without one (and until the chart has
   * arrived), `loading`, then `loaded` or `failed`. A failure does not stop the
   * song, which plays without it.
   */
  backing: 'none' | 'loading' | 'loaded' | 'failed';
}

/**
 * How a unit went. Rhythm judges timing (`perfect`, `good`); Tiles only whether a
 * unit was cleared (`clear`). Both have `miss`. `MODE_JUDGMENTS` lists each game's.
 */
export type Judgment = 'perfect' | 'good' | 'clear' | 'miss';

/** The scoring numbers, live while playing and final in the results. */
export interface ScoreStats {
  score: number;
  combo: number;
  maxCombo: number;
  /** Rhythm's judgments; 0 in Tiles. */
  perfect: number;
  good: number;
  /**
   * Tiles: units cleared; 0 in Rhythm. Optional so stats written before Tiles still
   * type-check; the session always sets it.
   */
  clear?: number;
  miss: number;
  /**
   * `100 * (perfect + clear + 0.5 * good) / resolved units`; 0 before any unit
   * resolves. In Tiles that is cleared ÷ resolved.
   */
  accuracy: number;
}

export interface LiveStats extends ScoreStats {
  /** `clamp(songTime / durationMs, 0, 1)`; lead-in excluded. */
  progress: number;
  /** Stars earned so far: 1 at a third, 2 at two thirds, 3 on completion. Never drops. */
  stars: number;
}

/**
 * - `cleared`: the song finished.
 * - `failed`: Classic failure. `failure` says what ended the run.
 */
export type Outcome = 'cleared' | 'failed';

export type Failure =
  /**
   * Rhythm: a tile's window passed unhit. Tiles: a tile fell off the screen. Both: a
   * hold was released early.
   */
  | { kind: 'missedTile'; lane: number; tileIndex: number }
  /**
   * A press with nothing to hit: an empty lane (Rhythm), empty space between tiles
   * (Tiles). Tiles also says where along the lane: `at` is the chart ms of a tile drawn
   * there (a key presses at the line).
   */
  | { kind: 'emptyTap'; lane: number; at?: number };

export interface FinalResults extends ScoreStats {
  outcome: Outcome;
  /** Set when `outcome` is `failed`. */
  failure?: Failure;
  /** The game that was played: best scores are kept per game. */
  mode: GameMode;
  songId: string;
  songTitle: string;
  difficulty: DifficultyName;
  tempo: Tempo;
  failMode: FailMode;
  /**
   * 1 when cleared. On a failed run, the furthest progress the run reached (what the
   * HUD showed, never less than at the failure), so it agrees with `stars`.
   */
  progress: number;
  /** 0 to 3; stars earned before a failure are kept. */
  stars: number;
  /** Cleared with no Good and no Miss (Tiles has no Good: with no Miss). */
  perfectBadge: boolean;
}

/** A unit was judged. The stage and HUD show feedback from these. */
export interface JudgmentEvent {
  /** `empty`: a press with no eligible tile. */
  unit: 'tap' | 'head' | 'tail' | 'empty';
  judgment: Judgment;
  lane: number;
  /** Index into the difficulty's tiles; -1 for `empty`. */
  tileIndex: number;
  /**
   * Song ms at which it was judged: Rhythm's inputs at their calibrated time, Tiles'
   * at the song time shown when they happened.
   */
  songMs: number;
  combo: number;
}

/**
 * Tiles: a tap on a tile that is not next yet (an earlier one waits). It is ignored,
 * with no penalty; the stage shakes the tile.
 */
export interface NotYetEvent {
  lane: number;
  tileIndex: number;
}

export interface SessionEvents {
  statechange: { state: SessionState; previous: SessionState };
  judgment: JudgmentEvent;
  notyet: NotYetEvent;
  /** The countdown advanced (3, 2, 1) or its reclaimed lanes changed. */
  countdown: CountdownInfo;
  /** Paused info changed (for example audio recovery progressed). */
  pause: PauseInfo;
}

/**
 * A game session. Commands are safe to call in any state; one that does not apply
 * is ignored. `start`, `resume` and `restart` may need to start or recover audio,
 * so call them synchronously from a user gesture (a `pointerup`, `click` or
 * `keydown` handler).
 *
 * Pause, countdown and resume:
 *
 * 1. Pausing (`pause()`, backgrounding, an audio interruption, a cancelled touch)
 *    freezes the song clock and judgment, fades out all sound and keeps hold
 *    progress. State `paused`; `pauseInfo.heldLanes` lists the interrupted holds.
 * 2. The pause screen calls `resume()` from a tap. If the audio was interrupted the
 *    session recovers it first with the clock still paused (`pauseInfo.audio` goes
 *    `recovering`, then `ok`, or `needsGesture`: call `resume()` again from the next
 *    tap).
 * 3. Then state `countdown`: `countdown.beat` goes 3, 2, 1, one per second. Lane
 *    presses now only reclaim the listed held lanes; pressing a reclaimed lane binds
 *    the hold to that finger or key.
 * 4. After 1 the clock and accompaniment resume together (state `playing`), and any
 *    hold not reclaimed becomes a tail Miss with the usual fail-mode consequence.
 *
 * The countdown screen must not take pointer events (`pointer-events: none`) so
 * the lanes underneath receive the reclaiming presses.
 */
export interface GameSession {
  readonly state: SessionState;
  readonly events: EventBus<SessionEvents>;
  /** The current setup; undefined until the chart has loaded. */
  readonly config: SessionConfig | undefined;
  /** While `loading`. */
  readonly loading: LoadingInfo;
  /** While `paused`. */
  readonly pauseInfo: PauseInfo | undefined;
  /** While `countdown`. */
  readonly countdown: CountdownInfo | undefined;
  /** Once `finished`. */
  readonly results: FinalResults | undefined;
  /** While `error`: a sentence to show the player. */
  readonly error: string | undefined;
  /** Score, combo, accuracy, progress and stars. Cheap; read it every frame. */
  stats(): LiveStats;

  /** Loads a song: state `loading`, then `ready`. Ends any current run. */
  load(setup: SessionSetup): void;
  /** From `ready` or `quit`: starts the run (state `starting`, then `leadIn`). */
  start(): void;
  /** From `leadIn`, `playing` or `countdown`. */
  pause(reason?: PauseReason): void;
  /** From `paused`: recovers audio if needed, then runs the countdown. */
  resume(): void;
  /** From any run state or `finished`: a fresh run of the same setup. */
  restart(): void;
  /** Ends the run without results: silence, state `quit`. */
  quit(): void;
}
