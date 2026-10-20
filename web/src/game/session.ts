import { createEventBus } from '../app/events';
import type { Lifecycle } from '../app/lifecycle';
import type { BackingPlayer } from '../audio/backing-player';
import type { AudioEngine } from '../audio/engine';
import type { LoadProgress, PianoSamples } from '../audio/piano-samples';
import type { PianoVoice, Sampler } from '../audio/sampler';
import { type Accompaniment, PAUSE_FADE_MS } from '../audio/scheduler';
import type { Chart, DifficultyName, Tile } from '../chart/schema';
import type { LaneInputSink, LaneSpot } from './input';
import { accuracyOf, earnsPerfectBadge, starsFor } from './scoring';
import type {
  AudioRecovery,
  CountdownInfo,
  FinalResults,
  GameSession,
  JudgmentEvent,
  LiveStats,
  LoadingInfo,
  PauseInfo,
  PauseReason,
  SessionConfig,
  SessionEvents,
  SessionState,
} from './session-contract';
import {
  createSimulation,
  finalizationHorizon,
  type Simulation,
  type SimulationOptions,
  TAIL,
  type TileAim,
} from './simulation';
import { createTilesSimulation, DEFAULT_EXIT_ALONG } from './tiles-simulation';

// Tunable presentation and audio timings.

/** One countdown beat, real ms. */
export const COUNTDOWN_BEAT_MS = 1000;
export const COUNTDOWN_BEATS = 3;
/** A hit tap plays this long (real seconds) before its key is released. */
export const TAP_NOTE_S = 0.45;
/** How long Start waits for the audio to run before giving up. */
export const START_TIMEOUT_MS = 3000;
/** Fade when a Classic failure silences the song. */
export const FAIL_FADE_MS = 120;
/** Fade on quit and restart. */
export const QUIT_FADE_MS = 150;
/** Fade for anything still ringing when a song completes. */
export const END_FADE_MS = 800;
/** The visual rewind after a failure: how far back (real ms of song) and how long it takes. */
export const REWIND_SONG_MS = 450;
export const REWIND_DURATION_MS = 650;
/** From the failure to handing over the results. */
export const FAIL_RESULTS_DELAY_MS = 1600;

/** The parts of `GameAudio` a session uses. */
export interface SessionAudio {
  engine: Pick<
    AudioEngine,
    'phase' | 'events' | 'clock' | 'timeline' | 'context' | 'resumeFromGesture' | 'resumeClock'
  >;
  piano: Pick<Sampler, 'noteOn' | 'noteOff' | 'stopAll'>;
  accompaniment: Pick<Accompaniment, 'play' | 'pause' | 'stopAll'>;
  /** The song's recording, loaded with the song (`chart.audio`). */
  backing: Pick<BackingPlayer, 'load' | 'state' | 'play' | 'pause' | 'stopAll'>;
  /** Tunes both pianos to a recording at this speed; 1 is concert pitch. */
  setTuning(rate: number): void;
  samples: {
    readonly progress: LoadProgress;
    readonly ready: Promise<Pick<PianoSamples, 'failed'>>;
  };
}

export interface GameplaySessionOptions {
  audio: SessionAudio;
  bus: Lifecycle;
  /** `performance.now()`. */
  now?: () => number;
}

/** What the stage draws this frame. */
export interface StageView {
  readonly config: SessionConfig | undefined;
  readonly simulation: Simulation | undefined;
  /** The song ms to draw at (the visual rewind included). */
  readonly songMs: number;
  readonly state: SessionState;
}

/**
 * The session plus what the rest of PLA-6 (input, stage) needs. PLA-7 only uses
 * the `GameSession` part.
 */
export interface GameplaySession extends GameSession {
  /** Feed lane input here (`installLaneInput`'s sink). Timestamps are performance ms. */
  readonly input: LaneInputSink;
  /** Whether lane presses are gameplay right now (lead-in, play, countdown). */
  acceptsInput(): boolean;
  /** The input layer, so pausing can forget held fingers and keys. */
  attachInput(input: { clear(): void }): void;
  /**
   * Tiles: where the stage's layout loses a tile, in scroll windows past the hit line
   * (`exitAlong` in scene/highway-layout.ts). Call it whenever the stage is resized:
   * the layout, and on the tabletop the screen's bottom edge, decide it.
   */
  setExitAlong(along: number): void;
  /** Call every render frame: finalizes misses and completions, runs transitions. */
  update(): void;
  /** Call after `update()` to get what to draw. */
  view(): StageView;
}

/** Every pitch a run of `difficulty` plays: its tiles and all the accompaniment. */
export function requiredPitches(chart: Chart, difficulty: DifficultyName): Set<number> {
  const { tiles, accompaniment = [] } = chart.difficulties[difficulty];
  const pitches = new Set<number>();
  for (const tile of tiles) for (const pitch of tile.pitches) pitches.add(pitch);
  for (const note of [...chart.accompaniment, ...accompaniment]) pitches.add(note.pitch);
  return pitches;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
/** Ease-out cubic. */
const easeOut = (t: number) => 1 - (1 - clamp01(t)) ** 3;

export function createGameplaySession({
  audio,
  bus,
  now = () => performance.now(),
}: GameplaySessionOptions): GameplaySession {
  const { engine, piano, accompaniment, backing, samples } = audio;
  const events = createEventBus<SessionEvents>();

  let state: SessionState = 'loading';
  let config: SessionConfig | undefined;
  let chartLoaded = false;
  let error: string | undefined;
  let sim: Simulation | undefined;
  let pauseInfo: PauseInfo | undefined;
  let countdown: CountdownInfo | undefined;
  let results: FinalResults | undefined;
  let input: { clear(): void } | undefined;
  // Bumped to abandon a load, a start or a countdown that was overtaken.
  let loadToken = 0;
  let startToken = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Voices of the hold being held, per tile index. */
  const holdVoices = new Map<number, PianoVoice[]>();
  /**
   * Tiles: tiles claimed before their beat, whose notes wait on the song clock, with
   * the context time each is due. A pause cancels them; resuming schedules them again.
   */
  const waiting = new Map<number, number>();
  let exitAlong = DEFAULT_EXIT_ALONG;
  /** The furthest progress this run has reached; a failure never takes it back. */
  let furthest = 0;
  /** When the run failed (performance ms) and the song time shown then, for the rewind. */
  let failedAt = 0;
  let failedSongMs = 0;

  const live: LiveStats = {
    score: 0,
    combo: 0,
    maxCombo: 0,
    perfect: 0,
    good: 0,
    clear: 0,
    miss: 0,
    accuracy: 0,
    progress: 0,
    stars: 0,
  };

  const setState = (next: SessionState) => {
    if (next === state) return;
    const previous = state;
    state = next;
    events.emit('statechange', { state: next, previous });
  };

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const tiles = () => (config ? config.chart.difficulties[config.difficulty].tiles : []);

  /** Plays a hit tile's note: now, or at context time `at`. */
  const strike = (index: number, tile: Tile, at?: number) => {
    const voices: PianoVoice[] = [];
    for (const pitch of tile.pitches) {
      const voice =
        at === undefined ? piano.noteOn(pitch, tile.vel) : piano.noteOn(pitch, tile.vel, at);
      if (voice) voices.push(voice);
    }
    if (tile.dur === undefined) {
      const off = (at ?? engine.context.currentTime) + TAP_NOTE_S;
      for (const voice of voices) piano.noteOff(voice, off);
    } else {
      holdVoices.set(index, voices);
    }
  };

  /** Schedules a waiting Tiles note on the song clock, like the accompaniment. */
  const strikeOnBeat = (index: number, tile: Tile) => {
    const startMs = sim?.noteStartMs[index] ?? tile.t;
    // Calibrated as all scheduled sound is: it is heard on its beat.
    const at = engine.timeline.startTimeFor(startMs);
    waiting.set(index, at);
    strike(index, tile, at);
  };

  const onJudgment = (event: Readonly<JudgmentEvent>) => {
    const tile = tiles()[event.tileIndex];
    if (tile && event.judgment !== 'miss' && (event.unit === 'tap' || event.unit === 'head')) {
      // Tiles: a tile claimed before its beat waits for it (`TILES_RULES.melody`).
      // Rhythm's notes start at the hit.
      const startMs = sim?.noteStartMs[event.tileIndex] ?? event.songMs;
      if (startMs > event.songMs) strikeOnBeat(event.tileIndex, tile);
      else strike(event.tileIndex, tile);
    }
    if (event.unit === 'tail') {
      for (const voice of holdVoices.get(event.tileIndex) ?? []) piano.noteOff(voice);
      holdVoices.delete(event.tileIndex);
      waiting.delete(event.tileIndex);
    }
    events.emit('judgment', { ...event });
  };

  const newSimulation = () => {
    holdVoices.clear();
    waiting.clear();
    furthest = 0;
    if (!config) return undefined;
    const options: SimulationOptions = {
      tiles: tiles(),
      tempo: config.tempo,
      failMode: config.failMode,
      durationMs: config.chart.durationMs,
      onJudgment,
    };
    // The game picks the rules.
    if (config.mode === 'rhythm') return createSimulation(options);
    return createTilesSimulation({
      ...options,
      scrollDurationMs: config.scrollDurationMs,
      exitAlong,
      onNotYet: (lane, tileIndex) => {
        events.emit('notyet', { lane, tileIndex });
      },
    });
  };

  /** Tiles: where a finger landed, as the chart ms of a tile drawn there, at `songMs`. */
  const aimOf = (spot: LaneSpot, songMs: number): TileAim | undefined => {
    if (config?.mode !== 'tiles') return undefined;
    const windowMs = config.scrollDurationMs * config.tempo;
    return { ms: songMs - spot.along * windowMs, reachMs: spot.reach * windowMs };
  };

  const progressAt = (songMs: number) =>
    config && config.chart.durationMs > 0 ? clamp01(songMs / config.chart.durationMs) : 0;
  /** Progress at `songMs`, or further if the run already got further. */
  const reach = (songMs: number) => (furthest = Math.max(furthest, progressAt(songMs)));

  const buildResults = (current: Simulation, cfg: SessionConfig): FinalResults => {
    const cleared = current.status === 'complete';
    // A failed run keeps the furthest progress it reached, and the stars that earned.
    const progress = cleared ? 1 : reach(current.endMs ?? 0);
    const outcome = cleared ? 'cleared' : 'failed';
    return {
      ...current.score,
      accuracy: accuracyOf(current.score),
      outcome,
      ...(current.failure ? { failure: { ...current.failure } } : {}),
      mode: cfg.mode,
      songId: cfg.chart.id,
      songTitle: cfg.chart.title,
      difficulty: cfg.difficulty,
      tempo: cfg.tempo,
      failMode: cfg.failMode,
      progress,
      stars: starsFor(progress, cleared),
      perfectBadge: earnsPerfectBadge(outcome, current.score),
    };
  };

  const silence = (fadeMs: number) => {
    accompaniment.stopAll(fadeMs);
    backing.stopAll(fadeMs);
    piano.stopAll(fadeMs);
    // Notes struck outside a run (the ?debug tap pad) are in concert pitch.
    audio.setTuning(1);
    holdVoices.clear();
    waiting.clear();
  };

  /** Runs state transitions the simulation calls for. */
  const afterSimulation = () => {
    if (!sim || !config || (state !== 'leadIn' && state !== 'playing' && state !== 'countdown')) {
      return;
    }
    if (sim.status === 'failed') {
      // The rewind starts from what the stage shows, which trails the clock.
      const shownSongMs = engine.timeline.songTime();
      clearTimer();
      engine.clock.pause();
      silence(FAIL_FADE_MS);
      input?.clear();
      countdown = undefined;
      failedAt = now();
      failedSongMs = shownSongMs;
      const final = buildResults(sim, config);
      setState('failing');
      timer = setTimeout(() => {
        timer = undefined;
        results = final;
        setState('finished');
      }, FAIL_RESULTS_DELAY_MS);
    } else if (sim.status === 'complete') {
      engine.clock.pause();
      silence(END_FADE_MS);
      input?.clear();
      results = buildResults(sim, config);
      setState('finished');
    }
  };

  /**
   * The song ms an input at `timeStamp` counts at. Rhythm judges timing, so it is
   * calibrated (`judgeSongTime`). Tiles has no timing to judge: a tile can be claimed
   * while it is shown, so its presses, releases and finalization all go by the board
   * as shown at the event (`shownSongTime`), and the input calibration plays no part.
   */
  const inputTime = (timeStamp: number) =>
    config?.mode === 'tiles'
      ? engine.timeline.shownSongTime(timeStamp)
      : engine.timeline.judgeSongTime(timeStamp);
  /** `inputTime` for an input received right now, also once the clock has stopped. */
  const inputTimeNow = () =>
    config?.mode === 'tiles'
      ? engine.timeline.shownSongTimeNow()
      : engine.timeline.judgeSongTimeNow();

  // ---- start ----

  const beginRun = () => {
    if (!config) return;
    clearTimer();
    sim = newSimulation();
    results = undefined;
    pauseInfo = undefined;
    countdown = undefined;
    const { chart, difficulty, tempo } = config;
    // Quiet anything left over (another run's tail, the debug sync test).
    silence(0);
    // Both pianos follow a recording's pitch as the speed changes: when there is one
    // to be in tune with (it may have failed to load, then the notes keep concert pitch).
    audio.setTuning(backing.state === 'loaded' ? tempo : 1);
    engine.clock.setTempo(tempo);
    engine.clock.start(-chart.leadInMs);
    accompaniment.play([
      ...chart.accompaniment,
      ...(chart.difficulties[difficulty].accompaniment ?? []),
    ]);
    backing.play();
    setState('leadIn');
  };

  /** Waits for audio to run (unlock, recovery), then begins; falls back on timeout. */
  const startWhenAudioRuns = (fallback: SessionState) => {
    const token = (startToken += 1);
    setState('starting');
    if (engine.phase === 'running') {
      beginRun();
      return;
    }
    // A locked context is being unlocked by this very gesture (the engine's
    // capture-phase listener); an interrupted one needs recovering inside it.
    if (engine.phase === 'interrupted') engine.resumeFromGesture({ resumeClock: false });
    const offs = [
      engine.events.on('unlocked', () => {
        finish(true);
      }),
      engine.events.on('recovered', () => {
        finish(true);
      }),
    ];
    timer = setTimeout(() => {
      timer = undefined;
      finish(engine.phase === 'running');
    }, START_TIMEOUT_MS);
    function finish(ok: boolean) {
      for (const off of offs) off();
      if (token !== startToken || state !== 'starting') return;
      clearTimer();
      if (ok) beginRun();
      else setState(fallback);
    }
  };

  // ---- pause, countdown, resume ----

  const audioState = (): AudioRecovery =>
    engine.phase === 'interrupted' ? 'interrupted' : 'running';

  const enterPause = (reason: PauseReason) => {
    if (!sim) return;
    clearTimer();
    // In input time, as inputs count: read before the clock stops, or from the value
    // the timeline kept when the audio already stopped it.
    const settledUpTo = inputTimeNow();
    engine.clock.pause();
    if (isPlaying()) {
      // Settle what is already decided at the pause, before anything is suspended:
      // holds still down at their tail complete, and Misses whose window closed count.
      // No finalization grace: the pause comes through the same event queue as every
      // input before it, so those are judged already, and later ones are dropped.
      sim.advance(settledUpTo);
      afterSimulation();
      if (sim.status !== 'running') return;
    }
    // Two pianos: pausing the accompaniment leaves the player's notes to fade here.
    accompaniment.pause(PAUSE_FADE_MS);
    backing.pause(PAUSE_FADE_MS);
    piano.stopAll(PAUSE_FADE_MS);
    holdVoices.clear();
    // Tiles notes still waiting for their beat were cancelled with the rest; they are
    // scheduled again on resume. Those already sounding are done.
    const ctxNow = engine.context.currentTime;
    for (const [index, at] of waiting) if (at <= ctxNow) waiting.delete(index);
    sim.pause();
    input?.clear();
    countdown = undefined;
    pauseInfo = { reason, audio: audioState(), heldLanes: sim.suspendedLanes() };
    setState('paused');
    events.emit('pause', pauseInfo);
  };

  const updatePause = (audioStatus: AudioRecovery) => {
    if (!pauseInfo) return;
    pauseInfo = { ...pauseInfo, audio: audioStatus };
    events.emit('pause', pauseInfo);
  };

  const emitCountdown = () => {
    if (!countdown || !sim) return;
    countdown = {
      ...countdown,
      heldLanes: sim.suspendedLanes(),
      reclaimedLanes: sim.reclaimedLanes(),
    };
    events.emit('countdown', countdown);
  };

  const beginCountdown = () => {
    if (!sim || state !== 'paused') return;
    clearTimer();
    pauseInfo = undefined;
    countdown = { beat: COUNTDOWN_BEATS, heldLanes: sim.suspendedLanes(), reclaimedLanes: [] };
    setState('countdown');
    events.emit('countdown', countdown);
    const tick = () => {
      timer = undefined;
      if (!countdown || state !== 'countdown') return;
      if (countdown.beat > 1) {
        countdown = { ...countdown, beat: countdown.beat - 1 };
        emitCountdown();
        timer = setTimeout(tick, COUNTDOWN_BEAT_MS);
        return;
      }
      finishCountdown();
    };
    timer = setTimeout(tick, COUNTDOWN_BEAT_MS);
  };

  const finishCountdown = () => {
    if (!sim) return;
    sim.resume(engine.clock.position());
    afterSimulation();
    if (state !== 'countdown') return;
    countdown = undefined;
    engine.resumeClock();
    resumeWaitingNotes();
    setState(engine.clock.position() < 0 ? 'leadIn' : 'playing');
  };

  /** Tiles: schedules again the notes a pause cancelled, for taps and reclaimed holds. */
  const resumeWaitingNotes = () => {
    if (!sim || waiting.size === 0) return;
    const current = sim;
    const all = tiles();
    for (const index of [...waiting.keys()]) {
      const tile = all[index];
      const sounds = tile && (tile.dur === undefined || current.tails[index] === TAIL.holding);
      if (sounds && engine.clock.isRunning) strikeOnBeat(index, tile);
      else waiting.delete(index);
    }
  };

  // ---- quitting ----

  const endRun = () => {
    startToken += 1;
    clearTimer();
    engine.clock.pause();
    silence(QUIT_FADE_MS);
    input?.clear();
    pauseInfo = undefined;
    countdown = undefined;
    results = undefined;
  };

  // ---- engine and lifecycle ----

  engine.events.on('interrupted', () => {
    if (state === 'leadIn' || state === 'playing' || state === 'countdown') {
      enterPause('interrupted');
    } else if (state === 'paused') {
      updatePause('interrupted');
    }
  });
  engine.events.on('needsgesture', () => {
    if (state === 'paused') updatePause('needsGesture');
  });
  engine.events.on('recovered', () => {
    if (state === 'paused' && pauseInfo?.audio !== 'running') {
      updatePause('running');
      beginCountdown();
    }
  });
  // Something else needed quiet (the calibration): the run cannot go on under it.
  engine.events.on('silenced', () => {
    if (state !== 'loading' && state !== 'ready' && state !== 'error' && state !== 'quit') {
      endRun();
      setState('quit');
    }
  });
  bus.on('pause', () => {
    if (state === 'leadIn' || state === 'playing' || state === 'countdown') {
      enterPause('interrupted');
    }
  });

  const isPlaying = () => state === 'leadIn' || state === 'playing';

  const sink: LaneInputSink = {
    press(id, lane, timeStamp, spot) {
      if (!sim) return;
      if (state === 'countdown') {
        if (sim.reclaim(id, lane)) emitCountdown();
        return;
      }
      if (!isPlaying()) return;
      // Tiles: the tile under the finger is the one drawn there when it landed.
      const songMs = inputTime(timeStamp);
      sim.press(id, lane, songMs, spot && aimOf(spot, songMs));
      afterSimulation();
    },
    release(id, timeStamp) {
      if (!sim) return;
      if (state === 'countdown') {
        sim.unclaim(id);
        emitCountdown();
        return;
      }
      if (!isPlaying()) return;
      sim.release(id, inputTime(timeStamp));
      afterSimulation();
    },
    cancel() {
      session.pause('inputcancel');
    },
    blur() {
      session.pause('blur');
    },
  };

  const session: GameplaySession = {
    get state() {
      return state;
    },
    events,
    get config() {
      return config;
    },
    get loading(): LoadingInfo {
      const { loaded, failed, total } = samples.progress;
      return {
        chartLoaded,
        samples: { loaded, failed, total },
        backing: chartLoaded ? backing.state : 'none',
      };
    },
    get pauseInfo() {
      return pauseInfo;
    },
    get countdown() {
      return countdown;
    },
    get results() {
      return results;
    },
    get error() {
      return error;
    },

    stats() {
      const score = sim?.score;
      live.score = score?.score ?? 0;
      live.combo = score?.combo ?? 0;
      live.maxCombo = score?.maxCombo ?? 0;
      live.perfect = score?.perfect ?? 0;
      live.good = score?.good ?? 0;
      live.clear = score?.clear ?? 0;
      live.miss = score?.miss ?? 0;
      live.accuracy = score ? accuracyOf(score) : 0;
      if (results) {
        live.progress = results.progress;
        live.stars = results.stars;
      } else if (state === 'failing' && sim?.endMs !== undefined) {
        live.progress = reach(sim.endMs);
        live.stars = starsFor(live.progress, false);
      } else {
        live.progress = isRunActiveState() ? reach(engine.timeline.songTime()) : 0;
        live.stars = starsFor(live.progress, false);
      }
      return live;
    },

    load(setup) {
      if (state !== 'loading' && state !== 'ready' && state !== 'error' && state !== 'quit') {
        endRun();
      }
      const token = (loadToken += 1);
      config = undefined;
      sim = undefined;
      chartLoaded = false;
      error = undefined;
      setState('loading');
      const { chart, ...rest } = setup;
      const chartReady = Promise.resolve(chart).then((loaded: Chart) => {
        if (token === loadToken) chartLoaded = true;
        return loaded;
      });
      // The recording downloads with the piano; it never fails the load. A superseded
      // load stays away from it: the newer load's recording may already be playing.
      const backingReady = chartReady.then((loaded) =>
        token === loadToken ? backing.load(loaded.audio) : undefined,
      );
      Promise.all([chartReady, samples.ready, backingReady]).then(
        ([loaded, { failed }]) => {
          if (token !== loadToken) return;
          const needed = requiredPitches(loaded, rest.difficulty);
          if (failed.some((pitch) => needed.has(pitch))) {
            error =
              "Some piano notes this song needs didn't download. Connect to the internet, then reload.";
            setState('error');
            return;
          }
          // `mode` picks the rules: see `newSimulation`.
          config = { ...rest, chart: loaded };
          sim = newSimulation();
          setState('ready');
        },
        (reason: unknown) => {
          if (token !== loadToken) return;
          const why = reason instanceof Error ? reason.message : String(reason);
          error = `This song didn't load. ${why}`.trim();
          setState('error');
        },
      );
    },

    start() {
      if (!config || (state !== 'ready' && state !== 'quit' && state !== 'finished')) return;
      startWhenAudioRuns(state === 'finished' ? 'quit' : state);
    },

    pause(reason = 'player') {
      if (state === 'leadIn' || state === 'playing' || state === 'countdown') enterPause(reason);
    },

    resume() {
      if (state !== 'paused' || !pauseInfo) return;
      if (engine.phase === 'interrupted') {
        updatePause('recovering');
        engine.resumeFromGesture({ resumeClock: false });
        return;
      }
      beginCountdown();
    },

    restart() {
      if (!config || state === 'loading' || state === 'error' || state === 'ready') return;
      endRun();
      setState('quit');
      startWhenAudioRuns('quit');
    },

    quit() {
      if (state === 'loading' || state === 'ready' || state === 'error' || state === 'quit') return;
      endRun();
      sim = newSimulation();
      setState('quit');
    },

    input: sink,
    acceptsInput: () => isPlaying() || state === 'countdown',
    attachInput(next) {
      input = next;
    },
    setExitAlong(along) {
      exitAlong = along;
      sim?.setExitAlong(along);
    },

    update() {
      if (!sim || !config || !isPlaying()) return;
      reach(engine.timeline.songTime());
      const horizon = finalizationHorizon(inputTime(now()), config.tempo);
      sim.advance(horizon);
      afterSimulation();
      if (state === 'leadIn' && engine.clock.position() >= 0) setState('playing');
    },

    view() {
      return stageView;
    },
  };

  function isRunActiveState() {
    return state === 'leadIn' || state === 'playing' || state === 'paused' || state === 'countdown';
  }

  const displaySongMs = () => {
    if (!config) return 0;
    switch (state) {
      case 'leadIn':
      case 'playing':
        return engine.timeline.songTime();
      case 'paused':
      case 'countdown':
        return engine.clock.position();
      case 'failing':
      case 'finished': {
        const end = sim?.endMs ?? engine.clock.position();
        if (sim?.status !== 'failed') return end;
        // From what the stage showed back to a little before the failure.
        const target = end - REWIND_SONG_MS * config.tempo;
        const eased = easeOut((now() - failedAt) / REWIND_DURATION_MS);
        return failedSongMs + (target - failedSongMs) * eased;
      }
      default:
        return -config.chart.leadInMs;
    }
  };

  const stageView: StageView = {
    get config() {
      return config;
    },
    get simulation() {
      return sim;
    },
    get songMs() {
      return displaySongMs();
    },
    get state() {
      return state;
    },
  };

  return session;
}
